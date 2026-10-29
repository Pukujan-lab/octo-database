import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, Exchange, H2, P, PageHeader, Table, UL } from "@/docs/blocks";

const BASE = "https://octodb.design-bakery.com";

export function SqlPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guide"
        title="Running SQL"
        lead="Every workspace owns a real PostgreSQL database. Run statements against it with nothing but an API key — no host, no port, no connection string."
      />

      <H2 id="the-surface">The surface</H2>
      <P>
        <C>POST /api/workspaces/&lt;id&gt;/query</C> takes a SQL string, optional positional
        parameters, and an optional row limit. The server authenticates to the workspace's own
        database as the workspace's own role, so a statement can never exceed the authority the
        workspace already has.
      </P>
      <Exchange
        request={{
          code: `POST /api/workspaces/<id>/query
Authorization: Bearer octo_live_ws_...

{
  "sql": "select * from items where label = $1",
  "params": ["alpha"],
  "rowLimit": 100
}`,
        }}
        response={{
          code: `{
  "columns": ["id", "label", "created_at"],
  "rows": [
    { "id": 1, "label": "alpha", "created_at": "2026-10-28T09:14:02.118Z" }
  ],
  "rowCount": 1,
  "statementCount": 1,
  "truncated": false
}`,
        }}
      />

      <H2 id="scope">Scope decides read or write</H2>
      <P>
        A caller with only <C>read</C> scope gets a read-only transaction. <C>SELECT</C> works;
        anything that writes is refused by Postgres itself, not by a parser. A caller with{" "}
        <C>write</C> scope may mutate.
      </P>
      <P>
        A workspace-scoped key is <em>allowed</em> here for its own workspace — unlike
        provisioning, running SQL against your own database is exactly what a scoped key is for.
        The key's workspace binding is still enforced.
      </P>

      <H2 id="statements">One statement, or a batch</H2>
      <UL>
        <li>
          A <strong>parameterised</strong> request is a single statement — <C>params</C> present
          and non-empty.
        </li>
        <li>
          A <strong>read-only</strong> request is a single statement.
        </li>
        <li>
          A <strong>write</strong> request with no parameters may carry several statements, which
          is the shape a migration takes.
        </li>
      </UL>
      <CodeBlock
        label="bash"
        code={`# a migration: one request, several statements, no parameters
curl -s ${BASE}/api/workspaces/$OCTO_WORKSPACE_ID/query \\
  -H "Authorization: Bearer $OCTO_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"sql": "alter table items add column note text; create index on items (label);"}'`}
        caption="The response reports the last statement's result and `statementCount` for the batch."
      />

      <H2 id="limits">Limits</H2>
      <Table
        minWidth="28rem"
        columns={[
          { key: "label", label: "Limit" },
          { key: "value", label: "Value" },
        ]}
        rows={[
          { label: "Rows per response, default", value: <span className="num text-foreground">1000</span> },
          { label: "Rows per response, maximum", value: <span className="num text-foreground">10000</span> },
          { label: "Statement timeout", value: <span className="num text-foreground">30 seconds</span> },
          { label: "Connection timeout", value: <span className="num text-foreground">5 seconds</span> },
        ]}
      />
      <P>
        When the result exceeds the row limit, <C>truncated</C> is true and <C>rowCount</C> reports
        what the statement matched. Page with <C>limit</C> and <C>offset</C> in your own SQL rather
        than raising <C>rowLimit</C>.
      </P>

      <H2 id="errors">Errors</H2>
      <P>
        A statement the database rejects is your problem and comes back as a 400 with Postgres's
        own message, so the fix is usually visible in the text:
      </P>
      <CodeBlock
        label="JSON"
        code={`{
  "error": "SQL_ERROR",
  "message": "column \\"lable\\" does not exist",
  "code": "42703"
}`}
        caption="`code` is the Postgres SQLSTATE. Anything that is not a statement error is a 5xx and is Octo's fault, not yours."
      />

      <H2 id="direct">When you need a direct connection</H2>
      <P>
        The SQL surface covers most projects. A client that speaks Postgres itself — Prisma,
        Drizzle, <C>psql</C>, a BI tool — needs the connection string instead.
      </P>
      <P>
        A workspace created through the API is auto-provisioned at creation, so the string is only
        needed for a client that cannot go through Octo. The explicit provision route returns it
        exactly once:
      </P>
      <CodeBlock
        label="HTTP"
        code={`POST /api/workspaces/<id>/database
Authorization: Bearer <account-wide key with write scope>

→ 201 { dbName, roleName, connectionString }`}
        caption="A workspace-scoped key cannot provision. A workspace that already has a database answers DATABASE_EXISTS."
      />
      <Callout tone="warning" title="Store it immediately">
        The connection string is the workspace database's own credential, scoped to that one
        database. It is the single deliberate exception to "agent tokens never expose
        infrastructure credentials" — so put it straight into the project's secret store, do not
        log it, and do not treat it as an Octo control-plane token.
      </Callout>
      <P>
        The role owns only its own database and reaches no Octo control-plane data. Deleting the
        workspace drops the database and its role.
      </P>

      <H2 id="why-not-a-second-database">Why not run a second database</H2>
      <P>
        The workspace database is a real, independently connectable PostgreSQL database with its
        own scoped role — not a shared table, not a proxy, not a control-plane schema. There is
        therefore no isolation or autonomy argument for provisioning another one. The full rule,
        and the narrow exception, live in{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/policy">
          adopter policy
        </Link>
        .
      </P>
    </>
  );
}
