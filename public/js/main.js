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
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.03;
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
  clone.frustumCulled = false;
  OUTLINES.push(mat);
  return clone;
}

// -------------------------------------------------------------------- town

// Materials that must NOT be shaded: a lamp that falls into the shadow band
// stops looking lit, and glass reads better as a flat pane than as a surface.
const TOWN_FLAT = new Set(['lamp']);
const TOWN_LOOK = {
  cobble:  { gradient: RAMP_SOFT, rimStrength: 0.18 },
  cobble_b:{ gradient: RAMP_SOFT, rimStrength: 0.18 },
  stone:   { gradient: RAMP_SOFT, rimStrength: 0.30 },
  glass:   { rimStrength: 1.20, rimColor: 0xffffff },
  water:   { rimStrength: 0.90, rimColor: 0xd8f4ff },
  brass:   { rimStrength: 1.00, rimColor: 0xfff0c0 },
  leaf:    { rimStrength: 0.45 },
};

let SOLIDS = [];           // oriented boxes, from the manifest
const FLOORS = [];         // meshes the ground raycast targets
let townReady = false;

function applyTownLook(root) {
  const meshes = [];
  root.traverse((o) => {
    o.frustumCulled = false;
    if (o.isMesh) meshes.push(o);
  });
  for (const m of meshes) {
    const name = (m.material?.name || '').toLowerCase();
    const color = m.material?.color?.clone() || new THREE.Color(0xffffff);
    m.material = TOWN_FLAT.has(name)
      ? flatMaterial(color)
      : toonMaterial(color, {
          gradient: RAMP_SOFT, rimStrength: 0.28,
          key: 'town:' + name, ...(TOWN_LOOK[name] || {}),
        });
    m.castShadow = true;
    m.receiveShadow = true;
  }
  for (const m of meshes) addOutline(m, 0.0022);
  return meshes;
}

Promise.all([
  new GLTFLoader().loadAsync('/assets/town.glb'),
  fetch('/assets/town.manifest.json').then((r) => r.json()),
]).then(([gltf, manifest]) => {
  const root = gltf.scene;
  applyTownLook(root);

  root.traverse((o) => {
    if (o.isMesh && /^FLOOR/i.test(o.name || '')) FLOORS.push(o);
  });
  // fall back to every mesh under a FLOOR parent, in case the exporter nested
  if (!FLOORS.length) {
    root.traverse((o) => {
      if (o.isMesh && /FLOOR/i.test(o.parent?.name || '')) FLOORS.push(o);
    });
  }

  SOLIDS = manifest.solids.map((s) => ({
    x: s.x, z: s.z, hx: s.hx, hz: s.hz, top: s.top ?? 3,
    c: Math.cos(s.yaw), s: Math.sin(s.yaw),
  }));

  // Lantern lights are a warm ACCENT in daylight, not a second key.  At full
  // strength six of them wash the plaza flat and undo the ramp's contrast.
  for (const L of manifest.lights) {
    const lamp = new THREE.PointLight(0xffc879, 4.0, 7.5, 2);
    lamp.position.set(L.x, L.y, L.z);
    world.add(lamp);
  }

  world.add(root);
  townReady = true;
  startCombat();
  console.log(`[town] ${FLOORS.length} floor meshes, ${SOLIDS.length} solids, `
    + `${manifest.lights.length} lamps`);
  done();
}).catch((err) => {
  document.getElementById('loading').textContent = 'failed to load the town';
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
               legs: collectLegs(group) };
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
  grounded = false;
  landing = false;
  vy = JUMP_V;
  playOnce('jump', 0.06);
}

function attack() {
  if (!cur || !grounded || !combat) return;
  combat.attack();
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
  if (!IK_ENABLED.value || !ch.legs || !grounded || !FLOORS.length) return;
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
// Tuned to just CLEAR the 1.1 m terrace: a jump that cannot reach the one
// ledge in the level is a button that does nothing.
let vy = 0;
let grounded = true;
let landing = false;

const groundRay = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();

function groundAt(x, z, fromY) {
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

// Where the fight is. Deliberately a clearing off the plaza rather than the
// plaza itself: enemies that spawn on top of the fountain read as a bug.
const ARENA = { x: 0.5, z: 6.2, r: 4.2 };

function startCombat() {
  combat = createCombat({
    scene,
    camera,
    world,
    groundAt,
    playerPos: () => pos,
    playerFacing: () => facing,
  });
  combat.load('nettle').then(() => {
    seedWave();
    console.log('[combat] ready');
  }).catch((err) => console.error('[combat] load failed', err));
}

function seedWave(n = 3) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random();
    const r = ARENA.r * (0.45 + Math.random() * 0.5);
    combat.spawn('nettle', ARENA.x + Math.cos(a) * r, ARENA.z + Math.sin(a) * r);
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

  // keep the fight populated so there is always something to test against
  if (combat.enemies.filter((e) => !e.dead).length === 0) seedWave();

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
  const t = combat.lockTarget;
  if (t && !t.dead) {
    _o.copy(t.pos); _o.y += t.spec.height * 0.75;
    _o.project(camera);
    const on = _o.z < 1;
    reticle.style.display = on ? 'block' : 'none';
    reticle.style.left = `${(_o.x * 0.5 + 0.5) * innerWidth}px`;
    reticle.style.top = `${(-_o.y * 0.5 + 0.5) * innerHeight}px`;
  } else {
    reticle.style.display = 'none';
  }
}

/** Camera shake, applied after the camera is placed so it never fights it. */
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

  const wants = dir.lengthSq() > 0 && !attacking && townReady;
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
    vy -= GRAVITY * dt;
    pos.y += vy * dt;
    const g = groundAt(pos.x, pos.z, pos.y + 1.2);
    if (g !== null && vy <= 0 && pos.y <= g) {
      pos.y = g;
      vy = 0;
      grounded = true;
      landing = true;
      playOnce('land', 0.05);
    }
  }

  if (cur) { cur.group.position.copy(pos); cur.group.rotation.y = facing; }

  // locomotion only reclaims the body once we are grounded and done landing
  if (cur && !attacking && grounded && !landing) {
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

  key.position.set(pos.x + 7, pos.y + 24, pos.z + 9);
  key.target.position.set(pos.x, pos.y, pos.z);
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

function frame(dt) {
  const isMoving = step(dt);
  updateCombat(dt, dt);
  if (cur) { cur.mixer.update(dt); applyFootIK(cur, dt); }
  renderer.render(scene, camera);
  hud.textContent =
    `${fps} fps  ·  ${cur ? cur.name : '—'}  ·  ${attacking ? 'attack' : !grounded ? 'air'
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
  };
};

function cycleCharacter() {
  const names = ROSTER.map((d) => d.name).filter((n) => chars[n]);
  const i = names.indexOf(cur ? cur.name : names[0]);
  selectCharacter(names[(i + 1) % names.length]);
}

globalThis.__cycle = cycleCharacter;
Object.defineProperty(globalThis, 'combat', { get: () => combat, configurable: true });
globalThis.__ik = IK_ENABLED;   // __ik.value = false to A/B it
globalThis.__resume = () => { cam.autoDelay = 0; live(); return 'live'; };
