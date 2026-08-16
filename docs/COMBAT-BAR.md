# COMBAT-BAR — the target for the combat demo

**This file is the loop's memory.** Context gets compacted over a long build; this
does not. Every iteration measures against the checklist here, records faults,
and crosses things off. Read it before doing anything else.

## The goal

> Build a playable action-RPG combat demo — plaza → path → outdoor area — with
> **original** creatures, and keep iterating until a fresh auditor judges its
> polish to exceed Kingdom Hearts 1's scene design and combat **on every element
> it implements**.

**KH1 is the quality bar, not the design source.** The auditor is asked to find
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
- [ ] an air attack exists and differs from the ground chain

### Impact  ← the single most load-bearing section
- [x] hit-stop — global dt scaled to 6% for 55 ms (115 ms on the finisher)
- [x] knockback proportional to the hit, finisher launches
- [x] camera shake, scaled to the hit, applied after camera placement
- [x] hit spark — pooled additive Points burst along the hit normal
- [x] damage numbers that rise, drift and fade
- [x] enemy flashes on hit (emissive, 160 ms)
- [x] death: collapse clip with a bone-scale flatten, then a fade

### Enemy behaviour
- [x] full cycle: idle → approach → telegraph → attack → recover — probe saw
      enemies in `telegraph` and `attack` states
- [x] the telegraph is a 520 ms held shape change (spines snap upright)
- [x] enemies do not all attack at once — max 2 attack tokens
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
- [x] a path leaving the plaza — bends, climbs, waymarked with posts
- [x] an outdoor area that reads as somewhere: a landmark hill with standing
      stones visible from the gate, elevation that reveals the space as you
      walk, hills framing the far edge, tree density that clusters and thins
- [x] the transition is continuous — probe walked plaza → gate → meadow with no
      block, terrain height varying under foot. The meadow sits 5 cm below the
      paving at the seam so the two are never coplanar

### Performance
- [x] measured with 4 foes on screen: plaza 194 fps, meadow 249 fps, hill 161 fps
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
| plaza | 4.2 ms · 238 fps · 119 draws | iter 3 |
| path | 15.2 ms · 66 fps · 259 draws | iter 3 |
| flock | 7.2 ms · 139 fps · 200 draws | iter 3 |
| meadow mid | 12.4 ms · 81 fps · 200 draws | iter 3 |
| ridge | 12.7 ms · 79 fps · 231 draws | iter 3 |
| far side | 13.7 ms · 73 fps · 276 draws | iter 3 |
| before the leash + far-cull (hostiles only) | 9.4 ms · 106 fps · 281 draws | iter 3 |
| when ambient life landed, before LOD | 24.4 ms · 41 fps · 616 draws | iter 3 |
| triangles (worst) | 733k | iter 3 |
| meadow before the terrain fix | 24-38 ms · 34-42 fps | iter 2 |

---

## Open faults

Newest audit at the top. Each entry: what is wrong, not what to do about it.

**iteration 3 — self-observed, no external audit yet**

1. Ambient life is expensive: 66 fps at its worst against 238 in the plaza. It
   is above target but it is now the frame budget's biggest single line, and the
   cost is skinning and drawing, not AI (measured: 12.4 ms for 42 ambients, of
   which freezing the mixers alone recovered 2.0 ms and hiding them alone 5.6).
2. No air attack.
3. The Nettle's `move` clip is authored at one speed and does not scale with
   travel, so the legs skate.
4. Hit 3's two-handed intent does not read: the left hand does not actually
   reach the grip, because nothing IKs the off hand to the weapon.
5. No smoke test yet; every check so far has been a hand-written probe.
6. The meadow has one biome and one weather. Fine for scope, but it means the
   walk out is short on variety.
7. The Curler's charge has no consequence for missing — it should be stunned by
   hitting something, which is what its own design note promises.
8. The Bellow's inflate reads at close range but its damage (22) makes trading
   with it correct-ish rather than clearly wrong.

*Fixed in iteration 3:* only one creature type; nothing spawned in the meadow;
enemies crowding onto the player's exact position; enemies following the player
across the entire map (no leash); NaN velocity from a per-species field being
undefined on a species that lacks it.

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
  surface. 249 fps, and 0 mm mismatch across 260 samples.
- **iteration 1** — the Nettle (7 clips, radial spine tell) and the whole combat
  core: 3-step combo with input buffering, lock-on with camera framing, hit-stop,
  knockback, shake, sparks, damage numbers, enemy AI state machine with attack
  tokens, player HP / damage / death / respawn. Verified by scripted probes in
  the browser, not by eye. Fixed: hurt vignette was cleared from a rAF callback
  and stuck on permanently in a backgrounded tab.
