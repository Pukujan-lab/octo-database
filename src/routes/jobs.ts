/**
 * Background jobs: enqueue, list, retry, and the manual drain.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { dbEnqueueJob, dbGetWorkspaceMembership, dbListJobs, dbRecordActivity, dbRetryJob } from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { drainQueueOnce } from '../server/queue';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleJobsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 10. Operations: jobs and activity (Slice 6)
  // Enqueue: POST /api/jobs
  if (pathname === '/api/jobs' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    const parsed = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId, jobType, idempotencyKey, payload } = parsed;

    if (!workspaceId || !jobType || !idempotencyKey) {
      sendJson(res, 400, { error: 'workspaceId, jobType, and idempotencyKey are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (jobType === 'archive_file' || jobType === 'restore_file') {
      sendJson(res, 400, { error: 'JOB_TYPE_RESERVED: use the file archive or restore route' });
      return true;
    }
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to enqueue jobs' });
      return true;
    }

    // A repeat with the same idempotency key returns the original job.
    const { job, created } = await dbEnqueueJob(
      randomUUID(),
      workspaceId,
      jobType,
      idempotencyKey,
      payload ?? {},
      auth.principal.id
    );

    if (created) {
      await dbRecordActivity(
        workspaceId,
        'job.enqueued',
        `Job ${jobType} queued`,
        job.id,
        auth.principal.id
      );
    }

    sendJson(res, created ? 201 : 200, { job, created });
    return true;
  }

  // List: GET /api/jobs?workspaceId=...
  if (pathname === '/api/jobs' && req.method === 'GET') {
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

    sendJson(res, 200, await dbListJobs(workspaceId));
    return true;
  }

  // Manual retry: POST /api/jobs/:id/retry?workspaceId=...
  // Recovery path for a job stuck after retry exhaustion.
  if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/retry') && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    const jobId = pathname.slice('/api/jobs/'.length, -'/retry'.length);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!jobId || !workspaceId) {
      sendJson(res, 400, { error: 'jobId and workspaceId are required' });
      return true;
    }
    if (!requireUuid(res, jobId, 'jobId')) return true;
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'admin')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to retry jobs' });
      return true;
    }

    const retry = await dbRetryJob(jobId, workspaceId);
    if (retry === 'busy') {
      sendJson(res, 409, { error: 'FILE_BUSY: archive or restore is in progress' });
      return true;
    }
    if (retry !== 'requeued') {
      sendJson(res, 404, { error: 'JOB_NOT_RETRYABLE: no failed job with that id in this workspace' });
      return true;
    }

    await dbRecordActivity(workspaceId, 'job.requeued', 'Job manually requeued', jobId, auth.principal.id);
    sendJson(res, 200, { success: true, jobId });
    return true;
  }

  // Worker tick: POST /api/jobs/run?workspaceId=...
  // Runs one drain pass so the operations page can demonstrate real progress
  // without requiring a separately supervised worker process.
  if (pathname === '/api/jobs/run' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
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
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to run jobs' });
      return true;
    }

    const outcomes = await drainQueueOnce(workspaceId);
    sendJson(res, 200, { outcomes });
    return true;
  }

  return false;
}
