/**
 * Unit tests: dataset registration (Slice 7).
 *
 * Registration is the only write path into the lake. The properties pinned here
 * are the ones the HTTP route relies on: the footer is the authority (not the
 * declaration), a re-export is a new version, every object key is derived from
 * the authenticated workspace, and an idempotent repeat returns the original.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerDatasetVersion, RegisterVersionInput } from '../../src/analytics/registration';
import { LocalObjectStore } from '../../src/storage/object-store';
import type { DatasetVersionRecord } from '../../src/types/analytics';
import { parquetBytes, JobRow } from './analytics-test-helpers';

const ROOT = path.join(os.tmpdir(), `octo-analytics-catalog-${randomUUID()}`);
const STORE = new LocalObjectStore(ROOT);
const WORKSPACE = randomUUID();

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const ROWS: JobRow[] = [
  { job_type: 'thumbnail', state: 'failed', created_at: '2026-01-02 00:00:00' },
  { job_type: 'thumbnail', state: 'completed', created_at: '2026-01-03 00:00:00' },
];

const DECLARED = [
  { name: 'job_type', type: 'TEXT' },
  { name: 'state', type: 'TEXT' },
  { name: 'created_at', type: 'TIMESTAMP' },
];

async function body(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const bytes = await parquetBytes(ROWS);
  return {
    dataset: 'job-history',
    name: 'Job history',
    format: 'parquet',
    schema: DECLARED,
    provenance: { source: 'octo.jobs', exportedAt: '2026-10-19T00:00:00Z' },
    watermark: '2026-01-31T23:59:59Z',
    parts: [{ partition: '2026-01-31', dataBase64: bytes.toString('base64') }],
    ...overrides,
  };
}

function recordingCatalog(
  outcome: 'created' | 'existing' | 'conflict' = 'created',
  base: DatasetVersionRecord | null = null
) {
  const seen: RegisterVersionInput[] = [];
  return {
    seen,
    catalog: {
      async latestVersion() {
        return base;
      },
      async createVersion(input: RegisterVersionInput) {
        seen.push(input);
        const keys = input.buildObjectKeys(base ? base.version + 1 : 1);
        await input.writeObjects(keys);
        if (outcome === 'conflict') return { status: 'conflict' as const };
        const version: DatasetVersionRecord = {
          id: randomUUID(),
          datasetId: randomUUID(),
          dataset: input.slug,
          version: base ? base.version + 1 : 1,
          format: input.format,
          schema: input.schema,
          objectKeys: [...(input.append?.carryKeys ?? []), ...keys],
          rowCount: input.rowCount,
          provenance: input.provenance,
          watermark: input.watermark,
          createdAt: '2026-10-19T00:00:00.000Z',
        };
        return { status: outcome, version };
      },
    },
  };
}

describe('dataset registration', () => {
  it('inspects the footer, sums rows, and writes server-derived keys', async () => {
    const { seen, catalog } = recordingCatalog();
    const outcome = await registerDatasetVersion(
      { workspaceId: WORKSPACE, createdBy: randomUUID(), body: await body(), store: STORE },
      catalog
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.created).toBe(true);
    expect(outcome.version.rowCount).toBe(2);

    const captured = seen[0]!;
    expect(captured.rowCount).toBe(2);
    expect(captured.schema).toEqual(DECLARED);
    expect(captured.buildObjectKeys(7)[0]).toMatch(
      new RegExp(`^workspaces/${WORKSPACE}/lake/job-history/v7/dt=2026-01-31/part-[0-9a-f-]+\\.parquet$`)
    );
    expect(await STORE.get(captured.buildObjectKeys(7)[0]!)).toBeNull();
    expect(await STORE.head(captured.buildObjectKeys(1)[0]!)).toBeGreaterThan(0);
  });

  it('rejects a declaration that disagrees with the Parquet footer', async () => {
    const { seen, catalog } = recordingCatalog();
    const outcome = await registerDatasetVersion(
      {
        workspaceId: WORKSPACE,
        createdBy: randomUUID(),
        body: await body({
          schema: [
            { name: 'job_type', type: 'TEXT' },
            { name: 'state', type: 'INTEGER' },
            { name: 'created_at', type: 'TIMESTAMP' },
          ],
        }),
        store: STORE,
      },
      catalog
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.error).toBe('SCHEMA_MISMATCH');
    expect(outcome.http).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('rejects a schema that cannot answer the accepted spec', async () => {
    const { catalog } = recordingCatalog();
    const outcome = await registerDatasetVersion(
      {
        workspaceId: WORKSPACE,
        createdBy: randomUUID(),
        body: await body({ schema: [{ name: 'job_type', type: 'TEXT' }] }),
        store: STORE,
      },
      catalog
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.error).toBe('SCHEMA_MISMATCH');
  });

  it('rejects a partition that is not a real calendar date', async () => {
    const { catalog } = recordingCatalog();
    const valid = await body();
    const parts = valid['parts'] as Array<{ partition: string; dataBase64: string }>;
    parts[0]!.partition = '2026-02-31';

    const outcome = await registerDatasetVersion(
      { workspaceId: WORKSPACE, createdBy: randomUUID(), body: valid, store: STORE },
      catalog
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.error).toBe('BAD_REQUEST');
  });

  it('reports an idempotent repeat as not created', async () => {
    const { catalog } = recordingCatalog('existing');
    const outcome = await registerDatasetVersion(
      {
        workspaceId: WORKSPACE,
        createdBy: randomUUID(),
        body: await body({ idempotencyKey: 'export-2026-01' }),
        store: STORE,
      },
      catalog
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.created).toBe(false);
  });

  it('reports a concurrent version collision as a retryable conflict', async () => {
    const { catalog } = recordingCatalog('conflict');
    const outcome = await registerDatasetVersion(
      { workspaceId: WORKSPACE, createdBy: randomUUID(), body: await body(), store: STORE },
      catalog
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.http).toBe(409);
    expect(outcome.error).toBe('DATASET_VERSION_CONFLICT');
  });

  it('MR-C: keys are always under the authenticated workspace, never a request value', async () => {
    const other = randomUUID();
    const { seen, catalog } = recordingCatalog();
    const request = await body({ workspaceId: other, objectKey: 'workspaces/x/secret.parquet' });

    const outcome = await registerDatasetVersion(
      { workspaceId: WORKSPACE, createdBy: randomUUID(), body: request, store: STORE },
      catalog
    );

    expect(outcome.ok).toBe(true);
    for (const key of seen[0]!.buildObjectKeys(1)) {
      expect(key.startsWith(`workspaces/${WORKSPACE}/lake/`)).toBe(true);
      expect(key.includes(other)).toBe(false);
    }
  });
});

describe('dataset registration: any schema and appends', () => {
  const BASE_KEY = `workspaces/${WORKSPACE}/lake/job-history/v1/dt=2026-01-30/part-aaaa.parquet`;
  const base: DatasetVersionRecord = {
    id: randomUUID(),
    datasetId: randomUUID(),
    dataset: 'job-history',
    version: 1,
    format: 'parquet',
    schema: DECLARED,
    objectKeys: [BASE_KEY],
    rowCount: 5,
    provenance: { source: 'test', exportedAt: '2026-10-19T00:00:00Z' },
    watermark: null,
    createdAt: '2026-10-19T00:00:00.000Z',
  };

  it('extends the newest version with new partitions and carries the old keys', async () => {
    const { seen, catalog } = recordingCatalog('created', base);
    const outcome = await registerDatasetVersion(
      { workspaceId: WORKSPACE, createdBy: randomUUID(), body: await body({ append: true }), store: STORE },
      catalog
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.version.version).toBe(2);
    expect(outcome.version.objectKeys[0]).toBe(BASE_KEY);
    expect(outcome.version.objectKeys).toHaveLength(2);
    expect(seen[0]!.append).toEqual({ baseVersion: 1, carryKeys: [BASE_KEY], baseRowCount: 5 });
    expect(seen[0]!.rowCount).toBe(7);
  });

  it('refuses an append of a partition the dataset already has', async () => {
    const { catalog } = recordingCatalog('created', {
      ...base,
      objectKeys: [`workspaces/${WORKSPACE}/lake/job-history/v1/dt=2026-01-31/part-aaaa.parquet`],
    });
    const outcome = await registerDatasetVersion(
      { workspaceId: WORKSPACE, createdBy: randomUUID(), body: await body({ append: true }), store: STORE },
      catalog
    );
    expect(outcome).toMatchObject({ ok: false, http: 409, error: 'PARTITION_EXISTS' });
  });

  it('refuses an append with a different schema, and an append to nothing', async () => {
    const changed = recordingCatalog('created', { ...base, schema: [{ name: 'x', type: 'TEXT' }] });
    expect(
      await registerDatasetVersion(
        { workspaceId: WORKSPACE, createdBy: randomUUID(), body: await body({ append: true }), store: STORE },
        changed.catalog
      )
    ).toMatchObject({ ok: false, error: 'SCHEMA_MISMATCH' });

    const none = recordingCatalog('created', null);
    expect(
      await registerDatasetVersion(
        { workspaceId: WORKSPACE, createdBy: randomUUID(), body: await body({ append: true }), store: STORE },
        none.catalog
      )
    ).toMatchObject({ ok: false, http: 404, error: 'DATASET_NOT_FOUND' });
  });
});
