import { Button } from "@/components/ui/button";
import { INTEGRATION_GUIDE_URL } from "./links";

/** Section 1: full-width dark hero. The image sits behind the right two-thirds
 *  on desktop and becomes a short banner above the text on narrow screens. */
export function LandingHero() {
  return (
    <section className="relative isolate overflow-hidden border-b border-border bg-background">
      <div className="relative lg:absolute lg:inset-y-0 lg:right-0 lg:w-2/3">
        <img
          src="/landing/hero.jpg"
          alt="Isometric workspace planes connected to a central hexagonal core"
          className="h-40 w-full object-cover object-center sm:h-56 lg:h-full lg:object-right"
        />
        <div
          className="pointer-events-none absolute inset-0 hidden bg-gradient-to-r from-background via-background/80 to-transparent lg:block"
          aria-hidden="true"
        />
      </div>

      <div className="relative mx-auto flex w-full max-w-6xl flex-col justify-center px-5 pb-14 pt-10 sm:px-8 lg:min-h-[640px] lg:py-24">
        <div className="max-w-xl">
          <p className="eyebrow">Self-hosted workspace data platform</p>
          <h1 className="mt-4 max-w-[18ch] text-balance font-display text-4xl font-bold leading-[1.04] tracking-tight sm:text-5xl lg:text-6xl">
            Your project&apos;s data layer.
          </h1>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Octo gives every project its own workspace — a database, file storage, analytics,
            retrieval, and credentials — behind one API. You run one server. Your projects stop
            rebuilding plumbing.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
            <Button
              asChild
              size="lg"
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
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
        </div>
      </div>
    </section>
  );
}
