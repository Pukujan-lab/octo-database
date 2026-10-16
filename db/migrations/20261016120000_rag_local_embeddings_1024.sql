-- Octo Schema: RAG embeddings move to a local provider at 1024 dimensions.
--
-- Slice 8 fixed the vector width at 1536 to match the configured model. That slice
-- also states that a re-embed under a new config inserts a new embedding_configs row
-- rather than mutating the old one. That rule cannot hold when the DIMENSION itself
-- changes: the column is fixed-width, so a 1536 and a 1024 vector cannot coexist in
-- it, and a config row describing a 1536 model could never be satisfied again.
--
-- So the derived index is discarded and rebuilt instead. Only derived rows go:
-- chunks, embeddings, and the config rows that describe them. The canonical sources
-- -- octo.files (the bytes), octo.documents, and octo.document_versions with their
-- extracted_text -- are untouched, and scripts/reembed-rag.ts rebuilds the index
-- from extracted_text without re-uploading anything.
--
-- The runtime safety net is EMBEDDING_DIMENSION_MISMATCH in src/rag/embeddings.ts:
-- a host whose OCTO_EMBEDDING_DIMENSIONS disagrees with this column fails loudly at
-- ingest rather than writing vectors the query path cannot compare.

-- Explicit DELETEs rather than TRUNCATE ... CASCADE. The cascade from a TRUNCATE is
-- driven by foreign keys pointing AT the named table, so truncating chunks would
-- silently empty embeddings too, and the full reach of a CASCADE is not readable
-- from this file. The three statements below name every row being discarded.
DELETE FROM octo.embeddings;
DELETE FROM octo.chunks;
DELETE FROM octo.embedding_configs;

-- The table must be empty before the ALTER: pgvector's implicit vector -> vector
-- cast IS the typmod coercion, and it rejects a 1536-dimension value with
-- "expected 1024 dimensions, not 1536".
DROP INDEX IF EXISTS octo.idx_embeddings_hnsw;
ALTER TABLE octo.embeddings ALTER COLUMN embedding TYPE vector(1024);
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON octo.embeddings
    USING hnsw (embedding vector_cosine_ops);

-- DROP + CREATE rather than CREATE OR REPLACE: the parameter type is part of the
-- signature this function is granted on, and dropping it states the width change
-- explicitly in the migration record. DROP discards the EXECUTE grant, so it is
-- re-issued at the end of this file.
DROP FUNCTION IF EXISTS octo.match_chunks(UUID, vector, INT, FLOAT);
CREATE FUNCTION octo.match_chunks(
    target_workspace UUID,
    query_embedding vector(1024),
    match_count INT DEFAULT 10,
    min_similarity FLOAT DEFAULT 0.0
)
RETURNS TABLE (
    chunk_id UUID,
    document_version_id UUID,
    content TEXT,
    chunk_index INT,
    similarity FLOAT,
    model TEXT,
    model_version TEXT,
    chunker TEXT
) AS $$
    SELECT
        c.id,
        c.document_version_id,
        c.content,
        c.chunk_index,
        1 - (e.embedding <=> query_embedding) AS similarity,
        cfg.model,
        cfg.model_version,
        cfg.chunker
    FROM octo.embeddings e
    JOIN octo.chunks c ON c.id = e.chunk_id
    JOIN octo.embedding_configs cfg ON cfg.id = e.config_id
    WHERE e.workspace_id = target_workspace
      AND 1 - (e.embedding <=> query_embedding) >= min_similarity
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION octo.match_chunks(UUID, vector, INT, FLOAT) TO authenticated;
