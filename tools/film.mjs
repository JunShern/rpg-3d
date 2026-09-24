// film.mjs -- record the demo as an actual video, with its own music on it.
//
// WHY THIS EXISTS. Screenshots cannot show a camera move, a party keeping up
// with you, an afternoon going down, or a bell. And the person this is being
// built for is travelling with a phone and no laptop, so a playable build is
// invisible to them: the deliverable has to be a file you can watch on a train.
//
// HOW IT WORKS, and the only interesting part is that it is not a screen
// recording. `__sim` takes the render loop off rAF -- it already did, so that
// captures would be deterministic -- which means the page only advances when
// asked. So this steps the world by exactly 1/30 s, screenshots, steps again.
// A stalled frame, a slow shadow pass or a garbage collection changes nothing
// about the output, because there is no wall clock in the loop at all.
//
// THE AUDIO IS RENDERED SEPARATELY AND MUXED. There is no way to capture a
// WebAudio graph out of headless Chromium, but the audio is synthesised from a
// score this project controls -- so the same events are rendered offline
// through an OfflineAudioContext at the same timestamps and handed to ffmpeg
// as a WAV. It is the same music, arrived at the other way round.
//
//   node tools/film.mjs                  # the whole thing
//   node tools/film.mjs --scene ring     # one sequence
//   node tools/film.mjs --fps 30 --w 1280

import { chromium } from 'playwright';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';

const run = promisify(execFile);
const URL = process.env.SHOT_URL || 'http://localhost:3100/';
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);

const FPS = Number(opt('--fps', 30));
const W = Number(opt('--w', 1280));
const H = Math.round(W * 9 / 16);
const ONLY = opt('--scene', null);
const OUT = 'docs/film';
const TMP = '/tmp/rpg-film';

// ---------------------------------------------------------------- the cut
//
// A shot list for the FILM, which is a different thing from the game's cutscene
// list: it interleaves cinematic sequences with real gameplay, because a video
// that is all cutscene is a trailer for a game nobody has seen played.
//
// `kind: 'cine'`  -- run a sequence from cine.js
// `kind: 'play'`  -- drive the actual game: walk, fight, talk
const CUT = [
  { kind: 'cine', scene: 'open', hour: 0.10, zone: 'town',
    setup: `quest.skipTo('q.start');` },

  // GAMEPLAY. The party walking the square at late afternoon -- this is the
  // shot that says the thing the whole session was for: three people, moving.
  { kind: 'play', secs: 7.0, hour: 0.30, zone: 'town',
    // footfalls, so the walk has a floor under it
    cue: [[0.4, 'step_stone', 0.5], [1.0, 'step_stone', 0.5], [1.6, 'step_stone', 0.5],
          [2.2, 'step_stone', 0.5], [2.8, 'step_stone', 0.5], [3.4, 'step_stone', 0.5],
          [4.0, 'step_stone', 0.5], [4.6, 'step_stone', 0.5], [5.2, 'step_stone', 0.5]],
    setup: `
      quest.skipTo('q.maren');
      __sim({ warp: [2.0, 0, 9.5], az: 0.30, polar: 1.20, dist: 6.4, steps: 20 });
      party.warp(2.0, 9.5, Math.PI);`,
    drive: `(f) => __sim({ steps: 1, az: 0.30 + f * 0.0016, held: ['KeyW'] })` },

  // A FIGHT, with the party in it.
  { kind: 'play', secs: 8.5, hour: 0.42, zone: 'battle',
    // a combo, then the party joining in
    cue: [[1.1, 'swing', 0.9], [1.28, 'hit_hard', 0.9],
          [1.7, 'swing2', 0.9], [1.88, 'hit_hard', 0.9],
          [2.4, 'swing3', 1.0], [2.62, 'crit', 1.0],
                    [4.2, 'swing3', 0.9], [4.45, 'crit', 1.0], [4.9, 'die', 0.9],
          [5.7, 'coin', 0.7],
          [6.9, 'swing', 0.9], [7.1, 'hit_hard', 0.9]],
    setup: `
      quest.skipTo('q.maren');
      __sim({ warp: [6, 0, -46], az: 0.7, polar: 1.18, dist: 7.0, steps: 20 });
      party.warp(6, -46, 0.7);
      combat.spawn('nettle', 8.5, -48.5);
      combat.spawn('nettle', 4.0, -49.0);
      combat.spawn('curler', 7.0, -51.0);`,
    drive: `(f) => {
      if (f % 22 === 0) combat.attack();
      __sim({ steps: 1, az: 0.7 + Math.sin(f * 0.012) * 0.25,
              held: f < 70 ? ['KeyW'] : [] });
    }` },

  // A CONVERSATION, so the writing and the portraits are in the film.
  { kind: 'play', secs: 9.0, hour: 0.55, wait: 900, zone: 'hush',
    // the voice blips under the typewriter, pitched for the Sexton
    cue: Array.from({ length: 46 }, (_, i) => [0.7 + i * 0.085, 'blip', 0.8])
           .concat([[5.2, 'ui_ok', 0.7]]),
    setup: `
      quest.skipTo('q.accepted');
      const n = npcs.at('sexton');
      __sim({ warp: [n.x + 0.9, 1, n.z - 1.3], az: 2.5, polar: 1.20, dist: 5.0, steps: 22 });
      npcs.tryTalk();`,
    drive: `(f) => {
      if (f === 120) { Dialogue.finishLine(); Dialogue.key('confirm'); }
      if (f === 210) { Dialogue.finishLine(); Dialogue.key('confirm'); }
      __sim({ steps: 1 });
    }` },

  { kind: 'cine', scene: 'ring', hour: 0.97, zone: 'hush',
    // THE BELL, three times, at the top of the second shot. Everything the
    // demo is for lands on these three strikes -- and they are spaced 3.1 s
    // apart because the Sexton says to count to three after, and a bell whose
    // partials have not finished before the next strike is a bell in a hurry.
    cue: [[2.2, 'bell', 1.0], [5.3, 'bell', 1.0], [8.4, 'bell', 0.95]],
    setup: `
      quest.skipTo('q.cleared');
      GS.state.flags['q.rung'] = true;
      __sim({ warp: [-1, 0, 13.5], az: 0, steps: 20 });`,
    at: [[2.2, `__audio.play('bell', { x: -1, y: 22.4, z: 15.5 }, 1.0);`]] },
];

// ------------------------------------------------------------------- video
async function frames(pg, shot, dir, index) {
  const n = Math.round((shot.secs || 0) * FPS);
  let count = 0;
  const grab = async () => {
    const buf = await pg.screenshot({ type: 'jpeg', quality: 92, timeout: 120000 });
    await writeFile(`${dir}/${String(index + count).padStart(5, '0')}.jpg`, buf);
    count++;
  };

  if (shot.kind === 'cine') {
    const total = await pg.evaluate((s) => __cine.duration(__scenes[s]), shot.scene);
    const N = Math.round(total * FPS);
    await pg.evaluate(([s, fps]) => { __cine.play(__scenes[s]); __sim({ steps: 1 }); },
                      [shot.scene, FPS]);
    for (let f = 0; f < N; f++) {
      await pg.evaluate(([fps, marks, fr]) => {
        for (const [at, code] of marks || []) {
          if (Math.abs(fr / fps - at) < 0.5 / fps) (0, eval)(code);
        }
        // ONE STEP, AND THE GAME TAKES IT. `frame()` already advances the
        // cutscene -- stepping it here as well ran every sequence at double
        // speed, so it finished half way through its own shot list and the
        // gameplay camera quietly took over for the rest of the take. The
        // footage looked fine, which is why it took a contact sheet to catch.
        __sim({ steps: 1, dt: 1 / fps });
      }, [FPS, shot.at || [], f]);
      await grab();
    }
    await pg.evaluate(() => __cine.stop());
    return count;
  }

  // gameplay
  for (let f = 0; f < n; f++) {
    await pg.evaluate(([code, fr]) => { (0, eval)('(' + code + ')')(fr); },
                      [shot.drive, f]);
    await grab();
  }
  return count;
}

// ------------------------------------------------------------------- audio
//
// RENDERED, NOT RECORDED. There is no way to pull a WebAudio graph out of
// headless Chromium -- there is no speaker and no capture device. But the
// music is synthesised from a score this project owns, so the soundtrack is
// produced by running the same engine against an OfflineAudioContext with the
// same events at the same timestamps. It is the same music arrived at the
// other way round, and it is sample-exact rather than a recording of a
// browser trying to keep up.
//
// EVERYTHING IS SCHEDULED ON THE AUDIO CLOCK. `setTimeout` runs on wall clock
// and an offline render outruns wall clock, so a timer-driven note lands after
// the render has already finished. That mistake once had me believing the
// entire engine was silent.
async function renderAudio(pg, cues, seconds) {
  const pcm = await pg.evaluate(async ([cues, secs]) => {
    const { makeAudio } = await import('/js/audio.js');
    const oac = new OfflineAudioContext(2, Math.ceil(44100 * secs), 44100);
    const real = window.AudioContext;
    window.AudioContext = function () { return oac; };
    const a = makeAudio();
    a.boot();
    window.AudioContext = real;

    a.ambience({ wind: 0.16, birds: 0.30, water: 0, forge: 0 });

    // walk the zones, pumping the scheduler up to each change
    let t = 0;
    for (const [at, zone] of cues.zones) {
      if (at > t) { a.pump(at); t = at; }
      a.cut(zone);
    }
    a.pump(secs);

    for (const [at, name, vol] of cues.sfx) a.playAt(at, name, vol);

    const buf = await oac.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);

    // NORMALISE BEFORE QUANTISING, and this is where the clipping actually
    // was. Clamping a float to +-32767 is hard clipping: a fight that sums
    // fifteen one-shot graphs over a battle theme goes past 1.0, every sample
    // above it becomes the same value, and the result is a square wave that
    // no amount of downstream `loudnorm` can un-square -- it was still
    // reporting a 0.0 dB peak after mastering, which is what gave it away.
    let peak = 0;
    for (let i = 0; i < L.length; i++) {
      const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (v > peak) peak = v;
    }
    const g = peak > 0.89 ? 0.89 / peak : 1;
    const out = new Int16Array(L.length * 2);
    for (let i = 0; i < L.length; i++) {
      out[i * 2]     = Math.round(L[i] * g * 32767);
      out[i * 2 + 1] = Math.round(R[i] * g * 32767);
    }
    return { pcm: Array.from(new Uint8Array(out.buffer)),
             peak: +peak.toFixed(3), gain: +g.toFixed(3) };
  }, [cues, seconds]);
  console.log(`  score peak ${pcm.peak} -> scaled by ${pcm.gain}`);
  return Buffer.from(pcm.pcm);
}

function wav(pcm, rate = 44100, ch = 2) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// -------------------------------------------------------------------- main
async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const pg = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await pg.goto(URL);
  // THE REAL READINESS SIGNAL, which is the same pair smoke.mjs waits on.
  // I had been waiting on `window.__ready` -- a flag that does not exist and
  // never has. Every probe this session wrote it with a `.catch(() => {})`
  // after it, so the wait timed out and execution carried on regardless, and
  // the invention was invisible until a tool without the catch sat there for
  // two minutes and gave up.
  await pg.waitForFunction('typeof window.__sim === "function"', null, { timeout: 90000 });
  await pg.waitForFunction(
    'window.combat && combat.enemies.length > 0 && __sim({steps:1}).who',
    null, { timeout: 90000 });
  await pg.waitForFunction("combat.enemies.some((e) => e.name === 'woolt')",
                           null, { timeout: 90000 });
  await pg.waitForTimeout(1500);
  await pg.evaluate(async () => { await window.GS.ready; });

  let index = 0;
  const cues = { zones: [], sfx: [] };
  const list = ONLY ? CUT.filter((c) => c.scene === ONLY || c.kind === ONLY) : CUT;
  for (const [i, shot] of list.entries()) {
    // THE SOUNDTRACK IS BUILT FROM THE SAME SHOT LIST, at the timestamps the
    // frames actually land on -- so it cannot drift out of sync with the cut.
    const t0 = index / FPS;
    if (shot.zone) cues.zones.push([t0, shot.zone]);
    for (const [at, name, vol] of shot.cue || []) cues.sfx.push([t0 + at, name, vol]);
    await pg.evaluate(([code, h]) => {
      __cine.stop();
      if (h !== undefined) { __atmos.setHour(h); }
      (0, eval)(code);
      __sim({ steps: 2 });
    }, [shot.setup || '', shot.hour]);
    if (shot.wait) await pg.waitForTimeout(shot.wait);
    const n = await frames(pg, shot, TMP, index);
    index += n;
    console.log(`  shot ${i + 1}/${list.length}  ${shot.kind}${shot.scene ? ':' + shot.scene : ''}  ${n} frames`);
  }
  console.log(`page errors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);

  const secs = index / FPS;
  console.log(`\n${index} frames = ${secs.toFixed(1)} s`);

  const browserClose = () => browser.close();

  // ---- encode ----
  const mp4 = `${OUT}/emberbrook.mp4`;
  const wavPath = `${TMP}/score.wav`;
  await writeFile(wavPath, wav(await renderAudio(pg, cues, secs + 1.2)));
  console.log(`rendered ${(secs + 1.2).toFixed(1)} s of score`);
  await browserClose();

  // MASTERED, because this is going to be watched on a phone. The raw mix runs
  // from -36 dB (a music bed alone) to 0.0 dB (a three-hit combo landing on
  // top of the battle theme) -- which clips at the top and is inaudible at the
  // bottom on any speaker smaller than a laptop. `loudnorm` brings the whole
  // thing to -16 LUFS with a true-peak ceiling of -1.5 dB, which is the
  // streaming standard and exactly the problem it was built for.
  await run(ffmpeg, [
    '-y', '-framerate', String(FPS), '-i', `${TMP}/%05d.jpg`, '-i', wavPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9',
    '-c:a', 'aac', '-b:a', '160k', '-shortest',
    '-movflags', '+faststart', mp4,
  ]);
  console.log(`wrote ${mp4}`);

  // a GIF too: it plays inline in a chat window, which an mp4 does not
  const gif = `${OUT}/emberbrook.gif`;
  await run(ffmpeg, [
    '-y', '-i', mp4, '-vf',
    'fps=14,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', gif,
  ]);
  console.log(`wrote ${gif}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
