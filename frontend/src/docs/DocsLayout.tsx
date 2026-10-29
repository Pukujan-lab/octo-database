import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Hexagon, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeControls } from "@/components/portal/ThemeControls";
import { REPOSITORY_URL } from "@/components/landing/links";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import { DOCS_SECTIONS, docNeighbours, type DocsPageEntry } from "@/docs/nav";

/** The sidebar's page list, shared by the desktop rail and the phone drawer. */
function SidebarNav({ current, onNavigate }: { current: DocsPageEntry; onNavigate?: () => void }) {
  return (
    <nav aria-label="Documentation" className="space-y-7">
      {DOCS_SECTIONS.map((section) => (
        <div key={section.label}>
          <p className="eyebrow mb-2">{section.label}</p>
          <ul className="space-y-0.5 border-l border-border">
            {section.pages.map((page) => {
              const active = page.slug === current.slug;
              return (
                <li key={page.href}>
                  <Link
                    to={page.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "-ml-px block border-l py-1 pl-4 text-[13px] leading-snug transition-colors",
                      active
                        ? "border-primary font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                    )}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Headings the current page rendered, for the "on this page" rail. Read from the
 *  DOM rather than duplicated per page, so a heading can never disagree with its
 *  own anchor. */
function useOutline(articleRef: React.RefObject<HTMLElement | null>, pageKey: string) {
  const [headings, setHeadings] = useState<{ id: string; text: string }[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const found = [...article.querySelectorAll<HTMLElement>("h2[id]")].map((node) => ({
      id: node.id,
      text: node.textContent ?? "",
    }));
    setHeadings(found);
    setActiveId(found[0]?.id ?? "");

    if (found.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-88px 0px -70% 0px", threshold: 0 },
    );
    found.forEach((heading) => {
      const node = document.getElementById(heading.id);
      if (node) observer.observe(node);
    });
    return () => observer.disconnect();
  }, [articleRef, pageKey]);

  return { headings, activeId };
}

/** The docs shell: header, page rail, article, right-hand outline.
 *
 *  The rail collapses into a drawer below `lg` because a 390px screen cannot hold
 *  navigation and prose side by side. */
export function DocsLayout({
  page,
  children,
}: {
  page: DocsPageEntry;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const articleRef = useRef<HTMLElement | null>(null);
  const { headings, activeId } = useOutline(articleRef, page.slug);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { previous, next } = useMemo(() => docNeighbours(page.slug), [page.slug]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [page.slug]);

  const themeControls = (
    <ThemeControls
      design={theme.design}
      onDesign={theme.setDesign}
      isDark={theme.isDark}
      onToggle={theme.toggleVariant}
      compact
    />
  );

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[88rem] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label="Open documentation menu"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground lg:hidden"
                >
                  <Menu className="h-4 w-4" />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[19rem] overflow-y-auto bg-background px-5 py-6">
                <SheetTitle className="sr-only">Documentation</SheetTitle>
                <Link to="/" className="mb-8 flex items-center gap-2.5">
                  <Hexagon className="h-5 w-5 text-foreground" strokeWidth={1.5} />
                  <span className="font-display text-sm font-semibold uppercase tracking-[0.16em]">
                    Octo
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground">
                    /
                  </span>
                  <span className="text-sm text-muted-foreground">Docs</span>
                </Link>
                <SidebarNav current={page} onNavigate={() => setDrawerOpen(false)} />
              </SheetContent>
            </Sheet>

            <Link to="/" className="flex min-w-0 items-center gap-2.5">
              <Hexagon className="hidden h-5 w-5 shrink-0 text-foreground sm:block" strokeWidth={1.5} />
              <span className="whitespace-nowrap font-display text-sm font-semibold uppercase tracking-[0.16em]">
                Octo
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                /
              </span>
              <span className="truncate text-sm text-muted-foreground">Docs</span>
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-3 sm:gap-5">
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              GitHub
            </a>
            {themeControls}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[88rem] px-4 sm:px-6">
        <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_13rem] lg:gap-10">
          <aside className="hidden lg:block">
            <div className="sticky top-[4.25rem] max-h-[calc(100dvh-5.25rem)] overflow-y-auto py-8 pr-2">
              <SidebarNav current={page} />
            </div>
          </aside>

          <main className="min-w-0 py-8 lg:py-10">
            <article ref={articleRef} className="max-w-3xl">
              {children}
            </article>

            <nav aria-label="Pagination" className="mt-14 grid gap-3 border-t border-border pt-6 sm:grid-cols-2">
              {previous ? (
                <Link
                  to={previous.href}
                  className="group flex flex-col gap-1 rounded-lg border border-border px-4 py-3 transition-colors hover:border-primary/50 hover:bg-muted/40"
                >
                  <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    <ArrowLeft className="h-3 w-3" /> Previous
                  </span>
                  <span className="text-sm font-medium text-foreground">{previous.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link
                  to={next.href}
                  className="group flex flex-col gap-1 rounded-lg border border-border px-4 py-3 text-right transition-colors hover:border-primary/50 hover:bg-muted/40 sm:col-start-2"
                >
                  <span className="flex items-center justify-end gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    Next <ArrowRight className="h-3 w-3" />
                  </span>
                  <span className="text-sm font-medium text-foreground">{next.title}</span>
                </Link>
              ) : null}
            </nav>
          </main>

          <aside className="hidden xl:block">
            {headings.length > 1 ? (
              <div className="sticky top-[4.25rem] max-h-[calc(100dvh-5.25rem)] overflow-y-auto py-10">
                <p className="eyebrow mb-2">On this page</p>
                <ul className="space-y-1 border-l border-border">
                  {headings.map((heading) => (
                    <li key={heading.id}>
                      <a
                        href={`#${heading.id}`}
                        className={cn(
                          "-ml-px block border-l py-0.5 pl-3 text-[12px] leading-snug transition-colors",
                          heading.id === activeId
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {heading.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
