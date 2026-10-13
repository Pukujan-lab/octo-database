/**
 * Request/response helpers shared by every route family: JSON responses, body
 * reading, identifier validation, and the handler contract the dispatch table in
 * src/server/index.ts is built from.
 */

import { UUID_PATTERN } from './runtime';
import { IncomingMessage, ServerResponse } from 'http';

// Helper: send JSON response
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

// Helper: read request body with Promise.withResolvers
export async function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
  return promise;
}

// Helper: read a JSON object body, tolerating empty or malformed input. An
// absent body becomes {}, so each route's own validation produces its intended
// refusal (400/403/412) rather than an unhandled 500 from JSON.parse.
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Refuse an identifier that is not a UUID before it reaches a Postgres uuid
// column, where a malformed value raises 22P02 and the outer handler would answer
// 500 with raw database text. Writes a clean 400 and returns false when the value
// is malformed, so the caller returns immediately.
export function requireUuid(res: ServerResponse, value: string, field: string): boolean {
  if (UUID_PATTERN.test(value)) return true;
  const code = field === 'workspaceId' ? 'INVALID_WORKSPACE_ID' : 'INVALID_IDENTIFIER';
  sendJson(res, 400, { error: code, code, message: `${field} must be a UUID.` });
  return false;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => Promise<boolean>;
