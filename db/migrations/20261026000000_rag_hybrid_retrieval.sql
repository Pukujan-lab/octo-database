-- Octo Schema: Slice 8 - Hybrid retrieval (lexical + vector, fused with RRF)
--
-- Vector-only retrieval loses recall on questions whose answer is an exact string:
-- identifiers, error codes, proper nouns, dates, and technical constants. The
-- embedding of "ZQX-7741-OMEGA" sits near every other hyphenated token, so cosine
-- ranking cannot reliably surface the chunk that literally contains it.
--
-- This adds a lexical arm over the same chunks and fuses the two rankings with
-- Reciprocal Rank Fusion (Cormack et al., k=60). RRF is used rather than a weighted
-- score sum because ts_rank and cosine similarity are not on a comparable scale and
-- any fixed weight would be a tuning guess; RRF needs only the ranks.
--
-- Both arms read octo.chunks, so the corpora cannot drift apart the way a separate
-- BM25 index could. The lexical arm deliberately does not join octo.embeddings, so a
-- chunk whose embedding is missing is still findable by text.
--
-- match_chunks (the vector-only primitive) is left in place: it remains the
-- semantic-only surface, and this migration only adds alongside it.

-- A GIN index over the generated tsvector is what makes the lexical arm an index
-- scan instead of a sequential ts_rank over every chunk in the workspace.
--
-- 'english' rather than 'simple': the config supplies stemming and stopwords, and
-- the query is built from the *output* lexemes of the same config, so whatever the
-- parser drops (stopwords, pure punctuation) is dropped on both sides symmetrically.
ALTER TABLE octo.chunks
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_content_tsv ON octo.chunks USING GIN (content_tsv);

-- Hybrid retrieval. Signature mirrors octo.match_chunks plus match_count, so the
-- route can swap the call without reshaping the request.
--
-- Returned columns keep the vector contract (`similarity`) and add the two hybrid
-- signals. `similarity` is NULL for a chunk the vector arm did not return, and
-- `lexical_score` is NULL for a chunk the lexical arm did not return; `score` is
-- always present. A consumer that only reads `similarity` still works, and the NULL
-- pattern says which arm produced each row.
DROP FUNCTION IF EXISTS octo.match_chunks_hybrid(UUID, vector, TEXT, INT);
CREATE FUNCTION octo.match_chunks_hybrid(
    target_workspace UUID,
    query_embedding vector(1024),
    query_text TEXT,
    match_count INT DEFAULT 10
)
RETURNS TABLE (
    chunk_id UUID,
    document_version_id UUID,
    content TEXT,
    chunk_index INT,
    similarity FLOAT,
    lexical_score FLOAT,
    score FLOAT,
    model TEXT,
    model_version TEXT,
    chunker TEXT
) AS $$
    -- Each arm contributes 4x the requested depth as an RRF candidate, so a chunk
    -- that is mid-ranked by one arm but top-ranked by the other still fuses into the
    -- result. A depth equal to match_count would make fusion mostly a no-op.
    WITH vec_raw AS (
        SELECT c.id AS chunk_id, 1 - (e.embedding <=> query_embedding) AS similarity
        FROM octo.embeddings e
        JOIN octo.chunks c ON c.id = e.chunk_id
        WHERE e.workspace_id = target_workspace
        ORDER BY e.embedding <=> query_embedding
        LIMIT match_count * 4
    ),
    -- A chunk may carry embeddings under more than one config; keep its best score
    -- so it enters the fused list once.
    vec AS (
        SELECT chunk_id, max(similarity)::float AS similarity
        FROM vec_raw
        GROUP BY chunk_id
    ),
    vec_ranked AS (
        SELECT chunk_id, similarity,
               row_number() OVER (ORDER BY similarity DESC, chunk_id) AS rank
        FROM vec
    ),
    -- Query lexemes come from the same config that produced the indexed tsvector.
    -- unnesting to_tsvector rather than calling plainto_tsquery means the query text
    -- is parsed once, exactly as the documents were, so punctuation and stopwords are
    -- handled identically on both sides. Quoting each lexeme keeps operator
    -- characters out of the tsquery grammar.
    query_lexemes AS (
        SELECT string_agg(quote_literal(lexeme), ' | ') AS tsq
        FROM unnest(to_tsvector('english', coalesce(query_text, ''))) AS t(lexeme, positions, weights)
    ),
    query_tsq AS (
        SELECT to_tsquery('english', NULLIF(tsq, '')) AS tsq FROM query_lexemes
    ),
    lex_raw AS (
        SELECT c.id AS chunk_id, ts_rank(c.content_tsv, q.tsq)::float AS lexical_score
        FROM octo.chunks c
        CROSS JOIN query_tsq q
        WHERE c.workspace_id = target_workspace
          AND q.tsq IS NOT NULL
          AND c.content_tsv @@ q.tsq
        ORDER BY lexical_score DESC, c.id
        LIMIT match_count * 4
    ),
    lex_ranked AS (
        SELECT chunk_id, lexical_score,
               row_number() OVER (ORDER BY lexical_score DESC, chunk_id) AS rank
        FROM lex_raw
    ),
    -- RRF: each arm contributes 1/(k + rank); k=60 is the value from the original
    -- paper and damps the difference between adjacent ranks so one arm cannot
    -- dominate purely by having a longer candidate list.
    fused AS (
        SELECT
            coalesce(v.chunk_id, l.chunk_id) AS chunk_id,
            v.similarity,
            l.lexical_score,
            (CASE WHEN v.rank IS NOT NULL THEN 1.0 / (60 + v.rank) ELSE 0 END
           + CASE WHEN l.rank IS NOT NULL THEN 1.0 / (60 + l.rank) ELSE 0 END)::float AS score
        FROM vec_ranked v
        FULL OUTER JOIN lex_ranked l ON l.chunk_id = v.chunk_id
    )
    SELECT
        c.id,
        c.document_version_id,
        c.content,
        c.chunk_index,
        f.similarity,
        f.lexical_score,
        f.score,
        cfg.model,
        cfg.model_version,
        cfg.chunker
    FROM fused f
    JOIN octo.chunks c ON c.id = f.chunk_id
    JOIN octo.embedding_configs cfg ON cfg.id = c.config_id
    ORDER BY f.score DESC, c.id
    LIMIT match_count;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION octo.match_chunks_hybrid(UUID, vector, TEXT, INT) TO authenticated;
