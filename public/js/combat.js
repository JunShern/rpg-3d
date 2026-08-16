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
      damage: 12, knock: 2.6, lift: 0.0, stop: 0.055, shake: 0.09, reach: 1.75,
      arc: 1.5, stun: 0.20 },
    { clip: 'attack2', windup: 0.09, active: 0.11, recover: 0.20,
      damage: 13, knock: 2.8, lift: 0.0, stop: 0.055, shake: 0.10, reach: 1.80,
      arc: 1.7, stun: 0.24 },
    { clip: 'attack3', windup: 0.17, active: 0.14, recover: 0.40,
      damage: 28, knock: 7.0, lift: 3.2, stop: 0.115, shake: 0.26, reach: 2.05,
      arc: 1.9, stun: 0.55 },
  ],
  // THE FALLING CUT. Not part of the chain, and deliberately not a fourth hit:
  // it exists because the finisher LAUNCHES, and a launch with nothing to do
  // about it is a wasted mechanic. Landing it bounces you back up, so an
  // airborne enemy can be juggled -- and missing it drops you into a landing
  // you have to eat. High damage, low knock: knocking it away would end the
  // juggle you just started.
  air: {
    clip: 'airattack', windup: 0.19, active: 0.20, recover: 0.26,
    damage: 18, knock: 2.2, lift: 2.4, stop: 0.085, shake: 0.17,
    reach: 1.90, arc: 2.1, stun: 0.36,
    hang: 0.19,            // seconds of held breath at the top
    pogo: 7.4,             // upward kick on a hit -- the whole point
  },
  // THE SLIP. The only defensive option, and the answer the Curler's design has
  // been asking for since it was built: its charge commits to a straight line
  // and cannot correct, so there has to be a way to not be on that line.
  //
  // It cancels attack recovery. That is the whole feel of it -- committing to a
  // swing is supposed to be a risk, not a trap, and a game where the only way
  // out of a recovery is to eat the hit teaches you to stop attacking.
  dodge: {
    clip: 'dodge', time: 0.42, dist: 3.6,
    iFrom: 0.05, iTo: 0.28,      // invulnerable across the middle of it
    cooldown: 0.62,
  },
  comboWindow: 0.42,       // how long after a swing a follow-up still chains
  playerHP: 100,
  playerIFrames: 0.85,
  lockRange: 13.0,
  lockDrop: 17.0,
};

// ------------------------------------------------------------ enemy species

export const SPECIES = {
  nettle: {
    url: '/assets/nettle.glb', far: 42,
    hp: 40,
    radius: 0.42,
    height: 0.45,
    speed: 2.5,
    // the fight rhythm, in seconds
    notice: 12.0,          // aggro radius
    // A DARTING LUNGE: lands early, narrow, and chip damage stops it. Being
    // interruptible is the thing that makes a swarm fair -- but these keys were
    // simply missing, so it silently used the generic defaults and its
    // `poiseLeft` was always zero. COMBAT-BAR cited numbers for it that did not
    // exist anywhere in the code.
    impact: 0.30, hitArc: 1.45, poise: 11,
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
    url: '/assets/curler.glb', far: 42,
    hp: 78, radius: 0.52, height: 0.55, speed: 2.0,
    notice: 15.0, strikeRange: 3.4, telegraph: 0.62, attackTime: 1.05,
    recoverTime: 1.35, damage: 14,
    // it is a rolling ball on a locked line: narrow, and dangerous almost at once
    impact: 0.10, hitArc: 1.1, poise: 26,
    charge: 12.5, roll: 13.0,
    look: { shell: { rimStrength: 0.55 },
            plate: { rimStrength: 1.0, rimColor: 0x8fe8ff },
            flesh: { rimStrength: 0.45 } },
    flat: ['eye'], hostile: true,
  },

  // BRUTE. Punishes greed. The wind-up is long enough to walk out of and the
  // damage is high enough that trading is never worth it -- it has the health
  // to survive a full chain, so it is the enemy the finisher exists for.
  bellow: {
    url: '/assets/bellow.glb', far: 46,
    hp: 150, radius: 0.78, height: 1.35, speed: 1.35,
    // A THIRD OF YOUR HEALTH. At 22 it was arithmetic -- trade two hits for a
    // chain and come out ahead -- which made the long, obvious wind-up
    // something to ignore rather than something to answer. At 32 there is no
    // version of standing in it that is worth doing, which is the whole design.
    notice: 14.0, strikeRange: 2.5, telegraph: 1.05, attackTime: 0.42,
    recoverTime: 1.5, damage: 32,
    // the slam lands late and wide, and NOTHING interrupts it once it starts --
    // this is the enemy that punishes greed, so greed has to be punishable
    impact: 0.62, hitArc: 2.5, poise: 999,
    look: { hide: { rimStrength: 0.55 },
            sack: { rimStrength: 1.0, rimColor: 0xffb060 },
            horn: { rimStrength: 1.0, rimColor: 0xfff0c0 } },
    // The sack is the tell, so it needs to hold its ember value in shadow AND
    // be able to pulse. `flat` makes a MeshBasicMaterial, which has no
    // `.emissive` at all -- so listing it here meant the wind-up pulse silently
    // skipped the one surface the whole design points at.
    flat: ['eye'], hostile: true,
  },

  // GRAZER, and the only thing out here that does not want to fight. It exists
  // so the meadow is inhabited before it is dangerous -- and as the palette
  // control: it is the one pale creature, so "dark shape" reliably means threat.
  woolt: {
    url: '/assets/woolt.glb', far: 21,
    hp: 45, radius: 0.46, height: 0.72, speed: 1.15,
    spook: 5.2, flee: 4.6, fleeTime: 2.6, startle: 0.45,
    look: { fleece: { rimStrength: 0.9 }, face: { rimStrength: 0.5 } },
    flat: ['eye'], hostile: false,
  },

  // The cheapest sense of consequence in the whole demo. A grazer that startles
  // is something you happen to notice; a dozen birds going up at once is the
  // field reacting to you having arrived. One 0.2 m mesh.
  flitter: {
    url: '/assets/flitter.glb', far: 16,
    hp: 8, radius: 0.16, height: 0.20, speed: 2.2,
    spook: 6.5, flee: 7.0, fleeTime: 3.4, startle: 0.16,
    flies: true, ceiling: 4.6,
    look: { coat: { rimStrength: 0.8 }, trim: { rimStrength: 0.9 } },
    flat: ['eye'], hostile: false,
  },
};

// ----------------------------------------------------------------- helpers

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fv = new THREE.Vector3();
const _hit = { x: 0, z: 0 };

// The colour each species owns, matched to its palette accent, used for the
// telegraph pulse. Kept out here so it is one allocation, not one per frame.
const TELL = {
  nettle: new THREE.Color(0xffe9a8),
  curler: new THREE.Color(0x63dcff),
  bellow: new THREE.Color(0xff7a26),
  _: new THREE.Color(0xffffff),
};

function pickClip(clips, want, fallback) {
  return clips[want] ? want : (clips[fallback] ? fallback : null);
}

// ------------------------------------------------------------------ system

export function createCombat(ctx) {
  // ctx: { scene, camera, world, groundAt, playerPos, playerFacing, hud }
  const loader = new GLTFLoader();
  const protos = {};
  const enemies = [];
  const fx = makeEffects(ctx.scene, ctx);

  let hitStop = 0;          // seconds of frozen time remaining
  const shake = { mag: 0, t: 0 };

  const player = {
    hp: TUNE.playerHP,
    maxHP: TUNE.playerHP,
    invuln: 0,
    step: -1,               // index into TUNE.combo, -1 = not attacking
    airChain: 0,            // pogos since last touching the ground
    lastStep: -1,           // the link that just ended, for comboWindow
    dodging: 0,             // seconds left in a slip
    stagger: 0,             // seconds of "you are not in control" after a hit
    knock: new THREE.Vector3(),
    hitEvent: 0,            // bumps once per hit taken, so main.js can react
    dodgeT: 0,
    dodgeCd: 0,
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
    // Kept so distance can switch them off. glTF splits a mesh per material, so
    // a four-material creature is four draws, doubled by outlines and again by
    // the shadow pass -- about twelve. Fifty of them living in the meadow cost
    // 616 draws and dropped the frame to 41 fps, and most of them were the size
    // of a fingernail on screen.
    const outlines = [];
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
        outlines.push(sk);
      } else {
        m.add(shell);
        shell.material.transparent = true;
        mats.push(shell.material);
        outlines.push(shell);
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
    return { group, mixer, clips, mats, meshes, outlines, spec, name,
             current: null, detail: true };
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
    e.seed = enemies.length * 3 + (Math.abs(Math.round(x)) % 5);
    e.wanders = 0;
    e.goal = null;
    e.fly = false;
    e.lockDir = null;
    e.spin = 0;
    e.home = e.pos.clone();
    play(e, 'idle', 0);
    enemies.push(e);
    return e;
  }

  // THE LEGS HAVE TO KEEP UP WITH THE GROUND.
  //
  // Every `move` clip is authored at one pace, and the AI drives speed from
  // spec.speed modified by knockback, slopes and crowding -- so the legs skated
  // whenever those disagreed. Scaling the clip to actual travel is one line and
  // it is the difference between a creature walking and a creature being slid.
  function matchGait(e, dt) {
    const clip = e.clips.move;
    if (!clip || e.current !== clip) return;
    const speed = Math.hypot(e.vel.x, e.vel.z);
    const want = THREE.MathUtils.clamp(speed / (e.spec.speed * 1.6), 0.35, 2.2);
    clip.timeScale += (want - clip.timeScale) * Math.min(1, dt * 12);
  }

  /**
   * The ONLY way an enemy changes state.
   *
   * `didHit` used to be set when an attack connected and cleared only in the
   * branch that completes the attack -- and `hurtEnemy` forces 'hurt', so an
   * enemy interrupted mid-swing never reached that branch. Its `didHit` stayed
   * true forever and it could never damage the player again for the rest of
   * its life. A swarm you had hit once was permanently harmless, and the check
   * that claimed "enemies can kill you" passed only because it never fought
   * back.
   *
   * Anything that is true "for this attack" gets cleared here, so there is no
   * exit from a state that can forget to.
   */
  function setState(e, name) {
    e.state = name;
    e.t = 0;
    if (name !== 'attack') {
      e.didHit = false;
      e.lockDir = null;
    }
    if (name !== 'telegraph' && name !== 'attack') e.poiseLeft = 0;
  }

  function play(e, name, fade = 0.14) {
    const next = e.clips[name];
    if (!next || next === e.current) return;
    next.reset().setEffectiveWeight(1).play();
    if (e.current) next.crossFadeFrom(e.current, fade, false);
    e.current = next;
  }

  // ------------------------------------------------------------ the combo

  /**
   * Start a slip if one is allowed. Returns the direction-agnostic timing the
   * movement code needs; main.js owns which way the player actually goes,
   * because it owns the camera basis that "left" is relative to.
   */
  function dodge() {
    if (player.dead || player.stagger > 0 || player.dodgeCd > 0) return null;
    // cancels a swing's recovery, but not its active frames: you do not get to
    // erase a whiff you are still in the middle of
    if (player.step >= 0 && player.phase !== 'recover') return null;
    player.step = -1;
    player.phase = 'none';
    player.dodging = TUNE.dodge.time;
    player.dodgeT = 0;
    player.dodgeCd = TUNE.dodge.cooldown;
    return TUNE.dodge;
  }

  /**
   * Give up the rest of a swing's recovery to jump.
   *
   * This is the route the moveset was missing: chain into the finisher, which
   * launches, cancel the long recovery, and meet the enemy in the air with the
   * falling cut. Without it the finisher throws something up and then makes you
   * watch it come down, which is a combo that punishes you for finishing it.
   *
   * Recovery only -- never the wind-up or the active frames, so a swing you
   * committed to still costs you the swing.
   */
  function jumpCancel() {
    if (player.dead || player.stagger > 0) return false;
    if (player.step < 0 || player.phase !== 'recover') return false;
    player.step = -1;
    player.phase = 'none';
    player.buffered = false;
    return true;
  }

  function attack(airborne = false) {
    // guarded HERE and not only in main.js's wrapper, so there is no way in
    // that skips it -- being hit has to actually cost you the swing
    if (player.dead || player.stagger > 0) return false;
    if (player.step < 0) {
      // CONTINUE THE CHAIN if the last one only just ended. `comboWindow` and
      // `sinceCombo` both existed and neither was ever read, so the checklist
      // line about the chain resetting after `comboWindow` described a
      // mechanism that was not there -- a swing that ended reset you to hit 1
      // no matter how quickly you followed it up.
      const cont = !airborne
        && player.lastStep >= 0
        && player.lastStep < TUNE.combo.length - 1
        && player.sinceCombo <= TUNE.comboWindow;
      startSwing(airborne ? AIR : (cont ? player.lastStep + 1 : 0));
      return true;
    }
    // buffered: a press at ANY point in the current swing lands the next one,
    // which is the difference between a combo that feels tight and one that
    // feels like it drops inputs
    player.buffered = true;
    return true;
  }

  function startSwing(i) {
    player.lastStep = -1;
    player.step = i;
    player.phase = 'windup';
    player.t = 0;
    player.buffered = false;
    player.sinceCombo = 0;
    player.hitThisSwing = new Set();
  }

  // The air swing is step AIR rather than an extra entry in `combo`, so it can
  // never be chained into or out of by the buffering logic -- it is a different
  // move, not a fourth hit.
  const AIR = 99;

  function specFor(i) {
    return i === AIR ? TUNE.air : TUNE.combo[Math.min(i, TUNE.combo.length - 1)];
  }

  function swingSpec() {
    return specFor(player.step);
  }

  function attackClipFor(clips, i) {
    return pickClip(clips, specFor(i).clip, 'attack');
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

  /** Lower is a better target. Infinity means not a target at all. */
  function targetScore(e) {
    _v.subVectors(e.pos, ctx.playerPos());
    const d = _v.length();
    if (d > TUNE.lockRange) return Infinity;
    _v.divideScalar(d || 1);
    const fwd = _v2.set(Math.sin(ctx.playerFacing()), 0, Math.cos(ctx.playerFacing()));
    // prefer things in front, but do not refuse something just behind you
    return d * (1.35 - 0.35 * _v.dot(fwd));
  }

  function nearestTarget(exclude = null) {
    let best = null, bestScore = Infinity;
    for (const e of validTargets()) {
      if (e === exclude) continue;
      const score = targetScore(e);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  // Cycle through ALL of them, in order of how good a target they are.
  // This used to be `nearestTarget(exclude: lockTarget)` -- strictly the
  // second-nearest -- so with three enemies you could toggle between two of
  // them forever and never select the third.
  function cycleLock() {
    const list = validTargets()
      .map((e) => ({ e, s: targetScore(e) }))
      .filter((x) => x.s < Infinity)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.e);
    if (!list.length) { lockTarget = null; return null; }
    const i = list.indexOf(lockTarget);
    lockTarget = list[(i + 1) % list.length];
    return lockTarget;
  }

  // -------------------------------------------------------------- damage

  function hurtEnemy(e, dmg, fromPos, knock, lift, stop, shakeMag, stun) {
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
      return;
    }

    // POISE. Every hit used to cancel every state, telegraph included -- and a
    // combo lands roughly every 0.31 s against a 0.52 s wind-up, so mashing
    // meant no tell in the game ever completed and none of them had to be
    // respected. A committed attack now has a damage budget: chip at it and it
    // flinches and keeps coming, break the budget and it staggers.
    //
    // The budget only exists while it is committed. Poking something that is
    // walking towards you still interrupts it, which is what makes closing the
    // distance the enemy's problem rather than a formality.
    const committed = e.state === 'telegraph' || e.state === 'attack';
    if (committed && (e.poiseLeft -= dmg) > 0) {
      e.flash = 0.16;                 // it registers, it just does not stop
      return;
    }

    // ...and the stun is the hit's, not a constant. A finisher that buys the
    // same 0.22 s as a jab makes the finisher pointless.
    e.hitLock = stun ?? 0.22;
    setState(e, 'hurt');
    play(e, 'hurt', 0.04);
  }

  function hurtPlayer(dmg, fromPos) {
    if (player.invuln > 0 || player.dead) return;
    // the slip's i-frames: a window inside the move, not the whole of it, so
    // it is a read rather than a panic button
    if (player.dodging > 0
        && player.dodgeT >= TUNE.dodge.iFrom && player.dodgeT <= TUNE.dodge.iTo) return;
    player.hp -= dmg;
    player.invuln = TUNE.playerIFrames;
    hitStop = Math.max(hitStop, 0.07);
    shake.mag = Math.max(shake.mag, 0.22);
    shake.t = 0.3;
    fx.number(ctx.playerPos().clone().setY(ctx.playerPos().y + 1.9), dmg, 0xff6b5a);
    fx.hurtFlash();

    // A HIT HAS TO COST YOU SOMETHING BESIDES A NUMBER.
    //
    // Until now this subtracted HP and drew a vignette, and the character kept
    // swinging as though nothing had happened -- so half of every exchange had
    // no weight in it at all. Now it cancels what you were doing and throws you,
    // and main.js turns the flag into a stagger and a knockback direction.
    player.step = -1;
    player.phase = 'none';
    player.buffered = false;
    player.dodging = 0;
    player.stagger = 0.34;
    _v.subVectors(ctx.playerPos(), fromPos).setY(0);
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
    player.knock.copy(_v.normalize()).multiplyScalar(dmg > 24 ? 5.0 : 3.0);
    player.hitEvent++;
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
    if (player.dodgeCd > 0) player.dodgeCd -= raw;
    if (player.stagger > 0) player.stagger -= raw;
    if (player.dodging > 0) { player.dodging -= raw; player.dodgeT += raw; }
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
        if (chainNow()) return;
      }
    } else if (player.phase === 'recover') {
      // A PRESS DURING RECOVERY CHAINS TOO.
      //
      // This used to fire only at the instant the active window closed, and the
      // recover branch cleared `buffered` without ever reading it. Windup plus
      // active is 0.21 s, so the entire input window for hit 2 was the first
      // fifth of a second of hit 1 -- press at a natural 0.3 s rhythm and the
      // chain silently restarted at hit 1 forever. Measured: pressing every
      // 18 or 24 frames produced step 0 and nothing else, and the demo's
      // headline mechanic was reachable only by mashing.
      if (chainNow()) return;
      if (player.t >= s.recover) {
        player.lastStep = player.step;
        player.sinceCombo = 0;
        player.step = -1;
        player.phase = 'none';
        player.buffered = false;
      }
    }
  }

  /** Start the next link if one is buffered and there is one to start. */
  function chainNow() {
    if (!player.buffered || player.step === AIR) return false;
    if (player.step >= TUNE.combo.length - 1) return false;
    startSwing(player.step + 1);
    return true;
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
      hurtEnemy(e, s.damage, p, s.knock, s.lift, s.stop, s.shake, s.stun);
      // combat.js does not own the player's vertical velocity, so it raises a
      // flag and the movement code decides what to do with it
      // DIMINISHING, or a perfect player never has to land. Each bounce
      // without touching the ground gives less than the last, so a juggle is a
      // few hits long by construction rather than by the player's patience.
      if (s.pogo) {
        player.pogo = s.pogo * Math.pow(0.74, player.airChain);
        player.airChain++;
      }
    }
  }

  // AMBIENT LIFE runs a different machine entirely, because it is answering a
  // different question. A hostile asks "how do I reach you"; this asks "am I
  // still allowed to eat". Sharing the combat states would have meant a grazer
  // holding an attack token and queueing up to not attack you.
  function spook(e) {
    e.state = 'startle'; e.t = 0;
    play(e, 'telegraph', 0.05);
  }

  function updateAmbient(e, dt, p, dist) {
    switch (e.state) {
      case 'idle':
      case 'graze':
        e.vel.multiplyScalar(0.80);
        e.fly = false;
        play(e, e.clips.graze ? 'graze' : 'idle');
        // wander off after a while, so a herd is never a static arrangement
        if (e.t > 5 + (e.seed % 7)) {
          const a = e.seed * 2.4 + e.wanders * 1.9;
          e.goal = new THREE.Vector3(
            e.home.x + Math.cos(a) * 3.4, 0, e.home.z + Math.sin(a) * 3.4);
          e.wanders++;
          e.state = 'wander'; e.t = 0;
        }
        break;

      case 'wander': {
        play(e, 'move');
        _v.subVectors(e.goal, e.pos).setY(0);
        const d = _v.length();
        if (d < 0.35 || e.t > 6) { e.state = 'graze'; e.t = 0; break; }
        faceToward(e, e.goal, dt, 3);
        e.vel.addScaledVector(_v.divideScalar(d), e.spec.speed * 6 * dt);
        break;
      }

      // head up, fleece puffed, weight already going backwards
      case 'startle':
        e.vel.multiplyScalar(0.7);
        faceToward(e, p, dt, 3);
        if (e.t >= e.spec.startle) { e.state = 'flee'; e.t = 0; play(e, 'attack', 0.05); }
        break;

      case 'flee': {
        if (e.spec.flies) {
          // climb to the ceiling and hold it. Gravity is off while `fly` is
          // set, so this is the only thing deciding altitude.
          e.fly = true;
          const want = (ctx.groundAt(e.pos.x, e.pos.z, e.pos.y + 3) ?? 0)
                     + e.spec.ceiling;
          e.vel.y += (want - e.pos.y) * 4.0 * dt - e.vel.y * 1.6 * dt;
        }
        _v.subVectors(e.pos, p).setY(0);
        if (_v.lengthSq() < 1e-6) _v.set(1, 0, 0);
        _v.normalize();
        // steer back toward home as it runs, or one walk across the meadow
        // empties the entire field of animals permanently
        _fv.subVectors(e.home, e.pos).setY(0);
        if (_fv.lengthSq() > 1) _v.addScaledVector(_fv.normalize(), 0.5).normalize();
        e.facing = Math.atan2(_v.x, _v.z);
        e.vel.addScaledVector(_v, e.spec.flee * 6 * dt);
        if (e.t > e.spec.fleeTime && dist > e.spec.spook * 1.6) {
          e.state = 'settle'; e.t = 0; play(e, 'recover', 0.1);
        }
        break;
      }

      case 'settle': {
        e.vel.x *= 0.90; e.vel.z *= 0.90;
        if (e.spec.flies) {
          // come down. It is on the ground when it is on the ground, not when
          // a timer says so -- a bird that finishes its landing in mid-air and
          // then drops is the single most obvious tell that nothing is real.
          const g = ctx.groundAt(e.pos.x, e.pos.z, e.pos.y + 3) ?? 0;
          e.vel.y += (g - e.pos.y) * 3.0 * dt - e.vel.y * 2.2 * dt;
          if (e.pos.y - g < 0.06) { e.fly = false; e.state = 'graze'; e.t = 0; }
          break;
        }
        if (e.t > 1.0) { e.state = 'graze'; e.t = 0; }
        break;
      }

      default:
        e.state = 'graze'; e.t = 0;
    }

    // being startled overrides everything except already running
    if (dist < e.spec.spook && e.state !== 'flee' && e.state !== 'startle') {
      spook(e);
      // PANIC IS CONTAGIOUS, and that is the entire point of the bird. One
      // going up is a detail; the flock going up together is the field
      // reacting to you. Only flocking species pass it on -- a grazer that
      // bolted because another grazer bolted would look telepathic.
      if (e.spec.flies) {
        for (const o of enemies) {
          if (o === e || o.dead || o.name !== e.name) continue;
          if (o.state === 'flee' || o.state === 'startle') continue;
          if (o.pos.distanceToSquared(e.pos) < 49) spook(o);
        }
      }
    }

    matchGait(e, dt);
    integrate(e, dt);
    e.group.position.copy(e.pos);
    e.group.rotation.y = e.facing;
  }

  // Beyond this an enemy is at its post and nobody is looking at it. Skinning
  // and drawing it costs the same as one in your face, and with five encounters
  // armed that was 280 draw calls for a fight involving four things.
  //
  // Ambient life cuts out much sooner than a hostile: you need to see a fight
  // coming from across the field, but a sheep you cannot make out is a sheep
  // that does not need to be drawn.
  const FAR = 42;

  // The outline is what the whole art style is made of, so this threshold sits
  // as far out as it can afford to -- at 45% of the cull distance the grazers
  // were losing their outlines inside ten metres and it read as a rendering bug.
  function setDetail(e, on) {
    if (e.detail === on) return;
    e.detail = on;
    // the outline is half the draws and it is one pixel wide at this range
    for (const o of e.outlines) o.visible = on;
    for (const m of e.meshes) m.castShadow = on;
  }

  function updateEnemy(e, dt) {
    const d2 = e.pos.distanceToSquared(ctx.playerPos());
    const cut = e.spec.far || FAR;
    const far = d2 > cut * cut;
    e.group.visible = !far;
    setDetail(e, d2 < (cut * 0.72) * (cut * 0.72));
    if (far && !e.dead) {
      // PARK IT PROPERLY. The first version froze whatever it was doing, which
      // meant a bird that crossed the cull line mid-flight hung in the air
      // forever and a leashed enemy walking home coasted to a stop in a field.
      // Both showed up in the smoke test as "3/6 back down" and "1/3 home".
      //
      // Nobody can see it, so the honest thing is to finish the journey for it:
      // resolve to its post, on the ground, at full health.
      // UNCONDITIONALLY back to its post. An earlier version skipped anything
      // already reading 'idle', which sounds like an optimisation and is
      // actually a hole: something idling far from home then stays there
      // forever, invisible, and the encounter it belongs to is quietly empty.
      // An enemy that IS at home makes this a no-op, so there is nothing to save.
      e.vel.set(0, 0, 0);
      e.fly = false;
      e.pos.copy(e.home);
      e.pos.y = ctx.groundAt(e.home.x, e.home.z, e.home.y + 3) ?? e.home.y;
      e.hp = e.spec.hp;
      e.token = false;
      e.lockDir = null;
      e.state = 'idle';
      e.t = 0;
      e.group.position.copy(e.pos);
      return;
    }
    e.mixer.update(dt);
    if (e.flash > 0) e.flash -= dt;

    // THE WIND-UP GLOWS.
    //
    // Every tell in this game is a shape change, which is the right idea and
    // reads beautifully at four metres -- and at fighting distance an enemy is
    // about forty-five pixels tall, where a silhouette change is a smudge
    // becoming a slightly different smudge. So the tell also pulses, in the
    // species' own accent: bone for the swarmer, cyan for the charger, ember
    // for the brute. Colour survives at any size the shape does not.
    const winding = e.state === 'telegraph';
    const pulse = winding
      ? 0.30 + 0.34 * Math.sin(e.t / Math.max(0.08, e.spec.telegraph) * 11.0)
      : 0;
    for (const m of e.mats) {
      if (!m.emissive) continue;
      if (e.flash > 0) m.emissive.setScalar(0.55);
      else if (pulse > 0) m.emissive.copy(TELL[e.name] || TELL._).multiplyScalar(pulse);
      else m.emissive.setScalar(0);
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

    if (!e.spec.hostile) { updateAmbient(e, dt, p, dist); return; }

    // LEASH. Without one, everything you ever woke follows you forever, and by
    // the far end of the walk you are being trailed by every fight you declined.
    // An encounter should be a place, so each one goes home when you leave it --
    // but only from states where breaking off is not a cheat. Something mid-swing
    // finishes its swing.
    // Two ways to break off. Distance from HOME is the territorial one -- it
    // will not chase you across the county. Distance from YOU is the honest
    // one: with no pathfinding, an enemy chasing you out of the plaza wedges
    // against the gateway wall, and while it is stuck it never gets far enough
    // from home to trip the first test at all. Measured: one of three sat at
    // 15.1 m from its post indefinitely with the leash threshold at 18 m.
    if (LEASHABLE.has(e.state)
        && (e.pos.distanceTo(e.home) > e.spec.notice * 1.5
            || dist > e.spec.notice * 2.2)) {
      setState(e, 'return'); e.token = false;
    }

    switch (e.state) {
      case 'idle':
        if (dist < e.spec.notice) { setState(e, 'approach'); play(e, 'move'); }
        else play(e, 'idle');
        break;

      // walk back and forget about you -- and it heals on the way, so a
      // hit-and-run down the path is not a way to whittle a group down for free
      case 'return': {
        play(e, 'move');
        _v.subVectors(e.home, e.pos).setY(0);
        const d = _v.length();
        e.hp = Math.min(e.spec.hp, e.hp + e.spec.hp * 0.35 * dt);
        if (d < 0.6) { setState(e, 'idle'); e.hp = e.spec.hp; break; }
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
          setState(e, 'telegraph'); e.token = true;
          e.poiseLeft = e.spec.poise ?? 0;
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
          setState(e, 'attack');
          e.poiseLeft = e.spec.poise ?? 0;
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
        // AN ATTACK IS A SHAPE IN SPACE AT A MOMENT IN TIME.
        //
        // This used to be `dist < strikeRange + 0.55 && t > 0.05` -- a
        // facing-less sphere that fired 0.05 s into the state it had just
        // entered *because* you were in range. It could not miss, it hit you
        // from behind, and it landed before the animation moved. That deleted
        // both designs the roster is built on: there was no line to step off
        // the Curler's charge, and no wind-up to walk out of on the Bellow.
        // A CHARGE IS A COLLISION, NOT A SWING.
        //
        // The Curler's whole design is that it commits to a line you can step
        // off, and it did not work: the hit fired 0.10 s into the charge inside
        // a 63-degree cone, which at 2.3 m is over a metre wide either side --
        // a sidestep of 0.3 m in that time never got out of it. Measured:
        // strafing was hit at 2.26 m, standing still at 1.74 m, which is the
        // enemy's own puzzle failing.
        //
        // So a charger tests CONTACT, continuously, at body width. Step a metre
        // aside and it goes past you, which is the thing the animation, the
        // committed `lockDir` and the 1.7x whiff penalty have all been
        // promising since it was built.
        const contact = !!e.spec.charge;
        const openAt = contact ? 0 : e.spec.attackTime * (e.spec.impact ?? 0.35);
        if (!e.didHit && e.t >= openAt) {
          _v.subVectors(p, e.pos).setY(0);
          const d2 = _v.length();
          const facing = e.lockDir
            ? Math.atan2(e.lockDir.x, e.lockDir.z)
            : e.facing;
          const dot = d2 > 1e-4
            ? (_v.x / d2) * Math.sin(facing) + (_v.z / d2) * Math.cos(facing)
            : 1;
          const reach = contact ? e.spec.radius + 0.62 : e.spec.strikeRange + 0.35;
          const arc = contact ? 1.5 : (e.spec.hitArc ?? 1.7);
          if (d2 < reach && dot > Math.cos(arc / 2)) {
            e.didHit = true;
            hurtPlayer(e.spec.damage, e.pos);
          }
        }
        if (e.t >= e.spec.attackTime) {
          // A CHARGE THAT MISSES COSTS MORE THAN ONE THAT LANDS. Stepping aside
          // is the answer to the Curler, so stepping aside has to be worth
          // something -- otherwise dodging and tanking have the same price and
          // the enemy has no puzzle in it.
          e.recoverScale = (e.spec.charge && !e.didHit) ? 1.7 : 1;
          setState(e, 'recover');
          play(e, 'recover', 0.06);
        }
        break;

      case 'recover':
        e.vel.multiplyScalar(0.84);
        if (e.t >= e.spec.recoverTime * (e.recoverScale || 1)) {
          setState(e, 'approach'); e.token = false; e.recoverScale = 1;
        }
        break;

      case 'hurt':
        if (e.hitLock <= 0) { setState(e, 'approach'); e.token = false; }
        break;
    }

    matchGait(e, dt);
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

    // The same box push-out the player uses. Without it a charging Curler goes
    // through a tree trunk, which is the sort of thing you only have to see
    // once. Fliers are exempt: they are above everything by design, and a bird
    // shoved sideways by a rock it is four metres over looks worse than a bird
    // that ignores it.
    if (ctx.pushOut && !e.fly) {
      _hit.x = e.pos.x; _hit.z = e.pos.z;
      ctx.pushOut(_hit, e.spec.radius);
      e.pos.x = _hit.x; e.pos.z = _hit.z;
    }

    e.vel.x *= Math.pow(0.02, dt);
    e.vel.z *= Math.pow(0.02, dt);
    if (!e.fly) e.vel.y -= 22 * dt;
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
    dodge,
    jumpCancel,
    // the smoke test lands a hit through the real path rather than
    // reaching into player.hp, so i-frames and the slip are actually exercised
    hurtPlayerForTest: (dmg, from) => hurtPlayer(dmg, from),
    isDodging: () => player.dodging > 0,
    isStaggered: () => player.stagger > 0,
    // HIT-STOP HAS TO BE GLOBAL. It scaled combat's own dt and nothing else, so
    // during a 55 ms stop the swing's state machine advanced 3.3 ms while its
    // clip advanced the full 55 -- every connected hit shoved the animation
    // ~17x ahead of its own hitbox windows.
    timeScale: () => (hitStop > 0 ? 0.06 : 1),
    dodgePhase: () => player.dodgeT,
    isAttacking: () => player.step >= 0,
    isAirSwing: () => player.step === AIR,
    takePogo: () => { const v = player.pogo; player.pogo = 0; return v; },
    landed: () => { player.airChain = 0; },
    airChain: () => player.airChain,
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

function makeEffects(scene, ctx = {}) {
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
      // Hidden behind the near plane OR behind the world. A number that floats
      // in front of the hill an enemy died on tells you the number and lies
      // about where it happened; the same test the lock ring gets.
      const occluded = ctx.occludes ? ctx.occludes(n.at) : false;
      n.el.style.display = (p.z > 1 || occluded) ? 'none' : '';
    }
  }

  return { spark, number, update, hurtFlash };
}
