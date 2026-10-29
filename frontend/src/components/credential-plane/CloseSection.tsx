import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { INTEGRATION_GUIDE_URL, REPOSITORY_URL } from "@/components/landing/links";
import { Reveal } from "./Reveal";
import { WireBackdrop } from "./WireBackdrop";
import { QUIET_LINK, SIGNAL_ACTION } from "./styles";

/** Section 7: the closing line, one action, one footer line. */
export function CloseSection() {
  return (
    <section className="relative overflow-hidden">
      <WireBackdrop bloom={false} />
      <div className="relative mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <Reveal>
          <p className="eyebrow text-info/80">Start here</p>
          <h2 className="mt-5 max-w-[16ch] font-display text-[2.5rem] font-bold leading-[0.96] tracking-[-0.04em] sm:text-6xl lg:text-7xl">
            Give it everything.
            <span className="mt-2 block text-info">Hand it nothing.</span>
          </h2>
          <p className="mt-7 max-w-[46ch] text-sm leading-relaxed text-muted-foreground sm:text-base">
            The plane runs on your hardware. The integration guide takes you from a stored secret to
            a working key in one sitting.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-x-8 gap-y-4">
            <Link to={INTEGRATION_GUIDE_URL} className={SIGNAL_ACTION}>
              Read the integration guide
              <ArrowRight
                className="h-4 w-4 transition-transform duration-500 group-hover:translate-x-1"
                strokeWidth={1.5}
              />
            </Link>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer noopener" className={QUIET_LINK}>
              Repository
            </a>
          </div>
        </Reveal>
      </div>

      <div className="relative border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-6 text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>Octo</span>
          <span>Self-hosted. Your hardware, your keys, your schedule.</span>
        </div>
      </div>
    </section>
  );
}
