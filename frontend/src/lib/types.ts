/** Row shapes returned by Octo's HTTP API. Nothing here is invented: every field
 *  matches a documented route in the API inventory. */

export type Principal = {
  id: string;
  email: string | null;
  displayName: string;
  isGuest: boolean;
  isPlatformOwner: boolean;
};

export type MeResponse = {
  principal: Principal;
  apiKey: unknown | null;
  confirmSecretSet: boolean;
  mfaEnabled: boolean;
  mfaRecoveryCodesRemaining: number;
};

export type Health = {
  status: string;
  version: string;
  database: { connected: boolean; version?: string };
  r2: { connected: boolean; bucket?: string | null };
  googleAuthEnabled: boolean;
  turnstileSiteKey: string | null;
  analytics?: { configured: boolean; engine: string; version: string | null };
};

export type Workspace = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: string;
  isOwner: boolean;
  retentionDays: number | null;
};

export type FileRecord = {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  storageKey: string;
  createdAt: string;
  archiveState: string;
  publishedAt: string | null;
  publishedUrl: string | null;
};

export type GalleryItem = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "video" | string;
  thumbnailUrl: string;
  fullUrl: string;
  createdAt: string;
};

export type JobRow = {
  id: string;
  jobType: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  errorSummary: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ActivityRow = {
  id: string;
  eventType: string;
  summary: string;
  jobId: string | null;
  createdAt: string;
};

/** One logical dataset with its newest immutable version (Slice 7). */
export type DatasetSummary = {
  datasetId: string;
  dataset: string;
  name: string;
  latestVersionId: string;
  latestVersion: number;
  versionCount: number;
  rowCount: number;
  partCount: number;
  watermark: string | null;
  createdAt: string;
};

/** One analytics_query job with its result artifact, if it has one. */
export type AnalyticsRunSummary = {
  jobId: string;
  state: string;
  errorCode: string | null;
  errorSummary: string | null;
  datasetVersionId: string | null;
  querySpec: string | null;
  resultId: string | null;
  rowCount: number | null;
  contentHash: string | null;
  engineVersion: string | null;
  createdAt: string;
  completedAt: string | null;
};

/** Result artifact rows, normalized for JSON. */
export type AnalyticsRows = {
  resultId: string;
  querySpec: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
};

export type ApiKey = {
  id: string;
  prefix: string;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  isAccountWide: boolean;
};

export type ShareRow = {
  id: string;
  workspaceId: string;
  resourceType: string;
  resourceId: string;
  tokenPrefix: string;
  permission: string;
  validFrom: string | null;
  validUntil: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
};

export type OpsSummary = {
  failureCounts: Array<{
    errorCode: string | null;
    severity: string | null;
    source: string | null;
    eventCount: number;
    lastSeen: string | null;
  }>;
  failuresByJobTypeDay: Array<{
    day: string;
    jobType: string;
    errorCode: string | null;
    eventCount: number;
  }>;
  unhealthyJobs: Array<{
    jobId?: string;
    id?: string;
    jobType: string;
    state: string;
    attempt: number;
    maxAttempts: number;
    updatedAt: string | null;
    errorCode: string | null;
  }>;
};

export type PublicShare = {
  share: {
    id: string;
    resourceType: string;
    permission: string;
    validUntil: string | null;
  };
  items: GalleryItem[];
};

export type DeleteWorkspaceResult = {
  success: boolean;
  workspaceId: string;
  slug: string;
  orphanedObjects: number;
  orphanedDatabase: number;
  orphanedGraph: number;
};

export type MfaStatus = {
  enabled: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
};

/** Scopes that the key editor exposes. */
export const KEY_SCOPES = ["read", "write", "files", "delete"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];
