// title.js -- the first thing you see and the last.
//
// THE GAME USED TO START MID-STRIDE: the page loaded, a loading panel
// vanished, and you were standing in the square with a debug readout in the
// corner. The opening cinematic existed and was only ever seen in the film.
// A JRPG starts with its name over its world and waits for you to be ready.
//
//   title  -- the valley at golden hour under a slow drifting camera, the name,
//             and "press any key". The key starts the music and the opening.
//   ending -- when the bell finally rings: the ring sequence, then a card.
//
// Neither ever blocks a headless check: the first `__sim` call dismisses the
// title silently, because a test that has to press a key to begin is a test
// of the title screen.

import * as THREE from 'three';

const CSS = `
#title {
  position: fixed; inset: 0; z-index: 60; pointer-events: auto; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0) 30%, rgba(4,6,14,.55) 100%);
  transition: opacity 1.4s ease; color: #fff7e4; text-align: center;
}
#title.out { opacity: 0; pointer-events: none; }
#title .logo { transform: translateY(-6vh); }
#title .pre {
  font: 600 13px/1 'Avenir Next', system-ui, sans-serif; letter-spacing: .6em;
  color: #f6dea0; text-shadow: 0 2px 10px #000a; margin-bottom: 18px; opacity: 0;
  animation: tIn 2.4s ease .6s forwards;
}
#title h1 {
  font: 700 clamp(48px, 8.4vw, 124px)/1 Optima, Palatino, 'Book Antiqua', Georgia, serif;
  letter-spacing: .16em; margin-right: -.16em;
  background: linear-gradient(180deg, #fffaf0 0%, #ffe6b0 55%, #d9a654 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 4px 18px rgba(0,0,0,.55)) drop-shadow(0 0 40px rgba(255,200,120,.25));
  opacity: 0; animation: tIn 3s ease .2s forwards;
}
#title .rule {
  width: min(560px, 60vw); height: 1px; margin: 22px auto 16px;
  background: linear-gradient(90deg, transparent, rgba(246,222,160,.9), transparent);
  opacity: 0; animation: tIn 2s ease 1.2s forwards;
}
#title em {
  display: block; font: italic 500 clamp(18px, 2vw, 28px)/1.2 Palatino, Georgia, serif;
  letter-spacing: .14em; color: #fbeccb; text-shadow: 0 2px 12px #000c;
  opacity: 0; animation: tIn 2.4s ease 1.6s forwards;
}
#title .press {
  position: absolute; bottom: 14vh; left: 0; right: 0;
  font: 700 14px/1 'Avenir Next', system-ui, sans-serif; letter-spacing: .5em; color: #fff4d6;
  text-shadow: 0 2px 10px #000; opacity: 0;
  animation: tIn 1.2s ease 3.2s forwards, tPulse 2.4s ease-in-out 4.4s infinite;
}
#title .foot {
  position: absolute; bottom: 4vh; left: 0; right: 0;
  font: 600 11px/1.8 'Avenir Next', system-ui, sans-serif; letter-spacing: .22em;
  color: rgba(255,244,214,.55); opacity: 0; animation: tIn 1.2s ease 3.6s forwards;
}
@keyframes tIn { to { opacity: 1; } }
@keyframes tPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
body.title #party, body.title #deck, body.title #objective, body.title #place,
body.title #talkprompt, body.title #gains { opacity: 0 !important; }

#endcard {
  position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center; pointer-events: none;
  opacity: 0; transition: opacity 2.2s ease; color: #fff7e4;
  background: radial-gradient(ellipse at 50% 50%, rgba(6,8,20,.35) 0%, rgba(4,5,12,.88) 100%);
}
#endcard.on { opacity: 1; pointer-events: auto; cursor: pointer; }
#endcard p { font: italic 500 clamp(18px, 2vw, 26px)/1.9 Palatino, Georgia, serif;
  letter-spacing: .06em; color: #fbeccb; max-width: 44ch; }
#endcard h2 { font: 700 clamp(30px, 4vw, 56px)/1 Optima, Palatino, Georgia, serif;
  letter-spacing: .2em; margin: 36px 0 14px; color: #ffe6b0; }
#endcard small { font: 700 12px/1 'Avenir Next', system-ui, sans-serif; letter-spacing: .5em;
  color: rgba(255,244,214,.7); margin-top: 40px; }
`;

// the drift: a slow pan across the valley toward the town and its tower,
// placed by looking (tools/look.mjs "vista") rather than by reasoning
// from above the old stone circle, down the path to the town and its tower
const PATH = {
  from: new THREE.Vector3(14, 25, -112), to: new THREE.Vector3(20, 20, -98),
  lookFrom: new THREE.Vector3(0, 5, -32), lookTo: new THREE.Vector3(-1, 7, -16),
  secs: 50,
};

export function makeTitle({ camera, onStart }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const el = document.createElement('div');
  el.id = 'title';
  el.innerHTML = `
    <div class="logo">
      <div class="pre">A STORY OF</div>
      <h1>EMBERBROOK</h1>
      <div class="rule"></div>
      <em>The Bell at Dusk</em>
    </div>
    <div class="press">PRESS ANY KEY</div>
    <div class="foot">WASD move · J attack · Space jump · Shift dodge · E talk · Esc menu</div>`;
  document.body.appendChild(el);
  document.body.classList.add('title');

  const end = document.createElement('div');
  end.id = 'endcard';
  end.innerHTML = `
    <p>The bell rang at dusk, as it has for forty-one years.<br>
       Out past the ford, somebody heard it, and turned for home.</p>
    <h2>EMBERBROOK</h2>
    <p style="font-size:18px;opacity:.8">Thank you for playing.</p>
    <small>PRESS ANY KEY TO KEEP WALKING</small>`;
  document.body.appendChild(end);

  let active = true, t = 0, leaving = false;
  const _p = new THREE.Vector3(), _l = new THREE.Vector3();

  function start(e) {
    if (!active || leaving) return;
    if (e) { e.preventDefault(); e.stopImmediatePropagation(); }
    leaving = true;
    el.classList.add('out');
    document.body.classList.remove('title');
    // the key is the user gesture the audio context needs, so onStart runs
    // inside this handler
    try { onStart && onStart(); } catch (err) { console.error('[title]', err); }
    setTimeout(() => { active = false; el.remove(); }, 1400);
    active = false;
  }
  addEventListener('keydown', start, true);
  el.addEventListener('pointerdown', start, true);

  let endOn = false;
  function closeEnd(e) {
    if (!endOn) return;
    e.preventDefault(); e.stopImmediatePropagation();
    endOn = false;
    end.classList.remove('on');
    document.body.classList.remove('title');
  }
  addEventListener('keydown', closeEnd, true);
  end.addEventListener('pointerdown', closeEnd, true);

  return {
    get active() { return active; },
    /** Hold the camera on the drift. Call after the gameplay camera has run. */
    update(dt) {
      if (!active) return false;
      t += dt;
      const u = 0.5 - 0.5 * Math.cos(Math.min(1, t / PATH.secs) * Math.PI);
      _p.lerpVectors(PATH.from, PATH.to, u);
      _l.lerpVectors(PATH.lookFrom, PATH.lookTo, u);
      camera.fov = 46; camera.updateProjectionMatrix();
      camera.position.copy(_p);
      camera.lookAt(_l);
      return true;
    },
    /** Dismiss without starting anything (the headless checks). */
    skip() {
      if (!active) return;
      active = false;
      el.remove();
      document.body.classList.remove('title');
      camera.fov = 52; camera.updateProjectionMatrix();
    },
    /** The ending card, after the ring sequence. */
    ending() {
      endOn = true;
      end.classList.add('on');
      document.body.classList.add('title');
    },
  };
}
