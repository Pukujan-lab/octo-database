# Control-plane adoption research

**Date:** 2026-10-02 · **Status:** Research checkpoint; recommendations below do not authorize a migration.
**Issue:** [octo-database #72](https://github.com/Pukujan-lab/octo-database/issues/72)

## What this research answers

Issue #72 asks whether Octo should adopt a mature database/control-plane product, what remains specific to Octo, how to handle non-Postgres projections, and how to make agents reuse mature software. This note compares documented product capabilities and proposes a default direction. It does not pick a provider or authorize a topology change.

The issue #72 working notes describe the broader goal: Octo is a workspace portal that connects project-specific workflows and existing tools. The dashboard, gallery, and operations experience remain product requirements under `AGENTS.md`; native consoles complement those views.

## Current Octo boundary

The repository's Gravebuster compose file defines Octo's current Caddy, Node API, and PostgreSQL/pgvector services. It does not define Supabase Studio, Auth, PostgREST, or Supabase Storage. The application currently owns workspace membership and route authorization. Therefore, installing Supabase would be a platform change: the existing schema or application behavior should not be assumed to become Supabase-managed automatically.

The production URL was reachable during this research and `/health` reported PostgreSQL and R2 connected plus Google OAuth configured. The Gravebuster peer was visible on Tailscale, but SSH authentication was denied from this session. The compose observation is from the repository; the live service status is from the health response.

## Candidate comparison

“Console quality” below means the workflows documented by each vendor, not a visual-design score. Glue estimates are relative to Octo's existing PostgreSQL and workspace model.

| Product | Console and project model | PostgreSQL fidelity | Glue for Octo |
|---|---|---|---|
| **Self-hosted Supabase** | Mature Studio, but a self-hosted deployment represents one project; Studio has no multi-organization/project switcher. [Self-hosting](https://supabase.com/docs/guides/self-hosting) | Full PostgreSQL plus Supabase Auth, APIs, and related services when the full stack is deployed. | **Low** to run one stack; **medium/high** to adopt it from Octo's current runtime and map existing app behavior. **High** for one stack per Octo workspace, because Octo would also need to provision and operate a fleet. |
| **Supabase Cloud** | Supabase's managed project platform and Studio; organizations contain projects. It avoids operating the stack, while each project remains a separately managed environment. [Organizations and projects](https://supabase.com/docs/guides/platform/billing-faq) | Full managed PostgreSQL/Supabase platform. | **Medium/high** to migrate Octo's current runtime; **high** for one project per workspace if Octo also automates project lifecycle. |
| **Supabase Studio / `postgres-meta` alone** | Studio is a UI for the Supabase platform APIs; `postgres-meta` is a supporting metadata service, not the Studio product. The upstream repository explicitly says not to use `postgres-meta` standalone. [Studio](https://supabase.com/docs/guides/self-hosting/docker), [postgres-meta](https://github.com/supabase/postgres-meta) | Can inspect Postgres metadata; does not supply the rest of Supabase's project runtime. | **High**. It is not a drop-in general Postgres control plane. |
| **pgAdmin** | Specialist Postgres administration UI with server groups and multiple registered servers. [Server groups](https://www.pgadmin.org/docs/pgadmin4/latest/server_group_dialog.html), [server connections](https://www.pgadmin.org/docs/pgadmin4/latest/connecting.html) | **Very high** for Postgres administration and development. It does not provision Octo workspaces or provide a cross-product portal. | **Low** to connect to existing databases; Octo supplies workspace context and links. |
| **DBeaver** | Community/desktop editions organize connections in projects; Team Edition adds a server/web collaboration surface and can display multiple projects. It remains a database client, not Octo's workspace portal. [Projects](https://dbeaver.com/docs/dbeaver/Projects/), [Team Edition projects](https://dbeaver.com/docs/team-edition/Projects/) | **High** for interactive SQL and database inspection across supported engines. | **Low** for individual operators; Team Edition adds operating/setup and licensing considerations. Neither provides Octo's workspace entry or user-facing gallery/jobs. |
| **Directus** | Rich Data Studio for a SQL-backed instance. Directus defines a project as an instance connected to a database; a fleet of separate projects therefore needs separate instances or custom provisioning/navigation. [Project glossary](https://docs.directus.io/user-guide/overview/glossary), [database config](https://docs.directus.io/self-hosted/config-options) | **High** for data-model and record workflows; not a complete Postgres server administration console. | **Medium** for a single existing database; **high** for Octo-managed per-workspace instances. |
| **NocoDB** | Spreadsheet-style base UI; can connect a base to an external data source. Community Edition includes one workspace. [External sources](https://nocodb.com/docs/product/integrations/data-sources/connect-to-data-source), [edition comparison](https://nocodb.com/docs/product/account-settings/cloud-enterprise-edition/community-vs-paid-editions) | **Medium** for table/data/schema workflows; not server-level Postgres administration. | **Low to medium** to browse tables; higher for a fleet of independent Octo workspaces and non-table operations. |
| **Baserow** | Workspace/database/app UI. Its PostgreSQL path is data synchronization, not a general admin console over arbitrary databases. [Workspaces](https://baserow.io/user-docs/intro-to-workspaces), [PostgreSQL sync](https://baserow.io/user-docs/data-sync-in-baserow) | **Low to medium** for external Postgres management; stronger for Baserow-managed workspaces and synced views. | **Medium** for synchronized views; high if the requirement is direct, full-fidelity Postgres administration. |
| **Hasura** | GraphQL/API console and metadata/migration workflow; can expose multiple data sources but is not a fleet-wide database administrator. [Multiple sources](https://hasura.io/blog/a-hasura-2-0-engineering-overview), [migrations](https://hasura.io/learn/graphql/hasura-advanced/migrations-metadata/) | **High** for API-facing schema and data workflows; not a replacement for a native server console. | **Medium** for an API product; extra work to map many Octo workspaces to databases. |
| **Nhost** | Cloud organizations contain projects, each managed as part of Nhost's application platform. Its local stack is aimed at developing an Nhost app, not attaching one console to Octo's existing database fleet. [Organizations](https://docs.nhost.io/platform/cloud/billing), [local development](https://docs.nhost.io/platform/cli/local-development) | **High** within an Nhost project. | **High** if retaining Octo's current backend: adoption means bringing in more of Nhost's platform, rather than adding only a Postgres console. |
| **Appwrite** | Appwrite Cloud now documents managed native Postgres databases alongside its app-oriented data products. Projects organize those services. Self-hosted Appwrite's Postgres configuration describes Appwrite's own backend database. [Native databases](https://appwrite.io/docs/products/databases/postgresql/quick-start), [self-hosted backend](https://appwrite.io/docs/advanced/self-hosting/configuration/databases) | **High** for its Cloud native Postgres offering; do not confuse it with self-hosted Appwrite's internal database. | **High** if Octo stays self-hosted: the documented native Postgres service is in Appwrite Cloud, so using it would change hosting/provider. The database itself is standard PostgreSQL with direct driver access, not an Appwrite-only data API. |

## Recommendation and topology tradeoffs

**Recommended working default:** keep Octo's existing workspace model and database topology while finishing accepted user workflows. Keep Octo's dashboard as the workspace entry point; use native consoles for the database-specific work they already handle well. Do not migrate to a provider merely to get a console before the owner has selected the desired project boundary.

If Supabase is selected later, a single self-hosted Supabase project is the lower-operations starting point: multiple Octo workspaces map inside that project, with Studio serving the project rather than switching between workspaces. One Supabase project per workspace gives cleaner provider-level separation and a project-specific Studio, but adds stacks, upgrades, backups, and provisioning glue. Supabase Cloud removes self-host operations but retains project lifecycle and cost tradeoffs. A shared project also does not itself settle Octo's authorization design; the existing app model needs to be deliberately mapped to the chosen platform.

This is a default for continuing current work, not a recommendation to migrate. The open owner decision is whether a future Octo workspace must correspond to an independently provisioned database project. If that is not a product requirement, the current shared database boundary is the simpler fit.

## Non-Postgres projections

Use each engine's native console for its own administration and keep Octo as the workspace-level navigation and workflow shell:

| Data/projection | Natural tool boundary |
|---|---|
| PostgreSQL and pgvector | pgAdmin or the selected Postgres platform's Studio. pgvector is an extension within PostgreSQL, not a separate database console. |
| Neo4j projection | Neo4j's own browser/developer tooling; Octo can provide a workspace link and projection status. |
| Parquet with DuckDB | Use the analytics job/query surface for accepted workspace questions and DuckDB's local UI (`duckdb -ui`) or another DuckDB client for specialist inspection. The local UI opens for the DuckDB process it was started from; DuckDB is often embedded in the analytics process rather than a separately hosted server. [DuckDB UI](https://duckdb.org/docs/stable/core_extensions/ui) |

Octo still needs workflow-specific UI for workspace selection, files/gallery, jobs, activity, and accepted proposals. It should not reproduce SQL editors, graph explorers, or general BI builders when a mature tool already owns that workflow. Deep links are the smallest integration; embedding should be evaluated only if the chosen product and workflow require it.

## Why agents rebuild, and the repository rule

Agents tend to implement a local substitute because a small custom screen or endpoint is easy to generate and verify in isolation. Evaluating an existing product requires checking its deployment model, connecting it to real data, and proving the user task works through that integration. Issue wording such as “build a dashboard” can also encourage the agent to interpret the requested outcome as permission to implement the whole generic admin surface. The maintenance cost lands after the agent's turn, so local completion signals reward new code more readily than a working integration.

The durable reuse rule should be: **use the selected provider's native console or a maintained OSS tool for generic infrastructure administration, with Octo providing workspace context and links. Keep custom UI focused on Octo-specific workflows such as workspace files, gallery, jobs, activity, and accepted proposals.**

This rule is already reflected in `AGENTS.md`'s reuse-before-build instruction and the `Reuse` field in `docs/productization/SLICE_CONTRACT.md`. Agents should answer that existing field for each UI or infrastructure slice; it helps planning compare adoption with custom code without adding a CI check, review gate, or approval layer.

## Limits and open decision

Vendor documentation describes capabilities, not comparative UX quality under Octo's user count, deployment budget, or operator habits. A bounded trial with Octo's actual workflows is needed before choosing a new platform. Current evidence favors native consoles for specialist administration and Octo's workspace-specific shell for cross-system workflows. It does not determine whether the owner wants each workspace to own a separate database project.

**Owner decision requested by issue #72:** should one Octo workspace ever require its own independently provisioned database project, or should workspaces remain application-level contexts inside the current shared database environment? No migration should be inferred from this note.
