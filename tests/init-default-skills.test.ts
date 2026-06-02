import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import { listCommands } from '../src/cli/commands.js';
import {
  deepClauseDirExists,
  getDocsDir,
  getSystemDir,
  getToolsDir,
  initConfig,
} from '../src/cli/config.js';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return memfs.fs.promises;
});

describe('deepclause init defaults', () => {
  beforeEach(() => {
    vol.reset();
  });

  afterEach(() => {
    vol.reset();
  });

  it('seeds the default deep research skill pair during init', async () => {
    await initConfig('/workspace');

    const toolsDir = getToolsDir('/workspace');
    const parentDmlPath = `${toolsDir}/deep-research.dml`;
    const childDmlPath = `${toolsDir}/research-search-reader.dml`;
    const parentMetaPath = `${toolsDir}/deep-research.meta.json`;
    const childMetaPath = `${toolsDir}/research-search-reader.meta.json`;

    expect(vol.existsSync(parentDmlPath)).toBe(true);
    expect(vol.existsSync(childDmlPath)).toBe(true);
    expect(vol.existsSync(parentMetaPath)).toBe(true);
    expect(vol.existsSync(childMetaPath)).toBe(true);

    const parentDml = vol.readFileSync(parentDmlPath, 'utf8') as string;
    const childDml = vol.readFileSync(childDmlPath, 'utf8') as string;
    const parentMeta = JSON.parse(vol.readFileSync(parentMetaPath, 'utf8') as string);
    const childMeta = JSON.parse(vol.readFileSync(childMetaPath, 'utf8') as string);

    expect(parentDml).toContain('run_skill(slug: "research-search-reader"');
    expect(parentDml).toContain('tool(search_topic(Query, Summary)');
    expect(childDml).toContain('exec(web_search(query: Query, count: 8), Results)');
    expect(childDml).toContain('exec(news_search(query: Query, count: 5), Results)');

    expect(parentMeta).toMatchObject({
      description: 'Conducts multi-source web research on any topic and saves a cited Markdown report to your workspace.',
      tools: ['ask_user', 'run_skill'],
    });
    expect(childMeta).toMatchObject({
      description: 'Helper skill that wraps web and news search and rewrites raw results into readable research notes.',
      tools: ['news_search', 'web_search'],
    });
  });

  it('detects whether the .deepclause directory exists', async () => {
    expect(await deepClauseDirExists('/workspace')).toBe(false);

    await initConfig('/workspace');

    expect(await deepClauseDirExists('/workspace')).toBe(true);
  });

  it('seeds editable system DML and prompt overrides during init', async () => {
    await initConfig('/workspace');

    const systemDir = getSystemDir('/workspace');
    const docsDir = getDocsDir('/workspace');
    const recipePath = `${systemDir}/recipes/deepclause-coding-workflow/SKILL.md`;

    expect(vol.existsSync(`${systemDir}/conductor.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/skill-creator.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/plan.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/default-session-compactor.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/default-loop-compactor.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/CONDUCTOR_PROMPT.md`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/DML_COMPILER_PROMPT.md`)).toBe(true);
    expect(vol.existsSync(recipePath)).toBe(true);
    expect(vol.existsSync(`${docsDir}/TUI.md`)).toBe(true);
    expect(vol.existsSync(`${docsDir}/DML_REFERENCE.md`)).toBe(true);

    const conductorPrompt = vol.readFileSync(`${systemDir}/CONDUCTOR_PROMPT.md`, 'utf8') as string;
    const compilerPrompt = vol.readFileSync(`${systemDir}/DML_COMPILER_PROMPT.md`, 'utf8') as string;
    const sessionCompactor = vol.readFileSync(`${systemDir}/default-session-compactor.dml`, 'utf8') as string;
    const loopCompactor = vol.readFileSync(`${systemDir}/default-loop-compactor.dml`, 'utf8') as string;
    const recipe = vol.readFileSync(recipePath, 'utf8') as string;
    const tuiGuide = vol.readFileSync(`${docsDir}/TUI.md`, 'utf8') as string;
    const dmlReference = vol.readFileSync(`${docsDir}/DML_REFERENCE.md`, 'utf8') as string;
    const planDml = vol.readFileSync(`${systemDir}/plan.dml`, 'utf8') as string;

    expect(conductorPrompt).toContain('# Who you are');
    expect(compilerPrompt).toContain('DeepClause Meta Language');
    expect(planDml).toContain("make_directory_path('plans')");
    expect(planDml).toContain('.deepclause/docs/DML_REFERENCE.md');
    expect(planDml).toContain('.deepclause/system/DML_COMPILER_PROMPT.md');
    expect(planDml).toContain("exists_file('.deepclause/docs/DML_REFERENCE.md')");
    expect(planDml).toContain("read_file('.deepclause/docs/DML_REFERENCE.md', DmlReference)");
    expect(planDml).toContain("exists_file('.deepclause/system/DML_COMPILER_PROMPT.md')");
    expect(planDml).toContain("read_file('.deepclause/system/DML_COMPILER_PROMPT.md', CompilerPrompt)");
    expect(planDml).toContain('tool(consult_recipes(Query, Result)');
    expect(planDml).toContain('tool(search_web(Query, Results)');
    expect(planDml).toContain('tool(fetch_url(Url, Content)');
    expect(planDml).toContain('tool(list_skills(Skills)');
    expect(planDml).toContain('tool(run_skill(Slug, Args, Result)');
    expect(planDml).toContain('tool(ask_user(Prompt, Response)');
    expect(planDml).toContain('exec(write_file(path: FilePath, content: PlanDml), _)');
    expect(planDml).toContain('exec(validate_dml(dml_file: FilePath), ValidationResult)');
    expect(planDml).not.toContain('tool(write(Path, Content, Result)');
    expect(planDml).toContain('load_coding_workflow_recipe(CodingWorkflowRecipe)');
    expect(planDml).toContain("consult_recipes('deepclause coding workflow', RecipeSearchResult)");
    expect(planDml).toContain('Current user request:');
    expect(planDml).toContain('Before drafting the task list, consult recipes relevant to the request.');
    expect(planDml).toContain('First decide whether the current request is primarily a coding task, a non-coding task, or a mixed task.');
    expect(planDml).toContain('For coding tasks, prefer recipe guidance, existing local skills, and repository-aware implementation steps.');
    expect(planDml).toContain('For non-coding tasks, prefer recipe guidance plus search_web/fetch_url for factual research, background gathering, comparison, or synthesis.');
    expect(planDml).toContain("Classify this request for plan execution: '{Request}'.");
    expect(planDml).toContain('Return exactly one label: coding, non_coding, or mixed.');
    expect(planDml).toContain('derive_plan_system_prompt(Request, PlanMode, CodingWorkflowRecipe, PlanTasks, PlanSystemPrompt)');
    expect(planDml).toContain('Create a concise system prompt for the generated DeepClause plan for this request');
    expect(planDml).toContain('DeepClause Coding Workflow recipe content:');
    expect(planDml).toContain('Include the DeepClause Coding Workflow recipe guidance below in the final system prompt so the generated plan always carries it forward.');
    expect(planDml).toContain('Explicitly say that discussions, questions, and clarifications are fine, and ask_user can be used when helpful.');
    expect(planDml).toContain('build_plan_review_message(FilePath, PlanMode, PlanTasks, PlanReviewMessage)');
    expect(planDml).toContain('Proposed plan overview');
    expect(planDml).toContain('Planned steps:');
    expect(planDml).toContain('Consult relevant recipes before finalizing PlanTasks.');
    expect(planDml).toContain('Decide whether the request is primarily coding, non-coding, or mixed, and shape the task list accordingly.');
    expect(planDml).toContain('Return only an ordered list of 3 to 8 plain natural-language task strings.');
    expect(planDml).toContain('Return only the ordered list of task descriptions in PlanTasks.');
    expect(planDml).toContain('assemble_plan_dml(PlanSystemPrompt, PlanTasks, PlanDml)');
    expect(planDml).toContain('This file was assembled deterministically from a task list.');
    expect(planDml).toContain('system(~q),');
    expect(planDml).not.toContain('generated_plan_system_prompt(');
    expect(planDml).toContain("I've created a new plan in ~w.\\n\\n~s\\nRun it with /run ~w or /~w.");
    expect(planDml).toContain('tool(search_news(Query, Results), "Search recent news articles. Returns news results.") :-');
    expect(planDml).toContain('tool(download_file(Url, FilePath, Size), "Download a file from a URL and save it to disk. Returns the file path and size.") :-');
    expect(planDml).toContain('tool(run_bash(Command, Output), "Run a shell command in the workspace.") :-');
    expect(planDml).toContain("Plans should generally create or modify normal project files outside '.deepclause/'.");
    expect(compilerPrompt).toContain('.deepclause/tools/lib/<skill-or-tool-name>/');
    expect(compilerPrompt).toContain('.venv');
    expect(dmlReference).toContain('# DML Language Reference');
    expect(dmlReference).toContain('task/1, task/2, task/3, task/4');
    expect(sessionCompactor).toContain('messages_json');
    expect(sessionCompactor).toContain('param(message_count, MessageCount)');
    expect(sessionCompactor).toContain('param(estimated_tokens, EstimatedTokens)');
    expect(sessionCompactor).toContain('EstimatedTokens < 50000');
    expect(loopCompactor).toContain('messages_json');
    expect(loopCompactor).toContain('param(message_count, MessageCount)');
    expect(loopCompactor).toContain('param(estimated_tokens, EstimatedTokens)');
    expect(loopCompactor).toContain('EstimatedTokens < 50000');
    expect(recipe).toContain('DeepClause Coding Workflow');
    expect(recipe).toContain('create a proper skill instead');
    expect(tuiGuide).toContain('# DeepClause TUI Guide');
  });

  it('seeds the task prompt override during init', async () => {
    await initConfig('/workspace');

    const systemDir = getSystemDir('/workspace');
    expect(vol.existsSync(`${systemDir}/TASK_PROMPT.md`)).toBe(true);

    const taskPrompt = vol.readFileSync(`${systemDir}/TASK_PROMPT.md`, 'utf8') as string;
    expect(taskPrompt).toContain('# DeepClause Task Harness');
    expect(taskPrompt).toContain('{TASK_DESCRIPTION}');
  });

  it('lists plan from the system override path even if a stale tools copy exists', async () => {
    await initConfig('/workspace');

    const toolsDir = getToolsDir('/workspace');
    vol.writeFileSync(`${toolsDir}/plan.dml`, 'agent_main(_):-answer("stale tool copy").\n');
    vol.writeFileSync(`${toolsDir}/plan.meta.json`, JSON.stringify({ description: 'stale', parameters: [], tools: [] }, null, 2));

    const commands = await listCommands('/workspace');
    const planCommand = commands.find((command) => command.name === 'plan');

    expect(planCommand).toMatchObject({
      path: '.deepclause/system/plan',
      description: 'Creates a simple standalone DML plan file from a request and saves it under plans/ in your workspace.',
    });
  });
});