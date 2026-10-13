/**
 * Workspace activity and the operator error/summary views.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { authenticateRequest, keyWorkspaceMatches, requireScope, scopeDenied } from '../server/auth-context';
import { dbGetOpsSummary, dbGetWorkspaceMembership, dbListActivity, dbListOpsEvents } from '../server/db';
import { requireUuid, sendJson } from '../server/http';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleOpsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // Activity feed: GET /api/activity?workspaceId=...
  if (pathname === '/api/activity' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId is required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    sendJson(res, 200, await dbListActivity(workspaceId));
    return true;
  }

  // Operational events: GET /api/ops/events?workspaceId=...&errorCode=...
  // Structured failure records for diagnosis (issue #140, slice O1).
  if (pathname === '/api/ops/events' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId is required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    const errorCode = url.searchParams.get('errorCode');
    sendJson(res, 200, { events: await dbListOpsEvents(workspaceId, errorCode) });
    return true;
  }

  // Ops summary: GET /api/ops/summary?workspaceId=...
  // The O2 classification views over HTTP (issue #140, slice O3).
  if (pathname === '/api/ops/summary' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId is required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    sendJson(res, 200, await dbGetOpsSummary(workspaceId));
    return true;
  }

  return false;
}
