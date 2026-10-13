/**
 * Share links: create, list, revoke, and the public read.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { signMediaUrl } from '../media/media-token';
import { hashShareToken } from '../media/share-service';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { bindRequestIdentity, dbGetWorkspaceMembership, dbInsertShare, dbListShares, dbListWorkspaceFiles, dbResolveShareByTokenHash, dbRevokeShare } from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { randomBytes, randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleSharesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 9. Scoped share links (Slice 4)
  // Create: POST /api/workspaces/shares
  if (pathname === '/api/workspaces/shares' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    // A share link grants read (or upload) access to this workspace's gallery,
    // so minting one needs the write scope; the role check below still applies.
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    const parsed = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId, resourceType, resourceId, permission, expiresInHours, validUntil } = parsed;

    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId is required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    // Enforce workspace-scoped key restrictions before anything else.
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    // The server connects as a trusted role, so authorization is enforced here.
    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'admin')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to create share links' });
      return true;
    }

    if (resourceType && resourceType !== 'gallery') {
      sendJson(res, 400, { error: "BAD_REQUEST: Only resourceType 'gallery' is supported currently" });
      return true;
    }

    if (permission && permission !== 'read' && permission !== 'upload') {
      sendJson(res, 400, { error: "BAD_REQUEST: permission must be 'read' or 'upload'" });
      return true;
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
        return true;
      }
      expiry = d.toISOString();
    }

    // Reject a nonsensical expiry with a clear 400 instead of surfacing the
    // database check constraint as an internal error.
    if (expiry) {
      const parsedExpiry = new Date(expiry);
      if (!Number.isFinite(parsedExpiry.getTime())) {
        sendJson(res, 400, { error: 'BAD_REQUEST: validUntil is not a valid timestamp' });
        return true;
      }
      if (parsedExpiry.getTime() <= Date.now()) {
        sendJson(res, 400, { error: 'BAD_REQUEST: validUntil must be in the future' });
        return true;
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
    return true;
  }

  // List: GET /api/workspaces/shares?workspaceId=...
  if (pathname === '/api/workspaces/shares' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    // Listing a workspace's share links is a read of its metadata.
    if (!requireScope(auth, 'read')) {
      scopeDenied(res, 'read');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId is required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'admin')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to list share links' });
      return true;
    }

    const shares = await dbListShares(workspaceId);
    sendJson(res, 200, shares);
    return true;
  }

  // Revoke: DELETE /api/shares/:id?workspaceId=...
  if (pathname.startsWith('/api/shares/') && req.method === 'DELETE') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    // Revoking a credential is destructive, so it needs the delete scope.
    if (!requireScope(auth, 'delete')) {
      scopeDenied(res, 'delete');
      return true;
    }

    const shareId = pathname.slice('/api/shares/'.length);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!shareId || !workspaceId) {
      sendJson(res, 400, { error: 'shareId and workspaceId are required' });
      return true;
    }
    if (!requireUuid(res, shareId, 'shareId')) return true;
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'admin')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to revoke share links' });
      return true;
    }

    const revoked = await dbRevokeShare(shareId);
    if (!revoked || revoked.workspaceId !== workspaceId) {
      sendJson(res, 404, { error: 'SHARE_NOT_FOUND' });
      return true;
    }

    sendJson(res, 200, { success: true, shareId });
    return true;
  }

  // Anonymous public view: GET /api/public/shares/:token
  // Resolves the token to exactly one target resource. No workspace, sibling
  // album, or admin route is reachable with the token alone.
  if (pathname.startsWith('/api/public/shares/') && req.method === 'GET') {
    const rawToken = pathname.slice('/api/public/shares/'.length);
    if (!rawToken) {
      sendJson(res, 400, { error: 'share token is required' });
      return true;
    }

    const tokenHash = hashShareToken(rawToken);
    const share = await dbResolveShareByTokenHash(tokenHash);

    // Unknown, revoked, not-yet-valid, and expired all fail identically, so the
    // response cannot be used to probe which links ever existed.
    if (!share) {
      sendJson(res, 404, { error: 'SHARE_NOT_FOUND_OR_INACTIVE' });
      return true;
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
    return true;
  }

  return false;
}
