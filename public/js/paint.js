// paint.js -- the world's surfaces.
//
// WHAT THIS REPLACES. Every surface in the world used to be a MeshToonMaterial:
// three flat bands of one colour, a rim, and an ink hull. On a character that
// is a style. On a thousand bevelled boxes it is the reason the game looked
// like a prototype -- a wall was one colour, a rock was one colour, a field
// was one colour, and the only thing telling you what anything was made of
// was a 256-pixel texture that was mostly flat too.
//
// WHAT IT IS NOW. A physically-lit surface (so it takes the sky's light, not
// just a hemisphere's two colours) with the detail generated IN WORLD SPACE,
// per fragment, from noise:
//
//   - broad colour variation, so a wall is weathered and a field has patches
//   - real relief -- the normal is perturbed by the analytic gradient of the
//     same noise, so stone is lumpy and bark is ridged under a raking sun
//   - moss and grass on whatever faces up, which is what makes a rock sit IN
//     a meadow rather than on top of it
//   - light through leaves and petals when you look toward the sun
//
// World space is the point. These meshes are procedural, joined by material
// and have no sensible UVs across a whole wall or rock; world-space detail is
// seamless across every join, never stretches, and costs no texture memory.
// The low-res textures that do exist are kept -- the cobble and tile patterns
// are real information -- and are used for colour and as a height field.
//
// The characters are NOT painted. They keep their cel shading: an anime cast
// in a lit, painterly world is a look (it is most of what makes that style of
// game look the way it does), and the cast's faces were drawn for a ramp.

import * as THREE from 'three';

// ------------------------------------------------------- shared uniforms
//
// One object per uniform, handed to every material by reference, so the sun
// moving updates the whole world in one assignment.
export const PAINT = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.5).normalize() },
  uSunCol: { value: new THREE.Color(1, 0.9, 0.75) },
  uWind: null,          // bound to toon.WIND in main.js so everything sways as one
  // the meadow's field map (grass.js bakes it): terrain height in R. Water
  // reads it to know how deep it is at every pixel.
  uField: { value: null },
  uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  // INDOORS. Image-based light is the sky, and the sky does not know there is
  // a roof: without this the shop, the smithy and the cellar were lit as if
  // they stood in the open square -- pale, blue and flat. The builder already
  // records every room and stairwell as a box (manifest `shafts`); a surface
  // in one takes almost no sky and a low warm bounce instead, and the room's
  // own lamps do the rest.
  uRoomLo: { value: Array.from({ length: 8 }, () => new THREE.Vector3(1, 1, 1)) },
  uRoomHi: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0, 0, 0)) },
  uRoomW: { value: new Array(8).fill(0) },
  uIndoorFill: { value: new THREE.Color(0.95, 0.62, 0.36) },
};

/** Hand the room boxes to every painted surface. `rooms` = manifest shafts. */
export function setRooms(rooms) {
  const lo = PAINT.uRoomLo.value, hi = PAINT.uRoomHi.value, w = PAINT.uRoomW.value;
  for (let i = 0; i < 8; i++) {
    const r = rooms[i];
    if (!r) { lo[i].set(1, 1, 1); hi[i].set(0, 0, 0); w[i] = 0; continue; }
    // a stairwell's pad covers the stair round the well; a room is its box.
    // The tower is open on its plaza face, so it keeps half its sky.
    const tall = (r.y1 - r.y0) > 6;
    const pad = tall ? (r.pad ?? 0) : 0;
    lo[i].set(r.x - r.hx - pad, r.y0 - 0.2, r.z - r.hz - pad);
    hi[i].set(r.x + r.hx + pad, r.y1 + 0.4, r.z + r.hz + pad);
    w[i] = tall ? 0.55 : 1.0;
  }
}

// ------------------------------------------------------------ the noise
//
// IQ's value noise WITH ANALYTIC DERIVATIVES. The derivative is what makes
// relief possible without screen-space tricks: the normal is bent by the
// gradient in world units, so bumps are the same size at any distance and do
// not crawl or sparkle the way a dFdx bump does when the camera moves.
export const NOISE_GLSL = /* glsl */`
float pHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
// returns (value 0..1, d/dx, d/dy, d/dz)
vec4 pNoiseD(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float a = pHash(i + vec3(0.0, 0.0, 0.0));
  float b = pHash(i + vec3(1.0, 0.0, 0.0));
  float c = pHash(i + vec3(0.0, 1.0, 0.0));
  float d = pHash(i + vec3(1.0, 1.0, 0.0));
  float e = pHash(i + vec3(0.0, 0.0, 1.0));
  float f = pHash(i + vec3(1.0, 0.0, 1.0));
  float g = pHash(i + vec3(0.0, 1.0, 1.0));
  float h = pHash(i + vec3(1.0, 1.0, 1.0));
  float k0 = a, k1 = b - a, k2 = c - a, k3 = e - a;
  float k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f;
  float k7 = -a + b + c - d + e - f - g + h;
  return vec4(
    k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z
       + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
              k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
              k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
float pNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * (3.0 - 2.0 * w);
  return mix(mix(mix(pHash(i), pHash(i + vec3(1,0,0)), u.x),
                 mix(pHash(i + vec3(0,1,0)), pHash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(pHash(i + vec3(0,0,1)), pHash(i + vec3(1,0,1)), u.x),
                 mix(pHash(i + vec3(0,1,1)), pHash(i + vec3(1,1,1)), u.x), u.y), u.z);
}
// three octaves with the gradient carried through, rotated between octaves so
// the lattice never lines up into visible grid artefacts
const mat3 pRot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
vec4 pFbmD(vec3 x) {
  vec4 acc = vec4(0.0);
  float amp = 0.5;
  mat3 m = mat3(1.0);
  for (int o = 0; o < 3; o++) {
    vec4 n = pNoiseD(x);
    acc.x += amp * n.x;
    acc.yzw += amp * (m * n.yzw);
    amp *= 0.5;
    x = pRot * x * 2.03;
    m = 2.03 * pRot * m;
  }
  return acc;
}
float pFbm(vec3 x) {
  float a = 0.0, amp = 0.5;
  for (int o = 0; o < 4; o++) { a += amp * pNoise(x); amp *= 0.5; x = pRot * x * 2.07; }
  return a;
}
`;

// ------------------------------------------------------------ the recipes
//
// Keyed by surface name (see surfaceOf in main.js). Every value is a knob with
// one job, so a surface that reads wrong is fixed by turning one of them:
//
//   hue      [amount, scale]  broad colour variation (0.2 = +-20%) at 1/scale m
//   bump     [amount, scale]  world-space relief
//   mapBump  amount           the texture's luminance used as a height field
//   moss     amount           growth on up-facing faces
//   streak   0/1              stretch the noise vertically (bark, timber)
//   grime    amount           darkening near the base of vertical faces
//   glow     amount           light through the surface, looking toward sun
//   rough, metal, env         the BRDF and how much sky light it takes
const RECIPES = {
  // --- stone and ground -------------------------------------------------
  // PAVING IS PROCEDURAL: see PAVE below. The builder's Voronoi texture drew
  // stones a third of a metre across in one blue-grey, tiled every 3.2 m --
  // toy bricks, not a street.
  // env 0.55: stone underfoot mirrored enough sky to read as blue ice
  cobble:    { hue: [0.08, 0.35], rough: 0.9, env: 0.6, pave: 1 },
  cobble_b:  { hue: [0.08, 0.35], rough: 0.9, env: 0.6, pave: 1 },
  flagstone: { hue: [0.10, 0.40], rough: 0.92, env: 0.38, pave: 2 },
  ring:      { hue: [0.10, 0.40], rough: 0.92, env: 0.38, pave: 2 },
  stone:     { hue: [0.22, 0.55], bump: [0.70, 1.4], mapBump: 0.7, mapFade: 0.35, moss: 0.45, grime: 0.25, rough: 0.88, env: 0.85, lichen: 0.5 },
  rock:      { hue: [0.30, 0.30], bump: [2.2, 0.8], mapBump: 0.4, mapFade: 0.85, moss: 0.55, rough: 0.92, env: 0.8, tint: [0.62, 0.60, 0.56], lichen: 1 },
  // the far ranges: dark forested hills that the air pass turns blue
  // SMOOTH, NOT BLOTCHED. A forest pattern at this distance came out, under
  // the haze, as drifting patches of cloud -- the eye reads large soft
  // light-and-dark shapes on a far slope as weather. A painted backdrop is a
  // silhouette with a little tone in it; the haze does the rest.
  ridge_a:   { hue: [0.12, 0.03], rough: 1.0, env: 0.5, tint: [0.20, 0.30, 0.24] },
  ridge_b:   { hue: [0.10, 0.03], rough: 1.0, env: 0.5, tint: [0.30, 0.38, 0.42] },
  water:     { water: 1, rough: 0.26, env: 1.1 },
  // the land beyond the built world: fields and woods, seen through haze
  farfield:  { hue: [0.20, 0.02], rough: 1.0, env: 0.6, forest: 1 },
  dirt:      { hue: [0.22, 0.30], bump: [0.30, 3.0], rough: 1.0, env: 0.8 },
  // the meadow floor -- see FIELD below; this is the fallback
  ground:    { hue: [0.30, 0.05], bump: [0.10, 1.6], rough: 1.0, env: 0.75, field: 1 },
  // --- built ------------------------------------------------------------
  plaster_a: { hue: [0.10, 0.60], bump: [0.10, 3.0], grime: 0.45, rough: 0.94, env: 1.0, age: 1 },
  plaster_b: { hue: [0.10, 0.60], bump: [0.10, 3.0], grime: 0.45, rough: 0.94, env: 1.0, age: 1 },
  plaster_c: { hue: [0.10, 0.60], bump: [0.10, 3.0], grime: 0.45, rough: 0.94, env: 1.0, age: 1 },
  plaster_d: { hue: [0.10, 0.60], bump: [0.10, 3.0], grime: 0.45, rough: 0.94, env: 1.0, age: 1 },
  roof_a:    { hue: [0.18, 0.35], bump: [0.06, 5.0], mapBump: 1.6, moss: 0.22, rough: 0.72, env: 1.0 },
  roof_b:    { hue: [0.18, 0.35], bump: [0.06, 5.0], mapBump: 1.6, moss: 0.22, rough: 0.72, env: 1.0 },
  roof_c:    { hue: [0.18, 0.35], bump: [0.06, 5.0], mapBump: 1.6, moss: 0.22, rough: 0.72, env: 1.0 },
  timber:    { hue: [0.16, 0.9], bump: [0.30, 2.2], mapBump: 0.8, streak: 1, grime: 0.2, rough: 0.78, env: 0.9 },
  door:      { hue: [0.10, 0.9], bump: [0.20, 2.2], streak: 1, rough: 0.6, env: 1.0 },
  // striped canvas, stripes running down the fall of the cloth
  awning:    { hue: [0.08, 1.5], bump: [0.04, 9.0], rough: 0.9, env: 0.9, glow: 0.35, stripe: 1,
               tint: [0.82, 0.72, 0.70] },
  cloth:     { hue: [0.08, 1.5], bump: [0.04, 9.0], rough: 0.9, env: 1.0, glow: 0.3 },
  curtain:   { hue: [0.10, 2.0], rough: 0.95, env: 0.4, glow: 0.2 },
  brass:     { hue: [0.08, 3.0], rough: 0.32, metal: 0.85, env: 1.4 },
  iron:      { hue: [0.12, 3.0], bump: [0.10, 6.0], rough: 0.55, metal: 0.7, env: 1.2 },
  // dark and reflective: what a window is from outside in daylight
  // dark, reflective and a little transparent, so the curtains and the room
  // behind read through it
  glass:     { rough: 0.10, metal: 0.0, env: 0.9, tint: [0.10, 0.11, 0.12], opacity: 0.62, lit: 1 },
  shutter_a: { hue: [0.12, 1.4], bump: [0.18, 5.0], streak: 1, grime: 0.2, rough: 0.7, env: 0.9 },
  shutter_b: { hue: [0.12, 1.4], bump: [0.18, 5.0], streak: 1, grime: 0.2, rough: 0.7, env: 0.9 },
  shutter_c: { hue: [0.12, 1.4], bump: [0.18, 5.0], streak: 1, grime: 0.2, rough: 0.7, env: 0.9 },
  shutter_d: { hue: [0.12, 1.4], bump: [0.18, 5.0], streak: 1, grime: 0.2, rough: 0.7, env: 0.9 },
  // --- growing ----------------------------------------------------------
  bark:      { hue: [0.18, 0.8], bump: [0.60, 3.2], streak: 1, moss: 0.35, rough: 0.9, env: 0.7 },
  bark_dead: { hue: [0.14, 0.8], bump: [0.60, 3.2], streak: 1, moss: 0.15, rough: 0.9, env: 0.7 },
  leaf:      { hue: [0.26, 0.55], bump: [0.30, 2.4], rough: 0.75, env: 0.9, glow: 0.55, foliage: 1 },
  leaf_lo:   { hue: [0.28, 0.35], rough: 0.85, env: 0.8, glow: 0.45, foliage: 1 },
  conifer:   { hue: [0.20, 0.7], bump: [0.30, 2.8], rough: 0.8, env: 0.5, glow: 0.30, foliage: 1, tint: [0.55, 0.85, 0.5] },
  grass_hi:  { hue: [0.26, 0.30], rough: 0.85, env: 0.8, glow: 0.5, foliage: 1 },
  reed:      { hue: [0.20, 0.8], rough: 0.8, env: 0.8, glow: 0.5, foliage: 1 },
  reed_head: { hue: [0.16, 1.2], rough: 0.9, env: 0.8, glow: 0.3 },
  bloom_a:   { hue: [0.08, 2.0], rough: 0.7, env: 0.8, glow: 0.15 },
  bloom_b:   { hue: [0.08, 2.0], rough: 0.7, env: 0.8, glow: 0.15 },
  fruit:     { hue: [0.14, 3.0], rough: 0.45, env: 1.1 },
  // falling water: translucent streaks running down the jet
  foam:      { rough: 0.15, env: 1.3, flow: 1, opacity: 0.8, tint: [0.80, 0.90, 0.95] },
};
const FALLBACK = { hue: [0.10, 0.8], rough: 0.85, env: 0.9 };

export function recipeFor(name) { return RECIPES[name] || FALLBACK; }

// ------------------------------------------------------------- the shader
const VERT_PARS = /* glsl */`
varying vec3 vPW;
varying vec3 vPN;
uniform float uWind;
uniform float uSway;
`;
const VERT_NORMAL = /* glsl */`
#include <defaultnormal_vertex>
{
  mat4 pm = modelMatrix;
  #ifdef USE_INSTANCING
    pm = modelMatrix * instanceMatrix;
  #endif
  vPN = normalize(mat3(pm) * objectNormal);
}
`;
const VERT_POS = /* glsl */`
#include <begin_vertex>
{
  mat4 pm = modelMatrix;
  #ifdef USE_INSTANCING
    pm = modelMatrix * instanceMatrix;
  #endif
  vec3 w = (pm * vec4(transformed, 1.0)).xyz;
  // THE SAME WIND AS THE REST OF THE WORLD (toon.SWAY_GLSL), so a painted tree
  // and a cel-shaded one side by side would still move together
  if (uSway > 0.0) {
    float ph = w.x * 0.35 + w.z * 0.27;
    float a = sin(uWind * 1.10 + ph) * 0.68 + sin(uWind * 2.30 + ph * 1.7 + 1.3) * 0.32;
    float b = sin(uWind * 0.87 + ph * 1.3 + 2.1);
    transformed.x += a * uSway;
    transformed.z += b * uSway * 0.45;
    w = (pm * vec4(transformed, 1.0)).xyz;
  }
  vPW = w;
}
`;

const FRAG_PARS = /* glsl */`
varying vec3 vPW;
varying vec3 vPN;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec2 uHue;
uniform vec2 uBump;
uniform float uMapBump, uMoss, uStreak, uGrime, uGlow, uField, uFoliage, uMapFade, uWater, uForest, uPave, uStripe, uAge, uLit, uFlow, uLichen;
uniform sampler2D uFieldMap;
uniform vec3 uRoomLo[8];
uniform vec3 uRoomHi[8];
uniform float uRoomW[8];
uniform vec3 uIndoorFill;
// how indoors a surface is: inside a room box, or on a wall of one facing in
// (so the OUTSIDE face of the same wall stays in the sky)
float pIndoor(vec3 p, vec3 n) {
  float k = 0.0;
  for (int i = 0; i < 8; i++) {
    vec3 lo = uRoomLo[i], hi = uRoomHi[i];
    if (hi.x < lo.x) continue;
    // 0.8: a room's box is inset from its walls (it is the CAMERA's box, kept
    // clear of them), so the walls themselves sit up to ~0.6 m outside it
    vec3 e = vec3(0.8, 0.4, 0.8);
    if (any(lessThan(p, lo - e)) || any(greaterThan(p, hi + e))) continue;
    bool inside = all(greaterThan(p, lo)) && all(lessThan(p, hi));
    bool facing = dot(n, (lo + hi) * 0.5 - p) > 0.0;
    if (inside || facing) k = max(k, uRoomW[i]);
  }
  return k;
}
uniform vec4 uRect;
uniform float uTime;
${NOISE_GLSL}

// 2D cellular noise: (F1, F2, cell id, and the vector to the nearest centre)
vec4 pVor(vec2 x, out vec2 toC) {
  vec2 n = floor(x), f = fract(x);
  float F1 = 8.0, F2 = 8.0, id = 0.0;
  toC = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = vec2(pHash(vec3(n + g, 1.7)), pHash(vec3(n + g, 7.3))) * 0.8 + 0.1;
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < F1) { F2 = F1; F1 = d; id = pHash(vec3(n + g, 3.1)); toC = r; }
    else if (d < F2) { F2 = d; }
  }
  return vec4(sqrt(F1), sqrt(F2), id, 0.0);
}
// three's arbitrary-surface bump (bumpmap_pars_fragment), for the texture's
// own height field -- the one place a screen-space derivative is the right tool
vec3 pPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = normalize(dFdx(surf_pos));
  vec3 vSigmaY = normalize(dFdy(surf_pos));
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

// After map_fragment: diffuseColor is final albedo-so-far. Everything that
// changes the COLOUR lives here; everything that changes the NORMAL is below.
const FRAG_COLOR = /* glsl */`
#include <map_fragment>
#ifdef USE_MAP
  // MAP FADE: some of the builder's textures carry blotches that were a toon
  // stand-in for detail (the dark spots on every wall stone); world-space
  // noise does that job now, so divide some of the image back out
  diffuseColor.rgb = mix(diffuseColor.rgb,
    diffuseColor.rgb / max(sampledDiffuseColor.rgb, vec3(0.05)) * dot(sampledDiffuseColor.rgb, vec3(0.333)),
    uMapFade);
#endif
float pDist = length(vPW - cameraPosition);
float pWaterDepth = 1.0;
vec3 pWN = normalize(vPN) * (gl_FrontFacing ? 1.0 : -1.0);
// stretched noise space for grain: bark runs up the trunk
vec3 pQ = vPW * vec3(1.0, mix(1.0, 0.18, uStreak), 1.0);
float pH0 = 0.5;
float pBumpK = 1.0;
vec3 pPaveTilt = vec3(0.0);
{
  // BROAD VARIATION. Two scales: patches the size of the hue scale, and a
  // finer mottle at 4x. Applied as a multiply around 1 so it varies the value
  // AND nudges the hue (the channels move by slightly different amounts).
  float n1 = pFbm(pQ * uHue.y);
  float n2 = pNoise(pQ * uHue.y * 4.3 + 11.0);
  pH0 = n1;
  float v = (n1 - 0.5) * 1.6 + (n2 - 0.5) * 0.5;
  diffuseColor.rgb *= 1.0 + uHue.x * v * vec3(1.0, 0.92, 0.80);

  // FIELD -- the meadow floor. The vertex colour already says where grass
  // stops and path begins; this paints the grass itself: sun-bleached
  // yellow-green crowns on the rises, deeper blue-green in the hollows and
  // clumps, and a scatter of flowers too small to model.
  if (uField > 0.5) {
    float greenness = clamp((diffuseColor.g - diffuseColor.r) * 5.0, 0.0, 1.0);
    // BARE GROUND: the builder colours the path as warm dirt and anything too
    // steep for soil as grey rock. Both get painted too -- a road with ruts
    // and stones in it, and rock faces with strata and moss -- and both get
    // real relief (pBumpK scales the bump below), because bare ground under a
    // low sun is where relief shows most.
    float warmth = clamp((diffuseColor.r - diffuseColor.b) * 4.0, 0.0, 1.0);
    float n3 = pFbm(vPW * 0.9 + 21.0);
    vec3 dirtC = mix(vec3(0.33, 0.23, 0.13), vec3(0.50, 0.37, 0.22), n3);
    // wheel ruts and a scatter of pale stones
    float peb = step(0.88, pNoise(vPW * 6.5)) * (1.0 - smoothstep(6.0, 18.0, pDist));
    dirtC = mix(dirtC, vec3(0.52, 0.47, 0.40), peb * 0.7);
    float strata = pNoise(vec3(vPW.x * 0.6, vPW.y * 3.5, vPW.z * 0.6));
    vec3 rockC = mix(vec3(0.30, 0.28, 0.25), vec3(0.50, 0.47, 0.41), strata * 0.6 + n3 * 0.4);
    vec3 bare = mix(rockC, dirtC, smoothstep(0.35, 0.7, warmth));
    pBumpK = mix(mix(7.0, 3.0, smoothstep(0.35, 0.7, warmth)), 1.0, greenness);
    float big = pFbm(vPW * 0.045 + 3.0);
    float mid = pFbm(vPW * 0.19 + 7.0);
    // matched to grass.js: this is the floor BETWEEN the tufts, so it is the
    // grass's own colour in its own shade, not a lawn
    vec3 warm = vec3(0.22, 0.24, 0.07);
    vec3 cool = vec3(0.05, 0.13, 0.05);
    vec3 lush = vec3(0.09, 0.19, 0.04);
    vec3 g = mix(cool, lush, smoothstep(0.35, 0.62, mid));
    g = mix(g, warm, smoothstep(0.52, 0.72, big) * 0.85);
    // blade-scale speckle, faded out with distance before it can alias
    float sp = pNoise(vPW * 3.1) * pNoise(vPW * 7.7 + 5.0);
    g *= mix(1.0, 0.78 + sp * 0.55, 1.0 - smoothstep(12.0, 36.0, pDist));
    diffuseColor.rgb = mix(bare, g * 0.92, greenness);
    // wildflowers: tiny, bright, clustered
    float fl = pNoise(vPW * 1.3 + 17.0);
    float dot1 = pNoise(vPW * 9.5);
    float flw = step(0.86, dot1) * smoothstep(0.55, 0.75, fl) * greenness
              * (1.0 - smoothstep(10.0, 28.0, pDist));
    vec3 fc = mix(vec3(1.0, 0.95, 0.75), vec3(0.95, 0.55, 0.75), step(0.5, pNoise(vPW * 0.7)));
    diffuseColor.rgb = mix(diffuseColor.rgb, fc, flw * 0.85);
  }

  // PAVING. Cobbles (pave 1): fist-sized stones in a spread of warm greys and
  // browns, each with its own tone, set in dark earth that grows moss where
  // nobody walks. Flags (pave 2): large rectangular slabs in running bond.
  if (uPave > 0.5 && pWN.y > 0.6) {
    vec2 q = vPW.xz;
    float gap, id;
    vec2 toC = vec2(0.0);
    if (uPave < 1.5) {
      vec4 v = pVor(q / 0.16, toC);
      gap = v.y - v.x;
      id = v.z;
    } else {
      vec2 g = q / vec2(0.78, 0.52);
      float row = floor(g.y);
      g.x += row * 0.5 + pHash(vec3(row, 2.0, 5.0)) * 0.3;
      vec2 c = fract(g) - 0.5;
      id = pHash(vec3(floor(g), 9.0));
      gap = min(0.5 - abs(c.x), (0.5 - abs(c.y)) * 0.67) * 1.3;
      toC = -c * vec2(0.78, 0.52);
    }
    // flags have tight joints and sandstone faces; cobbles have wide earthy ones
    float stoneK = uPave < 1.5 ? smoothstep(0.06, 0.13, gap) : smoothstep(0.012, 0.03, gap);
    vec3 warm = vec3(0.36, 0.31, 0.25), cool = vec3(0.31, 0.30, 0.29), dark = vec3(0.22, 0.20, 0.17);
    if (uPave > 1.5) { warm = vec3(0.52, 0.44, 0.33); cool = vec3(0.46, 0.41, 0.34); dark = vec3(0.36, 0.31, 0.25); }
    vec3 sc = mix(mix(cool, warm, smoothstep(0.2, 0.7, id)), dark, step(0.82, id) * 0.8);
    sc *= 0.86 + 0.28 * pNoise(vPW * 2.3 + id * 17.0);
    // wear: stones on the walked line are polished paler; the edges of the
    // square, where nobody walks, collect moss in the joints
    float traffic = 1.0 - smoothstep(4.0, 12.0, length(vPW.xz - vec2(0.0, -0.5)));
    sc = mix(sc, sc * 1.12 + 0.02, traffic * 0.5);
    float mossy = smoothstep(0.35, 0.8, pFbm(vPW * 0.6 + 4.0)) * (1.0 - traffic);
    vec3 joint = mix(vec3(0.10, 0.085, 0.07), vec3(0.16, 0.22, 0.09), mossy);
    diffuseColor.rgb = mix(joint, sc, stoneK);
    pH0 = stoneK;
    pPaveTilt = vec3(toC.x, 0.0, toC.y) / max(0.05, length(toC))
              * (uPave < 1.5 ? (1.0 - smoothstep(0.05, 0.28, gap)) * 0.55
                             : (1.0 - smoothstep(0.01, 0.05, gap)) * 0.25);
  }

  // FIELD STONE: hairline cracks, lichen in pale rosettes, and the colour
  // band of weathering that makes a boulder read as old rather than cast
  if (uLichen > 0.0) {
    float cr = 1.0 - abs(pNoise(vPW * 2.6 + 3.0) * 2.0 - 1.0);
    cr = smoothstep(0.965, 0.995, cr) * (1.0 - smoothstep(5.0, 16.0, pDist));
    diffuseColor.rgb *= 1.0 - cr * 0.35;
    float lc = pNoise(vPW * 9.0 + 21.0) * 0.65 + pNoise(vPW * 23.0) * 0.35;
    float lich = smoothstep(0.76, 0.80, lc) * uLichen * (1.0 - smoothstep(8.0, 25.0, pDist));
    vec3 lcol = mix(vec3(0.62, 0.62, 0.50), vec3(0.66, 0.50, 0.28), step(0.7, pNoise(vPW * 1.3)));
    diffuseColor.rgb = mix(diffuseColor.rgb, lcol, lich * 0.55);
    // weathered: darker toward the ground, where water sits
    diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(-0.2, 0.9, pWN.y + 0.3));
  }

  // FLOWING WATER: streaks that fall, and thin to glassy between them
  if (uFlow > 0.5) {
    float fl = pNoise(vec3(vPW.x * 7.0, vPW.y * 3.0 + uTime * 4.5, vPW.z * 7.0));
    float fl2 = pNoise(vec3(vPW.x * 15.0, vPW.y * 6.0 + uTime * 7.0, vPW.z * 15.0));
    float white = smoothstep(0.45, 0.8, fl * 0.7 + fl2 * 0.5);
    diffuseColor.rgb = mix(vec3(0.30, 0.45, 0.50), vec3(0.92, 0.96, 0.97), white);
    diffuseColor.a *= 0.45 + white * 0.55;
  }

  // AGE, on plaster. Lime render falls away in patches and shows the rubble
  // stone it was laid over; rain runs down from every sill and ledge and
  // leaves a dark tail; the top of a wall under the eaves stays cleaner.
  if (uAge > 0.5) {
    float vert = 1.0 - abs(pWN.y);
    // spalled patches, with a lighter lip where the render breaks
    float pn = pFbm(vPW * 0.95 + 13.0) + pNoise(vPW * 4.0) * 0.10;
    // mostly low on the wall, where the damp gets in
    float low = 1.0 - smoothstep(1.5, 5.0, vPW.y) * 0.6;
    // outside only: rooms have their own weather
    float outside = 1.0 - pIndoor(vPW, pWN);
    float spall = smoothstep(0.64, 0.655, pn * low + 0.04) * vert * outside;
    float lip = smoothstep(0.62, 0.64, pn * low + 0.04) * (1.0 - spall) * vert * outside;
    float course = abs(fract(vPW.y / 0.22) - 0.5);
    vec3 rubble = mix(vec3(0.46, 0.41, 0.34), vec3(0.62, 0.56, 0.46), pNoise(vPW * 5.0))
                * mix(0.55, 1.0, smoothstep(0.03, 0.08, course));
    diffuseColor.rgb = mix(diffuseColor.rgb, rubble, spall);
    diffuseColor.rgb *= 1.0 + lip * 0.12;
    // rain streaks: thin vertical runs, darker lower down each run
    float sx = pNoise(vec3(vPW.x * 4.5 + vPW.z * 4.5, vPW.y * 0.08, 3.0));
    float run = smoothstep(0.62, 0.9, sx) * smoothstep(0.2, 0.7, pNoise(vec3(vPW.xz * 0.7, vPW.y * 0.5)));
    diffuseColor.rgb *= 1.0 - run * vert * 0.22;
  }

  // CANVAS STRIPES: across the cloth's width, which is the horizontal line
  // lying in its surface -- so on an awning they run down the slope
  if (uStripe > 0.5) {
    // the FLAT face's normal, not the smoothed one: across a bevelled slab
    // the interpolated normal swings and the stripes zig-zagged
    vec3 fN = normalize(cross(dFdx(vPW), dFdy(vPW)));
    vec3 tng = cross(vec3(0.0, 1.0, 0.0), fN);
    tng = length(tng) < 0.2 ? vec3(1.0, 0.0, 0.0) : normalize(tng);
    float u = dot(vPW, tng) / 0.26;
    float st = smoothstep(0.46, 0.54, abs(fract(u) - 0.5) * 2.0);
    diffuseColor.rgb = mix(vec3(0.80, 0.75, 0.64), diffuseColor.rgb * 0.85, st);
  }

  // THE FAR HILLS: stripes of forest and clearing, too far off to model
  if (uForest > 0.5) {
    // forest in bands and clumps, with the trunks' dark between them
    float trees = smoothstep(0.40, 0.56, pFbm(vPW * 0.06 + 2.0));
    float tex = pNoise(vPW * 0.9);
    diffuseColor.rgb *= mix(1.2, 0.38 + tex * 0.2, trees);
  }

  // WATER. Its depth at this pixel is the surface height minus the terrain
  // under it, read from the same field map the grass grows from: clear and
  // teal over the shallows, dark over the channel, and white where it runs
  // thin against the bank.
  if (uWater > 0.5) {
    vec2 fuv = (vPW.xz - uRect.xy) / (uRect.zw - uRect.xy);
    float inside = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
    float bed = texture2D(uFieldMap, fuv).r;
    float dep = mix(0.9, vPW.y - bed, inside);
    pWaterDepth = dep;
    vec3 shallow = vec3(0.10, 0.24, 0.22);
    vec3 deep = vec3(0.015, 0.07, 0.10);
    diffuseColor.rgb = mix(shallow, deep, smoothstep(0.05, 1.1, dep));
    float fn = pNoise(vec3(vPW.x * 2.2 - uTime * 0.9, vPW.z * 2.2, uTime * 0.25));
    // a line of foam where the water meets the bank, and flecks in the fast
    // shallows -- the band used to be sixteen centimetres of DEPTH, which on a
    // gently shelving bank is a metre and a half of white
    float foam = (1.0 - smoothstep(0.0, 0.035 + fn * 0.05, dep)) * inside;
    foam = max(foam, step(0.86, fn) * (1.0 - smoothstep(0.0, 0.2, dep)) * inside * 0.45);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.90, 0.88), foam);
    diffuseColor.a = clamp(mix(0.50, 0.95, smoothstep(0.02, 0.8, dep)) + foam, 0.0, 1.0);
  }

  // MOSS on up-facing faces -- and the noise decides where it has taken, so it
  // grows in patches instead of painting every top surface the same green
  if (uMoss > 0.0) {
    float up = smoothstep(0.35, 0.85, pWN.y);
    float mn = pFbm(vPW * 1.1 + 31.0);
    // the noise carries more of it than the facing does: moss takes in
    // patches and drifts, and a rock with a perfect green cap reads as a
    // painted prop
    float m = smoothstep(0.50, 0.66, mn * 0.95 + up * 0.30) * up * uMoss;
    vec3 mossCol = mix(vec3(0.24, 0.36, 0.14), vec3(0.42, 0.52, 0.20), pNoise(vPW * 4.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, clamp(m, 0.0, 1.0));
  }

  // GRIME. Rain splashes up and damp wicks up from the ground: the bottom of
  // every wall is darker and slightly greener. The town's streets are at y~0
  // and the meadow's walls stand on terrain, so this keys on how vertical the
  // face is and on world height near the plaza level; anything high up is
  // left alone.
  if (uGrime > 0.0) {
    float vert = 1.0 - abs(pWN.y);
    float low = 1.0 - smoothstep(0.0, 1.3 + pNoise(vPW * 1.7) * 0.8, vPW.y);
    float streaks = smoothstep(0.35, 0.9, pNoise(vec3(vPW.x * 3.0, vPW.y * 0.25, vPW.z * 3.0)));
    float gr = clamp(low * vert + streaks * vert * 0.35, 0.0, 1.0) * uGrime;
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.64, 0.56), gr);
  }
}
`;

// After normal_fragment_maps. `normal` is view space here.
const FRAG_NORMAL = /* glsl */`
#include <normal_fragment_maps>
{
  vec3 nW = pWN;
  // WORLD-SPACE RELIEF from the analytic gradient -- fades out with distance,
  // because a bump smaller than a pixel is not relief, it is noise
  if (uWater > 0.5) {
    // ripples running downstream (the stream flows along x)
    vec4 r = pFbmD(vec3(vPW.x * 1.4 - uTime * 0.7, uTime * 0.35, vPW.z * 1.9));
    vec3 g = vec3(r.y * 1.4, 0.0, r.w * 1.9);
    nW = normalize(vec3(0.0, 1.0, 0.0) - g * 0.07);
  }
  if (uBump.x > 0.0) {
    float fade = 1.0 - smoothstep(18.0, 60.0, pDist) * 0.8;
    vec4 n = pFbmD(pQ * uBump.y);
    vec3 grad = n.yzw * uBump.y * vec3(1.0, mix(1.0, 0.18, uStreak), 1.0);
    grad -= dot(grad, nW) * nW;              // tangential part only
    nW = normalize(nW - grad * uBump.x * pBumpK * 0.35 * fade);
  }
  // each cobble is domed: its normal leans away from its centre at the edges
  if (uPave > 0.5) nW = normalize(nW - pPaveTilt * (1.0 - smoothstep(10.0, 30.0, pDist)));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  // THE TEXTURE AS A HEIGHT FIELD. The cobble and tile images are dark in the
  // gaps and light on the stones -- which is exactly a height map -- so the
  // grout reads as recessed under a low sun instead of painted on.
  #ifdef USE_MAP
  if (uMapBump > 0.0) {
    float hL = dot(sampledDiffuseColor.rgb, vec3(0.30, 0.59, 0.11));
    vec2 dH = vec2(dFdx(hL), dFdy(hL)) * uMapBump * 0.9
            * (1.0 - smoothstep(10.0, 40.0, pDist));
    normal = pPerturb(-vViewPosition, normal, dH, faceDirection);
  }
  #endif
}
`;

// Light THROUGH a thin surface: leaves, petals, cloth. Looking toward the sun
// through a canopy is most of what makes foliage read as alive rather than as
// painted plastic, and a standard BRDF cannot do it. Added as emission, scaled
// by how much the surface faces away from the sun and how directly you are
// looking into it.
const FRAG_GLOW = /* glsl */`
#include <emissivemap_fragment>
// NOT EVERY ROOM IS LIT: a window's worth of cell (about a metre by a storey)
// decides whether anybody is home, and how warm their lamp is
if (uLit > 0.5) {
  vec3 cell = floor(vec3(vPW.x * 0.9, vPW.y / 1.6, vPW.z * 0.9));
  float home = pHash(cell + 4.2);
  totalEmissiveRadiance *= step(0.34, home) * (0.6 + 0.6 * pHash(cell + 9.7));
}
if (uGlow > 0.0) {
  vec3 V = normalize(vPW - cameraPosition);
  float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 3.0);
  float thin = 0.35 + 0.65 * clamp(-dot(pWN, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  totalEmissiveRadiance += diffuseColor.rgb * uSunCol * (back * 1.6 + 0.10) * thin * uGlow;
}
// FOLIAGE SELF-SHADOWING. A canopy is a lump; its underside and its inside are
// dark and its crown catches the sky. Faking the lump's own occlusion from the
// normal's height is crude and it is most of the difference between a green
// blob and a tree.
if (uFoliage > 0.5) {
  diffuseColor.rgb *= mix(0.55, 1.08, smoothstep(-0.6, 0.8, pWN.y)) * (0.85 + pH0 * 0.3);
}
`;

const MATS = new Set();

/**
 * A painted world surface.
 * @param name   surface name after surfaceOf()
 * @param opts   { color, map, vertexColors, opacity, sway }
 */
export function worldMaterial(name, opts = {}) {
  const r = recipeFor(name);
  let { color = new THREE.Color(1, 1, 1) } = opts;
  const { map = null, vertexColors = false, opacity = 1, sway = 0 } = opts;
  if (r.tint) color = color.clone().multiply(new THREE.Color(...r.tint));
  const water = !!r.water;
  const opacity0 = r.opacity ?? opacity;
  const mat = new THREE.MeshStandardMaterial({
    color, map, vertexColors,
    roughness: r.rough ?? 0.85,
    metalness: r.metal ?? 0,
    envMapIntensity: r.env ?? 0.9,
    transparent: water || opacity0 < 1, opacity: water ? 1 : opacity0,
    depthWrite: !water && opacity0 >= 1,
  });
  const u = {
    uHue: { value: new THREE.Vector2(...(r.hue || [0, 1])) },
    uBump: { value: new THREE.Vector2(...(r.bump || [0, 1])) },
    uMapBump: { value: map ? (r.mapBump || 0) : 0 },
    uMoss: { value: r.moss || 0 },
    uStreak: { value: r.streak || 0 },
    uGrime: { value: r.grime || 0 },
    uGlow: { value: r.glow || 0 },
    uField: { value: r.field || 0 },
    uFoliage: { value: r.foliage || 0 },
    uMapFade: { value: map ? (r.mapFade || 0) : 0 },
    uWater: { value: r.water || 0 },
    uForest: { value: r.forest || 0 },
    uPave: { value: r.pave || 0 },
    uStripe: { value: r.stripe || 0 },
    uAge: { value: r.age || 0 },
    uLit: { value: r.lit || 0 },
    uFlow: { value: r.flow || 0 },
    uLichen: { value: r.lichen || 0 },
    uSway: { value: sway },
  };
  mat.userData.paint = { name, recipe: r, uniforms: u };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.uniforms.uSunDir = PAINT.uSunDir;
    sh.uniforms.uSunCol = PAINT.uSunCol;
    sh.uniforms.uWind = PAINT.uWind || { value: 0 };
    sh.uniforms.uFieldMap = PAINT.uField;
    sh.uniforms.uRect = PAINT.uRect;
    sh.uniforms.uTime = PAINT.uTime;
    sh.uniforms.uRoomLo = PAINT.uRoomLo;
    sh.uniforms.uRoomHi = PAINT.uRoomHi;
    sh.uniforms.uRoomW = PAINT.uRoomW;
    sh.uniforms.uIndoorFill = PAINT.uIndoorFill;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <defaultnormal_vertex>', VERT_NORMAL)
      .replace('#include <begin_vertex>', VERT_POS);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', FRAG_COLOR)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_GLOW)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        {
          float ind = pIndoor(vPW, pWN);
          iblIrradiance *= mix(1.0, 0.10, ind);
          radiance *= mix(1.0, 0.22, ind);
          iblIrradiance += uIndoorFill * ind;
        }`)
      // WATER DOES NOT BURN. A low-roughness surface under a 3.4 sun reflects
      // a highlight many times brighter than anything else in the frame, and
      // bloom turned it into a white fog over a third of the image. The glint
      // stays -- capped where it still reads as sun on water.
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (uWater > 0.5) gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(1.4));`);
  };
  // one program per feature set is plenty; the recipe values are uniforms
  mat.customProgramCacheKey = () => 'paint:' + (map ? 'm' : '') + (vertexColors ? 'v' : '');
  MATS.add(mat);
  return mat;
}

/** Live-tune a recipe from the console: `__paint('rock', {moss: 0.8})`. */
export function tune(name, patch) {
  for (const m of MATS) {
    const p = m.userData.paint;
    if (!p || p.name !== name) continue;
    const u = p.uniforms;
    if (patch.hue) u.uHue.value.set(...patch.hue);
    if (patch.bump) u.uBump.value.set(...patch.bump);
    for (const [k, key] of [['mapBump', 'uMapBump'], ['moss', 'uMoss'], ['streak', 'uStreak'],
                            ['grime', 'uGrime'], ['glow', 'uGlow']]) {
      if (patch[k] !== undefined) u[key].value = patch[k];
    }
    if (patch.rough !== undefined) m.roughness = patch.rough;
    if (patch.env !== undefined) m.envMapIntensity = patch.env;
  }
  return Object.assign(RECIPES[name] || (RECIPES[name] = {}), patch);
}
