const STEPS = [
  { title: "Mint a workspace key", code: "POST /api/keys" },
  { title: "Provision a workspace", code: "POST /api/workspaces" },
  { title: "Run SQL on its own database", code: "POST /api/workspaces/<id>/query" },
  { title: "Publish a file to a stable URL", code: "POST /api/files/<id>/publish" },
  { title: "Ask a named analytical question", code: "POST /api/workspaces/<id>/analytics/queries" },
];

/** Section 2: the five-call trace, drawn as a rail rather than five cards. */
export function StepTrace() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8 lg:py-24">
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            One API, from empty to useful
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            A workspace-scoped key does the rest. No connection string, no per-project
            infrastructure.
          </p>
        </div>

        <ol className="mt-10 max-w-3xl border-l border-border sm:mt-12">
          {STEPS.map((step, index) => (
            <li key={step.code} className="relative min-w-0 pb-8 pl-8 last:pb-0 sm:pl-10">
              <span
                className="num absolute left-0 top-0 -translate-x-1/2 bg-background px-1.5 text-xs text-warning"
                aria-hidden="true"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <p className="text-sm font-medium leading-relaxed text-foreground">{step.title}</p>
              <div className="mt-2 min-w-0 max-w-full overflow-x-auto">
                <code className="inline-block whitespace-normal break-words rounded-sm border border-border bg-muted/40 px-3 py-1.5 font-mono text-xs text-muted-foreground sm:whitespace-nowrap">
                  {step.code}
                </code>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
