# Octo — Product Design Document

**Status:** draft, derived from accepted issues
**Authority:** issue #1 (program) and the live issues it names. This document is a
navigation aid; it creates no scope and no gates (per issue #18).
**Last synced:** 2026-10-01 — reflects issue #61 research and the approved design
in `docs/superpowers/specs/2026-10-01-octo-workspace-data-plane-design.md`.

## 1. What Octo is

A self-hosted control plane that gives people and scoped agents one login, one
workspace boundary, one file/data API, and one operational surface across
personal, family, work, research, and project-specific applications.

Octo is **not** a general cloud or a distributed database. It is one deployable
unit: a server, a Postgres database, an R2 bucket, and (optionally) a Drive
archive folder.

## 2. Core concepts

| Concept | What it is | Canonical store |
|---|---|---|
| **Principal** | A human, guest, or machine identity | `octo.principals` |
| **Workspace** | The one tenancy boundary — **and the unit a "database" maps to** | `octo.workspaces` |
| **Membership** | A principal's role in a workspace (`owner`/`admin`/`operator`/`member`) | `octo.workspace_memberships` |
| **File** | A logical object; bytes live in R2, metadata in Postgres | `octo.files` |
| **API key** | A machine credential, account-wide or workspace-scoped | `octo.api_keys` |
| **Share** | A scoped, revocable read-only link | `octo.shares` |
| **Job / Activity** | Background work and its audit trail | `octo.jobs`, `octo.activity` |

### The workspace = database model

There is no separate "database" entity. **One workspace is one logical
database.** An application that needs several databases gets several
workspaces. This matches the issue #1 invariant: *every durable user-owned
resource carries a workspace boundary.*

## 3. The user path

```
Google login / guest
  → create or select a workspace (a database)
  → upload a file            (bytes → R2, metadata → Postgres)
  → view it in the gallery
  → share it with a scoped link (revocable)
  → archive it to Google Drive (manual, or after retention_days)
  → read it again            (restored from Drive on demand)
  → inspect job / activity evidence
  → delete the workspace     (human confirmation required)
```

## 4. Storage model

Three stores, one routing rule:

- **PostgreSQL** — canonical control state (identity, membership, file metadata,
  archive lifecycle state, keys, shares, jobs).
- **Cloudflare R2** — the **only active byte tier**. Every upload lands here.
- **Google Drive** — the **cold archive tier**. Bytes move here only via the
  archive lifecycle.

**Routing is not automatic.** There is no hot/warm/cold classifier and no
size/MIME rule. A file is in R2 until it is archived; that is the entire model.
The single policy knob is `workspaces.retention_days`: `NULL` means never
auto-archive; a number means files older than that window are archived by the
scheduler.

### Archive lifecycle

A controlled state machine on `octo.files.archive_state`:

```
active_r2 ──archive──▶ archiving ──▶ archived_drive
    ▲                                      │
    └──────── restore ◀── restoring ◀──────┘
                    (any failure ─▶ reconciliation_required)
```

- **Manual:** a human presses Archive / Restore (operator+ role).
- **Automatic:** an hourly sweep enqueues `archive_file` jobs for aged files,
  then drains the queue. No cron, no distributed lock — the server is one
  process.
- **On-demand recall:** reading an archived file restores Drive→R2 transparently
  and then streams from R2. Callers never touch Drive directly.
- Copy→verify(hash)→persist→delete ordering; the cold copy is retained on
  restore.

## 5. Identity, keys, and scopes

### Two key types

- **Account-wide** (`octo_live_acc_`) — one or more per principal (one per place
  that uses it); reaches
  every workspace the principal is a member of; carries `role NULL` so authority
  is derived from live memberships, never asserted by the key.
- **Workspace-scoped** (`octo_live_ws_`) — exactly **one per workspace**,
  auto-provisioned when the workspace is created; pinned to that workspace; its
  role is capped at the creator's role.

Both are SHA-256 hashed; the raw secret is shown exactly once.

### Scopes, key classes, and presets

Scopes: `read`, `write`, `files`, `delete`.

A **key class** is a documented authority profile a key can be minted under; the
class expands to a scope list. Minting accepts an optional `keyClass` in place of
an explicit `scopes` list.

| Class | Scopes | Reach |
|---|---|---|
| `analytics` | `read` | Workspace/job/activity/share metadata and RAG retrieval. No file or gallery bytes, no mutations. |
| `agent-read` | `read, files` | Analytics plus file, gallery, and media reads. No writes or destructive actions. |
| `program-write` | `read, write, files` | Agent-read plus upload, restore, jobs, ingestion, and share creation. No delete, archive, or revocation. |

The dashboard's named presets remain:

| Preset | Scopes |
|---|---|
| Read-only | `read, files` |
| Read-write | `read, write, files` |
| Ingest | `write, files` |
| Full | `read, write, files, delete` |
| Custom | explicit list |

Scopes are enforced server-side on every route — the capability description is
documentation, never the enforcement. Cross-tenant workspace deletion is not a
scope: it is platform-owner authority requiring a human session, the confirmation
secret, a matching workspace slug, and a valid MFA code when MFA is enrolled, so
no API key can perform it.

### How an app or agent uses a key

```
curl -H "Authorization: Bearer octo_live_ws_..." \
     "$OCTO/api/files?workspaceId=$WS"
```

`GET /api/capabilities` advertises the callable actions and their required
scope. The dashboard shows the same, with a copyable example.

## 6. Protection

Two independent layers, both required for destructive operations:

1. **Role + scope** — the caller's workspace role and the key's scopes.
2. **Human confirmation** — a per-account confirmation secret, checked only for
   human sessions. An API-key caller can **never** satisfy it, whatever its
   scopes. This is what makes "a blind agent cannot delete a workspace" a
   structural fact rather than a policy.

Workspace delete additionally requires typing the workspace slug, and refuses
while any file is mid-archive.

## 7. Explicit non-goals

- A Postgres/memory hot tier (R2 is the only active tier).
- Per-database sub-entities inside a workspace.
- Automatic byte reclamation for orphaned objects on workspace delete.
- Any retention rule beyond a single age threshold.
- A separate admin console (Supabase/provider surfaces are used for deep
  infrastructure administration).

## 8. Verification

Every slice ships with: happy-path integration proof, authorization-negative
proof, and — where side effects exist — restart/idempotency proof. The
cross-cutting relations that must hold for *any* input are enumerated in the
metamorphic test strategy in the design spec, and the user-visible path is
additionally checked with Playwright and the vision audit in CI.

Evidence (merged SHAs, green `gates`, browser trace, negative-test results) is
linked on the owning issue before it closes. No slice closes on screenshots
alone.
