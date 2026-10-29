import { Reveal } from "./Reveal";

function DiagramLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text
      x={x}
      y={y}
      fontSize={7}
      letterSpacing="0.14em"
      textAnchor="middle"
      fill="currentColor"
    >
      {children}
    </text>
  );
}

/** One value, pushed out as a real copy into every platform that needs it. */
function SyncDiagram() {
  return (
    <svg
      viewBox="0 0 300 150"
      role="img"
      aria-label="One stored secret, copied into three destinations."
      className="h-auto w-full"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1" className="text-border">
        <rect x="6" y="58" width="64" height="34" />
        <rect x="230" y="6" width="64" height="28" />
        <rect x="230" y="61" width="64" height="28" />
        <rect x="230" y="116" width="64" height="28" />
        <path d="M70 75 L230 20" />
        <path d="M70 75 L230 75" />
        <path d="M70 75 L230 130" />
      </g>
      <g className="fill-warning">
        <circle cx="240" cy="20" r="2.5" />
        <circle cx="240" cy="75" r="2.5" />
        <circle cx="240" cy="130" r="2.5" />
      </g>
      <g className="fill-muted-foreground">
        <DiagramLabel x={38} y={79}>
          SECRET
        </DiagramLabel>
        <DiagramLabel x={264} y={24}>
          APP
        </DiagramLabel>
        <DiagramLabel x={264} y={79}>
          CI
        </DiagramLabel>
        <DiagramLabel x={264} y={134}>
          LOGS
        </DiagramLabel>
      </g>
    </svg>
  );
}

/** The value stays behind the boundary. Only leases and requests travel. */
function NoCopyDiagram() {
  return (
    <svg
      viewBox="0 0 300 150"
      role="img"
      aria-label="One stored secret answering requests in place, with no copy leaving the plane."
      className="h-auto w-full"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1" className="text-border">
        <rect x="6" y="61" width="58" height="28" />
        <rect x="236" y="61" width="58" height="28" />
        <rect x="100" y="28" width="100" height="94" strokeDasharray="3 5" />
        <path d="M64 75 L120 75" />
        <path d="M180 75 L236 75" />
      </g>
      <g className="text-info">
        <rect
          x="120"
          y="61"
          width="60"
          height="28"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <circle cx="92" cy="75" r="2.5" className="fill-info" />
        <circle cx="208" cy="75" r="2.5" className="fill-info" />
      </g>
      <g className="fill-muted-foreground">
        <DiagramLabel x={35} y={79}>
          AGENT
        </DiagramLabel>
        <DiagramLabel x={150} y={79}>
          SECRET
        </DiagramLabel>
        <DiagramLabel x={265} y={79}>
          API
        </DiagramLabel>
      </g>
    </svg>
  );
}

const SYNC_POINTS = [
  "Rotation writes to every destination the value ever reached.",
  "Each destination is another place it can leak from.",
  "The copy is real, so it has to be tracked, rotated and chased.",
];

const NO_COPY_POINTS = [
  "Rotation is one write, and live keys follow on their next request.",
  "There is no second copy sitting on a host to find.",
  "The request travels to the value, not the other way around.",
];

function Points({ items }: { items: string[] }) {
  return (
    <ul className="space-y-3 text-sm leading-relaxed text-muted-foreground">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 border border-current" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** Section 4: the two architectures, side by side. */
export function SplitSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
        <Reveal>
          <p className="eyebrow">The split</p>
          <h2 className="mt-4 max-w-[20ch] font-display text-3xl font-semibold leading-[1.02] tracking-tight sm:text-4xl lg:text-5xl">
            Two answers. One of them keeps the secret home.
          </h2>
        </Reveal>

        <div className="mt-12 grid gap-6 lg:grid-cols-2 lg:gap-8">
          <Reveal>
            <div className="h-full border border-border p-6 sm:p-7">
              <p className="eyebrow">The sync model</p>
              <h3 className="mt-3 font-display text-xl font-semibold tracking-tight sm:text-2xl">
                Push a copy to every platform.
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                The manager owns the secret and writes it into every platform that needs it.
              </p>
              <div className="mt-7 border-t border-border pt-7">
                <SyncDiagram />
              </div>
              <div className="mt-7">
                <Points items={SYNC_POINTS} />
              </div>
              <p className="mt-7 border-t border-border pt-3 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                Infisical Agent Vault
              </p>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <div className="h-full border border-info/30 p-6 sm:p-7">
              <p className="eyebrow text-info/80">The no-copy model</p>
              <h3 className="mt-3 font-display text-xl font-semibold tracking-tight sm:text-2xl">
                Keep it home. Proxy the call.
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                The plane owns the secret and injects the real value at the edge, on the way out.
              </p>
              <div className="mt-7 border-t border-border pt-7">
                <NoCopyDiagram />
              </div>
              <div className="mt-7">
                <Points items={NO_COPY_POINTS} />
              </div>
              <p className="mt-7 border-t border-info/30 pt-3 text-[11px] uppercase tracking-[0.16em] text-info">
                Octo
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
