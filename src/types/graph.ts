/** Shared graph-projection types (Slice 10 / issue #12). */

export interface GraphProjectionRow {
  workspaceId: string;
  schemaVersion: string;
  sourceWatermark: string;
  entityCount: number;
  claimCount: number;
  evidenceCount: number;
  relationCount: number;
  status: 'projected' | 'failed';
  lastError: string | null;
  updatedAt: string;
}

/** The projection bookkeeping a run records: its watermark and counts, or a failure. */
export interface GraphProjectionRecord {
  workspaceId: string;
  schemaVersion: string;
  sourceWatermark: string;
  entityCount: number;
  claimCount: number;
  evidenceCount: number;
  relationCount: number;
  status: 'projected' | 'failed';
  lastError: string | null;
}
