import { Button } from "@/components/ui/button";
import { CopyButton } from "./EmptyState";
import { EyeOff, TriangleAlert } from "lucide-react";
import { toast } from "@/utils/toast";

/** One-time secrets live in component state only. They are shown exactly once:
 *  dismissing clears them, and they are never re-fetched, re-rendered or
 *  written to storage. */
export function OneTimeSecret({
  label,
  value,
  hint,
  onDismiss,
}: {
  label: string;
  value: string;
  hint?: string;
  onDismiss: () => void;
}) {
  return (
    <div data-testid="one-time-secret" className="animate-fade-rise rounded-lg border border-primary/45 bg-primary/8 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <EyeOff className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow text-primary">{label}</span>
            <span className="inline-flex items-center gap-1 rounded border border-warning/45 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning">
              <TriangleAlert className="h-3 w-3" /> shown once
            </span>
          </div>
          <p className="num break-all rounded-md border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground">
            {value}
          </p>
          {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={value} onCopied={() => toast.success("Copied. It will not be shown again.")} />
            <span className="text-xs text-muted-foreground">Copy it now, then store it somewhere safe.</span>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
