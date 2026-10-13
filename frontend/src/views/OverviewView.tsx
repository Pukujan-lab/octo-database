import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { StatTile } from "@/components/portal/StatTile";
import { ActivityChart, buildActivitySeries } from "@/components/portal/ActivityChart";
import { EmptyState, ErrorState } from "@/components/portal/EmptyState";
import { NewTextFileDialog } from "@/components/portal/NewTextFileDialog";
import { useFilePicker } from "@/hooks/useFilePicker";
import { errorMessage } from "@/lib/api";
import { formatBytes, formatCount, formatRelative } from "@/lib/format";
import { fileArchiveLabel } from "@/components/portal/file-status";
import type { WorkspaceData } from "@/lib/workspace-data";
import type { Workspace } from "@/lib/types";
import { ArrowUpRight, FilePlus2, FileUp, Images, Workflow } from "lucide-react";
import type { ViewId } from "@/components/portal/AppShell";

export function OverviewView({
  workspace,
  data,
  isGuest,
  onNavigate,
}: {
  workspace: Workspace;
  data: WorkspaceData;
  isGuest: boolean;
  onNavigate: (view: ViewId) => void;
}) {
  const files = data.files.data ?? [];
  const gallery = data.gallery.data ?? [];
  const jobs = data.jobs.data ?? [];
  const activity = data.activity.data ?? [];
  const picker = useFilePicker(workspace.id, () => data.reload());

  const storage = files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);
  const failedJobs = jobs.filter((job) => job.state === "failed").length;
  const series = useMemo(
    () =>
      buildActivitySeries(
        files.map((file) => file.createdAt),
        jobs.map((job) => job.createdAt),
      ),
    [files, jobs],
  );
  const recentFiles = files.slice(0, 5);

  return (
    <div data-testid="view-overview" className="animate-fade-rise space-y-6">
      {picker.input}

      {/* ------------------------------------------------------ welcome panel */}
      <section className="panel relative overflow-hidden">
        <div className="motif-grid motif-grid-fade pointer-events-none absolute inset-0 opacity-[0.07]" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 p-6 sm:p-7 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {workspace.isOwner ? (
                <StatusPill tone="success">owner</StatusPill>
              ) : (
                <StatusPill tone="primary">{workspace.role}</StatusPill>
              )}
              {isGuest ? (
                <StatusPill tone="warning" dot>
                  guest session
                </StatusPill>
              ) : null}
            </div>
            <h2 className="font-display text-2xl font-semibold leading-tight">{workspace.name}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {workspace.description?.trim() ||
                "No description yet — this workspace is your private object store, media gallery and job queue."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={picker.open} disabled={picker.uploading} className="gap-2">
              <FileUp className="h-4 w-4" /> {picker.uploading ? "Uploading…" : "Upload files"}
            </Button>
            <NewTextFileDialog workspaceId={workspace.id} onCreated={data.reload} variant="outline" size="default" />
          </div>
        </div>
      </section>

      {data.failedSections.length ? (
        <div className="panel border-warning/45 bg-warning/8 px-5 py-4">
          <p className="text-sm font-medium text-warning">
            Could not load {data.failedSections.join(", ")} for this workspace
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The figures below only cover sections that responded. Retry from the failing panel, or
            reselect the workspace.
          </p>
        </div>
      ) : null}

      {/* --------------------------------------------------------- stat tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Recorded storage"
          value={formatBytes(storage)}
          tone="primary"
          series={series.map((point) => point.files)}
          showTrend
          detail={`${formatCount(files.length)} object${files.length === 1 ? "" : "s"} in this workspace`}
        />
        <StatTile
          label="Files"
          value={formatCount(files.length)}
          tone="info"
          series={series.map((point) => point.files)}
          detail={data.files.isError ? "Files request failed" : "Catalog served from the object store"}
        />
        <StatTile
          label="Media"
          value={formatCount(gallery.length)}
          tone="default"
          series={series.map((point) => point.jobs)}
          detail="Images and video in the gallery index"
        />
        <StatTile
          label="Failed jobs"
          value={formatCount(failedJobs)}
          tone={failedJobs > 0 ? "danger" : "success"}
          series={series.map((point) => point.jobs)}
          detail={
            failedJobs > 0 ? (
              <button
                type="button"
                onClick={() => onNavigate("operations")}
                className="inline-flex items-center gap-1 font-medium text-destructive underline-offset-4 hover:underline"
              >
                Review in Operations <ArrowUpRight className="h-3 w-3" />
              </button>
            ) : (
              "Queue is clean"
            )
          }
        />
      </div>

      {/* -------------------------------------------------------------- chart */}
      <Panel
        eyebrow="Signal"
        title="Workspace activity over time"
        action={<span className="text-xs text-muted-foreground">Files added and jobs enqueued · last 14 days</span>}
      >
        {data.files.isError && data.jobs.isError ? (
          <ErrorState detail="The activity series could not be built because files and jobs both failed to load." />
        ) : (
          <ActivityChart series={series} />
        )}
      </Panel>

      {/* ------------------------------------------------------- catalog + media */}
      <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
        <Panel
          eyebrow="Catalog"
          title="File Catalog"
          action={
            <Button variant="ghost" size="sm" onClick={() => onNavigate("files")} className="gap-1 text-xs">
              View all files <ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
          }
          bodyClassName="min-h-[220px]"
        >
          {data.files.isError ? (
            <ErrorState
              title="Could not load files"
              detail={errorMessage(data.files.error)}
              onRetry={() => data.files.refetch()}
            />
          ) : data.files.isPending ? (
            <div className="space-y-2 p-5">
              {[0, 1, 2].map((row) => (
                <div key={row} className="h-10 w-full animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : recentFiles.length === 0 ? (
            <EmptyState
              title="No files yet"
              description="Upload an object or create a text file and it appears here immediately."
              action={
                <Button size="sm" onClick={picker.open} className="gap-2">
                  <FileUp className="h-4 w-4" /> Upload files
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="hidden sm:table-cell">Type</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th className="hidden md:table-cell">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {recentFiles.map((file) => {
                    const status = fileArchiveLabel(file.archiveState);
                    return (
                      <tr key={file.id}>
                        <td className="max-w-[240px] truncate font-medium">{file.name}</td>
                        <td className="num hidden max-w-[160px] truncate text-xs text-muted-foreground sm:table-cell">
                          {file.mimeType}
                        </td>
                        <td className="num whitespace-nowrap text-xs">{formatBytes(file.sizeBytes)}</td>
                        <td>
                          <StatusPill tone={status.tone}>{status.label}</StatusPill>
                        </td>
                        <td className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                          {formatRelative(file.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          eyebrow="Media"
          title="Gallery"
          action={
            <Button variant="ghost" size="sm" onClick={() => onNavigate("gallery")} className="gap-1 text-xs">
              Browse <ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
          }
          bodyClassName="min-h-[220px]"
        >
          {data.gallery.isError ? (
            <ErrorState
              title="Could not load media"
              detail={errorMessage(data.gallery.error)}
              onRetry={() => data.gallery.refetch()}
            />
          ) : gallery.length === 0 ? (
            <EmptyState
              motif="media"
              title="No media indexed"
              description="Images and video uploaded to this workspace show up here as thumbnails."
              action={
                <Button size="sm" variant="outline" onClick={picker.open} className="gap-2">
                  <Images className="h-4 w-4" /> Add media
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 p-5 sm:grid-cols-3">
              {gallery.slice(0, 3).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate("gallery")}
                  className="group relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-muted"
                  title={item.name}
                >
                  <img
                    src={item.thumbnailUrl}
                    alt={item.name}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]"
                  />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-background/90 to-transparent px-2 pb-1.5 pt-6 text-left text-[11px] font-medium">
                    {item.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        eyebrow="Trace"
        title="Recent activity"
        action={
          <Button variant="ghost" size="sm" onClick={() => onNavigate("operations")} className="gap-1 text-xs">
            <Workflow className="h-3.5 w-3.5" /> Operations
          </Button>
        }
        bodyClassName="min-h-[160px]"
      >
        {data.activity.isError ? (
          <ErrorState
            title="Could not load activity"
            detail={errorMessage(data.activity.error)}
            onRetry={() => data.activity.refetch()}
          />
        ) : activity.length === 0 ? (
          <EmptyState
            motif="ops"
            title="No activity recorded"
            description="Every upload, archive transition and job state change is written here."
            action={
              <Button size="sm" variant="outline" onClick={() => onNavigate("files")} className="gap-2">
                <FilePlus2 className="h-4 w-4" /> Add a file
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {activity.slice(0, 6).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                <StatusPill tone="muted" className="shrink-0">
                  {entry.eventType}
                </StatusPill>
                <span className="min-w-0 flex-1 truncate text-sm">{entry.summary}</span>
                <span className="num shrink-0 text-[11px] text-muted-foreground">{formatRelative(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
