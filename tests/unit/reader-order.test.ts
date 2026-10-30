import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadReaderConfigFromEnv, pickReaderUrl } from '../../src/rag/reader';

describe('reader order', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['OCTO_READER_URL'];
  });

  it('reads comma-separated reader URLs in order', () => {
    process.env['OCTO_READER_URL'] = 'http://gpu:6787/v1/, http://mac:8090/v1';
    expect(loadReaderConfigFromEnv()?.baseUrls).toEqual(['http://gpu:6787/v1', 'http://mac:8090/v1']);
  });

  it('skips a reader that does not answer and uses the next', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('http://gpu')) throw new TypeError('fetch failed');
      return new Response('{"data":[]}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await pickReaderUrl(['http://gpu/v1', 'http://mac/v1'])).toBe('http://mac/v1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prefers the first reader when it answers', async () => {
    const fetchMock = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await pickReaderUrl(['http://gpu/v1', 'http://mac/v1'])).toBe('http://gpu/v1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
