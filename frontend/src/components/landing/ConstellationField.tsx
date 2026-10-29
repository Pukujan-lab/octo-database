import { ConstellationSky } from "./ConstellationSky";

const TRACE = [
  { label: "Mint a workspace key", code: "POST /api/keys" },
  { label: "Provision a workspace", code: "POST /api/workspaces" },
  { label: "Run SQL on its own database", code: "POST /api/workspaces/<id>/query" },
  { label: "Publish a file to a stable URL", code: "POST /api/files/<id>/publish" },
  {
    label: "Ask a named analytical question",
    code: "POST /api/workspaces/<id>/analytics/queries",
  },
];

/** Section 2: the full-bleed band. The canvas carries the spectacle; the copy
 *  column sits on a scrim and stays passive so the sky is never blocked. */
export function ConstellationField() {
  return (
    <section className="relative isolate w-full overflow-hidden border-b border-border bg-background">
      <div className="relative h-[60vh] min-h-[380px] w-full lg:h-[78vh]">
        <ConstellationSky />

        {/* On desktop the copy is a left column, so the scrim runs left to right.
            On a phone the copy sits at the bottom, and a side scrim would wash out
            a third of the sky for nothing. */}
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent lg:bg-gradient-to-r lg:from-background lg:via-background/25 lg:to-transparent"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background via-transparent to-background lg:via-transparent"
          aria-hidden="true"
        />

        <div className="pointer-events-none absolute inset-0">
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col justify-end px-5 py-10 sm:px-8 lg:justify-center">
            <div className="pointer-events-none max-w-md">
              <p className="eyebrow">One workspace, one boundary</p>
              <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight sm:text-3xl lg:text-4xl">
                Every project gets its own plane.
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
                Separate databases. One API in front of all of them.
              </p>

              <ol className="mt-8 hidden max-w-sm border-l border-border/70 lg:block">
                {TRACE.map((step, index) => (
                  <li key={step.code} className="relative pb-5 pl-6 last:pb-0">
                    <span
                      className="num absolute left-0 top-0 -translate-x-1/2 bg-background px-1 text-[11px] text-primary"
                      aria-hidden="true"
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <p className="text-xs leading-relaxed text-foreground">{step.label}</p>
                    <code className="mt-1 block whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                      {step.code}
                    </code>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
