import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sparkline, TrendDelta } from "./Sparkline";

type Tone = "default" | "primary" | "danger" | "success" | "info" | "warning";

const TONE_TEXT: Record<Tone, string> = {
  default: "text-foreground",
  primary: "text-primary",
  danger: "text-destructive",
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
};

const TONE_RULE: Record<Tone, string> = {
  default: "before:bg-border",
  primary: "before:bg-primary",
  danger: "before:bg-destructive",
  success: "before:bg-success",
  info: "before:bg-info",
  warning: "before:bg-warning",
};

export function StatTile({
  label,
  value,
  unit,
  detail,
  tone = "default",
  series,
  showTrend = false,
  icon,
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  detail?: ReactNode;
  tone?: Tone;
  series?: number[];
  showTrend?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "panel relative overflow-hidden p-5 pl-6",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        TONE_RULE[tone],
        className,
      )}
    >
      <div className="motif-grid motif-grid-fade pointer-events-none absolute inset-0 opacity-[0.06]" aria-hidden="true" />
      <div className="relative flex items-start justify-between gap-3">
        <span className="eyebrow">{label}</span>
        {icon ? <span className={cn("shrink-0", TONE_TEXT[tone])}>{icon}</span> : null}
      </div>
      <div className="relative mt-3 flex items-baseline gap-1.5">
        <span className={cn("stat-value", tone === "danger" ? "text-destructive" : "text-foreground")}>{value}</span>
        {unit ? <span className="text-sm font-medium text-muted-foreground">{unit}</span> : null}
        {showTrend && series ? <TrendDelta values={series} className="ml-1" /> : null}
      </div>
      {series ? (
        <div className={cn("relative mt-3 -mb-1", TONE_TEXT[tone])}>
          <Sparkline values={series} />
        </div>
      ) : null}
      {detail ? (
        <div className={cn("relative mt-3 text-xs leading-relaxed text-muted-foreground", series ? "pt-1" : "")}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}
