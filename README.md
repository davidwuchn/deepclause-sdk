# DeepClause TUI Agent, CLI and SDK

Compile markdown specs into executable logic programs. Guaranteed execution semantics for agentic workflows. Comes with a minimal coding agent incl. a nostalgic Borland-style TUI.

![docs/overview.png](docs/overview.png)
![docs/tui.png](docs/tui.png)


## What This Is

AI skills and tools are everywhere—but most are just prompts. When a prompt fails, you tweak it. When you need branching logic, you write wrapper code. When you want retry behavior, you build it yourself.

DeepClause takes a different approach: **compile task descriptions into DML programs**—a Prolog-based language that handles control flow, error recovery, and tool orchestration automatically.


```
Markdown description  →  compile  →  Logic program  →  run  →  Output
```

## Install and Run

DeepClause requires Node.js 18+.

### Global install

```bash
npm install -g deepclause-sdk

# Pick one provider and export its API key
export OPENAI_API_KEY="sk-..."
# or: export ANTHROPIC_API_KEY="..."
# or: export GOOGLE_GENERATIVE_AI_API_KEY="..."
# or: export OPENROUTER_API_KEY="..."

# Initialize the current workspace
deepclause init --model openai:gpt-4o

# Inspect the configured slots
deepclause show-model

# Start the fullscreen conductor TUI
deepclause

# Or run one headless conductor turn
deepclause -p "Summarize the repository architecture"
```

### One-off usage with npx

```bash
npx deepclause-sdk@latest init --model openai:gpt-4o
npx deepclause-sdk@latest show-model
npx deepclause-sdk@latest
```

All commands except `init`, `help`, `--help`, `--version`, and `-V` expect a `.deepclause/` directory in the current workspace.

`deepclause init` creates:

- `.deepclause/config.json`
- `.deepclause/tools/`
- `.deepclause/docs/`
- `.deepclause/docs/TUI.md`
- `.deepclause/system/`
- `.deepclause/system/recipes/`
- `.deepclause/.gitignore`
- seeded local skills: `deep-research` and `research-search-reader`
- seeded example recipe: `deepclause-coding-workflow`
- editable system overrides:
    - `conductor.dml`
    - `skill-creator.dml`
    - `CONDUCTOR_PROMPT.md`
    - `DML_COMPILER_PROMPT.md`

The default recipe is created at `.deepclause/system/recipes/deepclause-coding-workflow/SKILL.md`. It is a real example, not a placeholder: it teaches the conductor how to approach local repository changes with small edits and focused validation. You can edit it, remove it, or add your own recipes next to it.

Recipes are plain markdown guidance, not executable DML. If you want to add or update one, edit `.deepclause/system/recipes/<slug>/SKILL.md` directly. The conductor can search those recipe files on future turns via `consult_recipes`.

## TUI Agent

Running `deepclause` with no subcommand starts the fullscreen TUI.

- Session list on the left
- Messages in the center
- Execution log and context summary on the right
- Slash commands such as `/new`, `/sessions`, `/set-model <model> [--slot <slot>]`, `/compile <spec>`, `/skill-creator <spec>`, `/cancel`, and `/<skill> [args]`
- Direct shell commands with `!<command>`, streamed live in the execution pane and cancelled with `/cancel`

For non-interactive use, `deepclause -p "..."` runs a single headless conductor turn with a fresh session.

### Basic Structure

The TUI is the interface around a single built-in agent: the conductor.

- The TUI itself is just the UI shell: session browser, messages pane, execution log, and context view.
- The conductor is the actual agent that receives your prompt each turn and decides what to do.
- The conductor is implemented as a system DML skill plus a system prompt.
- The conductor can answer directly, call an existing local skill, consult the recipe library for workflow guidance, invoke the skill creator to make a new skill, use shell tools, or do web research.

Conceptually, a TUI turn works like this:

1. Load the current session from `.deepclause/sessions/<session-id>/`.
2. Build the conductor prompt from the resolved conductor prompt template, the current skill catalog, the recipe library, assistant memory, task memory, and session transcript.
3. Run the conductor DML with the `gateway` model slot.
4. Stream the conductor's own activity and any child-skill events into the execution log on the right.
5. Persist the final user/assistant messages, structured `execution-log.jsonl`, and updated usage counters back into the session directory.

The conductor is the router and orchestrator for the CLI runtime. Normal compiled skills are the workers it delegates to. When the conductor launches a normal skill, that skill runs with the `run` model slot. When it launches the skill creator, that child run uses the `compile` model slot instead.

### Skills, Recipes, and the Conductor

DeepClause separates three things that other agent systems often collapse into one prompt surface.

- **Conductor**: the built-in router. It owns the conversation, inspects the workspace context, and decides whether to solve directly, run a skill, consult a recipe, or create a new skill.
- **Skills**: executable DML workers stored in `.deepclause/tools/`. These are compiled programs with explicit tool calls, branching, retries, recursion, and parameters.
- **Recipes**: markdown guidance stored in `.deepclause/system/recipes/`. These are instruction packs for workflows, conventions, checklists, and examples. They are searched via `consult_recipes`, not executed as child workers.
- **Skill creator**: the built-in compiler/orchestrator that turns a natural-language spec into a tested local skill.

That distinction matters in practice:

- Use a **recipe** when you need to know how to approach a task.
- Use a **skill** when you need a reusable automation that should actually execute.
- Use the **conductor** when you want the system to choose between those options for the current turn.

If the task is to create or refine workflow guidance itself, add or edit a recipe markdown file under `.deepclause/system/recipes/<slug>/SKILL.md`. Do not send recipe authoring through `deepclause compile` unless you actually want an executable skill instead of a guidance document.

Minimal recipe example:

```md
---
name: DeepClause Coding Workflow
description: Guidance for implementing and validating local repository changes.
tags: [coding, tests, docs]
when_to_use:
    - implementing a feature or bug fix in the current repository
priority: high
---

# Workflow

1. Start from a concrete anchor.
2. Make the smallest grounded edit.
3. Run the narrowest validation that can falsify it.
```

Minimal skill example:

```text
deepclause compile fix-imports.md
deepclause run .deepclause/tools/fix-imports.dml src/index.ts
```

The recipe is guidance. The skill is an executable worker.

### How This Differs From Other Agent Systems

Systems like `AGENTS.md`, Cursor rules, Claude Skills, or other instruction-pack formats are mostly about giving the model reusable context. DeepClause supports that same need through **recipes**, but it does not stop there.

What is different here:

- DeepClause keeps **guidance** and **execution** separate. Recipes are markdown guidance; skills are compiled programs.
- A DeepClause skill is not just a saved prompt. It is a DML program that the runtime executes with Prolog semantics.
- The conductor can decide between **consulting a recipe**, **running a compiled skill**, or **creating a new skill**.
- Model choice is split by role: `gateway` for orchestration, `run` for worker execution, and `compile` for skill creation.
- The compiled `.dml` is inspectable and versionable, so the automation logic is explicit instead of hidden in a long prompt.

### Memory Tools

The memory tools are there so the conductor can keep durable technical notes across turns instead of re-deriving everything from scratch every time.

- `messages.jsonl` is the conversation transcript. This is the raw history of user and assistant messages.
- `assistant-memory.md` is long-lived assistant context that gets injected into the conductor prompt each turn.
- `task-memory.md` is technical working memory: commands that worked, failure modes, local architecture notes, repair strategies, and other distilled learnings.

In the current conductor, memory updates are produced as part of the main `task(...)` call. The conductor asks the model for two outputs:

- `FinalAnswer`: the user-facing reply
- `MemoryUpdate`: the complete updated task-memory markdown, or `NONE`

When `MemoryUpdate` contains actual content, the runtime persists it through `update_memory`, which replaces `task-memory.md` with the complete updated memory contents.

That distinction matters:

- use the transcript for exact conversation history
- use task memory for compressed technical learnings that should help future turns
- use assistant memory for stable higher-level context, tone, or persistent instructions

In the current CLI runtime, task memory is the main writable memory channel exposed to the conductor. Assistant memory is loaded and shown in the TUI, but it is not automatically updated by a built-in conductor tool in the same way.

### Session and Memory Files

Each TUI session lives under `.deepclause/sessions/<session-id>/`:

```text
.deepclause/
    sessions/
        <session-id>/
            session.json
            messages.jsonl
            execution-log.jsonl
            assistant-memory.md
            task-memory.md
            usage.json
            specs/
```

- `session.json` stores the session title and timestamps.
- `messages.jsonl` is the append-only user/assistant transcript that gets replayed into future conductor turns.
- `execution-log.jsonl` stores structured JSONL records for conductor turns, direct `/skill` runs, direct `/skill-creator` runs, child-skill events, tool calls, streamed model output, errors, and completion summaries.
- `assistant-memory.md` is loaded into the conductor prompt as stable assistant context.
- `task-memory.md` is loaded into the conductor prompt as technical working memory.
- `usage.json` stores token usage summaries by model.
- `specs/` is used when the conductor invokes the skill creator and saves generated spec drafts for that session.

When a task fails, looks stuck, or needs to be retried, `execution-log.jsonl` is the first file to inspect. It gives you the concrete failing tool call, streamed model behavior, and any successful prior pattern in the same session instead of forcing you to guess from the final transcript alone.

In the CLI runtime today, task memory is the actively updated memory channel: the conductor can emit a `MemoryUpdate`, which persists through `update_memory` into `task-memory.md`. `assistant-memory.md` is still loaded every turn, but it is primarily something you inspect or edit manually unless you build additional tooling around it.

### Hacking the Conductor and Skill Creator

There are two levels of customization.

#### 1. Workspace-local system overrides

If you want to customize behavior for one workspace without modifying the package, place override files here:

- `.deepclause/system/conductor.dml`
- `.deepclause/system/skill-creator.dml`
- `.deepclause/system/CONDUCTOR_PROMPT.md`
- `.deepclause/system/DML_COMPILER_PROMPT.md`
- `.deepclause/system/recipes/<recipe-slug>/SKILL.md`

When present, the CLI runtime prefers those files over the packaged system DML and system prompt markdown. For recipes, workspace files override packaged recipes with the same slug.

#### 2. Source-level hacking in this repository

If you are developing DeepClause itself, these are the main files to edit:

- `src/system/assets/skills/conductor.dml` - the conductor's DML logic
- `src/system/assets/skills/skill-creator.dml` - the skill creator's DML logic
- `src/system/assets/docs/CONDUCTOR_PROMPT.md` - the conductor system prompt template
- `src/system/assets/docs/DML_COMPILER_PROMPT.md` - the skill creator/compiler system prompt template
- `src/system/assets/recipes/` - packaged default recipes copied into new workspaces
- `src/system/runtime/conductor.ts` - session loading, memory injection, tool registration, child-skill routing
- `src/system/runtime/skill-creator.ts` - compile-slot execution, skill-creator tool registration, validation/testing/deploy flow
- `src/system/runtime/catalog-recipes.ts` - recipe discovery, frontmatter parsing, and query matching

Notes:

- The conductor uses the `gateway` model slot.
- Normal compiled skills use the `run` model slot.
- The skill creator uses the `compile` model slot.
- The TUI context pane shows the resolved source paths for the conductor DML/prompt and skill creator DML/prompt.
- Changes to those `.deepclause/system/` files are picked up on the next conductor turn or skill-creator run; a dedicated TUI reload is not required.

After source-level changes, rebuild the package:

```bash
npm install
npm run build
```

If you want to run the CLI from a source checkout while hacking on it:

```bash
npm install
npm run build
npm run cli -- init
npm run cli --
```

## Model and Provider Configuration

DeepClause separates model choice into three slots:

- `gateway` - conductor and orchestration turns
- `run` - compiled skill execution
- `compile` - skill compilation and `_skill-creator`

The canonical model id format is `provider:model`, but the CLI also accepts `provider/model` and, for common built-ins, bare model names that it can infer.

Example `.deepclause/config.json`:

```json
{
    "models": {
        "gateway": "openai:gpt-4o",
        "run": "openrouter:google/gemini-2.5-flash",
        "compile": "anthropic:claude-sonnet-4-20250514"
    },
    "temperatures": {
        "gateway": 0.7,
        "run": 0.7,
        "compile": 0.4
    },
    "providers": {
        "openai": {
            "apiKey": "${OPENAI_API_KEY}"
        },
        "anthropic": {
            "apiKey": "${ANTHROPIC_API_KEY}"
        },
        "google": {
            "apiKey": "${GOOGLE_GENERATIVE_AI_API_KEY}"
        },
        "openrouter": {
            "apiKey": "${OPENROUTER_API_KEY}",
            "baseUrl": "https://openrouter.ai/api/v1"
        }
    },
    "agentvm": {
        "network": false
    },
    "workspace": "./workspace",
    "dmlBase": ".deepclause/tools"
}
```

Configuration values support `${ENV_VAR}` and `$ENV_VAR` interpolation.

### Setting Models from the CLI

```bash
# Update all three slots
deepclause set-model openai:gpt-4o

# Only change the compile slot
deepclause set-model anthropic:claude-sonnet-4-20250514 --slot compile

# Use OpenRouter for the conductor only
deepclause set-model openrouter:google/gemini-2.5-flash --slot gateway

# Inspect the resolved slot values
deepclause show-model
```

### Provider Notes

| Provider | Canonical example | API key env var | Notes |
|----------|-------------------|-----------------|-------|
| OpenAI | `openai:gpt-4o` | `OPENAI_API_KEY` | You can also set `providers.openai.baseUrl` for an OpenAI-compatible endpoint. |
| Anthropic | `anthropic:claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` | Native Anthropic adapter. |
| Google | `google:gemini-2.5-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` | Native Google Generative AI adapter. |
| OpenRouter | `openrouter:anthropic/claude-sonnet-4` | `OPENROUTER_API_KEY` | Use any OpenRouter model path. |
| Custom | `custom:local:qwen3-32b` | `LLM_PROVIDER_LOCAL_API_KEY` | Uses the OpenAI-compatible transport with a custom base URL. |

### Custom Provider

`custom:` is for OpenAI-compatible endpoints that you want to name explicitly instead of pretending they are one of the built-in providers.

Format:

```text
custom:<provider-name>:<model-name>
```

Example:

```bash
export LLM_PROVIDER_LOCAL_BASE_URL="http://localhost:11434/v1"
export LLM_PROVIDER_LOCAL_API_KEY="dummy"

deepclause set-model custom:local:qwen3-32b --slot run
deepclause show-model
```

Notes:

- `custom:local:qwen3-32b` reads `LLM_PROVIDER_LOCAL_BASE_URL` and `LLM_PROVIDER_LOCAL_API_KEY`.
- The provider name is uppercased and normalized when constructing env vars, so `custom:my-lab:model-x` becomes `LLM_PROVIDER_MY_LAB_BASE_URL` and `LLM_PROVIDER_MY_LAB_API_KEY`.
- `custom:` providers are not configured under the `providers` object in `config.json`; they are resolved from env vars.
- Internally, `custom:` uses the OpenAI-compatible transport, so your endpoint must speak an OpenAI-style chat/completions API.

## Runtime Model

DeepClause executes DML in a local CLI runtime:

- **Prolog runtime in WASM**: The DML logic engine runs in SWI-Prolog compiled to WebAssembly.
- **Host shell by default**: Shell tools run in the active local workspace shell.
- **AgentVM on demand**: Pass `--sandbox` when you want shell tools to run inside [AgentVM](https://github.com/deepclause/agentvm) instead.

This keeps the default workflow simple for local development while still supporting an isolated shell backend when needed.

## Beyond Markdown: Why Logic Programming?

Markdown skills are great for simple, linear workflows. But real-world tasks often need:

- **Branching logic** - Try approach A, fall back to B if it fails
- **Iteration** - Process a list of items one by one
- **State management** - Isolate context between sub-tasks
- **Error recovery** - Handle failures gracefully
- **Composition** - Build complex skills from simpler ones

When you give markdown instructions to a typical agentic loop, there's no guarantee these requirements will actually be followed—the LLM might ignore the fallback logic or skip items in a list. 

By compiling to Prolog, you get **guaranteed execution semantics**: backtracking ensures fallbacks happen, recursion processes every item, and unification binds variables correctly. You define *what* should happen—the runtime guarantees *how*.



## Spec-Driven Development That Compiles

[Spec-driven development](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html) proposes writing specifications before code, with the spec becoming the source of truth. Current SDD tools (Kiro, spec-kit, Tessl) generate elaborate markdown artifacts that are then fed to coding agents—but the output is still non-deterministic, and you end up reviewing both specs *and* generated code.

DeepClause offers a different approach: **specs that compile to actual programs**.

```bash
# Your spec
cat > api-client.md << 'EOF'
# API Client Generator
Generate a TypeScript API client from an OpenAPI spec URL.

## Arguments
- SpecUrl: URL to an OpenAPI/Swagger JSON specification

## Behavior
- Fetch the OpenAPI spec from SpecUrl
- Extract endpoints and types
- Generate typed client code
- Write to output file
EOF

# Compile it once
deepclause compile api-client.md

# Run it deterministically, forever
deepclause run api-client.dml "https://api.example.com/openapi.json"
```

The compiled `.dml` is inspectable logic—you can see exactly what it does:

```prolog
tool(fetch_spec(Url, Spec), "Fetch OpenAPI specification") :-
    exec(web_fetch(url: Url), Spec).

agent_main(SpecUrl) :-
    system("You are an API client generator..."),
    fetch_spec(SpecUrl, Spec),
    task("Extract endpoints from: {Spec}", Endpoints),
    task("Generate TypeScript client for: {Endpoints}", Code),
    exec(vm_exec(command: "cat > client.ts"), Code),
    answer("Generated client.ts").
```

Unlike traditional SDD where specs guide but don't control, DeepClause specs **become** the executable. The spec *is* the code—just at a higher abstraction level.

## Compile and Run a Skill

```bash
# Create a task description
cat > .deepclause/tools/explain.md << 'EOF'
# Code Explainer

Explain what a piece of code does in plain English.

## Arguments
- Code: The source code to explain

## Behavior
- Break down the code into logical sections
- Explain each section's purpose
- Note any potential issues
EOF

# Compile to executable DML
deepclause compile .deepclause/tools/explain.md

# Run it
deepclause run .deepclause/tools/explain.dml "function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2) }"

# Or trigger skill creation directly from the TUI with:
#   /compile <spec>
#   /skill-creator <spec>
# Or update the configured model selection from the TUI with:
#   /set-model openai:gpt-4.1 --slot run
# Or run a direct workspace shell command with:
#   !npm test
```

Compilation now runs two security-oriented checks on the generated DML:

- Prolog static analysis for taint flow, dangerous tool usage, and capability extraction
- An LLM security audit that reviews the generated DML and returns a short Markdown report

The LLM audit runs by default for `deepclause compile`, `deepclause compile-all`, and one-shot `deepclause run -p ...`. Use `--no-audit` if you want to skip only the LLM review. Static analysis still runs either way.

## Use Cases

### Reliable tools for coding agents

Give your AI coding assistant more deterministic, inspectable tools instead of hoping prompts work:

```bash
# Define a tool the agent can use
cat > .deepclause/tools/api-docs.md << 'EOF'
# API Documentation Lookup
Search for API documentation and summarize usage patterns.

## Arguments
- Query: The API or library name to look up

## Tools needed
- web_search

## Behavior
- Search for official documentation
- Summarize usage patterns and examples
EOF

# Compile it once
deepclause compile .deepclause/tools/api-docs.md

# Now your coding agent can run it reliably
deepclause run .deepclause/tools/api-docs.dml "Stripe PaymentIntent"
```

The compiled `.dml` files execute the same way every time—no prompt variance, no skipped steps. Build up a library of tools your agent can trust.

### Automation pipelines

Chain compiled programs together:

```bash
deepclause run review-code.dml src/handler.ts > review.md
deepclause run summarize.dml review.md
```

### Shareable, versionable task logic

Check `.dml` files into version control. The logic is inspectable—you can see exactly what the program does, not just what prompt it sends.

## Example Task Descriptions

### Web Research
```markdown
# Web Research
Search the web and synthesize findings into a report.

## Arguments
- Question: The research question to investigate

## Tools needed
- web_search

## Behavior
- Search for 3-5 authoritative sources on the Question
- Extract key findings from each
- Write a summary with inline citations
```

### Code Review
```markdown
# Code Review
Review code for bugs, security issues, and style.

## Arguments
- FilePath: Path to the file to review

## Tools needed
- vm_exec (to read files)

## Behavior
- Read the file at FilePath
- Check for common bugs and anti-patterns
- Identify security concerns
- Suggest improvements
- Be concise and actionable
```

### Data Analysis
```markdown
# CSV Analyzer
Analyze a CSV file and describe its contents.

## Arguments
- FilePath: Path to the CSV file to analyze

## Tools needed  
- vm_exec (to run Python)

## Behavior
- Load the CSV at FilePath with pandas
- Describe the schema (columns, types, row count)
- Identify interesting patterns
- Generate summary statistics
```

## Available Tools

Common built-in runtime tools:

| Tool | Description |
|------|-------------|
| `web_search` | Search the web using Brave Search (requires `BRAVE_API_KEY`) |
| `news_search` | Search recent news |
| `url_fetch` | Fetch a URL or save it into the workspace |
| `bash` | Run shell commands in the active workspace shell |
| `vm_exec` | Alias of `bash`; with `--sandbox`, runs in AgentVM |

Some tools are runtime-role specific rather than globally available to every skill. For example:

- the conductor adds tools such as `run_skill`, `create_skill`, and `update_memory`
- the skill creator adds tools such as `list_skills`, `write_file`, `validate_dml`, `test_dml`, and `deploy_skill`

Additional tools can come from configured MCP servers. Use `deepclause list-tools` to see the built-ins plus anything exposed by your configured MCP servers.

## CLI Reference

```bash
deepclause init                    # Set up .deepclause/ folder
deepclause compile <file.md>       # Compile Markdown to DML
deepclause compile-all <dir>       # Compile all .md files in directory
deepclause run <file.dml> [args]   # Execute a compiled skill
deepclause                         # Start the interactive conductor TUI
deepclause -p <text>               # Run one headless conductor turn
deepclause list-commands           # List available compiled skills
deepclause list-tools              # Show available tools
deepclause show-model              # Show gateway/run/compile slots
deepclause set-model <model>       # Change all slots or one slot with --slot
```

### Run Options

```bash
deepclause run skill.dml "input" \
    --model google:gemini-2.5-flash \  # Override the run model for this execution
    --stream \                          # Stream output
    --verbose \                         # Show tool calls
    --workspace ./data \                # Set working directory
    --sandbox                           # Use AgentVM instead of the local shell
```

### Compile Options

`deepclause compile` and `deepclause compile-all` use the `compile` model slot. They accept `--model`, `--provider`, `--temperature`, `--max-attempts`, `--sandbox`, and `--no-audit`.

Static analysis always runs. `--no-audit` disables only the LLM security audit.

One-shot prompt mode uses the same compile pipeline before execution, so `deepclause run -p "..." --no-audit` disables the LLM audit there as well.

```bash
deepclause compile skill.md \
    --model claude-sonnet-4-20250514 \
    --provider anthropic \
    --temperature 0.2 \
    --max-attempts 4

deepclause compile-all ./specs \
    --model claude-sonnet-4-20250514 \
    --provider anthropic \
    --no-audit
```

## Configuration

The main configuration surface is `.deepclause/config.json`.

The most important fields are covered above in:

- [Install and Run](#install-and-run)
- [TUI Conductor](#tui-conductor)
- [Model and Provider Configuration](#model-and-provider-configuration)

Other useful config fields:

```json
{
    "agentvm": {
        "network": false
    },
    "workspace": "./workspace",
    "dmlBase": ".deepclause/tools",
    "mcp": {
        "servers": {
            "filesystem": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
            }
        }
    }
}
```

- `agentvm.network` controls whether shell commands in `--sandbox` mode get outbound network access.
- `workspace` sets the default working directory used by shell/file tools.
- `dmlBase` changes where compiled local skills are written.
- `mcp.servers` registers MCP servers that then appear in `deepclause list-tools`.

## Understanding DML

The compiled `.dml` files use DML (DeepClause Meta Language), a dialect of Prolog designed for AI workflows.

```prolog
% Generated from research.md
tool(search(Query, Results), "Search the web") :-
    exec(web_search(query: Query), Results).

agent_main(Topic) :-
    system("You are a research assistant..."),
    task("Research {Topic} and summarize findings."),
    answer("Done").
```

You can edit DML directly for fine-grained control. See the [DML Reference](./docs/DML_REFERENCE.md) for the full language spec.


### Backtracking: Automatic Retry Logic

Prolog's backtracking means you can define multiple approaches. If one fails, execution automatically tries the next:

```prolog
% Try fast approach first, fall back to thorough approach
agent_main(Question) :-
    system("Answer concisely."),
    task("Answer: {Question}"),
    validate_answer,  % Fails if answer is inadequate
    answer("Done").

agent_main(Question) :-
    system("Be thorough and detailed."),
    task("Research and answer: {Question}"),
    answer("Done").
```

If `validate_answer` fails, Prolog backtracks and tries the second clause. No explicit if/else needed. Backtracking resets the execution state (including LLM context) to the original choice point!

### Recursion: Processing Lists

Handle variable-length inputs naturally:

```prolog
% Process each file in a list
process_files([]).
process_files([File|Rest]) :-
    task("Review {File} for issues."),
    process_files(Rest).

agent_main(Files) :-
    process_files(Files),
    answer("All files reviewed.").
```

### Memory Isolation: Independent Sub-tasks

Use `prompt/N` for LLM calls that shouldn't share context:

```prolog
agent_main(Topic) :-
    system("You are a researcher."),
    task("Research {Topic} deeply.", Findings),
    
    % Independent critique - fresh context, no bias from main research
    prompt("As a skeptic, critique: {Findings}", Critique),
    
    % Back to main context
    task("Address this critique: {Critique}"),
    answer("Done").
```

### Tool Scoping: Controlled Capabilities

Limit what tools are available to specific sub-tasks:

```prolog
tool(dangerous_action(X, Result), "Do something risky") :-
    exec(vm_exec(command: X), Result).

agent_main(Task) :-
    % Main task has all tools
    task("Plan how to: {Task}", Plan),
    
    % Execute with restricted tools - no dangerous_action allowed
    without_tools([dangerous_action], (
        task("Execute this plan safely: {Plan}")
    )),
    answer("Done").
```

### Composition: Building Blocks

Define reusable predicates and compose them:

```prolog
% Reusable building blocks
search_and_summarize(Query, Summary) :-
    exec(web_search(query: Query), Results),
    task("Summarize: {Results}", Summary).

verify_facts(Text, Verified) :-
    task("Fact-check this text: {Text}", Issues),
    (Issues = "none" -> Verified = Text ; fix_issues(Text, Issues, Verified)).

% Compose into a skill
agent_main(Topic) :-
    search_and_summarize(Topic, Draft),
    verify_facts(Draft, Final),
    answer(Final).
```

### Shared Predicates Across DML Files

When a skill grows beyond one file, move reusable predicates into helper files and load them at the top of the main DML. This is useful for shared search helpers, validation predicates, common formatting logic, or domain-specific utilities that multiple skills reuse.

```prolog
% .deepclause/tools/repo-review/helpers/search_helpers.dml
normalize_query(Query, Normalized) :-
    format(string(Normalized), "site:github.com ~w", [Query]).

search_and_summarize(Query, Summary) :-
    normalize_query(Query, Normalized),
    exec(web_search(query: Normalized), Results),
    task("Summarize these results: {Results}", Summary).
```

```prolog
% .deepclause/tools/repo-review.dml
:- use_module(library(lists)).
:- use_module(library(clpfd)).
:- consult('.deepclause/tools/repo-review/helpers/search_helpers.dml').

agent_main(Topic) :-
    search_and_summarize(Topic, Summary),
    answer(Summary).
```

- Use `:- use_module(library(...)).` for standard SWI-Prolog libraries such as `lists`, `clpfd`, `clpq`, and `clpr`.
- Use `:- consult('workspace-relative/path.dml').` for local shared DML helpers inside the workspace.
- Local `:- use_module('.deepclause/tools/repo-review/helpers/search_helpers.dml').` also works as a convenience alias, but today it has consult-style loading semantics rather than full SWI module export filtering.
- When a helper belongs to one skill, keep it in a dedicated subfolder such as `.deepclause/tools/<skill-slug>/helpers/` so the skill and its shared predicates stay together.

## Using as a Library

Embed DeepClause in your own applications:

```typescript
import { createDeepClause } from 'deepclause-sdk';

const dc = await createDeepClause({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
});

for await (const event of dc.runDML(code)) {
  console.log(event.type, event.content);
}

await dc.dispose();
```

See [sdk-examples/](./sdk-examples/) for more.

## More Resources

- [DML Reference](./docs/DML_REFERENCE.md) - Full language documentation
- [Examples](./dml-examples/) - Sample DML programs
- [Architecture](./ARCHITECTURE.md) - How it works

## License

MIT
