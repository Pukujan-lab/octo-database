import { Button } from "@/components/ui/button";
import { ARCHITECTURE_URL } from "./links";

const WALLS = [
  {
    title: "Isolate the blast radius",
    body: "Every workspace provisions its own PostgreSQL database with its own role. The server authenticates as that role, so an agent reaches the database with an Octo API key alone and no host, port or connection string ever reaches the model. Files can be published one at a time to a stable URL, and archived to a cold tier that restores on demand where a Drive provider is configured; nothing else in the workspace becomes public.",
    tags: ["SQL surface", "Files", "Gallery", "Shares"],
  },
  {
    title: "Keep deletion human",
    body: "Creating or deleting a workspace, minting a key, or widening a key's scopes needs a confirmation secret bound to a human MFA session, so a bare API key cannot do them. The vault relay injects the real credential into an outbound request, so the caller works with a temporary key and never holds the underlying secret. Hosted MCP clients authorize over OAuth 2.1, and the activity feed records what happened in the workspace.",
    tags: ["API keys", "Vault relay", "MFA", "Audit log", "OAuth 2.1"],
  },
  {
    title: "Move compute off the control plane",
    body: "Analytics runs DuckDB ephemerally over Parquet in object storage, and the caller submits a named query spec against a registered dataset version rather than SQL, so the server builds the statement and a request cannot widen the read or inject SQL. Hybrid retrieval fuses a lexical arm and a vector arm over 1024-dimensional embeddings. Documents and entities project into a property graph, claims land in a bitemporal ledger with as-of queries, and background jobs can be listed and retried without loading the control plane.",
    tags: ["Analytics", "Hybrid RAG", "Graph", "Epistemic ledger", "Jobs and ops"],
  },
];

function Beat({
  eyebrow,
  pull,
  children,
}: {
  eyebrow: string;
  pull: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <p className="mt-4 font-display text-2xl font-semibold leading-snug tracking-tight sm:text-3xl lg:text-4xl">
        {pull}
      </p>
      <div className="mt-5 space-y-4 text-sm leading-relaxed text-muted-foreground sm:text-base">
        {children}
      </div>
    </div>
  );
}

/** Section 3: the narrative close. Narrow measure, wide vertical rhythm. */
export function Manifesto() {
  return (
    <section>
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <div className="max-w-[62ch] space-y-20 lg:space-y-28">
          <Beat eyebrow="The status quo" pull="Prompt engineering is not a security model.">
            <p>
              You hand a non-deterministic model a live database connection string, then hope a
              sentence in a system prompt holds. That is not containment. That is a coin flip with
              production data.
            </p>
            <p>
              The ambition is a fleet of agents working through the night. The reality is
              babysitting toddlers with root access.
            </p>
          </Beat>

          <Beat eyebrow="The 2:00 AM" pull="One hallucinated mutation is all it takes.">
            <p>
              A pager at 2:00 AM, a cross-tenant read, a table that no longer exists. Your
              automation is only ever as safe as the surface you let it touch.
            </p>
          </Beat>

          <Beat
            eyebrow="The 9:00 AM"
            pull="They work the night shift. You review the telemetry over coffee."
          >
            <p>
              Agents run at full speed because the walls are structural, not polite. Every
              workspace is a separate PostgreSQL database, reachable only through an MCP-native
              HTTP surface. Destructive operations stop at a confirmation secret bound to a human.
              The same key provisions databases, stores and publishes files, runs analytics,
              retrieves documents and records claims.
            </p>
          </Beat>

          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              Three walls around every agent
            </h2>
            <div className="mt-8 border-t border-border">
              {WALLS.map((wall, index) => (
                <div
                  key={wall.title}
                  className="grid gap-3 border-b border-border py-7 sm:grid-cols-[auto_1fr] sm:gap-6"
                >
                  <span className="num text-[11px] leading-6 text-primary" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3 className="font-display text-base font-semibold">{wall.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{wall.body}</p>
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {wall.tags.map((tag) => (
                        <li
                          key={tag}
                          className="rounded-sm border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {tag}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
              The same surface is exposed to agents over MCP: 29 tools on a Streamable HTTP server
              at /mcp, including create_workspace, provision_database, query_workspace_database,
              upload_file and query_dataset. Hosted clients authorize over OAuth 2.1, and GET
              /api/capabilities returns the full catalogue for the calling credential&apos;s scopes,
              so a client discovers what it may do at runtime rather than from documentation that
              drifts.
            </p>
          </div>
        </div>

        <div className="mt-20 border-y border-border bg-card px-6 py-14 text-center lg:mt-28">
          <p className="font-display text-2xl font-semibold tracking-tight sm:text-3xl lg:text-4xl">
            Take back the wheel.
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
            Run one server. Give every project its own data plane.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4">
            <Button asChild size="lg">
              <a href="#sign-in">Deploy your first isolated workspace</a>
            </Button>
            <a
              href={ARCHITECTURE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
            >
              Read the architecture
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
