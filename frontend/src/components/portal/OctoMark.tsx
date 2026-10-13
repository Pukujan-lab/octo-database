import { cn } from "@/lib/utils";

/** Decorative brand motif: an orb/ring composition drawn entirely with tokens. */
export function OctoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" className={cn("text-primary", className)} aria-hidden="true">
      <defs>
        <radialGradient id="octo-orb" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.85" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="54" className="stroke-border" strokeWidth="1" strokeDasharray="3 7" />
      <circle cx="60" cy="60" r="40" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1" className="animate-pulse-ring" />
      <circle cx="60" cy="60" r="26" fill="url(#octo-orb)" />
      <circle cx="60" cy="60" r="26" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeOpacity="0.7">
        <path d="M60 34c-6-8-16-8-20-2" />
        <path d="M86 60c8-6 8-16 2-20" />
        <path d="M60 86c6 8 16 8 20 2" />
        <path d="M34 60c-8 6-8 16-2 20" />
      </g>
      <circle cx="52" cy="52" r="3" fill="currentColor" />
      <circle cx="70" cy="66" r="2" fill="currentColor" fillOpacity="0.5" />
    </svg>
  );
}
