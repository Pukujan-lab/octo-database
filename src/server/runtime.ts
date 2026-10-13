/**
 * Composition-root runtime state.
 *
 * This module owns the process-wide singletons the HTTP surface reads: the port,
 * the storage backends, the optional graph client, and the archive wiring. It is
 * also where the local-dev `.env` is loaded.
 *
 * Static ESM imports are hoisted and evaluated before any module body statement,
 * so this module's `.env` load cannot run ahead of the modules it imports. db.ts
 * is imported here, so it is always evaluated first and reads the ambient
 * environment exactly as it did before this split; the singletons below, and any
 * module evaluated after this one, read the loaded `.env`.
 */

import { GraphClient, loadGraphConfigFromEnv } from '../graph/falkordb-client';
import { ArchiveDeps } from '../storage/archive-service';
import { GoogleDriveProvider, loadGoogleDriveConfigFromEnv } from '../storage/google-drive-provider';
import { LocalObjectStore, ObjectStore, R2ObjectStore } from '../storage/object-store';
import { resolvePublicTarget } from '../storage/publish-service';
import { loadR2ConfigFromEnv, R2StorageProvider } from '../storage/r2-client';
import { dbUpdateArchiveState } from './db';
import * as fs from 'fs';
import * as path from 'path';

// Conditionally load .env if present (local dev) without failing in CI
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

export const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Explicit opt-in local storage backend for CI/dev only. Production default is R2
// and fails closed when credentials are absent, so uploads can never silently land
// outside R2 and leave octo.files rows pointing at objects that do not exist.
export const LOCAL_STORAGE_ROOT = path.join('/tmp', 'octo-storage');

export const useLocalStorage = process.env['OCTO_STORAGE_BACKEND'] === 'local';

// Initialize R2 Active Storage Provider
export let r2Provider: R2StorageProvider | null = null;

try {
  const r2Config = loadR2ConfigFromEnv();
  r2Provider = new R2StorageProvider(r2Config);
} catch (e) {
  if (useLocalStorage) {
    console.warn('Local storage backend active; R2 disabled:', (e as Error).message);
  } else {
    console.warn('R2 storage initialization note:', (e as Error).message);
  }
}

// Backend-agnostic store used by uploads and derived thumbnail artifacts.
export const objectStore: ObjectStore | null = r2Provider
  ? new R2ObjectStore(r2Provider)
  : useLocalStorage
    ? new LocalObjectStore(LOCAL_STORAGE_ROOT)
    : null;

export const privateBucketName =
  r2Provider?.bucket ?? process.env['OCTO_R2_BUCKET'] ?? process.env['R2_BUCKET'] ?? 'octo';

export const publicTarget = resolvePublicTarget(process.env, {
  useLocalStorage: Boolean(useLocalStorage && !r2Provider),
  privateBucket: privateBucketName,
  port: PORT,
});

export const publicLocalStore: ObjectStore | null =
  publicTarget?.mode === 'local' ? new LocalObjectStore(path.join('/tmp', 'octo-public')) : null;

// Cold/archival tier (Slice 5). Optional: archival is simply unavailable when
// Drive credentials are absent, rather than half-configured.
export let driveProvider: GoogleDriveProvider | null = null;

try {
  driveProvider = new GoogleDriveProvider(loadGoogleDriveConfigFromEnv());
} catch (e) {
  console.warn('Google Drive archival disabled:', (e as Error).message);
}

/**
 * Graph engine (issue #12). Optional, like the embedding provider: unset
 * `OCTO_GRAPH_URL` leaves the graph surface reporting "not configured" rather
 * than a half-wired engine. The client derives each graph name from the
 * authenticated workspace UUID, so no request value can name a graph.
 */
export const graphConfig = loadGraphConfigFromEnv();

export const graphClient: GraphClient | null = graphConfig ? new GraphClient(graphConfig) : null;

/**
 * Archive lifecycle wiring for the worker and the on-demand restore path. Null
 * when either tier is unavailable, so callers fail closed instead of guessing.
 */
export const archiveDeps: ArchiveDeps | null =
  objectStore && driveProvider
    ? {
        active: objectStore,
        archive: driveProvider,
        updateFile: (fileId, patch) =>
          dbUpdateArchiveState(fileId, {
            archiveState: patch.archiveState,
            ...(patch.archiveProvider !== undefined ? { archiveProvider: patch.archiveProvider } : {}),
            ...(patch.archiveLocator !== undefined ? { archiveLocator: patch.archiveLocator } : {}),
            ...(patch.archiveHash !== undefined ? { archiveHash: patch.archiveHash } : {}),
            ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
            ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
          }),
      }
    : null;
