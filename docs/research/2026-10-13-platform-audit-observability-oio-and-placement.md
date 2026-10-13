# Platform audit — observability, evidence storage, OIO intake, and the dev/app placement decisions

> Date: 2026-10-13 · Session audit of the live platform (Mac host) plus the placement questions raised the same day. Companion to [[2026-10-11-tenancy-capacity-dbw-and-bucket-layout]] (data-plane capacity) and [[2026-10-05-scaling-data-engines]] (control-plane tier). Every finding below is stated with its evidence (file:line or measured rows); nothing here proposes a fix unless a fix is already an open issue.

## 1. There is no query/read-path logging

Octo records **mutations** and **failures**, not reads.

- `dbRecordActivity` is called only from mutating handlers — `src/server/index.ts` at the create/update/delete/upload/revoke paths. A read (list, get, `claims-as-of`, `rag/query`) writes no activity row.
- `dbRecordOpsEvent` (`src/server/db.ts:1294`, via `captureOpsEvent` `src/server/index.ts:912`) is failure-only — it exists so a permanently-failed job leaves one attributable event.

Implication: there is no operational record of who read what. The IAM three-lane model (management events / data events / insight events) has no Octo analogue for the data-events lane. This is stated as a fact, not a defect; whether Octo should log reads is a separate decision and is **not** proposed here.

## 2. Evidence is pointer-only

`octo.evidence` (`db/migrations/20261001040000_slice9_epistemic_schema.sql:24-35`) stores `source_file_id`, `locator`, `quote`, `content_hash` — and by comment "never stores bytes or provider credentials." The ledger therefore holds **zero evidence bytes**; the bytes live in R2/`octo.files` (or a git locator) and the ledger holds the reference. This is the design, confirmed against the schema.

## 3. Two-tier database + storage tree

| Tier | What it is | Where |
|---|---|---|
| Control plane | one Postgres, `octo` schema, shared-schema + RLS (`octo_app` fenced / `octo_service` bypass) | `postgres` DB, control migrations |
| Data plane | DB-per-workspace, `octo_ws_<slug>_<suffix>`, pgvector enabled at provision | `src/server/provisioning.ts:41` |
| Object store | one private bucket + one public bucket | R2 |

`provisionDatabase` (`src/server/provisioning.ts:184-211`) creates the role/database and runs exactly `CREATE EXTENSION IF NOT EXISTS vector` (`provisioning.ts:156-171`). **No `octo.*` tables land in a workspace DB** — the epistemic schema is control-plane only.

## 4. Backup posture (tracked: octo-database#202)

`deploy/mac/backup.sh` on `main`: local dumps are pruned to `OCTO_BACKUP_KEEP` (default **1**), and the offsite copy to `OCTO_BACKUP_R2` (default `r2:octo-backups`) runs **only if** `rclone` is present and an `r2:` remote is configured — otherwise it prints `offsite: skipped`. So offsite is conditional on host configuration, and local retention defaults to a single dump. The detail and remediation live on **#202**; this note records only the state.

## 5. OIO intake is now a managed full install (PR #230)

The prior `.github/ISSUE_TEMPLATE/observational-issue.yml` and triage workflow were a stale hand-copy. PR #230 ran the pinned OIO adopter installer (`OIO 0.1.0 @ 402a46e`), installing the managed `.oio/` tree (ontology JSON, schemas, `ISSUE_LOG_ONTOLOGY.md`, `AGENT_GUIDE.md`), the current issue template, and the triage workflow. Octo's project extension (`.oio/ontology/project.json`) now carries **project-specific priority paths 1–10** (product-blocking → out-of-scope → deferred) instead of the generic 1–100 scaffold, and maps the owner account (`Pukujan`, `137629468`). `project.json` is adopter-owned; the other eleven files are installer-managed.

## 6. Dev-vs-application layer separation

Octo's product serves **application-layer agents**: a workspace + key + a managed database/R2 for an application's own data. The stack's *own* development coordination (who is boss, claim queue, role seeds — `.coord/*.json`) and its *governance* (what was decided and why) are a different concern:

- Governance lives in **git/GitHub** (issues, PRs, this doc). Octo is an **adopter** of the stack, not a certified component.
- Octo's control-DB epistemic ledger is the **queryable believed-state** store, for any workspace (including the owner's `chatgpt` workspace used for research).
- No workspace is created for stack governance itself; if an a2a coordination *executor* is ever built, its runtime store would be a dedicated workspace (`stack-ops`), which is **not** proposed now.

## 7. a2a coordination storage-class rule (decided)

The problem is filed as **agent-custom-setup#91**; the coordination layer already exists as advisory `.coord/*.json` + `ROLES.md`, and the missing piece is an **executor** that enforces it. The decision taken:

- **Ratify the storage-class rule now**: coordination hot-state needs an **atomic conditional store** (compare-and-set on the lease/claim rows), history needs the **git ledger** — and the state is **never DB-only**.
- **Defer building the store.** Build trigger = the first real cross-machine contention or an observed collision, not speculation.
- **When built, sequence**: octo-database#111 (RLS bypass path) first, then octo-database#202 (backup durability) makes the store load-bearing; an Octo-hosted store waits on Mac-host durability. A stack-owned store remains the fallback.

The argument and rationale live here; the problem statement and the proposed next actions live on ACS #91.

## 8. Consumer-capability answers (audit, 2026-10-13)

What an adopter actually gets, verified against the current code:

| Capability | Platform-internal? | Consumer-accessible? | Enforced / template / none |
|---|---|---|---|
| Epistemic record (`POST /api/epistemic/record`) | no — role-gated | yes — write scope + operator role, workspace-bound | enforced by role + RLS |
| Epistemic read (`claims-as-of`, `belief-as-of`) | no | yes — read scope + membership | enforced |
| Epistemic schema inside a workspace DB | — | no | **none** — control-plane only |
| pgvector in a workspace DB | no | yes | enforced (enabled at provision) |
| File → RAG indexing | — | no | **none** — uploads enqueue no embed job (**#227**) |
| Own RAG/epistemic tables | no | yes | consumer builds it (write-scope DDL or direct connection) |

- The epistemic ledger is **consumer-reachable, not platform-owner-gated**: a workspace-scoped key minted by the workspace owner (stored role `owner`) reaches `record` (needs operator+) and the as-of reads (member+). MCP exposes `record_epistemic`, `query_claims_as_of`, `query_belief_as_of` to such a key.
- RAG is exposed too: `POST /api/rag/documents` (ingest, needs `OCTO_EMBEDDING_API_KEY`) and `POST /api/rag/query` (retrieve); embeddings are stored in the control `octo` schema.
- **Consumers do not make their own embedding models** — they submit text and the platform embeds it. They *can* build their own RAG/epistemic tables in their workspace DB (pgvector pre-enabled; write scope for DDL, or a direct connection).
- The epistemic layer is **neither a template nor enforced for consumers**: it is a shared service they call, not a schema they inherit.
