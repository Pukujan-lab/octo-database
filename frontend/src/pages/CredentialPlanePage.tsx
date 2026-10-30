import { useEffect, useLayoutEffect } from "react";
import { Hexagon } from "lucide-react";
import { Link } from "react-router-dom";
import { INTEGRATION_GUIDE_URL } from "@/components/landing/links";
import { useForcedDark } from "@/components/credential-plane/useForcedDark";
import { CredentialHero } from "@/components/credential-plane/CredentialHero";
import { NightmareSection } from "@/components/credential-plane/NightmareSection";
import { HingeSection } from "@/components/credential-plane/HingeSection";
import { SplitSection } from "@/components/credential-plane/SplitSection";
import { MechanismSection } from "@/components/credential-plane/MechanismSection";
import { TransformedSection } from "@/components/credential-plane/TransformedSection";
import { CloseSection } from "@/components/credential-plane/CloseSection";

/**
 * The credential plane, as a signed-out launch page. Dark only, no data of any
 * kind: nothing here reads a session, a token or an API.
 */
export function CredentialPlanePage() {
  useForcedDark();

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = "Give it everything. Hand it nothing. | Octo";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link to="/" className="group flex items-center gap-2.5">
            <Hexagon className="h-5 w-5 text-foreground" strokeWidth={1.5} />
            <span className="font-display text-sm font-semibold uppercase tracking-[0.16em]">
              Octo
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span className="text-sm text-muted-foreground transition-colors duration-500 group-hover:text-foreground">
              Credential plane
            </span>
          </Link>
          <Link
            to={INTEGRATION_GUIDE_URL}
            className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground transition-colors duration-500 hover:text-foreground"
          >
            Guide
          </Link>
        </div>
      </header>

      <main>
        <CredentialHero />
        <NightmareSection />
        <HingeSection />
        <SplitSection />
        <MechanismSection />
        <TransformedSection />
        <CloseSection />
      </main>
    </div>
  );
}
