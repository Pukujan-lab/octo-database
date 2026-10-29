import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, H2, P, PageHeader, Table, UL } from "@/docs/blocks";

const TOKENS = [
  {
    prefix: "octo_live_acc_…",
    name: "Account-wide API key",
    holder: "Agent or script",
    opens: "Every workspace the principal belongs to. The only key that can create a workspace.",
    closed: "Cannot open the vault, and cannot mint another key — both need a human session.",
  },
  {
    prefix: "octo_live_ws_…",
    name: "Workspace API key",
    holder: "Agent or script",
    opens: "One workspace: SQL, files, analytics, retrieval, graph, jobs. Cannot provision or create workspaces.",
    closed: "Cannot reach any other workspace, and cannot open the vault.",
  },
  {
    prefix: "octo_vault_…",
    name: "Vault grant",
    holder: "Agent",
    opens: "The cabinet inventory — labels, descriptions, urls, whether a secret exists — and minting a working key.",
    closed: "Never returns a stored secret. Not valid on /api/workspaces, /api/files, or the SQL surface.",
  },
  {
    prefix: "octo_tmp_…",
    name: "Working key (lease)",
    holder: "Agent",
    opens: "One stored item, through the relay only. Expires on its own; revocable on its own.",
    closed: "Never sees the vendor secret and cannot open the cabinet. Every other path answers 401.",
  },
];

export function AuthenticationPage() {
  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Authentication"
        lead="Four token families, four different reach. Name the token you hold by its prefix before you use it — they are not interchangeable."
      />

      <H2 id="the-header">The header</H2>
      <P>
        Every authenticated call carries a bearer token. There is no cookie, no signature and no
        query-string credential.
      </P>
      <CodeBlock
        label="HTTP"
        code={`Authorization: Bearer octo_live_ws_...`}
        caption="A missing or invalid token answers 401. A valid token without the required scope answers 403."
      />

      <H2 id="token-families">The four token families</H2>
      <Table
        minWidth="40rem"
        columns={[
          { key: "prefix", label: "Prefix" },
          { key: "opens", label: "Opens" },
          { key: "closed", label: "Does not" },
        ]}
        rows={TOKENS.map((token) => ({
          prefix: (
            <>
              <code className="whitespace-nowrap font-mono text-[11px] text-foreground">
                {token.prefix}
              </code>
              <p className="mt-1 text-[11px] text-muted-foreground">{token.name}</p>
              <p className="text-[11px] text-muted-foreground/70">{token.holder}</p>
            </>
          ),
          opens: token.opens,
          closed: token.closed,
        }))}
      />

      <Callout tone="warning" title="A 401 on /api/workspaces with a vault token is correct">
        Vault tokens are valid only under <C>/api/vault/</C>. Getting a 401 elsewhere means you
        reached for the wrong token, not that the vault is missing. The vault is part of the same
        Octo host — there is no separate vault subdomain.
      </Callout>

      <H2 id="scopes">Scopes</H2>
      <P>
        A key stores a list of scopes. Every route names the one scope it requires, and the server
        checks it on every call — the capability catalogue is documentation, never the enforcement
        mechanism.
      </P>
      <UL>
        <li>
          <C>read</C> — list and inspect, and run SQL in a read-only transaction.
        </li>
        <li>
          <C>write</C> — mutate: upload, publish, enqueue jobs, register datasets, record claims.
        </li>
        <li>
          <C>files</C> — file and gallery bytes, separately from workspace metadata.
        </li>
        <li>
          <C>delete</C> — destructive operations. Never granted by default.
        </li>
      </UL>
      <P>
        The default for a new key is <C>read</C>, <C>write</C> and <C>files</C> — non-destructive.
        Deleting requires asking for <C>delete</C> explicitly.
      </P>

      <H2 id="roles">Roles</H2>
      <P>
        Scopes travel with the key; roles come from the caller's membership in the workspace. Both
        must pass. A key with <C>write</C> still cannot enqueue a job in a workspace where the
        principal is only a member, because that action needs operator.
      </P>
      <CodeBlock
        label="text"
        code={`member     read and query
operator   + upload, publish, jobs, ingest, record, project
admin      + delete files and documents, manage share links
owner      everything, including workspace lifecycle`}
      />

      <H2 id="minting">Minting a key</H2>
      <P>
        Minting is a human step: a browser session plus the account's confirmation secret, and a
        TOTP code when MFA is enrolled. An API key cannot mint another key, and cannot create a
        workspace. That gate is what stops a leaked agent token from widening its own authority.
      </P>
      <P>
        A key may only ever narrow when it mints: it cannot add scopes, escape its workspace
        binding, or become account-wide.
      </P>
      <CodeBlock
        label="HTTP"
        code={`POST /api/keys
Authorization: Bearer <a human session>

{
  "name": "design-bakery sync",
  "workspaceId": "6f1c2a90-...",
  "scopes": ["read", "write", "files"],
  "expiresInDays": 90
}`}
        caption="The response carries `rawSecret` exactly once. It is stored hashed and cannot be shown again."
      />
      <P>
        <C>keyClass</C> is shorthand for a documented authority profile — <C>analytics</C>,{" "}
        <C>agent-read</C>, <C>program-write</C> — and is mutually exclusive with an explicit{" "}
        <C>scopes</C> list. It expands to the same four scopes; it is not a second authorization
        dimension.
      </P>

      <H2 id="oauth">OAuth</H2>
      <P>
        Hosted MCP clients that cannot hold a long-lived key authenticate with OAuth 2.1 instead.
        The discovery document is served at <C>/.well-known/oauth-authorization-server</C>, and an
        unauthenticated <C>/mcp</C> request answers 401 with the RFC 6750 challenge that points a
        client at it. The resulting access token is presented the same way — as a bearer token.
      </P>

      <Callout title="Session vs key">
        A browser session and an API key are different credentials with different reach. A session
        can mint keys and create workspaces; a key cannot. When a route says "human session" it
        means a browser session specifically — sending a key answers 403.
      </Callout>

      <P>
        Next:{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/sql">
          running SQL
        </Link>{" "}
        against the workspace database.
      </P>
    </>
  );
}
