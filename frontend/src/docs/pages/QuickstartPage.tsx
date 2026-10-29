import { Link } from "react-router-dom";
import {
  Callout,
  C,
  CodeBlock,
  EndpointTable,
  Exchange,
  H2,
  P,
  PageHeader,
  Step,
  UL,
} from "@/docs/blocks";

const BASE = "https://octodb.design-bakery.com";

export function QuickstartPage() {
  return (
    <>
      <PageHeader
        eyebrow="Start here"
        title="Quickstart"
        lead="One workspace, its own Postgres database, and a key that reaches it. Ten minutes from nothing to rows."
      />

      <Callout title="What you are building">
        Octo provisions a real PostgreSQL database per workspace. Your project talks to it
        through Octo's API with a bearer key, or directly with the connection string — you
        never run the database yourself.
      </Callout>

      <H2 id="before-you-start">Before you start</H2>
      <P>
        You need two things: an Octo instance you can reach, and a human who can sign in to it.
        Workspace creation and key minting are human-stamped by design — an API key can never
        create a workspace or mint another key. Everything after that is yours to automate.
      </P>

      <Step n={1} title="Sign in and create a workspace">
        <P>
          Open the dashboard, sign in, and create a workspace. The workspace is the tenancy
          boundary: its database, files, analytics, retrieval index and graph all live behind
          that id, and nothing crosses between workspaces.
        </P>
        <P>
          Creation auto-provisions the workspace's own database in the same call. The response
          reports <C>databaseProvisioned: true</C> and returns the workspace's first key once.
        </P>
      </Step>

      <Step n={2} title="Mint a workspace-scoped key">
        <P>
          In the workspace's settings, mint a key. For a project that reads, writes and manages
          files, the default scopes <C>read</C>, <C>write</C> and <C>files</C> are what you want;
          add <C>delete</C> only if the project must destroy records. The secret is shown once.
        </P>
        <P>
          A key scoped to a workspace is fenced to that workspace. Use an account-wide key only
          for work that spans workspaces — creating workspaces, for instance.
        </P>
      </Step>

      <Step n={3} title="Put the key in the environment">
        <P>
          The key is a bearer token. Store it with whatever secret mechanism the project already
          uses — a <C>.env</C>, a platform secret store, an agent runtime's credentials. Never
          commit it.
        </P>
        <CodeBlock
          label="bash"
          code={`export OCTO_API_KEY="octo_live_ws_..."
export OCTO_WORKSPACE_ID="6f1c2a90-..."`}
          caption="Both values come from the workspace you just created. The id is in its URL."
        />
      </Step>

      <Step n={4} title="Run a statement">
        <P>
          This is the whole data path. No host, no port, no connection string — the server
          authenticates as the workspace's own role and runs the statement there.
        </P>
        <Exchange
          request={{
            code: `curl -s ${BASE}/api/workspaces/$OCTO_WORKSPACE_ID/query \\
  -H "Authorization: Bearer $OCTO_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"sql": "select now() as server_time"}'`,
          }}
          response={{
            code: `{
  "columns": ["server_time"],
  "rows": [{ "server_time": "2026-10-28T09:14:02.118Z" }],
  "rowCount": 1,
  "statementCount": 1,
  "truncated": false
}`,
          }}
        />
      </Step>

      <Step n={5} title="Create a table and write to it">
        <P>
          A write caller may send a multi-statement batch when it carries no parameters — the
          usual shape for a migration. Parameterised calls are single statements.
        </P>
        <CodeBlock
          label="bash"
          code={`curl -s ${BASE}/api/workspaces/$OCTO_WORKSPACE_ID/query \\
  -H "Authorization: Bearer $OCTO_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"sql": "create table items (id serial primary key, label text not null, created_at timestamptz default now())"}'

curl -s ${BASE}/api/workspaces/$OCTO_WORKSPACE_ID/query \\
  -H "Authorization: Bearer $OCTO_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"sql": "insert into items (label) values ($1) returning id, label", "params": ["alpha"]}'`}
        />
        <P>
          <C>pgvector</C> is already enabled in the workspace database, so embeddings can live
          beside your relational data without a second store.
        </P>
      </Step>

      <H2 id="where-to-go-next">Where to go next</H2>
      <P>
        The four calls below cover most of what a project needs on day one. Each links to a page
        with the full request and response.
      </P>
      <EndpointTable
        rows={[
          {
            method: "POST",
            path: "/api/workspaces/<id>/query",
            scope: "read",
            summary: "Run SQL against the workspace database. Write scope to mutate.",
          },
          {
            method: "POST",
            path: "/api/files/upload",
            scope: "write",
            summary: "Upload bytes into the workspace.",
          },
          {
            method: "POST",
            path: "/api/files/<fileId>/publish",
            scope: "write",
            summary: "Copy one file to the public bucket and get a stable URL.",
          },
          {
            method: "GET",
            path: "/api/capabilities",
            scope: "any key",
            summary: "Discover every action this key may invoke, with its path.",
          },
        ]}
      />

      <Callout tone="warning" title="Do not stand up a second database">
        A workspace already has a real, independently connectable PostgreSQL database with its
        own scoped role. Provisioning a separate Postgres "for independence" fragments the data
        layer Octo exists to keep whole. If you believe you have a concrete incompatibility,
        raise it with the owner before building anything. The full rule is in{" "}
        <Link to="/docs/policy">adopter policy</Link>.
      </Callout>

      <H2 id="using-an-agent">Using an agent runtime</H2>
      <P>
        If the caller is an agent rather than a script, point it at the MCP endpoint instead of
        hand-writing HTTP. The same surfaces are exposed as tools, and{" "}
        <C>GET /api/capabilities</C> tells a key what it may actually invoke — including
        capabilities that are unavailable because a provider is not configured.
      </P>
      <UL>
        <li>
          <Link className="text-primary underline underline-offset-2" to="/docs/mcp">
            MCP
          </Link>{" "}
          — the tool names and how to connect.
        </li>
        <li>
          <Link className="text-primary underline underline-offset-2" to="/docs/authentication">
            Authentication
          </Link>{" "}
          — the four token prefixes, and why they are not interchangeable.
        </li>
        <li>
          <Link className="text-primary underline underline-offset-2" to="/docs/api">
            API reference
          </Link>{" "}
          — every route with its scope and required role.
        </li>
      </UL>
    </>
  );
}
