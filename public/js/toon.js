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
export function gradientMap(steps, smooth = false) {
  const tex = new THREE.DataTexture(
    new Uint8Array(steps), steps.length, 1, THREE.RedFormat);
  // NEAREST gives the hard cel step; LINEAR turns the same table into a ramp
  // with soft terminators -- still banded, but the band edges become short
  // gradients instead of a razor line. Painted-toon (Ni no Kuni, BotW) is the
  // second one: you can see where the light stops without a saw-tooth edge
  // crawling across every curved surface as the character turns.
  tex.minFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  tex.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// The painted ramp: a deep shadow band that holds, a soft roll into a broad
// midtone, and a short bright lip at the top so the key still reads as a key.
// THE SHADOW BAND IS 66, NOT 54. Three candidates were captured side by side
// on the plaza and the hill: at 54 the shaded half of the square went navy
// and the grass under a warm key drifted to mustard. 66 keeps the shadows
// blue and leaves the local colour readable inside them.
export const RAMP_PAINTED = gradientMap(
  [66, 66, 72, 100, 150, 164, 168, 170, 196, 248], true);
export const RAMPS = { cel: null, painted: RAMP_PAINTED };

// Three bands: deep shadow, a wide midtone that carries the local colour, and a
// narrow lit band.  Four+ bands start looking like ordinary smooth shading.
//
// THE SHADOW BAND IS 70, NOT 48. At 48 it multiplies to 19% and anything with a
// dark albedo goes to nearly nothing -- bark at (0.34,0.25,0.19) landed at 6%
// luminance, so tree trunks, barrels and crates rendered as holes cut in the
// image rather than as dark objects. A toon shadow should be a dark VALUE of
// the colour, not the absence of one.
export const RAMP_3 = gradientMap([70, 70, 170, 170, 170, 255]);
// THE ENVIRONMENT'S RAMP, and its shadow band is 112, not 88. At 88 a shaded
// facade multiplies to 35% and, under a fill that used to be strongly blue,
// nine buildings' worth of distinct colour collapsed into one murk. Raising the
// band costs a little of the banding's punch on lit surfaces and buys back the
// difference between terracotta and teal on unlit ones, which is the trade
// worth making in a square that is mostly in shade.
export const RAMP_SOFT = gradientMap([112, 112, 176, 176, 216, 216, 255]);

/**
 * WIND.
 *
 * One clock, shared by every material that sways, so nothing drifts out of
 * phase with anything else. `main.js` advances it; the vertex shaders read it.
 *
 * The displacement is applied to the WHOLE object, not scaled by height above
 * its own base, and that is deliberate rather than lazy: these meshes are built
 * with world coordinates baked into their vertices and then joined by material,
 * so there is no per-vertex "how far up this plant am I" to scale by. A canopy
 * is a separate blob sitting on a trunk that does not move, so drifting the
 * whole blob reads as the branches flexing; a grass tuft is 30 cm tall and
 * moves 3 cm, which reads as motion and not as sliding.
 */
export const WIND = { value: 0 };

/** The vertex-shader body both the lit material and its outline shell use. */
const SWAY_GLSL = /* glsl */`
  {
    // two frequencies at right angles, so it gusts rather than metronomes
    float ph = transformed.x * 0.35 + transformed.z * 0.27;
    float a = sin(uWind * 1.10 + ph) * 0.68
            + sin(uWind * 2.30 + ph * 1.7 + 1.3) * 0.32;
    float b = sin(uWind * 0.87 + ph * 1.3 + 2.1);
    transformed.x += a * uSway;
    transformed.z += b * uSway * 0.45;
  }
`;

const RIM_UNIFORMS = [];
const RIM_SCALE = { value: 1 };
/** Scale every rim light at once, for A/B-ing a frame. `__rim(0)` = off. */
export function setRimScale(k) {
  RIM_SCALE.value = k;
  for (const u of RIM_UNIFORMS) u.value = u.userData.base * k;
}

/**
 * THE LOOK IS A PROFILE, NOT A HARD-CODED STYLE.
 *
 * Everything visual in this build was one style with no alternative: the
 * banded ramp, the rim, the inverted hull and the light rig were each written
 * once and assumed everywhere. None of that is load-bearing on the GEOMETRY,
 * the collision, the textures or the vertex colours -- so the honest answer to
 * "are we locked in" is no, and the honest way to show it is to make the other
 * option runnable rather than describable.
 *
 * `surfaceMaterial` below returns a MeshToonMaterial or a MeshStandardMaterial
 * from the same recipe, so the two looks can be compared on the same frame.
 *
 * THE PALETTE IS THE CATCH. These colours were authored as toon MIDTONES --
 * `arch_lib.palette` says so outright: "values are the toon ramp's MIDTONE, so
 * they run brighter and more saturated than a PBR albedo would". Handing them
 * unchanged to a smooth shader gives a bleached, chalky scene. `albedo` below
 * is the correction: pull the value down and the saturation in, which is
 * roughly the inverse of what the ramp was doing.
 */
export const LOOKS = {
  // THE LOOK. Warm key, cool sky fill, a soft-terminator ramp, a real horizon
  // and a sun in the dome. Shade is cool by HUE, not just darker: that is what
  // separates a painted afternoon from a lit model. The `toon` look below is
  // kept as it was, as the A/B control.
  painted: {
    label: 'painted',
    lit: false,
    outlines: true,
    rim: 1.0,
    // A warm key, but not an orange one -- 0xffd8a4 turned every green to
    // olive. The bounce from the ground is warm too, the sky fill is blue,
    // and a little cool ambient keeps the shadow side from going dead.
    key: { color: 0xffe2bc, intensity: 2.8, position: [11, 17, 8] },
    hemi: { sky: 0xbdd0ee, ground: 0x9c8668, intensity: 1.0 },
    ambient: { color: 0x8a8ea8, intensity: 0.22 },
    exposure: 1.0,
    albedo: 1,
    ramp: 'painted',
    sky: { top: 0x3b76c9, mid: 0x9cc3e8, horizon: 0xeddfcc, sun: 0xffe3ba },
    fog: { color: 0xe0dcd0, near: 38, far: 160 },
  },
  // THE HOUR AFTER THE BEACON. Not a look you choose: the world slides into
  // it over a few seconds when the coals take, because a beacon lit at noon
  // is a campfire and a beacon lit against a darkening sky is a beacon.
  // Same ramp, same materials -- only the light, the sky and the fog move,
  // so the blend is a lerp of numbers and never a rebuild.
  dusk: {
    label: 'dusk',
    lit: false, outlines: true, rim: 1.0,
    key: { color: 0xffa868, intensity: 1.9, position: [14, 7, 6] },
    hemi: { sky: 0x7d8cc4, ground: 0x6c4e3e, intensity: 0.95 },
    ambient: { color: 0x5a6494, intensity: 0.34 },
    exposure: 0.98, albedo: 1, ramp: 'painted',
    sky: { top: 0x24407a, mid: 0xc9744f, horizon: 0xffc98a, sun: 0xffb070 },
    fog: { color: 0xd9a488, near: 30, far: 150 },
    lamps: 2.8,
  },
  toon: {
    label: 'toon',
    lit: false,
    outlines: true,
    rim: 1,
    key: { color: 0xfff2d8, intensity: 2.5, position: [7, 24, 9] },
    hemi: { sky: 0xd2e2ee, ground: 0x8f7f6a, intensity: 0.88 },
    ambient: { color: 0x9d9aa4, intensity: 0.26 },
    exposure: 1.02,
    albedo: 1,
    ramp: 'cel',
    sky: { top: 0x5fa8e8, mid: null, horizon: 0xd6ebf7, sun: 0x000000 },
    fog: { color: 0xd2e6f3, near: 42, far: 130 },
  },
  lit: {
    label: 'lit',
    lit: true,
    // No inverted hull. An ink outline is a stylisation, and leaving it on
    // under smooth shading gives neither look -- it reads as a rendering bug.
    outlines: false,
    rim: 0,
    // A real midday sun is a hard, slightly warm key with very little else.
    // The toon rig needed a big neutral fill because the ramp crushed shadows;
    // a standard shader does not, and keeping that fill makes everything flat.
    // Tuned against the plaza, which is the hard case: it is a courtyard, so
    // most of it is in shade most of the time. The first pass cut the fill hard
    // -- correct in principle, since a standard shader does not need the big
    // neutral fill the ramp did -- and took the shaded half to near black. A
    // fair comparison needs the realistic look to be GOOD, not a strawman.
    key: { color: 0xfff4e2, intensity: 2.7 },
    hemi: { sky: 0xa8cbec, ground: 0x7a6d58, intensity: 0.95 },
    ambient: { color: 0x8e8aa0, intensity: 0.22 },
    exposure: 1.12,
    // toon midtone -> approximate albedo
    albedo: 0.74,
  },
};

/** Pull a toon midtone down toward a plausible albedo. */
function toAlbedo(c, k) {
  if (k >= 1) return c;
  const out = c.clone();
  // desaturate slightly as well as darken: the ramp's lit band was doing some
  // of the saturation work and a smooth shader will not
  const l = out.r * 0.299 + out.g * 0.587 + out.b * 0.114;
  out.lerp(new THREE.Color(l, l, l), 0.12).multiplyScalar(k);
  return out;
}

/**
 * One recipe, either shading model. `look` is a member of LOOKS.
 */
export function surfaceMaterial(look, color, opts = {}) {
  if (!look.lit) {
    const gradient = RAMPS[look.ramp] || RAMP_3;
    // the ramp is part of the program, so it has to be part of the cache key
    return toonMaterial(color, { gradient, ...opts,
                                 key: `${opts.key || 'default'}:${look.ramp || 'cel'}` });
  }
  const { map = null, vertexColors = false, opacity = 1, roughness = 0.92 } = opts;
  return new THREE.MeshStandardMaterial({
    color: toAlbedo(color instanceof THREE.Color ? color : new THREE.Color(color),
                    look.albedo),
    map, vertexColors, roughness, metalness: 0.0,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
  });
}

export function toonMaterial(color, opts = {}) {
  const {
    gradient = RAMP_3,
    rimColor = 0xbfe4ff,
    rimPower = 2.6,
    rimStrength = 0.55,
    key = 'default',
    map = null,
    sway = 0,
    vertexColors = false,
    opacity = 1,
    ripple = 0,
  } = opts;

  const mat = new THREE.MeshToonMaterial({ color, gradientMap: gradient, map,
                                           vertexColors,
                                           transparent: opacity < 1,
                                           opacity,
                                           depthWrite: opacity >= 1 });

  mat.onBeforeCompile = (shader) => {
    if (sway > 0) {
      shader.uniforms.uWind = WIND;
      shader.uniforms.uSway = { value: sway };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWind;\nuniform float uSway;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>' + SWAY_GLSL);
    }
    // WATER MOVES. A flat blue plane is a painted floor however it is lit;
    // two slow bands of light crossing it, phased off world position and the
    // wind clock everything else keeps, is what says liquid. Fragment-side,
    // so the geometry stays the one triangle strip it is.
    if (ripple > 0) {
      if (!shader.uniforms.uWind) shader.uniforms.uWind = WIND;
      shader.uniforms.uRipple = { value: ripple };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vRipplePos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n'
          + 'vRipplePos = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        // the vertex and fragment programs declare separately: sway only
        // put uWind in the vertex one
        .replace('#include <common>', '#include <common>\nvarying vec2 vRipplePos;'
          + '\nuniform float uWind;\nuniform float uRipple;')
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          {
            vec2 q = vRipplePos;
            float a = sin(q.x * 1.9 + q.y * 0.7 + uWind * 1.6);
            float b = sin(q.x * 0.6 - q.y * 2.3 - uWind * 1.1 + 1.3);
            float c = sin((q.x + q.y) * 4.1 + uWind * 2.7);
            float w = a * b * 0.5 + 0.5;
            float band = smoothstep(0.70, 0.98, w) * (0.6 + 0.4 * c);
            diffuseColor.rgb *= 1.0 + uRipple * (0.10 * (a * b) + 0.55 * band);
          }
        `);
    }
    shader.uniforms.uRimColor = { value: new THREE.Color(rimColor) };
    shader.uniforms.uRimPower = { value: rimPower };
    shader.uniforms.uRimStrength = { value: rimStrength };
    // A/B KNOB, and the reason it exists: rim uniforms live inside the compiled
    // program, so from outside a material there is no way to turn the rim off
    // and look at the frame without it. Twice now a bright wash on a large flat
    // surface has been blamed on the rim and turned out to be something else,
    // both times after arguing about it rather than looking. `__rim(0)` renders
    // the same frame with no rim at all.
    RIM_UNIFORMS.push(shader.uniforms.uRimStrength);
    shader.uniforms.uRimStrength.value = rimStrength * RIM_SCALE.value;
    shader.uniforms.uRimStrength.userData = { base: rimStrength };
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
  mat.customProgramCacheKey = () => 'toonrim:' + key + ':' + sway + ':' + ripple;
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
export function outlineMaterial(color = 0x241d2b, width = 0.0038, sway = 0) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: width },
      // THE SHELL HAS TO SWAY WITH ITS SOURCE. An inverted hull that stays put
      // while the thing inside it moves is a black smear that leaks out of one
      // side of every tree.
      uWind: WIND,
      uSway: { value: sway },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      uniform float uWidth;
      uniform float uWind;
      uniform float uSway;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        ${SWAY_GLSL}
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        vec3 n = normalize(normalMatrix * objectNormal);
        float depth = -mvPosition.z;
        // CONSTANT ON SCREEN, BUT NOT FOREVER.
        //
        // Multiplying by view depth keeps the line a fixed pixel width instead
        // of a fixed world width, which is what an ink outline should do -- up
        // to the point where the SUBJECT is only a few pixels across and a
        // two-pixel hull is most of it. Grazers twenty metres out were solid
        // dark blobs: a white animal entirely eaten by its own outline. Past
        // 12 m the width tapers to 30% by 34 m, so distant things thin out the
        // way a pen line does rather than filling in.
        float taper = 1.0 - 0.70 * clamp((depth - 12.0) / 22.0, 0.0, 1.0);
        mvPosition.xyz += n * depth * uWidth * taper;
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
export function skyDome(top, horizon, radius = 220, mid = null, sun = 0x000000) {
  // Three stops rather than two, and a sun. A two-colour gradient is the
  // single most recognisable "default engine" tell there is; the thing that
  // makes a painted sky is the HORIZON BAND -- a pale, slightly warm strip
  // that the zenith blue falls into -- and a direction the light is actually
  // coming from. The sun is two lobes: a tight disc and a wide, faint halo.
  const midColor = mid !== null ? new THREE.Color(mid)
    : new THREE.Color(top).lerp(new THREE.Color(horizon), 0.55);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uMid: { value: midColor },
      uHorizon: { value: new THREE.Color(horizon) },
      uSun: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
      uSunColor: { value: new THREE.Color(sun) },
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
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uSun;
      uniform vec3 uSunColor;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld);
        float h = clamp(dir.y * 1.35 + 0.18, 0.0, 1.0);
        // THE BLUE STARTS LOW. The camera the player is given looks up six
        // degrees, so a gradient that only reaches its mid tone at 25 degrees
        // gives every frame a cream sky. Mid by ten degrees, top by fifty.
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.17, h));
        col = mix(col, uTop, smoothstep(0.12, 0.78, h));
        float s = max(dot(dir, uSun), 0.0);
        col += uSunColor * (pow(s, 260.0) * 1.4 + pow(s, 10.0) * 0.16
                            + pow(s, 3.0) * 0.05);
        gl_FragColor = vec4(col, 1.0);
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
