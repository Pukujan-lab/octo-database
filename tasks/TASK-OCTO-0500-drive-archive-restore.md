# OCTO-0500 R2-to-Google-Drive archive lifecycle and restore

<!-- continuity:task {"acceptance":["Google Drive OAuth 2.0 refresh token authorization against drive.file scope","Cloudflare R2 active storage integration with dedicated octo bucket","3 guest workspaces verified end-to-end archiving active R2 files to Google Drive","Restoration of archived files from Google Drive back to R2 active tier with byte-for-byte fidelity","Cross-workspace storage path isolation across all 3 guest accounts","All gates pass across Python, TypeScript, and JSON contracts"],"depends_on":["OCTO-0200"],"goal":"Connect Google Drive OAuth 2.0 and Cloudflare R2 active storage to provide verified file archival, restore, and cross-workspace isolation across guest and owner workspaces","id":"OCTO-0500","issue_url":"https://github.com/Pukujan-lab/octo-database/issues/7","next_action":"Delivered in PR #39 with green gates.","owner":"Pukujan; main agent coordinates implementation","priority":"P1","protocol_version":"0.1.0-draft","schema":"project-continuity.task.v1","status":"completed","why":"Enable cold archiving of active R2 workspace files into Google Drive (5TB personal storage tier) and byte-perfect restoration per Slice 5 and Issue #7."} -->

- Status: completed
- Priority: P1
- Branch: `task/OCTO-0500-archive-lifecycle`
- GitHub issue: https://github.com/Pukujan-lab/octo-database/issues/7

## Correction

`PR #24` did **not** deliver this slice. It merged verification scripts
(`scripts/authorize_google_drive.py`, `scripts/verify_storage_credentials.py`,
`scripts/verify_live_guest_storage.py`), a `check_json.py` path fix, the CGM hero
banner, and one `src/storage/r2-client.ts` change. The archive lifecycle itself —
`archive_state` on `octo.files`, `archive-service.ts`, `google-drive-provider.ts`,
the `/api/files/*/archive|restore` routes, and their tests — shipped in
`PR #39` (`544f85f`). Earlier checkpoint text below names `PR #24` as the
delivery; that was wrong and is superseded by this note.

## Goal

Connect Google Drive OAuth 2.0 and Cloudflare R2 active storage to provide verified file archival, restore, and cross-workspace isolation across guest and owner workspaces.

## Prepared on this branch

- Google Drive OAuth 2.0 authorization helper `scripts/authorize_google_drive.py` obtaining persistent refresh token with `drive.file` scope
- Storage credential verification suite `scripts/verify_storage_credentials.py` testing live R2 buckets and 5TB personal Google Drive quota
- End-to-end multi-workspace guest storage verification suite `scripts/verify_live_guest_storage.py` running active R2 upload, SHA-256 verification, archival to Google Drive, active R2 deletion, restore from Google Drive to R2 with exact byte match, and cross-workspace isolation
- Cross-platform Windows JSON contract path normalizer in `scripts/check_json.py`
- CGM narrative PNG hero banner `docs/assets/octo-hero-banner.png` registered in `.content-system/asset-manifest.json` and `.content-system/visual-style.json`
- Human-facing `README.md` reflecting complete system architecture, storage tiers, and verification runbooks

## Checkpoint log

### 2026-10-01 02:00:00 UTC — Pukujan

<!-- continuity:checkpoint {"agent":"Pukujan","blocked":[],"changed":["scripts/","docs/assets/","README.md"],"completed":["Google Drive 5TB cold storage archive lifecycle and 3-guest workspace verification"],"decisions":["Use OAuth 2.0 refresh token with drive.file scope and PNG hero banner per CGM"],"evidence":["PR #24 merged with green gates"],"next_action":"Begin Slice 3 gallery","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0500","timestamp":"2026-10-01T02:00:00Z"} -->

Completed:
- Google Drive 5TB cold storage archive lifecycle and 3-guest workspace verification

Evidence:
- PR #24 merged with green gates

Decisions:
- Use OAuth 2.0 refresh token with drive.file scope and PNG hero banner per CGM

Changed:
- scripts/
- docs/assets/
- README.md

Blocked/uncertain:
- none

Next:
- Begin Slice 3 gallery

### 2026-10-01 — correction

<!-- continuity:checkpoint {"agent":"main","blocked":[],"changed":["checkpoints/CURRENT.md","tasks/TASK-OCTO-0500-drive-archive-restore.md"],"completed":["Corrected the Slice 5 delivery record"],"decisions":["Slice 5 was delivered by PR #39, not PR #24"],"evidence":["git log 544f85f Slice 5 — R2-to-Google-Drive archive lifecycle with verified restore (#7) (#39)"],"next_action":"Owner reviews the OCTO-1000 deployment design spec","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OCTO-0500","timestamp":"2026-10-01T08:00:00Z"} -->

Completed:
- Corrected the Slice 5 delivery record: the slice shipped in PR #39 (`544f85f`); PR #24 shipped only scripts, the hero banner, and one `r2-client.ts` change.

Evidence:
- `git log` shows `544f85f Slice 5 — R2-to-Google-Drive archive lifecycle with verified restore (#7) (#39)`.
- `gh pr list --state merged` lists PR #39 with that title; PR #24's title is "Slice 5 — Google Drive Archival & Restore, CGM narrative hero, and PCM checkpoint synchronization".

Decisions:
- Slice 5 was delivered by PR #39, not PR #24

Changed:
- checkpoints/CURRENT.md
- tasks/TASK-OCTO-0500-drive-archive-restore.md

Blocked/uncertain:
- none

Next:
- Owner reviews the OCTO-1000 deployment design spec.
