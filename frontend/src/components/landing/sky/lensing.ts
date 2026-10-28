import * as THREE from "three";

import type { SkyTokens } from "./tokens";

/**
 * Gravitational lensing, as a screen-space pass.
 *
 * Ported from acs-constellation's `createLensingShader`, which came from
 * voidfeed. This is the piece that makes the sky bend: every pixel is pulled
 * toward the hole's silhouette, with two overlapping lobes - a wide drag over
 * the neighbourhood and a tight fold right at the rim that wraps the background
 * back over the edge - and the red and blue channels are displaced by different
 * amounts, so the starfield gains a real chromatic smear instead of a painted
 * ring.
 *
 * Two things carried over because they matter here too. The pass ends at
 * `alpha = 1` nowhere except inside the shadow: the page background and the
 * band's scrim show through the canvas, so the frame's alpha is carried through
 * the displacement and only forced opaque where the sky genuinely stops.
 */

/** The shader object `ShaderPass` takes. Uniform names are voidfeed's. */
export function createLensingShader(palette: SkyTokens) {
  return {
    name: "OctoLensingShader",
    uniforms: {
      tDiffuse: { value: null as THREE.Texture | null },
      /** The hole's centre in uv, measured from the projected world position. */
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      /** Canvas width over height, so `r` is measured in half-heights. */
      uAspect: { value: 1.777 },
      /** The shadow's radius, in the same half-height units. */
      uShadow: { value: 0.05 },
      /** How far the drag reaches. */
      uOuter: { value: 0.42 },
      /** How hard it pulls. */
      uStrength: { value: 0.05 },
      /** 0 draws the frame untouched. */
      uActive: { value: 0 },
      uRing: { value: palette.wash.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tDiffuse;
      uniform vec2 uCenter;
      uniform float uAspect;
      uniform float uShadow;
      uniform float uOuter;
      uniform float uStrength;
      uniform float uActive;
      uniform vec3 uRing;
      varying vec2 vUv;

      void main(){
        if (uActive < 0.001){
          gl_FragColor = texture2D(tDiffuse, vUv);
          return;
        }

        vec2 d = vUv - uCenter;
        d.x *= uAspect;
        float r = length(d);

        /*
         * Past the reach of the bend every term below is zero: the wide lobe has
         * fallen off, the rim fold has, the shadow is fully open and the photon
         * ring has faded. So most of the canvas takes this one-fetch exit instead
         * of the three-channel sample, which is what keeps the pass cheap on a
         * phone.
         */
        if (r > uOuter){
          gl_FragColor = texture2D(tDiffuse, vUv);
          return;
        }

        vec2 dir = r > 1e-5 ? d / r : vec2(0.0);

        float span = max(uOuter - uShadow, 1e-4);
        float t = clamp((r - uShadow) / span, 0.0, 1.0);

        // Two overlapping lobes rather than one smooth falloff. The wide lobe drags
        // the whole neighbourhood inward; the tight lobe sits on the rim and folds
        // the background back over the edge, so the sky wraps the hole instead of
        // merely smearing toward it. That fold is what reads as a lens.
        float wide = pow(1.0 - t, 3.2);
        float rimT = (r - uShadow) / max(uShadow * 0.9, 1e-4);
        float rim = exp(-rimT * rimT * 1.6);
        float bend = uStrength * (wide + rim * 0.7);

        vec2 offset = dir * bend;
        offset.x /= uAspect;
        /*
         * Refraction splits by wavelength: red bends least, blue bends most. The
         * split is a fraction of the pull rather than a second, independent smear,
         * so the fringe stays a colour edge on the bent sky instead of three
         * copies of it.
         */
        vec2 ca = dir * bend * 0.3;
        ca.x /= uAspect;

        vec2 uv = vUv - offset;
        vec4 centre = texture2D(tDiffuse, uv);
        vec4 col;
        col.r = texture2D(tDiffuse, uv + ca).r;
        col.g = centre.g;
        col.b = texture2D(tDiffuse, uv - ca).b;
        col.a = centre.a;

        // Inside the silhouette the sky stops. The values in this buffer are
        // premultiplied, so the shadow zeroes the colour and closes the alpha: the
        // hole is black rather than a window onto the page behind the canvas.
        float shadow = smoothstep(uShadow * 0.8, uShadow * 1.04, r);
        col.rgb *= shadow;
        col.a = mix(1.0, col.a, shadow);

        // Light that orbited the hole before escaping, held in a hairline at the
        // edge of the shadow. Pale and thin: this sits mid-screen, where a bright
        // ring is uncomfortable to look at.
        float ringR = (r - uShadow * 1.07) / max(uShadow * 0.13, 1e-4);
        float photon = exp(-ringR * ringR);
        col.rgb += uRing * photon * 0.22 * uActive;

        gl_FragColor = col;
      }
    `,
  };
}

/**
 * The pass's geometry for one frame.
 *
 * `uShadow` has to be the hole's *on-screen* radius, and the camera orbits, so it
 * is derived each frame from the distance to the hole rather than assumed. A
 * perspective camera with a vertical field of view `fov` sees
 * `2 * distance * tan(fov / 2)` of world at that distance, so a world radius is
 * that radius over the visible height.
 */
export function lensGeometry(
  worldRadius: number,
  distance: number,
  fovDegrees: number,
  aspect: number,
) {
  const visibleHeight = Math.max(0.001, 2 * distance * Math.tan((fovDegrees * Math.PI) / 360));
  const shadow = Math.min(0.9, Math.max(0.005, worldRadius / visibleHeight));
  return {
    shadow,
    outer: Math.min(1.8, shadow * 4),
    strength: shadow * 0.34,
    aspect,
  };
}
