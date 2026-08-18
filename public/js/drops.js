// drops.js -- the thing a kill leaves on the ground, and picking it up.
//
// WHY THIS EXISTS.  The economy was wired to the fight and completely invisible
// from inside it. `onKill` granted xp, added gold and rolled the drop table, and
// every one of those was a number changing inside a save file: you killed a
// creature, nothing happened, and the only way to find out you had been paid was
// to stop playing and open a menu with Esc. The user's words were "i didn't see
// any items or visual artifacts drop when i killed monsters" -- which is the
// same rule that got the bell rope built, one system further on. An effect you
// cannot see from where you trigger it is not a feature.
//
// SO THE REWARD IS AN OBJECT, NOT AN EVENT. It bursts out of the body, arcs,
// lands, sits there glowing and turning, and you walk over it. That is three
// separate readable moments -- something came out, something is on the ground,
// you got it -- against nothing at all, and the middle one is the important
// one, because it is the only part that survives you looking away at the moment
// of the kill.
//
// IT REUSES THE GAME'S EXISTING LANGUAGE FOR "WORTH PICKING UP". Embercaps are
// the find this world already taught you to want: small, warm, flat-lit so they
// glow under a toon ramp. A drop is the same read at the same size, tinted by
// what kind of thing it is, so it needs no legend.

import * as THREE from 'three';
import { flatMaterial, outlineMaterial, outlineGeometry } from './toon.js';

// How near you have to be. Generous on purpose: hunting for a 12 cm object on
// cobbles with a camera five metres back is not gameplay, it is an eye test.
const PICKUP = 1.5;
// ...but not instant, or a drop that lands under your feet is collected before
// the toss has read as a toss.
const ARM = 0.45;
const LIFE = 30;            // seconds before it gives up and collects itself
const G = 15.0;             // gravity on the toss; lighter than the player's

// WHAT EACH KIND OF THING LOOKS LIKE. One glance has to say "money" or "stuff"
// without a label, and colour is the only channel available at this size.
// SIZED TO BE SEEN FROM THE CAMERA, not to be plausible in the hand. The first
// pass used 8-11 cm, which is about right for a coin and is four pixels on a
// cobbled square from a boom five metres back -- a capture of three of them
// found one. These are 20-26 cm: too big for what they are, and the only size
// at which "something is lying there" reads at a glance.
const LOOK = {
  gold:       { color: 0xffd25a, r: 0.20, spin: 3.4 },
  material:   { color: 0xffb454, r: 0.24, spin: 2.1 },
  consumable: { color: 0x7fe0a8, r: 0.23, spin: 2.4 },
  weapon:     { color: 0xbcd8ff, r: 0.26, spin: 1.7 },
  armor:      { color: 0xbcd8ff, r: 0.26, spin: 1.7 },
  keepsake:   { color: 0xe4a8ff, r: 0.24, spin: 1.4 },
};

export function makeDrops({ scene, groundAt, playerPos, toast }) {
  const live = [];
  const pool = [];
  // ONE geometry, shared. An octahedron rather than a sphere: at 10 cm it is
  // the flat facets that catch the key light and make the thing legible as it
  // turns, and a smooth ball at this size is a dot.
  const geo = new THREE.OctahedronGeometry(1, 0);
  // AND IT IS OUTLINED, like everything else in this world. A flat-lit solid
  // with no shell is the one object in the game drawn in a different language,
  // and at this size the outline is most of what carries it against paving.
  const shell = outlineGeometry(geo);
  const mats = new Map();
  const matFor = (c) => {
    if (!mats.has(c)) mats.set(c, flatMaterial(new THREE.Color(c)));
    return mats.get(c);
  };
  // wider than a character's, because the object is small and the shell is a
  // fixed width in SCREEN space -- the same reason grass has none at all
  const outline = outlineMaterial(0x2a2233, 0.010);

  /**
   * Throw one out of a body.
   *
   * @param kind  an items.json `type`, or 'gold'
   * @param at    where it comes from -- the corpse, not the ground under it
   * @param label what to say when it is picked up; null for gold, which says
   *              its own amount
   */
  function spawn(kind, at, label, onCollect) {
    const look = LOOK[kind] || LOOK.material;
    let m = pool.pop();
    if (!m) {
      m = new THREE.Mesh(geo, matFor(look.color));
      const o = new THREE.Mesh(shell, outline);
      o.userData.isOutline = true;
      m.add(o);                      // a child, so it follows the spin for free
    }
    m.material = matFor(look.color);
    m.scale.setScalar(look.r);
    m.position.copy(at);
    m.visible = true;
    scene.add(m);
    const a = Math.random() * Math.PI * 2;
    // OUT AND UP. A drop that falls straight down is hidden by the corpse for
    // the whole of its arc, which is the one second it has to be noticed in.
    const speed = 1.5 + Math.random() * 1.1;
    live.push({
      m, kind, label, onCollect,
      vx: Math.cos(a) * speed, vy: 4.2 + Math.random() * 1.4, vz: Math.sin(a) * speed,
      spin: look.spin * (Math.random() < 0.5 ? -1 : 1),
      t: 0, landed: false, floor: null, taken: false,
    });
    return m;
  }

  const _p = new THREE.Vector3();

  function update(dt) {
    const p = playerPos();
    for (let i = live.length - 1; i >= 0; i--) {
      const d = live[i];
      d.t += dt;
      if (!d.landed) {
        d.vy -= G * dt;
        d.m.position.x += d.vx * dt;
        d.m.position.y += d.vy * dt;
        d.m.position.z += d.vz * dt;
        if (d.floor === null || d.t % 0.25 < dt) {
          const g = groundAt(d.m.position.x, d.m.position.z, d.m.position.y + 1.2);
          if (g !== null) d.floor = g;
        }
        const rest = (d.floor === null ? 0 : d.floor) + 0.14;
        if (d.vy < 0 && d.m.position.y <= rest) {
          d.m.position.y = rest;
          d.landed = true;
        }
      } else {
        // A BOB WITH REAL TRAVEL. At 9 cm/s of amplitude this was a tremor; the
        // motion is the only thing that says "pick me up" once the toss is over,
        // so it hovers a hand's breadth off the ground and takes its time.
        const rest = (d.floor === null ? 0 : d.floor) + 0.14;
        d.m.position.y = rest + 0.12 + Math.sin(d.t * 2.6) * 0.10;
      }
      d.m.rotation.y += d.spin * dt;
      d.m.rotation.x += d.spin * 0.4 * dt;

      // COLLECT. Distance in the horizontal plane plus a loose vertical gate,
      // so a drop that fell off a roof is not collected from underneath it.
      const dx = d.m.position.x - p.x, dz = d.m.position.z - p.z;
      const near = d.t > ARM
        && Math.hypot(dx, dz) < PICKUP
        && Math.abs(d.m.position.y - p.y) < 2.2;
      if (near || d.t > LIFE) {
        collect(d);
        live.splice(i, 1);
      }
    }
  }

  function collect(d) {
    if (d.taken) return;
    d.taken = true;
    scene.remove(d.m);
    d.m.visible = false;
    pool.push(d.m);
    try { if (d.onCollect) d.onCollect(); } catch (e) { console.error('[drop]', e); }
    if (toast && d.label) toast(d.label, d.kind);
  }

  return {
    spawn, update,
    get count() { return live.length; },
    /** For probes: everything currently on the ground. */
    debug: () => live.map((d) => `${d.kind}${d.landed ? '' : '(air)'}`).join(' '),
    /** Collect the lot -- used when the fight is reset under a probe. */
    clear() { for (const d of live) collect(d); live.length = 0; },
  };
}
