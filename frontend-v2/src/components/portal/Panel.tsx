import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  title,
  eyebrow,
  action,
  children,
  className,
  bodyClassName,
  footer,
}: {
  title?: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
}) {
  return (
    <section className={cn("panel flex flex-col", className)}>
      {title || action ? (
        <header className="panel-header">
          <div className="min-w-0 space-y-0.5">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {title ? <h2 className="truncate font-display text-[15px] font-semibold">{title}</h2> : null}
          </div>
          {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
      {footer ? <footer className="border-t border-border px-5 py-3">{footer}</footer> : null}
    </section>
  );
}

const PILL_TONES = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  primary: "border-primary/40 bg-primary/12 text-primary",
  success: "border-success/40 bg-success/12 text-success",
  warning: "border-warning/40 bg-warning/12 text-warning",
  danger: "border-destructive/40 bg-destructive/12 text-destructive",
  info: "border-info/40 bg-info/12 text-info",
  muted: "border-border bg-muted text-muted-foreground",
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function StatusPill({
  tone = "neutral",
  children,
  className,
  dot = false,
}: {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5",
        PILL_TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="eyebrow">{label}</p>
      <div className="text-sm leading-relaxed text-foreground">{children}</div>
    </div>
  );
}
