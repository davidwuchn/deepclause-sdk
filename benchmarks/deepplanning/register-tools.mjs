import fs from 'node:fs/promises';
import path from 'node:path';
import { callDeepPlanningTool, loadToolSchemas } from './python-bridge.mjs';

export async function registerDeepPlanningTools(sdk, options) {
  const { domain, dbPath, benchDir, pythonPath } = options;
  const schemas = await loadToolSchemas(benchDir, domain);

  for (const [toolName, schema] of schemas.entries()) {
    const safeName = toolName;
    sdk.registerTool(safeName, {
      description: schema.description ?? '',
      parameters: schema.parameters ?? { type: 'object', properties: {} },
      execute: async (args) => {
        const filtered = {};
        for (const [key, value] of Object.entries(args)) {
          if (key !== 'arg1') {
            filtered[key] = value;
          }
        }
        try {
          return await callDeepPlanningTool({
            domain,
            dbPath,
            toolName,
            args: filtered,
            benchDir,
            pythonPath,
          });
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  }
}
