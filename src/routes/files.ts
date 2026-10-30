/**
 * File catalog and bytes: list, upload, download, content, thumbnail, publish, delete, archive.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { OctoScope } from '../api/capabilities';
import { signMediaUrl } from '../media/media-token';
import { loadEmbeddingConfigFromEnv } from '../rag/embeddings';
import { isIndexable } from '../rag/ingest';
import { ensureThumbnail } from '../media/thumbnail-service';
import { authenticateRequest, authorizeMediaRequest, keyWorkspaceMatches, requireScope, roleAllows, scopeDenied } from '../server/auth-context';
import { dbClearFilePublished, dbDeleteFileIfIdle, dbEnqueueJob, dbFinishFileDelete, dbGetFile, dbGetWorkspaceMembership, dbInsertFile, dbListWorkspaceFiles, dbMarkFilePublished, dbRecordActivity } from '../server/db';
import { readJsonObject, requireUuid, sendJson } from '../server/http';
import { attributeAgentAction } from '../server/ops';
import { deletePublicObject, ensureActiveBytes, presentFile } from '../server/present';
import { enqueueFileTransition } from '../server/queue';
import { archiveDeps, objectStore, publicLocalStore, publicTarget, r2Provider } from '../server/runtime';
import { clearPublishedObject, publishSnapshot, PublishStepError } from '../storage/publish-service';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleFilesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 4. File Catalog: GET /api/files?workspaceId=...
  if (pathname === '/api/files' && req.method === 'GET') {
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

    // Enforce workspace-scoped key restrictions
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    const files = await dbListWorkspaceFiles(workspaceId);
    sendJson(res, 200, files.map((file) => presentFile(file)));
    return true;
  }

  // 5. File Upload: POST /api/files/upload
  if (pathname === '/api/files/upload' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    const parsed = (await readJsonObject(req)) as Record<string, any>;
    const { workspaceId, name, mimeType, data, dataEncoding } = parsed;

    if (!workspaceId || !name || data === undefined) {
      sendJson(res, 400, { error: 'workspaceId, name, and data are required' });
      return true;
    }
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    // Enforce workspace-scoped key restriction
    if (auth.apiKey && auth.apiKey.workspaceId && auth.apiKey.workspaceId !== workspaceId) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required to upload' });
      return true;
    }

    const fileId = randomUUID();
    const storageKey = `workspaces/${workspaceId}/${fileId}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // Upload bytes to Cloudflare R2 (or the explicit local CI/dev backend)
    if (!objectStore) {
      sendJson(res, 503, {
        error:
          'STORAGE_UNAVAILABLE: R2 credentials missing. Set OCTO_STORAGE_BACKEND=local for CI/dev only.',
      });
      return true;
    }

    // Binary payloads must declare base64; otherwise the body is treated as
    // UTF-8 text. Storing base64 text as an object body would corrupt every
    // uploaded image and silently break thumbnail generation.
    if (dataEncoding !== undefined && dataEncoding !== 'base64' && dataEncoding !== 'utf8') {
      sendJson(res, 400, { error: "BAD_REQUEST: dataEncoding must be 'base64' or 'utf8'" });
      return true;
    }

    const payload =
      dataEncoding === 'base64'
        ? Buffer.from(String(data), 'base64')
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(String(data), 'utf-8');

    if (payload.byteLength === 0) {
      sendJson(res, 400, { error: 'BAD_REQUEST: decoded payload is empty' });
      return true;
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

    // PDF and text uploads are queued for document search when embeddings are
    // configured (issue #227). Best-effort: indexing never fails the upload.
    if (isIndexable(contentType) && loadEmbeddingConfigFromEnv()) {
      try {
        await dbEnqueueJob(randomUUID(), workspaceId, 'rag_ingest_file', `rag:${fileId}`, { fileId }, auth.principal.id);
      } catch (err) {
        console.error(`Queueing search indexing failed for ${fileId}:`, err);
      }
    }
    sendJson(res, 201, fileRecord);
    return true;
  }

  // 6. Presigned Download URL: GET /api/files/download
  if (pathname === '/api/files/download' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'files')) {
      scopeDenied(res, 'files');
      return true;
    }

    const fileId = url.searchParams.get('fileId');
    const workspaceId = url.searchParams.get('workspaceId');
    if (!fileId || !workspaceId) {
      sendJson(res, 400, { error: 'fileId and workspaceId required' });
      return true;
    }
    if (!requireUuid(res, fileId, 'fileId')) return true;
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }
    if (!objectStore) {
      sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'member')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not a member of this workspace' });
      return true;
    }

    const file = await dbGetFile(workspaceId, fileId);
    if (!file) {
      sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
      return true;
    }

    // An archived file has no R2 object to presign, so send the caller to the
    // content endpoint, which restores the bytes on demand.
    const downloadUrl =
      r2Provider && file.archiveState !== 'archived_drive'
        ? await r2Provider.generatePresignedDownloadUrl(file.storageKey, 3600)
        : `/api/files/content?fileId=${fileId}&workspaceId=${workspaceId}`;
    sendJson(res, 200, { file: presentFile(file), downloadUrl });
    return true;
  }

  // 6b. File Content: GET /api/files/content?workspaceId=...&fileId=...
  // Streams authorized bytes for browser downloads, restoring cold files on demand.
  if (pathname === '/api/files/content' && req.method === 'GET') {
    const auth = await authorizeMediaRequest(req, url);
    if (auth === false) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not authorized for this workspace' });
      return true;
    }
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }

    const { fileId, workspaceId } = auth;

    const file = await dbGetFile(workspaceId, fileId);
    if (!file) {
      sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
      return true;
    }

    if (!objectStore) {
      sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
      return true;
    }

    const bytes = await ensureActiveBytes(workspaceId, file);
    if (!bytes) {
      sendJson(res, 404, { error: 'OBJECT_MISSING: Stored bytes not found for this record.' });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(bytes);
    return true;
  }

  // 6c. Thumbnail: GET /api/files/thumbnail?workspaceId=...&fileId=...
  // Serves a cached small WebP derivative so grids never fetch full originals.
  if (pathname === '/api/files/thumbnail' && req.method === 'GET') {
    const auth = await authorizeMediaRequest(req, url);
    if (auth === false) {
      sendJson(res, 403, { error: 'FORBIDDEN: Not authorized for this workspace' });
      return true;
    }
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }

    const { fileId, workspaceId, principalId } = auth;

    const file = await dbGetFile(workspaceId, fileId);
    if (!file) {
      sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
      return true;
    }

    if (!objectStore) {
      sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
      return true;
    }

    // A thumbnail needs the original bytes; pull them back from the cold tier
    // first when the file has been archived.
    if (file.archiveState === 'archived_drive' && !(await ensureActiveBytes(workspaceId, file))) {
      sendJson(res, 404, { error: 'OBJECT_MISSING: Archived bytes could not be restored.' });
      return true;
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
      return true;
    }

    res.writeHead(200, {
      'Content-Type': thumb.contentType,
      'Content-Length': String(thumb.bytes.byteLength),
      'Cache-Control': 'private, max-age=3600',
      'X-Octo-Thumbnail-Cache': thumb.cached ? 'hit' : 'miss',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(thumb.bytes);
    return true;
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
      return true;
    }
    if (!requireScope(auth, 'write')) {
      scopeDenied(res, 'write');
      return true;
    }

    const publishing = pathname.endsWith('/publish');
    const suffix = publishing ? '/publish' : '/unpublish';
    const fileId = pathname.slice('/api/files/'.length, -suffix.length);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!fileId || !workspaceId) {
      sendJson(res, 400, { error: 'fileId and workspaceId required' });
      return true;
    }
    if (!requireUuid(res, fileId, 'fileId')) return true;
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, {
        error: publishing
          ? 'FORBIDDEN: Operator role or higher required to publish'
          : 'FORBIDDEN: Operator role or higher required to unpublish',
      });
      return true;
    }
    if (!objectStore) {
      sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
      return true;
    }

    const file = await dbGetFile(workspaceId, fileId);
    if (!file) {
      sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
      return true;
    }

    if (!publishing) {
      if (file.publishedAt == null && file.publicKey == null) {
        sendJson(res, 200, { fileId, published: false });
        return true;
      }
      if (!publicTarget) {
        sendJson(res, 503, { error: 'PUBLIC_STORAGE_UNAVAILABLE: public file bucket is not configured' });
        return true;
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
        return true;
      }
      await dbClearFilePublished(fileId, workspaceId);
      await attributeAgentAction(
        auth,
        workspaceId,
        'file.unpublished',
        `File ${fileId} removed from the public bucket`
      );
      sendJson(res, 200, { fileId, published: false });
      return true;
    }

    if (!publicTarget) {
      sendJson(res, 503, { error: 'PUBLIC_STORAGE_UNAVAILABLE: public file bucket is not configured' });
      return true;
    }
    if (file.archiveState === 'active_r2') {
      const size = await objectStore.head(file.storageKey);
      if (size === null) {
        sendJson(res, 404, { error: 'OBJECT_MISSING: Stored bytes not found for this record.' });
        return true;
      }
    }

    const wasPublished = file.publishedAt != null;
    const publishTarget = publicTarget;
    const publishProvider = r2Provider;
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
          publishTarget.mode === 'r2' && publishProvider && publishTarget.publicBucket
            ? async () => {
                await publishProvider.copyToBucket(
                  publishTarget.publicBucket!,
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
        return true;
      }
      copied = result;
    } catch (err) {
      const message =
        err instanceof PublishStepError
          ? err.message
          : 'PUBLIC_COPY_FAILED: the public object could not be written';
      sendJson(res, 502, { error: message });
      return true;
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
      return true;
    }

    await attributeAgentAction(auth, workspaceId, 'file.published', `File ${fileId} published`);
    sendJson(res, 200, {
      fileId,
      url: copied.url,
      publishedAt,
      republished: wasPublished,
    });
    return true;
  }

  // 7. File Delete: DELETE /api/files/:id
  if (pathname.startsWith('/api/files/') && req.method === 'DELETE') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (!requireScope(auth, 'delete')) {
      scopeDenied(res, 'delete');
      return true;
    }

    const fileId = pathname.slice('/api/files/'.length);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!fileId || !workspaceId) {
      sendJson(res, 400, { error: 'fileId and workspaceId required' });
      return true;
    }
    if (!requireUuid(res, fileId, 'fileId')) return true;
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }
    if (!objectStore) {
      sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE: no storage backend configured.' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'admin')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Owner or admin role required to delete files' });
      return true;
    }

    const result = await dbDeleteFileIfIdle(workspaceId, fileId);
    if (result.status === 'missing') {
      sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
      return true;
    }
    if (result.status === 'busy') {
      sendJson(res, 409, { error: 'FILE_BUSY: archive or restore is in progress' });
      return true;
    }

    let storageKey = result.storageKey;
    if (result.status === 'awaiting_public_delete') {
      if (!publicTarget) {
        sendJson(res, 503, { error: 'PUBLIC_STORAGE_UNAVAILABLE: public file bucket is not configured' });
        return true;
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
        return true;
      }
      const finished = await dbFinishFileDelete(workspaceId, fileId);
      if (finished.status === 'busy') {
        await dbClearFilePublished(fileId, workspaceId);
        sendJson(res, 409, { error: 'FILE_BUSY: archive or restore is in progress' });
        return true;
      }
      if (finished.status === 'missing') {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return true;
      }
      storageKey = finished.storageKey;
    }

    await objectStore.delete(storageKey);

    await attributeAgentAction(auth, workspaceId, 'file.deleted', `File ${fileId} deleted by agent principal`);
    sendJson(res, 200, { success: true, fileId });
    return true;
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
      return true;
    }
    const direction = pathname.endsWith('/archive') ? 'archive' : 'restore';
    // Archiving removes the bytes from the active tier, so it needs the delete
    // scope; restoring only writes them back and needs write.
    const requiredScope: OctoScope = direction === 'archive' ? 'delete' : 'write';
    if (!requireScope(auth, requiredScope)) {
      scopeDenied(res, requiredScope);
      return true;
    }

    const suffix = `/${direction}`;
    const fileId = pathname.slice('/api/files/'.length, -suffix.length);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!fileId || !workspaceId) {
      sendJson(res, 400, { error: 'fileId and workspaceId required' });
      return true;
    }
    if (!requireUuid(res, fileId, 'fileId')) return true;
    if (!requireUuid(res, workspaceId, 'workspaceId')) return true;

    // A workspace-scoped key may only touch its own workspace.
    if (!keyWorkspaceMatches(auth, workspaceId)) {
      sendJson(res, 403, { error: 'FORBIDDEN: Key restricted to different workspace' });
      return true;
    }

    const mem = await dbGetWorkspaceMembership(workspaceId, auth.principal.id);
    if (!mem || !roleAllows(auth, mem.role, 'operator')) {
      sendJson(res, 403, { error: 'FORBIDDEN: Operator role or higher required' });
      return true;
    }

    if (!archiveDeps) {
      sendJson(res, 503, {
        error: 'ARCHIVE_UNAVAILABLE: Google Drive archival is not configured on this server.',
      });
      return true;
    }

    const file = await dbGetFile(workspaceId, fileId);
    if (!file) {
      sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
      return true;
    }

    const transition = await enqueueFileTransition(
      direction,
      workspaceId,
      { id: file.id, storageKey: file.storageKey, mimeType: file.mimeType },
      auth.principal.id
    );
    if (transition.status === 'missing') {
      sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
      return true;
    }
    if (transition.status === 'busy') {
      sendJson(res, 409, { error: 'FILE_BUSY: another archive or restore is in progress' });
      return true;
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
    return true;
  }

  return false;
}
