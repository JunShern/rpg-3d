// menu.js — window.Menu: the pause menu (party / equip / items / save-load).
// ECONOMY-agent owned. Additive and self-contained: no-ops when the rules data
// is absent, and never touches play3d's internals.
//
// TWO HALVES, HARD LINE BETWEEN THEM (see docs/plans/economy-design.md):
//   OPS   pure operations over GS. compatible / statPreview / equipItem /
//         unequip / usable / useItem / partyView. No DOM, no keys, no timers.
//         tools/economy_test.mjs asserts these, so the tests exercise the code
//         the UI actually runs.
//   VIEW  a keyboard overlay (EBUI) driven by a small screen state machine.
//
// PARTY-OF-N BY CONSTRUCTION. Nothing here names a character or assumes a party
// size: every list of members is GS.activeParty(), every slot list is that
// character's own `equip` object, every stat comes from GS.stats/baseStats.
// Maren joining is `active` flipping in the save — she then appears in PARTY,
// in EQUIP's character step and in ITEMS' target step with no code change.
//
// PAUSING: EBUI takes UILOCK('menu'), the engine's modal-input contract — phys()
// freezes, and play3d's scene-graph and debug key handlers ignore input while the
// menu is up. Esc opens it (free key: play3d uses g/2/[/]/m/z, the scene graph
// uses e, the legibility overlay uses r; M is play3d's dev settings menu).
(function () {
  'use strict';

  const SLOT_LABEL = { weapon: 'weapon', armor: 'armor' };   // display only; slots come from data
  const STATS = ['atk', 'def', 'spd'];

  // ==========================================================================
  // OPS — pure, headless, GS-only
  // ==========================================================================
  const GSok = () => !!(window.GS && window.GS.ok && window.GS.data);
  const chr = id => (GSok() ? window.GS.state.party.find(p => p.id === id) : null);
  const def = id => (GSok() ? window.GS.charDef(id) : null);
  const itemDef = id => (GSok() ? window.GS.itemDef(id) : null);

  // Everything a party display needs, derived — never stored.
  function partyView() {
    if (!GSok()) return [];
    return window.GS.activeParty().map(ch => {
      const s = window.GS.stats(ch), b = window.GS.baseStats(ch);
      const need = window.GS.xpToNext(ch.level);
      const gear = {};
      for (const slot of Object.keys(ch.equip)) {
        const it = ch.equip[slot] && itemDef(ch.equip[slot]);
        gear[slot] = { id: ch.equip[slot] || null, name: it ? it.name : null };
      }
      return {
        id: ch.id, name: (def(ch.id) || {}).name || ch.id, level: ch.level,
        hp: ch.hp, maxHp: s.maxHp, xp: ch.xp, xpNext: need,
        xpFrac: need > 0 ? ch.xp / need : 0,
        stats: s, base: b,
        mods: STATS.reduce((o, k) => (o[k] = (s[k] || 0) - (b[k] || 0), o), {}),
        gear,
      };
    });
  }

  const slotsOf = charId => { const ch = chr(charId); return ch ? Object.keys(ch.equip) : []; };

  // Items in the bag that fit a slot. Equipment currently worn is NOT here —
  // GS.equip took it out of the bag when it went on — which is exactly right.
  function compatible(charId, slot) {
    if (!GSok()) return [];
    const inv = window.GS.state.inventory || {};
    return Object.keys(inv).filter(id => { const it = itemDef(id); return it && it.slot === slot && inv[id] > 0; })
      .map(id => ({ id, def: itemDef(id), count: inv[id] }))
      .sort((a, b) => (a.def.price || 0) - (b.def.price || 0));
  }

  // What equipping (or, with itemId null + a slot, removing) would do — computed
  // on a GHOST character, so a preview can never mutate the save. GS.stats reads
  // only id/level/equip, so the ghost is a faithful subject.
  function statPreview(charId, itemId, slot) {
    const ch = chr(charId); if (!ch) return null;
    const it = itemId ? itemDef(itemId) : null;
    const sl = it ? it.slot : slot;
    if (!sl) return null;
    const ghost = { id: ch.id, level: ch.level, xp: ch.xp, hp: ch.hp, active: ch.active,
      equip: Object.assign({}, ch.equip, { [sl]: itemId || null }) };
    const before = window.GS.stats(ch), after = window.GS.stats(ghost);
    const delta = {};
    for (const k of ['hp', 'maxHp'].concat(STATS)) delta[k] = (after[k] || 0) - (before[k] || 0);
    return { slot: sl, before, after, delta, replacing: ch.equip[sl] || null };
  }

  function equipItem(charId, itemId) {
    if (!GSok()) return { ok: false, reason: 'nodata' };
    const it = itemDef(itemId);
    if (!it || !it.slot) return { ok: false, reason: 'noslot' };
    if (window.GS.count(itemId) < 1) return { ok: false, reason: 'none' };
    const pv = statPreview(charId, itemId);
    if (!window.GS.equip(charId, itemId)) return { ok: false, reason: 'refused' };
    return { ok: true, slot: it.slot, delta: pv ? pv.delta : null, replaced: pv ? pv.replacing : null };
  }
  function unequip(charId, slot) {
    if (!GSok()) return { ok: false, reason: 'nodata' };
    const ch = chr(charId); if (!ch) return { ok: false, reason: 'nochar' };
    if (!ch.equip[slot]) return { ok: false, reason: 'empty' };
    const was = ch.equip[slot], pv = statPreview(charId, null, slot);
    if (!window.GS.equip(charId, null, slot)) return { ok: false, reason: 'refused' };
    return { ok: true, slot, item: was, delta: pv ? pv.delta : null };
  }

  const usable = () => {
    if (!GSok()) return [];
    const inv = window.GS.state.inventory || {};
    return Object.keys(inv).filter(id => { const it = itemDef(id); return it && it.effect && inv[id] > 0; })
      .map(id => ({ id, def: itemDef(id), count: inv[id] }))
      .sort((a, b) => (a.def.price || 0) - (b.def.price || 0));
  };
  // Heal-clamp-consume lives in GS.useItem (granted); the menu only calls it, so
  // battle item use and menu item use can never diverge.
  function useItem(charId, itemId) {
    if (!GSok()) return { ok: false, reason: 'nodata' };
    return window.GS.useItem(charId, itemId);
  }

  // ==========================================================================
  // VIEW
  // ==========================================================================
  const U = () => window.EBUI;
  const ROOT = [
    { id: 'party', label: 'PARTY', help: 'Look the party over — level, gauges, gear.' },
    { id: 'equip', label: 'EQUIP', help: 'Fit weapons and armour. Changes preview before they commit.' },
    { id: 'items', label: 'ITEMS', help: 'Use a tonic or a salve on someone who needs it.' },
    { id: 'save', label: 'SAVE', help: 'Write the journey so far into this browser.' },
    { id: 'load', label: 'LOAD', help: 'Return to the last written save.' },
    { id: 'newgame', label: 'NEW GAME', help: 'Erase the save and set out again from the beginning.' },
  ];
  // Which root entry a sub-screen belongs to — the nav column keeps showing you
  // where you are three steps down, FF9-style, instead of going blank.
  const BRANCH = {
    party: 'party', equipChar: 'equip', equipSlot: 'equip', equipItem: 'equip',
    itemPick: 'items', itemChar: 'items',
  };
  let ui = null;   // {panel, screen, cur:{...}, sel:{char,slot,item}, page, msg, confirm}

  const cur = k => (ui.cur[k] = ui.cur[k] || 0);
  const setCur = (k, v) => { ui.cur[k] = v; };

  // ---- this screen's own layout (the MATERIAL is ui_kit's; only the geometry
  // of an FF9 pause screen lives here) -------------------------------------
  const CSS = `
/* THE PAUSE SCREEN IS AN OVERLAY. Rows are AUTO, not 1fr: a fixed-height grid
   would stretch the plate to fill a box and paint blue over a scene the player
   is meant to still be looking at. Sized to content, the four windows float
   with the frozen town showing between and below them. */
.mn-grid{display:grid;min-height:0;gap:9px;
  grid-template-columns:13.5em minmax(0,1fr) 12.5em;
  grid-template-rows:auto auto;
  grid-template-areas:"nav main main" "strip strip gold"}
.mn-nav{grid-area:nav;padding:9px 8px;overflow:auto;display:flex;flex-direction:column;gap:2px}
/* THE NAV COLUMN IS THE "WHERE AM I". Same three redundant tells as .ebui-row —
   solid amber rail, brighter wash, a step toward the reader — because at TV
   distance a wash alone was not enough to find the cursor (measured before/after
   at docs/qa/ui/*/menu-root.tv.png). */
.mn-navrow{display:flex;align-items:center;gap:4px;padding:7px 8px;border-radius:6px;
  font:700 var(--eb-fs-md)/1.15 var(--eb-face);letter-spacing:.13em;color:var(--eb-ink-dim);
  border:1px solid transparent;
  transition:transform var(--eb-t-fast) var(--eb-ease-out),color var(--eb-t-fast) linear}
.mn-navrow.cur{color:var(--eb-amber-hi);border-color:#f0b45c7a;transform:translateX(4px);
  background:linear-gradient(90deg,#f0b45c5c,#f0b45c1f 72%,#f0b45c00);
  box-shadow:inset 3px 0 0 var(--eb-amber)}
.mn-nav.off .mn-navrow{opacity:.42}
.mn-nav.off .mn-navrow.cur{opacity:1;color:var(--eb-amber)}
/* min-height keeps the plate from collapsing to a sliver on a short screen;
   max-height keeps a long roster from pushing the strip off the bottom.
   THE MINIMUM CAME DOWN (38vh -> 24vh): at 1080p the root screen's two roster
   cards filled 250 px of a 410 px box and the rest was flat blue painted over a
   scene the overlay exists to let you keep looking at. Sized to content is the
   whole design; a floor that big was quietly defeating it. */
.mn-main{grid-area:main;display:grid;gap:12px;padding:11px 13px;overflow:auto;
  grid-template-columns:minmax(0,1fr);align-content:start;
  min-height:min(200px,24vh);max-height:min(620px,68vh)}
.mn-main.split{grid-template-columns:minmax(0,15em) minmax(0,1fr)}
/* overflow-x HIDDEN, not auto: the selected row steps 4px toward the reader and
   that alone was enough to give both columns a horizontal scrollbar — a mouse
   affordance, on a couch game, announcing four pixels of nothing. */
.mn-list{overflow-y:auto;overflow-x:hidden;min-width:0;max-height:100%;padding-right:5px}
.mn-side{overflow-y:auto;overflow-x:hidden;min-width:0;max-height:100%}
.mn-strip{grid-area:strip;padding:9px 13px;font:var(--eb-fs-md)/1.45 var(--eb-face);
  color:var(--eb-ink-dim);min-height:3.1em;display:flex;align-items:center}
/* the content is ONE span, never loose text nodes: a flex container turns each
   text run into its own anonymous item and eats the spaces between them. */
.mn-strip>span{display:block}
.mn-strip b{color:var(--eb-ink);font-weight:600}
.mn-gold{grid-area:gold;padding:8px 13px;display:flex;flex-direction:column;justify-content:center}
.mn-gold .lb{font:700 var(--eb-fs-2xs)/1 var(--eb-face);letter-spacing:.2em;color:var(--eb-ink-faint)}
.mn-gold .v{font:700 var(--eb-fs-xl)/1.3 var(--eb-mono);color:var(--eb-amber-hi);
  font-variant-numeric:tabular-nums;text-align:right}
.mn-gold .v small{font-size:var(--eb-fs-sm);color:var(--eb-amber-dim);margin-left:3px}

.mn-roster{display:flex;flex-direction:column;gap:9px}
.mn-roster.sm{gap:6px}
.mn-mem.sm{padding:5px 9px}
.mn-mem.sm .who{flex:0 0 8em}
.mn-mem.sm .nm{font-size:var(--eb-fs-md)}
.mn-mem{display:flex;gap:12px;align-items:center;padding:9px 11px;border-radius:7px;
  background:var(--eb-card);
  box-shadow:inset 1px 1px 0 var(--eb-inset-lt),inset -1px -1px 0 var(--eb-inset-dk);
  transition:transform var(--eb-t-fast) var(--eb-ease-out),background var(--eb-t-fast) linear}
.mn-mem.cur{background:var(--eb-card-cur);transform:translateX(4px);
  box-shadow:inset 3px 0 0 var(--eb-amber),inset -1px -1px 0 var(--eb-inset-dk),
             0 0 0 1px #f0b45c8a}
.mn-mem .who{flex:0 0 8.5em;min-width:0}
.mn-mem .nm{font:700 var(--eb-fs-lg)/1.2 var(--eb-face);letter-spacing:.01em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mn-mem.cur .nm{color:var(--eb-amber-hi)}
.mn-mem .lv{font:var(--eb-fs-xs)/1.4 var(--eb-mono);color:var(--eb-ink-faint);letter-spacing:.12em}
.mn-mem .g{flex:1 1 auto;max-width:34em;display:flex;flex-direction:column;gap:6px;min-width:0}

.mn-detail{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start}
/* the plate's text column must be allowed to be NARROW: it shares the window
   with a 252px bust, and a nowrap stat row in a 1fr track will happily draw
   itself straight across the portrait if the track is not told it may shrink */
.mn-detail>div{min-width:0;overflow:hidden}
.mn-detail .eb-gauge{margin:5px 0;max-width:30em}
.mn-dname{font:700 var(--eb-fs-2xl)/1.1 var(--eb-face);letter-spacing:.01em;color:var(--eb-ink)}
.mn-dlv{font:var(--eb-fs-xs)/1.6 var(--eb-mono);color:var(--eb-amber);letter-spacing:.2em;margin-bottom:9px}
.mn-block{margin-top:13px;padding-top:10px;border-top:1px solid var(--eb-rule)}
.mn-block .h{font:700 var(--eb-fs-2xs)/1.3 var(--eb-face);letter-spacing:.2em;color:var(--eb-ink-faint);
  display:block;margin-bottom:7px}
/* the value and its equipment bonus are ONE reading — "15 (+2)" — so the pair
   never wraps; at the new type size the old 30em cap split them across lines */
/* AUTO-FIT, not a hard two columns. At the new type size the plate's text
   column can be as narrow as 230px when it is sharing a split screen with a
   bust, and a fixed 2-column grid answered that by drawing the DEF cell on top
   of the ATK one. auto-fit drops to one column instead of overlapping. */
.mn-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5em,1fr));gap:6px 22px;
  max-width:100%;font-family:var(--eb-mono);font-size:var(--eb-fs-sm)}
.mn-stats .r{display:flex;gap:9px;align-items:baseline;min-width:0}
.mn-stats .l{flex:0 0 auto;color:var(--eb-ink-faint);letter-spacing:.12em;font-size:var(--eb-fs-2xs);
  white-space:nowrap;min-width:4.2em}
.mn-stats .v{color:var(--eb-ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.mn-gear{display:flex;flex-direction:column;gap:5px;max-width:30em;
  font-family:var(--eb-mono);font-size:var(--eb-fs-sm)}
.mn-gear .r{display:flex;gap:9px}
.mn-gear .l{flex:0 0 4.6em;color:var(--eb-ink-faint);letter-spacing:.1em;font-size:var(--eb-fs-2xs);
  align-self:center}
/* ===== "IF EQUIPPED" =====================================================
   THE ONLY QUESTION THE EQUIP SCREEN EXISTS TO ANSWER, and it used to be the
   smallest, palest thing on it — 12.5px mono in the bottom-left corner under
   two bigger blocks. It is now a framed amber card: the block a player's eye
   should land on when they move the cursor down a weapon list. */
.mn-cmp{margin-top:8px;max-width:30em;font-family:var(--eb-mono);
  font-size:var(--eb-fs-lg);display:flex;flex-direction:column;gap:5px;
  padding:9px 12px;border-radius:7px;
  background:linear-gradient(180deg,#f0b45c1f,#f0b45c08);
  box-shadow:inset 0 0 0 1px #f0b45c5c}
.mn-cmp .r{display:flex;gap:10px;align-items:baseline}
.mn-cmp .l{flex:0 0 3.6em;color:var(--eb-amber);letter-spacing:.12em;
  font-size:var(--eb-fs-xs);font-weight:700}
.mn-cmp b{color:var(--eb-ink);font-weight:700}
.mn-block.cmpblock{border-top-color:#f0b45c47}
.mn-block.cmpblock .h{color:var(--eb-amber)}
.mn-ask{max-width:34em;margin:6vh auto 0;text-align:center}
.mn-ask .q{font-size:var(--eb-fs-lg);color:var(--eb-ink);margin-bottom:16px;line-height:1.5}
.mn-ask .o{display:flex;gap:10px;justify-content:center}
.mn-ask .o .ebui-row{min-width:7.5em;justify-content:center}
@media (max-width:900px){
  .mn-grid{grid-template-columns:11em minmax(0,1fr) 10em}
  .mn-main.split{grid-template-columns:minmax(0,15em) minmax(0,1fr)}
  .mn-detail{grid-template-columns:minmax(0,1fr)}
}`;
  let styled = false;
  function style() {
    if (styled || !U() || !U().HAS_DOM) return;
    styled = true;
    U().style();                                    // the shared palette first
    const s = document.createElement('style');
    s.id = 'ebm-style'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- pieces --------------------------------------------------------------
  const memberAt = i => { const ps = partyView(); return ps.length ? ps[((i % ps.length) + ps.length) % ps.length] : null; };

  // one roster line: portrait, name/level, and the three gauges. MP is a
  // RESERVED COLUMN — it renders as a dash until magic exists, so the layout
  // does not move when it arrives.
  // `compact` drops the XP/MP lines to one HP gauge — used where the roster is a
  // SECONDARY read (under a character plate) rather than the whole screen.
  function memberRow(p, isCur, compact) {
    const E = U();
    return '<div class="mn-mem' + (isCur ? ' cur' : '') + (compact ? ' sm' : '') + '">' +
      E.cur(isCur) + E.portrait(p.id, compact ? 40 : 54) +
      '<div class="who"><div class="nm">' + E.esc(p.name) + '</div>' +
      '<div class="lv">LV ' + p.level + '</div></div>' +
      '<div class="g">' + E.gauge('HP', p.hp, p.maxHp) +
      (compact ? '' : E.gauge('MP', null) + E.gauge('XP', p.xp, p.xpNext, { kind: 'xp' })) +
      '</div></div>';
  }
  function roster(curId, compact) {
    const ps = partyView();
    if (!ps.length) return '<div class="ebui-note">No party.</div>';
    return '<div class="mn-roster' + (compact ? ' sm' : '') + '">' +
      ps.map(p => memberRow(p, p.id === curId, compact)).join('') + '</div>';
  }

  // the big FF9 character plate: gauges and stats left, the bust on the right
  function detail(p, extra) {
    if (!p) return '';
    const E = U();
    const stats = [['ATK', 'atk'], ['DEF', 'def'], ['SPD', 'spd'], ['MAX HP', 'maxHp']].map(s => {
      const v = s[1] === 'maxHp' ? p.maxHp : (p.stats[s[1]] || 0);
      const mod = p.mods[s[1]] || 0;
      return '<div class="r"><span class="l">' + s[0] + '</span><span class="v">' + v +
        (mod ? ' <span class="ebui-' + (mod > 0 ? 'up' : 'dn') + '">(' + (mod > 0 ? '+' : '') + mod + ')</span>' : '') +
        '</span></div>';
    }).join('');
    const gear = Object.keys(p.gear).map(s =>
      '<div class="r"><span class="l">' + (SLOT_LABEL[s] || s).toUpperCase() + '</span><span>' +
      E.esc(p.gear[s].name || '—') + '</span></div>').join('');
    return '<div class="mn-detail"><div>' +
      '<div class="mn-dname">' + E.esc(p.name) + '</div>' +
      '<div class="mn-dlv">LEVEL ' + p.level + '</div>' +
      E.gauge('HP', p.hp, p.maxHp) + E.gauge('MP', null) +
      E.gauge('XP', p.xp, p.xpNext, { kind: 'xp' }) +
      '<div class="mn-block"><span class="h">STATS &middot; gear in green</span>' +
      '<div class="mn-stats">' + stats + '</div></div>' +
      '<div class="mn-block"><span class="h">EQUIPMENT</span>' +
      '<div class="mn-gear">' + gear + '</div></div>' +
      (extra || '') +
      '</div>' + E.portrait(p.id, 210, { big: true }) + '</div>';
  }

  function listOf(items, key, fmt) {
    const E = U(), i0 = E.cursor(items.length, cur(key));
    setCur(key, i0);
    if (!items.length) return '<div class="ebui-note">—</div>';
    return items.map((it, i) => E.row(fmt(it, i), { cur: i === i0, dim: !!it._dim })).join('');
  }

  function navHtml() {
    const E = U(), active = ui.screen === 'root' && !ui.confirm;
    const i0 = E.cursor(ROOT.length, cur('root'));
    const branch = ui.confirm ? null : BRANCH[ui.screen];
    return '<div class="eb-win mn-nav' + (active ? '' : ' off') + '">' +
      ROOT.map((r, i) => {
        const on = active ? i === i0 : r.id === branch;
        return '<div class="mn-navrow' + (on ? ' cur' : '') + '">' + E.cur(on) +
          '<span>' + r.label + '</span></div>';
      }).join('') + '</div>';
  }

  // ---- screens -------------------------------------------------------------
  function render() {
    if (!ui || !ui.panel) return;
    const E = U(), gold = window.GS.state.gold;
    const ps = partyView();
    let title = 'PAUSE', main = '', strip = '', split = false;
    let foot = '<b>&uarr;&darr;</b>/WASD move &middot; <b>E/Enter</b> select &middot; <b>Esc/Q</b> back';

    if (ui.confirm) {
      const c = ui.confirm, i = E.cursor(2, cur('confirm'));
      title = 'PAUSE — ' + c.title;
      main = '<div class="mn-ask"><div class="q">' + E.esc(c.text) + '</div><div class="o">' +
        ['Yes', 'No'].map((t, k) => E.row('<span class="k">' + t + '</span>', { cur: k === i })).join('') +
        '</div></div>';
      strip = 'This choice cannot be taken back once it is made.';
      foot = '<b>&uarr;&darr;</b> choose &middot; <b>E/Enter</b> confirm &middot; <b>Esc/Q</b> cancel';
    } else if (ui.screen === 'root') {
      const p = memberAt(ui.page);
      main = roster(p ? p.id : null);
      strip = (ROOT[E.cursor(ROOT.length, cur('root'))] || {}).help || '';
      foot = '<b>&uarr;&darr;</b> command &middot; <b>&larr;&rarr;</b> highlight member &middot; ' +
        '<b>E/Enter</b> select &middot; <b>Esc/Q</b> close';
    } else if (ui.screen === 'party') {
      title = 'PAUSE — PARTY';
      const p = memberAt(ui.page);
      main = detail(p) + (ps.length > 1
        ? '<div class="mn-block"><span class="h">PARTY</span>' + roster(p ? p.id : null, true) + '</div>'
        : '');
      strip = p ? ((def(p.id) || {}).desc || '') : 'No party.';
      foot = ps.length > 1
        ? '<b>&larr;&rarr;</b> member ' + (E.cursor(ps.length, ui.page) + 1) + '/' + ps.length +
          ' &middot; <b>Esc/Q</b> back'
        : '<b>Esc/Q</b> back';
    } else if (ui.screen === 'equipChar' || ui.screen === 'itemChar') {
      split = true;
      const isItem = ui.screen === 'itemChar';
      // NB: panel titles are set with textContent — plain text only, no entities.
      title = 'PAUSE — ' + (isItem ? 'ITEMS › on whom?' : 'EQUIP › who?');
      const it = isItem && ui.sel.item ? itemDef(ui.sel.item) : null;
      const rows = ps.map(p => ({ p, _dim: !!(it && it.effect && it.effect.heal && p.hp >= p.maxHp) }));
      const list = listOf(rows, 'char', r =>
        '<span class="k">' + E.esc(r.p.name) + '</span><span class="n">Lv ' + r.p.level +
        '</span><span class="n" style="flex:0 0 6em">' + r.p.hp + '/' + r.p.maxHp + '</span>');
      const sel = rows[E.cursor(rows.length, cur('char'))];
      main = '<div class="mn-list">' + list + '</div><div class="mn-side">' +
        detail(sel ? sel.p : null) + '</div>';
      strip = isItem
        ? (it ? '<b>' + E.esc(it.name) + '</b> — ' + E.esc(it.desc || '') : 'Choose who to treat.')
        : 'Choose whose gear to change.';
    } else if (ui.screen === 'equipSlot') {
      split = true;
      const p = ps.find(x => x.id === ui.sel.char);
      title = 'PAUSE — EQUIP › ' + (p ? p.name : '');
      const slots = slotsOf(ui.sel.char).map(s => ({ s, name: p ? (p.gear[s].name || '—') : '—' }));
      const list = listOf(slots, 'slot', r =>
        '<span class="k">' + (SLOT_LABEL[r.s] || r.s) + '</span><span class="n" style="flex:0 0 auto">' +
        E.esc(r.name) + '</span>');
      main = '<div class="mn-list">' + list + '</div><div class="mn-side">' + detail(p) + '</div>';
      const s0 = slots[E.cursor(slots.length, cur('slot'))];
      strip = s0 ? ('<b>' + (SLOT_LABEL[s0.s] || s0.s) + '</b> — currently ' + E.esc(s0.name)) : '';
    } else if (ui.screen === 'equipItem') {
      split = true;
      const p = ps.find(x => x.id === ui.sel.char), slot = ui.sel.slot;
      title = 'PAUSE — EQUIP › ' + (p ? p.name : '') + ' › ' + (SLOT_LABEL[slot] || slot);
      const rows = compatible(ui.sel.char, slot).map(r => ({ kind: 'item', id: r.id, def: r.def, count: r.count }));
      if (p && p.gear[slot].id) rows.push({ kind: 'remove', id: null, def: { name: '— remove —' }, count: 0 });
      const i0 = E.cursor(rows.length, cur('eqitem')); setCur('eqitem', i0);
      const sel = rows[i0] || null;
      const list = rows.length
        ? rows.map((r, i) => E.row('<span class="k">' + E.esc(r.def.name) + '</span>' +
          (r.kind === 'item' ? '<span class="n">x' + r.count + '</span>' : ''), { cur: i === i0 })).join('')
        : '<div class="ebui-note">Nothing fits this slot.</div>';
      // live before -> after for the highlighted row, BEFORE anything is committed
      let cmp = '';
      if (sel) {
        const pv = statPreview(ui.sel.char, sel.kind === 'item' ? sel.id : null, slot);
        if (pv) {
          const keys = STATS.concat(['maxHp']).filter(k => pv.delta[k]);
          cmp = '<div class="mn-block cmpblock"><span class="h">IF EQUIPPED</span><div class="mn-cmp">' +
            (keys.length
              ? keys.map(k => '<div class="r"><span class="l">' + k.toUpperCase() + '</span><span>' +
                (pv.before[k] || 0) + ' &rarr; <b>' + (pv.after[k] || 0) + '</b>' + E.delta(pv.delta[k]) +
                '</span></div>').join('')
              : '<span class="ebui-msg">no stat change</span>') +
            '</div></div>';
        }
      }
      main = '<div class="mn-list">' + list + '</div><div class="mn-side">' + detail(p, cmp) + '</div>';
      strip = sel ? (sel.kind === 'item'
        ? '<b>' + E.esc(sel.def.name) + '</b> — ' + E.esc(sel.def.desc || '')
        : 'Take the piece off and put it back in the bag.') : 'Nothing here fits.';
    } else if (ui.screen === 'itemPick') {
      split = true;
      title = 'PAUSE — ITEMS';
      const rows = usable();
      const i0 = E.cursor(rows.length, cur('item')); setCur('item', i0);
      const sel = rows[i0] || null;
      const list = rows.length
        ? rows.map((r, i) => E.row('<span class="k">' + E.esc(r.def.name) + '</span><span class="n">x' + r.count + '</span>',
          { cur: i === i0 })).join('')
        : '<div class="ebui-note">No usable items.</div>';
      main = '<div class="mn-list">' + list + '</div><div class="mn-side">' + roster(null) + '</div>';
      strip = sel ? ('<b>' + E.esc(sel.def.name) + '</b> — ' + E.esc(sel.def.desc || '')) : 'The bag is empty.';
    }

    if (ui.msg) {
      strip = '<span class="ebui-msg' + (ui.msgBad ? ' bad' : '') + '">' + E.esc(ui.msg) + '</span>';
    }

    const html = '<div class="mn-grid">' + navHtml() +
      '<div class="eb-win mn-main' + (split ? ' split' : '') + '">' + main + '</div>' +
      '<div class="eb-win mn-strip"><span>' + strip + '</span></div>' +
      '<div class="eb-win mn-gold"><span class="lb">GOLD</span>' +
      '<span class="v">' + gold + '<small>g</small></span></div>' +
      '</div>';
    // gold rides in its own window (FF convention), so the head bar carries none.
    // WHERE AM I, the other half: the nav column and the title's breadcrumb say
    // where you are IN THE MENU; the sub says where you are in the GAME. It is
    // read straight off the save's own `at` (the resume authority), so it cannot
    // drift from what LOAD would put you back into, and it is simply absent on a
    // page whose store has not got there yet.
    const at = (window.GS.state && window.GS.state.at) || null;
    const where = at ? ('Chapter ' + (at.chapter || 1) + (at.scene ? ' · ' + at.scene : '')) : '';
    ui.panel.set({ title, sub: where, gold: null, html, foot });
  }

  function msg(t, bad) { ui.msg = t; ui.msgBad = !!bad; if (bad && ui.panel) ui.panel.shake(); render(); }
  const go = (screen, keepMsg) => { ui.screen = screen; if (!keepMsg) ui.msg = null; render(); };
  function ask(title, text, action, defaultNo) {
    ui.confirm = { title, text, action };
    setCur('confirm', defaultNo ? 1 : 0);
    render();
  }

  // `ui.page` is the HIGHLIGHTED PARTY MEMBER, not a page of cards: the FF9
  // plate shows one character at a time and left/right walks the party. With a
  // party of one it is a no-op, which is exactly right.
  function pages() { return Math.max(1, partyView().length); }

  function onKey(a, ev) {
    if (ui.confirm) {
      const i = cur('confirm');
      if (a === 'up' || a === 'down') { setCur('confirm', (i + 1) % 2); return render(); }
      if (a === 'cancel') { ui.confirm = null; return render(); }
      if (a === 'confirm') {
        const c = ui.confirm; ui.confirm = null;
        if (i === 0) c.action(); else render();
        return;
      }
      return;
    }
    const step = ev && ev.shiftKey ? 5 : 1;

    if (ui.screen === 'root') {
      if (a === 'cancel') return close();
      if (a === 'up') { setCur('root', cur('root') - step); return render(); }
      if (a === 'down') { setCur('root', cur('root') + step); return render(); }
      if (a === 'left' || a === 'right') { ui.page = (ui.page + (a === 'left' ? pages() - 1 : 1)) % pages(); return render(); }
      if (a === 'confirm') return chooseRoot(ROOT[U().cursor(ROOT.length, cur('root'))].id);
      return;
    }
    if (ui.screen === 'party') {
      if (a === 'cancel') return go('root');
      if (a === 'left' || a === 'right') { ui.page = (ui.page + (a === 'left' ? pages() - 1 : 1)) % pages(); return render(); }
      return;
    }
    if (ui.screen === 'equipChar' || ui.screen === 'itemChar') {
      const ps = partyView();
      if (a === 'cancel') return go(ui.screen === 'itemChar' ? 'itemPick' : 'root');
      if (a === 'up') { setCur('char', cur('char') - 1); return render(); }
      if (a === 'down') { setCur('char', cur('char') + 1); return render(); }
      if (a === 'confirm') {
        const p = ps[U().cursor(ps.length, cur('char'))]; if (!p) return;
        if (ui.screen === 'equipChar') { ui.sel.char = p.id; setCur('slot', 0); return go('equipSlot'); }
        const r = useItem(p.id, ui.sel.item);
        if (!r.ok) return msg(r.reason === 'full' ? p.name + ' is unhurt.' : 'Cannot use that (' + r.reason + ').', true);
        const name = (itemDef(ui.sel.item) || {}).name || ui.sel.item;
        // the item may have been the last one: fall back to the list, which
        // re-derives from GS and will simply not contain it any more
        const left = window.GS.count(ui.sel.item);
        ui.screen = left > 0 ? 'itemChar' : 'itemPick';
        return msg(name + ' restored ' + r.healed + ' HP to ' + p.name + '.');
      }
      return;
    }
    if (ui.screen === 'equipSlot') {
      const slots = slotsOf(ui.sel.char);
      if (a === 'cancel') return go('equipChar');
      if (a === 'up') { setCur('slot', cur('slot') - 1); return render(); }
      if (a === 'down') { setCur('slot', cur('slot') + 1); return render(); }
      if (a === 'confirm') { ui.sel.slot = slots[U().cursor(slots.length, cur('slot'))]; setCur('eqitem', 0); return go('equipItem'); }
      return;
    }
    if (ui.screen === 'equipItem') {
      const rows = compatible(ui.sel.char, ui.sel.slot).map(r => ({ kind: 'item', id: r.id }));
      const p = partyView().find(x => x.id === ui.sel.char);
      if (p && p.gear[ui.sel.slot].id) rows.push({ kind: 'remove', id: null });
      if (a === 'cancel') return go('equipSlot');
      if (a === 'up') { setCur('eqitem', cur('eqitem') - 1); return render(); }
      if (a === 'down') { setCur('eqitem', cur('eqitem') + 1); return render(); }
      if (a === 'confirm') {
        const sel = rows[U().cursor(rows.length, cur('eqitem'))]; if (!sel) return;
        const r = sel.kind === 'item' ? equipItem(ui.sel.char, sel.id) : unequip(ui.sel.char, ui.sel.slot);
        if (!r.ok) return msg('Cannot do that (' + r.reason + ').', true);
        return msg(sel.kind === 'item'
          ? 'Equipped ' + (itemDef(sel.id) || {}).name + '.'
          : 'Removed ' + ((itemDef(r.item) || {}).name || 'gear') + '.');
      }
      return;
    }
    if (ui.screen === 'itemPick') {
      const rows = usable();
      if (a === 'cancel') return go('root');
      if (a === 'up') { setCur('item', cur('item') - 1); return render(); }
      if (a === 'down') { setCur('item', cur('item') + 1); return render(); }
      if (a === 'confirm') {
        const sel = rows[U().cursor(rows.length, cur('item'))]; if (!sel) return;
        ui.sel.item = sel.id; setCur('char', 0); return go('itemChar');
      }
      return;
    }
  }

  function chooseRoot(id) {
    if (id === 'party') { ui.page = 0; return go('party'); }
    if (id === 'equip') { setCur('char', 0); return go('equipChar'); }
    if (id === 'items') { setCur('item', 0); return go('itemPick'); }
    if (id === 'save') return ask('SAVE', 'Write the current game to this browser?', () => {
      const ok = window.GS.save(); msg(ok ? 'Game saved.' : 'Save failed.', !ok);
    });
    if (id === 'load') return ask('LOAD', 'Discard unsaved progress and load the last save?', () => {
      const ok = window.GS.load(); ui.page = 0; ui.cur = {}; msg(ok ? 'Game loaded.' : 'No save found.', !ok);
    }, true);
    if (id === 'newgame') return ask('NEW GAME', 'Erase the save and start over? This cannot be undone.', () => {
      window.GS.reset(); go('root'); msg('New game started.');
    }, true);
  }

  // ---- open / close --------------------------------------------------------
  function open() {
    if (!GSok()) { console.warn('[Menu] no rules data — open ignored'); return false; }
    if (!U() || !U().HAS_DOM) return false;
    if (ui) return false;
    if (U().locked) return false;                 // another modal owns the screen
    style();
    ui = { screen: 'root', cur: {}, sel: {}, page: 0, msg: null, confirm: null };
    // layout:'full' = the FF9 shape (nav / plate / help strip / gold, each its
    // own window) rather than the shop's single centred dialog.
    ui.panel = U().panel({ name: 'menu', layout: 'full', onKey, render, onClose() { ui = null; } });
    render();
    return true;
  }
  function close() { if (ui && ui.panel) ui.panel.close(); return true; }

  function register() {
    if (!GSok() || !U()) return false;
    // Esc opens the menu. EBUI suppresses global keys while any modal is up, so
    // Esc inside the shop closes the shop and never stacks a menu on top of it.
    U().onGlobalKey('escape', () => open());
    return true;
  }

  // ==========================================================================
  window.Menu = {
    open, close, register,
    // OPS (headless; what tools/economy_test.mjs asserts)
    partyView, slotsOf, compatible, statPreview, equipItem, unequip, usable, useItem,
    get isOpen() { return !!ui; },
    debug() { return { open: !!ui, screen: ui ? ui.screen : null, sel: ui ? ui.sel : null, page: ui ? ui.page : 0 }; },
  };

  if (window.GS && window.GS.ready && window.GS.ready.then) {
    window.GS.ready.then(() => { try { register(); } catch (e) { console.error('[Menu]', e); } });
  }
})();
