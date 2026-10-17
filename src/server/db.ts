/**
 * Octo Database Client (Server Runtime)
 *
 * Connects directly to PostgreSQL canonical tables in the octo schema.
 * Executes all queries against real PostgreSQL tables and SECURITY DEFINER RPCs.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GraphProjectionRow, GraphProjectionRecord } from '../types/graph';
export type { GraphProjectionRow, GraphProjectionRecord } from '../types/graph';
const { Pool } = pg;

/**
 * Two database roles, two pools (Slice 14 — key-scope isolation fence):
 *
 * - `appPool`  connects as `octo_app` (a non-superuser, non-owner role). Because it
 *   is neither, Row-Level Security applies to it: the fence policies narrow every
 *   request to the workspace its credential is scoped to. This is the pool the
 *   authenticated data path runs on.
 * - `servicePool` connects as `octo_service` (BYPASSRLS). It is the small trusted
 *   surface that runs with no caller identity: login / bootstrap, the job worker,
 *   the archive lifecycle, and the server-owned control writes (jobs/activity)
 *   that intentionally have no client-side policy. Importing it is the grep-able
 *   boundary for "this code holds bypass authority."
 *
 * If neither OCTO_DB_URL nor OCTO_SERVICE_URL is set, both fall back to
 * DATABASE_URL, preserving the single-superuser connection used by local dev and
 * CI until the scoped roles are provisioned.
 */
export interface DbConfig {
  connectionString: string;
}

const legacyUrl =
  process.env['DATABASE_URL'] ??
  process.env['POSTGRES_URL'] ??
  process.env['SUPABASE_DB_URL'] ??
  'postgresql://postgres:postgres@localhost:54329/postgres';

// `||` (not `??`) so an empty value in a copied .env falls back rather than
// producing an empty connection string.
const appUrl = process.env['OCTO_DB_URL'] || legacyUrl;
const serviceUrl = process.env['OCTO_SERVICE_URL'] || legacyUrl;

export const dbPool = new Pool({
  connectionString: appUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const servicePool = new Pool({
  connectionString: serviceUrl,
  max: 6,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// An idle pooled client can error (server restart, network reset, admin
// termination). Without a listener Node rethrows that 'error' event as an
// uncaught exception and the single-process host exits, so log and continue:
// the pool discards the broken client and the next query dials a fresh one.
dbPool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});
servicePool.on('error', (err) => {
  console.error('[db] idle service client error:', err.message);
});

/**
 * The caller identity for the current request, populated by `authenticateRequest`
 * and read by `query()` to set the RLS claims. `runWithRequestIdentity()` seeds it
 * at the top of every request so each concurrent request carries its own object.
 *
 * `principalId` is bound directly (not derived from an auth-user lookup) so the
 * fence helpers resolve the exact caller even for a request whose first fenced read
 * would otherwise have to query `principals` — the chicken/egg the auth-bootstrap
 * readers used to hit before their identity existed.
 */
export interface RequestIdentity {
  principalId: string;
  workspaceId: string | null;
}
export const requestIdentity = new AsyncLocalStorage<RequestIdentity>();

/**
 * Binds the caller's principal id and, for a workspace-scoped key, its workspace
 * scope inside the current transaction via `set_config(..., is_local => true)`.
 * `is_local` guarantees both GUCs are discarded at COMMIT/ROLLBACK, so identity can
 * never survive on a client returned to the pool and be seen by the next caller —
 * the exact cross-tenant leak this guards. `octo.principal_id` is what the fence
 * helpers read; `request.workspace_id` is the key's scope (empty = unscoped).
 */
async function bindIdentity(client: pg.Client, id: RequestIdentity | undefined): Promise<void> {
  // Bind only once authentication has resolved a principal. An app-pool query that
  // runs before that leaves the claims unset, so RLS evaluates current_principal_id()
  // as NULL and fails closed — pre-identity reads must use queryService, never the
  // app pool.
  if (!id || !id.principalId) return;
  await client.query('SELECT set_config(\'octo.principal_id\', $1, true)', [id.principalId]);
  await client.query('SELECT set_config(\'request.workspace_id\', $1, true)', [id.workspaceId ?? '']);
}

/**
 * Fills in the current request's identity holder after authentication resolves.
 * The dispatcher seeds an empty holder at the top of every request; the store
 * object is mutated here so that every later `query()` on the app pool binds these
 * claims inside its own transaction. `workspaceId` is the *key's* scope (NULL for
 * an account-wide key or human session), which is what the fence restricts to.
 */
export function bindRequestIdentity(principalId: string, workspaceId: string | null): void {
  const id = requestIdentity.getStore();
  if (id) {
    id.principalId = principalId;
    id.workspaceId = workspaceId;
  }
}

/**
 * Runs `fn` with a fresh, empty identity holder bound to the async context, so
 * concurrent requests never share claims. Callers fill it via `bindRequestIdentity`
 * once authenticated. Without a wrapper, `query()` sees no store and binds nothing.
 */
export function runWithRequestIdentity<T>(fn: () => Promise<T>): Promise<T> {
  return requestIdentity.run({ principalId: '', workspaceId: null }, fn);
}

/**
 * Runs a single statement on the app pool, fenced. When a request identity is in
 * scope it is bound inside a transaction (BEGIN + COMMIT/ROLLBACK) so RLS sees it
 * and it cannot leak past this call. Pre-identity code that must run fenced passes
 * through here only after `authenticateRequest` has populated the store.
 */
export async function query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const id = requestIdentity.getStore();
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    if (id) await bindIdentity(client, id);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs a single statement on the service pool (BYPASSRLS, no identity binding).
 * Reserved for login / bootstrap, the job worker, the archive lifecycle, and the
 * server-owned jobs/activity control writes — the surface that runs with no caller
 * principal and must therefore not be fenced.
 */
export async function queryService<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = await servicePool.connect();
  try {
    const res = await client.query(text, params);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a single transaction on one pooled client. Commits on success,
 * rolls back on any throw, and always releases the client. Multi-write invariants
 * (workspace + owner membership + key) must use this rather than separate `query`
 * calls, which each check out their own connection and cannot roll back together.
 *
 * `pool` defaults to the app pool (identity bound at BEGIN). Control-plane and
 * bootstrap transactions pass `servicePool` and are not fenced.
 */
export async function withTransaction<T>(
  fn: (client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>,
  pool: pg.Pool = dbPool
): Promise<T> {
  const id = pool === dbPool ? requestIdentity.getStore() : undefined;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (id) await bindIdentity(client, id);
    const result = await fn({
      query: async (text: string, params: unknown[] = []) => {
        const res = await client.query(text, params);
        return { rows: res.rows as unknown[] };
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function testDbConnection(): Promise<{ connected: boolean; version?: string; error?: string }> {
  try {
    const rows = await query<{ version: string }>('SELECT version()');
    return { connected: true, version: rows[0]?.version };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { connected: false, error: message };
  }
}

// 1. Principals & Workspaces Operations
export async function dbInsertGuestPrincipal(
  id: string,
  authUserId: string,
  email: string,
  displayName: string
): Promise<{ id: string; email: string; displayName: string; isGuest: boolean }> {
  const sql = `
    INSERT INTO octo.principals (id, auth_user_id, email, display_name, is_guest, is_platform_owner)
    VALUES ($1, $2, $3, $4, true, false)
    ON CONFLICT (auth_user_id) DO UPDATE SET updated_at = now()
    RETURNING id, email, display_name AS "displayName", is_guest AS "isGuest";
  `;
  const rows = await queryService<{ id: string; email: string; displayName: string; isGuest: boolean }>(sql, [
    id,
    authUserId,
    email,
    displayName,
  ]);
  return rows[0]!;
}

export async function dbUpsertGooglePrincipal(
  authUserId: string,
  email: string,
  displayName: string | null,
  avatarUrl: string | null
): Promise<{
  id: string;
  authUserId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  isGuest: boolean;
  isPlatformOwner: boolean;
}> {
  const ownerEmail = process.env['PLATFORM_OWNER_EMAIL'];
  const isOwner = Boolean(ownerEmail) && email.toLowerCase() === ownerEmail!.toLowerCase();
  const sql = `
    INSERT INTO octo.principals (id, auth_user_id, email, display_name, avatar_url, is_guest, is_platform_owner)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, false, $5)
    ON CONFLICT (auth_user_id) DO UPDATE SET
      email = EXCLUDED.email,
      display_name = COALESCE(EXCLUDED.display_name, octo.principals.display_name),
      avatar_url = COALESCE(EXCLUDED.avatar_url, octo.principals.avatar_url),
      is_platform_owner = octo.principals.is_platform_owner OR EXCLUDED.is_platform_owner,
      is_guest = false,
      updated_at = now()
    RETURNING id, auth_user_id AS "authUserId", email, display_name AS "displayName", avatar_url AS "avatarUrl", is_guest AS "isGuest", is_platform_owner AS "isPlatformOwner";
  `;
  const rows = await queryService<{
    id: string;
    authUserId: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    isGuest: boolean;
    isPlatformOwner: boolean;
  }>(sql, [authUserId, email, displayName, avatarUrl, isOwner]);
  return rows[0]!;
}

export async function dbInsertWorkspace(
  id: string,
  slug: string,
  name: string,
  description: string,
  createdBy: string
): Promise<{ id: string; slug: string; name: string; description: string }> {
  // This path only ever provisions the sandbox a principal is handed at sign-in,
  // so it is marked auto_provisioned: it must not count against the Slice 16
  // daily creation limit, which bounds deliberate POST /api/workspaces creates.
  const sql = `
    INSERT INTO octo.workspaces (id, slug, name, description, created_by, auto_provisioned)
    VALUES ($1, $2, $3, $4, $5, true)
    ON CONFLICT (slug) DO UPDATE SET updated_at = now()
    RETURNING id, slug, name, description;
  `;
  const rows = await queryService<{ id: string; slug: string; name: string; description: string }>(sql, [
    id,
    slug,
    name,
    description,
    createdBy,
  ]);
  return rows[0]!;
}

export async function dbInsertMembership(
  workspaceId: string,
  principalId: string,
  role: string
): Promise<void> {
  const sql = `
    INSERT INTO octo.workspace_memberships (workspace_id, principal_id, role)
    VALUES ($1, $2, $3)
    ON CONFLICT (workspace_id, principal_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now();
  `;
  await queryService(sql, [workspaceId, principalId, role]);
}

export async function dbGetAuthorizedWorkspaces(principalId: string): Promise<
  {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    role: string;
    isOwner: boolean;
    retentionDays: number | null;
  }[]
> {
  // Authorization bootstrap: this runs the owner's cross-workspace bypass and a
  // principal's own membership join. Both read `principals`/`workspace_memberships`
  // by an explicit principal id that is not necessarily the bound RLS identity (the
  // OAuth callback and signed-media paths call it before any identity is bound), so
  // it runs on the trusted service pool. Route-level `requireScope`/`keyWorkspaceMatches`
  // remain the authority; the fence still guards every user-data read downstream.
  const pRows = await queryService<{ is_platform_owner: boolean }>(
    'SELECT is_platform_owner FROM octo.principals WHERE id = $1',
    [principalId]
  );
  if (pRows[0]?.is_platform_owner) {
    const sql = `
      SELECT
        w.id,
        w.slug,
        w.name,
        w.description,
        'owner' AS role,
        true AS "isOwner",
        w.retention_days AS "retentionDays"
      FROM octo.workspaces w
      ORDER BY w.name ASC;
    `;
    return queryService(sql, []);
  }
  const sql = `
    SELECT
      w.id,
      w.slug,
      w.name,
      w.description,
      m.role,
      (m.role = 'owner') AS "isOwner",
      w.retention_days AS "retentionDays"
    FROM octo.workspaces w
    JOIN octo.workspace_memberships m ON m.workspace_id = w.id
    WHERE m.principal_id = $1
    ORDER BY w.name ASC;
  `;
  return queryService(sql, [principalId]);
}

export async function dbGetWorkspaceMembership(
  workspaceId: string,
  principalId: string
): Promise<{ role: string } | null> {
  // Same bootstrap reason as dbGetAuthorizedWorkspaces: the worker and signed-media
  // paths resolve membership for a principal id with no bound RLS identity, so this
  // must not depend on the fence. It is a read only; it grants no bypass.
  const pRows = await queryService<{ is_platform_owner: boolean }>(
    'SELECT is_platform_owner FROM octo.principals WHERE id = $1',
    [principalId]
  );
  if (pRows[0]?.is_platform_owner) {
    return { role: 'owner' };
  }
  const sql = `
    SELECT role
    FROM octo.workspace_memberships
    WHERE workspace_id = $1 AND principal_id = $2
    LIMIT 1;
  `;
  const rows = await queryService<{ role: string }>(sql, [workspaceId, principalId]);
  return rows[0] ?? null;
}

// 2. File Catalog Operations
export async function dbInsertFile(
  id: string,
  workspaceId: string,
  createdBy: string,
  name: string,
  mimeType: string,
  sizeBytes: number,
  storageKey: string,
  contentHash: string | null = null
): Promise<{ id: string; name: string; sizeBytes: number; mimeType: string; storageKey: string }> {
  const sql = `
    INSERT INTO octo.files (id, workspace_id, created_by, name, mime_type, size_bytes, provider, storage_key, status, content_hash)
    VALUES ($1, $2, $3, $4, $5, $6, 'r2', $7, 'active', $8)
    RETURNING id, name, size_bytes::double precision AS "sizeBytes", mime_type AS "mimeType", storage_key AS "storageKey";
  `;
  const rows = await query<{ id: string; name: string; sizeBytes: number; mimeType: string; storageKey: string }>(
    sql,
    [id, workspaceId, createdBy, name, mimeType, sizeBytes, storageKey, contentHash]
  );
  return rows[0]!;
}

export async function dbListWorkspaceFiles(workspaceId: string): Promise<
  {
    id: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    storageKey: string;
    createdAt: string;
    archiveState: string;
    publishedAt: string | null;
  }[]
> {
  const sql = `
    SELECT id, name, size_bytes::double precision AS "sizeBytes", mime_type AS "mimeType",
           storage_key AS "storageKey", created_at AS "createdAt",
           archive_state AS "archiveState", published_at AS "publishedAt"
    FROM octo.files
    WHERE workspace_id = $1 AND status = 'active'
    ORDER BY created_at DESC;
  `;
  return query(sql, [workspaceId]);
}

export async function dbGetFile(
  workspaceId: string,
  fileId: string
): Promise<{
  id: string;
  name: string;
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  archiveState: string;
  archiveLocator: string | null;
  archiveHash: string | null;
  publishedAt: string | null;
  publicKey: string | null;
} | null> {
  const sql = `
    SELECT id, name, storage_key AS "storageKey", size_bytes::double precision AS "sizeBytes",
           mime_type AS "mimeType", archive_state AS "archiveState",
           archive_locator AS "archiveLocator", archive_hash AS "archiveHash",
           published_at AS "publishedAt", public_key AS "publicKey"
    FROM octo.files
    WHERE id = $1 AND workspace_id = $2 AND status = 'active'
    LIMIT 1;
  `;
  const rows = await query<{
    id: string;
    name: string;
    storageKey: string;
    sizeBytes: number;
    mimeType: string;
    archiveState: string;
    archiveLocator: string | null;
    archiveHash: string | null;
    publishedAt: string | null;
    publicKey: string | null;
  }>(sql, [fileId, workspaceId]);
  return rows[0] ?? null;
}

/**
 * Loads the record the archive/restore lifecycle needs. Distinct from dbGetFile
 * because it also serves files whose active bytes were pruned after archiving.
 */
export async function dbGetArchiveRecord(
  workspaceId: string,
  fileId: string
): Promise<{
  fileId: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  storageKey: string;
  archiveState: string;
  archiveLocator: string | null;
  archiveHash: string | null;
} | null> {
  const sql = `
    SELECT id AS "fileId", workspace_id AS "workspaceId", name,
           mime_type AS "mimeType", storage_key AS "storageKey",
           archive_state AS "archiveState", archive_locator AS "archiveLocator",
           archive_hash AS "archiveHash"
    FROM octo.files
    WHERE id = $1 AND workspace_id = $2 AND status = 'active'
    LIMIT 1;
  `;
  const rows = await queryService<{
    fileId: string;
    workspaceId: string;
    name: string;
    mimeType: string;
    storageKey: string;
    archiveState: string;
    archiveLocator: string | null;
    archiveHash: string | null;
  }>(sql, [fileId, workspaceId]);
  return rows[0] ?? null;
}

/** Persists a lifecycle transition. Only the supplied columns are written. */
export async function dbUpdateArchiveState(
  fileId: string,
  patch: {
    archiveState?: string;
    archiveProvider?: string | null;
    archiveLocator?: string | null;
    archiveHash?: string | null;
    archivedAt?: string | null;
    lastVerifiedAt?: string | null;
  }
): Promise<void> {
  const columns: Record<string, string> = {
    archiveState: 'archive_state',
    archiveProvider: 'archive_provider',
    archiveLocator: 'archive_locator',
    archiveHash: 'archive_hash',
    archivedAt: 'archived_at',
    lastVerifiedAt: 'last_verified_at',
  };

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) {
      params.push((patch as Record<string, unknown>)[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }

  if (sets.length === 0) return;
  params.push(fileId);
  const updated = await queryService<{ id: string }>(
    `UPDATE octo.files SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (updated.length === 0) {
    throw new Error(`File ${fileId} no longer exists`);
  }
}

type FileDeleteClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

type LockedFileRow = {
  id: string;
  storageKey: string;
  archiveState: string;
  publicKey: string | null;
};

async function lockIdleFile(
  client: FileDeleteClient,
  workspaceId: string,
  fileId: string
): Promise<{ status: 'missing' } | { status: 'busy' } | { status: 'ready'; row: LockedFileRow }> {
  const files = await client.query(
    `SELECT id, storage_key AS "storageKey", archive_state AS "archiveState",
            public_key AS "publicKey"
     FROM octo.files WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [fileId, workspaceId]
  );
  const file = files.rows[0] as LockedFileRow | undefined;
  if (!file) return { status: 'missing' };

  // No FOR UPDATE here: octo.jobs carries only a SELECT policy, so a locking read
  // returns zero rows for the non-owner app role and the busy check silently passes.
  // Serialization against enqueue does not need it — the file row lock above is the
  // gate, and dbEnqueueFileTransition (service pool) also locks the file row.
  const transitions = await client.query(
    `SELECT id FROM octo.jobs
     WHERE workspace_id = $1 AND job_type IN ('archive_file', 'restore_file')
       AND payload->>'fileId' = $2 AND state IN ('queued', 'running')`,
    [workspaceId, fileId]
  );
  if (
    transitions.rows.length > 0 ||
    file.archiveState === 'archiving' ||
    file.archiveState === 'restoring'
  ) {
    return { status: 'busy' };
  }
  return { status: 'ready', row: file };
}

/**
 * Deletes a file only when no archive/restore transition is queued or running.
 * A published file is not removed here: the caller deletes the public object
 * first, then calls `dbFinishFileDelete`, so a failed public delete leaves the row.
 */
export async function dbDeleteFileIfIdle(
  workspaceId: string,
  fileId: string
): Promise<
  | { status: 'deleted'; storageKey: string; publicKey: null }
  | { status: 'awaiting_public_delete'; storageKey: string; publicKey: string }
  | { status: 'missing' }
  | { status: 'busy' }
> {
  return withTransaction(async (client) => {
    const locked = await lockIdleFile(client, workspaceId, fileId);
    if (locked.status !== 'ready') return locked;
    if (locked.row.publicKey) {
      return {
        status: 'awaiting_public_delete' as const,
        storageKey: locked.row.storageKey,
        publicKey: locked.row.publicKey,
      };
    }

    const deleted = await client.query(
      `DELETE FROM octo.files WHERE id = $1 AND workspace_id = $2
       RETURNING storage_key AS "storageKey"`,
      [fileId, workspaceId]
    );
    const row = deleted.rows[0] as { storageKey: string } | undefined;
    return row
      ? { status: 'deleted' as const, storageKey: row.storageKey, publicKey: null }
      : { status: 'missing' as const };
  });
}

/** Removes a file row after its public object has already been deleted. */
export async function dbFinishFileDelete(
  workspaceId: string,
  fileId: string
): Promise<{ status: 'deleted'; storageKey: string } | { status: 'missing' } | { status: 'busy' }> {
  return withTransaction(async (client) => {
    const locked = await lockIdleFile(client, workspaceId, fileId);
    if (locked.status !== 'ready') return locked;
    const deleted = await client.query(
      `DELETE FROM octo.files WHERE id = $1 AND workspace_id = $2
       RETURNING storage_key AS "storageKey"`,
      [fileId, workspaceId]
    );
    const row = deleted.rows[0] as { storageKey: string } | undefined;
    return row ? { status: 'deleted', storageKey: row.storageKey } : { status: 'missing' };
  });
}

/**
 * Records a publish. The service connection is required because operators are
 * not owner/admin, and the files update policy would change zero rows for them.
 * The WHERE clause still demands the file be active in this workspace.
 */
export async function dbMarkFilePublished(
  fileId: string,
  workspaceId: string,
  publicKey: string
): Promise<string | null> {
  const rows = await queryService<{ publishedAt: Date | string }>(
    `UPDATE octo.files
     SET published_at = now(), public_key = $3, updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND status = 'active' AND archive_state = 'active_r2'
     RETURNING published_at AS "publishedAt"`,
    [fileId, workspaceId, publicKey]
  );
  const value = rows[0]?.publishedAt;
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function dbClearFilePublished(fileId: string, workspaceId: string): Promise<void> {
  await queryService(
    `UPDATE octo.files
     SET published_at = NULL, public_key = NULL, updated_at = now()
     WHERE id = $1 AND workspace_id = $2`,
    [fileId, workspaceId]
  );
}

/** Public-route lookup. Returns no workspace id, storage key, or file name. */
export async function dbGetPublishedObject(
  fileId: string
): Promise<{ mimeType: string; publicKey: string } | null> {
  const rows = await queryService<{ mimeType: string; publicKey: string }>(
    `SELECT mime_type AS "mimeType", public_key AS "publicKey"
     FROM octo.files
     WHERE id = $1 AND status = 'active'
       AND published_at IS NOT NULL AND public_key IS NOT NULL
     LIMIT 1`,
    [fileId]
  );
  return rows[0] ?? null;
}

// 3. API Key Operations
export async function dbInsertApiKey(
  id: string,
  keyHash: string,
  prefix: string,
  name: string,
  principalId: string,
  workspaceId: string | null,
  role: string | null,
  scopes: string[],
  expiresAt: string | null = null
): Promise<void> {
  const sql = `
    INSERT INTO octo.api_keys (id, key_hash, prefix, name, principal_id, workspace_id, role, scopes, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
  `;
  await query(sql, [id, keyHash, prefix, name, principalId, workspaceId, role, scopes, expiresAt]);
}

/** Replaces the allowances on a key the principal owns. The secret stays. */
export async function dbUpdateApiKeyScopes(
  id: string,
  principalId: string,
  scopes: string[]
): Promise<{
  id: string;
  prefix: string;
  name: string;
  workspaceId: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
} | null> {
  const rows = await query<{
    id: string;
    prefix: string;
    name: string;
    workspaceId: string | null;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }>(
    `UPDATE octo.api_keys
     SET scopes = $3
     WHERE id = $1 AND principal_id = $2
     RETURNING id, prefix, name, workspace_id AS "workspaceId", scopes,
               expires_at AS "expiresAt", last_used_at AS "lastUsedAt", created_at AS "createdAt"`,
    [id, principalId, scopes]
  );
  return rows[0] ?? null;
}

export async function dbVerifyApiKey(keyHash: string): Promise<{
  keyId: string;
  prefix: string;
  keyName: string;
  principalId: string;
  workspaceId: string | null;
  role: string | null;
  scopes: string[];
} | null> {
  // Uses SECURITY DEFINER function from migration!
  const sql = `
    SELECT 
      key_id AS "keyId",
      prefix,
      key_name AS "keyName",
      principal_id AS "principalId",
      workspace_id AS "workspaceId",
      role,
      scopes
    FROM octo.verify_api_key($1);
  `;
  const rows = await queryService<{
    keyId: string;
    prefix: string;
    keyName: string;
    principalId: string;
    workspaceId: string | null;
    role: string | null;
    scopes: string[];
  }>(sql, [keyHash]);
  return rows[0] ?? null;
}

export async function dbListApiKeys(
  principalId: string,
  workspaceId?: string
): Promise<
  {
    id: string;
    prefix: string;
    name: string;
    workspaceId: string | null;
    workspaceName: string | null;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }[]
> {
  const sql = `
    SELECT k.id, k.prefix, k.name, k.workspace_id AS "workspaceId", w.name AS "workspaceName",
           k.scopes, k.expires_at AS "expiresAt", k.last_used_at AS "lastUsedAt", k.created_at AS "createdAt"
    FROM octo.api_keys k
    LEFT JOIN octo.workspaces w ON w.id = k.workspace_id
    WHERE k.principal_id = $1 AND (k.workspace_id IS NULL${workspaceId ? ' OR k.workspace_id = $2' : ''})
    ORDER BY k.created_at DESC;
  `;
  return query(sql, workspaceId ? [principalId, workspaceId] : [principalId]);
}

// 4. Scoped Share Operations (Slice 4)
export interface DbShareRow {
  id: string;
  workspaceId: string;
  resourceType: string;
  resourceId: string | null;
  tokenPrefix: string;
  permission: string;
  validFrom: string;
  validUntil: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
}

export async function dbInsertShare(
  id: string,
  workspaceId: string,
  resourceType: string,
  resourceId: string | null,
  tokenHash: string,
  tokenPrefix: string,
  permission: string,
  validUntil: string | null,
  createdBy: string
): Promise<DbShareRow> {
  const sql = `
    INSERT INTO octo.shares
      (id, workspace_id, resource_type, resource_id, token_hash, token_prefix, permission, valid_until, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING
      id, workspace_id AS "workspaceId", resource_type AS "resourceType", resource_id AS "resourceId",
      token_prefix AS "tokenPrefix", permission, valid_from AS "validFrom", valid_until AS "validUntil",
      revoked_at AS "revokedAt", created_at AS "createdAt",
      last_accessed_at AS "lastAccessedAt", access_count AS "accessCount";
  `;
  const rows = await query<DbShareRow>(sql, [
    id,
    workspaceId,
    resourceType,
    resourceId,
    tokenHash,
    tokenPrefix,
    permission,
    validUntil,
    createdBy,
  ]);
  return rows[0]!;
}

/**
 * Resolves an active share by token hash through the SECURITY DEFINER function.
 * Anonymous callers have no session, so this must not rely on RLS.
 */
export async function dbResolveShareByTokenHash(tokenHash: string): Promise<{
  shareId: string;
  workspaceId: string;
  resourceType: string;
  resourceId: string | null;
  permission: string;
  validUntil: string | null;
  createdBy: string;
} | null> {
  const sql = `
    SELECT s.id AS "shareId", s.workspace_id AS "workspaceId", s.resource_type AS "resourceType",
           s.resource_id AS "resourceId", s.permission, s.valid_until AS "validUntil",
           s.created_by AS "createdBy"
    FROM octo.resolve_share($1) r
    JOIN octo.shares s ON s.id = r.share_id;
  `;
  const rows = await queryService<{
    shareId: string;
    workspaceId: string;
    resourceType: string;
    resourceId: string | null;
    permission: string;
    validUntil: string | null;
    createdBy: string;
  }>(sql, [tokenHash]);
  return rows[0] ?? null;
}

/**
 * Re-checks that a share referenced by a signed media URL is still active. Like the
 * token resolver, this runs before any principal identity exists (a media token
 * carries a share id, not a caller), so it reads through the service pool.
 */
export async function dbResolveShareById(shareId: string): Promise<{
  workspaceId: string;
  createdBy: string;
  validUntil: string | null;
} | null> {
  const sql = `
    SELECT workspace_id AS "workspaceId", created_by AS "createdBy", valid_until AS "validUntil"
    FROM octo.shares
    WHERE id = $1
      AND revoked_at IS NULL
      AND valid_from <= now()
      AND (valid_until IS NULL OR valid_until > now())
    LIMIT 1;
  `;
  const rows = await queryService<{ workspaceId: string; createdBy: string; validUntil: string | null }>(sql, [shareId]);
  return rows[0] ?? null;
}

export async function dbListShares(workspaceId: string): Promise<DbShareRow[]> {
  const sql = `
    SELECT
      id, workspace_id AS "workspaceId", resource_type AS "resourceType", resource_id AS "resourceId",
      token_prefix AS "tokenPrefix", permission, valid_from AS "validFrom", valid_until AS "validUntil",
      revoked_at AS "revokedAt", created_at AS "createdAt",
      last_accessed_at AS "lastAccessedAt", access_count AS "accessCount"
    FROM octo.shares
    WHERE workspace_id = $1
    ORDER BY created_at DESC;
  `;
  return query<DbShareRow>(sql, [workspaceId]);
}

/** Revokes a share. Returns the workspace id, or null when no such share exists. */
export async function dbRevokeShare(shareId: string): Promise<{ workspaceId: string } | null> {
  const sql = `
    UPDATE octo.shares
    SET revoked_at = now()
    WHERE id = $1 AND revoked_at IS NULL
    RETURNING workspace_id AS "workspaceId";
  `;
  const rows = await query<{ workspaceId: string }>(sql, [shareId]);
  return rows[0] ?? null;
}

// 5. Job Operations (Slice 6)
export interface DbJobRow {
  id: string;
  workspaceId: string;
  jobType: string;
  state: string;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorSummary: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const JOB_COLUMNS = `
  id, workspace_id AS "workspaceId", job_type AS "jobType", state,
  idempotency_key AS "idempotencyKey", attempt, max_attempts AS "maxAttempts",
  available_at AS "availableAt", lease_expires_at AS "leaseExpiresAt",
  payload, result, error_code AS "errorCode", error_summary AS "errorSummary",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"
`;

/**
 * Enqueues a job. A repeat with the same workspace, type, and idempotency key
 * returns the existing job rather than creating a second logical unit.
 */
export async function dbEnqueueJob(
  id: string,
  workspaceId: string,
  jobType: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  createdBy: string | null,
  maxAttempts = 3
): Promise<{ job: DbJobRow; created: boolean }> {
  const insertSql = `
    INSERT INTO octo.jobs
      (id, workspace_id, job_type, idempotency_key, payload, created_by, max_attempts)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (workspace_id, job_type, idempotency_key) DO NOTHING
    RETURNING ${JOB_COLUMNS};
  `;
  const inserted = await queryService<DbJobRow>(insertSql, [
    id,
    workspaceId,
    jobType,
    idempotencyKey,
    JSON.stringify(payload),
    createdBy,
    maxAttempts,
  ]);

  if (inserted[0]) {
    return { job: inserted[0], created: true };
  }

  const existing = await queryService<DbJobRow>(
    `SELECT ${JOB_COLUMNS} FROM octo.jobs
     WHERE workspace_id = $1 AND job_type = $2 AND idempotency_key = $3`,
    [workspaceId, jobType, idempotencyKey]
  );
  return { job: existing[0]!, created: false };
}

/** Queues one archive/restore transition while serialized with file deletion. */
export async function dbEnqueueFileTransition(
  id: string,
  workspaceId: string,
  direction: 'archive' | 'restore',
  idempotencyPrefix: string,
  payload: Record<string, unknown>,
  createdBy: string | null
): Promise<
  | { status: 'missing' }
  | { status: 'busy' }
  | { status: 'queued'; job: DbJobRow; created: boolean }
> {
  const fileId = String(payload['fileId'] ?? '');
  const jobType = direction === 'archive' ? 'archive_file' : 'restore_file';

  // Server-owned job transition, trusted/internal callers only. It INSERTs into
  // octo.jobs (which intentionally has no client-side write policy) and reads
  // octo.files without the RLS fence, so it runs on the service pool like every
  // other jobs/activity write. Every caller must have already performed a fenced,
  // scope-bound read of the same file on the app pool — the archive/restore route
  // does this via dbGetFile immediately before enqueueing — so a workspace-scoped
  // key naming another workspace is refused before reaching here. Do not expose
  // this as a client-facing operation. The `FOR UPDATE` row lock is load-bearing:
  // it serializes this transition against dbDeleteFileIfIdle.
  return withTransaction(async (client) => {
    const files = await client.query(
      `SELECT id, archive_state AS "archiveState" FROM octo.files
       WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [fileId, workspaceId]
    );
    const file = files.rows[0] as { id: string; archiveState: string } | undefined;
    if (!file) return { status: 'missing' };

    const open = await client.query(
      `SELECT ${JOB_COLUMNS} FROM octo.jobs
       WHERE workspace_id = $1 AND job_type IN ('archive_file', 'restore_file')
         AND payload->>'fileId' = $2 AND state IN ('queued', 'running')
       ORDER BY created_at DESC FOR UPDATE`,
      [workspaceId, fileId]
    );
    const activeJob = open.rows[0] as DbJobRow | undefined;
    if (activeJob) {
      return activeJob.jobType === jobType
        ? { status: 'queued', job: activeJob, created: false }
        : { status: 'busy' };
    }
    if (file.archiveState === 'archiving' || file.archiveState === 'restoring') {
      return { status: 'busy' };
    }

    const count = await client.query(
      `SELECT count(*)::int AS count FROM octo.jobs
       WHERE workspace_id = $1 AND job_type = $2 AND payload->>'fileId' = $3`,
      [workspaceId, jobType, fileId]
    );
    const cycle = Number((count.rows[0] as { count: number } | undefined)?.count ?? 0);
    const inserted = await client.query(
      `INSERT INTO octo.jobs
         (id, workspace_id, job_type, idempotency_key, payload, created_by, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, 3)
       ON CONFLICT (workspace_id, job_type, idempotency_key) DO NOTHING
       RETURNING ${JOB_COLUMNS}`,
      [id, workspaceId, jobType, `${idempotencyPrefix}:${cycle}`, JSON.stringify(payload), createdBy]
    );
    if (inserted.rows[0]) {
      return { status: 'queued', job: inserted.rows[0] as DbJobRow, created: true };
    }

    const existing = await client.query(
      `SELECT ${JOB_COLUMNS} FROM octo.jobs
       WHERE workspace_id = $1 AND job_type = $2 AND idempotency_key = $3`,
      [workspaceId, jobType, `${idempotencyPrefix}:${cycle}`]
    );
    return { status: 'queued', job: existing.rows[0] as DbJobRow, created: false };
  }, servicePool);
}
/** Requeues a failed transition while its file is idle (or already gone). */
export async function dbRetryJob(
  jobId: string,
  workspaceId: string
): Promise<'requeued' | 'busy' | 'not_retryable'> {
  return withTransaction(async (client) => {
    const jobs = await client.query(
      `SELECT id, job_type AS "jobType", state, payload FROM octo.jobs
       WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [jobId, workspaceId]
    );
    const job = jobs.rows[0] as {
      id: string;
      jobType: string;
      state: string;
      payload: Record<string, unknown>;
    } | undefined;
    if (!job || job.state !== 'failed') return 'not_retryable';

    if (job.jobType === 'archive_file' || job.jobType === 'restore_file') {
      const fileId = typeof job.payload?.['fileId'] === 'string' ? job.payload['fileId'] : '';
      const files = await client.query(
        `SELECT id, archive_state AS "archiveState" FROM octo.files
         WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [fileId, workspaceId]
      );
      const file = files.rows[0] as { id: string; archiveState: string } | undefined;

      // A deleted file makes the transition moot. Requeue it so the worker can
      // resolve it as a no-op rather than stranding a failure the owner cannot clear.
      if (file) {
        const open = await client.query(
          `SELECT id FROM octo.jobs
           WHERE workspace_id = $1 AND job_type IN ('archive_file', 'restore_file')
             AND payload->>'fileId' = $2 AND state IN ('queued', 'running')
           FOR UPDATE`,
          [workspaceId, fileId]
        );
        if (
          open.rows.length > 0 ||
          file.archiveState === 'archiving' ||
          file.archiveState === 'restoring'
        ) {
          return 'busy';
        }
      }
    }

    const requeued = await client.query(
      `UPDATE octo.jobs
       SET state = 'queued', attempt = 0, available_at = now(),
           error_code = NULL, error_summary = NULL, completed_at = NULL, updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND state = 'failed' RETURNING id`,
      [jobId, workspaceId]
    );
    return requeued.rows.length > 0 ? 'requeued' : 'not_retryable';
  }, servicePool);
}

export async function dbListJobs(workspaceId: string, limit = 50): Promise<DbJobRow[]> {
  return query<DbJobRow>(
    `SELECT ${JOB_COLUMNS} FROM octo.jobs
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit]
  );
}

export async function dbClaimJob(
  worker: string,
  leaseSeconds = 60,
  targetWorkspaceId: string | null = null
): Promise<{
  jobId: string;
  workspaceId: string;
  jobType: string;
  attempt: number;
  payload: Record<string, unknown>;
} | null> {
  const rows = await queryService<{
    job_id: string;
    workspace_id: string;
    job_type: string;
    attempt: number;
    payload: Record<string, unknown>;
  }>('SELECT * FROM octo.claim_job($1, $2, $3)', [worker, leaseSeconds, targetWorkspaceId]);

  const row = rows[0];
  if (!row) return null;
  return {
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    jobType: row.job_type,
    attempt: Number(row.attempt),
    payload: row.payload ?? {},
  };
}

export async function dbCompleteJob(
  jobId: string,
  result: Record<string, unknown>
): Promise<boolean> {
  const rows = await queryService<{ id: string }>(
    `UPDATE octo.jobs
     SET state = 'completed', result = $2, completed_at = now(),
         lease_expires_at = NULL, lease_owner = NULL, updated_at = now()
     WHERE id = $1 AND state = 'running'
     RETURNING id`,
    [jobId, JSON.stringify(result)]
  );
  return rows.length > 0;
}

export async function dbFailJob(
  jobId: string,
  attempt: number,
  maxAttempts: number,
  errorCode: string,
  errorSummary: string,
  retryable: boolean
): Promise<{ state: string }> {
  const exhausted = attempt >= maxAttempts;

  if (!retryable || exhausted) {
    await queryService(
      `UPDATE octo.jobs
       SET state = 'failed', error_code = $2, error_summary = $3, completed_at = now(),
           lease_expires_at = NULL, lease_owner = NULL, updated_at = now()
       WHERE id = $1`,
      [jobId, errorCode, errorSummary]
    );
    return { state: 'failed' };
  }

  const backoffSeconds = Math.min(2 ** attempt, 300);
  await queryService(
    `UPDATE octo.jobs
     SET state = 'queued', error_code = $2, error_summary = $3,
         available_at = now() + make_interval(secs => $4),
         lease_expires_at = NULL, lease_owner = NULL, updated_at = now()
     WHERE id = $1`,
    [jobId, errorCode, errorSummary, backoffSeconds]
  );
  return { state: 'queued' };
}

export async function dbRecordActivity(
  workspaceId: string,
  eventType: string,
  summary: string,
  jobId: string | null = null,
  actorPrincipalId: string | null = null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await queryService(
    `INSERT INTO octo.activity (workspace_id, job_id, actor_principal_id, event_type, summary, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, jobId, actorPrincipalId, eventType, summary, JSON.stringify(detail)]
  );
}

export async function dbListActivity(
  workspaceId: string,
  limit = 50
): Promise<
  {
    id: string;
    eventType: string;
    summary: string;
    jobId: string | null;
    createdAt: string;
  }[]
> {
  return query(
    `SELECT id, event_type AS "eventType", summary, job_id AS "jobId", created_at AS "createdAt"
     FROM octo.activity
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit]
  );
}

export interface OpsEventInput {
  workspaceId: string | null;
  source: 'api' | 'worker';
  eventType: string;
  errorCode: string | null;
  severity: 'warning' | 'error' | 'critical';
  detail: Record<string, unknown>;
  jobId?: string | null;
  route?: string | null;
  jobType?: string | null;
}

/**
 * Records a structured operational failure. Writes through the service pool: a
 * failure can happen before a caller identity exists (auth errors, pre-workspace
 * 500s), and the writer must not itself be subject to the fence it is reporting on.
 * Callers treat this as best-effort — capture must never break the request path.
 */
export async function dbRecordOpsEvent(input: OpsEventInput): Promise<void> {
  await queryService(
    `INSERT INTO octo.ops_events
       (workspace_id, source, event_type, error_code, severity, detail, job_id, route, job_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.workspaceId,
      input.source,
      input.eventType,
      input.errorCode,
      input.severity,
      JSON.stringify(input.detail),
      input.jobId ?? null,
      input.route ?? null,
      input.jobType ?? null,
    ]
  );
}

/** Recent operational events for a workspace, newest first, optionally by error code. */
export async function dbListOpsEvents(
  workspaceId: string,
  errorCode: string | null,
  limit = 100
): Promise<
  {
    id: string;
    source: string;
    eventType: string;
    errorCode: string | null;
    severity: string;
    detail: Record<string, unknown>;
    jobId: string | null;
    route: string | null;
    jobType: string | null;
    createdAt: string;
  }[]
> {
  const params: unknown[] = [workspaceId];
  let filter = 'workspace_id = $1';
  if (errorCode) {
    params.push(errorCode);
    filter += ` AND error_code = $${params.length}`;
  }
  params.push(limit);
  return query(
    `SELECT id, source, event_type AS "eventType", error_code AS "errorCode", severity,
            detail, job_id AS "jobId", route, job_type AS "jobType", created_at AS "createdAt"
     FROM octo.ops_events
     WHERE ${filter}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
}

export interface OpsSummary {
  failureCounts: {
    errorCode: string | null;
    source: string;
    severity: string;
    eventCount: number;
    firstSeen: string;
    lastSeen: string;
  }[];
  failuresByJobTypeDay: {
    jobType: string;
    day: string;
    errorCode: string | null;
    eventCount: number;
  }[];
  unhealthyJobs: {
    jobId: string;
    jobType: string;
    state: string;
    attempt: number;
    maxAttempts: number;
    leaseExpiresAt: string | null;
    errorCode: string | null;
    errorSummary: string | null;
    updatedAt: string;
  }[];
}

/**
 * The O2 classification views, read over HTTP (issue #140, slice O3).
 *
 * The views are `security_invoker`, so reading them through the fenced `query()`
 * on the app pool applies the caller's own RLS context: the member policy and the
 * slice-14 tenant fence still narrow the rows. This function adds no aggregation
 * of its own -- it selects from the views, so the SQL stays in one place.
 */
export async function dbGetOpsSummary(workspaceId: string): Promise<OpsSummary> {
  const [failureCounts, failuresByJobTypeDay, unhealthyJobs] = await Promise.all([
    query<OpsSummary['failureCounts'][number]>(
      `SELECT error_code AS "errorCode", source, severity, event_count::int AS "eventCount",
              first_seen AS "firstSeen", last_seen AS "lastSeen"
       FROM octo.ops_failure_counts
       WHERE workspace_id = $1
       ORDER BY event_count DESC, error_code`,
      [workspaceId]
    ),
    query<OpsSummary['failuresByJobTypeDay'][number]>(
      `SELECT job_type AS "jobType", day, error_code AS "errorCode", event_count::int AS "eventCount"
       FROM octo.ops_failures_by_job_type_day
       WHERE workspace_id = $1
       ORDER BY day DESC, job_type`,
      [workspaceId]
    ),
    query<OpsSummary['unhealthyJobs'][number]>(
      `SELECT job_id AS "jobId", job_type AS "jobType", state, attempt, max_attempts AS "maxAttempts",
              lease_expires_at AS "leaseExpiresAt", error_code AS "errorCode",
              error_summary AS "errorSummary", updated_at AS "updatedAt"
       FROM octo.ops_unhealthy_jobs
       WHERE workspace_id = $1
       ORDER BY updated_at DESC`,
      [workspaceId]
    ),
  ]);
  return { failureCounts, failuresByJobTypeDay, unhealthyJobs };
}

// 6. Retrieval Operations (Slice 8)
export async function dbEnsureEmbeddingConfig(
  workspaceId: string,
  model: string,
  modelVersion: string,
  dimensions: number,
  chunker: string,
  chunkSize: number,
  chunkOverlap: number
): Promise<string> {
  const sql = `
    INSERT INTO octo.embedding_configs
      (workspace_id, model, model_version, dimensions, chunker, chunk_size, chunk_overlap)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (workspace_id, model, model_version, chunker, chunk_size, chunk_overlap)
    DO NOTHING
    RETURNING id;
  `;
  const inserted = await query<{ id: string }>(sql, [
    workspaceId, model, modelVersion, dimensions, chunker, chunkSize, chunkOverlap,
  ]);
  if (inserted[0]) return inserted[0].id;

  const existing = await query<{ id: string }>(
    `SELECT id FROM octo.embedding_configs
     WHERE workspace_id = $1 AND model = $2 AND model_version = $3
       AND chunker = $4 AND chunk_size = $5 AND chunk_overlap = $6`,
    [workspaceId, model, modelVersion, chunker, chunkSize, chunkOverlap]
  );
  return existing[0]!.id;
}

/**
 * Registers an immutable document version. A repeat of the same content hash
 * returns the existing version instead of creating a duplicate.
 */
export async function dbUpsertDocumentVersion(
  workspaceId: string,
  title: string,
  contentHash: string,
  mimeType: string,
  byteSize: number,
  extractedText: string,
  createdBy: string
): Promise<{ versionId: string; documentId: string; created: boolean }> {
  const docSql = `
    INSERT INTO octo.documents (workspace_id, title, created_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (workspace_id, title) DO NOTHING
    RETURNING id;
  `;
  const docInserted = await query<{ id: string }>(docSql, [workspaceId, title, createdBy]);
  let documentId = docInserted[0]?.id;

  if (!documentId) {
    const found = await query<{ id: string }>(
      'SELECT id FROM octo.documents WHERE workspace_id = $1 AND title = $2',
      [workspaceId, title]
    );
    documentId = found[0]!.id;
  }

  const versionSql = `
    INSERT INTO octo.document_versions
      (document_id, workspace_id, version_number, content_hash, mime_type, byte_size,
       extracted_text, extraction_status)
    VALUES (
      $1, $2,
      COALESCE((SELECT MAX(version_number) + 1 FROM octo.document_versions WHERE document_id = $1), 1),
      $3, $4, $5, $6, 'extracted'
    )
    ON CONFLICT (document_id, content_hash) DO NOTHING
    RETURNING id;
  `;
  const versionInserted = await query<{ id: string }>(versionSql, [
    documentId, workspaceId, contentHash, mimeType, byteSize, extractedText,
  ]);

  if (versionInserted[0]) {
    return { versionId: versionInserted[0].id, documentId, created: true };
  }

  const existing = await query<{ id: string }>(
    'SELECT id FROM octo.document_versions WHERE document_id = $1 AND content_hash = $2',
    [documentId, contentHash]
  );
  return { versionId: existing[0]!.id, documentId, created: false };
}

/** Writes chunks and embeddings for a version, replacing any prior derived rows. */
export async function dbReplaceChunksAndEmbeddings(
  workspaceId: string,
  versionId: string,
  configId: string,
  chunks: Array<{ chunkIndex: number; chunkKey: string; content: string; startOffset: number; endOffset: number; tokenEstimate: number }>,
  vectors: number[][]
): Promise<number> {
  // Derived artifacts are rebuilt as a unit so a partial run cannot leave a
  // half-indexed version.
  await query('DELETE FROM octo.embeddings WHERE workspace_id = $1 AND chunk_id IN (SELECT id FROM octo.chunks WHERE document_version_id = $2)', [workspaceId, versionId]);
  await query('DELETE FROM octo.chunks WHERE document_version_id = $1', [versionId]);

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const inserted = await query<{ id: string }>(
      `INSERT INTO octo.chunks
         (workspace_id, document_version_id, config_id, chunk_index, chunk_key, content,
          start_offset, end_offset, token_estimate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [workspaceId, versionId, configId, chunk.chunkIndex, chunk.chunkKey, chunk.content,
       chunk.startOffset, chunk.endOffset, chunk.tokenEstimate]
    );
    const chunkId = inserted[0]!.id;
    const vectorLiteral = `[${(vectors[i] ?? []).join(',')}]`;
    await query(
      `INSERT INTO octo.embeddings (workspace_id, chunk_id, config_id, embedding)
       VALUES ($1, $2, $3, $4::vector)`,
      [workspaceId, chunkId, configId, vectorLiteral]
    );
  }

  return chunks.length;
}

/** Workspace-scoped semantic retrieval. The filter is applied in SQL. */
export async function dbMatchChunks(
  workspaceId: string,
  queryVector: number[],
  matchCount = 10,
  minSimilarity = 0
): Promise<
  Array<{
    chunkId: string;
    documentVersionId: string;
    content: string;
    chunkIndex: number;
    similarity: number;
    model: string;
    modelVersion: string;
    chunker: string;
  }>
> {
  const literal = `[${queryVector.join(',')}]`;
  return query(
    `SELECT chunk_id AS "chunkId", document_version_id AS "documentVersionId", content,
            chunk_index AS "chunkIndex", similarity, model, model_version AS "modelVersion", chunker
     FROM octo.match_chunks($1, $2::vector, $3, $4)`,
    [workspaceId, literal, matchCount, minSimilarity]
  );
}

/** The workspace's document catalog, newest first, with version and chunk counts. */
export async function dbListDocuments(
  workspaceId: string
): Promise<
  Array<{ documentId: string; title: string; createdAt: string; versionCount: number; chunkCount: number }>
> {
  return query(
    `SELECT d.id AS "documentId", d.title, d.created_at AS "createdAt",
            COUNT(DISTINCT v.id)::int AS "versionCount",
            COUNT(c.id)::int AS "chunkCount"
     FROM octo.documents d
     LEFT JOIN octo.document_versions v ON v.document_id = d.id
     LEFT JOIN octo.chunks c ON c.document_version_id = v.id
     WHERE d.workspace_id = $1
     GROUP BY d.id, d.title, d.created_at
     ORDER BY d.created_at DESC, d.title`,
    [workspaceId]
  );
}

/** One document with its immutable versions. Null when the workspace has no such document. */
export async function dbGetDocument(
  workspaceId: string,
  documentId: string
): Promise<{
  documentId: string;
  title: string;
  createdAt: string;
  versions: Array<{
    versionId: string;
    versionNumber: number;
    contentHash: string;
    mimeType: string;
    byteSize: number | null;
    extractionStatus: string;
    createdAt: string;
    chunkCount: number;
  }>;
} | null> {
  const doc = await query<{ documentId: string; title: string; createdAt: string }>(
    `SELECT id AS "documentId", title, created_at AS "createdAt"
     FROM octo.documents WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, documentId]
  );
  if (!doc[0]) return null;

  const versions = await query<{
    versionId: string;
    versionNumber: number;
    contentHash: string;
    mimeType: string;
    byteSize: number | null;
    extractionStatus: string;
    createdAt: string;
    chunkCount: number;
  }>(
    `SELECT v.id AS "versionId", v.version_number AS "versionNumber", v.content_hash AS "contentHash",
            v.mime_type AS "mimeType", v.byte_size AS "byteSize", v.extraction_status AS "extractionStatus",
            v.created_at AS "createdAt", COUNT(c.id)::int AS "chunkCount"
     FROM octo.document_versions v
     LEFT JOIN octo.chunks c ON c.document_version_id = v.id
     WHERE v.workspace_id = $1 AND v.document_id = $2
     GROUP BY v.id
     ORDER BY v.version_number`,
    [workspaceId, documentId]
  );

  return { ...doc[0], versions };
}

/** Renames a document's title. Null when the document is not in the workspace. */
export async function dbRenameDocument(
  workspaceId: string,
  documentId: string,
  title: string
): Promise<{ documentId: string; title: string } | null> {
  const rows = await query<{ documentId: string; title: string }>(
    `UPDATE octo.documents SET title = $3
     WHERE workspace_id = $1 AND id = $2
     RETURNING id AS "documentId", title`,
    [workspaceId, documentId, title]
  );
  return rows[0] ?? null;
}

/** Deletes a document; the cascade removes its versions, chunks, and embeddings. */
export async function dbDeleteDocument(
  workspaceId: string,
  documentId: string
): Promise<{ documentId: string } | null> {
  const rows = await query<{ documentId: string }>(
    `DELETE FROM octo.documents WHERE workspace_id = $1 AND id = $2 RETURNING id AS "documentId"`,
    [workspaceId, documentId]
  );
  return rows[0] ?? null;
}

// 7. Epistemic ledger (Slice 9): append-only bitemporal claims, beliefs, evidence.
//
// Every helper here runs on the fenced app pool (`query`/`withTransaction`), so the
// RLS operator-insert policy and the tenant fence are the authorization gate. This
// module adds no policy of its own: it writes the row the schema permits, and a
// caller below operator (or outside the workspace) is refused by Postgres.

export type BeliefStance = 'believes' | 'disbelieves' | 'uncertain';
export type ClaimEvidenceStance = 'supports' | 'contradicts' | 'qualifies';
export type ClaimRelation =
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'SUPERSEDES'
  | 'QUALIFIES'
  | 'DERIVED_FROM'
  | 'DUPLICATES'
  | 'REFINES';

/** Idempotent: a repeat of (workspace, name, entity_type) returns the existing row. */
export async function dbEnsureEpistemicEntity(
  workspaceId: string,
  name: string,
  entityType: string
): Promise<{ id: string; name: string; entityType: string }> {
  const inserted = await query<{ id: string; name: string; entityType: string }>(
    `INSERT INTO octo.epistemic_entities (workspace_id, name, entity_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, name, entity_type) DO NOTHING
     RETURNING id, name, entity_type AS "entityType"`,
    [workspaceId, name, entityType]
  );
  if (inserted[0]) return inserted[0];

  const existing = await query<{ id: string; name: string; entityType: string }>(
    `SELECT id, name, entity_type AS "entityType"
     FROM octo.epistemic_entities
     WHERE workspace_id = $1 AND name = $2 AND entity_type = $3`,
    [workspaceId, name, entityType]
  );
  return existing[0]!;
}

/** Idempotent: a repeat of (workspace, name) returns the existing perspective. */
export async function dbEnsurePerspective(
  workspaceId: string,
  name: string,
  description: string | null
): Promise<{ id: string; name: string; description: string | null }> {
  const inserted = await query<{ id: string; name: string; description: string | null }>(
    `INSERT INTO octo.perspectives (workspace_id, name, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, name) DO NOTHING
     RETURNING id, name, description`,
    [workspaceId, name, description]
  );
  if (inserted[0]) return inserted[0];

  const existing = await query<{ id: string; name: string; description: string | null }>(
    `SELECT id, name, description FROM octo.perspectives WHERE workspace_id = $1 AND name = $2`,
    [workspaceId, name]
  );
  return existing[0]!;
}

/** An immutable evidence reference. Never stores bytes; only points at a source. */
export async function dbInsertEvidence(params: {
  workspaceId: string;
  sourceFileId: string | null;
  locator: string | null;
  quote: string | null;
  contentHash: string | null;
  createdBy: string | null;
}): Promise<{ id: string; createdAt: string }> {
  const rows = await query<{ id: string; createdAt: string }>(
    `INSERT INTO octo.evidence (workspace_id, source_file_id, locator, quote, content_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at AS "createdAt"`,
    [params.workspaceId, params.sourceFileId, params.locator, params.quote, params.contentHash, params.createdBy]
  );
  return rows[0]!;
}

/**
 * Records a claim. When `supersedesClaimId` is given, the superseding relation and
 * the closing of the older claim's recorded-time interval happen in the same
 * transaction, so history is appended to, never rewritten: the old row survives
 * with `superseded_at` set and stops counting as current after that instant.
 */
export async function dbInsertClaim(params: {
  workspaceId: string;
  subjectEntityId: string | null;
  statement: string;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string | null;
  provenance: Record<string, unknown>;
  supersedesClaimId: string | null;
  createdBy: string | null;
}): Promise<{ id: string; recordedAt: string; supersededClaimId: string | null }> {
  return withTransaction(async (tx) => {
    const inserted = (await tx.query(
      `INSERT INTO octo.claims

         (workspace_id, subject_entity_id, statement, valid_from, valid_to, recorded_at, provenance, created_by)
       VALUES (
         $1, $2, $3,
         COALESCE($4::timestamptz, now()),
         $5::timestamptz,
         COALESCE($6::timestamptz, now()),
         $7::jsonb, $8
       )
       RETURNING id, recorded_at AS "recordedAt"`,
      [
        params.workspaceId,
        params.subjectEntityId,
        params.statement,
        params.validFrom,
        params.validTo,
        params.recordedAt,
        JSON.stringify(params.provenance),
        params.createdBy,
      ]
    )).rows as Array<{ id: string; recordedAt: string }>;
    const claim = inserted[0]!;

    if (params.supersedesClaimId) {
      await tx.query(
        `INSERT INTO octo.claim_relations
           (workspace_id, from_claim_id, to_claim_id, relation, recorded_at, created_by)
         VALUES ($1, $2, $3, 'SUPERSEDES', $4::timestamptz, $5)`,
        [params.workspaceId, claim.id, params.supersedesClaimId, claim.recordedAt, params.createdBy]
      );
      await tx.query(
        `UPDATE octo.claims
         SET superseded_at = $3::timestamptz
         WHERE workspace_id = $1 AND id = $2 AND superseded_at IS NULL`,
        [params.workspaceId, params.supersedesClaimId, claim.recordedAt]
      );
    }

    return { id: claim.id, recordedAt: claim.recordedAt, supersededClaimId: params.supersedesClaimId };
  });
}

/** One perspective's stance on one claim, bitemporal and append-only. */
export async function dbInsertBelief(params: {
  workspaceId: string;
  perspectiveId: string;
  claimId: string;
  stance: BeliefStance;
  confidence: number | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string | null;
}): Promise<{ id: string; recordedAt: string }> {
  const rows = await query<{ id: string; recordedAt: string }>(
    `INSERT INTO octo.beliefs
       (workspace_id, perspective_id, claim_id, stance, confidence, valid_from, valid_to, recorded_at)
     VALUES (
       $1, $2, $3, $4, $5,
       COALESCE($6::timestamptz, now()),
       $7::timestamptz,
       COALESCE($8::timestamptz, now())
     )
     RETURNING id, recorded_at AS "recordedAt"`,
    [
      params.workspaceId,
      params.perspectiveId,
      params.claimId,
      params.stance,
      params.confidence,
      params.validFrom,
      params.validTo,
      params.recordedAt,
    ]
  );
  return rows[0]!;
}

export async function dbInsertClaimRelation(params: {
  workspaceId: string;
  fromClaimId: string;
  toClaimId: string;
  relation: ClaimRelation;
  recordedAt: string | null;
  createdBy: string | null;
}): Promise<{ id: string }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO octo.claim_relations
       (workspace_id, from_claim_id, to_claim_id, relation, recorded_at, created_by)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6)
     RETURNING id`,
    [params.workspaceId, params.fromClaimId, params.toClaimId, params.relation, params.recordedAt, params.createdBy]
  );
  return rows[0]!;
}

export async function dbInsertClaimEvidence(params: {
  workspaceId: string;
  claimId: string;
  evidenceId: string;
  stance: ClaimEvidenceStance;
}): Promise<{ id: string }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO octo.claim_evidence (workspace_id, claim_id, evidence_id, stance)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (claim_id, evidence_id, stance) DO NOTHING
     RETURNING id`,
    [params.workspaceId, params.claimId, params.evidenceId, params.stance]
  );
  if (rows[0]) return rows[0];
  const existing = await query<{ id: string }>(
    `SELECT id FROM octo.claim_evidence
     WHERE workspace_id = $1 AND claim_id = $2 AND evidence_id = $3 AND stance = $4`,
    [params.workspaceId, params.claimId, params.evidenceId, params.stance]
  );
  return existing[0]!;
}

/**
 * Query mode 2: with current knowledge, which claims do we now consider valid at a
 * world instant? The canonical function applies both time axes; the join adds the
 * provenance the caller needs to cite the run/source that produced each claim.
 */
export async function dbClaimsAsOf(
  workspaceId: string,
  asOfRecorded: string,
  asOfValid: string | null
): Promise<
  Array<{
    claimId: string;
    statement: string;
    validFrom: string;
    validTo: string | null;
    recordedAt: string;
    provenance: Record<string, unknown>;
  }>
> {
  return query(
    `SELECT f.claim_id AS "claimId", f.statement, f.valid_from AS "validFrom", f.valid_to AS "validTo",
            c.recorded_at AS "recordedAt", c.provenance
     FROM octo.claims_as_of($1::uuid, $2::timestamptz, $3::timestamptz) f
     LEFT JOIN octo.claims c ON c.id = f.claim_id
     ORDER BY c.recorded_at DESC`,
    [workspaceId, asOfRecorded, asOfValid]
  );
}

/**
 * Query mode 1: what did perspective P believe about a claim as of a recorded
 * instant (and a world instant)? Returns the belief plus the evidence linked to the
 * claim, so the answer cites its sources.
 */
export async function dbBeliefAsOf(
  workspaceId: string,
  perspectiveId: string,
  claimId: string,
  asOfRecorded: string,
  asOfValid: string
): Promise<{
  belief: { stance: string; confidence: number | null; beliefId: string } | null;
  evidence: Array<{
    evidenceId: string;
    stance: string;
    locator: string | null;
    quote: string | null;
    contentHash: string | null;
    sourceFileId: string | null;
  }>;
}> {
  const beliefRows = await query<{ stance: string; confidence: number | null; beliefId: string }>(
    `SELECT stance, confidence, belief_id AS "beliefId"
     FROM octo.belief_as_of($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz)`,
    [workspaceId, perspectiveId, claimId, asOfRecorded, asOfValid]
  );

  const evidence = await query<{
    evidenceId: string;
    stance: string;
    locator: string | null;
    quote: string | null;
    contentHash: string | null;
    sourceFileId: string | null;
  }>(
    `SELECT e.id AS "evidenceId", ce.stance, e.locator, e.quote,
            e.content_hash AS "contentHash", e.source_file_id AS "sourceFileId"
     FROM octo.claim_evidence ce
     JOIN octo.evidence e ON e.id = ce.evidence_id
     WHERE ce.workspace_id = $1 AND ce.claim_id = $2
     ORDER BY ce.created_at`,
    [workspaceId, claimId]
  );

  return { belief: beliefRows[0] ?? null, evidence };
}

// 8. Graph projection (Slice 10): the canonical reads the projector consumes and
// the projection bookkeeping. The graph is a rebuildable read model; PostgreSQL
// stays canonical, so everything here reads octo.* rows and writes only the
// projection's own watermark/health row.
//
// Each helper has two forms. The route-facing one reads through the fenced app pool,
// where RLS is a second layer behind the route's own membership/role check. The
// `...Service` form reads through the trusted pool, because a job claimed by the
// scheduler drains with no caller identity and the fenced pool would fail closed --
// silently projecting an empty graph from a ledger RLS hid. The job's workspace is
// the authority there, exactly as it is for the archive and thumbnail jobs.

/** A pool query bound to the caller: the fenced app pool, or the trusted service pool. */
type SqlExecutor = <T = unknown>(text: string, params?: unknown[]) => Promise<T[]>;

/** The epistemic ledger for one workspace, in the shape the projector consumes. */
async function readEpistemicGraph(
  exec: SqlExecutor,
  workspaceId: string
): Promise<{
  entities: Array<{ id: string; name: string; entityType: string }>;
  claims: Array<{
    id: string;
    statement: string;
    subjectEntityId: string | null;
    validFrom: string;
    validTo: string | null;
    recordedAt: string;
    supersededAt: string | null;
    provenance: Record<string, unknown>;
  }>;
  evidence: Array<{
    id: string;
    locator: string | null;
    quote: string | null;
    contentHash: string | null;
    sourceFileId: string | null;
  }>;
  perspectives: Array<{ id: string; name: string }>;
  beliefs: Array<{
    id: string;
    perspectiveId: string;
    claimId: string;
    stance: string;
    confidence: number | null;
    validFrom: string;
    validTo: string | null;
    recordedAt: string;
    supersededAt: string | null;
  }>;
  claimRelations: Array<{
    id: string;
    fromClaimId: string;
    toClaimId: string;
    relation: string;
    recordedAt: string;
    supersededAt: string | null;
  }>;
  claimEvidence: Array<{ id: string; claimId: string; evidenceId: string; stance: string }>;
}> {
  const [entities, claims, evidence, perspectives, beliefs, claimRelations, claimEvidence] =
    await Promise.all([
      exec<{ id: string; name: string; entityType: string }>(
        `SELECT id, name, entity_type AS "entityType" FROM octo.epistemic_entities WHERE workspace_id = $1`,
        [workspaceId]
      ),
      exec<{
        id: string;
        statement: string;
        subjectEntityId: string | null;
        validFrom: string;
        validTo: string | null;
        recordedAt: string;
        supersededAt: string | null;
        provenance: Record<string, unknown>;
      }>(
        `SELECT id, statement, subject_entity_id AS "subjectEntityId",
                valid_from AS "validFrom", valid_to AS "validTo", recorded_at AS "recordedAt",
                superseded_at AS "supersededAt", provenance
         FROM octo.claims WHERE workspace_id = $1`,
        [workspaceId]
      ),
      exec<{
        id: string;
        locator: string | null;
        quote: string | null;
        contentHash: string | null;
        sourceFileId: string | null;
      }>(
        `SELECT id, locator, quote, content_hash AS "contentHash", source_file_id AS "sourceFileId"
         FROM octo.evidence WHERE workspace_id = $1`,
        [workspaceId]
      ),
      exec<{ id: string; name: string }>(
        `SELECT id, name FROM octo.perspectives WHERE workspace_id = $1`,
        [workspaceId]
      ),
      exec<{
        id: string;
        perspectiveId: string;
        claimId: string;
        stance: string;
        confidence: number | null;
        validFrom: string;
        validTo: string | null;
        recordedAt: string;
        supersededAt: string | null;
      }>(
        `SELECT id, perspective_id AS "perspectiveId", claim_id AS "claimId", stance,
                confidence::float8 AS confidence, valid_from AS "validFrom", valid_to AS "validTo",
                recorded_at AS "recordedAt", superseded_at AS "supersededAt"
         FROM octo.beliefs WHERE workspace_id = $1`,
        [workspaceId]
      ),
      exec<{
        id: string;
        fromClaimId: string;
        toClaimId: string;
        relation: string;
        recordedAt: string;
        supersededAt: string | null;
      }>(
        `SELECT id, from_claim_id AS "fromClaimId", to_claim_id AS "toClaimId", relation,
                recorded_at AS "recordedAt", superseded_at AS "supersededAt"
         FROM octo.claim_relations WHERE workspace_id = $1`,
        [workspaceId]
      ),
      exec<{ id: string; claimId: string; evidenceId: string; stance: string }>(
        `SELECT id, claim_id AS "claimId", evidence_id AS "evidenceId", stance
         FROM octo.claim_evidence WHERE workspace_id = $1`,
        [workspaceId]
      ),
    ]);

  return { entities, claims, evidence, perspectives, beliefs, claimRelations, claimEvidence };
}

export function dbReadEpistemicGraph(workspaceId: string) {
  return readEpistemicGraph(query, workspaceId);
}

/** Trusted-pool ledger read for the job worker, which runs with no caller identity. */
export function dbReadEpistemicGraphService(workspaceId: string) {
  return readEpistemicGraph(queryService, workspaceId);
}

/**
 * The newest canonical timestamp in a workspace's epistemic ledger, or null when
 * it is empty. The projector records this as the projection's source watermark, and
 * a query compares it to the live value to detect staleness.
 */
async function epistemicWatermark(exec: SqlExecutor, workspaceId: string): Promise<string | null> {
  const rows = await exec<{ watermark: string | null }>(
    `SELECT MAX(ts) AS watermark FROM (
       SELECT MAX(created_at) AS ts FROM octo.epistemic_entities WHERE workspace_id = $1
       UNION ALL SELECT MAX(recorded_at) FROM octo.claims WHERE workspace_id = $1
       UNION ALL SELECT MAX(created_at) FROM octo.evidence WHERE workspace_id = $1
       UNION ALL SELECT MAX(created_at) FROM octo.perspectives WHERE workspace_id = $1
       UNION ALL SELECT MAX(recorded_at) FROM octo.beliefs WHERE workspace_id = $1
       UNION ALL SELECT MAX(recorded_at) FROM octo.claim_relations WHERE workspace_id = $1
       UNION ALL SELECT MAX(created_at) FROM octo.claim_evidence WHERE workspace_id = $1
     ) t`,
    [workspaceId]
  );
  return rows[0]?.watermark ?? null;
}

export function dbEpistemicWatermark(workspaceId: string) {
  return epistemicWatermark(query, workspaceId);
}

/** Trusted-pool watermark read for the job worker, which runs with no caller identity. */
export function dbEpistemicWatermarkService(workspaceId: string) {
  return epistemicWatermark(queryService, workspaceId);
}

export async function dbGetGraphProjection(workspaceId: string): Promise<GraphProjectionRow | null> {
  const rows = await query<GraphProjectionRow>(
    `SELECT workspace_id AS "workspaceId", schema_version AS "schemaVersion",
            source_watermark AS "sourceWatermark", entity_count AS "entityCount",
            claim_count AS "claimCount", evidence_count AS "evidenceCount",
            relation_count AS "relationCount", status, last_error AS "lastError",
            updated_at AS "updatedAt"
     FROM octo.graph_projections WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0] ?? null;
}

/** Records the outcome of a projection run (a successful watermark or a failure). */
async function upsertGraphProjection(
  exec: SqlExecutor,
  params: GraphProjectionRecord
): Promise<void> {
  await exec(
    `INSERT INTO octo.graph_projections
       (workspace_id, schema_version, source_watermark, entity_count, claim_count,
        evidence_count, relation_count, status, last_error, updated_at)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (workspace_id) DO UPDATE SET
       schema_version = EXCLUDED.schema_version,
       source_watermark = EXCLUDED.source_watermark,
       entity_count = EXCLUDED.entity_count,
       claim_count = EXCLUDED.claim_count,
       evidence_count = EXCLUDED.evidence_count,
       relation_count = EXCLUDED.relation_count,
       status = EXCLUDED.status,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      params.workspaceId,
      params.schemaVersion,
      params.sourceWatermark,
      params.entityCount,
      params.claimCount,
      params.evidenceCount,
      params.relationCount,
      params.status,
      params.lastError,
    ]
  );
}

export function dbUpsertGraphProjection(params: GraphProjectionRecord) {
  return upsertGraphProjection(query, params);
}

/** Trusted-pool projection write for the job worker, which runs with no caller identity. */
export function dbUpsertGraphProjectionService(params: GraphProjectionRecord) {
  return upsertGraphProjection(queryService, params);
}

// 6. Workspace data plane (Slice 13): atomic workspace create, delete, and the
// confirmation/retention helpers. Kept together so the multi-write invariant in
// dbCreateWorkspaceAtomic is easy to audit.

export async function dbGetWorkspaceById(workspaceId: string): Promise<{
  id: string;
  slug: string;
  name: string;
  description: string | null;
  retentionDays: number | null;
} | null> {
  const rows = await query<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    retentionDays: number | null;
  }>(
    `SELECT id, slug, name, description, retention_days AS "retentionDays"
     FROM octo.workspaces WHERE id = $1`,
    [workspaceId]
  );
  return rows[0] ?? null;
}

/** Thrown by dbCreateWorkspaceAtomic when the Slice 16 rolling-day quota is spent. */
export const WORKSPACE_DAILY_LIMIT = 'WORKSPACE_DAILY_LIMIT';

/**
 * Creates a workspace, the creator's owner membership, and the workspace-scoped
 * API key in one transaction. A failure in any of the three rolls back all of
 * them, so a workspace can never exist without its key.
 *
 * When `enforceDailyLimit` is set, the Slice 16 quota is enforced *inside* the
 * same transaction, under a per-principal advisory lock. The count and the
 * insert must be atomic: checking the quota on one connection and inserting on
 * another lets two concurrent creates both observe an empty window and both
 * succeed. The lock serializes creates by one principal so the second sees the
 * first's row. The platform owner passes `enforceDailyLimit: false`.
 */
export async function dbCreateWorkspaceAtomic(params: {
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  retentionDays: number | null;
  createdBy: string;
  keyId: string;
  keyHash: string;
  keyPrefix: string;
  keyName: string;
  keyScopes: string[];
  enforceDailyLimit: boolean;
}): Promise<{ id: string; slug: string; name: string; description: string | null; retentionDays: number | null }> {
  return withTransaction(async (client) => {
    if (params.enforceDailyLimit) {
      // Serialize concurrent creates by this principal for the life of the
      // transaction. The lock releases on COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [params.createdBy]);
      const existing = await client.query(
        `SELECT count(*)::text AS count FROM octo.workspaces
         WHERE created_by = $1 AND auto_provisioned = false
           AND created_at >= now() - interval '24 hours'`,
        [params.createdBy]
      );
      const createdLastDay = parseInt((existing.rows[0] as { count: string }).count, 10);
      if (createdLastDay >= 1) {
        const err = new Error(WORKSPACE_DAILY_LIMIT);
        (err as { code?: string }).code = WORKSPACE_DAILY_LIMIT;
        throw err;
      }
    }

    const ws = await client.query(
      `INSERT INTO octo.workspaces (id, slug, name, description, created_by, retention_days)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, slug, name, description, retention_days AS "retentionDays"`,
      [params.workspaceId, params.slug, params.name, params.description, params.createdBy, params.retentionDays]
    );
    const row = ws.rows[0] as {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      retentionDays: number | null;
    };

    await client.query(
      `INSERT INTO octo.workspace_memberships (workspace_id, principal_id, role)
       VALUES ($1, $2, 'owner')`,
      [params.workspaceId, params.createdBy]
    );

    await client.query(
      `INSERT INTO octo.api_keys (id, key_hash, prefix, name, principal_id, workspace_id, role, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, 'owner', $7)`,
      [
        params.keyId,
        params.keyHash,
        params.keyPrefix,
        params.keyName,
        params.createdBy,
        params.workspaceId,
        params.keyScopes,
      ]
    );

    return row;
  });
}

// 6b. Provisioned databases (productization Slice 20). The catalog row is tenant
// data and runs on the fenced app pool like every other user-data read/write; the
// privileged DDL itself lives in src/server/provisioning.ts.

export interface DbWorkspaceDatabaseRow {
  id: string;
  workspaceId: string;
  dbName: string;
  roleName: string;
  status: string;
  createdAt: string;
}

const WORKSPACE_DATABASE_COLUMNS = `
  id, workspace_id AS "workspaceId", db_name AS "dbName", role_name AS "roleName",
  status, created_at AS "createdAt"
`;

/** The workspace's provisioned database, or null when it has none. */
export async function dbGetWorkspaceDatabase(workspaceId: string): Promise<DbWorkspaceDatabaseRow | null> {
  const rows = await query<DbWorkspaceDatabaseRow>(
    `SELECT ${WORKSPACE_DATABASE_COLUMNS} FROM octo.workspace_databases WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0] ?? null;
}

/** Records a provisioned database. Written last, so a failed provision leaves no row. */
export async function dbInsertWorkspaceDatabase(
  id: string,
  workspaceId: string,
  dbName: string,
  roleName: string,
  createdBy: string
): Promise<DbWorkspaceDatabaseRow> {
  const rows = await query<DbWorkspaceDatabaseRow>(
    `INSERT INTO octo.workspace_databases (id, workspace_id, db_name, role_name, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${WORKSPACE_DATABASE_COLUMNS}`,
    [id, workspaceId, dbName, roleName, createdBy]
  );
  return rows[0]!;
}

// 6c. Provisioned-database credentials (Slice 21). Secret material, not tenant
// data: the encrypted password is read only on the trusted service pool, which is
// the only role the credential table grants. The fenced app pool cannot read it.

/** The workspace's encrypted database password, or null when none is stored. */
export async function dbGetWorkspaceDatabaseCredential(workspaceId: string): Promise<string | null> {
  const rows = await queryService<{ passwordEncrypted: string }>(
    `SELECT password_encrypted AS "passwordEncrypted"
     FROM octo.workspace_database_credentials WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0]?.passwordEncrypted ?? null;
}

/** Stores (or replaces) the encrypted password for a workspace's database. */
export async function dbSetWorkspaceDatabaseCredential(
  workspaceId: string,
  passwordEncrypted: string
): Promise<void> {
  await queryService(
    `INSERT INTO octo.workspace_database_credentials (workspace_id, password_encrypted, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (workspace_id)
     DO UPDATE SET password_encrypted = EXCLUDED.password_encrypted, updated_at = now()`,
    [workspaceId, passwordEncrypted]
  );
}

/** Files in a transient archive state block a workspace delete. */
export async function dbCountTransientFiles(workspaceId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM octo.files
     WHERE workspace_id = $1 AND archive_state IN ('archiving', 'restoring')`,
    [workspaceId]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/** Storage keys for a workspace's files, so a delete can report orphaned bytes. */
export async function dbListWorkspaceStorageKeys(workspaceId: string): Promise<string[]> {
  const rows = await query<{ storageKey: string }>(
    `SELECT storage_key AS "storageKey" FROM octo.files WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows.map((r) => r.storageKey);
}

/**
 * Deletes a workspace inside one transaction. Re-checks the transient archive
 * state under the transaction so a concurrent archive cannot slip past the
 * route's pre-check and orphan bytes. Returns false when the workspace is busy.
 */
export async function dbDeleteWorkspaceAtomic(workspaceId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const busy = await client.query(
      `SELECT count(*)::int AS count FROM octo.files
       WHERE workspace_id = $1 AND archive_state IN ('archiving', 'restoring')`,
      [workspaceId]
    );
    if (((busy.rows[0] as { count: number }).count ?? 0) > 0) return false;
    await client.query('DELETE FROM octo.workspaces WHERE id = $1', [workspaceId]);
    return true;
  });
}

export async function dbSetConfirmSecret(principalId: string, hash: string): Promise<void> {
  // principals_update_own keys on auth.uid(), which the fence path no longer sets
  // (identity is bound by principal id instead). The confirm secret is per-principal
  // and the caller is already authenticated, so this identity-maintenance write runs
  // on the trusted path rather than widening the principals UPDATE policy.
  await queryService('UPDATE octo.principals SET confirm_secret_hash = $1, updated_at = now() WHERE id = $2', [
    hash,
    principalId,
  ]);
}

export async function dbGetConfirmSecretHash(principalId: string): Promise<string | null> {
  const rows = await queryService<{ hash: string | null }>(
    'SELECT confirm_secret_hash AS hash FROM octo.principals WHERE id = $1',
    [principalId]
  );
  return rows[0]?.hash ?? null;
}

export interface MfaRecord {
  secretEncrypted: string;
  confirmedAt: string | null;
  recoveryCodeHashes: string[];
}

/**
 * The principal's MFA record, or null when none is enrolled. Reads the trusted
 * path like the confirmation secret: this is per-principal identity material,
 * never tenant data exposed to the client.
 */
export async function dbGetMfa(principalId: string): Promise<MfaRecord | null> {
  const rows = await queryService<{ secret: string | null; confirmedAt: string | null; hashes: string[] | null }>(
    `SELECT mfa_secret_encrypted AS secret, mfa_confirmed_at AS "confirmedAt", mfa_recovery_code_hashes AS hashes
     FROM octo.principals WHERE id = $1`,
    [principalId]
  );
  const row = rows[0];
  if (!row?.secret) return null;
  return {
    secretEncrypted: row.secret,
    confirmedAt: row.confirmedAt,
    recoveryCodeHashes: row.hashes ?? [],
  };
}

/** Stores an unconfirmed enrollment secret, clearing any prior confirmation. */
export async function dbSetMfaPending(principalId: string, secretEncrypted: string): Promise<void> {
  await queryService(
    `UPDATE octo.principals
     SET mfa_secret_encrypted = $1, mfa_confirmed_at = NULL, mfa_recovery_code_hashes = '{}', updated_at = now()
     WHERE id = $2`,
    [secretEncrypted, principalId]
  );
}

/** Confirms enrollment and installs the initial recovery-code hashes. */
export async function dbConfirmMfa(principalId: string, recoveryCodeHashes: string[]): Promise<void> {
  await queryService(
    `UPDATE octo.principals
     SET mfa_confirmed_at = now(), mfa_recovery_code_hashes = $1, updated_at = now()
     WHERE id = $2`,
    [recoveryCodeHashes, principalId]
  );
}

/** Replaces the recovery-code hashes (after a code is consumed or rotated). */
export async function dbSetMfaRecoveryCodes(principalId: string, recoveryCodeHashes: string[]): Promise<void> {
  await queryService(
    'UPDATE octo.principals SET mfa_recovery_code_hashes = $1, updated_at = now() WHERE id = $2',
    [recoveryCodeHashes, principalId]
  );
}

/**
 * Atomically consumes one recovery code, returning whether it was present. The
 * single UPDATE removes the hash only when it is still in the list, so two
 * concurrent step-ups cannot both redeem the same code: the second re-reads the
 * row after the first's lock and finds the hash already gone.
 */
export async function dbConsumeMfaRecoveryCode(principalId: string, codeHash: string): Promise<boolean> {
  const rows = await queryService<{ id: string }>(
    `UPDATE octo.principals
     SET mfa_recovery_code_hashes = array_remove(mfa_recovery_code_hashes, $1), updated_at = now()
     WHERE id = $2 AND $1 = ANY(mfa_recovery_code_hashes)
     RETURNING id`,
    [codeHash, principalId]
  );
  return rows.length > 0;
}

/** Removes the MFA record entirely (disable). */
export async function dbClearMfa(principalId: string): Promise<void> {
  await queryService(
    `UPDATE octo.principals
     SET mfa_secret_encrypted = NULL, mfa_confirmed_at = NULL, mfa_recovery_code_hashes = '{}', updated_at = now()
     WHERE id = $1`,
    [principalId]
  );
}

/** The id of a principal's account-wide key, or null. Enforces the one-key rule. */
export async function dbGetAccountWideKeyId(principalId: string): Promise<string | null> {
  // An account-wide key has workspace_id NULL by definition, so a scoped key's fence
  // would hide it. This is a pre-mint existence check for the one-key rule, not tenant
  // data; it reads the caller's own key row on the trusted path.
  const rows = await queryService<{ id: string }>(
    'SELECT id FROM octo.api_keys WHERE principal_id = $1 AND workspace_id IS NULL LIMIT 1',
    [principalId]
  );
  return rows[0]?.id ?? null;
}

/** Workspaces that have a retention window set, for the archive sweep. */
export async function dbListRetentionWorkspaces(): Promise<{ id: string; retentionDays: number }[]> {
  return queryService<{ id: string; retentionDays: number }>(
    `SELECT id, retention_days AS "retentionDays" FROM octo.workspaces
     WHERE retention_days IS NOT NULL`
  );
}

/** Active R2 files older than the retention window, candidates for archiving. */
export async function dbListAgedActiveFiles(workspaceId: string, retentionDays: number): Promise<string[]> {
  const rows = await queryService<{ id: string }>(
    `SELECT id FROM octo.files
     WHERE workspace_id = $1 AND status = 'active' AND archive_state = 'active_r2'
       AND created_at < now() - ($2 || ' days')::interval`,
    [workspaceId, retentionDays]
  );
  return rows.map((r) => r.id);
}

/**
 * True when a job of this type for this file is still open (queued or running).
 * The retention sweep uses it to avoid double-queueing a file that is already
 * mid-transition.
 */
export async function dbHasOpenFileJob(
  workspaceId: string,
  jobType: string,
  fileId: string
): Promise<boolean> {
  const rows = await queryService<{ open: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM octo.jobs
       WHERE workspace_id = $1 AND job_type = $2 AND payload->>'fileId' = $3
         AND state IN ('queued', 'running')
     ) AS open`,
    [workspaceId, jobType, fileId]
  );
  return rows[0]?.open ?? false;
}

// --- Vault cabinet -----------------------------------------------------------

export interface VaultItemRow {
  id: string;
  workspaceId: string | null;
  label: string;
  description: string;
  kind: 'login' | 'token' | 'url' | 'note';
  kindSource: 'explicit' | 'inferred';
  username: string | null;
  url: string | null;
  urlKind: string | null;
  secretEncrypted: string | null;
  notesEncrypted: string | null;
  healthStatus: 'unchecked' | 'healthy' | 'weak' | 'stale';
  healthDetail: string | null;
  lastHealthAt: string | null;
  staleSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultGrantRow {
  id: string;
  workspaceId: string | null;
  parentGrantId: string | null;
  prefix: string;
  name: string;
  decoy: boolean;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  trippedAt: string | null;
}

const VAULT_ITEM_COLUMNS = `
  id,
  workspace_id AS "workspaceId",
  label,
  description,
  kind,
  kind_source AS "kindSource",
  username,
  url,
  url_kind AS "urlKind",
  secret_encrypted AS "secretEncrypted",
  notes_encrypted AS "notesEncrypted",
  health_status AS "healthStatus",
  health_detail AS "healthDetail",
  last_health_at AS "lastHealthAt",
  stale_since AS "staleSince",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function dbListVaultItems(principalId: string): Promise<VaultItemRow[]> {
  return query<VaultItemRow>(
    `SELECT ${VAULT_ITEM_COLUMNS}
     FROM octo.vault_items
     WHERE principal_id = $1
     ORDER BY created_at DESC`,
    [principalId]
  );
}

export async function dbGetVaultItem(principalId: string, itemId: string): Promise<VaultItemRow | null> {
  const rows = await query<VaultItemRow>(
    `SELECT ${VAULT_ITEM_COLUMNS}
     FROM octo.vault_items
     WHERE principal_id = $1 AND id = $2`,
    [principalId, itemId]
  );
  return rows[0] ?? null;
}

export async function dbInsertVaultItem(input: {
  id: string;
  principalId: string;
  workspaceId: string | null;
  label: string;
  description: string;
  kind: string;
  kindSource?: 'explicit' | 'inferred';
  username: string | null;
  url: string | null;
  urlKind: string | null;
  secretEncrypted: string | null;
  notesEncrypted: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO octo.vault_items (
       id, principal_id, workspace_id, label, description, kind, kind_source, username, url, url_kind, secret_encrypted, notes_encrypted
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.id,
      input.principalId,
      input.workspaceId,
      input.label,
      input.description,
      input.kind,
      input.kindSource ?? 'explicit',
      input.username,
      input.url,
      input.urlKind,
      input.secretEncrypted,
      input.notesEncrypted,
    ]
  );
}

export async function dbInsertVaultItemsBulk(
  principalId: string,
  items: Array<{
    workspaceId: string | null;
    label: string;
    description: string;
    kind: string;
    kindSource?: 'explicit' | 'inferred';
    username: string | null;
    url: string | null;
    urlKind: string | null;
    secretEncrypted: string | null;
    notesEncrypted: string | null;
  }>
): Promise<void> {
  await withTransaction(async (client) => {
    for (const item of items) {
      await client.query(
        `INSERT INTO octo.vault_items (
           id, principal_id, workspace_id, label, description, kind, kind_source, username, url, url_kind, secret_encrypted, notes_encrypted
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          randomUUID(),
          principalId,
          item.workspaceId,
          item.label,
          item.description,
          item.kind,
          item.kindSource ?? 'explicit',
          item.username,
          item.url,
          item.urlKind,
          item.secretEncrypted,
          item.notesEncrypted,
        ]
      );
    }
  });
}

export async function dbDeleteVaultItem(principalId: string, itemId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM octo.vault_items WHERE principal_id = $1 AND id = $2 RETURNING id',
    [principalId, itemId]
  );
  return rows.length > 0;
}

export async function dbUpdateVaultHealth(
  principalId: string,
  itemId: string,
  status: string,
  detail: string
): Promise<void> {
  await query(
    `UPDATE octo.vault_items
     SET health_status = $3,
         health_detail = $4,
         last_health_at = now(),
         stale_since = CASE WHEN $3 = 'stale' THEN COALESCE(stale_since, now()) ELSE NULL END,
         updated_at = now()
     WHERE principal_id = $1 AND id = $2`,
    [principalId, itemId, status, detail]
  );
}

/** Removes items that have been stale since before `cutoff`. */
export async function dbPurgeStaleVaultItems(principalId: string, cutoffIso: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM octo.vault_items
     WHERE principal_id = $1
       AND health_status = 'stale'
       AND stale_since IS NOT NULL
       AND stale_since < $2::timestamptz
     RETURNING id`,
    [principalId, cutoffIso]
  );
  return rows.length;
}

export async function dbListVaultGrants(principalId: string): Promise<VaultGrantRow[]> {
  return query<VaultGrantRow>(
    `SELECT id,
            workspace_id AS "workspaceId",
            parent_grant_id AS "parentGrantId",
            prefix,
            name,
            decoy,
            expires_at AS "expiresAt",
            created_at AS "createdAt",
            last_used_at AS "lastUsedAt",
            tripped_at AS "trippedAt"
     FROM octo.vault_grants
     WHERE principal_id = $1
     ORDER BY created_at DESC`,
    [principalId]
  );
}

export async function dbInsertVaultGrant(input: {
  id: string;
  principalId: string;
  workspaceId: string | null;
  parentGrantId: string | null;
  keyHash: string;
  prefix: string;
  name: string;
  decoy: boolean;
  expiresAt: string;
}): Promise<void> {
  await query(
    `INSERT INTO octo.vault_grants (
       id, principal_id, workspace_id, parent_grant_id, key_hash, prefix, name, decoy, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.principalId,
      input.workspaceId,
      input.parentGrantId,
      input.keyHash,
      input.prefix,
      input.name,
      input.decoy,
      input.expiresAt,
    ]
  );
}

/**
 * Inserts a decoy grant minted by an agent. The agent has no session, so this
 * uses the service pool and copies the cabinet from the parent grant. The
 * caller has already verified that parent.
 */
export async function dbInsertVaultGrantService(input: {
  id: string;
  principalId: string;
  workspaceId: string | null;
  parentGrantId: string;
  keyHash: string;
  prefix: string;
  name: string;
  expiresAt: string;
}): Promise<void> {
  await queryService(
    `INSERT INTO octo.vault_grants (
       id, principal_id, workspace_id, parent_grant_id, key_hash, prefix, name, decoy, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
    [
      input.id,
      input.principalId,
      input.workspaceId,
      input.parentGrantId,
      input.keyHash,
      input.prefix,
      input.name,
      input.expiresAt,
    ]
  );
}

export async function dbDeleteVaultGrant(principalId: string, grantId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM octo.vault_grants WHERE principal_id = $1 AND id = $2 RETURNING id',
    [principalId, grantId]
  );
  return rows.length > 0;
}

export interface ConsumedVaultGrant {
  grantId: string;
  principalId: string;
  workspaceId: string | null;
  prefix: string;
  grantName: string;
  decoy: boolean;
  expiresAt: string;
  trippedAt: string | null;
}

export async function dbConsumeVaultGrant(keyHash: string): Promise<ConsumedVaultGrant | null> {
  const rows = await queryService<ConsumedVaultGrant>(
    `SELECT grant_id AS "grantId",
            principal_id AS "principalId",
            workspace_id AS "workspaceId",
            prefix,
            grant_name AS "grantName",
            decoy,
            expires_at AS "expiresAt",
            tripped_at AS "trippedAt"
     FROM octo.consume_vault_grant($1)`,
    [keyHash]
  );
  return rows[0] ?? null;
}

/** Items in the cabinet a grant is allowed to read. Service path: no session. */
export async function dbListVaultItemsForGrant(
  principalId: string,
  workspaceId: string | null
): Promise<VaultItemRow[]> {
  return queryService<VaultItemRow>(
    `SELECT ${VAULT_ITEM_COLUMNS}
     FROM octo.vault_items
     WHERE principal_id = $1
       AND workspace_id IS NOT DISTINCT FROM $2::uuid
     ORDER BY label ASC`,
    [principalId, workspaceId]
  );
}

// --- Vault credential routes -------------------------------------------------

export interface VaultRouteRow {
  id: string;
  itemId: string;
  routeKey: string;
  name: string;
  baseUrl: string;
  authScheme: string;
  authHeader: string | null;
  bodyField: string | null;
  basicUsername: string | null;
  healthStatus: string;
  healthDetail: string | null;
  lastHealthAt: string | null;
  createdAt: string;
}

const VAULT_ROUTE_COLUMNS = `
  id,
  item_id AS "itemId",
  route_key AS "routeKey",
  name,
  base_url AS "baseUrl",
  auth_scheme AS "authScheme",
  auth_header AS "authHeader",
  body_field AS "bodyField",
  basic_username AS "basicUsername",
  health_status AS "healthStatus",
  health_detail AS "healthDetail",
  last_health_at AS "lastHealthAt",
  created_at AS "createdAt"
`;

export async function dbListVaultRoutes(principalId: string, itemId: string): Promise<VaultRouteRow[]> {
  return query<VaultRouteRow>(
    `SELECT ${VAULT_ROUTE_COLUMNS}
     FROM octo.vault_routes
     WHERE principal_id = $1 AND item_id = $2
     ORDER BY created_at ASC`,
    [principalId, itemId]
  );
}

/** Every route the owner has, for the health pass. */
export async function dbListVaultRoutesForPrincipal(principalId: string): Promise<VaultRouteRow[]> {
  return query<VaultRouteRow>(
    `SELECT ${VAULT_ROUTE_COLUMNS}
     FROM octo.vault_routes
     WHERE principal_id = $1
     ORDER BY created_at ASC`,
    [principalId]
  );
}

export async function dbGetVaultRoute(principalId: string, routeId: string): Promise<VaultRouteRow | null> {
  const rows = await query<VaultRouteRow>(
    `SELECT ${VAULT_ROUTE_COLUMNS}
     FROM octo.vault_routes
     WHERE principal_id = $1 AND id = $2`,
    [principalId, routeId]
  );
  return rows[0] ?? null;
}

export async function dbInsertVaultRoute(input: {
  id: string;
  principalId: string;
  itemId: string;
  routeKey: string;
  name: string;
  baseUrl: string;
  authScheme: string;
  authHeader: string | null;
  bodyField: string | null;
  basicUsername: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO octo.vault_routes (
       id, principal_id, item_id, route_key, name, base_url, auth_scheme, auth_header, body_field, basic_username
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      input.principalId,
      input.itemId,
      input.routeKey,
      input.name,
      input.baseUrl,
      input.authScheme,
      input.authHeader,
      input.bodyField,
      input.basicUsername,
    ]
  );
}

export async function dbDeleteVaultRoute(principalId: string, itemId: string, routeId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM octo.vault_routes WHERE principal_id = $1 AND item_id = $2 AND id = $3 RETURNING id',
    [principalId, itemId, routeId]
  );
  return rows.length > 0;
}

/**
 * Writes the health of one route. Service path: the relay calls this with no
 * session, and the health pass passes the owner's principal explicitly.
 */
export async function dbUpdateVaultRouteHealth(
  principalId: string,
  routeId: string,
  status: string,
  detail: string | null
): Promise<void> {
  await queryService(
    `UPDATE octo.vault_routes
     SET health_status = $3,
         health_detail = $4,
         last_health_at = now(),
         updated_at = now()
     WHERE principal_id = $1 AND id = $2`,
    [principalId, routeId, status, detail]
  );
}

/** Routes of one item, for the grant-facing cabinet and the mint response. */
export async function dbListVaultRoutesForGrant(itemId: string): Promise<VaultRouteRow[]> {
  return queryService<VaultRouteRow>(
    `SELECT ${VAULT_ROUTE_COLUMNS}
     FROM octo.vault_routes
     WHERE item_id = $1
     ORDER BY created_at ASC`,
    [itemId]
  );
}

/** Every route in one cabinet, so the open payload is one query, not one per item. */
export async function dbListVaultRoutesForCabinet(
  principalId: string,
  workspaceId: string | null
): Promise<VaultRouteRow[]> {
  return queryService<VaultRouteRow>(
    `SELECT ${VAULT_ROUTE_COLUMNS}
     FROM octo.vault_routes
     WHERE principal_id = $1
       AND item_id IN (
         SELECT id FROM octo.vault_items
         WHERE principal_id = $1 AND workspace_id IS NOT DISTINCT FROM $2::uuid
       )
     ORDER BY created_at ASC`,
    [principalId, workspaceId]
  );
}

// --- Vault leases (temp working keys) ---------------------------------------

export interface VaultLeaseRow {
  id: string;
  itemId: string;
  itemLabel: string;
  parentGrantId: string;
  prefix: string;
  name: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function dbListVaultLeases(principalId: string): Promise<VaultLeaseRow[]> {
  return query<VaultLeaseRow>(
    `SELECT l.id,
            l.item_id AS "itemId",
            i.label AS "itemLabel",
            l.parent_grant_id AS "parentGrantId",
            l.prefix,
            l.name,
            l.expires_at AS "expiresAt",
            l.revoked_at AS "revokedAt",
            l.created_at AS "createdAt",
            l.last_used_at AS "lastUsedAt"
     FROM octo.vault_leases l
     JOIN octo.vault_items i ON i.id = l.item_id
     WHERE l.principal_id = $1
     ORDER BY l.created_at DESC`,
    [principalId]
  );
}

export async function dbRevokeVaultLease(principalId: string, leaseId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE octo.vault_leases
     SET revoked_at = now()
     WHERE principal_id = $1 AND id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [principalId, leaseId]
  );
  return rows.length > 0;
}

/**
 * Mints a lease for a grant. The agent has no session, so this runs on the
 * service pool. An active lease for the same (grant, item) is rotated out in
 * the same transaction, which the partial unique index also enforces.
 */
export async function dbInsertVaultLeaseService(input: {
  id: string;
  principalId: string;
  itemId: string;
  parentGrantId: string;
  keyHash: string;
  prefix: string;
  name: string;
  expiresAt: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE octo.vault_leases
       SET revoked_at = now()
       WHERE parent_grant_id = $1 AND item_id = $2 AND revoked_at IS NULL`,
      [input.parentGrantId, input.itemId]
    );
    await client.query(
      `INSERT INTO octo.vault_leases (
         id, principal_id, item_id, parent_grant_id, key_hash, prefix, name, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.id,
        input.principalId,
        input.itemId,
        input.parentGrantId,
        input.keyHash,
        input.prefix,
        input.name,
        input.expiresAt,
      ]
    );
  }, servicePool);
}

/** Extends a live lease. Returns the new expiry, or null when it is gone. */
export async function dbRenewVaultLease(keyHash: string, days: number): Promise<string | null> {
  const rows = await queryService<{ expiresAt: string }>(
    `UPDATE octo.vault_leases
     SET expires_at = now() + make_interval(days => $2)
     WHERE key_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING expires_at AS "expiresAt"`,
    [keyHash, days]
  );
  return rows[0]?.expiresAt ?? null;
}

/** Introspection for the holder of a working key. Service path: no session. */
export async function dbGetVaultLeaseByKey(keyHash: string): Promise<VaultLeaseRow | null> {
  const rows = await queryService<VaultLeaseRow>(
    `SELECT l.id,
            l.item_id AS "itemId",
            i.label AS "itemLabel",
            l.parent_grant_id AS "parentGrantId",
            l.prefix,
            l.name,
            l.expires_at AS "expiresAt",
            l.revoked_at AS "revokedAt",
            l.created_at AS "createdAt",
            l.last_used_at AS "lastUsedAt"
     FROM octo.vault_leases l
     JOIN octo.vault_items i ON i.id = l.item_id
     WHERE l.key_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now()`,
    [keyHash]
  );
  return rows[0] ?? null;
}

export interface ConsumedVaultLease {
  leaseId: string;
  principalId: string;
  itemId: string;
  routeId: string;
  baseUrl: string;
  authScheme: string;
  authHeader: string | null;
  bodyField: string | null;
  basicUsername: string | null;
  itemUsername: string | null;
  secretEncrypted: string | null;
  expiresAt: string;
}

export async function dbConsumeVaultLease(keyHash: string, routeKey: string): Promise<ConsumedVaultLease | null> {
  const rows = await queryService<ConsumedVaultLease>(
    `SELECT lease_id AS "leaseId",
            principal_id AS "principalId",
            item_id AS "itemId",
            route_id AS "routeId",
            base_url AS "baseUrl",
            auth_scheme AS "authScheme",
            auth_header AS "authHeader",
            body_field AS "bodyField",
            basic_username AS "basicUsername",
            item_username AS "itemUsername",
            secret_encrypted AS "secretEncrypted",
            expires_at AS "expiresAt"
     FROM octo.consume_vault_lease($1, $2)`,
    [keyHash, routeKey]
  );
  return rows[0] ?? null;
}
