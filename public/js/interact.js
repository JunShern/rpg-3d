// interact.js -- things you USE rather than hit.
//
// Until now the world had exactly one verb: swing. Barrels, crates, market
// fruit, embercaps and the bell rope all answer to the sword, and that is a
// fine verb for a combat demo. It is the wrong one for a chest or a beacon.
// You do not attack a chest open; you crouch and lift the lid. You do not
// strike a beacon alight; you kneel and set it. Those are the two clips
// `anim_lib` already has (`open`, `cast_fire`) and this is what plays them.
//
// The shape mirrors npc.js on purpose -- proximity arms a prompt, E acts on it,
// the world holds still while the clip plays -- because the player has
// already learned that grammar from talking to people. E is asked in a fixed
// order by main.js: a person in reach, then a thing in reach, then a swing.
//
// A use is TIMED TO THE CLIP, not to a timer. `at` is the frame on which the
// thing happens -- the lid comes up on the lift, the coals catch on the
// release -- and it is read off the clip's own clock so hit-stop, dialogue
// freeze and slow-motion all keep the effect on the pose that causes it.

const FPS = 24;

export function makeInteract({ playClip, clipTime, toast = () => {} }) {
  const items = [];
  let near = null;
  let pending = null;          // { it, at } while a use is in flight

  const prompt = document.createElement('div');
  prompt.className = 'panel';
  prompt.id = 'useprompt';
  prompt.style.cssText =
    'left:50%;bottom:96px;transform:translateX(-50%);display:none;'
    + 'pointer-events:none;text-align:center;letter-spacing:.06em;';
  document.body.appendChild(prompt);

  function show(label) {
    if (!label) { prompt.style.display = 'none'; return; }
    prompt.innerHTML = '<b style="color:#ffe9a8">E</b>&nbsp; ' + label;
    prompt.style.display = '';
  }

  /**
   * it = { id, x, y, z, r, label, clip, at, can(), use(), facing? }
   * `can` decides whether the prompt shows at all -- a beacon with no fuel is
   * still a beacon, it just does not offer itself. `label` may be a function
   * so the prompt can explain a refusal ("needs 5 embercaps").
   */
  function add(it) {
    items.push({ r: 1.8, at: 0, can: () => true, ...it, done: false });
    return items[items.length - 1];
  }

  function update(pos, dt, { suppress = false } = {}) {
    // a use in flight: fire on the authored frame, then release the body
    if (pending) {
      const t = clipTime(pending.it.clip);
      if (t === null) { pending = null; }
      else if (!pending.fired && t >= pending.at) {
        pending.fired = true;
        try { pending.it.use(); } catch (e) { console.error('[use]', e); }
      } else if (pending.fired && t >= pending.dur - 1e-3) {
        pending = null;
      }
      show(null);
      return;
    }
    let best = null, bestD = 1e9;
    for (const it of items) {
      if (it.done) continue;
      const dx = it.x - pos.x, dz = it.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > it.r || Math.abs((it.y ?? pos.y) - pos.y) > 2.2) continue;
      if (d < bestD) { bestD = d; best = it; }
    }
    near = best;
    if (suppress || !near) { show(null); return; }
    const ok = near.can();
    const label = typeof near.label === 'function' ? near.label(ok) : near.label;
    show(ok ? label : (near.refuse || label));
  }

  /** Returns true if it consumed the key -- the caller must then NOT attack. */
  function tryUse() {
    if (!near || pending || near.done || !near.can()) return false;
    const it = near;
    const dur = playClip(it.clip, it.facing);
    if (dur === null || dur === undefined) return false;
    pending = { it, at: it.at / FPS, dur, fired: false };
    show(null);
    return true;
  }

  return {
    add, update, tryUse,
    get busy() { return !!pending; },
    get near() { return near ? near.id : null; },
    /** For probes. */
    debug: () => items.map((i) => `${i.id}${i.done ? '(done)' : ''}@(${i.x.toFixed(1)},${i.z.toFixed(1)})`).join(' '),
    at: (id) => items.find((i) => i.id === id) || null,
  };
}
