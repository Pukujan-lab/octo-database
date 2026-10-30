/**
 * API keys: list, mint, rescope, revoke.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { KEY_CLASSES, KeyClass } from '../api/capabilities';
import { authorizeKeyMint, hashApiKeySecret, parseKeyScopes } from '../api/keys';
import { authenticateRequest, requireScope, scopeDenied } from '../server/auth-context';
import { confirmGate } from '../server/confirm';
import { dbGetWorkspaceMembership, dbInsertApiKey, dbListApiKeys, dbUpdateApiKeyScopes, query } from '../server/db';
import { readJsonObject, sendJson } from '../server/http';
import { UUID_PATTERN } from '../server/runtime';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleKeysRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 8. API Keys: GET & POST /api/keys
  if (pathname === '/api/keys' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
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
    return true;
  }

  if (pathname === '/api/keys' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
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
      return true;
    }

    let expiresAt: string | null = null;
    if (expiresInDays !== undefined && expiresInDays !== null) {
      if (!Number.isInteger(expiresInDays as number) || (expiresInDays as number) <= 0) {
        sendJson(res, 400, { error: 'BAD_REQUEST: expiresInDays must be a positive integer' });
        return true;
      }
      const d = new Date();
      d.setDate(d.getDate() + (expiresInDays as number));
      // A large enough day count overflows the Date range; refuse it rather than
      // letting toISOString() throw `Invalid time value` as a 500.
      if (!Number.isFinite(d.getTime())) {
        sendJson(res, 400, { error: 'BAD_REQUEST: expiresInDays is out of range' });
        return true;
      }
      expiresAt = d.toISOString();
    }

    // A key class names a documented authority profile and expands to its
    // scopes; it is a preset over the real scopes, never a second
    // authorization dimension. Class and an explicit scope list are mutually
    // exclusive.
    if (keyClass !== undefined && requestedScopes !== undefined) {
      sendJson(res, 400, { error: 'BAD_REQUEST: keyClass and scopes are mutually exclusive' });
      return true;
    }

    // Default is non-destructive: a new token can read and write files but
    // cannot delete anything unless the delete scope is requested explicitly.
    let scopes: string[] = ['read', 'write', 'files'];
    if (keyClass !== undefined) {
      if (typeof keyClass !== 'string' || !Object.prototype.hasOwnProperty.call(KEY_CLASSES, keyClass)) {
        sendJson(res, 400, {
          error: `BAD_REQUEST: keyClass must be one of: ${Object.keys(KEY_CLASSES).join(', ')}`,
        });
        return true;
      }
      scopes = [...KEY_CLASSES[keyClass as KeyClass].scopes];
    } else if (requestedScopes !== undefined) {
      const parsedScopes = parseKeyScopes(requestedScopes);
      if (!parsedScopes.ok) {
        sendJson(res, 400, { error: parsedScopes.error });
        return true;
      }
      scopes = parsedScopes.scopes;
    }

    if (
      requestedWorkspaceId !== undefined &&
      requestedWorkspaceId !== null &&
      typeof requestedWorkspaceId !== 'string'
    ) {
      sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a UUID string' });
      return true;
    }
    let workspaceId: string | null =
      typeof requestedWorkspaceId === 'string' ? requestedWorkspaceId : null;
    if (workspaceId !== null && !UUID_PATTERN.test(workspaceId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: workspaceId must be a valid UUID' });
      return true;
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
      return true;
    }
    workspaceId = decision.workspaceId;
    scopes = decision.scopes;

    // If workspace-scoped key requested, verify caller belongs to that workspace
    if (workspaceId) {
      const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
      if (!mem) {
        sendJson(res, 403, { error: 'FORBIDDEN: Cannot create API key for non-member workspace' });
        return true;
      }
    }

    // Minting a credential grants authority, so it carries the same human stamp
    // as workspace creation and deletion: a human session plus the confirmation
    // secret. An API-key caller is refused outright, so a leaked agent token
    // cannot mint itself a wider key. When the principal has MFA enrolled, a
    // valid code is required too.
    if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
      return true;

    const isAccountWide = !workspaceId;

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
    return true;
  }

  // 8a. Edit allowances on an existing key: PATCH /api/keys/:id
  // The secret does not change. A human session must confirm, so a key cannot
  // widen itself.
  if (pathname.startsWith('/api/keys/') && req.method === 'PATCH') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }

    const keyId = pathname.slice('/api/keys/'.length);
    if (!keyId || !UUID_PATTERN.test(keyId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: keyId must be a valid UUID' });
      return true;
    }

    const parsed = await readJsonObject(req);
    const parsedScopes = parseKeyScopes(parsed.scopes);
    if (!parsedScopes.ok) {
      sendJson(res, 400, { error: parsedScopes.error });
      return true;
    }

    if (!(await confirmGate(res, auth, parsed.confirmSecret, { requireMfa: true, mfaCode: parsed.mfaCode })))
      return true;

    const updated = await dbUpdateApiKeyScopes(keyId, auth.principal.id, parsedScopes.scopes);
    if (!updated) {
      sendJson(res, 404, { error: 'KEY_NOT_FOUND: no such key owned by this principal' });
      return true;
    }

    sendJson(res, 200, { ...updated, isAccountWide: updated.workspaceId === null });
    return true;
  }

  // 8b. Revoke an API key: DELETE /api/keys/:id
  // Without this, a leaked agent token could never be withdrawn.
  if (pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    // Revoking a credential is destructive: a read-only or ingest token must
    // not be able to withdraw the account's keys.
    if (!requireScope(auth, 'delete')) {
      scopeDenied(res, 'delete');
      return true;
    }

    const keyId = pathname.slice('/api/keys/'.length);
    if (!keyId || !UUID_PATTERN.test(keyId)) {
      sendJson(res, 400, { error: 'BAD_REQUEST: keyId must be a valid UUID' });
      return true;
    }

    const rows = await query<{ id: string }>(
      'DELETE FROM octo.api_keys WHERE id = $1 AND principal_id = $2 RETURNING id',
      [keyId, auth.principal.id]
    );

    if (rows.length === 0) {
      sendJson(res, 404, { error: 'KEY_NOT_FOUND: no such key owned by this principal' });
      return true;
    }

    sendJson(res, 200, { success: true, keyId });
    return true;
  }

  return false;
}
