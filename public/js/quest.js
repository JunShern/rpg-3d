// quest.js -- the twenty minutes. What you are doing and why the light is going.
//
// THE DEMO IS THE BELL. The town has rung one at dusk for forty-one years;
// tonight the clapper pin has sheared and the Sexton's hands will not do it.
// Somebody is still out past the ford who comes home on that sound. You have
// until the light goes.
//
// WHY THAT STORY. It was chosen to be made out of what already existed rather
// than to be interesting in a vacuum -- there is a belltower you can climb, a
// rope you can pull, a bell that swings, a forge with a fire, a meadow with a
// heavy creature in it, and a lighting system that can put the sun on the
// floor. The story is a line drawn through things that were already built, and
// every beat is playable rather than watched.
//
// THE DEADLINE IS THE LIGHTING. There is no timer on screen and no failure
// state; the sun simply comes down as you progress, from late afternoon
// through the light going to lamplight. You feel late before anybody says so,
// and when the bell finally sounds it is dark enough that the lamps carry the
// square. A countdown would have been cheaper and would have made it a task.
//
// FLAGS, NOT A STATE MACHINE. Every beat is a flag in the save, set by the
// dialogue data itself -- so the writing and the progression cannot disagree,
// and a line that says "take the boy off the step" is the same object as the
// permission to have Lake join you.

export const STAGES = [
  // THE FIRST LINE HAS TO POINT SOMEWHERE. "Emberbrook. The light is going."
  // is atmosphere, and atmosphere is not an objective: a player dropped into a
  // square with nine people in it and twenty minutes on the clock needs to
  // know which one to walk at.
  { flag: null,          hour: 0.00, text: 'The bell did not ring. Find the Sexton, under the tower.' },
  { flag: 'q.start',     hour: 0.08, text: 'The Sexton is at the tower.' },
  { flag: 'q.accepted',  hour: 0.16, text: 'Find iron. A bellow, out past the ford.' },
  { flag: 'q.lake',      hour: 0.22, text: 'Out past the ford. Find the bellow.' },
  { flag: 'q.maren',     hour: 0.34, text: 'Find the bellow.' },
  { flag: 'q.iron',      hour: 0.52, text: 'Take the iron to Hobb.' },
  { flag: 'q.pin',       hour: 0.70, text: 'The tower. Ring the bell.' },
  { flag: 'q.cleared',   hour: 0.80, text: 'Climb. Pull the rope.' },
  { flag: 'q.rung',      hour: 1.00, text: null },
];

export function makeQuest({ getGS, atmos, party, chars, audio, playerPos }) {
  let stage = 0;
  let shown = -1;
  let joined = { lake: false, maren: false };
  let hour = 0;
  let hourWant = 0;
  let rungAt = -1;

  // ---- the objective line ----------------------------------------------
  // Top centre, small, and it fades. A permanent quest log would be the wrong
  // furniture for twenty minutes: this is a reminder, not a journal.
  const el = document.createElement('div');
  el.id = 'objective';
  el.style.cssText =
    'position:fixed;top:64px;left:50%;transform:translateX(-50%);pointer-events:none;'
    + 'font:600 13px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.10em;'
    + 'color:#ffe9a8;text-shadow:0 1px 6px #000c,0 0 16px #0009;opacity:0;'
    + 'transition:opacity .7s ease;text-align:center;';
  document.body.appendChild(el);

  function say(text) {
    if (!text) { el.style.opacity = '0'; return; }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 6500);
  }

  const has = (f) => {
    const GS = getGS();
    return !!(GS && GS.ok && GS.state && GS.state.flags && GS.state.flags[f]);
  };

  /** Which beat are we on? The LAST satisfied one, so a save loaded mid-way
   *  lands in the right hour rather than replaying the afternoon. */
  function currentStage() {
    let s = 0;
    for (let i = 1; i < STAGES.length; i++) if (has(STAGES[i].flag)) s = i;
    return s;
  }

  function update(dt, facing) {
    const GS = getGS();
    if (!GS || !GS.ok) return;

    const s = currentStage();
    if (s !== stage) {
      stage = s;
      hourWant = STAGES[s].hour;
      if (s !== shown) { say(STAGES[s].text); shown = s; }
    }

    // THE SUN EASES, it does not cut. Ten seconds to walk a stage's worth of
    // hour, which is slow enough to be felt rather than seen.
    if (Math.abs(hour - hourWant) > 1e-4) {
      hour += (hourWant - hour) * Math.min(1, dt * 0.35);
      atmos.setHour(hour);
    }

    // ---- who is walking with you -------------------------------------
    if (!joined.lake && has('q.lake')) {
      joined.lake = true;
      party.add({ id: 'lake', name: 'Lake', rig: 'lake', slot: 0, atk: 9 });
      party.warp(playerPos().x, playerPos().z, facing);
      say('Lake joined you.');
      if (audio) audio.play('item', null, 0.9);
    }
    if (!joined.maren && has('q.maren')) {
      joined.maren = true;
      party.add({ id: 'maren', name: 'Maren', rig: 'maren', slot: 1, atk: 11 });
      party.warp(playerPos().x, playerPos().z, facing);
      say('Maren joined you.');
      if (audio) audio.play('item', null, 0.9);
    }

    // ---- carrying the iron -------------------------------------------
    // Set here rather than in the drop, because what matters to Hobb is that
    // it is IN YOUR HANDS -- and a drop you never picked up is not.
    if (!has('q.iron') && GS.count && GS.count('iron-scale') > 0) {
      GS.state.flags['q.iron'] = true;
      GS.emit('change', GS.state);
      say('Iron. Take it to Hobb.');
    }
  }

  /**
   * The bell was struck. Returns true if this was THE ring -- the one the
   * whole demo is for -- so the caller can make it a moment.
   */
  function onBellRung() {
    const GS = getGS();
    if (!GS || !GS.ok) return false;
    // WITHOUT THE PIN IT DOES NOT COUNT, and it must not silently do nothing
    // either: pulling a rope and getting no bell is the story working, and the
    // player has to be told that is what happened rather than assume a bug.
    if (!has('q.pin') && !has('q.rung')) {
      say('The rope gives. Nothing sounds.');
      return false;
    }
    if (has('q.rung')) return false;
    GS.state.flags['q.rung'] = true;
    GS.emit('change', GS.state);
    rungAt = 0;
    return true;
  }

  return {
    update, onBellRung, say,
    get stage() { return stage; },
    get hour() { return hour; },
    get rung() { return has('q.rung'); },
    /** Jump the demo to a beat -- for probes, captures and the shot sheet. */
    skipTo(flag) {
      const GS = getGS();
      if (!GS || !GS.ok) return null;
      for (const st of STAGES) {
        if (!st.flag) continue;
        GS.state.flags[st.flag] = true;
        if (st.flag === flag) break;
      }
      GS.emit('change', GS.state);
      stage = currentStage();
      hour = hourWant = STAGES[stage].hour;
      atmos.setHour(hour);
      return { stage, hour, flag };
    },
    _debug: () => ({ stage, of: STAGES.length - 1, hour: +hour.toFixed(2),
                     text: STAGES[stage].text, joined }),
  };
}
