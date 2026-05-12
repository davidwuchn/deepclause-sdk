#!/usr/bin/env node
/**
 * DeepClause CLI
 * 
 * Command-line interface for compiling Markdown to DML and running DML programs.
 */

import { Command } from 'commander';
import { deepClauseDirExists, initConfig, setModel, showModel } from './config.js';
import { compile, compileAll } from './compile.js';
import { run } from './run.js';
import { listTools } from './tools.js';
import { listCommands } from './commands.js';
import { formatToolArgs } from './tool-args.js';
import { buildModelOverride, type ModelSlot } from '../system/config/model-slots.js';
import { runPromptHeadless, startTui } from './tui.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

const program = new Command();
const CLI_SUBCOMMANDS = new Set(['init', 'set-model', 'show-model', 'compile', 'compile-all', 'run', 'list-tools', 'list-commands', 'help']);

program
  .name('deepclause')
  .description('Compile Markdown to DML and run neurosymbolic AI agents')
  .version(version)
  .option('-p, --prompt <text>', 'Run a prompt in headless conductor mode with a fresh session')
  .option('--sandbox', 'Run shell tools inside AgentVM instead of the local workspace shell');

// =============================================================================
// Configuration Commands
// =============================================================================

program
  .command('init')
  .description('Initialize DeepClause configuration in current directory')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('--model <model>', 'Set initial model (default: gpt-4o)')
  .action(async (options) => {
    try {
      await initConfig(process.cwd(), options);
      console.log('✅ DeepClause initialized successfully');
      console.log('   Configuration: .deepclause/config.json');
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('set-model <model>')
  .description('Set the default LLM model (canonical format: provider:model)')
  .option('--slot <slot>', 'Apply only to a single slot: gateway, run, or compile')
  .action(async (model, options) => {
    try {
      const slot = options.slot as ModelSlot | undefined;
      const result = await setModel(process.cwd(), model, slot);
      console.log(`✅ Model set to: ${result.modelId}`);
      console.log(`   Updated slots: ${result.updatedSlots.join(', ')}`);
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('show-model')
  .description('Show the current LLM model')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const result = await showModel(process.cwd());
      if (options.json) {
        console.log(JSON.stringify({ models: result.models, temperatures: result.temperatures }, null, 2));
      } else {
        console.log(result.formatted);
      }
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      process.exit(1);
    }
  });

// =============================================================================
// Compilation Commands
// =============================================================================

program
  .command('compile <source> [output]')
  .description('Compile Markdown task description to DML')
  .option('-f, --force', 'Force recompilation even if source unchanged')
  .option('--validate-only', 'Validate without saving output')
  .option('--headless', 'Plain output only, no live formatting')
  .option('--sandbox', 'Run shell tools inside AgentVM instead of the local workspace shell')
  .option('--trace <file>', 'Save compilation trace to file')
  .option('--model <model>', 'Override model for compilation')
  .option('--provider <provider>', 'Override provider for compilation (openai, anthropic, google, openrouter)')
  .option('--temperature <number>', 'Override temperature (0.0-2.0)', parseFloat)
  .option('--max-attempts <number>', 'Max compilation attempts (default: 3)', parseInt)
  .option('-v, --verbose', 'Show debug output including tool calls')
  .option('--stream', 'Stream LLM responses in real-time')
  .option('--no-audit', 'Disable the LLM security audit (static analysis still runs)')
  .action(async (source, output, options) => {
    try {
      const outputDir = output || '.deepclause/tools';

      const liveOutput: string[] = [];
      const onEvent = (event: import('../types.js').DMLEvent): void => {
        switch (event.type) {
          case 'output':
            if (event.content) {
              liveOutput.push(event.content);
              if (!options.headless) {
                process.stdout.write(`${event.content}\n`);
              }
            }
            break;
          case 'stream':
            if (options.stream && !options.headless && event.content) {
              process.stdout.write(event.content);
            }
            if (options.stream && !options.headless && event.done) {
              process.stdout.write('\n');
            }
            break;
          case 'log':
            if (options.verbose && !options.headless && event.content) {
              process.stdout.write(`[log] ${event.content}\n`);
            }
            break;
          case 'tool_call':
            if (options.verbose && !options.headless && event.toolName) {
              process.stdout.write(`  🔧 ${event.toolName}(${formatToolArgs(event.toolArgs)})\n`);
            }
            break;
          case 'input_required':
            if (options.verbose && !options.headless && event.prompt) {
              process.stdout.write(`[input_required] ${event.prompt}\n`);
            }
            break;
          default:
            break;
        }
      };
      
      const result = await compile(source, outputDir, {
        force: options.force,
        validateOnly: options.validateOnly,
        headless: options.headless,
        sandbox: options.sandbox,
        trace: options.trace,
        model: buildModelOverride(options.model, options.provider),
        provider: options.provider as import('../system/config/model-slots.js').Provider,
        temperature: options.temperature,
        maxAttempts: options.maxAttempts,
        verbose: options.verbose,
        stream: options.stream,
        audit: options.audit !== false,
        onEvent,
      });

      if (result.analysis?.warnings?.length) {
        console.log('\n⚠️  Static Analysis Warnings:');
        for (const warning of result.analysis.warnings) {
          const icon = warning.level === 'critical' ? '🔴' : warning.level === 'high' ? '🟠' : warning.level === 'medium' ? '🟡' : '⚪';
          console.log(`  ${icon} [${warning.level.toUpperCase()}] ${warning.message}`);
        }
      }

      if (result.analysis?.auditorReport) {
        console.log('\n🛡️  LLM Security Audit:\n');
        console.log(result.analysis.auditorReport);
      }

      if (options.headless) {
        for (const out of result.runtimeOutput ?? liveOutput) {
          console.log(out);
        }
      }
      
      if (result.skipped) {
        console.log(`⏭️  Skipped (unchanged): ${source}`);
      } else {
        console.log('\n✅ Compilation successful!\n');
        if (result.explanation) {
          console.log(result.explanation);
        }
      }

      if (!result.skipped && !options.validateOnly) {
        console.log(`\n   Output: ${result.output}`);
        console.log(`   Tools: ${result.tools.join(', ') || 'none'}`);
        if (result.attempts && result.attempts > 1) {
          console.log(`   Attempts: ${result.attempts}`);
        }
      }

      if (!result.skipped && options.trace) {
        console.log(`\n📊 Trace saved to: ${options.trace}`);
      }
    } catch (error) {
      const compileError = error as {
        runtimeOutput?: string[];
        trace?: object;
      };

      if (options.headless && Array.isArray(compileError.runtimeOutput)) {
        for (const out of compileError.runtimeOutput) {
          console.log(out);
        }
      }

      const message = error instanceof Error && error.message
        ? error.message
        : String(error);
      console.error(message.startsWith('❌') ? message : `❌ Error: ${message}`);
      if (options.trace && compileError.trace) {
        console.log(`\n📊 Trace saved to: ${options.trace}`);
      }
      if (options.verbose && error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('compile-all <sourceDir> [outputDir]')
  .description('Compile all Markdown files in a directory')
  .option('-f, --force', 'Force recompilation of all files')
  .option('--sandbox', 'Run shell tools inside AgentVM instead of the local workspace shell')
  .option('--model <model>', 'Override model for compilation')
  .option('--provider <provider>', 'Override provider for compilation (openai, anthropic, google, openrouter)')
  .option('--temperature <number>', 'Override temperature (0.0-2.0)', parseFloat)
  .option('--max-attempts <number>', 'Max compilation attempts per file (default: 3)', parseInt)
  .option('--no-audit', 'Disable the LLM security audit (static analysis still runs)')
  .action(async (sourceDir, outputDir, options) => {
    try {
      const out = outputDir || '.deepclause/tools';
      
      const result = await compileAll(sourceDir, out, {
        force: options.force,
        sandbox: options.sandbox,
        model: buildModelOverride(options.model, options.provider),
        provider: options.provider as import('../system/config/model-slots.js').Provider,
        temperature: options.temperature,
        maxAttempts: options.maxAttempts,
        audit: options.audit !== false,
      });
      
      console.log(`\n📊 Compilation Summary:`);
      console.log(`   Compiled: ${result.compiled}`);
      console.log(`   Skipped:  ${result.skipped}`);
      console.log(`   Failed:   ${result.failed}`);
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      process.exit(1);
    }
  });

// =============================================================================
// Execution Commands
// =============================================================================

program
  .command('run [file] [args...]')
  .description('Execute a compiled DML program or generate and run DML from a prompt')
  .option('--workspace <path>', 'Working directory for file operations', './')
  .option('--verbose', 'Show debug output including tool calls')
  .option('--stream', 'Stream LLM responses in real-time')
  .option('--headless', 'Plain output only, no TUI formatting')
  .option('--sandbox', 'Run shell tools inside AgentVM instead of the local workspace shell')
  .option('--trace <file>', 'Save execution trace to file')
  .option('--dry-run', 'Show what would be executed without running')
  .option('--model <model>', 'Override configured model (can be provider/model format, e.g., google/gemini-2.5-pro)')
  .option('--provider <provider>', 'Override configured provider (openai, anthropic, google, openrouter)')
  .option('--temperature <number>', 'Override temperature (0.0-2.0)', parseFloat)
  .option('--no-audit', 'Disable the LLM security audit for one-shot prompt compilation')
  .option('--gas-limit <number>', 'Maximum number of execution steps', parseInt)
  .option('-p, --prompt <text>', 'One-shot prompt: generate and run DML from natural language')
  .option('-P, --param <key=value>', 'Pass named parameter (can be repeated)', collectParams, {})
  .action(async (file, args, options) => {
    try {
      // Parse provider/model format if provided (e.g., "google/gemini-2.5-pro")
      let model = options.model;
      let provider = options.provider;
      if (model && model.includes('/')) {
        const [parsedProvider, ...modelParts] = model.split('/');
        provider = provider || parsedProvider;
        model = modelParts.join('/'); // Handle models with / in name
      }
      
      const result = await run(file, args, {
        workspace: options.workspace,
        verbose: options.verbose,
        stream: options.stream,
        headless: options.headless,
        sandbox: options.sandbox,
        trace: options.trace,
        dryRun: options.dryRun,
        model,
        provider: provider as import('../system/config/model-slots.js').Provider,
        temperature: options.temperature,
        audit: options.audit !== false,
        gasLimit: options.gasLimit,
        params: options.param,
        prompt: options.prompt
      });


      if (options.dryRun) {
        console.log(result.wouldExecute);
      } else {
        // Show outputs only in headless mode (in interactive mode they were already shown)
        if (options.headless && result.output.length > 0) {
          for (const out of result.output) {
            console.log(out);
          }
        }
        
        // Show answer
        if (result.answer) {
          if (result.output.length > 0) {
            console.log(''); // Blank line before answer
          }
          console.log(result.answer);
        }
        
        // Show error
        if (result.error) {
          console.error('❌ Error:', result.error);
          process.exit(1);
        }
        
        // Show trace location if saved
        if (options.trace) {
          console.log(`\n📊 Trace saved to: ${options.trace}`);
        }
      }
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      if (options.verbose) {
        console.error((error as Error).stack);
      }
      process.exit(1);
    }
  });

// =============================================================================
// Listing Commands
// =============================================================================

program
  .command('list-tools')
  .description('List all available built-in runtime tools and MCP server tools')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const tools = await listTools(process.cwd(), { json: options.json });
      
      if (options.json) {
        console.log(tools);
      } else {
        console.log('Available Tools:\n');
        console.log(tools);
      }
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('list-commands')
  .description('List all compiled DML commands')
  .option('--json', 'Output as JSON')
  .option('--detailed', 'Show parameters and tool dependencies')
  .action(async (options) => {
    try {
      const commands = await listCommands(process.cwd(), {
        json: options.json,
        detailed: options.detailed
      });
      
      if (options.json) {
        console.log(JSON.stringify(commands, null, 2));
      } else {
        console.log('Compiled Commands:\n');
        for (const cmd of commands) {
          console.log(`📋 ${cmd.name}`);
          console.log(`   ${cmd.description}`);
          if (options.detailed && cmd.parameters) {
            console.log('   Parameters:');
            for (const p of cmd.parameters) {
              const req = p.required ? '(required)' : `(optional, default: ${p.default})`;
              console.log(`     • ${p.name} ${req} - ${p.description}`);
            }
            if (cmd.tools?.length) {
              console.log('   Tool Dependencies:');
              for (const t of cmd.tools) {
                console.log(`     • ${t}`);
              }
            }
          }
          console.log(`   Usage: deepclause run ${cmd.path}\n`);
        }
      }
    } catch (error) {
      console.error('❌ Error:', (error as Error).message);
      process.exit(1);
    }
  });

// =============================================================================
// Helper Functions
// =============================================================================

function collectParams(value: string, previous: Record<string, string>): Record<string, string> {
  const [key, val] = value.split('=');
  if (!key || val === undefined) {
    throw new Error(`Invalid param format: ${value}. Use key=value`);
  }
  return { ...previous, [key]: val };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rootPrompt = readRootPrompt(argv);
  const rootSandbox = hasRootSandbox(argv);

  if (requiresInitializedWorkspace(argv) && !await deepClauseDirExists(process.cwd())) {
    console.warn('⚠️  No .deepclause directory found in this workspace.');
    console.warn("   Run 'deepclause init' first.");
    process.exit(1);
  }

  if (rootPrompt && !hasSubcommand(argv)) {
    await runPromptHeadless(rootPrompt, process.cwd(), { sandbox: rootSandbox });
    return;
  }

  if (argv.length === 0) {
    await startTui(process.cwd(), { sandbox: rootSandbox });
    return;
  }

  if (argv.length === 1 && rootSandbox) {
    await startTui(process.cwd(), { sandbox: true });
    return;
  }

  await program.parseAsync(process.argv);
}

function hasSubcommand(argv: string[]): boolean {
  return argv.some((arg) => !arg.startsWith('-') && CLI_SUBCOMMANDS.has(arg));
}

function readRootPrompt(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-p' || arg === '--prompt') {
      return argv[index + 1];
    }
    if (arg.startsWith('--prompt=')) {
      return arg.slice('--prompt='.length);
    }
  }

  return undefined;
}

function hasRootSandbox(argv: string[]): boolean {
  return argv.includes('--sandbox');
}

function requiresInitializedWorkspace(argv: string[]): boolean {
  if (argv.includes('-h') || argv.includes('--help') || argv.includes('-V') || argv.includes('--version')) {
    return false;
  }

  const firstPositional = argv.find((arg) => !arg.startsWith('-'));
  if (!firstPositional) {
    return true;
  }

  return firstPositional !== 'init' && firstPositional !== 'help';
}

main().catch((error) => {
  console.error('❌ Error:', (error as Error).message);
  process.exit(1);
});
