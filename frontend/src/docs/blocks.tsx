import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** A copy button that reports success only after the clipboard actually took the
 *  text, and falls back to a hidden textarea on an insecure origin where
 *  `navigator.clipboard` is undefined. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback((next: "copied" | "failed") => {
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  }, []);

  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        if (!ok) throw new Error("execCommand copy refused");
      }
      flash("copied");
    } catch {
      flash("failed");
    }
  }, [flash, text]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={state === "copied" ? "Copied" : label}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {state === "copied" ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      <span>{state === "copied" ? "Copied" : state === "failed" ? "Press ⌘C" : label}</span>
    </button>
  );
}

/** A fenced code block with a language tag and a copy affordance. */
export function CodeBlock({
  code,
  label,
  caption,
}: {
  code: string;
  /** Shown in the top-right, e.g. "bash" or "HTTP". */
  label?: string;
  caption?: string;
}) {
  const trimmed = code.replace(/^\n+|\n+$/g, "");
  return (
    <figure className="my-5 overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {label ?? "shell"}
        </span>
        <CopyButton text={trimmed} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{trimmed}</code>
      </pre>
      {caption ? (
        <figcaption className="border-t border-border/70 bg-background/40 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** A two-column request/response pair: what you send, what comes back. */
export function Exchange({
  request,
  response,
  requestLabel = "Request",
  responseLabel = "Response",
}: {
  request: { code: string; label?: string; caption?: string };
  response: { code: string; label?: string; caption?: string };
  requestLabel?: string;
  responseLabel?: string;
}) {
  return (
    <div className="my-5 grid gap-3 lg:grid-cols-2">
      <div>
        <p className="eyebrow mb-1.5">{requestLabel}</p>
        <CodeBlock code={request.code} label={request.label ?? "HTTP"} caption={request.caption} />
      </div>
      <div>
        <p className="eyebrow mb-1.5">{responseLabel}</p>
        <CodeBlock code={response.code} label={response.label ?? "JSON"} caption={response.caption} />
      </div>
    </div>
  );
}

type Method = "GET" | "POST" | "PATCH" | "DELETE" | "ANY";

const METHOD_TONE: Record<Method, string> = {
  GET: "border-info/40 bg-info/10 text-info",
  POST: "border-primary/40 bg-primary/10 text-primary",
  PATCH: "border-warning/40 bg-warning/10 text-warning",
  DELETE: "border-destructive/40 bg-destructive/10 text-destructive",
  ANY: "border-border bg-muted text-muted-foreground",
};

export function MethodChip({ method }: { method: Method }) {
  return (
    <span
      className={cn(
        "inline-flex w-[3.4rem] shrink-0 justify-center rounded border py-0.5 font-mono text-[10px] font-semibold leading-normal",
        METHOD_TONE[method],
      )}
    >
      {method}
    </span>
  );
}

export interface EndpointRow {
  action?: string;
  method: Method;
  path: string;
  scope?: string;
  role?: string;
  summary: string;
}

/** The endpoint table. One row per call, verb first so the column scans. */
export function EndpointTable({ rows }: { rows: EndpointRow[] }) {
  return (
    <div className="my-5 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[42rem] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/60">
            <th className="px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Call
            </th>
            <th className="px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Path
            </th>
            <th className="px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Needs
            </th>
            <th className="px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Does
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.method} ${row.path}`} className="border-b border-border/60 last:border-b-0">
              <td className="px-3 py-2.5 align-top">
                {row.action ? (
                  <code className="font-mono text-[11px] text-foreground">{row.action}</code>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2.5 align-top">
                <div className="flex items-start gap-2">
                  <MethodChip method={row.method} />
                  <code className="break-all font-mono text-[11px] text-foreground">{row.path}</code>
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 align-top text-[11px] text-muted-foreground">
                {[row.scope, row.role].filter(Boolean).join(" · ") || "—"}
              </td>
              <td className="px-3 py-2.5 align-top leading-relaxed text-muted-foreground">{row.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A data table that stacks into labelled cards below `sm`.
 *
 *  A three-column table cannot fit a 390px screen without horizontal scrolling,
 *  and a scrolled-off column is a column nobody reads. Below `sm` each row becomes
 *  its own block with the column label beside the value, so nothing is hidden. */
export function Table({
  columns,
  rows,
  minWidth = "34rem",
}: {
  columns: { key: string; label: string }[];
  rows: Record<string, React.ReactNode>[];
  minWidth?: string;
}) {
  return (
    <>
      <div className="my-5 hidden overflow-x-auto rounded-lg border border-border sm:block">
        <table className="w-full border-collapse text-left text-xs" style={{ minWidth }}>
          <thead>
            <tr className="border-b border-border bg-muted/60">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-border/60 last:border-b-0">
                {columns.map((column) => (
                  <td key={column.key} className="px-3 py-2.5 align-top leading-relaxed text-muted-foreground">
                    {row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="my-5 space-y-2 sm:hidden">
        {rows.map((row, index) => (
          <div key={index} className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            {columns.map((column) => (
              <div key={column.key} className="flex gap-2 py-0.5 text-xs">
                <span className="w-[4.5rem] shrink-0 font-display text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
                  {column.label}
                </span>
                <span className="min-w-0 flex-1 leading-relaxed text-muted-foreground">{row[column.key]}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/** A callout. `tone` picks the accent bar; the body stays prose. */
export function Callout({
  children,
  tone = "note",
  title,
}: {
  children: React.ReactNode;
  tone?: "note" | "warning" | "rule";
  title?: string;
}) {
  const accent =
    tone === "warning" ? "border-l-warning" : tone === "rule" ? "border-l-destructive" : "border-l-primary";
  return (
    <aside className={cn("my-5 rounded-r-lg border border-l-2 border-border bg-muted/40 px-4 py-3", accent)}>
      {title ? <p className="mb-1 text-xs font-semibold text-foreground">{title}</p> : null}
      <div className="text-xs leading-relaxed text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.95em] [&_code]:text-foreground [&_strong]:text-foreground">
        {children}
      </div>
    </aside>
  );
}

/** The heading block every page opens with. */
export function PageHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: string;
  title: string;
  lead: React.ReactNode;
}) {
  return (
    <header className="mb-10 border-b border-border pb-7">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{lead}</p>
    </header>
  );
}

/** A section heading. The id is the anchor the "on this page" rail links to. */
export function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-12 scroll-mt-24 border-b border-border/60 pb-2 font-display text-xl font-semibold tracking-tight first:mt-0"
    >
      {children}
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="mt-8 scroll-mt-24 font-display text-sm font-semibold tracking-tight">
      {children}
    </h3>
  );
}

/** A numbered step, for procedural pages. */
export function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 first:mt-0">
      <div className="flex items-baseline gap-3">
        <span className="num shrink-0 text-[11px] text-primary">{String(n).padStart(2, "0")}</span>
        <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="mt-3 border-l border-border pl-6">{children}</div>
    </section>
  );
}

/** Inline prose, kept to one rhythm so every page reads the same. */
export function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

export function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
}

export function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-border">
      {children}
    </ul>
  );
}
