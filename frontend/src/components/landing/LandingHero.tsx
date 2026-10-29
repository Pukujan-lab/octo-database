import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignInCard } from "@/components/portal/SignInCard";
import { INTEGRATION_GUIDE_URL } from "./links";
import type { Health } from "@/lib/types";

const PROOF = [
  { label: "Per-workspace Postgres", line: "Own database, own role." },
  { label: "MCP-native HTTP", line: "One surface for people and agents." },
  { label: "29 MCP tools", line: "Discover them at /api/capabilities." },
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
            Every project gets its own database, file storage, analytics, retrieval, shares, a
            graph, credentials and an audit trail. One API, one server, nothing to rebuild.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
            <Button asChild size="lg">
              <a href="#sign-in">Start a session</a>
            </Button>
            <Link
              to={INTEGRATION_GUIDE_URL}
              className="text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
            >
              Read the integration guide
            </Link>
          </div>

          <Link
            to="/credential-plane"
            className="group mt-9 flex items-center justify-between gap-4 border border-border px-4 py-3 transition-colors duration-500 hover:border-info/50"
          >
            <span className="flex min-w-0 items-baseline gap-3">
              <span className="eyebrow shrink-0 text-info/80">New</span>
              <span className="truncate font-display text-sm font-semibold tracking-tight">
                The credential plane
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground transition-colors duration-500 group-hover:text-info">
              <span className="hidden sm:inline">Give it everything. Hand it nothing.</span>
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.5} />
            </span>
          </Link>

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
