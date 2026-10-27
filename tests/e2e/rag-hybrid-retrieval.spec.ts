/**
 * Playwright API/E2E: hybrid retrieval (lexical + vector, fused with RRF).
 *
 * CI has no embedding provider, so fixtures seed chunks and embeddings directly and
 * this spec calls the SQL function the route calls. That keeps the property under
 * test honest -- it is the ranking behavior, not the provider plumbing:
 *
 *   MR-1  An exact identifier is recoverable. A chunk that literally contains the
 *         queried token outranks a chunk the vector arm prefers, even when the
 *         identifier chunk is orthogonal to the query vector. Vector-only retrieval
 *         cannot do this, which is the whole reason the lexical arm exists.
 *   MR-2  Degradation is not failure. A query with no lexical overlap, or one made
 *         entirely of stopwords (empty lexical arm), still returns vector-ranked
 *         results instead of erroring or returning nothing.
 *   MR-3  The corpus stays scoped. Neither arm reaches another workspace's chunks.
 *   MR-4  `limit` bounds the fused result.
 *   MR-5  An identifier embedded in a URL path is still recoverable. The parser
 *         keeps `huggingface.co/org/ESM_nguha__legalbench_citation_prediction_open`
 *         as one token, so without separator normalization the query's separate
 *         words never intersect it. This is the shape that failed on production.
 */

import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { queryService } from '../../src/server/db';

/** Workspaces this spec created, removed afterwards so a shared instance stays clean. */
const created: Array<{ workspaceId: string; principalId: string }> = [];

test.afterEach(async () => {
  if (created.length === 0) return;
  const workspaceIds = created.map((c) => c.workspaceId);
  const principalIds = created.map((c) => c.principalId);
  // workspaces.created_by is ON DELETE RESTRICT, so workspaces go first.
  await queryService(`DELETE FROM octo.workspaces WHERE id = ANY($1)`, [workspaceIds]);
  await queryService(`DELETE FROM octo.principals WHERE id = ANY($1)`, [principalIds]);
  created.length = 0;
});

/** A 1024-dimension one-hot vector; the probe vector picks which axis it lights. */
function oneHot(axis: number): string {
  return `[${Array.from({ length: 1024 }, (_, i) => (i + 1 === axis ? '1' : '0')).join(',')}]`;
}

interface Workspace {
  workspaceId: string;
  principalId: string;
  configId: string;
}

async function seedWorkspace(): Promise<Workspace> {
  const principal = await queryService<{ id: string }>(
    `INSERT INTO octo.principals (auth_user_id, email, display_name)
     VALUES (gen_random_uuid(), $1, 'Hybrid E2E') RETURNING id`,
    [`hybrid-${randomUUID()}@example.invalid`]
  );
  const principalId = principal[0]!.id;

  const workspace = await queryService<{ id: string }>(
    `INSERT INTO octo.workspaces (slug, name, created_by) VALUES ($1, 'Hybrid E2E', $2) RETURNING id`,
    [`hybrid-${randomUUID()}`, principalId]
  );
  const workspaceId = workspace[0]!.id;

  const config = await queryService<{ id: string }>(
    `INSERT INTO octo.embedding_configs
       (workspace_id, model, model_version, dimensions, chunker, chunk_size, chunk_overlap)
     VALUES ($1, 'hybrid-e2e', 'v1', 1024, 'paragraph-aware', 800, 100) RETURNING id`,
    [workspaceId]
  );

  created.push({ workspaceId, principalId });
  return { workspaceId, principalId, configId: config[0]!.id };
}
/** Seeds one document with a single chunk and its embedding on `axis`. */
async function seedChunk(
  ws: Workspace,
  title: string,
  content: string,
  axis: number
): Promise<{ documentId: string; chunkId: string }> {
  const doc = await queryService<{ id: string }>(
    `INSERT INTO octo.documents (workspace_id, title, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [ws.workspaceId, title, ws.principalId]
  );
  const documentId = doc[0]!.id;

  const version = await queryService<{ id: string }>(
    `INSERT INTO octo.document_versions
       (document_id, workspace_id, version_number, content_hash, mime_type, byte_size, extracted_text, extraction_status)
     VALUES ($1, $2, 1, $3, 'text/plain', $4, $5, 'extracted') RETURNING id`,
    [documentId, ws.workspaceId, `sha256:${randomUUID()}`, content.length, content]
  );

  const chunk = await queryService<{ id: string }>(
    `INSERT INTO octo.chunks
       (workspace_id, document_version_id, config_id, chunk_index, chunk_key, content, start_offset, end_offset, token_estimate)
     VALUES ($1, $2, $3, 0, $4, $5, 0, $6, 10) RETURNING id`,
    [ws.workspaceId, version[0]!.id, ws.configId, `key-${randomUUID()}`, content, content.length]
  );
  const chunkId = chunk[0]!.id;

  await queryService(
    `INSERT INTO octo.embeddings (workspace_id, chunk_id, config_id, embedding) VALUES ($1, $2, $3, $4::vector)`,
    [ws.workspaceId, chunkId, ws.configId, oneHot(axis)]
  );

  return { documentId, chunkId };
}

interface HybridMatch {
  chunkId: string;
  content: string;
  similarity: number | null;
  lexicalScore: number | null;
  score: number;
}

/** Calls the same function POST /api/rag/query calls. */
async function hybrid(
  ws: Workspace,
  queryText: string,
  probeAxis: number,
  limit = 10
): Promise<HybridMatch[]> {
  return queryService<HybridMatch>(
    `SELECT chunk_id AS "chunkId", content, similarity,
            lexical_score AS "lexicalScore", score
     FROM octo.match_chunks_hybrid($1, $2::vector, $3, $4)`,
    [ws.workspaceId, oneHot(probeAxis), queryText, limit]
  );
}

async function vectorOnly(ws: Workspace, probeAxis: number, limit = 10) {
  return queryService<{ chunkId: string; similarity: number }>(
    `SELECT chunk_id AS "chunkId", similarity
     FROM octo.match_chunks($1, $2::vector, $3, 0)`,
    [ws.workspaceId, oneHot(probeAxis), limit]
  );
}

test.describe('hybrid retrieval', () => {
  test('MR-1: an exact identifier outranks the vector-preferred chunk', async () => {
    const ws = await seedWorkspace();
    // The identifier chunk is orthogonal to the probe vector (axis 1 vs probe 2).
    const identifier = await seedChunk(
      ws,
      `Deploy ${randomUUID()}`,
      'The deploy key is ZQX-7741-OMEGA and it rotates every ninety days.',
      1
    );
    const generic = await seedChunk(
      ws,
      `Policy ${randomUUID()}`,
      'Rotation schedules for credentials vary by environment and team policy.',
      2
    );

    // Baseline: vector-only puts the generic chunk first and cannot surface the
    // identifier above it.
    const vec = await vectorOnly(ws, 2);
    expect(vec.map((r) => r.chunkId)).toEqual([generic.chunkId, identifier.chunkId]);

    // Hybrid surfaces the identifier first, and it does so via the lexical arm.
    const fused = await hybrid(ws, 'ZQX-7741-OMEGA', 2);
    expect(fused[0]!.chunkId).toBe(identifier.chunkId);
    expect(fused[0]!.lexicalScore).not.toBeNull();
    expect(fused[0]!.similarity).toBe(0);

    // The vector arm's preference is still represented, ranked second.
    expect(fused[1]!.chunkId).toBe(generic.chunkId);
    expect(fused[1]!.lexicalScore).toBeNull();
  });

  test('MR-2: an empty lexical arm degrades to vector ranking instead of failing', async () => {
    const ws = await seedWorkspace();
    const identifier = await seedChunk(ws, `A ${randomUUID()}`, 'the deploy key is ZQX-7741-OMEGA', 1);
    const generic = await seedChunk(ws, `B ${randomUUID()}`, 'credential rotation policy', 2);

    const noOverlap = await hybrid(ws, 'zzz nonexistentterm', 2);
    expect(noOverlap.map((r) => r.chunkId)).toEqual([generic.chunkId, identifier.chunkId]);
    expect(noOverlap.every((r) => r.lexicalScore === null)).toBe(true);

    // Every token is a stopword, so the lexical query is NULL. This must not throw.
    const stopwords = await hybrid(ws, 'how does the', 2);
    expect(stopwords.map((r) => r.chunkId)).toEqual([generic.chunkId, identifier.chunkId]);
    expect(stopwords.every((r) => r.lexicalScore === null)).toBe(true);
  });

  test('MR-3: neither arm reaches another workspace', async () => {
    const mine = await seedWorkspace();
    const other = await seedWorkspace();

    const mineChunk = await seedChunk(mine, `Mine ${randomUUID()}`, 'shared term ZQX-7741-OMEGA', 2);
    await seedChunk(other, `Theirs ${randomUUID()}`, 'shared term ZQX-7741-OMEGA', 2);

    const fused = await hybrid(mine, 'ZQX-7741-OMEGA', 2);
    expect(fused.map((r) => r.chunkId)).toEqual([mineChunk.chunkId]);
  });

  test('MR-4: limit bounds the fused result', async () => {
    const ws = await seedWorkspace();
    for (let i = 0; i < 4; i += 1) {
      await seedChunk(ws, `Doc ${i} ${randomUUID()}`, `shared term ZQX-7741-OMEGA number ${i}`, i + 1);
    }
    expect((await hybrid(ws, 'ZQX-7741-OMEGA', 1, 10)).length).toBe(4);
    expect((await hybrid(ws, 'ZQX-7741-OMEGA', 1, 2)).length).toBe(2);
  });

  test('MR-5: an identifier embedded in a URL path is still recoverable', async () => {
    const ws = await seedWorkspace();
    // The identifier only appears inside a URL path, so the raw parser would keep
    // the whole path as one lexeme and the query's words would never match it.
    const embedded = await seedChunk(
      ws,
      `Dataset ${randomUUID()}`,
      'Download from https://huggingface.co/davidschulte/ESM_nguha__legalbench_citation_prediction_open',
      1
    );
    const generic = await seedChunk(
      ws,
      `Notes ${randomUUID()}`,
      'Benchmark results are summarized in the appendix for each release.',
      2
    );

    const fused = await hybrid(ws, 'ESM_nguha__legalbench_citation_prediction', 2);
    expect(fused[0]!.chunkId).toBe(embedded.chunkId);
    expect(fused[0]!.lexicalScore).not.toBeNull();
    expect(fused.map((r) => r.chunkId)).toContain(generic.chunkId);
  });
});
