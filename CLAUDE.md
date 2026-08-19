# Working in this repo

`README.md` says what this project *is*. This file says how to *work* in it, and
what will bite you. Read both.

## Start here

```sh
npm install
npx playwright install chromium     # NOT in node_modules -- it lives in a
                                    # machine-level cache, so a fresh box needs
                                    # this or every check dies at launch
npm run serve                       # symlinks three into public/vendor, serves :3100
```

Then `node tools/smoke.mjs`. If it prints `64/64 passed`, the checkout is good.

## What you can and cannot do without Blender

This matters more than anything else in this file, and it is the first thing to
establish on a new machine.

| you want to change | needs Blender? | how |
|---|---|---|
| combat feel, camera, UI, HUD, drops, pickups | **no** | `public/js/*.js` |
| dialogue, items, shops, monsters, growth curve | **no** | `public/game/*.json` |
| who the townspeople are and where they stand | **no** | `NPC_ROSTER` in `main.js` |
| the checks, the capture sheet | **no** | `tools/smoke.mjs`, `tools/shots.mjs` |
| terrain, buildings, props, any geometry | **YES** | `tools/*_build.py` |
| characters, creatures, animation clips | **YES** | `tools/char_build.py` etc. |

The nine `tools/*_build.py` scripts are the only things that need Blender, and
they produce the 19 `.glb` files that are **committed**. So a machine with no
Blender can still run, test, capture and change the whole game — it just cannot
regenerate art.

```sh
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}   # mac
BLENDER=${BLENDER:-/usr/bin/blender}                                   # linux
$BLENDER -b -P tools/meadow_build.py
```

### Two things a fresh clone does NOT have

1. **`assets/source/` is gitignored** — ~40 MB of Tripo source meshes that
   `char_build.py` consumes. Without them you cannot rebuild a character even
   with Blender installed. Provenance for all six is written at the top of
   `tools/char_build.py`, matched by file size against the Emberbrook repo.
2. **The Emberbrook project** (`~/projects/multiplayer-rpg`) is where the
   vendored dialogue/menu/shop code and all the cut-in portrait art came from.
   Everything currently used is committed here, but re-vendoring or pulling more
   art needs that repo.

## The rules this codebase was built on

Every one of these was paid for. They are in rough order of how often they recur.

- **(a) The fault is in the JOINT.** Not the piece. Two systems that each work.
  The terrain function mirrored in Python and JS. `items.json` nested one level
  differently. `buy(shop,item,qty)` against `sell(item,qty,shop)`.
- **(b) A walk test says nothing about what you can SEE** — and it is not enough
  to check that a thing is visible; check it in **the camera the player is
  given**. `polar 1.22, dist 5.4, fov 52` leaves only **5.9° above horizontal**.
  That number decided how wide the pass had to be, how big an interior had to
  be, and where the cairn could stand.
- **(c) Never edit `public/` while a suite is running.** `tools/` is safe.
- **(e) Derive the offset from the constraint.** Numbers written by hand go
  stale the moment the thing they describe moves. Wall heights written as
  "road + 3" ended up below ground when the road was regraded.
- **(f) Make a check report its own breakdown — and read it when it PASSES.**
  That is how the bell check was caught measuring the tail of its own ring.
- **(k) Passing at exactly the ceiling is not passing.** Report the margin.
- **(l) A self-consistent set of numbers is not evidence.** The shop door was
  1.25 m out and the collision, the platform and the step all agreed with it.
- **(q) The suite shares one page.** Any check that does not pin what it depends
  on is measuring the check before it. Camera pitch, draw budgets and — since
  the economy landed — the character sheet, because every kill grants XP.
- **(r) A constant written twice is a constant waiting to disagree.**
- **(p) An effect you cannot see from where you trigger it is not a feature.**
  The bell nobody could see ring. The gold that landed silently in a save file.

## Workflow

- **The suite takes ~45 minutes.** Run it in the background and keep working in
  `tools/` while it does. Do not start a second one.
- **`__sim` takes the render loop off rAF, deliberately**, so captures are
  deterministic. After calling it the world only advances when you call it
  again — which looks exactly like a frozen game if you forget. It also does not
  advance real timers, so anything on a promise or a `setTimeout` (the dialogue
  window, the panels) needs a real wait, not more steps.
- **Screenshots**: pass `animations: 'disabled'`, or an infinite CSS animation
  (the dialogue chevron) hangs the capture until it times out. Expect ~10-30 s
  per shot once `__sim` has killed the loop.
- **Look at the captures.** `node tools/shots.mjs` regenerates `docs/shots/`.
  Two frames in that sheet were committed broken for a long time — one was a
  full-frame photograph of the inside of a tree — because nobody opened them.

## Where things live

```
public/js/          the runtime: main, combat, npc, drops, breakables, toon, terrain
public/js/vendor/   Emberbrook's dialogue/menu/shop/game_state, byte-for-byte
public/game/*.json  dialogue, items, shops, monsters, growth  -- all data, no code
public/assets/      built glb + the manifests the runtime reads
tools/*_build.py    Blender: geometry, characters, creatures
tools/smoke.mjs     64 checks
tools/shots.mjs     the capture sheet
```

Adding a character is a row in `char_build.CHARACTERS`. Adding an item, a shop
or a monster is a JSON entry. Adding a townsperson is a row in `NPC_ROSTER` plus
dialogue nodes. **Adding an area is still a hand-written function** — that is
the least finished of the subsystems and the one to fix next.
