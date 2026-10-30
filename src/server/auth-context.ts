/**
 * Request authentication and authorization: the bearer-credential context, scope
 * checks, workspace role resolution, and media-request authorization.
 */

import { hasScope, OctoScope } from '../api/capabilities';
import { hashApiKeySecret } from '../api/keys';
import { sendPhoneAlert } from '../lib/phone-alert';
import { oauthResource, verifyOAuthAccessToken } from '../lib/oauth-token';
import { verifySessionToken } from '../lib/session-token';
import { verifyMediaToken } from '../media/media-token';
import { Principal, ROLE_HIERARCHY, WorkspaceRole } from '../types/auth';
import {
  bindRequestIdentity,
  dbFindDeadApiKey,
  dbGetWorkspaceMembership,
  dbRecordKeyUse,
  dbResolveShareById,
  dbVerifyApiKey,
  queryService,
} from './db';
import { sendJson } from './http';
import { UUID_PATTERN } from './runtime';
import { IncomingMessage, ServerResponse } from 'http';

export interface AuthContext {
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
  /** Set for an owner-listed agent key; the request is treated as the owner's session. */
  ownerAgent?: boolean;
}

function ownerAgentKeyIds(): Set<string> {
  return new Set(
    (process.env['OCTO_OWNER_AGENT_KEYS'] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

export function keyWorkspaceMatches(auth: AuthContext, workspaceId: string): boolean {
  return !auth.apiKey?.workspaceId || auth.apiKey.workspaceId === workspaceId;
}

export function effectiveWorkspaceRole(auth: AuthContext, liveRoleValue: string): WorkspaceRole {
  const liveRole = liveRoleValue in ROLE_HIERARCHY ? liveRoleValue as WorkspaceRole : 'member';
  const keyRole = auth.apiKey?.workspaceId ? auth.apiKey.role as WorkspaceRole | null : null;
  if (!keyRole || !(keyRole in ROLE_HIERARCHY)) return liveRole;
  return ROLE_HIERARCHY[liveRole] <= ROLE_HIERARCHY[keyRole] ? liveRole : keyRole;
}

export function roleMeetsMinimum(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minimum];
}

export function roleAllows(auth: AuthContext, liveRole: string, minimum: WorkspaceRole): boolean {
  return roleMeetsMinimum(effectiveWorkspaceRole(auth, liveRole), minimum);
}

/** The caller's address: Caddy's X-Forwarded-For (the real client behind Cloudflare), else the socket. */
function sourceIp(req: IncomingMessage): string | null {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return forwarded || req.socket?.remoteAddress || null;
}

/**
 * Logs one key presentation and alerts the phone on a revoked or expired key, or
 * an established key used from a new IP (#362). Runs off the request path.
 */
function recordKeyUse(
  req: IncomingMessage,
  key: { keyId: string; prefix: string | null; principalId: string | null; name?: string },
  outcome: 'ok' | 'revoked' | 'expired'
): void {
  const ip = sourceIp(req);
  const route = (req.url ?? '').split('?')[0] || null;
  void (async () => {
    try {
      const { newIp, firstAlertThisHour } = await dbRecordKeyUse(
        key.keyId, key.principalId, ip, req.method ?? null, route, outcome
      );
      const label = `${key.prefix ?? 'unknown'}…${key.name ? ` (${key.name})` : ''}`;
      if (outcome !== 'ok' && firstAlertThisHour) {
        await sendPhoneAlert(
          `Octo: ${outcome} API key used`,
          `Key ${label} was presented from ${ip ?? 'unknown IP'} on ${req.method} ${route}. It was refused.`
        );
      } else if (newIp) {
        await sendPhoneAlert(
          'Octo: API key used from a new IP',
          `Key ${label} was used from ${ip} on ${req.method} ${route}, an address it has not used before.`
        );
      }
    } catch (err) {
      console.error('key use log failed:', err instanceof Error ? err.message : err);
    }
  })();
}

// Helper: authenticate caller from Authorization header
export async function authenticateRequest(req: IncomingMessage): Promise<AuthContext | null> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();

  // 1. Check if token is an API key (octo_live_...)
  if (token.startsWith('octo_live_')) {
    const keyHash = hashApiKeySecret(token);
    const verified = await dbVerifyApiKey(keyHash);
    if (!verified) {
      const dead = await dbFindDeadApiKey(keyHash).catch(() => null);
      if (dead) recordKeyUse(req, dead, dead.outcome);
      return null;
    }
    recordKeyUse(req, { ...verified, name: verified.keyName }, 'ok');

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

    // An account-wide key the owner lists in OCTO_OWNER_AGENT_KEYS acts as its
    // owner's signed-in session, so the owner's agents reach every feature.
    if (verified.workspaceId === null && ownerAgentKeyIds().has(verified.keyId)) {
      return { principal, ownerAgent: true };
    }

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

export interface MediaAuthorization {
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
export async function authorizeMediaRequest(
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
 * Enforces a token scope. Human sessions carry no scope list and are not limited
 * here; API-key callers must hold the required scope or the call is refused.
 */
export function requireScope(auth: AuthContext, scope: OctoScope): boolean {
  if (!auth.apiKey) return true;
  return hasScope(auth.apiKey.scopes, scope);
}

/** Standard refusal body for a missing scope. */
export function scopeDenied(res: ServerResponse, scope: OctoScope): void {
  sendJson(res, 403, { error: `FORBIDDEN: Token is missing the required '${scope}' scope` });
}
