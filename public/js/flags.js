// flags.js -- the bridge from the world to the people in it.
//
// The dialogue engine can gate any line, choice or node on a flag, and it has
// been able to since it was vendored. What it never had was a world that SET
// any: the bell rang, embercaps burst, things died, the player stood at the
// top of the pass -- and the character sheet learned nothing, so nobody in the
// square could react to any of it. Every conversation was the same conversation
// on the first visit and the fortieth.
//
// This is deliberately small. A flag is a boolean in `GS.state.flags`, set
// once, saved with everything else, and read by dialogue.json with `if:
// {flag: ...}`. There is no event bus and no quest object: the things that
// happen in the world are the quest, and the flags are the memory of them.
//
// Every setter is idempotent, because most of them are polled every frame.

export function makeFlags({ toast = () => {} } = {}) {
  const gs = () => (window.GS && window.GS.ok ? window.GS : null);

  function get(k) {
    const G = gs();
    return G && G.state && G.state.flags ? G.state.flags[k] : undefined;
  }

  /** Set a flag; returns true only if it CHANGED. `note` is a one-line toast. */
  function set(k, v = true, note = null) {
    const G = gs();
    if (!G || !G.state) return false;
    if (!G.state.flags) G.state.flags = {};
    if (G.state.flags[k] === v) return false;
    G.state.flags[k] = v;
    G.emit('change', G.state);
    if (note) toast(note, 'quest');
    return true;
  }

  const once = (k, note) => set(k, true, note);

  // ---- things the world can tell it -------------------------------------

  /** Named places. Standing inside one sets `seen.<id>` once, for good. */
  function zones(pos, list) {
    for (const z of list) {
      if (get('seen.' + z.id)) continue;
      const dx = pos.x - z.x, dz = pos.z - z.z;
      if (dx * dx + dz * dz > z.r * z.r) continue;
      if (z.y0 !== undefined && pos.y < z.y0) continue;
      if (z.y1 !== undefined && pos.y > z.y1) continue;
      once('seen.' + z.id, z.note || null);
    }
  }

  /** Embercap milestones, from the running count the HUD already shows. */
  function caps(found) {
    for (const n of [1, 3, 5, 8, 12]) {
      if (found >= n) once(`caps.${n}`, n === 5 ? 'Enough embercaps to light a beacon' : null);
    }
  }

  return { get, set, once, zones, caps };
}
