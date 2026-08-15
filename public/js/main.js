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
  console.log(`[town] ${FLOORS.length} floor meshes, ${SOLIDS.length} solids, `
    + `${manifest.lights.length} lamps`);
  done();
}).catch((err) => {
  document.getElementById('loading').textContent = 'failed to load the town';
  console.error(err);
});

// ---------------------------------------------------------------- the hero

const HERO_LOOK = {
  // skin takes the LIGHTEST rim on the character: a face is mostly midtone, so
  // a strong rim eats the whole head and the features stop reading
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
const HERO_FLAT = new Set(['eye', 'iris', 'pupil']);
// every material on the hero AND on their outline shell, so the close-camera
// fade takes the outline with it -- fading the body alone leaves a floating
// black silhouette, which is worse than not fading at all
const HERO_MATS = [];

const hero = new THREE.Group();
scene.add(hero);

const clips = {};
let mixer = null;
let currentAction = null;
let attacking = false;
let heroReady = false;

new GLTFLoader().load('/assets/hero.glb', (gltf) => {
  const root = gltf.scene;
  const meshes = [];
  root.traverse((o) => { o.frustumCulled = false; if (o.isMesh) meshes.push(o); });

  for (const m of meshes) {
    const name = (m.material?.name || '').toLowerCase();
    const color = m.material?.color?.clone() || new THREE.Color(0xffffff);
    // the face arrives as a texture on a decal; carry the map through
    const map = m.material?.map || null;
    m.material = HERO_FLAT.has(name)
      ? flatMaterial(color)
      : toonMaterial(color, { key: name, map, ...(HERO_LOOK[name] || {}) });
    m.castShadow = true;
    // THE HERO DOES NOT RECEIVE SHADOWS.  A 1.7 m character inside a 32 m
    // shadow frustum gets ~15 texels across the head, so self-shadow lands as
    // grey blotches on the face and the features stop reading.  A stylised
    // character is shaded by its ramp; it still CASTS, which is what reads.
    m.receiveShadow = false;
  }
  for (const m of meshes) {
    const name = (m.material?.name || '').toLowerCase();
    HERO_MATS.push(m.material);
    // The face decal sits ~2 mm off the skull and must NOT be outlined: an
    // inverted hull round a flat patch draws a black ring across the face.
    if (name === 'face') continue;
    const shell = addOutline(m, 0.0034);
    HERO_MATS.push(shell.material);
  }
  // transparency is enabled UP FRONT so the fade never triggers a mid-frame
  // shader recompile the first time the camera gets tight
  for (const m of HERO_MATS) { m.transparent = true; m.opacity = 1; }

  hero.add(root);
  mixer = new THREE.AnimationMixer(root);
  for (const clip of gltf.animations) {
    const a = mixer.clipAction(clip);
    clips[clip.name] = a;
    if (clip.name === 'attack' || clip.name === 'jump' || clip.name === 'land') {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;      // `jump` HOLDS its airborne pose
    }
  }
  mixer.addEventListener('finished', (e) => {
    if (e.action === clips.attack) {
      attacking = false;
      play(moving() ? 'run' : 'idle', 0.18);
    } else if (e.action === clips.land) {
      landing = false;
      play(moving() ? 'run' : 'idle', 0.14);
    }
    // `jump` deliberately does NOT resolve here: it clamps on the airborne
    // pose and is held until physics says we touched down.
  });
  play('idle', 0);
  heroReady = true;
  done();
}, undefined, (err) => {
  document.getElementById('loading').textContent = 'failed to load hero.glb';
  console.error(err);
});

function done() {
  if (heroReady && townReady) document.getElementById('loading').style.display = 'none';
}

function play(name, fade = 0.22) {
  const next = clips[name];
  if (!next || next === currentAction) return;
  next.reset().setEffectiveWeight(1).play();
  if (currentAction) next.crossFadeFrom(currentAction, fade, false);
  currentAction = next;
}

// -------------------------------------------------------------------- input

const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); jump(); }
  if (e.code === 'KeyJ' || e.code === 'KeyE') { e.preventDefault(); attack(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function moving() {
  return ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown',
          'ArrowLeft', 'ArrowRight'].some((k) => keys.has(k));
}

function playOnce(name, fade = 0.10) {
  const a = clips[name];
  if (!a) return;
  a.reset().setEffectiveWeight(1).play();
  if (currentAction && currentAction !== a) a.crossFadeFrom(currentAction, fade, false);
  currentAction = a;
}

function jump() {
  if (!heroReady || !grounded || attacking) return;
  grounded = false;
  landing = false;
  vy = JUMP_V;
  playOnce('jump', 0.06);
}

function attack() {
  if (!heroReady || attacking || !grounded) return;
  attacking = true;
  const a = clips.attack;
  a.reset().setEffectiveWeight(1).play();
  if (currentAction) a.crossFadeFrom(currentAction, 0.10, false);
  currentAction = a;
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

canvas.addEventListener('pointerdown', (e) => {
  dragging = true; canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false; canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.az -= e.movementX * 0.005;
  cam.polar = THREE.MathUtils.clamp(cam.polar - e.movementY * 0.004, 0.35, 1.48);
  cam.autoDelay = 1.6;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = THREE.MathUtils.clamp(cam.dist + e.deltaY * 0.006, 2.2, 12.0);
}, { passive: false });

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

    const want = Math.atan2(wx, wz);
    const d = ((want - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    facing += d * Math.min(1, dt * 14);
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

  hero.position.copy(pos);
  hero.rotation.y = facing;

  // locomotion only reclaims the body once we are grounded and done landing
  if (heroReady && !attacking && grounded && !landing) {
    play(isMoving ? 'run' : 'idle');
  }

  // camera
  cam.autoDelay = Math.max(0, cam.autoDelay - dt);
  if (isMoving && cam.autoDelay === 0) {
    const want = facing + Math.PI;
    const d = ((want - cam.az + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    cam.az += d * Math.min(1, dt * 1.3);
  }
  camTarget.lerp(_o.set(pos.x, pos.y + 1.18, pos.z), Math.min(1, dt * 9));

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
  for (const m of HERO_MATS) {
    m.opacity = fade;
    m.visible = fade > 0.02;
  }

  const camGround = groundAt(camera.position.x, camera.position.z, camera.position.y);
  if (camGround !== null && camera.position.y < camGround + 0.35) {
    camera.position.y = camGround + 0.35;
  }
  camera.lookAt(camTarget);

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
  if (mixer) mixer.update(dt);
  renderer.render(scene, camera);
  hud.textContent =
    `${fps} fps  ·  ${attacking ? 'attack' : !grounded ? 'air'
        : landing ? 'land' : isMoving ? 'run' : 'idle'}  ·  `
    + `${renderer.info.render.calls} draws / `
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
Object.assign(globalThis, { scene, camera, renderer, hero, clips, OUTLINES, THREE,
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
    heroPos: pos.toArray().map((v) => +v.toFixed(2)),
    camDist: +camera.position.distanceTo(camTarget).toFixed(2),
    draws: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
  };
};

globalThis.__resume = () => { cam.autoDelay = 0; live(); return 'live'; };
