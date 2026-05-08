import { afterEach, describe, expect, it, vi } from 'vitest';
import { webSearch } from '../src/cli/search.js';
import { withCapturedConsole } from '../src/system/runtime/console-capture.js';

describe('runtime console capture', () => {
  const originalBraveApiKey = process.env.BRAVE_API_KEY;
  const originalBraveKey = process.env.BRAVE_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof originalBraveApiKey === 'string') {
      process.env.BRAVE_API_KEY = originalBraveApiKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
    if (typeof originalBraveKey === 'string') {
      process.env.BRAVE_KEY = originalBraveKey;
    } else {
      delete process.env.BRAVE_KEY;
    }
  });

  it('captures Brave fallback warnings as log entries instead of writing to stderr', async () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_KEY;

    const entries: Array<{ level: string; text: string }> = [];
    const result = await withCapturedConsole(
      (entry) => entries.push(entry),
      () => webSearch({ query: 'deepclause sdk' }),
    );

    expect(result).toContain('MOCK DATA - No API key');
    expect(entries).toEqual([
      {
        level: 'warn',
        text: '⚠️  No BRAVE_API_KEY found, using mock search results',
      },
    ]);
  });
});