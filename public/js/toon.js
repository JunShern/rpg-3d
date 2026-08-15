// toon.js -- the look.
//
// Three pieces make the vinyl-toon read, and they are deliberately separable so
// each can be judged on its own:
//
//   1. a BANDED ramp        -- lighting quantised to a few steps, not smooth
//   2. a RIM light          -- a bright edge facing away from the key light,
//                              which is what stops banded shading reading flat
//   3. an INVERTED-HULL outline -- a backface-only shell pushed along the normal
//
// The outline width is scaled by view depth so it stays roughly constant in
// SCREEN space: a world-space width would make the character's outline vanish
// at distance and swallow their face up close.

import * as THREE from 'three';

/** A 1-D nearest-filtered ramp.  `steps` are 0..255 luminance stops. */
export function gradientMap(steps) {
  const tex = new THREE.DataTexture(
    new Uint8Array(steps), steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// Three bands: deep shadow, a wide midtone that carries the local colour, and a
// narrow lit band.  Four+ bands start looking like ordinary smooth shading.
export const RAMP_3 = gradientMap([48, 48, 170, 170, 170, 255]);
export const RAMP_SOFT = gradientMap([88, 88, 166, 166, 212, 212, 255]);

export function toonMaterial(color, opts = {}) {
  const {
    gradient = RAMP_3,
    rimColor = 0xbfe4ff,
    rimPower = 2.6,
    rimStrength = 0.55,
    key = 'default',
    map = null,
  } = opts;

  const mat = new THREE.MeshToonMaterial({ color, gradientMap: gradient, map });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: new THREE.Color(rimColor) };
    shader.uniforms.uRimPower = { value: rimPower };
    shader.uniforms.uRimStrength = { value: rimStrength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3 uRimColor;
        uniform float uRimPower;
        uniform float uRimStrength;
      `)
      // hook before tone mapping so the rim is tone-mapped with everything else
      .replace('#include <tonemapping_fragment>', /* glsl */`
        {
          float f = 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
          gl_FragColor.rgb += uRimColor * pow(f, uRimPower) * uRimStrength;
        }
        #include <tonemapping_fragment>
      `);
  };
  // distinct programs per rim config, or three would reuse the first compile
  mat.customProgramCacheKey = () => 'toonrim:' + key;
  return mat;
}

/** Flat unlit -- for eyes, which must read the same in shadow as in sun. */
export function flatMaterial(color) {
  return new THREE.MeshBasicMaterial({ color });
}

/**
 * Inverted-hull outline.  Renders backfaces only, with every vertex pushed
 * along its (skinned) normal in view space.  Skinning chunks are included
 * explicitly so the shell deforms with the character instead of staying in
 * bind pose -- without skinnormal_vertex the outline peels off during a run.
 */
export function outlineMaterial(color = 0x241d2b, width = 0.0038) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: width },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      uniform float uWidth;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        vec3 n = normalize(normalMatrix * objectNormal);
        // -mvPosition.z is view depth: this keeps the outline a constant
        // thickness on screen rather than in the world.
        mvPosition.xyz += n * (-mvPosition.z) * uWidth;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
  });
}

/**
 * A copy of `geo` whose normals are AVERAGED across every vertex that shares a
 * position -- the shell geometry an inverted-hull outline needs.
 *
 * Hard-edged geometry (a box, a cylinder cap, a flat-shaded icosahedron) stores
 * one vertex per face corner, each with its own face normal.  Push those along
 * their own normals and the corner comes apart: the faces slide in three
 * different directions and the outline sprouts visible black flanges off every
 * edge.  Averaging first makes the corner move as one point, so the shell
 * inflates instead of exploding.  Smooth meshes are unaffected by this pass,
 * which is why the character looked right while the crates did not.
 */
export function outlineGeometry(geo) {
  const g = geo.clone();
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  if (!nrm) return g;

  const buckets = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(4)}|${pos.getY(i).toFixed(4)}|${pos.getZ(i).toFixed(4)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = { x: 0, y: 0, z: 0, idx: [] });
    b.x += nrm.getX(i); b.y += nrm.getY(i); b.z += nrm.getZ(i);
    b.idx.push(i);
  }
  for (const b of buckets.values()) {
    if (b.idx.length === 1) continue;
    const len = Math.hypot(b.x, b.y, b.z) || 1;
    for (const i of b.idx) nrm.setXYZ(i, b.x / len, b.y / len, b.z / len);
  }
  nrm.needsUpdate = true;
  return g;
}

/** A vertical sky gradient on an inward-facing sphere. */
export function skyDome(top, horizon, radius = 220) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uHorizon: { value: new THREE.Color(horizon) },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      varying vec3 vWorld;
      void main() {
        float h = clamp(normalize(vWorld).y * 1.35 + 0.18, 0.0, 1.0);
        gl_FragColor = vec4(mix(uHorizon, uTop, pow(h, 0.75)), 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 20), mat);
  dome.frustumCulled = false;
  return dome;
}
