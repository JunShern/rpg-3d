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

Then `node tools/smoke.mjs`. If it prints `69/69 passed`, the checkout is good.

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
public/js/          the runtime
  main.js             the spine: world load, input, camera, frame loop
  combat.js           the fight. `onKill` and `sfx` are handed in, not imported
  atmos.js            sky, sun, bloom, grade, and the story clock (setHour)
  audio.js            all sound, synthesised. Three busses, a music scheduler
  party.js            Lake and Maren: follow, target, swing
  quest.js            the twenty minutes. Flags -> stage -> hour -> objective
  cine.js             the cutscene camera + the shot lists
  paint.js            THE LOOK: every world surface, lit and detailed in world space
  grass.js            the GPU grass field (baked field map, wind, parting, warnings)
  foliage.js          leaf-card canopies generated from the builders' blobs
  air.js              post pass: depth AO, height haze, light shafts
  motes.js            dust in the sun, fireflies at dusk
  hud.js title.js     party rings + command deck; title screen and end card
  npc.js drops.js breakables.js toon.js terrain.js trail.js
public/js/vendor/   Emberbrook's dialogue/menu/shop/game_state, near byte-for-byte
public/game/*.json  dialogue, items, shops, monsters, growth -- all data, no code
public/assets/      built glb + the manifests the runtime reads
tools/*_build.py    Blender: geometry, characters, creatures
tools/smoke.mjs     the checks
tools/shots.mjs     the capture sheet
tools/frame.mjs     put the camera at x,y,z and look at the picture
tools/film.mjs      record the trailer to docs/film/emberbrook.mp4
tools/look.mjs      look-dev: nine fixed views -> one contact sheet, with ms/frame
```

## The demo

Twenty minutes, one thread: the town rings a bell at dusk, tonight the clapper
pin has sheared, and somebody is still out past the ford who comes home on that
sound. Talk to the Sexton -> take Lake off his step -> find Maren at the ruin ->
kill a bellow for its iron -> Hobb forges the pin -> climb the tower and pull.

**The deadline is the lighting.** No timer, no fail state: `quest.js` walks
`atmos.setHour()` from 0 to 1 as the flags advance, which takes the sun from 37
degrees to 6, warms the key light, closes the fog and brings the street lamps
up on a curve. Skip to any beat with `quest.skipTo('q.pin')`.

## The look (paint.js and friends)

The world is not cel-shaded any more; the CAST is. World surfaces are
MeshStandardMaterials whose detail (colour variation, relief, moss, grime,
leaf glow) is generated in world space from noise -- tune one live with
`__paint('rock', { moss: 0.8 })`. Light comes from the sky (PMREM of the sky
shader) plus the sun; the hemisphere light is OFF and lives inside the cast's
toon shader instead (`toon.CHAR_FILL`), or the world would be lit twice. Rooms
(manifest `shafts`) take almost no sky light (`paint.setRooms`). Fog is not
material fog: `scene.fog` is null and the air pass does it from depth.

## Things that will bite you again

- **Headless Chromium is SwiftShader unless told otherwise.** Every tool now
  launches with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`. Without
  it a capture takes ~100 s and every ms/frame number is a CPU's.
- **`flat` and `patch` are reserved words in GLSL ES 3** (so are `sample`,
  `smooth`, `centroid`, `layout`...). Using one as a variable fails the compile,
  and because every painted surface shares one program, the WHOLE WORLD
  vanishes. `tools/look.mjs` prints shader errors -- read them.
- **Any `__sim` call dismisses the title screen** unless `keepTitle: true`.

- **`window.__ready` does not exist.** Wait on
  `typeof window.__sim === "function"` and then on `combat.enemies.length > 0`,
  the way `smoke.mjs` does. An invented flag plus `.catch(() => {})` hid this
  for an entire session.
- **`frame()` already advances the cutscene.** Stepping `cine` yourself as well
  runs every sequence at double speed; it finishes halfway through its shot list
  and the gameplay camera takes over mid-take, which looks plausible.
- **Audio is rendered, never heard.** Measure it: `OfflineAudioContext`, sounds
  scheduled on the AUDIO clock (a `setTimeout` lands after an offline render has
  already finished, and everything measures as silence).
- **Tone map once.** The scene renders with `NoToneMapping`; ACES and the sRGB
  encode happen at the end of the grade shader. Adding an `OutputPass` curves
  the image twice.
- **Place cameras by looking.** `node tools/frame.mjs "x,y,z  lx,ly,lz  fov"`.
  The first cinematic in this project was placed by reasoning and pointed the
  hero shot at a blank wall.

Adding a character is a row in `char_build.CHARACTERS`. Adding an item, a shop
or a monster is a JSON entry. Adding a townsperson is a row in `NPC_ROSTER` plus
dialogue nodes. **Adding an area is still a hand-written function** — that is
the least finished of the subsystems and the one to fix next.
