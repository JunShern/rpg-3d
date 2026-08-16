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

// WHERE THE FIGHTING IS. The plaza used to hold a three-Nettle group that
// refilled when wiped, and half this suite stood on the spawn point and waited
// to be attacked. The town is deliberately empty now -- it is the one place you
// can look at the architecture without being swarmed -- so anything that needs
// live hostiles goes to the first meadow encounter instead.
//
// THESE LIVE IN THE PAGE, not in node. The first version was a plain node-side
// constant referenced inside `page.evaluate(() => ...)`, which runs in the
// browser and had never heard of it -- four checks died with
// `ReferenceError: FIGHT is not defined`. Installing them as page globals is
// the fix that does not need every call site to thread an argument through.
const FIGHT = [3, 6, -32];      // ENCOUNTERS[0] in main.js: two Nettles
const FIGHT_AWAY = [3, 6, 4];   // 36 m north of it: outside the leash, inside the cull
const installMarks = ([f, a]) => { window.FIGHT = f; window.FIGHT_AWAY = a; };

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
      // no reinforcements mid-probe
      __freezeEncounters(true);
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

    /**
     * Spawn a fresh subject where the test wants it, and stand in front of it.
     *
     * Reaching into `species(name)[0]` picks whatever is first in the enemy
     * list, which may be forty metres away in a different encounter -- and
     * anything killed by an earlier check never comes back, because only the
     * plaza encounter refills. Both produced "it never attacked" and "no
     * bellow" on features that work.
     */
    /** Spawn a test subject, TAGGED so `fresh()` can clear it away again. */
    make(name, x, z) {
      const e = combat.spawn(name, x, z);
      if (e) { e.testSpawn = true; e.home.set(x, e.pos.y, z); }
      return e;
    },

    summon(name, x, z, back) {
      __freezeEncounters(true);
      const e = window.__t.make(name, x, z);
      if (!e) throw new Error('could not spawn ' + name);
      for (const o of combat.enemies) {
        if (o === e || o.dead || !o.spec.hostile) continue;
        if (!o.home0) o.home0 = o.home.clone();
        o.home.set(x + 300, o.home.y, z + 300);
        o.pos.set(x + 300, o.pos.y, z + 300);
        o.state = 'idle';
      }
      __sim({ warp: [x, 6, z + back], steps: 4 });
      __face(x, z);
      return e;
    },

    /**
     * Swing the real ground chain at a pinned target until it dies.
     *
     * Steps a FIXED number of frames per swing rather than looping on
     * `attackPhase() !== 'none'`: if `attack()` is refused -- staggered, dead,
     * mid-swing -- that condition is false immediately, the body never runs,
     * no frames advance, and the helper reports "did not die" about a game
     * that is working perfectly. It also reports WHY it stopped.
     */
    killPinned(t, cap) {
      let swings = 0, refused = 0;
      while (!t.e.dead && swings < cap) {
        combat.player.hp = combat.player.maxHP;   // isolate: can it be killed
        combat.player.stagger = 0;
        if (combat.attack() === false) refused++;
        for (let i = 0; i < 34; i++) {
          t.step(1);
          if (t.e.dead) break;
        }
        swings++;
      }
      return { swings, refused, dead: t.e.dead, hp: Math.round(t.e.hp) };
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

    /** Land a hit on the player from a fixed direction, through the real path. */
    hurt(dmg) {
      const e = combat.enemies.find((x) => !x.dead && x.spec.hostile);
      const src = e ? e.pos : { x: 0, y: 0, z: 0 };
      combat.hurtPlayerForTest(dmg, src);
    },
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
  await page.evaluate(installMarks, [FIGHT, FIGHT_AWAY]);
  // ARM THE ENCOUNTERS. Nothing is armed at load any more -- the town is empty
  // and the meadow groups wake when you walk near them -- so a suite that grabs
  // "the first live nettle" finds none until something has triggered.
  // Wait for a WOOLT to exist, not for one species' proto. `seedHerds()` runs
  // only after all five GLBs have resolved, so a grazer in the world is the one
  // signal that means "the whole roster is up" -- polling `spawn('bellow')`
  // succeeded as soon as the bellow finished, which on some runs was before the
  // nettle, and the next check went looking for a live nettle and found none.
  await page.waitForFunction("combat.enemies.some((e) => e.name === 'woolt')",
                             null, { timeout: 90000 });
  await page.evaluate(() => {
    for (const e of combat.enemies) { e.dead = true; e.deadT = 99; }
    __respawnEncounters();
  });

  group('World');

  await check('every character has all ten clips', () => {
    const want = ['airattack', 'attack', 'attack2', 'attack3', 'dodge', 'hurt',
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
    // IT WALKS. Every sample here used to be a `warp`, which assigns
    // `pos.y = groundAt(...)` directly -- so the check could not see a wall, a
    // hole or a collider, and its 2.5 m tolerance was five times the 0.45 m
    // step limit it was nominally testing. A 2.4 m barrier across the path
    // passed. This holds W from the fountain to the far meadow and reports how
    // far it actually got and the worst single-frame rise.
    // az 0 puts the camera on the +z side looking toward -z, so camera-forward
    // -- which is what W means -- is south, toward the meadow. Without pinning
    // it the first run of this check walked the player NORTH into the town and
    // reported a wall.
    // NO FIGHT. This is a question about the world, not about combat: with the
    // plaza group live she gets staggered, knocked sideways and walks a
    // different route every run.
    __freezeEncounters(true);
    for (const e of combat.enemies) { e.dead = true; e.deadT = 99; e.group.visible = false; }
    // START SOUTH OF THE FOUNTAIN, ON THE GATE AXIS. The fountain sits on x=0
    // and the south range flanks the gate, so "hold W from the spawn point"
    // walks into one or the other depending which way you dodge -- x=3.6 put
    // her into the building at x=7 and the check reported a wall that is
    // supposed to be there. The gate is the route; this walks it.
    __sim({ warp: [-1.0, 6, -4.0], az: 0, steps: 20 });
    let worst = 0, best = -99, stall = 0, stuckAt = null;
    let prev = __sim({ steps: 0 }).heroPos;
    for (let i = 0; i < 1800; i++) {
      // FOLLOW THE ROAD, which is what the road is for. Holding W in a dead
      // straight line used to work and now walks into a field wall -- the
      // walls have gaps where the path crosses them, and steering for the
      // path's own centreline is both what a player does and what makes this
      // a test of the route rather than of the terrain under one line.
      // The path function is only meaningful PAST the gate: `pathAt` at a
      // plaza z extrapolates to x = -6, which steered her straight into the
      // arch's west pier six metres from the start. Inside the town the route
      // is simply "aim at the gate", which is on x = -1.
      const want = prev[2] > -20 ? -1.0 : terrain.pathAt(-prev[2]);
      const keys = ['KeyW'];
      if (want - prev[0] > 0.6) keys.push('KeyD');
      else if (want - prev[0] < -0.6) keys.push('KeyA');
      const now = __sim({ steps: 1, az: 0, held: keys }).heroPos;
      worst = Math.max(worst, Math.abs(now[1] - prev[1]));
      best = Math.max(best, now[1]);
      // SUSTAINED lack of progress, not one frame of it. Brushing a collider
      // stalls for a frame or two and that is not being stuck; forty
      // consecutive frames at a standstill while holding W is.
      stall = Math.abs(now[2] - prev[2]) < 0.004 ? stall + 1 : 0;
      if (stall > 40 && stuckAt === null) stuckAt = now;
      prev = now;
      // THE FAR EDGE IS THE END, NOT A WALL. She reaches z = -110, which is
      // where the meadow stops, and then stands against it -- which the stall
      // detector called being stuck. Getting there is the pass condition.
      if (now[2] < -100) break;
    }
    const end = __sim({ steps: 0 }).heroPos;
    const walked = -4.0 - end[2];
    // PUT THE WORLD BACK. This check kills every enemy so the walk is not a
    // fight, and the first version stopped there -- an encounter whose members
    // are dead is not wiped, it is armed and empty, so nothing ever respawned
    // and the next check reported "no live nettle" about a working game.
    __freezeEncounters(false);
    __respawnEncounters();
    return { ok: walked > 60 && worst < 0.5 && best > 1.5 && stuckAt === null,
             detail: `walked ${walked.toFixed(1)} m south, climbed to ${best.toFixed(2)} m, `
                   + `worst single frame ${worst.toFixed(3)} m`
                   + (stuckAt ? ` -- STUCK at [${stuckAt.map((v) => v.toFixed(1))}]` : '') };
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

  await check('the chain is reachable at every human rhythm', () => {
    // The old version pressed at frame 0 of each block -- always inside the
    // 0.21 s buffer window -- so it could not see that the combo was reachable
    // ONLY by mashing. Sweep the rhythms a person would actually play at.
    const reach = (frames) => {
      combat.respawn();
      __sim({ warp: [-8, 6, -30], steps: 30 });
      let max = -1;
      for (let k = 0; k < 3; k++) {
        combat.attack();
        for (let i = 0; i < frames; i++) {
          __sim({ steps: 1 });
          const st = combat.attackStep();
          if (st >= 0 && st < 3) max = Math.max(max, st);
        }
      }
      for (let i = 0; i < 45; i++) {
        __sim({ steps: 1 });
        const st = combat.attackStep();
        if (st >= 0 && st < 3) max = Math.max(max, st);
      }
      return max + 1;
    };
    const out = {};
    for (const f of [10, 14, 18, 22, 30, 36, 42]) out[`${(f / 60).toFixed(2)}s`] = reach(f);
    const worst = Math.min(...Object.values(out));
    // and it must RESET once the window has clearly passed
    const late = reach(75);
    return { ok: worst >= 2 && late === 1,
             detail: Object.entries(out).map(([k, v]) => `${k}:hit${v}`).join(' ')
                   + ` | 1.25s:hit${late}` };
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
    __freezeEncounters(false);
    // PUT THE ENCOUNTERS BACK. Each kill test permanently removes one member of
    // a group, and a group only refills when it is wiped -- so by the time the
    // separation and leash checks ran, the plaza held one Nettle and both were
    // reporting failures about a game that was fine.
    if (globalThis.__respawnEncounters) __respawnEncounters();
    // Clear test subjects away. Leaving them behind crowded the plaza with
    // seven nettles, and separation then shoved the real encounter eight to
    // twelve metres off its own posts -- which read as "the leash is broken".
    for (const e of combat.enemies) {
      if (!e.testSpawn || e.dead) continue;
      e.dead = true;
      e.deadT = 99;
      e.group.visible = false;
    }
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

  // CLEAR OF THE FIELD WALLS. The meadow now has dry-stone boundaries at
  // z = -40 and z = -68, and the Bellow's spot was z = -40 exactly -- so it
  // spent the whole check pushing into a wall and never left `approach`. There
  // is no pathfinding here by design; an enemy walks at you. Encounters are
  // sited between the walls for the same reason.
  for (const [sp, x, z, cap] of [['nettle', 0.5, 6.2, 10], ['curler', 6, -54, 24],
                                 ['bellow', 4, -48, 40]]) {
    await check(`${sp} dies to the ground chain`, (a) => {
      const t = window.__t.faceOff(a.sp, a.x, a.z, 1.6);
      const hp0 = t.e.spec.hp;
      const r = window.__t.killPinned(t, a.cap);
      return { ok: r.dead,
               detail: r.dead ? `${hp0} HP down in ${r.swings} swings`
                              : `stuck at ${r.hp}/${hp0} after ${r.swings} swings, `
                                + `${r.refused} presses refused` };
    }, { sp, x, z, cap });
  }

  await fresh();          // the kill tests left half the roster parked
  await check('enemies cannot stand on the player', () => {
    __sim({ warp: FIGHT, steps: 80, dt: 1 / 20 });
    const [hx, hz] = window.__t.heroXZ();
    const near = combat.enemies.filter((e) => !e.dead && e.spec.hostile)
      .map((e) => ({ d: Math.hypot(e.pos.x - hx, e.pos.z - hz), r: e.spec.radius }))
      .filter((x) => x.d < 30);
    if (!near.length) return { ok: false, detail: 'nothing came near enough to test' };
    // 0.90 m ABSOLUTE, not `radius + 0.30`. The old bound was derived from the
    // same table the push-out reads, so it moved whenever the push-out moved
    // and could never catch it being too small -- it asserted `>= radius+0.30`
    // against code that sets exactly `radius + 0.42`. What actually matters is
    // whether a body is inside the player's, and hers is about 0.35 m.
    const inside = near.filter((x) => x.d < 0.90);
    return { ok: !inside.length,
             detail: `closest ${Math.min(...near.map((x) => x.d)).toFixed(2)} m of ${near.length}` };
  });

  await fresh();
  await check('encounters leash home and heal', () => {
    __sim({ warp: FIGHT, steps: 60, dt: 1 / 20 });
    // ONE GROUP: the Nettles posted at the first meadow encounter. Collecting
    // by side of the map picks up members of two different sites, some beyond
    // the 42 m cull from the vantage below -- and the cull parks them at
    // exactly 0 m from home, which reads as "teleported" rather than "leashed"
    // and fails a check about a leash that works.
    const grp = combat.enemies
      .filter((e) => !e.dead && e.name === 'nettle'
                     && Math.hypot(e.home.x - FIGHT[0], e.home.z - FIGHT[2]) < 9);
    if (!grp.length) return { ok: false, detail: 'the meadow group is empty' };
    grp.forEach((e) => { e.hp = e.spec.hp * 0.5; });
    // STAY INSIDE THE CULL RADIUS. At 50 m the far-cull teleports them home and
    // restores their HP, so the check passed at exactly 0 m from home without
    // the leash ever running. 36 m is well outside the leash and inside the
    // 42 m cull, so they have to walk back under their own power.
    __sim({ warp: FIGHT_AWAY, steps: 40 });
    // KEEP THE PLAYER ALIVE while we wait. Standing thirty seconds in the
    // meadow gets you killed, and dying respawns you in the plaza -- next to
    // the very group whose leash we are measuring, which wakes them up and
    // reports "0/3 home" about a leash that works.
    for (let i = 0; i < 600; i++) {
      combat.player.hp = combat.player.maxHP;
      __sim({ steps: 1, dt: 1 / 20 });
    }
    // A NEIGHBOURHOOD, NOT A POINT. They snap back onto their posts and then
    // push apart from each other, so after crossing fifty metres home they end
    // up one to three metres off it. Measured 1.0, 2.1, 2.6.
    const away = grp.map((e) => +e.pos.distanceTo(e.home).toFixed(1));
    // and they must have WALKED, not been teleported: exactly 0.0 for all of
    // them is the far-cull's signature, not the leash's
    const teleported = away.every((d) => d === 0);
    const home = teleported ? 0 : away.filter((d) => d < 3.5).length;
    const healed = grp.filter((e) => e.hp >= e.spec.hp - 0.01).length;
    return { ok: home === grp.length && healed === grp.length,
             detail: `${home}/${grp.length} home (${away.join(', ')} m), `
                   + `${healed}/${grp.length} at full HP` };
  });

  await check('distant enemies cost nothing to draw', () => {
    // `e.group.visible === !far` computed from the same distance and constant
    // is the code restating itself. Ask the RENDERER instead: standing among
    // them and standing far away should differ by real draw calls.
    // SAME PLACE, SAME CAMERA, ONLY THE ENEMIES MOVE. Comparing the meadow to
    // the plaza compares two different sets of scenery -- a ~200-draw
    // difference measured against a 20-draw threshold, so the check passed on
    // the buildings alone and would have kept passing with the cull deleted.
    __sim({ warp: [6, 6, -54], steps: 120 });
    const near = __sim({ steps: 1 }).draws;
    const home = combat.enemies.map((e) => e.home.clone());
    combat.enemies.forEach((e, i) => { e.home.set(home[i].x, home[i].y, home[i].z - 300); });
    combat.enemies.forEach((e) => { e.pos.z -= 300; });
    __sim({ steps: 30 });
    const away = __sim({ steps: 1 }).draws;
    combat.enemies.forEach((e, i) => { e.home.copy(home[i]); e.pos.copy(home[i]); });
    __sim({ steps: 5 });
    const alive = combat.enemies.filter((e) => !e.dead).length;
    return { ok: away < near - 20,
             detail: `${near} draws with them here, ${away} with them 300 m away, `
                   + `${alive} alive either way` };
  });

  await fresh();
  group('The enemy half of the fight');

  await check('an interrupted attacker can still hurt you afterwards', () => {
    // `didHit` used to be set on a connect and cleared only in the branch that
    // COMPLETES the attack -- and being hit forces 'hurt', which never reaches
    // it. One interruption disarmed an enemy permanently.
    //
    // IT HAS TO ACTUALLY BE INTERRUPTED. This check used to press attack once
    // and assume that ended the enemy's swing. A single 12-damage link no
    // longer breaks a Nettle's 22 poise -- by design, that is the whole point
    // of poise -- so the enemy sailed through, `didHit` was true because the
    // attack CONNECTED, and the check reported a leak that was not there. It
    // now lands links until the state leaves 'attack', and fails loudly if it
    // never does, because "poise is now unbreakable" is also a bug worth
    // hearing about.
    combat.respawn();
    const e = window.__t.summon('nettle', 0.5, 6.2, 2.2);
    let g = 0;
    while (e.state !== 'attack' && g++ < 900) { __sim({ steps: 1 }); __face(e.pos.x, e.pos.z); }
    if (e.state !== 'attack') return { ok: false, detail: 'it never attacked' };
    let hits = 0;
    for (let i = 0; i < 60 && e.state === 'attack'; i++) {
      combat.player.hp = combat.player.maxHP;       // isolate: do not die to it
      if (combat.attack() !== false) hits++;
      __sim({ steps: 1 }); __face(e.pos.x, e.pos.z);
    }
    if (e.state === 'attack') {
      return { ok: false, detail: `${hits} presses and it never broke` };
    }
    for (let i = 0; i < 20; i++) __sim({ steps: 1 });
    const stuck = e.didHit;
    combat.respawn();
    __sim({ warp: [e.pos.x, e.pos.y + 1, e.pos.z + 1.2], steps: 10 });
    const hp0 = combat.player.hp;
    for (let i = 0; i < 900; i++) __sim({ steps: 1 });
    const lost = Math.round(hp0 - combat.player.hp);
    return { ok: !stuck && lost > 10,
             detail: `broken after ${hits} accepted presses, didHit stuck=${stuck}, `
                   + `then took ${lost} HP over 15 s` };
  });

  // THE TELL'S FOOTPRINT POINTS WHERE THE ATTACK GOES.
  //
  // Both ground tells were drawn off-axis -- the Curler's lane by 180 degrees
  // and the Bellow's arc by 90 -- for an unknown number of iterations. Every
  // capture until now let the AI pick the enemy's facing, and an enemy walking
  // straight at the camera looks identical whichever way its footprint is
  // painted. The bug only appears if you aim the enemy yourself, which is what
  // this does.
  for (const [sp, mesh, x, z] of [['curler', 'line', 2, -52], ['bellow', 'arc', 2, -52]]) {
    await check(`the ${sp}'s ground tell points at you`, (a) => {
      combat.respawn();
      __sim({ warp: [a.x, 4, a.z + 3.0], steps: 20 });
      const e = window.__t.species(a.sp)[0] || combat.spawn(a.sp, a.x, a.z);
      if (!e) return { ok: false, detail: 'nothing to aim' };
      e.pos.set(a.x, __groundAt(a.x, a.z, 40) ?? 0, a.z);
      e.home.copy(e.pos);
      e.vel.set(0, 0, 0);
      combat.forceState(e, 'telegraph');
      for (let i = 0; i < 6; i++) {
        e.pos.set(a.x, e.pos.y, a.z);
        e.facing = Math.atan2(pos.x - e.pos.x, pos.z - e.pos.z);
        __sim({ steps: 1 });
      }
      const m = __threat[a.mesh];
      if (!m.visible) return { ok: false, detail: 'the tell is not being drawn' };
      // a point one unit along the footprint's own axis, in world space
      const tip = m.localToWorld(new THREE.Vector3(0, 0, 1));
      const ax = tip.x - m.position.x, az = tip.z - m.position.z;
      const px = pos.x - e.pos.x, pz = pos.z - e.pos.z;
      const cos = (ax * px + az * pz)
                / (Math.hypot(ax, az) * Math.hypot(px, pz) || 1);
      return { ok: cos > 0.92,
               detail: `${Math.round(Math.acos(Math.max(-1, Math.min(1, cos)))
                                     * 180 / Math.PI)} degrees off the player` };
    }, { sp, mesh, x, z });
  }

  await check('a committed attack is not cancellable by mashing', () => {
    combat.respawn();
    // flat open meadow: the previous spot moved onto the relocated hill's
    // flank, where a slow brute and the player drift apart on the slope
    const b = window.__t.summon('bellow', 4, -48, 2.2);   // clear of the wall at z=-40
    let g = 0;
    while (b.state !== 'attack' && g++ < 1500) { __sim({ steps: 1 }); __face(b.pos.x, b.pos.z); }
    if (b.state !== 'attack') return { ok: false, detail: 'it never committed' };
    // THE HITS HAVE TO LAND. This mashed `attack()` and asserted the Bellow was
    // not in 'hurt' -- which passes with ZERO hits landed, and zero hits is the
    // normal outcome, because the Bellow's own slam staggers the player and a
    // staggered player's `attack()` is refused. It was checking that a brute
    // is unbreakable by a player who never swung. Damage dealt is the proof
    // that the poise was actually tested.
    // ONLY WHILE IT IS STILL COMMITTED. A 40-frame loop outlasts the Bellow's
    // own attack, so it was landing hits during 'recover' -- where poise does
    // not apply and is not supposed to -- and reporting that a brute with 999
    // poise had been mashed out of its swing. The property is about the
    // committed window, so the loop ends when the window does.
    const hp0 = b.hp;
    let broke = false, frames = 0;
    while (b.state === 'attack' && frames < 60) {
      combat.player.hp = combat.player.maxHP;    // isolate: do not be staggered out
      combat.player.stagger = 0;
      combat.attack();
      __sim({ steps: 1 }); __face(b.pos.x, b.pos.z);
      frames++;
      if (b.state === 'hurt') broke = true;
    }
    const dealt = Math.round(hp0 - b.hp);
    // 10, not 20. The damage floor exists only to prove hits ACTUALLY LANDED --
    // the property under test is "it does not break" -- and one full link is
    // 12. Asking for 20 was asking for two links inside one committed window,
    // which the retimed hitboxes (active is 65 ms now) do not fit.
    return { ok: !broke && dealt >= 10,
             detail: `${dealt} damage over ${frames} committed frames, `
                   + `never broken (now '${b.state}')` };
  });

  await check("a swarmer's wind-up breaks to a chain, not to one poke", () => {
    // WHAT THIS USED TO ASSERT WAS THE OLD BUG. One press, then "it must be in
    // 'hurt'" -- which was true only while a Nettle's poise (11) sat below the
    // weakest link's damage (12), i.e. while poise could never absorb a single
    // chip and the last encounter could be won by holding one button for zero
    // damage taken. Poise is 22 now, so the property is two-sided and both
    // sides are checked here: one link does NOT break the wind-up, and a chain
    // does. A swarm stays fair because you can interrupt it; it stays a fight
    // because interrupting costs you the commitment of a chain.
    combat.respawn();
    const e = window.__t.summon('nettle', 0.5, 6.2, 1.6);
    let g = 0;
    while (e.state !== 'telegraph' && g++ < 900) { __sim({ steps: 1 }); __face(e.pos.x, e.pos.z); }
    if (e.state !== 'telegraph') return { ok: false, detail: 'never wound up' };
    combat.attack();
    for (let i = 0; i < 10; i++) { __sim({ steps: 1 }); __face(e.pos.x, e.pos.z); }
    const afterOne = e.state;
    let presses = 1;
    for (let i = 0; i < 90 && e.state === 'telegraph'; i++) {
      combat.player.hp = combat.player.maxHP;
      if (combat.attack() !== false) presses++;
      __sim({ steps: 1 }); __face(e.pos.x, e.pos.z);
    }
    // 'hurt', not merely "no longer winding up". The loop can outlast a 0.52 s
    // telegraph, and a telegraph that simply EXPIRED also leaves the state !==
    // 'telegraph' -- so the old test passed whether or not anything broke.
    const broke = e.state === 'hurt';
    return { ok: afterOne === 'telegraph' && broke && presses > 1,
             // presses, not links: most of these are refused or buffered, so
             // the number is "how long the mashing took", not a damage count
             detail: `one link left it in '${afterOne}', `
                   + `${presses} presses broke it to '${e.state}'` };
  });

  await check('hit-stop freezes the PLAYER, not just combat', () => {
    // The bug this names lives in main.js's frame(), which scales step(), the
    // mixer and the IK by combat.timeScale(). Asserting `timeScale() < 1` was
    // restating combat's own expression and would have passed with main.js
    // ignoring it entirely -- which IS the original bug. So measure the thing
    // that actually stops: how far the player travels while frozen.
    const t = window.__t.faceOff('nettle', 0.5, 6.2, 1.5);
    const travel = (held) => {
      const a = window.__t.heroXZ();
      for (let i = 0; i < 6; i++) t.step(1);
      const b = window.__t.heroXZ();
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    // baseline: six frames of walking, unfrozen
    const free = (() => {
      const a = window.__t.heroXZ();
      for (let i = 0; i < 6; i++) { __sim({ steps: 1, held: ['KeyW'] }); t.hold(); }
      const b = window.__t.heroXZ();
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    })();
    // now land a hit and walk during the freeze
    combat.attack();
    let fired = false;
    for (let i = 0; i < 30 && !fired; i++) { t.step(1); fired = combat.timeScale() < 1; }
    if (!fired) return { ok: false, detail: 'hit-stop never fired' };
    const a2 = window.__t.heroXZ();
    for (let i = 0; i < 3; i++) { __sim({ steps: 1, held: ['KeyW'] }); t.hold(); }
    const b2 = window.__t.heroXZ();
    const frozenTravel = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
    return { ok: free > 0.05 && frozenTravel < free * 0.25,
             detail: `walked ${free.toFixed(3)} m free, ${frozenTravel.toFixed(3)} m frozen` };
  });

  await check('lock-on cycles through every target, not just two', () => {
    // summon its own three, because the checks above park everything else --
    // and because the bug being tested only shows up with three or more
    combat.respawn();
    __sim({ warp: [0.5, 6, 6.2], steps: 20 });
    const made = [window.__t.make('nettle', 2.4, 6.2),
                  window.__t.make('nettle', -1.4, 6.2),
                  window.__t.make('nettle', 0.5, 4.0)].filter(Boolean);
    __sim({ steps: 10 });
    const seen = new Set();
    for (let i = 0; i < 8; i++) { const t = combat.cycleLock(); if (t) seen.add(t); }
    const reachedAll = made.every((e) => seen.has(e));
    return { ok: reachedAll && seen.size >= 3,
             detail: `${seen.size} distinct targets, all three summoned reached=${reachedAll}` };
  });

  await fresh();
  group('Defence');

  await check('being hit takes the swing away from you', () => {
    // Asserting attack()===false and dodge()===null was restating the two
    // guards. Observe the consequences instead: a swing in progress ends, and
    // the body is thrown.
    combat.respawn();
    __sim({ warp: FIGHT, steps: 150 });
    // START CLEAN. Walking in mid-stagger meant the very first `attack()` was
    // refused, the loop broke on that same frame, and the check reported "there
    // was no swing to take away" about a working feature.
    for (let i = 0; i < 240 && combat.isStaggered(); i++) __sim({ steps: 1 });
    if (combat.isStaggered()) return { ok: false, detail: 'never stopped being staggered' };
    let hit = null, swingingRecently = false;
    for (let i = 0; i < 500; i++) {
      // keep a swing running so there is something for the hit to take away.
      // `wasSwinging` has to look at the frames AROUND the hit, not the single
      // frame before it -- a swing that happened to end on that exact frame
      // read as "there was nothing to take away" and failed a working feature.
      if (!combat.isAttacking()) combat.attack();
      const before = window.__t.heroXZ();
      if (combat.isAttacking()) swingingRecently = true;
      __sim({ steps: 1 });
      if (combat.isStaggered()) {
        const after = window.__t.heroXZ();
        hit = {
          wasSwinging: swingingRecently,
          nowSwinging: combat.isAttacking(),
          thrown: Math.hypot(after[0] - before[0], after[1] - before[1]),
        };
        break;
      }
    }
    if (!hit) return { ok: false, detail: 'never got hit' };
    // and it keeps throwing over the next few frames
    let total = hit.thrown;
    for (let i = 0; i < 8; i++) {
      const a = window.__t.heroXZ();
      __sim({ steps: 1 });
      const b = window.__t.heroXZ();
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return { ok: hit.wasSwinging && !hit.nowSwinging && total > 0.15,
             detail: `swinging ${hit.wasSwinging} -> ${hit.nowSwinging}, `
                   + `thrown ${total.toFixed(2)} m` };
  });

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

  await check('the slip refuses damage across its i-window and not outside it', () => {
    // A direct assertion, not a statistical one. The blunt "slip on a timer and
    // compare HP" version measured the i-frames the player gets after ANY hit
    // more than it measured the slip, and got noisier the moment being hit
    // started cancelling the slip.
    combat.respawn();
    const e = window.__t.summon('nettle', 0.5, 6.2, 6.0);
    e.pos.set(0.5, e.pos.y, 6.2);
    const probe = (atTime) => {
      combat.respawn();
      combat.player.invuln = 0;
      combat.dodge();
      let t = 0;
      while (t < atTime) { __sim({ steps: 1 }); t += 1 / 60; }
      const before = combat.player.hp;
      combat.player.invuln = 0;             // isolate: only the slip may save us
      window.__t.hurt(20);
      return before - combat.player.hp;
    };
    const inside = probe(0.14);              // middle of the i-window
    combat.player.dodgeCd = 0;
    const outside = probe(0.38);             // after it closes
    return { ok: inside === 0 && outside > 0,
             detail: `took ${inside} inside the window, ${outside} after it` };
  });

  await check('a recovery can be jump-cancelled, a commitment cannot', () => {
    // the route the moveset was missing: finisher launches, cancel the long
    // recovery, meet it in the air with the falling cut
    combat.respawn();
    __sim({ warp: [-8, 6, -30], steps: 40 });
    const seen = [];
    combat.attack();
    for (let i = 0; i < 45; i++) {
      const ph = combat.attackPhase();
      const before = __sim({ steps: 0 }).grounded;
      const r = __sim({ jump: true, steps: 1 });
      if (before && !r.grounded) { seen.push(ph); break; }
    }
    return { ok: seen[0] === 'recover',
             detail: seen.length ? `first jump allowed in '${seen[0]}'` : 'never jumped' };
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
    // clear the cooldown the previous check left behind, or "refused during
    // active" passes for the wrong reason and "allowed in recovery" fails
    for (let i = 0; i < 60; i++) t.step(1);
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
  // MASHING MUST NOT BE THE BEST STRATEGY.
  //
  // There was no check on this at all, and it was false: measured on the final
  // encounter with lock-on engaged and only the press policy varying, mashing
  // cleared in 10.6 s for 64 HP while one press per link took 15.4 s and cost
  // 96. `chainNow` fired the instant the active window closed, so a buffered
  // press deleted the whole recovery -- 49.8 dps against 36.2. The input that
  // engages least paid 37% more.
  //
  // The property is comparative on purpose. Absolute clear times drift with
  // every balance change; "reading the fight beats holding the button" is the
  // design, and it is the thing that quietly stopped being true.
  await check('reading the fight beats holding the button', async () => {
    const run = async (policy) => {
      __freezeEncounters(true);
      __respawnEncounters();
      const grp = [];
      for (const e of combat.enemies) {
        if (!e.spec.hostile) continue;
        if (Math.hypot(e.home.x - 10, e.home.z + 88) < 9) grp.push(e);
        else { e.dead = true; e.deadT = 99; }
      }
      __sim({ steps: 2 });
      combat.respawn();
      __sim({ warp: [10, 12, -82], steps: 25 });
      if (!combat.lockTarget) combat.toggleLock();
      const dt = 1 / 60;
      let t = 0, next = 0;
      while (t < 40 && grp.some((e) => !e.dead) && !combat.player.dead) {
        let held = false;
        if (policy === 'punish') {
          if (combat.punishWindow() > 0) combat.attack();
          else for (const e of grp) {
            if (e.dead || e.state !== 'telegraph') continue;
            if (Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z) > 4.2) continue;
            if (e.t < e.spec.telegraph * 0.45) continue;
            held = true; combat.dodge(); break;
          }
        }
        if (!held && t >= next) { combat.attack(); next += 0.1; }
        if (!combat.lockTarget) combat.toggleLock();
        __sim({ steps: 1, dt });
        t += dt;
      }
      return { t, alive: grp.filter((e) => !e.dead).length, dead: combat.player.dead };
    };
    const mash = await run('mash');
    const skill = await run('punish');
    const ok = !skill.dead && !skill.alive && (mash.dead || mash.alive || skill.t < mash.t);
    return { ok,
             detail: `mash ${mash.t.toFixed(1)}s${mash.dead ? ' DIED' : ''}`
                   + `${mash.alive ? ` ${mash.alive} alive` : ''}`
                   + ` vs slip-and-punish ${skill.t.toFixed(1)}s`
                   + `${skill.dead ? ' DIED' : ''}${skill.alive ? ` ${skill.alive} alive` : ''}` };
  });

  group('The camera');

  // NOTHING TOUCHED THE CAMERA. It is the most intricate code in the project --
  // a solid raycast, a terrain-clearing pitch, a blocker sweep and a pull-in --
  // and the suite had no opinion about any of it. What that cost: standing at
  // the stream ford and looking down the path put the boom inside a tree
  // canopy, and since the shell is an inverted hull the whole frame was flat
  // dark green with the player nowhere in it. Reproducible from a cold load,
  // and nothing here would have said a word.
  //
  // The property is simple and does not restate the implementation: from where
  // the camera ends up, the first thing along the view direction should be the
  // player.
  await check('the camera can always see the player', () => {
    const rc = new THREE.Raycaster();
    const dir = new THREE.Vector3();
    const bad = [];
    const spots = [
      [0, -50, 0], [0, -50, Math.PI], [0, -50, 1.6], [0, -50, -1.6],
      [2, -58, 0], [12, -62, -0.64], [-16, -70, 0.9],
      [0.6, 5.6, 0], [-11.5, 9.2, Math.PI], [7.6, -8.5, -Math.PI / 2],
      [-1, -5.5, 0], [29.9, -85.1, 2.7],
    ];
    for (const [x, z, az] of spots) {
      __sim({ warp: [x, 14, z], az, polar: 1.24, dist: 7.5, steps: 40 });
      camera.getWorldDirection(dir);
      rc.set(camera.position.clone(), dir);
      rc.near = 0.02; rc.far = 9;
      const hit = rc.intersectObjects(scene.children, true)
        .filter((h) => h.object.visible && h.distance > 0.05)[0];
      const name = hit ? (hit.object.userData.matName || hit.object.name || '?') : 'nothing';
      // the player's own materials are the acceptable answer; so is open air,
      // which happens when the camera is looking past her down a slope
      const ok = !hit || /vesper|lake|maren/.test(name);
      if (!ok) bad.push(`(${x},${z}) az${az.toFixed(1)} sees ${name} at ${hit.distance.toFixed(2)} m`);
    }
    return { ok: !bad.length,
             detail: bad.length ? bad.join(' | ') : `${spots.length} vantages, all clear` };
  });

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
    __sim({ warp: FIGHT, steps: 30 });
    const before = combat.player.hp;
    __sim({ steps: 160, dt: 1 / 20 });
    return { ok: combat.player.hp < before - 10,
             detail: `${Math.round(before)} -> ${Math.round(combat.player.hp)} HP in 8 s` };
  });

  await check('death and respawn', () => {
    combat.respawn();
    __sim({ warp: FIGHT, steps: 20 });
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
    ['far side', 24, -84, 380, 780],
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
