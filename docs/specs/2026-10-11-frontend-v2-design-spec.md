# Task: Octo workspace portal (frontend v2)

Build a single-page application that is the control dashboard for **Octo**, a self-hosted
workspace data platform. It signs a human in, lets them pick one of their workspaces, and
gives them five views of that workspace — Overview, Files, Gallery, Operations, and Access —
plus a standalone read-only public share viewer.

This app is a **pure client of Octo's existing HTTP API**. It runs same-origin with the API
server, which already exists and is not changed by this task. Every piece of data it shows
and every action it performs goes through a real route documented below. Do not invent
routes, do not mock data, do not stand up a second backend. If a value is not in the API
inventory, it is not in the app.

The generated starter is a placeholder; a complete five-view portal replaces it.

---

## 1. Login

The app has two states: signed out (login screen) and signed in (the workspace shell).
On load, if a saved token exists and has not expired, go straight to the shell; otherwise
render the login screen.

**Login screen must contain:**

- The product name **Octo**, a one-line description, and a "workspace data platform" eyebrow.
- A **Continue as Guest** button that calls `POST /api/auth/guest` and enters the session.
- A **Sign in with Google** button that navigates the browser to `GET /api/auth/google`.
  Read `GET /health` on load: if `googleAuthEnabled` is false, render the button disabled
  with a "not configured" label instead of a working link.
- A **Cloudflare Turnstile** widget, mounted only when `GET /health` returns a non-empty
  `turnstileSiteKey`. Load `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
  and render explicitly into a container. If a site key is advertised, the guest button must
  refuse to submit until the widget has produced a token, and must send that token as
  `turnstileToken` in the guest request body. Turnstile tokens are single-use and expire in
  about five minutes, so discard and re-request on every login-screen draw.
- A visible notice area for session-expiry and login errors (e.g. "Your session expired.
  Please sign in again.").

**Google callback:** after the Google round trip the server redirects the browser back to the
app at `/#token=<sessionToken>`, or `/#auth_error=<code>` on failure. On load, read the URL
hash: if `token` is present, consume it as the session token, then immediately strip the hash
from the URL with `history.replaceState`. If `auth_error` is present, clear it and show a
login error. Do not leave the token in the address bar.

**OAuth connector return:** a connector may bounce the browser to
`/#oauth_return=<authorize-url>`. Stash that value in `localStorage` (a Google sign-in is a
full-page round trip that would drop a hash), strip the hash, and once a session exists
resume it: `POST /oauth/dance` with the bearer token (this hands the authorization server the
same session as a short-lived HttpOnly cookie), then `location.replace(<authorize-url>)`.
Only ever resume a URL whose origin matches the app's own origin and whose path is
`/oauth/authorize`; anything else is discarded.

---

## 2. Session and auth requirements

These rules apply to every authenticated view.

- **Token storage.** The session token is a bearer token stored in `localStorage` under the
  key `octo_token`. The cached principal (for a fast first paint) is stored under
  `octo_principal` as JSON. Both are removed on sign-out and on expiry.
- **Sending the token.** Every request to `/api/...` sends
  `Authorization: Bearer <octo_token>`. JSON request bodies also send
  `Content-Type: application/json`.
- **Identity.** After entering a session, call `GET /api/me` and hold the returned principal
  (`id`, `email`, `displayName`, `isGuest`, `isPlatformOwner`) plus `confirmSecretSet`,
  `mfaEnabled`, and `mfaRecoveryCodesRemaining`.
- **401 handling.** Any response of 401 to an authenticated `/api/...` call (other than the
  auth routes themselves) ends the session: clear storage, show the expiry notice, and return
  to the login screen.
- **20-minute expiry.** The server issues a token with a 20-minute lifetime and enforces a
  20-minute idle timeout. The client mirrors both: parse the token's expiry, and treat 20
  minutes without real user interaction (click, keydown, pointerdown, scroll, touchstart) as
  an expired session. Check on an interval (about every 30 seconds) and also on any 401.
- **Confirm-code gate.** Destructive or credential-creating calls require a short-lived
  confirmation code that a human types. The flow:
  1. Call `POST /api/me/confirm-challenge` and display the returned `code` on the form.
  2. The human types it into a `secret` field.
  3. Send it as `confirmSecret` on the destructive call.
  Calls that require `confirmSecret`: create workspace, delete workspace, mint API key, edit
  key allowances, set/rotate the confirmation secret. If the account has never set a
  confirmation secret, the server answers `412` with code `CONFIRM_SECRET_NOT_SET`; handle
  that by directing the human to set one via `POST /api/me/confirm-secret` (minimum 8
  characters) rather than showing a raw error.
- **MFA step-up.** When `mfaEnabled` is true, the same destructive forms additionally require
  a `mfaCode` field (a 6-digit authenticator code, or a one-time recovery code).
- **Human-session-only routes.** `POST /api/me/confirm-challenge`, `POST /api/me/confirm-secret`,
  and the whole `/api/me/mfa/*` family answer `403` to an API-key caller and work only with the
  human session token. This portal always calls them with the human session, so it never sees
  that error — but do not attempt to reach them with an agent key.
- **One-time secrets.** A minted API key's `rawSecret` and a newly created share's URL are
  shown **exactly once**. Hold them in memory only for the current render, never write them to
  `localStorage`, and clear them on dismiss, on sign-out, and on any session end. Never
  re-fetch or re-display a secret after it is dismissed.

---

## 3. Workspace shell

Signed in, the app shows a persistent shell around the active view:

- A **workspace picker** (`<select>`) listing every workspace from `GET /api/workspaces`
  (`{id, slug, name, description, role, isOwner, retentionDays}`). Selecting one makes it
  active and reloads all workspace-scoped data. The first workspace is active on entry.
- Navigation for the five views: **Overview**, **Files**, **Gallery**, **Operations**,
  **Access**. Exactly one is active; switching does not re-fetch the workspace list.
- The active workspace's name as the page heading, its role as a chip, and a guest suffix
  when the principal is a guest.
- The signed-in principal's display name and a sign-out control.
- A **+ New Workspace** control that opens the create-workspace form (see §7).
- A **design-system picker** (a dropdown) plus a **light/dark toggle**. See §13. The choice
  persists in `localStorage` and applies to every screen, including login and the public
  share viewer.
- A non-blocking **notice/toast** area for confirmations and errors.

When a workspace is selected, load its data with a single parallel batch of requests, all
scoped by `?workspaceId=<id>`:

- `GET /api/files`
- `GET /api/gallery`
- `GET /api/jobs`
- `GET /api/activity`
- `GET /api/workspaces/shares`
- `GET /api/keys`
- `GET /api/ops/summary`

A failed request and an empty workspace must not look alike: if any of these fails, surface
which sections failed ("Could not load files, jobs … for this workspace") instead of silently
rendering an empty workspace.

---

## 4. Overview

The default view. It summarises the active workspace and links into the others.

- A welcome panel: workspace role, guest marker if applicable, the workspace description (or
  a sensible fallback line), and two actions — **Upload files** and **New text file**.
- Four metric tiles:
  - **Recorded storage** — sum of `sizeBytes` across the workspace's files, human-formatted.
  - **Files** — count of files.
  - **Media** — count of gallery items.
  - **Failed jobs** — count of jobs whose `state` is `failed` (highlighted when non-zero).
- A **File Catalog** panel showing the five most recent files (name, MIME type, size, status,
  added date) with a "View all files" link to the Files view.
- A **Gallery** panel showing up to three media thumbnails with a "Browse" link.
- A **Recent activity** panel showing the latest activity entries with an "Operations" link.

---

## 5. Files

Manage the workspace's files.

- A table of `GET /api/files` rows (`{id, name, sizeBytes, mimeType, storageKey, createdAt,
  archiveState, publishedAt, publishedUrl}`): name (with MIME type), size, status derived from
  `archiveState` (`archived_drive` → "Archived", `archiving`/`restoring` → "Transitioning",
  otherwise "Ready"), added date, and per-row actions.
- Per-row actions:
  - **Download** — `GET /api/files/content?workspaceId=&fileId=` returns raw bytes; save them
    via an object URL with the file's name as the download filename.
  - **Archive** / **Restore** — `POST /api/files/:id/archive` or `.../restore` (202, returns
    `{job, created}`); reload the workspace afterwards.
  - **Remove** — `DELETE /api/files/:id?workspaceId=`; confirm first, then reload.
- **Upload files** — a hidden multi-select file input. For each chosen file, read it as bytes,
  base64-encode, and `POST /api/files/upload` with
  `{workspaceId, name, mimeType, data, dataEncoding: 'base64'}`, then reload.
- **New text file** — a form that uploads a text document with
  `{workspaceId, name, mimeType: 'text/plain', data, dataEncoding: 'utf8'}`.
- Empty state when the workspace has no files.

---

## 6. Gallery

A visual view of the workspace's media.

- Read `GET /api/gallery` (`{id, name, mimeType, sizeBytes, kind: 'image'|'video',
  thumbnailUrl, fullUrl, createdAt}`) and render a responsive grid of thumbnail cards.
- Clicking a card opens a preview: the `fullUrl` in an `<img>` for `kind: 'image'`, or a
  `<video controls>` for `kind: 'video'`, with the item name, and a close control.
- An **Add media** action reuses the file-upload path.
- Empty state when there is no media.

---

## 7. Operations

Review processing work for the workspace and retry what failed.

- Three metric tiles: **Queued** (jobs with `state === 'queued'`), **Failed**
  (`state === 'failed'`, highlighted when non-zero), and **Recent jobs** (total).
- A **jobs table** from `GET /api/jobs` (`{id, jobType, state, attempts, maxAttempts,
  errorSummary, createdAt, completedAt}`): job type (with `errorSummary` as a detail line),
  a state pill, `attempts / maxAttempts`, created time, and a **Retry** action on failed jobs
  (`POST /api/jobs/:id/retry?workspaceId=`).
- A **Run worker pass** action: `POST /api/jobs/run?workspaceId=`.
- A **failure analysis** panel from `GET /api/ops/summary`
  (`{failureCounts, failuresByJobTypeDay, unhealthyJobs}`):
  - **By error code** — `failureCounts` rows: `errorCode` (or "Unclassified"), `severity`,
    `source`, `eventCount`, `lastSeen`.
  - **By job type and day** — `failuresByJobTypeDay` rows: `day`, `jobType`, `errorCode`,
    `eventCount`.
  - **Jobs needing attention** — `unhealthyJobs` rows: `jobType`, `state`, `attempt` /
    `maxAttempts`, `updatedAt`, `errorCode`, and a **Retry** action for failed rows.
  - A distinct empty state for each sub-table, and one for the whole panel when no summary is
    available.
- A **Recent activity** list from `GET /api/activity`
  (`{id, eventType, summary, jobId, createdAt}`).

---

## 8. Access

Credentials, shares, two-factor, and workspace settings. This view needs the confirmation code
(§2) available, so request one when the view is opened.

### 8.1 API keys

- List `GET /api/keys?workspaceId=` (`{id, prefix, name, workspaceId, workspaceName, scopes,
  expiresAt, lastUsedAt, createdAt, isAccountWide}`). The list is scoped to the active
  workspace plus account-wide keys; keys belonging to other workspaces are not shown.
- Each row shows name, the key prefix (`<prefix>…`), which workspace it belongs to
  ("Account-wide" when `isAccountWide`, otherwise `workspaceName`), created, last used, and
  its current allowances.
- **Allowances** are an inline editable set of checkboxes over `read`, `write`, `files`,
  `delete`. Saving calls `PATCH /api/keys/:id` with `{scopes, confirmSecret, mfaCode?}`. Put
  the allowance editor behind a collapsed control that summarises the current allowances so
  the table stays readable.
- A **Revoke key** action per row: `DELETE /api/keys/:id`, behind a per-row actions menu so a
  destructive verb is not a bare button in the row.
- **Mint a key** — a form with a name, a scope (this workspace / account-wide), an optional
  expiry (never / 30 / 90 / 365 days), and the allowance checkboxes. Submits `POST /api/keys`
  with `{name, workspaceId (null for account-wide), scopes, expiresInDays?, confirmSecret,
  mfaCode?}`. On success the response's `rawSecret` is shown once (§2) and the list reloads.
  A `409 ACCOUNT_KEY_EXISTS` means an account-wide key already exists.
- **Filter and view toggle.** Provide a text filter over the key list and a table/cards view
  toggle. Filtering is client-side over the already-loaded list. Filtering to nothing shows a
  distinct "no matches" state, separate from "no keys yet".

### 8.2 Share links

- List `GET /api/workspaces/shares?workspaceId=` (`{id, workspaceId, resourceType,
  resourceId, tokenPrefix, permission, validFrom, validUntil, revokedAt, createdAt,
  lastAccessedAt, accessCount}`). A share is active when `revokedAt` is null and `validUntil`
  is null or in the future.
- Each row shows its state (active / revoked), expiry, permission, created date, and visit
  count.
- **Create link** — choose an expiry (no expiry / 1h / 24h / 7d / 30d) and `POST
  /api/workspaces/shares` with `{workspaceId, resourceType: 'gallery', permission: 'read',
  expiresInHours?}`. The response's `rawToken` forms the share URL `<origin>/share/<rawToken>`;
  show it once (§2).
- **Revoke** — `DELETE /api/shares/:id?workspaceId=`.
- Same filter + table/cards toggle treatment as keys.

### 8.3 Two-factor authentication

- When `mfaEnabled` is false: a **Set up two-factor authentication** action calls
  `POST /api/me/mfa/begin` → `{secret, otpauthUri}`, shows the secret (and the `otpauthUri`
  for manual entry), and a form for the 6-digit code. Confirming calls
  `POST /api/me/mfa/confirm` with `{code}` → `{recoveryCodes}`; show the recovery codes once
  and mark MFA enabled.
- When enabled: show how many recovery codes remain (from `GET /api/me` or `GET /api/me/mfa`),
  a **Rotate recovery codes** action (`POST /api/me/mfa/recovery-codes` with `{code}` →
  `{recoveryCodes}`), and a **Disable two-factor** action (`POST /api/me/mfa/disable` with
  `{code}`).

### 8.4 Workspace settings

- Show the active workspace's name, description, role, slug, file-retention setting, and
  current confirmation/MFA status.
- A **Delete Workspace** action opens a form that requires typing the workspace slug and the
  confirmation code (and an MFA code when enabled), then calls `DELETE /api/workspaces/:id`
  with `{confirmSecret, confirmSlug, mfaCode?}` → `{success, workspaceId, slug,
  orphanedObjects, orphanedDatabase, orphanedGraph}`. Afterwards select the next remaining
  workspace, or the login/empty state if none remain.

---

## 9. Public share viewer

`GET /api/public/shares/:token` powers a **standalone, read-only** page served at the route
`/share/<token>`. This page renders outside the authenticated shell — no sidebar, no token, no
`Authorization` header, no workspace data — and is reachable by anyone holding the link.

- Parse the token from the path (`/share/<token>`, URL-decoded; the token may itself contain
  slashes).
- `GET /api/public/shares/:token` → `{share: {id, resourceType, permission, validUntil},
  items: [{id, name, mimeType, sizeBytes, kind, thumbnailUrl, fullUrl, createdAt}]}`.
- Render the items as a gallery grid (same card treatment as §6), the permission, and the
  expiry (or "No expiry (revocable)").
- On `404 SHARE_NOT_FOUND_OR_INACTIVE` (or any failure), show a "this link is not available"
  empty state rather than an error.
- The saved theme applies here too.

---

## 10. API inventory (the only routes this app may call)

All paths are same-origin. `?workspaceId=` marks routes that take a workspace scope.

| Method | Path | Request | Success response | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/health` | — | `{status, version, database, r2, googleAuthEnabled, turnstileSiteKey}` | — |
| GET | `/api/me` | bearer | `{principal, apiKey, confirmSecretSet, mfaEnabled, mfaRecoveryCodesRemaining}` | 401 |
| POST | `/api/auth/guest` | `{displayName?, turnstileToken?}` | 201 `{principal, workspace, sessionToken}` | 403 `TURNSTILE_FAILED` |
| GET | `/api/auth/google` | — | 302 to Google (callback 302 to `/#token=…` or `/#auth_error=…`) | 501 `GOOGLE_AUTH_NOT_CONFIGURED` |
| POST | `/api/me/confirm-secret` | `{secret, currentSecret?}` (≥8 chars) | `{success, rotated}` | 400 on short secret |
| POST | `/api/me/confirm-challenge` | bearer | `{code}` | — |
| GET | `/api/me/mfa` | bearer | `{enabled, confirmedAt, recoveryCodesRemaining}` | — |
| POST | `/api/me/mfa/begin` | bearer | `{secret, otpauthUri}` | — |
| POST | `/api/me/mfa/confirm` | `{code}` | `{recoveryCodes}` | — |
| POST | `/api/me/mfa/disable` | `{code}` | `{disabled: true}` | — |
| POST | `/api/me/mfa/recovery-codes` | `{code}` | `{recoveryCodes}` | — |
| GET | `/api/workspaces` | bearer | `[{id, slug, name, description, role, isOwner, retentionDays}]` | — |
| POST | `/api/workspaces` | `{name, slug?, description?, retentionDays?, confirmSecret, mfaCode?}` | 201 `{workspace, apiKey, rawSecret}` | 409 `SLUG_TAKEN`, 429 `WORKSPACE_DAILY_LIMIT`, 412 `CONFIRM_SECRET_NOT_SET` |
| DELETE | `/api/workspaces/:id` | `{confirmSecret, confirmSlug, mfaCode?}` | `{success, workspaceId, slug, orphanedObjects, orphanedDatabase, orphanedGraph}` | 412 `CONFIRM_SECRET_NOT_SET` |
| POST | `/api/workspaces/:id/database` | bearer | 201 `{database, connectionString}` | — |
| GET | `/api/files?workspaceId=` | bearer | `[{id, name, sizeBytes, mimeType, storageKey, createdAt, archiveState, publishedAt, publishedUrl}]` | — |
| POST | `/api/files/upload` | `{workspaceId, name, mimeType, data, dataEncoding}` | 201 file record | 400 on bad encoding |
| GET | `/api/files/download?fileId=&workspaceId=` | bearer | `{file, downloadUrl}` | — |
| GET | `/api/files/content?workspaceId=&fileId=` | bearer (or signed `t`/`e`/`s`) | raw bytes | — |
| GET | `/api/files/thumbnail?…` | bearer | WebP bytes (or 302 to content) | — |
| POST | `/api/files/:id/publish?workspaceId=` | bearer | `{fileId, url, publishedAt, republished}` | — |
| POST | `/api/files/:id/unpublish?workspaceId=` | bearer | `{fileId, published: false}` | — |
| DELETE | `/api/files/:id?workspaceId=` | bearer | `{success, fileId}` | — |
| POST | `/api/files/:id/archive?workspaceId=` | bearer | 202 `{job, created}` | — |
| POST | `/api/files/:id/restore?workspaceId=` | bearer | 202 `{job, created}` | — |
| GET | `/api/gallery?workspaceId=` | bearer | `[{id, name, mimeType, sizeBytes, kind, thumbnailUrl, fullUrl, createdAt}]` | — |
| GET | `/api/keys?workspaceId=` | bearer | `[{id, prefix, name, workspaceId, workspaceName, scopes, expiresAt, lastUsedAt, createdAt, isAccountWide}]` | — |
| POST | `/api/keys` | `{name, workspaceId?, scopes?, keyClass?, expiresInDays?, confirmSecret, mfaCode?}` | 201 `{apiKey, rawSecret}` | 409 `ACCOUNT_KEY_EXISTS`, 412 `CONFIRM_SECRET_NOT_SET` |
| PATCH | `/api/keys/:id` | `{scopes, confirmSecret, mfaCode?}` | updated key | 412 `CONFIRM_SECRET_NOT_SET` |
| DELETE | `/api/keys/:id` | bearer (needs `delete` scope) | `{success, keyId}` | 403 |
| POST | `/api/workspaces/shares` | `{workspaceId, resourceType: 'gallery', permission: 'read'\|'upload', expiresInHours?, validUntil?}` | 201 `{share, shareUrl, rawToken}` (`shareUrl` is the relative path `/share/<rawToken>`) | — |
| GET | `/api/workspaces/shares?workspaceId=` | bearer | `[DbShareRow]` | — |
| DELETE | `/api/shares/:id?workspaceId=` | bearer | `{success, shareId}` | — |
| GET | `/api/public/shares/:token` | none | `{share, items}` | 404 `SHARE_NOT_FOUND_OR_INACTIVE` |
| GET | `/public/files/:fileId` | none | raw bytes | 404 |
| GET | `/api/capabilities?workspaceId=` | bearer | `{contractVersion, discoveryMode, workspace, principal, token, auth, capabilities, unavailable}` | — |
| POST | `/api/jobs` | `{workspaceId, jobType, idempotencyKey, payload}` | 201 when created, else 200 — `{job, created}` | 400 `JOB_TYPE_RESERVED` (use the file archive/restore routes) |
| GET | `/api/jobs?workspaceId=` | bearer | `[DbJobRow]` | — |
| POST | `/api/jobs/:id/retry?workspaceId=` | bearer | `{success, jobId}` | — |
| POST | `/api/jobs/run?workspaceId=` | bearer | `{outcomes}` | — |
| GET | `/api/activity?workspaceId=` | bearer | `[{id, eventType, summary, jobId, createdAt}]` | — |
| GET | `/api/ops/events?workspaceId=&errorCode=` | bearer | `{events}` | — |
| GET | `/api/ops/summary?workspaceId=` | bearer | `{failureCounts, failuresByJobTypeDay, unhealthyJobs}` | — |

**Out of scope — do not call:** `/api/rag/*`, `/api/epistemic/*`, `/api/graph/*`, and
`/api/workspaces/:id/query`. These exist on the server but are not part of this portal.

---

## 11. Requirements

- React + Vite + Tailwind + shadcn (the starter stack). Fetch with `@tanstack/react-query`;
  show loading and error states rather than blank panels.
- **Build the visual system from scratch** (§13). Do not reuse or port any stylesheet from an
  earlier version of this app; the previous look is not a template to preserve.
- Responsive: usable at 375px and comfortable at 1440px.
- The five views plus the public share viewer must all be reachable and functional; no view
  may be a stub.
- All destructive or credential-creating actions go through the confirm-code gate (§2). The
  confirmation code, the minted key secret, and the new share URL are each shown once and
  never persisted.
- Never write a token, a raw secret, or a share URL to `localStorage` except the session
  token (`octo_token`) and the cached principal (`octo_principal`).

---

## 12. Test hooks (required)

Add these attributes so the build can be verified automatically. Do not remove or rename them.

- Login screen container: `data-testid="login-screen"`
- Guest login button: `data-testid="login-guest"`
- Google login button: `data-testid="login-google"`
- Workspace picker (`<select>`): `data-testid="workspace-picker"`
- Sidebar / top-level nav: `data-testid="app-nav"`
- Overview view container: `data-testid="view-overview"`
- Files view container: `data-testid="view-files"`
- Gallery view container: `data-testid="view-gallery"`
- Operations view container: `data-testid="view-operations"`
- Access view container: `data-testid="view-access"`
- File upload input: `data-testid="file-upload"`
- Gallery grid container: `data-testid="gallery-grid"`
- Key-mint form: `data-testid="key-mint-form"`
- Confirmation-code field (any form using the gate): `data-testid="confirm-code"`
- One-time secret display (minted key or share URL): `data-testid="one-time-secret"`
- Share-create control: `data-testid="share-create"`
- Public share viewer container: `data-testid="public-share-viewer"`

- Design-system picker (dropdown): `data-testid="design-system-picker"`
- Light/dark toggle: `data-testid="theme-toggle"`
- Overview activity chart container: `data-testid="overview-chart"`

---

## 13. Visual system (this is the point of this rebuild)

The previous version of this app looked like an earlier hand-written dashboard. This build
replaces it with a **new visual system designed from scratch**, and that system is the
deliverable. Treat everything below as required, not aspirational.

### 13.1 Aesthetic

- **Target: a first-class product UI at the level of Supabase's dashboard, or better** — precise
  type, real hierarchy, generous but disciplined spacing, dense-but-legible data tables, subtle
  borders, restrained chrome. Professional and technical, not playful or gamified.
- **Richer than Supabase, not just equal.** Add a graphics layer: gradient-filled charts,
  stat tiles with sparklines and trend deltas, illustrated empty states, and decorative
  background motifs (a subtle grid, a soft radial glow, an orb/ring composition). The graphics
  should read as one coherent system, re-themed by the active design system.
- Dark is the default. Both dark and light must be fully designed — not a mechanical inversion.

### 13.2 Named design systems, each with dark and light

The dropdown selects a **named design system**. Each system defines a complete palette, and each
has its own **dark** and **light** variant. Ship at least these six:

| System | Character |
| --- | --- |
| **Midnight** (default) | Near-black surfaces, a vivid lime accent — Octo's own identity |
| **Supabase** | `#1c1c1c`-family dark surfaces, emerald-green accent — the reference product |
| **Emerald** | Cool dark neutrals with a deep green accent |
| **Violet** | Cool dark neutrals with a violet accent |
| **Amber** | Warm dark neutrals with an amber accent |
| **Paper** | A warm, light-first system (its dark variant is still designed) |

### 13.3 How theming must work (non-negotiable)

- **Every color is a CSS custom property. No hardcoded colors in components.** No `#rrggbb`,
  no `rgb(...)`, no Tailwind palette literals like `bg-gray-800` or `text-blue-500` in
  component or page code. Components consume semantic tokens (`bg-background`,
  `text-muted-foreground`, `border-border`, `bg-card`, `text-primary`, plus chart and
  status tokens). This is what makes the dropdown actually work — a hardcoded hex cannot be
  re-themed.
- Define the token layer in `src/globals.css` using shadcn's HSL-triplet convention
  (`--background: 222 47% 4%;`) so `tailwind.config.ts`'s `hsl(var(--x))` mapping keeps working.
  Define the full shadcn set (`--background`, `--foreground`, `--card`, `--card-foreground`,
  `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`,
  `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`,
  `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`, `--radius`,
  the `--sidebar-*` group) **plus** `--chart-1` … `--chart-5` for chart series and semantic
  `--success` / `--warning` / `--info` (with foregrounds).
- Compose the two axes on the document element: a `data-design="<system>"` attribute selects the
  system and the `.dark` class selects the variant, e.g. `[data-design="supabase"].dark { … }`
  and `[data-design="supabase"]:not(.dark) { … }`. Every system × variant pair must define the
  full token set; never let a token fall through to an undefined value.
- The picker writes both attributes and persists the choice in `localStorage` (a design key and
  a theme key). Default on first load: **Midnight, dark**.
- The shadcn primitives under `src/components/ui/` are themed **through these tokens only** —
  do not hand-edit them to carry color; if a primitive needs a different look, restyle via the
  tokens or wrap it.

### 13.4 Graphics and charts

- Charts use **recharts** (already installed) and are driven by the active tokens
  (`--chart-1` … `--chart-5`), so they re-color with the design system.
- On **Overview**, one chart: **workspace activity over time** — files added per day (and, if
  useful, jobs per day) as a gradient-filled area or rounded-bar chart, with a legend, readable
  axes, and a tooltip. Derive the series client-side from the file/job/activity timestamps
  already returned by the API. Handle the empty case with a real empty state, never a broken
  chart.
- Metric tiles (Overview) gain a sparkline and a trend delta where the data supports it.
- Empty states across all views are illustrated (a small inline SVG motif themed by tokens),
  not a bare line of grey text.

### 13.5 Preserve

- All functional behavior in §1–§10 is unchanged — same routes, same auth, same confirm-code
  gate, same five views and public share viewer.
- The app remains a **pure client of the same-origin API**. No server change, no new endpoint.
- Accessibility: visible keyboard focus, WCAG AA body contrast in **every** system and variant.
