// smoke.mjs -- play the game and assert that it worked.
//
// WHY THIS EXISTS.  Every check in this project so far has been a probe typed
// into a console once and then lost.  That is fine for finding a bug and
// useless for knowing it stayed fixed, and this build has re-broken the same
// class of thing more than once -- a swing whose hitbox opens before the blade
// arrives has now been fixed twice, in two different moves.
//
// COMBAT-BAR.md's rule is that nothing is marked done on the strength of a
// screenshot.  This file is what that rule points at.
//
// IT DRIVES THE REAL GAME.  Not a mock: headless Chromium, the actual renderer,
// the actual GLBs, stepped through `__sim` so a frame is a frame and there is
// no wall-clock flakiness.  Enemies are PINNED wherever a test needs a
// stationary target, because an assertion that fails when a nettle happens to
// dart left is an assertion nobody will trust -- and an untrusted assertion
// gets commented out, which is worse than not having written it.
//
// EVERY CHECK HERE CAN FAIL.  If a property is not actually measurable from
// script, it does not get a passing stub -- it stays in COMBAT-BAR's open
// faults where it is visible.
//
//   node tools/smoke.mjs                  # against http://localhost:3100
//   node tools/smoke.mjs http://host:port
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:3100/';

const results = [];
let page;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '\x1b[32m  ok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${mark}  ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}

/** Run `fn(arg)` in the page. It returns {ok, detail}; a throw is a failure. */
async function check(name, fn, arg) {
  try {
    const r = await page.evaluate(fn, arg);
    record(name, !!(r && r.ok), r && r.detail);
  } catch (err) {
    record(name, false, String(err.message || err).split('\n')[0].slice(0, 170));
  }
}

const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);

// Headless renders every stepped frame, so "wait ten seconds for the AI to do
// something" is the expensive part of this suite, not the assertions. Anything
// measuring behaviour rather than physics runs at a coarser dt: same game time,
// a third of the draws. Physics-precision checks stay at 1/60.
const SLOW = '1/20';

// --------------------------------------------------------------- page helpers
//
// `pinned` is the important one: it parks a live enemy at a fixed spot and
// holds it there through every stepped frame, so a test measures the move under
// test and nothing else.
// Injected into the page as a FUNCTION, not a string.
//
// This started as a template literal and a backtick inside a JSDoc comment
// silently terminated it -- twice. Playwright serialises a function for you, so
// there is no quoting to get wrong. The identifiers below are page globals; a
// linter reading this file will not know them.
/* eslint-disable no-undef */
function installHelpers() {
  window.__t = {
    species(name) {
      return combat.enemies.filter((e) => e.name === name && !e.dead);
    },

    /** Park an enemy at (x,z), on the ground, and hold it there while stepping. */
    pinned(name, x, z) {
      const e = window.__t.species(name)[0];
      if (!e) throw new Error('no live ' + name);
      // ON THE GROUND, explicitly. faceOff parks the other hostiles far outside
      // the world, where groundAt returns null and nothing stops them falling --
      // so re-pinning one of those later put it a few hundred metres down with a
      // huge downward velocity, and "the finisher launches" read 0.0 m/s of lift
      // on an enemy that was in free fall.
      const gy = __groundAt(x, z, 6) ?? 0;
      // ITS POST MOVES WITH IT. An enemy far from home leashes, and the leash
      // heals at 35% of max HP per second -- which out-healed the ground chain
      // and made "the Curler dies" fail after 24 swings and 288 damage.
      if (!e.home0) e.home0 = e.home.clone();
      e.home.set(x, gy, z);
      const hold = () => {
        e.pos.set(x, gy, z);
        e.vel.set(0, 0, 0);
        e.state = 'idle';
        e.hitLock = 0;
      };
      hold();
      const self = { e, hold, aim: null, step(n) {
        let r;
        for (let i = 0; i < n; i++) { r = __sim({ steps: 1 }); hold(); if (self.aim) self.aim(); }
        return r;
      } };
      return self;
    },

    /**
     * Stand the player `back` metres behind a pinned target, aimed at it and at
     * nothing else.
     *
     * The "nothing else" is load-bearing and cost an hour: lock-on takes the
     * nearest valid enemy, which is not necessarily the one a test pinned, and
     * a swing arc is a cone around whatever the player is facing. So three
     * swings landed cleanly on a nettle nobody was measuring while the pinned
     * one sat at 40 HP and the assertion read "the finisher does not launch".
     *
     * So: every other hostile is parked out of the county, and facing is set by
     * the __face hook rather than by lock-on, which has its own test. Crowd
     * behaviour has its own tests too; this one is about the swing.
     */
    faceOff(name, x, z, back) {
      // DRAIN THE PREVIOUS TEST'S SWING FIRST. combat.attack() only starts a
      // new chain when nothing is running; otherwise it buffers into whatever
      // is. A check that inherited a half-finished combo from the check before
      // it reported "NOTHING LANDED" while the move worked perfectly by hand.
      for (let i = 0; i < 90 && combat.attackPhase() !== 'none'; i++) __sim({ steps: 1 });
      const t = window.__t.pinned(name, x, z);
      // Move their HOME as well as their position. The distance cull sends
      // anything out of sight back to its post, so parking a body without
      // moving its post just teleports it straight back -- and then the swing
      // under test happens inside a mob, where hit-stop stretches every frame
      // budget this file assumes.
      for (const o of combat.enemies) {
        if (o === t.e || o.dead || !o.spec.hostile) continue;
        // remember where it actually belongs BEFORE the first move. Restoring
        // by subtracting a fixed offset breaks the moment a second faceOff
        // parks the same enemy again -- which quietly relocated the entire
        // plaza group to wherever the last kill test happened.
        if (!o.home0) o.home0 = o.home.clone();
        o.home.set(x + 300, o.home.y, z + 300);
        o.pos.set(x + 300, o.pos.y, z + 300);
        o.state = 'idle';
        o.vel.set(0, 0, 0);
      }
      __sim({ warp: [x, 6, z + back], steps: 2 });
      t.hold();
      if (combat.lockTarget) combat.toggleLock();
      t.step(6);
      t.aim = () => __face(x, z);
      t.aim();
      return t;
    },

    /** Swing the real ground chain at a pinned target until it dies. */
    killPinned(t, cap) {
      let swings = 0;
      while (!t.e.dead && swings < cap) {
        combat.attack();
        for (let i = 0; i < 30 && combat.attackPhase() !== 'none'; i++) t.step(1);
        combat.player.hp = combat.player.maxHP;   // isolate: can it be killed
        swings++;
      }
      return swings;
    },

    frameMs(n) {
      const t = [];
      for (let i = 0; i < n; i++) {
        const a = performance.now(); __sim({ steps: 1 }); t.push(performance.now() - a);
      }
      t.sort((a, b) => a - b);
      return t[Math.floor(n / 2)];
    },

    heroXZ() { const p = __sim({ steps: 0 }).heroPos; return [p[0], p[2]]; },
  };
}
/* eslint-enable no-undef */

async function run() {
  const browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('typeof window.__sim === "function"', null, { timeout: 60000 });
  await page.waitForFunction(
    'window.combat && combat.enemies.length > 0 && __sim({steps:1}).who', null, { timeout: 60000 });
  await page.evaluate(installHelpers);

  group('World');

  await check('every character has all nine clips', () => {
    const want = ['airattack', 'attack', 'attack2', 'attack3', 'dodge',
                  'idle', 'jump', 'land', 'run'];
    const bad = [];
    for (const name of ['vesper', 'lake', 'maren']) {
      const got = __clipNames(name);
      if (!got) { bad.push(`${name}:absent`); continue; }
      for (const w of want) if (!got.includes(w)) bad.push(`${name}:${w}`);
    }
    return { ok: !bad.length, detail: bad.length ? bad.join(',') : 'vesper, lake, maren' };
  });

  await check('all five species are loaded and alive', () => {
    // encounters ARM on approach, so the route has to be walked before asking
    // what lives on it -- at spawn only the plaza group exists
    for (let z = 0; z >= -100; z -= 6) {
      __sim({ warp: [z > -20 ? 0.5 : 1 + (-z - 20) * 0.19, 6, z], steps: 4, dt: 1 / 20 });
    }
    const want = ['nettle', 'curler', 'bellow', 'woolt', 'flitter'];
    const have = new Set(combat.enemies.filter((e) => !e.dead).map((e) => e.name));
    const missing = want.filter((w) => !have.has(w));
    return { ok: !missing.length, detail: missing.length ? `missing ${missing}` : want.join(', ') };
  });

  await check('the terrain port agrees with the builder', () => {
    const r = terrain.check(__terrainProbes);
    return { ok: r.n > 0 && r.worst < 1e-4, detail: `${r.n} probes, worst ${r.worst} m` };
  });

  await check('plaza and meadow are one continuous walk', () => {
    const ys = [];
    for (let z = 4; z >= -76; z -= 4) {
      const px = z > -20 ? 0.5 : 1 + (-z - 20) * 0.19;
      ys.push(+__sim({ warp: [px, 6, z], steps: 4 }).heroPos[1].toFixed(2));
    }
    let worst = 0;
    for (let i = 1; i < ys.length; i++) worst = Math.max(worst, Math.abs(ys[i] - ys[i - 1]));
    return { ok: worst < 2.5 && Math.max(...ys) > 1.5,
             detail: `climbs to ${Math.max(...ys)} m, worst step ${worst.toFixed(2)} m` };
  });

  group('Lock-on and combo');

  await check('lock-on acquires, and never holds a dead target', () => {
    const t = window.__t.faceOff('nettle', 0.5, 6.2, 1.5);
    combat.toggleLock();                       // faceOff aims by hook, not by lock
    const got = combat.lockTarget;
    if (!got) return { ok: false, detail: 'never acquired' };
    t.e.hp = 0; t.e.dead = true;
    __sim({ steps: 40 });
    const now = combat.lockTarget;
    return { ok: now !== t.e,
             detail: `acquired ${got.name}; after its death target is `
                   + `${now ? (now === t.e ? 'STILL THE CORPSE' : now.name) : 'none'}` };
  });

  await check('three hits chain from buffered presses', () => {
    const t = window.__t.faceOff('nettle', 0.5, 6.2, 1.5);
    // press once per swing and keep stepping -- an earlier version of this
    // test broke out of the loop the moment the phase read 'active', which
    // meant the chain never got the frames it needed to advance
    const steps = new Set();
    for (let k = 0; k < 3; k++) {
      combat.attack();
      for (let i = 0; i < 14; i++) {
        t.step(1);
        if (combat.attackStep() >= 0) steps.add(combat.attackStep());
      }
    }
    return { ok: steps.has(0) && steps.has(1) && steps.has(2),
             detail: `reached steps ${[...steps].sort((a, b) => a - b).join(',')}` };
  });

  await check('the finisher launches', () => {
    const t = window.__t.faceOff('nettle', 0.5, 6.2, 1.5);
    // measure the LIFT, not the height it reaches -- 3.2 m/s against 22 m/s^2
    // of gravity peaks at 23 cm, which a per-frame sample can easily miss
    const log = [];
    let lift = 0, hp = t.e.hp;
    for (let k = 0; k < 3; k++) {
      combat.attack();
      for (let i = 0; i < (k === 2 ? 40 : 14); i++) {
        if (combat.attackStep() === 2) __sim({ steps: 1 });   // stop pinning
        else t.step(1);
        if (t.e.hp < hp - 0.1) {
          log.push(`s${combat.attackStep()}:${Math.round(hp - t.e.hp)}dmg`
                 + `/${t.e.vel.y.toFixed(1)}vy`);
          lift = Math.max(lift, t.e.vel.y);
          hp = t.e.hp;
        }
      }
    }
    return { ok: lift > 2.0, detail: `lift ${lift.toFixed(1)} m/s · ${log.join(' ') || 'NOTHING LANDED'}` };
  });

  group('The falling cut');

  await check('the wind-up hangs instead of falling', () => {
    __sim({ warp: [-8, 6, -30], steps: 30 });
    __sim({ jump: true, steps: 9 });
    const before = __sim({ steps: 1 }).vy;
    combat.attack(true);
    if (!combat.isAirSwing()) return { ok: false, detail: 'did not start an air swing' };
    let n = 0, low = before;
    while (combat.attackPhase() === 'windup' && n++ < 40) low = Math.min(low, __sim({ steps: 1 }).vy);
    return { ok: n > 4 && low > before - 1.0,
             detail: `vy ${before} -> ${low} across ${n} frames of wind-up` };
  });

  await check('the blade goes live and the body drives on the same frame', () => {
    __sim({ warp: [-8, 6, -30], steps: 30 });
    __sim({ jump: true, steps: 9 });
    combat.attack(true);
    let n = 0;
    while (combat.attackPhase() === 'windup' && n++ < 40) __sim({ steps: 1 });
    const r = __sim({ steps: 1 });
    return { ok: r.vy < -8, detail: `vy ${r.vy} the frame the hitbox opens` };
  });

  await check('landing it pogos the player back up', () => {
    const t = window.__t.pinned('nettle', -14, -8.2);
    __sim({ warp: [-14, 6, -6], steps: 18 }); t.hold();
    if (combat.lockTarget) combat.toggleLock();
    t.aim = () => __face(-14, -8.2);
    t.aim();
    t.step(14);
    __sim({ jump: true, steps: 1 }); t.step(8);
    combat.attack(true);
    let hitY = null, peak = 0; const hp0 = t.e.hp;
    for (let i = 0; i < 34; i++) {
      const r = t.step(1);
      if (hitY === null && t.e.hp < hp0 - 0.1) hitY = r.heroPos[1];
      if (hitY !== null) peak = Math.max(peak, r.heroPos[1]);
      if (r.grounded) break;
    }
    return { ok: hitY !== null && peak > hitY + 0.4,
             detail: hitY === null ? 'never connected' : `hit at ${hitY} m, rose to ${peak.toFixed(2)} m` };
  });

  await check('it travels forward, because the pose is a dive', () => {
    __sim({ warp: [-8, 6, -30], steps: 40 });
    __sim({ jump: true, steps: 9 });
    combat.attack(true);
    // measure the DIVE, not the jump: from the frame the blade goes live
    let n = 0;
    while (combat.attackPhase() === 'windup' && n++ < 40) __sim({ steps: 1 });
    const a = window.__t.heroXZ();
    for (let i = 0; i < 30; i++) {
      __sim({ steps: 1 });
      if (combat.attackPhase() === 'none') break;
    }
    const b = window.__t.heroXZ();
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { ok: d > 0.9, detail: `carried ${d.toFixed(2)} m forward while diving` };
  });

  await check('mashing in the air cannot start the ground chain', () => {
    __sim({ warp: [-8, 6, -30], steps: 30 });
    __sim({ jump: true, steps: 8 });
    combat.attack(true);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const r = __sim({ steps: 1 });
      combat.attack();                        // mash
      if (combat.attackStep() >= 0) seen.add(combat.attackStep());
      if (r.grounded) break;
    }
    const ground = [...seen].filter((s) => s < 3);
    return { ok: !ground.length, detail: `airborne steps: ${[...seen].join(',') || 'none'}` };
  });

  // Tests share one page, so anything that leaves the player dead, an enemy
  // artificially killed, or a whole encounter parked in the next county
  // poisons everything after it. Reset between groups.
  const fresh = () => page.evaluate(() => {
    combat.respawn();
    // un-park from the remembered original, not by undoing an offset
    for (const e of combat.enemies) {
      if (!e.home0) continue;
      e.home.copy(e.home0);
      e.pos.copy(e.home0);
      e.hp = e.spec.hp;
      e.state = 'idle';
      e.home0 = null;
    }
    __sim({ warp: [0.5, 6, 6.2], steps: 10 });
    return true;
  });

  await fresh();
  group('Enemies');

  for (const sp of ['nettle', 'curler', 'bellow']) {
    await check(`${sp} runs approach -> telegraph -> attack -> recover`, (name) => {
      const want = ['approach', 'telegraph', 'attack', 'recover'];
      const list = window.__t.species(name);
      if (!list.length) return { ok: false, detail: 'none alive' };
      const e = list[0];
      __sim({ warp: [e.pos.x, e.pos.y + 1, e.pos.z + 2.5], steps: 8 });
      const seen = new Set();
      // NOTE the generous budget: only two enemies hold an attack token at a
      // time, so a slow brute in a mixed encounter genuinely has to queue.
      for (let i = 0; i < 300; i++) {
        __sim({ steps: 2, dt: 1 / 20 });
        seen.add(e.state);
        if (e.dead) break;
        if (want.every((w) => seen.has(w))) break;
      }
      const missing = want.filter((w) => !seen.has(w));
      return { ok: !missing.length,
               detail: missing.length
                 ? `saw [${[...seen].join(',')}] dead=${e.dead} playerDead=${combat.player.dead}`
                 : 'full cycle' };
    }, sp);
  }

  for (const [sp, x, z, cap] of [['nettle', 0.5, 6.2, 10], ['curler', 6, -54, 24],
                                 ['bellow', 15, -95, 40]]) {
    await check(`${sp} dies to the ground chain`, (a) => {
      const t = window.__t.faceOff(a.sp, a.x, a.z, 1.6);
      const hp0 = t.e.spec.hp;
      const swings = window.__t.killPinned(t, a.cap);
      return { ok: t.e.dead, detail: `${hp0} HP down in ${swings} swings` };
    }, { sp, x, z, cap });
  }

  await fresh();          // the kill tests left half the roster parked
  await check('enemies cannot stand on the player', () => {
    __sim({ warp: [0.5, 6, 6.2], steps: 80, dt: 1 / 20 });
    const [hx, hz] = window.__t.heroXZ();
    const near = combat.enemies.filter((e) => !e.dead && e.spec.hostile)
      .map((e) => ({ d: Math.hypot(e.pos.x - hx, e.pos.z - hz), r: e.spec.radius }))
      .filter((x) => x.d < 30);
    if (!near.length) return { ok: false, detail: 'nothing came near enough to test' };
    const inside = near.filter((x) => x.d < x.r + 0.30);
    return { ok: !inside.length,
             detail: `closest ${Math.min(...near.map((x) => x.d)).toFixed(2)} m of ${near.length}` };
  });

  await fresh();
  await check('encounters leash home and heal', () => {
    __sim({ warp: [0.5, 6, 6.2], steps: 60, dt: 1 / 20 });
    const grp = combat.enemies.filter((e) => !e.dead && e.name === 'nettle' && e.home.z > 0);
    if (!grp.length) return { ok: false, detail: 'plaza group is empty' };
    grp.forEach((e) => { e.hp = e.spec.hp * 0.5; });
    __sim({ warp: [3, 6, -44], steps: 40 });
    __sim({ steps: 600, dt: 1 / 20 });
    const home = grp.filter((e) => e.pos.distanceTo(e.home) < 1.5).length;
    const healed = grp.filter((e) => e.hp >= e.spec.hp - 0.01).length;
    return { ok: home === grp.length && healed === grp.length,
             detail: `${home}/${grp.length} home, ${healed}/${grp.length} at full HP` };
  });

  await check('distant enemies are not drawn', () => {
    __sim({ warp: [0.5, 6, 6.2], steps: 60 });
    const [hx, hz] = window.__t.heroXZ();
    const wrong = combat.enemies.filter((e) => !e.dead).filter((e) => {
      const d = Math.hypot(e.pos.x - hx, e.pos.z - hz);
      return e.group.visible && d > (e.spec.far || 42) + 2;
    });
    const drawn = combat.enemies.filter((e) => !e.dead && e.group.visible).length;
    return { ok: !wrong.length, detail: `${drawn} of ${combat.enemies.length} drawn` };
  });

  await fresh();
  group('Defence');

  await check('the slip carries you', () => {
    // open meadow, not the plaza edge -- with no input the slip goes backwards,
    // and backwards off the paving is a wall as far as tryMove is concerned
    __sim({ warp: [-8, 6, -30], steps: 40 });
    const a = window.__t.heroXZ();
    dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    for (let i = 0; i < 34; i++) __sim({ steps: 1 });
    const b = window.__t.heroXZ();
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { ok: d > 3.0 && d < 4.5, detail: `${d.toFixed(2)} m` };
  });

  await check('slipping through a fight halves the damage', () => {
    const run = (useSlip) => {
      combat.respawn();
      __sim({ warp: [0.5, 6, 6.2], steps: 60 });
      combat.player.hp = combat.player.maxHP;
      for (let i = 0; i < 600; i++) {
        if (useSlip && i % 40 === 0) {
          dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
        }
        __sim({ steps: 1 });
      }
      return Math.round(combat.player.hp);
    };
    const still = run(false);
    const slipping = run(true);
    return { ok: still < 95 && slipping > still + 12,
             detail: `${100 - still} HP lost standing still, ${100 - slipping} slipping` };
  });

  await check('the slip has a cooldown', () => {
    combat.respawn();
    __sim({ warp: [-8, 6, -30], steps: 30 });
    const first = combat.dodge();
    const immediate = combat.dodge();          // same frame: must be refused
    for (let i = 0; i < 60; i++) __sim({ steps: 1 });
    const later = combat.dodge();
    return { ok: !!first && !immediate && !!later,
             detail: `start=${!!first} again-now=${!!immediate} again-after-1s=${!!later}` };
  });

  await check('it cancels recovery but not the active frames', () => {
    const t = window.__t.faceOff('nettle', 0.5, 6.2, 1.5);
    combat.attack();
    let duringActive = null, duringRecover = null;
    for (let i = 0; i < 40; i++) {
      t.step(1);
      const ph = combat.attackPhase();
      if (ph === 'active' && duringActive === null) duringActive = !!combat.dodge();
      if (ph === 'recover' && duringRecover === null) duringRecover = !!combat.dodge();
    }
    return { ok: duringActive === false && duringRecover === true,
             detail: `mid-swing=${duringActive}, in recovery=${duringRecover}` };
  });

  await fresh();
  group('Ambient life');

  await check('a grazer startles and bolts', () => {
    __sim({ warp: [-9, 6, -26], steps: 50, dt: 1 / 20 });
    const w = window.__t.species('woolt').find((e) => Math.abs(e.home.z + 38) < 4);
    if (!w) return { ok: false, detail: 'no grazer near the -38 herd' };
    __sim({ warp: [w.pos.x, w.pos.y + 1, w.pos.z + 9], steps: 90 });
    const calm = w.state;
    __sim({ warp: [w.pos.x, w.pos.y + 1, w.pos.z + 2.5], steps: 1 });
    const seen = new Set();
    for (let i = 0; i < 40; i++) { __sim({ steps: 2, dt: 1 / 20 }); seen.add(w.state); }
    const restful = ['graze', 'idle', 'wander'].includes(calm);
    return { ok: restful && seen.has('startle') && seen.has('flee'),
             detail: `was ${calm}, then ${[...seen].join(' ')}` };
  });

  await check('a grazer is not hostile and cannot be locked on to', () => {
    const w = window.__t.species('woolt')[0];
    if (!w) return { ok: false, detail: 'no grazer' };
    __sim({ warp: [w.pos.x, w.pos.y + 1, w.pos.z + 2.0], steps: 6 });
    if (combat.lockTarget) combat.toggleLock();
    combat.toggleLock();
    const got = combat.lockTarget;
    return { ok: !got || got.spec.hostile, detail: got ? `locked ${got.name}` : 'nothing to lock' };
  });

  await check('a flock goes up together and lands again', () => {
    __sim({ warp: [6, 6, -32], steps: 50, dt: 1 / 20 });
    const flock = () => window.__t.species('flitter')
      .filter((e) => Math.hypot(e.home.x - 6, e.home.z + 44) < 5);
    const n = flock().length;
    if (n < 3) return { ok: false, detail: `flock is only ${n}` };
    __sim({ warp: [6, 6, -41], steps: 4 });
    let up = 0, alt = 0;
    // sample often: at a coarse dt a bird passes through `flee` quickly
    for (let i = 0; i < 60; i++) {
      __sim({ steps: 1, dt: 1 / 20 });
      const f = flock();
      up = Math.max(up, f.filter((e) => e.state === 'flee').length);
      alt = Math.max(alt, ...f.map((e) => e.pos.y - (terrain.heightAt(e.pos.x, e.pos.z) || 0)));
    }
    __sim({ warp: [6, 6, -18], steps: 500, dt: 1 / 20 });
    const still = flock();
    const landed = still.filter((e) => !e.fly).length;
    return { ok: up >= n - 1 && alt > 2.0 && landed === still.length,
             detail: `${up}/${n} up, ${alt.toFixed(1)} m high, ${landed}/${still.length} back down` };
  });

  await fresh();
  group('Stakes');

  await check('standing in a fight costs health', () => {
    combat.respawn();
    __sim({ warp: [0.5, 6, 6.2], steps: 30 });
    const before = combat.player.hp;
    __sim({ steps: 160, dt: 1 / 20 });
    return { ok: combat.player.hp < before - 10,
             detail: `${Math.round(before)} -> ${Math.round(combat.player.hp)} HP in 8 s` };
  });

  await check('death and respawn', () => {
    combat.respawn();
    __sim({ warp: [0.5, 6, 6.2], steps: 20 });
    combat.player.hp = 1;
    let died = false;
    for (let i = 0; i < 400 && !died; i++) { __sim({ steps: 1, dt: 1 / 20 }); died = combat.player.dead; }
    if (!died) return { ok: false, detail: 'never died standing in the fight' };
    __sim({ steps: 100, dt: 1 / 20 });
    const r = __sim({ steps: 1 });
    return { ok: !combat.player.dead && combat.player.hp > 50,
             detail: `back at [${r.heroPos}] with ${Math.round(combat.player.hp)} HP` };
  });

  await fresh();
  group('Draw budget');
  //
  // NOT FRAME TIME. Headless Chromium reports about 1400 fps here, which is not
  // a measurement of anything -- swiftshader is not doing the rasterising a
  // real GPU would. A check that cannot fail is worse than no check, so frame
  // time stays a hand-measurement recorded in COMBAT-BAR.
  //
  // Draw calls and triangles ARE meaningful headless, deterministic, and they
  // are what actually regressed: ambient life arrived at 616 draws and 41 fps.
  // These ceilings sit ~15% above the measured numbers, so what trips them is a
  // change in kind and not noise. Measured in a real browser at the same spots:
  // 167 fps in the plaza down to 78 on the ridge.
  for (const [label, x, z, maxDraws, maxTris] of [
    ['plaza', 0.5, 6.2, 190, 680],
    ['path', 3, -32, 380, 860],
    ['flock', 6, -44, 380, 860],
    ['meadow', 6, -54, 400, 880],
    ['ridge', 13, -74, 380, 800],
    ['far side', 15, -95, 380, 780],
  ]) {
    await check(`${label} stays inside its draw budget`, (a) => {
      __sim({ warp: [a.x, 6, a.z], steps: 60, dt: 1 / 20 });
      const s = __sim({ steps: 1 });
      const tris = s.tris / 1000;
      return { ok: s.draws <= a.maxDraws && tris <= a.maxTris,
               detail: `${s.draws}/${a.maxDraws} draws · ${tris.toFixed(0)}k/${a.maxTris}k tris` };
    }, { x, z, maxDraws, maxTris });
  }

  group('Console');
  record('no page errors', errors.length === 0,
         errors.length ? errors.slice(0, 3).join(' | ') : 'clean');

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`\x1b[31mFAILED:\x1b[0m ${failed.map((f) => f.name).join(' · ')}`);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
