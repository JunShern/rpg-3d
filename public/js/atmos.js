// atmos.js -- light, sky, air and the post chain. What the game LOOKS like.
//
// WHAT WAS THERE BEFORE. One directional light at a fixed angle, a hemisphere,
// an ambient, a two-colour sky dome and linear fog. It is a competent noon and
// it is the ONLY hour this world has ever had -- every screenshot ever taken of
// this project was shot at the same time of day under the same sun. Nothing
// glowed, either: the forge, the lamps, the beacon and the embercaps are all
// emissive in the builder and all of them rendered as flat bright patches,
// because a bright pixel is not a glow without something to spread it.
//
// WHY THIS IS A MODULE AND NOT A TWEAK. Lighting is the one thing in a 3D game
// where the difference between competent and beautiful is almost entirely
// choices you can only judge by LOOKING, and you cannot look at a choice that
// takes an edit to see. So every value here is a named preset, they are all
// live at once, and `__look()` cycles them -- which means the comparison is a
// keypress and an honest answer is cheap.
//
// THE TARGET IS STYLISED, NOT REAL. The geometry is procedural and low-poly
// with no photographic textures anywhere; realism punishes exactly that, and
// the toon ramp is already doing the heavy lifting on materials. So the post
// chain is doing what a colourist does to a film -- contrast, split-tone,
// bloom, falloff -- rather than what a renderer does to a physical scene.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ---------------------------------------------------------------- the sky
//
// A gradient, a sun, and a band of haze at the horizon, on the inside of a
// sphere. Three colours rather than two because the interesting part of a sky
// is the MIDDLE -- the wash between horizon and zenith is where dawn and dusk
// actually live, and lerping straight from one to the other gives you a
// gradient that reads as a backdrop rather than as air.
const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uHorizon, uMid, uZenith, uSun, uSunDir;
uniform float uSunSize, uSunGlow, uHaze;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  // two-stage ramp: horizon -> mid over the bottom third, mid -> zenith above
  float a = smoothstep(0.40, 0.56, h);
  float b = smoothstep(0.52, 0.95, h);
  vec3 col = mix(mix(uHorizon, uMid, a), uZenith, b);

  // THE SUN. A disc with a wide glow around it -- the glow is most of the
  // effect and the disc is almost incidental, which is true of real skies too.
  float cd = max(0.0, dot(d, normalize(uSunDir)));
  float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, cd);
  float glow = pow(cd, uSunGlow);
  col += uSun * (disc * 1.7 + glow * 0.55);

  // haze thickens toward the horizon AND toward the sun, which is what makes a
  // low sun read as low rather than as a lamp stuck on a gradient
  float haze = pow(1.0 - abs(d.y), 3.0) * uHaze;
  col = mix(col, uHorizon * 1.08 + uSun * 0.10, clamp(haze, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

// --------------------------------------------------------------- the grade
//
// One pass doing contrast, saturation, split-tone, vignette and a distance
// wash. Separate passes would be tidier and would cost four more full-screen
// reads for no visible difference.
// IT IS ALSO THE END OF THE PIPELINE. Tone mapping and the sRGB encode happen
// HERE and nowhere else, which is the fix for the first thing that went wrong:
// three applies `renderer.toneMapping` inside every material's shader AND
// again in OutputPass, so the composed image was tone mapped twice. The result
// was a flat daylight preset that rendered as a murky blue evening, and it
// looked plausible enough that I nearly went and re-authored the presets to
// compensate for a bug.
//
// Rendering the scene untonemapped also means the bloom pass sees LINEAR
// light, which is the only way a threshold means anything: on tone mapped
// pixels a "bright" threshold is a curve-dependent guess.
const GRADE_FRAG = `
uniform sampler2D tDiffuse;
uniform float uContrast, uSaturation, uVignette, uLift, uExposure;
uniform vec3 uShadowTint, uHighTint;
varying vec2 vUv;

const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

// ACES, the filmic curve. Applied once, at the end, on linear input.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// A TINT MUST NOT CHANGE THE LEVEL. Dividing by its own luminance is what
// makes that true: 0xaebdd2 as written multiplies every channel by less than
// one, so "cool the shadows" silently meant "darken everything by a quarter".
vec3 hue(vec3 tint) { return tint / max(1e-4, dot(tint, LUM)); }

void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec3 c = src.rgb * uExposure;

  // SPLIT TONE -- cool shadows, warm highlights. The single most effective
  // thing on this list: it is most of what separates a rendered image from a
  // photographed one, and it costs a mix.
  float lum = dot(c, LUM);
  c *= mix(hue(uShadowTint), hue(uHighTint), smoothstep(0.10, 0.85, lum));

  // contrast about mid-grey, so raising it does not also raise exposure
  c = (c - 0.18) * uContrast + 0.18;
  c = max(c, 0.0);
  // a lifted black point: pure black reads as a hole in a stylised image
  c += uLift * vec3(0.05, 0.06, 0.09);
  // saturation
  lum = dot(c, LUM);
  c = mix(vec3(lum), c, uSaturation);

  // vignette, biased so it darkens the corners and not the sides of a wide frame
  vec2 q = (vUv - 0.5) * vec2(1.0, 0.82);
  c *= clamp(1.0 - dot(q, q) * uVignette, 0.0, 1.0);

  c = aces(c);
  // linear -> sRGB
  c = mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055,
          step(0.0031308, c));
  gl_FragColor = vec4(c, src.a);
}`;

// ------------------------------------------------------------- the presets
//
// Every number here was arrived at by rendering the same three frames and
// looking at them side by side. They are not physically derived and they are
// not meant to be.
export const PRESETS = {
  // What the game shipped with, kept so the comparison has a baseline and so
  // "is the new thing actually better" stays answerable.
  flat: {
    label: 'flat noon (the original)',
    sun: { az: 0.85, el: 0.98, color: 0xfff2d8, power: 2.5 },
    sky: { horizon: 0xd6ebf7, mid: 0x9ccdee, zenith: 0x5fa8e8, sun: 0xfff2d8,
           sunSize: 0.006, sunGlow: 64, haze: 0.30 },
    fog: { color: 0xd2e6f3, near: 42, far: 130 },
    hemi: { sky: 0xd2e2ee, ground: 0x8f7f6a, power: 0.88 },
    ambient: { color: 0x9d9aa4, power: 0.26 },
    bloom: { strength: 0.0, radius: 0.4, threshold: 1.0 },
    grade: { contrast: 1.0, saturation: 1.0, vignette: 0.0, lift: 0.0,
             exposure: 1.0, shadowTint: 0xffffff, highTint: 0xffffff },
    exposure: 1.02,
  },

  // THE ONE THE GAME NOW USES. Late afternoon: the sun low enough to throw
  // long shadows across the square and rake the building fronts, warm key
  // against cool shade, everything emissive actually glowing.
  //
  // Low sun is not a mood choice, it is a legibility one. At noon every roof
  // is the same value as every other roof and the town reads as a plan; at
  // 28 degrees the roofs separate, the arcade gets a shadow under it, and the
  // belltower finally casts something across the paving.
  gold: {
    label: 'late afternoon',
    sun: { az: 2.62, el: 0.65, color: 0xffe0b4, power: 3.4 },
    sky: { horizon: 0xffd9b4, mid: 0xa8cfe8, zenith: 0x3f7fd0, sun: 0xffe2b0,
           sunSize: 0.010, sunGlow: 40, haze: 0.42 },
    fog: { color: 0xdCE4F0, near: 38, far: 165 },
    hemi: { sky: 0xcbd6e2, ground: 0xa89078, power: 0.80 },
    ambient: { color: 0x8e93a8, power: 0.28 },
    bloom: { strength: 0.62, radius: 0.55, threshold: 0.78 },
    grade: { contrast: 1.06, saturation: 1.05, vignette: 0.26, lift: 0.055,
             exposure: 1.03, shadowTint: 0xb9c3d6, highTint: 0xfff2d8 },
    exposure: 1.06,
  },

  // Cold, blue, early. The one that makes the meadow look like somewhere you
  // arrived at rather than somewhere you are standing.
  dawn: {
    label: 'first light',
    sun: { az: 1.05, el: 0.17, color: 0xffc89a, power: 2.2 },
    sky: { horizon: 0xffc9a8, mid: 0xa9b6d8, zenith: 0x2a4a86, sun: 0xffd9b0,
           sunSize: 0.013, sunGlow: 26, haze: 0.62 },
    fog: { color: 0xc8d2e6, near: 24, far: 120 },
    hemi: { sky: 0x9fb2d8, ground: 0x6f6a72, power: 0.70 },
    ambient: { color: 0x7d86a6, power: 0.34 },
    bloom: { strength: 0.80, radius: 0.62, threshold: 0.70 },
    grade: { contrast: 1.12, saturation: 1.02, vignette: 0.34, lift: 0.085,
             exposure: 1.02, shadowTint: 0x8ba0cc, highTint: 0xffe6c8 },
    exposure: 1.02,
  },

  // Deep evening. Lamps and the forge carry the frame; this is the preset that
  // proves the emissive materials were worth having.
  dusk: {
    label: 'lamplight',
    sun: { az: 2.75, el: 0.10, color: 0xff9e6a, power: 1.25 },
    sky: { horizon: 0xff9a68, mid: 0x7d6f9e, zenith: 0x1b2450, sun: 0xffb27a,
           sunSize: 0.016, sunGlow: 20, haze: 0.55 },
    fog: { color: 0x6e6f92, near: 22, far: 110 },
    hemi: { sky: 0x6b78a4, ground: 0x554a54, power: 0.74 },
    ambient: { color: 0x6b7098, power: 0.56 },
    bloom: { strength: 1.15, radius: 0.72, threshold: 0.52 },
    grade: { contrast: 1.10, saturation: 1.08, vignette: 0.34, lift: 0.15,
             exposure: 1.10, shadowTint: 0x6c7cb4, highTint: 0xffd8a8 },
    exposure: 1.12,
  },

  // Flat white light, no shadows to speak of. Useful as a control and honestly
  // rather beautiful on the meadow.
  // Between gold and dusk. The demo's clock runs down through this, and it is
  // where the lamps first start to read against the sky rather than sitting on
  // it. The story needs a middle or the afternoon jumps straight to night.
  evening: {
    label: 'the light going',
    sun: { az: 2.70, el: 0.26, color: 0xffb679, power: 2.2 },
    sky: { horizon: 0xffbc84, mid: 0x8f9ec4, zenith: 0x27407e, sun: 0xffc894,
           sunSize: 0.014, sunGlow: 24, haze: 0.52 },
    fog: { color: 0xa8aec8, near: 30, far: 135 },
    hemi: { sky: 0x9aa8c8, ground: 0x7d6a58, power: 0.66 },
    ambient: { color: 0x74799c, power: 0.36 },
    bloom: { strength: 0.95, radius: 0.66, threshold: 0.60 },
    grade: { contrast: 1.12, saturation: 1.08, vignette: 0.36, lift: 0.085,
             exposure: 1.06, shadowTint: 0xa9b4d2, highTint: 0xffe4bc },
    exposure: 1.08,
  },

  overcast: {
    label: 'overcast',
    sun: { az: 1.6, el: 0.80, color: 0xe8eef6, power: 1.15 },
    sky: { horizon: 0xdfe6ee, mid: 0xcdd8e4, zenith: 0xb6c6d8, sun: 0xe8eef6,
           sunSize: 0.004, sunGlow: 12, haze: 0.70 },
    fog: { color: 0xd4dce8, near: 26, far: 118 },
    hemi: { sky: 0xdCE6F2, ground: 0x8e8880, power: 1.15 },
    ambient: { color: 0xa8adb8, power: 0.42 },
    bloom: { strength: 0.42, radius: 0.5, threshold: 0.82 },
    grade: { contrast: 1.08, saturation: 0.94, vignette: 0.30, lift: 0.09,
             exposure: 1.0, shadowTint: 0xaebdd2, highTint: 0xf6f2ea },
    exposure: 1.0,
  },
};

export function makeAtmos({ renderer, scene, camera, key, hemi, ambient }) {
  // THE MATERIALS MUST NOT TONE MAP. Everything downstream assumes the render
  // target holds linear light: the bloom threshold, the split-tone luminance
  // test and the ACES curve in the grade are all wrong on tone mapped pixels.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;
  let name = 'gold';
  const sunDir = new THREE.Vector3();

  // ---- sky -------------------------------------------------------------
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    uniforms: {
      uHorizon: { value: new THREE.Color() }, uMid: { value: new THREE.Color() },
      uZenith: { value: new THREE.Color() }, uSun: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunSize: { value: 0.01 }, uSunGlow: { value: 40 }, uHaze: { value: 0.4 },
    },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 20), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  // ---- post ------------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.55, 0.78);
  composer.addPass(bloom);

  const grade = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uContrast: { value: 1.1 }, uSaturation: { value: 1.1 },
      uVignette: { value: 0.3 }, uLift: { value: 0.05 }, uExposure: { value: 1 },
      uShadowTint: { value: new THREE.Color(0xffffff) },
      uHighTint: { value: new THREE.Color(0xffffff) },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: GRADE_FRAG,
  });
  composer.addPass(grade);
  // NO OutputPass. The grade shader ends in ACES + sRGB, so adding one would
  // tone map the image a second time -- which is exactly the bug above.

  // ---- apply -----------------------------------------------------------
  function apply(n) {
    const p = PRESETS[n];
    if (!p) return;
    name = n;

    // THE SUN IS PLACED BY ANGLE, not by a position vector. An elevation in
    // radians is a thing you can reason about -- 0.49 is 28 degrees and that
    // is a statement about shadow length -- where (7, 24, 9) is three numbers
    // you can only evaluate by rebuilding and looking.
    sunDir.set(Math.sin(p.sun.az) * Math.cos(p.sun.el),
               Math.sin(p.sun.el),
               Math.cos(p.sun.az) * Math.cos(p.sun.el)).normalize();
    key.color.setHex(p.sun.color);
    key.intensity = p.sun.power;

    skyMat.uniforms.uHorizon.value.setHex(p.sky.horizon);
    skyMat.uniforms.uMid.value.setHex(p.sky.mid);
    skyMat.uniforms.uZenith.value.setHex(p.sky.zenith);
    skyMat.uniforms.uSun.value.setHex(p.sky.sun);
    skyMat.uniforms.uSunDir.value.copy(sunDir);
    skyMat.uniforms.uSunSize.value = p.sky.sunSize;
    skyMat.uniforms.uSunGlow.value = p.sky.sunGlow;
    skyMat.uniforms.uHaze.value = p.sky.haze;

    if (scene.fog) {
      scene.fog.color.setHex(p.fog.color);
      scene.fog.near = p.fog.near;
      scene.fog.far = p.fog.far;
    }
    hemi.color.setHex(p.hemi.sky);
    hemi.groundColor.setHex(p.hemi.ground);
    hemi.intensity = p.hemi.power;
    ambient.color.setHex(p.ambient.color);
    ambient.intensity = p.ambient.power;

    bloom.strength = p.bloom.strength;
    bloom.radius = p.bloom.radius;
    bloom.threshold = p.bloom.threshold;

    const u = grade.uniforms;
    u.uContrast.value = p.grade.contrast;
    u.uSaturation.value = p.grade.saturation;
    u.uVignette.value = p.grade.vignette;
    u.uLift.value = p.grade.lift;
    u.uExposure.value = p.grade.exposure;
    u.uShadowTint.value.setHex(p.grade.shadowTint);
    u.uHighTint.value.setHex(p.grade.highTint);

    // The scene renders linear and untonemapped; `exposure` is a uniform on the
    // grade rather than a renderer setting, because the renderer's version is
    // applied inside every material shader and would be the second curve again.
    grade.uniforms.uExposure.value = p.grade.exposure * p.exposure;
  }

  /** Put the shadow frustum where the player is, along the preset's sun. */
  function follow(target) {
    // whole-texel steps, so the shadow map is the same map shifted by an
    // integer rather than a slightly different projection every frame
    const SPAN = 32;
    const texel = SPAN / key.shadow.mapSize.x;
    const q = (v) => Math.round(v / texel) * texel;
    const cx = q(target.x), cy = q(target.y), cz = q(target.z);
    key.position.set(cx + sunDir.x * 30, cy + sunDir.y * 30, cz + sunDir.z * 30);
    key.target.position.set(cx, cy, cz);
    key.target.updateMatrixWorld();
    sky.position.set(target.x, target.y, target.z);
  }

  function resize() {
    composer.setSize(innerWidth, innerHeight);
    bloom.setSize(innerWidth, innerHeight);
  }

  // BLEND BETWEEN TWO PRESETS.
  //
  // The demo has a deadline -- the bell must ring before the light goes -- and
  // the only honest way to express a deadline in a game with no clock on screen
  // is to put it in the light itself. Stepping between presets reads as the sun
  // jumping; this walks every value, so the hour comes down continuously while
  // you play and you feel late before anyone tells you that you are.
  const _c = new THREE.Color(), _d = new THREE.Color();
  const lerpHex = (a, b, t) => _c.setHex(a).lerp(_d.setHex(b), t).getHex();
  function blend(aName, bName, t) {
    const A = PRESETS[aName], B = PRESETS[bName];
    if (!A || !B) {
      // LOUDLY. The first version returned quietly, so when `evening` failed
      // to get written the story clock ran the whole demo, moved nothing, and
      // reported no error -- the sun simply never went down and every probe
      // said "late afternoon" while I looked for the bug in the quest.
      console.error('[atmos] blend: no such preset',
                    !A ? aName : bName, '-- have', Object.keys(PRESETS).join(','));
      return;
    }
    t = Math.max(0, Math.min(1, t));
    const L = (x, y) => x + (y - x) * t;
    PRESETS.__blend = {
      label: t < 0.5 ? A.label : B.label,
      sun: { az: L(A.sun.az, B.sun.az), el: L(A.sun.el, B.sun.el),
             color: lerpHex(A.sun.color, B.sun.color, t), power: L(A.sun.power, B.sun.power) },
      sky: { horizon: lerpHex(A.sky.horizon, B.sky.horizon, t),
             mid: lerpHex(A.sky.mid, B.sky.mid, t),
             zenith: lerpHex(A.sky.zenith, B.sky.zenith, t),
             sun: lerpHex(A.sky.sun, B.sky.sun, t),
             sunSize: L(A.sky.sunSize, B.sky.sunSize),
             sunGlow: L(A.sky.sunGlow, B.sky.sunGlow), haze: L(A.sky.haze, B.sky.haze) },
      fog: { color: lerpHex(A.fog.color, B.fog.color, t),
             near: L(A.fog.near, B.fog.near), far: L(A.fog.far, B.fog.far) },
      hemi: { sky: lerpHex(A.hemi.sky, B.hemi.sky, t),
              ground: lerpHex(A.hemi.ground, B.hemi.ground, t),
              power: L(A.hemi.power, B.hemi.power) },
      ambient: { color: lerpHex(A.ambient.color, B.ambient.color, t),
                 power: L(A.ambient.power, B.ambient.power) },
      bloom: { strength: L(A.bloom.strength, B.bloom.strength),
               radius: L(A.bloom.radius, B.bloom.radius),
               threshold: L(A.bloom.threshold, B.bloom.threshold) },
      grade: { contrast: L(A.grade.contrast, B.grade.contrast),
               saturation: L(A.grade.saturation, B.grade.saturation),
               vignette: L(A.grade.vignette, B.grade.vignette),
               lift: L(A.grade.lift, B.grade.lift),
               exposure: L(A.grade.exposure, B.grade.exposure),
               shadowTint: lerpHex(A.grade.shadowTint, B.grade.shadowTint, t),
               highTint: lerpHex(A.grade.highTint, B.grade.highTint, t) },
      exposure: L(A.exposure, B.exposure),
    };
    apply('__blend');
    name = `${aName}->${bName} ${t.toFixed(2)}`;
  }

  // THE CLOCK. `hour` runs 0..1 across the demo's afternoon; the presets it
  // walks are the story's three acts.
  const STOPS = ['gold', 'evening', 'dusk'];
  function setHour(h) {
    h = Math.max(0, Math.min(0.9999, h));
    const seg = h * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(seg));
    blend(STOPS[i], STOPS[i + 1], seg - i);
  }

  apply(name);

  // Sampled after the scene pass and before the post passes, because
  // `renderer.info` is reset per pass and the last one is a full-screen quad.
  const stats = { calls: 0, triangles: 0 };

  return {
    apply, blend, setHour, follow, resize, stats,
    render: () => {
      // ACCUMULATE ACROSS THE WHOLE FRAME. `renderer.info` resets on every
      // render call, so reading it after `composer.render()` gives you the
      // last full-screen quad and nothing else -- which is what put "1 draws"
      // in the HUD. Turning autoReset off and clearing once per frame makes
      // the counter the honest cost of the frame, post included, rather than
      // the cost of the scene with the expensive part hidden.
      renderer.info.reset();
      composer.render();
      stats.calls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
    },
    get name() { return name; },
    get sunDir() { return sunDir; },
    names: () => Object.keys(PRESETS),
    /** For probes and for the shot sheet. */
    // READ THE LIVE STATE, not a preset lookup. `name` becomes a description
    // like "evening->dusk 0.60" once blending starts, which is not a key in
    // PRESETS -- so the old version threw the moment the story clock moved.
    _debug: () => ({ preset: name,
                     sunEl: +(Math.asin(sunDir.y) * 180 / Math.PI).toFixed(1),
                     bloom: +bloom.strength.toFixed(2),
                     keyLight: '#' + key.color.getHexString(),
                     fogFar: scene.fog ? Math.round(scene.fog.far) : null }),
  };
}
