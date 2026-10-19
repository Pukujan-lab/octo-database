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
