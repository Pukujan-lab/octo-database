import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { Hexagon } from "lucide-react";
import { ThemeControls } from "@/components/portal/ThemeControls";
import { useTheme } from "@/hooks/useTheme";
import { REPOSITORY_URL } from "@/components/landing/links";
import guide from "../../../docs/consuming-octo.md?raw";

/** The source uses CRLF; normalise once so heading regexes and the outline agree. */
const GUIDE = guide.replace(/\r\n/g, "\n");

/** The headings the page builds its sidebar from, in document order. */
function outline(markdown: string): { id: string; text: string; depth: 2 | 3 }[] {
  const entries: { id: string; text: string; depth: 2 | 3 }[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    entries.push({ id: slug(text), text, depth: match[1].length as 2 | 3 });
  }
  return entries;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    // A leading digit is a legal HTML id but not a legal CSS selector, so the
    // anchors could not be resolved with querySelector.
    .replace(/^(\d)/, "s-$1");
}

/** `/docs` — the integration guide as a page, rendered from the repository's own
 *  markdown so it cannot drift from the source an agent would read. */
export function DocsPage() {
  const theme = useTheme();
  const headings = useMemo(() => outline(GUIDE), []);
  const title = useMemo(() => {
    const first = /^#\s+(.*)$/m.exec(GUIDE);
    return first ? first[1].replace(/\s+—\s+.*$/, "") : "Integration guide";
  }, []);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5">
            <Hexagon className="h-5 w-5 text-foreground" strokeWidth={1.5} />
            <span className="font-display text-sm font-semibold uppercase tracking-[0.16em]">
              Octo
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span className="text-sm text-muted-foreground">Docs</span>
          </Link>
          <div className="flex items-center gap-4">
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Repository
            </a>
            <ThemeControls
              design={theme.design}
              onDesign={theme.setDesign}
              isDark={theme.isDark}
              onToggle={theme.toggleVariant}
              compact
            />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14 lg:py-16">
        <nav aria-label="On this page" className="hidden lg:block">
          <div className="sticky top-24 space-y-1 border-l border-border pl-4">
            <p className="eyebrow pb-2">On this page</p>
            {headings.map((heading) => (
              <a
                key={heading.id}
                href={`#${heading.id}`}
                className={
                  heading.depth === 2
                    ? "block py-1 text-xs leading-snug text-muted-foreground transition-colors hover:text-foreground"
                    : "block py-1 pl-3 text-xs leading-snug text-muted-foreground/80 transition-colors hover:text-foreground"
                }
              >
                {heading.text}
              </a>
            ))}
          </div>
        </nav>

        <article className="min-w-0">
          <p className="eyebrow">Integration guide</p>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {title}
          </h1>

          <div className="prose prose-sm mt-8 max-w-none dark:prose-invert prose-headings:font-display prose-headings:tracking-tight prose-h2:mt-12 prose-h2:text-xl prose-h3:mt-8 prose-h3:text-base prose-p:leading-relaxed prose-p:text-muted-foreground prose-li:text-muted-foreground prose-strong:text-foreground prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.8em] prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-pre:text-foreground prose-a:text-primary prose-a:underline-offset-4 prose-table:text-sm prose-th:font-display prose-th:text-[11px] prose-th:uppercase prose-th:tracking-[0.12em] prose-th:text-muted-foreground prose-hr:border-border">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: () => null,
                h2: ({ children }) => <h2 id={slug(textOf(children))}>{children}</h2>,
                h3: ({ children }) => <h3 id={slug(textOf(children))}>{children}</h3>,
                pre: ({ children }) => (
                  <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 font-mono text-xs leading-relaxed text-foreground">
                    {children}
                  </pre>
                ),
                a: ({ href, children }) => {
                  const external = href?.startsWith("http");
                  return (
                    <a
                      href={href}
                      target={external ? "_blank" : undefined}
                      rel={external ? "noreferrer" : undefined}
                      className="text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:decoration-primary"
                    >
                      {children}
                    </a>
                  );
                },
              }}
            >
              {GUIDE}
            </ReactMarkdown>
          </div>

          <div className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-6 text-xs text-muted-foreground">
            <Link to="/" className="transition-colors hover:text-foreground">
              ← Back to Octo
            </Link>
            <a
              href={`${REPOSITORY_URL}/blob/main/docs/consuming-octo.md`}
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              View the source on GitHub
            </a>
          </div>
        </article>
      </div>
    </div>
  );
}

/** Flattens heading children to the text its id is derived from. */
function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}
