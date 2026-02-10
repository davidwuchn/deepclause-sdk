# Requirements: DML Verification & Security Analysis

## 1. Overview
To enhance the reliability and security of DeepClause agents, we will implement a multi-layered verification system for compiled DML (DeepClause Meta Language) code. This system combines **static symbolic analysis** (formal verification) with **LLM-based semantic analysis** to identify security risks, logic flaws, and potential runtime errors before execution.

## 2. Capability & Taint System

### 2.1. Tool Capabilities
Tools must be classified by their potential impact on the system and data privacy. We define the following capability levels:

*   **`pure`**: Deterministic, no side effects, no external I/O (e.g., math helpers).
*   **`read_only`**: Reads external state but does not modify it (e.g., `web_search`, `read_file`).
*   **`side_effect`**: Modifies external state or has costs (e.g., `write_file`, `send_email`).
*   **`dangerous`**: High-risk system access (e.g., `vm_exec`, `shell_exec`).

**Requirement:** Extend the `ToolDefinition` or maintain a registry mapping tool names to capabilities.

### 2.2. Taint Sources
Data originating from untrusted or unpredictable sources is considered "tainted".

*   **`user_input`**: Data from `param/2` (unless sanitized), `input/2`, or `user/1`.
*   **`external_data`**: Output from `exec/2` (tool results).
*   **`llm_output`**: Output variables from `task/N` (probabilistic, potentially hallucinated or adversarial).

### 2.3. Taint Sinks
Critical operations where tainted data can cause harm.

*   **`execution_sink`**: Arguments to `exec/2` (Risk: Command Injection).
*   **`prompt_sink`**: Arguments to `task/N` or `prompt/N` (Risk: Prompt Injection).
*   **`context_sink`**: Arguments to `system/1` (Risk: Context Poisoning/Behavior Alteration).
*   **`control_flow`**: Conditionals depending on tainted data (Risk: Logic manipulation).

## 3. Static Analysis (Formal Verification)

We will implement a Prolog-based static analyzer (`src/prolog-src/deepclause_analysis.pl`) that inspects the AST of the compiled DML.

### 3.1. Taint Propagation Analysis
The analyzer will track variable bindings to determine if tainted data reaches sensitive sinks.
*   **Rule:** If `Var` is bound to a Taint Source, `Var` is tainted.
*   **Rule:** If `Var` is tainted, and `Var` is used in a string interpolation `format(..., [Var])` or `{Var}`, the resulting string is tainted.
*   **Detection:**
    *   **Warning:** Tainted data -> `system/1` (High Risk: "User input in system prompt").
    *   **Warning:** Tainted data -> `exec/2` (High Risk: "Potential Command Injection").
    *   **Info:** Tainted data -> `task/1` (Medium Risk: "Prompt Injection possibility").

### 3.2. Structural Verification
*   **Unused Variables:** Identify variables bound but never used (potential logic bug).
*   **Singleton Variables:** Standard Prolog warning.
*   **Infinite Loop Detection:** Detect simple recursion patterns without base cases or state changes (heuristic).
*   **Gas Usage:** Estimate complexity (optional).

## 4. LLM-Based Semantic Analysis

After static analysis, the compiled code and static warnings are sent to an LLM (the "Auditor") for a second pass.

### 4.1. The Auditor Prompt
The Auditor is an expert DML security analyst. It checks for:
*   **Logic Flaws:** "Does this agent actually achieve the user's intent?"
*   **Prompt Injection Resilience:** "Is the prompt structure robust against adversarial user input?"
*   **Hallucination Risks:** "does the code blindly trust LLM output for critical decisions?"
*   **Tool Misuse:** "Is `vm_exec` used when `web_search` would suffice?"

### 4.2. Inputs to Auditor
*   Original User Request (Intent).
*   Compiled DML Code.
*   List of Static Analysis Warnings.
*   Tool Capability Manifest.

### 4.3. Outputs
A structured report containing:
*   **Critical Issues:** Must fix (security holes).
*   **Warnings:** Logic flaws or bad practices.
*   **Suggestions:** Refactoring advice.

## 5. Security Rules Knowledge Base
The system will support custom security policies defined in `.deepclause/security.dml` (or similar).
*   **Format:** DML/Prolog rules that hook into the analysis predicate.
*   **Example Rule:** `deny(exec(vm_exec(_))) :- environment(production).`

## 6. Implementation Plan

1.  **Modify `CompileResult`**: Add `analysis` field with warnings and capability report.
2.  **Create `src/prolog-src/deepclause_analysis.pl`**: Implement the static analysis predicates.
3.  **Update `src/compiler.ts`**:
    *   Load `deepclause_analysis.pl`.
    *   Run static analysis after compilation.
    *   (Optional flag) Run LLM Auditor pass.
4.  **CLI Integration**: Display analysis warnings during `compile` or `run` (if in dev mode).

## 7. Example Output

```text
[WARNING] Taint Analysis: User input from param(topic) flows into exec(shell_command).
          Risk: Command Injection.
          Location: agent_main/1, line 5.

[INFO]    LLM Auditor: The agent uses 'task' to format data before saving, which is good practice.
          However, consider validating the output of 'task' before 'write_file'.
```
