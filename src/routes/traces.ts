/**
 * Traces and eval scores (#268, #342).
 *
 * One Phoenix runs next to Octo. An agent sends OTLP/HTTP traces here with its
 * normal Octo key; Octo checks the key and the workspace, then forwards the bytes
 * unchanged to Phoenix with the project set to the workspace's slug. Phoenix
 * creates the project on its first span. Eval scores (span annotations) go the
 * same way. The Phoenix secret stays in Octo.
 *
 *   OCTO_PHOENIX_URL         internal Phoenix base URL, e.g. http://octo-phoenix:6006.
 *   OCTO_PHOENIX_SECRET      Phoenix's PHOENIX_ADMIN_SECRET (bearer token).
 *   OCTO_PHOENIX_PUBLIC_URL  where people open Phoenix, for the dashboard link.
 */

import { authenticateRequest, keyWorkspaceMatches, requireScope, scopeDenied } from '../server/auth-context';
import { dbGetWorkspaceById, dbGetWorkspaceMembership } from '../server/db';
import { sendJson } from '../server/http';
import { UUID_PATTERN } from '../server/runtime';
import type { IncomingMessage, ServerResponse } from 'http';

const BODY_MAX_BYTES = 8 * 1024 * 1024;
const ROUTE = /^\/api\/workspaces\/([^/]+)\/otel\/(v1\/traces|v1\/span_annotations|link)$/;

function readRaw(req: IncomingMessage): Promise<Buffer | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer | null>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_MAX_BYTES) {
      resolve(null);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
  return promise;
}

export async function handleTracesRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const [, workspaceId, action] = match as unknown as [string, string, string];
  const isLink = action === 'link';
  if (req.method !== (isLink ? 'GET' : 'POST')) return false;

  const auth = await authenticateRequest(req);
  if (!auth) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }
  const scope = isLink ? 'read' : 'write';
  if (!requireScope(auth, scope)) {
    scopeDenied(res, scope);
    return true;
  }
  if (!UUID_PATTERN.test(workspaceId)) {
    sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
    return true;
  }
  if (!keyWorkspaceMatches(auth, workspaceId)) {
    sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
    return true;
  }
  const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
  if (!mem && !auth.principal.isPlatformOwner) {
    sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
    return true;
  }
  const workspace = await dbGetWorkspaceById(workspaceId);
  if (!workspace) {
    sendJson(res, 404, { error: 'WORKSPACE_NOT_FOUND' });
    return true;
  }

  const base = process.env['OCTO_PHOENIX_URL']?.replace(/\/+$/, '');
  const secret = process.env['OCTO_PHOENIX_SECRET'];
  if (!base) {
    sendJson(res, 503, { error: 'TRACES_NOT_CONFIGURED: set OCTO_PHOENIX_URL' });
    return true;
  }
  const authHeader: Record<string, string> = secret ? { authorization: `Bearer ${secret}` } : {};
  const project = workspace.slug;

  if (isLink) {
    const publicUrl = (process.env['OCTO_PHOENIX_PUBLIC_URL'] ?? base).replace(/\/+$/, '');
    const found = await fetch(`${base}/v1/projects/${encodeURIComponent(project)}`, { headers: authHeader })
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { id?: string } }>) : null))
      .catch(() => null);
    const id = found?.data?.id;
    sendJson(res, 200, { project, url: id ? `${publicUrl}/projects/${id}` : `${publicUrl}/projects` });
    return true;
  }

  const body = await readRaw(req);
  if (!body) {
    sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    return true;
  }
  const headers: Record<string, string> = { ...authHeader, 'x-project-name': project };
  for (const name of ['content-type', 'content-encoding']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  // Annotations name the project in the query string; traces use the header.
  const target =
    action === 'v1/span_annotations' ? `${base}/v1/span_annotations${url.search}` : `${base}/v1/traces`;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body: new Uint8Array(body) });
  } catch {
    sendJson(res, 502, { error: 'TRACES_UPSTREAM_UNREACHABLE' });
    return true;
  }
  const out = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
  });
  res.end(out);
  return true;
}
