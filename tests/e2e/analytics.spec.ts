/**
 * Playwright E2E: historical analytics over Parquet (Slice 7).
 *
 * Drives the whole accepted flow with an ordinary workspace key -- register an
 * immutable dataset version, submit the named query, drain the queue, read the
 * job, and download the derived Parquet artifact:
 *
 *   POST /api/workspaces/:id/datasets
 *   POST /api/workspaces/:id/analytics/queries
 *   POST /api/jobs/run?workspaceId=:id
 *   GET  /api/workspaces/:id/analytics/queries/:jobId
 *   GET  /api/workspaces/:id/analytics/results/:resultId
 *   GET  /api/workspaces/:id/analytics/results/:resultId/content
 *
 * The caller never supplies SQL or an object key. The artifact's logical rows are
 * read back with the same pinned DuckDB build and compared to the known fixture
 * aggregate, and the downloaded bytes are checked against the recorded content
 * hash. The workspace fence and the unconfigured-spec refusal are pinned too.
 */

import { expect, test, APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash, randomUUID } from 'node:crypto';
import { OctoApi } from '../../src/mcp/client';
import { createOctoMcpServer } from '../../src/mcp/server';
import { CONFIRM_SECRET, setConfirmSecret } from './confirm-secret';
import {
  EXPECTED_AGGREGATE,
  FIXTURE_ROWS,
  fixtureRegistrationBody,
  readResultRows,
} from '../../scripts/analytics-fixture';

interface GuestSession {
  principal: { id: string; isGuest: boolean };
  workspace: { id: string; slug: string; role: string };
  sessionToken: string;
}

interface MintedKey {
  apiKey: { id: string; workspaceId: string | null; scopes: string[] };
  rawSecret: string;
}

interface RegisteredVersion {
  id: string;
  version: number;
  rowCount: number;
  objectKeys: string[];
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const SPEC = 'job-failures-by-type-month@1';
const API_BASE = 'http://localhost:3001';

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join('');
}

async function createGuest(request: APIRequestContext): Promise<GuestSession> {
  const response = await request.post('/api/auth/guest', {
    data: { displayName: `Analytics E2E ${randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as GuestSession;
  await setConfirmSecret(request, session.sessionToken);
  return session;
}

async function mintKey(
  request: APIRequestContext,
  sessionToken: string,
  workspaceId: string,
  scopes: string[]
): Promise<MintedKey> {
  const response = await request.post('/api/keys', {
    headers: bearer(sessionToken),
    data: { name: `analytics key ${randomUUID()}`, workspaceId, scopes, confirmSecret: CONFIRM_SECRET },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as MintedKey;
}

async function register(
  request: APIRequestContext,
  token: string,
  workspaceId: string,
  body: Record<string, unknown>
) {
  return request.post(`/api/workspaces/${workspaceId}/datasets`, {
    headers: bearer(token),
    data: body,
  });
}

test.describe('Historical analytics', () => {
  test('an API key registers Parquet, runs the named query, and downloads the artifact', async ({
    request,
  }) => {
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read', 'write']);
    const workspaceId = owner.workspace.id;

    // 1. Registration inspects the real Parquet footers and assigns version 1.
    const registration = await register(request, key.rawSecret, workspaceId, {
      ...(await fixtureRegistrationBody('e2e-job-history')),
      idempotencyKey: `e2e-${randomUUID()}`,
    });
    expect(registration.status()).toBe(201);
    const registered = (await registration.json()) as {
      datasetVersion: RegisteredVersion;
      created: boolean;
    };
    expect(registered.created).toBe(true);
    expect(registered.datasetVersion.version).toBe(1);
    expect(registered.datasetVersion.rowCount).toBe(FIXTURE_ROWS.length);
    expect(registered.datasetVersion.objectKeys).toHaveLength(2);
    for (const objectKey of registered.datasetVersion.objectKeys) {
      expect(objectKey.startsWith(`workspaces/${workspaceId}/lake/e2e-job-history/v1/`)).toBe(true);
    }

    // 2. Submit the named query. The server builds the SQL; the caller names a spec.
    const submitted = await request.post(`/api/workspaces/${workspaceId}/analytics/queries`, {
      headers: bearer(key.rawSecret),
      data: { datasetVersionId: registered.datasetVersion.id, querySpec: SPEC },
    });
    expect(submitted.status()).toBe(201);
    const job = ((await submitted.json()) as { job: { id: string; state: string } }).job;
    expect(job.state).toBe('queued');

    // 3. Drain one queue pass; the analytics_query job runs DuckDB in-process.
    const drain = await request.post(`/api/jobs/run?workspaceId=${workspaceId}`, {
      headers: bearer(key.rawSecret),
    });
    expect(drain.status()).toBe(200);

    // 4. The job completes and carries its result metadata.
    const status = await request.get(`/api/workspaces/${workspaceId}/analytics/queries/${job.id}`, {
      headers: bearer(key.rawSecret),
    });
    expect(status.status()).toBe(200);
    const jobStatus = (await status.json()) as {
      state: string;
      errorCode: string | null;
      resultId: string | null;
      result: { contentHash: string; rowCount: number; engineVersion: string } | null;
    };
    expect(jobStatus.errorCode).toBeNull();
    expect(jobStatus.state).toBe('completed');
    expect(jobStatus.resultId).toBeTruthy();
    expect(jobStatus.result?.rowCount).toBe(EXPECTED_AGGREGATE.length);
    expect(jobStatus.result?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(jobStatus.result?.engineVersion).toMatch(/^v?\d+\.\d+\.\d+/);

    // 5. The metadata route offers a download; with the local backend it is the
    //    authenticated content route.
    const resultId = jobStatus.resultId!;
    const metadata = await request.get(`/api/workspaces/${workspaceId}/analytics/results/${resultId}`, {
      headers: bearer(key.rawSecret),
    });
    expect(metadata.status()).toBe(200);
    const artifact = (await metadata.json()) as { downloadUrl: string };
    expect(artifact.downloadUrl).toBe(`/api/workspaces/${workspaceId}/analytics/results/${resultId}/content`);

    // 6. The bytes are real Parquet, hash to the recorded content hash, and hold
    //    the known aggregate in canonical order.
    const content = await request.get(artifact.downloadUrl, { headers: bearer(key.rawSecret) });
    expect(content.status()).toBe(200);
    expect(content.headers()['content-type']).toBe('application/vnd.apache.parquet');
    const bytes = await content.body();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(jobStatus.result?.contentHash);
    expect(await readResultRows(bytes)).toEqual(EXPECTED_AGGREGATE);
  });

  test('the same flow answers through the MCP tools', async ({ request }) => {
    // Differential axis 4: the MCP path must reach the same API and answer the
    // same question, so an agent that only has the MCP adapter is not a second,
    // weaker product surface.
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read', 'write']);
    const workspaceId = owner.workspace.id;
    const api = new OctoApi({ baseUrl: API_BASE, token: key.rawSecret });
    const server = createOctoMcpServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'octo-analytics-e2e', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const body = await fixtureRegistrationBody('e2e-mcp-history');
      const registered = await client.callTool({
        name: 'register_dataset',
        arguments: {
          workspaceId,
          dataset: body.dataset,
          name: body.name,
          schema: body.schema,
          provenance: body.provenance,
          watermark: body.watermark,
          parts: body.parts,
        },
      });
      expect(registered.isError).toBeFalsy();
      const version = JSON.parse(textOf(registered)) as {
        datasetVersion: { id: string; rowCount: number };
      };
      expect(version.datasetVersion.rowCount).toBe(FIXTURE_ROWS.length);

      const submitted = await client.callTool({
        name: 'query_dataset',
        arguments: {
          workspaceId,
          datasetVersionId: version.datasetVersion.id,
          querySpec: SPEC,
        },
      });
      expect(submitted.isError).toBeFalsy();
      const jobId = (JSON.parse(textOf(submitted)) as { job: { id: string } }).job.id;

      // Draining is an operator action, not an agent tool; the same key does it
      // over HTTP. Everything the agent needs to observe is then over MCP.
      const drain = await request.post(`/api/jobs/run?workspaceId=${workspaceId}`, {
        headers: bearer(key.rawSecret),
      });
      expect(drain.status()).toBe(200);

      const status = await client.callTool({
        name: 'get_analytics_query_status',
        arguments: { workspaceId, jobId },
      });
      expect(status.isError).toBeFalsy();
      const jobStatus = JSON.parse(textOf(status)) as {
        state: string;
        resultId: string;
        result: { contentHash: string };
      };
      expect(jobStatus.state).toBe('completed');

      const result = await client.callTool({
        name: 'get_analytics_result',
        arguments: { workspaceId, resultId: jobStatus.resultId },
      });
      expect(result.isError).toBeFalsy();
      const artifact = JSON.parse(textOf(result)) as { downloadUrl: string };
      const content = await request.get(artifact.downloadUrl, { headers: bearer(key.rawSecret) });
      expect(content.status()).toBe(200);
      const bytes = await content.body();
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(jobStatus.result.contentHash);
      expect(await readResultRows(bytes)).toEqual(EXPECTED_AGGREGATE);
    } finally {
      await client.close();
    }
  });

  test('a re-export is a new immutable version, and a repeated registration converges', async ({
    request,
  }) => {
    const owner = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read', 'write']);
    const workspaceId = owner.workspace.id;
    const body = await fixtureRegistrationBody('e2e-revisions');

    const first = await register(request, key.rawSecret, workspaceId, {
      ...body,
      idempotencyKey: 'same-export',
    });
    expect(first.status()).toBe(201);
    const firstVersion = ((await first.json()) as { datasetVersion: RegisteredVersion }).datasetVersion;

    // The same export key answers the same immutable version instead of minting one.
    const repeated = await register(request, key.rawSecret, workspaceId, {
      ...body,
      idempotencyKey: 'same-export',
    });
    expect(repeated.status()).toBe(200);
    const repeatedBody = (await repeated.json()) as { datasetVersion: RegisteredVersion; created: boolean };
    expect(repeatedBody.created).toBe(false);
    expect(repeatedBody.datasetVersion.id).toBe(firstVersion.id);

    // A new export is a new version; version 1 is never mutated.
    const second = await register(request, key.rawSecret, workspaceId, body);
    expect(second.status()).toBe(201);
    const secondVersion = ((await second.json()) as { datasetVersion: RegisteredVersion }).datasetVersion;
    expect(secondVersion.id).not.toBe(firstVersion.id);
    expect(secondVersion.version).toBe(2);
    expect(secondVersion.objectKeys).toHaveLength(2);
    for (const objectKey of secondVersion.objectKeys) {
      expect(objectKey.startsWith(`workspaces/${workspaceId}/lake/e2e-revisions/v2/`)).toBe(true);
    }
  });

  test('the workspace fence and input validation refuse before any engine work', async ({ request }) => {
    const owner = await createGuest(request);
    const stranger = await createGuest(request);
    const key = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read', 'write']);
    const body = await fixtureRegistrationBody('e2e-fence');

    // A key bound to one workspace cannot register into another.
    const crossKey = await register(request, key.rawSecret, stranger.workspace.id, body);
    expect(crossKey.status()).toBe(403);

    // A member of another workspace cannot register into the owner's.
    const crossMember = await register(request, stranger.sessionToken, owner.workspace.id, body);
    expect(crossMember.status()).toBe(403);

    // A write key is required to register.
    const readKey = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read']);
    const readOnly = await register(request, readKey.rawSecret, owner.workspace.id, body);
    expect(readOnly.status()).toBe(403);

    // A malformed dataset slug, format, schema, or part is a clean 400.
    const badSlug = await register(request, key.rawSecret, owner.workspace.id, { ...body, dataset: 'Not A Slug' });
    expect(badSlug.status()).toBe(400);
    const badFormat = await register(request, key.rawSecret, owner.workspace.id, { ...body, format: 'csv' });
    expect(badFormat.status()).toBe(400);
    const badSchema = await register(request, key.rawSecret, owner.workspace.id, { ...body, schema: [] });
    expect(badSchema.status()).toBe(400);
    const badPart = await register(request, key.rawSecret, owner.workspace.id, {
      ...body,
      parts: [{ partition: '2026-02-31', dataBase64: 'UEFS' }],
    });
    expect(badPart.status()).toBe(400);

    // A well-formed registration, then a query naming a foreign/absent version.
    const registered = await register(request, key.rawSecret, owner.workspace.id, body);
    expect(registered.status()).toBe(201);
    const versionId = ((await registered.json()) as { datasetVersion: RegisteredVersion }).datasetVersion.id;

    const unknownSpec = await request.post(`/api/workspaces/${owner.workspace.id}/analytics/queries`, {
      headers: bearer(key.rawSecret),
      data: { datasetVersionId: versionId, querySpec: 'select-everything@1' },
    });
    expect(unknownSpec.status()).toBe(400);
    expect(((await unknownSpec.json()) as { error: string }).error).toBe('UNKNOWN_QUERY_SPEC');

    const foreignVersion = await request.post(`/api/workspaces/${stranger.workspace.id}/analytics/queries`, {
      headers: bearer(stranger.sessionToken),
      data: { datasetVersionId: versionId, querySpec: SPEC },
    });
    expect(foreignVersion.status()).toBe(404);
    expect(((await foreignVersion.json()) as { error: string }).error).toBe('DATASET_VERSION_NOT_FOUND');

    const missingResult = await request.get(
      `/api/workspaces/${owner.workspace.id}/analytics/results/${randomUUID()}`,
      { headers: bearer(key.rawSecret) }
    );
    expect(missingResult.status()).toBe(404);
  });

  test('a write key discovers the analytics capabilities', async ({ request }) => {
    const owner = await createGuest(request);
    const writeKey = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read', 'write']);
    const readKey = await mintKey(request, owner.sessionToken, owner.workspace.id, ['read']);

    const writeDiscovery = await request.get(`/api/capabilities?workspaceId=${owner.workspace.id}`, {
      headers: bearer(writeKey.rawSecret),
    });
    expect(writeDiscovery.status()).toBe(200);
    const writeActions = new Set(
      ((await writeDiscovery.json()) as { capabilities: Array<{ action: string }> }).capabilities.map(
        (capability) => capability.action
      )
    );
    expect(writeActions.has('datasets.register')).toBe(true);
    expect(writeActions.has('analytics.query')).toBe(true);
    expect(writeActions.has('analytics.query_status')).toBe(true);
    expect(writeActions.has('analytics.result')).toBe(true);

    // A read-only token may query and download but never register.
    const readDiscovery = await request.get(`/api/capabilities?workspaceId=${owner.workspace.id}`, {
      headers: bearer(readKey.rawSecret),
    });
    expect(readDiscovery.status()).toBe(200);
    const readActions = new Set(
      ((await readDiscovery.json()) as { capabilities: Array<{ action: string }> }).capabilities.map(
        (capability) => capability.action
      )
    );
    expect(readActions.has('analytics.query')).toBe(true);
    expect(readActions.has('datasets.register')).toBe(false);
  });
});
