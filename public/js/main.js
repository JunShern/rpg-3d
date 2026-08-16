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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  toonMaterial, flatMaterial, outlineMaterial, outlineGeometry, skyDome,
  RAMP_3, RAMP_SOFT,
} from './toon.js';
import { createCombat, SPECIES, TUNE } from './combat.js';
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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
const world = new THREE.Group();
scene.add(world);

scene.add(skyDome(0x5fa8e8, 0xd6ebf7));
scene.fog = new THREE.Fog(0xd2e6f3, 42, 130);

// ------------------------------------------------------------------- lights

const key = new THREE.DirectionalLight(0xfff2d8, 2.5);
key.position.set(7, 24, 9);
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

// Fill stays LOW: piling on ambient lifts the shadow band toward the lit band
// until the toon banding stops reading and the whole scene turns pastel.
scene.add(new THREE.HemisphereLight(0xbcdcff, 0x6a6058, 0.62));
scene.add(new THREE.AmbientLight(0x6d7fa0, 0.20));

// ------------------------------------------------------------------ outlines

const OUTLINES = [];
const SHELLS = new WeakMap();

function addOutline(mesh, width = 0.0032) {
  const mat = outlineMaterial(0x2a2233, width);
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
  return clone;
}

// -------------------------------------------------------------------- town

// Materials that must NOT be shaded: a lamp that falls into the shadow band
// stops looking lit, and glass reads better as a flat pane than as a surface.
const TOWN_FLAT = new Set(['lamp']);
// Foliage is NOT outlined. An inverted hull round 500 grass tufts and every
// flower turns a meadow into a scribble; outlines belong on things whose
// silhouette carries meaning.
const NO_OUTLINE_ENV = new Set([
  'grass_hi', 'bloom_a', 'bloom_b', 'leaf_lo',
  // GROUND is not outlined either, and this one is about cost, not taste: an
  // inverted hull round a surface that fills the screen is a second full-screen
  // fill for an outline you only ever see at the silhouette.
  'grass', 'dirt', 'cobble', 'cobble_b',
]);
// ground casts nothing useful onto itself; tufts and blooms cast nothing at all
const NO_SHADOW_ENV = new Set([
  'grass', 'dirt', 'cobble', 'cobble_b', 'grass_hi', 'bloom_a', 'bloom_b',
]);
const TINY_ENV = new Set(['grass_hi', 'bloom_a', 'bloom_b']);
const TOWN_LOOK = {
  cobble:  { gradient: RAMP_SOFT, rimStrength: 0.18 },
  cobble_b:{ gradient: RAMP_SOFT, rimStrength: 0.18 },
  stone:   { gradient: RAMP_SOFT, rimStrength: 0.30 },
  glass:   { rimStrength: 1.20, rimColor: 0xffffff },
  water:   { rimStrength: 0.90, rimColor: 0xd8f4ff },
  brass:   { rimStrength: 1.00, rimColor: 0xfff0c0 },
  leaf:    { rimStrength: 0.45 },
  // meadow
  grass:    { gradient: RAMP_SOFT, rimStrength: 0.20 },
  grass_hi: { gradient: RAMP_SOFT, rimStrength: 0.34 },
  dirt:     { gradient: RAMP_SOFT, rimStrength: 0.16 },
  bark:     { rimStrength: 0.40 },
  leaf_lo:  { rimStrength: 0.34 },
  rock:     { gradient: RAMP_SOFT, rimStrength: 0.30 },
  bloom_a:  { rimStrength: 0.70, rimColor: 0xfff4c8 },
  bloom_b:  { rimStrength: 0.70, rimColor: 0xffd8ec },
};

const SOLIDS = [];         // oriented boxes, from every region's manifest
let terrain = null;        // analytic ground for the meadow
let terrainProbes = [];
const FLOORS = [];         // meshes the ground raycast targets
let townReady = false;

function applyTownLook(root) {
  const meshes = [];
  // Environment meshes are STATIC, so they keep frustum culling. It was
  // disabled wholesale early on, which is correct for a deforming character
  // and wrong here: it meant the entire town kept rendering while the player
  // was out in the meadow.
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    const name = (m.material?.name || '').toLowerCase();
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
    m.material = TOWN_FLAT.has(name)
      ? flatMaterial(color)
      : toonMaterial(color, {
          gradient: RAMP_SOFT, rimStrength: 0.28, map,
          key: 'town:' + name, ...(TOWN_LOOK[name] || {}),
        });
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
    m.material.shadowSide = THREE.BackSide;
    m.castShadow = !NO_SHADOW_ENV.has(name);
    m.receiveShadow = !TINY_ENV.has(name);
  }
  for (const m of meshes) {
    if (NO_OUTLINE_ENV.has((m.material?.name || '').toLowerCase())) continue;
    addOutline(m, 0.0022);
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
  root.traverse((o) => {
    if (!o.isMesh || o.material?.isShaderMaterial) return;
    if (/FLOOR/i.test(o.name || '')) FLOORS.push(o);
  });
  for (const s of manifest.solids || []) {
    SOLIDS.push({
      x: s.x, z: s.z, hx: s.hx, hz: s.hz, top: s.top ?? 3,
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

  // Lantern lights are a warm ACCENT in daylight, not a second key. At full
  // strength six of them wash the plaza flat and undo the ramp's contrast.
  for (const L of townMan.lights || []) {
    const lamp = new THREE.PointLight(0xffc879, 4.0, 7.5, 2);
    lamp.position.set(L.x, L.y, L.z);
    world.add(lamp);
  }

  townReady = true;
  console.log(`[world] ${FLOORS.length} floor meshes, ${SOLIDS.length} solids`);
  startCombat();
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
  // the sword is generated geometry joined into the body, so it arrives as
  // extra materials on the same mesh
  steel:   { rimStrength: 1.20, rimColor: 0xffffff },
  brass:   { rimStrength: 1.00, rimColor: 0xfff0c0 },
  leather: { rimStrength: 0.40 },
};
const FLAT_MATS = new Set(['eye', 'iris', 'pupil']);
const NO_OUTLINE = new Set(['face']);   // a hull round a flat decal rings the face

const ROSTER = [
  { name: 'vesper', url: '/assets/vesper.glb', look: CAST_LOOK, outline: 0.0028 },
  { name: 'lake',   url: '/assets/lake.glb',   look: CAST_LOOK, outline: 0.0028 },
  { name: 'maren',  url: '/assets/maren.glb',  look: CAST_LOOK, outline: 0.0028 },
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
    const name = (m.material?.name || '').toLowerCase();
    const color = m.material?.color?.clone() || new THREE.Color(0xffffff);
    const map = m.material?.map || null;      // face decal / body texture
    m.material = FLAT_MATS.has(name)
      ? flatMaterial(color)
      : toonMaterial(color, { key: def.name + ':' + name, map,
                              ...(def.look[name] || {}) });
    m.castShadow = true;
    // A CHARACTER DOES NOT RECEIVE SHADOWS.  A 1.7 m body inside a 32 m shadow
    // frustum gets ~15 texels across the head, so self-shadow lands as grey
    // blotches on the face.  A stylised character is shaded by its ramp; it
    // still CASTS, which is the part the player reads.
    m.receiveShadow = false;
  }
  for (const m of meshes) {
    const name = (m.material?.name || '').toLowerCase();
    mats.push(m.material);
    if (NO_OUTLINE.has(name)) continue;
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
    if (clip.name === 'attack' || clip.name === 'jump' || clip.name === 'land') {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;        // `jump` HOLDS its airborne pose
    }
  }
  const ch = { name: def.name, group, mixer, clips, mats, current: null,
               legs: collectLegs(group),
               hand: findBone(group, 'handr') };
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
  hud.dataset.who = name;
}

Promise.all(ROSTER.map((def) =>
  new GLTFLoader().loadAsync(def.url).then((g) => { chars[def.name] = buildCharacter(def, g); })
)).then(() => {
  selectCharacter(ROSTER[0].name);
  console.log('[chars]', Object.keys(chars).map(
    (k) => `${k}: ${Object.keys(chars[k].clips).join('/')}`).join('  |  '));
  done();
}).catch((err) => {
  document.getElementById('loading').textContent = 'failed to load a character';
  console.error(err);
});

function done() {
  if (cur && townReady) document.getElementById('loading').style.display = 'none';
}

function play(name, fade = 0.22) {
  if (!cur) return;
  const next = cur.clips[name];
  if (!next || next === cur.current) return;
  next.reset().setEffectiveWeight(1).play();
  if (cur.current) next.crossFadeFrom(cur.current, fade, false);
  cur.current = next;
}

// -------------------------------------------------------------------- input

const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); jump(); }
  if (e.code === 'KeyJ' || e.code === 'KeyE') { e.preventDefault(); attack(); }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); dodge(); }
  if (e.code === 'KeyC') { e.preventDefault(); cycleCharacter(); }
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
  if (!cur || !grounded || attacking) return;
  if (combat && combat.isStaggered()) return;
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
  // airborne presses run the falling cut instead of the ground chain
  combat.attack(!grounded);
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

function pushOut(p, r) {
  for (const b of SOLIDS) {
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
    if (!slab(oy, dy, -0.5, b.top)) continue;
    if (t0 > 0 && t0 < best) best = t0;
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
const SPEED = 3.0;
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
  // Ask the terrain function where it owns the ground. Raycasting the meadow
  // heightfield instead was, on its own, the single largest cost in the frame.
  if (terrain && terrain.owns(x, z)) return terrain.heightAt(x, z);
  if (!FLOORS.length) return 0;
  groundRay.set(_o.set(x, fromY + 2.0, z), DOWN);
  groundRay.far = 12;
  const hit = groundRay.intersectObjects(FLOORS, false)[0];
  return hit ? hit.point.y : null;
}

/** Try to move by (dx, dz).  Returns true if the hero actually moved. */
function tryMove(dx, dz) {
  const nx = pos.x + dx, nz = pos.z + dz;
  const p = { x: nx, z: nz };
  pushOut(p, CHAR_R);
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

const cam = { az: Math.PI, polar: 1.22, dist: 5.4, autoDelay: 0 };
const camTarget = new THREE.Vector3(0, 1.18, 7);
const camWant = new THREE.Vector3();
let dragging = false;

let pointerDownAt = 0, pointerDrag = 0;
canvas.addEventListener('pointerdown', (e) => {
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
const ENCOUNTERS = [
  { x: 0.5,  z: 6.2,  r: 4.2, trigger: 18, refill: true,
    mix: ['nettle', 'nettle', 'nettle'] },
  // sited ON the route -- the path runs x = -1 -> 2.9 -> 8.5 -> 13 as it climbs,
  // so these are what you walk into rather than what you'd have to go find
  // spaced further apart than they trigger, so you fight one group at a time --
  // overlapping them turned the hill into seventeen things at once, which is a
  // pile rather than an encounter
  { x: 3.0,  z: -32,  r: 5.5, trigger: 15,
    mix: ['nettle', 'nettle', 'curler'] },
  { x: 6.0,  z: -54,  r: 6.5, trigger: 16,
    mix: ['curler', 'nettle', 'nettle', 'nettle'] },
  { x: 13.0, z: -74,  r: 6.5, trigger: 16,
    mix: ['curler', 'curler', 'nettle'] },
  { x: 15.0, z: -95,  r: 8.5, trigger: 19,          // past the landmark hill
    mix: ['bellow', 'nettle', 'nettle', 'nettle'] },
];

function startCombat() {
  trail = makeTrail(scene);
  scene.add(lockRing);
  combat = createCombat({
    scene,
    camera,
    world,
    groundAt,
    pushOut,
    playerPos: () => pos,
    playerFacing: () => facing,
  });
  Promise.all(['nettle', 'curler', 'bellow', 'woolt', 'flitter'].map((n) => combat.load(n)))
    .then(() => {
      armEncounter(ENCOUNTERS[0]);
      seedHerds();
      console.log('[combat] ready:', Object.keys(SPECIES).join(', '));
    })
    .catch((err) => console.error('[combat] load failed', err));
}

// Grazers are not an encounter -- they are furniture that moves. They exist
// from the moment the meadow does, off to the sides of the route, so the field
// is inhabited whether or not you go looking for a fight.
const HERDS = [
  { x: -9,  z: -38, n: 3 },
  { x: 21,  z: -58, n: 4 },
  { x: -4,  z: -70, n: 2 },
  { x: 26,  z: -88, n: 3 },
];

// Flocks sit ON the route, unlike the herds -- you are meant to walk into them.
const FLOCKS = [
  { x: -2,  z: -24, n: 5 },
  { x: 6,   z: -44, n: 6 },
  { x: 10,  z: -62, n: 5 },
  { x: 16,  z: -86, n: 6 },
];

function seedHerds() {
  for (const h of HERDS) {
    for (let i = 0; i < h.n; i++) {
      const a = (i / h.n) * Math.PI * 2 + h.x;
      combat.spawn('woolt', h.x + Math.cos(a) * 2.6, h.z + Math.sin(a) * 2.6);
    }
  }
  for (const f of FLOCKS) {
    for (let i = 0; i < f.n; i++) {
      // scattered, not ringed: a ring of birds reads as a summoning circle
      const a = i * 2.39962;                       // golden angle
      const r = 0.9 + 1.9 * Math.sqrt(i / f.n);
      combat.spawn('flitter', f.x + Math.cos(a) * r, f.z + Math.sin(a) * r);
    }
  }
}

function armEncounter(enc) {
  enc.armed = true;
  enc.spawned = [];
  enc.mix.forEach((species, i) => {
    const a = (i / enc.mix.length) * Math.PI * 2 + enc.z;
    const r = enc.r * (0.45 + 0.5 * ((i * 7 % 5) / 5));
    const e = combat.spawn(species, enc.x + Math.cos(a) * r, enc.z + Math.sin(a) * r);
    if (e) enc.spawned.push(e);
  });
}

function updateEncounters() {
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
    lockRing.rotation.z += dt * 1.4;
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
  const g = new THREE.RingGeometry(0.78, 1.0, 32, 1);
  g.rotateX(-Math.PI / 2);
  // four bites out of the ring, so it reads as a bracket rather than a halo
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

  // locomotion only reclaims the body once we are grounded and done landing
  if (cur && !attacking && grounded && !landing && slip.t <= 0 && !staggered) {
    play(isMoving ? 'run' : 'idle');
  }

  // camera
  cam.autoDelay = Math.max(0, cam.autoDelay - dt);
  const lock = combat && combat.lockTarget;
  if (lock && !lock.dead) {
    // sit behind the player on the player->target line, so both are in frame
    const dx = lock.pos.x - pos.x, dz = lock.pos.z - pos.z;
    const want = Math.atan2(-dx, -dz);
    const d = ((want - cam.az + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    cam.az += d * Math.min(1, dt * 3.4);
    cam.polar += (1.16 - cam.polar) * Math.min(1, dt * 2.4);
  } else if (isMoving && cam.autoDelay === 0) {
    const want = facing + Math.PI;
    const d = ((want - cam.az + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    cam.az += d * Math.min(1, dt * 1.3);
  }
  // bias the look-at toward the target so the enemy is not shoved off-screen
  const bx = lock && !lock.dead ? (lock.pos.x - pos.x) * 0.22 : 0;
  const bz = lock && !lock.dead ? (lock.pos.z - pos.z) * 0.22 : 0;
  camTarget.lerp(_o.set(pos.x + bx, pos.y + 1.18, pos.z + bz), Math.min(1, dt * 9));

  const sp = Math.sin(cam.polar);
  camWant.set(Math.sin(cam.az) * sp, Math.cos(cam.polar), Math.cos(cam.az) * sp);
  // CAMERA COLLISION: pull in short of anything solid.  Without it the camera
  // walks into a facade and the screen fills with the inside of a wall -- which
  // in a town, unlike an open field, happens constantly.
  const hitD = rayCastSolids(camTarget.x, camTarget.y, camTarget.z,
                             camWant.x, camWant.y, camWant.z, cam.dist);
  // The floor has to be SMALL.  An alley is 1.75 m wide, so a camera shoved
  // sideways has under 0.9 m before it is inside a facade; a 1.1 m minimum put
  // it through the wall and filled the screen with outline colour.
  const d = Math.max(0.45, hitD - 0.25);
  camera.position.copy(camTarget).addScaledVector(camWant, d);

  // ...which means the camera now sometimes sits inside the hero.  Fade them
  // out rather than showing the inside of their head.  This is the cheap fix:
  // the real one is a corridor-aware camera that yaws to look ALONG an alley
  // instead of being pressed into its wall.
  const fade = THREE.MathUtils.clamp((d - 0.75) / 0.85, 0, 1);
  if (cur) for (const m of cur.mats) { m.opacity = fade; m.visible = fade > 0.02; }

  const camGround = groundAt(camera.position.x, camera.position.z, camera.position.y);
  if (camGround !== null && camera.position.y < camGround + 0.35) {
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
  key.position.set(sx + 7, sy + 24, sz + 9);
  key.target.position.set(sx, sy, sz);
  key.target.updateMatrixWorld();

  return isMoving;
}

// --------------------------------------------------------------------- loop

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
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

function frame(dt) {
  // HIT-STOP IS GLOBAL OR IT IS A DESYNC. combat.js used to scale only its own
  // clock, so a 55 ms freeze advanced the swing's state machine by 3.3 ms and
  // its animation by the full 55 -- the clip raced ~17x ahead of the hitbox
  // windows it is supposed to line up with, on every single connected hit.
  const scale = combat ? combat.timeScale() : 1;
  const sdt = dt * scale;
  const isMoving = step(sdt);
  updateCombat(dt, dt);
  if (cur) { cur.mixer.update(sdt); applyFootIK(cur, sdt); }
  updateTrail(sdt);
  renderer.render(scene, camera);
  hud.textContent =
    `${fps} fps  ·  ${cur ? cur.name : '—'}  ·  ${combat && combat.isStaggered() ? 'hurt' : slip.t > 0 ? 'slip' : attacking ? 'attack' : !grounded ? 'air'
        : landing ? 'land' : isMoving ? 'run' : 'idle'}`
    + `${combat ? `  ·  ${combat.enemies.filter((e) => !e.dead).length} foes` : ''}`
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
Object.assign(globalThis, { scene, camera, renderer, chars, OUTLINES, THREE,
                            selectCharacter,
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
  keys.clear();
  for (const k of held) keys.add(k);
  if (warp) {
    pos.set(warp[0], warp[1], warp[2]);
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
globalThis.__face = (x, z) => {
  facing = Math.atan2(x - pos.x, z - pos.z);
  return facing;
};
// hooks the smoke test needs and nothing else does
globalThis.__clipNames = (n) => (chars[n] ? Object.keys(chars[n].clips).sort() : null);
Object.defineProperty(globalThis, '__terrainProbes', {
  get: () => terrainProbes, configurable: true,
});
Object.defineProperty(globalThis, 'terrain', { get: () => terrain, configurable: true });
Object.defineProperty(globalThis, 'combat', { get: () => combat, configurable: true });
globalThis.__ik = IK_ENABLED;   // __ik.value = false to A/B it
globalThis.__resume = () => { cam.autoDelay = 0; live(); return 'live'; };
