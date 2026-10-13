/**
 * Local stand-in for the public bucket; production serves these bytes from R2.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { dbGetPublishedObject } from '../server/db';
import { sendJson } from '../server/http';
import { publicLocalStore, publicTarget, UUID_PATTERN } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

export async function handlePublicFilesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // Local stand-in for the Cloudflare public bucket. Production R2 does not
  // mount this route; the custom domain serves those bytes.
  if (publicTarget?.mode === 'local' && publicLocalStore && req.method === 'GET' && pathname.startsWith('/public/files')) {
    const rest = pathname.slice('/public/files'.length);
    if (rest === '' || rest === '/') {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return true;
    }
    const fileId = rest.startsWith('/') ? rest.slice(1) : rest;
    if (!fileId || fileId.includes('/') || !UUID_PATTERN.test(fileId)) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return true;
    }
    const published = await dbGetPublishedObject(fileId);
    const bytes = published ? await publicLocalStore.get(published.publicKey) : null;
    if (!published || !bytes) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': published.mimeType,
      'Content-Length': String(bytes.byteLength),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(bytes);
    return true;
  }

  return false;
}
