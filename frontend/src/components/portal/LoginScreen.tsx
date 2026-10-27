import { Hexagon } from "lucide-react";
import { LandingHero } from "@/components/landing/LandingHero";
import { ConstellationField } from "@/components/landing/ConstellationField";
import { Manifesto } from "@/components/landing/Manifesto";
import { LandingFooter } from "@/components/landing/LandingFooter";
import type { Health } from "@/lib/types";

/** The signed-out screen: intro with the sign-in card, the constellation band,
 *  then the narrative close. */
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
        <LandingHero
          health={health}
          healthPending={healthPending}
          notice={notice}
          signingIn={signingIn}
          onGuest={onGuest}
          isDark={isDark}
        />
        <ConstellationField />
        <Manifesto />
      </main>

      <LandingFooter health={health} />
    </div>
  );
}
