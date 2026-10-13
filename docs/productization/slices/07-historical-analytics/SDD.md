# Slice 7 — Historical Analytics (SDD)

**Status: appendix to the merged locked-format packet `docs/productization/slices/07-historical-analytics.md`. That packet is authoritative; this file is subordinate to it. Where this appendix and the packet differ, the packet governs. Not locked — do not implement until the owner locks the packet on issue #13.**

Owning issue: #13 (OCTO-1100, "DuckDB and Parquet analytical workspace over R2 datasets"), aligned to Slice 7 of `SLICE_MAP.md`. Robustness target: **Level 2**.

This appendix carries the implementation-level detail behind the packet's SDD section: concrete request/response types, the migration shape, the DuckDB handler mechanics, and the failure boundary. It adds no decision the packet does not make.

## SDD

### Authority/canonical state

Hard boundary, stated once and reused everywhere below:

- **PostgreSQL (control plane, `octo` schema) owns dataset, version, job, and result METADATA.** It stores the catalog rows, the ordered object-key list, the schema declaration, provenance, the declared export window (watermark), row counts, content hashes, and the job/result references. It never stores analytical rows.
- **R2 owns the Parquet BYTES** — both dataset parts and result artifacts. The bytes are canonical; the catalog row indexes them.
- **DuckDB is disposable compute with no durable state.** It reads Parquet objects, answers the query, writes a result artifact, and is torn down. There is no persistent DuckDB file and nothing durable depends on it.

Consequences that are load-bearing:

- A dataset version is **immutable**. A re-export is a new version row, never a mutation. Version 1's object keys stay version 1's. Logical dataset identity is the pair **(dataset slug, server-assigned version number)**; the immutable handle is `datasetVersionId`.
- The result artifact is **derivable** from `(immutable dataset version, named query spec, pinned engine version)`. It is a derived artifact, not a second authority. Its immutable handle is `resultId` (a registered `AnalyticsResult` row).
- Bulk analytical rows never enter operational Postgres. This is the slice's stated design evidence (issue #13 "operational DB row-count/design evidence").
- The workspace id in every object key is the authenticated workspace id, never a request value. Layout (`lake/`, `dt=`) is a convention, not the authorization mechanism — authorization is enforced on the catalog row and the existing route fence.

### Capabilities

Add four descriptors to `OCTO_CAPABILITIES` in `src/api/capabilities.ts`, in the existing `CapabilityDescriptor` shape (`action`/`method`/`path`/`requiredScope`/`description`). **No new scope is introduced** — the existing `read`/`write` scopes are reused, and `minimumRoleForCapability` is unchanged (all four are `member`).

| action | method | path | requiredScope | min role |
|---|---|---|---|---|
| `datasets.register` | POST | `/api/workspaces/<id>/datasets` | `write` | member |
| `analytics.query` | POST | `/api/workspaces/<id>/analytics/queries` | `read` | member |
| `analytics.query_status` | GET | `/api/workspaces/<id>/analytics/queries/<jobId>` | `read` | member |
| `analytics.result` | GET | `/api/workspaces/<id>/analytics/results/<resultId>` | `read` | member |

Rationale for the scope split: registering a dataset version is a durable, mutating catalog write and requires `write`; submitting a query only enqueues a read-only job over an immutable version and requires `read`. This matches the Slice 21 SQL surface, where `read` runs read-only and `write` is required to mutate.

**No new scope is introduced, deliberately.** Issue #13 says the agent "receives only scoped analytics capability"; the minimal-change answer is the existing `read`/`write` scopes applied to the new routes, not a new `analytics` scope. The existing `analytics` **key class** in `src/api/capabilities.ts` is read-only (`scopes: ['read']`, "No ... mutations.") and therefore **cannot register a dataset**; a caller that must both register and query needs a `write`-scoped key (for example `program-write` or an explicit scope list). The read-only analytics class covers query/status/result only.

Discovery grants no authority beyond route enforcement: each route re-checks `authenticateRequest`, `requireScope`, `keyWorkspaceMatches`, and `dbGetWorkspaceMembership` before any engine work.

### API contract

Routes follow the house pattern in `src/server/index.ts`: `authenticateRequest` → `requireScope` → `requireUuid` → `keyWorkspaceMatches` → `dbGetWorkspaceMembership` → resource lookup → engine probe. The workspace fence is checked **before** the engine is probed, so an unauthorized caller never learns whether analytics is configured (the `tests/e2e/graph-read.spec.ts` shape). Errors carry the existing top-level `error` string; where an engine code exists it is reported in `code`, matching the SQL surface's `{ error: 'SQL_ERROR', message, code }` shape.

**Register a dataset version**

```http
POST /api/workspaces/:id/datasets
Authorization: Bearer <octo_live_...>
Content-Type: application/json
```

```ts
type RegisterDatasetRequest = {
  dataset: string;                                 // logical slug, [a-z0-9-]
  format: 'parquet';                               // only parquet in this slice
  schema: Array<{ name: string; type: string }>;   // declared; validated against the Parquet footer
  provenance: { source: string; exportedAt: string; [k: string]: unknown };
  watermark?: string;                              // declared export window; owner confirm
  idempotencyKey?: string;                         // repeat returns the original version
  parts: Array<{ partition: string; dataBase64: string }>; // partition = 'YYYY-MM-DD'; bytes base64
};

type RegisterDatasetResponse = {
  datasetVersion: {
    id: string; datasetId: string; dataset: string; version: number;
    format: 'parquet';
    schema: Array<{ name: string; type: string }>;
    objectKeys: string[]; rowCount: number;
    provenance: Record<string, unknown>; watermark: string | null;
    createdAt: string;
  };
  created: boolean;
};
```

The caller supplies **no object key and no path**. The server derives every part key from the authenticated workspace id, the logical dataset slug, the assigned version number, the validated partition, and a generated part id:

```
workspaces/<workspaceId>/lake/<datasetSlug>/v<versionNumber>/dt=<YYYY-MM-DD>/part-<uuid>.parquet
```

It writes each part through the existing `ObjectStore.put`, reads each Parquet footer back to validate `format` and that the declared `schema` matches (rejecting a mismatch with `SCHEMA_MISMATCH` before any catalog row is written), requires the declared schema to include the accepted spec's input columns (`job_type`, `state`, `created_at` with compatible types), sets `rowCount` to the sum of the parts' footer row counts, and inserts the version row in one transaction. The schema is an explicit ordered array of `{ name, type }` (Parquet type names) stored as `jsonb`; it is the declared contract, validated against the footer, not inferred. Version numbers are **server-assigned** (`max(version)+1` for the logical dataset, computed inside the insert transaction); `(dataset_id, version)` is unique, so a concurrent registration of the same slug fails closed with `409 DATASET_VERSION_CONFLICT`. `201` on a new version; `200` with the original row when `idempotencyKey` repeats.

**Submit an analytical query**

```http
POST /api/workspaces/:id/analytics/queries
Authorization: Bearer <octo_live_...>
Content-Type: application/json
```

```ts
type SubmitQueryRequest = {
  datasetVersionId: string;                       // must belong to this workspace
  querySpec: 'job-failures-by-type-month@1';      // named spec; the caller never supplies SQL
  idempotencyKey?: string;                         // defaults to `analytics:<datasetVersionId>:<querySpec>`
};

type SubmitQueryResponse = {
  job: { id: string; jobType: 'analytics_query'; state: JobState; idempotencyKey: string };
  created: boolean;
};
```

The server resolves `querySpec` from a server-side registry (`QUERY_SPECS`), builds the SQL itself, and enqueues the reserved `analytics_query` job through the existing jobs queue (`dbEnqueueJob`), whose unique constraint `(workspace_id, job_type, idempotency_key)` is the only dedupe mechanism. The job payload carries **ids only** — `{ datasetVersionId, querySpec, resultId }` — and no credential. `201` when a job was created, `200` with the existing job when the idempotency key repeats.

**Authority-floor note (owner confirmation required).** This route requires `member` + `read` and enqueues a job, whereas the generic `POST /api/jobs` enqueue path requires `operator` (`src/server/index.ts`). The lower floor is deliberate for the single named read-only spec, but it is a deviation and is listed for owner confirmation.

**Fetch job/result status**

```http
GET /api/workspaces/:id/analytics/queries/:jobId
Authorization: Bearer <octo_live_...>
```

```ts
type QueryStatusResponse = {
  jobId: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  jobType: 'analytics_query';
  errorCode: string | null;      // job-level code, e.g. PARQUET_CORRUPT
  errorSummary: string | null;
  resultId: string | null;       // set when state === 'completed'
  result: AnalyticsResult | null;
};
```

**Fetch the result artifact**

```http
GET /api/workspaces/:id/analytics/results/:resultId
Authorization: Bearer <octo_live_...>
```

```ts
type AnalyticsResult = {
  id: string; datasetVersionId: string; querySpec: string;
  objectKey: string;            // workspaces/<id>/lake/_results/<resultId>.parquet
  rowCount: number;
  contentHash: string;          // sha256 hex of the result Parquet bytes (house convention)
  engineVersion: string;        // resolved pinned DuckDB version recorded with every run
  createdAt: string;
};

type ResultResponse = { result: AnalyticsResult; downloadUrl: string; expiresInSeconds: number };
```

`downloadUrl` is a short-lived presigned R2 URL minted server-side with `r2Provider.generatePresignedDownloadUrl(...)` — the same mechanism the file download route uses. The bytes go client-direct; no master credential is exposed. Result fetch uses **this dedicated route**, not `GET /api/files/download` (which requires a `files` catalog row via `dbGetFile` and the `files` scope).

**Error codes** (stable; `error` is the code, `message` is readable):

| HTTP | `error` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No or invalid credential. |
| 400 | `BAD_REQUEST` | Malformed body, missing field, non-UUID id, or a `partition` that is not `YYYY-MM-DD`. |
| 400 | `UNKNOWN_QUERY_SPEC` | `querySpec` is not in the server-side registry. |
| 400 | `SCHEMA_MISMATCH` | Declared schema does not match the Parquet footer, or is missing the accepted spec's required input columns. |
| 403 | `FORBIDDEN` | Key bound to a different workspace (`keyWorkspaceMatches`), or caller is not a member. |
| 404 | `DATASET_VERSION_NOT_FOUND` | `datasetVersionId` unknown, or not in this workspace. |
| 404 | `JOB_NOT_FOUND` | `jobId` unknown, or not an `analytics_query` job in this workspace. |
| 404 | `RESULT_NOT_FOUND` | `resultId` unknown, or not in this workspace. |
| 409 | `DATASET_VERSION_CONFLICT` | A concurrent registration raced on the same logical dataset/version; retry. |
| 503 | `ANALYTICS_NOT_CONFIGURED` | No object-store backend is configured, or the pinned DuckDB native module failed to load in this process. |

Job-level failures (surfaced through the status route's `errorCode`, not as HTTP statuses): `PARQUET_MISSING`, `PARQUET_CORRUPT`, `SCHEMA_MISMATCH`, `QUERY_TIMEOUT`, `QUERY_CANCELLED`, `RESULT_REGISTRATION_FAILED`.

### Provider/data flow

**PostgreSQL — metadata only.** One migration (`db/migrations/<ts>_slice7_analytics_catalog.sql`, after `20261006150000_workspace_database_credentials.sql`) creates three tables: `octo.datasets` (workspace, slug, name, created_by; unique on workspace+slug), `octo.dataset_versions` (dataset_id, version, format, `schema jsonb`, `provenance jsonb`, watermark, row_count, `object_keys text[]`, created_by; unique on dataset_id+version), and `octo.analytics_results` (workspace, dataset_version_id, job_id, query_spec, object_key, row_count, content_hash, engine_version; unique on job_id). Each carries RLS plus the Slice 14 RESTRICTIVE tenant fence, is idempotent (`IF NOT EXISTS`), has no top-level transaction control, and **grants DML to `octo_service` only** — mirroring `tests/test_slice21_schema.py`, which asserts `TO octo_service` and forbids `TO authenticated`. No analytical rows, no second catalog.

**R2 — Parquet bytes.** Dataset parts and result artifacts live under the workspace prefix. The server writes them through the existing `ObjectStore` (`objectStore.put`) and reads them with DuckDB. The result download URL is presigned.

**DuckDB — ephemeral, in-process, in the existing worker path.** No new service. The engine is a pinned embedded npm dependency (exact version, no caret — the Node client is alpha upstream) loaded by a new handler in `src/jobs/worker.ts`, dispatched by `processJob` for the reserved `analytics_query` job type and reached through the existing `drainQueueOnce` path in `src/server/index.ts`. Per job: a temp directory (`os.tmpdir()/octo-analytics/<jobId>`), the dataset's object keys from the catalog row, one `read_parquet([...])` over **all** parts, the named spec's SQL, a `COPY (...) TO '<tmp>/result.parquet' (FORMAT PARQUET)`, then `objectStore.put` to `workspaces/<id>/lake/_results/<resultId>.parquet`; the temp directory is removed afterward. The handler sets DuckDB's `max_memory` and a temp-directory limit so the in-process engine cannot grow unbounded, and clamps query timeout/`rowLimit` server-side mirroring `src/server/query.ts`. DuckDB's state is disposable; deleting the temp directory is a no-op (TDD MR-B).

**DuckDB reads multiple Parquet objects directly from R2.** The handler configures DuckDB's S3 reader in-process from the same `loadR2ConfigFromEnv()` values the rest of the server uses (`s3_endpoint`, `s3_access_key_id`, `s3_secret_access_key`, `s3_url_style='path'`, `s3_use_ssl=true`) and runs `read_parquet(['s3://<bucket>/<key>', ...])` with the full key list taken from the catalog row. Dataset bytes are fetched over HTTPS, not staged locally or proxied through the API.

**Credential boundary.** The R2 access key and secret exist only in the server process environment, are read by `loadR2ConfigFromEnv()`, and are applied as DuckDB session settings inside the server process. They are never returned by a route, written into a job payload, or sent to a browser. The client sees only: (a) at registration, the bytes it already holds going server-side; (b) at result fetch, a short-lived presigned URL. The job payload contains ids only, so a compromised job row reveals no credential.

**Named query spec.** `job-failures-by-type-month@1` is built server-side, never supplied by the caller:

```sql
SELECT job_type,
       date_trunc('month', created_at AT TIME ZONE 'UTC') AS month,
       count(*)::BIGINT AS failure_count
FROM read_parquet([<server-derived s3 keys from the catalog row>])
WHERE state = 'failed'
GROUP BY 1, 2
ORDER BY 1, 2
```

Input contract: the dataset must carry `job_type TEXT`, `state TEXT`, `created_at TIMESTAMPTZ` (validated at registration). The key list is derived from the catalog row, never from the request body. Result columns are exactly `(job_type, month, failure_count)`; canonical row order is `ORDER BY job_type, month`.

**Production wiring (the anti-dark step, W1).** The wiring is deliberately small, because the engine is embedded: DuckDB is a pinned `package.json` dependency compiled into the existing `octo-api` image (`deploy/gravebuster/Dockerfile.api`, which runs `npm ci`). The wiring acceptance item must verify the DuckDB native module **actually loads** in the built image (`node:22-bookworm-slim`) — a native module that fails to load is the embedded-engine analogue of a missing config. The host `.env` must feed the R2 provider the names `loadR2ConfigFromEnv()` reads (`S3_API_ENDPOINT` / `ACCESS_KEY_ID` / `CLOUDFLARE_SECRET_ACCESS_KEY` / `OCTO_R2_BUCKET`, or the `R2_*` fallbacks); `deploy/gravebuster/.env.example` currently sets `CLOUDFLARE_R2_*` names, so the wiring step must **confirm** the deployed environment feeds the provider and add aliases if it does not — this is **not** assumed to be free. `/health` gains a **new** `analytics: { configured: true, engine: 'duckdb', version }` block (`version` = the pinned DuckDB package version read at startup); note the existing `/health` shape reports only `{ status, version, database, r2: { connected, bucket }, googleAuthEnabled }`, and the graph/embedding dark states are `503` **route** responses, not `/health` fields. **A `503` does not prevent merge-but-dark** — graph (`503 GRAPH_NOT_CONFIGURED`) and retrieval (`503 EMBEDDING_PROVIDER_NOT_CONFIGURED`) shipped dark with exactly that shape. The only real anti-dark mechanism is the named wiring acceptance item plus the deployed production smoke (W1). `503 ANALYTICS_NOT_CONFIGURED` is the ordinary runtime error when the object store is absent or the native module failed to load, not the anti-dark guarantee. The production smoke submits the accepted query against the deployed runtime and asserts the known result, proving the deployed path reads real R2 Parquet and returns the registered artifact, not a local stub.

### Client surfaces

- **HTTP API** — the four routes above. This is the product boundary, and the **first (and only) client surface in this slice**.
- **Frontend** — **no new analytics UI.** The existing operations/jobs surface already lists the `analytics_query` job and its terminal state/result through the existing jobs list. A durable analytics view belongs to slices 4–5.
- **MCP / SDK / CLI** — **not in this slice.** The thin MCP tool (`register_dataset`, `query_dataset`, `get_analytics_query_status`, `get_analytics_result`) is **deferred to Slice 3** (owner decision), consistent with `SLICE_MAP.md` (the MCP adapter is Slice 3) and with issue #13's success condition, which names no MCP tool.

### Existing code reuse/replacement

**Reuse (do not rebuild):**

- `src/storage/r2-client.ts` (`loadR2ConfigFromEnv`, `generatePresignedDownloadUrl`, object read/write) and `src/storage/object-store.ts` (`ObjectStore.put`/`get`) for dataset parts, result artifacts, and the result download URL.
- `src/jobs/job-service.ts` and `src/jobs/worker.ts` for enqueue, idempotency, leases, retries, and ops events; add **one** reserved job type (`analytics_query`) and **one** handler. `processJob` already fails an unregistered type, so no queue change is needed.
- `src/server/db.ts` (`queryService`, `withTransaction`) for the new metadata helpers; the existing `jobs` table and `jobs_idempotency_unique` constraint for dedupe.
- `src/api/capabilities.ts` for the four descriptors and the existing `read`/`write` scopes.
- `src/server/index.ts` route conventions: `authenticateRequest`, `requireScope`, `scopeDenied`, `requireUuid`, `keyWorkspaceMatches`, `dbGetWorkspaceMembership`, `roleAllows`, `sendJson`, `readJsonObject`.
- The migration pattern of `tests/test_slice21_schema.py`: RLS + Slice 14 RESTRICTIVE fence + grant to `octo_service` only.

**Do not build:**

- No new always-on service, query service, or distributed machinery; DuckDB stays embedded and disposable.
- No Iceberg, DuckLake, ClickHouse, Spark, or `pg_duckdb`.
- No BI/chart UI, no Power BI/DAX reimplementation, no user-authored SQL or SQL console over operational Postgres.
- No duplication of analytical rows into Postgres.
- No new scope, role, MFA, policy engine, or isolation layer — the existing binding, RLS fence, and workspace-prefix derivation are reused unchanged.
- No second dedupe mechanism, no manifest table, no compaction/orphan sweep, no result-retention policy.
- No list-versions, delete-dataset, or catalog-browsing endpoints beyond what the accepted job strictly needs.
- No server-side exporter/checkpoint of Octo's own operational tables (deferred; see below).

**Do not claim reuse that does not exist.** The `UNSAFE_OBJECT_KEY` traversal guard lives only in `LocalObjectStore.resolve()` (`src/storage/object-store.ts`); `R2ObjectStore` delegates straight to the provider and has no key guard. On the production R2 path, safety comes from **server-derived keys** (workspace UUID + validated slug + assigned version + validated `YYYY-MM-DD` partition + generated part id) plus an explicit assertion that each derived key starts with `workspaces/<authenticated workspace id>/`. Keys are never accepted from the request.

### Failure boundary

In scope, and only these:

- **Corrupt or truncated Parquet** — the job fails with `PARQUET_CORRUPT` (non-retryable); never a hang or a silent empty result.
- **Missing Parquet object** — `PARQUET_MISSING` (non-retryable).
- **Schema mismatch** — rejected at registration with `400 SCHEMA_MISMATCH` before a catalog row is written; if a footer later disagrees with the recorded schema, the job fails with `SCHEMA_MISMATCH`.
- **Query timeout / cancellation** — bounded by a server-clamped timeout mirroring `src/server/query.ts`; DuckDB is interrupted deterministically and the job fails with `QUERY_TIMEOUT` / `QUERY_CANCELLED`.
- **Cross-workspace denial** — a key bound to a different workspace gets `403`; a `datasetVersionId` / `resultId` not in the caller's workspace resolves to `404` with no existence leak. The fence is checked before the engine probe.
- **Duplicate result registration** — the result row is keyed by `job_id`, and enqueue dedupe is the existing `jobs_idempotency_unique` constraint `(workspace_id, job_type, idempotency_key)`; a retry under the same key resolves to the same job and cannot register a second artifact.
- **Engine/object store unavailable** — `503 ANALYTICS_NOT_CONFIGURED`.

Not in scope: an exhaustive hypothetical failure matrix. No retry/backoff tuning, no concurrency handling beyond the existing single-job lease, no multi-version engine matrix (deferred to a deliberate, recorded engine bump).

## Packet resolutions recorded by this appendix

The packet was synthesized from the four companion drafts after independent critique and resolved every blocking defect. This appendix is subordinate to it. Recorded here so a reader of the draft-era text is not misled; the normative rule in each case lives in the topical section above (or in the packet), not in this list:

1. **First client surface.** The draft proposed an MCP tool (`register_dataset` / `query_dataset` / `get_analytics_query_status` / `get_analytics_result`) backed by `OctoApi` methods in this slice. The packet defers MCP to Slice 3 (owner decision); Client surfaces now states HTTP-only.
2. **Engine placement.** The draft TDD's W1 proposed a separate `octo-analytics` compose service with its own memory cap. The packet keeps DuckDB **embedded, in-process, in the existing `octo-api` worker drain path** — no separate service, no persistent DuckDB file. That default is reflected throughout this appendix.
3. **Production wiring / anti-dark.** The draft claimed the wiring was free ("no new env var") and that a `503` route response meant the engine "cannot be merged-but-dark". The packet rejects both: the host `.env` must be **confirmed** to feed `loadR2ConfigFromEnv()` (aliases added if the current `CLOUDFLARE_R2_*` names do not reach the provider), and graph + retrieval shipped dark *with* `503`s. The only real anti-dark mechanism is the named wiring acceptance item plus the deployed production smoke.
4. **Migration grant target.** The draft granted DML `TO authenticated`. The packet grants to `octo_service` only, mirroring `tests/test_slice21_schema.py` (which forbids `TO authenticated`).
5. **Version assignment / conflict code.** The draft had the caller pin a version number and returned `409 DATASET_VERSION_EXISTS`. The packet assigns version numbers server-side and returns `409 DATASET_VERSION_CONFLICT` on a concurrent registration race.
6. **Job-level failure codes.** The draft listed an extra `ANALYTICS_UNAVAILABLE` job-level code. The packet's set is `PARQUET_MISSING`, `PARQUET_CORRUPT`, `SCHEMA_MISMATCH`, `QUERY_TIMEOUT`, `QUERY_CANCELLED`, `RESULT_REGISTRATION_FAILED`.
7. **Operations UI.** The draft allowed "at most a one-field submit control". The packet adds **no new analytics UI**; the existing jobs surface is the observable.
8. **Octo's own history.** The draft said producing the accepted dataset from Octo's history was "achievable today with the Slice 21 SQL surface plus client-side Parquet conversion". That is false: the Slice 21 route runs as the workspace's own `NOSUPERUSER` role against the workspace's own provisioned database, which holds no `octo` schema (`src/server/provisioning.ts`, `src/server/query.ts`). No existing product surface reads Octo's control-plane history.
9. **`UNSAFE_OBJECT_KEY` reuse.** The draft claimed the traversal guard covers the analytics key derivation. It is `LocalObjectStore`-only; the R2 path relies on server-derived keys plus the workspace-prefix assertion.

## Deferred / not in this slice

- **No server-side exporter/checkpoint** that materializes Octo's own operational tables (`octo.jobs`, `octo.activity`, `octo.ops_events`) into Parquet as a product job. This slice answers the accepted question over a **caller-registered** dataset. Octo's control-plane history is **not reachable by any existing product surface**: the Slice 21 SQL route runs as the workspace's own `NOSUPERUSER` role against the workspace's own provisioned database, which holds no `octo` schema and no control-plane grants (`src/server/provisioning.ts`, `src/server/query.ts`). A caller's own data in its provisioned database is exportable with existing surfaces; Octo's own operational history is not. An automated exporter is a later, separately accepted slice.
- **Partial roadmap delivery, stated plainly:** `PROJECT.md`'s Parquet/DuckDB promise is only **partially** delivered here. This slice delivers a working DuckDB-over-Parquet engine and a caller-registered dataset path. It does **not** deliver the "exported history" pipeline that would make Octo's own operational history queryable, nor any BI surface. Roadmap prose must not be read as shipped capability beyond this.
- **Streaming/multipart dataset-part upload** — registration parts arrive as base64 in one JSON body, which is not size-limited in this slice; a large dataset registration is a known limitation. Large-object streaming / presigned direct upload is a later concern.
- **No partition-pruning or performance guarantee.** Multi-file correctness is the claim; layout is a convention.
- **No list-versions, delete-dataset, or catalog-browsing endpoints** beyond what the accepted job strictly needs.
- **No BI/analytics connector** — issue #13's "optional BI connection later" is not taken up here.
- **No SDK/CLI or MCP analytics client** — Slice 3.
- **Iceberg, DuckLake, ClickHouse, Spark, `pg_duckdb`, an always-on query service.**
- **Concurrent query workers** — one query at a time, serialized by the existing job lease.
- **Manifest table, compaction job, orphan sweep, Hive-partition discipline beyond the path convention** — deferred until a named trigger fires.
- **Result-artifact retention/lifecycle policy** — not promised here.
- **A durable analytics frontend view** — slices 4–5.

## Lock

- Owner accepted/corrected: **pending**
- Locked at: **not locked**

## Decisions for owner review

The packet owns the authoritative decisions list (nine items, including engine placement, first client surface, the hidden holdout, and the enqueue authority floor). This appendix adds no decisions of its own; it records the SDD-scoped owner confirmations already stated above:

1. **Enqueue authority floor.** `analytics.query` lets a `member` with `read` enqueue an `analytics_query` job, whereas the generic `POST /api/jobs` enqueue requires `operator`. Confirm this deliberate lower floor for the single named spec.
2. **Migration grant target.** The analytics catalog tables grant DML to `octo_service` only, not `authenticated`. Confirm.
3. **Registration ingestion.** Dataset parts are supplied as base64 bytes in the JSON body (the caller never holds R2 credentials and never supplies keys); large-object streaming / presigned direct upload is deferred. Confirm, or direct a streaming/presigned path.
