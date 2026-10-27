import { useEffect, useRef } from "react";
import { buildField, drawField, readSky, type Sky } from "./constellation";

/** The canvas itself. Layout is built once; the loop only advances the angle.
 *  It pauses off screen and in a hidden tab, and never starts under reduced
 *  motion (one static frame is painted instead). */
export function ConstellationSky() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const initial = readSky();
    if (!initial) return;

    const field = buildField();
    let sky: Sky = initial;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    let angle = 0.55;
    let frame = 0;
    let previous = 0;
    let running = false;
    let onScreen = true;
    let width = 0;
    let height = 0;
    let ratio = 1;

    const paint = () => {
      if (!width || !height) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawField(context, field, sky, width, height, angle);
    };

    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      paint();
    };

    const tick = (now: number) => {
      if (!running) return;
      const elapsed = previous ? Math.min(now - previous, 64) : 16;
      previous = now;
      angle += elapsed * 0.00006;
      paint();
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || reduced.matches) return;
      running = true;
      previous = 0;
      frame = window.requestAnimationFrame(tick);
    };

    const stop = () => {
      running = false;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const sync = () => {
      if (onScreen && !document.hidden && !reduced.matches) start();
      else stop();
    };

    const onVisibility = () => sync();

    const onReducedMotion = () => {
      if (reduced.matches) {
        stop();
        paint();
      } else {
        sync();
      }
    };

    // The palette lives on <html>, so watch that element for theme changes.
    const paletteObserver = new MutationObserver(() => {
      const next = readSky();
      if (!next) return;
      sky = next;
      paint();
    });
    paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-design"],
    });

    const resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        sync();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onReducedMotion);

    measure();
    sync();

    return () => {
      stop();
      paletteObserver.disconnect();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onReducedMotion);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}
