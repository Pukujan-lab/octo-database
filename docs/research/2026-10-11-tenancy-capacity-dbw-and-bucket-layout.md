# Tenancy capacity: DB-per-workspace and single-bucket R2 — the standing answer

> Date: 2026-10-11 · Question that keeps recurring: "can we change DB-per-workspace? should we go multi-bucket? what about 50+ workspaces / 100+ users?" · Measured on the live Mac host (not estimated). Companion to [[2026-10-05-scaling-data-engines]] — that doc covers the *control-plane* shared-schema/RLS tier; this one covers the *data-plane* DB-per-workspace tier and R2 bucket layout, which that doc does not.

## Measured state (2026-10-11, live host)

| Metric | Value |
|---|---|
| `max_connections` | 100 |
| databases in cluster | 5 (control + 2 workspace + templates) |
| cluster total size | 39 MB |
| `octo.claims` / `beliefs` / `evidence` / `perspectives` / `epistemic_entities` | 0 / 0 / 0 / 0 / 0 (epistemic ledger exists and is wired but never used) |
| `octo.workspace_databases` catalog rows | 2 |
| actual `octo_ws_*` Postgres DBs | 2 (matches catalog) |

## Verdict

**Change nothing.** At 50 workspaces and 100+ users, no structural change is warranted. The model is a legitimate hybrid (RLS-shared control plane + DB-per-workspace data plane + prefix-isolated single bucket), matching AWS's pool/silo/bridge pattern. All thresholds below are orders of magnitude, not measured Octo limits — re-measure before any decision that depends on one.

## DB-per-workspace

**Changeable, but only by a real re-architecture** — collapse into one shared Postgres with schema-per-tenant or shared-schema + `tenant_id` + RLS. This rewrites the whole fence (`octo_app`/`octo_service` roles, `current_workspace_id()`) and the isolation model the system is built around. Do not do it for capacity: at 5 DBs and 39 MB there is no density problem. The `2026-10-05-scaling-data-engines.md` research also explicitly warns schema-per-tenant is "the trap middle ground" — avoid.

**Why it scales past 50 workspaces:** connections are per-request, not per-workspace. `src/server/query.ts` `runWorkspaceQuery` opens a fresh short-lived `pg.Client` per request and closes it (`await client.end()` in `finally`) — no persistent pool per workspace. So *workspace count* costs zero idle connections; only *concurrent requests* do. The binding limit is `max_connections=100` under concurrency, not workspace count.

**Scaling ladder (data plane):**

| Trigger | Action |
|---|---|
| ~100 concurrent SQL requests | raise `max_connections` or add PgBouncer (transaction mode) |
| hundreds–~1,000 workspace DBs | cluster-wide ops slow (catalog, autovacuum, and the daily whole-cluster `pg_dump` gets long) — this is the honest ceiling for one cluster |
| beyond that | shard: add a `cluster`/`region` column to `octo.workspace_databases` (the seam already exists — the catalog row is the natural place to carry a cluster name) |

## 100+ users

Non-issue. Users are rows in `octo.principals` + `octo.workspace_memberships` in the control DB; 100 users is nothing. What scales with users is concurrent requests → the `max_connections` number → raise it or front with PgBouncer when concurrency actually grows. 100 users doing occasional queries is nowhere near 100 simultaneous.

## Single bucket vs multi-bucket

**Keep one bucket (`octo`), plus the existing `octo-public` for published files.** Correction to an earlier session's claim: R2's documented limit is **1,000,000 buckets per account** (the 1,000-bucket ceiling people cite is AWS S3, not R2) — so bucket count is not a quota problem. The reason to say no is that you'd be splitting on the wrong axis: object storage scales by object count and prefix, not bucket count; millions of objects under `workspaces/<wsId>/…` is fine. The reason to split buckets is differing lifecycle/retention/policy, and Octo already splits on exactly that (`octo` private vs `octo-public` published). Per-workspace buckets add provisioning and per-bucket config for an isolation boundary that isn't real anyway — R2 API tokens can be scoped only to the account or to specific buckets, never to a prefix (verified in the 2026-10-05 research), so per-workspace buckets don't give credential-level isolation without per-workspace R2 credentials, which is exactly the extra machinery AGENTS.md forbids building unprompted.

## What to actually watch

Not DB count, not bucket count. Watch:
1. **Whole-cluster `pg_dump` duration** (`deploy/mac/backup.sh`) — first real symptom of DB sprawl; a backup problem long before a database problem.
2. **`max_connections` under concurrency** — check `pg_stat_activity` if queries start timing out.

## Where this sits vs the older research

`2026-10-05-scaling-data-engines.md` covers the control plane (shared-schema + RLS tier) and explicitly says database-per-tenant is "sensible only for a handful of high-value workspaces" — that framing was about the control-plane tables, and predates Slice 20 making DB-per-workspace the actual data-plane default. This doc is the data-plane answer and supersedes nothing; the two together say the same thing at different tiers: shared-schema/RLS for control-plane rows, DB-per-workspace for tenant data, one bucket + prefixes for bytes, and nothing to change until a named trigger fires.
