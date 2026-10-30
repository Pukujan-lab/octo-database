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
import { analyticsEngineStatus, normalizeSpecSql, readParquetRows, validateWorkspaceSql } from '../analytics/engine';
import { createHash } from 'crypto';
import {
  coerceParams,
  getQuerySpec,
  parseWorkspaceSpecId,
  validateParamDecls
} from '../analytics/specs';
import { assertWorkspaceKey, DATASET_SLUG_PATTERN } from '../analytics/paths';
import { validateSink } from '../analytics/sink';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import {
  dbCreateAnalyticsSchedule,
  dbCreateWorkspaceSpec,
  dbDeleteAnalyticsSchedule,
  dbEnqueueJob,
  dbGetAnalyticsJob,
  dbGetAnalyticsResult,
  dbGetAnalyticsResultByJob,
  dbGetDatasetVersion,
  dbGetLatestDatasetVersion,
  dbGetWorkspaceSpec,
  dbGetWorkspaceMembership,
  dbListAnalyticsRuns,
  dbListAnalyticsSchedules,
  dbListDatasets,
  dbListWorkspaceSpecs,
  dbRegisterDatasetVersion,
} from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { objectStore, r2Provider, UUID_PATTERN } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

const REGISTER_PATH = /^\/api\/workspaces\/([^/]+)\/datasets$/;
const SPECS_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/specs$/;
const SCHEDULES_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/schedules$/;
const SCHEDULE_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/schedules\/([^/]+)$/;
const RUNS_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/runs$/;
const QUERIES_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/queries$/;
const QUERY_STATUS_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/queries\/([^/]+)$/;
const RESULT_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/results\/([^/]+)$/;
const RESULT_CONTENT_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/results\/([^/]+)\/content$/;
const RESULT_ROWS_PATH = /^\/api\/workspaces\/([^/]+)\/analytics\/results\/([^/]+)\/rows$/;

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
      { createVersion: dbRegisterDatasetVersion, latestVersion: dbGetLatestDatasetVersion }
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

  // List the workspace's datasets: GET /api/workspaces/:id/datasets
  if (registerMatch && req.method === 'GET') {
    const workspaceId = registerMatch[1]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    sendJson(res, 200, { datasets: await dbListDatasets(workspaceId) });
    return true;
  }

  // Register a workspace query spec: POST /api/workspaces/:id/analytics/specs
  const specsMatch = pathname.match(SPECS_PATH);
  if (specsMatch && req.method === 'POST') {
    const workspaceId = specsMatch[1]!;
    const auth = await authorize(req, res, workspaceId, 'write');
    if (!auth) return true;
    if (!(await analyticsReady(res))) return true;

    const body = await readJsonObject(req);
    const slug = body['slug'];
    const dataset = body['dataset'];
    const sql = body['sql'];
    const params = body['params'] ?? [];
    if (typeof slug !== 'string' || !DATASET_SLUG_PATTERN.test(slug)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: slug must be a lowercase slug matching [a-z0-9-]' });
      return true;
    }
    if (typeof dataset !== 'string' || !DATASET_SLUG_PATTERN.test(dataset)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: dataset must name a registered dataset slug' });
      return true;
    }
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 20000) {
      sendJson(res, 400, { error: 'BAD_REQUEST: sql must be a non-empty string of at most 20000 characters' });
      return true;
    }
    const paramError = validateParamDecls(params);
    if (paramError) {
      sendJson(res, 400, { error: `BAD_REQUEST: ${paramError}` });
      return true;
    }
    const latest = await dbGetLatestDatasetVersion(workspaceId, dataset);
    if (!latest) {
      sendJson(res, 404, { error: 'DATASET_NOT_FOUND' });
      return true;
    }

    const normalized = normalizeSpecSql(sql);
    const problem = await validateWorkspaceSql({
      sql: normalized,
      params: params as Parameters<typeof validateWorkspaceSql>[0]['params'],
      schema: latest.schema,
    });
    if (problem) {
      sendJson(res, 400, { error: 'INVALID_SPEC', message: problem });
      return true;
    }

    const spec = await dbCreateWorkspaceSpec({
      workspaceId,
      createdBy: auth.principal.id,
      slug,
      sql: normalized,
      params: params as Parameters<typeof validateWorkspaceSql>[0]['params'],
    });
    if (!spec) {
      sendJson(res, 409, { error: 'SPEC_VERSION_CONFLICT', message: 'a concurrent registration took this version; retry' });
      return true;
    }
    sendJson(res, 201, { spec });
    return true;
  }

  // List the workspace's query specs: GET /api/workspaces/:id/analytics/specs
  if (specsMatch && req.method === 'GET') {
    const workspaceId = specsMatch[1]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    sendJson(res, 200, { specs: await dbListWorkspaceSpecs(workspaceId) });
    return true;
  }

  // Schedules: POST/GET /api/workspaces/:id/analytics/schedules
  const schedulesMatch = pathname.match(SCHEDULES_PATH);
  if (schedulesMatch && req.method === 'POST') {
    const workspaceId = schedulesMatch[1]!;
    const auth = await authorize(req, res, workspaceId, 'write');
    if (!auth) return true;

    const body = await readJsonObject(req);
    const spec = body['spec'];
    const dataset = body['dataset'];
    const everyMinutes = body['everyMinutes'];
    if (typeof spec !== 'string') {
      sendJson(res, 400, { error: 'BAD_REQUEST: spec must be a spec id' });
      return true;
    }
    if (typeof dataset !== 'string' || !DATASET_SLUG_PATTERN.test(dataset)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: dataset must name a dataset slug' });
      return true;
    }
    if (typeof everyMinutes !== 'number' || !Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 10080) {
      sendJson(res, 400, { error: 'BAD_REQUEST: everyMinutes must be an integer from 5 to 10080' });
      return true;
    }
    const sink = validateSink(body['sink']);
    if (!sink.ok) {
      sendJson(res, 400, { error: `BAD_REQUEST: ${sink.message}` });
      return true;
    }
    let params: Record<string, string | number | boolean> = {};
    const workspaceRef = parseWorkspaceSpecId(spec);
    if (workspaceRef) {
      const found = await dbGetWorkspaceSpec(workspaceId, workspaceRef.slug, workspaceRef.version);
      if (!found) {
        sendJson(res, 404, { error: 'SPEC_NOT_FOUND' });
        return true;
      }
      const coerced = coerceParams(found.params, body['params']);
      if (!coerced.ok) {
        sendJson(res, 400, { error: `BAD_REQUEST: ${coerced.message}` });
        return true;
      }
      params = coerced.values;
    } else if (!getQuerySpec(spec)) {
      sendJson(res, 400, { error: 'UNKNOWN_QUERY_SPEC' });
      return true;
    }
    if (!(await dbGetLatestDatasetVersion(workspaceId, dataset))) {
      sendJson(res, 404, { error: 'DATASET_NOT_FOUND' });
      return true;
    }
    const schedule = await dbCreateAnalyticsSchedule({
      workspaceId,
      createdBy: auth.principal.id,
      spec,
      dataset,
      params,
      everyMinutes,
      sink: sink.sink,
    });
    sendJson(res, 201, { schedule });
    return true;
  }

  if (schedulesMatch && req.method === 'GET') {
    const workspaceId = schedulesMatch[1]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    sendJson(res, 200, { schedules: await dbListAnalyticsSchedules(workspaceId) });
    return true;
  }

  const scheduleMatch = pathname.match(SCHEDULE_PATH);
  if (scheduleMatch && req.method === 'DELETE') {
    const workspaceId = scheduleMatch[1]!;
    const scheduleId = scheduleMatch[2]!;
    if (!(await authorize(req, res, workspaceId, 'write'))) return true;
    if (!requireUuid(res, scheduleId, 'scheduleId')) return true;
    if (!(await dbDeleteAnalyticsSchedule(workspaceId, scheduleId))) {
      sendJson(res, 404, { error: 'SCHEDULE_NOT_FOUND' });
      return true;
    }
    sendJson(res, 200, { deleted: scheduleId });
    return true;
  }

  // List recent analytics runs: GET /api/workspaces/:id/analytics/runs
  const runsMatch = pathname.match(RUNS_PATH);
  if (runsMatch && req.method === 'GET') {
    const workspaceId = runsMatch[1]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    sendJson(res, 200, { runs: await dbListAnalyticsRuns(workspaceId) });
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
    // `dataset` (a slug) runs the query over that dataset's newest version, pinned
    // at submission so the result still names one immutable version.
    let datasetVersionId = body['datasetVersionId'];
    const querySpec = body['querySpec'];
    if (datasetVersionId === undefined && typeof body['dataset'] === 'string') {
      const latest = await dbGetLatestDatasetVersion(workspaceId, body['dataset']);
      if (!latest) {
        sendJson(res, 404, { error: 'DATASET_NOT_FOUND' });
        return true;
      }
      datasetVersionId = latest.id;
    }
    if (typeof datasetVersionId !== 'string' || !UUID_PATTERN.test(datasetVersionId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: datasetVersionId must be a UUID (or pass dataset: <slug>)' });
      return true;
    }
    if (typeof querySpec !== 'string') {
      sendJson(res, 400, { error: 'UNKNOWN_QUERY_SPEC' });
      return true;
    }
    // A workspace spec carries its own parameters; a built-in spec takes none.
    let queryParams: Record<string, string | number | boolean> = {};
    const workspaceRef = parseWorkspaceSpecId(querySpec);
    if (workspaceRef) {
      const spec = await dbGetWorkspaceSpec(workspaceId, workspaceRef.slug, workspaceRef.version);
      if (!spec) {
        sendJson(res, 404, { error: 'SPEC_NOT_FOUND' });
        return true;
      }
      const coerced = coerceParams(spec.params, body['params']);
      if (!coerced.ok) {
        sendJson(res, 400, { error: `BAD_REQUEST: ${coerced.message}` });
        return true;
      }
      queryParams = coerced.values;
    } else if (!getQuerySpec(querySpec)) {
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
    const paramsDigest = Object.keys(queryParams).length
      ? ':' + createHash('sha256').update(JSON.stringify(queryParams, Object.keys(queryParams).sort())).digest('hex').slice(0, 16)
      : '';
    const idempotencyKey =
      typeof suppliedKey === 'string' ? suppliedKey : `analytics:${datasetVersionId}:${querySpec}${paramsDigest}`;

    const { job, created } = await dbEnqueueJob(
      randomUUID(),
      workspaceId,
      'analytics_query',
      idempotencyKey,
      { datasetVersionId, querySpec, params: queryParams, resultId: randomUUID() },
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

  // Result rows as JSON for the dashboard: GET .../results/:resultId/rows
  const rowsMatch = pathname.match(RESULT_ROWS_PATH);
  if (rowsMatch && req.method === 'GET') {
    const workspaceId = rowsMatch[1]!;
    const resultId = rowsMatch[2]!;
    if (!(await authorize(req, res, workspaceId, 'read'))) return true;
    if (!requireUuid(res, resultId, 'resultId')) return true;
    if (!(await analyticsReady(res))) return true;

    const result = await dbGetAnalyticsResult(workspaceId, resultId);
    if (!result) {
      sendJson(res, 404, { error: 'RESULT_NOT_FOUND' });
      return true;
    }
    assertWorkspaceKey(result.objectKey, workspaceId);
    const bytes = await objectStore!.get(result.objectKey);
    if (!bytes) {
      sendJson(res, 404, { error: 'RESULT_NOT_FOUND' });
      return true;
    }

    const requested = Number(url.searchParams.get('limit') ?? '');
    const rows = await readParquetRows(
      bytes,
      Number.isFinite(requested) && requested > 0 ? requested : undefined
    );
    sendJson(res, 200, { resultId, querySpec: result.querySpec, ...rows });
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
