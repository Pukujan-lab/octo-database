/**
 * The workspace gallery view.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { signMediaUrl } from '../media/media-token';
import { authenticateRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { dbGetWorkspaceMembership, dbListWorkspaceFiles } from '../server/db';
import { requireUuid, sendJson } from '../server/http';
import { r2Provider } from '../server/runtime';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleGalleryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 8. Gallery Media: GET /api/gallery?workspaceId=...
  if (pathname === '/api/gallery' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'files')) {
      scopeDenied(res, 'files');
      return true;
    }

    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'member')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
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
    return true;
  }

  return false;
}
