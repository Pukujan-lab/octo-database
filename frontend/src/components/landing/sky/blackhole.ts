import * as THREE from "three";

import type { SkyTokens } from "./tokens";

/**
 * The workspace, as a hole in the sky rather than a painted ring.
 *
 * A port of the singularity from acs-constellation, which is itself a port of
 * voidfeed. The six layers, the noise that drives the gas, and the screen-space
 * lensing pass in `lensing.ts` are that object's structure. What changed: the
 * game's feeding loop is gone, so the three uniforms that used to report hunger,
 * readiness and panic are held at one fixed well-fed level and given a small
 * pulse; and every colour comes from the active design tokens instead of a fixed
 * ramp, so the hole recolours with the palette the way the rest of the page does.
 *
 * Layers, outside in:
 *   1. event horizon  - a black sphere, so the sky behind it is occluded
 *   2. photon ring    - a thin torus hugging the horizon
 *   3. lensing rim    - a fresnel shell that reads as light bending past the edge
 *   4. gas shell      - slow fbm turbulence, visible from any angle
 *   5. accretion disk - two counter-rotating planes at different radii and tilts
 *   6. halo sprites   - three wide soft glows, depth-tested so the black disc
 *                       punches through them
 */

/** The frame, in this band's world units. */
export const HOTLOADER = {
  horizon: 0.86,
  diskInner: 1.18,
  diskOuter: 3.4,
} as const;

/**
 * The radius the lens pass treats as the shadow. This is the horizon sphere
 * itself, not the gas shell around it, so the photon ring and the fresnel rim
 * stay lit: a black disc with gas still glowing around it, which is the shape
 * the hole has to read as.
 */
export const SHADOW_RADIUS = HOTLOADER.horizon;

/**
 * The void is drawn as if it has been fed. voidfeed drove brightness and
 * turbulence from three game states; here they are one constant, and the only
 * variation left is the pulse.
 */
const FEED = 0.62;

/* ------------------------------------------------------------------ glsl */

/**
 * Value noise and five octaves of it. The disk and the gas shell both read from
 * this, which is what gives them structure that moves instead of a gradient that
 * slides.
 */
const GLSL_NOISE = /* glsl */ `
  float hash21(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++){
      v += a * vnoise(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return v;
  }
`;

/* -------------------------------------------------------------- textures */

let softTexture: THREE.Texture | null = null;

/**
 * The halo sprite: neutral white to transparent, so each halo takes its colour
 * from the sprite that uses it.
 */
export function getSoftTexture(): THREE.Texture {
  if (!softTexture) {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.24, "rgba(255,255,255,0.44)");
      g.addColorStop(0.55, "rgba(255,255,255,0.13)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    softTexture = new THREE.CanvasTexture(canvas);
    softTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return softTexture;
}

/* ------------------------------------------------------------- materials */

/**
 * One accretion plane. The radius sets where the band starts and ends; the spin
 * sets which way the gas flows and at what rate, so two planes at different
 * spins shear against each other. Colour runs cool at the inner edge, through the
 * hot middle, out to warm at the limb, and one side is brighter than the other
 * because a disk being fed beams.
 */
function createAccretionMaterial(
  inner: number,
  outer: number,
  spin: number,
  tokens: SkyTokens,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFeed: { value: FEED },
      uPulse: { value: 0 },
      uInner: { value: inner },
      uOuter: { value: outer },
      uSpin: { value: spin },
      // The disk runs cyan at the inner edge, through the palette's violet in
      // the hot middle, out to amber at the limb. That is a thermal ramp the
      // tokens can actually supply; mixing lime with orange instead gives olive.
      uCool: { value: tokens.cool.clone() },
      uHot: { value: tokens.plasma.clone() },
      uWarm: { value: tokens.warm.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main(){
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vLocal;
      uniform float uTime;
      uniform float uFeed;
      uniform float uPulse;
      uniform float uInner;
      uniform float uOuter;
      uniform float uSpin;
      uniform vec3 uCool;
      uniform vec3 uHot;
      uniform vec3 uWarm;
      ${GLSL_NOISE}

      void main(){
        float r = length(vLocal.xy);
        float t = clamp((r - uInner) / max(uOuter - uInner, 0.001), 0.0, 1.0);
        float ang = atan(vLocal.y, vLocal.x);

        float spin = uTime * uSpin * (0.6 + 0.7 * uFeed);
        vec2 q = vec2(ang * 1.7 + r * 0.05 + spin, r * 0.075 - spin * 0.3);
        float n  = fbm(q * 1.7);
        float n2 = fbm(q * 3.6 + 31.0);

        float band = smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.42, 1.0, t));
        float density = (n * 0.72 + n2 * 0.38) * band;

        // One limb is brighter, and the bright side turns slowly.
        float beaming = 0.72 + 0.28 * sin(ang - uTime * 0.22);

        vec3 col = mix(uCool, uHot, smoothstep(0.14, 0.62, density));
        col = mix(col, uWarm, smoothstep(0.34, 1.0, t) * 0.6);

        float alpha = clamp(
          density * (0.42 + 0.3 * uFeed) * beaming * (0.9 + 0.1 * uPulse),
          0.0, 1.0
        ) * 0.85;
        gl_FragColor = vec4(col * (0.85 + 0.6 * uFeed), alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * The gas wrapped around the hole. Latitude and longitude are fed into the same
 * noise as the disk, so the shell and the disk are made of the same weather, and
 * the band keeps it off the poles where it would read as a hat.
 */
function createShellMaterial(tokens: SkyTokens): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFeed: { value: FEED },
      uPulse: { value: 0 },
      uCool: { value: tokens.cool.clone() },
      uWarm: { value: tokens.wash.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main(){
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vLocal;
      uniform float uTime;
      uniform float uFeed;
      uniform float uPulse;
      uniform vec3 uCool;
      uniform vec3 uWarm;
      ${GLSL_NOISE}

      void main(){
        vec3 d = normalize(vLocal);
        float lat = asin(clamp(d.y, -1.0, 1.0));
        float lon = atan(d.z, d.x);

        float spin = uTime * (0.22 + 0.34 * uFeed);
        vec2 q = vec2(lon * 1.5 + spin, lat * 2.6 - spin * 0.35);
        float n  = fbm(q * 1.4);
        float n2 = fbm(q * 3.2 + 19.0);

        float band = pow(1.0 - abs(d.y), 2.4);
        float v = (n * 0.68 + n2 * 0.34) * band;
        v = pow(max(v, 0.0), 1.35);

        vec3 col = mix(uCool, uWarm, smoothstep(0.05, 0.6, v));
        float alpha = clamp(v * (0.4 + 0.32 * uFeed), 0.0, 1.0);
        gl_FragColor = vec4(col * 0.8, alpha * (0.34 + 0.03 * uPulse));
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/**
 * The fresnel shell that does the lensing look from the outside: the grazing
 * angle lights up, and the light is cool in the middle of the band and warm at
 * the very edge.
 */
function createRimMaterial(tokens: SkyTokens): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCool: { value: tokens.wash.clone() },
      uWarm: { value: tokens.warm.clone() },
      uPower: { value: 2.6 },
      uIntensity: { value: 0.34 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vN;
      varying vec3 vV;
      uniform vec3 uCool;
      uniform vec3 uWarm;
      uniform float uPower;
      uniform float uIntensity;
      uniform float uTime;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
        // A slow wobble, not a strobe: an Einstein ring is never a perfect circle.
        float wobble = 0.96 + 0.04 * sin(uTime * 0.9);
        vec3 col = mix(uCool, uWarm, f);
        gl_FragColor = vec4(col * f * uIntensity * wobble, f * uIntensity * wobble);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
}

/* ------------------------------------------------------------- the object */

/**
 * The three wide glows outside the disk, sized against the disk so the hole reads
 * as a hole punched in the sky rather than a lamp. Each sprite is depth-tested,
 * so the black disc eats the middle of the glow and the ring that survives is
 * what reads as a lens.
 */
const HALO_SCALE = [1.05, 1.7, 2.6] as const;
const HALO_OPACITY = [0.1, 0.05, 0.022] as const;

export class BlackHole {
  readonly group = new THREE.Group();

  private readonly horizonMaterial: THREE.MeshBasicMaterial;
  private readonly photonMaterial: THREE.MeshBasicMaterial;
  private readonly rimMaterial: THREE.ShaderMaterial;
  private readonly shellMaterial: THREE.ShaderMaterial;
  private readonly diskAMaterial: THREE.ShaderMaterial;
  private readonly diskBMaterial: THREE.ShaderMaterial;
  private readonly haloMaterials: THREE.SpriteMaterial[] = [];

  private readonly horizon: THREE.Mesh;
  private readonly photonRing: THREE.Mesh;
  private readonly rim: THREE.Mesh;
  private readonly shell: THREE.Mesh;
  private readonly diskA: THREE.Mesh;
  private readonly diskB: THREE.Mesh;
  private readonly halos: THREE.Sprite[] = [];

  private time = 0;

  constructor(tokens: SkyTokens) {
    const base = HOTLOADER.horizon;

    // 1. event horizon: a black sphere, so the starfield behind it is occluded.
    this.horizonMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.horizon = new THREE.Mesh(new THREE.SphereGeometry(base, 64, 48), this.horizonMaterial);
    this.group.add(this.horizon);

    // 2. photon ring: a hairline at the edge of the shadow. Pale, never white-hot:
    //    a bright ring at the centre of the screen is the fastest way to tire eyes.
    this.photonMaterial = new THREE.MeshBasicMaterial({
      color: tokens.wash.clone(),
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.photonRing = new THREE.Mesh(
      new THREE.TorusGeometry(base * 1.045, 0.04, 10, 140),
      this.photonMaterial,
    );
    this.photonRing.rotation.x = Math.PI / 2;
    this.group.add(this.photonRing);

    // 3. lensing rim.
    this.rimMaterial = createRimMaterial(tokens);
    this.rim = new THREE.Mesh(new THREE.SphereGeometry(base * 1.22, 48, 36), this.rimMaterial);
    this.group.add(this.rim);

    // 4. gas shell.
    this.shellMaterial = createShellMaterial(tokens);
    this.shell = new THREE.Mesh(new THREE.SphereGeometry(base * 1.24, 64, 48), this.shellMaterial);
    this.group.add(this.shell);

    // 5. two counter-rotating planes. The second is wider, fainter and tilted off
    //    the first, so the two shear instead of stacking into one flat ring.
    this.diskAMaterial = createAccretionMaterial(
      HOTLOADER.diskInner,
      HOTLOADER.diskOuter,
      1,
      tokens,
    );
    this.diskA = new THREE.Mesh(
      new THREE.PlaneGeometry(HOTLOADER.diskOuter * 2.15, HOTLOADER.diskOuter * 2.15),
      this.diskAMaterial,
    );
    this.diskA.rotation.x = -Math.PI / 2;
    this.group.add(this.diskA);

    this.diskBMaterial = createAccretionMaterial(
      HOTLOADER.diskInner * 1.55,
      HOTLOADER.diskOuter * 1.32,
      -0.42,
      tokens,
    );
    this.diskB = new THREE.Mesh(
      new THREE.PlaneGeometry(HOTLOADER.diskOuter * 3.0, HOTLOADER.diskOuter * 3.0),
      this.diskBMaterial,
    );
    this.diskB.rotation.x = -Math.PI / 2;
    this.diskB.rotation.z = 0.14;
    this.group.add(this.diskB);

    // 6. wide soft halos, tested against depth so the black disc eats the glow.
    const soft = getSoftTexture();
    HALO_SCALE.forEach((scale, i) => {
      const material = new THREE.SpriteMaterial({
        map: soft,
        color: haloColors(tokens)[i].clone(),
        transparent: true,
        opacity: HALO_OPACITY[i],
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(HOTLOADER.diskOuter * scale);
      sprite.renderOrder = -1;
      this.group.add(sprite);
      this.halos.push(sprite);
      this.haloMaterials.push(material);
    });

    // Tilt the assembly so the disk reads open from the ecliptic.
    this.group.rotation.set(0.36, 0, 0.52);
  }

  /**
   * Move the hole onto a new palette. Only the colours change: the geometry, the
   * clock and the camera relationship all survive, so a theme switch recolours
   * the sky without a rebuild or a jump.
   */
  recolor(tokens: SkyTokens) {
    this.photonMaterial.color.copy(tokens.wash);
    this.rimMaterial.uniforms.uCool.value.copy(tokens.wash);
    this.rimMaterial.uniforms.uWarm.value.copy(tokens.warm);
    this.shellMaterial.uniforms.uCool.value.copy(tokens.cool);
    this.shellMaterial.uniforms.uWarm.value.copy(tokens.wash);
    for (const disk of [this.diskAMaterial, this.diskBMaterial]) {
      disk.uniforms.uCool.value.copy(tokens.cool);
      disk.uniforms.uHot.value.copy(tokens.plasma);
      disk.uniforms.uWarm.value.copy(tokens.warm);
    }
    haloColors(tokens).forEach((color, i) => this.haloMaterials[i].color.copy(color));
  }

  /** Advance the hole. `dt` is already scaled by the page's motion setting. */
  update(dt: number) {
    this.time += dt;
    const t = this.time;
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.9);

    this.diskAMaterial.uniforms.uTime.value = t;
    this.diskAMaterial.uniforms.uPulse.value = pulse;
    this.diskBMaterial.uniforms.uTime.value = t;
    this.diskBMaterial.uniforms.uPulse.value = pulse;
    this.shellMaterial.uniforms.uTime.value = t;
    this.shellMaterial.uniforms.uPulse.value = pulse;
    this.rimMaterial.uniforms.uTime.value = t;

    // The pulse keeps the amplitude the painted hotloader had, so nothing here
    // strobes harder than the thing it replaced.
    this.rimMaterial.uniforms.uIntensity.value = 0.34 + pulse * 0.06;
    this.photonMaterial.opacity = 0.3 + pulse * 0.05;

    const breathe = 1 + Math.sin(t * 0.9) * 0.012;
    this.horizon.scale.setScalar(breathe);
    this.photonRing.scale.setScalar(breathe);
    this.rim.scale.setScalar(breathe);
    this.shell.scale.setScalar(breathe);

    this.diskA.rotation.z = t * 0.16;
    this.diskB.rotation.z = 0.14 - t * 0.07;

    for (let i = 0; i < this.halos.length; i += 1) {
      const flicker = 1 + Math.sin(t * (1.1 + i * 0.7)) * 0.05;
      this.halos[i].scale.setScalar(HOTLOADER.diskOuter * HALO_SCALE[i] * breathe * flicker);
      this.haloMaterials[i].opacity = HALO_OPACITY[i] * (0.88 + pulse * 0.18);
    }
  }

  dispose() {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.horizonMaterial.dispose();
    this.photonMaterial.dispose();
    this.rimMaterial.dispose();
    this.shellMaterial.dispose();
    this.diskAMaterial.dispose();
    this.diskBMaterial.dispose();
    for (const material of this.haloMaterials) material.dispose();
    // The soft sprite is cached at module scope and shared by every hole on the
    // page, so it is deliberately left alive: one 256-pixel texture, reused for
    // the whole visit, rather than rebuilt on each mount.
  }
}

/** Inner veil takes the signal colour, the middle the warm one, the outer the starlight. */
function haloColors(tokens: SkyTokens): THREE.Color[] {
  return [tokens.wash, tokens.warm, tokens.light];
}
