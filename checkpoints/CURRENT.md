# Current repository checkpoint

<!-- continuity:current {"active_task":"OCTO-1000","active_task_file":"tasks/TASK-OCTO-1000-gravebuster-deployment.md","protocol_version":"0.1.0-draft","schema":"project-continuity.current.v1"} -->

## Current state

- **Live host moved to the Mac** (2026-10-09): `~/apps/octo`, Docker (`octo-web`, `octo-api`, `octo-db` = pgvector/pg16, `octo-graph`, `octo-cloudflared`), Tailscale Serve + Cloudflare ingress at `octodb.design-bakery.com`. gravebuster is OFFLINE. launchd agents: `com.octo.autodeploy` (polls `origin/production`, 5-min tick), `com.octo.backup`.
- **Auto-provision workspace DB at creation (OCTO-1100)**: Merged (`PR #221`) and promoted to `production` (`PR #223`, commit `46a6401`); deployed live on the Mac (`46a6401bdfd8`) and verified: `/health` ok, frontend-v2 served, `autoProvisionWorkspaceDatabase` in the running container.
- **Research docs + ledger (2026-10-11)**: 3 `docs/research` notes pushed (PR #222, commit `8bef6c7`) after redacting host-specific details (tailnet IP, credential paths). Findings recorded into the epistemic ledger (Slice 9) in workspace `chatgpt`: 1 perspective, 1 entity, 3 evidence, 3 claims, 3 beliefs (conf 0.8), 3 claim_evidence links; verified via `claims-as-of` / `belief-as-of`.
- **chatgpt workspace DB**: provisioned (`octo_ws_chatgpt_3b3adbc3`, role `…_rw`), SQL surface verified with the workspace key.
- **design-bakery re-wired onto Octo (2026-10-11, full migration)**: old workspace `e2f12428`/DB `c192afbc` died with gravebuster; the live site's API was returning 500 "octo data layer not configured". Now on new workspace `de8ca5e3-4917-4fac-8fff-5ef160c71c61` (DB `octo_ws_design_bakery_a54f2dd8`, auto-provisioned):
  - Schema applied via the SQL surface: `supabase/migrations/000_octo_bootstrap.sql` + `001`–`010` → 8 public tables.
  - Content re-migrated from Supabase `ukjflpgrfmgwazogrgdv` (service-role key in the Windows checkout) via the repo's `migrate-supabase-to-octo.mjs`: 136 rows (34 blogs / 41 CMS / 31 media / 30 cover; 33 published).
  - **Images fully migrated off Supabase**: 193 distinct images fetched from Supabase, uploaded + published through Octo's files API, and all URL references rewritten to `https://files.design-bakery.com/<fileId>` — `media_assets` + `cover_studio_assets` (`url`, `storage_path` = octo fileId), `blog_posts` (`cover_image_url`, `thumbnail_image_url`, inline `content` refs, and `seo` og/social images). **0 supabase.co references remain** in any content table. Verified live: cover fetch → HTTP 200 image/png, pages `/`, `/blog`, `/blog/24`, `/blog/7` all 200.
  - `design-bakery-api` on the Mac re-created with `OCTO_WORKSPACE_ID` + `OCTO_API_KEY` in `deploy/gravebuster/.env.api` (key `octo_live_ws_9738d023…`, scopes read/write/files/delete; backup `.env.api.bak-20261011T094811Z`). Windows checkout `.env` re-pointed too (backup `.env.bak-20261011`).

- **Helper pins synced to the certified release train (2026-10-11, PR #224, commit `348da81`)**: ACS hot-loader `38f8f52` (pre-mesh, no `stack-mesh.json` enforcement) → ACS 0.2.0 module v0.1.0 @ `3df982a`; PCM 0.6.0 @ `4e23854` → 0.7.0 @ `85e6aa7`; CGM @ `6831f91` → 0.5.12 @ `5c8c5f1`; OIO 0.1.0 @ `402a46e` recorded in `.coord/assignment.json` pins + AGENTS.md/HANDOFF.md. `gates.yml` now validates with the new hotloader, which enforces the mesh. `stack-manifest.json` keeps empty pins (follows the train). This required ACS PR #89 first (merged `3df982a` — its runs were parked at `action_required` and its example assignment template had gone stale against the moved mesh; both fixed before merge). Verified locally: train `check_manifest` OK, PCM `continuity validate` VALID, CGM validator VALID, `hotload_check` exit 0. Not promoted to `production` — pins affect CI only, not the running app.

- **Platform-audit research note (2026-10-13)**: `docs/research/2026-10-13-platform-audit-observability-oio-and-placement.md` — no read-path logging, evidence pointer-only, two-tier tree, backup posture (#202), OIO full install (PR #230), dev/app layer split, a2a storage-class rule (ACS #91), consumer-capability answers.

## Owner corrections & anti-overengineering

- Anti-overengineering rules active in AGENTS.md: zero unsolicited security layers or speculative abstractions.
- All gates passing locally and on GitHub Actions CI: Python unittests, Vitest tests, `tsc --noEmit`, Ruff, Mypy, and 18 JSON contracts.
- Auto-merge: repository auto-merge is enabled. `main` and `production` each require only the aggregate `gates` check, no review approval is required, and "require branches to be up to date" is OFF so a PR merges as soon as `gates` is green without anyone rebasing it. `.github/workflows/auto-merge.yml` arms squash auto-merge on every same-repo pull request into `main` or `production`. Do not leave auto-merge off and do not ask the owner to merge.

## Next action

- design-bakery residual: `agent_tokens` table is empty (Supabase never exposed it to the anon/service read; 0 tokens migrated) — re-seed agent tokens if agent publishing is needed. `publish_kit_hero_cache` was not exposed in Supabase either and starts empty. The old orphaned R2 objects under `workspaces/e2f12428…/` and the `octo-public` mirror can be deleted whenever the owner wants the bucket cleaned.

