/**
 * Object-key derivation for the analytics lake (Slice 7).
 *
 * Every key is derived from server-held identifiers: the authenticated
 * workspace id, the validated dataset slug, the server-assigned version, the
 * validated partition, and a generated part id. A request never supplies a key.
 * The path layout is an optimization; authorization is enforced on the catalog
 * row, not on the prefix.
 */

export const DATASET_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PARTITION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string that also names a real calendar date. */
export function isValidPartition(partition: string): boolean {
  if (!PARTITION_PATTERN.test(partition)) return false;
  const [year, month, day] = partition.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

export function datasetPartKey(input: {
  workspaceId: string;
  datasetSlug: string;
  version: number;
  partition: string;
  partId: string;
}): string {
  return `workspaces/${input.workspaceId}/lake/${input.datasetSlug}/v${input.version}/dt=${input.partition}/part-${input.partId}.parquet`;
}

export function resultObjectKey(workspaceId: string, resultId: string): string {
  return `workspaces/${workspaceId}/lake/_results/${resultId}.parquet`;
}

/**
 * The R2 object store has no key-traversal guard (only LocalObjectStore does), so
 * every derived key is asserted against the authenticated workspace prefix before
 * it is read or written.
 */
export function assertWorkspaceKey(key: string, workspaceId: string): void {
  const prefix = `workspaces/${workspaceId}/`;
  if (!key.startsWith(prefix)) {
    throw new Error(`UNSAFE_OBJECT_KEY: ${key} is outside ${prefix}`);
  }
}
