import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { EmptyState } from "@/components/portal/EmptyState";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { Hexagon, Play } from "lucide-react";
import type { GalleryItem, PublicShare } from "@/lib/types";

/** §9 — standalone, read-only share viewer. No shell, no bearer token, no
 *  workspace data: anyone holding the link can open it. */
export function PublicShareViewer({ themeControls }: { themeControls?: React.ReactNode }) {
  const params = useParams();
  // The `*` splat catches tokens that themselves contain slashes.
  const token = decodeURIComponent(params.splat ?? "");
  const [preview, setPreview] = useState<GalleryItem | null>(null);

  const query = useQuery({
    queryKey: ["public-share", token],
    enabled: Boolean(token),
    retry: false,
    queryFn: () => api.get<PublicShare>(`/api/public/shares/${encodeURIComponent(token)}`, { authMode: "public" }),
  });

  const items = query.data?.items ?? [];
  const share = query.data?.share ?? null;
  const unavailable = !token || Boolean(query.isError) || (!query.isPending && !query.data);
  const totalBytes = useMemo(() => items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0), [items]);

  return (
    <div data-testid="public-share-viewer" className="relative min-h-dvh overflow-hidden bg-background text-foreground">
      <div className="motif-grid motif-grid-fade pointer-events-none absolute inset-x-0 top-0 h-[320px] opacity-40" aria-hidden="true" />
      <div className="motif-glow pointer-events-none absolute inset-x-0 top-0 h-[320px]" aria-hidden="true" />

      <div className="relative mx-auto w-full max-w-6xl px-5 py-6 sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/12 ring-1 ring-primary/30">
              <Hexagon className="h-4 w-4 text-primary" strokeWidth={1.9} />
            </span>
            <div className="leading-tight">
              <p className="font-display text-[13px] font-semibold uppercase tracking-[0.18em]">Octo</p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">shared gallery</p>
            </div>
          </div>
          {themeControls}
        </header>

        <main className="py-8">
          {query.isPending && token ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="aspect-[4/3] w-full rounded-md" />
              ))}
            </div>
          ) : unavailable ? (
            <Panel>
              <EmptyState
                motif="media"
                title="This link is not available"
                description="The share was revoked, has expired, or the token is wrong. Ask the workspace owner for a fresh link."
              />
            </Panel>
          ) : (
            <div className="space-y-6">
              <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="space-y-1.5">
                  <p className="eyebrow">Public share</p>
                  <h1 className="font-display text-xl font-semibold">{share?.resourceType ?? "gallery"} · read-only</h1>
                  <p className="text-sm text-muted-foreground">
                    {items.length} item{items.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone="primary">{share?.permission ?? "read"}</StatusPill>
                  <StatusPill tone={share?.validUntil ? "warning" : "muted"} dot>
                    {share?.validUntil ? `expires ${formatDateTime(share.validUntil)}` : "No expiry (revocable)"}
                  </StatusPill>
                </div>
              </div>

              {items.length === 0 ? (
                <Panel>
                  <EmptyState
                    motif="media"
                    title="Nothing shared here yet"
                    description="The owner has not added media to this workspace's gallery."
                  />
                </Panel>
              ) : (
                <div data-testid="gallery-grid" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setPreview(item)}
                      className="panel group relative overflow-hidden p-0 text-left transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lifted"
                    >
                      <span className="relative block aspect-[4/3] overflow-hidden rounded-t-lg bg-muted">
                        <img
                          src={item.thumbnailUrl}
                          alt={item.name}
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]"
                        />
                        {item.kind === "video" ? (
                          <span className="absolute inset-0 flex items-center justify-center">
                            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-background/80 ring-1 ring-border">
                              <Play className="ml-0.5 h-5 w-5 text-primary" />
                            </span>
                          </span>
                        ) : null}
                      </span>
                      <span className="block space-y-1 px-3 py-2.5">
                        <span className="block truncate text-sm font-medium">{item.name}</span>
                        <span className="num block truncate text-[11px] text-muted-foreground">
                          {formatBytes(item.sizeBytes)} · {formatDateTime(item.createdAt)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>

        <footer className="border-t border-border pt-5 text-xs text-muted-foreground">
          Read-only view served by Octo. Nothing on this page can modify the workspace.
        </footer>
      </div>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          {preview ? (
            <>
              <DialogHeader>
                <DialogTitle className="sr-only">{preview.name}</DialogTitle>
                <DialogDescription className="sr-only">Shared media preview</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="overflow-hidden rounded-md border border-border bg-muted">
                  {preview.kind === "video" ? (
                    <video src={preview.fullUrl} controls className="max-h-[60vh] w-full bg-background" />
                  ) : (
                    <img src={preview.fullUrl} alt={preview.name} className="max-h-[60vh] w-full object-contain" />
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-display text-sm font-semibold">{preview.name}</p>
                    <p className="num truncate text-xs text-muted-foreground">
                      {preview.mimeType} · {formatBytes(preview.sizeBytes)}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setPreview(null)}>
                    Close
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
