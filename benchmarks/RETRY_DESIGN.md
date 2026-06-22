# DML Task Retry and Semantic Backtracking — Design Document

## Problem

When `task/2` fails in DML, the only option is Prolog's native backtracking:
- Memory resets to the pre-attempt state
- Failure information is lost (only a warning is printed)
- The entire `agent_main` clause fails, falling through to the fallback `answer("Failed.")`

There is no way to:
1. Retry the same task with a fresh attempt
2. Learn from a failure and retry with enriched context

This makes DML agents fragile — a single task failure aborts the entire execution.

## Prerequisite: Failure Capture

Currently, `task/2` failure does `fail` with no saved context. We need to capture failure details **before** the `fail` so retry logic can use them.

### Change to `mi_call(task_named(...))` in `deepclause_mi.pl`

```prolog
% Current failure path:
(   Result.success == true
->  bind_task_variables(...)
;   engine_yield(output(WarnMsg)),
    fail
)

% New failure path:
(   Result.success == true
->  bind_task_variables(...)
;   get_memory(StateIn, AttemptMemory),
    assertz(session_last_task_failure(SessionId, Desc, Result.error, AttemptMemory)),
    engine_yield(output(WarnMsg)),
    fail
)
```

### Helper predicate

```prolog
get_last_failure(SessionId, Desc, Error, Memory) :-
    retract(session_last_task_failure(SessionId, Desc, Error, Memory)).
```

Reads and consumes the most recent failure. Returns:
- `Desc`: the task description string
- `Error`: the error message from the LLM result (or `"unknown"`)
- `Memory`: the memory state at the point of failure

---

## `retry_atmost(+Goal, +N)`

**Semantics**: Try Goal up to N times. On each failure, memory resets to the pre-attempt state (Prolog's natural backtracking). Each attempt starts completely fresh — no analysis, no context from previous attempts.

### Meta-interpreter rule

```prolog
mi_call(retry_atmost(Goal, N), StateIn, StateOut) :-
    integer(N), N > 0,
    (   mi_call(Goal, StateIn, StateOut)
    ->  true
    ;   N1 is N - 1,
        consume_gas(StateIn, _),      % retry costs gas
        mi_call(retry_atmost(Goal, N1), StateIn, StateOut)
    ).
```

### Behavior trace (N=3)

| Attempt | Memory      | Side effects      | Outcome      |
|---------|-------------|-------------------|--------------|
| 1       | Original    | Files on disk     | Fail → reset |
| 2       | Original    | Files persist     | Fail → reset |
| 3       | Original    | Files persist     | Success ✓    |

Key properties:
- **Memory**: Fully reset on each failure (Prolog backtracking)
- **Side effects**: NOT undone — files from failed attempts remain on disk. The model may overwrite or build upon them.
- **Gas**: Each retry consumes gas (prevents infinite loops)
- **Failure info**: Captured but not used (available for logging)

### Use case

Transient failures: LLM returns malformed output, API timeout, rate limit. The same prompt with fresh memory may succeed.

---

## `retry_with_analysis(+Goal, +N)`

**Semantics**: Try Goal up to N times. On failure, the model receives failure analysis and remediation advice before the next attempt. This is "semantic backtracking" — memory is not simply reset; it's enriched with what went wrong.

### Two memory strategies

#### Strategy A: Reset + Enrich (simpler)

Memory resets to pre-attempt state, then analysis is appended. The model starts fresh but knows what went wrong.

```
StateWithAnalysis = OriginalMemory + [system("RETRY: ...failed because X. Try Y instead.")]
```

Pros: Clean context, no confusion from failed attempt's partial results
Cons: Model loses visibility into what it already tried

#### Strategy B: Preserve + Correct (recommended)

Memory from the failed attempt is preserved, then analysis is appended on top. The model sees its full conversation history including the failed actions, plus the correction.

```
StateWithAnalysis = FailedAttemptMemory + [system("RETRY: ...failed because X. Try Y instead.")]
```

Pros: Model has full context of what it already tried, can avoid repeating mistakes
Cons: Longer context (more tokens), potential confusion from failed partial results

**Recommendation**: Strategy B. It aligns with the user's request to "not backtrack the memory entirely." The model can see what files it already created and what went wrong, enabling it to take a different approach without starting from scratch.

### Meta-interpreter rule (Strategy B)

```prolog
mi_call(retry_with_analysis(Goal, N), StateIn, StateOut) :-
    integer(N), N > 0,
    (   mi_call(Goal, StateIn, StateOut)
    ->  true
    ;   N1 is N - 1,
        consume_gas(StateIn, _),
        build_retry_analysis(StateIn, StateWithAnalysis),
        mi_call(retry_with_analysis(Goal, N1), StateWithAnalysis, StateOut)
    ).
```

### `build_retry_analysis/2` — Analysis generation

Two options for generating the analysis message:

#### Option 1: Template-based (zero cost, instant)

```prolog
build_retry_analysis(StateIn, StateOut) :-
    (   get_last_failure(SessionId, TaskDesc, ErrorMsg, FailedMemory)
    ->  StateMid = StateIn.put(memory, FailedMemory),
        format(string(Msg),
            "RETRY NOTICE: The previous attempt at this task failed.\nTask: ~w\nError: ~w\n\nTry a different approach: simplify the implementation, break into smaller steps, or verify assumptions before writing code.",
            [TaskDesc, ErrorMsg])
    ;   Msg = "RETRY NOTICE: The previous attempt failed. Try a different approach.",
        StateMid = StateIn
    ),
    add_memory(StateMid, system, Msg, StateOut).
```

#### Option 2: LLM-generated analysis (one extra LLM call, smarter remediation)

```prolog
build_retry_analysis(StateIn, StateOut) :-
    (   get_last_failure(SessionId, TaskDesc, ErrorMsg, FailedMemory)
    ->  StateMid = StateIn.put(memory, FailedMemory),
        format(string(AnalysisPrompt),
            "A task in an agent execution plan just failed. Analyze the failure and suggest specific remediation.\nTask: ~w\nError: ~w\n\nProvide 2-3 concise, actionable strategies for the next attempt.",
            [TaskDesc, ErrorMsg])
    ;   AnalysisPrompt = "A task failed. Suggest a different approach.",
        StateMid = StateIn
    ),
    % Make a fresh-context LLM call to generate analysis
    mi_call(prompt(AnalysisPrompt, string(Analysis)), StateMid, StateAfterPrompt),
    % Restore original memory + failed attempt memory + analysis
    format(string(FullMsg),
        "RETRY NOTICE: Previous attempt failed.\nTask: ~w\nError: ~w\nAnalysis & Remediation: ~w",
        [TaskDesc, ErrorMsg, Analysis]),
    add_memory(StateMid, system, FullMsg, StateOut).
```

**Recommendation**: Start with Option 1 (template). It's simpler, costs nothing, and the retry itself already gives the model another chance with a "try differently" signal. Option 2 can be added later as an opt-in variant.

---

## Compiler Integration

### Task call transformation

The DML compiler (`transform_task_calls/3`) rewrites `task(Desc, TypeWrapper)` into `task_named(Desc, Vars, VarNames)`. When `task/2` appears inside `retry_atmost/2` or `retry_with_analysis/2`, the compiler must still transform it.

Approach: Treat `retry_atmost/2` and `retry_with_analysis/2` as transparent wrappers. The compiler recurses into the Goal argument and transforms any `task/2` calls found inside.

```prolog
% In transform_task_calls/3:
transform_task_calls(retry_atmost(Goal, N), retry_atmost(GoalOut, N)) :-
    transform_task_calls(Goal, GoalOut).
transform_task_calls(retry_with_analysis(Goal, N), retry_with_analysis(GoalOut, N)) :-
    transform_task_calls(Goal, GoalOut).
```

---

## Usage Examples

### NL2Repo executor DML with simple retry

```prolog
agent_main :-
    ...
    retry_atmost(task("Implement src/aiofiles/base.py", string(Sum1)), 2),
    retry_atmost(task("Implement src/aiofiles/os.py", string(Sum2)), 2),
    ...
```

### NL2Repo executor DML with semantic backtracking

```prolog
agent_main :-
    ...
    retry_with_analysis(task("Implement the core async file wrapper", string(Sum1)), 3),
    ...
```

### Combined: hard retry for simple tasks, semantic retry for complex ones

```prolog
agent_main :-
    ...
    retry_atmost(task("Create pyproject.toml", string(Sum1)), 2),
    retry_with_analysis(task("Implement the AST evaluator engine", string(Sum2)), 3),
    ...
```

### Multi-step goal with retry

```prolog
agent_main :-
    ...
    retry_with_analysis((
        system("Focus on error handling for reserved words."),
        task("Implement error detection for reserved words and runtime errors", string(Sum))
    ), 2),
    ...
```

---

## Edge Cases

| Case | `retry_atmost` | `retry_with_analysis` |
|------|---------------|----------------------|
| N=0 | Fails immediately | Fails immediately |
| Goal is compound (`(A, B)`) | Retries entire conjunction | Retries entire conjunction |
| Failure in A, not B | Retries both | Retries both, analysis from A's failure |
| Nested retry | Works naturally | Works naturally |
| All retries exhausted | Goal fails (propagates up) | Goal fails (propagates up) |
| `exec/2` fails (not `task/2`) | No failure captured, standard backtrack | No failure captured, standard backtrack |
| Gas exhausted during retry | Throws `gas_exhausted` | Throws `gas_exhausted` |

**Note on `exec/2` failures**: Currently, only `task/2` failures are captured. If the Goal contains `exec/2` calls that fail, no failure info is available for analysis. A future enhancement could also capture `exec/2` failures.

---

## Implementation Plan

| Step | File | Change |
|------|------|--------|
| 1 | `src/system/runtime/prolog/deepclause_mi.pl` | Add `session_last_task_failure/4` dynamic predicate |
| 2 | `src/system/runtime/prolog/deepclause_mi.pl` | Modify `mi_call(task_named(...))` failure path to assert failure info |
| 3 | `src/system/runtime/prolog/deepclause_mi.pl` | Add `get_last_failure/4` helper |
| 4 | `src/system/runtime/prolog/deepclause_mi.pl` | Add `mi_call(retry_atmost/2)` clause |
| 5 | `src/system/runtime/prolog/deepclause_mi.pl` | Add `mi_call(retry_with_analysis/2)` clause + `build_retry_analysis/2` |
| 6 | `src/system/runtime/prolog/deepclause_mi.pl` | Add `transform_task_calls` rules for both new predicates |
| 7 | `src/compiler_prompt.ts` | Document `retry_atmost/2` and `retry_with_analysis/2` in DML reference |
| 8 | `benchmarks/nl2repo/worker/plan.dml` | Use `retry_with_analysis(task(...), 2)` in generated executor DML |
