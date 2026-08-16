// combat.js -- enemies, the combo, and impact.
//
// Split from main.js because it is a different concern: main.js owns the scene,
// the player body and the camera; this owns everything that fights.
//
// The load-bearing part of this file is IMPACT, not damage. A hit that deals
// damage but does not stop time, shove the target, shake the camera and throw a
// spark reads as a spreadsheet, not a fight. Numbers are the cheap half.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toonMaterial, flatMaterial, outlineMaterial, outlineGeometry } from './toon.js';

// ------------------------------------------------------------------- tuning

export const TUNE = {
  // Three swings. The third is the finisher: slower to start, bigger payoff.
  // Recovery is what makes a combo a commitment rather than a spam button.
  combo: [
    { clip: 'attack',  windup: 0.10, active: 0.11, recover: 0.20,
      damage: 12, knock: 2.6, lift: 0.0, stop: 0.055, shake: 0.09, reach: 1.75, arc: 1.5 },
    { clip: 'attack2', windup: 0.09, active: 0.11, recover: 0.20,
      damage: 13, knock: 2.8, lift: 0.0, stop: 0.055, shake: 0.10, reach: 1.80, arc: 1.7 },
    { clip: 'attack3', windup: 0.17, active: 0.14, recover: 0.40,
      damage: 28, knock: 7.0, lift: 3.2, stop: 0.115, shake: 0.26, reach: 2.05, arc: 1.9 },
  ],
  comboWindow: 0.42,       // how long after a swing a follow-up still chains
  playerHP: 100,
  playerIFrames: 0.85,
  lockRange: 13.0,
  lockDrop: 17.0,
};

// ------------------------------------------------------------ enemy species

export const SPECIES = {
  nettle: {
    url: '/assets/nettle.glb',
    hp: 40,
    radius: 0.42,
    height: 0.45,
    speed: 2.5,
    // the fight rhythm, in seconds
    notice: 12.0,          // aggro radius
    strikeRange: 1.55,
    telegraph: 0.52,       // how long the tell is held before committing
    attackTime: 0.30,
    recoverTime: 0.75,
    damage: 9,
    look: {
      hide:  { rimStrength: 0.55 },
      belly: { rimStrength: 0.40 },
      quill: { rimStrength: 0.95, rimColor: 0xfff0c0 },
    },
    flat: ['eye'],
    hostile: true,
  },

  // ARMOURED CHARGER. Commits to a straight line and cannot correct, so the
  // answer is to step aside; helpless for a beat on unfurl, which is what the
  // combo is for. Rolls physically -- `roll` spins the mesh while charging,
  // because a ball that also plays a walk cycle looks like two ideas.
  curler: {
    url: '/assets/curler.glb',
    hp: 78, radius: 0.52, height: 0.55, speed: 2.0,
    notice: 15.0, strikeRange: 3.4, telegraph: 0.62, attackTime: 1.05,
    recoverTime: 1.35, damage: 14,
    charge: 12.5, roll: 13.0,
    look: { shell: { rimStrength: 0.55 }, plate: { rimStrength: 0.85 },
            flesh: { rimStrength: 0.45 } },
    flat: ['eye'], hostile: true,
  },

  // BRUTE. Punishes greed. The wind-up is long enough to walk out of and the
  // damage is high enough that trading is never worth it -- it has the health
  // to survive a full chain, so it is the enemy the finisher exists for.
  bellow: {
    url: '/assets/bellow.glb',
    hp: 150, radius: 0.78, height: 1.35, speed: 1.35,
    notice: 14.0, strikeRange: 2.5, telegraph: 1.05, attackTime: 0.42,
    recoverTime: 1.5, damage: 22,
    look: { hide: { rimStrength: 0.55 }, sack: { rimStrength: 0.70 },
            horn: { rimStrength: 1.0, rimColor: 0xfff0c0 } },
    flat: ['eye'], hostile: true,
  },
};

// ----------------------------------------------------------------- helpers

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function pickClip(clips, want, fallback) {
  return clips[want] ? want : (clips[fallback] ? fallback : null);
}

// ------------------------------------------------------------------ system

export function createCombat(ctx) {
  // ctx: { scene, camera, world, groundAt, playerPos, playerFacing, hud }
  const loader = new GLTFLoader();
  const protos = {};
  const enemies = [];
  const fx = makeEffects(ctx.scene);

  let hitStop = 0;          // seconds of frozen time remaining
  const shake = { mag: 0, t: 0 };

  const player = {
    hp: TUNE.playerHP,
    maxHP: TUNE.playerHP,
    invuln: 0,
    step: -1,               // index into TUNE.combo, -1 = not attacking
    phase: 'none',          // windup | active | recover
    t: 0,
    buffered: false,
    sinceCombo: 99,
    hitThisSwing: null,     // Set of enemies already hit by the current swing
    dead: false,
    deadT: 0,
  };

  let lockTarget = null;

  // ------------------------------------------------------------ loading

  async function load(name) {
    const spec = SPECIES[name];
    const gltf = await loader.loadAsync(spec.url);
    protos[name] = { gltf, spec };
    return protos[name];
  }

  function instantiate(name) {
    const { gltf, spec } = protos[name];
    // SkeletonUtils-free clone: each enemy needs its own skeleton, and the
    // simplest correct way is to re-parse per instance would be wasteful, so
    // clone the hierarchy and rebind.
    const root = cloneSkinned(gltf.scene);

    const meshes = [];
    root.traverse((o) => { o.frustumCulled = false; if (o.isMesh) meshes.push(o); });
    for (const m of meshes) {
      const mat = (m.material?.name || '').toLowerCase();
      const color = m.material?.color?.clone() || new THREE.Color(0xffffff);
      m.material = spec.flat.includes(mat)
        ? flatMaterial(color)
        : toonMaterial(color, { key: `${name}:${mat}`, ...(spec.look[mat] || {}) });
      m.castShadow = true;
      m.receiveShadow = false;
      m.material.transparent = true;    // enabled up front; death fades
      m.material.opacity = 1;
    }
    const mats = meshes.map((m) => m.material);
    for (const m of meshes) {
      const shell = new THREE.Mesh(
        outlineGeometry(m.geometry), outlineMaterial(0x241d2b, 0.0030));
      if (m.isSkinnedMesh) {
        const sk = new THREE.SkinnedMesh(shell.geometry, shell.material);
        sk.bindMode = m.bindMode;
        sk.bind(m.skeleton, m.bindMatrix);
        sk.frustumCulled = false;
        m.parent.add(sk);
        sk.material.transparent = true;
        mats.push(sk.material);
      } else {
        m.add(shell);
        shell.material.transparent = true;
        mats.push(shell.material);
      }
    }

    const group = new THREE.Group();
    group.add(root);
    ctx.scene.add(group);

    const mixer = new THREE.AnimationMixer(root);
    const clips = {};
    for (const c of gltf.animations) {
      const a = mixer.clipAction(c);
      clips[c.name] = a;
      if (['telegraph', 'attack', 'hurt', 'die', 'recover'].includes(c.name)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    }
    return { group, mixer, clips, mats, spec, name, current: null };
  }

  function spawn(name, x, z) {
    if (!protos[name]) return null;
    const e = instantiate(name);
    const g = ctx.groundAt(x, z, 2) ?? 0;
    e.pos = new THREE.Vector3(x, g, z);
    e.vel = new THREE.Vector3();
    e.facing = Math.random() * Math.PI * 2;
    e.hp = e.spec.hp;
    e.state = 'idle';
    e.t = 0;
    e.flash = 0;
    e.dead = false;
    e.deadT = 0;
    e.hitLock = 0;
    e.lockDir = null;
    e.spin = 0;
    e.home = e.pos.clone();
    play(e, 'idle', 0);
    enemies.push(e);
    return e;
  }

  function play(e, name, fade = 0.14) {
    const next = e.clips[name];
    if (!next || next === e.current) return;
    next.reset().setEffectiveWeight(1).play();
    if (e.current) next.crossFadeFrom(e.current, fade, false);
    e.current = next;
  }

  // ------------------------------------------------------------ the combo

  function attack() {
    if (player.dead) return false;
    if (player.step < 0) {
      startSwing(0);
      return true;
    }
    // buffered: a press at ANY point in the current swing lands the next one,
    // which is the difference between a combo that feels tight and one that
    // feels like it drops inputs
    player.buffered = true;
    return true;
  }

  function startSwing(i) {
    player.step = i;
    player.phase = 'windup';
    player.t = 0;
    player.buffered = false;
    player.sinceCombo = 0;
    player.hitThisSwing = new Set();
  }

  function swingSpec() {
    return TUNE.combo[Math.min(player.step, TUNE.combo.length - 1)];
  }

  function attackClipFor(clips, i) {
    const s = TUNE.combo[i];
    return pickClip(clips, s.clip, 'attack');
  }

  // ------------------------------------------------------------- lock-on

  function validTargets() {
    return enemies.filter((e) => !e.dead && e.spec.hostile);
  }

  function toggleLock() {
    if (lockTarget) { lockTarget = null; return null; }
    lockTarget = nearestTarget();
    return lockTarget;
  }

  function nearestTarget(exclude = null) {
    let best = null, bestScore = Infinity;
    const fwd = _v2.set(Math.sin(ctx.playerFacing()), 0, Math.cos(ctx.playerFacing()));
    for (const e of validTargets()) {
      if (e === exclude) continue;
      _v.subVectors(e.pos, ctx.playerPos());
      const d = _v.length();
      if (d > TUNE.lockRange) continue;
      _v.normalize();
      // prefer things in front, but do not refuse something just behind you
      const score = d * (1.35 - 0.35 * _v.dot(fwd));
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  function cycleLock() {
    if (!lockTarget) { lockTarget = nearestTarget(); return lockTarget; }
    const next = nearestTarget(lockTarget);
    lockTarget = next || lockTarget;
    return lockTarget;
  }

  // -------------------------------------------------------------- damage

  function hurtEnemy(e, dmg, fromPos, knock, lift, stop, shakeMag) {
    if (e.dead) return;
    e.hp -= dmg;
    e.flash = 0.16;
    hitStop = Math.max(hitStop, stop);
    shake.mag = Math.max(shake.mag, shakeMag);
    shake.t = 0.28;

    _v.subVectors(e.pos, fromPos).setY(0);
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
    _v.normalize();
    e.vel.addScaledVector(_v, knock);
    e.vel.y += lift;

    fx.spark(e.pos.clone().setY(e.pos.y + e.spec.height * 0.6), _v);
    fx.number(e.pos.clone().setY(e.pos.y + e.spec.height * 1.15), dmg,
              e.hp <= 0 ? 0xffd25a : 0xffffff);

    if (e.hp <= 0) {
      e.dead = true;
      e.deadT = 0;
      e.state = 'dead';
      play(e, 'die', 0.05);
      if (lockTarget === e) lockTarget = nearestTarget(e);
    } else {
      e.hitLock = 0.22;
      e.state = 'hurt';
      e.t = 0;
      play(e, 'hurt', 0.04);
    }
  }

  function hurtPlayer(dmg, fromPos) {
    if (player.invuln > 0 || player.dead) return;
    player.hp -= dmg;
    player.invuln = TUNE.playerIFrames;
    hitStop = Math.max(hitStop, 0.07);
    shake.mag = Math.max(shake.mag, 0.22);
    shake.t = 0.3;
    fx.number(ctx.playerPos().clone().setY(ctx.playerPos().y + 1.9), dmg, 0xff6b5a);
    fx.hurtFlash();
    if (player.hp <= 0) {
      player.hp = 0;
      player.dead = true;
      player.deadT = 0;
    }
  }

  function respawn() {
    player.hp = player.maxHP;
    player.dead = false;
    player.deadT = 0;
    player.invuln = 1.2;
    player.step = -1;
    player.phase = 'none';
    lockTarget = null;
  }

  // --------------------------------------------------------------- update

  function update(dt, raw) {
    // HIT-STOP: freeze the simulation briefly on contact. This is the single
    // highest-value line in the file -- without it a hit has no weight at all.
    let scaled = dt;
    if (hitStop > 0) {
      hitStop -= raw;
      scaled = dt * 0.06;
    }

    updatePlayerSwing(scaled);
    for (const e of enemies) updateEnemy(e, scaled);
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.dead && e.deadT > 1.9) {
        ctx.scene.remove(e.group);
        enemies.splice(i, 1);
        if (lockTarget === e) lockTarget = null;
      }
    }
    separate(scaled);

    if (player.invuln > 0) player.invuln -= raw;
    player.sinceCombo += raw;
    if (lockTarget && (lockTarget.dead
        || lockTarget.pos.distanceTo(ctx.playerPos()) > TUNE.lockDrop)) {
      lockTarget = null;
    }
    if (player.dead) player.deadT += raw;

    fx.update(raw, ctx.camera);
    if (shake.t > 0) { shake.t -= raw; if (shake.t <= 0) shake.mag = 0; }
    return { hitStop: hitStop > 0 };
  }

  function updatePlayerSwing(dt) {
    if (player.step < 0) return;
    const s = swingSpec();
    player.t += dt;
    if (player.phase === 'windup' && player.t >= s.windup) {
      player.phase = 'active';
      player.t -= s.windup;
    } else if (player.phase === 'active') {
      testSwingHits(s);
      if (player.t >= s.active) {
        player.phase = 'recover';
        player.t -= s.active;
        // chain on the buffered press the instant the active window closes
        if (player.buffered && player.step < TUNE.combo.length - 1) {
          startSwing(player.step + 1);
        }
      }
    } else if (player.phase === 'recover' && player.t >= s.recover) {
      player.step = -1;
      player.phase = 'none';
      player.buffered = false;
    }
  }

  function testSwingHits(s) {
    const p = ctx.playerPos();
    const f = ctx.playerFacing();
    const fx2 = Math.sin(f), fz = Math.cos(f);
    for (const e of enemies) {
      if (e.dead || player.hitThisSwing.has(e)) continue;
      _v.subVectors(e.pos, p).setY(0);
      const d = _v.length();
      if (d > s.reach + e.spec.radius) continue;
      if (d > 1e-4) {
        _v.divideScalar(d);
        // a cone in front, wide enough that a swing does not feel like a laser
        if (_v.x * fx2 + _v.z * fz < Math.cos(s.arc / 2)) continue;
      }
      player.hitThisSwing.add(e);
      hurtEnemy(e, s.damage, p, s.knock, s.lift, s.stop, s.shake);
    }
  }

  // Beyond this an enemy is at its post and nobody is looking at it. Skinning
  // and drawing it costs the same as one in your face, and with five encounters
  // armed that was 280 draw calls for a fight involving four things.
  const FAR = 42;

  function updateEnemy(e, dt) {
    const far = e.pos.distanceToSquared(ctx.playerPos()) > FAR * FAR;
    e.group.visible = !far;
    if (far && !e.dead) {
      // park it: no skinning, no AI, no draw. It is home and idle by now.
      if (e.state !== 'return') { e.vel.set(0, 0, 0); e.state = 'idle'; }
      else { integrate(e, dt); e.group.position.copy(e.pos); }
      return;
    }
    e.mixer.update(dt);
    if (e.flash > 0) e.flash -= dt;
    for (const m of e.mats) {
      if (m.emissive) m.emissive.setScalar(e.flash > 0 ? 0.55 : 0);
    }

    if (e.dead) {
      e.deadT += dt;
      const k = THREE.MathUtils.clamp((e.deadT - 0.9) / 0.9, 0, 1);
      for (const m of e.mats) m.opacity = 1 - k;
      e.vel.multiplyScalar(0.86);
      integrate(e, dt);
      e.group.position.copy(e.pos);
      e.group.rotation.y = e.facing;
      return;
    }

    const p = ctx.playerPos();
    const dist = e.pos.distanceTo(p);
    e.t += dt;
    if (e.hitLock > 0) e.hitLock -= dt;

    // LEASH. Without one, everything you ever woke follows you forever, and by
    // the far end of the walk you are being trailed by every fight you declined.
    // An encounter should be a place, so each one goes home when you leave it --
    // but only from states where breaking off is not a cheat. Something mid-swing
    // finishes its swing.
    if (LEASHABLE.has(e.state)
        && e.pos.distanceTo(e.home) > e.spec.notice * 1.5) {
      e.state = 'return'; e.t = 0; e.token = false; e.lockDir = null;
    }

    switch (e.state) {
      case 'idle':
        if (dist < e.spec.notice) { e.state = 'approach'; e.t = 0; play(e, 'move'); }
        else play(e, 'idle');
        break;

      // walk back and forget about you -- and it heals on the way, so a
      // hit-and-run down the path is not a way to whittle a group down for free
      case 'return': {
        play(e, 'move');
        _v.subVectors(e.home, e.pos).setY(0);
        const d = _v.length();
        e.hp = Math.min(e.spec.hp, e.hp + e.spec.hp * 0.35 * dt);
        if (d < 0.6) { e.state = 'idle'; e.t = 0; e.hp = e.spec.hp; break; }
        faceToward(e, e.home, dt, 5);
        e.vel.addScaledVector(_v.divideScalar(d), e.spec.speed * 7 * dt);
        break;
      }

      case 'approach': {
        play(e, 'move');
        faceToward(e, p, dt, 7);
        if (dist > e.spec.strikeRange) {
          _v.subVectors(p, e.pos).setY(0).normalize();
          e.vel.addScaledVector(_v, e.spec.speed * 7 * dt);
        }
        // do not all pile in at once: only a couple hold an attack token
        if (dist <= e.spec.strikeRange && attackTokens() < 2) {
          e.state = 'telegraph'; e.t = 0; e.token = true;
          play(e, 'telegraph', 0.06);
        }
        break;
      }

      case 'telegraph':
        // it can still track you WHILE winding up, but slowly -- that is the
        // difference between a tell you can dodge and a tell you can ignore
        faceToward(e, p, dt, e.spec.charge ? 2.2 : 4);
        e.vel.multiplyScalar(0.80);
        if (e.t >= e.spec.telegraph) {
          e.state = 'attack'; e.t = 0;
          play(e, 'attack', 0.04);
          _v.subVectors(p, e.pos).setY(0).normalize();
          // a charger COMMITS: the direction is locked in now, and no amount
          // of moving afterwards will make it turn. Only chargers -- a lunger
          // gets one impulse and that is the whole move.
          e.lockDir = e.spec.charge ? _v.clone() : null;
          e.vel.addScaledVector(_v, e.spec.charge || 7.5);
        }
        break;

      case 'attack':
        if (e.lockDir) {
          // hold the committed line and keep the charge fed
          e.vel.addScaledVector(e.lockDir, e.spec.charge * 2.2 * dt);
          e.facing = Math.atan2(e.lockDir.x, e.lockDir.z);
          if (e.spec.roll) e.spin = (e.spin || 0) + e.spec.roll * dt;
        }
        if (dist < e.spec.strikeRange + 0.55 && e.t > 0.05 && !e.didHit) {
          e.didHit = true;
          hurtPlayer(e.spec.damage, e.pos);
        }
        if (e.t >= e.spec.attackTime) {
          e.state = 'recover'; e.t = 0; e.didHit = false; e.lockDir = null;
          play(e, 'recover', 0.06);
        }
        break;

      case 'recover':
        e.vel.multiplyScalar(0.84);
        if (e.t >= e.spec.recoverTime) {
          e.state = 'approach'; e.t = 0; e.token = false;
        }
        break;

      case 'hurt':
        if (e.hitLock <= 0) { e.state = 'approach'; e.t = 0; e.token = false; }
        break;
    }

    integrate(e, dt);
    e.group.position.copy(e.pos);
    e.group.rotation.y = e.facing;
    if (e.spec.roll) {
      if (e.state !== 'attack') e.spin = (e.spin || 0) * Math.pow(0.02, dt);
      e.group.children[0].rotation.x = e.spin || 0;
    }
  }

  function attackTokens() {
    let n = 0;
    for (const e of enemies) if (!e.dead && e.token) n++;
    return n;
  }

  function faceToward(e, target, dt, rate) {
    _v.subVectors(target, e.pos);
    const want = Math.atan2(_v.x, _v.z);
    let d = ((want - e.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    e.facing += d * Math.min(1, dt * rate);
  }

  // states it is fair to break off from -- not mid-attack, not mid-flinch
  const LEASHABLE = new Set(['idle', 'approach', 'return']);

  let nanReported = false;

  function integrate(e, dt) {
    // TRIPWIRE. A single undefined in a per-species field turns into NaN
    // velocity, and a NaN position renders as *nothing at all* -- the enemy is
    // simply absent, which reads as "it never spawned" and sends you looking in
    // the wrong place entirely. Say so instead.
    if (!Number.isFinite(e.vel.x) || !Number.isFinite(e.vel.y)
        || !Number.isFinite(e.vel.z)) {
      if (!nanReported) {
        nanReported = true;
        console.error(`[combat] NaN velocity on ${e.name} in state ${e.state}`);
      }
      e.vel.set(0, 0, 0);
      if (!Number.isFinite(e.pos.x)) e.pos.copy(ctx.playerPos());
    }
    e.pos.addScaledVector(e.vel, dt);
    e.vel.x *= Math.pow(0.02, dt);
    e.vel.z *= Math.pow(0.02, dt);
    e.vel.y -= 22 * dt;
    const g = ctx.groundAt(e.pos.x, e.pos.z, e.pos.y + 1.5);
    if (g !== null && e.pos.y <= g) { e.pos.y = g; e.vel.y = Math.max(0, e.vel.y); }
  }

  function separate(dt) {
    // keep bodies out of each other so a swarm reads as several things
    for (let i = 0; i < enemies.length; i++) {
      for (let j = i + 1; j < enemies.length; j++) {
        const a = enemies[i], b = enemies[j];
        if (a.dead || b.dead) continue;
        _v.subVectors(b.pos, a.pos).setY(0);
        const d = _v.length();
        const min = a.spec.radius + b.spec.radius;
        if (d > min || d < 1e-5) continue;
        _v.divideScalar(d).multiplyScalar((min - d) * 0.5);
        a.pos.sub(_v); b.pos.add(_v);
      }
    }

    // AND OUT OF THE PLAYER. Without this a swarm converges onto the exact
    // point you are standing on and the fight turns into a pile -- you cannot
    // see your own character, and "which one is about to hit me" is unanswerable.
    // A charge is allowed to bully through, at 35%, or it would stall on contact.
    const p = ctx.playerPos();
    for (const e of enemies) {
      if (e.dead) continue;
      _v.subVectors(e.pos, p).setY(0);
      let d = _v.length();
      const min = e.spec.radius + 0.42;
      if (d > min) continue;
      if (d < 1e-4) { _v.set(Math.sin(e.facing), 0, Math.cos(e.facing)); d = 1; }
      const push = (min - d) * (e.state === 'attack' && e.spec.charge ? 0.35 : 1);
      e.pos.addScaledVector(_v.divideScalar(d), push);
    }
  }

  return {
    load, spawn, update, attack, respawn,
    toggleLock, cycleLock,
    get lockTarget() { return lockTarget; },
    get enemies() { return enemies; },
    player,
    swingSpec, attackClipFor,
    get shake() { return shake; },
    fx,
    isAttacking: () => player.step >= 0,
    attackPhase: () => player.phase,
    attackStep: () => player.step,
  };
}

// ------------------------------------------------------------- skinned clone

function cloneSkinned(src) {
  const clone = src.clone(true);
  const bones = new Map();
  clone.traverse((o) => { if (o.isBone) bones.set(o.name, o); });
  const srcMeshes = [];
  src.traverse((o) => { if (o.isSkinnedMesh) srcMeshes.push(o); });
  let i = 0;
  clone.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const s = srcMeshes[i++];
    const skel = new THREE.Skeleton(
      s.skeleton.bones.map((b) => bones.get(b.name)),
      s.skeleton.boneInverses);
    o.bind(skel, s.bindMatrix);
  });
  return clone;
}

// ------------------------------------------------------------------ effects

function makeEffects(scene) {
  const layer = document.getElementById('fx');
  const numbers = [];

  // sparks: one pooled Points cloud, reused
  const MAX = 320;
  const pos = new Float32Array(MAX * 3);
  const vel = new Float32Array(MAX * 3);
  const life = new Float32Array(MAX);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xfff0c0, size: 0.13, sizeAttenuation: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  pts.frustumCulled = false;
  scene.add(pts);
  let head = 0;

  function spark(at, dir, n = 16) {
    for (let k = 0; k < n; k++) {
      const i = head = (head + 1) % MAX;
      pos[i * 3] = at.x; pos[i * 3 + 1] = at.y; pos[i * 3 + 2] = at.z;
      const s = 3.5 + Math.random() * 5.5;
      vel[i * 3] = (dir.x * 1.4 + (Math.random() - 0.5) * 1.6) * s;
      vel[i * 3 + 1] = (0.7 + Math.random() * 1.3) * s;
      vel[i * 3 + 2] = (dir.z * 1.4 + (Math.random() - 0.5) * 1.6) * s;
      life[i] = 0.30 + Math.random() * 0.16;
    }
  }

  function number(at, value, color) {
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'dmg';
    el.textContent = Math.round(value);
    el.style.color = '#' + new THREE.Color(color).getHexString();
    layer.appendChild(el);
    numbers.push({ el, at: at.clone(), t: 0, drift: (Math.random() - 0.5) * 26 });
  }

  // Driven from the update loop, NOT by a CSS transition kicked off inside a
  // requestAnimationFrame callback: rAF does not fire in a backgrounded tab, so
  // that version left the screen permanently tinted red after the first hit.
  const vignette = document.getElementById('vignette');
  let hurt = 0;

  function hurtFlash() { hurt = 1; }

  function update(dt, camera) {
    if (vignette && hurt > 0) {
      hurt = Math.max(0, hurt - dt * 2.4);
      vignette.style.opacity = String(hurt * hurt);
    }
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) { pos[i * 3 + 1] = -999; continue; }
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      vel[i * 3 + 1] -= 26 * dt;
      vel[i * 3] *= 0.90; vel[i * 3 + 2] *= 0.90;
    }
    geo.attributes.position.needsUpdate = true;

    for (let i = numbers.length - 1; i >= 0; i--) {
      const n = numbers[i];
      n.t += dt;
      if (n.t > 0.85) { n.el.remove(); numbers.splice(i, 1); continue; }
      n.at.y += dt * 1.15;
      const p = n.at.clone().project(camera);
      const w = innerWidth, h = innerHeight;
      n.el.style.left = `${(p.x * 0.5 + 0.5) * w + n.drift * n.t}px`;
      n.el.style.top = `${(-p.y * 0.5 + 0.5) * h}px`;
      n.el.style.opacity = String(1 - Math.max(0, (n.t - 0.5) / 0.35));
      n.el.style.transform =
        `translate(-50%,-50%) scale(${1 + 0.5 * Math.min(1, n.t * 7)})`;
      n.el.style.display = p.z > 1 ? 'none' : '';
    }
  }

  return { spark, number, update, hurtFlash };
}
