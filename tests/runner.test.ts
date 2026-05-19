import { describe, expect, it } from 'vitest';

import { decodeAgentOutputVars } from '../src/runner.js';

describe('decodeAgentOutputVars', () => {
  it('preserves typed output vars for multi-result task bindings', () => {
    const decoded = decodeAgentOutputVars([
      { name: 'FinalAnswer', type: 'string' },
      { name: 'MemoryUpdate', type: 'string' },
    ]);

    expect(decoded).toEqual([
      { name: 'FinalAnswer', type: 'string' },
      { name: 'MemoryUpdate', type: 'string' },
    ]);
  });

  it('converts plain output vars to strings', () => {
    const decoded = decodeAgentOutputVars(['Summary', 'Status']);

    expect(decoded).toEqual(['Summary', 'Status']);
  });
});