// audio.js -- everything you hear. Synthesised, not sampled.
//
// THE GAME WAS SILENT. Completely: you could ring a belltower and hear
// nothing, land a three-hit combo and hear nothing, walk from cobbles onto
// grass and hear nothing. That is the largest single gap between this and a
// game, and it is invisible in every screenshot, which is exactly why it
// survived so long. Rule (p) again -- an effect you cannot perceive from where
// you trigger it is not a feature -- and the bell is the case in point, because
// it has a ROPE that moves so you can see the ring you cannot hear.
//
// WHY SYNTHESISED.  The rest of this project generates its own assets: the
// meadow is a closed-form function, the paving is a noise field, the characters
// are built from a geometry kit. Shipping a folder of .ogg files would be the
// one place we bought something instead of building it -- and it would be ~20 MB
// for a demo whose entire GLB payload is 40. Every sound below is a few dozen
// lines of DSP and costs nothing to download.
//
// THREE LAYERS, and they are mixed on separate busses so they can duck one
// another:
//   SFX     one-shots, positioned in the world
//   AMBIENT loops tied to places -- birds, water at the ford, the forge fire
//   MUSIC   a scheduler playing authored chord charts, one per zone
//
// BROWSERS REFUSE TO MAKE NOISE until the user has interacted with the page, so
// the context is created lazily on the first key or click and everything before
// that is a silent no-op. The headless suite never interacts, so it never makes
// a context, so audio is structurally incapable of breaking a check -- which is
// why every entry point here tolerates `ctx === null`.

const A4 = 440;
// semitones from A4 -> Hz. Note names are parsed as C4, F#3, Bb5.
const NOTE = { c: -9, d: -7, e: -5, f: -4, g: -2, a: 0, b: 2 };
export function hz(name) {
  const m = /^([a-g])([#b]?)(-?\d)$/i.exec(String(name).trim());
  if (!m) return 440;
  let s = NOTE[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  s += (parseInt(m[3], 10) - 4) * 12;
  return A4 * Math.pow(2, s / 12);
}

export function makeAudio() {
  let ctx = null;
  let master = null, busSfx = null, busAmb = null, busMus = null, verb = null;
  let started = false;
  let muted = false;
  // MEASURED. A tap on the master said a full combo peaked at 0.048 and the
  // loudest thing in the game was a menu fanfare at 0.216 -- everything 15 to
  // 25 dB below the ceiling, and the fight quieter than the UI. These are the
  // numbers that put impacts at the top of the mix where they belong.
  const settings = { master: 0.95, sfx: 2.6, ambient: 0.85, music: 1.25 };

  // ---------------------------------------------------------------- boot
  function boot() {
    if (ctx || started) return ctx;
    started = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }

    master = ctx.createGain();
    master.gain.value = muted ? 0 : settings.master;
    // A LIMITER, not a volume knob. Twelve overlapping one-shots during a combo
    // will clip a naive sum into buzzing mush; this is the difference between
    // "loud" and "distorted".
    const comp = ctx.createDynamicsCompressor();
    // -6, not -12: with the levels above, a -12 threshold was compressing the
    // whole mix all the time, which is how you get a game that sounds loud and
    // has no impact. It should only catch the peaks of a busy fight.
    comp.threshold.value = -6;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    master.connect(comp).connect(ctx.destination);

    // REVERB FROM NOISE. A convolver needs an impulse response and an impulse
    // response is just a decaying noise burst -- 0.4 s of it turns a dry click
    // into a click in a place. It is the cheapest "this is a physical space"
    // there is, and without it a synthesised bell sounds like a phone alarm.
    verb = ctx.createConvolver();
    verb.buffer = impulse(2.1, 2.6);
    const verbGain = ctx.createGain();
    verbGain.gain.value = 0.9;
    verb.connect(verbGain).connect(master);

    busSfx = ctx.createGain(); busSfx.gain.value = settings.sfx;
    busAmb = ctx.createGain(); busAmb.gain.value = settings.ambient;
    busMus = ctx.createGain(); busMus.gain.value = settings.music;
    for (const b of [busSfx, busAmb, busMus]) b.connect(master);

    startMusic();
    startAmbient();
    return ctx;
  }

  function impulse(secs, decay) {
    const n = Math.floor(ctx.sampleRate * secs);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // a touch of early-reflection sparkle in the first 60 ms, then a smooth
        // exponential tail -- pure exponential noise sounds like a hiss gate
        const early = t < 0.03 ? (Math.random() * 2 - 1) * 0.6 : 0;
        d[i] = ((Math.random() * 2 - 1) + early) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  // -------------------------------------------------------------- voices
  //
  // Everything below builds one short graph, starts it, and lets it stop
  // itself. Nodes are disposable: WebAudio collects a stopped source, and
  // pooling them is the kind of optimisation that trades a real bug for an
  // imaginary saving.

  // FORCED TIME, for offline rendering. Every voice below takes its default
  // `t0` from `now()`, so overriding this one function is enough to schedule
  // the entire SFX table at an arbitrary moment instead of "as soon as
  // possible" -- which is what a film needs and a game never does.
  let forcedT = null;
  const now = () => (forcedT !== null ? forcedT : (ctx ? ctx.currentTime : 0));

  /** An ADSR-ish gain envelope. `peak` at `t0+a`, down to 0 by `t0+a+d`. */
  function env(t0, a, d, peak, dest) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    g.connect(dest);
    return g;
  }

  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      const n = ctx.sampleRate * 2;
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    return s;
  }

  /** A filtered noise burst: footsteps, whooshes, impacts, wind. */
  function hiss({ t0 = now(), a = 0.004, d = 0.12, peak = 0.3, type = 'bandpass',
                  f0 = 1200, f1 = null, q = 1.2, dest = null, wet = 0.12 }) {
    const src = noise();
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t0);
    if (f1 !== null) flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + a + d);
    const g = env(t0, a, d, peak, dest || busSfx);
    src.connect(flt).connect(g);
    if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s).connect(verb); }
    src.start(t0); src.stop(t0 + a + d + 0.05);
    return g;
  }

  /** A pitched voice. `f1` sweeps, which is most of what sells a whoosh. */
  function tone({ t0 = now(), f = 440, f1 = null, a = 0.005, d = 0.3, peak = 0.25,
                  type = 'sine', dest = null, wet = 0.14, detune = 0 }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f, t0);
    if (f1 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + a + d);
    const g = env(t0, a, d, peak, dest || busSfx);
    o.connect(g);
    if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s).connect(verb); }
    o.start(t0); o.stop(t0 + a + d + 0.05);
    return g;
  }

  // ------------------------------------------------------ world position
  //
  // Not a PannerNode. The listener is a third-person camera looking at a
  // character, so "where the sound is" in the mix is better described by its
  // offset from the CHARACTER projected onto the camera's right vector than by
  // a full HRTF model of a head that is not where the player's attention is.
  // Two numbers -- pan and gain -- and they are both cheap.
  let listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
  function setListener(pos, camRightX, camRightZ) {
    listener.x = pos.x; listener.y = pos.y; listener.z = pos.z;
    listener.rx = camRightX; listener.rz = camRightZ;
  }

  const ROLLOFF = 17;      // metres to roughly half volume
  function place(at, dest) {
    if (!at) return { node: dest || busSfx, gain: 1 };
    const dx = at.x - listener.x, dy = (at.y || 0) - listener.y, dz = at.z - listener.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const g = 1 / (1 + (d / ROLLOFF) * (d / ROLLOFF));
    if (g < 0.012) return null;                 // inaudible: do not build a graph
    const pan = Math.max(-1, Math.min(1, (dx * listener.rx + dz * listener.rz) / 9));
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const gn = ctx.createGain();
    gn.gain.value = g;
    if (p) { p.pan.value = pan; gn.connect(p).connect(dest || busSfx); }
    else gn.connect(dest || busSfx);
    return { node: gn, gain: g };
  }

  // --------------------------------------------------------------- sfx
  //
  // One entry per sound. They are functions rather than data because the
  // interesting part of a synthesised sound is its STRUCTURE -- a bell is
  // inharmonic partials with per-partial decay, and no table expresses that.

  const SFX = {
    // ---- movement ----------------------------------------------------
    // Surface-aware, because walking from cobbles onto grass and hearing the
    // same click is the sort of thing you do not consciously notice and do
    // absolutely feel.
    step_stone: (g) => { hiss({ peak: 0.20 * g, a: 0.002, d: 0.045, f0: 2100, f1: 900, q: 1.1, dest: cur, wet: 0.16 });
                         tone({ f: 150, f1: 90, a: 0.002, d: 0.05, peak: 0.07 * g, type: 'triangle', dest: cur }); },
    step_grass: (g) => { hiss({ peak: 0.14 * g, a: 0.006, d: 0.11, f0: 3000, f1: 1500, q: 0.7, dest: cur, wet: 0.06 }); },
    step_dirt:  (g) => { hiss({ peak: 0.16 * g, a: 0.004, d: 0.075, f0: 1100, f1: 480, q: 0.9, dest: cur, wet: 0.08 });
                         tone({ f: 110, f1: 70, a: 0.002, d: 0.06, peak: 0.06 * g, type: 'sine', dest: cur }); },
    step_wood:  (g) => { hiss({ peak: 0.13 * g, a: 0.002, d: 0.05, f0: 1500, f1: 700, q: 1.6, dest: cur, wet: 0.13 });
                         tone({ f: 230, f1: 150, a: 0.002, d: 0.09, peak: 0.10 * g, type: 'triangle', dest: cur }); },
    jump:  (g) => { hiss({ peak: 0.13 * g, a: 0.004, d: 0.13, f0: 900, f1: 2200, q: 0.8, dest: cur, wet: 0.1 }); },
    land:  (g) => { hiss({ peak: 0.26 * g, a: 0.002, d: 0.10, f0: 1500, f1: 500, q: 0.9, dest: cur, wet: 0.16 });
                    tone({ f: 130, f1: 60, a: 0.002, d: 0.14, peak: 0.16 * g, type: 'triangle', dest: cur }); },
    slip:  (g) => { hiss({ peak: 0.20 * g, a: 0.02, d: 0.26, f0: 700, f1: 2600, q: 0.6, dest: cur, wet: 0.2 }); },

    // ---- the sword ---------------------------------------------------
    // The whoosh is a band of noise sweeping DOWN in pitch -- up reads as a
    // rising sci-fi zap, and the blade is accelerating away from you.
    swing:  (g) => { hiss({ peak: 0.30 * g, a: 0.028, d: 0.14, f0: 2600, f1: 620, q: 2.4, dest: cur, wet: 0.16 }); },
    swing2: (g) => { hiss({ peak: 0.33 * g, a: 0.022, d: 0.13, f0: 3000, f1: 700, q: 2.6, dest: cur, wet: 0.16 }); },
    swing3: (g) => { hiss({ peak: 0.46 * g, a: 0.05,  d: 0.26, f0: 2200, f1: 380, q: 2.0, dest: cur, wet: 0.24 });
                     tone({ f: 320, f1: 110, a: 0.01, d: 0.3, peak: 0.07 * g, type: 'sawtooth', dest: cur, wet: 0.2 }); },

    // ---- impact ------------------------------------------------------
    // A hit is TWO events a few milliseconds apart: the contact transient and
    // the body of whatever was hit. Collapsing them into one makes every
    // material sound like the same cardboard box.
    hit_soft: (g) => { hiss({ peak: 0.52 * g, a: 0.001, d: 0.065, f0: 900, f1: 260, q: 0.8, dest: cur, wet: 0.14 });
                       tone({ f: 105, f1: 52, a: 0.001, d: 0.15, peak: 0.46 * g, type: 'triangle', dest: cur, wet: 0.1 }); },
    hit_hard: (g) => { hiss({ peak: 0.62 * g, a: 0.001, d: 0.04, f0: 3400, f1: 1200, q: 1.4, dest: cur, wet: 0.2 });
                       tone({ f: 190, f1: 74, a: 0.001, d: 0.19, peak: 0.44 * g, type: 'square', dest: cur, wet: 0.14 }); },
    crit:     (g) => { hiss({ peak: 0.70 * g, a: 0.001, d: 0.09, f0: 4200, f1: 900, q: 1.1, dest: cur, wet: 0.3 });
                       tone({ f: 880, f1: 220, a: 0.002, d: 0.34, peak: 0.16 * g, type: 'sawtooth', dest: cur, wet: 0.3 });
                       tone({ f: 146, f1: 60, a: 0.001, d: 0.28, peak: 0.55 * g, type: 'triangle', dest: cur }); },
    hurt:     (g) => { hiss({ peak: 0.60 * g, a: 0.002, d: 0.16, f0: 700, f1: 180, q: 0.7, dest: cur, wet: 0.18 });
                       tone({ f: 92, f1: 44, a: 0.002, d: 0.3, peak: 0.52 * g, type: 'sawtooth', dest: cur, wet: 0.1 }); },
    die:      (g) => { tone({ f: 300, f1: 60, a: 0.01, d: 0.7, peak: 0.2 * g, type: 'triangle', dest: cur, wet: 0.34 });
                       hiss({ peak: 0.22 * g, a: 0.01, d: 0.5, f0: 1400, f1: 200, q: 0.6, dest: cur, wet: 0.3 }); },

    // ---- props -------------------------------------------------------
    break_wood: (g) => {
      for (let i = 0; i < 5; i++) {
        const t = now() + i * (0.012 + Math.random() * 0.02);
        hiss({ t0: t, peak: (0.34 - i * 0.05) * g, a: 0.001, d: 0.05 + Math.random() * 0.06,
               f0: 1800 + Math.random() * 2200, f1: 500, q: 2.2, dest: cur, wet: 0.2 });
      }
      tone({ f: 170, f1: 70, a: 0.002, d: 0.22, peak: 0.34 * g, type: 'triangle', dest: cur, wet: 0.16 });
    },
    // The find. Bright, rising, unmistakably A Good Thing -- it is the one
    // reward the map teaches you to look for.
    pod: (g) => {
      const t = now();
      [0, 0.055, 0.11].forEach((dt, i) => {
        tone({ t0: t + dt, f: hz(['e5', 'a5', 'c6'][i]), a: 0.004, d: 0.5 - i * 0.08,
               peak: (0.2 - i * 0.03) * g, type: 'triangle', dest: cur, wet: 0.4 });
      });
      hiss({ peak: 0.1 * g, a: 0.002, d: 0.2, f0: 5000, f1: 9000, q: 0.8, dest: cur, wet: 0.4 });
    },
    coin: (g) => {
      const t = now();
      tone({ t0: t, f: hz('b5'), a: 0.002, d: 0.14, peak: 0.16 * g, type: 'square', dest: cur, wet: 0.3 });
      tone({ t0: t + 0.06, f: hz('e6'), a: 0.002, d: 0.3, peak: 0.13 * g, type: 'square', dest: cur, wet: 0.35 });
    },
    item: (g) => {
      const t = now();
      [['a4', 0], ['d5', 0.07], ['a5', 0.14]].forEach(([n, dt], i) =>
        tone({ t0: t + dt, f: hz(n), a: 0.006, d: 0.44 - i * 0.06, peak: 0.16 * g,
               type: 'triangle', dest: cur, wet: 0.4 }));
    },
    levelup: (g) => {
      const t = now();
      ['d5', 'f#5', 'a5', 'd6', 'f#6'].forEach((n, i) =>
        tone({ t0: t + i * 0.085, f: hz(n), a: 0.006, d: 0.8, peak: 0.125 * g,
               type: 'triangle', dest: cur, wet: 0.45 }));
      tone({ t0: t, f: hz('d3'), a: 0.02, d: 1.4, peak: 0.12 * g, type: 'sine', dest: cur, wet: 0.3 });
    },

    // ---- THE BELL ----------------------------------------------------
    //
    // The reason this file exists at all. A bell is not a note: it is a set of
    // INHARMONIC partials -- hum, prime, tierce, quint, nominal -- at ratios
    // that are nothing like a harmonic series, each decaying at its own rate.
    // The high partials die in under a second and leave the hum ringing for
    // ten, which is why a real bell seems to get lower as it fades. Stacking
    // octaves instead gives you a church organ.
    bell: (g) => {
      const t = now();
      const f = hz('e3');
      // ratio, level, decay -- the classic strike-note recipe
      const P = [[0.5, 0.60, 9.0], [1.0, 0.50, 7.0], [1.19, 0.32, 4.4],
                 [1.50, 0.26, 3.2], [2.0, 0.30, 2.6], [2.66, 0.14, 1.5],
                 [3.01, 0.11, 1.1], [4.13, 0.07, 0.7], [5.43, 0.05, 0.45]];
      for (const [r, lvl, dec] of P) {
        tone({ t0: t, f: f * r, a: 0.004, d: dec, peak: lvl * 0.16 * g,
               type: 'sine', dest: cur, wet: 0.55,
               // a couple of cents off makes two nominally identical partials
               // beat against each other, which is the shimmer of a real casting
               detune: (Math.random() - 0.5) * 9 });
      }
      // the clapper itself
      hiss({ t0: t, peak: 0.12 * g, a: 0.001, d: 0.09, f0: 3800, f1: 1100, q: 1.3,
             dest: cur, wet: 0.4 });
    },

    // ---- voice -------------------------------------------------------
    // Not speech. A soft blip per character of the typewriter, pitched per
    // speaker -- the Animal Crossing trick, and the cheapest characterisation
    // in games. It is why Tally sounds like a different person from Hobb.
    blip: (g, f) => tone({ f: f || 420, a: 0.004, d: 0.055, peak: 0.055 * g,
                           type: 'square', dest: cur, wet: 0.1 }),

    // ---- ui ----------------------------------------------------------
    ui_move:    (g) => tone({ f: 620, a: 0.002, d: 0.06, peak: 0.07 * g, type: 'square', dest: cur, wet: 0.05 }),
    ui_ok:      (g) => { const t = now();
                         tone({ t0: t, f: 620, a: 0.002, d: 0.08, peak: 0.09 * g, type: 'square', dest: cur, wet: 0.1 });
                         tone({ t0: t + 0.05, f: 930, a: 0.002, d: 0.14, peak: 0.08 * g, type: 'square', dest: cur, wet: 0.14 }); },
    ui_back:    (g) => { const t = now();
                         tone({ t0: t, f: 480, a: 0.002, d: 0.08, peak: 0.08 * g, type: 'square', dest: cur, wet: 0.1 });
                         tone({ t0: t + 0.05, f: 320, a: 0.002, d: 0.13, peak: 0.07 * g, type: 'square', dest: cur, wet: 0.1 }); },
    ui_buy:     (g) => { const t = now();
                         ['a4', 'c#5', 'e5'].forEach((n, i) => tone({ t0: t + i * 0.05, f: hz(n),
                           a: 0.003, d: 0.3, peak: 0.1 * g, type: 'triangle', dest: cur, wet: 0.3 })); },
    ui_refuse:  (g) => tone({ f: 200, f1: 140, a: 0.004, d: 0.2, peak: 0.12 * g, type: 'square', dest: cur, wet: 0.08 }),
  };

  // `cur` is the destination the SFX table writes into. It is module-scoped so
  // the table can stay declarative: `play()` points it at a positioned gain
  // node for the duration of one call. Single-threaded, so this is safe, and
  // the alternative is threading a `dest` argument through forty closures.
  let cur = null;

  /**
   * Fire a one-shot.
   * @param name  key in SFX
   * @param at    world position, or null for "on the player"
   * @param vol   0..1 scale
   */
  function play(name, at = null, vol = 1, arg = null) {
    if (!ctx || muted) return;
    const fn = SFX[name];
    if (!fn) return;
    const p = at ? place(at, busSfx) : { node: busSfx, gain: 1 };
    if (!p) return;                         // too far away to be worth building
    cur = p.node;
    try { fn(vol, arg); } catch (e) { /* never let a sound break a frame */ }
    cur = null;
  }

  // ----------------------------------------------------------- ambience
  //
  // Beds, not one-shots: a filtered noise loop for wind and water, and a
  // sparse scheduler for birdsong. Each has a target gain that the game moves
  // as you walk, so the ford gets louder as you approach it without anything
  // being "triggered".
  const beds = {};
  function bed(name, make) {
    if (!ctx) return null;
    if (beds[name]) return beds[name];
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(busAmb);
    beds[name] = { gain: g, target: 0 };
    make(g);
    return beds[name];
  }

  function startAmbient() {
    // WIND -- two bands of noise at different speeds. One band is a hiss; two
    // moving against each other is weather.
    bed('wind', (g) => {
      for (const [f, q, lvl, rate] of [[420, 0.8, 0.5, 0.07], [900, 1.4, 0.22, 0.11]]) {
        const s = noise();
        const flt = ctx.createBiquadFilter();
        flt.type = 'bandpass'; flt.frequency.value = f; flt.Q.value = q;
        const amp = ctx.createGain(); amp.gain.value = lvl;
        // a slow LFO on the band gives gusts rather than a fan
        const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
        const lg = ctx.createGain(); lg.gain.value = lvl * 0.6;
        lfo.connect(lg).connect(amp.gain);
        s.connect(flt).connect(amp).connect(g);
        s.start(); lfo.start();
      }
    });
    // WATER at the ford: brighter, faster, no gusting.
    bed('water', (g) => {
      for (const [f, q, lvl] of [[1700, 0.7, 0.35], [3800, 1.1, 0.16]]) {
        const s = noise();
        const flt = ctx.createBiquadFilter();
        flt.type = 'bandpass'; flt.frequency.value = f; flt.Q.value = q;
        const amp = ctx.createGain(); amp.gain.value = lvl;
        s.connect(flt).connect(amp).connect(g);
        s.start();
      }
    });
    // THE FORGE: a low roar with an irregular crackle over it.
    bed('forge', (g) => {
      const s = noise();
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.frequency.value = 320; flt.Q.value = 0.6;
      const amp = ctx.createGain(); amp.gain.value = 0.5;
      s.connect(flt).connect(amp).connect(g);
      s.start();
      const crackle = () => {
        if (!ctx) return;
        if (beds.forge && beds.forge.target > 0.01) {
          hiss({ peak: 0.08 + Math.random() * 0.12, a: 0.001, d: 0.03 + Math.random() * 0.05,
                 f0: 1800 + Math.random() * 2600, f1: 800, q: 2, dest: g, wet: 0.05 });
        }
        setTimeout(crackle, 70 + Math.random() * 420);
      };
      setTimeout(crackle, 300);
    });
    birds();
  }

  // BIRDSONG. Two or three chirps in a phrase, a pause, then another -- and
  // pitched from a pentatonic set so a bird never lands on a note that fights
  // the music playing under it.
  function birds() {
    const call = () => {
      if (!ctx) return;
      const b = beds.birds;
      if (b && b.target > 0.02 && !muted) {
        const root = ['a5', 'b5', 'd6', 'e6', 'f#6'][(Math.random() * 5) | 0];
        const n = 2 + ((Math.random() * 3) | 0);
        const t = now();
        for (let i = 0; i < n; i++) {
          const f = hz(root) * (1 + (Math.random() - 0.3) * 0.12);
          tone({ t0: t + i * (0.07 + Math.random() * 0.06), f, f1: f * (1.1 + Math.random() * 0.3),
                 a: 0.006, d: 0.07 + Math.random() * 0.05, peak: 0.05,
                 type: 'sine', dest: b.gain, wet: 0.5 });
        }
      }
      setTimeout(call, 900 + Math.random() * 4200);
    };
    bed('birds', () => {});
    setTimeout(call, 1200);
  }

  /** Set where each bed sits, 0..1. Called every frame by the game. */
  function ambience(mix) {
    if (!ctx) return;
    for (const k of Object.keys(mix)) {
      const b = beds[k] || bed(k, () => {});
      if (!b) continue;
      b.target = mix[k];
      b.gain.gain.setTargetAtTime(Math.max(0.0001, mix[k]), ctx.currentTime, 0.4);
    }
  }

  // -------------------------------------------------------------- music
  //
  // A scheduler, not a player. Songs below are chord charts with a melodic
  // motif; the scheduler walks the chart and voices it. This is a few hundred
  // bytes per theme against a megabyte per minute of audio, it can change key
  // or tempo on the fly, and it can cross-fade between zones sample-accurately
  // because every layer shares one clock.
  //
  // WHY IT MATTERS. A JRPG is its music more than it is its combat. The town
  // theme is the thing the player will still be humming, and a silent town is
  // a tech demo however good the paving looks.

  const SONGS = {
    // Warm, unhurried, a little wistful. The town you start in.
    town: {
      bpm: 84, swing: 0.06, key: 0,
      // [chord root, quality, bars]
      chart: [['d3', 'maj9', 1], ['g3', 'maj7', 1], ['a3', 'sus', 1], ['b2', 'min7', 1],
              ['g3', 'maj7', 1], ['a3', 'dom', 1], ['d3', 'maj9', 2]],
      // scale degrees the melody may use, as semitone offsets from the key
      scale: [0, 2, 4, 7, 9, 11],
      lead: 'pluck', pad: true, bass: true, perc: 'light',
      motif: [[0, 2, 1.0], [2, 1, 0.8], [4, 1, 0.9], [2, 2, 0.7], [0, 2, 0.8], [-3, 4, 0.6]],
    },
    // Open, pastoral, more air between the notes. Out of the gate.
    field: {
      bpm: 92, swing: 0.0, key: 5,
      chart: [['f3', 'maj', 1], ['c3', 'maj', 1], ['g3', 'maj', 1], ['a3', 'min7', 1],
              ['bb2', 'maj7', 1], ['f3', 'maj', 1], ['c3', 'sus', 1], ['c3', 'dom', 1]],
      scale: [0, 2, 4, 5, 7, 9],
      lead: 'flute', pad: true, bass: true, perc: null,
      motif: [[4, 3, 0.7], [2, 1, 0.6], [0, 2, 0.8], [4, 1, 0.7], [7, 3, 0.9], [4, 2, 0.6]],
    },
    // Driving, minor, insistent. Not frantic -- this is a skirmish, not a
    // boss, and a theme that screams gets tiring in ninety seconds.
    battle: {
      bpm: 146, swing: 0.0, key: 0,
      chart: [['d3', 'min', 1], ['bb2', 'maj', 1], ['c3', 'maj', 1], ['a2', 'min', 1],
              ['d3', 'min', 1], ['bb2', 'maj', 1], ['g2', 'min7', 1], ['a2', 'dom', 1]],
      scale: [0, 2, 3, 5, 7, 10],
      lead: 'brass', pad: false, bass: true, perc: 'drive',
      motif: [[0, 1, 1.0], [3, 1, 0.9], [0, 1, 0.9], [7, 2, 1.0], [5, 1, 0.8], [3, 2, 0.9]],
    },
    // Night, or the top of the pass. Sparse, high, almost nothing.
    hush: {
      bpm: 66, swing: 0, key: 7,
      chart: [['g3', 'maj7', 2], ['e3', 'min7', 2], ['c3', 'maj7', 2], ['d3', 'sus', 2]],
      scale: [0, 2, 4, 7, 9],
      lead: 'glass', pad: true, bass: false, perc: null,
      motif: [[7, 6, 0.5], [4, 4, 0.4], [2, 6, 0.45], [0, 8, 0.4]],
    },
  };

  const CHORD = {
    maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
    dom: [0, 4, 7, 10], sus: [0, 5, 7], maj9: [0, 4, 7, 11, 14],
  };

  let music = null;   // { song, t0, bar, timer, layers:{gain}, fading }
  let wantZone = 'town';

  function layerGains() {
    const mk = (v) => { const g = ctx.createGain(); g.gain.value = v; g.connect(busMus); return g; };
    return { pad: mk(0.5), bass: mk(0.6), lead: mk(0.5), perc: mk(0.4) };
  }

  function startMusic() {
    if (!ctx || music) return;
    music = { zone: null, song: null, next: 0, bar: 0, layers: layerGains(), gain: null };
    music.gain = ctx.createGain();
    music.gain.gain.value = 1;
    for (const k of Object.keys(music.layers)) music.layers[k].disconnect();
    for (const k of Object.keys(music.layers)) music.layers[k].connect(music.gain);
    music.gain.connect(busMus);
    setZone(wantZone, 0);
    // LOOKAHEAD SCHEDULING. Notes are placed on the audio clock up to 160 ms
    // early from a 40 ms timer, so a stalled frame cannot make the music
    // stutter -- the rendering thread and the music are not the same clock and
    // must not be made into one.
    music.timer = setInterval(tick, 40);
  }

  function setZone(zone, fade = 1.6) {
    wantZone = zone;
    if (!ctx || !music) return;
    if (music.zone === zone) return;
    const song = SONGS[zone];
    if (!song) return;
    // CHANGE ON THE BAR LINE, not on the frame the player crossed a threshold.
    // A cut mid-bar is the single most amateur sound a game can make.
    music.pending = { zone, song, fade };
  }

  function applyPending() {
    const p = music.pending;
    if (!p) return;
    music.pending = null;
    const old = music.gain;
    if (old && p.fade > 0) {
      old.gain.setTargetAtTime(0.0001, ctx.currentTime, p.fade / 3);
      setTimeout(() => { try { old.disconnect(); } catch (e) {} }, p.fade * 1000 + 400);
    } else if (old) { try { old.disconnect(); } catch (e) {} }
    music.gain = ctx.createGain();
    music.gain.gain.value = p.fade > 0 ? 0.0001 : 1;
    music.gain.connect(busMus);
    if (p.fade > 0) music.gain.gain.setTargetAtTime(1, ctx.currentTime, p.fade / 3);
    music.layers = layerGains();
    for (const k of Object.keys(music.layers)) {
      try { music.layers[k].disconnect(); } catch (e) {}
      music.layers[k].connect(music.gain);
    }
    music.zone = p.zone;
    music.song = p.song;
    music.bar = 0;
  }

  // ---- instruments --------------------------------------------------
  function voicePad(t, f, dur, dest, lvl) {
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.frequency.value = 900; flt.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(lvl, t + 0.5);
      g.gain.setValueAtTime(lvl, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(flt).connect(g).connect(dest);
      const w = ctx.createGain(); w.gain.value = 0.5; g.connect(w).connect(verb);
      o.start(t); o.stop(t + dur + 0.1);
    }
  }
  function voicePluck(t, f, dur, dest, lvl) {
    const o = ctx.createOscillator();
    o.type = 'triangle'; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    const w = ctx.createGain(); w.gain.value = 0.42; g.connect(w).connect(verb);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function voiceFlute(t, f, dur, dest, lvl) {
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(f * 0.995, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2;
    const vg = ctx.createGain(); vg.gain.value = f * 0.006;
    vib.connect(vg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + 0.09);
    g.gain.setValueAtTime(lvl, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // breath
    const n = noise(); const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = f * 2; nf.Q.value = 0.8;
    const ng = ctx.createGain(); ng.gain.value = lvl * 0.06;
    n.connect(nf).connect(ng).connect(dest);
    o.connect(g).connect(dest);
    const w = ctx.createGain(); w.gain.value = 0.5; g.connect(w).connect(verb);
    o.start(t); vib.start(t); n.start(t);
    o.stop(t + dur + 0.1); vib.stop(t + dur + 0.1); n.stop(t + dur);
  }
  function voiceBrass(t, f, dur, dest, lvl) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = f;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(f * 1.5, t);
    flt.frequency.linearRampToValueAtTime(f * 4.5, t + 0.06);
    flt.frequency.exponentialRampToValueAtTime(f * 1.8, t + dur);
    flt.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + 0.03);
    g.gain.setValueAtTime(lvl, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(flt).connect(g).connect(dest);
    const w = ctx.createGain(); w.gain.value = 0.3; g.connect(w).connect(verb);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function voiceGlass(t, f, dur, dest, lvl) {
    for (const [r, l] of [[1, 1], [2.01, 0.4], [3.03, 0.16]]) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f * r;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(lvl * l, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (1 - 0.2 * (r - 1)));
      o.connect(g).connect(dest);
      const w = ctx.createGain(); w.gain.value = 0.7; g.connect(w).connect(verb);
      o.start(t); o.stop(t + dur + 0.1);
    }
  }
  const VOICE = { pad: voicePad, pluck: voicePluck, flute: voiceFlute,
                  brass: voiceBrass, glass: voiceGlass };

  function kick(t, dest, lvl) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(lvl, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + 0.24);
  }
  function tick_(t, dest, lvl, bright) {
    const s = noise();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = bright ? 6500 : 3800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(lvl, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (bright ? 0.05 : 0.09));
    s.connect(f).connect(g).connect(dest);
    s.start(t); s.stop(t + 0.12);
  }

  // ---- the scheduler ------------------------------------------------
  /**
   * @param until  schedule every bar that starts before this time. Defaults to
   *   a 200 ms lookahead on the live clock; an OFFLINE render passes the whole
   *   length of the piece, because `setInterval` does not fire during one and
   *   the scheduler would otherwise place exactly nothing.
   */
  function tick(until) {
    if (!ctx || !music || muted) return;
    const target = until !== undefined ? until : ctx.currentTime + 0.20;
    if (!music.song) { applyPending(); if (!music.song) return; }
    if (music.next === 0) music.next = (until !== undefined ? 0 : ctx.currentTime) + 0.12;

    while (music.next < target) {
      const song = music.song;
      const spb = 60 / song.bpm;           // seconds per beat
      const barT = spb * 4;

      // a bar line is the only place a zone change is allowed to land
      if (music.pending) {
        const at = music.next;
        applyPending();
        music.next = until !== undefined ? at : ctx.currentTime + 0.05;
        continue;
      }

      const chart = song.chart;
      // which chart entry is this bar?
      let acc = 0, idx = 0, span = 1;
      const total = chart.reduce((s, c) => s + c[2], 0);
      const barIn = music.bar % total;
      for (const c of chart) { if (barIn < acc + c[2]) { span = c[2]; break; } acc += c[2]; idx++; }
      const entry = chart[Math.min(idx, chart.length - 1)];
      const rootHz = hz(entry[0]) * Math.pow(2, song.key / 12);
      const ivals = CHORD[entry[1]] || CHORD.maj;
      const t = music.next;
      const L = music.layers;

      // PAD -- the chord, held across the bar
      if (song.pad) for (const iv of ivals)
        voicePad(t, rootHz * Math.pow(2, iv / 12), barT * span * 0.98, L.pad, 0.045);

      // BASS -- root on 1, fifth on 3. Anything busier fights the melody.
      if (song.bass) {
        voicePluck(t, rootHz / 2, spb * 1.6, L.bass, 0.13);
        voicePluck(t + spb * 2, rootHz / 2 * Math.pow(2, 7 / 12), spb * 1.2, L.bass, 0.09);
      }

      // PERCUSSION
      if (song.perc === 'light') {
        tick_(t + spb * 2, L.perc, 0.05, true);
      } else if (song.perc === 'drive') {
        for (let b = 0; b < 4; b++) {
          if (b === 0 || b === 2) kick(t + spb * b, L.perc, 0.22);
          tick_(t + spb * b + spb * 0.5, L.perc, 0.05, true);
          if (b === 1 || b === 3) tick_(t + spb * b, L.perc, 0.10, false);
        }
      }

      // LEAD -- walk the motif, snapped into the current chord's scale so it
      // is consonant whatever the harmony is doing underneath.
      const voice = VOICE[song.lead] || voicePluck;
      let beat = 0, mi = music.bar % song.motif.length;
      while (beat < 4 * span - 0.01) {
        const [deg, len, vel] = song.motif[mi % song.motif.length];
        mi++;
        const sc = song.scale;
        const oct = Math.floor(deg / sc.length);
        const st = sc[((deg % sc.length) + sc.length) % sc.length] + oct * 12;
        const f = rootHz * 2 * Math.pow(2, st / 12);
        const sw = (beat % 2 === 1) ? (song.swing || 0) * spb : 0;
        voice(t + beat * spb + sw, f, spb * len * 0.92, L.lead, 0.075 * vel);
        beat += len;
      }

      music.bar++;
      music.next += barT * span;
    }
  }

  /** Duck the music under a conversation or a cutscene line. */
  function duck(amount = 0.35, secs = 0.3) {
    if (!ctx || !busMus) return;
    busMus.gain.setTargetAtTime(settings.music * amount, ctx.currentTime, secs / 3);
  }
  function unduck(secs = 0.6) {
    if (!ctx || !busMus) return;
    busMus.gain.setTargetAtTime(settings.music, ctx.currentTime, secs / 3);
  }

  function setMuted(v) {
    muted = !!v;
    if (master) master.gain.setTargetAtTime(muted ? 0.0001 : settings.master,
                                            ctx.currentTime, 0.08);
  }

  return {
    boot, play, setListener, ambience, setZone, duck, unduck, setMuted,
    /** The context and a tap point, so a probe can MEASURE the output.
     *
     * Audio is the one subsystem here with no visual trace at all, so without
     * a tap the only available verification is "it did not throw" -- which is
     * exactly what a silent bug looks like. The tap sits before the limiter so
     * what it reads is what the mix is doing, not what the limiter left. */
    get ctx() { return ctx; },
    tap(node) { if (master) master.connect(node); },

    // ---- offline rendering, for tools/film.mjs -------------------------
    //
    // There is no way to capture a WebAudio graph out of headless Chromium, so
    // the film's soundtrack is rendered rather than recorded: the same engine,
    // the same score, driven against an OfflineAudioContext at the same
    // timestamps. It is the same music arrived at the other way round.

    /** Schedule every music bar that begins before `until` seconds. */
    pump(until) { tick(until); },

    /** Fire a one-shot at an absolute time on the audio clock. */
    playAt(t, name, vol = 1, at = null) {
      forcedT = t;
      try { play(name, at, vol); } finally { forcedT = null; }
    },

    /** Switch the music at a bar line, without a crossfade. */
    cut(zone) {
      if (!music) return;
      const song = SONGS[zone];
      if (!song) return;
      music.pending = { zone, song, fade: 0 };
    },
    get ready() { return !!ctx; },
    get muted() { return muted; },
    get zone() { return music ? (music.zone || wantZone) : wantZone; },
    hz,
    /** For probes: prove a sound was asked for without needing to hear it. */
    _debug: () => ({ ready: !!ctx, zone: music && music.zone, bar: music && music.bar,
                     beds: Object.keys(beds).map((k) => `${k}:${beds[k].target.toFixed(2)}`) }),
  };
}
