---
name: deepclause-cli
description: "Compiles, runs, debugs, and validates DeepClause agents built from Markdown specs. Use when users want to compile Markdown into DML programs, execute DML-based agent skills, run one-shot prompts as agents, inspect execution traces, list available tools, or convert natural language task descriptions into deterministic Prolog-based workflows."
---

# DeepClause CLI

Compiles Markdown task descriptions into DML (DeepClause Meta Language) programs and executes them as deterministic, Prolog-based AI agents in sandboxed WebAssembly environments.

## Quick Start

### Running Existing Skills

```bash
deepclause run <path/to/skill.dml> [arguments...]
```

Example:
```bash
deepclause run .deepclause/tools/code-review src/
```

### Creating New Skills

1. **Write Spec**: Create a Markdown file describing the task (e.g., `tasks/my-task.md`).
2. **Compile**: `deepclause compile tasks/my-task.md`
   - If compilation fails, review the error output for missing predicates or syntax issues in the Markdown spec, fix, and recompile.
3. **Run**: `deepclause run .deepclause/tools/my-task`

## Core Capabilities

### 1. Compile Task Descriptions

Compiles a Markdown file into an executable `.dml` program.

```bash
deepclause compile <source.md> [output_dir]
```

- **Source**: Markdown file describing the task parameters, requirements, and behavior.
- **Output**: Directory for the compiled `.dml` and `.meta.json` files (default: `.deepclause/tools`).

### 2. Run DML Programs

Executes a compiled DML program.

```bash
deepclause run <file> [args...] --param key=value
```

- **file**: Path to the `.dml` file (or file without extension).
- **args**: Positional arguments defined in the skill's `agent_main`.
- **--param**: Named parameters to override defaults.
- **--verbose**: Show tool calls and detailed output.
- **--trace <file>**: Save execution trace for debugging.

### 3. One-Shot Execution

Generate and run a DML program on the fly from a natural language prompt.

```bash
deepclause run --prompt "Your natural language prompt here" --verbose
```

### 4. Manage Tools and Commands

- **List Compiled Commands**: `deepclause list-commands`
- **List Available Tools**: `deepclause list-tools`

## Reference Material

- **DML Language Reference**: See `references/dml_reference.md` for the full DeepClause Meta Language specification.
- **File Patterns**: See `references/dml_file_patterns.md` for common file operations and patterns.