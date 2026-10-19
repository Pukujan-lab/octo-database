/** Shared analytics records (Slice 7). */

export interface ColumnSpec {
  name: string;
  type: string;
}

/** One immutable dataset export, as the catalog and the API present it. */
export interface DatasetVersionRecord {
  id: string;
  datasetId: string;
  dataset: string;
  version: number;
  format: string;
  schema: ColumnSpec[];
  objectKeys: string[];
  rowCount: number;
  provenance: Record<string, unknown>;
  watermark: string | null;
  createdAt: string;
}

/** The derived result artifact of one analytics_query job. */
export interface AnalyticsResultRecord {
  id: string;
  datasetVersionId: string;
  querySpec: string;
  objectKey: string;
  rowCount: number;
  contentHash: string;
  engineVersion: string;
  createdAt: string;
}

/** One logical dataset with its newest immutable version. */
export interface DatasetSummary {
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
}

/** One analytics_query job with its artifact, if it has one. */
export interface AnalyticsRunSummary {
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
}

/** Result artifact rows, normalized for JSON (the dashboard's read path). */
export interface AnalyticsRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}
