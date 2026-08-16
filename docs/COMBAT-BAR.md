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
- [ ] acquires the nearest valid target in front of the player
- [ ] swaps targets on input
- [ ] drops when the target dies or leaves range
- [ ] camera frames player and target together
- [ ] on-screen reticle, readable against any background
- [ ] movement becomes strafe-relative while locked

### Combo
- [ ] 3-hit ground chain, each hit a distinct pose and timing
- [ ] the third hit reads as a finisher (bigger, slower, more knockback)
- [ ] input buffering — a press during hit N always lands hit N+1
- [ ] the chain resets cleanly after a pause
- [ ] an air attack exists and differs from the ground chain

### Impact  ← the single most load-bearing section
- [ ] hit-stop (both bodies freeze briefly on contact)
- [ ] knockback proportional to the hit, finisher launches
- [ ] camera shake, scaled to the hit
- [ ] hit spark / burst VFX at the contact point
- [ ] damage numbers that rise and fade
- [ ] enemy flashes on hit
- [ ] a death that is not just "the object disappears"

### Enemy behaviour
- [ ] full cycle: idle → notice → approach → **telegraph** → attack → recover
- [ ] the telegraph is readable early enough to react to
- [ ] enemies do not all attack at once (attack tokens / spacing)
- [ ] three hostile types with genuinely different roles
- [ ] two ambient types that wander, startle and flee

### Stakes
- [ ] player HP, visible
- [ ] player takes damage, with i-frames
- [ ] death and respawn
- [ ] enemies can actually kill you if you play badly

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
| frame time (full fight) | — | — |
| draw calls | — | — |
| triangles | — | — |

---

## Open faults

Newest audit at the top. Each entry: what is wrong, not what to do about it.

_(no audit run yet)_

---

## Progress log

- **iteration 0** — bar written. Starting state: three-character cast with five
  shared clips, foot IK, a town plaza with collision, a generated sword. No
  combat, no enemies, no outdoor area.
