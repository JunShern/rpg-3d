// party.js -- the two people who walk with you, and fight next to you.
//
// THIS IS THE THING THAT MAKES IT A JRPG. Not the menus, not the levels, not
// the shops -- those had all shipped and the game was still one person alone
// in a field. Kingdom Hearts is Sora and two others; Final Fantasy is a row of
// portraits. The party is the form.
//
// AND THE PIECES WERE ALREADY HERE, which is the galling part. Lake and Maren
// are fully built rigs with ten animation clips and a sword each; they are in
// `growth.json` with `active:false` and a `joinFlag`; they have painted cut-in
// portraits and dialogue. Everything was in place except anybody walking.
//
// THREE RULES THEY FOLLOW, all of them about legibility rather than realism:
//
//  1. THEY KEEP UP BUT NEVER ARRIVE. A follower that reaches its slot and
//     stops reads as a pet. The slots are behind and to the side, they are
//     never quite reached at speed, and the gap grows when you sprint -- so
//     they look like people following you rather than attached to you.
//  2. THEY DO NOT COLLIDE WITH YOU. A companion that can body-block the player
//     in a doorway is the single most hated thing in this genre.
//  3. THEY CANNOT DIE. There is no party-wipe state in a twenty-minute demo and
//     a downed ally would be a failure mode with no recovery built. They get
//     knocked down and get back up.

import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// Where each member sits relative to the player, in the player's own frame:
// [right, back]. Both behind, on opposite shoulders, at different distances so
// the three of you form a triangle rather than a rank.
const SLOTS = [[-1.55, 2.10], [1.70, 2.65]];

const RUN = 5.2;             // a touch faster than the player, or they trail off
const NEAR = 1.15;           // close enough to the slot to stand still
const TELEPORT = 26;         // fall this far behind and just catch up

export function makeParty({ scene, chars, groundAt, getCombat, sfx }) {
  const members = [];
  let enabled = true;
  // LAZILY. The party is built when the character rigs finish loading and
  // `combat` is assigned later in the same file, so capturing it here would
  // capture undefined -- and the failure would be silent: everybody follows
  // you around perfectly and simply never fights.
  const C = () => (getCombat ? getCombat() : null);

  function add(def) {
    const src = chars[def.rig];
    if (!src) { console.warn('[party] no rig', def.rig); return null; }
    const group = new THREE.Group();
    const root = skeletonClone(src.group.children[0]);
    root.visible = true;
    root.traverse((o) => { o.frustumCulled = false; });
    group.add(root);
    scene.add(group);

    const mixer = new THREE.AnimationMixer(root);
    const clips = {};
    for (const c of src.rawClips || []) {
      const a = mixer.clipAction(c);
      if (/attack|hurt|land|jump/.test(c.name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      clips[c.name] = a;
    }
    const m = {
      id: def.id, name: def.name, slot: def.slot | 0,
      group, mixer, clips, cur: null,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      yaw: 0, state: 'idle', t: 0,
      target: null, swing: 0, cool: 0, atk: def.atk || 9,
      // so a probe can prove they are doing something
      hits: 0,
    };
    if (clips.idle) { clips.idle.play(); m.cur = clips.idle; }
    members.push(m);
    return m;
  }

  function play(m, name, fade = 0.15) {
    const a = m.clips[name];
    if (!a || a === m.cur) return;
    a.reset().setEffectiveWeight(1).play();
    if (m.cur) a.crossFadeFrom(m.cur, fade, false);
    m.cur = a;
  }

  /** Put everyone at the player, facing where the player faces. */
  function warp(px, pz, facing) {
    for (const m of members) {
      const [rx, bz] = SLOTS[m.slot % SLOTS.length];
      const sx = px + Math.cos(facing) * rx - Math.sin(facing) * bz;
      const sz = pz - Math.sin(facing) * rx - Math.cos(facing) * bz;
      const g = groundAt(sx, sz, 6);
      m.pos.set(sx, g === null ? 0 : g, sz);
      m.vel.set(0, 0, 0);
      m.yaw = facing;
      m.group.position.copy(m.pos);
      m.group.rotation.y = facing;
      m.target = null; m.state = 'idle'; m.swing = 0;
    }
  }

  const _v = new THREE.Vector3();

  function update(dt, player, facing) {
    if (!enabled || !dt) return;
    for (const m of members) {
      m.mixer.update(dt);
      m.t += dt;
      m.cool = Math.max(0, m.cool - dt);

      // ---- what am I doing? -------------------------------------------
      // A companion picks its own target rather than copying the player's,
      // because two people hitting the same thing looks like one person with
      // an echo -- and because a swarm is exactly when you want them spread.
      const combat = C();
      if (combat && combat.nearestHostile) {
        const t = combat.nearestHostile(m.pos.x, m.pos.z, 13);
        // keep the current target while it lives; switching every frame makes
        // them jitter between two enemies equidistant from them
        if (!m.target || m.target.dead
            || Math.hypot(m.target.pos.x - m.pos.x, m.target.pos.z - m.pos.z) > 16) {
          m.target = t;
        }
      }

      let goalX, goalZ, want;
      const fighting = !!(m.target && !m.target.dead);
      if (fighting) {
        // stand off at sword length, on the side they approached from
        const dx = m.pos.x - m.target.pos.x, dz = m.pos.z - m.target.pos.z;
        const d = Math.max(1e-3, Math.hypot(dx, dz));
        const stand = (m.target.spec.radius || 0.5) + 1.05;
        goalX = m.target.pos.x + (dx / d) * stand;
        goalZ = m.target.pos.z + (dz / d) * stand;
        want = Math.atan2(m.target.pos.x - m.pos.x, m.target.pos.z - m.pos.z);
      } else {
        const [rx, bz] = SLOTS[m.slot % SLOTS.length];
        goalX = player.x + Math.cos(facing) * rx - Math.sin(facing) * bz;
        goalZ = player.z - Math.sin(facing) * rx - Math.cos(facing) * bz;
        want = null;
      }

      const gx = goalX - m.pos.x, gz = goalZ - m.pos.z;
      const gd = Math.hypot(gx, gz);

      // FELL BEHIND A WALL OR OFF A ROOF. There is no pathfinding here by
      // design -- they walk at you -- so the recovery for "stuck" is to
      // reappear, and it is better than watching somebody grind into a corner
      // for the rest of the demo.
      if (Math.hypot(player.x - m.pos.x, player.z - m.pos.z) > TELEPORT) {
        warp(player.x, player.z, facing);
        continue;
      }

      const moving = gd > NEAR || fighting && gd > 0.35;
      if (moving) {
        const sp = Math.min(RUN, gd * 3.2);
        m.pos.x += (gx / gd) * sp * dt;
        m.pos.z += (gz / gd) * sp * dt;
        if (want === null) want = Math.atan2(gx, gz);
      }
      // ease onto the ground rather than snapping, so a step up a kerb is a
      // step rather than a teleport
      const g = groundAt(m.pos.x, m.pos.z, m.pos.y + 1.6);
      if (g !== null) m.pos.y += (g - m.pos.y) * Math.min(1, dt * 12);

      if (want === null) want = facing;
      const turn = ((want - m.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      m.yaw += turn * Math.min(1, dt * 9);

      m.group.position.copy(m.pos);
      m.group.rotation.y = m.yaw;

      // ---- swing -------------------------------------------------------
      if (m.swing > 0) {
        m.swing -= dt;
        // the blow lands part-way through, like the player's does
        if (m.swing <= 0.16 && !m.landed) {
          m.landed = true;
          if (m.target && !m.target.dead
              && Math.hypot(m.target.pos.x - m.pos.x, m.target.pos.z - m.pos.z) < 2.3) {
            C().allyHit(m.target, m.atk, m.pos);
            m.hits++;
            if (sfx) sfx('hit_soft', m.pos, 0.55);
          }
        }
        if (m.swing <= 0) { m.landed = false; play(m, 'idle', 0.2); }
      } else if (fighting && gd < 0.9 && m.cool <= 0) {
        // THE COOLDOWN IS LONG ON PURPOSE. Two allies swinging at the player's
        // rate trivialises every fight in the game and takes the kill away
        // from you -- they are support, and the demo's combat was tuned for
        // one sword.
        m.cool = 1.15 + Math.random() * 0.5;
        m.swing = 0.42;
        m.landed = false;
        play(m, ['attack', 'attack2'][(Math.random() * 2) | 0], 0.08);
        if (sfx) sfx('swing', m.pos, 0.4);
      } else if (m.swing <= 0) {
        play(m, moving ? 'run' : 'idle', 0.18);
      }
    }
  }

  return {
    add, update, warp,
    get members() { return members; },
    get size() { return members.length; },
    has: (id) => members.some((m) => m.id === id),
    set enabled(v) {
      enabled = !!v;
      for (const m of members) m.group.visible = !!v;
    },
    get enabled() { return enabled; },
    /** Take everybody off the field -- for a cutscene that stages them by hand. */
    hide(v) { for (const m of members) m.group.visible = !v; },
    at: (id) => members.find((m) => m.id === id) || null,
    _debug: () => members.map((m) =>
      `${m.id}@(${m.pos.x.toFixed(1)},${m.pos.z.toFixed(1)}) ${m.state}` +
      `${m.target ? ' ->' + m.target.name : ''} hits:${m.hits}`).join(' | '),
  };
}
