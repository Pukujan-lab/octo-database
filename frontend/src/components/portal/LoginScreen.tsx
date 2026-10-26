import { Hexagon } from "lucide-react";
import { SignInCard } from "./SignInCard";
import { LandingHero } from "@/components/landing/LandingHero";
import { StepTrace } from "@/components/landing/StepTrace";
import { CapabilityGrid } from "@/components/landing/CapabilityGrid";
import { AgentsBand } from "@/components/landing/AgentsBand";
import { LandingFooter } from "@/components/landing/LandingFooter";
import type { Health } from "@/lib/types";

/** The signed-out screen: marketing page first, sign-in card at the bottom. */
export function LoginScreen({
  health,
  healthPending,
  notice,
  signingIn,
  onGuest,
  designControls,
  isDark,
}: {
  health: Health | undefined;
  healthPending: boolean;
  notice: string | null;
  signingIn: boolean;
  onGuest: (input: { displayName?: string; turnstileToken?: string }) => Promise<boolean>;
  designControls: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div data-testid="login-screen" className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-2.5">
            <Hexagon className="h-5 w-5 text-foreground" strokeWidth={1.5} />
            <span className="font-display text-sm font-semibold uppercase tracking-[0.16em]">
              Octo Portal
            </span>
          </div>
          {designControls}
        </div>
      </header>

      <main>
        <LandingHero />
        <StepTrace />
        <CapabilityGrid />
        <AgentsBand />

        <section id="sign-in" className="scroll-mt-6">
          <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8 lg:py-24">
            <div className="mx-auto w-full max-w-lg">
              <h2 className="eyebrow">Start a session</h2>
              <div className="mt-4">
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
          </div>
        </section>
      </main>

      <LandingFooter health={health} />
    </div>
  );
}
