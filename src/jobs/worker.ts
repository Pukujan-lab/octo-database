/**
 * Background Worker (Slice 6)
 *
 * One worker process claims queued jobs with a lease, runs the handler, and
 * records the outcome. Two properties are load-bearing:
 *
 *   - Idempotent side effects: each handler is keyed by the job's identity, so
 *     re-running a job after a crash converges to the same result instead of
 *     producing a duplicate.
 *   - Lease-based recovery: a worker that dies mid-job stops renewing its lease,
 *     and the job becomes claimable again once the lease expires.
 */

import { ObjectStore } from '../storage/object-store';
import { ensureThumbnail } from '../media/thumbnail-service';
import { ArchiveDeps, ArchiveFileRecord, archiveFile, restoreFile } from '../storage/archive-service';
import { ClaimedJob, completeJob, failJob, recordActivity } from './job-service';
import { AnalyticsJobDeps, runAnalyticsJob } from '../analytics/job';
import type { GraphClient } from '../graph/falkordb-client';
import { GRAPH_SCHEMA_VERSION, ProjectionInput, projectWorkspaceGraph } from '../graph/projector';
import type { GraphProjectionRecord } from '../types/graph';

/**
 * Graph projection wiring for a `graph_rebuild` job. The graph is a rebuildable read
 * model, so a rebuild is always a full destroy-and-rebuild of the workspace's graph
 * from canonical rows -- the same operation `POST /api/graph/project` performs, driven
 * by the queue instead of a request.
 *
 * `client` is absent when `OCTO_GRAPH_URL` is unset: the graph surface is optional, so
 * a queued rebuild then fails with a clear, non-retryable code rather than looping.
 */
export interface GraphProjectionDeps {
  client?: GraphClient;
  /** Reads the canonical epistemic ledger the projector consumes. */
  readLedger: (workspaceId: string) => Promise<ProjectionInput>;
  /** The newest canonical instant, or null when the ledger is empty. */
  watermark: (workspaceId: string) => Promise<string | null>;
  /** Records the projection's watermark, counts, and status. */
  record: (row: GraphProjectionRecord) => Promise<void>;
}

export interface WorkerDeps {
  /** Claims the next runnable job, or null when the queue is empty. */
  claim: () => Promise<ClaimedJob | null>;
  store: ObjectStore;
  /** Completes a job with a result payload. */
  complete: (jobId: string, result: Record<string, unknown>) => Promise<void>;
  fail: (
    job: ClaimedJob,
    errorCode: string,
    errorSummary: string,
    retryable: boolean
  ) => Promise<void>;
  activity: (job: ClaimedJob, summary: string) => Promise<void>;
  /** Archive lifecycle wiring. Absent when Drive is not configured. */
  archive?: ArchiveDeps;
  /** Graph projection wiring for `graph_rebuild` jobs. Absent outside the server. */
  graphProjection?: GraphProjectionDeps;
  /**
   * Analytics wiring for `analytics_query` jobs. The store comes from `store`;
   * absent wiring means the surface is not configured on this worker.
   */
  analytics?: Omit<AnalyticsJobDeps, 'store'>;
  /** Loads the file record an archive/restore job targets. */
  loadArchiveTarget?: (workspaceId: string, fileId: string) => Promise<ArchiveFileRecord | null>;
  /**
   * Resolves the file a thumbnail job targets, pinned to the job's workspace.
   * The job payload is client-supplied and never trusted for the object key or
   * MIME type; this lookup is the authority for both.
   */
  loadFileTarget?: (workspaceId: string, fileId: string) => Promise<{ storageKey: string; mimeType: string } | null>;
  /**
   * Records a structured operational failure (issue #140, slice O1). Best-effort:
   * the implementation must swallow its own errors so capture never breaks the
   * worker path. Absent in tests and non-server wiring.
   */
  recordOpsEvent?: (event: {
    workspaceId: string;
    source: 'worker';
    eventType: string;
    errorCode: string;
    severity: 'warning' | 'error' | 'critical';
    detail: Record<string, unknown>;
    jobId: string;
    jobType: string;
  }) => Promise<void>;
  log?: (message: string) => void;
}

/** Handler failure, optionally overriding whether a retry could succeed. */
type HandlerFailure = { ok: false; code: string; summary: string; retryable?: boolean };
type HandlerResult = { ok: true; detail: string } | HandlerFailure;

export interface JobOutcome {
  jobId: string;
  status: 'completed' | 'failed' | 'retry';
  detail: string;
}

/**
 * Handles a thumbnail job. Idempotency comes from the stable derivative key:
 * re-running regenerates or reuses `derived/{fileId}/thumb.webp` rather than
 * creating a second artifact.
 *
 * The payload supplies only the file id. The object key and MIME type come from
 * the file record pinned to the job's workspace, so a job cannot be pointed at
 * another tenant's object (a confused-deputy read) and cannot poison a
 * derivative the caller does not own.
 */
export async function handleThumbnailJob(job: ClaimedJob, deps: WorkerDeps): Promise<HandlerResult> {
  const fileId = job.payload['fileId'];

  if (typeof fileId !== 'string') {
    // Malformed payload will never succeed on retry.
    return { ok: false, code: 'INVALID_PAYLOAD', summary: 'Job payload is missing fileId', retryable: false };
  }

  if (!deps.loadFileTarget) {
    return { ok: false, code: 'FILE_LOOKUP_UNAVAILABLE', summary: 'File lookup is not configured on this worker', retryable: false };
  }

  const target = await deps.loadFileTarget(job.workspaceId, fileId);
  if (!target) {
    // The file was deleted after the job was queued. Resolve it as a benign
    // no-op rather than a failure the owner cannot clear.
    return { ok: true, detail: `no-op: file ${fileId} no longer exists` };
  }

  const thumb = await ensureThumbnail(deps.store, fileId, target.storageKey, target.mimeType);
  if (!thumb) {
    return { ok: false, code: 'NO_DERIVATIVE', summary: `No thumbnail produced for ${fileId}` };
  }

  return { ok: true, detail: `thumbnail ${thumb.cached ? 'reused' : 'generated'} (${thumb.bytes.byteLength} bytes)` };
}

/**
 * Handles an archive job: move the file's bytes R2 -> cold tier. The archive
 * service owns the verify-before-delete ordering, so this only adapts the job
 * payload and reports a retryable/permanent outcome.
 */
export async function handleArchiveJob(
  job: ClaimedJob,
  deps: WorkerDeps,
  direction: 'archive' | 'restore'
): Promise<HandlerResult> {
  const fileId = job.payload['fileId'];
  if (typeof fileId !== 'string') {
    return { ok: false, code: 'INVALID_PAYLOAD', summary: 'Archive job payload is missing fileId', retryable: false };
  }

  if (!deps.archive || !deps.loadArchiveTarget) {
    return {
      ok: false,
      code: 'ARCHIVE_UNAVAILABLE',
      summary: 'Google Drive archival is not configured on this server',
      retryable: false,
    };
  }

  const target = await deps.loadArchiveTarget(job.workspaceId, fileId);
  if (!target) {
    // The file was deleted after the job was queued (deletion is serialized
    // against open transitions, so a queued job normally blocks it; this covers
    // jobs left behind by an older deployment). The transition is moot: resolve
    // it as a benign no-op rather than a permanent failure the owner cannot clear.
    return { ok: true, detail: `no-op: file ${fileId} no longer exists` };
  }

  const outcome = direction === 'archive'
    ? await archiveFile(deps.archive, target)
    : await restoreFile(deps.archive, target);

  if (outcome.ok) return { ok: true, detail: outcome.detail };

  // A state that needs reconciliation is not a clean retry: the bytes are safe
  // in both tiers, so retrying immediately would not help. Surface it plainly.
  return {
    ok: false,
    code: outcome.code,
    summary: outcome.summary,
    retryable: !outcome.reconciliationRequired && outcome.code !== 'INVALID_PAYLOAD',
  };
}

/**
 * Handles a graph rebuild: project the workspace's canonical epistemic ledger into
 * its graph. Idempotent by construction -- the projector deletes the graph and writes
 * it from canonical rows, so a replay converges to the same graph rather than
 * duplicating nodes.
 *
 * The workspace comes from the job (the queue pins it), never from the payload, and
 * the client derives the graph name from that workspace, so a rebuild cannot target
 * another tenant's graph.
 */
export async function handleGraphProjectionJob(
  job: ClaimedJob,
  deps: WorkerDeps
): Promise<HandlerResult> {
  const projection = deps.graphProjection;
  if (!projection?.client) {
    // Optional surface: a deterministic failure, not a retry loop. Mirrors the
    // route's GRAPH_NOT_CONFIGURED so the reason is legible on the job.
    return {
      ok: false,
      code: 'GRAPH_NOT_CONFIGURED',
      summary: 'set OCTO_GRAPH_URL to project a workspace graph',
      retryable: false,
    };
  }

  const workspaceId = job.workspaceId;
  const data = await projection.readLedger(workspaceId);
  const watermark = (await projection.watermark(workspaceId)) ?? new Date(0).toISOString();

  try {
    const counts = await projectWorkspaceGraph(projection.client, workspaceId, data);
    await projection.record({
      workspaceId,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      sourceWatermark: watermark,
      ...counts,
      status: 'projected',
      lastError: null,
    });
    return {
      ok: true,
      detail: `projected ${counts.claimCount} claims, ${counts.entityCount} entities, ${counts.relationCount} relations`,
    };
  } catch (err) {
    // A failed projection is recorded, not hidden: health reports the failure so an
    // operator can see it, and the retryable flag lets a transient engine outage
    // converge on a later attempt.
    const message = err instanceof Error ? err.message : String(err);
    await projection.record({
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
    return { ok: false, code: 'GRAPH_PROJECTION_FAILED', summary: message, retryable: true };
  }
}

/**
 * Handles one `analytics_query`: run the named spec with DuckDB over the
 * immutable dataset version and register the result artifact. The workspace
 * comes from the job, and the catalog row is the authority for the object keys.
 */
export async function handleAnalyticsQueryJob(
  job: ClaimedJob,
  deps: WorkerDeps
): Promise<HandlerResult> {
  if (!deps.analytics) {
    return {
      ok: false,
      code: 'ANALYTICS_NOT_CONFIGURED',
      summary: 'analytics is not configured on this worker',
      retryable: false,
    };
  }
  return runAnalyticsJob(job, { store: deps.store, ...deps.analytics });
}

/** Runs a single claimed job through its handler and records the outcome. */
export async function processJob(job: ClaimedJob, deps: WorkerDeps): Promise<JobOutcome> {
  try {
    let outcome: HandlerResult;

    if (job.jobType === 'thumbnail') {
      outcome = await handleThumbnailJob(job, deps);
    } else if (job.jobType === 'archive_file') {
      outcome = await handleArchiveJob(job, deps, 'archive');
    } else if (job.jobType === 'restore_file') {
      outcome = await handleArchiveJob(job, deps, 'restore');
    } else if (job.jobType === 'graph_rebuild') {
      outcome = await handleGraphProjectionJob(job, deps);
    } else if (job.jobType === 'analytics_query') {
      outcome = await handleAnalyticsQueryJob(job, deps);
    } else {
      outcome = { ok: false, code: 'UNKNOWN_JOB_TYPE', summary: `No handler for job type ${job.jobType}`, retryable: false };
    }

    if (outcome.ok) {
      await deps.complete(job.jobId, { detail: outcome.detail, attempt: job.attempt });
      await deps.activity(job, `Job ${job.jobType} completed: ${outcome.detail}`);
      return { jobId: job.jobId, status: 'completed', detail: outcome.detail };
    }

    // INVALID_PAYLOAD and UNKNOWN_JOB_TYPE are deterministic: retrying cannot help.
    const retryable =
      outcome.retryable ??
      (outcome.code !== 'INVALID_PAYLOAD' && outcome.code !== 'UNKNOWN_JOB_TYPE');
    await deps.fail(job, outcome.code, outcome.summary, retryable);
    await deps.recordOpsEvent?.({
      workspaceId: job.workspaceId,
      source: 'worker',
      eventType: 'job.failed',
      errorCode: outcome.code,
      severity: retryable ? 'warning' : 'error',
      detail: { summary: outcome.summary, retryable, attempt: job.attempt },
      jobId: job.jobId,
      jobType: job.jobType,
    });
    await deps.activity(job, `Job ${job.jobType} ${retryable ? 'failed, will retry' : 'failed permanently'}: ${outcome.summary}`);
    return { jobId: job.jobId, status: retryable ? 'retry' : 'failed', detail: outcome.summary };
  } catch (err: unknown) {
    const summary = err instanceof Error ? err.message : String(err);
    await deps.fail(job, 'HANDLER_EXCEPTION', summary, true);
    await deps.recordOpsEvent?.({
      workspaceId: job.workspaceId,
      source: 'worker',
      eventType: 'job.exception',
      errorCode: 'HANDLER_EXCEPTION',
      severity: 'error',
      detail: { summary, attempt: job.attempt },
      jobId: job.jobId,
      jobType: job.jobType,
    });
    await deps.activity(job, `Job ${job.jobType} threw: ${summary}`);
    return { jobId: job.jobId, status: 'retry', detail: summary };
  }
}

/**
 * Drains the queue once. Returns the outcomes so callers (including tests and the
 * failure drill) can assert exactly what happened.
 */
export async function drainQueue(deps: WorkerDeps, maxJobs = 25): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];

  for (let i = 0; i < maxJobs; i += 1) {
    const job = await deps.claim();
    if (!job) break;
    outcomes.push(await processJob(job, deps));
  }

  return outcomes;
}

/**
 * Builds worker dependencies backed by a Supabase client.
 * Kept here so both the long-running worker and tests share one wiring.
 */
export function buildWorkerDeps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  store: ObjectStore,
  log: (message: string) => void = console.log,
  archive?: ArchiveDeps,
  loadArchiveTarget?: (workspaceId: string, fileId: string) => Promise<ArchiveFileRecord | null>
): WorkerDeps {
  return {
    claim: async () => {
      const { data, error } = await supabase
        .schema('octo')
        .rpc('claim_job', { target_worker: 'octo-worker-1', lease_seconds: 60 });
      if (error || !data) return null;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        jobId: row.job_id,
        workspaceId: row.workspace_id,
        jobType: row.job_type,
        attempt: Number(row.attempt),
        payload: row.payload ?? {},
      };
    },
    store,
    archive,
    loadArchiveTarget,
    complete: (jobId, result) => completeJob(supabase, jobId, result),
    fail: async (job, code, summary, retryable) => {
      await failJob(supabase, job.jobId, job.attempt, 3, code, summary, retryable);
    },
    activity: (job, summary) =>
      recordActivity(supabase, job.workspaceId, 'job.transition', summary, { jobId: job.jobId }),
    log,
  };
}
