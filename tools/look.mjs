// look.mjs -- the look-dev loop. One page load, a fixed set of reference views,
// one contact sheet.
//
// Judging a rendering change from a single frame is how a change that helps
// the meadow and ruins the plaza gets committed. Every change to the look is
// judged against the SAME six views, at the same hour, side by side, with the
// HUD out of the way -- so "is this better" is a comparison and not a mood.
//
//   node tools/look.mjs [tag]          -> $OUT/<tag>-sheet.jpg (+ each view)
//   ONLY=0,3 node tools/look.mjs tag   -> just those views
//   W=1600 node tools/look.mjs tag     -> bigger frames
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const URL = process.env.SHOT_URL || 'http://localhost:3100/';
const TAG = process.argv[2] || 'look';
const OUT = process.env.OUT || '/tmp/look';
const W = Number(process.env.W || 1280), H = Math.round(W * 9 / 16);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;

// Gameplay-camera views use the player's own rig (warp + orbit); `cam` views
// are free cameras for vistas the rig cannot reach.
// SET=town swaps in the town views, for the town rebuild
const TOWN_VIEWS = [
  { name: 'plaza',        warp: [0.6, 0, 5.6], az: 0, polar: 1.14, dist: 7.0, hour: 0.15 },
  { name: 'facade-east',  warp: [6.0, 0, 2.0], az: -1.2, polar: 1.32, dist: 6.5, hour: 0.15 },
  { name: 'facade-west',  warp: [-6.0, 0, 0.0], az: 1.4, polar: 1.32, dist: 6.5, hour: 0.15 },
  { name: 'tower-foot',   warp: [-1.0, 0, 6.0], az: 3.14, polar: 1.40, dist: 8.0, hour: 0.15 },
  { name: 'town-high',    cam: [[16, 14, -12], [-2, 3, 8], 50], warp: [0, 0, 0], hour: 0.15 },
  { name: 'gate-in',      warp: [-1.0, 0, -14.0], az: 3.14, polar: 1.30, dist: 7.0, hour: 0.15 },
  { name: 'plaza-low',    cam: [[4, 1.7, 3], [-10, 4.5, 8], 55], warp: [4, 0, 3], hour: 0.15 },
  { name: 'plaza-dusk',   warp: [0.6, 0, 5.6], az: 0.6, polar: 1.20, dist: 8.0, hour: 0.93 },
  { name: 'roofs',        cam: [[-14, 12, 14], [4, 5, -4], 50], warp: [0, 0, 0], hour: 0.15 },
];
export const VIEWS_ALL = [
  { name: 'meadow-ford',  warp: [-1.0, 0, -41.0], az: -0.55, polar: 1.30, dist: 9.0, hour: 0.15 },
  { name: 'ruin',         warp: [-14.0, 6, -50.0], az: 0.0, polar: 1.28, dist: 9.5, hour: 0.15 },
  { name: 'plaza',        warp: [0.6, 0, 5.6], az: 0, polar: 1.14, dist: 7.0, hour: 0.15 },
  { name: 'vista',        cam: [[26, 15, -78], [0, 3, -22], 50], warp: [0, 0, -52], hour: 0.15 },
  { name: 'hero-close',   warp: [-3.0, 0, -35.0], az: 2.2, polar: 1.36, dist: 3.6, hour: 0.15 },
  { name: 'town-dusk',    warp: [0, 0, -30.0], az: Math.PI, polar: 1.30, dist: 9.0, hour: 0.92 },
  { name: 'sky-west',     cam: [[4, 4, -60], [-60, 22, -120], 55], warp: [4, 0, -60], hour: 0.15 },
  { name: 'stream-low',   cam: [[-4, 2.2, -44], [8, 0.2, -50], 50], warp: [-4, 0, -40], hour: 0.15 },
  { name: 'meadow-dusk',  warp: [4.0, 0, -58.0], az: 2.8, polar: 1.28, dist: 8.0, hour: 0.80 },
];

// THE REAL GPU. Headless Chromium defaults to SwiftShader -- a CPU rasteriser
// -- which made every capture take 100 s and made frame rates meaningless.
// ANGLE-on-Metal gives it the machine's actual GPU.
export const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const VIEWS = process.env.SET === 'town' ? TOWN_VIEWS : VIEWS_ALL;
const b = await chromium.launch({ args: GPU_ARGS });
const pg = await b.newPage({ viewport: { width: W, height: H } });
pg.setDefaultTimeout(180000);
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e).slice(0, 240)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 240)); });
await pg.goto(URL);
await pg.waitForFunction('typeof window.__sim === "function"', null, { timeout: 90000 });
await pg.waitForFunction('window.combat && combat.enemies.length > 0 && __sim({steps:1}).who',
                         null, { timeout: 90000 });
await pg.evaluate((keepHud) => {
  if (window.__freezeEncounters) __freezeEncounters(true);
  if (keepHud) return;
  // hide the HUD the way a cutscene does, without the letterbox
  document.body.classList.add('cine');
  for (const id of ['hud', 'help', 'vitals', 'purse', 'gains', 'objective', 'talkprompt']) {
    const el = document.getElementById(id); if (el) el.style.visibility = 'hidden';
  }
}, !!process.env.HUD);
await mkdir(OUT, { recursive: true });

const files = [];
for (const [i, v] of VIEWS.entries()) {
  if (ONLY && !ONLY.includes(i)) continue;
  const t0 = Date.now();
  await pg.evaluate((v) => {
    // THE HOUR FIRST, then step: the lamps, the windows and the cast's rim
    // follow the hour inside frame(), so setting it only after the steps
    // captured every dusk view with its lamps still at their noon setting
    __atmos.setHour(v.hour ?? 0.15);
    __sim({ warp: v.warp, az: v.az ?? 0, polar: v.polar ?? 1.22, dist: v.dist ?? 6, steps: 30 });
    // the quest eases the hour toward its own stage every frame, so the hour
    // is pinned AFTER the steps and the frame re-rendered under it
    __atmos.setHour(v.hour ?? 0.15);
    if (v.cam) {
      const [p, l, f] = v.cam;
      camera.fov = f; camera.updateProjectionMatrix();
      camera.position.set(...p); camera.lookAt(...l);
      __atmos.follow({ x: l[0], y: l[1], z: l[2] });
    }
    if (window.__lookFrame) __lookFrame();
    __atmos.render();
  }, v);
  const path = `${OUT}/${TAG}-${i}-${v.name}.jpg`;
  await pg.screenshot({ path, type: 'jpeg', quality: 90, animations: 'disabled' });
  files.push(path);
  // time the frame honestly: a few real renders, wall clock, GPU flushed
  const st = await pg.evaluate(() => {
    const gl = document.getElementById('view').getContext('webgl2');
    const px = new Uint8Array(4);
    const t = performance.now();
    for (let i = 0; i < 6; i++) { if (window.__lookFrame) __lookFrame(); __atmos.render(); }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = (performance.now() - t) / 6;
    return { ...__atmos.stats, ms };
  });
  console.log(`${path}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${st.calls} draws ${Math.round(st.triangles / 1000)}k tris  ${st.ms.toFixed(1)} ms/frame`);
}
await b.close();
if (errs.length) console.log('ERRORS:\n  ' + [...new Set(errs)].slice(0, 8).join('\n  '));

if (files.length > 1) {
  const sheet = `${OUT}/${TAG}-sheet.jpg`;
  const cols = files.length > 4 ? 3 : 2;
  const rows = Math.ceil(files.length / cols);
  const inputs = files.flatMap((f) => ['-i', f]);
  const scaled = files.map((_, k) => `[${k}:v]scale=640:360[s${k}]`).join(';');
  const pad = [];
  // pad missing tiles with black so xstack has a full grid
  const n = cols * rows;
  let chain = scaled;
  for (let k = files.length; k < n; k++) {
    pad.push('-f', 'lavfi', '-i', 'color=black:s=640x360');
    chain += `;[${k}:v]null[s${k}]`;
  }
  const layout = Array.from({ length: n }, (_, k) => `${(k % cols) * 640}_${Math.floor(k / cols) * 360}`).join('|');
  const inputsAll = [...inputs, ...pad];
  chain += ';' + Array.from({ length: n }, (_, k) => `[s${k}]`).join('') + `xstack=inputs=${n}:layout=${layout}[o]`;
  execFileSync(ffmpeg, ['-y', ...inputsAll, '-filter_complex', chain, '-map', '[o]', '-frames:v', '1', '-q:v', '3', sheet],
               { stdio: 'pipe' });
  console.log('sheet', sheet);
}
