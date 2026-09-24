// hud.js -- the heads-up display, in the idiom of the games this is homage to.
//
// WHAT IT REPLACES. A monospace panel in the corner reading "20 fps · vesper ·
// idle · 0 foes · 311 draws / 1,133,357 tris", a key-binding strip across the
// bottom of every frame, and a flat green bar labelled VITALITY. All three are
// a developer's instruments, and they made every screenshot of the game read
// as a build rather than as a game.
//
// WHAT IT IS NOW.
//   bottom right -- the party: a portrait per member in a ring that IS their
//                   health, the leader large and the others beside her
//   bottom left  -- the command deck: what the buttons do, as a menu of
//                   actions with the one that matters right now lit (TALK when
//                   someone is in reach, ATTACK when something hostile is)
//   top          -- the objective, and a place name when you walk into one
//
// The debug readout still exists: backquote (`) toggles it.

const CSS = `
:root {
  --gold: #f3d48a; --gold2: #b98a3e; --ink2: #eef3fb;
  --deck: linear-gradient(100deg, rgba(20,34,68,.92) 0%, rgba(34,58,112,.86) 70%, rgba(34,58,112,0) 100%);
  --deck-on: linear-gradient(100deg, rgba(196,140,48,.95) 0%, rgba(236,190,96,.9) 65%, rgba(236,190,96,0) 100%);
}
#hud { display: none; }
#hud.show { display: block; }
#help, #vitals, #purse { display: none !important; }

/* ---------------------------------------------------------------- party */
#party {
  position: fixed; right: 26px; bottom: 22px; pointer-events: none;
  display: flex; align-items: flex-end; gap: 10px;
  font-family: 'Avenir Next', 'Segoe UI', system-ui, sans-serif;
  transition: opacity .3s ease;
}
.pm { position: relative; display: flex; flex-direction: column; align-items: center; }
.pm .ring { position: relative; }
.pm svg { position: absolute; inset: 0; transform: rotate(135deg); overflow: visible; }
.pm .face {
  position: absolute; border-radius: 50%; overflow: hidden;
  background: #2a2230 center 18% / 150% no-repeat;
  box-shadow: inset 0 0 0 2px rgba(255,236,190,.55), 0 4px 14px rgba(0,0,0,.55);
}
.pm .track { fill: none; stroke: rgba(8,12,24,.72); stroke-linecap: round; }
.pm .hp    { fill: none; stroke: url(#hpg); stroke-linecap: round;
             transition: stroke-dashoffset .12s linear; filter: drop-shadow(0 0 4px rgba(120,255,170,.55)); }
.pm .lag   { fill: none; stroke: #e0566e; stroke-linecap: round;
             transition: stroke-dashoffset .45s cubic-bezier(.2,.7,.3,1) .18s; }
.pm.low .hp  { stroke: #ffc46b; filter: drop-shadow(0 0 4px rgba(255,190,90,.6)); }
.pm.crit .hp { stroke: #ff6a5a; animation: hudpulse .7s infinite; }
@keyframes hudpulse { 50% { filter: drop-shadow(0 0 9px rgba(255,80,60,.95)); } }
.pm .name {
  margin-top: 4px; padding: 2px 12px 3px; border-radius: 10px;
  font: 800 12px/1.2 'Avenir Next', 'Segoe UI', system-ui, sans-serif; letter-spacing: .14em; color: var(--ink2);
  background: linear-gradient(180deg, rgba(34,50,96,.92), rgba(16,24,50,.92));
  box-shadow: 0 0 0 1px rgba(243,212,138,.45), 0 3px 8px rgba(0,0,0,.5);
  text-transform: uppercase; white-space: nowrap;
}
.pm.lead .name { font-size: 13px; }
.pm .lv {
  position: absolute; top: -2px; right: -6px; padding: 1px 7px;
  font: 800 11px/1.3 'Avenir Next', 'Segoe UI', system-ui, sans-serif; color: #231a0c; letter-spacing: .06em;
  background: linear-gradient(180deg, #ffe7a8, #d9a54a); border-radius: 9px;
  box-shadow: 0 2px 6px rgba(0,0,0,.5);
}
.pm .num { position: absolute; bottom: 4px; right: 100%; margin-right: 6px; font: 800 15px/1 'Avenir Next', 'Segoe UI', system-ui, sans-serif;
  color: #fff; text-shadow: 0 0 3px #000, 0 2px 6px #000; letter-spacing: .02em; }
.pm .num small { font-size: 10px; opacity: .75; }

/* ------------------------------------------------------------- command */
#deck {
  position: fixed; left: 26px; bottom: 24px; pointer-events: none; width: 236px;
  font-family: 'Avenir Next', 'Segoe UI', system-ui, sans-serif; transition: opacity .3s ease;
}
#deck .title {
  font: 700 12px/1 Optima, 'Palatino', 'Book Antiqua', Georgia, serif; letter-spacing: .32em; color: var(--gold);
  margin: 0 0 7px 6px; text-shadow: 0 2px 6px #000c;
}
#deck .cmd {
  position: relative; height: 30px; margin: 3px 0; padding: 0 14px 0 16px;
  display: flex; align-items: center; justify-content: space-between;
  background: var(--deck); color: var(--ink2);
  clip-path: polygon(0 0, 100% 0, 94% 100%, 0 100%);
  font: 800 13px/1 'Avenir Next', 'Segoe UI', system-ui, sans-serif; letter-spacing: .16em; text-transform: uppercase;
  transition: transform .18s cubic-bezier(.2,.8,.3,1), background .2s ease, color .2s ease;
}
#deck .cmd::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
  background: rgba(243,212,138,.5);
}
#deck .cmd kbd {
  font: 800 11px/1 'Avenir Next', 'Segoe UI', system-ui, sans-serif; letter-spacing: .04em; color: rgba(238,243,251,.72);
  padding: 3px 6px; border-radius: 4px; background: rgba(0,0,0,.28); margin-right: 14px;
}
#deck .cmd.on { background: var(--deck-on); color: #22170a; transform: translateX(10px); }
#deck .cmd.on::before { background: #fff6d8; }
#deck .cmd.on kbd { color: #22170a; background: rgba(255,255,255,.35); }
#deck .cmd.on::after {
  content: '▶'; position: absolute; left: -16px; font-size: 11px; color: var(--gold);
  text-shadow: 0 0 6px rgba(255,220,140,.9);
}
#munny {
  margin: 0 0 8px 6px; font: 800 14px/1 'Avenir Next', 'Segoe UI', system-ui, sans-serif; color: var(--gold);
  letter-spacing: .08em; text-shadow: 0 2px 6px #000c;
}
#munny i { font-style: normal; color: #fff3cf; margin-right: 6px; }

#gains { left: 30px !important; bottom: 214px !important; }

/* --------------------------------------------------------- the objective */
#objective {
  top: 22px !important; left: 28px !important; transform: none !important; text-align: left !important;
  font: 700 14px/1.5 Optima, 'Palatino', 'Book Antiqua', Georgia, serif !important; letter-spacing: .08em !important;
  color: #fff4d6 !important; padding: 8px 18px 8px 30px;
  background: linear-gradient(90deg, rgba(14,22,46,.82), rgba(14,22,46,0)) ;
  border-left: 3px solid var(--gold);
}
#objective::before { content: '◆'; position: absolute; left: 11px; color: var(--gold); font-size: 11px; top: 11px; }

/* ------------------------------------------------------------ place name */
#place {
  position: fixed; top: 22%; left: 50%; transform: translateX(-50%); pointer-events: none;
  text-align: center; opacity: 0; transition: opacity 1.2s ease;
  font: 700 38px/1.1 Optima, 'Palatino', 'Book Antiqua', Georgia, serif; letter-spacing: .22em; color: #fff7e2;
  text-shadow: 0 2px 18px rgba(0,0,0,.65), 0 0 40px rgba(255,210,140,.25);
}
#place small { display: block; margin-top: 10px; font: 600 14px/1 'Avenir Next', 'Segoe UI', system-ui, sans-serif;
  letter-spacing: .3em; color: #f6dea0; text-shadow: 0 1px 3px #000, 0 0 12px rgba(0,0,0,.7); }
#place::before, #place::after {
  content: ''; display: block; height: 1px; margin: 12px auto;
  width: 60%; background: linear-gradient(90deg, transparent, rgba(243,212,138,.8), transparent);
}
#place.on { opacity: 1; }

/* ------------------------------------------------------------- talk */
#talkprompt {
  bottom: 150px !important; font: 800 14px/1 'Avenir Next', 'Segoe UI', system-ui, sans-serif !important;
  letter-spacing: .12em !important; padding: 10px 18px !important; color: #fff !important;
  background: linear-gradient(180deg, rgba(34,50,96,.92), rgba(16,24,50,.92)) !important;
  border: 1px solid rgba(243,212,138,.6) !important; border-radius: 18px !important;
  box-shadow: 0 0 18px rgba(243,212,138,.25);
}

body.talking #party, body.talking #deck, body.cine #party, body.cine #deck,
body.cine #place, body.menu #deck { opacity: 0; }
`;

const RING = (size, stroke, frac) => {
  const r = size / 2 - stroke / 2 - 1;
  const c = 2 * Math.PI * r;
  const arc = c * frac;
  return { r, c, arc, size, stroke };
};

export function makeHud() {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  // a shared gradient definition for every health ring
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.setAttribute('width', '0'); defs.setAttribute('height', '0');
  defs.style.position = 'absolute';
  defs.innerHTML = `<defs><linearGradient id="hpg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b8ffcf"/><stop offset=".55" stop-color="#4fd98a"/>
    <stop offset="1" stop-color="#23a864"/></linearGradient></defs>`;
  document.body.appendChild(defs);

  const party = document.createElement('div');
  party.id = 'party';
  document.body.appendChild(party);

  const deck = document.createElement('div');
  deck.id = 'deck';
  deck.innerHTML = `<div id="munny"><i>◆</i><span>0</span></div><div class="title">COMMAND</div>`;
  const CMDS = [
    ['attack', 'Attack', 'J'],
    ['talk', 'Talk', 'E'],
    ['jump', 'Jump', 'Space'],
    ['slip', 'Dodge', 'Shift'],
    ['lock', 'Lock-on', 'Q'],
    ['menu', 'Menu', 'Esc'],
  ];
  const cmdEl = {};
  for (const [id, label, key] of CMDS) {
    const d = document.createElement('div');
    d.className = 'cmd';
    d.innerHTML = `<span>${label}</span><kbd>${key}</kbd>`;
    deck.appendChild(d);
    cmdEl[id] = d;
  }
  document.body.appendChild(deck);
  const munny = deck.querySelector('#munny span');

  const place = document.createElement('div');
  place.id = 'place';
  document.body.appendChild(place);

  // --- members --------------------------------------------------------
  const members = new Map();       // id -> { el, hp, lag, ring }
  function member(id, name, lead) {
    let m = members.get(id);
    if (m) return m;
    const size = lead ? 104 : 66, stroke = lead ? 9 : 6;
    // three quarters of a circle, opening at the bottom-left like the games'
    const R = RING(size, stroke, 0.75);
    const el = document.createElement('div');
    el.className = 'pm' + (lead ? ' lead' : '');
    const inset = stroke + 3;
    el.innerHTML = `
      <div class="ring" style="width:${size}px;height:${size}px">
        <div class="face" style="inset:${inset}px;background-image:url(/assets/characters/${id}/bust.png)"></div>
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${R.r}" stroke-width="${stroke + 3}"
            stroke-dasharray="${R.arc} ${R.c}"/>
          <circle class="lag" cx="${size / 2}" cy="${size / 2}" r="${R.r}" stroke-width="${stroke}"
            stroke-dasharray="${R.arc} ${R.c}" stroke-dashoffset="0"/>
          <circle class="hp" cx="${size / 2}" cy="${size / 2}" r="${R.r}" stroke-width="${stroke}"
            stroke-dasharray="${R.arc} ${R.c}" stroke-dashoffset="0"/>
        </svg>
        ${lead ? '<div class="lv">LV 1</div><div class="num"></div>' : ''}
      </div>
      <div class="name">${name}</div>`;
    // the leader sits at the right, the party files in to her left
    if (lead) party.appendChild(el); else party.insertBefore(el, party.firstChild);
    m = { el, R, hp: el.querySelector('.hp'), lag: el.querySelector('.lag'),
          lv: el.querySelector('.lv'), num: el.querySelector('.num'), last: -1 };
    members.set(id, m);
    return m;
  }

  function setHP(m, frac) {
    frac = Math.max(0, Math.min(1, frac));
    if (Math.abs(frac - m.last) < 1e-3) return;
    m.last = frac;
    const off = m.R.arc * (1 - frac);
    m.hp.setAttribute('stroke-dashoffset', off);
    m.lag.setAttribute('stroke-dashoffset', off);
    m.el.classList.toggle('low', frac < 0.5 && frac >= 0.25);
    m.el.classList.toggle('crit', frac < 0.25);
  }

  let placeT = 0, lastPlace = '';
  function showPlace(name, sub) {
    if (!name || name === lastPlace) return;
    lastPlace = name;
    place.innerHTML = `${name}${sub ? `<small>${sub}</small>` : ''}`;
    place.classList.add('on');
    placeT = 3.6;
  }

  addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') document.getElementById('hud')?.classList.toggle('show');
  });

  return {
    showPlace,
    /**
     * @param s { lead:{id,name,hp,maxHp,level}, party:[{id,name,frac}], gold,
     *            near:bool, hostile:bool, dt }
     */
    update(s) {
      if (s.lead) {
        const m = member(s.lead.id, s.lead.name, true);
        setHP(m, s.lead.hp / Math.max(1, s.lead.maxHp));
        if (m.lv) m.lv.textContent = `LV ${s.lead.level ?? 1}`;
        if (m.num) m.num.innerHTML = `${Math.max(0, Math.ceil(s.lead.hp))}<small>/${s.lead.maxHp}</small>`;
      }
      for (const p of s.party || []) setHP(member(p.id, p.name, false), p.frac ?? 1);
      if (s.gold !== undefined) munny.textContent = s.gold;
      const want = s.near ? 'talk' : 'attack';
      for (const [id, el] of Object.entries(cmdEl)) el.classList.toggle('on', id === want);
      cmdEl.talk.style.display = s.near ? '' : 'none';
      if (placeT > 0) {
        placeT -= s.dt || 0;
        if (placeT <= 0) place.classList.remove('on');
      }
    },
  };
}
