import * as THREE from "three";

/** The scene's colours, read from the design tokens on <html>.
 *
 *  The band holds no literal colour: the sky recolours with the palette and the
 *  light/dark variant, exactly as the rest of the page does. Tokens are stored as
 *  shadcn HSL triplets, so each one is parsed and handed to three as an sRGB HSL
 *  colour.
 */
export type SkyTokens = {
  /** Starlight: the foreground lifted toward white in a dark variant, and kept
   *  bright in a light one, so a star always reads as light rather than a dot. */
  light: THREE.Color;
  /** The warm limb of the disk and the outer halo. */
  warm: THREE.Color;
  /** The signal colour: the hot middle of the disk and the point light. */
  hot: THREE.Color;
  /** The cool inner edge of the disk and the gas shell. */
  cool: THREE.Color;
  /** `hot` lifted toward white, for the photon ring and the lens rim. */
  wash: THREE.Color;
  /** A saturated violet from the chart ramp, for the disk's hot middle. */
  plasma: THREE.Color;
};

function tokenColor(styles: CSSStyleDeclaration, name: string): THREE.Color | null {
  const parts = styles
    .getPropertyValue(name)
    .trim()
    .replace(/%/g, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) return null;
  return new THREE.Color().setHSL(parts[0] / 360, parts[1] / 100, parts[2] / 100, THREE.SRGBColorSpace);
}

/** Move a colour toward white, thinning its saturation on the way if asked. */
function lift(base: THREE.Color, amount: number, desaturate = 0): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  return new THREE.Color().setHSL(
    hsl.h,
    Math.max(0, hsl.s * (1 - desaturate)),
    hsl.l + (1 - hsl.l) * amount,
    THREE.SRGBColorSpace,
  );
}

/** Null means the page has no palette to read yet. */
export function readTokens(): SkyTokens | null {
  const styles = getComputedStyle(document.documentElement);
  const foreground = tokenColor(styles, "--foreground");
  const hot = tokenColor(styles, "--primary");
  const warm = tokenColor(styles, "--warning");
  const cool = tokenColor(styles, "--chart-2");
  // The chart ramp's violet is the one hue in the palette that sits between the
  // cool and warm ends without desaturating to grey, which is what a disk's hot
  // middle needs. Falling back to the signal colour keeps every design system
  // renderable even if a future palette drops it.
  const plasma = tokenColor(styles, "--chart-5") ?? hot;
  if (!foreground || !hot || !warm || !cool) return null;

  // Stars are drawn with additive blending, so their colour is a brightness: a
  // dark one simply does not appear. In the dark variant the foreground is
  // already near-white and works as-is; in a light variant it is near-black, and
  // the sky has to be lit from the palette's own light end instead — the signal
  // colour washed out — so a star stays a star on either background.
  const fgHsl = { h: 0, s: 0, l: 0 };
  foreground.getHSL(fgHsl);
  const light = fgHsl.l > 0.55 ? foreground : lift(hot, 0.72, 0.55);

  return {
    light,
    warm,
    hot,
    cool,
    wash: lift(hot, 0.62, 0.42),
    plasma,
  };
}
