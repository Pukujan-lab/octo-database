import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, H2, P, PageHeader, UL } from "@/docs/blocks";

const TOOLS: { group: string; tools: string[] }[] = [
  {
    group: "Workspaces and keys",
    tools: ["list_workspaces", "create_workspace", "mint_key", "provision_database", "query_workspace_database"],
  },
  {
    group: "Files",
    tools: ["list_files", "upload_file", "download_file", "delete_file"],
  },
  {
    group: "Retrieval and graph",
    tools: [
      "ingest_document",
      "list_documents",
      "get_document",
      "rename_document",
      "delete_document",
      "query_workspace",
      "query_graph",
      "project_graph",
      "graph_health",
    ],
  },
  {
    group: "Ledger",
    tools: ["record_epistemic", "query_claims_as_of", "query_belief_as_of"],
  },
  {
    group: "Operations",
    tools: ["list_ops_events", "get_ops_summary", "retry_job"],
  },
  {
    group: "Analytics",
    tools: ["register_dataset", "query_dataset", "get_analytics_query_status", "get_analytics_result"],
  },
];

export function McpPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guide"
        title="MCP"
        lead="Octo serves a remote MCP endpoint over Streamable HTTP. Every surface above is also a tool, so an agent runtime needs no hand-written HTTP."
      />

      <H2 id="connect">Connect</H2>
      <P>
        The endpoint is <C>/mcp</C> on the same host as the API. A client authenticates with an
        Octo bearer key, or with OAuth 2.1 when it cannot hold a long-lived secret.
      </P>
      <CodeBlock
        label="json"
        code={`{
  "mcpServers": {
    "octo": {
      "url": "https://octodb.design-bakery.com/mcp",
      "headers": { "Authorization": "Bearer octo_live_ws_..." }
    }
  }
}`}
        caption="The exact config shape depends on the client; the two facts that matter are the URL and the bearer header."
      />
      <P>
        An unauthenticated request answers 401 with the RFC 6750 challenge that points a client at
        the authorization server. Discovery is served at{" "}
        <C>/.well-known/oauth-authorization-server</C>. A key in the URL path is not accepted — a
        long-lived secret does not belong in a URL.
      </P>

      <Callout tone="warning" title="Clients snapshot the tool list at connect time">
        A client that connected before a tool was added will not see it until it reconnects. If a
        tool you expect is missing, refresh the connection before assuming it does not exist.
      </Callout>

      <H2 id="tools">Tools</H2>
      <P>
        The tool list follows the HTTP surface, one tool per action. The same scope and role rules
        apply — an MCP call is authorized exactly as the equivalent HTTP call would be.
      </P>
      <div className="mt-4 space-y-5">
        {TOOLS.map((group) => (
          <div key={group.group}>
            <p className="eyebrow mb-2">{group.group}</p>
            <div className="flex flex-wrap gap-1.5">
              {group.tools.map((tool) => (
                <code
                  key={tool}
                  className="rounded border border-border bg-muted/50 px-2 py-1 font-mono text-[11px] text-foreground"
                >
                  {tool}
                </code>
              ))}
            </div>
          </div>
        ))}
      </div>

      <H2 id="arguments">Arguments</H2>
      <P>
        Arguments match the HTTP calls. Two differences are worth knowing: analytics parts are
        supplied as <C>{"{ partition, dataBase64 }"}</C> rather than the HTTP array shape, and the
        workspace is usually named explicitly rather than taken from the path.
      </P>
      <CodeBlock
        label="json"
        code={`// query_workspace_database
{
  "workspaceId": "6f1c2a90-...",
  "sql": "select count(*) from items",
  "params": [],
  "rowLimit": 100
}`}
      />

      <H2 id="discovery">What this key can actually do</H2>
      <P>
        Do not hard-code the tool list into an agent's instructions. Call{" "}
        <C>GET /api/capabilities?workspaceId=&lt;id&gt;</C> with the same key and read the result:
        it returns the actions that key may invoke, already filtered by scopes, workspace binding,
        role, and provider availability.
      </P>
      <UL>
        <li>
          An action absent from <C>capabilities</C> is one this key cannot invoke.
        </li>
        <li>
          An action in <C>unavailable</C> is one no key can invoke on this deployment — the
          provider behind it is not configured.
        </li>
        <li>
          <C>auth</C> restates the header shape, so a client can self-configure.
        </li>
      </UL>

      <H2 id="boot-block">Boot block for an adopter's AGENTS.md</H2>
      <P>
        A fresh agent session should not have to read Octo's repository first. This block is the
        short form — copy it into the adopting project's <C>AGENTS.md</C> or <C>CLAUDE.md</C>.
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
        caption="The full rule, including the narrow exception, is in the adopter policy page."
      />

      <P>
        See also:{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/policy">
          adopter policy
        </Link>{" "}
        and{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/api">
          the API reference
        </Link>
        .
      </P>
    </>
  );
}
