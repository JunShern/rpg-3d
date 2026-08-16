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
- [~] 3-hit ground chain — timings and damage differ, but **all three still play
      the same clip**: `attack2` and `attack3` are not authored yet
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
- [ ] three hostile types — **only the Nettle exists**
- [ ] two ambient types

### Stakes
- [x] player HP, visible — bar with a lagging drain behind it
- [x] player takes damage, with 0.85 s i-frames — probe: 73 → 28 HP
- [x] death and respawn (2 s downed overlay, then respawn at the plaza)
- [x] enemies can kill you — three Nettles took 45 HP in ~7 s of standing still

### Place
- [ ] a path leaving the plaza that reads as a way out
- [ ] an outdoor area that reads as somewhere, not a grey box with grass
- [ ] the transition between them is not a hard seam

### Performance
- [ ] 60 fps measured (not eyeballed) with a full fight on screen
- [ ] draw calls and triangle counts recorded below

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
| draw calls (3 foes + town + cast) | 107 | iter 1 |
| triangles | 435,307 | iter 1 |
| frame time | not yet measured | — |

---

## Open faults

Newest audit at the top. Each entry: what is wrong, not what to do about it.

**iteration 1 — self-observed, no external audit yet**

1. The combo plays ONE clip for all three hits. `attack2` / `attack3` are unwritten,
   so the chain reads as the same swing three times. Highest-value next fix.
2. No path, no outdoor area — everything happens in the plaza.
3. Only one creature type; no ambient life at all.
4. Enemies crowd onto the player's exact position; separation keeps them apart
   from each other but nothing pushes them off the player.
5. No air attack.
6. Frame time not yet measured with a full fight on screen.
7. The Nettle's `move` clip is a scuttle authored at one speed; it does not
   scale with actual travel speed, so the legs skate.

---

## Progress log

- **iteration 0** — bar written. Starting state: three-character cast with five
  shared clips, foot IK, a town plaza with collision, a generated sword. No
  combat, no enemies, no outdoor area.
- **iteration 1** — the Nettle (7 clips, radial spine tell) and the whole combat
  core: 3-step combo with input buffering, lock-on with camera framing, hit-stop,
  knockback, shake, sparks, damage numbers, enemy AI state machine with attack
  tokens, player HP / damage / death / respawn. Verified by scripted probes in
  the browser, not by eye. Fixed: hurt vignette was cleared from a rAF callback
  and stuck on permanently in a backgrounded tab.
