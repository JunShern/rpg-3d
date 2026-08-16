# COMBAT-BAR — the target for the combat demo

**This file is the loop's memory.** Context gets compacted over a long build; this
does not. Every iteration measures against the checklist here, records faults,
and crosses things off. Read it before doing anything else.

## The goal

> Build a playable action-RPG combat demo — plaza → path → outdoor area — with
> **original** creatures, and keep iterating until a fresh auditor judges its
> polish to exceed Kingdom Hearts 1's scene design and combat **on every element
> it implements**.

**KH1 is the quality bar, not the design source.**

An external reviewer answered *"does this read as derivative?"* with **yes**, and
was specific: the Nettle — small, dark, low-slung, spiky, glowing yellow eyes,
spawning in threes and swarming — read as the reference's most recognisable
enemy with quills added, and it fills most of every frame. The overlap was never
the shape; the radial quills are its own. It was the colour. It is now a cold
moss-slate animal with bone quills and small pale eyes: still dark enough to
separate from a pale meadow, no longer a silhouette with lights in it.

The same reviewer noted the source was telling on itself — a geometry library
called `kh_lib.py` and a weapon called a "keyblade" throughout, in a project
whose weapon is a sword. Renamed to `geo_lib.py`, and the sword is a sword. The auditor is asked to find
faults — including *"does any of this read as derivative?"* — and a yes there
counts as a fault exactly like a bug does.

Iteration stops only when the remaining complaints are about things this demo
deliberately does not have: content volume, voice acting, music, party and menu
systems.

### Explicitly out of scope
Voice acting · music · story content · menus, inventory, party members · level
progression · save systems · more than one outdoor area.

---

## Checklist

Each line is either DONE (with the probe that proves it) or open. Nothing is
marked DONE on the strength of a screenshot alone — it needs an assertion in
`tools/smoke.mjs` or a measured number.

`npm test` (`node tools/smoke.mjs`) drives the real game in headless Chromium — real
renderer, real GLBs, stepped frame by frame through `__sim` so there is no
wall-clock flakiness — and asserts the lines below. It takes a few minutes.
**Frame time is deliberately not one of its assertions**: headless reports
~1400 fps because swiftshader is not doing a real GPU's rasterising, and a
check that cannot fail is worse than no check. It asserts draw-call and
triangle budgets instead, which are meaningful headless and are the thing that
actually regressed. Frame time stays a hand-measurement, recorded below.

**Currently 37/37.** Roughly two thirds of the time spent writing it went on its
own bad assumptions rather than on the game: lock-on picking a different enemy
than the one a test pinned, a check inheriting a half-finished combo from the
check before it, enemies parked outside the world falling forever, and a pinned
enemy leashing and out-healing the damage. All of those produced confident
failure messages about features that worked. The lesson is the same one this
project keeps relearning: when a measurement disagrees with what you can see,
instrument the measurement before you change the thing.

### Lock-on
- [x] acquires the nearest valid target in front of the player — probe: `lockAcquired`
- [x] swaps targets on input (`cycleLock`)
- [x] drops when the target dies or leaves range
- [x] camera frames player and target together (camera yaws onto the player→target line, look-at biased 22% toward the target)
- [x] on-screen reticle — projected, spinning bracket
- [x] the character turns to face the target; measured facing error 0.2°

### Combo
- [x] 3-hit ground chain — three authored clips: forward lunge, rising
      backhand, two-handed step-through chop. Each keyed to its own hitbox
      window (hit 1 previously peaked at frame 11 while its damage landed at
      frame 2.4)
- [x] the third hit is slower, hits for 28 and launches (knock 7.0, lift 3.2)
- [x] input buffering — probe chained step 0 → 1 → 2 from presses mid-swing
- [x] the chain resets cleanly after `comboWindow`
- [x] a swing's recovery can be jump-cancelled, and its wind-up and active
      frames cannot — which is what turns the finisher's launch into a route
      (chain → launch → cancel → falling cut) instead of a thing you watch
- [x] an air attack exists and differs from the ground chain — the **falling
      cut**: a stall at the top, then a dive forward and down with the blade
      leading. It is not a fourth combo hit and cannot be chained into or out of
      the ground chain. Landing it **pogos** you back up, so the finisher's
      launch has something to do with it; missing drops you into the landing.
      Probe: hang held vy at ~4.0 through the wind-up, the drive hit −11 m/s the
      frame the blade went live, travelled 2.08 m forward, connected at 2.20 m
      and bounced the player from 1.55 m to 2.54 m

### Defence
- [x] a dodge exists and is the only defensive option — the **slip**: a low
      fencer's retreat, deliberately not a shoulder roll. 3.6 m over 0.42 s,
      eased so the fast part and the invulnerable part are the same part
- [x] it grants i-frames across the middle of the move (0.05 s → 0.28 s), not
      all of it — measured: 63 HP lost standing in a fight for 10 s, 36 slipping
- [x] it cancels attack recovery but not active frames — committing to a swing
      is a risk, not a trap, and a game where the only way out of a recovery is
      to eat the hit teaches you to stop attacking
- [x] it has a cooldown (0.62 s) so it is a read rather than a held button

### The enemy half  ← added after the first external audit found it missing
- [x] an enemy attack is a shape in space at a moment in time — a cone around
      the attacker's committed facing, opening at a per-species impact frame
      (Nettle 30% and 1.45 rad, Bellow 62% and 2.5). It was a facing-less
      sphere fired 0.05 s into a state it entered *because* you were in range,
      so it could not miss and it hit you from behind
- [x] **the positional answer each enemy was designed around actually works** —
      measured, isolated, one enemy at a time:
      · Bellow, stand still → hit at 1.20 m. Retreat through the wind-up →
        5.35 m by the commit, **misses**.
      · Curler, stand still → hit at 0.92 m. Strafe either way → **misses**,
        and it ends up 5.0 m past you.
      A charge is a CONTACT test at body width, continuously, rather than a
      cone on a timer: the old version fired 0.10 s into the charge inside a
      63° cone, which at 2.3 m is over a metre wide either side, so a sidestep
      never got out of it and the enemy's whole puzzle silently failed
- [x] an interrupted attacker still works afterwards — `didHit` was cleared only
      in the branch that completes an attack, and being hit forces `hurt`, so
      one interruption disarmed an enemy permanently. Probe: interrupt, then
      take 72 HP over 15 s from the same enemy
- [x] committed attacks have **poise**, so a telegraph is not cancellable by
      mashing — the Bellow's slam cannot be interrupted at all; the Nettle's can,
      which is what makes a swarm fair
- [x] hitstun is the hit's, not a constant — 0.20 s on hit 1, 0.55 s on the
      finisher, 0.36 s on the falling cut
- [x] the player has a hit reaction: a `hurt` clip, the swing cancelled, a
      throw, and a third of a second of not being in control
- [x] hit-stop is genuinely global — it scaled combat's clock only, so the swing
      clip raced ~17× ahead of its own hitbox windows on every connected hit

### Impact  ← the single most load-bearing section
- [x] hit-stop — global dt scaled to 6% for 55 ms (115 ms on the finisher)
- [x] knockback proportional to the hit, finisher launches
- [x] camera shake, scaled to the hit, applied after camera placement
- [x] hit spark — pooled additive Points burst along the hit normal
- [x] damage numbers that rise, drift and fade — outlined all the way round
      rather than drop-shadowed, because they land on tree trunks, pale
      hillsides and sky alike, and hidden when world geometry is in front of
      them (a number floating over the building a hit happened behind tells you
      the number and lies about where)
- [x] enemy flashes on hit (emissive, 160 ms)
- [x] death: collapse clip with a bone-scale flatten, then a fade

### Enemy behaviour
- [x] every attack shape is drawn on the ground during its wind-up — a lane for
      a charge, because a charge is a path, and a circle sector for a swing,
      because a slam is an area. The sector carries the arc width in its own
      shape, so the Bellow's 2.5 rad reads as most of a half-circle and the
      Nettle's 1.45 as a narrow slice, and you can tell which you are standing
      in without being told
- [x] a charger's line is drawn on the ground during its wind-up — its whole
      puzzle is "step off the line", and once that actually worked the next
      problem was that the line was invisible. In the world rather than over it,
      so it is occluded by whatever occludes it
- [x] the wind-up is legible at fighting distance, not just at four metres —
      the tell pulses in the species' accent (bone / cyan / ember) as well as
      changing shape, because at ~45 px a silhouette change is a smudge
      becoming a slightly different smudge
- [x] full cycle: idle → approach → telegraph → attack → recover — probe saw
      enemies in `telegraph` and `attack` states
- [x] the telegraph is a 520 ms held shape change (spines snap upright)
- [x] enemies do not all attack at once — max 2 attack tokens
- [x] a whiffed charge costs more than a landed one — measured: tanking a
      Curler charge gives 1.43 s of recovery to punish, stepping aside gives
      2.38 s. Dodging has to be worth something or the enemy has no puzzle in it
- [x] enemies collide with the world, not just with each other — measured 0
      overlap against all 91 solids across plaza, meadow and ridge
- [x] locomotion clips scale to actual travel, so nothing skates — measured
      2.11 m/s → 0.74× and 3.46 m/s → 1.16×, slowing as they close
- [x] three hostile types — Nettle (swarmer), Curler (charger), Bellow (brute).
      Probe saw each run `approach → telegraph → attack → recover` and die
- [x] two ambient types — Woolt (grazer: grazes, wanders, startles, bolts,
      returns) and Flitter (flocking bird: perches, and the whole flock goes up
      together because panic is contagious). Probe saw a flock of 8 scatter to
      4.6 m and land again, and a grazer run `graze → startle → flee → settle`

### Stakes
- [x] player HP, visible — bar with a lagging drain behind it
- [x] player takes damage, with 0.85 s i-frames — probe: 73 → 28 HP
- [x] death and respawn (2 s downed overlay, then respawn at the plaza)
- [x] enemies can kill you — three Nettles took 45 HP in ~7 s of standing still

### Place
- [x] somewhere to climb, with a reason to — five rock shelves spiralling
      around the standing stones, each a 0.42 m rise against the runtime's
      0.45 m step so it is a walk rather than a platforming test. Measured
      3.40 m at the hilltop up to 5.50 m on the plateau, and from up there the
      path, the meadow and the town are one frame
- [x] surfaces above the analytic ground are standable — the meadow answers
      "where is the floor" from a closed-form function for speed, which only
      knows about terrain, so platforms are declared in the manifest and tested
      as axis-aligned tops
- [x] a path leaving the plaza — bends, climbs, waymarked with posts
- [x] an outdoor area that reads as somewhere: a landmark hill with standing
      stones, elevation that reveals the space as you walk, hills framing the
      far edge, tree density that clusters and thins
- [x] the landmark is actually a landmark — it sat 0.9 m from the path's centre
      and the road, being cut flat, simply overwrote it: a transect across the
      middle of a "7.2 m hill" read 3.40, 3.40, 3.44. Moved clear of the road,
      it now reads 1.26 → 4.14 → 5.70 → 6.48 across the same transect
- [x] the path climbs the whole way — it saturated at y=62 and ran dead level
      at 3.40 m for the last forty metres, so the back half of the meadow was a
      table. Now 0.10 → 1.61 → 3.10 → 3.89 → 5.22 → 6.24 from gate to far edge
- [x] the transition is continuous — probe walked plaza → gate → meadow with no
      block, terrain height varying under foot. The meadow sits 5 cm below the
      paving at the seam so the two are never coplanar

### Performance
- [x] measured in a real browser — see the table below, which is the only
      place numbers live. This line used to carry its own stale figures that
      contradicted it
- [x] draw calls and triangles recorded below

---

## Original creatures

Design constraint that is also an opportunity: the geometry is **generated**, so
a telegraph can be a **shape change** rather than a wind-up animation. A
silhouette that swells, bristles or curls is readable clear across a field, is
cheap to author here, and is not what the reference does.

### Hostile
| name | role | shape-tell |
|---|---|---|
| **Nettle** | fast swarmer, fights in threes | spines lie flat, then **flare** just before it darts |
| **Curler** | armoured charger | **curls** into a ball to roll, helpless for a beat when it unfurls or hits a wall |
| **Bellow** | slow brute | **inflates**, larger and larger, then slams |

### Ambient
| name | behaviour |
|---|---|
| **Woolt** | round grazer; wanders, startles, flees |
| **Flitter** | small bird; scatters as you approach, settles again after |

---

## Measured numbers

Updated each iteration. Empty until measured.

| metric | value | when |
|---|---|---|
| plaza | 4.2 ms · 238 fps · 103 draws · 501k tris | iter 4 |
| path | 14.0 ms · 71 fps · 212 draws · 688k tris | iter 4 |
| meadow | 10.4 ms · 96 fps · 273 draws · 736k tris | iter 4 |
| ridge | 11.9 ms · 84 fps · 251 draws · 617k tris | iter 4 |
| hill | 11.6 ms · 86 fps · 283 draws · 654k tris | iter 4 |

Measured synchronously through `__sim` in a foreground tab. The numbers move
±30% run to run because the tab is scheduled against everything else on the
machine, so treat them as a band, not a reading.
| before the leash + far-cull (hostiles only) | 9.4 ms · 106 fps · 281 draws | iter 3 |
| when ambient life landed, before LOD | 24.4 ms · 41 fps · 616 draws | iter 3 |
| triangles (worst) | 733k | iter 3 |
| meadow before the terrain fix | 24-38 ms · 34-42 fps | iter 2 |

---

## Reading this file

Two rules, both learned the hard way by an auditor catching them:

1. **Numbers live in the table below and nowhere else.** Checklist lines that
   carried their own figures went stale and then contradicted the table.
2. **The captures in `docs/shots/` are stills of a HALTED simulation.** They
   are taken through `__sim`, which detaches the render loop, so every one
   reads `0 fps` and can show a damage number frozen mid-flight. They are for
   judging composition and materials, not motion or performance — and they go
   stale the moment anything is rebuilt.

## Open faults

Newest audit at the top. Each entry: what is wrong, not what to do about it.

**iteration 4 — after two external audits**

Both audits returned **FALSE** on "polish exceeds KH1". The first said the
enemy half of the fight did not run; the second, given the fixes, went further
and measured that the demo's own headline mechanic — the three-hit combo — was
unreachable at any human rhythm. Both were right and both are fixed. `npm test`
is 44/44, and several of those checks were rewritten because the second audit
showed they restated the code instead of testing the game.

Still open, in rough order of how much they cost:

1. **The town's upper floors are still one window repeated.** Ground floors now
   differ — shopfronts, doors, signs — but every storey above them is the same
   shuttered pane at the same spacing on all nine buildings.
2. **One time of day, one weather, one key light.** The single biggest thing
   the reference does that this does not: night is half of Traverse Town's
   atmosphere and it costs nothing but a palette and a light rig.
3. **Verticality exists but the combat ignores it.** A climb on the hill and a
   gallery over the plaza, and no encounter uses either — nothing fights you
   from up there and nothing makes you go up.
4. **Tells have no ground footprint.** They pulse and change shape, but nothing
   shows *where* an attack will land.
5. **The move list is still small** for one weapon: chain, falling cut, slip,
   jump-cancel. No guard, parry, dash attack or charged hit.
6. **The playable characters are not generated.** They are imported meshes from
   another project, retargeted and re-rigged here. The README says so, but the
   "everything is scripted geometry" framing does not hold for the character you
   look at for the entire demo.
7. **Being hit cancels your swing**, so a dense swarm can suppress attacking.
   The 0.85 s of i-frames after each hit should leave room to act, but this has
   been measured on a probe and not played.

*Answered from the second audit:* the three-hit combo being reachable only by
mashing (a press during recovery was discarded, and `comboWindow`/`sinceCombo`
were dead code the checklist described as working); the Curler's whole design —
a line you can step off — silently failing, because its hit fired 0.10 s into
the charge inside a 63° cone; the Nettle having no `impact`, `hitArc` or
`poise` keys at all while the checklist cited numbers for it; the landmark hill
being flattened to road height by the path running over its centre; the path
running dead level for its last forty metres; every ground mesh being outlined
and shadow-cast because the exclusion lists keyed on pre-texture names *and*
read the material name after it had been replaced by an unnamed one; the lock
ring tumbling out of the ground; the Bellow's sack being unable to glow because
`flat` makes a material with no `.emissive`; the grass/path boundary being a
hard binary switch; sparks reading as confetti above small creatures; the water
sitting proud of its own banks; and five smoke assertions that could not fail.

*Also answered:* **does it read as derivative** — the Nettle, which fills most
of every frame, was a dark low-slung spiky thing with glowing amber eyes that
swarmed in threes. Recoloured to a moss-slate animal with bone quills and small
pale eyes. `kh_lib.py` is `geo_lib.py`, and the "keyblade" in a dozen comments
is a sword, which is what it always was.

*Corrected against the audit:* its Bellow finding does not reproduce. Isolated
and instrumented at the impact frame, standing still is hit at 1.20 m and
retreating from the first frame of the wind-up puts you at 5.35 m by the commit
and the attack misses. My own first three attempts at that measurement
disagreed with each other — one held the key that walks *into* the enemy.

*Fixed in iteration 3:* only one creature type; nothing spawned in the meadow;
enemies crowding onto the player's exact position; enemies following the player
across the entire map (no leash); NaN velocity from a per-species field read on
a species that lacks it; distant creatures frozen mid-flight and mid-walk-home
by the cull; no air attack; no defensive option at all; legs skating because
`move` clips ran at one authored speed; enemies walking through trees and
buildings; a whiffed charge costing the same as a landed one; the Bellow's
damage making a trade arithmetically fine.

*Fixed in iteration 2:* combo clips; hit timing vs hitbox; terrain rendering
black (open-surface normals guessed down); FLOORS silently containing every
outline shell; frustum culling disabled on static environment meshes.

---

## Progress log

- **iteration 0** — bar written. Starting state: three-character cast with five
  shared clips, foot IK, a town plaza with collision, a generated sword. No
  combat, no enemies, no outdoor area.
- **iteration 2** — attack2/attack3 authored; the meadow built (heightfield,
  bending climbing path, landmark hill, waymarks, clustered copses, 2,489
  parts / 75k tris) and seamed to the plaza as one continuous world.
  **Performance: the meadow ran at 34-42 fps and the plaza at 190 — same draws,
  same triangles.** Disabling shadows, foliage and half the resolution changed
  nothing, because it was not rendering at all: the ground raycast scanned the
  6,120-triangle heightfield ~10 times a frame. The terrain function now travels
  with the mesh in the manifest and the runtime evaluates it in O(1), sampling
  the mesh's own triangulation so collision and visible ground are the same
  surface. 0 mm mismatch across 260 samples, and the meadow went from 34-42 fps
  to comfortably triple figures.
- **iteration 1** — the Nettle (7 clips, radial spine tell) and the whole combat
  core: 3-step combo with input buffering, lock-on with camera framing, hit-stop,
  knockback, shake, sparks, damage numbers, enemy AI state machine with attack
  tokens, player HP / damage / death / respawn. Verified by scripted probes in
  the browser, not by eye. Fixed: hurt vignette was cleared from a rAF callback
  and stuck on permanently in a backgrounded tab.
