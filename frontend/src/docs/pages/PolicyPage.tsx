import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, H2, H3, P, PageHeader, UL } from "@/docs/blocks";
import { REPOSITORY_URL } from "@/components/landing/links";

export function PolicyPage() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="Adopter policy"
        lead="How to work in a project that Octo serves. This is the operative rule for coding agents and humans alike."
      />

      <Callout tone="rule" title="The rule in one line">
        Octo is your data layer. You consume it; you do not change it, and you do not stand up a
        second database beside it.
      </Callout>

      <H2 id="read-only">Octo's repository is read-only to adopters</H2>
      <P>
        Consuming Octo — through its API, MCP, or SQL surfaces — grants <strong>no write access to
        this repository in any form</strong>. No pull requests, no branches, no file edits, not even
        "documentation fixes", and not even to make Octo "work for you". Octo is the platform; your
        project is a client of it.
      </P>
      <P>If Octo lacks something you need:</P>
      <UL>
        <li>
          <strong>Propose it — don't patch it.</strong> File an issue under the OIO
          observational-issue protocol (<C>[OBSERVATION]</C> template). It is a non-binding
          proposal, not a mandate.
        </li>
        <li>
          <strong>Human consent gates everything.</strong> A proposal becomes work only if the owner
          accepts it, and the change is made by an agent the owner directs — never by the adopter.
        </li>
        <li>
          <strong>Work around it in your own project, or wait.</strong> Build what you need against
          Octo's public surfaces in your own repo; adapting Octo itself is not something an adopter
          does.
        </li>
      </UL>

      <H2 id="no-second-database">Do not provision a second database</H2>
      <P>
        Do <strong>not</strong> provision, scaffold, or recommend a database for an Octo-served
        project. That includes:
      </P>
      <UL>
        <li>a dedicated Postgres container of your own (a "project-db" service on its own volume);</li>
        <li>a managed Postgres elsewhere (Railway, a separate Supabase project, RDS, …);</li>
        <li>a database "for independence" — a second datastore so the project is not "tied to" Octo;</li>
        <li>a database co-located on Octo's own host as a peer to Octo's Postgres.</li>
      </UL>
      <P>
        All four are the same mistake. You are not the project's database operator — Octo is.
        Instead: provision the workspace database through Octo, then reach it either with your Octo
        API key or with an ordinary Postgres client. That is the whole job.
      </P>

      <H3 id="why">Why</H3>
      <P>
        Octo exists so data does not fragment across per-project datastores. "Host my own database"
        is a default instinct for most coding agents, and for an Octo project it is the exact
        anti-pattern Octo was built to prevent. Recommending it — even as one option among several —
        erodes the single-data-layer guarantee one "recommended option" at a time. This is not
        hypothetical: see incident <strong>#162</strong>.
      </P>

      <H3 id="exception">The exception (narrow)</H3>
      <P>
        Skip Octo's managed database only when you can <strong>demonstrate a concrete, specific
        incompatibility</strong> with Octo's provisioned Postgres — with evidence, not a preference.
      </P>
      <P>These are <strong>not</strong> incompatibilities:</P>
      <UL>
        <li>"the project should be independent of Octo";</li>
        <li>"I want control over the database";</li>
        <li>"it is a different engine / version / extension";</li>
        <li>"it is simpler to run my own";</li>
        <li>"the project already had one before Octo".</li>
      </UL>
      <P>
        Octo's provisioned database is a real, independently connectable PostgreSQL database with
        its own scoped role — not a shared table, not a proxy, not a control-plane schema. There is
        therefore no isolation or autonomy argument for a second one.
      </P>
      <P>
        If you believe you have a genuine incompatibility, <strong>stop and surface it to the
        owner</strong> before building anything. Do not quietly stand up a second datastore as the
        "safe" option.
      </P>

      <H2 id="bootstrap">Getting a key is a human step</H2>
      <P>
        Creating a workspace and minting a key are human-stamped: a browser session plus the
        account's confirmation secret, and a TOTP code when MFA is enrolled. An API key can never
        create a workspace or mint a key — that is the same gate that stops a blind agent deleting a
        workspace.
      </P>
      <P>So the bootstrap is done once per project, by a human:</P>
      <UL>
        <li>
          Open the Octo dashboard, create (or find) the project's workspace, and mint a
          workspace-scoped key with the scopes the project needs — <C>read</C>, <C>write</C>,{" "}
          <C>files</C>, and <C>delete</C> only if the project must destroy records.
        </li>
        <li>Put that key in the project's normal secret mechanism.</li>
        <li>Use that key for everything else.</li>
      </UL>
      <P>
        If you do not have a key, <strong>stop and ask the human</strong>. That is the intended
        path, not a broken system. Do not provision a database of your own to work around it.
      </P>

      <H2 id="adopting">Adopting a project that already runs its own datastore</H2>
      <P>
        If a project already speaks to a database directly (for example PostgREST via{" "}
        <C>@supabase/supabase-js</C>), the adoption path is to <strong>re-point its data path at the
        Octo workspace database</strong> — not to keep the old datastore alongside Octo. Provision
        the workspace database, point the project's client at the returned connection string, and
        migrate its schema and data into it. Surface the migration plan to the owner.
      </P>

      <H2 id="boot-block">Boot block for an adopter's AGENTS.md</H2>
      <P>
        Copy this into the adopting repo's <C>AGENTS.md</C> (or <C>CLAUDE.md</C>) so a fresh agent
        session sees it without having to read Octo's repository first. The same block is on the{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/mcp">
          MCP page
        </Link>
        .
      </P>
      <CodeBlock
        label="markdown"
        code={`## Data layer — Octo

This project's durable data lives in Octo, not in a database you run. Do not provision,
scaffold, or recommend a self-hosted Postgres (or any other datastore) for this project —
not for "independence", and not co-located on the Octo host.

**Your key is minted by a human, once.** An API key can never create a workspace or mint a
key. If you have no OCTO_API_KEY in the project .env, stop and ask the human to create the
workspace and mint a workspace-scoped key in the Octo dashboard — do not stand up your own
database to work around it.

Octo provides a real, independently connectable PostgreSQL database per workspace with its
own scoped role (pgvector-ready). Reach it either way:

- Through Octo (no connection string): MCP query_workspace_database,
  or HTTP POST /api/workspaces/<id>/query. Read scope is read-only; write scope mutates.
- Directly: connect with the workspace database's own connection string.

**Historical analytics lives in Octo too.** Register immutable Parquet dataset versions and
run a named query spec with DuckDB — do not add a warehouse or a second analytical
database. You never supply SQL or object keys.

**Vault tokens are not interchangeable.** octo_live_… is an API key and cannot open the
vault. octo_vault_… is a grant: inventory only, never a stored value. octo_tmp_… is a
working key: one item, relay only, never reveals the vendor secret.

**Octo's repo is read-only to you.** You consume Octo; you do not change it — no pull
requests, branches, or file edits. Need something Octo lacks? File an OIO [OBSERVATION]
proposal and let the owner decide; build workarounds in this project.`}
      />

      <H2 id="source">The canonical source</H2>
      <P>
        This page is the policy in full. The repository's{" "}
        <a
          className="text-primary underline underline-offset-2"
          href={`${REPOSITORY_URL}/blob/main/docs/consuming-octo.md`}
          target="_blank"
          rel="noreferrer"
        >
          docs/consuming-octo.md
        </a>{" "}
        remains the file an agent reads from the repo, and{" "}
        <a
          className="text-primary underline underline-offset-2"
          href={`${REPOSITORY_URL}/blob/main/AGENTS.md`}
          target="_blank"
          rel="noreferrer"
        >
          AGENTS.md
        </a>{" "}
        carries the operative rule under "Adopters do not modify this repository".
      </P>
    </>
  );
}
