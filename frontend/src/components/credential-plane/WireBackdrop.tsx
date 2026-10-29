import { cn } from "@/lib/utils";

/**
 * The wireframe ground: a token grid fading out, and one cyan bloom. Both are
 * drawn from CSS custom properties on <html>, so the page recolours with the
 * palette instead of carrying its own colours.
 */
export function WireBackdrop({
  bloom = true,
  className,
}: {
  bloom?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, hsl(var(--border) / 0.55) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border) / 0.55) 1px, transparent 1px)",
          backgroundSize: "68px 68px",
          maskImage: "radial-gradient(115% 85% at 50% 0%, black 0%, transparent 70%)",
          WebkitMaskImage: "radial-gradient(115% 85% at 50% 0%, black 0%, transparent 70%)",
        }}
      />
      {bloom ? (
        <div
          className="absolute left-1/2 top-0 h-[48rem] w-[48rem] -translate-x-1/2 -translate-y-1/3"
          style={{
            background: "radial-gradient(circle, hsl(var(--info) / 0.12), transparent 62%)",
          }}
        />
      ) : null}
    </div>
  );
}
