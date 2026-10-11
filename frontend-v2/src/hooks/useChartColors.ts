import { useEffect, useState } from "react";

export type ChartColors = {
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  background: string;
  card: string;
  primary: string;
  success: string;
  warning: string;
  info: string;
  destructive: string;
};

const TOKENS: Record<keyof ChartColors, string> = {
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  foreground: "--foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  border: "--border",
  background: "--background",
  card: "--card",
  primary: "--primary",
  success: "--success",
  warning: "--warning",
  info: "--info",
  destructive: "--destructive",
};

function read(): ChartColors {
  const style = getComputedStyle(document.documentElement);
  const out = {} as ChartColors;
  (Object.keys(TOKENS) as Array<keyof ChartColors>).forEach((key) => {
    const triplet = style.getPropertyValue(TOKENS[key]).trim();
    out[key] = triplet ? `hsl(${triplet})` : "transparent";
  });
  return out;
}

/** Charts need concrete colour strings, so resolve the active tokens and keep
 *  them in sync with the design-system / variant attributes on <html>. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(() => read());

  useEffect(() => {
    const sync = () => setColors(read());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-design"],
    });
    const onResize = () => sync();
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return colors;
}
