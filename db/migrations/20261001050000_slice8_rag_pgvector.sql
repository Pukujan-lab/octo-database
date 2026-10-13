-- Octo Schema: Slice 8 - Retrieval (documents, chunks, embeddings)
--
-- Ownership split:
--   * canonical: document/version metadata, chunk provenance, embedding config
--   * durable bytes: the original object in R2/Drive (octo.files), untouched
--   * derived: chunks and embedding vectors, rebuildable from the original
--
-- Deleting the derived index must never destroy the source/version records, so
-- chunks and embeddings cascade from the version while the version itself is only
-- removed deliberately.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS octo.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT documents_unique_title UNIQUE (workspace_id, title)
);

-- An immutable version of a source file. Re-ingesting the same bytes is idempotent
-- via the unique content hash, so a retry cannot create a duplicate version.
CREATE TABLE IF NOT EXISTS octo.document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES octo.documents(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    file_id UUID REFERENCES octo.files(id) ON DELETE SET NULL,
    version_number INT NOT NULL,
    content_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size BIGINT,
    extracted_text TEXT,
    extraction_status TEXT NOT NULL CHECK (extraction_status IN ('pending', 'extracted', 'failed'))
        DEFAULT 'pending',
    extraction_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT document_versions_unique UNIQUE (document_id, content_hash),
    CONSTRAINT document_versions_number UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_workspace ON octo.document_versions(workspace_id);

-- Embedding configuration identity. A re-embed under a new config inserts a new row
-- rather than mutating the old one, so historical configuration identity survives.
CREATE TABLE IF NOT EXISTS octo.embedding_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    dimensions INT NOT NULL CHECK (dimensions > 0),
    chunker TEXT NOT NULL,
    chunk_size INT NOT NULL CHECK (chunk_size > 0),
    chunk_overlap INT NOT NULL DEFAULT 0 CHECK (chunk_overlap >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT embedding_configs_unique UNIQUE (workspace_id, model, model_version, chunker, chunk_size, chunk_overlap),
    CONSTRAINT embedding_configs_overlap CHECK (chunk_overlap < chunk_size)
);

-- Chunks are derived artifacts. The chunk key is deterministic so re-running the
-- pipeline targets the same row instead of appending duplicates.
CREATE TABLE IF NOT EXISTS octo.chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    document_version_id UUID NOT NULL REFERENCES octo.document_versions(id) ON DELETE CASCADE,
    config_id UUID NOT NULL REFERENCES octo.embedding_configs(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    chunk_key TEXT NOT NULL,
    content TEXT NOT NULL,
    start_offset INT NOT NULL,
    end_offset INT NOT NULL,
    token_estimate INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chunks_key_unique UNIQUE (document_version_id, config_id, chunk_key)
);

CREATE INDEX IF NOT EXISTS idx_chunks_version ON octo.chunks(document_version_id);
CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON octo.chunks(workspace_id);

-- Embedding vectors. Dimensions are fixed at 1536 to match the configured model;
-- changing the model means a new config row, not an in-place rewrite.
CREATE TABLE IF NOT EXISTS octo.embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL REFERENCES octo.chunks(id) ON DELETE CASCADE,
    config_id UUID NOT NULL REFERENCES octo.embedding_configs(id) ON DELETE CASCADE,
    embedding vector(1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT embeddings_unique UNIQUE (chunk_id, config_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_workspace ON octo.embeddings(workspace_id);
-- HNSW gives reasonable recall without a training step.
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON octo.embeddings
    USING hnsw (embedding vector_cosine_ops);

ALTER TABLE octo.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.embedding_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_select_member ON octo.documents
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY document_versions_select_member ON octo.document_versions
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY embedding_configs_select_member ON octo.embedding_configs
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY chunks_select_member ON octo.chunks
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY embeddings_select_member ON octo.embeddings
    FOR SELECT USING (octo.is_workspace_member(workspace_id));

CREATE POLICY documents_insert_operator ON octo.documents
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY document_versions_insert_operator ON octo.document_versions
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY embedding_configs_insert_operator ON octo.embedding_configs
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY chunks_insert_operator ON octo.chunks
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY embeddings_insert_operator ON octo.embeddings
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));

-- Workspace-scoped semantic retrieval. The workspace filter is applied in SQL so a
-- caller cannot retrieve another workspace's chunks even with a valid vector.
CREATE OR REPLACE FUNCTION octo.match_chunks(
    target_workspace UUID,
    query_embedding vector(1536),
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

-- DML only: TRUNCATE and REFERENCES are not subject to row security.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.document_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.embedding_configs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.chunks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.embeddings TO authenticated;
GRANT EXECUTE ON FUNCTION octo.match_chunks(UUID, vector, INT, FLOAT) TO authenticated;
