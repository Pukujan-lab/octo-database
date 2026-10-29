import { Reveal } from "./Reveal";

/** Section 2: the current reality. The only place the warm accent appears. */
export function NightmareSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <div className="lg:grid lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
          <Reveal>
            <p className="eyebrow">The nightmare</p>
            <h2 className="mt-4 max-w-[13ch] font-display text-3xl font-semibold leading-[1.02] tracking-tight sm:text-4xl lg:text-5xl">
              The key is on the box.
            </h2>
            <div className="mt-7 h-px w-16 bg-warning/60" />
          </Reveal>

          <Reveal delay={120} className="mt-10 lg:mt-0">
            <div className="max-w-[62ch] space-y-6 text-sm leading-relaxed text-muted-foreground sm:text-base">
              <p>
                You put the vendor key in an env file on a server that also runs code you did not
                write. Now it is in a backup from March, in a debug line a library printed at two in
                the morning, in a CI variable someone copied into a new project, and in a screenshot
                you pasted into a support thread.
              </p>
              <p>
                None of that was a mistake. It is how most deployments get built. The key was never
                a secret, it was a convenience, and convenience gets copied.
              </p>
              <p>
                <span className="text-warning">Then it turns up somewhere you did not put it.</span>{" "}
                You lose the weekend rotating a credential you cannot enumerate, because you do not
                know how many copies exist, who is holding one, or how long one has been sitting in
                a log that outlives the machine it came from.
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
