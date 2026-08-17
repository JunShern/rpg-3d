// shots.mjs -- the capture sheet.
//
// WHY THIS EXISTS.  Every audit round so far has been fed by screenshots taken
// from a scratch script that was then thrown away, so the next round's shots
// were framed slightly differently and "is this better than last time?" could
// not be answered by putting two images side by side.  The shot list belongs in
// the repo for the same reason the smoke suite does.
//
// The camera is placed through `__sim`, which steps the loop by hand: an
// unaided capture in a throttled headless tab lands mid-lerp on frame three.
//
//   node tools/shots.mjs                 # all of them, into docs/shots
//   node tools/shots.mjs plaza stream    # only shots whose name contains these
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const URL = process.env.SHOT_URL || 'http://localhost:3100/';
const OUT = 'docs/shots';

// az is the camera's yaw in radians: it is where the CAMERA sits, so the view
// looks the opposite way. az 0 = camera on the +z side, looking toward -z (out
// through the gate, into the meadow); az PI = looking back toward the town;
// az PI/2 looks toward -x, az -PI/2 toward +x.
//
// World coordinates, since every shot below is framed on one of them:
//   fountain (0, -0.5)   gate arch (-1, -11)   belltower (-1, 15.5)
//   gallery (12.6, -8.5) meadow mouth z=-19.5  stream z=-47
//   landmark hill + outcrop (27, -82)
//
// `cast` spawns enemies at offsets from the player's mark; `setup` runs in the
// page just before the frames are stepped.
const SHOTS = [
  { name: '01-plaza-fountain', warp: [0.6, 0, 5.6], az: 0, polar: 1.14, dist: 7.0 },
  { name: '02-plaza-shopfront', warp: [-11.5, 0, 9.2], az: Math.PI, polar: 1.22, dist: 7.0 },
  { name: '03-plaza-gallery', warp: [7.6, 0, -8.5], az: -Math.PI / 2, polar: 1.16, dist: 8.0 },
  // warp y is high: the roof leads are PLATFORMS at 8.4 m, and `groundAt`
  // searches downward from the y you give it
  // The cellar cannot be WARPED into: `groundAt` raycasts downward and finds
  // the paving over the room, so the only way in is the way a player takes.
  { name: '03c-cellar', warp: [-8.7, 3, -4.6], az: Math.PI, polar: 1.40, dist: 6.0,
    walk: { keys: ['KeyW'], frames: 420 } },
  { name: '03b-rooftops', warp: [7.0, 12, -15.0], az: 1.9, polar: 1.30, dist: 9.0 },
  // Reached down a 1.5 m alley between the two east buildings, so like the
  // cellar it has to be walked to rather than warped into.
  { name: '03d-yard', warp: [12.0, 3, -3.25], az: -Math.PI / 2, polar: 1.24, dist: 9.0,
    walkTo: [[20.0, -3.25], [25.6, -3.25], [27.0, -1.4]] },
  { name: '04-belltower', warp: [-1.0, 0, -7.0], az: Math.PI, polar: 1.47, dist: 9.0 },
  // THE TOWER IS ENTERABLE, so it gets the same three-shot treatment the cellar
  // does: the way in, the middle of the climb, and what the climb was for. The
  // shaft CAN be warped into, unlike the cellar -- its stair is platforms, and
  // `groundAt` checks platforms before it raycasts the paving.
  { name: '04b-tower-door', warp: [-1.0, 0, 10.6], az: Math.PI, polar: 1.30, dist: 7.5 },
  // framed ACROSS the well, which is the only direction in a stairwell with
  // room for a boom: along a flight the camera is into a corner in two metres
  { name: '04c-tower-stair', warp: [0.81, 9, 13.69], az: 2.36, polar: 1.24, dist: 5.0 },
  { name: '04d-tower-well', warp: [-2.81, 13, 17.31], az: -0.79, polar: 1.05, dist: 5.0 },
  { name: '04e-belfry', warp: [-1.0, 20.5, 16.6], az: 0.2, polar: 1.30, dist: 6.5 },
  { name: '04f-tower-from-the-air', warp: [-1.0, 20.5, 16.6], az: 0.0, polar: 0.80, dist: 9.5 },
  { name: '05-gate-to-meadow', warp: [-1.0, 0, -5.5], az: 0, polar: 1.26, dist: 7.5 },
  { name: '06-path-climb', warp: [0.5, 0, -34.0], az: 0, polar: 1.24, dist: 8.5 },
  { name: '07-stream-ford', warp: [-1.0, 0, -41.0], az: -0.55, polar: 1.30, dist: 9.0 },
  // warp y is 14, not 0: the outcrop's top shelf is a PLATFORM three metres
  // above the height field, and `groundAt` searches downward from the y you
  // give it -- warping in at zero drops the player onto the terrain underneath
  // the rock, which is how this shot spent a round showing a hero standing in
  // grass inside a boulder.
  // AIMED AT THE MEASURED CHANNEL. Both of these were framed by eye and both
  // missed: the watercourse is not straight, `_stream_y(x)` puts it at y=43.7
  // where x=-14 and the shots were pointed at y=41 and y=47.5, four metres out
  // on either side. 07b came back as a full frame of water with no player in
  // it, which read as a camera bug and was a map-reading error.
  { name: '07b-ravine', warp: [-14.0, 5, -38.6], az: 0.35, polar: 1.30, dist: 11.0 },
  // LOOKING THE OTHER WAY ALONG THE CHANNEL. The water surface follows its own
  // bed, and the bed climbs, so from down in the gorge the ribbon seen edge-on
  // up-channel is a plane across the view with the player behind it. Measured:
  // az -1.571 sees water 1.9 m out, az +1.571 sees the player at 7.6 m.
  { name: '07c-ravine-bed', warp: [-14.0, 0, -43.7], az: 1.571, polar: 1.34, dist: 8.0 },
  { name: '08-outcrop-vantage', warp: [29.9, 14, -85.1], az: 2.715, polar: 1.36, dist: 9.0 },
  { name: '08b-outcrop-climb', warp: [22.0, 6, -76.0], az: -0.55, polar: 1.24, dist: 10.0 },
  { name: '09-landmark-hill', warp: [12.0, 0, -62.0], az: -0.644, polar: 1.16, dist: 11.0 },
  { name: '09e-dell', warp: [-9.5, 6, -31.0], az: 1.571, polar: 1.16, dist: 12.0 },
  { name: '09f-dell-rim', warp: [-12.5, 6, -31.0], az: 1.571, polar: 1.22, dist: 11.0 },
  { name: '09b-stone-circle', warp: [27.0, 16, -82.0], az: 2.55, polar: 1.44, dist: 9.0 },
  { name: '09c-ruin', warp: [-14.0, 6, -50.0], az: 0.0, polar: 1.28, dist: 9.5 },
  // THE SPINE: the face from below, the walk along the crest, and what the
  // crest is for. Its peak is at (-8.44, -73) and stands 9.29 m up.
  { name: '09g-spine-face', warp: [-15.0, 6, -70.0], az: -1.571, polar: 1.24, dist: 11.0 },
  { name: '09h-spine-crest', warp: [-8.44, 11, -73.0], az: 0.0, polar: 1.18, dist: 8.0 },
  { name: '09i-spine-view', warp: [-8.44, 11, -73.0], az: 2.2, polar: 1.06, dist: 9.0 },
  { name: '09d-fieldwall', warp: [5.7, 6, -35.0], az: 0.0, polar: 1.26, dist: 9.0 },
  { name: '10-town-from-meadow', warp: [0, 0, -30.0], az: Math.PI, polar: 1.30, dist: 9.0 },

  // Combat states. Each of these SPAWNS its own cast rather than hunting for a
  // live one: the meadow encounters only arm when the player walks into them,
  // so a shot that teleports straight to its mark and then looks for a Curler
  // finds nothing. Spawned enemies are cleared again after the shot.
  // The cast sits OFF the camera's axis. Framed dead ahead, an enemy 3 m in
  // front of the player is directly behind the player from the camera -- the
  // Bellow shot spent a round showing nothing but an orange glow over the
  // hero's shoulder, which was the enemy, entirely occluded by her.
  {
    name: '11-lock-on', warp: [2.0, 0, -58.0], az: 0, polar: 1.26, dist: 7.5,
    cast: [['nettle', 2.0, -2.8]],
    setup: () => { combat.toggleLock(); },
    steps: 30,
  },
  {
    name: '12-charge-line', warp: [2.0, 0, -58.0], az: 0, polar: 1.30, dist: 8.5,
    cast: [['curler', 3.4, -5.2]],
    setup: (p) => { window.__aim(p); combat.forceState(window.__cast[0], 'telegraph'); },
    steps: 8,
  },
  {
    name: '13-slam-arc', warp: [2.0, 0, -58.0], az: 0, polar: 1.28, dist: 8.0,
    cast: [['bellow', 2.4, -2.8]],
    setup: (p) => { window.__aim(p); combat.forceState(window.__cast[0], 'telegraph'); },
    steps: 10,
  },
  {
    name: '14-blade-trail', warp: [2.0, 0, -58.0], az: 0, polar: 1.22, dist: 6.8,
    cast: [['nettle', 1.5, -1.6]],
    setup: (p) => { __face(p[0] + 1.5, p[2] - 1.6); },
    attack: true, steps: 11,
  },
  {
    name: '15-full-cast', warp: [0, 0, -52.0], az: 0, polar: 1.24, dist: 11.0,
    cast: [['nettle', -5.0, -6], ['curler', -2.4, -6], ['bellow', 0.2, -6.6],
           ['woolt', 3.0, -6], ['flitter', 5.2, -5.4]],
    steps: 24,
  },
];

const want = process.argv.slice(2);
const list = want.length
  ? SHOTS.filter((s) => want.some((w) => s.name.includes(w)))
  : SHOTS;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
// A SHOT THAT WALKS runs several hundred stepped frames before the capture,
// and at 1600x900 that is slow enough to blow the 30 s default -- which
// surfaces as "page.screenshot: Timeout" and looks like the page has died.
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction('typeof window.__sim === "function"', null, { timeout: 60000 });
await page.waitForFunction(
  'window.combat && combat.enemies.length > 0 && __sim({steps:1}).who', null, { timeout: 60000 });

// Freeze the roaming encounters so a shot framed on empty meadow stays empty
// and a shot framed on a pinned enemy does not collect three of its friends.
await page.evaluate(() => { if (window.__freezeEncounters) __freezeEncounters(true); });

await mkdir(OUT, { recursive: true });

for (const s of list) {
  const info = await page.evaluate(async (shot) => {
    // clear whatever the last shot spawned, then settle: land on the ground and
    // let the camera arrive before anything else happens
    for (const e of window.__cast || []) { e.dead = true; e.deadT = 9; }
    window.__cast = [];
    __sim({ warp: shot.warp, az: shot.az, polar: shot.polar, dist: shot.dist, steps: 40 });
    for (const [name, dx, dz] of shot.cast || []) {
      const e = combat.spawn(name, shot.warp[0] + dx, shot.warp[2] + dz);
      if (e) { e.home.copy(e.pos); window.__cast.push(e); }
    }
    // A forced state does not steer, and spawn gives a RANDOM facing -- so a
    // telegraph shot framed the ground tell pointing off into a field. Point
    // the cast at the player before freezing them.
    window.__aim = (w) => {
      for (const e of window.__cast) {
        e.facing = Math.atan2(w[0] - e.pos.x, w[2] - e.pos.z);
      }
    };
    if (shot.setupSrc) {
      // eslint-disable-next-line no-new-func
      new Function('p', `return (${shot.setupSrc})(p)`)(shot.warp);
    }
    // Some framings can only be reached on foot -- the cellar is under the
    // paving, so a warp lands on the square above it.
    if (shot.walk) {
      for (let i = 0; i < shot.walk.frames; i++) {
        __sim({ steps: 1, az: shot.az, held: shot.walk.keys });
      }
    }
    // ...or steer through a list of waypoints, for anywhere the route matters
    for (const [tx, tz] of shot.walkTo || []) {
      for (let i = 0; i < 420; i++) {
        const h = __sim({ steps: 0 }).heroPos;
        if (Math.hypot(tx - h[0], tz - h[2]) < 0.6) break;
        __sim({ steps: 1, az: Math.atan2(h[0] - tx, h[2] - tz), held: ['KeyW'] });
      }
    }
    return __sim({
      steps: shot.steps ?? 20, az: shot.az, polar: shot.polar, dist: shot.dist,
      attack: !!shot.attack,
    });
  }, { ...s, setupSrc: s.setup ? s.setup.toString() : null, setup: undefined });

  const buf = await page.screenshot({ type: 'jpeg', quality: 88 });
  await writeFile(`${OUT}/${s.name}.jpg`, buf);
  const near = info.foes.filter((f) => f.d < 14);
  console.log(`${s.name}  ${info.draws} draws · ${(info.tris / 1000) | 0}k tris`
              + `  ${near.map((f) => f.k + ':' + f.s).join(',') || 'no foes in frame'}`);
}

if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
await browser.close();
