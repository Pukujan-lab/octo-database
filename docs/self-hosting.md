# Octo Self-Hosting Runbook (Gravebuster)

This runbook covers hosting Octo on the `gravebuster` host at `https://octodb.design-bakery.com`, managing promotions through the `production` branch, and troubleshooting deployments.

---

## 1. Architecture Overview

Octo runs as a three-container Docker Compose project on gravebuster:

```
                      Cloudflare Tunnel (study-os-cloudflared-1)
                                      │  study-os_edge
                                      ▼
                          ┌───────────────────────┐
   octodb.design-bakery ─▶│  octo-web  (Caddy 2)  │  127.0.0.1:8091
   .com                   │  static dist + proxy  │
                          └───────────┬───────────┘
                                      │ /api/*, /health
                                      ▼
                          ┌───────────────────────┐
                          │  octo-api (Node 22)   │  internal only
                          │  tsx src/server/...   │
                          └───────────┬───────────┘
                                      │ postgres://
                                      ▼
                          ┌───────────────────────┐
                          │  octo-db              │  internal only
                          │  pgvector/pgvector:16 │  volume: octo-db-data
                          └───────────────────────┘

                          ┌───────────────────────┐
                          │  octo-graph           │  internal only
                          │  falkordb-server:6.0.1│  in-memory, rebuildable
                          └───────────────────────┘
```

- **`octo-web`** (`caddy:2-alpine`): Serves Vite static production assets from `/srv`, serves `/healthz` for container liveness, and reverse-proxies `/api/*` and `/health` to `octo-api:3001`.
- **`octo-api`** (`node:22-bookworm-slim`): Platform server running `tsx src/server/index.ts`.
- **`octo-db`** (`pgvector/pgvector:pg16`): Dedicated Postgres database with Supabase auth scaffolding and canonical migrations loaded on init.
- **`octo-graph`** (`falkordb/falkordb-server:6.0.1`): The per-workspace graph engine, on the internal network only with no published port. Agents reach a graph only through Octo's mediated API/MCP, which derives the graph name from the authenticated workspace and holds the password. It is an in-memory, rebuildable projection of Postgres, so it carries no data volume and the API does not depend on it.

---

## 2. Prerequisites & Owner Actions

Before running on gravebuster, ensure:

1. **Google OAuth Authorized Redirect URI**:
   Add `https://octodb.design-bakery.com/api/auth/google/callback` to the authorized redirect URIs for your Google OAuth client in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

2. **Cloudflare Tunnel Routing**:
   Map `octodb.design-bakery.com` to `http://octo-web:80` inside the Cloudflare Zero Trust tunnel dashboard (using the existing `study-os-cloudflared-1` tunnel on the `study-os_edge` Docker network).

3. **Port Check**:
   Confirm port `8091` is open on gravebuster (port 8090 is in use by groktocrawl):
   ```bash
   ss -ltn | grep ':8091 '
   ```

---

## 3. Initial Deployment Setup

1. **Clone repository onto gravebuster**:
   ```bash
   mkdir -p ~/apps
   git clone https://github.com/Pukujan-lab/octo-database.git ~/apps/octo
   cd ~/apps/octo
   git checkout production
   ```

2. **Configure production environment**:
   ```bash
   cp deploy/gravebuster/.env.example deploy/gravebuster/.env
   chmod 600 deploy/gravebuster/.env
   nano deploy/gravebuster/.env
   ```
   Provide:
   - `PUBLIC_BASE_URL=https://octodb.design-bakery.com`
   - `POSTGRES_PASSWORD=<strong_random_password>`
   - `DATABASE_URL=postgresql://postgres:<strong_random_password>@octo-db:5432/postgres`
   - `GOOGLE_OAUTH_CLIENT_ID` & `GOOGLE_OAUTH_CLIENT_SECRET`
   - `OCTO_MEDIA_SECRET=<random_32_byte_secret>`
   - `OCTO_SESSION_SECRET=<random_32_byte_secret>`
   - `OCTO_MFA_SECRET=<random_32_byte_secret>` (the envelope key for stored secrets: per-principal MFA, and the workspace database passwords the SQL surface authenticates with)
   - `OCTO_ADMIN_URL=postgresql://postgres:<strong_random_password>@octo-db:5432/postgres` (the privileged provisioning connection for per-workspace databases)
   - `OCTO_GRAPH_PASSWORD=<random_secret>` (and the matching `OCTO_GRAPH_URL`; leave both unset to run without the graph engine)
   - Cloudflare R2 & Google Drive credentials

3. **Initial build and start**:
   ```bash
   cd ~/apps/octo/deploy/gravebuster
   ./deploy.sh
   ```

---

## 3a. Database Migrations

`deploy.sh` applies migrations **before** it starts the API, so a deploy can never
run new code against an old schema. (Skipping this is what once left production
missing three slices and 500-ing on login.) Each applied migration is recorded in
`octo.schema_migrations`; a migration already recorded is never re-run, and each
migration runs in one transaction with its tracking row, so a failure leaves
neither a half-applied migration nor a false "applied" record.

- **Fresh database:** the Postgres init scripts apply every migration and record
  them, so the first `deploy.sh` run finds nothing to do.
- **Existing database that predates tracking** (it has the schema but an empty
  `octo.schema_migrations`): a normal run would try to re-apply old migrations and
  fail on the non-idempotent ones (plain `CREATE POLICY`), which aborts the deploy
  before the containers are swapped. Adopt it once, after confirming its schema is
  already current — and **baseline against the migration set the database already
  has**, i.e. the commit that created it, **not** the set you are deploying.
  `MIGRATE_BASELINE=1` records every migration file present, so baselining from a
  checkout that also contains a new migration marks that new migration as applied
  and it is then skipped forever, leaving the schema silently behind the code:
  ```bash
  # Suppose the live database was created by commit C, and you are deploying D.
  git checkout C
  MIGRATE_BASELINE=1 ./migrate.sh   # records exactly the migrations C contains, runs none
  git checkout D
  ./deploy.sh                       # applies only the migrations D adds on top of C
  ```
  (A fresh database needs none of this: its init scripts already record every
  migration.)
- **Running it directly** (e.g. to apply a new migration without a full deploy):
  ```bash
  ./migrate.sh
  ```
- **Against a non-compose database** (host psql, CI): set `MIGRATE_PSQL_CMD`, e.g.
  ```bash
  MIGRATE_PSQL_CMD="psql -v ON_ERROR_STOP=1 -h localhost -p 54329 -U postgres -d postgres" ./migrate.sh
  ```

4. **Install systemd autodeploy timer**:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp systemd/octo-autodeploy.{service,timer} ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now octo-autodeploy.timer
   ```

---

## 4. Promotion & Continuous Deployment Workflow

1. Development takes place on feature branches and merges to `main` via auto-merge on green CI gates.
2. When ready to promote to production:
   - Open a pull request from `main` into `production`.
   - Arm squash auto-merge. CI runs the full `gates` validation suite, and the PR merges when `gates` is green. Do not ask the owner to merge.
3. Within 5 minutes, the systemd timer on gravebuster invokes `autodeploy.sh`:
   - Detects the new commit on `origin/production`.
   - Runs `deploy.sh`.
   - Builds SHA-tagged images, starts `octo-db`, and applies migrations (`migrate.sh`).
   - Starts the API and web containers.
   - Verifies health within 90 seconds.
   - Runs smoke test.
   - If smoke test fails, automatically rolls back to the previous image.

---

## 5. Manual Rollback

If a manual rollback is ever required:
```bash
cd ~/apps/octo/deploy/gravebuster
./rollback.sh
```

---

## 6. Local Podman Testing (WSL)

To test the container stack locally before deployment:
```bash
cd deploy/local
cp .env.example .env
podman-compose up -d --build
```
Then visit `http://localhost:8095` to test the UI and API locally.
