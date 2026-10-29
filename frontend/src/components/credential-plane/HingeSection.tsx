import { Reveal } from "./Reveal";

/** Section 3: the turn. The instinct everyone shares, then the question that decides everything. */
export function HingeSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <div className="lg:grid lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
          <Reveal>
            <p className="eyebrow">The obvious answer</p>
            <h2 className="mt-4 max-w-[14ch] font-display text-3xl font-semibold leading-[1.02] tracking-tight sm:text-4xl lg:text-5xl">
              Store it once. Proxy the call.
            </h2>
          </Reveal>

          <Reveal delay={120} className="mt-10 lg:mt-0">
            <div className="max-w-[62ch] space-y-6 text-sm leading-relaxed text-muted-foreground sm:text-base">
              <p>
                Everyone lands on the same instinct. Keep the secret in one manager, answer requests
                with it instead of handing it out, and the agent never sees the value. That part is
                solved. It is table stakes, and it is not the interesting part.
              </p>
              <p>Then there is the question almost everybody skips.</p>
            </div>
          </Reveal>
        </div>

        <Reveal className="mt-14 border-t border-border pt-10 lg:mt-20 lg:pt-14">
          <h3 className="max-w-[18ch] font-display text-[2.25rem] font-bold leading-[0.96] tracking-[-0.04em] sm:text-6xl lg:text-7xl">
            Where does the <span className="text-info">copy</span> live?
          </h3>
          <p className="mt-6 max-w-[52ch] text-sm leading-relaxed text-muted-foreground sm:text-base">
            The answer decides how many places your secret can leak from, and how many places a
            rotation has to reach.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
