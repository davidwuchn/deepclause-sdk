import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  listRecipeCatalog,
  searchRecipeCatalog,
} from '../src/system/runtime/catalog-recipes.js';

describe('recipe catalog', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'deepclause-recipe-catalog-'));
    await mkdir(join(workspaceRoot, '.deepclause', 'system', 'recipes'), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('lists workspace recipes and parses frontmatter fields', async () => {
    await writeRecipe(workspaceRoot, 'repo-change-workflow', `---
name: Repo Change Workflow
description: Guidance for making code changes, tests, and docs updates.
tags: [coding, docs, tests]
when_to_use:
  - implementing a feature in the local repository
  - updating tests or documentation
when_not_to_use:
  - purely informational web research
globs: [src/**, tests/**, README.md]
priority: high
---

# Goal

Use focused reads, minimal edits, and narrow validation.
`);

    const catalog = await listRecipeCatalog(workspaceRoot);
    const recipe = catalog.find((entry) => entry.slug === 'repo-change-workflow');

    expect(recipe).toMatchObject({
      slug: 'repo-change-workflow',
      name: 'Repo Change Workflow',
      description: 'Guidance for making code changes, tests, and docs updates.',
      tags: ['coding', 'docs', 'tests'],
      whenToUse: [
        'implementing a feature in the local repository',
        'updating tests or documentation',
      ],
      whenNotToUse: ['purely informational web research'],
      globs: ['src/**', 'tests/**', 'README.md'],
      priority: 'high',
    });
    expect(recipe?.content).toContain('Use focused reads, minimal edits, and narrow validation.');
  });

  it('prefers workspace recipes over packaged recipes with the same slug', async () => {
    await writeRecipe(workspaceRoot, 'deepclause-coding-workflow', `---
name: Workspace Override
description: Workspace-specific override.
tags: [workspace]
---

Prefer workspace conventions first.
`);

    const catalog = await listRecipeCatalog(workspaceRoot);
    const recipe = catalog.find((entry) => entry.slug === 'deepclause-coding-workflow');

    expect(recipe).toMatchObject({
      source: 'workspace',
      name: 'Workspace Override',
      description: 'Workspace-specific override.',
    });
  });

  it('finds the most relevant recipes for a natural-language query', async () => {
    await writeRecipe(workspaceRoot, 'frontend-components', `---
name: Frontend Components
description: Patterns for TSX components and UI composition.
tags: [react, frontend, ui]
when_to_use:
  - creating a new TSX component
---

Use small components and nearby examples.
`);
    await writeRecipe(workspaceRoot, 'release-checklist', `---
name: Release Checklist
description: Steps for publishing a release.
tags: [release, changelog]
---

Update changelog, tag the release, and verify artifacts.
`);

    const matches = await searchRecipeCatalog(workspaceRoot, 'I need to update a TSX component in the frontend', {
      maxResults: 2,
    });

    expect(matches[0]).toMatchObject({
      slug: 'frontend-components',
    });
    expect(matches[0].matchedOn).toEqual(expect.arrayContaining(['description', 'tags', 'when_to_use']));
    expect(matches.some((entry) => entry.slug === 'release-checklist')).toBe(false);
  });
});

async function writeRecipe(workspaceRoot: string, slug: string, content: string): Promise<void> {
  const recipeDir = join(workspaceRoot, '.deepclause', 'system', 'recipes', slug);
  await mkdir(recipeDir, { recursive: true });
  await writeFile(join(recipeDir, 'SKILL.md'), content, 'utf8');
}