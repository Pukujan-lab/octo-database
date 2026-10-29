import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Callout, C, CodeBlock, H2, P, PageHeader } from "@/docs/blocks";
import { DOCS_SECTIONS } from "@/docs/nav";

const SURFACES = [
  {
    title: "SQL database",
    body: "A real PostgreSQL database per workspace, auto-provisioned at creation, pgvector enabled, with its own scoped role.",
  },
  {
    title: "Files and publishing",
    body: "Upload bytes, serve thumbnails, archive cold, and publish a single file to a stable public URL.",
  },
  {
    title: "Analytics",
    body: "Immutable Parquet dataset versions queried by a named spec with DuckDB. The caller never supplies SQL.",
  },
  {
    title: "Retrieval",
    body: "Chunk, embed and store documents, then query them with a hybrid lexical-plus-vector search.",
  },
  {
    title: "Graph and ledger",
    body: "A bitemporal claim ledger, plus a Cypher-queryable graph projection rebuilt from it.",
  },
  {
    title: "Vault",
    body: "Store a vendor credential once and let an agent spend it without ever holding the secret.",
  },
];

export function OverviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Octo documentation"
        title="Octo is your project's data layer"
        lead="One workspace per project, one API in front of everything it owns. This page is the map; the quickstart is the shortest path to a first query."
      />

      <Callout title="You are probably looking for one of these">
        <Link to="/docs/quickstart">Quickstart</Link> — key in, workspace up, rows out.{" "}
        <Link to="/docs/api">API reference</Link> — every route, its scope and required role.
      </Callout>

      <H2 id="the-model">The model</H2>
      <P>
        A <strong>workspace</strong> is the tenancy boundary. It owns a database, a file store,
        an analytics lake, a retrieval index, a graph and an activity log. Nothing crosses
        between workspaces: a resource belonging to another workspace answers <C>404</C>, not{" "}
        <C>403</C>.
      </P>
      <P>
        A <strong>key</strong> is how a caller reaches a workspace. Keys carry four scopes —{" "}
        <C>read</C>, <C>write</C>, <C>files</C>, <C>delete</C> — and are either account-wide or
        fenced to one workspace. Scopes decide <em>what</em> a key may do; workspace membership
        and role decide <em>where</em>.
      </P>
      <CodeBlock
        label="text"
        code={`account
└── workspace            ← the tenancy boundary
    ├── database         ← real PostgreSQL, own role, pgvector on
    ├── files            ← private bytes + published copies
    ├── datasets         ← immutable Parquet versions
    ├── documents        ← chunked, embedded, searchable
    ├── graph            ← rebuilt from the claim ledger
    └── activity         ← who did what`}
      />

      <H2 id="surfaces">What a workspace gives you</H2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {SURFACES.map((surface) => (
          <div key={surface.title} className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <p className="font-display text-sm font-semibold tracking-tight">{surface.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{surface.body}</p>
          </div>
        ))}
      </div>

      <H2 id="first-call">The shape of every call</H2>
      <P>
        Authentication is a bearer token. Paths are versioned by family, not by number, and every
        response is JSON. This is the canonical call — run SQL against the workspace database:
      </P>
      <CodeBlock
        label="bash"
        code={`curl -s https://octodb.design-bakery.com/api/workspaces/$OCTO_WORKSPACE_ID/query \\
  -H "Authorization: Bearer $OCTO_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"sql": "select 1 as ok"}'`}
      />

      <H2 id="contents">Contents</H2>
      <div className="mt-4 grid gap-8 sm:grid-cols-2">
        {DOCS_SECTIONS.map((section) => (
          <div key={section.label}>
            <p className="eyebrow mb-2">{section.label}</p>
            <ul className="space-y-1.5">
              {section.pages.map((page) => (
                <li key={page.href}>
                  <Link
                    to={page.href}
                    className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {page.title}
                    <ArrowRight className="h-3 w-3 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <H2 id="discovery">Discovery is a call, not a document</H2>
      <P>
        This documentation is written by hand, so it can lag. The server's own catalogue cannot:
        <C>GET /api/capabilities</C> returns every action the presented key may invoke, each with
        its method, path and required scope — already filtered by the key's scopes, its workspace
        binding, the caller's role, and whether a provider is configured.
      </P>
      <CodeBlock
        label="bash"
        code={`curl -s https://octodb.design-bakery.com/api/capabilities?workspaceId=$OCTO_WORKSPACE_ID \\
  -H "Authorization: Bearer $OCTO_API_KEY"`}
        caption="An action missing from this response is one this key cannot invoke. An action in `unavailable` is one no key can invoke on this deployment."
      />
    </>
  );
}
