/**
 * Static asset serving for the standalone/production server.
 *
 * The caller has already resolved and guarded the path (traversal check,
 * existsSync, isFile). This helper owns the read itself, because a read can still
 * fail after those guards — the file is deleted, permissions change, or the disk
 * errors between the check and the open. A ReadStream with no 'error' handler
 * emits an unhandled error, which is an uncaught exception that takes down the
 * whole server process rather than failing the one response, so the failure is
 * confined to this request.
 */

import * as fs from 'fs';
import { ServerResponse } from 'http';

export function sendStaticFile(
  res: ServerResponse,
  filePath: string,
  contentType: string,
  rangeHeader?: string
): void {
  // A single `bytes=start-end` range, which is all a media element sends. Safari
  // will not play an inline video from a server that answers the whole body to
  // a ranged request, so a range that parses is honoured and anything else
  // falls back to the full file.
  const range = parseRange(rangeHeader);
  let start: number | undefined;
  let end: number | undefined;
  let size = 0;
  if (range) {
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = 0;
    }
    if (size > 0) {
      start = range.start === null ? Math.max(0, size - (range.end ?? 0)) : range.start;
      end = range.start === null ? size - 1 : Math.min(range.end ?? size - 1, size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
    } else {
      start = undefined;
    }
  }

  const stream = fs.createReadStream(filePath, start === undefined ? undefined : { start, end });

  stream.once('error', () => {
    if (res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: 'STATIC_READ_FAILED' }));
    }
  });

  stream.once('open', () => {
    // A client that disconnected before the file opened must not have writeHead
    // called on its destroyed response — that would throw inside this callback,
    // outside the request handler's try/catch.
    if (res.destroyed) {
      stream.destroy();
      return;
    }
    if (start === undefined || end === undefined) {
      res.writeHead(200, { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    } else {
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      });
    }
    stream.pipe(res);
  });
}

function parseRange(header?: string): { start: number | null; end: number | null } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  return {
    start: rawStart === '' ? null : Number(rawStart),
    end: rawEnd === '' ? null : Number(rawEnd),
  };
}
