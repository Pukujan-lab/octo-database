# OCTO-0800 Normal RAG with PostgreSQL/pgvector

<!-- continuity:task {"acceptance":["documents and versions tracked with content hashes so re-ingest is idempotent","embedding configurations coexist as immutable rows rather than being overwritten","deterministic chunk keys produce stable derived rows on repeat runs","workspace-scoped semantic retrieval filters chunks in SQL so cross-workspace queries never return another's chunks","deleting derived embeddings and chunks leaves documents, versions, and configs intact","text extraction refuses unsupported binaries rather than indexing garbage","no separate vector database required"],"depends_on":["OCTO-0200","OCTO-0700"],"goal":"Add retrieval capability using document extraction, chunking, embedding metadata, and pgvector","id":"OCTO-0800","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/10","next_action":"Merged in PR #36 with green gates.","owner":"Pukujan; main agent coordinates implementation","priority":"P1","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"Let agents retrieve relevant workspace chunks with provenance back to the exact source and config."} -->

- Status: completed
- Priority: P1
- Branch: `task/OCTO-0800-rag-pgvector`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/10

## Goal

Add the first retrieval capability using document extraction, chunking, embedding metadata, and
PostgreSQL/pgvector. Original evidence remains in R2/Drive; retrieval artifacts are derived and
rebuildable.

## Prepared on this branch

- Migration `supabase/migrations/20261001050000_slice8_rag_pgvector.sql` enabling the `vector`
  extension, defining `octo.documents`, `octo.document_versions`, `octo.embedding_configs`,
  `octo.chunks`, `octo.embeddings` with an HNSW cosine index, and `octo.match_chunks`.
- Pipeline `src/rag/pipeline.ts` (content hashing, deterministic chunk keys, paragraph-aware
  chunking, plain-text extraction, in-process cosine similarity).
- Provider client `src/rag/embeddings.ts` (pluggable OpenAI-compatible embeddings, fail-closed when
  unconfigured; no silent fake fallback).
- Server routes `POST /api/rag/documents` and `POST /api/rag/query`.
- CI updated to use `pgvector/pgvector:pg16` so the extension is present in GitHub Actions.
- Tests: `tests/unit/rag-pipeline.test.ts`, `tests/test_slice8_schema.py`.

## Design notes

- **Clear ownership split**: documents, versions, and configs are canonical; chunks and vectors are
  derived. Deleting derived tables leaves versions intact; re-embedding coexists under a new config.
- **Fail closed on unconfigured provider**: InferHub exposes no embeddings endpoint, so borrowing
  its chat key would fail silently at runtime. The embedding client is explicitly configured via
  `OCTO_EMBEDDING_API_KEY` and fails closed (503) when absent.
- **Workspace filtering in SQL**: `match_chunks` applies the workspace filter inside the query, so a
  caller cannot retrieve another workspace's chunks even with an identical vector.

## Checkpoint log

### 2026-10-01 10:00:00 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["supabase/migrations/20261001050000_slice8_rag_pgvector.sql","src/rag/pipeline.ts","src/rag/embeddings.ts","src/server/db.ts","src/server/index.ts",".github/workflows/gates.yml","tests/unit/rag-pipeline.test.ts","tests/test_slice8_schema.py"],"completed":["PostgreSQL pgvector retrieval schema with HNSW index, deterministic chunking, and workspace-scoped retrieval"],"decisions":["Use pgvector exclusively rather than introducing a separate vector DB","Fail closed when no embedding provider is configured instead of substituting a fake local embedding","Filter workspace inside the SQL match function rather than client-side"],"evidence":["Live: match_chunks scoped to rag-ws returned only rag-ws chunks (similarity 1.0) with an identical vector present in other-rag","Live: deleting all embeddings and chunks left 2 documents, 2 versions, and 2 configs intact","Live: re-embedding under text-embedding-3-large/2 coexisted with the v1 config","Live: duplicate content hash was rejected by document_versions_unique","74 Vitest tests and 48 Python tests pass"],"next_action":"Merge PR after green gates, then continue with the next accepted slice","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0800","timestamp":"2026-10-01T10:00:00Z"} -->

Completed:
- PostgreSQL pgvector retrieval schema with HNSW index, deterministic chunking, and workspace-scoped retrieval

Evidence:
- Live: `match_chunks` scoped to `rag-ws` returned only `rag-ws` chunks (similarity 1.0) with an identical vector present in `other-rag`
- Live: deleting all embeddings and chunks left 2 documents, 2 versions, and 2 configs intact
- Live: re-embedding under `text-embedding-3-large/2` coexisted with the v1 config (3 config rows present)
- Live: duplicate content hash was rejected by `document_versions_unique`
- 74 Vitest tests and 48 Python tests pass

Decisions:
- Use pgvector exclusively rather than introducing a separate vector DB
- Fail closed when no embedding provider is configured instead of substituting a fake local embedding
- Filter workspace inside the SQL match function rather than client-side

Changed:
- supabase/migrations/20261001050000_slice8_rag_pgvector.sql
- src/rag/pipeline.ts
- src/rag/embeddings.ts
- src/server/db.ts
- src/server/index.ts
- .github/workflows/gates.yml
- tests/unit/rag-pipeline.test.ts
- tests/test_slice8_schema.py

Blocked/uncertain:
- An external embedding provider is not configured in this environment (InferHub has no embeddings
  endpoint). The schema, pipeline, and SQL retrieval function are fully verified; live semantic search
  awaits setting `OCTO_EMBEDDING_API_KEY`.

Next:
- Merge PR after green gates, then continue with the next accepted slice
