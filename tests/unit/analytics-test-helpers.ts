/**
 * Shared helpers for the analytics unit tests: materialize fixture rows as real
 * Parquet with the pinned DuckDB build, and read a result Parquet back as plain
 * JSON rows. Nothing here is a product surface.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FixtureRow,
  parquetBytes,
  readResultRows,
} from '../../scripts/analytics-fixture';

export type JobRow = FixtureRow;
export { parquetBytes, readResultRows };

export function tempPath(name: string): string {
  const dir = path.join(os.tmpdir(), `octo-analytics-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
