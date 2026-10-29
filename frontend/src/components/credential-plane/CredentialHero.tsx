import { ArrowRight } from "lucide-react";
import { CredentialVideo } from "./CredentialVideo";
import { WireBackdrop } from "./WireBackdrop";
import { SIGNAL_ACTION } from "./styles";

/** Section 1: the square film, and one statement beside it (beneath it on a phone). */
export function CredentialHero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <WireBackdrop />
      <div className="relative mx-auto w-full max-w-6xl px-0 pb-16 pt-8 sm:px-8 sm:pt-12 lg:pb-24 lg:pt-16">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-16">
          <div className="min-w-0">
            <CredentialVideo />
          </div>

          <div className="min-w-0 px-5 sm:px-0">
            <p className="eyebrow text-info/80">Self-hosted credential plane</p>
            <h1 className="mt-5 font-display text-[2.75rem] font-bold leading-[0.94] tracking-[-0.04em] sm:text-6xl lg:text-[4.25rem]">
              Give it everything.
              <span className="mt-2 block text-info">Hand it nothing.</span>
            </h1>
            <p className="mt-7 max-w-[40ch] text-base leading-relaxed text-muted-foreground sm:text-lg">
              Your agent gets full reach and no copy of the secret. Octo runs the credential plane on
              your own hardware, and every working key it holds is a lease with its own expiry.
            </p>
            <div className="mt-9">
              <a href="#mechanism" className={SIGNAL_ACTION}>
                See the mechanism
                <ArrowRight
                  className="h-4 w-4 transition-transform duration-500 group-hover:translate-x-1"
                  strokeWidth={1.5}
                />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
