# Slice 7 — Historical Analytics (DuckDB and Parquet over R2 datasets)

**Status: DRAFT — pending independent critique and owner acceptance. Not locked. Do not implement until the owner locks this packet on issue #13.** This is the merged, locked-format PDD/SDD/EVAL packet for the Slice 7 draft documents under `docs/productization/slices/07-historical-analytics/` (`PDD.md`, `SDD.md`, `TDD.md`, `DIFFERENTIAL.md`). The owning issue #13 is titled **"Slice 11 — DuckDB and Parquet analytical workspace over R2 datasets"** (OCTO-1100); `SLICE_MAP.md` orders the same work as **Slice 7**, and this packet uses "Slice 7" throughout. Robustness target: **Level 2**.

## PDD

**User / actor:** An authenticated agent or human working in a workspace that holds a large/tabular dataset it has already materialized as Parquet objects, and that needs to answer a long-range aggregate question over it. The canonical example is **job failures by type and month**, answered over a dataset **the caller registers** — not over Octo's own control-plane history.

**Job:** Register a multi-file Parquet dataset (with its schema and provenance) into a workspace, run one named analytical query over it with DuckDB through an Octo-controlled job, and fetch the result artifact — without loading bulk analytical rows into operational Postgres and without the caller ever holding R2 master credentials.

**Why now:** `PROJECT.md` promises Parquet for long-term operational, observational, and analytical history and DuckDB for analytical queries over it, but the repository contains no DuckDB/Parquet code and issue #13 is open. Adopters have been told analytics runs on "Octo's DuckDB and Parquet" and found neither existed (#149); another agent bypassed Octo's managed layer entirely (#162). The recurring failure is reading merged roadmap prose as shipped capability. This slice makes the analytical path real, and states plainly what it does not deliver.

**In scope:**

- **Dataset/version catalog** in control-plane Postgres: workspace, logical dataset, immutable version, `format`, schema, R2 object-key list, and provenance. A re-export is a new version, never a mutation.
- **Parquet object conventions in R2:** a workspace-scoped key prefix and a dataset/version path layout. Partition/path layout is an optimization, never the authorization mechanism.
- **A DuckDB query job:** DuckDB reads the dataset's Parquet objects directly from R2, runs one **named** query spec, and writes a result Parquet artifact back to R2. DuckDB is ephemeral, in-process compute in the existing `octo-api` worker drain path — no separate service and no persistent DuckDB file.
- **Result artifact registration and fetch:** the result Parquet's key and metadata are recorded against the workspace and fetched through a dedicated analytics result route (see SDD).
- **Workspace authorization:** the existing scoped-key binding and membership checks apply. A caller in another workspace cannot register, query, or read a dataset/result. The server holds the R2 credentials; the caller never receives them.
- **The client-facing submit path:** an authenticated HTTP surface that enqueues one reserved analytics job type through the existing jobs queue (the same enqueue/idempotency/lease contract) and returns the job id.

**Out of scope:**

- Iceberg, ClickHouse, Spark, `pg_duckdb`, or any analytical engine beyond DuckDB.
- An always-on distributed query service; DuckDB stays in-process and disposable.
- A BI/DAX product or Power BI platform reimplementation.
- Duplicating bulk analytical rows into operational Postgres.
- A general SQL console. A raw-SQL surface over a workspace's **own provisioned database** already exists as Slice 21 (`POST /api/workspaces/:id/query`); this slice does not rebuild, wrap, or duplicate it.
- A new analytics UI. The existing operations/jobs surface already shows the query job and its terminal state; the workspace shell is slices 4–5.
- User-authored SQL. The caller submits a named spec id; the server builds the SQL.

**Deferred / not in this slice:**

- **No server-side exporter/checkpoint** that materializes Octo's own operational tables (`octo.jobs`, `octo.activity`, `octo.ops_events`) into Parquet as a product job. This slice answers the accepted question over a **caller-registered** dataset. Octo's control-plane history is **not reachable by any existing product surface**: the Slice 21 SQL route runs as the workspace's own `NOSUPERUSER` role against the workspace's own provisioned database, which holds no `octo` schema and no control-plane grants (`src/server/provisioning.ts`, `src/server/query.ts`). A caller's own data in its provisioned database is exportable with existing surfaces; Octo's own operational history is not. An automated exporter is a later, separately accepted slice.
- **Partial roadmap delivery, stated plainly:** `PROJECT.md`'s Parquet/DuckDB promise is only **partially** delivered here. This slice delivers a working DuckDB-over-Parquet engine and a caller-registered dataset path. It does **not** deliver the "exported history" pipeline that would make Octo's own operational history queryable, nor any BI surface. Roadmap prose must not be read as shipped capability beyond this.
- **No BI/analytics connector** (issue #13's "optional BI connection later" is not taken up here).
- **No partition-pruning or performance guarantee.** Multi-file correctness is the claim; layout is a convention.
- **No list-versions, delete-dataset, or catalog-browsing endpoints** beyond what the accepted job strictly needs.
- **No SDK/CLI or MCP analytics client** — Slice 3.
- **No large-object streaming or presigned direct upload.** Registration parts arrive as base64 in one JSON body, which is not size-limited in this slice; a large dataset registration is a known limitation. Streaming/multipart upload is a later concern.

**Reuse:**

- Existing R2 client (`src/storage/r2-client.ts`) for reading dataset objects and writing/presigning result artifacts.
- Existing jobs queue: enqueue/run, leases, idempotency, retries, ops events (`src/jobs/job-service.ts`, `src/jobs/worker.ts`, `src/server/index.ts`). The analytics job is one more reserved job type dispatched by the existing worker, which already fails an unregistered type.
- Existing scoped-key authorization and workspace binding (`requireScope`, `keyWorkspaceMatches`, membership checks) and control-plane metadata helpers (`src/server/db.ts`).
- Existing capabilities catalog (`src/api/capabilities.ts`) for the four analytics descriptors, and the existing migration/RLS pattern (Slice 14 fence; `tests/test_slice21_schema.py`).

**Observable success:**

- A caller-registered multi-file Parquet dataset with input columns `(job_type TEXT, state TEXT, created_at TIMESTAMPTZ)` answers `job-failures-by-type-month@1` through the HTTP job API. The result Parquet has exactly the columns `(job_type, month, failure_count)` and rows equal to the aggregate computed **independently** in the test from the same registered rows, with `month = date_trunc('month', created_at AT TIME ZONE 'UTC')` and canonical order `ORDER BY job_type, month`.
- The result artifact is registered and re-fetchable through `GET /api/workspaces/<id>/analytics/results/<resultId>`; re-submitting under the same idempotency key returns the same job and does not create a duplicate result.
- A key bound to another workspace is refused (`403`); a `datasetVersionId`/`resultId` not in the caller's workspace resolves to `404` with no existence leak.
- Operational Postgres row counts and schema show only dataset/version/job/result metadata — bulk analytical rows never entered it.
- On the deployed runtime, the analytics job actually executes against R2 and returns the known result (production smoke; W1).

## SDD

### Authority / canonical state

- **PostgreSQL (control plane, `octo` schema) owns dataset, version, job, and result METADATA.** It stores the catalog rows, the ordered object-key list, the schema declaration, provenance, the declared export window (watermark), row counts, content hashes, and the job/result references. It never stores analytical rows.
- **R2 owns the Parquet BYTES** — dataset parts and result artifacts. The bytes are canonical; the catalog row indexes them.
- **DuckDB is disposable compute with no durable state.** It reads Parquet objects, answers the query, writes a result artifact, and is torn down. There is no persistent DuckDB file and nothing durable depends on it.

Load-bearing consequences:

- A dataset version is **immutable**. A re-export is a new version row.
- The result artifact is **derivable** from `(immutable dataset version, named query spec, pinned engine version)`. It is a derived artifact, not a second authority.
- Bulk analytical rows never enter operational Postgres (issue #13's row-count/design evidence).
- The workspace id in every object key is the authenticated workspace id, never a request value. Layout (`lake/`, `dt=`) is a convention, not the authorization mechanism.

### Capabilities

Add four descriptors to `OCTO_CAPABILITIES` in `src/api/capabilities.ts` in the existing `CapabilityDescriptor` shape. **No new scope is introduced** — the existing `read`/`write` scopes are reused, and `minimumRoleForCapability` is unchanged (all four are `member`).

| action | method | path | requiredScope | min role |
|---|---|---|---|---|
| `datasets.register` | POST | `/api/workspaces/<id>/datasets` | `write` | member |
| `analytics.query` | POST | `/api/workspaces/<id>/analytics/queries` | `read` | member |
| `analytics.query_status` | GET | `/api/workspaces/<id>/analytics/queries/<jobId>` | `read` | member |
| `analytics.result` | GET | `/api/workspaces/<id>/analytics/results/<resultId>` | `read` | member |

Rationale: registering a dataset version is a durable mutating catalog write and requires `write`; submitting a query only enqueues a read-only job over an immutable version and requires `read`. **The existing `analytics` key class is read-only (`scopes: ['read']`, "No ... mutations." in `src/api/capabilities.ts`) and therefore cannot register a dataset.** A caller that must both register and query needs a `write`-scoped key (for example the `program-write` class or an explicit scope list); the read-only analytics class covers query/status/result only. The PDD's single actor performing register + query + fetch must be provisioned accordingly. Discovery grants no authority beyond route enforcement: each route re-checks `authenticateRequest`, `requireScope`, `keyWorkspaceMatches`, and `dbGetWorkspaceMembership` before any engine work.

### API contract

Routes follow the house pattern in `src/server/index.ts`: `authenticateRequest` → `requireScope` → `requireUuid` → `keyWorkspaceMatches` → `dbGetWorkspaceMembership` → resource lookup → engine probe. The workspace fence is checked **before** the engine is probed, so an unauthorized caller never learns whether analytics is configured (the `tests/e2e/graph-read.spec.ts` shape). Errors carry the existing top-level `error` string; an engine code is reported in `code`.

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
  watermark?: string;                              // minor addition (declared export window); owner confirm
  idempotencyKey?: string;                         // minor addition; repeat returns the original version
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

It writes each part through the existing `ObjectStore.put`, reads each Parquet footer back to validate `format` and that the declared `schema` matches (rejecting a mismatch with `SCHEMA_MISMATCH` before any catalog row is written), requires the declared schema to include the accepted spec's input columns (`job_type`, `state`, `created_at` with compatible types), sets `rowCount` to the sum of the parts' footer row counts, and inserts the version row in one transaction. The schema representation is an explicit ordered array of `{ name, type }` (Parquet type names) stored as `jsonb`; it is the declared contract, validated against the footer, not inferred. Version numbers are **server-assigned** (`max(version)+1` for the logical dataset, computed inside the insert transaction); `(dataset_id, version)` is unique, so a concurrent registration of the same slug fails closed with `409`. `201` on a new version; `200` with the original row when `idempotencyKey` repeats.

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

**Authority-floor note (owner confirmation required):** this route requires `member` + `read` and enqueues a job, whereas the generic `POST /api/jobs` enqueue path requires `operator` (`src/server/index.ts`). That lower floor is deliberate for the single named read-only spec, but it is a deviation and is listed for owner confirmation.

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

`downloadUrl` is a short-lived presigned R2 URL minted server-side with `r2Provider.generatePresignedDownloadUrl(...)` — the same mechanism the file download route uses. Bytes go client-direct; no master credential is exposed. Result fetch uses **this dedicated route** (not `GET /api/files/download`, which requires a `files` catalog row via `dbGetFile` and the `files` scope).

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

### Provider / data flow

**PostgreSQL — metadata only.** One migration (`db/migrations/<ts>_slice7_analytics_catalog.sql`, after `20261006150000_workspace_database_credentials.sql`) creates three tables: `octo.datasets` (workspace, slug, name, created_by; unique on workspace+slug), `octo.dataset_versions` (dataset_id, version, format, `schema jsonb`, `provenance jsonb`, watermark, row_count, `object_keys text[]`, created_by; unique on dataset_id+version), and `octo.analytics_results` (workspace, dataset_version_id, job_id, query_spec, object_key, row_count, content_hash, engine_version; unique on job_id). Each carries RLS plus the Slice 14 RESTRICTIVE tenant fence, is idempotent (`IF NOT EXISTS`), has no top-level transaction control, and **grants DML to `octo_service` only** — mirroring `tests/test_slice21_schema.py`, which asserts `TO octo_service` and forbids `TO authenticated`. No analytical rows, no second catalog.

**R2 — Parquet bytes.** Dataset parts and result artifacts live under the workspace prefix. The server writes them through the existing `ObjectStore` (`objectStore.put`) and reads them with DuckDB. The result download URL is presigned.

**DuckDB — ephemeral, in-process, in the existing worker path.** No new service. The engine is a pinned embedded npm dependency (exact version, no caret) loaded by a new handler in `src/jobs/worker.ts`, dispatched by `processJob` for the reserved `analytics_query` job type and reached through the existing `drainQueueOnce` path in `src/server/index.ts`. Per job: a temp directory (`os.tmpdir()/octo-analytics/<jobId>`), the dataset's object keys from the catalog row, one `read_parquet([...])` over **all** parts, the named spec's SQL, a `COPY (...) TO '<tmp>/result.parquet' (FORMAT PARQUET)`, then `objectStore.put` to `workspaces/<id>/lake/_results/<resultId>.parquet`; the temp directory is removed afterward. The handler sets DuckDB's `max_memory` and a temp-directory limit so the in-process engine cannot grow unbounded, and clamps query timeout/`rowLimit` server-side mirroring `src/server/query.ts`.

**DuckDB reads multiple Parquet objects directly from R2.** The handler configures DuckDB's S3 reader in-process from the same `loadR2ConfigFromEnv()` values the rest of the server uses (`s3_endpoint`, `s3_access_key_id`, `s3_secret_access_key`, `s3_url_style='path'`, `s3_use_ssl=true`) and runs `read_parquet(['s3://<bucket>/<key>', ...])` with the full key list taken from the catalog row. Dataset bytes are fetched over HTTPS, not staged locally or proxied through the API.

**Credential boundary.** The R2 access key and secret exist only in the server process environment, are read by `loadR2ConfigFromEnv()`, and are applied as DuckDB session settings inside the server process. They are never returned by a route, written into a job payload, or sent to a browser. The client sees only: (a) at registration, the bytes it already holds going server-side; (b) at result fetch, a short-lived presigned URL. The job payload contains ids only.

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

Input contract: the dataset must carry `job_type TEXT`, `state TEXT`, `created_at TIMESTAMPTZ` (validated at registration). Result columns are exactly `(job_type, month, failure_count)`; canonical row order is `ORDER BY job_type, month`.

**Production wiring (the anti-dark step).** The wiring is deliberately small, because the engine is embedded: DuckDB is a pinned `package.json` dependency compiled into the existing `octo-api` image (`deploy/gravebuster/Dockerfile.api`). The wiring acceptance item must verify the DuckDB native module **actually loads** in the built image (`node:22-bookworm-slim`) — a native module that fails to load is the embedded-engine analogue of a missing config. The host `.env` must feed the R2 provider the names `loadR2ConfigFromEnv()` reads (`S3_API_ENDPOINT` / `ACCESS_KEY_ID` / `CLOUDFLARE_SECRET_ACCESS_KEY` / `OCTO_R2_BUCKET`, or the `R2_*` fallbacks); `deploy/gravebuster/.env.example` currently sets `CLOUDFLARE_R2_*` names, so the wiring step must confirm the deployed environment feeds the provider and add aliases if it does not — this is **not** assumed to be free. `/health` gains a **new** `analytics: { configured: true, engine: 'duckdb', version }` block (`version` = the pinned DuckDB package version read at startup); note the existing `/health` shape reports only `{ status, version, database, r2: { connected, bucket }, googleAuthEnabled }`, and the graph/embedding dark states are `503` **route** responses, not `/health` fields. **A `503` does not prevent merge-but-dark** — graph (`503 GRAPH_NOT_CONFIGURED`) and retrieval (`503 EMBEDDING_PROVIDER_NOT_CONFIGURED`) shipped dark with exactly that shape. The only real anti-dark mechanism is the named wiring acceptance item plus the deployed production smoke (W1, below). `503 ANALYTICS_NOT_CONFIGURED` is the ordinary runtime error when the object store is absent or the native module failed to load, not the anti-dark guarantee.

### Client surfaces

- **HTTP API** — the four routes above. This is the product boundary.
- **Frontend** — **no new analytics UI.** The existing operations/jobs surface already lists the `analytics_query` job and its terminal state/result through the existing jobs list. A durable analytics view belongs to slices 4–5.
- **MCP / SDK / CLI** — **not in this slice.** The thin MCP tool (`register_dataset`, `query_dataset`, `get_analytics_query_status`, `get_analytics_result`) is deferred to Slice 3, consistent with `SLICE_MAP.md` (the MCP adapter is Slice 3) and with issue #13's success condition, which names no MCP tool. This deferral is an owner decision (below).

### Existing code reuse / replacement

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
- No server-side exporter/checkpoint of Octo's own operational tables (deferred).

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

## EVAL / TDD

Tests exist to prove the accepted claim, not to maximize test count. Add no failure matrix beyond the boundaries named here.

### Public deterministic evals

**Catalog — `tests/unit/analytics-catalog.test.ts`**

- Registering a dataset version writes one catalog row carrying: workspace id, logical dataset id, version number, `format='parquet'`, schema (column names + types), provenance, watermark, row count, and the ordered list of object keys. The row is immutable once written.
- Registering the same logical dataset again produces version 2 with its own object list; version 1's row and object keys are unchanged. Version numbers are server-assigned; a concurrent registration of the same slug fails closed (`409`).
- A request body cannot supply an object key outside the version's own derived prefix; every key is derived from the catalog row's identifiers, never accepted from the caller.
- A dataset version whose recorded schema does not match the Parquet footer, or is missing the spec's required input columns, is rejected at registration with `SCHEMA_MISMATCH`, not accepted and failed later.

**Parquet path conventions — `tests/unit/analytics-paths.test.ts`**

- A dataset version's keys are exactly
  `workspaces/<workspaceId>/lake/<datasetSlug>/v<versionNumber>/dt=<YYYY-MM-DD>/part-<uuid>.parquet`.
  The `<workspaceId>` segment is the authenticated workspace id; it is never taken from a request value.
- Result artifacts are `workspaces/<workspaceId>/lake/_results/<resultId>.parquet`.
- Every derived key is asserted to start with `workspaces/<authenticated workspace id>/`. (The `UNSAFE_OBJECT_KEY` guard is `LocalObjectStore`-only; the R2 path relies on derivation plus this prefix assertion.)
- The path layout is an optimization, not the authorization mechanism: authorization is enforced on the catalog row, independent of the path.

**Query submission — `tests/unit/analytics-query.test.ts`**

- The accepted query spec `job-failures-by-type-month@1` compiles server-side to a deterministic SQL string over `read_parquet([...])`. The caller cannot supply SQL; an unrecognized spec id is `400`.
- An unknown `datasetVersionId` is `404`. A `datasetVersionId` owned by another workspace resolves to `404` (no existence leak) before any engine work.
- The enqueued job payload carries only ids (workspace, dataset version, query spec, result id). It contains no R2 credential.
- `rowLimit`/timeout defaults mirror the SQL surface (`src/server/query.ts`) and are clamped server-side.

**Result registration — `tests/unit/analytics-result.test.ts`**

- A completed job registers exactly one result row: object key, row count, `contentHash` (sha256 hex of the result bytes), query spec, dataset version, job id, and `engineVersion`.
- A retry under the same idempotency key resolves to the same job and creates no second result row. (Dedupe is anchored on `job_id` via the existing jobs constraint; a *new* idempotency key is a new job and legitimately a new result.)

**Authorization — `tests/e2e/analytics.spec.ts`**

- Unauthenticated request is `401`.
- Submitting the accepted query requires `read`; registering a dataset requires `write`. A read-only key is refused at registration.
- The same principal owns workspaces A and B; an A-bound key is refused (`403`) for a B workspace on both the register and query paths, and a B-owned `datasetVersionId` resolves to `404`. Membership alone is insufficient for a workspace-bound key.
- No new scope is introduced; the analytics descriptors reuse the existing `read`/`write` scopes, and the workspace fence is checked **before** the engine is probed.
- The capabilities surface advertises the four analytics descriptors with their real required scopes, and discovery grants no authority beyond route enforcement.

**Migration schema — `tests/test_analytics_catalog_schema.py`**

- The migration creates the dataset/version/result tables, enables RLS, adds the Slice 14 RESTRICTIVE tenant fence, grants DML to `octo_service` only, is idempotent (`IF NOT EXISTS`), and has no top-level transaction control. Same checks as `tests/test_slice21_schema.py`.

**Live engine — `scripts/verify-analytics.ts`** (wired into the `gates` job beside `scripts/verify-workspace-query.ts`)

- DuckDB reads **multiple** Parquet files in one query and returns the known aggregate.
- The same logical rows written as one file, as day partitions, or as month partitions (all keys under `dt=YYYY-MM-DD`) return identical logical results.
- A corrupt/truncated Parquet object yields a deterministic job failure with a stable error code, never a hang or a silent empty result.
- A schema-mismatched file yields a stable failure code.
- A runaway query is bounded by a clamped timeout; cancellation is deterministic.
- The result Parquet is written to the object store and registered; a retry does not duplicate catalog output.
- The DuckDB dependency is added to `package.json` and pinned to an explicit version (the Node client is alpha upstream, so an unpinned range is not acceptable), and the script's `gates` step installs it so the check actually runs.
- CI has no R2, so this eval uses the explicit local object-store backend (`OCTO_STORAGE_BACKEND=local`) plus the Postgres service, matching the existing Playwright/e2e gates step; the production smoke exercises real R2.

### End-to-end user eval

The real job: **an agent registers a multi-file Parquet dataset and gets a correct answer to the agreed historical question — job failures by type and month — through the HTTP product surface.**

1. The agent registers the multi-file dataset version: `POST /api/workspaces/:id/datasets` with the logical slug, `format`, the declared schema, provenance, and `parts` (base64 bytes + `YYYY-MM-DD` partition). The agent supplies no path or object key.
2. The agent submits the agreed query: `POST /api/workspaces/:id/analytics/queries` with `datasetVersionId` and `querySpec: 'job-failures-by-type-month@1'` → job id.
3. The job is drained (`POST /api/jobs/run?workspaceId=` or the worker tick) and polled to a terminal state.
4. The agent fetches the result: `GET /api/workspaces/:id/analytics/results/:resultId` → row count plus a short-lived download URL; the result Parquet bytes are retrieved.

**Observable output.** A result Parquet artifact in R2 with columns `(job_type, month, failure_count)` whose rows equal the expected aggregate computed independently from the same registered source rows. A result row is registered in the catalog. Operational Postgres holds metadata only — the eval asserts the analytical rows were not duplicated into `octo.*` (issue #13's row-count/design evidence).

**Fixtures (deterministic).**

- **Fixture A — synthetic multi-file Parquet.** A known row set written as several Parquet files (one file; N day-partitioned files; month-partitioned files, normalized to `dt=YYYY-MM-DD` keys). The expected answer is computed by plain aggregation in the test, never by re-running DuckDB, so the oracle is not circular.
- **Fixture B — seeded source history.** `octo.jobs` seeded with a known distribution of `state='failed'` rows across several job types and months (including two job types failing in the same month and a month with zero failures for one type). A **fixture producer** (`scripts/analytics-fixture.ts`, test scaffolding only — not a product exporter) materializes those seeded rows into Parquet. The oracle is a Postgres `GROUP BY` over `octo.jobs WHERE state='failed'`, aggregated to month. The oracle source is pinned to `octo.jobs.state='failed'` (one row per failed job); `octo.ops_events` is **not** used as the oracle because it is per-event and error-code keyed.

### Metamorphic / property evals

Targeted only. File: `tests/unit/analytics-metamorphic.test.ts`.

- **MR-A Repartition invariance.** The same logical rows written as one file, as N day-partitioned files, or as month-partitioned files produce identical logical results (same columns, same ordered rows).
- **MR-B Regenerability / determinism.** Deleting DuckDB's local compute state (temp directory) changes nothing: the result artifact is derivable from the immutable dataset version + named spec + pinned engine. A re-submit under the **same** idempotency key resolves to the existing job (no re-run); a re-run under a **new** key reproduces the same logical rows as a new result row. This asserts determinism of the derivation, not cross-job artifact reuse.
- **MR-C Workspace binding.** A workspace-bound key for A never reaches B's dataset, across both the register and query paths. The R2 prefix is derived from the authenticated workspace, never from a request value.

Do not generalize these into a broad failure matrix.

### Differential evals

The full differential plan is the standalone companion `docs/productization/slices/07-historical-analytics/DIFFERENTIAL.md`; this packet owns the completion oracle and summarizes it. **Where the companion and this packet differ, this packet governs.** One fixture module (`scripts/analytics-fixture.ts`) and one gates script (`scripts/verify-analytics.ts`) serve both; the companion's separate `scripts/verify-analytics-differential.ts` is folded in and not added.

| # | Axis | Two paths | In this slice? |
|---|---|---|---|
| 1 | Parquet vs operational Postgres | DuckDB over fixture-materialized Parquet vs a **test-only** direct Postgres query over `octo.jobs WHERE state='failed'`, filtered to the declared window | In scope (gates, `scripts/verify-analytics.ts`) |
| 2 | Repartition invariance | Partitioning A vs B of the same logical rows | In scope (unit) |
| 3 | Engine-version stability | **Determinism/pin check**, not two independent paths: the pinned DuckDB build re-run on a frozen fixture; the resolved version is recorded in result metadata | In scope (unit) |
| 4 | Client-path equivalence | HTTP vs MCP | **Deferred** — MCP tool is Slice 3; no operations-UI proxy (this slice adds no new UI) |
| 5 | Incremental vs full materialization | Full vs checkpointed fixture producer | In scope as **test-harness only**; no product exporter |

Shared invariants: logical result equality (same columns and ordered rows), not byte equality; canonical order `ORDER BY job_type, month`; UTC month truncation on both sides; every dataset version declares a source window (watermark) and the Postgres oracle compares only rows inside it; the pinned engine version is recorded with every run. **Clamp exemption:** a run truncated by the server-side `rowLimit`/timeout clamp is intended behavior, exempt from the identical-row-sets assertion.

Axis 5's "accumulated dataset" is a **fixture-producer** concern only. The product query contract reads exactly one `datasetVersionId`; no multi-version accumulated read is designed, and no product late-arriving-row policy is declared. The fixture exercises incremental materialization to prove the invariant; the product surface does not expose it.

This is a **scope choice, not a contract prohibition**: a product SQL console over operational Postgres is out of scope here because the accepted job does not need one. Neither issue #13 nor `SLICE_CONTRACT.md` forbids it, and this packet does not claim they do.

### Hidden holdout

**One holdout — subject to explicit owner authorization (AGENTS.md rule 9).** Issue #13 does not name a holdout; the owner is asked below to authorize it. Analytics is where an implementation could hardcode the public fixture's answer or read a stale/partial file set and still return plausible numbers.

`tests/e2e/analytics-holdout.spec.ts` preserves the success claim while changing meaningful scenario details, submitted over **HTTP** (no MCP):

- an **unseen dataset** with different job-type labels and a different number of types;
- a **different partition layout** (a single file plus month partitions, where the public fixture used day partitions);
- a **different date range** crossing a year boundary.

The holdout asserts the result equals the independently computed aggregate and additionally asserts the public fixture's expected numbers do not appear. It hides scenario details, not implementation trivia.

### Production smoke

**Named production wiring acceptance item — W1: wire the analytics engine on gravebuster.** This slice's whole problem is that engines get merged to `main`+`production` and left dark (graph returns `503 GRAPH_NOT_CONFIGURED`; retrieval returns `503 EMBEDDING_PROVIDER_NOT_CONFIGURED`). A green merge with the analytics engine unreachable is **not** acceptance. W1 acceptance (exact artifacts):

- the pinned DuckDB dependency is present in `package.json` and **verified to load** inside the built `octo-api` image (`deploy/gravebuster/Dockerfile.api`, which runs `npm ci`); a native-module load failure fails the item;
- the `analytics_query` job type is **claimable and dispatchable by the deployed worker** — a submitted job reaches `completed` on the host, not `UNKNOWN_JOB_TYPE`;
- the deployed host environment feeds `loadR2ConfigFromEnv()` the R2 variables it reads (add the expected aliases to `deploy/gravebuster/.env.example` and the host `.env` if the current `CLOUDFLARE_R2_*` names do not reach the provider);
- `/health` reports `analytics: { configured: true, engine: 'duckdb', version }` after a restart;
- a designated smoke workspace is provisioned **by the smoke script itself** through the registration route (no manual pre-seeding).

**Smoke script — `scripts/analytics-smoke.ts`** (invoked by the existing `npm run production-smoke` path alongside `src/qa/production-smoke.ts`). Against `OCTO_SMOKE_BASE_URL`:

1. `/health` reports the analytics engine configured;
2. with an env-provided smoke key, register a small known dataset version via `POST /api/workspaces/:id/datasets`, submit `job-failures-by-type-month@1`, poll the job to completion, fetch the result, and assert the known row count/sum.

That is the smallest post-deploy check proving the deployed runtime supports the accepted job.

**Evidence-to-close mapping (issue #13):** catalog/version record → `analytics-catalog.test.ts`; multi-file query output → the end-to-end eval; result artifact record → `analytics-result.test.ts`; cross-workspace denial → `analytics.spec.ts`; bulk rows remain out of operational Postgres → the end-to-end eval's row-count assertion; green `gates` → `scripts/verify-analytics.ts` plus the rest of the `gates` job. **W1 (production wiring) is additional evidence this slice adds, because the engine must not ship dark.**

### Done criteria

A slice is done only when: the accepted user job works end to end; the public deterministic evals pass; the metamorphic evals pass; the holdout passes (if authorized); required repository CI (`gates`) is green on the exact candidate; **the production smoke passes and W1 is satisfied — the deployed analytics job actually executes against R2 and returns the known result**; and no out-of-scope machinery was added.

## Lock

- Owner accepted/corrected: **pending**
- Locked at: **not locked**
- **Wiring/provisioning acceptance (W1): required in the Lock/Done criteria.** The packet is not done while the analytics engine is merged but dark: the DuckDB dependency must be present and loading in the deployed `octo-api` image, the host environment must feed the R2 provider, `/health` must report the analytics block, and the production smoke must execute the accepted query against R2 and return the known result.

## Decisions for owner review

1. **Analytics-enabled workspaces opt-in?** Issue #13 says "optional capability: analytics-enabled workspaces only." Confirm whether the analytics capability is gated by an explicit workspace flag (and, if so, how it is set) or is available to any workspace holding the required scopes. The packet currently assumes availability is governed only by scopes/membership and adds no workspace flag.
2. **Engine placement.** The packet's default is **embedded DuckDB in the existing `octo-api` worker drain path** (minimum change, no new service; memory bounded by DuckDB `max_memory` + temp-dir limit + server clamps). The rejected alternative is a separate `octo-analytics` compose service with its own memory cap (the draft TDD's W1). Confirm the embedded default or direct the separate service.
3. **First accepted question and dataset.** Confirm the first accepted question is **job failures by type and month**, answered over a **caller-registered** dataset with required input columns `(job_type TEXT, state TEXT, created_at TIMESTAMPTZ)` — and confirm the plain statement that this question over Octo's **own** control-plane history is **not** answerable end-to-end by this slice (no exporter).
4. **First client surface: HTTP-only, or also MCP?** The packet's default is **HTTP-only**; the thin MCP tool is deferred to Slice 3 (consistent with `SLICE_MAP.md` and issue #13). Confirm the default or bring the MCP tool into this slice (which would require defining its contract and an MCP-based eval here).
5. **Hidden holdout authorization.** AGENTS.md rule 9 permits a holdout only when the owning slice names it. Issue #13 names none. Authorize the single HTTP holdout described above, or remove it.
6. **Minor catalog additions.** `watermark` (declared export window), `idempotencyKey`, and `rowCount` are additions beyond issue #13's enumerated catalog fields (`workspace, logical dataset/version, schema/format, R2 locations, provenance`). Confirm them or drop them.
7. **Job-enqueue authority floor.** `analytics.query` lets a `member` with `read` enqueue an `analytics_query` job, whereas the generic `POST /api/jobs` enqueue requires `operator`. Confirm this deliberate lower floor for the single named spec.
8. **Migration grant target.** The analytics catalog tables grant DML to `octo_service` only (mirroring `tests/test_slice21_schema.py`), not `authenticated`. Confirm.
9. **Registration ingestion.** Dataset parts are supplied as base64 bytes in the JSON body (the caller never holds R2 credentials and never supplies keys); large-object streaming / presigned direct upload is deferred. Confirm, or direct a streaming/presigned path.
