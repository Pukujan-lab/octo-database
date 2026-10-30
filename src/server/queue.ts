/**
 * The job queue's in-process driver: one drain pass, the file-transition
 * enqueue, the retention sweep, and the two background loops a single container
 * needs.
 */

import { JobOutcome, processJob } from '../jobs/worker';
import { dbClaimJob, dbEnsureEmbeddingConfig, dbReplaceChunksAndEmbeddings, dbUpsertDocumentVersion, queryService, dbCompleteJob, dbEnqueueFileTransition, dbEnqueueJob, dbEpistemicWatermarkService, dbFailJob, dbGetArchiveRecord, dbGetDatasetVersion, dbGetLatestDatasetVersion, dbGetWorkspaceSpec, dbListDueAnalyticsSchedules, dbMarkAnalyticsScheduleRan, dbHasOpenFileJob, dbListAgedActiveFiles, dbListRetentionWorkspaces, dbReadEpistemicGraphService, dbRecordActivity, dbRecordOpsEvent, dbRegisterAnalyticsResult, dbUpsertGraphProjectionService } from './db';
import { writeAnalyticsSink } from './analytics-sink';
import { loadEmbeddingConfigFromEnv } from '../rag/embeddings';
import { loadReaderConfigFromEnv } from '../rag/reader';
import { loadArchiveRecord } from './present';
import { archiveDeps, graphClient, objectStore } from './runtime';
import { randomUUID } from 'crypto';

/**
 * Runs one drain pass of the job queue against the server's storage backend.
 * The worker uses the same lease-based claim as a standalone process, so a crash
 * between claim and completion leaves the job claimable again after the lease.
 */
export async function drainQueueOnce(targetWorkspaceId?: string, maxJobs = 10): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];

  for (let i = 0; i < maxJobs; i += 1) {
    const job = await dbClaimJob('octo-server-worker', 60, targetWorkspaceId ?? null);
    if (!job) break;

    const outcome = await processJob(job, {
      claim: async () => null,
      store: objectStore!,
      complete: async (jobId, result) => {
        await dbCompleteJob(jobId, result);
      },
      fail: async (claimed, code, summary, retryable) => {
        await dbFailJob(claimed.jobId, claimed.attempt, 3, code, summary, retryable);
      },
      activity: async (claimed, summary) => {
        await dbRecordActivity(claimed.workspaceId, 'job.transition', summary, claimed.jobId);
      },
      archive: archiveDeps ?? undefined,
      loadArchiveTarget: archiveDeps ? loadArchiveRecord : undefined,
      // A queued `graph_rebuild` projects the workspace's canonical ledger into its
      // graph, the same destroy-and-rebuild the on-demand project route performs. The
      // graph name is derived from the job's workspace by the client, so a rebuild is
      // confined to one tenant. The scheduler drain runs with no caller identity, so
      // the ledger read and the projection write go through the trusted pool -- the
      // job's workspace is the authority, as it is for the archive jobs above. Absent
      // `OCTO_GRAPH_URL`, the handler fails the job with GRAPH_NOT_CONFIGURED.
      graphProjection: {
        client: graphClient ?? undefined,
        readLedger: (workspaceId) => dbReadEpistemicGraphService(workspaceId),
        watermark: (workspaceId) => dbEpistemicWatermarkService(workspaceId),
        record: (row) => dbUpsertGraphProjectionService(row),
      },
      // An analytics job reads its immutable dataset version from the catalog and
      // registers the derived result. Both go through the trusted pool for the
      // same reason as the archive/graph jobs: the drain runs with no caller
      // identity, and the job's workspace is the authority.
      analytics: objectStore
        ? {
            loadVersion: (workspaceId, datasetVersionId) =>
              dbGetDatasetVersion(workspaceId, datasetVersionId),
            loadWorkspaceSpec: (workspaceId, slug, version) =>
              dbGetWorkspaceSpec(workspaceId, slug, version),
            writeSink: writeAnalyticsSink,
            registerResult: async (input) => {
              await dbRegisterAnalyticsResult(input);
            },
          }
        : undefined,
      // A `rag_ingest_file` job indexes one uploaded file. Same trusted pool and
      // workspace pinning as the jobs above.
      ragIngest: {
        embedding: loadEmbeddingConfigFromEnv(),
        reader: loadReaderConfigFromEnv(),
        loadFile: async (workspaceId, fileId) => {
          const file = await dbGetArchiveRecord(workspaceId, fileId);
          return file ? { name: file.name, mimeType: file.mimeType, storageKey: file.storageKey } : null;
        },
        ensureConfig: (workspaceId, c) =>
          dbEnsureEmbeddingConfig(workspaceId, c.model, c.modelVersion, c.dimensions, c.chunker, c.chunkSize, c.chunkOverlap, queryService),
        upsertVersion: (v) =>
          dbUpsertDocumentVersion(v.workspaceId, v.title, v.contentHash, v.mimeType, v.byteSize, v.extractedText, null, v.fileId, queryService),
        replaceChunks: (workspaceId, versionId, configId, chunks, vectors) =>
          dbReplaceChunksAndEmbeddings(workspaceId, versionId, configId, chunks, vectors, queryService),
      },
      // Resolve the thumbnail target through the trusted service pool: the app
      // pool is RLS-fenced and the scheduler drain runs with no caller identity.
      // Pinning to the job's workspace is what stops a payload from pointing the
      // worker at another tenant's object.
      loadFileTarget: async (workspaceId, fileId) => {
        const file = await dbGetArchiveRecord(workspaceId, fileId);
        return file ? { storageKey: file.storageKey, mimeType: file.mimeType } : null;
      },
      recordOpsEvent: async (event) => {
        // Best-effort: capture must never break the drain.
        try {
          await dbRecordOpsEvent(event);
        } catch {
          // swallow
        }
      },
    });

    // Only return outcomes belonging to the caller's workspace to prevent cross-workspace data leakage
    if (!targetWorkspaceId || job.workspaceId === targetWorkspaceId) {
      outcomes.push(outcome);
    }
  }

  return outcomes;
}

/**
 * Enqueues an archive (or restore) job for one file. The idempotency key is
 * scoped to the transition *cycle*, not just the file: it embeds a monotonic
 * count of prior jobs of this type for this file. While a transition is in flight
 * the count is unchanged, so a repeat is deduped; once it completes the count
 * increments, so a later archive -> restore -> archive is not permanently
 * swallowed by the jobs unique constraint (the re-archive defect).
 */
export async function enqueueFileTransition(
  direction: 'archive' | 'restore',
  workspaceId: string,
  file: { id: string; storageKey: string; mimeType: string },
  createdBy: string | null
): Promise<
  | { status: 'missing' }
  | { status: 'busy' }
  | { status: 'queued'; job: Awaited<ReturnType<typeof dbEnqueueJob>>['job']; created: boolean }
> {
  return dbEnqueueFileTransition(
    randomUUID(),
    workspaceId,
    direction,
    `${direction}:${file.id}`,
    { fileId: file.id, storageKey: file.storageKey, mimeType: file.mimeType },
    createdBy
  );
}

/**
 * The retention/tiering policy in full: `workspaces.retention_days` is the only
 * knob. For each workspace with a window set, active files older than the window
 * are enqueued for archival. NULL means never auto-archive. Files already
 * mid-transition are skipped so a slow archive is not double-queued.
 */
export async function runRetentionSweep(): Promise<number> {
  if (!archiveDeps) return 0;

  let enqueued = 0;
  for (const workspace of await dbListRetentionWorkspaces()) {
    for (const fileId of await dbListAgedActiveFiles(workspace.id, workspace.retentionDays)) {
      if (await dbHasOpenFileJob(workspace.id, 'archive_file', fileId)) continue;

      // The sweep runs with no caller identity (a background interval), so it reads
      // through the trusted service pool: dbGetFile is RLS-fenced and would return
      // nothing without a bound principal.
      const file = await dbGetArchiveRecord(workspace.id, fileId);
      if (!file) continue;

      const transition = await enqueueFileTransition(
        'archive',
        workspace.id,
        { id: file.fileId, storageKey: file.storageKey, mimeType: file.mimeType },
        null
      );
      if (transition.status === 'queued' && transition.created) enqueued += 1;
    }
  }
  return enqueued;
}

/**
 * Enqueues one analytics_query job for every due schedule whose dataset has a
 * version it has not yet run on. The idempotency key names the schedule and the
 * version, so a repeated tick (or two containers) cannot enqueue the same run twice.
 */
export async function runAnalyticsSchedules(): Promise<number> {
  let enqueued = 0;
  for (const schedule of await dbListDueAnalyticsSchedules()) {
    const latest = await dbGetLatestDatasetVersion(schedule.workspaceId, schedule.dataset);
    if (!latest || latest.id === schedule.lastDatasetVersionId) {
      await dbMarkAnalyticsScheduleRan(schedule.id, schedule.everyMinutes, null);
      continue;
    }
    await dbEnqueueJob(
      randomUUID(),
      schedule.workspaceId,
      'analytics_query',
      `sched:${schedule.id}:${latest.id}`,
      {
        datasetVersionId: latest.id,
        querySpec: schedule.spec,
        params: schedule.params,
        sink: schedule.sink,
        resultId: randomUUID(),
      },
      schedule.createdBy
    );
    await dbMarkAnalyticsScheduleRan(schedule.id, schedule.everyMinutes, latest.id);
    enqueued += 1;
  }
  return enqueued;
}

/**
 * Starts the background loops a single container needs: a minute tick that
 * enqueues due analytics schedules, one that drains the job queue (so queued archiving/restores progress without a human
 * pressing "Run worker pass"), and an hourly retention sweep. Both are unref'd so
 * they never hold the process open.
 */
export function startSchedulers(): void {
  setInterval(() => {
    drainQueueOnce(undefined, 25).catch((err) => console.warn('Queue drain tick failed:', err));
  }, 60_000).unref();

  setInterval(() => {
    runAnalyticsSchedules().catch((err) => console.warn('Analytics schedule tick failed:', err));
  }, 60_000).unref();

  setInterval(() => {
    runRetentionSweep()
      .then(async (enqueued) => {
        if (enqueued > 0) {
          console.log(`Retention sweep enqueued ${enqueued} archive job(s)`);
          await drainQueueOnce(undefined, 25);
        }
      })
      .catch((err) => console.warn('Retention sweep failed:', err));
  }, 60 * 60 * 1000).unref();
}
