# Scaling Octo's data engines — pragmatic research report

> Date: 2026-10-05 · Method: five specialist researchers (Postgres+pgvector, DuckDB, Parquet/lakehouse, graph, cross-cutting multi-tenancy + economics) plus an adversarial synthesis pass.
> Per-engine structured findings (the raw JSON the specialists returned) live beside this file in `docs/research/2026-10-05-scaling-data-engines/`.
>
> **Scope note (added 2026-10-11):** this report reasons about the **control plane** — the `octo.*` shared tables, `workspace_id` column, and RESTRICTIVE RLS. The shipped **data plane** is different by design (Slice 20: one real Postgres database per workspace) and is covered in the companion `2026-10-11-tenancy-capacity-dbw-and-bucket-layout.md`. Read bottom-line #2 below as a statement about the control-plane tier, not about workspace data.

---

## Bottom line

1. **Nothing structural needs to change now.** Octo is at single-digit workspaces and megabytes of data. One Postgres 16 + pgvector on one VM is two-to-three orders of magnitude from its limits, no Parquet is produced, no graph query exists, and there is no analytics engine. Every researcher independently reached "do nothing yet." The single highest-value work this quarter is *verification*, not construction.

2. **The single most important architectural decision: commit to shared Postgres + `workspace_id` + RESTRICTIVE RLS as the isolation tier — do NOT split into schema-per-tenant or database-per-tenant — and preserve the escape hatches so extracting a workspace later is mechanical, not a rewrite.** Schema-per-tenant is a trap (per-schema migrations, `search_path` fragility, catalog bloat, no resource isolation); database-per-tenant on the *same* VM also isolates nothing (CPU/RAM/disk stay shared). The escape hatches are cheap and non-negotiable: `workspace_id` on every tenant row, **no cross-workspace FKs or joins**, `workspace_id` as the **leading column of every composite index**, per-transaction `SET LOCAL` (never session-level `SET`) for tenant context, and RLS helper functions marked `STABLE` so the planner can inline them.

3. **The co-star invariant is mediation.** RLS fences the `octo.*` Postgres tables and nothing else. DuckDB has no RLS, Parquet has no RLS, no graph engine inherits the fence, and **R2 tokens cannot be scoped to a prefix — only to the account or a whole bucket** (verified). So the only thing keeping project A's agent out of project B's data across every engine is the Octo control plane: one fence per engine, all enforced by Octo, clients/agents get Octo API keys and never raw credentials. This is already declared in PROJECT.md; the decision is really *do not unmake either invariant*.

4. **The honest answer for Parquet, graph, and a separate vector store is "do nothing yet"** — and for DuckDB it is "build only the already-declared Slice 7, in the smallest shape." The first real triggers to watch are: (a) filtered vector-search recall degrading as workspace count grows, (b) DB size passing ~50–100 GB or the HNSW index exceeding RAM, and (c) active connections approaching `max_connections`. None has fired.

5. **Cheap, days-scale do-now items exist and are worth doing** — but they are verification/maintenance of what already exists, not scope: check the deployed pgvector version, add the tenant indexes that keep RLS index-shaped, enable `pg_stat_statements`, and actually perform one restore drill.

---

## 1. PostgreSQL + pgvector

**Verdict: the correct move today is to change nothing structural.** The single node is far from its limits (app pool 10 + service pool 6 = 16 connections against `max_connections` default 100), and the first real work is verification.

### Scaling ladder

| Stage | Trigger to move on | Action | Tradeoff |
|---|---|---|---|
| **0 — Single node, single DB, shared schema + RLS** *(today)* | You are here. No capacity trigger fired. | Verify pgvector version (`SELECT extversion`; iterative scans need ≥ 0.8.0). Add tenant indexes: unique `(principal_id, workspace_id)` on `workspace_memberships`; `(workspace_id, created_at DESC)` on activity/jobs/ops_events. Enable `pg_stat_statements`. Confirm backups **and do one test restore**. Raise `maintenance_work_mem` before any HNSW (re)build. | Near-zero cost. The only work is verification + a restore drill. |
| **1 — Vertical VM resize** | Working set nearing RAM, sustained CPU pressure, or autovacuum falling behind; still under ~50–100 GB / a few hundred connections. | Resize the VM. `shared_buffers` ~25% of RAM, `effective_cache_size` ~50–75% of RAM, tune `work_mem` per workload. Stay on one Postgres. | Brief restart downtime; still a single point of failure (already true today). Cheapest capacity per dollar — tens of $/mo for the next size. |
| **2 — Streaming read replica / warm standby** | Read-heavy analytics/BI competing with writes, or you want failover (HA). | Physical streaming replica on a second host; route analytics/BI reads there. | Async lag; **replicas add no write throughput**; another node to run/back up/fail over to. Needs a second host. |
| **3 — PgBouncer (transaction mode)** | Active backends approaching `max_connections` (100) or pool connection-timeout errors. **NOT Octo's current 16 — premature today.** | PgBouncer in transaction mode; cap the server-side pool. If named prepared statements are ever adopted, need PgBouncer ≥ 1.21 with `max_prepared_statements`. Verify `set_config(..., is_local=true)` inside BEGIN/COMMIT stays transaction-safe. | Extra service to operate; transaction mode breaks session-scoped features (LISTEN/NOTIFY, session advisory locks, non-LOCAL SET). |
| **4 — Partition the large tenant tables** | A single table > ~50–100 GB; autovacuum can't keep up; or a workspace's vector recall degrades because a **global** HNSW index must post-filter `workspace_id`. | `PARTITION BY LIST (workspace_id)` (pgvector's own multitenancy guidance) or HASH for even spread; time-partition activity/jobs/ops_events by month. Each partition gets its own HNSW index. **Caveat: iterative scans do not work across a partitioned parent in 0.8.x** — verify on your version and ensure pruning. Cheaper intermediate rung: a per-workspace **partial HNSW index** on the shared table. | Migration effort, many more relations, planner complexity, per-partition autovacuum tuning. Overkill today. |
| **5 — Vector memory management (quantization)** | Embeddings table / HNSW index working set exceeds RAM; index build or vacuum slow. | `halfvec(1536)` (~3 KB/vector vs ~6 KB for full `vector(1536)`) or `binary_quantize` + rerank with full vectors; raise `hnsw.ef_search` (default 40) or enable iterative scan; `REINDEX CONCURRENTLY` then `VACUUM`. | Recall tuning; expression indexes complicate writes. Only once the index no longer fits memory. |
| **6 — Dedicated vector store (Qdrant / Weaviate / Milvus / Pinecone)** | **Compositional, not a row count**: tens of millions of vectors AND p95 latency tuning can't meet, high QPS, or aggressive metadata-filtered search; or vector load harming relational performance. | Add Qdrant (self-hosted, Rust, one small service); Postgres stays source of truth; Octo mediates. Weaviate/Milvus for larger/complex; Pinecone if fully managed required. | A second always-on service plus a sync/consistency and dual-backup problem. pgvector remains correct through low millions of vectors and well beyond with partitioning + quantization. Far off. |
| **7 — Horizontal sharding / instance-per-tenant** | Write throughput or volume exceeds one node's vertical ceiling (hundreds of GB–TB, sustained write saturation), or a hard per-tenant isolation/compliance requirement. | Citus (row/schema sharding; pgvector on distributed tables has real limitations) or database-per-tenant on separate instances (cleaner fit). | Large architectural change + distributed ops. Anti-overengineering rule likely defers indefinitely. |

### Per-workspace angle
The current shared-table + RLS model is right and should stay. Isolation ladder, cheapest → strongest: (1) **shared table + RLS row isolation** — one migration path, one pool, one backup; risks are noisy neighbors, per-row RLS helper cost, and a global vector index; (2) **schema-per-tenant** — the classic trap middle ground: per-schema migrations, `pg_catalog`/relation bloat, fragile `search_path`, little isolation benefit over RLS while sharing one instance. **Avoid.** (3) **database-per-tenant** — genuinely cleaner isolation, per-tenant backup/PITR, independent extensions/upgrades; costs more connections, per-database migrations, provisioning glue; sensible only for a handful of high-value workspaces. (4) **instance-per-tenant** — strongest, highest cost/ops; only for compliance or a tenant that saturates a box.

**Underrated scaling cost of the current model is RLS.** Every permissive SELECT policy calls `octo.is_workspace_member(workspace_id)` — a `STABLE SECURITY DEFINER` function doing an `EXISTS` against `workspace_memberships` **per candidate row**. Workspace-scoped, index-backed queries (most of `src/server/db.ts`, via explicit `WHERE workspace_id = $1` + indexes) evaluate the policy on few rows and are fine; broad scans/analytics without a selective workspace predicate pay the helper per row. Keep every tenant query workspace-scoped and indexed, keep `workspace_memberships(principal_id, workspace_id)` uniquely indexed, and spot-check plans with `EXPLAIN ANALYZE`.

**Vectors:** a global HNSW index with a `workspace_id` filter is *filtered HNSW* — the index is scanned first and the filter applied after, so **recall drops as workspace count (filter selectivity) grows**. The recall fix is **iterative index scans (pgvector ≥ 0.8.0), not partitioning**; partitioning is physical separation and index-size/vacuum management. Per-workspace partial HNSW index is the cheap intermediate step; LIST partitioning is the later step.

**Recommendation:** do nothing structural now. The five cheap near-term actions are in Stage 0 above. First triggers, in order: (a) vector recall degrades → iterative scan → per-workspace partial HNSW → LIST partitioning; (b) DB > ~50–100 GB or working set > RAM → vertical resize, then replica/partition; (c) connections approaching `max_connections` → PgBouncer; (d) autovacuum lag/bloat on jobs/activity/ops_events/embeddings → per-table autovacuum tuning, then partition; (e) a specific workspace needs independent restore/retention or harms neighbors → database-per-tenant on a **separate instance**. Managed Postgres (RDS/Aurora, Cloud SQL/AlloyDB, Neon, Supabase, Crunchy Bridge) is only worth it if operating Postgres itself becomes the pain — there is no capacity reason to move yet.

---

## 2. DuckDB

**Verdict: right analytical engine, but only in its embedded, disposable-compute shape — in a dedicated worker, over workspace-scoped Parquet in R2, with Octo generating all SQL. Never as a server.** This is exactly what PROJECT.md and the Slice 7 packet already declare, so the recommendation is *build the declared slice and add nothing else*.

### Scaling ladder

| Stage | Trigger to move on | Action | Tradeoff |
|---|---|---|---|
| **Today** — one VM, single-digit workspaces, MB of data, no analytics engine | An accepted workspace question needs long-range history (declared Slice 7, unbuilt). | Do nothing new. Export operational history to Parquet in R2; answer with a one-off DuckDB CLI/script. No service. | $0, zero ops. Manual, not yet a product capability — fine, nothing asks for it. |
| **Embedded worker** (the correct default) | Analytics becomes a repeatable product job (Slice 7 ships), or the API process must not carry query memory. | Add a **separate Node worker process — NOT the API process**. Pin DuckDB **1.4.x LTS** (the 1.5 line EOLs 2026-11-01). Set `memory_limit` 2–4 GB, `threads` 2–4, `temp_directory` on **local SSD** (never network storage). Read `r2://…/workspaces/<ws-id>/…` via httpfs + a `TYPE r2` secret. Serialize jobs (one query at a time). Octo builds SQL server-side. | One more process to run/monitor and bounded concurrency — but a runaway query spills or fails instead of taking down the API. Cheapest step that removes the pain. |
| **Concurrent multi-process reads / scale-out** | One worker can't keep up; queries queue unacceptably. | Run N stateless workers all reading the same R2 Parquet read-only. **No Quack needed** — multiple processes can read concurrently (`READ_ONLY`) natively. Add a small queue + concurrency cap. | More processes/memory on the VM. No writer coordination needed because Parquet is immutable — writes are new files + a compaction job. |
| **Multiplayer DuckDB** | You genuinely need multiple writers or low-latency updates, not just appends via new files. | Adopt **DuckLake v1.0** with the existing Postgres as SQL catalog (ACID, Parquet on R2). **Do NOT self-host Quack yet** — beta until v2.0 (slated 2026-10-21). | Adds a catalog schema + consistency/maintenance. Prefer over `pg_duckdb`, which installs DuckDB inside the canonical OLTP Postgres you must not destabilize. |
| **Managed / real warehouse** | Genuinely concurrent multi-tenant analytics, always-on dashboards, or datasets large enough that single-node scan time hurts. | MotherDuck Lite (free, 10 GB) is the first rung; then MotherDuck Business or ClickHouse. Snowflake/BigQuery only if Octo leaves self-hosting — overkill. | Recurring cost and/or a new engine. Snowflake/BigQuery per-query/per-scan pricing is hostile to tiny, bursty, many-tenant workloads. |

### Per-workspace angle
Shared compute + per-workspace storage + a logical predicate — the same shape as the Postgres RLS fence. **The R2 prefix IS the fence**: bind each job's worker to exactly one `r2://bucket/workspaces/<ws-id>/…` prefix, with server-generated workspace IDs in the path so a tenant-controlled name can never influence path construction. A redundant `workspace_id` predicate is defense-in-depth, not the fence. Because Octo builds all SQL server-side and never accepts tenant SQL, a workspace can only reach data its worker is pointed at. One process per tenant is over-engineering now — and becomes nearly free later anyway, since multiple processes can concurrently read object storage (`READ_ONLY`), so per-tenant read workers over a shared prefix is a legitimate scale-out path without ever adopting Quack.

**Honest disclosure to keep:** the R2 credential the worker uses is **account-wide** (one token can read all prefixes), so the fence is application-level — identical to Octo's current Postgres/R2 trust model. Do not imply stronger isolation than that.

**Recommendation:** build the declared Slice 7 and nothing more. Keep DuckDB out of the API process; pin 1.4.x LTS with bounded memory/threads; point each job at one workspace prefix; serialize jobs; do NOT run a DuckDB server, do NOT adopt MotherDuck/ClickHouse, do NOT install `pg_duckdb`. When it actually hurts, the first graduation step is **DuckLake over the existing Postgres catalog — not a new warehouse**. Re-evaluate Quack only after v2.0 (2026-10-21) has a few months in the field. Note the Node client (`@duckdb/node-api`) is itself marked alpha by DuckDB — pin versions, treat upgrades as deliberate.

---

## 3. Parquet / object-storage lakehouse (R2)

**Verdict: do nothing lakehouse-shaped yet.** Octo produces no Parquet and its data fits in Postgres. When history appears, the minimum is a DuckDB job that COPYs Postgres to partitioned Parquet on R2 under the existing per-workspace prefix, with Postgres itself acting as the catalog. Iceberg/DuckLake/distributed engines deferred until a named trigger fires.

### Scaling ladder

| Rung | Trigger to move on | Action | Tradeoff |
|---|---|---|---|
| **0 — Single Postgres is the analytics engine** *(today)* | You are here. No Parquet anywhere; structured state + history live in one Postgres 16. | Do nothing lakehouse-related. Keep history rows in Postgres; when an append-only table grows, use declarative partitioning + `pg_partman`. DuckDB's `postgres` extension can already run analytical SQL against live Postgres with **no export at all** (`ATTACH … (TYPE postgres)`; read+write, filter pushdown, COPY both ways). | Zero new infra/failure modes. Postgres scans slow and storage pricier as history grows — but not until tens of GB, which Octo is far from. Any Parquet work now is speculative. |
| **1 — Raw partitioned Parquet + DuckDB reads it (GB scale)** | A workspace accumulates append-only history you'd rather not keep in Postgres, or a dataset passes a few GB / tens of millions of rows and Postgres scans hurt. | One job (reuse the jobs table + worker) runs DuckDB in-process: `ATTACH` live Postgres, then `COPY (SELECT …) TO 's3://octo/workspaces/{wsId}/lake/<dataset>/dt=YYYY-MM-DD/part-<uuid>.parquet'` (zstd). Query with `read_parquet('…/**/*.parquet')` via httpfs. No catalog, no manifest, no table format. Files **128–512 MB**; partition by low-cardinality time (day/month), **not** by `workspace_id` (already in the path). | Near-zero new infra. Latent costs: schema drift across files, orphaned bytes if the PUT succeeds and the job dies, file sprawl. At Octo's scale this is a job + a convention, not a platform. |
| **2 — Manifest + partition discipline (tens–hundreds of GB, many files)** | Hundreds of files per partition; per-query LIST cost showing up (**R2 ListObjects is a Class A op at $4.50/million**); or schema drift actually breaking a read. | Add a small Postgres manifest (dataset, partition, file key, row count, content hash, schema version) in a **separate schema** from the RLS-fenced app schema. Enforce "no per-query LIST — always read the manifest." Hive-style partitions, `union_by_name=true`, write-then-commit ordering, content-addressed filenames, periodic orphan sweep (reuse the existing `orphanedObjects` pattern). | A few hundred lines of bookkeeping + a discipline. No external system. Still no ACID, no row-level deletes, no time travel. |
| **3 — Compaction job (small files hurt)** | Median file size well under ~128 MB, or a query fans out over hundreds of tiny files (many range-GETs + footer reads per query). | Scheduled job rewrites a partition's small files into 128–512 MB files under **new** content-addressed names, updates the manifest, deletes the old. **Never overwrite a key in place: R2 allows only 1 write/sec per object key and returns 429 beyond that.** | Another job to own/monitor + rewrite I/O. At MB–GB scale pointless — do not schedule a compactor for data that fits in RAM. |
| **4 — Table format: DuckLake with a Postgres catalog** | Concurrent independent writers to the same lake dataset, need for row-level deletes/updates, time travel/schema evolution, or multiple DuckDB processes read-writing the same data. | Adopt **DuckLake v1.0 (Apr 2026)**: metadata in a SQL catalog DB (Postgres supported), data as Parquet on object storage; snapshots/time-travel/partitioning/schema evolution; no custom catalog server. Put the catalog in a **separate Postgres schema/database** from the RLS-fenced app schema. | Young format (~6 months old); only acceptable because lake data is **derived and rebuildable** — never the sole copy. **R2 support is via DuckDB's S3/httpfs layer and is NOT explicitly documented by DuckLake (only a MinIO demo) — verify `s3_endpoint`/`force_path_style` against R2 before committing.** |
| **5 — Iceberg + managed catalog** | Engines other than DuckDB (Trino, ClickHouse, BI tools, Snowflake) must read the same tables, or you want managed compaction/table maintenance. | Apache Iceberg tables on R2, with **Basin Catalog** (formerly R2 Data Catalog; GA Oct 2026) as the managed Iceberg REST catalog built into the bucket, auto-compacting small files. Query via DuckDB, Basin SQL, Trino, ClickHouse. Iceberg over Delta (Databricks-centric) or Hudi (streaming/CDC). | Iceberg metadata overhead (many manifests = more R2 Class A/B ops); catalog-op billing (**$9/million ops; compaction $0.005/GB + $2/million objects**); soft vendor tie to Cloudflare. Only worth it for interop you don't have. |
| **6 — Distributed query/OLAP** | Rules of thumb, **not measured**: hot Parquet > ~500 GB; interactive scans > ~50–100 GB; > ~10 concurrent query users; or a scan whose wall-clock (~100–500 MB/s effective per node from object storage, so ~1 TB ≈ 30–90 min) is fatal for a dashboard. | Self-host Trino (federated SQL over Iceberg/Postgres/Parquet) or ClickHouse (fast high-concurrency OLAP, reads Iceberg/S3); Spark only for heavy batch ETL. Or stay managed with Basin SQL. **Athena is not a fit**: AWS-only, cannot read R2 natively, $5/TB scanned. | A stateful multi-node service to run/secure/upgrade — a large ops jump for a single-owner platform. Explicitly premature. |

### Per-workspace angle
Prefix-per-workspace is already the correct and existing layout (`workspaces/{workspaceId}/{fileId}/{name}`), so the lake extends it as `workspaces/{workspaceId}/lake/…`. Keep **one bucket and one master R2 credential held only by Octo**. **Verified constraint: R2 API tokens can be scoped only to the account or to specific buckets — there is no prefix-level scoping.** Consequence: (a) isolation must live in the Octo API + path scoping, not in storage credentials; (b) if a workspace ever genuinely needs a direct storage credential, the only true credential-level isolation is **bucket-per-workspace** — cheap in principle (R2 allows up to 1,000,000 buckets/account, no per-bucket fee beyond storage/ops) but operationally heavier. For scoped direct access without exposing the master credential, prefer **Octo-minted presigned URLs** (already implemented in `r2-client.ts`). Query engines have no RLS, so the mediator must constrain the glob/path to `workspaces/{workspaceId}/…` — a query engine handed the master credential can read every workspace. Any DuckLake/Iceberg catalog must likewise be workspace-scoped, never shared across tenants with one credential.

**Recommendation:** build nothing lakehouse-shaped now. When the first analytics-history capability is accepted: (1) have the existing jobs worker run DuckDB in-process to ATTACH live Postgres and COPY to zstd Parquet under `workspaces/{workspaceId}/lake/<dataset>/dt=YYYY-MM-DD/part-<uuid>.parquet`, files 128–512 MB; (2) read back with DuckDB httpfs; use the `postgres` extension to join live state to history with no ETL; (3) use Postgres itself as the catalog/manifest (separate schema), enforcing "no per-query LIST"; (4) adopt no table format, catalog service, compaction, or distributed engine until a **named** pain appears (file count, schema drift, concurrent writers, row-level deletes, multi-engine access). When that fires, prefer DuckLake (Postgres catalog + Parquet, no catalog server — but young and derived-data-only) over Iceberg; choose Iceberg + managed Basin Catalog only if broad multi-engine interop is required, and treat managed Basin SQL ($2.50/TB scanned, 10 GB/month free) as the escape hatch, not an adoption target.

---

## 4. Neo4j / graph

**Verdict: do not host a graph engine today.** Postgres recursive CTEs (and DuckDB/Parquet for batch graph analytics) cover Octo's actual graph-shaped needs. The only thing a dedicated graph engine adds inside the current fence is **Cypher syntax — an ergonomics problem, not a scaling problem.**

### Scaling ladder

| Stage | Trigger to move on | Action | Tradeoff |
|---|---|---|---|
| **0 — Today: no graph engine** | Any graph-shaped question appears ("what is connected to what", reachability). | Model edges as ordinary Postgres tables; query with `WITH RECURSIVE`. Keep it inside `octo` and the existing `workspace_id` RESTRICTIVE RLS fence. For set-based analysis (centrality, connected components, community detection) use the Parquet + DuckDB lane. Do not add a service. | Recursive CTEs are practical to roughly **3–4 hops and ~10⁵ edges**, then the planner's working set grows exponentially and a 10-hop query typically times out (order-of-magnitude, workload-dependent). No Cypher. $0, zero new ops. |
| **1 — GraphRAG-lite / shallow semantic graph** | An agent needs relationship-aware retrieval: vector similarity + a bounded 2–3 hop neighborhood join. | Compose pgvector KNN with a bounded recursive CTE over edge tables in the **same** Postgres instance. Covers most "GraphRAG-lite" patterns. | Hard-bounded hop count, no variable-length path product. Still $0, inside the relational fence. |
| **2 — Cypher ergonomics wanted (AGE inside existing Postgres)** | Owner/agents specifically want Cypher via the MCP adapter, traversals stay within ~4–5 hops / low-millions of edges. | Run **Apache AGE** (Apache 2.0; PG16 = v1.6.0) inside the Postgres Octo already runs, one AGE graph namespace per workspace, accessed only through Octo's mediation. This is the only Cypher path inside Postgres until SQL/PGQ, which was **reverted from PG 19 (7 Sep 2026)** and is earliest in PG 20 (~Sep 2027). | AGE compiles Cypher to recursive SQL, so it **inherits the same 4–5 hop ceiling with no performance headroom** (benchmarks show it slower than raw CTEs and timing out on large/deep cases). **Isolation caveat: AGE stores graph data in its own namespace, so the `octo.*` RLS fence does NOT cover it. On PG16 there is no AGE-level RLS (that arrived only in the PG18/1.7.0 branch)** — graph isolation rests on Octo's mediation layer, a deliberate documented weakening of the DB-level fence. Buys syntax, not capability. |
| **3 — One workspace genuinely needs online graph traversal** | A specific workspace crosses **any two** of Capital One's thresholds — multi-million nodes, 5+ hop traversals, 100s of simultaneous graph queries, 100s of interactive graph algorithms — AND a pattern test on real data shows the CTE/AGE baseline misses the latency SLO (a long, selective, path-shaped query — the only shape where benchmarks show a graph DB clearly winning). | Stand up **ONE dedicated single-node engine for that workspace only**, behind Octo mediation, firewalled to localhost. Smallest realistic: Neo4j Community (single database, Cypher; GPLv3 fine for internal self-host; no hot backup, so the projection-rebuild pipeline IS the backup) or an in-memory engine exported from Postgres (FalkorDB/Memgraph) if the graph fits RAM. Treat the graph as a **rebuildable projection**, not a system of record: no clustering, no HA, no Enterprise license. | A new JVM/service to operate, ~2–8 GB RAM + 2+ vCPU, plus Neo4j's heap + page cache (~1.2× data+index) and per-database query-cache overhead. Recovery = re-derive from Postgres. FalkorDB is arguably the better multi-workspace shape; Memgraph is BSL 1.1 (not OSI). |
| **4 — A single workspace's graph outgrows one node** | Graph exceeds a single node's RAM/disk, write throughput exceeds one writer, or HA/failover becomes a hard requirement. | Only now consider Neo4j Enterprise causal clustering (reads scale on async secondaries; still exactly **ONE writer per database**; max 11 primaries / 20 secondaries, M=2F+1) and/or Infinigraph property sharding (GA Jan 2026, separate subscription). | Commercial license (custom quote; third-party marketplace estimate ~**$3k–6k/core/yr**, ~$80k–200k+/yr for 16-core production — rough, not list) plus Infinigraph's extra subscription plus real distributed-ops burden. For Octo, very likely never. |
| **5 — Self-hosting graph ops is the actual pain** | Operational burden outweighs the self-hosted requirement for some workspace. | Managed: Neo4j AuraDB, or Amazon Neptune if all-in on AWS. | Recurring cost + data leaving the single host. AuraDB: Free (single DB), Professional **$0.09/GB/hr** (min 1 GB ≈ $65/mo), Business Critical **$0.20/GB/hr** (min 2 GB ≈ $288/mo). Neptune is AWS-managed only: db.r5.large $0.348/hr, storage $0.10/GB-mo, I/O $0.20/million. Neither aligns with Octo's self-hosted direction. |

### Per-workspace angle
No graph engine inherits the RLS fence. Neo4j has **no row-level security**, so the three patterns trade isolation against cost: (1) **one shared graph with a tenant property** — cheapest, but filtering lives entirely in application/Cypher and is easy to get wrong; worse, the **native Neo4j Browser bypasses Octo's mediation** and would show every tenant, contradicting PROJECT.md's "native consoles remain available for deep work." (2) **database-per-tenant** — physical separation, but **Enterprise-only** (Community allows exactly one standard database), no cross-database relationships, each database adds fixed memory + its own query caches. AuraDB Free is single-database. (3) **instance-per-tenant** — strongest, highest cost. Recommendation: never put all workspaces into one Community Neo4j database relying on app-layer filtering. Prefer one graph per workspace — an AGE namespace per workspace in the shared Postgres (mediation-only isolation on PG16), or a dedicated instance for the one workspace that truly needs it — and lean on graph data being a rebuildable projection, so per-workspace engines need no HA.

**Recommendation:** do nothing yet. The single strongest framing: the only graph feature Octo cannot get today inside its existing fence is native Cypher/PGQ syntax, and syntax is not a scaling problem.

---

## 5. Cross-cutting: multi-tenancy isolation tiers and managed-vs-self-hosted economics

### Isolation tiers (cheapest → strongest; both isolation and cost rise left to right)

| Tier | Isolation | Cost / ops | When |
|---|---|---|---|
| **Shared table + `workspace_id` + RESTRICTIVE RLS** *(today)* | Row-level, app/DB-enforced | One migration path, one pool, one backup; **≈$0 marginal per workspace** | Now, through single-digit to low-dozens of workspaces and GBs of data. **Correct and should stay.** |
| Schema-per-tenant | Logical only — **NO resource isolation** (same CPU/RAM/IO) | Per-schema migrations, catalog bloat, fragile `search_path` | **The trap middle ground. Avoid.** Neon explicitly advises against it for SaaS. |
| Database-per-tenant (same host) | Physical separation of data — **still no resource isolation** | Per-DB migrations, connections, provisioning glue | Only a partial step; a second database on the same VM isolates nothing resource-wise. |
| Database-per-tenant (**different instance/host**) | Genuine isolation: per-tenant backup/PITR, independent extensions/upgrades | Per-project floor ($0–25/mo managed) + one more thing to patch/back up | One workspace exceeds ~50–100 GB, its vector index dominates RAM, needs residency/independent restore/compliance, or needs more than the whole box. |
| Instance-per-tenant (fleet) | Strongest | Ops + cost scale linearly with tenants | Many workspaces each need isolation/residency/independent restore. |

**RLS breaks first on two axes:** (1) **noisy neighbors** — Postgres has no native per-tenant CPU/memory quotas, so a heavy workspace contends on CPU, memory, disk I/O, connections, and locks; (2) **one huge tenant** — a table or vector index that dominates the instance degrades everyone. Per-tenant resource limits in a shared Postgres are limited to `statement_timeout`, `idle_in_transaction_session_timeout`, and (once per-workspace DB identities exist) pooler caps (`PgBouncer max_db_connections`, `max_user_connections`, per-DB `pool_size`). Today Octo is a single application user, so the honest near-term tools are `statement_timeout` + `pg_stat_activity` observation; pooler per-tenant caps only become real when workspaces get their own DB roles. Mature SaaS almost universally runs a **hybrid/tiered** model (AWS "pool / silo / bridge"): pool small tenants on shared infra, silo large/regulated/noisy ones onto dedicated instances.

**Two pooler mechanics decide whether the RLS fence survives:** it resolves the tenant through session state, and **PgBouncer transaction mode discards session state between transactions** — so context must be passed **per-transaction (`SET LOCAL`)** and prepared statements disabled if a transaction-mode pooler enters the path (Supabase docs: "Session-level state is lost between transactions… covers set and reset"; "Transaction mode does not support prepared statements").

### Cost comparison (rough, list prices, mid-2026, us-east-1/us-central1 — order-of-magnitude, not quotes)

| Option | Kind | Rough cost | Notes |
|---|---|---|---|
| **Current: self-hosted VM + R2** | self-hosted | **~$20–40/mo VM**; R2 $0.015/GB-mo + free egress | Baseline; effectively $0 marginal per workspace |
| RDS for PostgreSQL (db.r7g.large) | managed | ~$0.24–0.28/hr (~$175–205/mo) + gp3 $0.10/GB-mo | |
| Aurora (Serverless v2) | managed | $0.12/ACU-hr (**0.5 ACU floor ~$44/mo idle**) + $0.10/GB-mo + I/O $0.20/M | |
| Google Cloud SQL (Enterprise) | managed | ~$0.0413/vCPU-hr + $0.007/GiB-hr (**2 vCPU/8 GB ~$110/mo**); AlloyDB materially more | |
| Neon | managed | Launch **$0.106/CU-hr**, Scale $0.222/CU-hr; storage **$0.35/GB-mo**; **scales to zero** | 100 projects Free/Launch, 1,000 Scale |
| Supabase | managed | Pro **$25/mo** + per-project compute **$10 (Micro) – $3,730 (16XL)/mo**; storage $0.125/GB-mo | **Pro does NOT pause when idle** |
| Crunchy Bridge | managed | from **$10/mo** | |
| MotherDuck | managed DuckDB | Lite free (3 internal users, 10 GB, 10 Pulse hrs/mo); **Business $250/org/mo** + $0.04/GB-mo + $0.60/CU-hr Pulse | Step function entry |
| ClickHouse Cloud | managed OLAP | ~**$0.33–0.50/CU-hr** (1 CU = 8 GiB/2 vCPU); $22–27.50/TB-mo storage; $300/30-day credit | |
| Basin SQL + Catalog (on R2) | managed lakehouse | SQL **$2.50/TB scanned** (10 GB/mo free, 10 MB min/query); catalog ops $9/M (1M free); compaction $0.005/GB + $2/M objects | GA Oct 2026 |
| Neo4j AuraDB | managed graph | Free single DB (~200k nodes/400k rels); Pro **$0.09/GB-hr** (min 1 GB ≈ $65/mo); BC $0.20/GB-hr (min 2 GB ≈ $288/mo) | |
| Amazon Neptune | managed graph | db.r5.large $0.348/hr + $0.10/GB-mo + $0.20/M I/O | No self-host |
| Cloudflare R2 | object storage | **$0.015/GB-mo** Standard, $0.01 IA; Class A $4.50/M, Class B $0.36/M; **egress free** | Free tier 10 GB + 1M Class A + 10M Class B |

**Economics summary:** the bill at current scale stays roughly **$20–40/mo VM plus R2** (~$0.015/GB-mo, free egress). Managed engines only pay when a single tenant is worth the per-project floor, which is why isolation is a **trigger**, not a default. All prices are public list, region-dependent, exclude egress (except R2), and change over time; Neo4j Enterprise pricing is a third-party estimate, not list.

---

## 6. Staged recommendation for Octo

### NOW — no new engines, no new services, no architectural changes
The exception is cheap verification/maintenance of what already exists (days, not weeks):

1. **Check the deployed pgvector version** — `SELECT extversion FROM pg_extension WHERE extname='vector'`. Iterative scans (the filtered-HNSW recall fix) require **≥ 0.8.0**; the `pgvector/pgvector:pg16` tag tracks latest so it's *probably* fine, but **verify**, and if below, plan the upgrade.
2. **Add the tenant indexes that keep RLS index-driven** — unique `(principal_id, workspace_id)` on `workspace_memberships`; `(workspace_id, created_at DESC)` on activity/jobs/ops_events.
3. **Enable `pg_stat_statements`** and read slow queries before adding anything.
4. **Confirm backups/PITR and actually perform one restore.**
5. **Preserve the escape hatches** — `workspace_id` first in composite indexes, no cross-workspace FKs/joins, per-transaction `SET LOCAL`, RLS helpers marked `STABLE`.
6. **Keep DuckDB out of the API process.** If/when Slice 7 is built: dedicated worker, pinned 1.4.x LTS, `memory_limit` 2–4 GB, `threads` 2–4, `temp_directory` on local SSD, one workspace prefix per job, serialized jobs.

Leave the single VM, single database, shared-schema + RLS design as-is. PgBouncer, read replicas, partitioning, a dedicated vector store, Parquet/lakehouse, and any graph engine are all premature.

### First triggers to watch (in order)
1. **Vector recall degrades** — filtered HNSW returns too few rows as workspace count grows → enable iterative scan → per-workspace partial HNSW → LIST partitioning.
2. **DB size > ~50–100 GB or working set > RAM** → vertical resize → read replica/partition.
3. **Active connections approaching `max_connections`** or pool connection-timeout errors → PgBouncer in transaction mode.
4. **Autovacuum lag/bloat** on jobs/activity/ops_events/embeddings → per-table autovacuum tuning → partition.
5. **One workspace needs independent restore/retention or harms neighbors** → database-per-tenant on a **separate instance** via row-filtered logical replication (native since PG15; Octo is on PG16).

### Ordered sequence of moves as it grows
1. Now: verification + indexes + restore drill + escape hatches. **(no structural change)**
2. Vertical VM resize when RAM/CPU pressure appears.
3. **Dedicated embedded DuckDB worker (Slice 7)** when an analytics capability is actually accepted.
4. PgBouncer when connections approach 100.
5. Streaming read replica when read analytics competes with writes.
6. Per-workspace partial HNSW index → LIST partitioning when recall degrades or a table passes ~50–100 GB.
7. Move one workspace to a **dedicated instance** when it exceeds ~50–100 GB, its vector index dominates RAM, or it needs residency/independent restore.
8. Dedicated vector store (Qdrant) at tens of millions of vectors **with** latency/filtering/QPS pressure.
9. DuckLake (Postgres catalog) when concurrent writers/row-level deletes are needed; Iceberg + Basin Catalog only for broad multi-engine interop.
10. A graph engine only if one workspace has real long/selective/path-shaped traversal at multi-million-node / 5+ hop scale.
11. Citus/sharding: essentially never under the current contract.

---

## 7. Where the researchers disagree or are uncertain (stated, not smoothed over)

- **DuckDB placement — direct contradiction.** The DuckDB specialist says a **dedicated worker, NOT the API process** (default `memory_limit` is 80% of RAM; an unbounded query can OOM the control plane). The cross-cutting researcher says "embed DuckDB in the API process over Parquet on R2 now." The disagreement is narrower than it looks — both agree nothing should be built today, and the cross-cutting claim reads as a statement about *single-writer* concurrency, not blast radius. **Resolution: the dedicated worker wins on asymmetric failure cost** (a runaway query spills or fails instead of taking down the API). One extra process on the existing VM is a trivially small increment against the anti-overengineering rule, which targets speculative architecture, not a boundary that prevents a known failure mode.
- **DuckLake's R2 support is inferred, not documented.** Both the DuckDB and Parquet researchers converge on DuckLake (Postgres catalog) as the graduation step, but DuckLake's docs demonstrate only MinIO/S3; R2 via `s3_endpoint` + path-style must be **verified before committing**. DuckLake v1.0 is ~6 months old with no release history — hold only derived, rebuildable data in it.
- **AGE weakens the DB-level fence.** Apache AGE on PG16 has **no RLS coverage** (graph data lives in its own namespace; RLS arrives only in the PG18/1.7.0 branch). If AGE is adopted, isolation rests on Octo's mediation layer only — carry this caveat at full weight.
- **RLS per-row helper cost is reasoned, not measured.** The `is_workspace_member()` SECURITY DEFINER cost is inferred from policy definitions; whether policies inline depends on `STABLE` marking. **Verify with `EXPLAIN ANALYZE` on a large tenant before optimizing.**
- **pgvector version is genuinely unknown** — the deployed image tag tracks latest, so iterative scans are probably present but unverified.
- **MotherDuck tension (minor):** the DuckDB specialist says don't adopt it at all; the cross-cutting researcher lists it as the rung "if concurrent analytics outgrows embedded." Different rungs, not a contradiction; the DuckDB researcher's stricter framing stands since they owned the engine.
- **All thresholds are heuristics, not measured on Octo.** The ~50–100 GB / ~50–100M row / "index exceeds RAM" / CTE ~3–4 hop / AGE ~4–5 hop / DuckDB ~500 GB figures are engineering rules of thumb or third-party benchmarks — not published limits and not measured on `gravebuster`. Re-measure on real data before any decision that depends on them.
- **Costs are list prices, mid-2026, region-dependent**, excluding egress (except R2); Neo4j Enterprise (~$3k–6k/core/yr) and AuraDB Free limits (FAQ says 200k nodes/400k rels; some Neo4j material says 50k/175k) are third-party or inconsistent. Treat as order-of-magnitude.
- **Whether any workspace ever needs true physical isolation, graph traversal, or long-range analytics is a product decision** not derivable from the repo. If none arises, most rungs above "do nothing" may never be needed — and that is an acceptable outcome.

**The one-sentence version:** stay on one shared Postgres + RLS, keep mediation as the invariant across every engine, preserve the escape hatches, and build only the already-declared embedded-DuckDB analytics worker — everything else is a trigger to watch, not a task to start.
