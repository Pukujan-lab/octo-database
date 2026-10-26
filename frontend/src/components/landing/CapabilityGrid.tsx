const CAPABILITIES = [
  { title: "Workspaces", line: "One identity, one boundary, per-project isolation." },
  {
    title: "Provisioned databases",
    line: "A PostgreSQL database per workspace, owned by its own role.",
  },
  { title: "SQL surface", line: "Run SQL with an API key alone." },
  { title: "Files", line: "Upload, list, download, and delete with short-lived URLs." },
  { title: "Publishing", line: "Give one file a stable public URL." },
  { title: "Archival", line: "Move cold files to Drive and restore on demand." },
  { title: "Gallery and shares", line: "Media browsing plus scoped public links." },
  {
    title: "Analytics",
    line: "Immutable Parquet versions, named queries through DuckDB.",
  },
  { title: "Retrieval", line: "Index documents and query them by similarity." },
  {
    title: "Epistemic ledger",
    line: "Bitemporal claims and beliefs; corrections are new rows.",
  },
  { title: "Graph", line: "A rebuildable projection of the ledger, queryable with Cypher." },
  { title: "Jobs and operations", line: "A queue plus classified failure reporting." },
  { title: "Credential vault", line: "Leases and relays without exposing plaintext." },
  { title: "API keys", line: "Account-wide or workspace-scoped, four real scopes." },
  { title: "MCP server", line: "Twenty-nine tools for hosted agents." },
  {
    title: "Control dashboard",
    line: "Overview, files, gallery, analytics, operations, access, vault.",
  },
];

/** Section 3: sixteen compact capability entries, three columns on desktop. */
export function CapabilityGrid() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8 lg:py-24">
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Everything a project needs, in one place
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Turn on what a workspace needs. Nothing else is provisioned.
          </p>
        </div>

        <dl className="mt-10 grid gap-x-8 gap-y-7 sm:mt-12 md:grid-cols-2 lg:grid-cols-3 lg:gap-x-10">
          {CAPABILITIES.map((item) => (
            <div key={item.title} className="border-t border-border pt-4">
              <dt className="font-display text-sm font-semibold text-foreground">{item.title}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.line}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
