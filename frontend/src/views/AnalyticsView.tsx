import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { StatTile } from "@/components/portal/StatTile";
import { EmptyState, ErrorState } from "@/components/portal/EmptyState";
import { errorMessage } from "@/lib/api";
import { formatCount, formatDate, shortId } from "@/lib/format";
import { jobStateTone } from "@/components/portal/file-status";
import { useAnalyticsRows, useAnalyticsRuns, useDatasets, useHealth } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { AnalyticsRunSummary, DatasetSummary } from "@/lib/types";
import { ChartColumn, Database, Layers, RefreshCw, Table2 } from "lucide-react";

/** §9 — the DuckDB + Parquet lake: engine status, the workspace's registered
 *  datasets, its recent `analytics_query` runs, and the rows of one result. */
export function AnalyticsView({ workspaceId }: { workspaceId: string }) {
  const health = useHealth();
  const datasetsQuery = useDatasets(workspaceId);
  const runsQuery = useAnalyticsRuns(workspaceId);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const datasets = datasetsQuery.data?.datasets ?? [];
  const runs = runsQuery.data?.runs ?? [];

  // Newest first, whatever order the endpoint answered with.
  const orderedRuns = useMemo(
    () => [...runs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [runs],
  );

  const selectedRun = orderedRuns.find((run) => run.jobId === selectedJobId) ?? null;
  const resultId = selectedRun?.resultId ?? null;
  const rowsQuery = useAnalyticsRows(workspaceId, resultId);

  // Open the newest completed result on first paint, and fall back to it if the
  // selected run drops out of a refreshed list.
  useEffect(() => {
    if (!runsQuery.data) return;
    if (selectedJobId && orderedRuns.some((run) => run.jobId === selectedJobId)) return;
    const newest = orderedRuns.find((run) => run.state === "completed" && run.resultId);
    setSelectedJobId(newest?.jobId ?? null);
  }, [runsQuery.data, orderedRuns, selectedJobId]);

  const totalParts = datasets.reduce((sum, dataset) => sum + (dataset.partCount || 0), 0);
  const totalRows = datasets.reduce((sum, dataset) => sum + (dataset.rowCount || 0), 0);
  const refreshing = datasetsQuery.isFetching || runsQuery.isFetching || rowsQuery.isFetching;
  const datasetsReady = !datasetsQuery.isPending && !datasetsQuery.isError;

  function refresh() {
    void datasetsQuery.refetch();
    void runsQuery.refetch();
    if (resultId) void rowsQuery.refetch();
  }

  const analytics = health.data?.analytics;

  return (
    <div data-testid="view-analytics" className="animate-fade-rise space-y-6">
      <EngineStrip
        pending={health.isPending}
        failed={health.isError}
        analytics={analytics}
        refreshing={refreshing}
        onRefresh={refresh}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Datasets"
          value={datasetsReady ? formatCount(datasets.length) : "—"}
          tone="primary"
          icon={<Database className="h-4 w-4" />}
          detail={
            datasetsQuery.isError
              ? "Datasets request failed"
              : "Logical datasets registered in this workspace"
          }
        />
        <StatTile
          label="Parts"
          value={datasetsReady ? formatCount(totalParts) : "—"}
          tone="info"
          icon={<Layers className="h-4 w-4" />}
          detail="Parquet parts across the lake"
        />
        <StatTile
          label="Rows"
          value={datasetsReady ? formatCount(totalRows) : "—"}
          tone="default"
          icon={<Table2 className="h-4 w-4" />}
          detail="Rows in each dataset's latest version"
        />
      </div>

      <Panel
        eyebrow="Lake"
        title="Datasets"
        action={<StatusPill tone="muted">{formatCount(datasets.length)}</StatusPill>}
        bodyClassName="min-h-[180px]"
      >
        {datasetsQuery.isError ? (
          <ErrorState
            title="Could not load datasets"
            detail={errorMessage(datasetsQuery.error)}
            onRetry={() => void datasetsQuery.refetch()}
          />
        ) : datasetsQuery.isPending ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-12 w-full" />
            ))}
          </div>
        ) : datasets.length === 0 ? (
          <EmptyState
            motif="ops"
            title="No datasets registered"
            description="Datasets are registered through the API or the MCP register_dataset tool."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Version</th>
                  <th className="text-right">Rows</th>
                  <th className="text-right">Parts</th>
                  <th>Watermark</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {datasets.map((dataset) => (
                  <DatasetRow key={dataset.datasetId} dataset={dataset} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        eyebrow="Queries"
        title="Recent runs"
        action={<StatusPill tone="muted">{formatCount(runs.length)}</StatusPill>}
        bodyClassName="min-h-[180px]"
      >
        {runsQuery.isError ? (
          <ErrorState
            title="Could not load analytics runs"
            detail={errorMessage(runsQuery.error)}
            onRetry={() => void runsQuery.refetch()}
          />
        ) : runsQuery.isPending ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-12 w-full" />
            ))}
          </div>
        ) : orderedRuns.length === 0 ? (
          <EmptyState
            motif="ops"
            title="No analytics runs yet"
            description="A run starts when a named query is submitted through the API or MCP."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Query</th>
                  <th className="text-right">Rows</th>
                  <th className="hidden md:table-cell">Created</th>
                  <th className="hidden lg:table-cell">Completed</th>
                  <th className="text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {orderedRuns.map((run) => (
                  <RunRow
                    key={run.jobId}
                    run={run}
                    selected={run.jobId === selectedJobId}
                    onSelect={() => setSelectedJobId(run.jobId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ResultPanel
        run={selectedRun}
        rowsQuery={rowsQuery}
        onRetry={() => void rowsQuery.refetch()}
      />
    </div>
  );
}

/** The health endpoint reports the engine slug (`duckdb`) and a version that may
 *  already carry its own `v` (`v1.5.6`), so the label is assembled defensively. */
function engineName(engine: string): string {
  if (!engine) return "";
  const known: Record<string, string> = { duckdb: "DuckDB" };
  return known[engine.toLowerCase()] ?? engine.charAt(0).toUpperCase() + engine.slice(1);
}

function engineVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function EngineStrip({
  pending,
  failed,
  analytics,
  refreshing,
  onRefresh,
}: {
  pending: boolean;
  failed: boolean;
  analytics: { configured: boolean; engine: string; version: string | null } | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const engineLabel = analytics?.engine
    ? [engineName(analytics.engine), engineVersion(analytics.version)].filter(Boolean).join(" ")
    : "—";

  const note = pending
    ? "Reading the engine configuration from the health endpoint…"
    : failed
      ? "The portal could not read engine status, so the state of the lake is unknown."
      : !analytics
        ? "This server's health endpoint does not report an analytics engine, so the state of the lake is unknown."
        : analytics.configured
          ? "Queries run against the workspace lake: DuckDB reads the Parquet parts each registered dataset writes."
          : "The lake is unavailable on this server. Dataset registration and queries answer 503.";

  return (
    <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
      <span className="flex items-center gap-2">
        <ChartColumn className="h-4 w-4 text-primary" />
        <span className="eyebrow">Analytics engine</span>
      </span>

      {pending ? (
        <Skeleton className="h-5 w-24" />
      ) : failed ? (
        <StatusPill tone="danger" dot>
          status unknown
        </StatusPill>
      ) : !analytics ? (
        <StatusPill tone="muted" dot>
          not reported
        </StatusPill>
      ) : analytics.configured ? (
        <StatusPill tone="success" dot>
          configured
        </StatusPill>
      ) : (
        <StatusPill tone="warning" dot>
          not configured
        </StatusPill>
      )}

      <span className="num text-xs text-foreground/80">{engineLabel}</span>

      <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{note}</p>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        disabled={refreshing}
        className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  );
}

function DatasetRow({ dataset }: { dataset: DatasetSummary }) {
  return (
    <tr>
      <td>
        <div className="max-w-[260px] space-y-0.5">
          <p className="truncate font-medium">{dataset.name}</p>
          <p className="num truncate text-[11px] text-muted-foreground">{dataset.dataset}</p>
        </div>
      </td>
      <td>
        <div className="space-y-0.5">
          <p className="num whitespace-nowrap text-xs font-semibold">v{dataset.latestVersion}</p>
          <p className="whitespace-nowrap text-[11px] text-muted-foreground">
            {formatCount(dataset.versionCount)}{" "}
            {dataset.versionCount === 1 ? "version" : "versions"}
          </p>
        </div>
      </td>
      <td className="num whitespace-nowrap text-right text-xs">{formatCount(dataset.rowCount)}</td>
      <td className="num whitespace-nowrap text-right text-xs">{formatCount(dataset.partCount)}</td>
      <td className="whitespace-nowrap text-xs text-muted-foreground">
        {dataset.watermark ? formatDate(dataset.watermark) : "—"}
      </td>
      <td className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDate(dataset.createdAt)}
      </td>
    </tr>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: AnalyticsRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const hasResult = run.state === "completed" && Boolean(run.resultId);

  return (
    <tr
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
      tabIndex={0}
      aria-selected={selected}
      className={cn("cursor-pointer", selected && "bg-accent/60")}
    >
      <td>
        <StatusPill tone={jobStateTone(run.state)} dot>
          {run.state}
        </StatusPill>
      </td>
      <td>
        <div className="max-w-[280px] space-y-0.5">
          <p className="truncate text-xs font-medium">{run.querySpec ?? "—"}</p>
          <p className="num truncate text-[11px] text-muted-foreground">
            {run.datasetVersionId ? shortId(run.datasetVersionId, 10) : "—"}
          </p>
        </div>
      </td>
      <td className="num whitespace-nowrap text-right text-xs">
        {run.rowCount === null || run.rowCount === undefined ? "—" : formatCount(run.rowCount)}
      </td>
      <td className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
        {formatDate(run.createdAt)}
      </td>
      <td className="hidden whitespace-nowrap text-xs text-muted-foreground lg:table-cell">
        {formatDate(run.completedAt)}
      </td>
      <td className="text-right">
        {hasResult ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            View result
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function ResultPanel({
  run,
  rowsQuery,
  onRetry,
}: {
  run: AnalyticsRunSummary | null;
  rowsQuery: ReturnType<typeof useAnalyticsRows>;
  onRetry: () => void;
}) {
  const artifact = rowsQuery.data;
  const querySpec = artifact?.querySpec ?? run?.querySpec ?? null;
  const artifactRows = artifact?.rowCount ?? run?.rowCount ?? null;
  const renderable = Boolean(artifact && artifact.columns.length && artifact.rows.length);

  return (
    <Panel
      eyebrow="Artifact"
      title={
        querySpec ? (
          <span className="num text-[13px] font-medium" title={querySpec}>
            {querySpec}
          </span>
        ) : (
          "Result"
        )
      }
      action={
        run ? (
          <StatusPill tone={jobStateTone(run.state)}>{run.state}</StatusPill>
        ) : (
          <StatusPill tone="muted">no run selected</StatusPill>
        )
      }
      bodyClassName="min-h-[200px]"
      footer={
        artifact?.truncated && renderable ? (
          <p className="text-xs text-muted-foreground">
            Showing the first <span className="num">{formatCount(artifact.rows.length)}</span> of{" "}
            <span className="num">{formatCount(artifact.rowCount)}</span> rows
          </p>
        ) : undefined
      }
    >
      {run ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-b border-border bg-muted/40 px-5 py-2.5">
          <Meta label="rows" value={artifactRows === null ? "—" : formatCount(artifactRows)} />
          <Meta label="hash" value={run.contentHash ? shortId(run.contentHash, 12) : "—"} />
          <Meta label="engine" value={engineVersion(run.engineVersion) ?? "—"} />
        </div>
      ) : null}

      {!run ? (
        <EmptyState
          motif="ops"
          title="No result selected"
          description="Select a completed run from the list above to read the rows it wrote."
        />
      ) : !run.resultId ? (
        <EmptyState
          motif="ops"
          title="No result artifact"
          description={
            run.state === "failed"
              ? (run.errorSummary ??
                "This run failed before it wrote a result. Submit the query again to produce one.")
              : "This run has not written a result yet. Completed runs with a result appear here as rows."
          }
        />
      ) : rowsQuery.isError ? (
        <ErrorState
          title="Could not load this result"
          detail={errorMessage(rowsQuery.error)}
          onRetry={onRetry}
        />
      ) : rowsQuery.isPending ? (
        <div className="space-y-2 p-5">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </div>
      ) : renderable && artifact ? (
        <ResultTable columns={artifact.columns} rows={artifact.rows} />
      ) : (
        <EmptyState
          motif="ops"
          title="No rows in this result"
          description={`The artifact recorded ${formatCount(artifact?.rowCount ?? 0)} rows but returned no columns or cells to display.`}
        />
      )}
    </Panel>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="eyebrow">{label}</span>
      <span className="num text-xs text-foreground">{value}</span>
    </span>
  );
}

function ResultTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} className="whitespace-nowrap">
                {/* Column names come from the query, so they render verbatim
                    rather than in the table's small-caps treatment. */}
                <span className="normal-case tracking-normal">{column}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const cell = formatCell(row[column]);
                return (
                  <td
                    key={column}
                    className={cn(
                      "whitespace-nowrap text-xs",
                      cell.numeric ? "num text-right" : "text-left",
                    )}
                  >
                    <span
                      className="inline-block max-w-[280px] truncate align-bottom"
                      title={cell.title}
                    >
                      {cell.text}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NUMERIC_TEXT = /^[+-]?\d+(?:\.\d+)?$/;
const DATE_TEXT = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/;

/** One result cell, normalized for display: nulls become an em dash, date-like
 *  values lose their time part, and numeric values are flagged for alignment. */
function formatCell(value: unknown): { text: string; numeric: boolean; title?: string } {
  if (value === null || value === undefined) return { text: "—", numeric: false };

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { text: String(value), numeric: true };
    // Group only long counts, so a year-like integer keeps its exact form.
    const text = Number.isInteger(value) && Math.abs(value) >= 10000 ? formatCount(value) : String(value);
    return { text, numeric: true };
  }

  if (typeof value === "boolean") return { text: value ? "true" : "false", numeric: false };
  if (value instanceof Date) return { text: value.toISOString().slice(0, 10), numeric: false };

  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return { text, numeric: false, title: text };
  }

  const text = String(value);
  const date = DATE_TEXT.exec(text.trim());
  if (date) return { text: date[1], numeric: false };

  return { text, numeric: NUMERIC_TEXT.test(text.trim()), title: text };
}
