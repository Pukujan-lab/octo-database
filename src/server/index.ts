/**
 * Octo Full-Stack Platform Server
 *
 * Exposes REST APIs, API Gateway, and Cloudflare R2 active storage connector.
 * Executes all data mutations directly in PostgreSQL and Cloudflare R2.
 */

import * as fs from 'fs';
import * as path from 'path';

// Conditionally load .env if present (local dev) without failing in CI
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { loadR2ConfigFromEnv, R2StorageProvider } from '../storage/r2-client';
import { LocalObjectStore, ObjectStore, R2ObjectStore } from '../storage/object-store';
import {
  clearPublishedObject,
  publishSnapshot,
  publishedFileUrl,
  PublishStepError,
  resolvePublicTarget,
} from '../storage/publish-service';
import { GoogleDriveProvider, loadGoogleDriveConfigFromEnv } from '../storage/google-drive-provider';
import {
  ArchiveDeps,
  ArchiveFileRecord,
  ArchiveState,
  archiveFile,
  restoreFile,
} from '../storage/archive-service';
import { ensureThumbnail } from '../media/thumbnail-service';
import { signMediaUrl, verifyMediaToken } from '../media/media-token';
import { hashShareToken } from '../media/share-service';
import { JobOutcome, processJob } from '../jobs/worker';
import {
  AUTH_GUIDANCE,
  capabilitiesForScopes,
  hasScope,
  KEY_CLASSES,
  KeyClass,
  minimumRoleForCapability,
  OctoScope,
} from '../api/capabilities';
import { chunkKey, chunkText, contentHash, extractText } from '../rag/pipeline';
import { embedTexts, loadEmbeddingConfigFromEnv } from '../rag/embeddings';
import { GraphClient, loadGraphConfigFromEnv } from '../graph/falkordb-client';
import { GRAPH_SCHEMA_VERSION, projectWorkspaceGraph } from '../graph/projector';
import { hashApiKeySecret, authorizeKeyMint, parseKeyScopes } from '../api/keys';
import { acceptConfirmChallenge, hasConfirmChallenge, issueConfirmChallenge } from '../auth/confirm-challenge';
import { sendStaticFile } from './static-file';
import { bearerToken, handleMcpRequest } from './mcp-http';
import {
  provisioningConfigured,
  provisionDatabase,
  dropProvisionedDatabase,
  rotateRolePassword,
} from './provisioning';
import {
  runWorkspaceQuery,
  isSqlError,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  DEFAULT_STATEMENT_TIMEOUT_MS,
} from './query';
import { guestSlug, personalSlug } from '../lib/provisioning-slug';
import { signSessionToken, verifySessionToken } from '../lib/session-token';
import { getPublicOrigin } from '../lib/public-origin';
import { verifyOAuthAccessToken, oauthResource } from '../lib/oauth-token';
import { handleOAuthRoutes, sendWwwAuthenticate } from './oauth';
import {
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  encryptSecret,
  decryptSecret,
} from '../lib/mfa';
import {
  dbCountTransientFiles,
  dbCreateWorkspaceAtomic,
  dbDeleteFileIfIdle,
  dbEnqueueFileTransition,
  dbDeleteWorkspaceAtomic,
  dbGetArchiveRecord,
  dbGetAccountWideKeyId,
  dbGetAuthorizedWorkspaces,
  dbGetConfirmSecretHash,
  dbGetMfa,
  dbSetMfaPending,
  dbConfirmMfa,
  dbSetMfaRecoveryCodes,
  dbConsumeMfaRecoveryCode,
  dbClearMfa,
  MfaRecord,
  dbGetFile,
  dbGetWorkspaceById,
  dbGetWorkspaceDatabase,
  dbGetWorkspaceDatabaseCredential,
  dbSetWorkspaceDatabaseCredential,
  dbClearFilePublished,
  dbFinishFileDelete,
  dbGetPublishedObject,
  dbGetWorkspaceMembership,
  dbMarkFilePublished,
  dbHasOpenFileJob,
  dbInsertApiKey,
  dbUpdateApiKeyScopes,
  dbInsertFile,
  dbInsertGuestPrincipal,
  dbInsertWorkspaceDatabase,
  dbUpsertGooglePrincipal,
  dbInsertMembership,
  dbInsertWorkspace,
  dbListAgedActiveFiles,
  dbListApiKeys,
  dbListRetentionWorkspaces,
  dbListWorkspaceStorageKeys,
  dbClaimJob,
  dbCompleteJob,
  dbEnsureEmbeddingConfig,
  dbMatchChunks,
  dbReplaceChunksAndEmbeddings,
  dbUpsertDocumentVersion,
  dbEnsureEpistemicEntity,
  dbEnsurePerspective,
  dbInsertEvidence,
  dbInsertClaim,
  dbInsertBelief,
  dbInsertClaimRelation,
  dbInsertClaimEvidence,
  dbClaimsAsOf,
  dbBeliefAsOf,
  dbReadEpistemicGraph,
  dbReadEpistemicGraphService,
  dbEpistemicWatermark,
  dbEpistemicWatermarkService,
  dbGetGraphProjection,
  dbUpsertGraphProjection,
  dbUpsertGraphProjectionService,
  dbEnqueueJob,
  dbRetryJob,
  dbFailJob,
  dbListActivity,
  dbListOpsEvents,
  dbGetOpsSummary,
  dbListJobs,
  dbListShares,
  dbListWorkspaceFiles,
  dbRecordActivity,
  dbRecordOpsEvent,
  dbResolveShareById,
  dbResolveShareByTokenHash,
  dbRevokeShare,
  dbInsertShare,
  dbSetConfirmSecret,
  dbUpdateArchiveState,
  dbVerifyApiKey,
  query,
  queryService,
  bindRequestIdentity,
  runWithRequestIdentity,
  requestIdentity,
  testDbConnection,
} from './db';
import { Principal, ROLE_HIERARCHY, WorkspaceRole } from '../types/auth';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Explicit opt-in local storage backend for CI/dev only. Production default is R2
// and fails closed when credentials are absent, so uploads can never silently land
// outside R2 and leave octo.files rows pointing at objects that do not exist.
const LOCAL_STORAGE_ROOT = path.join('/tmp', 'octo-storage');
const useLocalStorage = process.env['OCTO_STORAGE_BACKEND'] === 'local';

// Initialize R2 Active Storage Provider
let r2Provider: R2StorageProvider | null = null;
try {
  const r2Config = loadR2ConfigFromEnv();
  r2Provider = new R2StorageProvider(r2Config);
} catch (e) {
  if (useLocalStorage) {
    console.warn('Local storage backend active; R2 disabled:', (e as Error).message);
  } else {
    console.warn('R2 storage initialization note:', (e as Error).message);
  }
}

// Backend-agnostic store used by uploads and derived thumbnail artifacts.
const objectStore: ObjectStore | null = r2Provider
  ? new R2ObjectStore(r2Provider)
  : useLocalStorage
    ? new LocalObjectStore(LOCAL_STORAGE_ROOT)
    : null;

const privateBucketName =
  r2Provider?.bucket ?? process.env['OCTO_R2_BUCKET'] ?? process.env['R2_BUCKET'] ?? 'octo';
const publicTarget = resolvePublicTarget(process.env, {
  useLocalStorage: Boolean(useLocalStorage && !r2Provider),
  privateBucket: privateBucketName,
  port: PORT,
});
const publicLocalStore: ObjectStore | null =
  publicTarget?.mode === 'local' ? new LocalObjectStore(path.join('/tmp', 'octo-public')) : null;

function presentFile<T extends { id: string; publishedAt?: string | Date | null; publicKey?: string | null }>(
  file: T
): Omit<T, 'publicKey'> & { publishedUrl: string | null } {
  const published = file.publishedAt != null && publicTarget;
  const { publicKey: _publicKey, ...rest } = file;
  return {
    ...rest,
    publishedUrl: published ? publishedFileUrl(publicTarget.baseUrl, file.id) : null,
  };
}

async function deletePublicObject(publicKey: string): Promise<void> {
  if (publicTarget?.mode === 'local' && publicLocalStore) {
    await publicLocalStore.delete(publicKey);
    return;
  }
  if (publicTarget?.mode === 'r2' && r2Provider && publicTarget.publicBucket) {
    await r2Provider.deleteObjectInBucket(publicTarget.publicBucket, publicKey);
    return;
  }
  throw new PublishStepError(
    'PUBLIC_DELETE_FAILED',
    'PUBLIC_DELETE_FAILED: the public object could not be removed'
  );
}

// Cold/archival tier (Slice 5). Optional: archival is simply unavailable when
// Drive credentials are absent, rather than half-configured.
let driveProvider: GoogleDriveProvider | null = null;
try {
  driveProvider = new GoogleDriveProvider(loadGoogleDriveConfigFromEnv());
} catch (e) {
  console.warn('Google Drive archival disabled:', (e as Error).message);
}

/**
 * Graph engine (issue #12). Optional, like the embedding provider: unset
 * `OCTO_GRAPH_URL` leaves the graph surface reporting "not configured" rather
 * than a half-wired engine. The client derives each graph name from the
 * authenticated workspace UUID, so no request value can name a graph.
 */
const graphConfig = loadGraphConfigFromEnv();
const graphClient: GraphClient | null = graphConfig ? new GraphClient(graphConfig) : null;

/**
 * Archive lifecycle wiring for the worker and the on-demand restore path. Null
 * when either tier is unavailable, so callers fail closed instead of guessing.
 */
const archiveDeps: ArchiveDeps | null =
  objectStore && driveProvider
    ? {
        active: objectStore,
        archive: driveProvider,
        updateFile: (fileId, patch) =>
          dbUpdateArchiveState(fileId, {
            archiveState: patch.archiveState,
            ...(patch.archiveProvider !== undefined ? { archiveProvider: patch.archiveProvider } : {}),
            ...(patch.archiveLocator !== undefined ? { archiveLocator: patch.archiveLocator } : {}),
            ...(patch.archiveHash !== undefined ? { archiveHash: patch.archiveHash } : {}),
            ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
            ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
          }),
      }
    : null;

async function loadArchiveRecord(
  workspaceId: string,
  fileId: string
): Promise<ArchiveFileRecord | null> {
  const row = await dbGetArchiveRecord(workspaceId, fileId);
  if (!row) return null;
  return {
    fileId: row.fileId,
    workspaceId: row.workspaceId,
    name: row.name,
    mimeType: row.mimeType,
    storageKey: row.storageKey,
    archiveState: row.archiveState as ArchiveState,
    archiveLocator: row.archiveLocator,
    archiveHash: row.archiveHash,
  };
}

/**
 * Ensures a file's bytes are present in the active tier, restoring them from the
 * cold tier first when the file has been archived. Returns the bytes, or null
 * when they are unavailable. This is what lets an archived image still open
 * through its unchanged logical file id.
 */
async function ensureActiveBytes(
  workspaceId: string,
  file: { id: string; storageKey: string; archiveState: string }
): Promise<Buffer | null> {
  if (!objectStore) return null;

  const direct = await objectStore.get(file.storageKey);
  if (direct) return direct;

  if (file.archiveState !== 'archived_drive' || !archiveDeps) return null;

  const record = await loadArchiveRecord(workspaceId, file.id);
  if (!record) return null;

  const result = await restoreFile(archiveDeps, record);
  if (!result.ok) {
    console.warn(`On-demand restore failed for ${file.id}: ${result.summary}`);
    return null;
  }

  return objectStore.get(file.storageKey);
}

// Helper: send JSON response
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

// Helper: read request body with Promise.withResolvers
async function readBody(req: IncomingMessage): Promise<string> {
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
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
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
function requireUuid(res: ServerResponse, value: string, field: string): boolean {
  if (UUID_PATTERN.test(value)) return true;
  const code = field === 'workspaceId' ? 'INVALID_WORKSPACE_ID' : 'INVALID_IDENTIFIER';
  sendJson(res, 400, { error: code, code, message: `${field} must be a UUID.` });
  return false;
}

interface AuthContext {
  principal: Principal;
  apiKey?: {
    keyId: string;
    prefix: string;
    name: string;
    workspaceId: string | null;
    role: string | null;
    scopes: string[];
    isAccountWide: boolean;
  };
}

function keyWorkspaceMatches(auth: AuthContext, workspaceId: string): boolean {
  return !auth.apiKey?.workspaceId || auth.apiKey.workspaceId === workspaceId;
}

function effectiveWorkspaceRole(auth: AuthContext, liveRoleValue: string): WorkspaceRole {
  const liveRole = liveRoleValue in ROLE_HIERARCHY ? liveRoleValue as WorkspaceRole : 'member';
  const keyRole = auth.apiKey?.workspaceId ? auth.apiKey.role as WorkspaceRole | null : null;
  if (!keyRole || !(keyRole in ROLE_HIERARCHY)) return liveRole;
  return ROLE_HIERARCHY[liveRole] <= ROLE_HIERARCHY[keyRole] ? liveRole : keyRole;
}

function roleMeetsMinimum(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minimum];
}

function roleAllows(auth: AuthContext, liveRole: string, minimum: WorkspaceRole): boolean {
  return roleMeetsMinimum(effectiveWorkspaceRole(auth, liveRole), minimum);
}

// Helper: authenticate caller from Authorization header
async function authenticateRequest(req: IncomingMessage): Promise<AuthContext | null> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();

  // 1. Check if token is an API key (octo_live_...)
  if (token.startsWith('octo_live_')) {
    const keyHash = hashApiKeySecret(token);
    const verified = await dbVerifyApiKey(keyHash);
    if (!verified) return null;

    // Resolve principal
    const rows = await queryService<{
      id: string;
      auth_user_id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
      is_guest: boolean;
      is_platform_owner: boolean;
    }>(
      'SELECT id, auth_user_id, email, display_name, avatar_url, is_guest, is_platform_owner FROM octo.principals WHERE id = $1',
      [verified.principalId]
    );

    if (rows.length === 0) return null;
    const pRow = rows[0]!;

    const principal: Principal = {
      id: pRow.id,
      authUserId: pRow.auth_user_id,
      email: pRow.email,
      displayName: pRow.display_name,
      avatarUrl: pRow.avatar_url ?? null,
      isPlatformOwner: pRow.is_platform_owner,
      isGuest: pRow.is_guest,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    bindRequestIdentity(pRow.id, verified.workspaceId ?? null);

    return {
      principal,
      apiKey: {
        keyId: verified.keyId,
        prefix: verified.prefix,
        name: verified.keyName,
        workspaceId: verified.workspaceId,
        role: verified.role,
        scopes: verified.scopes,
        isAccountWide: verified.workspaceId === null,
      },
    };
  }

  // 2. OAuth access token (the MCP authorization server). A stateless HMAC JWT
  // minted for one resource and one workspace. The audience check refuses a token
  // minted for a different resource, and the workspace claim binds the RLS fence,
  // so an OAuth client cannot reach beyond the workspace its user consented to.
  if (token.startsWith('eyJ')) {
    const verified = verifyOAuthAccessToken(token, oauthResource());
    if (!verified) return null;
    const { claims } = verified;

    const rows = await queryService<{
      id: string;
      auth_user_id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
      is_guest: boolean;
      is_platform_owner: boolean;
    }>(
      'SELECT id, auth_user_id, email, display_name, avatar_url, is_guest, is_platform_owner FROM octo.principals WHERE id = $1',
      [claims.sub]
    );

    if (rows.length === 0) return null;
    const pRow = rows[0]!;

    bindRequestIdentity(pRow.id, claims.workspace_id);

    return {
      principal: {
        id: pRow.id,
        authUserId: pRow.auth_user_id,
        email: pRow.email,
        displayName: pRow.display_name,
        avatarUrl: pRow.avatar_url ?? null,
        isPlatformOwner: pRow.is_platform_owner,
        isGuest: pRow.is_guest,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      apiKey: {
        keyId: `oauth:${claims.jti}`,
        prefix: 'octo_oauth',
        name: 'OAuth client',
        workspaceId: claims.workspace_id,
        role: null,
        scopes: claims.scope.split(' ').filter(Boolean),
        isAccountWide: false,
      },
    };
  }

  // 3. Signed session token (guest login / OAuth callback). A raw principal UUID
  // is deliberately NOT accepted: it is a public identifier that also rides in
  // media query strings, so treating it as a bearer credential would let anyone
  // who observes it act as that principal (ISS-1).
  const sessionPrincipalId = verifySessionToken(token);
  if (!sessionPrincipalId) {
    return null;
  }

  const rows = await queryService<{
    id: string;
    auth_user_id: string;
    email: string;
    display_name: string | null;
    avatar_url: string | null;
    is_guest: boolean;
    is_platform_owner: boolean;
  }>(
    'SELECT id, auth_user_id, email, display_name, avatar_url, is_guest, is_platform_owner FROM octo.principals WHERE id = $1',
    [sessionPrincipalId]
  );

  if (rows.length === 0) return null;
  const pRow = rows[0]!;

  bindRequestIdentity(pRow.id, null);

  return {
    principal: {
      id: pRow.id,
      authUserId: pRow.auth_user_id,
      email: pRow.email,
      displayName: pRow.display_name,
      avatarUrl: pRow.avatar_url ?? null,
      isPlatformOwner: pRow.is_platform_owner,
      isGuest: pRow.is_guest,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

interface MediaAuthorization {
  principalId: string;
  workspaceId: string;
  fileId: string;
  /**
   * Set when a share token authorized the request. A fallback redirect must then
   * stay share-scoped: widening a share authorization into a principal-scoped
   * credential would hand a logged-out link holder a broader, longer-lived token.
   */
  share?: { shareId: string; validUntil: string | null };
}

/**
 * Authorizes a media request either by bearer credential or by a signed media URL
 * token (image/video tags cannot send Authorization headers). The signature is
 * scoped to one file + workspace + principal, so it cannot be replayed elsewhere.
 */
async function authorizeMediaRequest(
  req: IncomingMessage,
  url: URL
): Promise<MediaAuthorization | false | null> {
  const bearer = await authenticateRequest(req);
  if (bearer) {
    const workspaceId = url.searchParams.get('workspaceId');
    const fileId = url.searchParams.get('fileId');
    if (!workspaceId || !fileId) return null;
    // A malformed id can never resolve to a membership, and passing it to a uuid
    // column would raise 22P02; refuse before the lookup.
    if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(fileId)) return null;
    if (!requireScope(bearer, 'files') || !keyWorkspaceMatches(bearer, workspaceId)) return false;
    const mem = await dbGetWorkspaceMembership(workspaceId, bearer.principal.id);
    if (!mem || !roleAllows(bearer, mem.role, 'member')) return false;
    return { principalId: bearer.principal.id, workspaceId, fileId };
  }

  const claims = verifyMediaToken(url.searchParams);
  if (!claims) return null;

  if (claims.kind === 'principal') {
    // Membership is still re-checked, so revoking access invalidates live tokens.
    const mem = await dbGetWorkspaceMembership(claims.workspaceId, claims.principalId);
    if (!mem) return null;
    // The signature already names the principal and workspace, so bind them before the
    // fenced file read that follows (image/video tags carry no Authorization header).
    bindRequestIdentity(claims.principalId, claims.workspaceId);
    return {
      principalId: claims.principalId,
      workspaceId: claims.workspaceId,
      fileId: claims.fileId,
    };
  }

  // Share-scoped media: the share must still be active. Revoking or expiring the
  // link therefore also invalidates every media URL it signed.
  const share = await dbResolveShareById(claims.shareId);
  if (!share || share.workspaceId !== claims.workspaceId) return null;

  // Bind the share creator so the fenced read is scoped to exactly the shared
  // workspace; the creator is a member, so the membership predicate also passes.
  bindRequestIdentity(share.createdBy, claims.workspaceId);

  return {
    principalId: share.createdBy,
    workspaceId: claims.workspaceId,
    fileId: claims.fileId,
    share: { shareId: claims.shareId, validUntil: share.validUntil },
  };
}

/**
 * Runs one drain pass of the job queue against the server's storage backend.
 * The worker uses the same lease-based claim as a standalone process, so a crash
 * between claim and completion leaves the job claimable again after the lease.
 */
async function drainQueueOnce(targetWorkspaceId?: string, maxJobs = 10): Promise<JobOutcome[]> {
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
async function enqueueFileTransition(
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
async function runRetentionSweep(): Promise<number> {
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
 * Starts the two background loops a single container needs: a minute tick that
 * drains the job queue (so queued archiving/restores progress without a human
 * pressing "Run worker pass"), and an hourly retention sweep. Both are unref'd so
 * they never hold the process open.
 */
function startSchedulers(): void {
  setInterval(() => {
    drainQueueOnce(undefined, 25).catch((err) => console.warn('Queue drain tick failed:', err));
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
/**
 * Enforces a token scope. Human sessions carry no scope list and are not limited
 * here; API-key callers must hold the required scope or the call is refused.
 */
function requireScope(auth: AuthContext, scope: OctoScope): boolean {
  if (!auth.apiKey) return true;
  return hasScope(auth.apiKey.scopes, scope);
}

/** Standard refusal body for a missing scope. */
function scopeDenied(res: ServerResponse, scope: OctoScope): void {
  sendJson(res, 403, { error: `FORBIDDEN: Token is missing the required '${scope}' scope` });
}

/** Lowercase, hyphenated, URL-safe form of a workspace name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * The human confirmation gate for destructive commands. It is satisfied only when
 * both hold: the caller is a human session (no API key), and the supplied value
 * is the one-time code just shown to that person (or, for existing API clients,
 * the stored confirmation secret). An API-key caller can never satisfy it,
 * whatever its scopes -- that is the structural answer to "can a blind agent
 * delete a workspace".
 *
 * When `options.requireMfa` is set and the principal has confirmed MFA, a valid
 * TOTP code (or a one-time recovery code) is additionally required. A used
 * recovery code is consumed. Principals without MFA enrolled are unaffected.
 *
 * Fails closed: an account that never set a secret refuses with
 * CONFIRM_SECRET_NOT_SET rather than falling open. Returns true when the request
 * may proceed, having already written the refusal response otherwise.
 */
async function confirmGate(
  res: ServerResponse,
  auth: AuthContext,
  suppliedSecret: unknown,
  options: { requireMfa?: boolean; mfaCode?: unknown } = {}
): Promise<boolean> {
  if (auth.apiKey) {
    sendJson(res, 403, {
      error: 'FORBIDDEN: Destructive commands require a human session; API keys can never confirm.',
    });
    return false;
  }

  if (acceptConfirmChallenge(auth.principal.id, suppliedSecret)) {
    return confirmMfa(res, auth, options);
  }

  if (hasConfirmChallenge(auth.principal.id)) {
    sendJson(res, 403, { error: 'CONFIRM_CODE_INVALID: Type the code shown on the form.' });
    return false;
  }

  const stored = await dbGetConfirmSecretHash(auth.principal.id);
  if (!stored) {
    sendJson(res, 412, {
      error: 'CONFIRM_SECRET_NOT_SET: Set a confirmation secret via POST /api/me/confirm-secret first.',
    });
    return false;
  }

  if (typeof suppliedSecret !== 'string' || hashApiKeySecret(suppliedSecret) !== stored) {
    sendJson(res, 403, { error: 'CONFIRM_SECRET_INVALID: Confirmation secret does not match.' });
    return false;
  }

  return confirmMfa(res, auth, options);
}

async function confirmMfa(
  res: ServerResponse,
  auth: AuthContext,
  options: { requireMfa?: boolean; mfaCode?: unknown }
): Promise<boolean> {
  if (options.requireMfa) {
    const mfa = await dbGetMfa(auth.principal.id);
    if (mfa?.confirmedAt) {
      const ok = await verifyMfaCode(auth.principal.id, mfa, options.mfaCode);
      if (!ok) {
        sendJson(res, 403, {
          error: 'MFA_CODE_INVALID: A valid authenticator code is required to complete this command.',
        });
        return false;
      }
    }
  }
  return true;
}

/**
 * Verifies a TOTP code against the enrolled secret, falling back to a one-time
 * recovery code (which is consumed on success). Returns false for a missing or
 * malformed code.
 */
async function verifyMfaCode(principalId: string, mfa: MfaRecord, supplied: unknown): Promise<boolean> {
  if (typeof supplied !== 'string' || !supplied.trim()) return false;
  let secret: string;
  try {
    secret = decryptSecret(mfa.secretEncrypted);
  } catch {
    // A key rotation or corrupt record must fail closed, not fall open.
    return false;
  }
  if (verifyTotpCode(secret, supplied)) return true;

  // Recovery codes are one-time. Consume atomically so two concurrent step-ups
  // presenting the same code cannot both succeed.
  return dbConsumeMfaRecoveryCode(principalId, hashRecoveryCode(supplied));
}

/** Attributes an agent action to its principal for audit. Best-effort. */
async function attributeAgentAction(
  auth: AuthContext,
  workspaceId: string,
  eventType: string,
  summary: string
): Promise<void> {
  if (!auth.apiKey) return;
  try {
    await dbRecordActivity(workspaceId, eventType, summary, null, auth.principal.id);
  } catch {
    // Audit attribution must never break the request path.
  }
}

/**
 * Records a structured operational failure (issue #140, slice O1). Best-effort:
 * a capture failure is swallowed so it can never turn a handled error into a
 * crash. Workspace attribution prefers the request's bound workspace scope, then
 * a UUID `workspaceId` query param, else null (a platform-level event).
 */
async function captureOpsEvent(
  req: IncomingMessage,
  url: URL,
  event: { eventType: string; errorCode: string; detail: Record<string, unknown> }
): Promise<void> {
  try {
    const scoped = requestIdentity.getStore()?.workspaceId ?? null;
    const fromQuery = url.searchParams.get('workspaceId');
    const workspaceId = scoped ?? (fromQuery && UUID_PATTERN.test(fromQuery) ? fromQuery : null);
    await dbRecordOpsEvent({
      workspaceId,
      source: 'api',
      eventType: event.eventType,
      errorCode: event.errorCode,
      severity: 'error',
      detail: event.detail,
      route: `${req.method} ${url.pathname}`,
    });
  } catch {
    // Operational capture must never break the request path.
  }
}

/**
 * Resolves the public origin from PUBLIC_BASE_URL, X-Forwarded-* headers,
 * Host header, or fallback local URL origin. Defined in lib/public-origin so the
 * OAuth routes can share it without importing this module; re-exported here for
 * the callers and tests that already import it from the server.
 */
export { getPublicOrigin } from '../lib/public-origin';

export function getGoogleClientCredentials(): { clientId: string | null; clientSecret: string | null } {
  const clientId = process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? process.env['GOOGLE_CLIENT_ID'] ?? null;
  const clientSecret = process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? process.env['GOOGLE_CLIENT_SECRET'] ?? null;
  return { clientId, clientSecret };
}

/** Public Turnstile site key for the login widget, or null when unconfigured. */
export function getTurnstileSiteKey(): string | null {
  return process.env['TURNSTILE_SITE_KEY']?.trim() || null;
}

/**
 * Verifies a Cloudflare Turnstile token for the guest-login challenge.
 *
 * Returns true when the challenge passed. When no secret is configured the
 * check is skipped (true): CI and local dev run without Cloudflare, and a
 * deployment that has not set the secret yet must not lock guests out — the
 * same fail-open shape as googleAuthEnabled. Set TURNSTILE_SECRET_KEY to arm it.
 */
async function verifyTurnstile(token: unknown, remoteIp: string | null): Promise<boolean> {
  const secret = process.env['TURNSTILE_SECRET_KEY']?.trim();
  if (!secret) return true;
  if (typeof token !== 'string' || !token.trim()) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    // A network failure must not admit an unverified caller.
    return false;
  }
}

/**
 * Provisions a newly created workspace's own Postgres database, so a workspace
 * arrives with its data plane in place instead of needing a second, separately
 * authorized call (which a workspace-scoped key is refused). Best effort by
 * design: creating the workspace is the durable act, and a provisioning failure
 * here leaves the workspace intact with the manual
 * POST /api/workspaces/:id/database route still available as the retry.
 *
 * Called AFTER dbCreateWorkspaceAtomic commits, never inside it: CREATE DATABASE
 * cannot run in a transaction, and provisioning uses its own connection.
 *
 * Returns true when this call provisioned the database, false otherwise (no
 * admin credential configured, or a database already existed).
 */
async function autoProvisionWorkspaceDatabase(
  workspace: { id: string; slug: string; name: string },
  principalId: string
): Promise<boolean> {
  if (!provisioningConfigured()) {
    console.warn(
      `[provisioning] workspace '${workspace.slug}' created without a database: OCTO_ADMIN_URL is not set`
    );
    return false;
  }
  if (await dbGetWorkspaceDatabase(workspace.id)) {
    return false;
  }
  const provisioned = await provisionDatabase(workspace.slug);
  const database = await dbInsertWorkspaceDatabase(
    randomUUID(),
    workspace.id,
    provisioned.dbName,
    provisioned.roleName,
    principalId
  );
  await dbRecordActivity(
    workspace.id,
    'workspace.database_provisioned',
    `Database '${database.dbName}' provisioned for workspace '${workspace.name}'`,
    null,
    principalId
  );
  // Keep the role's password so the SQL surface can authenticate as the
  // workspace's own role without a connection string from the caller. Best
  // effort: if the encryption key is unset the query surface rotates a fresh
  // password on first use.
  try {
    await dbSetWorkspaceDatabaseCredential(workspace.id, encryptSecret(provisioned.password));
  } catch (err) {
    console.warn(
      '[provisioning] database credential not stored:',
      err instanceof Error ? err.message : String(err)
    );
  }
  return true;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // A malformed request target (for example the absolute-form `http://[`) makes
  // URL() throw ERR_INVALID_URL. Constructing it before the try below would turn
  // that into an unhandled rejection that terminates the single-process host, so
  // answer the bad request instead of dying on it.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST: malformed request target' });
    return;
  }
  const pathname = url.pathname;

  try {
    // 1. Health check (tests both PostgreSQL and Cloudflare R2 connections)
    if (pathname === '/health' && req.method === 'GET') {
      const dbStatus = await testDbConnection();
      const r2Status = r2Provider ? await r2Provider.testConnection() : { connected: false, bucket: 'none' };
      const { clientId } = getGoogleClientCredentials();
      sendJson(res, 200, {
        status: 'ok',
        version: '0.1.0',
        database: dbStatus,
        r2: r2Status,
        googleAuthEnabled: Boolean(clientId),
        turnstileSiteKey: getTurnstileSiteKey(),
      });
      return;
    }

    // 1a. OAuth 2.1 authorization server for the MCP endpoint: the discovery
    // metadata, dynamic client registration, and the authorize/token endpoints.
    // Runs before any body-reading route below, since it consumes the request
    // body on the endpoints that have one.
    if (await handleOAuthRoutes(req, res, url)) return;

    // 1b. Remote MCP endpoint (Streamable HTTP) for hosted clients such as
    // ChatGPT. A caller authenticates with an Octo bearer key or an OAuth access
    // token; when neither is present the 401 carries the RFC 6750 challenge that
    // points a client at the authorization server. /mcp/<key> is retired: a
    // long-lived key does not belong in a URL.
    if (pathname === '/mcp') {
      const auth = await authenticateRequest(req);
      const token = bearerToken(req);
      if (!auth || !token) {
        sendWwwAuthenticate(res, getPublicOrigin(req, url));
        return;
      }
      await handleMcpRequest(req, res, { baseUrl: `http://127.0.0.1:${PORT}`, token });
      return;
    }

    // Local stand-in for the Cloudflare public bucket. Production R2 does not
    // mount this route; the custom domain serves those bytes.
    if (publicTarget?.mode === 'local' && publicLocalStore && req.method === 'GET' && pathname.startsWith('/public/files')) {
      const rest = pathname.slice('/public/files'.length);
      if (rest === '' || rest === '/') {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      const fileId = rest.startsWith('/') ? rest.slice(1) : rest;
      if (!fileId || fileId.includes('/') || !UUID_PATTERN.test(fileId)) {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      const published = await dbGetPublishedObject(fileId);
      const bytes = published ? await publicLocalStore.get(published.publicKey) : null;
      if (!published || !bytes) {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': published.mimeType,
        'Content-Length': String(bytes.byteLength),
        'Access-Control-Allow-Origin': '*',
      });
      res.end(bytes);
      return;
    }

    // 1b. Google OAuth start. Reports a clear state instead of a dead 404 when the
    // OAuth client has not been provisioned yet.
    if (pathname === '/api/auth/google' && req.method === 'GET') {
      const { clientId } = getGoogleClientCredentials();
      if (!clientId) {
        sendJson(res, 501, {
          error:
            'GOOGLE_AUTH_NOT_CONFIGURED: Set GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET, or use Guest access.',
        });
        return;
      }
      const origin = getPublicOrigin(req, url);
      const redirectUri = `${origin}/api/auth/google/callback`;
      const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', 'openid email profile');
      authorizeUrl.searchParams.set('access_type', 'offline');
      authorizeUrl.searchParams.set('prompt', 'consent');
      res.writeHead(302, { Location: authorizeUrl.toString() });
      res.end();
      return;
    }

    // 1c. Google OAuth callback: GET /api/auth/google/callback
    if (pathname === '/api/auth/google/callback' && req.method === 'GET') {
      const origin = getPublicOrigin(req, url);
      const errorParam = url.searchParams.get('error');
      if (errorParam) {
        res.writeHead(302, { Location: `${origin}/#auth_error=${encodeURIComponent(errorParam)}` });
        res.end();
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(302, { Location: `${origin}/#auth_error=MISSING_CODE` });
        res.end();
        return;
      }
      const { clientId, clientSecret } = getGoogleClientCredentials();
      if (!clientId || !clientSecret) {
        res.writeHead(302, { Location: `${origin}/#auth_error=GOOGLE_AUTH_NOT_CONFIGURED` });
        res.end();
        return;
      }
      const redirectUri = `${origin}/api/auth/google/callback`;
      try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          console.error('Google token exchange failed:', tokenResponse.status, errText);
          res.writeHead(302, { Location: `${origin}/#auth_error=TOKEN_EXCHANGE_FAILED` });
          res.end();
          return;
        }

        const tokenData = (await tokenResponse.json()) as { id_token?: string; access_token?: string };
        let sub = '';
        let email = '';
        let displayName: string | null = null;
        let avatarUrl: string | null = null;

        if (tokenData.id_token) {
          try {
            const parts = tokenData.id_token.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
              sub = payload.sub ?? '';
              email = payload.email ?? '';
              displayName = payload.name ?? null;
              avatarUrl = payload.picture ?? null;
            }
          } catch (e) {
            console.warn('Could not parse Google id_token payload:', e);
          }
        }

        if ((!sub || !email) && tokenData.access_token) {
          const userinfoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (userinfoRes.ok) {
            const userinfo = (await userinfoRes.json()) as {
              sub?: string;
              email?: string;
              name?: string;
              picture?: string;
            };
            sub = userinfo.sub ?? sub;
            email = userinfo.email ?? email;
            displayName = userinfo.name ?? displayName;
            avatarUrl = userinfo.picture ?? avatarUrl;
          }
        }

        if (!sub || !email) {
          res.writeHead(302, { Location: `${origin}/#auth_error=MISSING_PROFILE` });
          res.end();
          return;
        }

        // Derive deterministic RFC4122-compatible UUID for sub to satisfy PostgreSQL UUID type
        const subHash = createHash('sha256').update(`google:${sub}`).digest('hex');
        const authUserId = `${subHash.slice(0, 8)}-${subHash.slice(8, 12)}-4${subHash.slice(13, 16)}-a${subHash.slice(17, 20)}-${subHash.slice(20, 32)}`;

        const principal = await dbUpsertGooglePrincipal(authUserId, email, displayName, avatarUrl);

        // Ensure the principal has at least one workspace to enter
        const workspaces = await dbGetAuthorizedWorkspaces(principal.id);
        if (workspaces.length === 0) {
          const slug = personalSlug(principal.id);
          const ws = await dbInsertWorkspace(
            randomUUID(),
            slug,
            'Personal',
            'Personal workspace',
            principal.id
          );
          await dbInsertMembership(ws.id, principal.id, 'owner');
        }

        res.writeHead(302, { Location: `${origin}/#token=${signSessionToken(principal.id)}` });
        res.end();
        return;
      } catch (err) {
        console.error('Google auth callback error:', err);
        res.writeHead(302, { Location: `${origin}/#auth_error=INTERNAL_ERROR` });
        res.end();
        return;
      }
    }

    // 2. Guest Login: POST /api/auth/guest
    if (pathname === '/api/auth/guest' && req.method === 'POST') {
      // Cloudflare Turnstile challenge ("are you a bot"). Fail-open when the
      // secret is unset (CI/dev); armed once TURNSTILE_SECRET_KEY exists.
      const remoteIp =
        (req.headers['cf-connecting-ip'] as string | undefined)?.trim() ||
        (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        null;
      const parsed = await readJsonObject(req);
      if (!(await verifyTurnstile(parsed.turnstileToken, remoteIp))) {
        sendJson(res, 403, { error: 'TURNSTILE_FAILED: complete the human check and try again.' });
        return;
      }
      const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : 'Guest User';

      const guestId = randomUUID();
      const slug = guestSlug(guestId);
      const email = `${slug}@octo.local`;

      // Insert guest principal in PostgreSQL
      const principal = await dbInsertGuestPrincipal(guestId, guestId, email, displayName);

      // Auto-provision Personal (Guest) workspace in PostgreSQL
      const workspaceId = randomUUID();
      const workspace = await dbInsertWorkspace(
        workspaceId,
        slug,
        'Personal (Guest)',
        'Auto-provisioned personal sandbox workspace',
        principal.id
      );

      // Insert owner membership in PostgreSQL
      await dbInsertMembership(workspace.id, principal.id, 'owner');

      sendJson(res, 201, {
        principal: {
          id: principal.id,
          email: principal.email,
          displayName: principal.displayName,
          isGuest: true,
          isPlatformOwner: false,
        },
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          role: 'owner',
        },
        sessionToken: signSessionToken(principal.id),
      });
      return;
    }

    // 2b. Current Principal: GET /api/me
    if (pathname === '/api/me' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      // The client needs to know whether the destructive-command gate is armed so
      // it can prompt for setup rather than letting the user hit a 412, and whether
      // MFA is enrolled so it can prompt for a code.
      const confirmSecretSet = Boolean(await dbGetConfirmSecretHash(auth.principal.id));
      const mfa = await dbGetMfa(auth.principal.id);
      sendJson(res, 200, {
        principal: auth.principal,
        apiKey: auth.apiKey ?? null,
        confirmSecretSet,
        mfaEnabled: Boolean(mfa?.confirmedAt),
        mfaRecoveryCodesRemaining: mfa?.recoveryCodeHashes.length ?? 0,
      });
      return;
    }

    // 2c. Set or rotate the confirmation secret: POST /api/me/confirm-secret
    // Human session only. Rotation is itself destructive, so changing an existing
    // secret requires presenting the current one; first-time setup does not.
    if (pathname === '/api/me/confirm-secret' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (auth.apiKey) {
        sendJson(res, 403, {
          error: 'FORBIDDEN: The confirmation secret is set from a human session, never an API key.',
        });
        return;
      }

      const parsed = await readJsonObject(req);
      const { secret, currentSecret } = parsed;
      if (typeof secret !== 'string' || secret.length < 8) {
        sendJson(res, 400, { error: 'BAD_REQUEST: secret must be a string of at least 8 characters' });
        return;
      }

      const existing = await dbGetConfirmSecretHash(auth.principal.id);
      if (existing) {
        if (typeof currentSecret !== 'string' || hashApiKeySecret(currentSecret) !== existing) {
          sendJson(res, 403, {
            error: 'CONFIRM_SECRET_INVALID: the current confirmation secret is required to rotate it.',
          });
          return;
        }
      }

      await dbSetConfirmSecret(auth.principal.id, hashApiKeySecret(secret));
      sendJson(res, 200, { success: true, rotated: Boolean(existing) });
      return;
    }

    // A one-time code shown on the form. The human types it back. Nothing is
    // remembered between actions. An API key cannot ask for one.
    if (pathname === '/api/me/confirm-challenge' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (auth.apiKey) {
        sendJson(res, 403, {
          error: 'FORBIDDEN: A confirmation code is issued to a human session, never an API key.',
        });
        return;
      }
      sendJson(res, 200, issueConfirmChallenge(auth.principal.id));
      return;
    }

    // 2d. MFA (TOTP) status. Human session only, like the confirmation secret:
    // MFA protects a person's own account, never an agent's.
    if (pathname === '/api/me/mfa' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (auth.apiKey) {
        sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
        return;
      }
      const mfa = await dbGetMfa(auth.principal.id);
      sendJson(res, 200, {
        enabled: Boolean(mfa?.confirmedAt),
        confirmedAt: mfa?.confirmedAt ?? null,
        recoveryCodesRemaining: mfa?.recoveryCodeHashes.length ?? 0,
      });
      return;
    }

    // 2e. Begin MFA enrollment: mint a secret and return its provisioning URI
    // once. The secret is stored encrypted and unconfirmed until a code proves it.
    if (pathname === '/api/me/mfa/begin' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (auth.apiKey) {
        sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
        return;
      }
      const existing = await dbGetMfa(auth.principal.id);
      if (existing?.confirmedAt) {
        sendJson(res, 409, { error: 'MFA_ALREADY_ENABLED: Disable MFA before enrolling a new authenticator.' });
        return;
      }
      const secret = generateTotpSecret();
      let encrypted: string;
      try {
        encrypted = encryptSecret(secret);
      } catch {
        sendJson(res, 503, {
          error: 'MFA_NOT_CONFIGURED: MFA enrollment requires OCTO_MFA_SECRET on the server.',
        });
        return;
      }
      await dbSetMfaPending(auth.principal.id, encrypted);
      const label = auth.principal.email || auth.principal.displayName || auth.principal.id;
      sendJson(res, 200, { secret, otpauthUri: totpProvisioningUri(secret, label) });
      return;
    }

    // 2f. Confirm MFA enrollment with a code from the authenticator. Issues the
    // one-time recovery codes exactly here.
    if (pathname === '/api/me/mfa/confirm' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (auth.apiKey) {
        sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
        return;
      }
      const parsed = await readJsonObject(req);
      const mfa = await dbGetMfa(auth.principal.id);
      if (!mfa) {
        sendJson(res, 400, { error: 'MFA_NOT_STARTED: Begin enrollment before confirming it.' });
        return;
      }
      if (mfa.confirmedAt) {
        sendJson(res, 409, { error: 'MFA_ALREADY_ENABLED: MFA is already enabled.' });
        return;
      }
      let secret: string;
      try {
        secret = decryptSecret(mfa.secretEncrypted);
      } catch {
        sendJson(res, 500, { error: 'MFA_SECRET_UNREADABLE: Re-enroll the authenticator.' });
        return;
      }
      if (!verifyTotpCode(secret, parsed.code)) {
        sendJson(res, 403, { error: 'MFA_CODE_INVALID: That code did not match. Try the next one.' });
        return;
      }
      const recoveryCodes = generateRecoveryCodes();
      await dbConfirmMfa(auth.principal.id, recoveryCodes.map(hashRecoveryCode));
      sendJson(res, 200, { recoveryCodes });
      return;
    }

    // 2g. Disable MFA. Requires a valid current code or a one-time recovery code
    // (the recovery path), so a lost authenticator does not lock the account out.
    if (pathname === '/api/me/mfa/disable' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (auth.apiKey) {
        sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
        return;
      }
      const parsed = await readJsonObject(req);
      const mfa = await dbGetMfa(auth.principal.id);
      if (!mfa?.confirmedAt) {
        sendJson(res, 409, { error: 'MFA_NOT_ENABLED: MFA is not enabled.' });
        return;
      }
      if (!(await verifyMfaCode(auth.principal.id, mfa, parsed.code))) {
        sendJson(res, 403, { error: 'MFA_CODE_INVALID: Enter a current authenticator code or a recovery code.' });
        return;
      }
      await dbClearMfa(auth.principal.id);
      sendJson(res, 200, { disabled: true });
      return;
    }

    // 2h. Rotate recovery codes. Requires a current authenticator code (not a
    // recovery code), and returns the new set once.
    if (pathname === '/api/me/mfa/recovery-codes' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (auth.apiKey) {
        sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
        return;
      }
      const parsed = await readJsonObject(req);
      const mfa = await dbGetMfa(auth.principal.id);
      if (!mfa?.confirmedAt) {
        sendJson(res, 409, { error: 'MFA_NOT_ENABLED: MFA is not enabled.' });
        return;
      }
      let secret: string;
      try {
        secret = decryptSecret(mfa.secretEncrypted);
      } catch {
        sendJson(res, 500, { error: 'MFA_SECRET_UNREADABLE: Re-enroll the authenticator.' });
        return;
      }
      if (!verifyTotpCode(secret, parsed.code)) {
        sendJson(res, 403, { error: 'MFA_CODE_INVALID: A current authenticator code is required to rotate recovery codes.' });
        return;
      }
      const recoveryCodes = generateRecoveryCodes();
      await dbSetMfaRecoveryCodes(auth.principal.id, recoveryCodes.map(hashRecoveryCode));
      sendJson(res, 200, { recoveryCodes });
      return;
    }

    // 3. Workspaces: GET /api/workspaces
    if (pathname === '/api/workspaces' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      // If workspace-scoped key, restrict list to that specific workspace
      if (auth.apiKey && auth.apiKey.workspaceId) {
        const rows = await query<{
          id: string;
          slug: string;
          name: string;
          description: string | null;
          retention_days: number | null;
        }>('SELECT id, slug, name, description, retention_days FROM octo.workspaces WHERE id = $1', [
          auth.apiKey.workspaceId,
        ]);

        const mem = await dbGetWorkspaceMembership(auth.apiKey.workspaceId, auth.principal.id);
        if (rows.length === 0 || !mem) {
          sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
          return;
        }

        const ws = rows[0]!;
        sendJson(res, 200, [
          {
            id: ws.id,
            slug: ws.slug,
            name: ws.name,
            description: ws.description,
            role: effectiveWorkspaceRole(auth, mem.role),
            isOwner: effectiveWorkspaceRole(auth, mem.role) === 'owner',
            retentionDays: ws.retention_days,
          },
        ]);
        return;
      }

      // Account-wide API key or user session: query all authorized workspaces from PostgreSQL
      const workspaces = await dbGetAuthorizedWorkspaces(auth.principal.id);
      sendJson(res, 200, workspaces);
      return;
    }

    // 3b. Create a workspace: POST /api/workspaces
    // Workspace = database: the creator becomes owner and the workspace's single
    // API key is minted in the same transaction, so a workspace can never exist
    // without its key. The raw key secret is returned exactly once, here.
    if (pathname === '/api/workspaces' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }
      // A workspace-scoped key is pinned to one workspace and cannot mint more.
      if (auth.apiKey && auth.apiKey.workspaceId) {
        sendJson(res, 403, {
          error: 'FORBIDDEN: A workspace-scoped key cannot create workspaces',
        });
        return;
      }

      const parsed = await readJsonObject(req);
      const { name, slug, description, retentionDays } = parsed;

      if (!name || typeof name !== 'string' || !slugify(name)) {
        sendJson(res, 400, { error: 'BAD_REQUEST: a name that slugifies to at least one character is required' });
        return;
      }
      let retentionDaysValue: number | null = null;
      if (retentionDays !== undefined && retentionDays !== null) {
        if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays <= 0) {
          sendJson(res, 400, { error: 'BAD_REQUEST: retentionDays must be a positive integer' });
          return;
        }
        retentionDaysValue = retentionDays;
      }

      const resolvedSlug = typeof slug === 'string' && slug.trim() ? slugify(slug) : slugify(name);
      if (!resolvedSlug) {
        sendJson(res, 400, { error: 'BAD_REQUEST: slug is empty' });
        return;
      }

      // Creating a workspace mints a tenancy boundary and its first key. Like
      // deletion, it is stamped by a human session plus the confirmation secret,
      // so an agent holding the account-wide key cannot create workspaces at all.
      // When the principal has MFA enrolled, a valid code is required too.
      if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
        return;

      // Slice 16: a second, independent guard. Even a compromised browser session
      // that holds the confirmation secret may create at most one workspace per
      // rolling day. The platform owner is exempt. The auto-provisioned personal
      // sandbox does not count. Enforced inside dbCreateWorkspaceAtomic under a
      // per-principal advisory lock so concurrent creates cannot race the quota.
      const workspaceId = randomUUID();
      const keyId = randomUUID();
      const rawSecret = `octo_live_ws_${randomUUID().replace(/-/g, '')}`;

      try {
        const workspace = await dbCreateWorkspaceAtomic({
          workspaceId,
          slug: resolvedSlug,
          name: name.trim(),
          description: typeof description === 'string' && description.trim() ? description.trim() : null,
          retentionDays: retentionDaysValue,
          createdBy: auth.principal.id,
          keyId,
          keyHash: hashApiKeySecret(rawSecret),
          keyPrefix: 'octo_live_ws',
          keyName: `${name.trim()} workspace key`,
          keyScopes: ['read', 'write', 'files'],
          enforceDailyLimit: !auth.principal.isPlatformOwner,
        });

        await dbRecordActivity(
          workspaceId,
          'workspace.created',
          `Workspace '${workspace.name}' created`,
          null,
          auth.principal.id
        );

        // Auto-provision the workspace's own database so it is usable without a
        // second call. A failure here does not fail the request: the workspace
        // exists, and the manual provisioning route remains the retry.
        let databaseProvisioned = false;
        try {
          databaseProvisioned = await autoProvisionWorkspaceDatabase(workspace, auth.principal.id);
        } catch (err) {
          console.warn(
            '[provisioning] auto-provision failed for workspace',
            workspaceId,
            err instanceof Error ? err.message : String(err)
          );
        }

        sendJson(res, 201, {
          workspace: { ...workspace, role: 'owner', isOwner: true },
          apiKey: {
            id: keyId,
            prefix: 'octo_live_ws',
            name: `${name.trim()} workspace key`,
            workspaceId,
            isAccountWide: false,
            scopes: ['read', 'write', 'files'],
          },
          rawSecret,
          databaseProvisioned,
        });
      } catch (err) {
        // A slug collision raises the unique-violation code from the plain INSERT.
        if ((err as { code?: string }).code === '23505') {
          sendJson(res, 409, {
            error: `SLUG_TAKEN: a workspace with slug '${resolvedSlug}' already exists`,
          });
          return;
        }
        if ((err as { code?: string }).code === 'WORKSPACE_DAILY_LIMIT') {
          sendJson(res, 429, {
            error: 'WORKSPACE_DAILY_LIMIT: You can create one workspace per day. Try again after 24 hours.',
          });
          return;
        }
        throw err;
      }
      return;
    }

    // 3c. Delete a workspace: DELETE /api/workspaces/:id
    // Destructive: owner-only, gated on the human confirmation secret plus the
    // typed slug, and refused while any file is mid-archive so a copy in flight
    // cannot be orphaned.
    if (pathname.startsWith('/api/workspaces/') && req.method === 'DELETE') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }

      const workspaceId = pathname.slice('/api/workspaces/'.length);
      if (!UUID_PATTERN.test(workspaceId)) {
        sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
        return;
      }

      const parsed = await readJsonObject(req);
      // Deletion is the most destructive command, so it is the first to require a
      // per-principal MFA step-up: when the principal has an authenticator enrolled,
      // a valid TOTP code (or a one-time recovery code) is required in addition to
      // the confirmation secret. Principals without MFA enrolled are unaffected.
      if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
        return;

      const workspace = await dbGetWorkspaceById(workspaceId);
      if (!workspace) {
        sendJson(res, 404, { error: 'WORKSPACE_NOT_FOUND' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      // A platform owner may delete any workspace; the gate above already required
      // a human session, so this override is never reachable by an API key.
      if (mem?.role !== 'owner' && !auth.principal.isPlatformOwner) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner role required to delete a workspace' });
        return;
      }

      if (parsed.confirmSlug !== workspace.slug) {
        sendJson(res, 403, {
          error: `CONFIRM_SLUG_MISMATCH: type the workspace slug '${workspace.slug}' to confirm`,
        });
        return;
      }

      // Refuse while a copy is in flight: deleting now would orphan the bytes.
      if ((await dbCountTransientFiles(workspaceId)) > 0) {
        sendJson(res, 409, {
          error: 'WORKSPACE_BUSY: a file is mid-archive; wait for it to settle and retry',
        });
        return;
      }

      const storageKeys = await dbListWorkspaceStorageKeys(workspaceId);

      // Read the catalog row before the delete: the cascade removes it, and the
      // database and role it names are not reachable by any cascade.
      const provisioned = await dbGetWorkspaceDatabase(workspaceId);

      // The transaction re-checks the transient state, closing the window between
      // the pre-check above and the delete.
      if (!(await dbDeleteWorkspaceAtomic(workspaceId))) {
        sendJson(res, 409, {
          error: 'WORKSPACE_BUSY: a file entered a transient archive state during delete',
        });
        return;
      }

      // The cascade removed the catalog row but not the database or role on the
      // cluster, which no cascade can reach. Drop them outside the transaction
      // (DROP DATABASE cannot run inside one). Best effort: the workspace is
      // already gone, so a failure is reported rather than failing the delete.
      let orphanedDatabase: { dbName: string; roleName: string } | null = null;
      if (provisioned) {
        try {
          if (!provisioningConfigured()) {
            throw new Error('PROVISIONING_NOT_CONFIGURED: OCTO_ADMIN_URL is not set');
          }
          await dropProvisionedDatabase(provisioned.dbName, provisioned.roleName);
        } catch (err) {
          console.error(
            `[workspaces] failed to drop provisioned database ${provisioned.dbName}:`,
            err instanceof Error ? err.message : String(err)
          );
          orphanedDatabase = { dbName: provisioned.dbName, roleName: provisioned.roleName };
        }
      }

      // The graph is a derived read model with no irreplaceable data, so its
      // lifecycle ends with the workspace: leaving it behind would accumulate
      // in-memory graphs the engine never reclaims. Best effort, like the database
      // drop above -- the workspace is already gone, so a failure is reported
      // rather than failing the delete.
      let orphanedGraph = false;
      if (graphClient) {
        try {
          await graphClient.deleteGraph(workspaceId);
        } catch (err) {
          console.error(
            `[workspaces] failed to delete graph for ${workspaceId}:`,
            err instanceof Error ? err.message : String(err)
          );
          orphanedGraph = true;
        }
      }

      sendJson(res, 200, {
        success: true,
        workspaceId,
        slug: workspace.slug,
        // The DB cascade removes rows but not R2/Drive bytes or the cluster-side
        // database. Report what survived so the operator sees the consequence
        // instead of a silent leak.
        orphanedObjects: storageKeys,
        orphanedDatabase,
        orphanedGraph,
      });
      return;
    }


    // 3d. Provision a real Postgres database for a workspace:
    // POST /api/workspaces/:id/database
    // Creates a role and a database owned by it, records the catalog row, and
    // returns the client's connection string exactly once. Additive, so there is
    // no confirmation gate; it is refused for workspace-scoped keys for the same
    // reason workspace creation is (a scoped key cannot mint more of anything).
    if (
      pathname.startsWith('/api/workspaces/') &&
      pathname.endsWith('/database') &&
      req.method === 'POST'
    ) {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }
      if (auth.apiKey && auth.apiKey.workspaceId) {
        sendJson(res, 403, {
          error: 'FORBIDDEN: A workspace-scoped key cannot provision databases',
        });
        return;
      }

      const workspaceId = pathname.slice('/api/workspaces/'.length, -'/database'.length);
      if (!UUID_PATTERN.test(workspaceId)) {
        sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
        return;
      }

      const workspace = await dbGetWorkspaceById(workspaceId);
      if (!workspace) {
        sendJson(res, 404, { error: 'WORKSPACE_NOT_FOUND' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem && !auth.principal.isPlatformOwner) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      if (await dbGetWorkspaceDatabase(workspaceId)) {
        sendJson(res, 409, {
          error: 'DATABASE_EXISTS: this workspace already has a provisioned database',
        });
        return;
      }

      if (!provisioningConfigured()) {
        // Thrown so the outer handler captures it as an ops event like any other
        // 500, rather than inventing a second failure path.
        throw new Error('PROVISIONING_NOT_CONFIGURED: OCTO_ADMIN_URL is not set');
      }

      const provisioned = await provisionDatabase(workspace.slug);
      const database = await dbInsertWorkspaceDatabase(
        randomUUID(),
        workspaceId,
        provisioned.dbName,
        provisioned.roleName,
        auth.principal.id
      );

      await dbRecordActivity(
        workspaceId,
        'workspace.database_provisioned',
        `Database '${database.dbName}' provisioned for workspace '${workspace.name}'`,
        null,
        auth.principal.id
      );

      // Keep the role's password so the SQL surface (POST /api/workspaces/:id/query)
      // can authenticate as the workspace's own role without a connection string from
      // the caller. Stored encrypted, on the service pool only. Best effort: if the
      // encryption key is unset, provisioning still succeeds and the query surface
      // rotates a fresh password on first use (which invalidates the string returned
      // here, so the key belongs in the deployment).
      try {
        await dbSetWorkspaceDatabaseCredential(workspaceId, encryptSecret(provisioned.password));
      } catch (err) {
        console.warn(
          '[provisioning] database credential not stored:',
          err instanceof Error ? err.message : String(err)
        );
      }

      // The connection string is returned here and nowhere else: it is not stored,
      // not logged, and not repeated in the activity event above.
      sendJson(res, 201, {
        database,
        connectionString: provisioned.connectionString,
      });
      return;
    }


    // 4. File Catalog: GET /api/files?workspaceId=...
    if (pathname === '/api/files' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'files')) {
        scopeDenied(res, 'files');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      // Enforce workspace-scoped key restrictions
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      const files = await dbListWorkspaceFiles(workspaceId);
      sendJson(res, 200, files.map((file) => presentFile(file)));
      return;
    }

    // 5. File Upload: POST /api/files/upload
    if (pathname === '/api/files/upload' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, name, mimeType, data, dataEncoding } = parsed;

      if (!workspaceId || !name || data === undefined) {
        sendJson(res, 400, { error: 'workspaceId, name, and data are required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      // Enforce workspace-scoped key restriction
      if (auth.apiKey && auth.apiKey.workspaceId && auth.apiKey.workspaceId !== workspaceId) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to upload' });
        return;
      }

      const fileId = randomUUID();
      const storageKey = `workspaces/${workspaceId}/${fileId}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

      // Upload bytes to Cloudflare R2 (or the explicit local CI/dev backend)
      if (!objectStore) {
        sendJson(res, 503, {
          error:
            'STORAGE_UNAVAILABLE: R2 credentials missing. Set OCTO_STORAGE_BACKEND=local for CI/dev only.',
        });
        return;
      }

      // Binary payloads must declare base64; otherwise the body is treated as
      // UTF-8 text. Storing base64 text as an object body would corrupt every
      // uploaded image and silently break thumbnail generation.
      if (dataEncoding !== undefined && dataEncoding !== 'base64' && dataEncoding !== 'utf8') {
        sendJson(res, 400, { error: "BAD_REQUEST: dataEncoding must be 'base64' or 'utf8'" });
        return;
      }

      const payload =
        dataEncoding === 'base64'
          ? Buffer.from(String(data), 'base64')
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(String(data), 'utf-8');

      if (payload.byteLength === 0) {
        sendJson(res, 400, { error: 'BAD_REQUEST: decoded payload is empty' });
        return;
      }

      const contentType = mimeType ?? 'application/octet-stream';
      await objectStore.put(storageKey, payload, contentType);
      const sizeBytes = payload.byteLength;
      const etag: string | null = `stored-${payload.byteLength}`;
      // Commit record into PostgreSQL octo.files
      let fileRecord;
      try {
        fileRecord = await dbInsertFile(
          fileId,
          workspaceId,
          auth.principal.id,
          name,
          mimeType ?? 'application/octet-stream',
          sizeBytes,
          storageKey,
          etag?.replace(/"/g, '') ?? null
        );
      } catch (err) {
        try {
          await objectStore.delete(storageKey);
        } catch (cleanupError) {
          console.error(`File upload cleanup failed for ${fileId}:`, cleanupError);
        }
        throw err;
      }

      await attributeAgentAction(
        auth,
        workspaceId,
        'file.uploaded',
        `File ${name} uploaded by agent principal`
      );
      sendJson(res, 201, fileRecord);
      return;
    }

    // 6. Presigned Download URL: GET /api/files/download
    if (pathname === '/api/files/download' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'files')) {
        scopeDenied(res, 'files');
        return;
      }

      const fileId = url.searchParams.get('fileId');
      const workspaceId = url.searchParams.get('workspaceId');
      if (!fileId || !workspaceId) {
        sendJson(res, 400, { error: 'fileId and workspaceId required' });
        return;
      }
      if (!requireUuid(res, fileId, 'fileId')) return;
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }
      if (!objectStore) {
        sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'member')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      const file = await dbGetFile(workspaceId, fileId);
      if (!file) {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }

      // An archived file has no R2 object to presign, so send the caller to the
      // content endpoint, which restores the bytes on demand.
      const downloadUrl =
        r2Provider && file.archiveState !== 'archived_drive'
          ? await r2Provider.generatePresignedDownloadUrl(file.storageKey, 3600)
          : `/api/files/content?fileId=${fileId}&workspaceId=${workspaceId}`;
      sendJson(res, 200, { file: presentFile(file), downloadUrl });
      return;
    }
    // 6b. File Content: GET /api/files/content?workspaceId=...&fileId=...
    // Streams authorized bytes for browser downloads, restoring cold files on demand.
    if (pathname === '/api/files/content' && req.method === 'GET') {
      const auth = await authorizeMediaRequest(req, url);
      if (auth === false) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not authorized for this workspace' });
        return;
      }
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }

      const { fileId, workspaceId } = auth;

      const file = await dbGetFile(workspaceId, fileId);
      if (!file) {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }

      if (!objectStore) {
        sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
        return;
      }

      const bytes = await ensureActiveBytes(workspaceId, file);
      if (!bytes) {
        sendJson(res, 404, { error: 'OBJECT_MISSING: Stored bytes not found for this record.' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Access-Control-Allow-Origin': '*',
      });
      res.end(bytes);
      return;
    }

    // 6c. Thumbnail: GET /api/files/thumbnail?workspaceId=...&fileId=...
    // Serves a cached small WebP derivative so grids never fetch full originals.
    if (pathname === '/api/files/thumbnail' && req.method === 'GET') {
      const auth = await authorizeMediaRequest(req, url);
      if (auth === false) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not authorized for this workspace' });
        return;
      }
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }

      const { fileId, workspaceId, principalId } = auth;

      const file = await dbGetFile(workspaceId, fileId);
      if (!file) {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }

      if (!objectStore) {
        sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
        return;
      }

      // A thumbnail needs the original bytes; pull them back from the cold tier
      // first when the file has been archived.
      if (file.archiveState === 'archived_drive' && !(await ensureActiveBytes(workspaceId, file))) {
        sendJson(res, 404, { error: 'OBJECT_MISSING: Archived bytes could not be restored.' });
        return;
      }

      const thumb = await ensureThumbnail(objectStore, fileId, file.storageKey, file.mimeType);

      if (!thumb) {
        // Not an image (or original missing/corrupt): send the caller to the full
        // object instead of inventing a derivative. The fallback keeps the same
        // scope that authorized this request, and a share-scoped fallback is
        // capped at the share's own expiry.
        const fallback = auth.share
          ? { kind: 'share' as const, fileId, workspaceId, shareId: auth.share.shareId }
          : { kind: 'principal' as const, fileId, workspaceId, principalId };
        res.writeHead(302, {
          Location: signMediaUrl('/api/files/content', fallback, 3600, auth.share?.validUntil ?? null),
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': thumb.contentType,
        'Content-Length': String(thumb.bytes.byteLength),
        'Cache-Control': 'private, max-age=3600',
        'X-Octo-Thumbnail-Cache': thumb.cached ? 'hit' : 'miss',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(thumb.bytes);
      return;
    }

    // 7. Publish / unpublish: POST /api/files/:id/publish | /unpublish
    // Registered before delete and archive so the suffix is not parsed as an id.
    if (
      pathname.startsWith('/api/files/') &&
      (pathname.endsWith('/publish') || pathname.endsWith('/unpublish')) &&
      req.method === 'POST'
    ) {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const publishing = pathname.endsWith('/publish');
      const suffix = publishing ? '/publish' : '/unpublish';
      const fileId = pathname.slice('/api/files/'.length, -suffix.length);
      const workspaceId = url.searchParams.get('workspaceId');
      if (!fileId || !workspaceId) {
        sendJson(res, 400, { error: 'fileId and workspaceId required' });
        return;
      }
      if (!requireUuid(res, fileId, 'fileId')) return;
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, {
          error: publishing
            ? 'FORBIDDEN: Operator role or higher required to publish'
            : 'FORBIDDEN: Operator role or higher required to unpublish',
        });
        return;
      }
      if (!objectStore) {
        sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
        return;
      }

      const file = await dbGetFile(workspaceId, fileId);
      if (!file) {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }

      if (!publishing) {
        if (file.publishedAt == null && file.publicKey == null) {
          sendJson(res, 200, { fileId, published: false });
          return;
        }
        if (!publicTarget) {
          sendJson(res, 503, { error: 'PUBLIC_STORAGE_UNAVAILABLE: public file bucket is not configured' });
          return;
        }
        try {
          await clearPublishedObject({
            publishedAt: file.publishedAt,
            publicKey: file.publicKey ?? fileId,
            deletePublic: deletePublicObject,
          });
        } catch (err) {
          const message =
            err instanceof PublishStepError
              ? err.message
              : 'PUBLIC_DELETE_FAILED: the public object could not be removed';
          sendJson(res, 502, { error: message });
          return;
        }
        await dbClearFilePublished(fileId, workspaceId);
        await attributeAgentAction(
          auth,
          workspaceId,
          'file.unpublished',
          `File ${fileId} removed from the public bucket`
        );
        sendJson(res, 200, { fileId, published: false });
        return;
      }

      if (!publicTarget) {
        sendJson(res, 503, { error: 'PUBLIC_STORAGE_UNAVAILABLE: public file bucket is not configured' });
        return;
      }
      if (file.archiveState === 'active_r2') {
        const size = await objectStore.head(file.storageKey);
        if (size === null) {
          sendJson(res, 404, { error: 'OBJECT_MISSING: Stored bytes not found for this record.' });
          return;
        }
      }

      const wasPublished = file.publishedAt != null;
      let copied: { url: string; publicKey: string };
      try {
        const activeBytes =
          publicTarget.mode === 'local' ? await objectStore.get(file.storageKey) : null;
        const result = await publishSnapshot({
          fileId,
          mimeType: file.mimeType,
          archiveState: file.archiveState,
          baseUrl: publicTarget.baseUrl,
          activeBytes,
          writePublic: async (key, bytes, contentType) => {
            if (!publicLocalStore) {
              throw new PublishStepError(
                'PUBLIC_COPY_FAILED',
                'PUBLIC_COPY_FAILED: the public object could not be written'
              );
            }
            await publicLocalStore.put(key, bytes, contentType);
          },
          copyDirect:
            publicTarget.mode === 'r2' && r2Provider && publicTarget.publicBucket
              ? async () => {
                  await r2Provider.copyToBucket(
                    publicTarget.publicBucket!,
                    file.storageKey,
                    fileId,
                    file.mimeType
                  );
                }
              : undefined,
        });
        if (!result.ok) {
          const error =
            result.code === 'FILE_NOT_ACTIVE'
              ? 'FILE_NOT_ACTIVE: restore the file before publishing; publish does not restore'
              : 'OBJECT_MISSING: Stored bytes not found for this record.';
          sendJson(res, result.code === 'FILE_NOT_ACTIVE' ? 409 : 404, { error });
          return;
        }
        copied = result;
      } catch (err) {
        const message =
          err instanceof PublishStepError
            ? err.message
            : 'PUBLIC_COPY_FAILED: the public object could not be written';
        sendJson(res, 502, { error: message });
        return;
      }

      const publishedAt = await dbMarkFilePublished(fileId, workspaceId, copied.publicKey);
      if (!publishedAt) {
        if (!wasPublished) {
          try {
            await deletePublicObject(copied.publicKey);
          } catch (cleanupError) {
            console.error(`Public publish cleanup failed for ${fileId}:`, cleanupError);
          }
        }
        sendJson(res, 409, {
          error: 'FILE_NOT_ACTIVE: restore the file before publishing; publish does not restore',
        });
        return;
      }

      await attributeAgentAction(auth, workspaceId, 'file.published', `File ${fileId} published`);
      sendJson(res, 200, {
        fileId,
        url: copied.url,
        publishedAt,
        republished: wasPublished,
      });
      return;
    }

    // 7. File Delete: DELETE /api/files/:id
    if (pathname.startsWith('/api/files/') && req.method === 'DELETE') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'delete')) {
        scopeDenied(res, 'delete');
        return;
      }

      const fileId = pathname.slice('/api/files/'.length);
      const workspaceId = url.searchParams.get('workspaceId');
      if (!fileId || !workspaceId) {
        sendJson(res, 400, { error: 'fileId and workspaceId required' });
        return;
      }
      if (!requireUuid(res, fileId, 'fileId')) return;
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }
      if (!objectStore) {
        sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'admin')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to delete files' });
        return;
      }

      const result = await dbDeleteFileIfIdle(workspaceId, fileId);
      if (result.status === 'missing') {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }
      if (result.status === 'busy') {
        sendJson(res, 409, { error: 'FILE_BUSY: archive or restore is in progress' });
        return;
      }

      let storageKey = result.storageKey;
      if (result.status === 'awaiting_public_delete') {
        if (!publicTarget) {
          sendJson(res, 503, { error: 'PUBLIC_STORAGE_UNAVAILABLE: public file bucket is not configured' });
          return;
        }
        try {
          await clearPublishedObject({
            publishedAt: new Date().toISOString(),
            publicKey: result.publicKey,
            deletePublic: deletePublicObject,
          });
        } catch (err) {
          const message =
            err instanceof PublishStepError
              ? err.message
              : 'PUBLIC_DELETE_FAILED: the public object could not be removed';
          sendJson(res, 502, { error: message });
          return;
        }
        const finished = await dbFinishFileDelete(workspaceId, fileId);
        if (finished.status === 'busy') {
          await dbClearFilePublished(fileId, workspaceId);
          sendJson(res, 409, { error: 'FILE_BUSY: archive or restore is in progress' });
          return;
        }
        if (finished.status === 'missing') {
          sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
          return;
        }
        storageKey = finished.storageKey;
      }

      await objectStore.delete(storageKey);

      await attributeAgentAction(auth, workspaceId, 'file.deleted', `File ${fileId} deleted by agent principal`);
      sendJson(res, 200, { success: true, fileId });
      return;
    }

    // 7b. Archive / Restore: POST /api/files/:id/archive | /restore
    // Both are queued as jobs rather than executed inline, so the copy-verify-
    // delete ordering runs under the worker's lease and retry accounting.
    if (
      pathname.startsWith('/api/files/') &&
      (pathname.endsWith('/archive') || pathname.endsWith('/restore')) &&
      req.method === 'POST'
    ) {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      const direction = pathname.endsWith('/archive') ? 'archive' : 'restore';
      // Archiving removes the bytes from the active tier, so it needs the delete
      // scope; restoring only writes them back and needs write.
      const requiredScope: OctoScope = direction === 'archive' ? 'delete' : 'write';
      if (!requireScope(auth, requiredScope)) {
        scopeDenied(res, requiredScope);
        return;
      }

      const suffix = `/${direction}`;
      const fileId = pathname.slice('/api/files/'.length, -suffix.length);
      const workspaceId = url.searchParams.get('workspaceId');
      if (!fileId || !workspaceId) {
        sendJson(res, 400, { error: 'fileId and workspaceId required' });
        return;
      }
      if (!requireUuid(res, fileId, 'fileId')) return;
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      // A workspace-scoped key may only touch its own workspace.
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required' });
        return;
      }

      if (!archiveDeps) {
        sendJson(res, 503, {
          error: 'ARCHIVE_UNAVAILABLE: Google Drive archival is not configured on this server.',
        });
        return;
      }

      const file = await dbGetFile(workspaceId, fileId);
      if (!file) {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }

      const transition = await enqueueFileTransition(
        direction,
        workspaceId,
        { id: file.id, storageKey: file.storageKey, mimeType: file.mimeType },
        auth.principal.id
      );
      if (transition.status === 'missing') {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }
      if (transition.status === 'busy') {
        sendJson(res, 409, { error: 'FILE_BUSY: another archive or restore is in progress' });
        return;
      }
      const { job, created } = transition;

      if (created) {
        await dbRecordActivity(
          workspaceId,
          'file.archive_requested',
          `File ${fileId} ${direction} queued`,
          job.id,
          auth.principal.id
        );
      }

      sendJson(res, 202, { job, created });
      return;
    }

    // 8. Gallery Media: GET /api/gallery?workspaceId=...
    if (pathname === '/api/gallery' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'files')) {
        scopeDenied(res, 'files');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'member')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      const allFiles = await dbListWorkspaceFiles(workspaceId);
      const mediaFiles = allFiles.filter(
        (f) => f.mimeType.startsWith('image/') || f.mimeType.startsWith('video/')
      );

      const items = [];
      for (const f of mediaFiles) {
        const claims = {
          kind: 'principal' as const,
          fileId: f.id,
          workspaceId,
          principalId: auth.principal.id,
        };

        // The full view uses the original (presigned R2 URL when available, else the
        // signed content route). The grid always uses the small cached derivative.
        // An archived file has no R2 object to presign, so it goes through the
        // content route, which restores the bytes on demand.
        const fullUrl =
          r2Provider && f.archiveState !== 'archived_drive'
            ? await r2Provider.generatePresignedDownloadUrl(f.storageKey, 3600)
            : signMediaUrl('/api/files/content', claims);

        const thumbnailUrl = signMediaUrl('/api/files/thumbnail', claims);

        items.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          kind: f.mimeType.startsWith('video/') ? 'video' : 'image',
          thumbnailUrl,
          fullUrl,
          createdAt: f.createdAt,
        });
      }

      sendJson(res, 200, items);
      return;
    }

    // 8. API Keys: GET & POST /api/keys
    if (pathname === '/api/keys' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
      const keys = await dbListApiKeys(auth.principal.id, workspaceId);
      sendJson(
        res,
        200,
        keys.map((k) => ({
          ...k,
          isAccountWide: k.workspaceId === null,
        }))
      );
      return;
    }

    if (pathname === '/api/keys' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }

      const parsed = await readJsonObject(req);
      const {
        name,
        workspaceId: requestedWorkspaceId,
        scopes: requestedScopes,
        keyClass,
        expiresInDays,
      } = parsed;

      if (!name || typeof name !== 'string') {
        sendJson(res, 400, { error: 'name is required' });
        return;
      }

      let expiresAt: string | null = null;
      if (expiresInDays !== undefined && expiresInDays !== null) {
        if (!Number.isInteger(expiresInDays as number) || (expiresInDays as number) <= 0) {
          sendJson(res, 400, { error: 'BAD_REQUEST: expiresInDays must be a positive integer' });
          return;
        }
        const d = new Date();
        d.setDate(d.getDate() + (expiresInDays as number));
        // A large enough day count overflows the Date range; refuse it rather than
        // letting toISOString() throw `Invalid time value` as a 500.
        if (!Number.isFinite(d.getTime())) {
          sendJson(res, 400, { error: 'BAD_REQUEST: expiresInDays is out of range' });
          return;
        }
        expiresAt = d.toISOString();
      }

      // A key class names a documented authority profile and expands to its
      // scopes; it is a preset over the real scopes, never a second
      // authorization dimension. Class and an explicit scope list are mutually
      // exclusive.
      if (keyClass !== undefined && requestedScopes !== undefined) {
        sendJson(res, 400, { error: 'BAD_REQUEST: keyClass and scopes are mutually exclusive' });
        return;
      }

      // Default is non-destructive: a new token can read and write files but
      // cannot delete anything unless the delete scope is requested explicitly.
      let scopes: string[] = ['read', 'write', 'files'];
      if (keyClass !== undefined) {
        if (typeof keyClass !== 'string' || !Object.prototype.hasOwnProperty.call(KEY_CLASSES, keyClass)) {
          sendJson(res, 400, {
            error: `BAD_REQUEST: keyClass must be one of: ${Object.keys(KEY_CLASSES).join(', ')}`,
          });
          return;
        }
        scopes = [...KEY_CLASSES[keyClass as KeyClass].scopes];
      } else if (requestedScopes !== undefined) {
        const parsedScopes = parseKeyScopes(requestedScopes);
        if (!parsedScopes.ok) {
          sendJson(res, 400, { error: parsedScopes.error });
          return;
        }
        scopes = parsedScopes.scopes;
      }

      if (
        requestedWorkspaceId !== undefined &&
        requestedWorkspaceId !== null &&
        typeof requestedWorkspaceId !== 'string'
      ) {
        sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a UUID string' });
        return;
      }
      let workspaceId: string | null =
        typeof requestedWorkspaceId === 'string' ? requestedWorkspaceId : null;
      if (workspaceId !== null && !UUID_PATTERN.test(workspaceId)) {
        sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
        return;
      }

      // A token may only narrow its own authority when minting another key: it
      // cannot widen its scopes, escape its workspace binding, or turn a
      // workspace-bound token into an account-wide one.
      const decision = authorizeKeyMint(
        {
          isApiKey: Boolean(auth.apiKey),
          workspaceId: auth.apiKey?.workspaceId ?? null,
          scopes: auth.apiKey?.scopes ?? [],
        },
        { workspaceId, scopes }
      );
      if (!decision.ok) {
        sendJson(res, decision.status, { error: decision.error });
        return;
      }
      workspaceId = decision.workspaceId;
      scopes = decision.scopes;

      // If workspace-scoped key requested, verify caller belongs to that workspace
      if (workspaceId) {
        const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
        if (!mem) {
          sendJson(res, 403, { error: 'FORBIDDEN: Cannot create API key for non-member workspace' });
          return;
        }
      }

      // Minting a credential grants authority, so it carries the same human stamp
      // as workspace creation and deletion: a human session plus the confirmation
      // secret. An API-key caller is refused outright, so a leaked agent token
      // cannot mint itself a wider key. When the principal has MFA enrolled, a
      // valid code is required too.
      if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
        return;

      const isAccountWide = !workspaceId;

      // At most one account-wide key per principal (enforced by a partial unique
      // index). Refuse a duplicate with guidance rather than minting a second one.
      if (isAccountWide && (await dbGetAccountWideKeyId(auth.principal.id))) {
        sendJson(res, 409, {
          error: 'ACCOUNT_KEY_EXISTS: revoke the existing account-wide key before creating another.',
        });
        return;
      }

      const prefix = isAccountWide ? 'octo_live_acc' : 'octo_live_ws';
      const secretBytes = randomUUID().replace(/-/g, '');
      const rawSecret = `${prefix}_${secretBytes}`;
      const keyHash = hashApiKeySecret(rawSecret);

      // Authority is never asserted by the key:
      //   * account-wide keys carry role NULL, so each call is authorized against
      //     the principal's live memberships;
      //   * workspace-scoped keys are capped at the creator's current role there.
      let keyRole: string | null = null;
      if (workspaceId) {
        const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
        keyRole = mem?.role ?? 'member';
      }

      const keyId = randomUUID();
      await dbInsertApiKey(
        keyId,
        keyHash,
        prefix,
        name,
        auth.principal.id,
        workspaceId ?? null,
        keyRole,
        scopes,
        expiresAt
      );

      sendJson(res, 201, {
        apiKey: {
          id: keyId,
          prefix,
          name,
          workspaceId: workspaceId ?? null,
          isAccountWide,
          scopes,
          expiresAt,
        },
        rawSecret,
      });
      return;
    }

    // 8a. Edit allowances on an existing key: PATCH /api/keys/:id
    // The secret does not change. A human session must confirm, so a key cannot
    // widen itself.
    if (pathname.startsWith('/api/keys/') && req.method === 'PATCH') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }

      const keyId = pathname.slice('/api/keys/'.length);
      if (!keyId || !UUID_PATTERN.test(keyId)) {
        sendJson(res, 400, { error: 'BAD_REQUEST: keyId must be a valid UUID' });
        return;
      }

      const parsed = await readJsonObject(req);
      const parsedScopes = parseKeyScopes(parsed.scopes);
      if (!parsedScopes.ok) {
        sendJson(res, 400, { error: parsedScopes.error });
        return;
      }

      if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
        return;

      const updated = await dbUpdateApiKeyScopes(keyId, auth.principal.id, parsedScopes.scopes);
      if (!updated) {
        sendJson(res, 404, { error: 'KEY_NOT_FOUND: no such key owned by this principal' });
        return;
      }

      sendJson(res, 200, { ...updated, isAccountWide: updated.workspaceId === null });
      return;
    }

    // 8b. Revoke an API key: DELETE /api/keys/:id
    // Without this, a leaked agent token could never be withdrawn.
    if (pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      // Revoking a credential is destructive: a read-only or ingest token must
      // not be able to withdraw the account's keys.
      if (!requireScope(auth, 'delete')) {
        scopeDenied(res, 'delete');
        return;
      }

      const keyId = pathname.slice('/api/keys/'.length);
      if (!keyId || !UUID_PATTERN.test(keyId)) {
        sendJson(res, 400, { error: 'BAD_REQUEST: keyId must be a valid UUID' });
        return;
      }

      const rows = await query<{ id: string }>(
        'DELETE FROM octo.api_keys WHERE id = $1 AND principal_id = $2 RETURNING id',
        [keyId, auth.principal.id]
      );

      if (rows.length === 0) {
        sendJson(res, 404, { error: 'KEY_NOT_FOUND: no such key owned by this principal' });
        return;
      }

      sendJson(res, 200, { success: true, keyId });
      return;
    }

    // 9. Scoped share links (Slice 4)
    // Create: POST /api/workspaces/shares
    if (pathname === '/api/workspaces/shares' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      // A share link grants read (or upload) access to this workspace's gallery,
      // so minting one needs the write scope; the role check below still applies.
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, resourceType, resourceId, permission, expiresInHours, validUntil } = parsed;

      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      // Enforce workspace-scoped key restrictions before anything else.
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      // The server connects as a trusted role, so authorization is enforced here.
      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'admin')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to create share links' });
        return;
      }

      if (resourceType && resourceType !== 'gallery') {
        sendJson(res, 400, { error: "BAD_REQUEST: Only resourceType 'gallery' is supported currently" });
        return;
      }

      if (permission && permission !== 'read' && permission !== 'upload') {
        sendJson(res, 400, { error: "BAD_REQUEST: permission must be 'read' or 'upload'" });
        return;
      }

      const rawToken = `octo_share_${randomBytes(32).toString('base64url')}`;
      const tokenHash = hashShareToken(rawToken);
      const tokenPrefix = rawToken.slice(0, 18);

      let expiry: string | null = validUntil ?? null;
      if (!expiry && typeof expiresInHours === 'number' && expiresInHours > 0) {
        const d = new Date();
        d.setHours(d.getHours() + expiresInHours);
        // A large enough hour count overflows the Date range; refuse it rather than
        // letting toISOString() throw `Invalid time value` as a 500.
        if (!Number.isFinite(d.getTime())) {
          sendJson(res, 400, { error: 'BAD_REQUEST: expiresInHours is out of range' });
          return;
        }
        expiry = d.toISOString();
      }

      // Reject a nonsensical expiry with a clear 400 instead of surfacing the
      // database check constraint as an internal error.
      if (expiry) {
        const parsedExpiry = new Date(expiry);
        if (!Number.isFinite(parsedExpiry.getTime())) {
          sendJson(res, 400, { error: 'BAD_REQUEST: validUntil is not a valid timestamp' });
          return;
        }
        if (parsedExpiry.getTime() <= Date.now()) {
          sendJson(res, 400, { error: 'BAD_REQUEST: validUntil must be in the future' });
          return;
        }
      }

      const share = await dbInsertShare(
        randomUUID(),
        workspaceId,
        resourceType ?? 'gallery',
        resourceId ?? null,
        tokenHash,
        tokenPrefix,
        permission ?? 'read',
        expiry,
        auth.principal.id
      );

      // The raw token is returned exactly once and never persisted or logged.
      sendJson(res, 201, {
        share: { ...share, tokenHash: undefined },
        shareUrl: `/share/${rawToken}`,
        rawToken,
      });
      return;
    }

    // List: GET /api/workspaces/shares?workspaceId=...
    if (pathname === '/api/workspaces/shares' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      // Listing a workspace's share links is a read of its metadata.
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'admin')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to list share links' });
        return;
      }

      const shares = await dbListShares(workspaceId);
      sendJson(res, 200, shares);
      return;
    }

    // Revoke: DELETE /api/shares/:id?workspaceId=...
    if (pathname.startsWith('/api/shares/') && req.method === 'DELETE') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      // Revoking a credential is destructive, so it needs the delete scope.
      if (!requireScope(auth, 'delete')) {
        scopeDenied(res, 'delete');
        return;
      }

      const shareId = pathname.slice('/api/shares/'.length);
      const workspaceId = url.searchParams.get('workspaceId');
      if (!shareId || !workspaceId) {
        sendJson(res, 400, { error: 'shareId and workspaceId are required' });
        return;
      }
      if (!requireUuid(res, shareId, 'shareId')) return;
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'admin')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to revoke share links' });
        return;
      }

      const revoked = await dbRevokeShare(shareId);
      if (!revoked || revoked.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: 'SHARE_NOT_FOUND' });
        return;
      }

      sendJson(res, 200, { success: true, shareId });
      return;
    }

    // Anonymous public view: GET /api/public/shares/:token
    // Resolves the token to exactly one target resource. No workspace, sibling
    // album, or admin route is reachable with the token alone.
    if (pathname.startsWith('/api/public/shares/') && req.method === 'GET') {
      const rawToken = pathname.slice('/api/public/shares/'.length);
      if (!rawToken) {
        sendJson(res, 400, { error: 'share token is required' });
        return;
      }

      const tokenHash = hashShareToken(rawToken);
      const share = await dbResolveShareByTokenHash(tokenHash);

      // Unknown, revoked, not-yet-valid, and expired all fail identically, so the
      // response cannot be used to probe which links ever existed.
      if (!share) {
        sendJson(res, 404, { error: 'SHARE_NOT_FOUND_OR_INACTIVE' });
        return;
      }

      // The token has authorized this workspace read; bind the share creator so the
      // fenced file listing is scoped to exactly the shared workspace.
      bindRequestIdentity(share.createdBy, share.workspaceId);

      const mediaFiles = (await dbListWorkspaceFiles(share.workspaceId)).filter(
        (f) => f.mimeType.startsWith('image/') || f.mimeType.startsWith('video/')
      );

      const items = [];
      for (const f of mediaFiles) {
        const claims = {
          kind: 'share' as const,
          fileId: f.id,
          workspaceId: share.workspaceId,
          shareId: share.shareId,
        };

        // Media URLs are capped at the share's own expiry so they cannot outlive it.
        const fullUrl = signMediaUrl('/api/files/content', claims, 3600, share.validUntil);
        const thumbnailUrl = signMediaUrl('/api/files/thumbnail', claims, 3600, share.validUntil);

        items.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          kind: f.mimeType.startsWith('video/') ? 'video' : 'image',
          thumbnailUrl,
          fullUrl,
          createdAt: f.createdAt,
        });
      }

      // Only share-scoped fields are returned: no workspace name, members, or IDs
      // beyond the shared target itself.
      sendJson(res, 200, {
        share: {
          id: share.shareId,
          resourceType: share.resourceType,
          permission: share.permission,
          validUntil: share.validUntil,
        },
        items,
      });
      return;
    }

    // 9b. Workspace-aware capability discovery.
    if (pathname === '/api/capabilities' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, {
          error: 'UNAUTHENTICATED',
          code: 'UNAUTHENTICATED',
          message: 'A valid Octo credential is required.',
        });
        return;
      }

      const requestedWorkspaceId = url.searchParams.get('workspaceId');
      if (requestedWorkspaceId !== null && !UUID_PATTERN.test(requestedWorkspaceId)) {
        sendJson(res, 400, {
          error: 'INVALID_WORKSPACE_ID',
          code: 'INVALID_WORKSPACE_ID',
          message: 'workspaceId must be a UUID.',
        });
        return;
      }

      const scopes = auth.apiKey ? auth.apiKey.scopes : ['read', 'write', 'delete', 'files'];
      let workspace: { id: string; role: WorkspaceRole } | null = null;
      let unavailable: { action: string; reason: 'PROVIDER_UNAVAILABLE' }[] = [];
      let capabilities = capabilitiesForScopes(scopes);

      if (requestedWorkspaceId) {
        if (!keyWorkspaceMatches(auth, requestedWorkspaceId)) {
          sendJson(res, 403, {
            error: 'WORKSPACE_ACCESS_DENIED',
            code: 'WORKSPACE_ACCESS_DENIED',
            message: 'This credential cannot access the requested workspace.',
          });
          return;
        }

        let mem;
        try {
          const exists = await dbGetWorkspaceById(requestedWorkspaceId);
          mem = exists ? await dbGetWorkspaceMembership(requestedWorkspaceId, auth.principal.id) : null;
        } catch {
          sendJson(res, 500, {
            error: 'CAPABILITY_LOOKUP_FAILED',
            code: 'CAPABILITY_LOOKUP_FAILED',
            message: 'Workspace capabilities could not be loaded.',
          });
          return;
        }
        if (!mem) {
          sendJson(res, 403, {
            error: 'WORKSPACE_ACCESS_DENIED',
            code: 'WORKSPACE_ACCESS_DENIED',
            message: 'This credential cannot access the requested workspace.',
          });
          return;
        }

        const role = effectiveWorkspaceRole(auth, mem.role);
        workspace = { id: requestedWorkspaceId, role };
        capabilities = capabilities.filter((capability) => {
          if (capability.action === 'workspaces.create') return !auth.apiKey?.workspaceId;
          return roleMeetsMinimum(role, minimumRoleForCapability(capability.action));
        });

        const providerByAction: Record<string, boolean> = {
          'files.download': Boolean(objectStore),
          'files.upload': Boolean(objectStore),
          'files.publish': Boolean(objectStore && publicTarget),
          'files.unpublish': Boolean(objectStore && publicTarget),
          'files.delete': Boolean(objectStore),
          'files.archive': Boolean(objectStore && archiveDeps),
          'files.restore': Boolean(objectStore && archiveDeps),
          'graph.query': Boolean(graphClient),
        };
        const supported = [] as typeof capabilities;
        for (const capability of capabilities) {
          const configured = providerByAction[capability.action];
          if (configured === false) unavailable.push({ action: capability.action, reason: 'PROVIDER_UNAVAILABLE' });
          else supported.push(capability);
        }
        capabilities = supported;
      } else if (auth.apiKey?.workspaceId) {
        capabilities = capabilities.filter((capability) => capability.action !== 'workspaces.create');
      }

      sendJson(res, 200, {
        contractVersion: 1,
        discoveryMode: requestedWorkspaceId ? 'workspace' : 'unbound',
        workspace,
        principal: {
          id: auth.principal.id,
          isGuest: auth.principal.isGuest,
          // No email, provider token, or infrastructure credential is disclosed.
        },
        token: auth.apiKey
          ? {
              prefix: auth.apiKey.prefix,
              workspaceId: auth.apiKey.workspaceId,
              isAccountWide: auth.apiKey.isAccountWide,
              scopes: auth.apiKey.scopes,
            }
          : { type: 'session' },
        auth: AUTH_GUIDANCE,
        capabilities,
        unavailable,
      });
      return;
    }

    // 10. Operations: jobs and activity (Slice 6)
    // Enqueue: POST /api/jobs
    if (pathname === '/api/jobs' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, jobType, idempotencyKey, payload } = parsed;

      if (!workspaceId || !jobType || !idempotencyKey) {
        sendJson(res, 400, { error: 'workspaceId, jobType, and idempotencyKey are required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (jobType === 'archive_file' || jobType === 'restore_file') {
        sendJson(res, 400, { error: 'JOB_TYPE_RESERVED: use the file archive or restore route' });
        return;
      }
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to enqueue jobs' });
        return;
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
      return;
    }

    // List: GET /api/jobs?workspaceId=...
    if (pathname === '/api/jobs' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      sendJson(res, 200, await dbListJobs(workspaceId));
      return;
    }

    // Activity feed: GET /api/activity?workspaceId=...
    if (pathname === '/api/activity' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      sendJson(res, 200, await dbListActivity(workspaceId));
      return;
    }

    // Operational events: GET /api/ops/events?workspaceId=...&errorCode=...
    // Structured failure records for diagnosis (issue #140, slice O1).
    if (pathname === '/api/ops/events' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      const errorCode = url.searchParams.get('errorCode');
      sendJson(res, 200, { events: await dbListOpsEvents(workspaceId, errorCode) });
      return;
    }

    // Ops summary: GET /api/ops/summary?workspaceId=...
    // The O2 classification views over HTTP (issue #140, slice O3).
    if (pathname === '/api/ops/summary' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      sendJson(res, 200, await dbGetOpsSummary(workspaceId));
      return;
    }

    // Manual retry: POST /api/jobs/:id/retry?workspaceId=...
    // Recovery path for a job stuck after retry exhaustion.
    if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/retry') && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const jobId = pathname.slice('/api/jobs/'.length, -'/retry'.length);
      const workspaceId = url.searchParams.get('workspaceId');
      if (!jobId || !workspaceId) {
        sendJson(res, 400, { error: 'jobId and workspaceId are required' });
        return;
      }
      if (!requireUuid(res, jobId, 'jobId')) return;
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'admin')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to retry jobs' });
        return;
      }

      const retry = await dbRetryJob(jobId, workspaceId);
      if (retry === 'busy') {
        sendJson(res, 409, { error: 'FILE_BUSY: archive or restore is in progress' });
        return;
      }
      if (retry !== 'requeued') {
        sendJson(res, 404, { error: 'JOB_NOT_RETRYABLE: no failed job with that id in this workspace' });
        return;
      }

      await dbRecordActivity(workspaceId, 'job.requeued', 'Job manually requeued', jobId, auth.principal.id);
      sendJson(res, 200, { success: true, jobId });
      return;
    }

    // Worker tick: POST /api/jobs/run?workspaceId=...
    // Runs one drain pass so the operations page can demonstrate real progress
    // without requiring a separately supervised worker process.
    if (pathname === '/api/jobs/run' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to run jobs' });
        return;
      }

      const outcomes = await drainQueueOnce(workspaceId);
      sendJson(res, 200, { outcomes });
      return;
    }

    // 11. Retrieval: ingest and query (Slice 8)
    // Ingest: POST /api/rag/documents
    if (pathname === '/api/rag/documents' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      // Authorize before probing provider configuration: an unauthorized caller
      // must not learn whether embeddings are configured.
      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, title, text, mimeType } = parsed;

      if (!workspaceId || !title || typeof text !== 'string') {
        sendJson(res, 400, { error: 'workspaceId, title, and text are required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to ingest documents' });
        return;
      }

      const embeddingConfig = loadEmbeddingConfigFromEnv();
      if (!embeddingConfig) {
        sendJson(res, 503, {
          error: 'EMBEDDING_PROVIDER_NOT_CONFIGURED: set OCTO_EMBEDDING_API_KEY to ingest documents',
        });
        return;
      }

      const bytes = Buffer.from(text, 'utf-8');
      const resolvedMime = mimeType ?? 'text/plain';
      const extracted = extractText(resolvedMime, bytes);
      if (extracted === null) {
        sendJson(res, 415, {
          error: `EXTRACTION_UNSUPPORTED: cannot faithfully extract text from ${resolvedMime}`,
        });
        return;
      }

      const hash = contentHash(bytes);
      const configId = await dbEnsureEmbeddingConfig(
        workspaceId,
        embeddingConfig.model,
        'v1',
        embeddingConfig.dimensions,
        'paragraph-aware',
        800,
        100
      );

      const version = await dbUpsertDocumentVersion(
        workspaceId,
        title,
        hash,
        resolvedMime,
        bytes.byteLength,
        extracted,
        auth.principal.id
      );

      // Re-ingesting identical bytes is a no-op beyond the version lookup.
      if (!version.created) {
        sendJson(res, 200, {
          documentId: version.documentId,
          versionId: version.versionId,
          created: false,
          message: 'Identical content already ingested; no new version created.',
        });
        return;
      }

      const chunks = chunkText(extracted, {
        model: embeddingConfig.model,
        modelVersion: 'v1',
        dimensions: embeddingConfig.dimensions,
        chunker: 'paragraph-aware',
        chunkSize: 800,
        chunkOverlap: 100,
      }).map((c) => ({
        ...c,
        chunkKey: chunkKey(version.versionId, configId, c.chunkIndex),
      }));

      const { vectors } = await embedTexts(embeddingConfig, chunks.map((c) => c.content));
      const written = await dbReplaceChunksAndEmbeddings(
        workspaceId,
        version.versionId,
        configId,
        chunks,
        vectors
      );

      sendJson(res, 201, {
        documentId: version.documentId,
        versionId: version.versionId,
        contentHash: hash,
        chunks: written,
        embedding: { model: embeddingConfig.model, dimensions: embeddingConfig.dimensions },
        created: true,
      });
      return;
    }

    // Query: POST /api/rag/query
    if (pathname === '/api/rag/query' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, query, limit } = parsed;

      if (!workspaceId || !query) {
        sendJson(res, 400, { error: 'workspaceId and query are required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      // Authorize before probing provider configuration: an unauthorized caller
      // must not learn whether embeddings are configured.
      const embeddingConfig = loadEmbeddingConfigFromEnv();
      if (!embeddingConfig) {
        sendJson(res, 503, {
          error: 'EMBEDDING_PROVIDER_NOT_CONFIGURED: set OCTO_EMBEDDING_API_KEY to query documents',
        });
        return;
      }

      const { vectors } = await embedTexts(embeddingConfig, [query]);
      const results = await dbMatchChunks(workspaceId, vectors[0]!, limit ?? 10, 0);

      sendJson(res, 200, {
        query,
        matches: results,
        // Provenance: each match carries the version and the exact embedding/chunker
        // configuration that produced it.
      });
      return;
    }

    // Epistemic ledger: POST /api/epistemic/record -- one append-only write into a
    // workspace's bitemporal knowledge ledger. The `kind` selects which record is
    // being written; each kind validates only its own fields.
    if (pathname === '/api/epistemic/record' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const body = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, kind } = body;

      if (!workspaceId || !kind) {
        sendJson(res, 400, { error: 'workspaceId and kind are required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to record epistemic data' });
        return;
      }

      const createdBy = auth.principal.id;
      const asTimestamp = (value: unknown, field: string): { ok: true; value: string | null } | { ok: false } => {
        if (value === undefined || value === null) return { ok: true, value: null };
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          sendJson(res, 400, { error: `${field} must be an ISO 8601 timestamp` });
          return { ok: false };
        }
        return { ok: true, value };
      };
      const asUuidOrNull = (value: unknown, field: string): { ok: true; value: string | null } | { ok: false } => {
        if (value === undefined || value === null || value === '') return { ok: true, value: null };
        if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
          sendJson(res, 400, { error: `${field} must be a UUID` });
          return { ok: false };
        }
        return { ok: true, value };
      };

      try {
        if (kind === 'entity') {
          const { name, entityType } = body;
          if (typeof name !== 'string' || !name.trim()) {
            sendJson(res, 400, { error: 'name is required to record an entity' });
            return;
          }
          const entity = await dbEnsureEpistemicEntity(
            workspaceId,
            name,
            typeof entityType === 'string' && entityType.trim() ? entityType : 'entity'
          );
          sendJson(res, 201, { kind, entity });
          return;
        }

        if (kind === 'perspective') {
          const { name, description } = body;
          if (typeof name !== 'string' || !name.trim()) {
            sendJson(res, 400, { error: 'name is required to record a perspective' });
            return;
          }
          const perspective = await dbEnsurePerspective(
            workspaceId,
            name,
            typeof description === 'string' ? description : null
          );
          sendJson(res, 201, { kind, perspective });
          return;
        }

        if (kind === 'evidence') {
          const sourceFileId = asUuidOrNull(body.sourceFileId, 'sourceFileId');
          if (!sourceFileId.ok) return;
          const { locator, quote, contentHash } = body;
          if (
            sourceFileId.value === null &&
            !(typeof locator === 'string' && locator.trim()) &&
            !(typeof quote === 'string' && quote.trim()) &&
            !(typeof contentHash === 'string' && contentHash.trim())
          ) {
            sendJson(res, 400, {
              error: 'evidence requires at least one of sourceFileId, locator, quote, or contentHash',
            });
            return;
          }
          const evidence = await dbInsertEvidence({
            workspaceId,
            sourceFileId: sourceFileId.value,
            locator: typeof locator === 'string' ? locator : null,
            quote: typeof quote === 'string' ? quote : null,
            contentHash: typeof contentHash === 'string' ? contentHash : null,
            createdBy,
          });
          sendJson(res, 201, { kind, evidence });
          return;
        }

        if (kind === 'claim') {
          const subjectEntityId = asUuidOrNull(body.subjectEntityId, 'subjectEntityId');
          if (!subjectEntityId.ok) return;
          const supersedesClaimId = asUuidOrNull(body.supersedesClaimId, 'supersedesClaimId');
          if (!supersedesClaimId.ok) return;
          const validFrom = asTimestamp(body.validFrom, 'validFrom');
          if (!validFrom.ok) return;
          const validTo = asTimestamp(body.validTo, 'validTo');
          if (!validTo.ok) return;
          const recordedAt = asTimestamp(body.recordedAt, 'recordedAt');
          if (!recordedAt.ok) return;
          const { statement, provenance } = body;
          if (typeof statement !== 'string' || !statement.trim()) {
            sendJson(res, 400, { error: 'statement is required to record a claim' });
            return;
          }
          if (provenance !== undefined && (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance))) {
            sendJson(res, 400, { error: 'provenance must be a JSON object' });
            return;
          }
          const claim = await dbInsertClaim({
            workspaceId,
            subjectEntityId: subjectEntityId.value,
            statement,
            validFrom: validFrom.value,
            validTo: validTo.value,
            recordedAt: recordedAt.value,
            provenance: (provenance as Record<string, unknown>) ?? {},
            supersedesClaimId: supersedesClaimId.value,
            createdBy,
          });
          sendJson(res, 201, { kind, claim });
          return;
        }

        if (kind === 'belief') {
          const perspectiveId = asUuidOrNull(body.perspectiveId, 'perspectiveId');
          if (!perspectiveId.ok) return;
          const claimId = asUuidOrNull(body.claimId, 'claimId');
          if (!claimId.ok) return;
          const validFrom = asTimestamp(body.validFrom, 'validFrom');
          if (!validFrom.ok) return;
          const validTo = asTimestamp(body.validTo, 'validTo');
          if (!validTo.ok) return;
          const recordedAt = asTimestamp(body.recordedAt, 'recordedAt');
          if (!recordedAt.ok) return;
          const { stance, confidence } = body;
          if (!perspectiveId.value || !claimId.value) {
            sendJson(res, 400, { error: 'perspectiveId and claimId are required to record a belief' });
            return;
          }
          if (!['believes', 'disbelieves', 'uncertain'].includes(stance)) {
            sendJson(res, 400, { error: 'stance must be one of believes, disbelieves, uncertain' });
            return;
          }
          if (confidence !== undefined && confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
            sendJson(res, 400, { error: 'confidence must be a number between 0 and 1' });
            return;
          }
          const belief = await dbInsertBelief({
            workspaceId,
            perspectiveId: perspectiveId.value,
            claimId: claimId.value,
            stance,
            confidence: typeof confidence === 'number' ? confidence : null,
            validFrom: validFrom.value,
            validTo: validTo.value,
            recordedAt: recordedAt.value,
          });
          sendJson(res, 201, { kind, belief });
          return;
        }

        if (kind === 'claim_relation') {
          const fromClaimId = asUuidOrNull(body.fromClaimId, 'fromClaimId');
          if (!fromClaimId.ok) return;
          const toClaimId = asUuidOrNull(body.toClaimId, 'toClaimId');
          if (!toClaimId.ok) return;
          const recordedAt = asTimestamp(body.recordedAt, 'recordedAt');
          if (!recordedAt.ok) return;
          const { relation } = body;
          if (!fromClaimId.value || !toClaimId.value) {
            sendJson(res, 400, { error: 'fromClaimId and toClaimId are required' });
            return;
          }
          const relations = ['SUPPORTS', 'CONTRADICTS', 'SUPERSEDES', 'QUALIFIES', 'DERIVED_FROM', 'DUPLICATES', 'REFINES'];
          if (!relations.includes(relation)) {
            sendJson(res, 400, { error: `relation must be one of ${relations.join(', ')}` });
            return;
          }
          if (fromClaimId.value === toClaimId.value) {
            sendJson(res, 400, { error: 'a claim cannot relate to itself' });
            return;
          }
          const created = await dbInsertClaimRelation({
            workspaceId,
            fromClaimId: fromClaimId.value,
            toClaimId: toClaimId.value,
            relation,
            recordedAt: recordedAt.value,
            createdBy,
          });
          sendJson(res, 201, { kind, claimRelation: created });
          return;
        }

        if (kind === 'claim_evidence') {
          const claimId = asUuidOrNull(body.claimId, 'claimId');
          if (!claimId.ok) return;
          const evidenceId = asUuidOrNull(body.evidenceId, 'evidenceId');
          if (!evidenceId.ok) return;
          const { stance } = body;
          if (!claimId.value || !evidenceId.value) {
            sendJson(res, 400, { error: 'claimId and evidenceId are required' });
            return;
          }
          if (!['supports', 'contradicts', 'qualifies'].includes(stance)) {
            sendJson(res, 400, { error: 'stance must be one of supports, contradicts, qualifies' });
            return;
          }
          const link = await dbInsertClaimEvidence({
            workspaceId,
            claimId: claimId.value,
            evidenceId: evidenceId.value,
            stance,
          });
          sendJson(res, 201, { kind, claimEvidence: link });
          return;
        }

        sendJson(res, 400, {
          error: 'kind must be one of entity, perspective, evidence, claim, belief, claim_relation, claim_evidence',
        });
        return;
      } catch (error) {
        // A foreign key to another workspace's row, or a value the schema rejects,
        // surfaces as a clean 400 rather than a raw 500 with database text.
        const message = error instanceof Error ? error.message : 'record failed';
        sendJson(res, 400, { error: 'EPISTEMIC_RECORD_REJECTED', message });
        return;
      }
    }

    // Epistemic ledger: GET /api/epistemic/claims-as-of -- query mode 2. With
    // current knowledge, which claims do we now consider valid at a world instant?
    if (pathname === '/api/epistemic/claims-as-of' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId') ?? '';
      const asOfRecorded = url.searchParams.get('asOfRecorded') ?? '';
      const asOfValid = url.searchParams.get('asOfValid');

      if (!workspaceId || !asOfRecorded) {
        sendJson(res, 400, { error: 'workspaceId and asOfRecorded are required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (Number.isNaN(Date.parse(asOfRecorded))) {
        sendJson(res, 400, { error: 'asOfRecorded must be an ISO 8601 timestamp' });
        return;
      }
      if (asOfValid !== null && Number.isNaN(Date.parse(asOfValid))) {
        sendJson(res, 400, { error: 'asOfValid must be an ISO 8601 timestamp' });
        return;
      }

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      const claims = await dbClaimsAsOf(workspaceId, asOfRecorded, asOfValid ?? null);
      sendJson(res, 200, { asOfRecorded, asOfValid: asOfValid ?? null, claims });
      return;
    }

    // Epistemic ledger: GET /api/epistemic/belief-as-of -- query mode 1. What did
    // perspective P believe about a claim as of a recorded instant?
    if (pathname === '/api/epistemic/belief-as-of' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId') ?? '';
      const perspectiveId = url.searchParams.get('perspectiveId') ?? '';
      const claimId = url.searchParams.get('claimId') ?? '';
      const asOfRecorded = url.searchParams.get('asOfRecorded') ?? '';
      const asOfValidParam = url.searchParams.get('asOfValid');

      if (!workspaceId || !perspectiveId || !claimId || !asOfRecorded) {
        sendJson(res, 400, {
          error: 'workspaceId, perspectiveId, claimId, and asOfRecorded are required',
        });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;
      if (!requireUuid(res, perspectiveId, 'perspectiveId')) return;
      if (!requireUuid(res, claimId, 'claimId')) return;
      if (Number.isNaN(Date.parse(asOfRecorded))) {
        sendJson(res, 400, { error: 'asOfRecorded must be an ISO 8601 timestamp' });
        return;
      }
      // Valid time defaults to the recorded instant: "what did we believe at T
      // about T". A caller may separate the two axes explicitly.
      const asOfValid = asOfValidParam ?? asOfRecorded;
      if (Number.isNaN(Date.parse(asOfValid))) {
        sendJson(res, 400, { error: 'asOfValid must be an ISO 8601 timestamp' });
        return;
      }

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      const result = await dbBeliefAsOf(workspaceId, perspectiveId, claimId, asOfRecorded, asOfValid);
      sendJson(res, 200, { perspectiveId, claimId, asOfRecorded, asOfValid, ...result });
      return;
    }

    // Graph: POST /api/graph/project -- rebuild one workspace's graph from the
    // canonical epistemic ledger. Destroy-and-rebuild: the graph is a read model, so
    // a rebuild always converges to the same graph for the same canonical rows.
    if (pathname === '/api/graph/project' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'write')) {
        scopeDenied(res, 'write');
        return;
      }

      const body = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId } = body;

      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem || !roleAllows(auth, mem.role, 'operator')) {
        sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to project a graph' });
        return;
      }

      // Authorize before probing provider configuration: an unauthorized caller
      // must not learn whether the graph engine is configured.
      if (!graphClient) {
        sendJson(res, 503, {
          error: 'GRAPH_NOT_CONFIGURED: set OCTO_GRAPH_URL to project a workspace graph',
        });
        return;
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
      return;
    }

    // Graph: GET /api/graph/health -- the projection's watermark and counts, plus
    // whether the graph is stale against the live canonical ledger.
    if (pathname === '/api/graph/health' && req.method === 'GET') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = url.searchParams.get('workspaceId') ?? '';
      if (!workspaceId) {
        sendJson(res, 400, { error: 'workspaceId is required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
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
      return;
    }

    // Graph: POST /api/graph/query -- a mediated read against one workspace's graph.
    if (pathname === '/api/graph/query' && req.method === 'POST') {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { workspaceId, query: cypher, params } = parsed;

      if (!workspaceId || !cypher) {
        sendJson(res, 400, { error: 'workspaceId and query are required' });
        return;
      }
      if (!requireUuid(res, workspaceId, 'workspaceId')) return;

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      // Authorize before probing provider configuration: an unauthorized caller
      // must not learn whether the graph engine is configured.
      if (!graphClient) {
        sendJson(res, 503, {
          error: 'GRAPH_NOT_CONFIGURED: set OCTO_GRAPH_URL to query a workspace graph',
        });
        return;
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
      return;
    }

    // SQL: POST /api/workspaces/:id/query -- run SQL against a workspace's own
    // provisioned database, using only an Octo API key. No connection string, host,
    // or port crosses the wire: the server authenticates as the workspace's own role
    // (src/server/query.ts) and the caller never learns the credential.
    //
    // Read scope is enough for a read-only caller; the server then opens a read-only
    // transaction, so a statement that tries to write fails in Postgres. Write scope
    // is required to mutate. A workspace-scoped key is allowed here -- unlike
    // provisioning, running SQL against your own workspace's database is exactly
    // what a scoped key is for; the key's workspace binding is enforced below.
    if (
      pathname.startsWith('/api/workspaces/') &&
      pathname.endsWith('/query') &&
      req.method === 'POST'
    ) {
      const auth = await authenticateRequest(req);
      if (!auth) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!requireScope(auth, 'read')) {
        scopeDenied(res, 'read');
        return;
      }

      const workspaceId = pathname.slice('/api/workspaces/'.length, -'/query'.length);
      if (!UUID_PATTERN.test(workspaceId)) {
        sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
        return;
      }

      const parsed = (await readJsonObject(req)) as Record<string, any>;
      const { sql, params, rowLimit } = parsed;
      if (typeof sql !== 'string' || !sql.trim()) {
        sendJson(res, 400, { error: 'BAD_REQUEST: sql is required' });
        return;
      }

      if (!keyWorkspaceMatches(auth, workspaceId)) {
        sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
        return;
      }

      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem && !auth.principal.isPlatformOwner) {
        sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
        return;
      }

      const database = await dbGetWorkspaceDatabase(workspaceId);
      if (!database) {
        sendJson(res, 404, {
          error: 'DATABASE_NOT_PROVISIONED: provision a database for this workspace first',
        });
        return;
      }

      // The workspace role's password is stored encrypted. Databases provisioned
      // before this surface existed have none stored -- rotate one now, which is the
      // same role with a fresh credential, and keep it. A credential that cannot be
      // read (or a secret key that is unset) throws and fails the request closed.
      const stored = await dbGetWorkspaceDatabaseCredential(workspaceId);
      let password: string;
      if (stored) {
        password = decryptSecret(stored);
      } else {
        password = await rotateRolePassword(database.roleName);
        await dbSetWorkspaceDatabaseCredential(workspaceId, encryptSecret(password));
      }

      const limit =
        typeof rowLimit === 'number' && Number.isInteger(rowLimit) && rowLimit > 0
          ? Math.min(rowLimit, MAX_ROW_LIMIT)
          : DEFAULT_ROW_LIMIT;

      try {
        const result = await runWorkspaceQuery({
          dbName: database.dbName,
          roleName: database.roleName,
          password,
          sql,
          params: Array.isArray(params) ? params : undefined,
          readOnly: !requireScope(auth, 'write'),
          rowLimit: limit,
          timeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
        });
        sendJson(res, 200, result);
      } catch (err) {
        // A statement the database rejected is the caller's problem, reported with
        // Postgres's own message; anything else is ours and reaches the outer handler.
        if (isSqlError(err)) {
          const pgError = err as { message?: string; code?: string };
          sendJson(res, 400, {
            error: 'SQL_ERROR',
            message: pgError.message,
            code: pgError.code,
          });
          return;
        }
        throw err;
      }
      return;
    }

    // Static asset serving if dist/ directory exists (standalone/production)
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath) && req.method === 'GET') {
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.join(distPath, relPath);
      const normalizedDist = distPath.endsWith(path.sep) ? distPath : distPath + path.sep;
      // Prevent path traversal
      if ((filePath === distPath || filePath.startsWith(normalizedDist)) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.webp': 'image/webp',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
        };
        const contentType = contentTypes[ext] ?? 'application/octet-stream';
        sendStaticFile(res, filePath, contentType);
        return;
      }

      // SPA fallback for HTML navigation requests (excluding /api routes)
      const indexPath = path.join(distPath, 'index.html');
      if (!pathname.startsWith('/api/') && fs.existsSync(indexPath) && (!path.extname(pathname) || req.headers.accept?.includes('text/html'))) {
        sendStaticFile(res, indexPath, 'text/html; charset=utf-8');
        return;
      }
    }

    // 404 for unknown route
    sendJson(res, 404, { error: `Not found: ${req.method} ${pathname}` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await captureOpsEvent(req, url, {
      eventType: 'request.error',
      errorCode: 'INTERNAL_SERVER_ERROR',
      detail: { message, method: req.method, path: pathname },
    });
    sendJson(res, 500, { error: `INTERNAL_SERVER_ERROR: ${message}` });
  }
}

// Every request runs inside a fresh identity holder so concurrent requests can
// never share RLS claims. `authenticateRequest` fills it in; `query()` binds it,
// transaction-scoped, on the fenced app pool.
export const server = createServer((req, res) => {
  void runWithRequestIdentity(() => handleRequest(req, res));
});

// Start listening if run directly. Compare on the basename so the guard holds on
// Windows too, where argv[1] is a backslash path and never matches 'server/index.ts'.
const entryFile = process.argv[1] ? path.basename(process.argv[1]) : '';
if (
  (entryFile === 'index.ts' || entryFile === 'index.js') &&
  path.basename(path.dirname(process.argv[1]!)) === 'server'
) {
  server.listen(PORT, () => {
    console.log(`Octo Platform Server listening on http://localhost:${PORT}`);
    console.log(`- Health: http://localhost:${PORT}/health`);
    console.log(`- Guest Login: POST http://localhost:${PORT}/api/auth/guest`);
    console.log(`- R2 Active Bucket: ${r2Provider ? r2Provider.bucket : 'none'}`);
    // Apply the retention policy once at boot, then on the hourly tick, so a
    // deployment does not wait up to an hour to honour an existing window.
    void runRetentionSweep()
      .then((enqueued) => {
        if (enqueued > 0) console.log(`Retention sweep enqueued ${enqueued} archive job(s)`);
      })
      .catch((err) => console.warn('Retention sweep failed:', err));
    startSchedulers();
  });
}
