/**
 * Analytics HTTP surface (Slice 7).
 *
 * Four routes: register an immutable Parquet dataset version, submit one named
 * query over it, read the job's status, and fetch the derived result artifact.
 * The caller never supplies SQL or an object key; the server builds both.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { randomUUID } from 'crypto';
import { registerDatasetVersion } from '../analytics/registration';
import { analyticsEngineStatus } from '../analytics/engine';
import { getQuerySpec } from '../analytics/specs';
import { assertWorkspaceKey } from '../analytics/paths';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import {
  dbEnqueueJob,
  dbGetAnalyticsJob,
  dbGetAnalyticsResult,
  dbGetAnalyticsResultByJob,
  dbGetDatasetVersion,
  dbGetWorkspaceMembership,
  dbRegisterDatasetVersion,
} from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { objectStore, r2Provider, UUID_PATTERN } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

const REGISTER_PATH = /^\/api\/workspaces\/([^/]+)\/datasets$/;
const QUERIES_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/queries$/;
const QUERY_STATUS_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/queries\/([^/]+)$/;
const RESULT_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/results\/([^/]+)$/;
const RESULT_CONTENT_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/results\/([^/]+)\/content$/;

const PRESIGNED_EXPIRY_SECONDS = 3600;

type Auth = NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>;

/**
 * The common gate every analytics route runs before any engine work: authenticate,
 * require the scope, validate the workspace id, enforce the key's workspace
 * binding, then membership. The engine probe comes after this, so an
 * unauthorized caller never learns whether analytics is configured.
 */
async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  scope: 'read' | 'write'
): Promise<Auth | null> {
  const auth = await authenticateRequest(req);
  if (!auth) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return null;
  }
  if (!requireScope(auth, scope)) {
    scopeDenied(res, scope);
    return null;
  }
  if (!requireUuid(res, workspaceId, 'workspaceId')) return null;
  if (!keyWorkspaceMatches(auth, workspaceId)) {
    sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
    return null;
  }
  const membership = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
  if (!membership || !roleAllows(auth, membership.role, 'member')) {
    sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
    return null;
  }
  return auth;
}

/** True when the engine and an object-store backend are both usable. */
async function analyticsReady(res: ServerResponse): Promise<boolean> {
  if (!objectStore) {
    sendJson(res, 503, { error: 'ANALYTICS_NOT_CONFIGURED: no storage backend configured' });
    return false;
  }
  const engine = await analyticsEngineStatus();
  if (!engine.configured) {
    sendJson(res, 503, { error: 'ANALYTICS_NOT_CONFIGURED: the DuckDB engine failed to load' });
    return false;
  }
  return true;
}

export async function handleAnalyticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // Register an immutable dataset version: POST /api/workspaces/:id/datasets
  const registerMatch = pathname.match(REGISTER_PATH);
  if (registerMatch && req.method === 'POST') {
    const workspaceId = registerMatch[1]!;
    const auth = await authorize(req, res, workspaceId, 'write');
    if (!auth) return true;
    if (!(await analyticsReady(res))) return true;

    const body = await readJsonObject(req);
    const outcome = await registerDatasetVersion(
      { workspaceId, createdBy: auth.principal.id, body, store: objectStore! },
      { createVersion: dbRegisterDatasetVersion }
    );
    if (!outcome.ok) {
      sendJson(res, outcome.http, { error: outcome.error, message: outcome.message });
      return true;
    }
    sendJson(res, outcome.created ? 201 : 200, {
      datasetVersion: outcome.version,
      created: outcome.created,
    });
    return true;
  }

  // Submit one named query: POST /api/workspaces/:id/analytics/queries
  const queriesMatch = pathname.match(QUERIES_PATH);
  if (queriesMatch && req.method === 'POST') {
    const workspaceId = queriesMatch[1]!;
    const auth = await authorize(req, res, workspaceId, 'read');
    if (!auth) return true;
    if (!(await analyticsReady(res))) return true;

    const body = await readJsonObject(req);
    const datasetVersionId = body['datasetVersionId'];
    const querySpec = body['querySpec'];
    if (typeof datasetVersionId !== 'string' || !UUID_PATTERN.test(datasetVersionId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: datasetVersionId must be a UUID' });
      return true;
    }
    if (typeof querySpec !== 'string' || !getQuerySpec(querySpec)) {
      sendJson(res, 400, { error: 'UNKNOWN_QUERY_SPEC' });
      return true;
    }

    const version = await dbGetDatasetVersion(workspaceId, datasetVersionId);
    if (!version) {
      sendJson(res, 404, { error: 'DATASET_VERSION_NOT_FOUND' });
      return true;
    }

    const suppliedKey = body['idempotencyKey'];
    if (
      suppliedKey !== undefined &&
      (typeof suppliedKey !== 'string' || !suppliedKey.trim() || suppliedKey.length > 200)
    ) {
      sendJson(res, 400, { error: 'BAD_REQUEST: idempotencyKey must be a non-empty string' });
      return true;
    }
    const idempotencyKey =
      typeof suppliedKey === 'string' ? suppliedKey : `analytics:${datasetVersionId}:${querySpec}`;

    const { job, created } = await dbEnqueueJob(
      randomUUID(),
      workspaceId,
      'analytics_query',
      idempotencyKey,
      { datasetVersionId, querySpec, resultId: randomUUID() },
      auth.principal.id
    );
    sendJson(res, created ? 201 : 200, {
      job: { id: job.id, jobType: job.jobType, state: job.state, idempotencyKey: job.idempotencyKey },
      created,
    });
    return true;
  }

  // Poll one job: GET /api/workspaces/:id/analytics/queries/:jobId
  const statusMatch = pathname.match(QUERY_STATUS_PATH);
  if (statusMatch && req.method === 'GET') {
    const workspaceId = statusMatch[1]!;
    const jobId = statusMatch[2]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    if (!requireUuid(res, jobId, 'jobId')) return true;

    const job = await dbGetAnalyticsJob(workspaceId, jobId);
    if (!job) {
      sendJson(res, 404, { error: 'JOB_NOT_FOUND' });
      return true;
    }
    const result = job.state === 'completed' ? await dbGetAnalyticsResultByJob(workspaceId, jobId) : null;
    sendJson(res, 200, {
      jobId: job.id,
      state: job.state,
      jobType: job.jobType,
      errorCode: job.errorCode,
      errorSummary: job.errorSummary,
      resultId: result?.id ?? null,
      result,
    });
    return true;
  }

  // Result bytes for the explicit local backend (no presigner). Production R2
  // callers use the presigned URL the metadata route returns instead.
  const contentMatch = pathname.match(RESULT_CONTENT_PATH);
  if (contentMatch && req.method === 'GET') {
    const workspaceId = contentMatch[1]!;
    const resultId = contentMatch[2]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    if (!requireUuid(res, resultId, 'resultId')) return true;
    if (!objectStore) {
      sendJson(res, 503, { error: 'ANALYTICS_NOT_CONFIGURED: no storage backend configured' });
      return true;
    }

    const result = await dbGetAnalyticsResult(workspaceId, resultId);
    if (!result) {
      sendJson(res, 404, { error: 'RESULT_NOT_FOUND' });
      return true;
    }
    assertWorkspaceKey(result.objectKey, workspaceId);
    const bytes = await objectStore.get(result.objectKey);
    if (!bytes) {
      sendJson(res, 404, { error: 'RESULT_NOT_FOUND' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apache.parquet',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${resultId}.parquet"`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(bytes);
    return true;
  }

  // Fetch one result artifact: GET /api/workspaces/:id/analytics/results/:resultId
  const resultMatch = pathname.match(RESULT_PATH);
  if (resultMatch && req.method === 'GET') {
    const workspaceId = resultMatch[1]!;
    const resultId = resultMatch[2]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    if (!requireUuid(res, resultId, 'resultId')) return true;

    const result = await dbGetAnalyticsResult(workspaceId, resultId);
    if (!result) {
      sendJson(res, 404, { error: 'RESULT_NOT_FOUND' });
      return true;
    }

    const downloadUrl = r2Provider
      ? await r2Provider.generatePresignedDownloadUrl(result.objectKey, PRESIGNED_EXPIRY_SECONDS)
      : `/api/workspaces/${workspaceId}/analytics/results/${resultId}/content`;
    sendJson(res, 200, {
      result,
      downloadUrl,
      expiresInSeconds: r2Provider ? PRESIGNED_EXPIRY_SECONDS : 0,
    });
    return true;
  }

  return false;
}
