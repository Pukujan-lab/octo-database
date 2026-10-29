import { Reveal } from "./Reveal";

const BEATS = [
  {
    step: "01",
    title: "A grant cannot read.",
    body: "It lists your stored secrets and mints working keys from that list. Returning a stored secret is the one operation it refuses, and the refusal is built into the plane rather than asked of the model.",
  },
  {
    step: "02",
    title: "Working keys are leases.",
    body: "A working key is minted with a lifetime, scoped to one secret and one purpose, and it is not the real secret. It dies when the job ends, so the leak window is the length of the work rather than the lifespan of a deployment.",
  },
  {
    step: "03",
    title: "The real value is injected at the edge.",
    body: "A request made with a working key proxies back to the plane, which substitutes the real secret on the way out. The secret stays in exactly one place, so there is no copy to chase.",
  },
  {
    step: "04",
    title: "Rotation is one write. Revocation is one transaction.",
    body: "Change the stored value once and every live working key picks it up on its next request, with no propagation step and no redeploy. Delete the grant and every key it ever minted dies in the same transaction, in every project.",
  },
];

/** Section 5: the mechanism, turned over one beat at a time. */
export function MechanismSection() {
  return (
    <section id="mechanism" className="scroll-mt-8 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <Reveal>
          <p className="eyebrow">The mechanism</p>
          <h2 className="mt-4 max-w-[18ch] font-display text-3xl font-semibold leading-[1.02] tracking-tight sm:text-4xl lg:text-5xl">
            Four things make it work.
          </h2>
        </Reveal>

        <div className="mt-12">
          {BEATS.map((beat, index) => (
            <Reveal key={beat.step} delay={index * 90}>
              <div className="grid gap-4 border-t border-border py-8 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 lg:py-10">
                <span className="num text-xl font-semibold leading-none tracking-[0.08em] text-info/70 sm:text-2xl">
                  {beat.step}
                </span>
                <div className="max-w-[64ch]">
                  <h3 className="font-display text-lg font-semibold leading-snug tracking-tight sm:text-xl">
                    {beat.title}
                  </h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground sm:text-base">
                    {beat.body}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
          <div className="border-t border-border" />
        </div>
      </div>
    </section>
  );
}
