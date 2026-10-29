import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sendStaticFile } from '../../src/server/static-file';

/**
 * A static asset read can fail after the caller's `existsSync`/`statSync` guard:
 * the file is deleted, permissions change, or the disk errors between the check
 * and the read. A ReadStream with no 'error' handler emits an unhandled error,
 * which is an uncaught exception that takes down the whole server process — not
 * just the one request. These tests pin the response-level failure instead.
 */
describe('sendStaticFile', () => {
  let server: http.Server;
  let base: string;
  let goodFile: string;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-static-'));
    goodFile = path.join(dir, 'index.html');
    fs.writeFileSync(goodFile, '<h1>ok</h1>');
    server = http.createServer((req, res) => {
      const target = req.url === '/good' ? goodFile : path.join(dir, 'missing.html');
      sendStaticFile(res, target, 'text/html; charset=utf-8', req.headers.range);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('serves a readable file with 200 and its bytes', async () => {
    const response = await fetch(`${base}/good`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<h1>ok</h1>');
  });

  it('answers an unreadable file with 500 and keeps the server alive', async () => {
    const response = await fetch(`${base}/missing`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'STATIC_READ_FAILED' });

    // The process survived: the next request is still served normally.
    const again = await fetch(`${base}/good`);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe('<h1>ok</h1>');
  });

  it('serves a byte range as 206, which is what an inline video needs', async () => {
    const response = await fetch(`${base}/good`, { headers: { Range: 'bytes=1-4' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-4/11');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe('h1>o');
  });

  it('answers a range past the end with 416', async () => {
    const response = await fetch(`${base}/good`, { headers: { Range: 'bytes=50-60' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */11');
  });
});
