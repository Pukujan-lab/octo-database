/**
 * The workspace's own SQL surface.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { decryptSecret, encryptSecret } from '../lib/mfa';
import { authenticateRequest, keyWorkspaceMatches, requireScope, scopeDenied } from '../server/auth-context';
import { dbGetWorkspaceDatabase, dbGetWorkspaceDatabaseCredential, dbGetWorkspaceMembership, dbSetWorkspaceDatabaseCredential } from '../server/db';
import { readJsonObject, sendJson } from '../server/http';
import { rotateRolePassword } from '../server/provisioning';
import { DEFAULT_ROW_LIMIT, DEFAULT_STATEMENT_TIMEOUT_MS, isSqlError, MAX_ROW_LIMIT, runWorkspaceQuery } from '../server/query';
import { UUID_PATTERN } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleWorkspaceQueryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

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
      return true;
    }
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = pathname.slice('/api/workspaces/'.length, -'/query'.length);
    if (!UUID_PATTERN.test(workspaceId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
      return true;
    }

    const parsed = (await readJsonObject(req)) as Record<string, any>;
    const { sql, params, rowLimit } = parsed;
    if (typeof sql !== 'string' || !sql.trim()) {
      sendJson(res, 400, { error: 'BAD_REQUEST: sql is required' });
      return true;
    }

    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem && !auth.principal.isPlatformOwner) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    const database = await dbGetWorkspaceDatabase(workspaceId);
    if (!database) {
      sendJson(res, 404, {
        error: 'DATABASE_NOT_PROVISIONED: provision a database for this workspace first',
      });
      return true;
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
        return true;
      }
      throw err;
    }
    return true;
  }

  return false;
}
