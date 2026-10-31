/**
 * Workspaces: list, create, delete, and per-workspace database provisioning.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { hashApiKeySecret } from '../api/keys';
import { encryptSecret } from '../lib/mfa';
import { deleteUmamiWebsite, umamiConfigured } from '../lib/umami';
import { authenticateRequest, effectiveWorkspaceRole, requireScope, scopeDenied } from '../server/auth-context';
import { autoProvisionWorkspaceDatabase } from '../server/auto-provision';
import { confirmGate } from '../server/confirm';
import { dbCountTransientFiles, dbCreateWorkspaceAtomic, dbDeleteWorkspaceAtomic, dbGetAuthorizedWorkspaces, dbGetWorkspaceById, dbGetWorkspaceDatabase, dbGetWorkspaceMembership, dbGetWorkspaceUmami, dbInsertWorkspaceDatabase, dbListWorkspaceStorageKeys, dbRecordActivity, dbSetWorkspaceDatabaseCredential, query } from '../server/db';
import { readJsonObject, sendJson } from '../server/http';
import { dropProvisionedDatabase, provisionDatabase, provisioningConfigured } from '../server/provisioning';
import { graphClient, UUID_PATTERN } from '../server/runtime';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleWorkspacesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 3. Workspaces: GET /api/workspaces
  if (pathname === '/api/workspaces' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
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
        return true;
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
      return true;
    }

    // Account-wide API key or user session: query all authorized workspaces from PostgreSQL
    const workspaces = await dbGetAuthorizedWorkspaces(auth.principal.id);
    sendJson(res, 200, workspaces);
    return true;
  }

  // 3b. Create a workspace: POST /api/workspaces
  // Workspace = database: the creator becomes owner and the workspace's single
  // API key is minted in the same transaction, so a workspace can never exist
  // without its key. The raw key secret is returned exactly once, here.
  if (pathname === '/api/workspaces' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }
    // A workspace-scoped key is pinned to one workspace and cannot mint more.
    if (auth.apiKey && auth.apiKey.workspaceId) {
      sendJson(res, 403, {
        error: 'FORBIDDEN: A workspace-scoped key cannot create workspaces',
      });
      return true;
    }

    const parsed = await readJsonObject(req);
    const { name, slug, description, retentionDays } = parsed;

    if (!name || typeof name !== 'string' || !slugify(name)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: a name that slugifies to at least one character is required' });
      return true;
    }
    let retentionDaysValue: number | null = null;
    if (retentionDays !== undefined && retentionDays !== null) {
      if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays <= 0) {
        sendJson(res, 400, { error: 'BAD_REQUEST: retentionDays must be a positive integer' });
        return true;
      }
      retentionDaysValue = retentionDays;
    }

    const resolvedSlug = typeof slug === 'string' && slug.trim() ? slugify(slug) : slugify(name);
    if (!resolvedSlug) {
      sendJson(res, 400, { error: 'BAD_REQUEST: slug is empty' });
      return true;
    }

    // Creating a workspace mints a tenancy boundary and its first key. Like
    // deletion, it is stamped by a human session plus the confirmation secret,
    // so an agent holding the account-wide key cannot create workspaces at all.
    // When the principal has MFA enrolled, a valid code is required too.
    if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
      return true;

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
        return true;
      }
      if ((err as { code?: string }).code === 'WORKSPACE_DAILY_LIMIT') {
        sendJson(res, 429, {
          error: 'WORKSPACE_DAILY_LIMIT: You can create one workspace per day. Try again after 24 hours.',
        });
        return true;
      }
      throw err;
    }
    return true;
  }

  // 3c. Delete a workspace: DELETE /api/workspaces/:id
  // Destructive: owner-only, gated on the human confirmation secret plus the
  // typed slug, and refused while any file is mid-archive so a copy in flight
  // cannot be orphaned.
  if (pathname.startsWith('/api/workspaces/') && req.method === 'DELETE') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }

    const workspaceId = pathname.slice('/api/workspaces/'.length);
    if (!UUID_PATTERN.test(workspaceId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
      return true;
    }

    const parsed = await readJsonObject(req);
    // Deletion is the most destructive command, so it is the first to require a
    // per-principal MFA step-up: when the principal has an authenticator enrolled,
    // a valid TOTP code (or a one-time recovery code) is required in addition to
    // the confirmation secret. Principals without MFA enrolled are unaffected.
    if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
      return true;

    const workspace = await dbGetWorkspaceById(workspaceId);
    if (!workspace) {
      sendJson(res, 404, { error: 'WORKSPACE_NOT_FOUND' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    // A platform owner may delete any workspace; the gate above already required
    // a human session, so this override is never reachable by an API key.
    if (mem?.role !== 'owner' && !auth.principal.isPlatformOwner) {
      sendJson(res, 403, { error: 'FORBIDDEN: Owner role required to delete a workspace' });
      return true;
    }

    if (parsed.confirmSlug !== workspace.slug) {
      sendJson(res, 403, {
        error: `CONFIRM_SLUG_MISMATCH: type the workspace slug '${workspace.slug}' to confirm`,
      });
      return true;
    }

    // Refuse while a copy is in flight: deleting now would orphan the bytes.
    if ((await dbCountTransientFiles(workspaceId)) > 0) {
      sendJson(res, 409, {
        error: 'WORKSPACE_BUSY: a file is mid-archive; wait for it to settle and retry',
      });
      return true;
    }

    const storageKeys = await dbListWorkspaceStorageKeys(workspaceId);

    // Read the catalog row before the delete: the cascade removes it, and the
    // database and role it names are not reachable by any cascade.
    const provisioned = await dbGetWorkspaceDatabase(workspaceId);
    const umami = await dbGetWorkspaceUmami(workspaceId);

    // The transaction re-checks the transient state, closing the window between
    // the pre-check above and the delete.
    if (!(await dbDeleteWorkspaceAtomic(workspaceId))) {
      sendJson(res, 409, {
        error: 'WORKSPACE_BUSY: a file entered a transient archive state during delete',
      });
      return true;
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

    // The workspace's Umami website and team (#400) go with it. Best effort too.
    if (umami?.websiteId && umamiConfigured()) {
      try {
        await deleteUmamiWebsite(umami.teamId, umami.websiteId);
      } catch (err) {
        console.error(
          `[workspaces] failed to delete Umami website ${umami.websiteId}:`,
          err instanceof Error ? err.message : String(err)
        );
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
    return true;
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
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }
    if (auth.apiKey && auth.apiKey.workspaceId) {
      sendJson(res, 403, {
        error: 'FORBIDDEN: A workspace-scoped key cannot provision databases',
      });
      return true;
    }

    const workspaceId = pathname.slice('/api/workspaces/'.length, -'/database'.length);
    if (!UUID_PATTERN.test(workspaceId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
      return true;
    }

    const workspace = await dbGetWorkspaceById(workspaceId);
    if (!workspace) {
      sendJson(res, 404, { error: 'WORKSPACE_NOT_FOUND' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem && !auth.principal.isPlatformOwner) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    if (await dbGetWorkspaceDatabase(workspaceId)) {
      sendJson(res, 409, {
        error: 'DATABASE_EXISTS: this workspace already has a provisioned database',
      });
      return true;
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
    return true;
  }

  return false;
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
