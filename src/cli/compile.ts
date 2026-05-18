/**
 * DeepClause CLI - Compilation Module
 * 
 * Compiles Markdown task descriptions to DML programs using an agentic loop
 * with LLM generation and Prolog validation.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  applyResolvedModelConfig,
  buildModelOverride,
  getDefaultConfig,
  loadConfig,
  resolveModelSlot,
  type Config,
  type Provider,
} from './config.js';
import { promptUser } from './interactive.js';
import { compileWithSkillCreator } from '../system/runtime/skill-creator.js';
import type { DMLEvent } from '../types.js';
import {
  extractDescription as extractDescriptionFromCompiler,
  extractParameters as extractParametersFromCompiler,
  extractToolDependencies as extractToolDependenciesFromCompiler,
} from '../compiler.js';
import type { AnalysisResult } from '../types.js';

// =============================================================================
// Types
// =============================================================================

export interface CompileOptions {
  force?: boolean;
  validateOnly?: boolean;
  sandbox?: boolean;
  model?: string;
  provider?: Provider;
  temperature?: number;
  maxAttempts?: number;
  verbose?: boolean;
  stream?: boolean;
  audit?: boolean;
  headless?: boolean;
  trace?: string;
  signal?: AbortSignal;
  onEvent?: (event: DMLEvent) => void;
}

export interface CompileResult {
  output: string;
  tools: string[];
  skipped: boolean;
  valid: boolean;
  dml?: string;
  meta?: MetaFile;
  explanation?: string;
  attempts?: number;
  analysis?: AnalysisResult;
  runtimeOutput?: string[];
  trace?: object;
  events?: DMLEvent[];
}

interface CompileExecutionError extends Error {
  runtimeOutput?: string[];
  trace?: object;
  events?: DMLEvent[];
}

export interface CompileAllResult {
  compiled: number;
  skipped: number;
  failed: number;
  errors: Array<{ file: string; error: string }>;
}

export interface MetaFile {
  version: string;
  source: string;
  sourceHash: string;
  compiledAt: string;
  model: string;
  provider: string;
  name?: string;
  triggerPhrases?: string[];
  capabilities?: string[];
  description: string;
  parameters: Array<{
    name: string;
    description?: string;
    required?: boolean;
    default?: string;
    position: number;
  }>;
  tools: string[];
  history: Array<{
    version: number;
    timestamp: string;
    sourceHash: string;
    model: string;
    provider: string;
  }>;
}

// =============================================================================
// Status Indicator
// =============================================================================

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class StatusIndicator {
  private frame = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private message = '';
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled && process.stdout.isTTY === true;
  }

  start(message: string): void {
    if (!this.enabled) {
      console.log(`  ${message}`);
      return;
    }
    this.message = message;
    this.frame = 0;
    this.render();
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 80);
  }

  update(message: string): void {
    this.message = message;
    if (!this.enabled) {
      console.log(`  ${message}`);
    } else {
      this.render();
    }
  }

  private render(): void {
    process.stdout.write(`\r${SPINNER_FRAMES[this.frame]} ${this.message}`.padEnd(80));
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.enabled) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }
    if (finalMessage) {
      console.log(finalMessage);
    }
  }
}

// =============================================================================
// Main Compilation Functions
// =============================================================================

/**
 * Compile a Markdown task description to DML using an agentic loop
 */
export async function compile(
  sourcePath: string,
  outputDir: string,
  options: CompileOptions = {}
): Promise<CompileResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const verbose = options.verbose ?? false;
  const shouldStream = options.stream ?? false;
  const shouldAudit = options.audit !== false;
  
  // Resolve paths
  const absoluteSource = path.resolve(sourcePath);
  const absoluteOutputDir = path.resolve(outputDir);
  
  // Read source file
  let markdown: string;
  try {
    markdown = await fs.readFile(absoluteSource, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read source file: ${absoluteSource}`);
  }

  // Calculate source hash
  const sourceHash = computeHash(markdown);

  // Determine output file names
  const baseName = path.basename(absoluteSource, path.extname(absoluteSource));
  const dmlPath = path.join(absoluteOutputDir, `${baseName}.dml`);
  const metaPath = path.join(absoluteOutputDir, `${baseName}.meta.json`);

  // Check for existing compilation (caching)
  if (!options.force && !options.validateOnly) {
    const existing = await loadExistingMeta(metaPath);
    if (existing && existing.sourceHash === sourceHash) {
      return {
        output: dmlPath,
        tools: existing.tools,
        skipped: true,
        valid: true,
        meta: existing
      };
    }
  }

  // Load config for model/provider (try cwd first, then source dir, then use defaults)
  let config: Config;
  let workspaceRoot: string | undefined;
  try {
    workspaceRoot = process.cwd();
    config = await loadConfig(process.cwd());
  } catch {
    try {
      const sourceDir = path.dirname(absoluteSource).split('/.deepclause')[0];
      workspaceRoot = sourceDir;
      config = await loadConfig(sourceDir);
    } catch {
      // Use sensible defaults if no config found
      workspaceRoot = process.cwd();
      config = getDefaultConfig();
    }
  }
  const compileSelection = resolveModelSlot(config, 'compile', {
    modelId: buildModelOverride(options.model, options.provider),
    temperature: options.temperature,
  });
  applyResolvedModelConfig(compileSelection);
  const runSelection = resolveModelSlot(config, 'run');

  const runtimeOutput: string[] = [];
  const events: DMLEvent[] = [];
  let executionTrace: object | undefined;

  const captureEvents = (
    options.headless
    || shouldStream
    || verbose
    || !!options.trace
    || !!options.onEvent
  );

  const status = new StatusIndicator(!captureEvents);
  if (!captureEvents) {
    status.start('Compiling...');
  }

  const handleEvent = (event: DMLEvent): void => {
    events.push(event);

    if (event.type === 'output' && event.content) {
      runtimeOutput.push(event.content);
    }

    if ((event.type === 'finished' || event.type === 'error') && event.trace) {
      executionTrace = event.trace;
    }

    options.onEvent?.(event);
  };

  try {
    const result = await compileWithSkillCreator(markdown, {
      sourcePath: absoluteSource,
      outputDir: absoluteOutputDir,
      baseName,
      workspaceRoot,
      workspacePath: path.resolve(config.workspace || './workspace'),
      config,
      compileSelection,
      runSelection,
      sandbox: options.sandbox,
      validateOnly: options.validateOnly,
      maxAttempts,
      verbose,
      stream: shouldStream,
      trace: !!options.trace,
      audit: shouldAudit,
      onUserInput: promptUser,
      signal: options.signal,
      onEvent: handleEvent,
    });

    if (!captureEvents) {
      status.stop();
    }

    if (options.trace && executionTrace) {
      const tracePath = path.resolve(options.trace);
      await fs.writeFile(tracePath, JSON.stringify(executionTrace, null, 2) + '\n');
    }

    if (!options.onEvent && !options.headless && result.analysis.warnings.length > 0) {
      console.log('\n⚠️  Static Analysis Warnings:');
      for (const warning of result.analysis.warnings) {
        const icon = warning.level === 'critical' ? '🔴' : warning.level === 'high' ? '🟠' : warning.level === 'medium' ? '🟡' : '⚪';
        console.log(`  ${icon} [${warning.level.toUpperCase()}] ${warning.message}`);
      }
    }

    if (!options.onEvent && !options.headless) {
      console.log('\n✅ Compilation successful!\n');
      console.log(result.explanation);
    }

    return {
      output: dmlPath,
      tools: result.tools,
      skipped: false,
      valid: true,
      dml: result.dml,
      meta: result.meta,
      explanation: result.explanation,
      attempts: 1,
      analysis: result.analysis,
      runtimeOutput,
      trace: executionTrace,
      events,
    };
  } catch (error) {
    if (!captureEvents) {
      status.stop();
    }

    if (options.trace && executionTrace) {
      const tracePath = path.resolve(options.trace);
      await fs.writeFile(tracePath, JSON.stringify(executionTrace, null, 2) + '\n');
    }

    const compileError: CompileExecutionError = error instanceof Error
      ? error as CompileExecutionError
      : new Error(String(error));
    compileError.runtimeOutput = runtimeOutput;
    compileError.trace = executionTrace;
    compileError.events = events;
    throw compileError;
  }
}

/**
 * Compile all Markdown files in a directory
 */
export async function compileAll(
  sourceDir: string,
  outputDir: string,
  options: CompileOptions = {}
): Promise<CompileAllResult> {
  const absoluteSourceDir = path.resolve(sourceDir);
  const absoluteOutputDir = path.resolve(outputDir);

  // Find all markdown files
  let files: string[];
  try {
    const entries = await fs.readdir(absoluteSourceDir);
    files = entries.filter(f => f.endsWith('.md'));
  } catch (error) {
    throw new Error(`Failed to read source directory: ${absoluteSourceDir}`);
  }

  const result: CompileAllResult = {
    compiled: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };

  // Compile each file
  for (const file of files) {
    const sourcePath = path.join(absoluteSourceDir, file);
    
    try {
      const compileResult = await compile(sourcePath, absoluteOutputDir, {
        ...options,
        stream: false,  // Don't stream when batch compiling
        verbose: false,
        headless: true,
      });
      
      if (compileResult.skipped) {
        result.skipped++;
      } else {
        result.compiled++;
      }
    } catch (error) {
      result.failed++;
      result.errors.push({
        file,
        error: (error as Error).message
      });
    }
  }

  return result;
}

/**
 * Compile a natural language prompt directly to DML without saving to disk
 */
export async function compilePrompt(
  prompt: string,
  options: CompileOptions = {}
): Promise<{ dml: string; tools: string[] }> {
  const workspaceRoot = process.cwd();
  const config = await loadConfig(process.cwd());
  const compileSelection = resolveModelSlot(config, 'compile', {
    modelId: buildModelOverride(options.model, options.provider),
    temperature: options.temperature,
  });
  const runSelection = resolveModelSlot(config, 'run');

  const result = await compileWithSkillCreator(prompt, {
    sourcePath: 'oneshot.md',
    outputDir: path.resolve(config.dmlBase || '.deepclause/tools'),
    baseName: 'oneshot',
    workspaceRoot,
    workspacePath: path.resolve(config.workspace || './workspace'),
    config,
    compileSelection,
    runSelection,
    sandbox: options.sandbox,
    validateOnly: true,
    maxAttempts: options.maxAttempts,
    verbose: options.verbose,
    audit: options.audit !== false,
    onUserInput: promptUser,
  });

  return {
    dml: result.dml,
    tools: result.tools,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compute SHA-256 hash of content
 */
function computeHash(content: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Load existing meta file if it exists
 */
async function loadExistingMeta(metaPath: string): Promise<MetaFile | null> {
  try {
    const content = await fs.readFile(metaPath, 'utf-8');
    return JSON.parse(content) as MetaFile;
  } catch {
    return null;
  }
}

export const extractToolDependencies = extractToolDependenciesFromCompiler;
export const extractParameters = extractParametersFromCompiler;
export const extractDescription = extractDescriptionFromCompiler;

export function validateDMLSyntax(dml: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!dml.includes('agent_main')) {
    errors.push('Missing agent_main predicate');
  }

  const stripped = dml
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/%.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  let parenCount = 0;
  let bracketCount = 0;
  for (const char of stripped) {
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;
    if (char === '[') bracketCount++;
    if (char === ']') bracketCount--;
  }

  if (parenCount !== 0) {
    errors.push('Unbalanced parentheses');
  }
  if (bracketCount !== 0) {
    errors.push('Unbalanced brackets');
  }

  const withoutQuotedStrings = dml.replace(/"(?:[^"\\]|\\.)*"/g, '');
  if ((withoutQuotedStrings.match(/"/g) || []).length % 2 !== 0) {
    errors.push('Unclosed string literal');
  }

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
  };
}
