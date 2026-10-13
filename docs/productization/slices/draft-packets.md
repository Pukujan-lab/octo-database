# Later Slice Packets (Draft Outlines)

These are planning drafts only. Give each slice a compact locked PDD/SDD/EVAL packet before implementation; do not treat this file as owner acceptance.

## Slice 2 — Complete the existing file lifecycle

**PDD:** A workspace user can upload, find, retrieve, archive, restore, and share the intended files. Reuse the current gallery, R2, Drive, jobs, and operations UI; do not build a general content-management system.

**SDD:** PostgreSQL retains stable logical identity and storage-location metadata; R2/Drive own bytes. Preserve current APIs. Bound work to demonstrated lifecycle gaps, including partial upload outcomes, archive/delete races, loss of cold-file locators, and scoped shares returning broader content. If folder targeting needs a missing model, define that as a bounded packet before pretending the target exists.

**EVAL:** Browser upload/download and archive/restore; byte equality and stable ID across tiers; visible job failure/retry; intended recipient sees only the shared target. Exercise the actual configured R2/Drive deployment. One unseen filename/content/tier scenario is justified. Level 2 because this slice changes durable state and promises recovery.

## Slice 3 — Thin clients

**PDD:** An app and an agent complete the same workspace/file job through the typed TypeScript SDK, CLI, or MCP. Do not duplicate policy or create a second backend.

**SDD:** The server stays authoritative. Build the SDK over the accepted HTTP contract; CLI and MCP wrap it using standard tooling. Start with discovery and the stabilized workspace/file/job operations. Use the platform's normal credential configuration.

**EVAL:** One fixture job through each client with equivalent results, refusal semantics, and job identifiers; revoke a credential between requests; one deployed read/write/read sequence. Hidden holdout none. Level 2 because these become supported product clients.

## Conditional packet — Retrieval correction (#10)

Only slices that expose RAG/GraphRAG retrieval depend on this packet; file/API/UI work and analytics without retrieval can ship independently.

**PDD:** Ingest one known PDF, retrieve its relevant passage with provenance, rebuild derived embeddings, and repeat the query.

**SDD:** Preserve the existing pgvector and embedding-provider integration. Correct the live ingest/rebuild path against issue #10; do not add a second vector system. Resolve source/version identity and re-embedding behavior within that accepted contract.

**EVAL:** The bounded PDF/provenance/rebuild job, configuration-history behavior required by #10, one interrupted-ingest retry, and workspace filtering. Run against the configured embedding provider. Level 2.

## Slices 4–5 — Frontend bakeoff and selected shell

**PDD:** A fresh user completes workspace selection, file retrieval, and failed-job recovery without owner coaching. Keep the dashboard, gallery, operations, and useful key management. Exclude SQL consoles, BI builders, graph explorers, and provider-admin duplication.

**SDD:** Use the same accepted workspace API and canonical backend. Select one component/design workflow, then migrate useful existing behavior into one shell.

**EVAL:** Shared browser tasks, clear empty/loading/error states, keyboard operation, consistent desktop/mobile layout, and one unseen workspace fixture. Smoke actual login and file retrieval. Bakeoff is Level 1; shipped shell is Level 2.

## Slice 6 — Fresh-machine recovery

**PDD:** Restore one owner-selected set of important user/agent files to an empty working directory. A possible initial set is selected configuration, memories, custom skills, and one repository reference; the owner must choose exact paths and authority. Whole-home backup and bidirectional conflict resolution are excluded.

**SDD:** First, the owner chooses exact paths and authority for each data class. Then compare existing provider/OSS recovery surfaces before choosing a manifest, snapshot format, CLI command, or UI. Keep canonical state and rebuildable caches distinct. Do not add a new metadata service or bidirectional sync unless the selected job proves it necessary.

**EVAL:** Snapshot, remove the working copy, restore elsewhere, compare declared important bytes, clone the declared repository, and rebuild one cache. Machine/path changes preserve canonical identity. An interrupted snapshot is not marked complete. Use one unseen file-set/path variant. Level 2.

**Owner decision:** Exact included paths, canonical authority, and treatment of local changes per data class. Do not infer them from all local agent directories.

## Slice 7 — Historical analytics

**PDD:** Answer one agreed long-range workspace question as a recorded analytics job; for example, job failures by type and month. Reuse issue #13's dataset/result contract. Do not build a BI product.

**SDD:** PostgreSQL owns dataset/version/query/job/result metadata. Parquet in R2 owns exported history; DuckDB is disposable compute. The API discovers and submits the query and fetches status/results; the operations UI submits the accepted query. Export checkpoints must not silently drop or double-count history.

**EVAL:** Multi-file Parquet answers match a known dataset; repartitioning preserves results; retry does not duplicate catalog output; corrupt/schema-mismatched data shows failure; timeout/cancellation/workspace denial follow #13. Verify deployed R2/DuckDB. Level 2.

## Slice 8 — Bounded agent proposal

**PDD:** An agent proposes one supported change; a human reviews the exact change; the server executes only that accepted version. Start with an existing action such as archiving a named file set; exclude a universal automation/policy engine.

**SDD:** PostgreSQL owns proposal content, preview result, state, and execution references. Agent uses its normal scoped API. Human authorization is distinct and tied to the proposal version. Reuse existing action/jobs. Do not add MFA solely because nonbinding research mentions it.

**EVAL:** Agent submits; human sees affected objects; changed/expired proposal cannot execute under old authorization; agent cannot impersonate the human; retry does not duplicate work. One changed-object variant and deployed propose/review/execute flow. Level 2.

## Slice 9 — Optional graph projection

**PDD:** A workspace that needs graph traversal can query canonical evidence and recover after graph deletion. Reuse issue #12; graph is not mandatory for every workspace.

**SDD:** PostgreSQL epistemic records remain canonical; Neo4j is derived. Existing jobs drive projection/rebuild. Expose only the rebuild/freshness state the accepted job needs. Use the native graph console for graph administration. Retrieval-dependent GraphRAG waits for #10's bounded correction packet.

**EVAL:** Project/query, replay, update/supersede, delete graph, rebuild, and compare logical results; show stale state; enforce workspace binding; retain evidence IDs. Reuse #12's stated checks and smoke one graph-enabled workspace. Level 2.

## Slice 8 addendum — RAG document lifecycle

**PDD:** A workspace that ingests documents can also manage them: list what is indexed, read one document and its versions, rename its title, and delete it with everything derived from it. Ingest and semantic query already worked; without the rest, an agent that indexed the wrong thing had no way to find it again or remove it.

**SDD:** Adds the four routes (`GET /api/rag/documents`, `GET /api/rag/documents/<id>`, `POST /api/rag/documents/<id>/rename`, `DELETE /api/rag/documents/<id>`) over the existing `octo.documents`/`document_versions`/`chunks`/`embeddings` model. Rename is metadata-only — versions are content-hashed and immutable, so a text change stays a re-ingest. One migration adds the missing `documents_update_operator` and `documents_delete_owner_admin` row-security policies; deleting a document row already cascades to every derived row, so no extra cleanup SQL is needed. Scope and role checks mirror the file routes: read for list/get, write plus operator for rename, delete plus owner/admin for delete.

**EVAL:** `tests/e2e/rag-document-lifecycle.spec.ts` drives the full job over HTTP against a real database (fixtures seeded directly, since CI has no embedding provider). MR-1: deleting one document leaves a sibling's versions, chunks, and embeddings untouched. MR-2: a key missing the scope, missing the role, or pinned to another workspace is refused, and the document survives. Malformed ids follow the existing `identifier-validation` 400 contract. MCP tool coverage (`list_documents`, `get_document`, `rename_document`, `delete_document`) is asserted in `tests/unit/mcp-server.test.ts`.

## Optional integrated demonstration

After independently shippable slices are complete, the owner may request a cross-slice demonstration on the deployed test candidate: login → workspace → discovery → file operations → clients → recovery → enabled analytics/proposal/projection jobs. It is a summary, not an additional acceptance gate for any completed slice. Production changes continue through a pull request into `production` with auto-merge armed.
