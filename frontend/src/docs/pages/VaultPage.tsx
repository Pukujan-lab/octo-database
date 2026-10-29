import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, EndpointTable, Exchange, H2, P, PageHeader, Step, Table, UL } from "@/docs/blocks";

const BASE = "https://octodb.design-bakery.com";

export function VaultPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guide"
        title="Vault"
        lead="The owner stores a vendor credential once. An agent then spends it without ever seeing it — through a relay that injects the secret server-side."
      />

      <H2 id="tokens">Three token families</H2>
      <P>
        Three different tokens touch the vault, and they are not interchangeable. Name the one you
        hold by its prefix before using it.
      </P>
      <Table
        minWidth="38rem"
        columns={[
          { key: "prefix", label: "Prefix" },
          { key: "can", label: "Can" },
          { key: "cannot", label: "Cannot" },
        ]}
        rows={[
          {
            prefix: <code className="font-mono text-[11px] text-foreground">octo_live_…</code>,
            can: "Workspaces and SQL.",
            cannot:
              "Open the vault. GET /api/vault/open answers 401; other /api/vault/* routes answer 403.",
          },
          {
            prefix: <code className="font-mono text-[11px] text-foreground">octo_vault_…</code>,
            can: "The cabinet inventory — labels, descriptions, urls, hasSecret, routes. Mints working keys.",
            cannot: "Return a stored secret. There is no call, with any grant, that decrypts one.",
          },
          {
            prefix: <code className="font-mono text-[11px] text-foreground">octo_tmp_…</code>,
            can: "One stored item, relay only, until it expires.",
            cannot:
              "See the vendor secret or open the cabinet. Every path outside the relay answers 401.",
          },
        ]}
      />

      <Callout title="A grant is an inventory, not a reader">
        <C>GET /api/vault/open</C> with a grant tells you <em>that</em> a key exists and how to
        reach it. It does not decrypt anything. That is what makes one grant safe to hand an agent:
        it can discover every key the owner holds, and it still cannot read one.
      </Callout>

      <H2 id="using-a-credential">Using a credential without holding it</H2>

      <Step n={1} title="Ask for a working key">
        <Exchange
          request={{
            code: `curl -s -X POST ${BASE}/api/vault/open/lease \\
  -H "Authorization: Bearer $OCTO_VAULT_GRANT" \\
  -H 'Content-Type: application/json' \\
  -d '{"label": "Fish Audio", "expiresInDays": 15}'`,
          }}
          response={{
            code: `{
  "lease": { "id": "…", "itemLabel": "Fish Audio",
             "prefix": "octo_tmp_…", "expiresAt": "…" },
  "rawSecret": "octo_tmp_…",
  "proxy": {
    "url": "${BASE}/api/vault/proxy",
    "targetHeader": "x-octo-target",
    "defaultTarget": "https://api.vendor.example/v1"
  },
  "routes": []
}`,
            caption: "The raw key is shown once. `routes` lists any dashboard routes the item already had.",
          }}
        />
        <P>
          <C>label</C> must match a stored item in the grant's cabinet; <C>itemId</C> works too.
          Asking again for the same item rotates the previous working key out.
        </P>
        <P>
          A working key is <strong>free-form</strong> — not pinned to one base URL. The lease stores
          only <em>how</em> to inject the secret, taken from, in order: a <C>baseUrl</C> and scheme
          you pass at lease time, an existing dashboard route on the item, or the item's own{" "}
          <C>url</C> with a bearer header.
        </P>
        <CodeBlock
          label="bash"
          code={`curl -s -X POST ${BASE}/api/vault/open/lease \\
  -H "Authorization: Bearer $OCTO_VAULT_GRANT" \\
  -H 'Content-Type: application/json' \\
  -d '{"itemId": "…", "baseUrl": "https://api.vendor.example/v1",
       "authScheme": "x-api-key", "authHeader": "X-Api-Key"}'`}
          caption="`authScheme` defaults to bearer. x-api-key and query need `authHeader`; basic can take `basicUsername`; body_json and path need `bodyField`."
        />
      </Step>

      <Step n={2} title="Send it wherever the vendor is">
        <P>
          Name the full upstream URL in <C>x-octo-target</C>, as <C>?target=</C>, or as the path
          after <C>/api/vault/proxy</C>. Any <C>http(s)</C> URL works, independent of the item's own
          url.
        </P>
        <CodeBlock
          label="bash"
          code={`curl -s ${BASE}/api/vault/proxy \\
  -H "Authorization: Bearer octo_tmp_…" \\
  -H "x-octo-target: https://api.vendor.example/v1/tts" \\
  -d '{"text": "hello"}'`}
        />
        <CodeBlock
          label="bash"
          code={`# the path form, for a client that only lets you set a base URL
curl -s "${BASE}/api/vault/proxy/https://api.vendor.example/v1/tts" \\
  -H "Authorization: Bearer octo_tmp_…"`}
          caption="A relative path resolves against `defaultTarget`. With no target and no defaultTarget, the proxy answers 400 TARGET_REQUIRED."
        />
        <P>
          The proxy resolves the working key, injects the stored secret using the lease's auth
          scheme, forwards the request and streams the vendor's response back. The working key is
          stripped from every position the scheme does not use, so it never reaches the vendor. The
          path and query are forwarded unchanged.
        </P>
      </Step>

      <Step n={3} title="Renew, inspect, revoke">
        <CodeBlock
          label="bash"
          code={`# extend the working key
curl -s -X POST ${BASE}/api/vault/lease/renew \\
  -H "Authorization: Bearer octo_tmp_…" -H 'Content-Type: application/json' \\
  -d '{"expiresInDays": 15}'

# what is this key for?
curl -s ${BASE}/api/vault/lease/info -H "Authorization: Bearer octo_tmp_…"`}
        />
        <P>
          The owner lists and revokes working keys from the vault dashboard (
          <C>GET /api/vault/leases</C>, <C>DELETE /api/vault/leases/&lt;id&gt;</C>). A revoked or
          expired key answers 401.
        </P>
      </Step>

      <H2 id="auth-schemes">Auth schemes</H2>
      <Table
        minWidth="30rem"
        columns={[
          { key: "scheme", label: "Scheme" },
          { key: "where", label: "Where the working key goes" },
        ]}
        rows={[
          ["bearer", "Authorization: Bearer octo_tmp_…"],
          ["x-api-key", "the configured header, e.g. x-api-key: octo_tmp_…"],
          ["basic", "Authorization: Basic base64(user:octo_tmp_…)"],
          ["query", "the configured query parameter"],
          ["body_json", 'the configured JSON body field, e.g. {"api_key": "octo_tmp_…"}'],
          ["path", "in the path where the vendor puts the token, e.g. Telegram /bot<key>/getMe"],
        ].map(([scheme, where]) => ({
          scheme: <code className="font-mono text-[11px] text-foreground">{scheme}</code>,
          where,
        }))}
      />
      <P>
        The proxy accepts the working key in any of the usual positions — bearer, basic (either
        half), <C>x-api-key</C>, the path, or a query parameter — and refuses two <em>different</em>{" "}
        keys in two positions.
      </P>

      <H2 id="fence">What a working key cannot do</H2>
      <P>
        It is not a session, a grant, or an API key. It cannot open the cabinet, list vault items,
        list grants, create workspaces, or call any path outside:
      </P>
      <UL>
        <li>
          <C>/api/vault/proxy</C>
        </li>
        <li>
          <C>/api/vault/relay/&lt;routeKey&gt;</C>
        </li>
        <li>
          <C>/api/vault/lease/renew</C>
        </li>
        <li>
          <C>/api/vault/lease/info</C>
        </li>
      </UL>
      <P>Every other Octo path answers 401. That fence is the point.</P>

      <H2 id="endpoints">Endpoints</H2>
      <EndpointTable
        rows={[
          {
            method: "GET",
            path: "/api/vault/open",
            scope: "grant",
            summary: "Read the cabinet inventory. Never returns a stored secret.",
          },
          {
            method: "POST",
            path: "/api/vault/open/lease",
            scope: "grant",
            summary: "Mint a working key for one item.",
          },
          {
            method: "POST",
            path: "/api/vault/lease/renew",
            scope: "working key",
            summary: "Extend a working key.",
          },
          {
            method: "GET",
            path: "/api/vault/lease/info",
            scope: "working key",
            summary: "Describe a working key.",
          },
          {
            method: "ANY",
            path: "/api/vault/proxy[/<target>]",
            scope: "working key",
            summary: "Call any vendor URL through Octo.",
          },
          {
            method: "ANY",
            path: "/api/vault/relay/<routeKey>/…",
            scope: "working key",
            summary: "Call a dashboard route's vendor through Octo.",
          },
          {
            method: "GET",
            path: "/api/vault/grants",
            scope: "session",
            summary: "Owner lists grants. DELETE revokes one.",
          },
          {
            method: "GET",
            path: "/api/vault/leases",
            scope: "session",
            summary: "Owner lists working keys. DELETE revokes one.",
          },
        ]}
      />
      <P>
        A token valid for one row of that table is not valid for another. In particular a grant does{" "}
        <strong>not</strong> authenticate <C>/api/workspaces</C>, <C>/api/files</C> or the SQL
        surface, and an API key does <strong>not</strong> authenticate <C>/api/vault/open</C>.
      </P>

      <P>
        Next:{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/mcp">
          MCP
        </Link>{" "}
        — the same surfaces as agent tools.
      </P>
    </>
  );
}
