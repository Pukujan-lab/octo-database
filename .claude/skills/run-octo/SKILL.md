---
name: run-octo
description: Run, start, drive, screenshot, and smoke-test the Octo app (Vite web UI + Node API server + local Postgres). Use when asked to launch Octo, take a screenshot of the dashboard, click through the login/files/access views, or verify a UI change in the real app.
---

# Run Octo

Octo is a self-hosted workspace control plane: a **Vite** frontend (`src/main.ts`,
port **3000**) talking to a **Node/tsx** API server (`src/server/index.ts`, port
**3001**) backed by a local **PostgreSQL 17** cluster (port **54329**).

All paths below are relative to the repo root (`D:\development\octo-db`).

The agent path is `.claude/skills/run-octo/driver.mjs` — a Playwright REPL that
drives the real app headless: navigate, click, type, screenshot, read the DOM.
No `chromium-cli` is installed here; this driver uses the repo's own Playwright.

## Prerequisites

Node ≥ 22 (verified on v24) and the Playwright Chromium browser (already present
in this environment under `~/AppData/Local/ms-playwright`). If missing:

```bash
npm install
npx playwright install chromium
```

## Build / start the stack

Three processes. Start them in this order.

**1. Local Postgres (port 54329).** A dev cluster lives at
`C:/Users/pujan/AppData/Local/Temp/octo-pg` (trust auth, `postgres` superuser).
Start it:

```bash
"/c/Program Files/PostgreSQL/17/bin/pg_ctl.exe" -D "C:/Users/pujan/AppData/Local/Temp/octo-pg" -o "-p 54329" -l "C:/Users/pujan/AppData/Local/Temp/octo-pg/server.log" start
```

The Octo schema lives in the **`octo`** database on this cluster (not `postgres`).

**2. API server (port 3001).** Run in the background; it stays up:

```bash
DATABASE_URL="postgresql://postgres@localhost:54329/octo" \
OCTO_STORAGE_BACKEND=local \
OCTO_MEDIA_SECRET=e2e-media-secret \
OCTO_MFA_SECRET=e2e-mfa-secret \
OCTO_SESSION_SECRET=e2e-session-secret \
PORT=3001 \
npx tsx src/server/index.ts
```

Confirm: `curl -s http://localhost:3001/health` → `{"status":"ok",...,"database":{"connected":true,...}}`.

**3. Vite frontend (port 3000).**

```bash
npx vite --port 3000
```

Confirm: `curl -s http://localhost:3000/` returns the HTML shell (`<title>Octo — Workspace</title>`).

## Run (agent path)

Drive the app with the driver. It reads commands from stdin, one per line:

```bash
cd /d/development/octo-db
printf 'guest\nss dashboard\n' | node .claude/skills/run-octo/driver.mjs
```

Screenshots land in `./shots/<name>.png` (relative to the CWD you launch from).

Commands:

| Command | Effect |
|---|---|
| `goto <path>` | navigate to `http://localhost:3000<path>` |
| `guest` | load `/`, click **Continue as Guest**, wait for the dashboard |
| `click <text>` | click the first element whose text matches |
| `clickrole <role> <name> [\|exact]` | click by ARIA role + accessible name; `\|exact` forces exact name |
| `fill <selector> :: <text>` | fill an input/textarea; `::` separates so both sides may contain spaces |
| `ss [name]` | screenshot → `shots/<name>.png` (default `shot-N`) |
| `text` | print visible body text |
| `wait <selector>` | wait for a selector to become visible |
| `sleep <ms>` | pause |
| `url` | print the current URL |
| `quit` | close the browser |

Env: `OCTO_BASE` (default `http://localhost:3000`), `OCTO_HEADFUL=1` to show a window.

**Verified end-to-end flow** (login → create a file → confirm it is listed):

```bash
printf 'guest\nclickrole button Files |exact\nclickrole button New text file\nfill input[placeholder="notes.txt"] :: qa_report.txt\nfill textarea :: Live driver verification text.\nclickrole button Save file\nsleep 1500\nss file-saved\n' | node .claude/skills/run-octo/driver.mjs
```

Then look at `shots/file-saved.png` — the file row (`qa_report.txt`, `Ready`) must be present.

## Direct API path

For API-only checks, skip the browser. A guest session is the fastest token:

```bash
curl -s -X POST http://localhost:3001/api/auth/guest -H 'Content-Type: application/json' -d '{}'
```

Use the returned `sessionToken` as `Authorization: Bearer <token>` for
`/api/me`, `GET /api/workspaces`, `POST /api/keys`, and `GET /api/files?workspaceId=<id>`.

## Test

```bash
npm test          # vitest unit tests — 341 tests, ~17s
```

E2E needs the local `DATABASE_URL` in the **runner's** env (not only the server's),
or specs that seed fixtures fail with `owner-db: DATABASE_URL ... is required`:

```bash
DATABASE_URL="postgresql://postgres@localhost:54329/octo" npx playwright test tests/e2e/dashboard-ui.spec.ts
```

Playwright's `webServer` config starts its own API on 3001 and Vite on 3000, and
reuses an already-running server when not in `CI`. Set `CI=1` to force a fresh
server when validating a server-source change. The full suite (`npx playwright test`)
runs 40+ specs at `workers: 1` and takes many minutes — prefer a targeted spec.

## Gotchas

- **Two databases, one cluster.** The schema is in the `octo` database. Pointing
  `DATABASE_URL` at `.../postgres` on 54329 yields a schema-less database and the
  dashboard shows *"Could not load files, gallery for this workspace."* Always use
  `DATABASE_URL="postgresql://postgres@localhost:54329/octo"`.
- **Schema drift shows up as a red dashboard banner, not a crash.** The local `octo`
  DB can lag the migrations. If the dashboard banner reads *"Could not load files,
  gallery"*, check the API log for a missing-column error. The newest migration is
  `db/migrations/20261006160000_file_publish.sql` (adds `published_at`,
  `public_key`); apply any missing one directly:
  ```bash
  "/c/Program Files/PostgreSQL/17/bin/psql.exe" -h 127.0.0.1 -p 54329 -U postgres -d octo -v ON_ERROR_STOP=1 -f db/migrations/20261006160000_file_publish.sql
  ```
- **`clickrole` strict-mode violations.** `Files` matches three buttons (nav item,
  `Upload files`, `View all files →`). Use `|exact`: `clickrole button Files |exact`.
- **Text with spaces or `…` breaks naive arg splitting.** Use the `::` form of `fill`.
- **The API is a background process.** It holds port 3001; a second start fails with
  `EADDRINUSE`. Stop the old one before restarting after a server-source change.
- **`octo-graph` (FalkorDB) is optional and unset locally.** The graph surface
  reports `GRAPH_NOT_CONFIGURED` (503) unless `OCTO_GRAPH_URL` is set — expected, not a bug.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl localhost:3001/health` empty / connection refused | API not running or still booting (~10s). Check its log; confirm the pg cluster is up first. |
| Dashboard red banner "Could not load files, gallery" | Schema drift — apply the missing migration (see Gotchas). |
| `EADDRINUSE :3001` | An API is already running; reuse it or stop it. |
| `page.goto: Cannot navigate to invalid URL` | You passed multiple commands as argv. Use stdin, one command per line. |
| `strict mode violation` on a click | Use `clickrole <role> <name> |exact`. |
| `page.fill: Unexpected token` on a selector | Use `fill <selector> :: <text>`. |
