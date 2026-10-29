import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

import { BlackHole, SHADOW_RADIUS } from "./sky/blackhole";
import { createLensingShader, lensGeometry } from "./sky/lensing";
import { buildSky, type Vec3 } from "./sky/skyfield";
import { readTokens, type SkyTokens } from "./sky/tokens";
import { INTEGRATION_GUIDE_URL } from "./links";

/** Desktop aims the hole at the middle of the open sky right of the copy column,
 *  so the constellation ring and its wall labels never cross the trace. */
const DESKTOP_AIM_X = -1.9;
/** How far the named field slides right on desktop, in world units. The hole
 *  slides with it, so the ring stays centred on the boundary it is bent around. */
const DESKTOP_SKY_SHIFT = 4.6;

/* ------------------------------------------------------------------- stars */

/** A soft round star. Without this a `PointsMaterial` draws hard squares. */
function starTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.28, "rgba(255,255,255,0.55)");
    g.addColorStop(0.62, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let sharedStarTexture: THREE.CanvasTexture | null = null;
function getStarTexture(): THREE.CanvasTexture {
  if (!sharedStarTexture) sharedStarTexture = starTexture();
  return sharedStarTexture;
}

/** The star's own brightness and warmth, kept so a recolor can replay them. */
type StarSeed = { warm: boolean; k: number };

/**
 * One additive shell of points, so the sky has depth behind the hole. The seed
 * for each star is kept beside its geometry: a palette switch rebuilds the
 * colours from the same seeds, so the field does not reshuffle under a theme
 * change.
 */
function makeStars(
  count: number,
  rMin: number,
  rMax: number,
  warmShare: number,
  tokens: SkyTokens,
) {
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const seeds: StarSeed[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = rMin + Math.random() * (rMax - rMin);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    position[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    position[i * 3 + 1] = r * Math.cos(phi);
    position[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const seed = { warm: Math.random() < warmShare, k: 0.4 + Math.random() * 0.6 };
    seeds.push(seed);
    const c = seed.warm ? tokens.warm : tokens.light;
    color[i * 3] = c.r * seed.k;
    color[i * 3 + 1] = c.g * seed.k;
    color[i * 3 + 2] = c.b * seed.k;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  const material = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: true,
    map: getStarTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    opacity: 0.8,
  });
  return { points: new THREE.Points(geometry, material), seeds };
}

/** Rebuild one shell's colours from its seeds against a new palette. */
function recolorStars(
  points: THREE.Points,
  seeds: StarSeed[],
  tokens: SkyTokens,
) {
  const attribute = points.geometry.getAttribute("color") as THREE.BufferAttribute;
  seeds.forEach((seed, i) => {
    const c = seed.warm ? tokens.warm : tokens.light;
    attribute.setXYZ(i, c.r * seed.k, c.g * seed.k, c.b * seed.k);
  });
  attribute.needsUpdate = true;
}

/**
 * The named layer: one star per surface, a brighter star per wall, and the edges
 * that tie each surface to the wall it belongs to. Positions come from
 * `skyfield`, so they are the same on every load.
 *
 * The stars take `tokens.mark` and the anchors `tokens.beacon`, so the three
 * walls read as the bright things in the field. The edges use the cool token and
 * normal blending rather than additive: a one-pixel hairline added to a
 * near-white background disappears, which would leave the links invisible on
 * half the palettes.
 */
function makeConstellation(tokens: SkyTokens, compact: boolean) {
  const { anchors, stars, edges } = buildSky(compact);

  // The band's copy takes the left of the frame, so on desktop the whole field
  // slides right until its leftmost wall clears the trace. Shifting the
  // coordinates themselves keeps the points, the edges, and the projected labels
  // in agreement; moving the group instead would leave the labels behind.
  if (!compact) {
    const shift = (p: Vec3): Vec3 => [p[0] + DESKTOP_SKY_SHIFT, p[1], p[2]];
    anchors.forEach((anchor) => {
      anchor.position = shift(anchor.position);
    });
    stars.forEach((star) => {
      star.position = shift(star.position);
    });
  }

  const position = new Float32Array(stars.length * 3);
  const color = new Float32Array(stars.length * 3);
  stars.forEach((star, i) => {
    position[i * 3] = star.position[0];
    position[i * 3 + 1] = star.position[1];
    position[i * 3 + 2] = star.position[2];
    color[i * 3] = tokens.mark.r;
    color[i * 3 + 1] = tokens.mark.g;
    color[i * 3 + 2] = tokens.mark.b;
  });

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  starGeometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  const starMaterial = new THREE.PointsMaterial({
    size: 0.62,
    sizeAttenuation: true,
    map: getStarTexture(),
    transparent: true,
    depthWrite: false,
    blending: tokens.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexColors: true,
    opacity: 0.95,
  });

  const anchorPosition = new Float32Array(anchors.length * 3);
  anchors.forEach((anchor, i) => {
    anchorPosition[i * 3] = anchor.position[0];
    anchorPosition[i * 3 + 1] = anchor.position[1];
    anchorPosition[i * 3 + 2] = anchor.position[2];
  });
  const anchorGeometry = new THREE.BufferGeometry();
  anchorGeometry.setAttribute("position", new THREE.BufferAttribute(anchorPosition, 3));
  const anchorMaterial = new THREE.PointsMaterial({
    size: 1.5,
    sizeAttenuation: true,
    map: getStarTexture(),
    transparent: true,
    depthWrite: false,
    blending: tokens.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    color: tokens.beacon.clone(),
    opacity: 0.9,
  });

  const byId = new Map<string, THREE.Vector3>();
  anchors.forEach((anchor) =>
    byId.set(anchor.id, new THREE.Vector3(...anchor.position)),
  );
  stars.forEach((star) => byId.set(star.id, new THREE.Vector3(...star.position)));

  const edgePosition = new Float32Array(edges.length * 6);
  let cursor = 0;
  edges.forEach((edge) => {
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) return;
    edgePosition[cursor] = from.x;
    edgePosition[cursor + 1] = from.y;
    edgePosition[cursor + 2] = from.z;
    edgePosition[cursor + 3] = to.x;
    edgePosition[cursor + 4] = to.y;
    edgePosition[cursor + 5] = to.z;
    cursor += 6;
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(edgePosition.subarray(0, cursor), 3),
  );
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: tokens.cool.clone(),
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    depthTest: true,
  });

  const stars3d = new THREE.Points(starGeometry, starMaterial);
  const anchors3d = new THREE.Points(anchorGeometry, anchorMaterial);
  const links = new THREE.LineSegments(edgeGeometry, edgeMaterial);

  return {
    anchors,
    stars,
    group: new THREE.Group(),
    anchorPoints: anchors3d,
    starPoints: stars3d,
    objects: [stars3d, anchors3d, links],
    geometries: [starGeometry, anchorGeometry, edgeGeometry],
    materials: [starMaterial, anchorMaterial, edgeMaterial],
    recolor(next: SkyTokens) {
      const starColors = starGeometry.getAttribute("color") as THREE.BufferAttribute;
      for (let i = 0; i < stars.length; i += 1) {
        starColors.setXYZ(i, next.mark.r, next.mark.g, next.mark.b);
      }
      starColors.needsUpdate = true;
      const blending = next.dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      starMaterial.blending = blending;
      anchorMaterial.blending = blending;
      anchorMaterial.color.copy(next.beacon);
      edgeMaterial.color.copy(next.cool);
    },
  };
}

/**
 * The band's sky: the ported black hole in a drifting starfield, with the
 * screen-space lensing pass bending everything behind it.
 *
 * The starfield is not scenery. Three labelled anchors are the walls the copy
 * below the band names, and the stars around each one are the surfaces that wall
 * is built from, so the sky and the prose say the same thing twice. The layout is
 * fixed, so a reader who points at a star today points at the same one tomorrow.
 * The hole sits inside that field and bends it: the constellation is what the
 * boundary is holding.
 *
 * The hole itself holds still and the sky moves: the shells drift at their own
 * rates, the hole runs its pulse, and page scroll adds a desktop-only parallax.
 * A drag in the middle of the band orbits the camera around the hole — the same
 * gesture zones ACS uses, so the page keeps its scroll near the edges. The
 * canvas is transparent where nothing is drawn, so the band's scrim and the page
 * background read through it, and the lensing pass carries that alpha through
 * its displacement.
 */
export function ConstellationSky() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  // The scene is built once, so it cannot capture a router function that may be
  // replaced on a later render. The ref is what the card's link reads.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const labels = labelsRef.current;
    const initialTokens = readTokens();
    if (!initialTokens) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let viewWidth = canvas.clientWidth || 1;
    let viewHeight = canvas.clientHeight || 1;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, viewWidth / viewHeight, 0.1, 400);
    // The same framing ACS gives its hero: the hole sits in the sky at about a
    // sixth of the frame's height, with the starfield carrying the rest. Closer
    // than this and the disk stops reading as a hole and starts reading as a
    // plate of gas.
    const home = new THREE.Vector3(1.1, 2.6, 22);
    camera.position.copy(home);

    /*
     * Where the camera looks decides where the hole lands in the frame, and the
     * band's copy decides where it should land. On desktop the copy is a column
     * down the left, so the hole aims at the centre of the open sky beside it
     * rather than at the page's centre; the ring the walls sit on then stays
     * clear of the copy and its labels never cross the trace. On a phone the copy
     * sits at the bottom, so it aims below the origin and the hole rides above it.
     * Both keep the hole clear of the scrim, which is what made it read as a
     * smudge rather than a hole.
     */
    // The named field's geometry is built once, so the layout that frames it is
    // fixed at mount too: a resize that crosses the breakpoint must not move the
    // camera away from stars that are staying where they were laid out.
    const desktop = viewWidth >= 1024;
    const aimTarget = new THREE.Vector3(
      desktop ? DESKTOP_AIM_X : 0,
      desktop ? 0.5 : -1.5,
      0,
    );
    camera.lookAt(aimTarget);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(viewWidth, viewHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearAlpha(0);
    /*
     * The resting state gives the page its vertical scroll. A gesture that starts
     * inside the middle of the band raises this to none for as long as it lasts,
     * so the sky can take a drag too. See `inGestureZone` below.
     */
    renderer.domElement.style.touchAction = "pan-y";
    renderer.domElement.style.cursor = "grab";
    renderer.domElement.setAttribute("aria-hidden", "true");

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(aimTarget);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.enablePan = false;
    // The band is scenery, not a map: orbit it, but do not let a reader lose the
    // hole by zooming past it or under it.
    controls.enableZoom = false;
    controls.minPolarAngle = Math.PI * 0.28;
    controls.maxPolarAngle = Math.PI * 0.72;
    controls.rotateSpeed = 0.55;
    controls.autoRotate = false;
    controls.update();
    // OrbitControls takes touchAction for itself when it connects and sets it to
    // none, which would leave a phone unable to scroll past a full-bleed band.
    renderer.domElement.style.touchAction = "pan-y";

    /* ------------------------------------------------------- the sky's bodies */

    const farShell = new THREE.Group();
    const hole = new BlackHole(initialTokens);
    // The hole and the named field move as one body: the ring is the field the
    // boundary bends, so it has to stay centred on the horizon.
    if (desktop) hole.group.position.x = DESKTOP_SKY_SHIFT;
    // A phone's frame is too narrow for the disk and the ring at the same scale:
    // the disk covers the walls. Shrinking the hole alone keeps the ring where it
    // was laid out and gives the clusters room around the shadow.
    const holeScale = desktop ? 1 : 0.66;
    hole.group.scale.setScalar(holeScale);
    scene.add(farShell, hole.group);

    const far = makeStars(560, 46, 120, 0.14, initialTokens);
    farShell.add(far.points);

    // The named layer holds still while the background drifts: a star you can
    // point at is only useful if it stays where you left it.
    const constellation = makeConstellation(initialTokens, !desktop);
    constellation.group.add(...constellation.objects);
    scene.add(constellation.group);

    const geometries = [
      far.points.geometry,
      ...constellation.geometries,
    ];
    const materials = [
      far.points.material as THREE.Material,
      ...constellation.materials,
    ];

    /* --------------------------------------------------------------- labels */

    /*
     * The three wall labels are DOM, projected from the same camera the scene
     * uses. A WebGL text texture would have to be regenerated for every palette
     * and would blur at the wrong pixel ratio; a projected element inherits the
     * page's own type and colour, which is the point of drawing the walls at all.
     */
    const labelEls = new Map<string, HTMLElement>();
    if (labels) {
      constellation.anchors.forEach((anchor) => {
        const el = document.createElement("span");
        // A phone's frame is 390px wide; the full wall names overlap each other
        // and the nodes, so compact layouts use the short name and the card
        // carries the full one.
        el.textContent = desktop ? anchor.label : anchor.short;
        el.className =
          "absolute left-0 top-0 whitespace-nowrap rounded-sm bg-background/70 px-1.5 py-0.5 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/75 backdrop-blur-[2px] transition-opacity duration-300";
        labels.appendChild(el);
        labelEls.set(anchor.id, el);
      });
    }

    const projected = new THREE.Vector3();
    // Measured once per label: reading `offsetWidth` every frame would force a
    // layout on each one, and the label's type never changes size.
    const labelSizes = new Map<string, { w: number; h: number }>();

    const placeLabels = () => {
      if (!labels) return;
      const rect = canvas.getBoundingClientRect();
      constellation.anchors.forEach((anchor) => {
        const el = labelEls.get(anchor.id);
        if (!el) return;
        projected.set(anchor.position[0], anchor.position[1], anchor.position[2]);
        projected.project(camera);
        const margin = 40 / Math.max(rect.width, 1);
        const visible =
          projected.z < 1 &&
          projected.x > -1 - margin &&
          projected.x < 1 + margin &&
          projected.y > -1 - margin &&
          projected.y < 1 + margin;
        el.style.opacity = visible ? "1" : "0";
        if (!visible) return;

        let size = labelSizes.get(anchor.id);
        if (!size || !size.w) {
          size = { w: el.offsetWidth, h: el.offsetHeight };
          if (size.w) labelSizes.set(anchor.id, size);
        }
        const halfW = size.w / 2;
        // Clamped, so a wall near the frame's edge keeps its whole label on
        // screen instead of losing half of it to the overflow clip.
        const x = Math.min(
          Math.max(((projected.x + 1) / 2) * rect.width, halfW + 6),
          rect.width - halfW - 6,
        );
        const nodeY = ((1 - projected.y) / 2) * rect.height;
        // Above the point where there is room, below it where there is not: on a
        // phone the upper walls sit close to the band's top edge.
        const y = nodeY - 34 - size.h / 2 < 6 ? nodeY + 34 : nodeY - 34;
        el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
      });
    };

    /* --------------------------------------------------------- hit targets */

    /*
     * Every point in the field is a target, tested in screen space against the
     * same projection the labels use. Raycasting a `Points` cloud would need a
     * per-pixel threshold that changes with distance; projecting the seventeen
     * known points costs nothing and answers in the units a finger works in.
     *
     * The lens pass displaces what is drawn near the hole, so the hit radius is
     * generous enough to cover the few pixels of smear at the rim.
     */
    const wallNames = new Map(
      constellation.anchors.map((anchor) => [anchor.id.replace("anchor:", ""), anchor.label]),
    );

    type Target = {
      id: string;
      label: string;
      kind: "wall" | "surface";
      cluster: string;
      point: THREE.Vector3;
    };

    const targets: Target[] = [
      ...constellation.anchors.map((anchor) => ({
        id: anchor.id,
        label: anchor.label,
        kind: "wall" as const,
        cluster: anchor.id.replace("anchor:", ""),
        point: new THREE.Vector3(...anchor.position),
      })),
      ...constellation.stars.map((star) => ({
        id: star.id,
        label: star.label,
        kind: "surface" as const,
        cluster: star.cluster,
        point: new THREE.Vector3(...star.position),
      })),
    ];

    const focus = focusRef.current;
    let ring: HTMLDivElement | null = null;
    let card: HTMLDivElement | null = null;
    let active: Target | null = null;
    let cardHeight = 0;
    if (focus) {
      ring = document.createElement("div");
      ring.className =
        "pointer-events-none absolute left-0 top-0 h-9 w-9 rounded-full border border-primary/70 opacity-0 transition-opacity duration-150";
      focus.appendChild(ring);

      card = document.createElement("div");
      card.className =
        "absolute rounded-lg border border-border bg-background/95 p-4 text-left shadow-xl backdrop-blur transition-opacity duration-200";
      card.style.opacity = "0";
      card.style.pointerEvents = "none";
      focus.appendChild(card);
    }

    const hideCard = () => {
      active = null;
      if (!card) return;
      card.style.opacity = "0";
      card.style.pointerEvents = "none";
    };

    const markRing = (sx: number, sy: number) => {
      if (!ring) return;
      ring.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-50%)`;
      ring.style.opacity = "1";
    };

    const clearRing = () => {
      if (ring) ring.style.opacity = "0";
    };

    const showCard = (target: Target, sx: number, sy: number) => {
      if (!card) return;
      const siblings = constellation.stars.filter((star) => star.cluster === target.cluster);

      card.replaceChildren();
      const eyebrow = document.createElement("p");
      eyebrow.className = "eyebrow";
      eyebrow.textContent = target.kind === "wall" ? "Wall" : "Surface";

      const heading = document.createElement("p");
      heading.className = "mt-1.5 font-display text-sm font-semibold leading-snug";
      heading.textContent = target.label;

      const copy = document.createElement("p");
      copy.className = "mt-1.5 text-xs leading-relaxed text-muted-foreground";
      copy.textContent =
        target.kind === "wall"
          ? siblings.map((star) => star.label).join(" · ")
          : `Part of ${wallNames.get(target.cluster) ?? target.cluster}`;

      const link = document.createElement("a");
      link.href = INTEGRATION_GUIDE_URL;
      link.className =
        "mt-3 inline-block text-xs text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:decoration-primary";
      link.textContent = "Integration guide →";
      // A plain href would reload the whole app; the band is a client route away
      // from the guide, so hand it to the router instead.
      link.addEventListener("click", (event) => {
        event.preventDefault();
        navigateRef.current(INTEGRATION_GUIDE_URL);
      });

      card.append(eyebrow, heading, copy, link);

      active = target;
      const rect = canvas.getBoundingClientRect();
      card.style.width = `${Math.min(272, rect.width - 32)}px`;
      card.style.opacity = "1";
      card.style.pointerEvents = "auto";
      // Measured once when the content lands, then reused: reading the height
      // on every frame would force a layout inside the render loop.
      cardHeight = card.offsetHeight;
      placeActive(sx, sy);
    };

    /** Keeps the ring on the point and the card beside it as the camera moves. */
    const placeActive = (sx: number, sy: number) => {
      if (!card) return;
      const rect = canvas.getBoundingClientRect();
      if (ring) {
        ring.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-50%)`;
        ring.style.opacity = "1";
      }

      const width = Math.min(272, rect.width - 32);
      const height = cardHeight || card.offsetHeight;

      let left = sx + 20;
      let top = sy + 20;
      if (left + width > rect.width - 16) left = sx - width - 20;
      if (top + height > rect.height - 16) top = sy - height - 20;
      card.style.left = `${Math.max(16, left)}px`;
      card.style.top = `${Math.max(16, top)}px`;
    };

    const probe = new THREE.Vector3();
    const hitTest = (clientX: number, clientY: number, touch: boolean) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const reach = touch ? 26 : 16;
      let best: Target | null = null;
      let bestDistance = Infinity;
      let bestX = 0;
      let bestY = 0;
      for (const target of targets) {
        probe.copy(target.point).project(camera);
        if (probe.z >= 1) continue;
        const px = ((probe.x + 1) / 2) * rect.width;
        const py = ((1 - probe.y) / 2) * rect.height;
        const distance = Math.hypot(px - x, py - y);
        // Walls are drawn larger than surfaces, so they get the wider reach and
        // win a near-tie against a surface sitting just beside them.
        if (distance > (target.kind === "wall" ? reach * 1.6 : reach)) continue;
        if (distance >= bestDistance) continue;
        best = target;
        bestDistance = distance;
        bestX = px;
        bestY = py;
      }
      return best ? { target: best, sx: bestX, sy: bestY } : null;
    };

    /** Re-projects the open target so the card stays pinned to its point. */
    const trackActive = () => {
      if (!active) return;
      const rect = canvas.getBoundingClientRect();
      probe.copy(active.point).project(camera);
      if (probe.z >= 1) {
        hideCard();
        return;
      }
      placeActive(((probe.x + 1) / 2) * rect.width, ((1 - probe.y) / 2) * rect.height);
    };

    /* --------------------------------------------------------- lensing pass */

    let composer: EffectComposer | null = null;
    let lensPass: ShaderPass | null = null;

    const ensureComposer = () => {
      if (composer) return composer;
      const built = new EffectComposer(renderer);
      built.addPass(new RenderPass(scene, camera));
      const pass = new ShaderPass(createLensingShader(initialTokens));
      // A full-screen quad that replaces what it draws over, so the frame is not
      // blended onto itself by the pass.
      pass.material.blending = THREE.NoBlending;
      built.addPass(pass);
      const output = new OutputPass();
      output.material.blending = THREE.NoBlending;
      built.addPass(output);
      composer = built;
      lensPass = pass;
      return built;
    };

    const lensPoint = new THREE.Vector3();

    /** The hole's centre and on-screen radius for this frame, in pass units. */
    const aimLens = () => {
      hole.group.updateWorldMatrix(true, false);
      lensPoint.set(0, 0, 0).applyMatrix4(hole.group.matrixWorld);
      const distance = camera.position.distanceTo(lensPoint);
      lensPoint.project(camera);
      if (lensPoint.z > 1 || Math.abs(lensPoint.x) > 1.45 || Math.abs(lensPoint.y) > 1.45) {
        return null;
      }
      const shape = lensGeometry(
        SHADOW_RADIUS * holeScale,
        distance,
        camera.fov,
        camera.aspect,
      );
      return {
        x: (lensPoint.x + 1) / 2,
        // The pass samples a quad whose uv has y = 0 at the bottom, same as NDC.
        y: (lensPoint.y + 1) / 2,
        ...shape,
      };
    };

    /* ------------------------------------------------------------ theme sync */

    // The palette lives on <html>; a theme or design switch recolours the sky
    // in place rather than tearing the scene down.
    const paletteObserver = new MutationObserver(() => {
      const next = readTokens();
      if (!next) return;
      hole.recolor(next);
      recolorStars(far.points, far.seeds, next);
      constellation.recolor(next);
      // The lens pass owns the photon ring it draws over the shadow, and it is
      // built once, so its one colour has to be carried across by hand.
      if (lensPass) {
        (lensPass.material.uniforms.uRing.value as THREE.Color).copy(next.wash);
      }
    });
    paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-design"],
    });

    /* -------------------------------------------------------------- motion */

    let running = false;
    let onScreen = true;
    let frame = 0;
    let previous = 0;
    let elapsed = 0;
    // Page scroll moves the shells, on desktop only: on a phone the sky sliding
    // under a scrolling thumb reads as broken, not as depth. It is measured from
    // the band's own position, so a deep link that lands mid-page does not start
    // the sky already offset.
    const parallax = window.matchMedia("(min-width: 1024px)").matches;
    let scrollOffset = 0;
    const measureScroll = () => {
      if (!parallax) return;
      const rect = canvas.getBoundingClientRect();
      scrollOffset = window.innerHeight - rect.top;
    };

    const render = (delta: number) => {
      elapsed += delta;
      const drift = reduced ? 0.15 : 1;

      farShell.rotation.y = -elapsed * 0.006 * drift;
      farShell.rotation.x = Math.sin(elapsed * 0.02) * 0.03 * drift;
      if (parallax) {
        farShell.position.y = scrollOffset * 0.006;
      }

      // The drag the reader made is applied before the hole is measured, so the
      // lens is aimed at where the hole is this frame rather than last frame.
      controls.update();

      hole.update(delta * (reduced ? 0.35 : 1));

      // Labels follow the camera, so they are placed after the controls settle.
      placeLabels();
      // An open card is anchored to a world point, so it has to follow the same
      // camera as the labels or it detaches the moment the sky is dragged.
      trackActive();

      const aim = aimLens();
      if (aim) {
        ensureComposer();
        const uniforms = lensPass!.material.uniforms;
        (uniforms.uCenter.value as THREE.Vector2).set(aim.x, aim.y);
        uniforms.uAspect.value = aim.aspect;
        uniforms.uShadow.value = aim.shadow;
        uniforms.uOuter.value = aim.outer;
        uniforms.uStrength.value = aim.strength;
        uniforms.uActive.value = 1;
        composer!.render(delta);
      } else {
        if (lensPass) lensPass.material.uniforms.uActive.value = 0;
        renderer.render(scene, camera);
      }
    };

    const tick = (now: number) => {
      if (!running) return;
      const delta = previous ? Math.min((now - previous) / 1000, 0.05) : 0.016;
      previous = now;
      render(delta);
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
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
      if (onScreen && !document.hidden) start();
      else stop();
    };

    const onVisibility = () => sync();
    window.addEventListener("scroll", measureScroll, { passive: true });

    /* -------------------------------------------------------------- gestures */

    /*
     * Where a gesture starts decides who gets it. The middle of the band belongs
     * to the sky; a band round the edge stays the page's, so a reader can always
     * swipe past a full-bleed sky on a phone. 20% of each axis, never thinner
     * than 44px, which is the smallest thing a thumb is.
     */
    const GESTURE_EDGE = 0.2;
    const GESTURE_EDGE_PX = 44;

    const inGestureZone = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const bandX = Math.max(rect.width * GESTURE_EDGE, GESTURE_EDGE_PX);
      const bandY = Math.max(rect.height * GESTURE_EDGE, GESTURE_EDGE_PX);
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      return x > bandX && x < rect.width - bandX && y > bandY && y < rect.height - bandY;
    };

    /*
     * Registered on the canvas in the capture phase, so it answers before
     * OrbitControls sees the pointer. Inside the zone the sky takes the gesture;
     * outside it the controls go quiet and the page keeps scrolling. Chromium
     * latches touch-action from the style committed before a gesture begins, so
     * the value is set here rather than on the first move.
     */
    let downInside = false;
    // A press that never travels is a tap: the sky treats it as a click on
    // whatever it started over. A press that travels is a drag, and a drag must
    // not open a card on release.
    let downAt = { x: 0, y: 0 };
    let dragged = false;

    const onPointerDown = (event: PointerEvent) => {
      downInside = inGestureZone(event.clientX, event.clientY);
      downAt = { x: event.clientX, y: event.clientY };
      dragged = false;
      controls.enabled = downInside;
      canvas.style.touchAction = downInside ? "none" : "pan-y";
      if (downInside) {
        // A drag here is the sky's, not the page's: without this the browser
        // treats it as a text selection and paints the copy behind the band.
        event.preventDefault();
        canvas.style.cursor = "grabbing";
      }
    };

    const releaseGesture = (event: PointerEvent) => {
      canvas.style.touchAction = "pan-y";
      canvas.style.cursor = "grab";
      downInside = false;
      const travel = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      if (dragged || travel > 8) return;
      const hit = hitTest(event.clientX, event.clientY, event.pointerType !== "mouse");
      if (hit) {
        markRing(hit.sx, hit.sy);
        showCard(hit.target, hit.sx, hit.sy);
      } else {
        hideCard();
        clearRing();
      }
    };

    /** `pointercancel` is the browser taking the gesture back, never a tap. */
    const cancelGesture = () => {
      downInside = false;
      dragged = false;
      canvas.style.touchAction = "pan-y";
      canvas.style.cursor = "grab";
    };

    const onTouchMove = (event: TouchEvent) => {
      if (downInside) event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      // A press that is still down is a drag, not a hover: leave the cursor
      // alone and remember that this gesture was not a tap.
      if (event.buttons) {
        if (downInside) dragged = true;
        return;
      }
      if (event.pointerType !== "mouse") return;
      const hit = hitTest(event.clientX, event.clientY, false);
      canvas.style.cursor = hit
        ? "pointer"
        : inGestureZone(event.clientX, event.clientY)
          ? "grab"
          : "default";
    };

    const onPointerLeave = () => {
      canvas.style.cursor = "grab";
    };

    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("pointerup", releaseGesture);
    canvas.addEventListener("pointercancel", cancelGesture);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });

    // Reduced motion slows the sky instead of stopping it, matching the hole's
    // own reduced-motion behaviour.
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onReducedMotion = () => sync();

    const resizeObserver = new ResizeObserver(() => {
      viewWidth = canvas.clientWidth || 1;
      viewHeight = canvas.clientHeight || 1;
      camera.aspect = viewWidth / viewHeight;
      camera.updateProjectionMatrix();
      // The aim and the named field's layout are both mount-time decisions, so a
      // resize only re-frames: moving the aim here would take the hole off a ring
      // that is staying where it was laid out.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(ratio);
      renderer.setSize(viewWidth, viewHeight, false);
      if (composer) {
        composer.setPixelRatio(ratio);
        composer.setSize(viewWidth, viewHeight);
      }
      if (!running) render(0);
    });
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
    reducedQuery.addEventListener("change", onReducedMotion);

    measureScroll();
    render(0);
    sync();

    return () => {
      stop();
      paletteObserver.disconnect();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("scroll", measureScroll);
      reducedQuery.removeEventListener("change", onReducedMotion);
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointerup", releaseGesture);
      canvas.removeEventListener("pointercancel", cancelGesture);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("touchmove", onTouchMove);
      labelEls.forEach((el) => el.remove());
      ring?.remove();
      card?.remove();
      controls.dispose();
      hole.dispose();
      lensPass?.dispose();
      composer?.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      renderer.dispose();
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
      <div
        ref={labelsRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
      <div ref={focusRef} className="pointer-events-none absolute inset-0 z-10" />
    </>
  );
}
