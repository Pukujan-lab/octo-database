/** Where every point in the sky sits, and what it stands for.
 *
 *  The layout is deterministic, never random: each surface keeps its place across
 *  reloads and devices, so two people can point at the same star and mean the
 *  same thing. The clusters are the three walls from the manifesto, and the stars
 *  around each one are the surfaces that wall is built from, so the sky and the
 *  prose below it say the same thing twice.
 *
 *  Every star here is a surface the server serves today. Anything still dark or
 *  unbuilt stays out of the sky rather than being drawn as scenery.
 */

export type Vec3 = [number, number, number];

export interface SkyAnchor {
  id: string;
  label: string;
  /** A phone's frame cannot hold the full wall name beside its node. */
  short: string;
  position: Vec3;
}

export interface SkyStar {
  id: string;
  label: string;
  /** The wall this surface answers, used to light up its cluster. */
  cluster: string;
  position: Vec3;
}

export interface SkyEdge {
  fromId: string;
  toId: string;
}

/** The three walls, in the order the manifesto lists them. */
export const WALLS = [
  {
    id: "isolate",
    label: "Isolate the blast radius",
    short: "Isolate",
    surfaces: ["SQL surface", "Files", "Gallery", "Shares"],
  },
  {
    id: "human",
    label: "Keep deletion human",
    short: "Human deletion",
    surfaces: ["API keys", "Vault relay", "MFA", "Audit log", "OAuth 2.1"],
  },
  {
    id: "compute",
    label: "Move compute off the control plane",
    short: "Move compute",
    surfaces: ["Analytics", "Hybrid RAG", "Graph", "Epistemic ledger", "Jobs and ops"],
  },
] as const;

/** The ring the clusters sit on. */
const ORBIT_RADIUS = 5.6;
/** A phone's frame is narrow, so the ring and the stars around it are pulled in
 *  until the whole field fits between the two edges. */
const ORBIT_RADIUS_COMPACT = 3.9;
/** Turned so the wall with the longest label hangs below the disk rather than
 *  across its bright face: the ring's first wall sits upper right, the second
 *  upper left, and the third at the bottom. */
const ORBIT_PHASE = Math.PI / 6;
/** The ring is an ellipse, squashed vertically so three walls fit inside the
 *  band without the lowest one falling out of frame. */
const ORBIT_SQUASH = 0.45;
/** A phone's band is close to square, so the ring can stand up into a triangle. */
const ORBIT_SQUASH_COMPACT = 0.62;

/** FNV-1a over a string, in [0,1). Stable across runs and platforms. */
export function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function anchorId(wall: string): string {
  return `anchor:${wall}`;
}

/** The centre of one wall's cluster. `compact` pulls the whole ring in for a
 *  phone: the frame is 390px wide, so the desktop radius would carry the outer
 *  clusters off both edges.
 *
 *  The ring is squashed vertically rather than left circular: the band is wider
 *  than it is tall, so a circle would push the lower wall out of frame. A phone's
 *  band is close to square, so it gets less squash and the three walls read as a
 *  triangle around the hole rather than one flat line over it.
 */
function anchorPosition(index: number, compact: boolean): Vec3 {
  const angle = (index / WALLS.length) * Math.PI * 2 + ORBIT_PHASE;
  const radius = compact ? ORBIT_RADIUS_COMPACT : ORBIT_RADIUS;
  return [
    Math.cos(angle) * radius,
    Math.sin(angle) * radius * (compact ? ORBIT_SQUASH_COMPACT : ORBIT_SQUASH),
    Math.sin(angle) * radius * 0.18,
  ];
}

/** The sky: three labelled anchors, their surfaces fanned round them, and the links. */
export function buildSky(compact = false): {
  anchors: SkyAnchor[];
  stars: SkyStar[];
  edges: SkyEdge[];
} {
  const anchors: SkyAnchor[] = [];
  const stars: SkyStar[] = [];
  const edges: SkyEdge[] = [];

  WALLS.forEach((wall, index) => {
    const centre = anchorPosition(index, compact);
    anchors.push({
      id: anchorId(wall.id),
      label: wall.label,
      short: wall.short,
      position: centre,
    });

    const spread = (1.5 + wall.surfaces.length * 0.3) * (compact ? 0.9 : 1);
    wall.surfaces.forEach((surface, i) => {
      const id = `${wall.id}/${surface}`;
      // Golden angle, so a wall's surfaces fan out instead of bunching on one side.
      const golden = i * 2.399963;
      const jitter = hash(id);
      // Spread the surfaces evenly across the cluster's height, from -0.5 to 0.5.
      const lift = i / (wall.surfaces.length - 1) - 0.5;
      const radius = spread * (0.68 + jitter * 0.44);
      stars.push({
        id,
        label: surface,
        cluster: wall.id,
        position: [
          centre[0] + Math.cos(golden) * radius,
          centre[1] + lift * (1.7 + jitter * 1.2),
          centre[2] + Math.sin(golden) * radius * 0.34 - jitter * 0.5,
        ],
      });
      edges.push({ fromId: id, toId: anchorId(wall.id) });
    });

    // The walls answer to the same control plane, so the ring closes.
    edges.push({
      fromId: anchorId(wall.id),
      toId: anchorId(WALLS[(index + 1) % WALLS.length].id),
    });
  });

  return { anchors, stars, edges };
}
