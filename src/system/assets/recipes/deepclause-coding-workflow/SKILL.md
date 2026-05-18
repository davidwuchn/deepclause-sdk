---
name: DeepClause Coding Workflow
description: Guidance for implementing and validating local repository changes in a DeepClause workspace.
tags: [coding, repository, tests, docs, deepclause]
when_to_use:
  - implementing a feature or bug fix in the current repository
  - updating tests and documentation alongside code changes
  - debugging a local behavior before editing files
when_not_to_use:
  - purely informational web research
  - work that should become a reusable executable skill instead of a one-off repo change
globs: [src/**, tests/**, README.md, docs/**]
priority: high
---

# Goal

Make small, grounded repository changes with focused validation and clear outcomes.

# Workflow

1. Start from a concrete anchor such as a failing test, a named file, a command, or the nearest implementation surface.
2. Read only enough nearby code to form one falsifiable local hypothesis about what should change.
3. Prefer the smallest edit that tests that hypothesis.
4. Run the narrowest validation that can falsify the change before widening scope.
5. If the validation fails, repair the same slice first instead of opening new work.
6. Update documentation when behavior, workflow, or user-visible commands changed.

# When To Use

Use this recipe when the task is primarily about changing repository files, adding tests, or updating documentation in a controlled way.

# When Not To Use

Do not use this recipe for pure research or when the right outcome is to create a reusable DML worker skill.

# Examples

- Implement a narrow bug fix in `src/` and validate it with one focused Vitest file.
- Update a CLI workflow and document the changed behavior in `README.md`.
- Add a new config seed and verify it with the corresponding init tests.

# Escalation

If the task repeats often or clearly represents a reusable automation, stop treating it as a one-off workflow and create a proper skill instead.