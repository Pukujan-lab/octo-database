import { Reveal } from "./Reveal";

const SHIFTS = [
  {
    before: "A key per environment, and every one of them a copy you cannot count.",
    after: "One stored secret, and working keys that expire on their own schedule.",
  },
  {
    before: "Rotation is a project with a calendar reminder attached to it.",
    after: "Rotation is one write, and there is nothing to redeploy.",
  },
  {
    before: "An agent finishes the job and the key outlives it.",
    after: "The key dies with the job, and the grant closes whatever is left.",
  },
  {
    before: "You keep a map of where the secret lives.",
    after: "You stop keeping the map.",
  },
];

/** Section 6: the transformed world, then the number. */
export function TransformedSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <Reveal>
          <p className="eyebrow">The other side</p>
          <h2 className="mt-4 max-w-[16ch] font-display text-3xl font-semibold leading-[1.02] tracking-tight sm:text-4xl lg:text-5xl">
            You stop thinking about keys.
          </h2>
        </Reveal>

        <div className="mt-12">
          {SHIFTS.map((shift, index) => (
            <Reveal key={shift.after} delay={index * 80}>
              <div className="grid gap-5 border-t border-border py-7 sm:grid-cols-2 sm:gap-12">
                <div>
                  <p className="eyebrow text-muted-foreground/70">Before</p>
                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground sm:text-base">
                    {shift.before}
                  </p>
                </div>
                <div>
                  <p className="eyebrow text-info/80">After</p>
                  <p className="mt-2.5 text-sm leading-relaxed text-foreground sm:text-base">
                    {shift.after}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-16 border-t border-border pt-14 lg:mt-24 lg:pt-20">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:gap-12">
            <span
              aria-hidden="true"
              className="font-display text-[8rem] font-bold leading-[0.78] tracking-[-0.06em] text-info sm:text-[12rem] lg:text-[15rem]"
            >
              0
            </span>
            <p className="max-w-[13ch] pb-1 font-display text-xl font-semibold leading-tight tracking-tight sm:pb-8 sm:text-2xl">
              copies of the secret, anywhere.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
