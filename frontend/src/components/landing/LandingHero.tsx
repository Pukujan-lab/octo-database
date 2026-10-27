import { Button } from "@/components/ui/button";
import { SignInCard } from "@/components/portal/SignInCard";
import { INTEGRATION_GUIDE_URL } from "./links";
import type { Health } from "@/lib/types";

const PROOF = [
  { label: "Per-workspace Postgres", line: "Own database, own role." },
  { label: "MCP-native HTTP", line: "One surface for people and agents." },
  { label: "DuckDB analytics", line: "Ephemeral compute over Parquet." },
];

/** Section 1: intro copy and the sign-in card, side by side on desktop. */
export function LandingHero({
  health,
  healthPending,
  notice,
  signingIn,
  onGuest,
  isDark,
}: {
  health: Health | undefined;
  healthPending: boolean;
  notice: string | null;
  signingIn: boolean;
  onGuest: (input: { displayName?: string; turnstileToken?: string }) => Promise<boolean>;
  isDark: boolean;
}) {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-12 sm:px-8 lg:grid lg:grid-cols-[1.05fr_0.95fr] lg:items-start lg:gap-16 lg:pb-24 lg:pt-20">
        <div className="max-w-xl">
          <p className="eyebrow">Self-hosted workspace data platform</p>
          <h1 className="mt-4 font-display text-4xl font-bold leading-[1.04] tracking-tight sm:text-5xl lg:text-6xl">
            Your project&apos;s data layer.
          </h1>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Every project gets its own database, file storage, analytics, retrieval and
            credentials. One API, one server, nothing to rebuild.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
            <Button asChild size="lg">
              <a href="#sign-in">Start a session</a>
            </Button>
            <a
              href={INTEGRATION_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
            >
              Read the integration guide
            </a>
          </div>

          <dl className="mt-10 grid grid-cols-1 divide-y divide-border border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {PROOF.map((item) => (
              <div key={item.label} className="py-4 sm:px-5 sm:first:pl-0 sm:last:pr-0">
                <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">
                  {item.label}
                </dt>
                <dd className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{item.line}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div id="sign-in" className="mt-12 scroll-mt-6 lg:mt-0">
          <SignInCard
            health={health}
            healthPending={healthPending}
            notice={notice}
            signingIn={signingIn}
            onGuest={onGuest}
            isDark={isDark}
          />
        </div>
      </div>
    </section>
  );
}
