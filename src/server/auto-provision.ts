/**
 * Provisions a newly created workspace's own Postgres database so a workspace
 * arrives with its data plane in place.
 */

import { encryptSecret } from '../lib/mfa';
import { dbGetWorkspaceDatabase, dbInsertWorkspaceDatabase, dbRecordActivity, dbSetWorkspaceDatabaseCredential } from './db';
import { provisionDatabase, provisioningConfigured } from './provisioning';
import { randomUUID } from 'crypto';

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
export async function autoProvisionWorkspaceDatabase(
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
