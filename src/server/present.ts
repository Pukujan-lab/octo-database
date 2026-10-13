/**
 * Presentation and active-tier access for stored files: the published-file shape,
 * public-object deletion, and the on-demand restore that lets an archived file
 * still open through its logical id.
 */

import { ArchiveFileRecord, ArchiveState, restoreFile } from '../storage/archive-service';
import { publishedFileUrl, PublishStepError } from '../storage/publish-service';
import { dbGetArchiveRecord } from './db';
import { archiveDeps, objectStore, publicLocalStore, publicTarget, r2Provider } from './runtime';

export function presentFile<T extends { id: string; publishedAt?: string | Date | null; publicKey?: string | null }>(
  file: T
): Omit<T, 'publicKey'> & { publishedUrl: string | null } {
  const target = publicTarget;
  const published = file.publishedAt != null && target;
  const { publicKey: _publicKey, ...rest } = file;
  return {
    ...rest,
    publishedUrl: published ? publishedFileUrl(target.baseUrl, file.id) : null,
  };
}

export async function deletePublicObject(publicKey: string): Promise<void> {
  if (publicTarget?.mode === 'local' && publicLocalStore) {
    await publicLocalStore.delete(publicKey);
    return;
  }
  if (publicTarget?.mode === 'r2' && r2Provider && publicTarget.publicBucket) {
    await r2Provider.deleteObjectInBucket(publicTarget.publicBucket, publicKey);
    return;
  }
  throw new PublishStepError(
    'PUBLIC_DELETE_FAILED',
    'PUBLIC_DELETE_FAILED: the public object could not be removed'
  );
}

export async function loadArchiveRecord(
  workspaceId: string,
  fileId: string
): Promise<ArchiveFileRecord | null> {
  const row = await dbGetArchiveRecord(workspaceId, fileId);
  if (!row) return null;
  return {
    fileId: row.fileId,
    workspaceId: row.workspaceId,
    name: row.name,
    mimeType: row.mimeType,
    storageKey: row.storageKey,
    archiveState: row.archiveState as ArchiveState,
    archiveLocator: row.archiveLocator,
    archiveHash: row.archiveHash,
  };
}

/**
 * Ensures a file's bytes are present in the active tier, restoring them from the
 * cold tier first when the file has been archived. Returns the bytes, or null
 * when they are unavailable. This is what lets an archived image still open
 * through its unchanged logical file id.
 */
export async function ensureActiveBytes(
  workspaceId: string,
  file: { id: string; storageKey: string; archiveState: string }
): Promise<Buffer | null> {
  if (!objectStore) return null;

  const direct = await objectStore.get(file.storageKey);
  if (direct) return direct;

  if (file.archiveState !== 'archived_drive' || !archiveDeps) return null;

  const record = await loadArchiveRecord(workspaceId, file.id);
  if (!record) return null;

  const result = await restoreFile(archiveDeps, record);
  if (!result.ok) {
    console.warn(`On-demand restore failed for ${file.id}: ${result.summary}`);
    return null;
  }

  return objectStore.get(file.storageKey);
}
