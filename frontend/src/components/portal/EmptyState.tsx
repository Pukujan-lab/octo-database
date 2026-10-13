import { AlertTriangle, Check } from "lucide-react";
import type { ReactNode } from "react";

/** Illustrated empty states. Every shape is painted with tokens (`currentColor`
 *  plus token utilities), so the motif re-themes with the design system. */

type MotifProps = { className?: string };

export function EmptyMotif({ className = "h-16 w-16" }: MotifProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <rect x="6" y="14" width="52" height="36" rx="4" className="stroke-border" strokeWidth="2" />
      <path d="M6 24h52" className="stroke-border" strokeWidth="2" />
      <circle cx="13" cy="19" r="1.6" className="fill-primary" />
      <circle cx="19" cy="19" r="1.6" className="fill-muted-foreground/50" />
      <rect x="14" y="32" width="22" height="3" rx="1.5" className="fill-muted-foreground/35" />
      <rect x="14" y="39" width="30" height="3" rx="1.5" className="fill-muted-foreground/25" />
      <rect x="14" y="46" width="16" height="3" rx="1.5" className="fill-primary/45" />
    </svg>
  );
}

export function MediaMotif({ className = "h-16 w-16" }: MotifProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <rect x="8" y="12" width="48" height="40" rx="4" className="stroke-border" strokeWidth="2" />
      <circle cx="23" cy="27" r="5" className="fill-primary/60" />
      <path
        d="M12 46l14-14 10 10 8-8 8 12"
        className="stroke-muted-foreground/60"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="46" cy="22" r="3" className="fill-info/70" />
    </svg>
  );
}

export function OpsMotif({ className = "h-16 w-16" }: MotifProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <path
        d="M10 44l10-12 8 6 10-16 8 8 6-10"
        className="stroke-primary"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="32" r="2.5" className="fill-info" />
      <circle cx="38" cy="22" r="2.5" className="fill-warning" />
      <circle cx="52" cy="12" r="2.5" className="fill-destructive" />
      <path d="M8 54h48" className="stroke-border" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function KeyMotif({ className = "h-16 w-16" }: MotifProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <circle cx="22" cy="32" r="11" className="stroke-primary" strokeWidth="2.5" />
      <circle cx="22" cy="32" r="4" className="fill-primary/40" />
      <path
        d="M33 32h20m-5 0v7m-7-7v5"
        className="stroke-muted-foreground/70"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

type EmptyStateProps = {
  title: string;
  description: string;
  motif?: "files" | "media" | "ops" | "keys";
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, motif = "files", action, className }: EmptyStateProps) {
  const Motif = { files: EmptyMotif, media: MediaMotif, ops: OpsMotif, keys: KeyMotif }[motif];
  return (
    <div className={"flex flex-col items-center justify-center gap-3 px-6 py-14 text-center " + (className ?? "")}>
      <div className="relative">
        <div className="motif-orb absolute -inset-5 rounded-full opacity-60 blur-xl" aria-hidden="true" />
        <Motif className="relative h-16 w-16 text-muted-foreground" />
      </div>
      <h3 className="font-display text-base font-semibold text-foreground">{title}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** A failed request must never look like an empty workspace. */
export function ErrorState({
  title = "Could not load this section",
  detail,
  onRetry,
}: {
  title?: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10">
        <AlertTriangle className="h-5 w-5 text-destructive" />
      </span>
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{detail}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex h-9 items-center gap-2 rounded-md border border-border bg-secondary px-3.5 text-sm font-medium text-secondary-foreground transition-colors hover:bg-accent"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function CopyButton({ value, onCopied }: { value: string; onCopied: () => void }) {
  return (
    <button
      type="button"
      title="Copy to clipboard"
      onClick={() => {
        navigator.clipboard
          ?.writeText(value)
          .then(onCopied)
          .catch(() => undefined);
      }}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:text-foreground"
    >
      <Check className="h-4 w-4" />
    </button>
  );
}
