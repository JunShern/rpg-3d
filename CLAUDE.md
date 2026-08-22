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

### Blender without Blender

On a box with no Blender and no display — a cloud session, CI — install it as a
Python module instead. It needs Python 3.11 and about 400 MB.

```sh
pip install bpy                     # 5.0.x; the committed art is 5.1
python3 tools/meadow_build.py -- --out public/assets/meadow.glb
```

Same scripts, no `-b -P`: they already guard on `__main__` and read their own
`--` arguments. `meadow.glb` rebuilt this way differs from the committed one in
**three bytes**, all of them the exporter version stamp in the generator string.
The geometry is byte-identical, so this is a real build and not an approximation.

Rendering needs a GL stack even headless (`apt-get install libegl1 libgl1
libglx-mesa0`), and then EEVEE runs on llvmpipe — which is why
`tools/anim_preview.py` drops `taa_render_samples` to 8. At the default 64 a
single 360x520 frame costs 61 s.

### Two things a fresh clone does NOT have

1. **`assets/source/` is gitignored** — ~40 MB of Tripo source meshes that
   `char_build.py` consumes. Without them you cannot rebuild a character even
   with Blender installed. Provenance for all six is written at the top of
   `tools/char_build.py`, matched by file size against the Emberbrook repo.

   You can still change a character's **animation** without them, which is most
   of what anyone wants: the rig, the mesh and the weights are all inside the
   built `.glb`, and `anim_lib` clips are pose data keyed by bone name, so they
   bind to a character that already exists. `tools/clip_bake.py` does exactly
   that. What needs the sources is changing the BODY.
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
- **(s) ROTATION MODE IS A PROPERTY OF THE BONE, not of the clip.** `anim_lib`
  authors euler XYZ; the glTF importer brings clips back as QUATERNIONS;
  `K.action` sets every pose bone to XYZ as it starts. A bone whose mode
  disagrees with its own F-curves does not error — Blender reads the channel the
  mode names and ignores the other, so the rig sits at rest while the clip plays
  perfectly. It cost a contact sheet of eight identical frames, and it is why
  `clip_bake` re-authors the whole set instead of adding to it: one new clip on
  an imported rig would have exported the other ten as valid, motionless
  animations.
- **(u) THE EXPORTER CONVERTS VERTICES, not just the root.** A character
  exported `export_yup=True` has its mesh data rewritten from Blender's Z-up
  into glTF's Y-up, so its *armature space* is Y-up and every bone-local frame
  under it is too. A prop exported to sit in that space must take the same
  conversion. Written `yup=False` on the reasoning that Blender coordinates
  would match a bone-local frame, the new sword came out identical in X with Y
  and Z swapped — through the floor, at right angles to the hand. Two renders
  failed to explain it; comparing the two meshes' coordinate ranges settled it
  in one step. **Compare the numbers of the thing that works.**
- **(t) A convention is only true where it was measured.** The module docstring
  says +Z opens the LEFT arm and closes the RIGHT. True at rest. Rotations are
  XYZ euler, so by X=-170 the sign has flipped, and a cast written at -150 using
  the rule learned at 0 folds the arms shut instead of opening them. Negative X
  is up and BEHIND, not up. `tools/pose_probe.py` answers both questions in
  metres instead of adjectives.

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
tools/anim_lib.py   THE ANIMATION LIBRARY -- pose data, one set, every character
tools/anim_preview.py  a clip as a contact sheet, off a built glb
tools/pose_probe.py    where an angle actually puts a limb, in metres
tools/clip_bake.py     put the library into a character that already exists
tools/weapon_split.py  take a welded weapon out of a built character
tools/weapon_lib.py    weapons as parameters -- blade, guard, grip, pommel
tools/weapon_build.py  build them, and render the rack you judge them from
tools/rig_extend.py    give a built character a second spine segment
tools/smoke.mjs     64 checks
tools/shots.mjs     the capture sheet
```

### Adding a move

`anim_lib.library()` is the list — every `anim_*` function in the file, and both
`char_build` and `clip_bake` read it, so a new function IS a new clip on every
character. The loop is:

```sh
# write the clip, then look at it -- from the plane the motion happens in
python3 tools/anim_preview.py -- --author anim_cast_fire --clip cast_fire --az -90

# check an angle instead of assuming it
python3 tools/pose_probe.py -- --want overhead

# put it into the characters
for c in vesper lake maren; do python3 tools/clip_bake.py -- --char public/assets/$c.glb; done
```

`swing()` and `cast()` take three pose dictionaries and a timing, so a new move
is data. `--view side` is azimuth 90 and looks at the character's **left**;
every sword action in this game happens on the right, so use `--az -90`.

### Adding a weapon

The weapon is its own node riding `hand.R`, not part of the skin — `cur.weapon`
in `main.js`, null on anyone unarmed.

```sh
# a row in weapon_lib.CATALOGUE, then look at it beside the others
python3 tools/weapon_build.py -- --rack docs/weapons/rack.png
python3 tools/weapon_build.py -- --out public/assets/weapons
```

Then give `items.json` an item whose **id matches the .glb name** (or set
`model`), and equipping it swaps the model. `GS.on('change')` drives that —
nothing in `public/js/vendor/` was touched or may be.

Two things about the frame, both of which cost a wrong sword:

- Weapons are built **grip at the origin, blade down -Z**, which is what
  `props.place_in_hand` expects. `weapon_build` applies that placement against
  a reference character before export, so the runtime owns **no grip maths**
  and mounts at identity. Do not move that arithmetic into JavaScript.
- Export **`yup=True`**, matching the characters. See rule (u).

The parameters in `weapon_lib` are the ones that survive a toon ramp at four to
six metres — length, taper, guard span and style, pommel mass, metal colour.
The guard changes a weapon's silhouette further than the blade does: it is the
only horizontal on an otherwise vertical object.

### Townspeople

They already carry every clip the cast does — `npc.js` builds a mixer and the
full action set per person and used to play only `idle`. A person's gesture is
hashed from their id so it is theirs every time you speak to them, and only the
NPC whose window is open gestures: that is `speaker`, captured when the
conversation starts, **not** whoever is nearest while it runs.

Adding a character is a row in `char_build.CHARACTERS`. Adding an item, a shop
or a monster is a JSON entry. Adding a townsperson is a row in `NPC_ROSTER` plus
dialogue nodes. **Adding an area is still a hand-written function** — that is
the least finished of the subsystems and the one to fix next.
