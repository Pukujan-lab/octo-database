import { Button } from "@/components/ui/button";
import { ARCHITECTURE_URL } from "./links";

const WALLS = [
  {
    title: "Isolate the blast radius",
    body: "Every workspace provisions its own PostgreSQL database with its own role. Agents query it through the HTTP surface, so a raw connection string never reaches the model.",
    tags: ["SQL surface", "File storage", "Shares"],
  },
  {
    title: "Keep deletion human",
    body: "Destructive operations require a confirmation secret bound to a human factor. Vault credentials stay behind a relay, so a working key is never handed to the model.",
    tags: ["API keys", "Vault relay", "Audit log"],
  },
  {
    title: "Move compute off the control plane",
    body: "DuckDB runs ephemerally against Parquet objects in object storage. Hybrid retrieval fuses a lexical arm and a vector arm over 1024-dimensional embeddings, so a heavy query or a hard search cannot take the control plane down.",
    tags: ["Analytics", "Hybrid RAG", "Graph projection", "MCP"],
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
              A pager at 2:00 AM. A cross-tenant read. A table that no longer exists. Your
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
