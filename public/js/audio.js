// audio.js -- every sound in the game, synthesised. No files.
//
// The demo was silent. A frame can be as painted as it likes; without a
// footstep under it, it is a screenshot. Everything here is built from
// oscillators and filtered noise at the moment it is needed, which keeps the
// repository free of samples and keeps every sound tunable as a number.
//
// The shape: one AudioContext, unlocked by the first key or click (browsers
// will not start audio on their own), a master with a soft compressor, and
// three kinds of thing on it --
//   ONE-SHOTS   step, swing, hit, hurt, jump, land, pickup, level, ui, bell,
//               chest, sheathe, draw, kill, whoosh
//   BEDS        wind, birds, water, fire -- always running, mixed by distance
//               from the listener every frame
//   THE PAD     two detuned voices under a slow filter, four chords, a pluck
//               every few seconds; warms when dusk arrives
// Everything routes through `bus.sfx` / `bus.amb` / `bus.music` so one number
// each is the whole mix, and `M` mutes the lot.

const CHORDS = [[62, 66, 69, 74], [59, 62, 66, 71], [55, 59, 62, 67], [57, 61, 64, 69]]; // D F#m G A (open, low)
const PENTA = [62, 64, 66, 69, 71, 74, 76, 78];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function makeAudio() {
  let ctx = null;
  let bus = null;
  let muted = false;
  try { muted = localStorage.getItem('rpg3d-mute') === '1'; } catch (e) { /* no storage */ }
  const beds = {};
  let noiseBuf = null;
  let counts = { shots: 0 };           // for probes: how many one-shots fired
  let pad = null;
  let dusk = 0;                         // 0 day .. 1 dusk, drives the pad's colour
  let lastStep = -1;

  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.18;
    master.connect(comp).connect(ctx.destination);
    const mk = (v) => { const g = ctx.createGain(); g.gain.value = v; g.connect(master); return g; };
    bus = { master, sfx: mk(0.9), amb: mk(0.55), music: mk(0.32) };
    // two seconds of white noise, reused by everything that hisses
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    startBeds();
    startPad();
  }

  // ---------------------------------------------------------- primitives
  function noise(dur, { type = 'bandpass', f0 = 1000, f1 = null, q = 1, gain = 0.5, at = 0, decay = null } = {}) {
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const flt = ctx.createBiquadFilter();
    flt.type = type; flt.frequency.setValueAtTime(f0, t0); flt.Q.value = q;
    if (f1 !== null) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (decay || dur));
    src.connect(flt).connect(g).connect(bus.sfx);
    src.start(t0); src.stop(t0 + dur + 0.05);
    return g;
  }
  function tone(freq, dur, { type = 'sine', f1 = null, gain = 0.3, at = 0, attack = 0.005, out = null, detune = 0 } = {}) {
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t0); o.detune.value = detune;
    if (f1 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out || bus.sfx);
    o.start(t0); o.stop(t0 + dur + 0.05);
    return g;
  }
  const ok = () => { if (!ctx || muted) return false; counts.shots++; return true; };

  // ---------------------------------------------------------- one-shots
  const S = {
    step(surface = 'stone', run = true) {
      if (!ok()) return;
      const v = run ? 0.22 : 0.14;
      if (surface === 'grass') {
        noise(0.09, { type: 'lowpass', f0: 900, f1: 300, gain: v * 0.8, decay: 0.07 });
      } else if (surface === 'dirt') {
        noise(0.08, { type: 'bandpass', f0: 500, q: 0.7, gain: v * 0.9, decay: 0.06 });
      } else if (surface === 'wood') {
        noise(0.07, { type: 'bandpass', f0: 350, q: 2, gain: v, decay: 0.05 });
        tone(140, 0.08, { gain: v * 0.5, f1: 90 });
      } else {
        noise(0.06, { type: 'bandpass', f0: 1600 + Math.random() * 600, q: 1.4, gain: v, decay: 0.045 });
        tone(220 + Math.random() * 60, 0.05, { gain: v * 0.25, f1: 120 });
      }
    },
    swing(heavy = false) {
      if (!ok()) return;
      noise(heavy ? 0.22 : 0.15, { type: 'bandpass', f0: heavy ? 500 : 900, f1: heavy ? 2400 : 3200, q: 1.1, gain: heavy ? 0.32 : 0.22 });
    },
    hit(heavy = false, kill = false) {
      if (!ok()) return;
      tone(heavy ? 110 : 150, 0.16, { f1: 45, gain: heavy ? 0.55 : 0.4 });
      noise(0.08, { type: 'highpass', f0: 2500, gain: heavy ? 0.3 : 0.2, decay: 0.05 });
      if (kill) {
        tone(80, 0.35, { f1: 38, gain: 0.5, at: 0.02 });
        noise(0.25, { type: 'lowpass', f0: 700, f1: 200, gain: 0.25, at: 0.02 });
      }
    },
    hurt() {
      if (!ok()) return;
      tone(120, 0.22, { f1: 50, gain: 0.5, type: 'triangle' });
      noise(0.12, { type: 'bandpass', f0: 700, q: 0.8, gain: 0.25 });
      tone(660, 0.18, { f1: 330, gain: 0.08, type: 'square', at: 0.01 });
    },
    jump() { if (ok()) noise(0.16, { type: 'bandpass', f0: 500, f1: 1800, q: 0.9, gain: 0.12 }); },
    land(hard = false) {
      if (!ok()) return;
      tone(hard ? 90 : 120, 0.12, { f1: 50, gain: hard ? 0.4 : 0.25 });
      noise(0.07, { type: 'lowpass', f0: 1200, f1: 300, gain: hard ? 0.3 : 0.18 });
    },
    dodge() { if (ok()) noise(0.2, { type: 'bandpass', f0: 1400, f1: 400, q: 0.8, gain: 0.16 }); },
    sheathe() {
      if (!ok()) return;
      noise(0.28, { type: 'bandpass', f0: 3200, f1: 900, q: 3, gain: 0.16 });
      tone(1800, 0.05, { f1: 900, gain: 0.05, at: 0.24 });
    },
    draw() {
      if (!ok()) return;
      noise(0.24, { type: 'bandpass', f0: 1200, f1: 4200, q: 3, gain: 0.18 });
      tone(2600, 0.16, { gain: 0.05, at: 0.1 });
    },
    pickup(gold = false) {
      if (!ok()) return;
      const f = gold ? 1320 : 880;
      tone(f, 0.16, { gain: 0.12, type: 'triangle' });
      tone(f * 1.5, 0.22, { gain: 0.1, type: 'triangle', at: 0.07 });
    },
    level() {
      if (!ok()) return;
      [0, 4, 7, 12].forEach((s, i) => tone(mtof(74 + s), 0.5 - i * 0.05, { gain: 0.14, type: 'triangle', at: i * 0.11 }));
    },
    ui() { if (ok()) tone(1400, 0.045, { gain: 0.05, type: 'square', f1: 1200 }); },
    talk() { if (ok()) tone(700 + Math.random() * 300, 0.05, { gain: 0.035, type: 'sine' }); },
    chest() {
      if (!ok()) return;
      // a hinge: a sawtooth sliding down with a tremble on it
      const t0 = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(320, t0); o.frequency.exponentialRampToValueAtTime(180, t0 + 0.5);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 28;
      const lg = ctx.createGain(); lg.gain.value = 18;
      lfo.connect(lg).connect(o.frequency);
      const flt = ctx.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 900; flt.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
      o.connect(flt).connect(g).connect(bus.sfx);
      o.start(t0); lfo.start(t0); o.stop(t0 + 0.6); lfo.stop(t0 + 0.6);
      [0, 7, 12, 16].forEach((s, i) => tone(mtof(81 + s), 0.6, { gain: 0.09, type: 'triangle', at: 0.55 + i * 0.09 }));
    },
    bell(dist = 10) {
      if (!ok()) return;
      // a bell is inharmonic: hum, prime, tierce, quint, nominal
      const base = 196;
      const g = Math.max(0.08, 0.6 - dist * 0.012);
      [[0.5, 3.6, 0.9], [1.0, 3.0, 1.0], [1.2, 2.2, 0.55], [1.5, 1.8, 0.45], [2.0, 1.4, 0.5], [2.67, 0.9, 0.25]]
        .forEach(([r, dur, a]) => tone(base * r, dur, { gain: g * a * 0.35, attack: 0.003 }));
      noise(0.04, { type: 'highpass', f0: 3000, gain: g * 0.3 });
    },
    beacon() {
      if (!ok()) return;
      noise(1.4, { type: 'lowpass', f0: 300, f1: 2600, q: 0.7, gain: 0.5, decay: 1.2 });
      tone(70, 1.2, { f1: 40, gain: 0.35 });
      for (let i = 0; i < 12; i++) noise(0.03, { type: 'highpass', f0: 2000, gain: 0.12, at: 0.3 + Math.random() * 1.2 });
      beds.fire.on = true;
    },
    cast() {
      if (!ok()) return;
      noise(0.6, { type: 'bandpass', f0: 400, f1: 3000, q: 1.5, gain: 0.2 });
      tone(330, 0.5, { f1: 660, gain: 0.08, type: 'triangle' });
    },
    kill() { if (ok()) tone(60, 0.4, { f1: 30, gain: 0.4 }); },
    title() {
      if (!ok()) return;
      [62, 69, 74, 78].forEach((m, i) => tone(mtof(m), 1.6, { gain: 0.08, type: 'triangle', at: i * 0.16, attack: 0.05 }));
    },
  };

  // ---------------------------------------------------------- beds
  function bed(name, make) { const b = make(); b.g.gain.value = 0; beds[name] = b; return b; }
  function startBeds() {
    // WIND: brown-ish noise, a slow wander on the filter and the gain
    bed('wind', () => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.4;
      const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 900;
      const g = ctx.createGain();
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lg = ctx.createGain(); lg.gain.value = 260;
      lfo.connect(lg).connect(lp.frequency);
      src.connect(lp).connect(lp2).connect(g).connect(bus.amb);
      src.start(); lfo.start();
      return { g, lp, want: 0.18 };
    });
    // WATER: hissier noise, faster flutter
    bed('water', () => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      src.playbackRate.value = 1.3;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.5;
      const g = ctx.createGain();
      const lfo = ctx.createOscillator(); lfo.frequency.value = 1.7;
      const lg = ctx.createGain(); lg.gain.value = 600;
      lfo.connect(lg).connect(bp.frequency);
      src.connect(bp).connect(g).connect(bus.amb);
      src.start(); lfo.start();
      return { g, want: 0 };
    });
    // FIRE: low rumble; the pops are scheduled on top when it is lit
    bed('fire', () => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      src.playbackRate.value = 0.5;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
      const g = ctx.createGain();
      src.connect(lp).connect(g).connect(bus.amb);
      src.start();
      return { g, want: 0, on: false, pop: 0 };
    });
    beds.birds = { next: 2 + Math.random() * 4, want: 1 };
  }
  function chirp(vol) {
    // a two- or three-note chirp with a wobble, up in the trees
    const n = 2 + Math.floor(Math.random() * 2);
    const f = 2600 + Math.random() * 1600;
    for (let i = 0; i < n; i++) {
      tone(f * (1 + (Math.random() - 0.5) * 0.25), 0.07 + Math.random() * 0.05,
           { f1: f * (1.1 + Math.random() * 0.5), gain: vol * (0.05 + Math.random() * 0.03), at: i * 0.11, attack: 0.01, out: bus.amb });
    }
  }

  // ---------------------------------------------------------- the pad
  function startPad() {
    const out = ctx.createGain(); out.gain.value = 1; out.connect(bus.music);
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 520; flt.Q.value = 0.6;
    flt.connect(out);
    const voices = [];
    for (let i = 0; i < 4; i++) {
      const pair = [];
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.detune.value = det;
        const g = ctx.createGain(); g.gain.value = 0.0001;
        o.connect(g).connect(flt); o.start();
        pair.push({ o, g });
      }
      voices.push(pair);
    }
    pad = { out, flt, voices, chord: -1, t: 0, next: 0, pluckNext: 3 };
    setChord(0, 3.5);
  }
  function setChord(i, glide) {
    const t0 = ctx.currentTime;
    CHORDS[i].forEach((m, k) => {
      for (const v of pad.voices[k]) {
        v.o.frequency.setTargetAtTime(mtof(m - 12), t0, 0.4);
        v.g.gain.cancelScheduledValues(t0);
        v.g.gain.setTargetAtTime(0.045, t0, glide);
      }
    });
    pad.chord = i;
  }
  function pluck() {
    const m = PENTA[Math.floor(Math.random() * PENTA.length)] + (Math.random() < 0.3 ? 12 : 0);
    tone(mtof(m), 1.4, { gain: 0.05, type: 'triangle', attack: 0.01, out: bus.music });
    tone(mtof(m) * 2, 0.9, { gain: 0.012, type: 'sine', attack: 0.01, out: bus.music });
  }

  // ---------------------------------------------------------- per frame
  function update(dt, { pos = null, inTown = true, waterD = 99, fireD = 99, fireOn = false, dusk: dk = 0, quiet = false } = {}) {
    if (!ctx || muted) return;
    dusk = dk;
    const t = ctx.currentTime;
    const ease = (g, v) => g.gain.setTargetAtTime(v, t, 0.6);
    // wind: fuller in the open, and higher when dusk comes in
    ease(beds.wind.g, quiet ? 0.05 : (inTown ? 0.10 : 0.20) * (1 + 0.4 * dusk));
    beds.wind.lp.frequency.setTargetAtTime(380 + 200 * dusk, t, 2);
    // water: by distance to the nearest water
    ease(beds.water.g, Math.max(0, 0.30 * (1 - waterD / 14)));
    // fire: only once lit, by distance, with pops
    const fv = beds.fire.on || fireOn ? Math.max(0, 0.45 * (1 - fireD / 20)) : 0;
    ease(beds.fire.g, fv);
    if (fv > 0.02) {
      beds.fire.pop -= dt;
      if (beds.fire.pop <= 0) {
        beds.fire.pop = 0.08 + Math.random() * 0.5;
        noise(0.025, { type: 'highpass', f0: 1800 + Math.random() * 2000, gain: fv * (0.5 + Math.random() * 0.8), decay: 0.02 });
      }
    }
    // birds: sparser in town, gone at dusk
    beds.birds.next -= dt;
    if (beds.birds.next <= 0) {
      beds.birds.next = (inTown ? 6 : 3) + Math.random() * 7;
      if (dusk < 0.7 && !quiet) chirp((inTown ? 0.6 : 1.0) * (1 - dusk));
    }
    // the pad: a chord every twelve seconds, a pluck now and then, warmer at dusk
    pad.t += dt;
    if (pad.t >= pad.next) { pad.next = pad.t + 12; setChord((pad.chord + 1) % CHORDS.length, 2.5); }
    pad.pluckNext -= dt;
    if (pad.pluckNext <= 0) { pad.pluckNext = 2.5 + Math.random() * 5; if (!quiet) pluck(); }
    pad.flt.frequency.setTargetAtTime(520 + 900 * dusk, t, 3);
    pad.out.gain.setTargetAtTime(quiet ? 0.35 : 1, t, 1.5);
  }

  function setMute(m) {
    muted = m;
    try { localStorage.setItem('rpg3d-mute', m ? '1' : '0'); } catch (e) { /* no storage */ }
    if (bus) bus.master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05);
    return muted;
  }

  return {
    ...S, unlock, update, setMute,
    get muted() { return muted; },
    get ready() { return !!ctx; },
    get counts() { return { ...counts, state: ctx ? ctx.state : 'none' }; },
    /** the step clock: fires a step when the run clip crosses a footfall */
    footfall(phase) {
      // two footfalls per cycle: at phase 0.0-0.5 boundary crossings
      const k = Math.floor(phase * 2);
      if (k !== lastStep) { lastStep = k; return true; }
      return false;
    },
  };
}
