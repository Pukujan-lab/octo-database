import { Hexagon } from "lucide-react";
import { Link } from "react-router-dom";
import { LandingHero } from "@/components/landing/LandingHero";
import { ConstellationField } from "@/components/landing/ConstellationField";
import { Manifesto } from "@/components/landing/Manifesto";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { INTEGRATION_GUIDE_URL } from "@/components/landing/links";
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
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-4 sm:gap-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <Hexagon className="h-5 w-5 shrink-0 text-foreground" strokeWidth={1.5} />
            <span className="whitespace-nowrap font-display text-sm font-semibold uppercase tracking-[0.16em]">
              Octo
              {/* The full wordmark plus the controls and the Docs link do not fit
                  a 390px header, so the phone gets the short form. */}
              <span className="hidden sm:inline"> Portal</span>
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3 sm:gap-6">
            <Link
              to={INTEGRATION_GUIDE_URL}
              className="whitespace-nowrap text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
            </Link>
            {designControls}
          </div>
        </div>
      </header>

      <main>
        <ConstellationField />
        <LandingHero
          health={health}
          healthPending={healthPending}
          notice={notice}
          signingIn={signingIn}
          onGuest={onGuest}
          isDark={isDark}
        />
        <Manifesto />
      </main>

      <LandingFooter health={health} />
    </div>
  );
}
