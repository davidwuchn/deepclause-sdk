import { access, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type SystemSkillAssetName = 'conductor' | 'skill-creator';
export type SystemPromptAssetName = 'conductor' | 'skill-creator';

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

export function getSystemSkillAssetPath(name: SystemSkillAssetName): string {
  return join(SKILLS_DIR, getSystemSkillFileName(name));
}

export function getSystemPromptAssetPath(name: SystemPromptAssetName): string {
  switch (name) {
    case 'conductor':
      return join(DOCS_DIR, 'CONDUCTOR_PROMPT.md');
    case 'skill-creator':
      return join(DOCS_DIR, 'DML_COMPILER_PROMPT.md');
  }
}

async function resolveSystemSkillAssetPath(
  name: SystemSkillAssetName,
  workspaceRoot?: string,
): Promise<string> {
  if (workspaceRoot) {
    const overridePath = join(workspaceRoot, SYSTEM_OVERRIDE_DIR, getSystemSkillFileName(name));
    try {
      await access(overridePath);
      return overridePath;
    } catch {
      // Fall back to the packaged asset when no workspace override exists.
    }
  }

  return getSystemSkillAssetPath(name);
}

export async function readSystemSkillAsset(
  name: SystemSkillAssetName,
  options: { workspaceRoot?: string } = {},
): Promise<string> {
  return readFile(await resolveSystemSkillAssetPath(name, options.workspaceRoot), 'utf8');
}

export async function readSystemPromptAsset(name: SystemPromptAssetName): Promise<string> {
  return readFile(getSystemPromptAssetPath(name), 'utf8');
}