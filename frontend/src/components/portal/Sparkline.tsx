import { useId } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Token-driven sparkline. The gradient stops inherit `currentColor`, so the
 *  tile's text colour utility alone themes it. */
export function Sparkline({
  values,
  className,
  height = 34,
}: {
  values: number[];
  className?: string;
  height?: number;
}) {
  const gradientId = useId();
  const width = 120;
  if (values.length < 2) {
    return (
      <div className={cn("flex h-[34px] items-center text-[11px] text-muted-foreground", className)}>
        <span className="h-px w-full bg-border" />
      </div>
    );
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - 3 - ((value - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full text-primary", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points.join(" ")} ${width},${height}`} fill={`url(#${gradientId})`} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function TrendDelta({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const half = Math.max(1, Math.floor(values.length / 2));
  const recent = values.slice(-half).reduce((sum, value) => sum + value, 0);
  const prior = values.slice(0, half).reduce((sum, value) => sum + value, 0);
  const delta = prior === 0 ? (recent > 0 ? 100 : 0) : ((recent - prior) / prior) * 100;
  if (!Number.isFinite(delta)) return null;
  const up = delta >= 0;
  const flat = Math.abs(delta) < 0.5;
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-semibold",
        flat
          ? "bg-muted text-muted-foreground"
          : up
            ? "bg-success/12 text-success"
            : "bg-destructive/12 text-destructive",
        className,
      )}
    >
      {flat ? null : up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {flat ? "no change" : `${up ? "+" : ""}${delta.toFixed(0)}%`}
    </span>
  );
}
