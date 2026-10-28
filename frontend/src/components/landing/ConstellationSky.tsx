import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

import { BlackHole, SHADOW_RADIUS } from "./sky/blackhole";
import { createLensingShader, lensGeometry } from "./sky/lensing";
import { readTokens, type SkyTokens } from "./sky/tokens";

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
 * The band's sky: the ported black hole in a drifting starfield, with the
 * screen-space lensing pass bending everything behind it.
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
     * down the left, so the hole aims right of centre; on a phone the copy sits
     * at the bottom, so it aims below the origin and the hole rides above it.
     * Both keep the hole clear of the scrim, which is what made it read as a
     * smudge rather than a hole.
     */
    const aimTarget = new THREE.Vector3(
      viewWidth >= 1024 ? -1.9 : 0,
      viewWidth >= 1024 ? 0.5 : -1.5,
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
    const nearShell = new THREE.Group();
    const hole = new BlackHole(initialTokens);
    scene.add(farShell, nearShell, hole.group);

    const far = makeStars(560, 46, 120, 0.14, initialTokens);
    const near = makeStars(220, 22, 46, 0.26, initialTokens);
    farShell.add(far.points);
    nearShell.add(near.points);

    const geometries = [far.points.geometry, near.points.geometry];
    const materials = [far.points.material as THREE.Material, near.points.material as THREE.Material];

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
      const shape = lensGeometry(SHADOW_RADIUS, distance, camera.fov, camera.aspect);
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
      recolorStars(near.points, near.seeds, next);
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
      nearShell.rotation.y = elapsed * 0.012 * drift;
      farShell.rotation.x = Math.sin(elapsed * 0.02) * 0.03 * drift;
      if (parallax) {
        farShell.position.y = scrollOffset * 0.006;
        nearShell.position.y = scrollOffset * 0.013;
      }

      // The drag the reader made is applied before the hole is measured, so the
      // lens is aimed at where the hole is this frame rather than last frame.
      controls.update();

      hole.update(delta * (reduced ? 0.35 : 1));

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
    const onPointerDown = (event: PointerEvent) => {
      downInside = inGestureZone(event.clientX, event.clientY);
      controls.enabled = downInside;
      canvas.style.touchAction = downInside ? "none" : "pan-y";
      if (downInside) {
        // A drag here is the sky's, not the page's: without this the browser
        // treats it as a text selection and paints the copy behind the band.
        event.preventDefault();
        canvas.style.cursor = "grabbing";
      }
    };

    const releaseGesture = () => {
      canvas.style.touchAction = "pan-y";
      canvas.style.cursor = "grab";
    };

    const onTouchMove = (event: TouchEvent) => {
      if (downInside) event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") {
        canvas.style.cursor = inGestureZone(event.clientX, event.clientY) ? "grab" : "default";
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("pointerup", releaseGesture);
    canvas.addEventListener("pointercancel", releaseGesture);
    canvas.addEventListener("pointermove", onPointerMove);
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
      // The aim target is a breakpoint decision, not a per-pixel one: only move
      // it when the band has actually crossed into the other layout, or a resize
      // would yank the hole out from under a reader who is dragging it.
      const wantX = viewWidth >= 1024 ? -1.9 : 0;
      const wantY = viewWidth >= 1024 ? 0.5 : -1.5;
      if (aimTarget.x !== wantX || aimTarget.y !== wantY) {
        aimTarget.set(wantX, wantY, 0);
        controls.target.copy(aimTarget);
        controls.update();
      }
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
      canvas.removeEventListener("pointercancel", releaseGesture);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("touchmove", onTouchMove);
      controls.dispose();
      hole.dispose();
      lensPass?.dispose();
      composer?.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}
