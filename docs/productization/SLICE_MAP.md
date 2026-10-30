# Octo Productization Slice Map (Draft)

This map translates the program in `PROJECT.md` and issue #74 into bounded user jobs. It is planning input for owner review; no slice is locked until the owner accepts or corrects its packet on the owning issue.

## Ordered slices

| Order | Slice | Main dependency | Robustness |
|---|---|---|---|
| 0 | Complete runtime/bootstrap prerequisites and make the online test deployment usable | Existing deployment; #75 baseline train sync and #78 local test bootstrap are merged; #76 tracks the next upstream train | Level 2 for durability claims |
| 1 | Discover the operations a caller can use in a selected workspace, then invoke an advertised operation | Existing auth, API and PostgreSQL | Level 2: live authority and deployed API |
| 2 | Complete the existing workspace file lifecycle: find, retrieve, archive, restore and share intended files | Slice 1; existing gallery, storage and jobs | Level 2: durable bytes and transitions |
| 3 | Complete the same workspace/file jobs through the TypeScript SDK, CLI and MCP adapter | Slice 1; stabilized operations from Slice 2 | Level 2: client/server equivalence |
| 4 | Select a frontend delivery approach through a bounded bakeoff | Stable API plus Slice 2 fixtures | Level 1: evaluated prototype |
| 5 | Deliver the selected workspace shell with overview, gallery, keys and operations | Slice 4 and useful flows from Slices 1–3 | Level 2: real browser jobs |
| 6 | Recover one owner-declared set of important user/agent files on a fresh machine | Slice 2; recovery UI from Slice 5 | Level 2: recovery is the product claim |
| 7 | Answer one accepted historical workspace question with Parquet and DuckDB | API foundation and issue #13 | Level 2: durable dataset and result metadata |
| 8 | Let an agent propose one supported change, then let a human authorize that exact proposal | Slices 1–5; one supported action | Level 2: durable proposal and execution state |
| 9 | Rebuild and query an optional graph projection for a graph-enabled workspace | Existing epistemic model and issue #12 | Level 2: reconstruction and freshness |

**Conditional retrieval correction:** If a slice exposes RAG/GraphRAG retrieval, first lock a bounded issue #10 repair packet for PDF ingest, provenance, and rebuildable embeddings. This does not block unrelated API, file, shell, recovery, or analytics jobs.

Existing pgvector/RAG behavior should be reused where relevant; a new vector implementation is not proposed. The current RAG path has concrete ingest/rebuild and source-link limitations. Any later client or graph slice that exposes retrieval depends on a bounded repair/verification packet grounded in issue #10. Graph is optional per workspace. Level 3 hardening has no blanket authorization; scale work remains conditional on demonstrated load or an owner request.

The runtime/bootstrap lane and platform topology research proceed in parallel with product slices. They do not imply an architecture migration. Production and the temporary test deployment both returned HTTP 200 from their health routes on 2026-10-03. Production reported Postgres, R2, and Google OAuth connected; the test deployment reported Postgres connected with R2 and Google OAuth disabled. The test deployment serves the local Docker Compose runtime through a Quick Tunnel. Gravebuster is online in the Tailscale network, but SSH authentication from this workstation was denied, so host-level deployment state remains unverified.

## Draft packet links

- First packet, pending owner lock: [Workspace capability discovery](slices/01-workspace-capability-discovery.md)
- Later slice outlines: [Productization draft packets](slices/draft-packets.md)

## Frontend bakeoff timing

Use the same Octo jobs, API contract, and representative data when comparing frontend approaches. Do not require a particular framework, component library, design tool, or visual system; the owner may choose any of them. Dyad is available as one prototyping option. Owner taste decides the visual direction.

## Luna work-order template

```text
Owning issue and parent:
Accepted packet revision/link and owner acceptance:
Repository path; base commit; assigned branch/worktree:
One concrete user job:
In-scope change and explicit exclusions:
Canonical authority and API requests/responses:
Existing code/providers to reuse:
Allowed file ownership / coordination boundary:
Public eval commands and required end-to-end user flow:
Named property/holdout checks, or “none”:
Failure/recovery boundary:
Acceptance checklist:
Required return: changed behavior/files, actual checks/outcomes, remaining failures, commit/PR URL and exact head
Delivery: arm auto-merge on every pull request, including a promotion into production
Escalate only for a contradictory packet, unavailable required provider, or missing product decision
```

## Current blockers

- No product packet has owner acceptance yet. Slice 1 is ready for critique and owner correction, not implementation.
- Current `GET /api/capabilities` filters by scope but does not account for workspace binding, live membership role, or provider configuration consistently; dependable client work depends on correcting that contract.
- Recovery needs one owner-selected set of important files and an authority classification before sync behavior can be implemented.
- Production PostgreSQL is a local named container volume; a repository backup/restore path is not present. External host backups have not been checked.
- [PR #75](https://github.com/Pukujan-lab/octo-database/pull/75) merged at `f1e67c4`; its [final `gates` run](https://github.com/Pukujan-lab/octo-database/actions/runs/37081413169) passed after Octo updated the ACS and CGM validation checkouts to match the certified 0.5.12 train. [PR #78](https://github.com/Pukujan-lab/octo-database/pull/78) merged at `11fcb85`; its [`gates` run](https://github.com/Pukujan-lab/octo-database/actions/runs/37081681871) passed with the local database bootstrap and persistent local file volume. [PR #79](https://github.com/Pukujan-lab/octo-database/pull/79) merged at `91b1388`; its [`gates` run](https://github.com/Pukujan-lab/octo-database/actions/runs/37081683468) passed. These PRs complete the current bootstrap and planning-document work, not the product slices.
- [Issue #76](https://github.com/Pukujan-lab/octo-database/issues/76) remains open for the next helper train and depends on upstream ACS OIO hotload support and a published compatible train. It is separate from the current local test deployment, which is running.

Each accepted slice ships with its own end-to-end flow and appropriate deployed smoke. A cross-slice journey can be recorded later as a summary, but is not a new gate for earlier completed slices.
