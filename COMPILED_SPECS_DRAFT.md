# Compiled Specs

There is a growing movement around "Spec-Driven Development" (SDD) in the generative AI space. Tools like Kiro and Tessl are trying to shift the focus from writing code to writing specifications, which agents then implement.

It makes sense. Natural language is the new interface, but natural language is also messy. We need structure.

But usually, these "specs" are just really detailed prompts. They might be formatted as Markdown or distinct files, but at runtime, they are fed into the context window just like any other instruction. The LLM reads the spec and *tries* to follow it.

If the LLM ignores a "MUST" requirement, or hallucinates a step, the spec is meaningless.

I’ve been working on a different approach with **DeepClause**. Instead of treating the spec as context, what if we treated it as source code?

## The Markdown Compiler

I added a `compile` command to the DeepClause CLI. It takes a standard Markdown task description and compiles it into **DML** (DeepClause Meta Language), our Prolog-based runtime.

It looks like this. You write a spec in `api-client.md`:

```markdown
# API Client Generator
Generate a TypeScript API client from an OpenAPI spec.

## Arguments
- SpecUrl: URL to the JSON spec

## Behavior
- Fetch the spec from SpecUrl
- Extract endpoints
- Generate the client code
```

You run `deepclause compile api-client.md`, and it generates `api-client.dml`.

This isn't just a prompt transformation. It's compiling intent into logic.

## Why Logic?

When an LLM runs a standard "chain" or "flow," the control logic is often fuzzy. *Did it really finish step A? Is it actually falling back to step B, or did it just hallucinate that it did?*

By compiling to Prolog, we get **guaranteed execution semantics**.

Take an "Autonomous Fixer" agent. You want it to write code, run tests, and if the tests fail, try again. In Markdown, you describe the intent:

```markdown
# Autonomous Fixer
Write a Python script, run it, and fix errors.

## Behavior
- Write Python code for the request
- Save and run the script
- If it fails (contains "Traceback"), try again up to 3 times
- Otherwise, show the output
```

The compiler turns this into a loop with **backtracking**. The resulting DML looks like this:

```prolog
% The 'retry' loop is handled by Prolog's choice points
agent_main(Request) :-
    % Try to solve - if it fails, the semicolon (OR) triggers a retry
    (   attempt_solve(Request)
    ;   attempt_solve(Request)
    ;   attempt_solve(Request)
    ;   answer("Failed after 3 attempts")
    ).

attempt_solve(Request) :-
    task("Write code for {Request}", Code),
    exec(run_python(Code), Output),
    % This is the guard: if it contains Traceback, this predicate FAILS
    % and Prolog backtracks to the next 'attempt_solve'
    \+ contains_error(Output),
    answer(Output).
```

This is a logic program. It has properties that prompts don't have:

1.  **Atomicity**: `task/2` either succeeds or fails.
2.  **Backtracking**: The `\+ contains_error(Output)` guard is a real constraint. If it fails, the *entire state* of the agent (including the context window) is rolled back to the last choice point. The agent doesn't "apologize" for the error; it simply starts the next attempt from a clean state.
3.  **Variables**: `Request` is a bound variable. It’s not just text in a context window; it’s a symbol in the logic engine.

## Deep Research in DML

Here is a full example of a Deep Research agent. It mixes **tools**, **human-in-the-loop confirmation**, and **multi-step reasoning**.

Notice how it looks like a script, but it's actually a logic program.

```prolog
% --- Tool Definitions ---

% tool/2 defines a capability the LLM can call within a task.
% The description is strictly typed and injected into the model's context.
tool(search(Query, Results), "Search the web for information.") :-
    % exec/2 bridges to the host runtime (TypeScript/Rust/etc).
    % This runs OUTSIDE the LLM's context window.
    exec(web_search(query: Query, count: 10), Results).

% --- Main Agent Logic ---

% agent_main/1 is the entry point, receiving the user's input in 'Question'.
agent_main(Question) :-
    % system/1 sets the global instructions for this execution scope.
    system("You are a research assistant. Always cite your sources."),

    % output/1 sends a message to the UI stream (not the LLM).
    output("Step 1: Analyzing..."),

    % task/2 invokes the LLM. 
    % '{Question}' is interpolated. 
    % 'KeyTopics' is a variable that gets bound to the model's output.
    task("Identify key topics in: {Question}", KeyTopics),

    output("Step 2: Planning..."),
    % Variables flow naturally from one step to the next.
    task("Create a research plan for: {KeyTopics}", Plan),

    % Standard Prolog predicates control the flow.
    % If confirm_plan fails (user says no), the agent stops or backtracks.
    confirm_plan(Plan),

    output("Step 3: Executing..."),
    % This task has access to the 'search' tool defined above.
    task("Execute this plan: {Plan}. Write a report.", FinalReport),

    % We can drop into standard IO for file handling.
    save_report(FinalReport),
    answer("Research complete.").

% --- Helper Predicates ---

confirm_plan(Plan) :-
    % We start a sub-task to negotiate with the user.
    task("Ask the user to approve this plan: {Plan}", Approved),
    
    % Prolog control flow:
    % If Approved is "yes", succeed.
    % If not, we fail (and potentially backtrack or stop).
    ( Approved == "yes" ->
        output("Plan approved.")
    ;
        answer("Cancelled by user."), fail
    ).
```

## The "Vibes" vs. The Machine

The goal here isn't to force everyone to write Prolog. Most people (myself included) find Markdown much faster to write.

We want to keep the "vibes" of natural language specs—easy to read, easy to edit—but enforce the rigor of a compiled runtime.

When you compile a spec, you lock in the behavior. You can inspect the `.dml` file and see exactly what the agent *can* and *cannot* do. You can see the tool scopes. You can see the flow control.

It turns the spec from a "suggestion" into a program.

## Just a Compiler

At its core, this is just a compiler. It takes high-level intent (Markdown) and lowers it to machine-verifiable instructions (DML/Prolog).

We are still exploring what this means for complex agents, but the early results are promising. We get agents that are less prone to "getting lost" and more capable of handling long, multi-step tasks without drifting.

If you want to try it out, the SDK is open source. You can define your specs, compile them, and watch the logic engine do its work.
