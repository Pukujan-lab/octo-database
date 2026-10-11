import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { StatTile } from "@/components/portal/StatTile";
import { EmptyState, ErrorState } from "@/components/portal/EmptyState";
import { ActivityChart, buildActivitySeries } from "@/components/portal/ActivityChart";
import { api, errorMessage } from "@/lib/api";
import { formatCount, formatDateTime, formatRelative } from "@/lib/format";
import { jobStateTone } from "@/components/portal/file-status";
import { useChartColors } from "@/hooks/useChartColors";
import type { WorkspaceData } from "@/lib/workspace-data";
import type { JobRow, OpsSummary } from "@/lib/types";
import { toast } from "@/utils/toast";
import { Activity, CircleSlash2, RotateCw, Timer, Waves } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function OperationsView({ workspaceId, data }: { workspaceId: string; data: WorkspaceData }) {
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [runningPass, setRunningPass] = useState(false);
  const jobs = data.jobs.data ?? [];
  const activity = data.activity.data ?? [];

  const queued = jobs.filter((job) => job.state === "queued").length;
  const failed = jobs.filter((job) => job.state === "failed").length;

  async function retry(jobId: string) {
    setBusyJob(jobId);
    try {
      await api.post<{ success: boolean }>(
        `/api/jobs/${jobId}/retry?workspaceId=${encodeURIComponent(workspaceId)}`,
        {},
      );
      toast.success("Job re-queued");
      data.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyJob(null);
    }
  }

  async function runPass() {
    setRunningPass(true);
    try {
      const result = await api.post<{ outcomes: unknown[] }>(
        `/api/jobs/run?workspaceId=${encodeURIComponent(workspaceId)}`,
        {},
      );
      const touched = Array.isArray(result?.outcomes) ? result.outcomes.length : 0;
      toast.success(
        touched
          ? `Worker pass finished · ${touched} job${touched === 1 ? "" : "s"} touched`
          : "Worker pass finished — nothing to do",
      );
      data.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRunningPass(false);
    }
  }

  return (
    <div data-testid="view-operations" className="animate-fade-rise space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Queued"
          value={formatCount(queued)}
          tone="warning"
          icon={<Timer className="h-4 w-4" />}
          detail="Waiting for a worker pass"
        />
        <StatTile
          label="Failed"
          value={formatCount(failed)}
          tone={failed > 0 ? "danger" : "success"}
          icon={<CircleSlash2 className="h-4 w-4" />}
          detail={failed > 0 ? "Retryable from the jobs table below" : "No failing jobs"}
        />
        <StatTile
          label="Recent jobs"
          value={formatCount(jobs.length)}
          tone="info"
          icon={<Waves className="h-4 w-4" />}
          detail={`${formatCount(activity.length)} activity event${activity.length === 1 ? "" : "s"}`}
        />
      </div>

      <Panel
        eyebrow="Queue"
        title="Jobs"
        action={
          <Button size="sm" variant="outline" onClick={() => void runPass()} disabled={runningPass} className="gap-2">
            <Activity className="h-4 w-4" /> {runningPass ? "Running…" : "Run worker pass"}
          </Button>
        }
        bodyClassName="min-h-[220px]"
      >
        {data.jobs.isError ? (
          <ErrorState title="Could not load jobs" detail={errorMessage(data.jobs.error)} onRetry={() => data.jobs.refetch()} />
        ) : data.jobs.isPending ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-12 w-full" />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState
            motif="ops"
            title="No jobs recorded"
            description="Archive, restore and media processing all land here as jobs you can inspect and retry."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job type</th>
                  <th>State</th>
                  <th>Attempts</th>
                  <th className="hidden md:table-cell">Created</th>
                  <th className="hidden lg:table-cell">Completed</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <JobRowView key={job.id} job={job} busy={busyJob === job.id} onRetry={retry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <FailureAnalysis data={data} summary={data.opsSummary.data} onRetry={retry} busyJob={busyJob} />

      <Panel eyebrow="Trace" title="Recent activity" bodyClassName="min-h-[140px]">
        {data.activity.isError ? (
          <ErrorState title="Could not load activity" detail={errorMessage(data.activity.error)} onRetry={() => data.activity.refetch()} />
        ) : activity.length === 0 ? (
          <EmptyState motif="ops" title="Nothing has happened yet" description="Activity is written as jobs transition between states." />
        ) : (
          <ul className="divide-y divide-border">
            {activity.slice(0, 24).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
                <StatusPill tone="muted" className="shrink-0">
                  {entry.eventType}
                </StatusPill>
                <span className="min-w-0 flex-1 text-sm leading-relaxed">{entry.summary}</span>
                {entry.jobId ? <span className="num text-[11px] text-muted-foreground">job {entry.jobId.slice(0, 8)}</span> : null}
                <span className="num shrink-0 text-[11px] text-muted-foreground">{formatRelative(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function JobRowView({ job, busy, onRetry }: { job: JobRow; busy: boolean; onRetry: (id: string) => void }) {
  return (
    <tr className={busy ? "opacity-60" : undefined}>
      <td>
        <div className="max-w-[320px] space-y-0.5">
          <p className="truncate font-medium">{job.jobType}</p>
          {job.errorSummary ? <p className="num truncate text-[11px] text-destructive">{job.errorSummary}</p> : null}
        </div>
      </td>
      <td>
        <StatusPill tone={jobStateTone(job.state)} dot>
          {job.state}
        </StatusPill>
      </td>
      <td className="num whitespace-nowrap text-xs">
        {job.attempts} / {job.maxAttempts}
      </td>
      <td className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">{formatDateTime(job.createdAt)}</td>
      <td className="hidden whitespace-nowrap text-xs text-muted-foreground lg:table-cell">
        {job.completedAt ? formatDateTime(job.completedAt) : "—"}
      </td>
      <td className="text-right">
        {job.state === "failed" ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => onRetry(job.id)} disabled={busy}>
            <RotateCw className="h-3.5 w-3.5" /> Retry
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function FailureAnalysis({
  data,
  summary,
  onRetry,
  busyJob,
}: {
  data: WorkspaceData;
  summary: OpsSummary | undefined;
  onRetry: (id: string) => void;
  busyJob: string | null;
}) {
  const colors = useChartColors();
  const jobs = data.jobs.data ?? [];

  if (data.opsSummary.isError) {
    return (
      <Panel eyebrow="Diagnostics" title="Failure analysis">
        <ErrorState title="Could not load the ops summary" detail={errorMessage(data.opsSummary.error)} onRetry={() => data.opsSummary.refetch()} />
      </Panel>
    );
  }

  if (data.opsSummary.isPending) {
    return (
      <Panel eyebrow="Diagnostics" title="Failure analysis">
        <div className="space-y-2 p-5">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </Panel>
    );
  }

  const counts = summary?.failureCounts ?? [];
  const byDay = summary?.failuresByJobTypeDay ?? [];
  const unhealthy = summary?.unhealthyJobs ?? [];

  if (!counts.length && !byDay.length && !unhealthy.length) {
    return (
      <Panel eyebrow="Diagnostics" title="Failure analysis">
        <EmptyState
          motif="ops"
          title="No failures to analyse"
          description="This panel fills in with error codes, a per-day job failure breakdown, and jobs that need attention."
        />
      </Panel>
    );
  }

  const daySeries = buildActivitySeries(
    jobs.map((job) => job.createdAt),
    byDay.map((row) => `${row.day}T12:00:00.000Z`),
  );

  return (
    <Panel
      eyebrow="Diagnostics"
      title="Failure analysis"
      action={
        <StatusPill tone={counts.length ? "danger" : "success"}>
          {counts.length} error code{counts.length === 1 ? "" : "s"}
        </StatusPill>
      }
    >
      <div className="grid gap-px bg-border lg:grid-cols-2">
        <div className="bg-card p-5 lg:col-span-2">
          <p className="eyebrow mb-3">Failure volume by day</p>
          <div className="h-[190px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daySeries} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="octo-fail-bar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.chart4} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={colors.chart4} stopOpacity={0.2} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={colors.border} strokeDasharray="2 6" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: colors.mutedForeground, fontSize: 11, fontFamily: "IBM Plex Mono" }}
                  tickLine={false}
                  axisLine={{ stroke: colors.border }}
                  interval={1}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: colors.mutedForeground, fontSize: 11, fontFamily: "IBM Plex Mono" }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip
                  cursor={{ fill: colors.muted, fillOpacity: 0.35 }}
                  contentStyle={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: colors.foreground, fontWeight: 600 }}
                />
                <Legend
                  verticalAlign="top"
                  align="left"
                  height={24}
                  iconType="circle"
                  iconSize={8}
                  formatter={() => <span style={{ color: colors.mutedForeground, fontSize: 12 }}>Failure events</span>}
                />
                <Bar dataKey="jobs" fill="url(#octo-fail-bar)" radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <SubTable
          title="By error code"
          columns={["Error code", "Severity", "Source", "Events", "Last seen"]}
          empty="No classified error codes were recorded for this workspace."
          rows={counts.map((row) => [
            <span className="num text-xs font-semibold">{row.errorCode ?? "Unclassified"}</span>,
            <StatusPill tone={row.severity === "critical" ? "danger" : row.severity === "warn" ? "warning" : "muted"}>
              {row.severity ?? "—"}
            </StatusPill>,
            <span className="num truncate text-xs text-muted-foreground">{row.source ?? "—"}</span>,
            <span className="num text-xs">{formatCount(row.eventCount)}</span>,
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {row.lastSeen ? formatRelative(row.lastSeen) : "—"}
            </span>,
          ])}
        />

        <SubTable
          title="By job type and day"
          columns={["Day", "Job type", "Error code", "Events"]}
          empty="No per-day failure breakdown has been recorded."
          rows={byDay.map((row) => [
            <span className="num whitespace-nowrap text-xs">{row.day}</span>,
            <span className="max-w-[200px] truncate text-xs font-medium">{row.jobType}</span>,
            <span className="num text-xs text-muted-foreground">{row.errorCode ?? "Unclassified"}</span>,
            <span className="num text-xs">{formatCount(row.eventCount)}</span>,
          ])}
        />

        <div className="bg-card lg:col-span-2">
          <div className="flex items-center justify-between px-5 py-3">
            <p className="eyebrow">Jobs needing attention</p>
            <StatusPill tone={unhealthy.length ? "warning" : "success"}>{unhealthy.length}</StatusPill>
          </div>
          {unhealthy.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">
              No jobs are stuck, delayed or past their attempt budget.
            </p>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Job type</th>
                    <th>State</th>
                    <th>Attempt</th>
                    <th className="hidden sm:table-cell">Updated</th>
                    <th>Error code</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {unhealthy.map((row, index) => {
                    const id = row.jobId ?? row.id ?? "";
                    return (
                      <tr key={`${id || row.jobType}-${index}`}>
                        <td className="max-w-[240px] truncate font-medium">{row.jobType}</td>
                        <td>
                          <StatusPill tone={jobStateTone(row.state)} dot>
                            {row.state}
                          </StatusPill>
                        </td>
                        <td className="num whitespace-nowrap text-xs">
                          {row.attempt} / {row.maxAttempts}
                        </td>
                        <td className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">
                          {row.updatedAt ? formatDateTime(row.updatedAt) : "—"}
                        </td>
                        <td className="num text-xs text-destructive">{row.errorCode ?? "Unclassified"}</td>
                        <td className="text-right">
                          {row.state === "failed" && id ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 gap-1.5 text-xs"
                              onClick={() => onRetry(id)}
                              disabled={busyJob === id}
                            >
                              <RotateCw className="h-3.5 w-3.5" /> Retry
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

function SubTable({
  title,
  columns,
  rows,
  empty,
}: {
  title: string;
  columns: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  return (
    <div className="bg-card">
      <div className="flex items-center justify-between px-5 py-3">
        <p className="eyebrow">{title}</p>
        <StatusPill tone="muted">{rows.length}</StatusPill>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, index) => (
                <tr key={index}>
                  {cells.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
