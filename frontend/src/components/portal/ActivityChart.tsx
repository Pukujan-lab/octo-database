import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, isValid, parseISO, subDays } from "date-fns";
import { useChartColors } from "@/hooks/useChartColors";
import { EmptyState } from "./EmptyState";

export type ChartPoint = { day: string; files: number; jobs: number };

const DAYS = 14;

function dayKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = parseISO(value);
  return isValid(date) ? format(date, "yyyy-MM-dd") : null;
}

/** Build the per-day series client-side from the timestamps the API returns. */
export function buildActivitySeries(
  fileDates: Array<string | null | undefined>,
  jobDates: Array<string | null | undefined>,
): ChartPoint[] {
  const today = new Date();
  const buckets = new Map<string, ChartPoint>();
  for (let index = DAYS - 1; index >= 0; index -= 1) {
    const key = format(subDays(today, index), "yyyy-MM-dd");
    buckets.set(key, { day: key, files: 0, jobs: 0 });
  }
  fileDates.forEach((value) => {
    const key = dayKey(value);
    if (key && buckets.has(key)) buckets.get(key)!.files += 1;
  });
  jobDates.forEach((value) => {
    const key = dayKey(value);
    if (key && buckets.has(key)) buckets.get(key)!.jobs += 1;
  });
  return Array.from(buckets.values());
}

export function ActivityChart({ series }: { series: ChartPoint[] }) {
  const colors = useChartColors();
  const hasData = useMemo(() => series.some((point) => point.files > 0 || point.jobs > 0), [series]);

  if (!hasData) {
    return (
      <div data-testid="overview-chart">
        <EmptyState
          motif="ops"
          title="No activity in the last 14 days"
          description="Files added and jobs enqueued appear here as a daily series. Upload a file to start the timeline."
        />
      </div>
    );
  }

  return (
    <div data-testid="overview-chart" className="h-[280px] w-full px-2 pb-3 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 4, right: 16, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id="octo-files-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.chart1} stopOpacity={0.5} />
              <stop offset="100%" stopColor={colors.chart1} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="octo-jobs-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.chart2} stopOpacity={0.4} />
              <stop offset="100%" stopColor={colors.chart2} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={colors.border} strokeDasharray="2 6" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: colors.mutedForeground, fontSize: 11, fontFamily: "IBM Plex Mono" }}
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            interval={1}
            tickFormatter={(value: string) => format(parseISO(value), "MMM d")}
            tickMargin={10}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: colors.mutedForeground, fontSize: 11, fontFamily: "IBM Plex Mono" }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: colors.primary, strokeWidth: 1, strokeDasharray: "3 3" }}
            contentStyle={{
              background: colors.card,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              fontSize: 12,
              padding: "8px 10px",
            }}
            labelStyle={{ color: colors.foreground, fontWeight: 600, marginBottom: 4 }}
            itemStyle={{ color: colors.foreground }}
            formatter={(value: number | string, name: string) => [
              String(value),
              name === "files" ? "Files added" : "Jobs enqueued",
            ]}
            labelFormatter={(value: string) => format(parseISO(value), "EEEE, MMM d")}
          />
          <Legend
            verticalAlign="top"
            align="left"
            height={26}
            iconType="circle"
            iconSize={8}
            formatter={(value: string) => (
              <span style={{ color: colors.mutedForeground, fontSize: 12 }}>
                {value === "files" ? "Files added" : "Jobs enqueued"}
              </span>
            )}
          />
          <Area
            type="monotone"
            dataKey="files"
            stroke={colors.chart1}
            strokeWidth={2}
            fill="url(#octo-files-fill)"
            activeDot={{ r: 4, fill: colors.chart1, stroke: colors.card, strokeWidth: 2 }}
          />
          <Area
            type="monotone"
            dataKey="jobs"
            stroke={colors.chart2}
            strokeWidth={2}
            fill="url(#octo-jobs-fill)"
            activeDot={{ r: 4, fill: colors.chart2, stroke: colors.card, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
