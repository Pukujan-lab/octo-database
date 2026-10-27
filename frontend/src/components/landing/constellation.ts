/** Deterministic layout and drawing for the constellation band.
 *
 *  Everything here is dependency free. Colours are read from the design tokens
 *  on <html> (HSL triplets) and resolved to hsla() strings at draw time, so the
 *  sky recolours with the palette and never holds a literal colour.
 */

type Hsl = { h: number; s: number; l: number };

export type Sky = { node: Hsl; core: Hsl };

export type SkyNode = { x: number; y: number; z: number; weight: number };
export type SkyLink = { a: number; b: number; bright: boolean };
export type SkyField = { nodes: SkyNode[]; links: SkyLink[] };

const NODE_COUNT = 132;
const SEED = 0x0c7a11;
const LINK_RANGE = 0.3;
const CORE_SPOKES = 7;
const MAX_DEGREE = 3;
const FOV = 2.4;
const TILT = 0.55;

/** mulberry32: a tiny fixed-seed generator, so the field never reshuffles. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tokens are stored as shadcn HSL triplets, e.g. "210 18% 93%". */
function parseToken(raw: string): Hsl | null {
  const parts = raw
    .trim()
    .replace(/%/g, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) return null;
  return { h: parts[0], s: parts[1], l: parts[2] };
}

/** Read the two tokens the scene needs. Null means the page has no palette. */
export function readSky(): Sky | null {
  const styles = getComputedStyle(document.documentElement);
  const node = parseToken(styles.getPropertyValue("--foreground"));
  const core = parseToken(styles.getPropertyValue("--primary"));
  return node && core ? { node, core } : null;
}

function hsla(color: Hsl, alpha: number) {
  return `hsla(${color.h}, ${color.s}%, ${color.l}%, ${Math.min(1, Math.max(0, alpha))})`;
}

/** A shallow ellipsoid of nodes plus the links that join neighbours in 3D. */
export function buildField(count = NODE_COUNT, seed = SEED): SkyField {
  const random = seeded(seed);
  const nodes: SkyNode[] = [{ x: 0, y: 0, z: 0, weight: 1 }];

  while (nodes.length < count) {
    const u = random() * Math.PI * 2;
    const v = Math.acos(2 * random() - 1);
    const ring = 0.58 + random() * 0.42;
    nodes.push({
      x: Math.sin(v) * Math.cos(u) * ring,
      y: Math.cos(v) * 0.38 * ring,
      z: Math.sin(v) * Math.sin(u) * ring,
      weight: 0.3 + random() * 0.7,
    });
  }

  const links: SkyLink[] = [];
  const degree = new Array<number>(count).fill(0);

  // The core is the control point, so it holds the nearest few spokes.
  const spokes = nodes
    .map((node, index) => ({ index, distance: Math.hypot(node.x, node.y, node.z) }))
    .slice(1)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, CORE_SPOKES);
  for (const spoke of spokes) {
    links.push({ a: 0, b: spoke.index, bright: true });
    degree[spoke.index] += 1;
  }
  degree[0] = CORE_SPOKES;

  // The rest of the mesh joins nodes that sit close together in 3D.
  for (let a = 1; a < count; a += 1) {
    for (let b = a + 1; b < count; b += 1) {
      if (degree[a] >= MAX_DEGREE || degree[b] >= MAX_DEGREE) continue;
      const dx = nodes[a].x - nodes[b].x;
      const dy = nodes[a].y - nodes[b].y;
      const dz = nodes[a].z - nodes[b].z;
      if (dx * dx + dy * dy + dz * dz > LINK_RANGE * LINK_RANGE) continue;
      links.push({ a, b, bright: false });
      degree[a] += 1;
      degree[b] += 1;
    }
  }

  return { nodes, links };
}

type Projected = { x: number; y: number; near: number; weight: number };

/** Rotate the field around its vertical axis, then divide by perspective. */
export function drawField(
  context: CanvasRenderingContext2D,
  field: SkyField,
  sky: Sky,
  width: number,
  height: number,
  angle: number,
) {
  context.clearRect(0, 0, width, height);

  // On narrow screens the copy covers the lower half, so the core is lifted
  // into the clear space above it rather than hidden behind the scrim.
  const wide = width > 900;
  const centerX = width * (wide ? 0.66 : 0.6);
  const centerY = height * (wide ? 0.5 : 0.33);
  const radius = Math.min(width, height) * (wide ? 0.56 : 0.66);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // A fixed tilt on the second axis stops the field reading as a flat ring:
  // the near half sits lower and larger than the far half.
  const tilt = Math.cos(TILT);
  const tiltSin = Math.sin(TILT);

  const points: Projected[] = field.nodes.map((node) => {
    const x = node.x * cos - node.z * sin;
    const rotatedZ = node.x * sin + node.z * cos;
    const y = node.y * tilt - rotatedZ * tiltSin;
    const z = node.y * tiltSin + rotatedZ * tilt;
    const depth = FOV / (FOV + z);
    return {
      x: centerX + x * radius * depth,
      y: centerY + y * radius * depth,
      near: Math.min(1, Math.max(0, (depth - 0.7) / 1)),
      weight: node.weight,
    };
  });

  for (const link of field.links) {
    const from = points[link.a];
    const to = points[link.b];
    const near = (from.near + to.near) / 2;
    context.strokeStyle = hsla(link.bright ? sky.core : sky.node, 0.05 + near * (link.bright ? 0.45 : 0.22));
    context.lineWidth = link.bright ? 1.1 : 0.8;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const core = index === 0;
    const scale = 0.6 + point.near * 0.7;
    const nodeRadius = core ? 4.2 * scale : (1.1 + point.weight * 2) * scale;
    const alpha = core ? 0.95 : 0.2 + point.near * 0.85 * (0.4 + point.weight * 0.6);
    const color = core ? sky.core : sky.node;

    if (core) {
      const halo = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, nodeRadius * 8);
      halo.addColorStop(0, hsla(sky.core, 0.26));
      halo.addColorStop(1, hsla(sky.core, 0));
      context.fillStyle = halo;
      context.beginPath();
      context.arc(point.x, point.y, nodeRadius * 8, 0, Math.PI * 2);
      context.fill();
    }

    context.fillStyle = hsla(color, alpha);
    context.beginPath();
    context.arc(point.x, point.y, nodeRadius, 0, Math.PI * 2);
    context.fill();
  }
}
