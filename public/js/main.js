// main.js -- the style-test runtime.
//
// A third-person, free-camera, real-time town: the thing a Kingdom Hearts-shaped
// game needs and a pre-rendered-background approach cannot give.  The character
// probe lives in hero.glb; this file is the ENVIRONMENT probe, and the question
// it exists to answer is whether a scripted kit produces a space the camera can
// actually survive.
//
// Collision comes from town.manifest.json, emitted by the same Blender run that
// placed the geometry, so a wall and the box that blocks you cannot drift apart.

import * as THREE from 'three';
import { makeNpcs } from './npc.js';
import { makeDrops } from './drops.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makePost } from './post.js';
import { makeFlags } from './flags.js';
import { makeInteract } from './interact.js';
import { makeAmbient } from './ambient.js';
import { CLOUD } from './toon.js';
import { makeAudio } from './audio.js';
import { makeGroundFog } from './groundfog.js';
import { makeGrass } from './grass.js';
import {
  toonMaterial, flatMaterial, outlineMaterial, outlineGeometry, skyDome,
  RAMP_3, RAMP_SOFT, setRimScale, WIND, LOOKS, surfaceMaterial,
} from './toon.js';
import { createCombat, SPECIES, TUNE } from './combat.js';
import { makeBreakables } from './breakables.js';
import { makeTrail } from './trail.js';
import { makeTerrain } from './terrain.js';

// ------------------------------------------------------------------ renderer

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
// The post stack owns the final frame; built on the first resize, because it
// needs a size and the renderer does not have one until then.
let post = null;
// The world's memory and its second verb -- built once the regions and the
// cast are in, since both refer to things by name.
let flags = null;
let interact = null;
let air = null;   // dust and petals in the air round the player
// EVERY SOUND, synthesised. Built at load, unlocked by the first key or
// click because no browser will start audio on its own.
const sfx = makeAudio();
let gfog = null;      // the mist on the meadow
let duskLevel = 0;   // 0 day .. 1 dusk, for the pad and the wind
let grass = null;  // the instanced field -- see grass.js
const EMBERS = [];

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
const world = new THREE.Group();
scene.add(world);

const sky = skyDome(0x5fa8e8, 0xd6ebf7);
scene.add(sky);
scene.fog = new THREE.Fog(0xd2e6f3, 42, 130);

// ------------------------------------------------------------------- lights

const key = new THREE.DirectionalLight(0xfff2d8, 2.5);
// WHERE THE SUN IS, as an offset from the player: the shadow frustum follows
// them every frame (see `step`), so this is the one vector that decides the
// light direction and it has to be the look's, not a literal in the loop.
const _sunP = new THREE.Vector3(), _sunDir = new THREE.Vector3();
const KEY_OFFSET = new THREE.Vector3(7, 24, 9);
key.position.copy(KEY_OFFSET);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 70;
key.shadow.camera.left = -16;
key.shadow.camera.right = 16;
key.shadow.camera.top = 16;
key.shadow.camera.bottom = -16;
// A LARGE normalBias AND back-face casting, tuned together against the gate
// pillars -- the worst case in the build, being thin, bevelled and nearly
// parallel to the light. normalBias offsets the lookup along the surface
// normal, which is exactly the correction a grazing surface needs; bias stays
// small so contact shadows still touch what casts them.
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.06;
scene.add(key, key.target);

// THE FILL IS NEUTRAL, NOT BLUE.
//
// It used to be a 0xbcdcff sky over a 0x6a6058 ground at 0.62, plus a 0x6d7fa0
// ambient at 0.20 -- and the note here said fill had to stay low or the toon
// banding would stop reading. That was the right worry aimed at the wrong
// control. The plaza is a courtyard ringed by nine buildings, so most of it is
// in shade most of the time, and in shade a surface is mostly FILL COLOUR: with
// the fill that blue, warm plaster, terracotta roof, teal shutters and a red
// awning all collapsed into one brown-navy value. An A/B with the shadow map
// off showed five distinguishable colours in the same frame that shows one with
// it on, which is a legibility failure, not a contrast choice.
//
// So the fill is brighter and much closer to neutral -- shade is now a darker
// value OF the material rather than a wash of sky over it -- and the contrast
// that was being protected is protected where it belongs, in the ramp.
const hemi = new THREE.HemisphereLight(0xd2e2ee, 0x8f7f6a, 0.88);
const ambient = new THREE.AmbientLight(0x9d9aa4, 0.26);
scene.add(hemi, ambient);

// ------------------------------------------------------------------ outlines

const OUTLINES = [];
const OUTLINE_MESHES = [];   // the shells themselves, so a look can hide them
const SHELLS = new WeakMap();

function addOutline(mesh, width = 0.0032, sway = 0) {
  const mat = outlineMaterial(0x2a2233, width, sway);
  let shell = SHELLS.get(mesh.geometry);
  if (!shell) SHELLS.set(mesh.geometry, shell = outlineGeometry(mesh.geometry));

  let clone;
  if (mesh.isSkinnedMesh) {
    // A skinned outline must stay a SIBLING: parenting it under the source mesh
    // would apply that mesh's world matrix on top of the skinning that already
    // accounts for it, and the shell would drift off the body.
    clone = new THREE.SkinnedMesh(shell, mat);
    clone.bindMode = mesh.bindMode;
    clone.bind(mesh.skeleton, mesh.bindMatrix);
    clone.position.copy(mesh.position);
    clone.quaternion.copy(mesh.quaternion);
    clone.scale.copy(mesh.scale);
    (mesh.parent || scene).add(clone);
  } else {
    // Everything else becomes a CHILD at identity, so the shell tracks the
    // source transform forever rather than a snapshot of it.
    clone = new THREE.Mesh(shell, mat);
    mesh.add(clone);
  }
  clone.castShadow = false;
  clone.receiveShadow = false;
  // CULL THE SHELL EXACTLY WHEN ITS SOURCE IS CULLED. This was hard-false, so
  // iteration 2's fix for "frustum culling disabled on static environment
  // meshes" only ever applied to the meshes and not to their outlines -- and
  // the shells are half the triangles. The plaza was drawing 626k triangles for
  // two buildings, a fountain and two enemies, most of it off-screen.
  clone.frustumCulled = mesh.frustumCulled;
  OUTLINES.push(mat);
  OUTLINE_MESHES.push(clone);
  return clone;
}

// -------------------------------------------------------------------- town

// ONE NAME PER SURFACE.
//
// The builders generate a texture for a surface and name the resulting material
// `<surface>_tex`, because `image_material` hands back any existing material
// with the requested name and the palette already owns a flat `cobble`. That
// rename has now broken lookup after lookup in this file, each time silently:
// the outline exclusions, the shadow exclusions, and -- found by rendering the
// plaza with the rim forced to zero and watching a bleached wash disappear --
// the entire per-material look table, so every textured ground surface in the
// build was running the default rim meant for a creature.
//
// So the suffix is stripped ONCE, here, and every table below is keyed on the
// surface, not on whatever the exporter happened to call it.
const surfaceOf = (matName) => (matName || '')
  .toLowerCase()
  // `m_` marks a MEADOW-textured variant of a shared surface: the town's
  // `stone` is coursed ashlar and the meadow's is undressed rock, so they
  // cannot be the same image, but they must land on the same look entry or
  // every table in this file needs a second row that will drift from the first.
  .replace(/^m_/, '')
  .replace(/_tex$/, '');

// Materials that must NOT be shaded: a lamp that falls into the shadow band
// stops looking lit, and glass reads better as a flat pane than as a surface.
// `ridge_a`/`ridge_b` are the painted backdrop: unlit on purpose, because a
// silhouette 200 m away that responds to the key light is a silhouette that
// swings with it, and aerial perspective is already baked into the colour.
// GLASS IS IN HERE NOW. The comment above has said "glass reads better as a
// flat pane than as a surface" since it was written and the set never contained
// it, so every shopfront on the shaded side of the square was a black
// rectangle -- in a capture framed ON a shopfront, the shopfront was the least
// readable thing in it.
// `pod` is in here for the same reason `lamp` is: it is emissive in the
// builder, and `applyTownLook` replaces every material with a toon one that
// knows nothing about emission -- so a glowing find would have arrived as a
// slightly yellow mushroom.
// `forge` joins them: it is the smithy's fire, and a hearth that takes the
// shadow band is a hearth made of cold rubble.
const TOWN_FLAT = new Set(['lamp', 'glass', 'pod', 'forge', 'ridge_a', 'ridge_b', 'ridge_c', 'snow', 'cloud']);
// ...and out of the fog. The fog reaches 130 m; the rings are at 185 and 245,
// so leaving them in would fade them to exactly the sky and there would be no
// backdrop at all.
const NO_FOG_ENV = new Set(['ridge_a', 'ridge_b', 'ridge_c', 'snow', 'cloud']);
// Foliage is NOT outlined. An inverted hull round 500 grass tufts and every
// flower turns a meadow into a scribble; outlines belong on things whose
// silhouette carries meaning.
const NO_OUTLINE_ENV = new Set([
  'grass_hi', 'bloom_a', 'bloom_b', 'leaf_lo',
  // REEDS, for exactly the reason the grass blades are here. A stem is 2.3 cm
  // at the base and tapers to nothing; the inverted hull is a fixed width in
  // SCREEN space, so on something that thin the shell is most of what you see
  // and three hundred of them came out as a thicket of black wire. The heads
  // keep theirs -- they are 6 cm across and want the line.
  'reed',
  // GROUND is not outlined either, and this one is about cost, not taste: an
  // inverted hull round a surface that fills the screen is a second full-screen
  // fill for an outline you only ever see at the silhouette.
  // The visible symptom of getting this wrong was a stray black line drawn
  // across open grass; the invisible one was half the build's triangles being
  // outline.
  'grass', 'dirt', 'verge', 'ground', 'cobble', 'cobble_b', 'flagstone', 'ring',
  'ridge_a', 'ridge_b', 'ridge_c', 'snow', 'cloud', 'flag_a', 'flag_b', 'flag_c',
]);
// Ground casts nothing useful onto itself; tufts and blooms cast nothing at all.
//
// `leaf_lo` IS A TUFT MATERIAL and was missing from this list, so 22,000
// triangles of ankle-high grass were being drawn into a 32 m shadow map every
// frame. The symptom was not "I can see grass shadows" -- at that size each one
// is a texel -- it was a uniform speckled darkening of the entire meadow that
// stopped dead at a straight line where the shadow frustum ended. Turning the
// shadow map off and watching a hard-edged wedge of "brighter" ground vanish is
// what found it; from inside the frame it looked like a lighting bug.
const NO_SHADOW_ENV = new Set([
  'grass', 'dirt', 'verge', 'ground', 'cobble', 'cobble_b', 'flagstone', 'ring',
  'grass_hi', 'bloom_a', 'bloom_b', 'leaf_lo', 'pod', 'ridge_a', 'ridge_b', 'ridge_c', 'snow', 'cloud',
]);
const TINY_ENV = new Set(['grass_hi', 'bloom_a', 'bloom_b', 'leaf_lo']);
const TOWN_LOOK = {
  // THE GROUND GETS ALMOST NO RIM. On a plane, `1 - dot(view, normal)` is not
  // an edge light at all -- it is a distance ramp, zero directly under the
  // camera and approaching one at the horizon. At the default 0.28 the plaza
  // paving lost its contrast from about six metres out and the far side of the
  // square read as overexposed white. 0.06 keeps stone from going dead flat
  // and is not enough to bleach anything.
  ground:    { gradient: RAMP_SOFT, rimStrength: 0.06 },
  cobble:    { gradient: RAMP_SOFT, rimStrength: 0.06 },
  cobble_b:  { gradient: RAMP_SOFT, rimStrength: 0.06 },
  flagstone: { gradient: RAMP_SOFT, rimStrength: 0.06 },
  ring:      { gradient: RAMP_SOFT, rimStrength: 0.06 },
  verge:     { gradient: RAMP_SOFT, rimStrength: 0.06 },
  stone:   { gradient: RAMP_SOFT, rimStrength: 0.30 },
  glass:   { rimStrength: 1.20, rimColor: 0xffffff },
  // 0.12, not 0.90. Rim light is `1 - dot(view, normal)`, which is small on a
  // ball and near ONE across a large flat plane seen at a grazing angle -- so a
  // value tuned on the fountain bowl added most of a cyan to every fragment of
  // a ninety-metre stream and rendered it as a drift of snow.
  // 0.05: same argument as the ground below -- a ninety-metre water plane is
  // seen almost entirely at a grazing angle, so any rim at all is a uniform
  // lightening of the whole surface rather than a highlight on its edge.
  // TRANSPARENT, because an opaque plane with a straight-cut edge is not
  // water, it is a painted floor -- which is what an audit called it. At 0.72
  // the bed and the bank stones read through it, so the shoreline becomes the
  // line where the plane meets the ground rather than a hard edge drawn on top
  // of it, and the ford's stepping stones stop looking like they are resting
  // on a lid.
  water:   { rimStrength: 0.05, rimColor: 0xd8f4ff, opacity: 0.72, ripple: 1.0 },
  foam:    { rimStrength: 0.35, rimColor: 0xffffff },
  brass:   { rimStrength: 1.00, rimColor: 0xfff0c0 },
  // meadow
  grass:    { gradient: RAMP_SOFT, rimStrength: 0.06 },
  grass_hi: { gradient: RAMP_SOFT, rimStrength: 0.34, sway: 0.035 },
  // REEDS SWAY THREE TIMES AS MUCH AS GRASS, which is the point of them.
  // Everything outdoors moves in the same wind and almost nothing shows it: a
  // 3 cm blade at one per fifteen square metres cannot, and a canopy forty
  // metres off moves too little to read. A reed is 1.5 m of near-vertical line
  // with a heavy head on it, and there are three hundred in one place.
  reed:      { gradient: RAMP_SOFT, rimStrength: 0.40, sway: 0.10 },
  reed_head: { rimStrength: 0.30, sway: 0.10 },
  dirt:     { gradient: RAMP_SOFT, rimStrength: 0.06 },
  bark:     { rimStrength: 0.40 },
  // WIND. Amplitudes in metres of horizontal drift at the gust's peak. A canopy
  // is a blob sitting on a trunk that does not move, so 11 cm reads as branches
  // flexing; a grass blade is 30 cm tall, so 3 cm reads as motion rather than
  // as the ground sliding. Cloth gets the most, because cloth should.
  leaf:     { rimStrength: 0.45, sway: 0.11 },
  leaf_lo:  { rimStrength: 0.34, sway: 0.035 },
  // A conifer's skirts are stiffer than a broadleaf canopy, so it moves less.
  conifer:  { rimStrength: 0.38, sway: 0.055 },
  bark_dead:{ rimStrength: 0.34 },
  // 0.06, NOT 0.30. The pass walls are blobs eight metres across, seen at a
  // grazing angle from the road: `1 - dot(view, normal)` is high over most
  // of that face, and 0.30 of a pale blue rim washed the biggest rock in the
  // game to cream -- through two texture and two tint changes that could not
  // have shown. The same lesson the ground taught, on a rounder surface.
  rock:     { gradient: RAMP_SOFT, rimStrength: 0.06 },
  // pennants on a rope: the one thing in the square that should visibly move
  flag_a:   { rimStrength: 0.30, sway: 0.06 },
  flag_b:   { rimStrength: 0.30, sway: 0.06 },
  flag_c:   { rimStrength: 0.30, sway: 0.06 },
  bloom_a:  { rimStrength: 0.70, rimColor: 0xfff4c8, sway: 0.03 },
  bloom_b:  { rimStrength: 0.70, rimColor: 0xffd8ec, sway: 0.03 },
};

// EVERY MATERIAL THIS FILE OWNS, and the recipe that made it.
//
// Switching look means rebuilding materials, not tweaking them: a toon ramp
// and a standard BRDF are different material classes. Recording the recipe at
// load is what makes the switch possible at all -- by the time the material
// exists the GLB's own colour and map have been thrown away.
const SURFACES = [];       // { mesh, kind, name, color, map, vcol, opts }
let LOOK = LOOKS.painted;
let breakables = null;     // the props that come apart -- see breakables.js
const SOLIDS = [];         // oriented boxes, from every region's manifest
const PLATFORMS = [];      // flat tops ABOVE the analytic ground
// Spheres the camera must not enter and nothing else knows about -- tree
// canopies, chiefly. See Town.camblock for why this is a separate list.
const CAM_BLOCKERS = [];
let terrain = null;        // analytic ground for the meadow
let terrainProbes = [];
const FLOORS = [];         // meshes the ground raycast targets
// OPEN VOLUMES THE CAMERA MAY ALWAYS OCCUPY -- see `Town.shafts` in arch_lib.
const SHAFTS = [];
// THINGS THAT MOVE WHEN YOU HIT THEM -- see `Town.moving` in arch_lib. One so
// far: the bell. Kept out of the town's big join, because you cannot rotate one
// bell inside a mesh that contains the whole town.
const MOVERS = [];
const LAMPS = [];               // the plaza's outdoor lanterns, for dusk
const RING_T = 7.0;             // how long a ring takes to die away
const _mm = new THREE.Matrix4();
const _mr = new THREE.Matrix4();
let townReady = false;

function applyTownLook(root) {
  const meshes = [];
  // Environment meshes are STATIC, so they keep frustum culling. It was
  // disabled wholesale early on, which is correct for a deforming character
  // and wrong here: it meant the entire town kept rendering while the player
  // was out in the meadow.
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    const name = surfaceOf(m.material?.name);
    // REMEMBER IT. The loop below decides outlines by material name, and by
    // then this loop has replaced the material with a fresh MeshToonMaterial
    // that carries no name at all -- so the exclusion set matched nothing and
    // every ground surface got a shell regardless of what was listed.
    m.userData.matName = name;
    const color = m.material?.color?.clone() || new THREE.Color(0xffffff);
    // CARRY THE TEXTURE THROUGH. This rebuilt every material from scratch and
    // dropped the map with it, so the generated paving arrived in the GLB and
    // was thrown away one line into the runtime.
    const map = m.material?.map || null;
    if (map) {
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
    }
    // WHITE UNDER A MAP. MeshToonMaterial multiplies colour by map, and these
    // textures are generated already tinted -- so keeping the material colour
    // applied the tint twice and every textured surface came out a shade of
    // itself squared.
    const base = map ? new THREE.Color(0xffffff) : color;
    // VERTEX COLOURS, where the geometry carries them. The meadow floor is one
    // material whose entire grass-to-path transition is a COLOR_0 attribute --
    // ignoring it ships a field of flat mottled white.
    const vcol = !!m.geometry.getAttribute('color');
    // LEAF CARDS. A canopy is forty transparent cards, not a ball: the cut is
    // the alpha in the painted leaf texture, both faces draw, and the shadow
    // pass has to see the same cut or every tree casts a square. No ink hull
    // round a card -- the alpha edge IS the line.
    const card = name.startsWith('leafcard');
    const opts = { gradient: RAMP_SOFT, rimStrength: 0.28, map, vertexColors: vcol,
                   key: `town:${name}:${vcol ? 'v' : ''}`,
                   ...(card ? { alphaTest: 0.5, side: THREE.DoubleSide, rimStrength: 0.12,
                                gradient: RAMP_SOFT, sway: 0.06, flutter: 0.022, nearFade: 1.6,
                                windUV: true } : {}),
                   ...(TOWN_LOOK[name] || {}) };
    SURFACES.push({ mesh: m, flat: TOWN_FLAT.has(name), color: base, opts });
    m.material = TOWN_FLAT.has(name) ? flatMaterial(base)
                                     : surfaceMaterial(LOOK, base, opts);
    if (card && map) {
      m.customDepthMaterial = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5, side: THREE.DoubleSide });
    }
    // NOT EVERYTHING CASTS. The shadow map is a second full pass over the
    // scene, so a 6k-triangle terrain and 500 grass tufts casting shadows
    // nobody can see is the most expensive nothing in the build. Ground
    // receives; small foliage does neither.
    // SHADOW-CAST FROM THE BACK FACES.
    //
    // The town is closed, bevelled solids, so the surface nearest the light is
    // also the surface being tested -- which is what self-shadowing acne IS.
    // Writing only back faces into the depth map moves the reference surface to
    // the far side of the object, where nothing visible is being compared
    // against it. Texel snapping stopped the speckle crawling; this is what
    // stops it existing.
    m.material.shadowSide = card ? THREE.DoubleSide : THREE.BackSide;
    if (NO_FOG_ENV.has(name)) { m.material.fog = false; m.renderOrder = -1; }
    m.castShadow = !NO_SHADOW_ENV.has(name);
    m.receiveShadow = !TINY_ENV.has(name);
  }
  for (const m of meshes) {
    const name = m.userData.matName || '';
    if (NO_OUTLINE_ENV.has(name) || name.startsWith('leafcard')) continue;
    // the shell has to move with what it wraps, or it leaks out of one side
    addOutline(m, 0.0022, (TOWN_LOOK[name] || {}).sway || 0);
  }
  return meshes;
}

/** Fold a region's floor meshes and collision boxes into the shared world.
 *  The plaza and the meadow are separate builds but ONE world at runtime --
 *  the player should never learn where the seam is. */
function absorbRegion(root, manifest) {
  // Match on the mesh's OWN name and skip outline shells. A shell is a child of
  // its source mesh, so a parent-name match silently added every outline to the
  // ground raycast -- doubling its cost and letting it return a surface 2 mm
  // off the real floor.
  // THE LOOKUP HAS TO EXIST BEFORE THE LOOP THAT USES IT. This was below the
  // traverse, so `MOVERS.find` matched nothing on every node and the bell was
  // never claimed -- it loaded, it was in the scene, and it sat there.
  for (const q of manifest.movers || []) MOVERS.push({ ...q, obj: null, t: -1 });
  root.traverse((o) => {
    // A MOVER MAY BE A GROUP. A node with two materials comes back from the
    // loader as a Group named MOVE_x with one mesh per material under it, so
    // an `isMesh` gate here left the chest -- timber lid, iron bands -- in
    // the scene, unclaimed and unopenable, while the one-material bell worked.
    const mv = /^MOVE_(.+)$/.exec(o.name || '');
    if (mv) {
      const m = MOVERS.find((q) => q.name === mv[1]);
      // the transform is composed by hand every frame -- see `updateMovers`
      if (m && !m.obj) { m.obj = o; o.matrixAutoUpdate = false; }
    }
    if (!o.isMesh || o.material?.isShaderMaterial) return;
    if (/FLOOR/i.test(o.name || '')) FLOORS.push(o);
  });
  for (const p of manifest.platforms || []) PLATFORMS.push(p);
  for (const q of manifest.shafts || []) SHAFTS.push(q);
  for (const c of manifest.camBlockers || []) CAM_BLOCKERS.push(c);
  for (const s of manifest.solids || []) {
    SOLIDS.push({
      x: s.x, z: s.z, hx: s.hx, hz: s.hz, top: s.top ?? 3,
      // `base` defaults to -0.5 for everything that stands on the ground; the
      // cellar's walls are the first thing in the build that does not.
      base: s.base ?? -0.5,
      c: Math.cos(s.yaw), s: Math.sin(s.yaw),
    });
  }
  world.add(root);
}

Promise.all([
  new GLTFLoader().loadAsync('/assets/town.glb'),
  fetch('/assets/town.manifest.json').then((r) => r.json()),
  new GLTFLoader().loadAsync('/assets/meadow.glb'),
  fetch('/assets/meadow.manifest.json').then((r) => r.json()),
]).then(([town, townMan, meadow, meadowMan]) => {
  applyTownLook(town.scene);
  applyTownLook(meadow.scene);
  absorbRegion(town.scene, townMan);
  absorbRegion(meadow.scene, meadowMan);


  // the meadow answers ground queries analytically; prove the port agrees
  terrain = makeTerrain(meadowMan.terrain);
  terrainProbes = meadowMan.terrainProbes;
  const agree = terrain.check(terrainProbes);
  console.log(`[terrain] port agrees with the mesh to ${agree.worst} over `
    + `${agree.n} probes`);
  if (agree.worst > 1e-4) {
    console.error('[terrain] PORT HAS DRIFTED from the builder', agree.at);
  }
  // THE FIELD. Placed off the same port, so it sits on the ground it agrees with.
  grass = makeGrass({
    scene, terrain,
    material: (opts) => surfaceMaterial(LOOK, new THREE.Color(0x5c8f3c), opts),
  });
  console.log(`[grass] ${grass.count} clumps in ${grass.meshes.length} chunks`);

  // Lantern lights are a warm ACCENT in daylight, not a second key -- and at
  // intensity 4 over a 7.5 m range they were not even that: they painted a
  // round yellow hotspot onto sunlit plaster next to every lamp, which reads as
  // a rendering bug rather than as a lamp. A lit lamp at midday should be
  // almost nothing; the glow belongs on the lamp head, not on the wall behind
  // it, which is what the emissive `lamp` material is for.
  for (const L of townMan.lights || []) {
    // 0.45 over 3.2 m, and it took three passes to get here. At 4.0/7.5 each
    // lamp painted a yellow disc across a sunlit facade; at 1.1/4.2 the disc
    // was smaller and still plainly a disc, because the thing that makes it
    // read as a bug is not its brightness but its EDGE -- a soft circular
    // gradient on a flat wall in a game with no other soft gradients anywhere.
    // At this strength it is a warm pool at the foot of the post and nothing
    // on the wall behind it, which is all a lit lamp should do at midday.
    // A LAMP INDOORS IS NOT AN ACCENT, IT IS THE LIGHT. The plaza's six are
    // deliberately almost nothing at midday; the cellar's is the only source in
    // a room the sun cannot reach. That used to be told apart by testing
    // whether the lamp was below the paving, which was true of the cellar and
    // of nothing else -- the belltower's stair lamps are twelve metres UP a
    // windowless shaft and just as much the only light in the room. The
    // builder now says which job each lamp does instead.
    const inside = L.k === 'interior' || L.y < -0.5;
    const lamp = new THREE.PointLight(0xffc879, inside ? 6.0 : 0.45,
                                      inside ? 9.0 : 3.2, 2);
    lamp.position.set(L.x, L.y, L.z);
    world.add(lamp);
    if (!inside) LAMPS.push(lamp);
  }

  townReady = true;
  console.log(`[world] ${FLOORS.length} floor meshes, ${SOLIDS.length} solids`);
  startCombat();
  // AFTER startCombat, which builds it, and after absorbRegion, so the
  // collision boxes exist to be removed from when a prop is smashed. Barrels
  // and crates arrive as their own `BREAK_*` objects rather than folded into
  // the town mesh -- see arch_lib.Town.breakable.
  const nProps = breakables.collect(town.scene) + breakables.collect(meadow.scene);
  console.log(`[props] ${nProps} breakable`);
  done();
}).catch((err) => {
  document.getElementById('loading').textContent = 'failed to load the world';
  console.error(err);
});

// ----------------------------------------------------------- the characters
//
// Two characters share one animation library.  The hero is generated by
// tools/hero_build.py; Vesper's MESH came from the Emberbrook project and was
// re-rigged by tools/vesper_build.py onto this project's skeleton.  Because the
// clips are bone-name-keyed pose data rather than baked transforms, both play
// the identical five clips with no retarget step and no per-character code here.

const HERO_LOOK = {
  // skin takes the LIGHTEST rim on a face: a face is mostly midtone, so a
  // strong rim eats the whole head and the features stop reading
  skin:   { rimStrength: 0.30, rimColor: 0xffd9c0 },
  hair:   { rimStrength: 0.60, rimColor: 0xffd9a8 },
  jacket: { rimStrength: 0.75 },
  pants:  { rimStrength: 0.65 },
  glove:  { rimStrength: 0.45 },
  shoe:   { rimStrength: 0.55 },
  trim:   { rimStrength: 0.60 },
  metal:  { rimStrength: 1.10, rimColor: 0xffffff },
  gold:   { rimStrength: 1.00, rimColor: 0xfff0c0 },
};
// The Emberbrook cast are single textured meshes, so one material covers the
// whole body and they all want the same treatment.
const SKIN_RIM = { rimStrength: 0.45, rimColor: 0xffe0c8 };
const CAST_LOOK = {
  vesper: SKIN_RIM, lake: SKIN_RIM, maren: SKIN_RIM,
  // WEAPON SURFACES. These used to arrive as extra materials on the character's
  // own mesh, because the sword was joined into it. The blade is its own node
  // now and may be loaded from public/assets/weapons at equip time, so these
  // entries are read for both -- and the list is longer than the built-in
  // sword needs, because a weapon that cannot change colour cannot look like a
  // better weapon.
  steel:     { rimStrength: 1.20, rimColor: 0xffffff },
  bluesteel: { rimStrength: 1.35, rimColor: 0xdcecff },
  iron:      { rimStrength: 0.85, rimColor: 0xf0f0ea },
  darkiron:  { rimStrength: 0.65, rimColor: 0xc8c8d0 },
  brass:     { rimStrength: 1.00, rimColor: 0xfff0c0 },
  jewel:     { rimStrength: 1.40, rimColor: 0xbdf3ff },
  wood:      { rimStrength: 0.35 },
  wrap:      { rimStrength: 0.35 },
  leather:   { rimStrength: 0.40 },
};
const FLAT_MATS = new Set(['eye', 'iris', 'pupil']);
const NO_OUTLINE = new Set(['face']);   // a hull round a flat decal rings the face

const ROSTER = [
  { name: 'vesper', url: '/assets/vesper.glb', look: CAST_LOOK, outline: 0.0028 },
  { name: 'lake',   url: '/assets/lake.glb',   look: CAST_LOOK, outline: 0.0028 },
  { name: 'maren',  url: '/assets/maren.glb',  look: CAST_LOOK, outline: 0.0028 },
];
// THE TOWNSPEOPLE'S BODIES. Loaded into `chars` like the cast, but deliberately
// not in ROSTER -- `cycleCharacter` walks ROSTER, so C still cycles the three
// playable characters and does not offer to make you the shopkeeper. They are
// here to be CLONED by npc.js, which wants the finished article: toon materials
// keyed to the look table and an outline hull per mesh, both of which
// `buildCharacter` has already done.
//
// Same intake as the cast, and for the same reason it was cheap: these are
// Emberbrook Tripo generations on the identical source rig, so each one cost a
// row in char_build.CHARACTERS. They also arrive with painted cut-in portraits
// already drawn, which is the half of a conversation this engine cannot make.
// LOW-POLY, AND THAT IS THE WHOLE POINT OF THEM BEING SEPARATE FILES. The
// playable rigs come out of char_build at 0.45 decimation, which is 86,000
// triangles each -- fine for the one body the camera is always three metres
// from, and ruinous nine times over. Nine townspeople took the plaza to
// 2,014,781 triangles and 20 fps, and every one of those triangles was on
// somebody standing still in the middle distance.
//
// These are the same characters through the same pipeline at 0.10, about
// 19,000 triangles apiece. They are cloned by npc.js and never played, so the
// only thing they have to survive is being looked at from two metres away in a
// toon ramp that reads silhouette before surface -- which is exactly the case
// decimation costs least.
//
// Keyed `<name>.npc` so they cannot collide with the playable rig of the same
// name: Lake is both a character you can BE and a body two townspeople wear.
const NPC_RIGS = [
  { name: 'lake.npc',  url: '/assets/npc/lake.glb',  look: CAST_LOOK, outline: 0.0028 },
  { name: 'maren.npc', url: '/assets/npc/maren.glb', look: CAST_LOOK, outline: 0.0028 },
  { name: 'finn.npc',  url: '/assets/npc/finn.glb',  look: CAST_LOOK, outline: 0.0028 },
  { name: 'mara.npc',  url: '/assets/npc/mara.glb',  look: CAST_LOOK, outline: 0.0028 },
  { name: 'pip.npc',   url: '/assets/npc/pip.glb',   look: CAST_LOOK, outline: 0.0028 },
];
// The scripted five-head hero was the character PROBE, not a cast member, and
// he reads as a different game beside these three.  hero_build.py still builds
// him -- he is the reference implementation and hosts the joint probes -- he is
// just not in the roster any more.

const chars = {};
let cur = null;                 // the active character
let attacking = false;

function buildCharacter(def, gltf) {
  const group = new THREE.Group();
  const root = gltf.scene;
  const mats = [];
  const meshes = [];
  root.traverse((o) => { o.frustumCulled = false; if (o.isMesh) meshes.push(o); });

  for (const m of meshes) {
    const name = surfaceOf(m.material?.name);
    // SAME TRAP AS THE TOWN. The outline loop below used to read the material
    // name again -- from the material this loop has already replaced, which
    // carries no name -- so `NO_OUTLINE` matched nothing and the face got an
    // inverted hull round a flat decal, which is the one thing that comment
    // says not to do.
    m.userData.matName = name;
    const color = m.material?.color?.clone() || new THREE.Color(0xffffff);
    const map = m.material?.map || null;      // face decal / body texture
    const opts = { key: def.name + ':' + name, map, ...(def.look[name] || {}) };
    SURFACES.push({ mesh: m, flat: FLAT_MATS.has(name), color, opts });
    m.material = FLAT_MATS.has(name) ? flatMaterial(color)
                                     : surfaceMaterial(LOOK, color, opts);
    m.castShadow = true;
    // A CHARACTER DOES NOT RECEIVE SHADOWS.  A 1.7 m body inside a 32 m shadow
    // frustum gets ~15 texels across the head, so self-shadow lands as grey
    // blotches on the face.  A stylised character is shaded by its ramp; it
    // still CASTS, which is the part the player reads.
    m.receiveShadow = false;
  }
  for (const m of meshes) {
    mats.push(m.material);
    if (NO_OUTLINE.has(m.userData.matName || '')) continue;
    mats.push(addOutline(m, def.outline).material);
  }
  // transparency up front, so the close-camera fade never triggers a mid-frame
  // shader recompile the first time the camera gets tight
  for (const m of mats) { m.transparent = true; m.opacity = 1; }

  group.add(root);
  group.visible = false;
  scene.add(group);

  const mixer = new THREE.AnimationMixer(root);
  const clips = {};
  for (const clip of gltf.animations) {
    const a = mixer.clipAction(clip);
    clips[clip.name] = a;
    if (clip.name === 'attack' || clip.name === 'jump' || clip.name === 'land'
        || clip.name === 'sheathe' || clip.name === 'draw'
        || clip.name === 'open' || clip.name === 'cast_fire') {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;        // `jump` HOLDS its airborne pose
    }
  }
  const ch = { name: def.name, group, mixer, clips, mats, current: null,
               legs: collectLegs(group),
               // THE RAW CLIPS, not just the actions. `clips` above are
               // AnimationActions already bound to THIS character's mixer, and
               // an action cannot be replayed on another one. An NPC clone
               // needs the underlying AnimationClips to bind its own.
               rawClips: gltf.animations,
               hand: findBone(group, 'handr'),
               // THE WEAPON IS ITS OWN NODE, hanging off hand.R rather than
               // welded into the skin (see tools/props.attach_to_bone).  Held
               // here because a thing you cannot name you cannot throw: this is
               // the handle a disarm, a sheathe, a weapon swap or a thrown
               // blade all need.  Null on anyone unarmed -- the townspeople are
               // built without one, and that is the normal case, not an error.
               weapon: findWeapon(root) };
  mixer.addEventListener('finished', (e) => {
    if (e.action === clips.land) {
      landing = false;
      play(moving() ? 'run' : 'idle', 0.14);
    }
    // `jump` deliberately does NOT resolve here: it clamps on the airborne pose
    // and is held until physics says we touched down.
  });
  return ch;
}

function selectCharacter(name) {
  const next = chars[name];
  if (!next || next === cur) return;
  if (cur) { cur.group.visible = false; cur.mixer.stopAllAction(); cur.current = null; }
  cur = next;
  cur.group.visible = true;
  attacking = false;
  landing = false;
  play('idle', 0);
  // Whoever just stepped forward carries what the sheet says they carry, and
  // they may never have been synced -- GS's `change` only fires on a change.
  syncWeapon();
  hud.dataset.who = name;
  const vname = document.getElementById('vname');
  if (vname) vname.textContent = name.charAt(0).toUpperCase() + name.slice(1);
}

// ------------------------------------------------------------------ people
//
// WHERE EVERYBODY STANDS. Positions are in three.js world space (z = -blender y)
// and were read off the town build rather than eyeballed: the shop door is at
// (7, 15) in the builder's frame, the smithy at (17, -2), the belltower at
// (-1, 15.5), the walled yard at (26, -3.25).
//
// EVERY ONE OF THEM IS SOMEWHERE THEY WOULD BE. A townsperson standing in open
// paving is set dressing; a townsperson at their own counter, gate or fire is a
// place with somebody in it. Tally is at her stall, Hobb at his forge, the
// Sexton under the tower she keeps, Mara in the yard with the animals, Pip
// beside the cart with the bad wheel, Finn behind the shop counter -- and Nell
// is loose in the square, because a child who stays put is not a child.
//
// `rig` is which body they wear and `tint` is how six rigs dress ten people.
const NPC_ROSTER = [
  // BODIES ARE CAST AGAINST THE PORTRAITS, not assigned and hoped for. The
  // first pass put Tally's elderly-cleric cut-in on a young woman in a red
  // dress, and the mismatch is the loudest thing in the frame -- you read the
  // body for two seconds while you walk up, then the box contradicts it.
  // Looking at the art settled it: the `tally` plate is a bald man in glasses
  // and a sashed robe, which is a SEXTON; `elder-woman` is an old woman with a
  // shawl and knitting, which is somebody who has run a market stall for forty
  // years. They swapped, and both got better.
  //
  // Five people wear their own face -- finn, mara, pip, lake, maren are the
  // rigs those portraits were drawn for. The other four borrow a rig and are
  // tinted, which is exactly how Emberbrook dresses thirty-nine people in six
  // bodies: a toon ramp reads silhouette and value long before it reads a face.
  { id: 'tally',  name: 'Tally',      rig: 'maren.npc', tint: '#cfc6b4', scale: 0.95,
    x: -6.2, z: 2.4,   facing: 150, dialogue: 'tally.hail' },
  { id: 'hobb',   name: 'Hobb',       rig: 'lake.npc',  tint: '#c9a184',
    x: 15.6, z: -1.4,  facing: 210, dialogue: 'hobb.hail' },
  { id: 'sexton', name: 'The Sexton', rig: 'finn.npc',  tint: '#a9a4b4', scale: 0.97,
    x: -2.6, z: 11.2,  facing: 200, dialogue: 'sexton.hail' },
  // ERRANDS: three of them walk. Waypoints are on open paving, checked
  // against the town's solids by `__npcPaths()`; the loop returns to the
  // spot the dialogue was written for.
  { id: 'nell',   name: 'Nell',       rig: 'pip.npc',   tint: '#f0d79a', scale: 0.74,
    x: 3.4,  z: 1.2,   facing: 40,  dialogue: 'nell.hail', speed: 1.35,
    path: [[7.6, -3.2], [6.0, -7.6], [3.4, 1.2]] },
  { id: 'finn',   name: 'Finn',       rig: 'finn.npc',
    // (6.4, 16.6) was INSIDE the east building's collision box -- reachable
    // only because reach is longer than the box edge is far. On the paving now.
    x: 3.2,  z: 12.0,  facing: 180, dialogue: 'finn.hail', speed: 1.0,
    path: [[3.2, 8.0], [-2.4, 8.4], [3.2, 12.0]] },
  { id: 'mara',   name: 'Mara',       rig: 'mara.npc',
    x: 25.0, z: -4.6,  facing: 300, dialogue: 'mara.hail', y: 1.2 },
  { id: 'pip',    name: 'Pip',        rig: 'pip.npc',
    x: 1.2,  z: -9.0,  facing: 20,  dialogue: 'pip.hail', speed: 1.25,
    path: [[-2.6, -6.6], [-2.9, 0.6], [-3.0, -4.6], [1.2, -9.0]] },
  // THE TWO TRAVELLERS ARE OUT IN IT. Lake never leaves the step he found;
  // Maren is at the ruin, thirty metres off the road, which is the point of
  // the ruin. Finding somebody you know out in the meadow is worth more than
  // one more person in the square.
  { id: 'lake',   name: 'Lake',       rig: 'lake.npc',
    x: 11.4, z: -7.6,  facing: 250, dialogue: 'lake.hail' },
  { id: 'maren',  name: 'Maren',      rig: 'maren.npc',
    x: -13.4, z: -49.6, facing: 30, dialogue: 'maren.hail' },
];

let npcs = null;
let drops = null;

// ------------------------------------------------------- what you just got
//
// One line per thing, newest at the bottom, gone in under three seconds. This
// is the whole of the reward UI outside the menu, and it exists because the
// economy was invisible without it: xp, gold and items all landed silently in
// a save file and the player had to stop and press Esc to discover that any of
// it had happened.
const gainsEl = document.getElementById('gains');
const purseEl = document.getElementById('purse');

function gain(text, kind) {
  if (kind === 'item') sfx.pickup(false);
  else if (kind === 'lvl') sfx.level();
  else if (/^\+\d+ g$/.test(text)) sfx.pickup(true);
  if (!gainsEl) return;
  const el = document.createElement('div');
  if (kind) el.className = kind;
  el.textContent = text;
  gainsEl.appendChild(el);
  // FIVE LINES AT MOST. A wiped encounter pays four times over and the column
  // would otherwise climb the side of the screen.
  while (gainsEl.children.length > 5) gainsEl.removeChild(gainsEl.firstChild);
  // removed on the animation's own schedule rather than a timer, so the two
  // cannot disagree about when the line is gone
  el.addEventListener('animationend', () => el.remove());
}

function purse() {
  if (!purseEl || !window.GS || !GS.ok) return;
  const me = GS.state.party.find((m) => m.active) || GS.state.party[0];
  purseEl.innerHTML = `<b>${GS.state.gold}</b> g`;
  const vlv = document.getElementById('vlv');
  if (vlv && me) vlv.textContent = `LV ${me.level}`;
}

Promise.all(ROSTER.concat(NPC_RIGS).map((def) =>
  new GLTFLoader().loadAsync(def.url).then((g) => { chars[def.name] = buildCharacter(def, g); })
)).then(() => {
  selectCharacter(ROSTER[0].name);
  console.log('[chars]', Object.keys(chars).map(
    (k) => `${k}: ${Object.keys(chars[k].clips).join('/')}`).join('  |  '));
  // AFTER the rigs, because npc.js clones them -- rule (o), populate a lookup
  // before the thing that reads it.
  // MAX HP IS THE SHEET'S, and it is re-read on every change rather than copied
  // once: a level-up and a change of armour both move it, and a bar that only
  // agrees with the menu at load time is worse than one that never does.
  if (window.GS) {
    const syncHP = () => {
      if (!GS.ok || !combat) return;
      const me = GS.state.party.find((m) => m.active) || GS.state.party[0];
      const st = me && GS.stats(me);
      if (!st || !st.maxHp) return;
      const was = combat.player.maxHP;
      combat.player.maxHP = st.maxHp;
      // a level-up that raises the ceiling should not leave you on a bar that
      // reads as damaged -- carry the gain onto the current pool too
      if (st.maxHp > was) combat.player.hp += st.maxHp - was;
      combat.player.hp = Math.min(combat.player.hp, combat.player.maxHP);
    };
    GS.on('change', () => { syncHP(); purse(); syncWeapon(); });
    // A LEVEL IS THE LOUDEST THING THE ECONOMY DOES, so it gets its own line
    // and its own colour. `grantXp` emits one event per member who levelled.
    // AN ARRAY of {char, level}, one per member who levelled -- `grantXp`
    // splits the award across the active party and can roll more than one
    // level at a time, so this is a list and not an event.
    GS.on('levelup', (events) => {
      syncHP();
      purse();
      for (const ev of events || []) {
        const name = (GS.charDef(ev.char) || {}).name || ev.char;
        gain(`${String(name).toUpperCase()}  LEVEL ${ev.level}`, 'lvl');
      }
    });
    if (GS.ready && GS.ready.then) GS.ready.then(() => { syncHP(); purse(); syncWeapon(); });
  }

  drops = makeDrops({
    scene, groundAt, playerPos: () => pos,
    toast: (label, kind) => gain(kind === 'gold' ? label : label, kind === 'gold' ? null : 'item'),
  });

  npcs = makeNpcs({ scene, chars, groundAt, hud });
  const n = npcs.load(NPC_ROSTER);
  setupWorld();
  air = makeAmbient({ scene, groundAt });
  // CLOUD SHADOWS: one 256px noise image the toon materials scroll across
  // the world. Built here from the same fbm the textures use, on a canvas,
  // so no file is fetched and no build is needed to change it.
  CLOUD.map.value = makeCloudMap();
  CLOUD.strength.value = 0.5;
  console.log('[npc]', n + ' placed:', npcs.debug());
  if (window.EBUI) window.EBUI.assetBase = '/assets/';
  if (window.Dialogue) window.Dialogue.load().catch((e) => console.warn('[dlg]', e));
  done();
}).catch((err) => {
  document.getElementById('loading').textContent = 'failed to load a character';
  console.error(err);
});

function done() {
  if (cur && townReady) {
    document.getElementById('loading').style.display = 'none';
    showTitle();
  }
}

function play(name, fade = 0.22) {
  if (!cur) return;
  const next = cur.clips[name];
  if (!next || next === cur.current) return;
  // RATE-MATCH THE RUN so the feet keep up with the ground. Foot IK plants the
  // sole wherever the clip says it should be, so a body moving faster than its
  // own stride does not read as "fast", it reads as the floor being ice.
  if (name === 'run') next.setEffectiveTimeScale(SPEED / RUN_CYCLE);
  next.reset().setEffectiveWeight(1).play();
  if (cur.current) next.crossFadeFrom(cur.current, fade, false);
  cur.current = next;
}

// -------------------------------------------------------------------- input

const keys = new Set();

// THE INPUT LOCK, which is Emberbrook's contract and not an invention.
//
// The vendored ui_kit.js pauses the world by calling `window.UILOCK.lock(name)`
// and unlocking by name, and it falls back to zeroing `SIM.keys` on a page that
// has no such object. Providing the real thing is four lines and means the
// vendored files can stay byte-identical to upstream, which is the whole reason
// they are in a `vendor/` folder: the next time that project's dialogue box
// improves, this one gets the improvement with a copy.
//
// BY NAME, not a boolean. Two overlays can be open at once -- a shop handed off
// from a conversation is exactly that case -- and a boolean would have the
// first one to close unfreeze the world underneath the second.
const LOCKS = new Set();
window.UILOCK = {
  lock(name) { LOCKS.add(name || 'ui'); keys.clear(); },
  unlock(name) { LOCKS.delete(name || 'ui'); },
  get held() { return LOCKS.size > 0; },
  names: () => [...LOCKS],
};
const uiLocked = () => LOCKS.size > 0;

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  sfx.unlock();
  if (e.code === 'KeyM') { e.preventDefault(); sfx.setMute(!sfx.muted); gain(sfx.muted ? 'sound off' : 'sound on'); return; }
  // a panel's own keys tick: the game does not see them, the ear should
  if (uiLocked() && (e.code === 'KeyE' || e.code === 'Enter' || e.code === 'Space'
                     || e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'Escape')) sfx.ui();
  // WHILE A PANEL IS UP, THE GAME GETS NOTHING. The panel's own capture-phase
  // listener already stops propagation, so this is the belt to that braces --
  // and it is what stops a conversation's Space and E from also jumping and
  // swinging behind the box.
  if (uiLocked()) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); jump(); }
  // E IS SHARED, AND THE PERSON IN FRONT OF YOU IS ASKED FIRST. E has been a
  // second attack key since before there was anybody to talk to, and taking it
  // away would break the muscle memory of every existing capture and probe. So
  // it is contextual the way Emberbrook chains its own E handlers: if somebody
  // is in reach, E talks; otherwise E is still a swing. J is always a swing,
  // which means there is never a moment where you cannot attack.
  if (e.code === 'KeyE' && npcs && npcs.tryTalk()) { e.preventDefault(); sfx.ui(); return; }
  // ...then a THING in reach -- a chest, the beacon -- and only then a swing
  if (e.code === 'KeyE' && interact && interact.tryUse()) {
    e.preventDefault();
    if (interact.near === 'beacon') sfx.cast(); else sfx.ui();
    return;
  }
  if (e.code === 'KeyJ' || e.code === 'KeyE') { e.preventDefault(); attack(); }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); dodge(); }
  if (e.code === 'KeyC') { e.preventDefault(); cycleCharacter(); }
  if (e.code === 'Backquote') { e.preventDefault(); document.body.classList.toggle('debug'); }
  if (e.code === 'KeyR') { e.preventDefault(); toggleCarry(); }
  if (e.code === 'KeyQ') { e.preventDefault(); if (combat) combat.toggleLock(); }
  if (e.code === 'Tab') { e.preventDefault(); if (combat) combat.cycleLock(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function moving() {
  return ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown',
          'ArrowLeft', 'ArrowRight'].some((k) => keys.has(k));
}

function playOnce(name, fade = 0.10) {
  if (!cur) return;
  const a = cur.clips[name];
  if (!a) return;
  a.reset().setEffectiveWeight(1).play();
  if (cur.current && cur.current !== a) a.crossFadeFrom(cur.current, fade, false);
  cur.current = a;
}

function jump() {
  if (!cur || !grounded) return;
  if (combat && combat.isStaggered()) return;
  // JUMP-CANCEL. A swing's recovery can be given up to jump -- which is what
  // turns the finisher's launch into a route rather than a thing you watch. It
  // refuses during the wind-up and the active frames, so committing to a swing
  // still costs you the swing.
  // ASK COMBAT, don't read the cached flag. `attacking` is refreshed once a
  // frame in updateCombat, so a jump pressed in the same tick as the swing that
  // started still saw the old value and sailed straight through the guard.
  if (combat && combat.isAttacking() && !combat.jumpCancel()) return;
  attacking = false;
  grounded = false;
  landing = false;
  vy = JUMP_V;
  playOnce('jump', 0.06);
}

/**
 * The slip. Direction is decided HERE and not in combat.js, because "left"
 * only means anything relative to the camera and the camera lives up here.
 *
 * With no input it goes backwards -- away from the lock target if there is one,
 * which is what you want when a Curler has committed to a line through you.
 */
function dodge() {
  if (!cur || !combat || !grounded || combat.isStaggered()) return;
  const spec = combat.dodge();
  if (!spec) return;

  let dx = 0, dz = 0;
  if (keys.has('KeyW') || keys.has('KeyS') || keys.has('KeyA') || keys.has('KeyD')) {
    const fx2 = -Math.sin(cam.az), fz2 = -Math.cos(cam.az);
    const rx = -fz2, rz = fx2;
    const iz = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const ix = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    dx = fx2 * iz + rx * ix;
    dz = fz2 * iz + rz * ix;
  }
  if (!dx && !dz) {
    const lt = combat.lockTarget;
    if (lt && !lt.dead) { dx = pos.x - lt.pos.x; dz = pos.z - lt.pos.z; }
    else { dx = -Math.sin(facing); dz = -Math.cos(facing); }
  }
  const len = Math.hypot(dx, dz) || 1;
  slip.x = dx / len; slip.z = dz / len;
  slip.t = spec.time; slip.total = spec.time; slip.dist = spec.dist;
  playOnce('dodge', 0.05);
}

function attack() {
  if (!cur || !combat || combat.isStaggered()) return;
  // PRESSING ATTACK WITH THE BLADE AWAY DRAWS IT AND SWINGS, on one press.
  // Making the player press R first would be a second thing to learn for no
  // reason -- nobody has ever wanted to draw a sword and then not use it.
  if (sheathed && !carry) { startCarry('hand', true); return; }
  if (carry) return;                 // mid draw or sheathe: the clip owns this
  // airborne presses run the falling cut instead of the ground chain
  const swung = combat.attack(!grounded);
  if (swung !== false) sfx.swing(!grounded);
}

// --------------------------------------------------------------- collision
//
// Everything is an oriented box in XZ with a height.  25 of them is few enough
// that brute force per frame costs nothing, and analytic boxes beat raycasting
// 94k triangles for both the player push-out and the camera.

function toLocal(b, x, z, out) {
  const dx = x - b.x, dz = z - b.z;
  out.x = dx * b.c - dz * b.s;      // rotate by -yaw
  out.z = dx * b.s + dz * b.c;
  return out;
}

const _l = { x: 0, z: 0 };

function pushOut(p, r, y = null) {
  for (const b of SOLIDS) {
    // A BOX ONLY BLOCKS YOU AT ITS OWN HEIGHT. Without this the cellar's walls
    // -- which sit entirely below the paving -- would fence off the middle of
    // the square for anyone walking over them.
    if (y !== null && (y > b.top + 0.2 || y + 1.7 < b.base)) continue;
    const l = toLocal(b, p.x, p.z, _l);
    const cx = Math.max(-b.hx, Math.min(b.hx, l.x));
    const cz = Math.max(-b.hz, Math.min(b.hz, l.z));
    let dx = l.x - cx, dz = l.z - cz;
    let d = Math.hypot(dx, dz);
    if (d >= r) continue;
    if (d < 1e-5) {
      // dead centre inside the box: escape along the shallowest axis
      const px = b.hx - Math.abs(l.x), pz = b.hz - Math.abs(l.z);
      if (px < pz) { dx = Math.sign(l.x) || 1; dz = 0; }
      else { dx = 0; dz = Math.sign(l.z) || 1; }
      d = 1;
    }
    const nx = (cx + (dx / d) * r), nz = (cz + (dz / d) * r);
    p.x = b.x + nx * b.c + nz * b.s;   // rotate by +yaw
    p.z = b.z - nx * b.s + nz * b.c;
  }
  return p;
}

/** Distance along `dir` to the nearest solid, capped at `maxD`. */
function rayCastSolids(ox, oy, oz, dx, dy, dz, maxD) {
  let best = maxD;
  for (const b of SOLIDS) {
    const l = toLocal(b, ox, oz, _l);
    const lox = l.x, loz = l.z;
    const ldx = dx * b.c - dz * b.s;
    const ldz = dx * b.s + dz * b.c;

    let t0 = 0, t1 = best;
    const slab = (o, d, lo, hi) => {
      if (Math.abs(d) < 1e-8) return o >= lo && o <= hi;
      let a = (lo - o) / d, bq = (hi - o) / d;
      if (a > bq) { const tmp = a; a = bq; bq = tmp; }
      if (a > t0) t0 = a;
      if (bq < t1) t1 = bq;
      return t1 >= t0;
    };
    if (!slab(lox, ldx, -b.hx, b.hx)) continue;
    if (!slab(loz, ldz, -b.hz, b.hz)) continue;
    if (!slab(oy, dy, b.base, b.top)) continue;
    if (t0 > 0 && t0 < best) best = t0;
  }
  return best;
}

/**
 * The nearest camera blocker along the boom. Ray-vs-sphere, no early exit,
 * because there are a few hundred of these and the test is eight multiplies.
 *
 * The ray starts at the look-at point, which is inside the player -- so a
 * sphere that CONTAINS the origin returns 0 and pins the camera on her
 * shoulder. That is the right answer: standing inside a canopy, the closest
 * the camera can get to a clear shot is right behind her head.
 */
function rayCastBlockers(ox, oy, oz, dx, dy, dz, maxD) {
  let best = maxD;
  for (const b of CAM_BLOCKERS) {
    const ex = b.x - ox, ey = b.y - oy, ez = b.z - oz;
    const proj = ex * dx + ey * dy + ez * dz;
    const d2 = ex * ex + ey * ey + ez * ez - proj * proj;
    const r2 = b.r * b.r;
    if (d2 > r2) continue;                      // the line misses it entirely
    const half = Math.sqrt(r2 - d2);
    const t = proj - half;
    if (t < best) best = Math.max(0, t);
  }
  return best;
}

// ----------------------------------------------------------------- foot IK
//
// The clips are joint ANGLES, which is what makes them portable between
// characters -- and is exactly why feet do not land.  The same contact pose
// that plants the hero's foot leaves Vesper's above the ground, because her
// legs are proportionally longer and her soles far thinner.  Authoring per
// character would fix the symptom and destroy the portability, so the fix
// belongs at runtime: solve each leg so the foot meets the floor it is
// standing on.
//
// Analytic two-bone IK (hip -> knee -> ankle).  Only the ankle HEIGHT is
// retargeted; x and z come from the animation, so the stride is untouched.

// A foot within IK_PLANT of the floor is CONTACT and is corrected fully; past
// IK_BAND it is genuinely swinging and is left alone.  Between the two the
// correction eases out, so nothing pops as the foot lifts.  A single linear
// fade from zero left contacts ~5 cm short, which still read as hovering.
const IK_PLANT = 0.055;
const IK_BAND = 0.17;
const IK_ENABLED = { value: true };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _t = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _o2 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion();
const _qi = new THREE.Quaternion(), _qt = new THREE.Quaternion();

// The prop riding hand.R, if this character carries one.  Matched on the node
// name the builders give it (`<Name>_Weapon`) and NOT on material, because the
// outline pass adds shell meshes that wear the weapon's materials and would
// match a material test twice.
//
// DO NOT TEST `isMesh` HERE.  The sword is three materials, so glTF stores it
// as three primitives, and GLTFLoader turns a multi-primitive node into a GROUP
// of meshes whose children carry generated names -- the only object wearing the
// name the builder chose is the group itself.  An isMesh test finds nothing at
// all, silently, on every character.  The group is also the right handle: it is
// the whole weapon, which is what `scene.attach` has to take to throw it.
function findWeapon(root) {
  let hit = null;
  root.traverse((o) => {
    if (!hit && /_weapon$/i.test(o.name || '')) hit = o;
  });
  return hit;
}

// ------------------------------------------------------------------ weapons
//
// THE BLADE INSIDE THE CHARACTER IS THE MOUNT, not the weapon.  It is already a
// child of hand.R carrying the local transform `props.place_in_hand` worked out
// in Blender -- a basis matrix, a slide up the bone, a wrist tweak -- so
// anything parented to it inherits a correct grip for free.  Reproducing that
// arithmetic here, in JavaScript, from Python, by hand, is exactly the joint
// this codebase keeps paying for (rule (a)), and it would fail silently: a
// sword held at a slightly wrong angle reads as a modelling mistake.
//
// So equipping swaps the CHILD and hides the built-in blade.  Weapon .glb files
// are exported already placed against a reference rig, so they drop in at
// identity.
const weaponCache = new Map();

function loadWeapon(id) {
  let p = weaponCache.get(id);
  if (p) return p;
  p = new GLTFLoader().loadAsync(`/assets/weapons/${id}.glb`).then((g) => {
    const meshes = [];
    g.scene.traverse((o) => { o.frustumCulled = false; if (o.isMesh) meshes.push(o); });
    for (const m of meshes) {
      const name = surfaceOf(m.material?.name);
      m.userData.matName = name;
      const color = m.material?.color?.clone() || new THREE.Color(0xffffff);
      m.material = surfaceMaterial(LOOK, color,
                                   { key: 'weapon:' + name, ...(CAST_LOOK[name] || {}) });
      m.material.transparent = true;
      m.material.opacity = 1;
      m.castShadow = true;
      m.receiveShadow = false;      // same reason a character does not: see above
    }
    for (const m of meshes) addOutline(m, 0.0028);
    return g.scene;
  }).catch((e) => {
    // A MISSING MODEL KEEPS THE BUILT-IN BLADE, because a character standing in
    // a fight with empty hands is a worse answer than the wrong sword.
    console.warn('[weapon] could not load', id, e.message || e);
    return null;
  });
  weaponCache.set(id, p);
  return p;
}

function builtInBlade(ch) {
  if (!ch._blade) {
    ch._blade = [];
    ch.weapon.traverse((o) => { if (o.isMesh) ch._blade.push(o); });
  }
  return ch._blade;
}

function setWeapon(ch, id) {
  if (!ch || !ch.weapon || ch.weaponId === id) return;
  ch.weaponId = id;
  if (!id) {
    for (const m of builtInBlade(ch)) m.visible = false;
    if (ch.mounted) { ch.weapon.remove(ch.mounted); ch.mounted = null; }
    return;
  }
  loadWeapon(id).then((root) => {
    // Equipping twice quickly resolves out of order; the id is the arbiter.
    if (!root || ch.weaponId !== id) return;
    if (ch.mounted) ch.weapon.remove(ch.mounted);
    // CLONE, because two characters can carry the same model and a node
    // belongs to one parent
    // HIDE FIRST, THEN MOUNT.  builtInBlade() is lazy and traverses
    // ch.weapon, so computing it after the new blade is parented captures the
    // new blade too -- and the next line then hides the weapon it just
    // mounted, leaving the character empty-handed with no error anywhere.
    const blade = builtInBlade(ch);
    ch.mounted = root.clone(true);
    ch.weapon.add(ch.mounted);
    for (const m of blade) m.visible = false;
    ch.mounted.traverse((o) => { o.visible = true; });
  });
}

/** The model id for whoever is active, or null for empty-handed. */
function equippedWeapon() {
  if (!window.GS || !GS.ok) return null;
  const me = GS.state.party.find((m) => m.active) || GS.state.party[0];
  const id = me && me.equip && me.equip.weapon;
  if (!id) return null;
  const def = GS.data?.items?.items?.[id];
  // items.json may name a model; otherwise the item id IS the model name, which
  // is why the three weapon files are called what the three items are called.
  return (def && def.model) || id;
}

function syncWeapon() {
  if (cur) setWeapon(cur, equippedWeapon());
}

// ---------------------------------------------------------------- carrying
//
// MANUAL, and not location-driven.  Sheathing on entering a "safe" area needs
// the game to have an opinion about where a fight can start, which it does not
// and should not: R puts it away, R takes it back, and pressing attack does
// both in one press.  Nothing here reads the world.
let sheathed = false;
let carry = null;         // the draw/sheathe in flight, or null
let HANDOFF = {};         // frame numbers, from the clip manifest

// The frames the weapon changes hands on are AUTHORED, not chosen here -- see
// anim_lib.HANDOFF.  Fetched rather than typed, because a number that lives in
// two languages is a number waiting to disagree.
fetch('/assets/clips.manifest.json').then((r) => r.json())
  .then((m) => { HANDOFF = m.handoff || {}; })
  .catch((e) => console.warn('[carry] no clip manifest', e.message || e));

// The draw is 34 frames but its pull is done by 16, and a full second of
// animation before a swing lands is a combat problem rather than a fidelity
// win.  So a queued attack fires on the pull, not at the end of the clip.
const DRAW_ATTACK_FRAME = 16;
const FPS = 24;

/** A bone's world matrix in the BIND pose -- the one animation cannot move. */
function bindMatrix(ch, bone) {
  if (!bone) return null;
  let skin = null;
  ch.group.traverse((o) => { if (!skin && o.isSkinnedMesh) skin = o; });
  if (!skin) return null;
  const i = skin.skeleton.bones.indexOf(bone);
  if (i < 0) return null;
  return new THREE.Matrix4().copy(skin.skeleton.boneInverses[i]).invert();
}

// Where a sheathed weapon rides, RELATIVE TO THE HIPS, and how it is tilted.
// +x is her left, +y up, +z forward. Worn on the left hip because the right
// hand draws it.
let SHEATH_AT = new THREE.Vector3(0.24, -0.02, -0.03);
// Tilt is applied ABOUT THE GRIP, not about the character's origin, and that
// distinction is the whole of why the first attempt failed. Composed as a
// plain offset the rotation pivots on the point between her feet, so 22
// degrees swings the blade through an enormous arc: it measured 0.43 m lower
// and 0.40 m further back than asked for, and the x-shift vanished into the
// same lever. Rotating about the grip is what "hang it on her hip at an angle"
// actually means.
// Positive X, and the sign was worth measuring rather than assuming. The blade
// hangs BELOW the grip, so a rotation about X sweeps it through -y: negative X
// carries the tip forward, which is the opposite of trailing.
let SHEATH_TILT = new THREE.Euler(0.34, 0.0, 0.34);

/**
 * The node a sheathed weapon hangs from, built once per character.
 *
 * A WEAPON'S VERTICES ARE IN THE CHARACTER'S REST SPACE -- that is what lets
 * the runtime own no grip maths -- so the hip node has to undo the hand
 * placement and redo it at the hip.  Doing that from CURRENT matrices would
 * bake in whichever frame of `idle` happened to be playing, and the sword would
 * sit a few millimetres differently every time it was put away.  Bind matrices
 * are the rest pose and animation cannot touch them.
 */
function sheathAnchor(ch) {
  if (ch._sheath) return ch._sheath;
  const hips = findBone(ch.group, 'hips');
  const hand = ch.hand;
  const bHips = bindMatrix(ch, hips);
  const bHand = bindMatrix(ch, hand);
  if (!hips || !bHips || !bHand) return null;
  // The grip sits at the hand, so the hand's bind position IS the pivot and
  // the thing being placed. Both come straight off the rig, so a taller
  // character wears the sword on their own hip rather than on Vesper's.
  const gripAt = new THREE.Vector3().setFromMatrixPosition(bHand);
  const hipsAt = new THREE.Vector3().setFromMatrixPosition(bHips);
  const target = hipsAt.clone().add(SHEATH_AT);

  //   world = hips.matrixWorld * local
  // and at rest we want the drawn placement, rotated about its own grip and
  // moved so that grip lands on the hip:
  //   world = T(target) * R(tilt) * T(-grip) * bind(hand) * T
  const place = new THREE.Matrix4()
    .makeTranslation(target.x, target.y, target.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(SHEATH_TILT))
    .multiply(new THREE.Matrix4().makeTranslation(-gripAt.x, -gripAt.y, -gripAt.z));
  const local = new THREE.Matrix4()
    .copy(bHips).invert()
    .multiply(place)
    .multiply(bHand)
    .multiply(ch.weapon.matrix);
  // The sanity check from the plan: on a 1.70 m character the hips bind near
  // y=0.9 and the hand near x=-0.3. If these are wildly off, the frame is
  // wrong and no amount of tuning SHEATH_AT will rescue it.
  console.log(`[carry] hips bind y=${hipsAt.y.toFixed(3)}, `
    + `grip x=${gripAt.x.toFixed(3)} y=${gripAt.y.toFixed(3)}`);
  const node = new THREE.Object3D();
  node.name = (ch.name || 'char') + '_Sheath';
  node.matrixAutoUpdate = false;
  node.matrix.copy(local);
  hips.add(node);
  ch._sheath = node;
  return node;
}

function moveWeapon(ch, to) {
  const target = to === 'hip' ? sheathAnchor(ch) : ch.weapon;
  if (!target || !ch.mounted) return;
  target.add(ch.mounted);
  // ADD, not attach: attach preserves the world transform, which is the exact
  // opposite of what snapping a sword onto a hip wants.
  ch.mounted.position.set(0, 0, 0);
  ch.mounted.quaternion.identity();
  ch.mounted.scale.set(1, 1, 1);
  sheathed = (to === 'hip');
}

function startCarry(to, thenAttack = false) {
  if (!cur || !cur.mounted || carry) return false;
  const name = to === 'hip' ? 'sheathe' : 'draw';
  if (!cur.clips[name]) return false;
  playOnce(name, 0.08);
  if (name === 'sheathe') sfx.sheathe(); else sfx.draw();
  carry = { name, to, thenAttack,
            at: (HANDOFF[name] || 0) / FPS,
            attackAt: DRAW_ATTACK_FRAME / FPS,
            moved: false, swung: false };
  return true;
}

/** Watch the clip's own clock and hand the weapon over on the authored frame. */
function stepCarry() {
  if (!carry || !cur) return;
  const a = cur.clips[carry.name];
  if (!a) { carry = null; return; }
  if (!carry.moved && a.time >= carry.at) {
    moveWeapon(cur, carry.to);
    carry.moved = true;
  }
  if (carry.thenAttack && !carry.swung && a.time >= carry.attackAt) {
    carry.swung = true;
    if (combat && !combat.isStaggered()) { combat.attack(!grounded); sfx.swing(!grounded); }
  }
  if (a.time >= (a.getClip().duration || 0) - 1e-3) carry = null;
}

function toggleCarry() {
  if (!cur || !cur.mounted || carry || attacking) return;
  if (combat && combat.isStaggered()) return;
  startCarry(sheathed ? 'hand' : 'hip');
}

function findBone(root, want) {
  let hit = null;
  root.traverse((o) => {
    if (!hit && o.isBone
        && o.name.replace(/[._\s]/g, '').toLowerCase() === want) hit = o;
  });
  return hit;
}

/** Rotate a bone by a world-space axis/angle, preserving its parent chain. */
function rotateWorld(bone, axis, angle) {
  if (!isFinite(angle) || Math.abs(angle) < 1e-6) return;
  _q.setFromAxisAngle(axis, angle);
  bone.parent.getWorldQuaternion(_qp);
  _qi.copy(_qp).invert();
  // world: q * (parent * local)  =>  local' = parent⁻¹ * q * parent * local
  _qt.copy(_qi).multiply(_q).multiply(_qp);
  bone.quaternion.premultiply(_qt);
  bone.updateMatrixWorld(true);
}

/** The knee's hinge in world space: bones are rolled so local X is flexion. */
function hingeAxis(leg, out) {
  return out.set(1, 0, 0).applyQuaternion(leg.thigh.getWorldQuaternion(_qt)).normalize();
}

function collectLegs(group) {
  group.updateMatrixWorld(true);
  const legs = [];
  for (const side of ['l', 'r']) {
    const thigh = findBone(group, 'thigh' + side);
    const shin = findBone(group, 'shin' + side);
    const foot = findBone(group, 'foot' + side);
    if (!thigh || !shin || !foot) continue;
    thigh.getWorldPosition(_a); shin.getWorldPosition(_b); foot.getWorldPosition(_c);
    const leg = {
      thigh, shin, foot,
      upper: _a.distanceTo(_b),
      lower: _b.distanceTo(_c),
      // how high the ankle rides above the sole when standing -- the hero's
      // chunky shoes put it at 12 cm, Vesper's thin boots at 4 cm
      sole: _c.y - group.position.y,
      hingeSign: 1,
    };

    // WHICH WAY DOES THIS KNEE BEND?  Measure it: bend the knee deliberately,
    // see which way the bend plane points relative to the hinge, put it back.
    // Derived per character rather than assumed, because the answer depends on
    // the rest pose the source mesh happened to arrive in.
    const keep = shin.quaternion.clone();
    shin.rotateX(-0.35);
    group.updateMatrixWorld(true);
    thigh.getWorldPosition(_a); shin.getWorldPosition(_b); foot.getWorldPosition(_c);
    _u.subVectors(_c, _a); _v.subVectors(_b, _a);
    _ax.crossVectors(_u, _v);
    hingeAxis(leg, _t);
    leg.hingeSign = _ax.dot(_t) < 0 ? -1 : 1;
    shin.quaternion.copy(keep);
    group.updateMatrixWorld(true);
    legs.push(leg);
  }
  return legs;
}

function solveLegIK(leg, target) {
  const eps = 1e-5;
  leg.thigh.getWorldPosition(_a);
  leg.shin.getWorldPosition(_b);
  leg.foot.getWorldPosition(_c);

  const lab = leg.upper, lcb = leg.lower;
  const lat = THREE.MathUtils.clamp(_a.distanceTo(target), eps, lab + lcb - eps);
  const cl = (x) => THREE.MathUtils.clamp(x, -1, 1);

  const ac0 = Math.acos(cl(_u.subVectors(_c, _a).normalize()
                           .dot(_v.subVectors(_b, _a).normalize())));
  const ba0 = Math.acos(cl(_u.subVectors(_a, _b).normalize()
                           .dot(_v.subVectors(_c, _b).normalize())));
  const ac1 = Math.acos(cl((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)));
  const ba1 = Math.acos(cl((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb)));

  // BEND PLANE: the plane the ANIMATION put the knee in.
  //
  // This matters more than it looks.  With this axis the solve is an exact
  // no-op when the target equals the current ankle -- lat equals |ac|, so the
  // triangle reproduces the current angles and every rotation is zero.  That
  // property is what lets the correction be faded to nothing safely.
  //
  // Forcing the knee's own hinge instead seems more principled (a knee IS a
  // hinge) and was tried: it relocates the knee into the hinge plane even when
  // no correction is needed, so fading out or skipping a frame snapped the knee
  // by tens of millimetres.  The axis only degenerates for a straight leg, and
  // a straight leg also has near-zero rotations, so the noise is multiplied by
  // nothing.  The hinge is kept purely as a fallback for the exact singularity.
  _u.subVectors(_c, _a); _v.subVectors(_b, _a);
  _ax.crossVectors(_u, _v);
  if (_ax.lengthSq() < 1e-12) hingeAxis(leg, _ax).multiplyScalar(leg.hingeSign);
  _ax.normalize();

  rotateWorld(leg.thigh, _ax, ac1 - ac0);
  rotateWorld(leg.shin, _ax, ba1 - ba0);

  // now swing the whole leg so the ankle lands on the target
  leg.thigh.getWorldPosition(_a);
  leg.foot.getWorldPosition(_c);
  _u.subVectors(_c, _a);
  _v.subVectors(target, _a);
  if (_u.lengthSq() < 1e-10 || _v.lengthSq() < 1e-10) return;
  _u.normalize(); _v.normalize();
  _ax.crossVectors(_u, _v);
  if (_ax.lengthSq() < 1e-10) return;
  rotateWorld(leg.thigh, _ax.normalize(), Math.acos(cl(_u.dot(_v))));
}

function applyFootIK(ch, dt) {
  // ...and not during a slip. The clip deliberately takes both feet off the
  // floor and drives; planting them back onto it flattens the whole pose into
  // a shuffle.
  if (!IK_ENABLED.value || !ch.legs || !grounded || slip.t > 0 || !FLOORS.length) return;
  ch.group.updateMatrixWorld(true);
  for (const leg of ch.legs) {
    leg.foot.getWorldPosition(_c);
    const g = groundAt(_c.x, _c.z, _c.y + 0.4);
    if (g === null) continue;
    let delta = (g + leg.sole) - _c.y;
    // below the floor -> always lift out.  above it -> pull down, fading to
    // nothing by IK_BAND so a swinging foot is never yanked at the ankle.
    let w = 1;
    if (delta < -IK_PLANT) {
      const k = (-delta - IK_PLANT) / (IK_BAND - IK_PLANT);   // 0..1 leaving contact
      w = k >= 1 ? 0 : 1 - k * k * (3 - 2 * k);               // smoothstep out
    }
    if (w <= 0.001) continue;

    // SOFT DEADZONE.  A standing character's leg is almost straight, so the
    // target sits 1-3 mm inside the leg's maximum reach -- and near full
    // extension the knee's sideways position goes as sqrt(slack).  A 1 mm
    // wobble from the idle breathing therefore swings the knee tens of
    // millimetres.  That is honest geometry, not a numerical fault, and it is
    // what made the legs flicker at rest.
    //
    // So corrections below a few millimetres are faded out.  It MUST be a ramp:
    // a hard "skip if small" test does the same job but discontinuously, and
    // snapped the knee ~25 mm every time it crossed the threshold.
    // The deadzone is WIDE on purpose.  A standing leg sits at ~99.7% extension,
    // where the knee's sideways position goes as sqrt(slack): correcting even a
    // 3 mm ground error there demands ~36 mm of knee swing, so chasing the last
    // few millimetres at rest is what made the legs flicker.  Idle errors run
    // 2-3 mm and are invisible; running contacts need 20-50 mm and still get the
    // full solve.
    const mag = Math.abs(delta * w);
    w *= THREE.MathUtils.smoothstep(mag, 0.006, 0.020);
    // safe to bail now: at w ~ 0 the solve is a no-op, so skipping and applying
    // agree, and there is no step to snap across
    if (w <= 1e-4) continue;
    _t.set(_c.x, _c.y + delta * w, _c.z);
    const reach = leg.upper + leg.lower;
    const need = _t.distanceTo(leg.thigh.getWorldPosition(_u));
    solveLegIK(leg, _t);
    if (globalThis.__ikTrace) {
      globalThis.__ikTrace.push({
        d: +(delta * 1000).toFixed(2), w: +w.toFixed(3),
        need: +need.toFixed(4), reach: +reach.toFixed(4),
        slack: +((reach - need) * 1000).toFixed(2),
      });
    }
  }
}


// ------------------------------------------------------------------- world

const pos = new THREE.Vector3(0, 0, 7);
// The hero is exported facing +Z, so facing = 0 means "+Z".  The camera starts
// at az = PI, which puts it on the -Z side -- i.e. BEHIND a hero facing +Z.
// Starting facing at PI instead had the camera staring him in the face.
let facing = 0;
// 4.6, not 3.0. The meadow is ninety metres deep and crossing it at a walking
// pace is most of the time you spend in the demo.
//
// The `run` clip was authored against 3.0 m/s, so raising this alone puts the
// feet a third out of step with the ground -- which is the same skating bug the
// enemies already had and `matchGait` already fixes for them. RUN_CYCLE is the
// speed the clip was drawn for, and the player's run action is rate-matched to
// the ratio.
const SPEED = 4.6;
const RUN_CYCLE = 3.0;
const CHAR_R = 0.38;
const STEP_MAX = 0.45;                    // stairs pass, a 1.1 m terrace does not
// g is well above 9.81: real gravity makes a 1 m jump hang for almost a second,
// which reads as floaty. 20 keeps the arc snappy and game-like.
const GRAVITY = 20.0;
const JUMP_V = 7.5;                       // ~1.41 m apex, ~0.75 s of air
const PLUNGE_V = 11.0;      // the falling cut beats gravity to the ground
const PLUNGE_FWD = 7.0;     // ...and travels, because the pose is a dive
const PLUNGE_TIME = 0.22;
// Tuned to just CLEAR the 1.1 m terrace: a jump that cannot reach the one
// ledge in the level is a button that does nothing.
let vy = 0;
let grounded = true;
let lastAirPhase = 'none';
let plungeT = 0;
const slip = { x: 0, z: 0, t: 0, total: 1, dist: 0 };
let lastHitEvent = 0;
let trail = null;
let trailLive = false;
let landing = false;

const groundRay = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();

function groundAt(x, z, fromY) {
  // PLATFORMS FIRST. The meadow answers "where is the floor" from a closed-form
  // terrain function rather than by raycasting -- which is what made it playable
  // -- but that function only knows about terrain, so anything standing on top
  // of it would be scenery you walk through. A handful of axis-aligned tops is
  // a point-in-box test, so this costs nothing next to the raycast it replaces.
  //
  // Highest top AT OR BELOW the query height wins, which is what lets you stand
  // on a shelf and also walk out from under one.
  let best = null;
  for (const p of PLATFORMS) {
    if (Math.abs(x - p.x) > p.hx || Math.abs(z - p.z) > p.hz) continue;
    if (p.top > fromY + 0.45) continue;         // it is above you, not under you
    if (best === null || p.top > best) best = p.top;
  }

  // Ask the terrain function where it owns the ground. Raycasting the meadow
  // heightfield instead was, on its own, the single largest cost in the frame.
  if (terrain && terrain.owns(x, z)) {
    const g = terrain.heightAt(x, z);
    return best !== null && best > g ? best : g;
  }
  if (best !== null) return best;
  if (!FLOORS.length) return 0;
  groundRay.set(_o.set(x, fromY + 2.0, z), DOWN);
  groundRay.far = 12;
  const hit = groundRay.intersectObjects(FLOORS, false)[0];
  return hit ? hit.point.y : null;
}

/** The interior volume the point is inside, with how far in it is (0..1).
 *
 * The blend used to be VERTICAL ONLY, which suited a twenty-metre stairwell and
 * nothing else: a room is 3 m tall and 9 m wide, so its transition happens as
 * you walk THROUGH THE DOOR -- sideways. Blending on the nearest face in any
 * axis handles both.
 *
 * `pad` is per-volume because a stairwell wants the player counted while she is
 * on the stair AROUND the well, and a room does not: there, the box is exactly
 * where she is.
 */
function volumeAt(x, y, z) {
  let best = null;
  for (const s of SHAFTS) {
    const pad = s.pad ?? 0;
    const m = Math.min(y - s.y0, s.y1 - y,
                       s.hx + pad - Math.abs(x - s.x),
                       s.hz + pad - Math.abs(z - s.z));
    if (m <= 0) continue;
    const k = Math.min(1, m / 0.8);        // about a stride to cross fully in
    if (!best || k > best.k) best = { s, k };
  }
  return best;
}

/** Try to move by (dx, dz).  Returns true if the hero actually moved. */
function tryMove(dx, dz) {
  const nx = pos.x + dx, nz = pos.z + dz;
  const p = { x: nx, z: nz };
  pushOut(p, CHAR_R, pos.y);
  const g = groundAt(p.x, p.z, pos.y);
  if (g === null) return false;                 // walked off the paving
  if (grounded) {
    if (g - pos.y > STEP_MAX) return false;     // too tall to step up
    pos.y = g;
  } else if (g > pos.y) {
    return false;                               // would end up inside a wall
  }
  pos.x = p.x; pos.z = p.z;
  return true;
}

// ------------------------------------------------------------------ camera

// POLAR 1.32, NOT 1.22. At 1.22 the camera looked 20 degrees down and half
// of every frame was paving; at 1.32 it is 14, a third more of the frame is
// facade and sky, the hills come into view on the road, and the ground still
// reads for a fight. Chosen from a three-way capture at four vantages.
const cam = { az: Math.PI, polar: 1.32, dist: 5.4, autoDelay: 0 };
// THE BOOM'S ACTUAL LENGTH, smoothed. See the note where it is applied.
let camBoom = 5.4;
// last frame's camera position, for the indoor ease. See where it is used.
const camPrev = new THREE.Vector3();
let camPrevOk = false;
const camTarget = new THREE.Vector3(0, 1.18, 7);
const camWant = new THREE.Vector3();
let dragging = false;

let pointerDownAt = 0, pointerDrag = 0;
canvas.addEventListener('pointerdown', (e) => sfx.unlock(), true);
addEventListener('pointerdown', (e) => {
  dragging = true; pointerDownAt = Date.now(); pointerDrag = 0;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false; canvas.releasePointerCapture(e.pointerId);
  // a click that did not turn into a drag is an attack
  if (Date.now() - pointerDownAt < 220 && pointerDrag < 6) attack();
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  pointerDrag += Math.abs(e.movementX) + Math.abs(e.movementY);
  cam.az -= e.movementX * 0.005;
  cam.polar = THREE.MathUtils.clamp(cam.polar - e.movementY * 0.004, 0.35, 1.48);
  cam.autoDelay = 1.6;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = THREE.MathUtils.clamp(cam.dist + e.deltaY * 0.006, 2.2, 12.0);
}, { passive: false });

// ------------------------------------------------------------------ combat

let combat = null;
let lastSwingStep = -1;

const hpFill = document.getElementById('hpfill');
const hpLag = document.getElementById('hplag');
const hpWrap = document.getElementById('hpwrap');
const reticle = document.getElementById('reticle');
const deadOverlay = document.getElementById('dead');

// ENCOUNTERS, not a spawner.
//
// A pen that refills forever is a test harness, not a place. These are sited
// along the route out of town so the fights escalate as you walk it, and each
// arms once when you get near it. The plaza one is the exception: it keeps
// refilling, because it is where the combat gets tuned.
// THE TOWN IS SAFE, and there are fewer of them everywhere else.
//
// There was a three-Nettle group standing in the plaza that refilled when you
// wiped it, so the square you spawn in -- shopfronts, awnings, a fountain,
// people's front doors -- was a permanent monster pen. A town reads as a town
// because nothing is trying to kill you in it; it is also the only place in the
// demo you can look at the architecture, which you cannot do while being
// swarmed. Combat starts past the gate now.
//
// The meadow groups are cut from 3-4 down to 2-3. With a swarmer at 62 HP and
// the finisher as the poise breaker, three Nettles plus a Bellow was long
// rather than hard -- the fight ran thirteen seconds and most of it was the
// third and fourth enemy waiting its turn behind the attack-token cap.
const ENCOUNTERS = [
  // sited ON the route -- the path runs x = -1 -> 2.9 -> 8.5 -> 13 as it climbs,
  // so these are what you walk into rather than what you'd have to go find
  // spaced further apart than they trigger, so you fight one group at a time --
  // overlapping them turned the hill into seventeen things at once, which is a
  // pile rather than an encounter
  { x: 3.0,  z: -32,  r: 5.5, trigger: 15,
    mix: ['nettle', 'nettle'] },
  { x: 6.0,  z: -54,  r: 6.5, trigger: 16,
    mix: ['curler', 'nettle'] },
  { x: 13.0, z: -74,  r: 6.5, trigger: 16,
    mix: ['curler', 'nettle'] },
  // CLEAR OF THE MONUMENT. This was at (24, -84) with an 8.5 m spread, which
  // put its members straight through the stone circle at (27, -82) -- and the
  // uprights are solid, so the Bellow spent every fight shouldered against a
  // standing stone, stuck in `approach`, unable to reach anyone. There is no
  // pathfinding here by design; an enemy walks at you, so an encounter has to
  // be sited where walking at you works.
  //
  // On the flank below the summit, so the climb to the circle is the reward
  // for winning rather than the arena for it.
  { x: 10.0, z: -88,  r: 5.0, trigger: 18,
    mix: ['bellow', 'nettle', 'nettle'] },
];

function startCombat() {
  trail = makeTrail(scene);
  scene.add(lockRing);
  scene.add(threatLine);
  scene.add(threatArc);
  scene.add(threatArcEdge);
  breakables = makeBreakables(scene, SOLIDS);
  combat = createCombat({
    scene,
    camera,
    world,
    groundAt,
    pushOut,
    /**
     * WHAT A KILL IS WORTH, read out of game/monsters.json rather than invented
     * here. The file is the single source: combat.js already fights a Nettle
     * with 40 HP and the data says a Nettle is worth 8 xp and 6 gold, so the
     * reward is proportional to something real. Rule (r) -- if the number were
     * written here as well it would be a second copy waiting to disagree.
     *
     * Silent when there is no save system, which is how the suite's combat
     * probes run: a fight that needs an economy loaded to resolve a death is a
     * fight with a new way to break.
     */
    /**
     * THE CHARACTER SHEET, AS THE FIGHT SEES IT.
     *
     * Returns null until a save exists, and combat.js treats null as "use the
     * hand-tuned numbers" -- which is what every probe in the suite runs on and
     * what the whole of TUNE was balanced against. At level 1 with the starting
     * gear it returns atk 8, which is ATK_BASE, so the multiplier is exactly 1
     * and nothing changes. The system only starts to bite once you have bought
     * something, which is the point.
     */
    power: () => {
      const G = window.GS;
      if (!G || !G.ok || !G.state) return null;
      const me = G.state.party.find((m) => m.active) || G.state.party[0];
      return me ? G.stats(me) : null;
    },
    onHit: (e, dmg, breaks, kill) => sfx.hit(breaks, kill),
    onHurt: () => sfx.hurt(),
    onKill: (species, e) => {
      const G = window.GS;
      if (!G || !G.ok || !G.data || !G.data.monsters) return;
      const m = G.data.monsters.monsters[species];
      if (!m) return;
      // XP IS IMMEDIATE, because it is not a thing -- it is the fight itself
      // paying out, and it belongs on the same frame as the kill.
      if (m.xp) { G.grantXp(m.xp); gain(`+${m.xp} XP`, 'xp'); }
      // the town hears about it: "you're the one who killed a bellow"
      if (flags) { flags.once('kill.first'); flags.once('kill.' + species); }
      // GOLD AND ITEMS ARE OBJECTS, and they come out of the body. The whole
      // point is that something visibly LEAVES the creature: the numbers used
      // to move silently inside the save and the player reported, correctly,
      // that nothing dropped.
      const from = e && e.pos
        ? e.pos.clone().setY(e.pos.y + (e.spec ? e.spec.height * 0.6 : 0.5))
        : pos.clone().setY(pos.y + 0.8);
      if (m.gold && drops) {
        drops.spawn('gold', from, `+${m.gold} g`, () => G.addGold(m.gold));
      } else if (m.gold) { G.addGold(m.gold); }
      for (const d of m.drops || []) {
        if (Math.random() >= (d.chance || 0)) continue;
        const def = G.data.items.items[d.item];
        const name = (def && def.name) || d.item;
        if (drops) drops.spawn((def && def.type) || 'material', from, name,
                               () => G.addItem(d.item, 1));
        else G.addItem(d.item, 1);
      }
    },
    /**
     * Is `p` hidden from the camera by world geometry?
     *
     * Used by the floating damage numbers, which are DOM elements with no depth
     * at all -- so a number for a hit that happened behind a building drew
     * cleanly on top of the building. Boxes only, which is all the town and the
     * meadow's props are, and cheap enough to ask once per number per frame.
     */
    occludes: (p) => {
      _o.subVectors(p, camera.position);
      const d = _o.length();
      if (d < 0.5) return false;
      _o.divideScalar(d);
      return rayCastSolids(camera.position.x, camera.position.y, camera.position.z,
                           _o.x, _o.y, _o.z, d - 0.35) < d - 0.35;
    },
    playerPos: () => pos,
    playerFacing: () => facing,
  });
  Promise.all(['nettle', 'curler', 'bellow', 'woolt', 'flitter'].map((n) => combat.load(n)))
    .then(() => {
      // NOTHING IS ARMED AT LOAD. This used to arm ENCOUNTERS[0] so the demo
      // had something to fight the moment it opened -- and ENCOUNTERS[0] was
      // the group standing in the plaza. With the town cleared, arming the
      // first entry now means the first meadow group is awake and waiting
      // before you have left the square, which is the same mistake pointed at
      // a different place. They arm when you walk near them, which is what the
      // trigger radius is for.
      seedHerds();
      console.log('[combat] ready:', Object.keys(SPECIES).join(', '));
    })
    .catch((err) => console.error('[combat] load failed', err));
}

// Grazers are not an encounter -- they are furniture that moves. They exist
// from the moment the meadow does, off to the sides of the route, so the field
// is inhabited whether or not you go looking for a fight.
// Ambient life is thinner too. The HUD counts every creature in the world as a
// "foe" and it was reading 48 -- most of them sheep and birds, none of them a
// threat, all of them contributing to "there are way too many enemies".
const HERDS = [
  { x: -9,  z: -38, n: 2 },
  { x: 21,  z: -58, n: 3 },
  { x: 34,  z: -92, n: 2 },
  // TWO IN THE WALLED YARD, which is what a walled yard is for. The yard has a
  // well, a trough and a woodpile and read as a room nobody uses; the animals
  // are the difference between a set and a place, and they are already built.
  { x: 26,  z: -3.25, n: 2, y: 1.2 },
  // IN THE SHEEPFOLD, for the same reason. The fold is sited to be looked at
  // from the spine's crest, 19 m off and 3 m below the eye -- an empty pen at
  // that distance is a rectangle of wall, and three animals in it are the only
  // thing that says what it IS. The yard runs x -30..-26.5, z -70..-80.
  { x: -28.4, z: -75.5, n: 3 },
];

// Flocks sit ON the route, unlike the herds -- you are meant to walk into them.
const FLOCKS = [
  // THE TOWN WAS A DEAD SET. All the ambient life was in the meadow, so a
  // reviewer's word for the plaza was "dead" and it was fair. Birds in a square
  // are the cheapest possible inhabitants, and they do something better than
  // decorate: a fight breaking out scatters them, so the plaza reacts to the
  // thing happening in it.
  { x: -4.5, z: 1.5,  n: 4 },
  { x: 6.5,  z: -6.0, n: 3 },
  { x: -2,  z: -24, n: 3 },
  { x: 6,   z: -44, n: 3 },
  { x: 16,  z: -86, n: 4 },
  // ROOSTING IN THE BELFRY, 20 m up. You climb the whole tower and something
  // is already living at the top of it -- and because a flock scatters when a
  // fight starts, the birds that leave the belfry are visible from the square.
  { x: -1,  z: 15.5, n: 3, y: 20.8 },
  // and on the roof route, so the leads have something on them
  { x: 7,   z: -15.0, n: 2, y: 9.0 },
];

function seedHerds() {
  for (const h of HERDS) {
    for (let i = 0; i < h.n; i++) {
      const a = (i / h.n) * Math.PI * 2 + h.x;
      combat.spawn('woolt', h.x + Math.cos(a) * 2.6, h.z + Math.sin(a) * 2.6, h.y);
    }
  }
  for (const f of FLOCKS) {
    for (let i = 0; i < f.n; i++) {
      // scattered, not ringed: a ring of birds reads as a summoning circle
      const a = i * 2.39962;                       // golden angle
      const r = 0.9 + 1.9 * Math.sqrt(i / f.n);
      combat.spawn('flitter', f.x + Math.cos(a) * r, f.z + Math.sin(a) * r, f.y);
    }
  }
}

function armEncounter(enc) {
  enc.spawned = [];
  enc.mix.forEach((species, i) => {
    const a = (i / enc.mix.length) * Math.PI * 2 + enc.z;
    const r = enc.r * (0.45 + 0.5 * ((i * 7 % 5) / 5));
    const e = combat.spawn(species, enc.x + Math.cos(a) * r, enc.z + Math.sin(a) * r);
    if (e) enc.spawned.push(e);
  });
  // ONLY ARMED IF IT ACTUALLY SPAWNED. `combat.spawn` returns null until that
  // species' GLB has finished loading, and this used to set `armed = true`
  // before finding out -- so walking straight to an encounter on a cold load
  // armed it with nothing, permanently. It never refills, because refilling is
  // what happens when an armed group is WIPED, and a group of zero is already
  // wiped. Silent, and it is exactly the sort of thing that only ever happens
  // to someone on a slow connection.
  enc.armed = enc.spawned.length === enc.mix.length;
}

// Test hook: stop encounters arming and refilling.
//
// The plaza group refills when it is wiped, which is right for play and wrong
// for a probe -- a check that clears the plaza to measure one enemy gets three
// more spawned on top of it, and now that being hit cancels your swing, that
// is enough to stop the probe landing a single hit.
let encountersFrozen = false;
globalThis.__freezeEncounters = (v) => { encountersFrozen = !!v; };
globalThis.__encounters = ENCOUNTERS;
// Test hook: put every encounter back exactly as it was at load.
//
// A dead enemy is spliced out of the roster 1.9 s later, so there is nothing
// left to revive -- and an encounter only refills when it is completely wiped.
// A suite whose kill tests each remove one Nettle from the plaza group
// therefore drifts: two checks downstream, "enemies cannot stand on the
// player" was measuring one enemy and "the leash brings them home" was
// measuring nought out of one, both about a game that was working.
globalThis.__respawnEncounters = () => {
  for (const e of combat.enemies) { e.dead = true; e.deadT = 99; e.group.visible = false; }
  for (const enc of ENCOUNTERS) { enc.armed = false; enc.spawned = []; }
  frame(1 / 60);                       // let the roster actually drop them
  for (const enc of ENCOUNTERS) armEncounter(enc);
  // AND THE AMBIENT LIFE. This re-armed the encounters and stopped, so a suite
  // that called it to get a deterministic roster deleted every grazer and bird
  // in the world on the way -- and then failed its own "all five species are
  // alive" check, about a game in which all five were fine.
  seedHerds();
  return combat.enemies.filter((e) => !e.dead).length;
};

function updateEncounters() {
  if (encountersFrozen) return;
  for (const enc of ENCOUNTERS) {
    const d = Math.hypot(pos.x - enc.x, pos.z - enc.z);
    if (!enc.armed && d < enc.trigger) armEncounter(enc);
    else if (enc.armed && enc.refill && d < enc.trigger
             && enc.spawned.every((e) => e.dead)) {
      armEncounter(enc);
    }
  }
}

function updateCombat(dt, raw) {
  if (!combat) return;
  combat.update(dt, raw);
  attacking = combat.isAttacking();

  // drive the player's clip from the swing state, and only on a CHANGE --
  // calling playOnce every frame would restart the clip every frame
  const step = combat.attackStep();
  if (step !== lastSwingStep) {
    lastSwingStep = step;
    if (step >= 0 && cur) {
      const clip = combat.attackClipFor(cur.clips, step);
      if (clip) playOnce(clip, 0.055);
    }
  }

  updateEncounters();

  // vitals
  const p = combat.player;
  const pct = Math.max(0, p.hp / p.maxHP) * 100;
  hpFill.style.width = `${pct}%`;
  hpLag.style.width = `${pct}%`;
  hpWrap.classList.toggle('low', pct <= 55 && pct > 25);
  hpWrap.classList.toggle('crit', pct <= 25);

  if (p.dead) {
    deadOverlay.classList.add('on');
    if (p.deadT > 2.0) {
      combat.respawn();
      pos.set(0.5, 0, 6.0);
      vy = 0; grounded = true;
      deadOverlay.classList.remove('on');
    }
  }

  // reticle
  //
  // The projected bracket alone was the wrong marker: it is a 2D overlay with
  // no depth, so a target standing behind the player put a lock indicator
  // squarely on the player's own back with nothing else marked. The RING is the
  // real indicator -- it is in the world, under the target's feet, and it
  // cannot land on anything but the thing it belongs to. The bracket stays as a
  // secondary read for a target you cannot see the ground of.
  const t = combat.lockTarget;
  if (t && !t.dead) {
    lockRing.visible = true;
    // 12 cm, not 3: the visible ground is a triangulated heightfield and the
    // enemy's y comes from the analytic surface, so a 3 cm lift got buried on
    // any slope and the ring simply never appeared
    lockRing.position.set(t.pos.x, t.pos.y + 0.12, t.pos.z);
    const r = Math.max(0.55, t.spec.radius * 1.55);
    lockRing.scale.set(r, r, r);
    // Y, not Z. The geometry is laid flat with rotateX(-PI/2), which leaves Z
    // lying IN the ring's plane -- spinning about it tumbled the ring end over
    // end out of the ground and rendered it as a half-buried crescent.
    lockRing.rotation.y += dt * 1.4;
    _o.copy(t.pos); _o.y += t.spec.height * 1.0;
    _o.project(camera);
    // ...and it hides when it would land on the player. A 2D bracket has no
    // depth, so a target directly behind the character drew a lock indicator on
    // the character's own back with nothing else marked -- the single worst
    // reading a lock marker can have. The ring in the world covers that case.
    _o2.copy(pos); _o2.y += 1.0;
    const behindPlayer = camera.position.distanceToSquared(t.pos)
                       > camera.position.distanceToSquared(pos);
    _o2.project(camera);
    const overlaps = behindPlayer
      && Math.abs(_o.x - _o2.x) < 0.10 && Math.abs(_o.y - _o2.y) < 0.16;
    reticle.style.display = (_o.z < 1 && !overlaps) ? 'block' : 'none';
    reticle.style.left = `${(_o.x * 0.5 + 0.5) * innerWidth}px`;
    reticle.style.top = `${(-_o.y * 0.5 + 0.5) * innerHeight}px`;
  } else {
    lockRing.visible = false;
    reticle.style.display = 'none';
  }
}

/** Camera shake, applied after the camera is placed so it never fights it. */
/**
 * A ring on the ground under whatever is locked.
 *
 * Flat, banded and slightly larger than the target's own radius, drawn face-up
 * with `depthWrite` off so it sits on uneven terrain without z-fighting but is
 * still occluded by anything genuinely in front of it.
 */
const lockRing = (() => {
  // FOUR ARCS, NOT A RING. The comment here used to claim "four bites out of
  // the ring so it reads as a bracket" over a complete RingGeometry, and the
  // spin was applied about Y -- the ring's own axis of symmetry, so a
  // geometrically invisible no-op. Both are now true: four 68-degree arcs with
  // gaps between them, and the spin is visible because there is something to
  // see move.
  const g = mergeArcs(4, 0.78, 1.0, THREE.MathUtils.degToRad(68));
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    color: 0xffd15a, transparent: true, opacity: 0.85,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 2;
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
})();

/**
 * The line a charger is about to run down.
 *
 * The Curler's puzzle is "step off the line", and once that actually worked the
 * next problem was that the line is invisible -- reading it meant watching
 * which way a 45-pixel blob was pointing. This is a flat wedge on the ground
 * from the enemy along its facing, shown only during the wind-up, in the
 * species' own accent colour. It is the one piece of UI in the build that is
 * IN the world rather than over it, which is also why it can be trusted: it is
 * occluded by what occludes it.
 */
const threatLine = (() => {
  const g = new THREE.PlaneGeometry(1, 1, 1, 1);
  // IT POINTS ALONG +Z, because that is where `rotation.y = facing` sends it.
  //
  // It used to be translated +0.5 and it pointed the other way: rotateX(-PI/2)
  // maps local +Y to -Z, so the lane was drawn a hundred and eighty degrees
  // from the direction the Curler was about to charge. Nothing caught it,
  // because every capture until now let the AI pick the facing and the enemy
  // was always coming at the camera anyway -- the error only shows when you
  // aim the enemy yourself and look at where the lane went.
  g.translate(0, -0.5, 0);         // pivot at the near edge
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    // 0x2ec8ff, not 0x63dcff: the paler cyan at 0.3 alpha was a wash you had
    // to hunt for on a beige path, which is exactly the ground the Curler
    // charges you across.
    color: 0x2ec8ff, transparent: true, opacity: 0.42,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 1;
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
})();

/**
 * The wedge a swinger is about to cover — the same idea as the charge line, but
 * an ARC rather than a lane, because a slam is an area and a charge is a path.
 *
 * Built as a circle sector so the shape itself carries the arc width: the
 * Bellow's 2.5 rad reads as most of a half-circle, the Nettle's 1.45 as a
 * narrow slice, and you can tell which you are standing in without being told.
 */
/**
 * A sector of `arc` radians, unit radius, its axis along local +Z.
 *
 * THE ANGLE IS IN THE GEOMETRY. The first version drew one half-disc and
 * narrowed it by scaling X -- which cannot narrow an angle: the extreme rays of
 * a half-disc lie on the local +/-X axis and stay at exactly +/-90 degrees under
 * any X scale. Measured off the mesh's own world vertices, the Nettle's true
 * cone is +/-41.5 degrees out to 1.90 m and the Bellow's +/-71.6 degrees out to
 * 2.85 m, while BOTH were painted at +/-90 degrees and, because the squash also
 * shortens every ray off the axis, only 1.14 m and 2.30 m respectively at the
 * cone's own edge. So the tell claimed safe ground along both edges of the real
 * cone -- a 0.55 m band on the Nettle and 0.76 m on the Bellow, and the Bellow
 * hits for a third of your health. It is the only "where will this land"
 * information in the game and it was wrong in the direction that kills you.
 *
 * One geometry per distinct arc, built once and reused.
 */
const SECTORS = new Map();
function sectorGeometry(arc) {
  const key = arc.toFixed(3);
  let g = SECTORS.get(key);
  if (!g) {
    g = new THREE.CircleGeometry(1, 30, Math.PI + (Math.PI - arc) / 2, arc);
    g.rotateX(-Math.PI / 2);
    SECTORS.set(key, g);
  }
  return g;
}

function sectorMesh(color) {
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.34,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(sectorGeometry(Math.PI), m);
  mesh.renderOrder = 1;
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}
const threatArc = sectorMesh(0xff8a3a);
// A DARK EDGE ROUND IT. The fill alone is a wash on grass -- a Nettle's pale
// gold at 0.2-0.5 alpha over pale-green meadow was not visible AT ALL in a
// capture taken 2.4 m from a winding-up Nettle. An outline survives any ground
// it is drawn on, which a tinted fill does not.
const threatArcEdge = (() => {
  const m = new THREE.LineBasicMaterial({
    color: 0x2a2028, transparent: true, opacity: 0.85, depthWrite: false,
  });
  const line = new THREE.LineLoop(new THREE.BufferGeometry(), m);
  line.renderOrder = 2;
  line.visible = false;
  line.frustumCulled = false;
  return line;
})();
const EDGES = new Map();
function sectorEdge(arc) {
  const key = arc.toFixed(3);
  let g = EDGES.get(key);
  if (!g) {
    const pts = [new THREE.Vector3(0, 0, 0)];
    for (let i = 0; i <= 30; i++) {
      const th = -arc / 2 + (arc * i) / 30;
      pts.push(new THREE.Vector3(Math.sin(th), 0, Math.cos(th)));
    }
    g = new THREE.BufferGeometry().setFromPoints(pts);
    EDGES.set(key, g);
  }
  return g;
}

function updateThreatLines(dt) {
  if (!combat) return;
  let shown = null, arced = null;
  for (const e of combat.enemies) {
    if (e.dead || e.state !== 'telegraph' || !e.group.visible) continue;
    if (e.spec.charge) { if (!shown) shown = e; }
    else if (!arced) arced = e;
  }

  // the swingers: the arc IS the cone -- same half-angle, same reach as the
  // test in combat.js's 'attack' case, so what is painted is what connects
  threatArc.visible = !!arced;
  threatArcEdge.visible = !!arced;
  if (arced) {
    const r = arced.spec.strikeRange + 0.35;
    const arc = arced.spec.hitArc ?? 1.7;
    const k = Math.min(1, arced.t / Math.max(0.05, arced.spec.telegraph));
    threatArc.geometry = sectorGeometry(arc);
    threatArcEdge.geometry = sectorEdge(arc);
    for (const m of [threatArc, threatArcEdge]) {
      m.position.set(arced.pos.x, arced.pos.y + 0.13, arced.pos.z);
      m.rotation.y = arced.facing;
      m.scale.set(r, 1, r);
    }
    threatArcEdge.position.y += 0.005;   // the edge sits on top of its own fill
    // 0.34 -> 0.62, because this is drawn on pale-green grass as often as on
    // beige path and the low value was invisible on both
    threatArc.material.opacity = 0.34 + 0.28 * k;
    threatArcEdge.material.opacity = 0.55 + 0.35 * k;
    // The Nettle's was 0xfff0b0 -- pale gold on pale green, which is the one
    // hue the meadow cannot show. Both accents are now saturated enough to sit
    // on grass, and the dark edge carries the shape wherever the fill does not.
    threatArc.material.color.set(arced.name === 'bellow' ? 0xff7a26 : 0xffd23f);
  }

  if (!shown) { threatLine.visible = false; return; }
  const reach = shown.spec.charge * shown.spec.attackTime * 0.62;
  threatLine.visible = true;
  // 0.14 for the same reason the lock ring needed it: the visible ground is
  // a triangulated heightfield and the enemy's y comes from the analytic
  // surface, so a low lift gets buried on any slope
  threatLine.position.set(shown.pos.x, shown.pos.y + 0.14, shown.pos.z);
  threatLine.rotation.y = shown.facing;
  threatLine.scale.set(shown.spec.radius * 2.1, 1, reach);
  // pulse with the wind-up, so it reads as a countdown and not as a decal
  const k = Math.min(1, shown.t / Math.max(0.05, shown.spec.telegraph));
  // it has to be seen from across a field on a beige path, so it starts
  // visible and grows -- 0.16 was invisible at the moment it mattered most
  threatLine.material.opacity = 0.40 + 0.38 * k;
}

/** Four evenly spaced ring segments, merged into one buffer geometry. */
function mergeArcs(n, inner, outer, sweep) {
  const pos = [], idx = [];
  const seg = 8;
  for (let a = 0; a < n; a++) {
    const base = (a / n) * Math.PI * 2 - sweep / 2;
    const v0 = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const th = base + (sweep * i) / seg;
      pos.push(Math.cos(th) * inner, Math.sin(th) * inner, 0);
      pos.push(Math.cos(th) * outer, Math.sin(th) * outer, 0);
    }
    for (let i = 0; i < seg; i++) {
      const k = v0 + i * 2;
      idx.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function applyShake() {
  if (!combat) return;
  const sh = combat.shake;
  if (sh.mag <= 0.0001 || sh.t <= 0) return;
  const k = sh.mag * Math.max(0, sh.t / 0.28);
  camera.position.x += (Math.random() - 0.5) * k;
  camera.position.y += (Math.random() - 0.5) * k;
  camera.position.z += (Math.random() - 0.5) * k;
}


// -------------------------------------------------------------------- step

const dir = new THREE.Vector3();

function step(dt) {
  dir.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) dir.z += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) dir.z -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) dir.x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) dir.x += 1;

  // A slip is a commitment: no steering it, and no adding walk speed to it.
  // Without this, holding a direction through one turned 3.6 m into 6 and let
  // you change your mind halfway, which is exactly what a dodge should not be.
  const staggered = combat && combat.isStaggered();
  const wants = dir.lengthSq() > 0 && !attacking && slip.t <= 0
    && !staggered && townReady;
  let isMoving = false;

  if (wants) {
    dir.normalize();
    // Movement is CAMERA-RELATIVE: "up" means away from the camera, always.
    //
    // right = forward x up.  With three's Y-up right-handed basis that works out
    // to (-fz, fx); the first version used (fz, -fx) -- the negation -- so A and
    // D were swapped.  Derive this, do not eyeball it.
    const fx = -Math.sin(cam.az), fz = -Math.cos(cam.az);
    const rx = -fz, rz = fx;
    const wx = fx * dir.z + rx * dir.x;
    const wz = fz * dir.z + rz * dir.x;
    const len = Math.hypot(wx, wz) || 1;
    const sx = (wx / len) * SPEED * dt, sz = (wz / len) * SPEED * dt;

    // full move, then each axis alone -- this is what lets the hero slide
    // along a wall instead of sticking to it the moment they touch one
    isMoving = tryMove(sx, sz) || tryMove(sx, 0) || tryMove(0, sz);

    // While LOCKED the character keeps facing the target and the stick just
    // moves them -- that is what makes circling a target feel like circling
    // rather than steering.
    const lt = combat && combat.lockTarget;
    const want = lt && !lt.dead
      ? Math.atan2(lt.pos.x - pos.x, lt.pos.z - pos.z)
      : Math.atan2(wx, wz);
    const d = ((want - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    facing += d * Math.min(1, dt * (lt ? 10 : 14));
  }

  // THE SWING CARRIES YOU, and steers onto the target.
  //
  // A three-hit chain moved the character 0.000 m, and movement is forbidden
  // while attacking, so a fight was walk in, plant, swing, walk in again with
  // no way to correct a miss. Each link now steps into its own strike; with a
  // lock target it also homes, which is what closes the gap between "the enemy
  // drifted 40 cm" and "the swing whiffs".
  {
    const adv = combat ? combat.swingAdvance() : 0;
    if (adv > 0) {
      let ax = Math.sin(facing), az2 = Math.cos(facing);
      // WHATEVER YOU ARE SWINGING AT, LOCKED OR NOT.
      //
      // The first version only stopped for `lockTarget`, so unlocked the step
      // ran blind: three links at 1.15/1.30/2.10 m/s walked the player about a
      // metre and a quarter PAST a stationary enemy, and every swing after the
      // second whiffed from behind it. The smoke suite caught this as "the
      // nettle does not die" -- it had 28 of 40 HP left after ten swings --
      // which is exactly the shape of bug that looks like a damage problem and
      // is actually a movement one.
      let tgt = combat.lockTarget && !combat.lockTarget.dead ? combat.lockTarget : null;
      if (!tgt) {
        let bd = 3.6;
        for (const e of combat.enemies) {
          if (e.dead || !e.spec.hostile) continue;
          const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.001 || d > bd) continue;
          if ((dx * ax + dz * az2) / d < 0.5) continue;   // outside +-60 degrees
          bd = d; tgt = e;
        }
      }
      if (tgt) {
        const dx = tgt.pos.x - pos.x, dz = tgt.pos.z - pos.z;
        const d = Math.hypot(dx, dz);
        // stop steering once you are already inside your own reach, or the
        // homing shoves you through the thing you are hitting
        if (d > 1.25) { ax = dx / d; az2 = dz / d; }
        else { ax = 0; az2 = 0; }
      }
      const k = adv * dt;
      if (ax || az2) tryMove(ax * k, az2 * k);
    }
  }

  // BEING HIT TAKES THE BODY AWAY FROM YOU for a third of a second, and throws
  // it. Without this the character eats a third of their health and keeps
  // swinging, which reads as the hit not having happened.
  if (combat && combat.isStaggered()) {
    slip.t = 0;
    const k = combat.player.knock;
    const f = 6.0 * dt;
    tryMove(k.x * f, k.z * f);
    k.multiplyScalar(Math.pow(0.02, dt));
  }
  if (combat && combat.player.hitEvent !== lastHitEvent) {
    lastHitEvent = combat.player.hitEvent;
    playOnce('hurt', 0.04);
  }

  // THE SLIP MOVES YOU. Eased so the speed is highest in the middle, which is
  // also where the i-frames are -- the fast part of the move and the safe part
  // of the move being the same part is what makes it readable.
  if (slip.t > 0) {
    const k0 = 1 - slip.t / slip.total;
    slip.t = Math.max(0, slip.t - dt);
    const k1 = 1 - slip.t / slip.total;
    const ease = (u) => u * u * (3 - 2 * u);
    const step = (ease(k1) - ease(k0)) * slip.dist;
    tryMove(slip.x * step, slip.z * step);
  }

  // ...and the falling cut carries FORWARD as well as down. The pose is a dive
  // -- body horizontal, legs trailing, blade leading -- and a dive that moves
  // straight down reads as a belly-flop. Motion has to agree with the drawing.
  if (plungeT > 0) {
    plungeT -= dt;
    const k = PLUNGE_FWD * dt;
    tryMove(Math.sin(facing) * k, Math.cos(facing) * k);
  }

  // How far off the player->target line the boom sits, and how high it rides
// while locked. Swept against the measured NDC separation between target and
// player at 2.2 m, which is the range melee actually happens at:
//   0.00 rad -> the target is AT the player's screen position. This was the
//               shipped behaviour: locked on at 2.18 m, the enemy projected to
//               (0.02, -0.09) and all you could see of it was one spike past
//               her shoulder.
//   0.30 rad -> 0.16 -- clear of her centre, still tucked at her shoulder
//   0.55 rad -> 0.19, and in the capture the enemy is plainly beside her with
//               the bracket over it. 
// Polar 1.06 rather than 1.16 rides the camera higher so the pair separate
// vertically as well, which is what keeps them apart when the target is
// directly up-slope.
const LOCK_YAW_OFF = 0.55;
const LOCK_POLAR = 1.06;

// face the target even while standing still, and while swinging
  {
    const lt = combat && combat.lockTarget;
    if (lt && !lt.dead) {
      const want = Math.atan2(lt.pos.x - pos.x, lt.pos.z - pos.z);
      const d = ((want - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      facing += d * Math.min(1, dt * 9);
    }
  }

  // vertical: integrate, then land when we cross the floor going down
  if (!grounded) {
    // THE HANG. During the falling cut's wind-up the character is gathering,
    // and gravity is scaled almost to nothing so the pose has a moment to
    // read. Without it the tuck goes by while you are already falling and the
    // whole move looks like a twitch.
    const airSwing = combat && combat.isAirSwing();
    const phase = airSwing ? combat.attackPhase() : 'none';
    const hanging = phase === 'windup';
    vy -= GRAVITY * (hanging ? 0.10 : airSwing ? 1.45 : 1.0) * dt;

    // THE DRIVE. The moment the blade goes live, the character stops obeying
    // whatever the jump was doing and goes DOWN, hard. Without this you could
    // press attack on the way up and watch a downward plunge animation play
    // while rising, which is the kind of thing that reads as broken instantly.
    if (phase === 'active' && lastAirPhase !== 'active') {
      vy = -PLUNGE_V;
      plungeT = PLUNGE_TIME;
    }
    lastAirPhase = phase;

    // ...and the drive is FASTER than a fall, because it is a drive
    const kick = combat ? combat.takePogo() : 0;
    if (kick) {
      // POGO: hitting something on the way down throws you back up, which is
      // what turns the finisher's launch into a juggle instead of a one-off.
      vy = kick;
      playOnce('jump', 0.05);
    }

    pos.y += vy * dt;
    const g = groundAt(pos.x, pos.z, pos.y + 1.2);
    if (g !== null && vy <= 0 && pos.y <= g) {
      pos.y = g;
      sfx.land(vy < -9);
      vy = 0;
      grounded = true;
      landing = true;
      if (combat) combat.landed();     // the juggle's diminishing return resets
      playOnce('land', 0.05);
    }
  } else {
    // landing mid-swing would otherwise leave the edge detector latched and
    // the NEXT falling cut would never drive
    lastAirPhase = 'none';
    plungeT = 0;
  }

  if (cur) { cur.group.position.copy(pos); cur.group.rotation.y = facing; }

  // locomotion only reclaims the body once we are grounded and done landing --
  // AND once a draw or sheathe has finished. Without `!carry` the idle clip
  // crossfaded straight back over the sheathe and three.js stopped it dead at
  // 0.23 s, so the handoff frame at 0.625 s never arrived and the sword simply
  // stayed in her hand. Nothing errored: the state machine sat there holding a
  // clip that was no longer running.
  if (cur && !attacking && !carry && grounded && !landing && slip.t <= 0
      && !staggered && !(interact && interact.busy)) {
    play(isMoving ? 'run' : 'idle');
  }

  // camera
  cam.autoDelay = Math.max(0, cam.autoDelay - dt);
  // the title card turns slowly round the hero: a demo that opens on a
  // static frame opens on a screenshot
  if (document.body.classList.contains('title')) cam.az += dt * 0.09;
  const lock = combat && combat.lockTarget;
  if (lock && !lock.dead) {
    // BEHIND, BUT OFF THE LINE.
    //
    // This used to sit exactly on the player->target line, which is precisely
    // the axis along which the target is hidden by the player's own body.
    // Measured with one enemy at 2.18 m: locked on, it projected to NDC
    // (0.02, -0.09) -- dead centre, which is also where the player is -- and
    // all you could see of it was one spike past her shoulder. The core
    // targeting mechanic framed her back.
    //
    // A fixed 17-degree yaw offset puts the target clear of her silhouette at
    // melee range and stays put as the distance changes, because what has to
    // clear is her angular width from the CAMERA, which does not depend on how
    // far away the target is. The sign is fixed rather than chosen per frame:
    // picking the nearer side flips the camera through the player every time
    // you cross the line, which is worse than either side.
    const dx = lock.pos.x - pos.x, dz = lock.pos.z - pos.z;
    const want = Math.atan2(-dx, -dz) + LOCK_YAW_OFF;
    const d = ((want - cam.az + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    cam.az += d * Math.min(1, dt * 3.4);
    cam.polar += (LOCK_POLAR - cam.polar) * Math.min(1, dt * 2.4);
  } else if (isMoving && cam.autoDelay === 0) {
    const want = facing + Math.PI;
    const d = ((want - cam.az + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    cam.az += d * Math.min(1, dt * 1.3);
  }
  // bias the look-at toward the target so the enemy is not shoved off-screen
  // 0.30, not 0.22: with the boom off-axis the look-at has to carry more of
  // the framing, or the pair drifts to the edge of frame together.
  const bx = lock && !lock.dead ? (lock.pos.x - pos.x) * 0.30 : 0;
  const bz = lock && !lock.dead ? (lock.pos.z - pos.z) * 0.30 : 0;
  camTarget.lerp(_o.set(pos.x + bx, pos.y + 1.18, pos.z + bz), Math.min(1, dt * 9));

  const sp = Math.sin(cam.polar);
  camWant.set(Math.sin(cam.az) * sp, Math.cos(cam.polar), Math.cos(cam.az) * sp);
  // CAMERA COLLISION: pull in short of anything solid.  Without it the camera
  // walks into a facade and the screen fills with the inside of a wall -- which
  // in a town, unlike an open field, happens constantly.
  let hitD = rayCastSolids(camTarget.x, camTarget.y, camTarget.z,
                           camWant.x, camWant.y, camWant.z, cam.dist);
  hitD = rayCastBlockers(camTarget.x, camTarget.y, camTarget.z,
                         camWant.x, camWant.y, camWant.z, hitD);
  // THE GROUND LIFTS THE BOOM; IT DOES NOT SHORTEN IT.
  //
  // Solids are boxes and the meadow is a height field, so nothing above stopped
  // the boom being swung into a hillside. Standing below the landmark hill with
  // the camera downhill, the frame filled with the underside of the slope and
  // the player was not in it.
  //
  // Shortening the boom -- the obvious fix, and the one tried first -- is
  // WRONG here: on a slope the ground blocks the boom immediately, so the
  // distance collapses to its floor and the camera ends up inside the hill
  // instead of behind it. A hillside is not an obstacle to squeeze past, it is
  // a floor to climb, so the boom PITCHES UP until it clears and keeps its
  // length. That is also what it looks like from the player's side: walk into
  // a valley and the camera rises to look down at you.
  //
  // Eight samples along the boom, because this runs every frame and the ground
  // query is analytic.
  let lift = camWant.y;
  for (let i = 1; i <= 8; i++) {
    const t = (hitD * i) / 8;
    if (t < 0.2) continue;
    const sx = camTarget.x + camWant.x * t, sz = camTarget.z + camWant.z * t;
    const g = groundAt(sx, sz, camTarget.y + camWant.y * t + 3.0);
    if (g === null) continue;
    // A CEILING IS NOT A HILL. Underground -- in the cellar, under the gallery
    // -- the nearest "ground" above a boom sample is the paving over your head,
    // and lifting toward it drives the camera into the underside of the square.
    // Anything above the player's own head is something you are INSIDE, and the
    // answer there is to pull in, which the blocker sweep below already does.
    //
    // ...BUT A HEIGHTFIELD IS NEVER A CEILING. The meadow's ground is a
    // function of x and z with exactly one value, so it cannot be over your
    // head -- and this test was disabling the lift entirely in any pit deeper
    // than 0.6 m, which is every pit there is. Standing in the ravine bed the
    // walls rise 4.9 m and were all being read as ceiling, so the boom never
    // rose, and the near wall filled a third of the frame with the unlit inside
    // of the hillside. The dell had it too. The rule was written for the cellar
    // and the cellar is not terrain.
    if (g > camTarget.y + 0.6 && !(terrain && terrain.owns(sx, sz))) continue;
    // the y-component this boom would need for THIS sample to clear the ground
    lift = Math.max(lift, (g + 0.45 - camTarget.y) / t);
  }
  // 0.80 is about 53 degrees. Lifting further does clear more terrain, but at
  // 70 degrees it is a top-down camera and the player loses their own heading,
  // which is worse than seeing a hill -- standing on the outcrop with the
  // landmark right behind it, the cap was reached and the shot became a map.
  lift = Math.min(lift, 0.80);
  if (lift > camWant.y) {
    const flat = Math.hypot(camWant.x, camWant.z) || 1;
    const k = Math.sqrt(Math.max(0, 1 - lift * lift)) / flat;
    camWant.set(camWant.x * k, lift, camWant.z * k);
  }
  // ...and if the lifted boom STILL runs into the hill -- a rise close and
  // steep enough that no reasonable pitch clears it -- then shorten, which is
  // the right answer once pitching has been tried and failed. Its own floor is
  // 2.2 m rather than the solids' 0.45 m: pressed against a facade the camera
  // is meant to end up almost on the player's shoulder, but a hillside should
  // never pull it closer than a normal over-the-shoulder distance.
  let groundD = cam.dist;
  for (let i = 1; i <= 8; i++) {
    const t = (hitD * i) / 8;
    if (t < 0.2) continue;
    const sx = camTarget.x + camWant.x * t, sz = camTarget.z + camWant.z * t;
    const g = groundAt(sx, sz, camTarget.y + camWant.y * t + 3.0);
    if (g !== null && (g <= camTarget.y + 0.6 || (terrain && terrain.owns(sx, sz)))
        && camTarget.y + camWant.y * t < g + 0.35) {
      groundD = Math.max(2.2, (hitD * (i - 1)) / 8);
      break;
    }
  }
  // The floor has to be SMALL.  An alley is 1.75 m wide, so a camera shoved
  // sideways has under 0.9 m before it is inside a facade; a 1.1 m minimum put
  // it through the wall and filled the screen with outline colour.
  //
  // SHORTEN AT ONCE, LENGTHEN SLOWLY -- and this is the whole of what made the
  // camera feel rough indoors.
  //
  // The solve above returns a length for THIS frame and it used to be applied
  // as-is, so the moment a boom stopped hitting something the camera teleported
  // out to full extension. Measured by dragging the camera through one slow
  // revolution and recording the largest single-frame change: 0.00 m standing
  // in the plaza, 2.24 m in the cellar, 3.53 m in the shop, and 6.30 m in the
  // belfry -- where rotating past a pier hands the ray open sky. Between 4% and
  // 11% of frames moved the camera more than a quarter of a metre.
  //
  // Shortening has to stay instant: a boom that eases INTO its new length is a
  // boom that spends those frames inside a wall. Lengthening does not -- there
  // is nothing to collide with on the way out -- so it eases, and the lunge
  // goes away without the clipping coming back.
  const want = Math.max(0.45, Math.min(hitD, groundD) - 0.25);
  camBoom = want < camBoom ? want
                           : camBoom + (want - camBoom) * Math.min(1, dt * 3.2);
  const d = camBoom;
  camera.position.copy(camTarget).addScaledVector(camWant, d);

  // A STAIRWELL IS THE ONE SHAPE THIS SOLVE CANNOT DO.
  //
  // Everything above finds air by pulling in or pitching up, and both assume
  // air exists somewhere behind the player. On a spiral stair it does not: the
  // flight she is on runs along a wall, so whichever way she faces there is
  // masonry 60 cm behind her back. Measured in the belltower, the boom
  // collapsed to 0.45-1.9 m at every point on the climb, which renders as a
  // full-frame close-up of her shoulders -- and widening the tower from 5.2 m
  // to 6.6 changed almost nothing, because in a CORNER, which a spiral puts you
  // in every few seconds, two walls close at once.
  //
  // The well down the middle is the exception, and it is not a heuristic: a
  // stair well is empty by definition, for the shaft's whole height. So rather
  // than hunt for air, put the camera in the volume the builder has PROMISED is
  // clear. The boom keeps the length and pitch the player chose; only its
  // horizontal position is confined, so turning the camera still turns it.
  // BLENDED, because the two solves put the camera in genuinely different
  // places and swapping between them on one frame is a cut.
  const vol = volumeAt(camTarget.x, camTarget.y, camTarget.z);
  if (vol) {
    const shaft = vol.s, k = vol.k;
    {
      _o.copy(camTarget).addScaledVector(camWant, Math.max(camBoom, cam.dist * 0.55));
      _o.x = THREE.MathUtils.clamp(_o.x, shaft.x - shaft.hx, shaft.x + shaft.hx);
      _o.z = THREE.MathUtils.clamp(_o.z, shaft.z - shaft.hz, shaft.z + shaft.hz);
      // never below the tread she is standing on, and never so far above it
      // that the shot becomes a floor plan: confining the boom horizontally
      // shortens it without shortening its RISE, so an ordinary 45-degree
      // camera came out at 64 and the climb was viewed from directly overhead.
      // Capped against the horizontal distance that survived the clamp.
      const horiz = Math.hypot(_o.x - camTarget.x, _o.z - camTarget.z);
      _o.y = THREE.MathUtils.clamp(_o.y, camTarget.y - 0.30,
                                   camTarget.y + 1.15 * horiz + 0.35);
      // AND UNDER THE VOLUME'S OWN CEILING. `y1` was being used to decide
      // whether the player is in the volume and then never applied to the
      // camera, so in the belfry the pitch cap let the boom climb to 23.98 m
      // against a roof that starts at 22.48 -- the whole frame came back flat
      // outline colour, twice, and I blamed the corner piers the first time.
      _o.y = Math.min(_o.y, shaft.y1);
      camera.position.lerp(_o, k);
      // AND EASE OVER TIME, which is only safe in here. Clamping into a box
      // makes the camera slide along an edge, and near a CORNER a small turn
      // moves it fast: measured in the shop's back corner, one frame of
      // rotation walked it 1.06 m while the middle of the same room managed
      // 0.42. Outdoors this would be unsafe -- a camera that lags its solve is
      // a camera inside a wall for those frames -- but the builder has promised
      // this volume is empty, so there is nothing to lag into.
      if (camPrevOk) camera.position.lerp(camPrev, Math.exp(-13 * dt) * k);
    }
  }

  // ...which means the camera now sometimes sits inside the hero.  Fade them
  // out rather than showing the inside of their head.  This is the cheap fix:
  // the real one is a corridor-aware camera that yaws to look ALONG an alley
  // instead of being pressed into its wall.
  //
  // MEASURED FROM WHERE THE CAMERA ENDED UP, not from the boom length the solve
  // asked for. Those were the same number until the shaft confinement started
  // moving the camera afterwards, and then they were not: in the belltower the
  // solve wanted 0.45 m, the camera actually sat 2.5 m away across the well,
  // and the hero was faded to nothing in a shot framed perfectly well on her.
  const fade = THREE.MathUtils.clamp(
    (camera.position.distanceTo(camTarget) - 0.75) / 0.85, 0, 1);
  if (cur) for (const m of cur.mats) { m.opacity = fade; m.visible = fade > 0.02; }

  camPrev.copy(camera.position);
  camPrevOk = true;

  const camGround = groundAt(camera.position.x, camera.position.z, camera.position.y);
  if (camGround !== null && camGround <= camTarget.y + 0.6
      && camera.position.y < camGround + 0.35) {
    camera.position.y = camGround + 0.35;
  }
  camera.lookAt(camTarget);
  applyShake();

  // SNAP THE SHADOW CAMERA TO ITS OWN TEXEL GRID.
  //
  // The light follows the player so a 32 m shadow frustum can cover a 200 m
  // world. Following CONTINUOUSLY means every texel's world position drifts a
  // fraction each frame, so the depth comparison flickers in and out of
  // tolerance along grazing surfaces -- a herringbone speckle across the gate
  // pillars that crawls as you walk, and reads exactly like a broken renderer.
  //
  // Moving in whole-texel steps makes the sampling stable: the shadow map is
  // the same map shifted by an integer, not a slightly different projection.
  const SPAN = 32;                       // left..right of the shadow frustum
  const texel = SPAN / key.shadow.mapSize.x;
  const sx = Math.round(pos.x / texel) * texel;
  const sz = Math.round(pos.z / texel) * texel;
  const sy = Math.round(pos.y / texel) * texel;
  key.position.set(sx + KEY_OFFSET.x, sy + KEY_OFFSET.y, sz + KEY_OFFSET.z);
  key.target.position.set(sx, sy, sz);
  key.target.updateMatrixWorld();

  return isMoving;
}

// --------------------------------------------------------------------- loop

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  // the composer's targets are sized in device pixels, same as the canvas
  const pr = renderer.getPixelRatio();
  const w = Math.round(innerWidth * pr), h = Math.round(innerHeight * pr);
  if (!post) post = makePost({ renderer, scene, camera, width: w, height: h });
  else post.resize(w, h);
}
addEventListener('resize', resize);
resize();

const hud = document.getElementById('hud');
const clock = new THREE.Clock();
let acc = 0, frames = 0, fps = 0;

// THE BLADE'S PATH, sampled from the weapon hand rather than from the body.
//
// The sword is joined into the character mesh at build time and rigged to
// `hand.R`, whose local +Y runs down the blade (props.place_in_hand maps the
// canonical blade axis onto it). So the guard is the bone's origin and the tip
// is that origin plus its +Y axis times the blade length -- no separate object
// to find, and it survives every clip because it IS the rig.
// The ribbon spans the OUTER part of the blade, not hand-to-tip. Hand-to-tip is
// a metre wide and the first pass read as a flag being waved rather than a
// sword being swung -- the part of a blade that leaves a mark is the fast end.
const BLADE_NEAR = 0.34;
const BLADE_FAR = 0.72;
const _tg = new THREE.Vector3(), _tt = new THREE.Vector3();
const _tm = new THREE.Matrix4();

function updateTrail(dt) {
  if (!trail) return;
  // ONLY the active window. Including the wind-up drew the arc of the load as
  // well as the arc of the strike, which is most of a circle and reads as a
  // sheet rather than a slash.
  const swinging = combat && combat.isAttacking()
    && combat.attackPhase() === 'active';
  if (swinging && !trailLive) { trail.start(); trailLive = true; }
  if (!swinging && trailLive) { trail.stop(); trailLive = false; }

  if (swinging && cur && cur.hand) {
    cur.hand.updateWorldMatrix(true, false);
    _tm.copy(cur.hand.matrixWorld);
    _tg.setFromMatrixPosition(_tm);
    _tt.set(_tm.elements[4], _tm.elements[5], _tm.elements[6])   // local +Y
      .normalize();
    trail.sample(_tt.clone().multiplyScalar(BLADE_NEAR).add(_tg),
                 _tt.clone().multiplyScalar(BLADE_FAR).add(_tg));
  }
  trail.update(dt);
}

// THE SWING SMASHES PROPS, using the same reach the enemy hitbox uses.
//
// Once per active window, not once per frame: `smashedThisSwing` is the same
// idea as combat's `hitThisSwing`, and without it a barrel is hit four times in
// four frames and throws thirty-six chunks.
let smashedThisSwing = false;
const _sd = new THREE.Vector3();
/** Swing the things that have been set swinging. */
function updateMovers(dt) {
  for (const m of MOVERS) {
    if (!m.obj || m.t < 0) continue;
    m.t += dt;
    if (m.name === 'chest') {
      // ONE-SHOT, AND IT STAYS. A lid that comes up over half a second and
      // then snaps shut on the ring timer would be a bell, not a chest. It
      // eases out hard and parks at the top, and `hold` keeps the reset below
      // from ever putting it back.
      const a = Math.min(1, m.t / 0.55);
      const ang = -(1 - Math.pow(1 - a, 3)) * 1.85;
      _mm.makeTranslation(m.x, m.y, m.z)
         .multiply(_mr.makeRotationX(ang))
         .multiply(new THREE.Matrix4().makeTranslation(-m.x, -m.y, -m.z));
      m.obj.matrix.copy(_mm);
      m.obj.matrixWorldNeedsUpdate = true;
      if (a >= 1) m.hold = true;
      continue;
    }
    if (m.t >= RING_T) {
      if (m.hold) continue;
      m.t = -1;
      m.obj.matrix.identity();
      m.obj.matrixWorldNeedsUpdate = true;
      continue;
    }
    // Decaying as the SQUARE of the remaining time, not linearly: a bell rings
    // hard and then hangs about, and a linear fade reads as somebody slowing it
    // down with their hand.
    const k = 1 - m.t / RING_T;
    const w = Math.sin(m.t * 6.6) * k * k;
    if (m.name === 'rope') {
      // THE ROPE IS WHAT YOU ACTUALLY SEE. You ring from the ground room and
      // the bell is twenty metres over your head inside the belfry, so nothing
      // about the bell is observable from where you swing. The rope is in front
      // of your face and runs the whole height of the shaft.
      //
      // It RISES AND FALLS rather than swinging, because that is what a bell
      // rope does -- the wheel takes it up as the bell goes over -- with a
      // little sway on a slower beat so it is not a piston.
      // UP ONLY, NEVER DOWN. A symmetric bob pulls the rope's top DOWN off the
      // eye it hangs from for half of every cycle, which opens a 0.4 m gap
      // between the ceiling and the rope. Raised it just slides up through the
      // hole, which is where a bell rope goes.
      const rise = (1 - Math.cos(m.t * 6.6)) * 0.5 * k * k;
      _mm.makeTranslation(Math.sin(m.t * 3.1) * 0.05 * k * k,
                          rise * 0.40, Math.cos(m.t * 2.7) * 0.05 * k * k);
    } else {
      // ABOUT THE BEAM'S OWN AXIS. The headstock runs along x, so a bell swings
      // in the z-y plane -- rotate about x and it rocks the way a bell rocks
      // rather than spinning like a carousel.
      _mm.makeTranslation(m.x, m.y, m.z)
         .multiply(_mr.makeRotationX(w * 0.60))
         .multiply(new THREE.Matrix4().makeTranslation(-m.x, -m.y, -m.z));
    }
    m.obj.matrix.copy(_mm);
    m.obj.matrixWorldNeedsUpdate = true;
  }
}

// ------------------------------------------------------------- the world
//
// PLACES WORTH HAVING BEEN. Standing in one sets `seen.<id>` for good, and
// that is what lets a townsperson say "you've been up the tower, then" --
// which is the whole difference between people and signposts. Radii are
// generous: this is "you were there", not a hit-box.
const ZONES = [
  { id: 'belfry',  x: -1.0, z: 16.6,  r: 3.5, y0: 17 },
  { id: 'cellar',  x: -8.7, z: -4.6,  r: 4.0, y1: -0.5 },
  { id: 'roofs',   x: -11.4, z: -15.0, r: 5.0, y0: 7 },
  { id: 'gate',    x: -1.0, z: -19.5, r: 4.0 },
  { id: 'ford',    x: -1.0, z: -47.0, r: 6.0 },
  { id: 'ravine',  x: -14.0, z: -38.6, r: 6.0, y1: 4.5 },
  { id: 'orchard', x: 19.0, z: -37.0, r: 9.0 },
  { id: 'dell',    x: -9.5, z: -31.0, r: 7.0 },
  { id: 'ruin',    x: -14.0, z: -50.0, r: 8.0 },
  { id: 'stones',  x: 27.0, z: -82.0, r: 8.0 },
  { id: 'outcrop', x: 29.9, z: -85.1, r: 5.0, y0: 12 },
  { id: 'fold',    x: -20.0, z: -76.0, r: 12.0 },
];

function setupWorld() {
  flags = makeFlags({ toast: gain });
  interact = makeInteract({
    playClip: (name) => {
      if (!cur || !cur.clips[name]) return null;
      playOnce(name, 0.08);
      return cur.clips[name].getClip().duration;
    },
    clipTime: (name) => (cur && cur.clips[name] ? cur.clips[name].time : null),
    toast: gain,
  });

  // THE BEACON STARTS COLD. Every line about it says it has gone out; the
  // builder now keeps its coals as a mover so this can be true. The lit
  // material is kept on the mesh for the moment it is needed.
  const beacon = MOVERS.find((m) => m.name === 'beacon');
  if (beacon && beacon.obj) {
    beacon.lit = false;
    beacon.obj.traverse((o) => {
      if (!o.isMesh || o.userData.isOutline) return;
      o.userData.litMat = o.material;
      o.material = surfaceMaterial(LOOK, new THREE.Color(0x2a2320),
                                   { key: 'beacon:cold', rimStrength: 0.15 });
    });
    ZONES.push({ id: 'pass', x: beacon.hx, z: beacon.hz, r: 7.0 });
    interact.add({
      id: 'beacon', x: beacon.hx, y: beacon.hy, z: beacon.hz, r: 2.4,
      clip: 'cast_fire', at: 9,
      label: 'light the beacon',
      refuse: 'the beacon wants embercaps — five of them',
      can: () => !!(breakables && breakables.found >= 5),
      use: () => lightBeacon(beacon),
    });
  }

  if (terrain) {
    gfog = makeGroundFog({ scene, heightAt: (x, z) => terrain.heightAt(x, z), y: 0.8 });
  }

  const chest = MOVERS.find((m) => m.name === 'chest');
  if (chest && chest.obj) {
    interact.add({
      id: 'chest', x: chest.hx, y: chest.hy, z: chest.hz, r: 1.7,
      clip: 'open', at: 30,                      // the lift
      label: 'open the chest',
      use: () => {
        chest.t = 0;
        sfx.chest();
        const G = window.GS;
        if (G && G.ok) { G.addItem('river-steel', 1); G.addGold(120); }
        gain('River Steel', 'item');
        gain('+120 g');
        flags.once('chest.opened');
        interact.at('chest').done = true;
      },
    });
  }
}

function lightBeacon(m) {
  if (m.lit) return;
  m.lit = true;
  m.obj.traverse((o) => {
    if (!o.isMesh || !o.userData.litMat) return;
    // UNLIT ON PURPOSE. A toon material would put a shadow band on the coals;
    // a fire has no dark side. Basic material, over-bright, so bloom takes it.
    o.material = new THREE.MeshBasicMaterial({ color: 0xffb35a });
    o.material.color.multiplyScalar(1.6);
  });
  const light = new THREE.PointLight(0xff9a3a, 14, 18, 1.7);
  light.position.set(m.x, m.y + 0.35, m.z);
  scene.add(light);
  EMBERS.push(makeEmbers(m.x, m.y + 0.15, m.z, light));
  sfx.beacon();
  flags.once('beacon.lit', 'The beacon is lit');
}

// Sparks off a fire: a handful of points that rise, drift, gutter and respawn.
// CPU-driven and tiny, because eighty sprites is plenty for a basket of coals
// and a particle system is not a thing this demo needs to own.
function makeCloudMap(res = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = res;
  const g = c.getContext('2d');
  const img = g.createImageData(res, res);
  // value noise in three octaves, tileable by construction (integer lattice)
  const lat = (n) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = Math.random(); return a; };
  const L = [lat(4), lat(8), lat(16)];
  const sample = (a, n, u, v) => {
    const x = u * n, y = v * n, x0 = Math.floor(x) % n, y0 = Math.floor(y) % n;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n, fx = x - Math.floor(x), fy = y - Math.floor(y);
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a00 = a[y0 * n + x0], a10 = a[y0 * n + x1], a01 = a[y1 * n + x0], a11 = a[y1 * n + x1];
    return (a00 * (1 - sx) + a10 * sx) * (1 - sy) + (a01 * (1 - sx) + a11 * sx) * sy;
  };
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    const u = x / res, v = y / res;
    const n = 0.55 * sample(L[0], 4, u, v) + 0.30 * sample(L[1], 8, u, v) + 0.15 * sample(L[2], 16, u, v);
    const k = Math.max(0, Math.min(255, Math.round(n * 255)));
    const i = (y * res + x) * 4;
    img.data[i] = k; img.data[i + 1] = k; img.data[i + 2] = k; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function makeEmbers(x, y, z, light) {
  const N = 80;
  const pos = new Float32Array(N * 3);
  const life = new Float32Array(N);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffb86a, size: 0.11, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  const reset = (i) => {
    const a = Math.random() * 6.283, r = Math.random() * 0.22;
    pos[i * 3] = x + Math.cos(a) * r;
    pos[i * 3 + 1] = y + Math.random() * 0.1;
    pos[i * 3 + 2] = z + Math.sin(a) * r;
    life[i] = 0.6 + Math.random() * 1.6;
  };
  for (let i = 0; i < N; i++) { reset(i); life[i] *= Math.random(); }
  let t = 0;
  return {
    update(dt) {
      t += dt;
      for (let i = 0; i < N; i++) {
        life[i] -= dt;
        if (life[i] <= 0) { reset(i); continue; }
        pos[i * 3] += Math.sin(t * 3.1 + i) * 0.35 * dt;
        pos[i * 3 + 1] += (0.9 + (i % 5) * 0.12) * dt;
        pos[i * 3 + 2] += Math.cos(t * 2.7 + i * 1.3) * 0.35 * dt;
      }
      geo.attributes.position.needsUpdate = true;
      if (light) light.intensity = 13 + Math.sin(t * 9.0) * 1.2 + Math.sin(t * 23.0) * 0.6;
    },
  };
}

// WHAT YOU ARE DOING, in one line. The first row whose `when` is met and
// whose `done` is not. Written as flags rather than as a quest object, so the
// world -- not a script -- decides when you have moved on.
const TASKS = [
  { done: 'quest.beacon',  text: 'Something has the square on edge. Ask around.' },
  { when: 'quest.beacon', done: 'caps.5',
    // the count is live: a task you can watch move is one you keep doing
    text: () => `Gather embercaps — ${breakables ? breakables.found : 0} of 5. `
      + 'Along the walls, down the ravine, up on the roofs.' },
  { when: 'caps.5', done: 'beacon.lit',
    text: 'Light the beacon at the top of the north road.' },
  { when: 'beacon.lit', done: 'bell.rung',
    text: 'Ring the bell. The rope hangs in the tower\'s ground room.' },
  { when: 'bell.rung', done: 'chest.opened',
    text: 'Nell says the east lead ends in something worth having.' },
  { when: 'chest.opened', done: 'done.epilogue',
    text: 'The valley knows. See who noticed.' },
];
let taskEl = null, taskText = '';
function updateTask() {
  if (!taskEl) taskEl = document.getElementById('task');
  if (!taskEl || !flags) return;
  let text = '';
  for (const t of TASKS) {
    if (t.when && !flags.get(t.when)) continue;
    if (flags.get(t.done)) continue;
    text = typeof t.text === 'function' ? t.text() : t.text;
    break;
  }
  if (text !== taskText) { taskText = text; taskEl.textContent = text; }
}

// What is underfoot, for the ear: the town is stone, the road is dirt, the
// rest of the valley is grass. The gate is at z=-11; the meadow's road is the
// terrain's own path function, asked in the builder's y.
function surfaceAt(p) {
  if (p.z > -11.5) return 'stone';
  const tr = globalThis.terrain;
  if (tr && tr.pathAt && Math.abs(p.x - tr.pathAt(-p.z)) < 3.2) return 'dirt';
  return 'grass';
}
function ambienceAt(p) {
  const inTown = p.z > -11.5;
  const fountain = Math.hypot(p.x, p.z + 0.5);
  const stream = Math.hypot(Math.max(0, Math.abs(p.z + 47) - 2.5), Math.max(0, Math.abs(p.x + 2) - 30));
  const beacon = Math.hypot(p.x - 13.6, p.z + 106);
  return {
    inTown, waterD: Math.min(fountain, stream), fireD: beacon,
    fireOn: !!(flags && flags.get('beacon.lit')), dusk: duskLevel,
    quiet: !!(npcs && npcs.talking()) || document.body.classList.contains('title'),
  };
}

function stepWorld(dt) {
  if (!flags || !interact) return;
  updateTask();
  flags.zones(pos, ZONES);
  if (breakables) flags.caps(breakables.found);
  if (cur && cur.weaponId) flags.set('weapon.' + cur.weaponId);
  flags.set('sheathed', sheathed);
  interact.update(pos, dt, {
    suppress: !!(npcs && (npcs.near || npcs.talking())) || attacking || !!carry,
  });
  for (const e of EMBERS) e.update(dt);
  // THE CLIMAX IS A CHANGE OF LIGHT. When the coals take, the world slides
  // to dusk over six seconds: sun low and orange, sky banded, lanterns up.
  if (flags.get('beacon.lit') && !dusk && !duskDone) startDusk();
  if (dusk) {
    dusk.t = Math.min(1, dusk.t + dt / dusk.dur);
    const k = dusk.t * dusk.t * (3 - 2 * dusk.t);
    applyLighting(mixLook(LOOK, LOOKS.dusk, k));
    if (post) post.set({ bloom: 0.20 + 0.16 * k });
    duskLevel = k;
    if (dusk.t >= 1) { dusk = null; duskDone = true; duskLevel = 1; }
  }
}
let duskDone = false;

/** Anything the swing can set going that is not a breakable. */
function hitMovers(spec) {
  let rang = false;
  for (const m of MOVERS) {
    if (!m.obj || m.t >= 0) continue;
    // things you USE are not things you hit -- see interact.js
    if (m.name === 'beacon' || m.name === 'chest') continue;
    const dx = m.hx - pos.x, dz = m.hz - pos.z;
    const d = Math.hypot(dx, dz);
    if (d > m.r + (spec.reach ?? 1.6) * 0.7) continue;
    // THE TRIGGER IS NOT THE THING. You cannot reach the bell -- it hangs 2.1 m
    // over the belfry floor and the swing reaches 1.55 -- so what you actually
    // hit is the sally on the rope, twenty metres below it. Which is how a bell
    // is rung, and the reason the rope was worth modelling.
    if (Math.abs(pos.y + 1.0 - m.hy) > 1.5) continue;
    if (d > 1e-4) {
      const cos = (dx / d) * Math.sin(facing) + (dz / d) * Math.cos(facing);
      if (cos < Math.cos(1.1)) continue;
    }
    m.t = 0;
    rang = true;
    sfx.bell(0);
    // the first thing the world ever told the character sheet about itself
    if (flags) flags.once('bell.rung', 'The bell carries down the valley');
    // NO FLOCK SCATTER, and this is a decision I measured my way out of.
    //
    // The obvious flourish is to send the belfry's roosting flock up when the
    // bell sounds. It cannot work: the runtime PARKS AND HIDES any creature
    // past the cull distance -- resets it home, sets it idle, makes it
    // invisible -- and from the rope the belfry flock is 21.9 m away, which is
    // past it. Sampled per frame, the birds went to `startle` on the frame the
    // bell was struck and back to `idle` on the next, every time. `spook`
    // itself is fine: a flitter 6.6 m away in the plaza holds `startle`
    // indefinitely.
    //
    // So the scatter would have been twenty metres above your head, behind a
    // wall, on an animal the engine had already put to sleep. The rope is the
    // feedback instead.
  }
  return rang;
}

function updateSmash(dt) {
  if (!breakables) return;
  breakables.update(dt);
  if (!combat) return;
  const active = combat.isAttacking() && combat.attackPhase() === 'active';
  if (!active) { smashedThisSwing = false; return; }
  if (smashedThisSwing) return;
  const spec = combat.swingSpec();
  _sd.set(Math.sin(facing), 0, Math.cos(facing));
  // reach and arc BOTH from the swing that is happening, so what you can smash
  // is the same shape as what you can hit
  const n = breakables.hit(pos.x, pos.z, _sd, (spec.reach ?? 1.6) * 0.95,
                           (spec.arc ?? 1.6) + 0.5);
  if (hitMovers(spec)) {
    smashedThisSwing = true;
    combat.shake.mag = Math.max(combat.shake.mag, 0.10);
    combat.shake.t = 0.20;
  }
  if (n > 0) {
    smashedThisSwing = true;
    // it has to FEEL like it connected, or a barrel bursting reads as scenery
    // choosing to fall over next to you
    combat.shake.mag = Math.max(combat.shake.mag, 0.13);
    combat.shake.t = 0.24;
  }
}

function frame(dt) {
  // HIT-STOP IS GLOBAL OR IT IS A DESYNC. combat.js used to scale only its own
  // clock, so a 55 ms freeze advanced the swing's state machine by 3.3 ms and
  // its animation by the full 55 -- the clip raced ~17x ahead of the hitbox
  // windows it is supposed to line up with, on every single connected hit.
  // The wind runs on UNSCALED time. Hit-stop is a freeze on the fight, not on
  // the weather, and a world that stops breathing every time you connect reads
  // as the game hitching.
  WIND.value += dt;
  // A CONVERSATION FREEZES THE FIGHT, NOT THE FRAME. `sdt` going to zero stops
  // the player, the enemies, the swing and the animation; `dt` keeps running so
  // the wind still moves in the grass behind the box and the typewriter is not
  // sitting on a still image. This is the same split hit-stop already uses, for
  // the same reason -- a world that stops breathing reads as the game hitching.
  const scale = (combat ? combat.timeScale() : 1) * (uiLocked() ? 0 : 1);
  const sdt = dt * scale;
  const isMoving = step(sdt);
  // FOOTSTEPS ON THE CLIP'S CLOCK, not a timer: a footfall is a pose, and the
  // run clip already knows when the foot is down.
  if (isMoving && grounded && cur && cur.clips.run) {
    const a = cur.clips.run;
    const ph = (a.time / (a.getClip().duration || 1)) % 1;
    if (sfx.footfall(ph)) sfx.step(surfaceAt(pos), true);
  }
  sfx.update(dt, ambienceAt(pos));
  if (gfog) gfog.update(camera.position, { dusk: duskLevel, color: scene.fog.color });
  updateCombat(dt, dt);
  if (cur) { cur.mixer.update(sdt); stepCarry(); applyFootIK(cur, sdt); }
  stepWorld(sdt);
  if (air) air.update(sdt, pos);
  if (grass && grass.update) grass.update(pos);
  // the clouds drift with the prevailing wind, a metre or so a second
  CLOUD.offset.value.x += sdt * 0.9 * CLOUD.scale.value;
  CLOUD.offset.value.y += sdt * 0.35 * CLOUD.scale.value;
  updateTrail(sdt);
  updateThreatLines(sdt);
  updateSmash(sdt);
  updateMovers(sdt);
  // ON UNSCALED TIME, and on purpose. A townsperson has to keep breathing and
  // keep turning to face you while you are talking to them -- freezing the
  // person you are mid-conversation with is the one thing worse than not
  // having them at all.
  if (npcs) npcs.update(dt, pos);
  // ON SCALED TIME. A drop is part of the fight -- it should hang in the air
  // through hit-stop with everything else, and it must not be collectable
  // while a conversation is frozen over the top of it.
  if (drops) drops.update(sdt);
  if (post) {
    // SUN SHAFTS need to know where the sun is on screen. Project a point far
    // along the key direction; weight falls off as it leaves the frame and
    // is zero when it is behind the camera.
    _sunP.copy(camera.position).addScaledVector(_sunDir.copy(KEY_OFFSET).normalize(), 500);
    _sunP.project(camera);
    const behind = _sunP.z > 1.0;
    const sx = _sunP.x * 0.5 + 0.5, sy = _sunP.y * 0.5 + 0.5;
    const out = Math.max(Math.abs(_sunP.x), Math.abs(_sunP.y));
    const w = behind ? 0 : 1 - Math.max(0, Math.min(1, (out - 1.0) / 0.9));
    post.setSun(sx, sy, w * (dusk || duskDone ? 1.0 : 0.6));
    post.render(dt);
  } else renderer.render(scene, camera);
  hud.textContent =
    `${fps} fps  ·  ${cur ? cur.name : '—'}  ·  ${combat && combat.isStaggered() ? 'hurt' : slip.t > 0 ? 'slip' : attacking ? 'attack' : !grounded ? 'air'
        : landing ? 'land' : isMoving ? 'run' : 'idle'}`
    // HOSTILES, not "every creature alive in the world". This said `48 foes`
    // standing in an empty plaza, because it was counting sheep and birds --
    // and a number that large is itself a report that the place is overrun,
    // whether or not any of them can hurt you.
    + `${combat ? `  ·  ${combat.enemies.filter((e) => !e.dead && e.spec.hostile).length} foes` : ''}`
    // The whole of the reward UI. No inventory, no pickup prompt, no menu --
    // a count of the things you went out of your way to find.
    + `${breakables && breakables.pods ? `  ·  ${breakables.found}/${breakables.pods} embercaps` : ''}`
    + `${combat && combat.lockTarget ? '  ·  LOCK' : ''}`
    + `  ·  ${renderer.info.render.calls} draws / `
    + `${renderer.info.render.triangles.toLocaleString()} tris`;
  return isMoving;
}

function live() {
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    frame(dt);
    acc += dt; frames++;
    if (acc >= 0.5) { fps = Math.round(frames / acc); acc = 0; frames = 0; }
  });
}
live();

// expose for quick console poking while art-directing
// NB: Object.assign INVOKES getters rather than copying them, so a
// `get cur()` here would have snapshotted null at module-evaluation time,
// before the roster finished loading.  Define the accessor explicitly.
Object.defineProperty(globalThis, 'cur', { get: () => cur, configurable: true });
Object.defineProperty(globalThis, 'npcs', { get: () => npcs, configurable: true });
Object.defineProperty(globalThis, 'drops', { get: () => drops, configurable: true });
Object.assign(globalThis, { scene, camera, renderer, chars, OUTLINES, THREE,
                            selectCharacter, key, hemi, ambient, sky,
                            pos, cam, get SOLIDS() { return SOLIDS; }, FLOORS });

/**
 * QA hook: advance the simulation deterministically, without waiting on rAF.
 *
 * An automated screenshot runs in a tab Chrome has throttled to a couple of
 * frames per second, so an unaided capture always shows the scene mid-lerp on
 * frame three.  Driving the step loop by hand makes captures reproducible.
 *
 *   __sim({ steps: 90, held: ['KeyW'] })   // 1.5 s of running
 *   __sim({ attack: true, steps: 14 })     // 14 frames into the swing
 *   __sim({ warp: [0, 0, 2] })             // teleport, then settle
 */
globalThis.__sim = ({ steps = 60, dt = 1 / 60, held = [], attack: doAttack = false,
                      az = null, polar = null, dist = null, warp = null,
                      jump: doJump = false } = {}) => {
  renderer.setAnimationLoop(null);      // take the loop away from rAF entirely
  if (globalThis.__dismissTitle) { globalThis.__dismissTitle(); globalThis.__dismissTitle = null; }
  keys.clear();
  for (const k of held) keys.add(k);
  if (warp) {
    pos.set(warp[0], warp[1], warp[2]);
    camBoom = cam.dist;          // a teleport is not a camera move: do not ease
    camPrevOk = false;
    const g = groundAt(pos.x, pos.z, pos.y + 4);
    if (g !== null) pos.y = g;
    vy = 0; grounded = true; landing = false;
    camTarget.set(pos.x, pos.y + 1.18, pos.z);
  }
  if (az !== null) { cam.az = az; cam.autoDelay = 1e6; }
  if (polar !== null) cam.polar = polar;
  if (dist !== null) cam.dist = dist;
  if (doAttack) attack();
  if (doJump) jump();
  for (let i = 0; i < steps; i++) frame(dt);
  keys.clear();
  return {
    grounded, vy: +vy.toFixed(2),
    who: cur && cur.name,
    heroPos: pos.toArray().map((v) => +v.toFixed(2)),
    camDist: +camera.position.distanceTo(camTarget).toFixed(2),
    draws: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    hp: combat ? Math.round(combat.player.hp) : null,
    foes: combat ? combat.enemies.filter((e) => !e.dead).map((e) => ({
      k: e.name, s: e.state, hp: Math.round(e.hp),
      d: +Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z).toFixed(1),
    })) : [],
  };
};

// THE TITLE CARD. Up once the world and a character exist, down on the
// first key or click -- which still does what it does, so the card never
// costs the player an input. `__sim` skips it: a capture is not a player.
let titleShown = false;
function showTitle() {
  if (titleShown) return;
  titleShown = true;
  const el = document.getElementById('title');
  if (!el) return;
  document.body.classList.add('title');
  requestAnimationFrame(() => el.classList.add('on'));
  const dismiss = () => {
    sfx.unlock();
    sfx.title();
    el.classList.remove('on');
    el.classList.add('off');
    document.body.classList.remove('title');
    setTimeout(() => { el.style.display = 'none'; }, 800);
    window.removeEventListener('keydown', dismiss, true);
    window.removeEventListener('pointerdown', dismiss, true);
  };
  window.addEventListener('keydown', dismiss, true);
  window.addEventListener('pointerdown', dismiss, true);
  globalThis.__dismissTitle = dismiss;
}

function cycleCharacter() {
  const names = ROSTER.map((d) => d.name).filter((n) => chars[n]);
  const i = names.indexOf(cur ? cur.name : names[0]);
  selectCharacter(names[(i + 1) % names.length]);
}

globalThis.__cycle = cycleCharacter;
/**
 * QA hook: point the character at a spot.
 *
 * Swing tests need a known facing, and the only in-game way to get one is
 * lock-on -- which picks the nearest valid target, not the one a test pinned.
 * Three swings once landed cleanly on a nettle nobody was measuring while the
 * assertion reported that the finisher does not launch. Aim directly instead,
 * and let lock-on be tested by the lock-on test.
 */
globalThis.__groundAt = groundAt;
// A GETTER, not a copy: `breakables` is null until `startCombat` runs, and
// `Object.assign` would have snapshotted that null at module-evaluation time --
// the same trap the `cur` accessor above exists for.
Object.defineProperty(globalThis, '__breakables',
                      { get: () => breakables, configurable: true });
globalThis.__face = (x, z) => {
  facing = Math.atan2(x - pos.x, z - pos.z);
  return facing;
};
// hooks the smoke test needs and nothing else does
// What the carrying state machine thinks, so a sheathe that silently refuses
// can be asked why instead of guessed at.
// Retune where the sword rides without a rebuild. These two are TASTE, not
// correctness -- the frame around them is measured and checked -- so they are
// the one part of this worth putting in front of a person and comparing.
globalThis.__setSheath = (at, tilt) => {
  if (at) SHEATH_AT = new THREE.Vector3(...at);
  if (tilt) SHEATH_TILT = new THREE.Euler(...tilt);
  for (const c of Object.values(chars)) {
    if (c._sheath) { c._sheath.parent.remove(c._sheath); c._sheath = null; }
  }
  return { at: SHEATH_AT.toArray(), tilt: [SHEATH_TILT.x, SHEATH_TILT.y, SHEATH_TILT.z] };
};

globalThis.__carry = () => ({
  sheathed, carrying: carry ? carry.name : null,
  mounted: !!(cur && cur.mounted),
  hasClips: !!(cur && cur.clips.sheathe && cur.clips.draw),
  handoff: HANDOFF, attacking, locked: uiLocked(),
});

globalThis.__clipNames = (n) => (chars[n] ? Object.keys(chars[n].clips).sort() : null);
Object.defineProperty(globalThis, '__terrainProbes', {
  get: () => terrainProbes, configurable: true,
});
Object.defineProperty(globalThis, 'terrain', { get: () => terrain, configurable: true });
Object.defineProperty(globalThis, 'combat', { get: () => combat, configurable: true });
globalThis.__ik = IK_ENABLED;   // __ik.value = false to A/B it
/**
 * Switch the whole build between shading models, live.
 *
 * `__look('lit')` for a standard BRDF with a single hard key and no ink;
 * `__look('toon')` for the banded ramp, rim and inverted hull. The geometry,
 * the collision, the textures and the ground's vertex colours are identical in
 * both -- which is the point: none of them were ever tied to the look.
 */
// THE LIGHT RIG, THE SKY AND THE FOG, from a look -- or from a blend of two.
// THE SKY, THE FOG AND THE SUN'S POSITION ARE PART OF THE LOOK. They were
// set once at load and never touched by a look switch, so an A/B between
// looks was comparing two light rigs under one sky -- which is the sky's
// fault being blamed on the ramp, every time.
const _lc = [new THREE.Color(), new THREE.Color()];
function applyLighting(L) {
  key.color.set(L.key.color);
  key.intensity = L.key.intensity;
  hemi.color.set(L.hemi.sky);
  hemi.groundColor.set(L.hemi.ground);
  hemi.intensity = L.hemi.intensity;
  ambient.color.set(L.ambient.color);
  ambient.intensity = L.ambient.intensity;
  renderer.toneMappingExposure = L.exposure;
  if (L.key.position) {
    KEY_OFFSET.fromArray(L.key.position);
    sky.material.uniforms.uSun.value.copy(KEY_OFFSET).normalize();
  }
  if (L.sky) {
    const s = sky.material.uniforms;
    s.uTop.value.set(L.sky.top);
    s.uHorizon.value.set(L.sky.horizon);
    s.uMid.value.copy(L.sky.mid !== null && L.sky.mid !== undefined
      ? _lc[0].set(L.sky.mid)
      : _lc[0].set(L.sky.top).lerp(_lc[1].set(L.sky.horizon), 0.55));
    s.uSunColor.value.set(L.sky.sun || 0x000000);
  }
  if (L.fog) {
    scene.fog.color.set(L.fog.color);
    scene.fog.near = L.fog.near;
    scene.fog.far = L.fog.far;
  }
  const lamps = L.lamps || 0.45;
  for (const l of LAMPS) { l.intensity = lamps; l.distance = lamps > 1 ? 7.5 : 3.2; }
}

// Two looks, mixed. Colours lerp as colours, numbers as numbers, the sun's
// position as a vector -- everything applyLighting reads.
function mixLook(A, B, t) {
  const c = (a, b) => _lc[0].set(a).lerp(_lc[1].set(b), t).getHex();
  const n = (a, b) => a + (b - a) * t;
  const v = (a, b) => a.map((x, i) => n(x, b[i]));
  return {
    key: { color: c(A.key.color, B.key.color), intensity: n(A.key.intensity, B.key.intensity),
           position: v(A.key.position, B.key.position) },
    hemi: { sky: c(A.hemi.sky, B.hemi.sky), ground: c(A.hemi.ground, B.hemi.ground),
            intensity: n(A.hemi.intensity, B.hemi.intensity) },
    ambient: { color: c(A.ambient.color, B.ambient.color),
               intensity: n(A.ambient.intensity, B.ambient.intensity) },
    exposure: n(A.exposure, B.exposure),
    sky: { top: c(A.sky.top, B.sky.top), mid: c(A.sky.mid, B.sky.mid),
           horizon: c(A.sky.horizon, B.sky.horizon), sun: c(A.sky.sun, B.sky.sun) },
    fog: { color: c(A.fog.color, B.fog.color), near: n(A.fog.near, B.fog.near),
           far: n(A.fog.far, B.fog.far) },
    lamps: n(A.lamps || 0.45, B.lamps || 0.45),
  };
}
// the dusk in progress: { t, dur } while the world is sliding, null otherwise
let dusk = null;
function startDusk(dur = 6.0) {
  if (dusk || LOOK.label === 'dusk') return;
  dusk = { t: 0, dur };
}
globalThis.__dusk = (t) => {
  // a probe: jump to any point of the slide, or start it
  if (t === undefined) { startDusk(); return 'dusk started'; }
  applyLighting(mixLook(LOOK, LOOKS.dusk, t));
  if (post) post.set({ bloom: 0.20 + 0.16 * t });
  return `dusk ${t}`;
};

globalThis.__look = (name) => {
  const next = LOOKS[name];
  if (!next) return `unknown look: ${Object.keys(LOOKS).join(', ')}`;
  LOOK = next;
  for (const s of SURFACES) {
    if (!s.mesh.parent) continue;
    const keep = s.mesh.material;
    s.mesh.material = s.flat ? keep : surfaceMaterial(LOOK, s.color, s.opts);
    if (!s.flat) {
      // carry the per-surface flags the loaders set after construction
      s.mesh.material.shadowSide = keep.shadowSide;
      s.mesh.material.transparent = true;
      s.mesh.material.opacity = keep.opacity;
      if (keep !== s.mesh.material) keep.dispose();
    }
  }
  // the ink shells are a stylisation, not a lighting term
  for (const o of OUTLINE_MESHES) o.visible = LOOK.outlines;
  setRimScale(LOOK.rim);
  applyLighting(LOOK);
  dusk = null;
  // characters keep their own material list for the close-camera fade
  for (const c of Object.values(chars)) {
    if (!c) continue;
    c.mats = [];
    c.group.traverse((o) => { if (o.isMesh) c.mats.push(o.material); });
  }
  return `look: ${LOOK.label}`;
};
// Apply the default look ONCE, here, so the sky, fog and sun position come from
// the same table as the lights -- the literals above are the toon look's and
// only exist so the scene has something before this line runs.
globalThis.__look(LOOK.label);
// The frame after the frame: `__post('flat')` is the same passes with every
// knob at zero, so an A/B isolates the grade from the pass structure itself.
globalThis.__post = (c) => (post ? post.set(c) : 'post not built yet');
globalThis.__rim = setRimScale; // __rim(0) renders the frame with no rim light
// The world's memory and its second verb, for probes.
globalThis.__flags = () => (window.GS && GS.state ? { ...GS.state.flags } : null);
Object.defineProperty(globalThis, '__interact', { get: () => interact, configurable: true });
Object.defineProperty(globalThis, '__air', { get: () => air, configurable: true });
Object.defineProperty(globalThis, '__grass', { get: () => grass, configurable: true });
// every errand, sampled every half metre against the town's collision boxes
globalThis.__npcPaths = () => NPC_ROSTER.filter((d) => d.path).map((d) => {
  const pts = [[d.x, d.z], ...d.path];
  const hits = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    for (let u = 0; u <= L; u += 0.5) {
      const x = ax + (bx - ax) * u / L, z = az + (bz - az) * u / L;
      for (const s of SOLIDS) {
        const lx = (x - s.x) * s.c + (z - s.z) * s.s, lz = -(x - s.x) * s.s + (z - s.z) * s.c;
        if (Math.abs(lx) < s.hx + 0.3 && Math.abs(lz) < s.hz + 0.3 && s.top > 0.4 && s.base < 1.0)
          { hits.push(`${d.id} leg${i} @${x.toFixed(1)},${z.toFixed(1)} top${s.top.toFixed(1)}`); break; }
      }
    }
  }
  return `${d.id}: ${hits.length ? hits.slice(0, 4).join(' | ') : 'clear'}`;
});
globalThis.__sfx = sfx;
Object.defineProperty(globalThis, '__gfog', { get: () => gfog, configurable: true });
globalThis.__sun = () => ({ x: +(_sunP.x * 0.5 + 0.5).toFixed(2), y: +(_sunP.y * 0.5 + 0.5).toFixed(2), z: +_sunP.z.toFixed(2), post: !!post });
globalThis.__shafts = (strength, threshold) => post && post.setShafts(strength, threshold);
globalThis.__cloud = (k) => { if (k !== undefined) CLOUD.strength.value = k; return CLOUD.strength.value; };
globalThis.__movers = () => MOVERS.map((m) => `${m.name}${m.obj ? '' : '(unresolved)'} t=${m.t}`);
globalThis.__wind = WIND;  // set .value directly to A/B the sway
Object.defineProperty(globalThis, '__breakables', { get: () => breakables, configurable: true });
// The ground tells, so a test can ask which way they point. Both of them
// pointed the wrong way for an unknown number of iterations because every
// capture let the AI choose the facing, and an enemy walking at the camera
// looks the same whichever way its footprint is drawn.
globalThis.__threat = { line: threatLine, arc: threatArc };
globalThis.__shadows = (on) => {
  // shadowMap.enabled alone does nothing to already-compiled programs, so
  // an A/B that only flips the flag renders an identical frame and 'proves'
  // the shadows were not the cause.
  renderer.shadowMap.enabled = !!on;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
};
globalThis.__resume = () => { cam.autoDelay = 0; live(); return 'live'; };
