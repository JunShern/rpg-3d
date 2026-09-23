// cine.js -- the camera when the game stops being played and starts being shown.
//
// WHY A SECOND CAMERA. The gameplay camera is a good third-person rig and it
// is the wrong tool for a moment: it orbits a character at a fixed boom and
// deliberately refuses to do anything dramatic, because a camera that gets
// clever while you are fighting is a camera you fight. So a cutscene needs a
// different instrument, not a different mood on the same one.
//
// EVERY SHOT IS A DOLLY. There is no hand-held, no snap-cut inside a shot and
// no free-look: a shot names where the camera starts, where it ends, what it
// is looking at, and how long it takes. That is restrictive on purpose -- it
// is nearly impossible to make an ugly frame with it, and the whole point is
// that these moments look composed rather than captured.
//
// AND IT IS DETERMINISTIC. `step(dt)` advances the whole sequence by exactly
// dt, so the same call sequence gives the same frames every time. That is what
// makes `tools/film.mjs` able to record the demo at a fixed 30 fps into an
// actual video file rather than screen-grabbing at whatever rate a headless
// tab felt like.

import * as THREE from 'three';

const EASE = {
  linear: (t) => t,
  // the default. Slow in, slow out -- a camera that starts and stops abruptly
  // reads as a mistake even when the move itself is good
  smooth: (t) => t * t * (3 - 2 * t),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  // for a reveal: hold, then go
  late: (t) => t * t * t,
};

export function makeCine({ camera, scene }) {
  let seq = null;          // the running sequence
  let shotI = 0;
  let t = 0;               // seconds into the current shot
  let active = false;
  let onLine = null;
  let bars = null, title = null;

  // ---- letterbox -------------------------------------------------------
  // Two bars and a caption. The bars are the single cheapest signal in the
  // medium for "you are not driving now" -- and crucially they also change the
  // FRAME, so a composition can use the full width without the HUD in it.
  function chrome() {
    if (bars) return;
    bars = document.createElement('div');
    bars.id = 'cinebars';
    bars.innerHTML =
      '<div class="bar top"></div><div class="bar bot"></div>'
      + '<div class="cap"></div>';
    const st = document.createElement('style');
    st.textContent = `
      #cinebars { position:fixed; inset:0; pointer-events:none; z-index:40;
        opacity:0; transition:opacity .5s ease; }
      #cinebars.on { opacity:1; }
      #cinebars .bar { position:absolute; left:0; right:0; height:11vh;
        background:#05060c; transition:height .5s cubic-bezier(.3,.8,.3,1); }
      #cinebars .bar.top { top:0; } #cinebars .bar.bot { bottom:0; }
      #cinebars .cap { position:absolute; left:0; right:0; bottom:13.5vh;
        text-align:center; color:#f0ecdf; opacity:0;
        font:500 clamp(15px,1.35vw,26px)/1.6 ui-serif, Georgia, serif;
        letter-spacing:.02em; text-shadow:0 2px 12px #000d, 0 0 30px #0009;
        padding:0 12vw; transition:opacity .45s ease; }
      #cinebars .cap.on { opacity:1; }
      body.cine #hud, body.cine #help, body.cine #vitals,
      body.cine #purse, body.cine #gains, body.cine #objective,
      body.cine #talkprompt { opacity:0 !important; transition:opacity .4s ease; }`;
    document.head.appendChild(st);
    document.body.appendChild(bars);
    title = bars.querySelector('.cap');
  }

  function caption(text) {
    if (!title) return;
    if (!text) { title.classList.remove('on'); return; }
    title.textContent = text;
    title.classList.add('on');
  }

  const _from = new THREE.Vector3(), _to = new THREE.Vector3();
  const _look = new THREE.Vector3(), _lookTo = new THREE.Vector3();
  const _p = new THREE.Vector3(), _l = new THREE.Vector3();

  /**
   * Play a sequence.
   *
   * A shot is:
   *   { from:[x,y,z], to:[x,y,z], look:[x,y,z], lookTo:[x,y,z],
   *     secs, ease, fov, caption, on:fn }
   *
   * `to` and `lookTo` default to `from` and `look`, which makes a locked-off
   * shot the short form rather than a special case.
   */
  function play(shots, opts = {}) {
    chrome();
    seq = shots;
    shotI = 0;
    t = 0;
    active = true;
    onLine = opts.onLine || null;
    document.body.classList.add('cine');
    bars.classList.add('on');
    enter(0);
    return new Promise((res) => { seq._done = res; });
  }

  function enter(i) {
    const s = seq[i];
    if (!s) return;
    caption(s.caption || null);
    if (s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
    if (s.on) { try { s.on(); } catch (e) { console.error('[cine]', e); } }
    apply(0);
  }

  function apply(u) {
    const s = seq[shotI];
    if (!s) return;
    const e = (EASE[s.ease] || EASE.smooth)(Math.max(0, Math.min(1, u)));
    _from.fromArray(s.from);
    _to.fromArray(s.to || s.from);
    _look.fromArray(s.look);
    _lookTo.fromArray(s.lookTo || s.look);
    _p.copy(_from).lerp(_to, e);
    _l.copy(_look).lerp(_lookTo, e);
    camera.position.copy(_p);
    camera.lookAt(_l);
  }

  /** Advance. Returns true while the sequence is still running. */
  function step(dt) {
    if (!active || !seq) return false;
    const s = seq[shotI];
    if (!s) { stop(); return false; }
    t += dt;
    apply(t / s.secs);
    if (t >= s.secs) {
      shotI++;
      t = 0;
      if (shotI >= seq.length) { stop(); return false; }
      enter(shotI);
    }
    return true;
  }

  function stop() {
    active = false;
    caption(null);
    if (bars) bars.classList.remove('on');
    document.body.classList.remove('cine');
    camera.fov = 52;
    camera.updateProjectionMatrix();
    const done = seq && seq._done;
    seq = null;
    if (done) done();
  }

  return {
    play, step, stop, caption,
    get active() { return active; },
    get shot() { return shotI; },
    /** Total running time, so a recorder knows how many frames to take. */
    duration: (shots) => shots.reduce((a, s) => a + s.secs, 0),
    _debug: () => ({ active, shot: shotI, of: seq ? seq.length : 0, t: +t.toFixed(2) }),
  };
}

// ---------------------------------------------------------------- the scenes
//
// Coordinates are three.js world space (z = -blender y). Every one of these was
// placed by putting the camera there and looking, not by reasoning about it --
// which is why they are data in this file rather than numbers in a function.

export const SCENES = {
  // THE OPENING. Every coordinate below was placed with `tools/frame.mjs` --
  // put the camera there, look at the picture, move it -- and not one of them
  // was reasoned. The first attempt was reasoned and pointed the hero shot of
  // the demo at the blank side of a building, because I had the tower on the
  // wrong side of the square.
  open: [
    // the tower over the roofs, with the bell actually visible in the belfry
    { secs: 5.4, ease: 'smooth', fov: 42,
      from: [17.5, 17.5, -19.0], to: [12.5, 15.2, -13.5],
      look: [-1.0, 13.5, 15.5], lookTo: [-1.0, 15.0, 15.5],
      caption: 'Emberbrook has rung its bell at dusk for forty-one years.' },
    // down into the square
    { secs: 4.8, ease: 'smooth', fov: 46,
      from: [6.5, 9.0, -2.0], to: [1.6, 3.6, 5.0],
      look: [-1.4, 6.0, 12.5], lookTo: [-2.3, 1.7, 10.9],
      caption: 'Tonight the clapper pin has sheared.' },
    // and the woman who cannot climb it
    { secs: 4.4, ease: 'out', fov: 40,
      from: [-6.8, 2.5, 6.2], to: [-6.0, 2.2, 7.4],
      look: [-2.3, 1.5, 10.9],
      caption: 'And the woman who rings it cannot climb.' },
  ],

  // THE PAYOFF. The rope, the shaft, and the sound going out over the valley.
  ring: [
    // NO INTERIOR SHOT OF THE ROPE. There was one; it is the room the bell is
    // rung from and it ought to be the opening image of the payoff, and at
    // dusk it is three and a half seconds of near-black. The ground storey is
    // the one solid part of the tower, so no sky reaches it and the single
    // interior lamp is behind the camera wherever you put it. Cut rather than
    // lit: adding a light for one shot is set dressing for a camera, and the
    // room has to keep making sense when you walk into it.
    // THE BELL, FROM OUTSIDE. Two interior shots were tried and both were
    // wrong for the same reason: the belfry is open on four sides, so from
    // inside it everything is backlit by a bright sky and the bell is a pale
    // shape in a pale room. From out here it is a lit object against the dusk,
    // which is the picture -- and it is the same framing the establishing shot
    // uses, so the film returns to where it began.
    { secs: 5.2, ease: 'smooth', fov: 34,
      from: [16.5, 17.0, -17.0], to: [12.0, 16.2, -12.5],
      look: [-1.0, 20.5, 15.5], lookTo: [-1.0, 21.6, 15.5],
      caption: 'Count to three after. Everyone lets go on the one.' },
    // and away, over the roofs, in the dark
    { secs: 6.4, ease: 'smooth', fov: 40,
      from: [12.5, 15.6, -13.0], to: [21.0, 20.0, -26.0],
      look: [-1.0, 15.5, 15.5], lookTo: [-1.0, 12.0, 15.5] },
  ],
};
