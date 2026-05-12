import { existsSync } from 'fs';
import { access, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type SystemSkillAssetName = 'conductor' | 'skill-creator';
export type SystemPromptAssetName = 'conductor' | 'skill-creator';
export type WorkspaceDocAssetName = 'tui';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, 'skills');
const DOCS_DIR = join(__dirname, 'docs');
const SYSTEM_OVERRIDE_DIR = '.deepclause/system';

function getSystemSkillFileName(name: SystemSkillAssetName): string {
  switch (name) {
    case 'conductor':
      return 'conductor.dml';
    case 'skill-creator':
      return 'skill-creator.dml';
  }
}

function getSystemPromptFileName(name: SystemPromptAssetName): string {
  switch (name) {
    case 'conductor':
      return 'CONDUCTOR_PROMPT.md';
    case 'skill-creator':
      return 'DML_COMPILER_PROMPT.md';
  }
}

export function getSystemSkillAssetPath(name: SystemSkillAssetName): string {
  return join(SKILLS_DIR, getSystemSkillFileName(name));
}

export function getSystemPromptAssetPath(name: SystemPromptAssetName): string {
  return join(DOCS_DIR, getSystemPromptFileName(name));
}

function getWorkspaceDocFileName(name: WorkspaceDocAssetName): string {
  switch (name) {
    case 'tui':
      return 'TUI.md';
  }
}

export function getWorkspaceDocAssetPath(name: WorkspaceDocAssetName): string {
  return join(DOCS_DIR, getWorkspaceDocFileName(name));
}

function getWorkspaceOverridePath(workspaceRoot: string, fileName: string): string {
  return join(workspaceRoot, SYSTEM_OVERRIDE_DIR, fileName);
}

async function resolveSystemSkillAssetPath(
  name: SystemSkillAssetName,
  workspaceRoot?: string,
): Promise<string> {
  if (workspaceRoot) {
    const overridePath = getWorkspaceOverridePath(workspaceRoot, getSystemSkillFileName(name));
    try {
      await access(overridePath);
      return overridePath;
    } catch {
      // Fall back to the packaged asset when no workspace override exists.
    }
  }

  return getSystemSkillAssetPath(name);
}

async function resolveSystemPromptAssetPath(
  name: SystemPromptAssetName,
  workspaceRoot?: string,
): Promise<string> {
  if (workspaceRoot) {
    const overridePath = getWorkspaceOverridePath(workspaceRoot, getSystemPromptFileName(name));
    try {
      await access(overridePath);
      return overridePath;
    } catch {
      // Fall back to the packaged asset when no workspace override exists.
    }
  }

  return getSystemPromptAssetPath(name);
}

function resolveSystemSkillAssetPathSync(
  name: SystemSkillAssetName,
  workspaceRoot?: string,
): string {
  if (workspaceRoot) {
    const overridePath = getWorkspaceOverridePath(workspaceRoot, getSystemSkillFileName(name));
    if (existsSync(overridePath)) {
      return overridePath;
    }
  }

  return getSystemSkillAssetPath(name);
}

function resolveSystemPromptAssetPathSync(
  name: SystemPromptAssetName,
  workspaceRoot?: string,
): string {
  if (workspaceRoot) {
    const overridePath = getWorkspaceOverridePath(workspaceRoot, getSystemPromptFileName(name));
    if (existsSync(overridePath)) {
      return overridePath;
    }
  }

  return getSystemPromptAssetPath(name);
}

export function getSystemAssetSourcePaths(workspaceRoot?: string): {
  conductorDml: string;
  conductorPrompt: string;
  skillCreatorDml: string;
  skillCreatorPrompt: string;
} {
  return {
    conductorDml: resolveSystemSkillAssetPathSync('conductor', workspaceRoot),
    conductorPrompt: resolveSystemPromptAssetPathSync('conductor', workspaceRoot),
    skillCreatorDml: resolveSystemSkillAssetPathSync('skill-creator', workspaceRoot),
    skillCreatorPrompt: resolveSystemPromptAssetPathSync('skill-creator', workspaceRoot),
  };
}

export async function readSystemSkillAsset(
  name: SystemSkillAssetName,
  options: { workspaceRoot?: string } = {},
): Promise<string> {
  return readFile(await resolveSystemSkillAssetPath(name, options.workspaceRoot), 'utf8');
}

export async function readSystemPromptAsset(
  name: SystemPromptAssetName,
  options: { workspaceRoot?: string } = {},
): Promise<string> {
  return readFile(await resolveSystemPromptAssetPath(name, options.workspaceRoot), 'utf8');
}