/**
 * The projected workspace graph: rebuild, health, and query.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { GRAPH_SCHEMA_VERSION, projectWorkspaceGraph } from '../graph/projector';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { dbEpistemicWatermark, dbGetGraphProjection, dbGetWorkspaceMembership, dbReadEpistemicGraph, dbUpsertGraphProjection, query } from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { graphClient } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleGraphRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // Graph: POST /api/graph/project -- rebuild one workspace's graph from the
  // canonical epistemic ledger. Destroy-and-rebuild: the graph is a read model, so
  // a rebuild always converges to the same graph for the same canonical rows.
  if (pathname === '/api/graph/project' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    const body = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId } = body;

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
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to project a graph' });
      return true;
    }

    // Authorize before probing provider configuration: an unauthorized caller
    // must not learn whether the graph engine is configured.
    if (!graphClient) {
      sendJson(res, 503, {
        error: 'GRAPH_NOT_CONFIGURED: set OCTO_GRAPH_URL to project a workspace graph',
      });
      return true;
    }

    const data = await dbReadEpistemicGraph(workspaceId);
    const watermark = (await dbEpistemicWatermark(workspaceId)) ?? new Date(0).toISOString();

    try {
      const counts = await projectWorkspaceGraph(graphClient, workspaceId, data);
      await dbUpsertGraphProjection({
        workspaceId,
        schemaVersion: GRAPH_SCHEMA_VERSION,
        sourceWatermark: watermark,
        ...counts,
        status: 'projected',
        lastError: null,
      });
      sendJson(res, 200, { workspaceId, sourceWatermark: watermark, schemaVersion: GRAPH_SCHEMA_VERSION, ...counts, status: 'projected' });
    } catch (error) {
      // A failed projection is recorded, not hidden: health reports the failure so
      // an operator can retry, and the previous watermark shows the graph is stale.
      const message = error instanceof Error ? error.message : String(error);
      await dbUpsertGraphProjection({
        workspaceId,
        schemaVersion: GRAPH_SCHEMA_VERSION,
        sourceWatermark: watermark,
        entityCount: 0,
        claimCount: 0,
        evidenceCount: 0,
        relationCount: 0,
        status: 'failed',
        lastError: message,
      });
      sendJson(res, 502, { error: 'GRAPH_PROJECTION_FAILED', message });
    }
    return true;
  }

  // Graph: GET /api/graph/health -- the projection's watermark and counts, plus
  // whether the graph is stale against the live canonical ledger.
  if (pathname === '/api/graph/health' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId') ?? '';
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

    const projection = await dbGetGraphProjection(workspaceId);
    const liveWatermark = await dbEpistemicWatermark(workspaceId);
    // Stale when the canonical ledger has moved past the watermark the graph was
    // built from -- the graph may not reflect the newest rows. Compare instants,
    // not the second-granularity string form.
    const stale =
      !projection ||
      (liveWatermark !== null &&
        new Date(liveWatermark).getTime() > new Date(projection.sourceWatermark).getTime());

    sendJson(res, 200, {
      workspaceId,
      configured: Boolean(graphClient),
      stale,
      liveWatermark,
      projection,
    });
    return true;
  }

  // Graph: POST /api/graph/query -- a mediated read against one workspace's graph.
  if (pathname === '/api/graph/query' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const parsed = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId, query: cypher, params } = parsed;

    if (!workspaceId || !cypher) {
      sendJson(res, 400, { error: 'workspaceId and query are required' });
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

    // Authorize before probing provider configuration: an unauthorized caller
    // must not learn whether the graph engine is configured.
    if (!graphClient) {
      sendJson(res, 503, {
        error: 'GRAPH_NOT_CONFIGURED: set OCTO_GRAPH_URL to query a workspace graph',
      });
      return true;
    }

    // Only scalar parameters reach the engine; the client's read-only path
    // (GRAPH.RO_QUERY) and the derived graph name are the isolation boundary.
    const safeParams: Record<string, string | number | boolean | null> = {};
    if (params && typeof params === 'object') {
      for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          safeParams[name] = value as string | number | boolean | null;
        }
      }
    }

    try {
      const result = await graphClient.roQuery(
        workspaceId,
        cypher,
        Object.keys(safeParams).length ? safeParams : undefined
      );
      sendJson(res, 200, { query: cypher, rows: result.rows, metadata: result.metadata });
    } catch {
      sendJson(res, 502, { error: 'GRAPH_QUERY_FAILED: the graph engine rejected the query' });
    }
    return true;
  }

  return false;
}
