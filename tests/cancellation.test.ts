import { afterEach, describe, expect, it, vi } from 'vitest';
import { webSearch } from '../src/cli/search.js';
import { urlFetch } from '../src/system/runtime/runtime-tools.js';

describe('runtime cancellation', () => {
  const originalBraveApiKey = process.env.BRAVE_API_KEY;
  const originalBraveKey = process.env.BRAVE_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('propagates aborts through Brave web search instead of falling back to mock results', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => pendingAbortableFetch(init?.signal));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = webSearch({ query: 'quantum computing', signal: controller.signal });
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://api.search.brave.com/res/v1/web/search?'),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('passes abort signals into url_fetch requests', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => pendingAbortableFetch(init?.signal));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = urlFetch('/tmp', { url: 'https://example.com/data.txt' }, controller.signal);
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/data.txt',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

function pendingAbortableFetch(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const fail = () => {
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    };

    if (!signal) {
      reject(new Error('Expected abort signal'));
      return;
    }

    if (signal.aborted) {
      fail();
      return;
    }

    signal.addEventListener('abort', fail, { once: true });
  });
}