/**
 * Password-manager cabinet and the temporary grant an agent pastes.
 *
 * Stored secrets use the AES-256-GCM envelope already used for TOTP seeds and
 * workspace database passwords (OCTO_MFA_SECRET). Grant tokens are hashed with
 * the same SHA-256 used for API keys. A grant is not an API key: it cannot
 * call the rest of Octo, and an API key cannot mint one.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { getPublicOrigin } from '../lib/public-origin';
import { hashApiKeySecret } from '../lib/secret-hash';
import { decryptSecret, encryptSecret } from '../lib/mfa';
import { buildRouteProbe, checkVaultItem, classifyRouteProbe } from '../lib/vault-health';
import {
  BULK_MAX_LINES,
  grantExpiresAt,
  inferVaultGroup,
  leaseExpiresAt,
  parseBulkVaultLine,
  parseGrantHours,
  parseLeaseDays,
  parseVaultItem,
  parseVaultRoute,
  presentVaultItem,
  routeKeySlug,
  STALE_PURGE_MS,
  type VaultItemInput,
  type VaultKind,
} from '../lib/vault-policy';
import { authenticateRequest } from '../server/auth-context';
import { confirmGate } from '../server/confirm';
import {
  dbConsumeVaultGrant,
  dbDeleteVaultGrant,
  dbDeleteVaultItem,
  dbDeleteVaultRoute,
  dbGetVaultItem,
  dbGetVaultRoute,
  dbGetWorkspaceMembership,
  dbInsertVaultGrant,
  dbInsertVaultGrantService,
  dbInsertVaultItem,
  dbInsertVaultItemsBulk,
  dbInsertVaultLeaseService,
  dbInsertVaultRoute,
  dbListVaultGrants,
  dbListVaultItems,
  dbListVaultItemsForGrant,
  dbListVaultLeases,
  dbListVaultRoutes,
  dbListVaultRoutesForCabinet,
  dbListVaultRoutesForGrant,
  dbListVaultRoutesForPrincipal,
  dbPurgeStaleVaultItems,
  dbRevokeVaultLease,
  dbUpdateVaultHealth,
  dbUpdateVaultItem,
  dbUpdateVaultRouteHealth,
  type VaultItemRow,
  type VaultRouteRow,
} from '../server/db';
import { readJsonObject, requireUuid, sendJson, type RouteHandler } from '../server/http';
import { UUID_PATTERN } from '../server/runtime';
import type { IncomingMessage, ServerResponse } from 'http';

const GRANT_PREFIX = 'octo_vault_';
const LEASE_PREFIX = 'octo_tmp_';

function bearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function vaultConfiguredError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('MFA_NOT_CONFIGURED');
}

function sendVaultUnavailable(res: ServerResponse): void {
  sendJson(res, 503, {
    error: 'VAULT_NOT_CONFIGURED: OCTO_MFA_SECRET is required to seal vault items.',
  });
}

function seal(value: string | null): string | null {
  if (!value) return null;
  return encryptSecret(value);
}

function openSeal(value: string | null): string | null {
  if (!value) return null;
  return decryptSecret(value);
}

function publicItem(row: VaultItemRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    description: row.description,
    kind: row.kind,
    kindSource: row.kindSource,
    group: inferVaultGroup(row.label),
    username: row.username,
    url: row.url,
    urlKind: row.urlKind,
    hasSecret: Boolean(row.secretEncrypted),
    hasNotes: Boolean(row.notesEncrypted),
    healthStatus: row.healthStatus,
    healthDetail: row.healthDetail,
    lastHealthAt: row.lastHealthAt,
    staleSince: row.staleSince,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicRoute(row: VaultRouteRow) {
  return {
    id: row.id,
    itemId: row.itemId,
    routeKey: row.routeKey,
    name: row.name,
    baseUrl: row.baseUrl,
    authScheme: row.authScheme,
    authHeader: row.authHeader,
    bodyField: row.bodyField,
    basicUsername: row.basicUsername,
    healthStatus: row.healthStatus,
    healthDetail: row.healthDetail,
    lastHealthAt: row.lastHealthAt,
    createdAt: row.createdAt,
  };
}

function agentItem(row: VaultItemRow, grantId: string, decoy: boolean) {
  return presentVaultItem({
    id: row.id,
    label: row.label,
    description: row.description,
    kind: row.kind,
    username: row.username,
    url: row.url,
    secret: openSeal(row.secretEncrypted),
    notes: openSeal(row.notesEncrypted),
    healthStatus: row.healthStatus,
    grantId,
    decoy,
  });
}

function mintToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${GRANT_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashApiKeySecret(raw), prefix: raw.slice(0, 18) };
}

function mintLeaseToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${LEASE_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashApiKeySecret(raw), prefix: raw.slice(0, 16) };
}

/** What the agent needs to use a route: where to send the working key, and how. */
function relayRoute(origin: string, route: VaultRouteRow) {
  return {
    routeKey: route.routeKey,
    name: route.name,
    baseUrl: route.baseUrl,
    authScheme: route.authScheme,
    url: `${origin}/api/vault/relay/${route.routeKey}`,
  };
}

async function workspaceAllowed(
  res: ServerResponse,
  principalId: string,
  workspaceId: string | null
): Promise<boolean> {
  if (!workspaceId) return true;
  if (!UUID_PATTERN.test(workspaceId)) {
    sendJson(res, 400, { error: 'INVALID_WORKSPACE_ID: workspaceId must be a UUID.' });
    return false;
  }
  const membership = await dbGetWorkspaceMembership(workspaceId, principalId);
  if (!membership) {
    sendJson(res, 403, { error: 'FORBIDDEN: that workspace is not on this account.' });
    return false;
  }
  return true;
}

export const handleVaultRoutes: RouteHandler = async (req, res, url) => {
  const path = url.pathname;
  if (!path.startsWith('/api/vault')) return false;

  try {
    if (path === '/api/vault/open' && req.method === 'GET') return openCabinet(req, res, url);
    if (path === '/api/vault/open/decoy' && req.method === 'POST') return mintDecoy(req, res);
    if (path === '/api/vault/open/lease' && req.method === 'POST') return mintLease(req, res, url);

    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHORIZED: sign in to use the vault.' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, { error: 'FORBIDDEN: an API key cannot open the vault. Mint a vault grant from the dashboard.' });
      return true;
    }

    if (path === '/api/vault/items' && req.method === 'GET') {
      const items = await dbListVaultItems(auth.principal.id);
      sendJson(res, 200, { items: items.map(publicItem) });
      return true;
    }

    if (path === '/api/vault/items' && req.method === 'POST') {
      const body = await readJsonObject(req);
      if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
        return true;
      }
      const workspaceId = body['workspaceId'];
      const scope = workspaceId === undefined || workspaceId === null || workspaceId === '' ? null : String(workspaceId);
      if (!(await workspaceAllowed(res, auth.principal.id, scope))) return true;
      const parsed = parseVaultItem(body, scope);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.error });
        return true;
      }
      const id = randomUUID();
      await dbInsertVaultItem({
        id,
        principalId: auth.principal.id,
        workspaceId: parsed.value.workspaceId,
        label: parsed.value.label,
        description: parsed.value.description,
        kind: parsed.value.kind,
        username: parsed.value.username,
        url: parsed.value.url,
        urlKind: parsed.value.urlKind,
        secretEncrypted: seal(parsed.value.secret),
        notesEncrypted: seal(parsed.value.notes),
      });
      const created = await dbGetVaultItem(auth.principal.id, id);
      sendJson(res, 201, { item: created ? publicItem(created) : { id } });
      return true;
    }

    if (path === '/api/vault/items/bulk' && req.method === 'POST') {
      const body = await readJsonObject(req);
      const rawLines = body['lines'];
      if (!Array.isArray(rawLines) || rawLines.some((line) => typeof line !== 'string')) {
        sendJson(res, 400, { error: 'BULK_LINES: lines must be an array of LABEL=secret strings.' });
        return true;
      }
      const lines = (rawLines as string[]).map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) {
        sendJson(res, 400, { error: 'BULK_LINES: paste at least one LABEL=secret line.' });
        return true;
      }
      if (lines.length > BULK_MAX_LINES) {
        sendJson(res, 400, { error: `BULK_TOO_LARGE: at most ${BULK_MAX_LINES} lines per paste.` });
        return true;
      }
      // The kind is per line now: a `kind:` prefix overrides, otherwise the
      // label infers it. The batch-wide selector is gone.
      const workspaceId = body['workspaceId'];
      const scope = workspaceId === undefined || workspaceId === null || workspaceId === '' ? null : String(workspaceId);
      if (!(await workspaceAllowed(res, auth.principal.id, scope))) return true;

      // Validate every line before the gate so a malformed paste never
      // consumes the one-time code.
      const parsed: VaultItemInput[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const item = parseBulkVaultLine(lines[index]!, null, scope);
        if (!item.ok) {
          sendJson(res, 400, { error: `Line ${index + 1}: ${item.error.replace('BULK_LINE: ', '')}` });
          return true;
        }
        parsed.push(item.value);
      }

      if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
        return true;
      }
      await dbInsertVaultItemsBulk(
        auth.principal.id,
        parsed.map((item) => ({
          workspaceId: item.workspaceId,
          label: item.label,
          description: item.description,
          kind: item.kind,
          kindSource: item.kindSource,
          username: item.username,
          url: item.url,
          urlKind: item.urlKind,
          secretEncrypted: seal(item.secret),
          notesEncrypted: seal(item.notes),
        }))
      );
      sendJson(res, 201, { inserted: parsed.length });
      return true;
    }

    const routeMatch = path.match(/^\/api\/vault\/items\/([^/]+)\/routes$/);
    if (routeMatch) {
      const itemId = routeMatch[1] ?? '';
      if (!requireUuid(res, itemId, 'itemId')) return true;

      if (req.method === 'GET') {
        const routes = await dbListVaultRoutes(auth.principal.id, itemId);
        sendJson(res, 200, { routes: routes.map(publicRoute) });
        return true;
      }

      if (req.method === 'POST') {
        const body = await readJsonObject(req);
        if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
          return true;
        }
        const item = await dbGetVaultItem(auth.principal.id, itemId);
        if (!item) {
          sendJson(res, 404, { error: 'NOT_FOUND: no vault item with that id.' });
          return true;
        }
        if ((item.kind !== 'token' && item.kind !== 'login') || !item.secretEncrypted) {
          sendJson(res, 400, {
            error: 'ROUTE_ITEM_INVALID: only a token or login with a stored secret can have a route.',
          });
          return true;
        }
        const parsed = parseVaultRoute(body);
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return true;
        }
        const routeKey = parsed.value.routeKey ?? `${routeKeySlug(parsed.value.name)}-${randomBytes(3).toString('hex')}`;
        const id = randomUUID();
        try {
          await dbInsertVaultRoute({
            id,
            principalId: auth.principal.id,
            itemId,
            routeKey,
            name: parsed.value.name,
            baseUrl: parsed.value.baseUrl,
            authScheme: parsed.value.authScheme,
            authHeader: parsed.value.authHeader,
            bodyField: parsed.value.bodyField,
            basicUsername: parsed.value.basicUsername,
          });
        } catch (error) {
          if (error instanceof Error && error.message.includes('vault_routes_route_key_key')) {
            sendJson(res, 409, { error: 'ROUTE_KEY_TAKEN: that routeKey is already used by another route.' });
            return true;
          }
          throw error;
        }
        const created = await dbGetVaultRoute(auth.principal.id, id);
        sendJson(res, 201, { route: created ? publicRoute(created) : { id, routeKey } });
        return true;
      }
    }

    const routeDeleteMatch = path.match(/^\/api\/vault\/items\/([^/]+)\/routes\/([^/]+)$/);
    if (routeDeleteMatch && req.method === 'DELETE') {
      const itemId = routeDeleteMatch[1] ?? '';
      const routeId = routeDeleteMatch[2] ?? '';
      if (!requireUuid(res, itemId, 'itemId')) return true;
      if (!requireUuid(res, routeId, 'routeId')) return true;
      const body = await readJsonObject(req);
      if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
        return true;
      }
      const removed = await dbDeleteVaultRoute(auth.principal.id, itemId, routeId);
      if (!removed) {
        sendJson(res, 404, { error: 'NOT_FOUND: no route with that id on that item.' });
        return true;
      }
      sendJson(res, 200, { deleted: routeId });
      return true;
    }

    const itemMatch = path.match(/^\/api\/vault\/items\/([^/]+)$/);
    if (itemMatch) {
      const itemId = itemMatch[1] ?? '';
      if (!requireUuid(res, itemId, 'itemId')) return true;
      if (req.method === 'GET') {
        const row = await dbGetVaultItem(auth.principal.id, itemId);
        if (!row) {
          sendJson(res, 404, { error: 'NOT_FOUND: no vault item with that id.' });
          return true;
        }
        sendJson(res, 200, {
          item: {
            ...publicItem(row),
            secret: openSeal(row.secretEncrypted),
            notes: openSeal(row.notesEncrypted),
          },
        });
        return true;
      }
      if (req.method === 'PATCH') {
        const body = await readJsonObject(req);
        if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
          return true;
        }
        const existing = await dbGetVaultItem(auth.principal.id, itemId);
        if (!existing) {
          sendJson(res, 404, { error: 'NOT_FOUND: no vault item with that id.' });
          return true;
        }
        // An edit that leaves the secret alone sends no `secret` key at all, so
        // the stored value is validated in its place and written back unchanged.
        const secretReplaced = Object.prototype.hasOwnProperty.call(body, 'secret');
        const parsed = parseVaultItem(
          { ...body, secret: secretReplaced ? body['secret'] : openSeal(existing.secretEncrypted) },
          existing.workspaceId
        );
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return true;
        }
        await dbUpdateVaultItem({
          principalId: auth.principal.id,
          itemId,
          label: parsed.value.label,
          description: parsed.value.description,
          kind: parsed.value.kind,
          // A kind the person picked is no longer an inference.
          kindSource: parsed.value.kind === existing.kind ? existing.kindSource : 'explicit',
          username: parsed.value.username,
          url: parsed.value.url,
          urlKind: parsed.value.urlKind,
          secretEncrypted: secretReplaced ? seal(parsed.value.secret) : existing.secretEncrypted,
          notesEncrypted: seal(parsed.value.notes),
          secretReplaced,
        });
        const updated = await dbGetVaultItem(auth.principal.id, itemId);
        sendJson(res, 200, { item: updated ? publicItem(updated) : { id: itemId } });
        return true;
      }
      if (req.method === 'DELETE') {
        const body = await readJsonObject(req);
        if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
          return true;
        }
        const removed = await dbDeleteVaultItem(auth.principal.id, itemId);
        if (!removed) {
          sendJson(res, 404, { error: 'NOT_FOUND: no vault item with that id.' });
          return true;
        }
        sendJson(res, 200, { deleted: itemId });
        return true;
      }
    }

    if (path === '/api/vault/leases' && req.method === 'GET') {
      const leases = await dbListVaultLeases(auth.principal.id);
      sendJson(res, 200, { leases });
      return true;
    }

    const leaseMatch = path.match(/^\/api\/vault\/leases\/([^/]+)$/);
    if (leaseMatch && req.method === 'DELETE') {
      const leaseId = leaseMatch[1] ?? '';
      if (!requireUuid(res, leaseId, 'leaseId')) return true;
      const body = await readJsonObject(req);
      if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
        return true;
      }
      const revoked = await dbRevokeVaultLease(auth.principal.id, leaseId);
      if (!revoked) {
        sendJson(res, 404, { error: 'NOT_FOUND: no active working key with that id.' });
        return true;
      }
      sendJson(res, 200, { revoked: leaseId });
      return true;
    }

    if (path === '/api/vault/grants' && req.method === 'GET') {
      const grants = await dbListVaultGrants(auth.principal.id);
      sendJson(res, 200, { grants });
      return true;
    }

    if (path === '/api/vault/grants' && req.method === 'POST') {
      const body = await readJsonObject(req);
      if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
        return true;
      }
      const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
      if (!name || name.length > 200) {
        sendJson(res, 400, { error: 'NAME_REQUIRED: name the grant.' });
        return true;
      }
      const hours = parseGrantHours(body['expiresInHours']);
      if (!hours.ok) {
        sendJson(res, 400, { error: hours.error });
        return true;
      }
      const workspaceId = body['workspaceId'];
      const scope = workspaceId === undefined || workspaceId === null || workspaceId === '' ? null : String(workspaceId);
      if (!(await workspaceAllowed(res, auth.principal.id, scope))) return true;
      const token = mintToken();
      const id = randomUUID();
      const expiresAt = grantExpiresAt(hours.hours);
      await dbInsertVaultGrant({
        id,
        principalId: auth.principal.id,
        workspaceId: scope,
        parentGrantId: null,
        keyHash: token.hash,
        prefix: token.prefix,
        name,
        decoy: false,
        expiresAt,
      });
      sendJson(res, 201, {
        grant: { id, name, prefix: token.prefix, workspaceId: scope, decoy: false, expiresAt },
        rawSecret: token.raw,
      });
      return true;
    }

    const grantMatch = path.match(/^\/api\/vault\/grants\/([^/]+)$/);
    if (grantMatch && req.method === 'DELETE') {
      const grantId = grantMatch[1] ?? '';
      if (!requireUuid(res, grantId, 'grantId')) return true;
      const body = await readJsonObject(req);
      if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
        return true;
      }
      const removed = await dbDeleteVaultGrant(auth.principal.id, grantId);
      if (!removed) {
        sendJson(res, 404, { error: 'NOT_FOUND: no vault grant with that id.' });
        return true;
      }
      sendJson(res, 200, { deleted: grantId });
      return true;
    }

    if (path === '/api/vault/health' && req.method === 'POST') {
      const body = await readJsonObject(req);
      if (!(await confirmGate(res, auth, body['confirmSecret'], { requireMfa: true, mfaCode: body['mfaCode'] }))) {
        return true;
      }
      const items = await dbListVaultItems(auth.principal.id);
      const checked: Array<{ id: string; healthStatus: string; healthDetail: string }> = [];
      for (const item of items) {
        // A kind inferred from a label is not evidence the value can be
        // probed. Skipping inferred rows keeps a 404 on a backfilled base URL
        // from marking a live key stale (and eventually purging it).
        if (item.kindSource === 'inferred') continue;
        const secret = openSeal(item.secretEncrypted);
        const verdict = await checkVaultItem(
          {
            kind: item.kind as VaultKind,
            url: item.url,
            createdAtMs: Date.parse(item.createdAt),
          },
          secret,
          liveProbe
        );
        await dbUpdateVaultHealth(auth.principal.id, item.id, verdict.status, verdict.detail);
        checked.push({ id: item.id, healthStatus: verdict.status, healthDetail: verdict.detail });
      }

      // Routes are probed with the same request the relay would send, so the
      // answer reflects what an agent would actually get back from the vendor.
      const byItem = new Map(items.map((item) => [item.id, item]));
      const routes = await dbListVaultRoutesForPrincipal(auth.principal.id);
      const checkedRoutes: Array<{ id: string; routeKey: string; healthStatus: string; healthDetail: string }> = [];
      for (const route of routes) {
        const item = byItem.get(route.itemId);
        if (!item) continue;
        const secret = openSeal(item.secretEncrypted);
        if (!secret) continue;
        const request = buildRouteProbe(
          {
            baseUrl: route.baseUrl,
            authScheme: route.authScheme,
            authHeader: route.authHeader,
            bodyField: route.bodyField,
            basicUsername: route.basicUsername,
            itemUsername: item.username,
            routeKey: route.routeKey,
          },
          secret
        );
        // A body_json route only proves itself when a caller sends a body.
        if (!request) continue;
        const status = await liveProbe(request.url, request.headers, 'GET');
        const health = classifyRouteProbe(status);
        await dbUpdateVaultRouteHealth(auth.principal.id, route.id, health.status, health.detail);
        checkedRoutes.push({
          id: route.id,
          routeKey: route.routeKey,
          healthStatus: health.status,
          healthDetail: health.detail,
        });
      }

      const cutoff = new Date(Date.now() - STALE_PURGE_MS).toISOString();
      const purged = await dbPurgeStaleVaultItems(auth.principal.id, cutoff);
      sendJson(res, 200, { checked, checkedRoutes, purged });
      return true;
    }

    sendJson(res, 404, { error: 'NOT_FOUND: no vault route at that path.' });
    return true;
  } catch (error) {
    if (vaultConfiguredError(error)) {
      sendVaultUnavailable(res);
      return true;
    }
    throw error;
  }
};

async function liveProbe(url: string, headers: Record<string, string>, method: 'GET' | 'HEAD'): Promise<number | 'error'> {
  try {
    const response = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
    return response.status;
  } catch {
    return 'error';
  }
}

async function loadGrant(req: IncomingMessage, res: ServerResponse) {
  const token = bearer(req);
  if (!token?.startsWith(GRANT_PREFIX)) {
    sendJson(res, 401, { error: 'UNAUTHORIZED: paste a vault grant.' });
    return null;
  }
  const grant = await dbConsumeVaultGrant(hashApiKeySecret(token));
  if (!grant) {
    sendJson(res, 401, { error: 'UNAUTHORIZED: that vault grant is expired or unknown.' });
    return null;
  }
  return grant;
}

async function openCabinet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const grant = await loadGrant(req, res);
  if (!grant) return true;
  const [rows, routes] = await Promise.all([
    dbListVaultItemsForGrant(grant.principalId, grant.workspaceId),
    dbListVaultRoutesForCabinet(grant.principalId, grant.workspaceId),
  ]);
  const byItem = new Map<string, VaultRouteRow[]>();
  for (const route of routes) {
    const list = byItem.get(route.itemId) ?? [];
    list.push(route);
    byItem.set(route.itemId, list);
  }
  const origin = getPublicOrigin(req, url);
  sendJson(res, 200, {
    cabinet: grant.workspaceId ? 'workspace' : 'account',
    workspaceId: grant.workspaceId,
    expiresAt: grant.expiresAt,
    items: rows.map((row) => ({
      ...agentItem(row, grant.grantId, grant.decoy),
      routes: (byItem.get(row.id) ?? []).map((route) => relayRoute(origin, route)),
    })),
  });
  return true;
}

/**
 * Exchanges a grant for one working key scoped to one stored item. The key is
 * shown once; Octo keeps only its hash. A new mint for the same (grant, item)
 * retires the previous key.
 */
async function mintLease(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const grant = await loadGrant(req, res);
  if (!grant) return true;
  if (grant.decoy) {
    sendJson(res, 403, { error: 'FORBIDDEN: a decoy grant cannot mint a working key.' });
    return true;
  }
  const body = await readJsonObject(req);
  const days = parseLeaseDays(body['expiresInDays']);
  if (!days.ok) {
    sendJson(res, 400, { error: days.error });
    return true;
  }

  const label = typeof body['label'] === 'string' ? body['label'].trim() : '';
  const itemId = typeof body['itemId'] === 'string' ? body['itemId'].trim() : '';
  if (!label && !itemId) {
    sendJson(res, 400, { error: 'ITEM_REQUIRED: name the stored key by label or itemId.' });
    return true;
  }
  const items = await dbListVaultItemsForGrant(grant.principalId, grant.workspaceId);
  const item = itemId
    ? items.find((row) => row.id === itemId)
    : items.find((row) => row.label.toLowerCase() === label.toLowerCase());
  if (!item) {
    sendJson(res, 404, { error: 'NOT_FOUND: no item with that label in this cabinet.' });
    return true;
  }
  if ((item.kind !== 'token' && item.kind !== 'login') || !item.secretEncrypted) {
    sendJson(res, 400, {
      error: 'ITEM_NOT_ROUTABLE: only a token or login with a stored secret can become a working key.',
    });
    return true;
  }

  const token = mintLeaseToken();
  const id = randomUUID();
  const expiresAt = leaseExpiresAt(days.days);
  await dbInsertVaultLeaseService({
    id,
    principalId: grant.principalId,
    itemId: item.id,
    parentGrantId: grant.grantId,
    keyHash: token.hash,
    prefix: token.prefix,
    name: `${grant.grantName} / ${item.label}`.slice(0, 200),
    expiresAt,
  });
  const routes = await dbListVaultRoutesForGrant(item.id);
  const origin = getPublicOrigin(req, url);
  sendJson(res, 201, {
    lease: { id, itemId: item.id, itemLabel: item.label, prefix: token.prefix, expiresAt },
    rawSecret: token.raw,
    routes: routes.map((route) => relayRoute(origin, route)),
  });
  return true;
}

async function mintDecoy(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const grant = await loadGrant(req, res);
  if (!grant) return true;
  const body = await readJsonObject(req);
  const hours = parseGrantHours(body['expiresInHours']);
  if (!hours.ok) {
    sendJson(res, 400, { error: hours.error });
    return true;
  }
  const token = mintToken();
  const id = randomUUID();
  const expiresAt = grantExpiresAt(hours.hours);
  await dbInsertVaultGrantService({
    id,
    principalId: grant.principalId,
    workspaceId: grant.workspaceId,
    parentGrantId: grant.grantId,
    keyHash: token.hash,
    prefix: token.prefix,
    name: `${grant.grantName} decoy`,
    expiresAt,
  });
  sendJson(res, 201, {
    grant: {
      id,
      prefix: token.prefix,
      workspaceId: grant.workspaceId,
      expiresAt,
    },
    rawSecret: token.raw,
  });
  return true;
}
