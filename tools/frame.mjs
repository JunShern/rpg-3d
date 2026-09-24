// frame.mjs -- put the camera somewhere and look at it. A tuning tool.
//
// Cinematic shots are placed by eye and there is no substitute; this makes the
// loop "type six numbers, see the frame" instead of "edit a file, rebuild,
// run the sequence, catch the right moment".
//
//   node tools/frame.mjs  "x,y,z  lx,ly,lz  [fov]"  ...
import { chromium } from 'playwright';
const URL = process.env.SHOT_URL || 'http://localhost:3100/';
const args = process.argv.slice(2);
const hour = Number(process.env.HOUR ?? 0.15);
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pg = await b.newPage({ viewport: { width: 1180, height: 664 } });
pg.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 160)));
await pg.goto(URL);
await pg.waitForFunction(() => window.__sim && window.__ready, null, { timeout: 90000 }).catch(() => {});
await pg.waitForTimeout(5500);
await pg.evaluate((h) => { __atmos.setHour(h); __sim({ warp: [-1, 0, 6], az: 0, steps: 20 }); }, hour);
let i = 0;
for (const a of args) {
  const [p, l, f] = a.trim().split(/\s{2,}|\s*\|\s*/);
  const pos = p.split(',').map(Number), look = l.split(',').map(Number);
  await pg.evaluate(([pp, ll, ff]) => {
    __cine.stop();
    document.body.classList.add('cine');
    camera.fov = ff || 45; camera.updateProjectionMatrix();
    camera.position.set(pp[0], pp[1], pp[2]);
    camera.lookAt(ll[0], ll[1], ll[2]);
    __sim({ steps: 1 });
    // re-assert: __sim runs updateCamera and moves it back
    camera.position.set(pp[0], pp[1], pp[2]);
    camera.lookAt(ll[0], ll[1], ll[2]);
    if (window.__lookFrame) __lookFrame();      // re-centre the grass on this camera
    __atmos.render();
  }, [pos, look, f ? Number(f) : 45]);
  await pg.waitForTimeout(200);
  await pg.screenshot({ path: `/tmp/frame-${i}.jpg`, type: 'jpeg', quality: 88, timeout: 60000 });
  console.log(`/tmp/frame-${i}.jpg   pos ${p}  look ${l}`);
  i++;
}
await b.close();
