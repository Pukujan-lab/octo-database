/**
 * One-off rebuild of the RAG index after the vector width changed.
 *
 * db/migrations/20261016120000_rag_local_embeddings_1024.sql discards every chunk,
 * embedding, and embedding_config row and narrows octo.embeddings.embedding to
 * vector(1024). This rebuilds that derived index from
 * octo.document_versions.extracted_text, which the migration leaves alone, so no
 * source file has to be re-uploaded.
 *
 * Runs on the SERVICE pool (BYPASSRLS). A backfill has no caller principal, and the
 * app pool is fenced by request identity, which a standalone script does not have.
 *
 * Env:
 *   OCTO_SERVICE_URL (or DATABASE_URL)   service connection
 *   OCTO_EMBEDDING_BASE_URL / _MODEL / _DIMENSIONS
 *
 * Also the re-index after a chunker change (issue #357 renamed the chunker to
 * paragraph-aware-v2): every text version is re-chunked under the current config.
 *
 * Exit 0 = rebuilt, 2 = misconfigured. Idempotent: each version's derived rows are
 * deleted and rewritten inside one transaction, so a crash cannot leave a
 * half-indexed version and a re-run is safe.
 */

import { embedTexts, loadEmbeddingConfigFromEnv } from '../src/rag/embeddings';
import { RAG_CHUNKER, RAG_CHUNK_OVERLAP, RAG_CHUNK_SIZE, RAG_MODEL_VERSION } from '../src/rag/ingest';
import { chunkKey, chunkText, type ChunkConfig } from '../src/rag/pipeline';
import { queryService, servicePool, withTransaction } from '../src/server/db';

// The config identity is the one every ingest path writes (src/rag/ingest.ts), or a
// later ingest would write a second embedding_configs row for the same model.
const MODEL_VERSION = RAG_MODEL_VERSION;
const CHUNKER = RAG_CHUNKER;
const CHUNK_SIZE = RAG_CHUNK_SIZE;
const CHUNK_OVERLAP = RAG_CHUNK_OVERLAP;
const EMBED_BATCH = 32;

interface VersionRow {
  id: string;
  workspace_id: string;
  extracted_text: string;
}

async function ensureConfig(
  workspaceId: string,
  model: string,
  dimensions: number
): Promise<string> {
  const inserted = await queryService<{ id: string }>(
    `INSERT INTO octo.embedding_configs
       (workspace_id, model, model_version, dimensions, chunker, chunk_size, chunk_overlap)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, model, model_version, chunker, chunk_size, chunk_overlap)
     DO NOTHING
     RETURNING id`,
    [workspaceId, model, MODEL_VERSION, dimensions, CHUNKER, CHUNK_SIZE, CHUNK_OVERLAP]
  );
  if (inserted[0]) return inserted[0].id;

  const existing = await queryService<{ id: string }>(
    `SELECT id FROM octo.embedding_configs
      WHERE workspace_id = $1 AND model = $2 AND model_version = $3
        AND chunker = $4 AND chunk_size = $5 AND chunk_overlap = $6`,
    [workspaceId, model, MODEL_VERSION, CHUNKER, CHUNK_SIZE, CHUNK_OVERLAP]
  );
  return existing[0]!.id;
}

async function main(): Promise<void> {
  const embeddingConfig = loadEmbeddingConfigFromEnv();
  if (!embeddingConfig) {
    console.error(
      'reembed-rag: no embedding provider configured (set OCTO_EMBEDDING_BASE_URL and OCTO_EMBEDDING_MODEL)'
    );
    process.exit(2);
  }

  const versions = await queryService<VersionRow>(
    `SELECT id, workspace_id, extracted_text
       FROM octo.document_versions
      WHERE extraction_status = 'extracted' AND extracted_text IS NOT NULL
        -- A PDF is re-indexed by queueing its rag_ingest_file job again: its chunks
        -- are per-page passages, which re-chunking the flat text would lose.
        AND split_part(mime_type, ';', 1) <> 'application/pdf'
      ORDER BY workspace_id, version_number`
  );

  const chunkConfig: ChunkConfig = {
    model: embeddingConfig.model,
    modelVersion: MODEL_VERSION,
    dimensions: embeddingConfig.dimensions,
    chunker: CHUNKER,
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  };

  const configIds = new Map<string, string>();
  let chunkTotal = 0;

  for (const version of versions) {
    let configId = configIds.get(version.workspace_id);
    if (!configId) {
      configId = await ensureConfig(
        version.workspace_id,
        embeddingConfig.model,
        embeddingConfig.dimensions
      );
      configIds.set(version.workspace_id, configId);
    }

    const chunks = chunkText(version.extracted_text, chunkConfig).map((c) => ({
      ...c,
      chunkKey: chunkKey(version.id, configId, c.chunkIndex),
    }));
    if (chunks.length === 0) continue;

    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const result = await embedTexts(embeddingConfig, batch.map((c) => c.content));
      vectors.push(...result.vectors);
    }

    await withTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM octo.embeddings
          WHERE chunk_id IN (SELECT id FROM octo.chunks WHERE document_version_id = $1)`,
        [version.id]
      );
      await tx.query('DELETE FROM octo.chunks WHERE document_version_id = $1', [version.id]);

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]!;
        const inserted = await tx.query(
          `INSERT INTO octo.chunks
             (workspace_id, document_version_id, config_id, chunk_index, chunk_key, content,
              start_offset, end_offset, token_estimate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            version.workspace_id, version.id, configId, chunk.chunkIndex, chunk.chunkKey,
            chunk.content, chunk.startOffset, chunk.endOffset, chunk.tokenEstimate,
          ]
        );
        const chunkId = (inserted.rows[0] as { id: string }).id;
        await tx.query(
          `INSERT INTO octo.embeddings (workspace_id, chunk_id, config_id, embedding)
           VALUES ($1, $2, $3, $4::halfvec)`,
          [version.workspace_id, chunkId, configId, `[${vectors[i]!.join(',')}]`]
        );
      }
    }, servicePool);

    chunkTotal += chunks.length;
    console.log(`  ${version.workspace_id}  ${version.id}  ${chunks.length} chunks`);
  }

  console.log(
    JSON.stringify({
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
      versions: versions.length,
      chunks: chunkTotal,
    })
  );
  await servicePool.end();
}

main().catch((err) => {
  console.error('reembed-rag failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
