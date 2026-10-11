import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { EmptyState, ErrorState } from "@/components/portal/EmptyState";
import { useFilePicker } from "@/hooks/useFilePicker";
import { errorMessage } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import type { WorkspaceData } from "@/lib/workspace-data";
import type { GalleryItem } from "@/lib/types";
import { Images, Play, Upload } from "lucide-react";

export function GalleryView({ workspaceId, data }: { workspaceId: string; data: WorkspaceData }) {
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const picker = useFilePicker(workspaceId, () => data.reload());
  const items = data.gallery.data ?? [];

  return (
    <div data-testid="view-gallery" className="animate-fade-rise space-y-6">
      {picker.input}

      <Panel
        eyebrow="Media"
        title="Gallery"
        action={
          <>
            <StatusPill tone="muted">
              {items.length} item{items.length === 1 ? "" : "s"}
            </StatusPill>
            <Button size="sm" onClick={picker.open} disabled={picker.uploading} className="gap-2">
              <Upload className="h-4 w-4" /> {picker.uploading ? "Uploading…" : "Add media"}
            </Button>
          </>
        }
        bodyClassName="min-h-[280px]"
      >
        {data.gallery.isError ? (
          <ErrorState title="Could not load media" detail={errorMessage(data.gallery.error)} onRetry={() => data.gallery.refetch()} />
        ) : data.gallery.isPending ? (
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="aspect-[4/3] w-full rounded-md" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            motif="media"
            title="No media in this workspace"
            description="Images and video are indexed automatically once they are uploaded as files."
            action={
              <Button size="sm" onClick={picker.open} className="gap-2">
                <Images className="h-4 w-4" /> Add media
              </Button>
            }
          />
        ) : (
          <div data-testid="gallery-grid" className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPreview(item)}
                className="panel group relative overflow-hidden p-0 text-left transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lifted focus-visible:-translate-y-0.5"
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
                  <span className="absolute left-2 top-2">
                    <StatusPill tone={item.kind === "video" ? "info" : "primary"}>{item.kind}</StatusPill>
                  </span>
                </span>
                <span className="block space-y-1 px-3 py-2.5">
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="num block truncate text-[11px] text-muted-foreground">
                    {formatBytes(item.sizeBytes)} · {formatDate(item.createdAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          {preview ? (
            <>
              <DialogHeader>
                <DialogTitle className="sr-only">{preview.name}</DialogTitle>
                <DialogDescription className="sr-only">Media preview</DialogDescription>
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
                      {preview.mimeType} · {formatBytes(preview.sizeBytes)} · added {formatDate(preview.createdAt)}
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
