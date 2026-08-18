// shop.js — window.Shop: the buy/sell system for every shop in the game.
// ECONOMY-agent owned. Additive and self-contained: it no-ops silently in a
// scene that is not a shop, before its hooks land, and when the rules data is
// absent.
//
// TWO HALVES, HARD LINE BETWEEN THEM (see docs/plans/economy-design.md):
//   OPS   pure operations over GS + rules data. No DOM, no keys, no timers.
//         Everything tools/economy_test.mjs asserts lives here, so the tests
//         exercise the code the UI actually runs.
//   VIEW  a keyboard-driven overlay (EBUI) that calls OPS and re-renders from GS.
//
// NO COORDINATES, NO SHOP TABLE, NO KEEPER LABELS IN THIS FILE. Copying the rule
// play3d's scene-graph layer set for itself: adding a shop is a shops.json edit.
//   which shop is this scene?  -> the shops.json entry whose sceneKey === ?scene=
//   where is the counter?      -> the interior's own `walk_pad_counter` mesh
//                                 (every interior builder emits one)
//   what does the prompt say?  -> "Talk to the " + shops.json `keeper`
//   what does it look like?    -> the scene graph's own promptFmt/key/vTol
// A sceneKey that is not a real scene-graph node is REPORTED (console warn +
// Shop.debug().sceneKeyErrors), never silently adapted.
(function () {
  'use strict';

  const PAD = 'walk_pad_counter';   // the interaction-pad convention, emitted by
                                    // item_int_build.py / inn_int_build.py /
                                    // cookhouse_int_build.py ("interaction pads,
                                    // hidden from the beauty render")
  const PAD_MARGIN = 0.55;          // how far outside the pad box the prompt still offers
  const CIRCLE_R = 1.7;             // fallback radius when only a point is known
  const TICK_MS = 250;              // keepalive: rAF is throttled to nothing in a
                                    // background tab, and headless verification lives there

  // Anchor of last resort. These are the walk_pad_counter box centres read out of
  // the SHIPPED bundles, so they cannot disagree with what the player walks on —
  // but they are only used when SIM.pad() is unavailable (see resolveAnchor).
  // All three Dellhollow shops come off the same interior template, hence one value.
  // REGENERATE WITH:
  //   node -e "import('./tools/glb_read.mjs').then(({loadGlb})=>{for(const k of
  //     ['del-item-int','del-weapon-int','del-armor-int']){const G=loadGlb(
  //     'public/assets/scenes/'+k+'/scene.glb'),p=G.nodesNamed(/^walk_pad_counter/i)[0];
  //     console.log(k,G.nodeBox(p.i).center)}})"
  const COUNTER_FALLBACK = {
    'del-item-int':   [2.10, 0.04, 0.30],
    'del-weapon-int': [2.10, 0.04, 0.30],
    'del-armor-int':  [2.10, 0.04, 0.30],
  };

  // ==========================================================================
  // OPS — pure, headless, GS-only
  // ==========================================================================
  const GSok = () => !!(window.GS && window.GS.ok && window.GS.data);
  const shopsData = () => (GSok() && window.GS.data.shops) || null;
  const shopDef = id => { const s = shopsData(); return (s && s.shops && s.shops[id]) || null; };
  const itemDef = id => (GSok() ? window.GS.itemDef(id) : null);

  // Rate lookup goes through ONE accessor with a per-shop override already
  // honoured, so "this smith buys cheap" is a shops.json field tomorrow rather
  // than a code change.
  function rate(shopId, which) {
    const d = shopDef(shopId), s = shopsData();
    if (d && d.rates && d.rates[which] != null) return d.rates[which];
    if (s && s.rates && s.rates[which] != null) return s.rates[which];
    return which === 'sellRate' ? 0.5 : 1.0;
  }
  const money = (price, r) => Math.max(1, Math.round(price * r));

  function buyPrice(itemId, shopId) {
    const it = itemDef(itemId); if (!it || it.price == null) return null;
    return money(it.price, rate(shopId, 'buyRate'));
  }
  function sellPrice(itemId, shopId) {
    const it = itemDef(itemId); if (!it || it.price == null) return null;
    return money(it.price, rate(shopId, 'sellRate'));
  }

  // the shop that lives in a given scene key (the whole scene->shop mapping)
  function shopForScene(key) {
    const s = shopsData(); if (!s || !key) return null;
    for (const id of Object.keys(s.shops || {})) if (s.shops[id].sceneKey === key) return id;
    return null;
  }

  function stock(shopId) {
    const d = shopDef(shopId); if (!d) return [];
    return (d.stock || []).filter(id => !!itemDef(id)).map(id => ({
      id, def: itemDef(id), unit: buyPrice(id, shopId), have: window.GS.count(id),
    }));
  }

  // What the player may sell. Equipment sitting in a slot is NOT here and needs
  // no special case: GS.equip removes an item from the bag when it is equipped,
  // so a worn weapon simply is not in the inventory this reads. (Asserted in
  // tools/economy_test.mjs rather than trusted.)
  function sellable(shopId) {
    if (!GSok()) return [];
    const inv = window.GS.state.inventory || {};
    return Object.keys(inv).filter(id => {
      const it = itemDef(id);
      return it && it.price != null && !it.noSell && inv[id] > 0;
    }).map(id => ({
      id, def: itemDef(id), count: inv[id], unit: sellPrice(id, shopId),
    })).sort((a, b) => (a.def.type + a.def.name).localeCompare(b.def.type + b.def.name));
  }

  const maxAffordable = (shopId, itemId) => {
    const u = buyPrice(itemId, shopId); if (!u) return 0;
    return Math.floor(window.GS.state.gold / u);
  };

  function buy(shopId, itemId, qty) {
    qty = qty == null ? 1 : Math.floor(qty);
    if (!GSok()) return { ok: false, reason: 'nodata' };
    const d = shopDef(shopId); if (!d) return { ok: false, reason: 'noshop' };
    if (!itemDef(itemId)) return { ok: false, reason: 'noitem' };
    if ((d.stock || []).indexOf(itemId) < 0) return { ok: false, reason: 'nostock' };
    if (!(qty >= 1)) return { ok: false, reason: 'qty' };
    const unit = buyPrice(itemId, shopId), cost = unit * qty;
    if (!window.GS.spendGold(cost)) return { ok: false, reason: 'gold', cost };
    window.GS.addItem(itemId, qty);
    return { ok: true, qty, unit, spent: cost, gold: window.GS.state.gold };
  }

  function sell(itemId, qty, shopId) {
    qty = qty == null ? 1 : Math.floor(qty);
    if (!GSok()) return { ok: false, reason: 'nodata' };
    const it = itemDef(itemId); if (!it || it.price == null) return { ok: false, reason: 'noitem' };
    if (it.noSell) return { ok: false, reason: 'nosell' };
    if (!(qty >= 1)) return { ok: false, reason: 'qty' };
    const unit = sellPrice(itemId, shopId), gain = unit * qty;
    if (!window.GS.removeItem(itemId, qty)) return { ok: false, reason: 'none' };
    window.GS.addGold(gain);
    return { ok: true, qty, unit, earned: gain, gold: window.GS.state.gold };
  }

  // ==========================================================================
  // VIEW — keyboard overlay. Nothing below runs without a DOM.
  // ==========================================================================
  const U = () => window.EBUI;
  const TABS = ['BUY', 'SELL'];
  let ui = null;   // {panel, shopId, tab, cur:[0,0], mode:'list'|'qty', qty, msg}

  // The shop wears the same window grammar as the pause menu: a stock window, a
  // help strip under it (FF9's description bar) and gold in its own small
  // window. Only the geometry lives here; every colour and bevel is ui_kit's.
  const CSS = `
.sh-grid{display:grid;gap:9px;grid-template-columns:minmax(0,1fr) 12.5em;
  grid-template-areas:"list gold" "desc desc"}
/* overflow-x hidden: the selected row steps 4px right and that alone earns a
   horizontal scrollbar otherwise — a mouse affordance in a keyboard-only UI */
.sh-list{grid-area:list;padding:8px 12px 8px 9px;max-height:46vh;
  overflow-y:auto;overflow-x:hidden}
.sh-gold{grid-area:gold;padding:9px 13px;display:flex;flex-direction:column;justify-content:center;
  align-self:start}
.sh-gold .lb{font:700 var(--eb-fs-2xs)/1 var(--eb-face);letter-spacing:.2em;color:var(--eb-ink-faint)}
.sh-gold .v{font:700 var(--eb-fs-xl)/1.3 var(--eb-mono);color:var(--eb-amber-hi);
  font-variant-numeric:tabular-nums;text-align:right}
.sh-gold .v small{font-size:var(--eb-fs-sm);color:var(--eb-amber-dim);margin-left:3px}
/* WHAT THE PURSE WILL SAY AFTERWARDS is the number a player is actually
   deciding on, so it stopped being a footnote: same weight as the balance, and
   green/red by direction, because "can I still afford the armour after this"
   is the whole of shopping. */
.sh-gold .after{font:700 var(--eb-fs-md)/1.4 var(--eb-mono);text-align:right;
  color:var(--eb-ink-faint);border-top:1px solid var(--eb-rule);margin-top:7px;padding-top:6px;
  font-variant-numeric:tabular-nums}
.sh-gold .after span{display:block;font:700 var(--eb-fs-2xs)/1 var(--eb-face);
  letter-spacing:.2em;color:var(--eb-ink-faint);margin-bottom:3px}
.sh-gold .after b{color:var(--eb-ink)}
.sh-gold .after.spend b{color:#ffc9a0}
.sh-gold .after.earn b{color:var(--eb-good)}
.sh-desc{grid-area:desc;padding:10px 13px;min-height:4.4em;font:var(--eb-fs-md)/1.5 var(--eb-face);
  color:var(--eb-ink-dim)}
.sh-desc b{color:var(--eb-ink);font-weight:600}
.sh-mods{font-family:var(--eb-mono);font-size:var(--eb-fs-sm);color:var(--eb-good);letter-spacing:.04em}
.sh-qty{display:flex;align-items:center;gap:12px;margin-top:8px;padding-top:8px;
  border-top:1px solid var(--eb-rule);font-family:var(--eb-mono);font-size:var(--eb-fs-md)}
.sh-qty .lb{font:700 var(--eb-fs-2xs)/1 var(--eb-face);letter-spacing:.2em;color:var(--eb-ink-faint)}
.sh-qty .step{display:inline-flex;align-items:center;gap:11px;padding:3px 14px;border-radius:6px;
  background:var(--eb-chip);
  box-shadow:inset 1px 1px 0 var(--eb-inset-lt),inset -1px -1px 0 var(--eb-inset-dk)}
.sh-qty .step i{font-style:normal;color:var(--eb-amber);font-size:var(--eb-fs-lg)}
.sh-qty .step i.off{opacity:.25}
.sh-qty .step b{color:var(--eb-amber-hi);font-size:var(--eb-fs-lg);min-width:2ch;text-align:center;
  font-variant-numeric:tabular-nums}
.sh-qty .tot{color:var(--eb-ink)}
.sh-qty .tot b{color:var(--eb-amber-hi);font-size:var(--eb-fs-lg)}`;
  let styled = false;
  function style() {
    if (styled || !U() || !U().HAS_DOM) return;
    styled = true;
    U().style();
    const s = document.createElement('style');
    s.id = 'ebs-style'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function statLine(def) {
    if (!def.statMods) return '';
    return Object.keys(def.statMods).map(k => k + ' ' + (def.statMods[k] > 0 ? '+' : '') + def.statMods[k]).join('  ');
  }

  function rows() { return ui.tab === 0 ? stock(ui.shopId) : sellable(ui.shopId); }

  function render() {
    if (!ui || !ui.panel) return;
    const E = U(), list = rows(), gold = window.GS.state.gold;
    ui.cur[ui.tab] = E.cursor(list.length, ui.cur[ui.tab]);
    const sel = list[ui.cur[ui.tab]] || null;

    const tabs = '<div class="ebui-tabs">' + TABS.map((t, i) =>
      '<span class="ebui-tab' + (i === ui.tab ? ' on' : '') + '">' + t + '</span>').join('') + '</div>';

    let body = '';
    if (!list.length) {
      body = '<div class="ebui-note" style="margin:0;border:0;padding:6px 8px">' +
        (ui.tab === 0 ? 'Nothing for sale.' : 'You have nothing to sell.') + '</div>';
    } else {
      body = list.map((r, i) => {
        const cur = i === ui.cur[ui.tab];
        const dim = ui.tab === 0 ? (r.unit > gold) : false;
        const right = ui.tab === 0
          ? '<span class="n">' + r.unit + ' g</span><span class="n" style="flex:0 0 5.5em;opacity:.7">have ' + r.have + '</span>'
          : '<span class="n">' + r.unit + ' g</span><span class="n" style="flex:0 0 5.5em;opacity:.7">x' + r.count + '</span>';
        return E.row('<span class="k">' + E.esc(r.def.name) + '</span>' + right, { cur, dim });
      }).join('');
    }

    // the help strip: description, stat mods, and — when the quantity step is
    // live — the quantity spinner and the running total.
    let desc = '';
    if (sel) {
      desc = '<b>' + E.esc(sel.def.name) + '</b> — ' + E.esc(sel.def.desc || '') +
        (statLine(sel.def) ? '<br><span class="sh-mods">' + statLine(sel.def) + '</span>' : '');
    } else {
      desc = ui.tab === 0 ? 'The shelves are bare today.' : 'Nothing in the bag is worth coin here.';
    }
    let after = '';
    if (sel && ui.mode === 'qty') {
      const total = sel.unit * ui.qty, max = qtyMax(sel);
      desc += '<div class="sh-qty"><span class="lb">QTY</span>' +
        '<span class="step"><i class="' + (ui.qty > 1 ? '' : 'off') + '">&#8249;</i><b>' + ui.qty +
        '</b><i class="' + (ui.qty < max ? '' : 'off') + '">&#8250;</i></span>' +
        '<span class="tot">' + (ui.tab === 0 ? 'cost' : 'earns') + ' <b>' + total + ' g</b></span></div>';
      after = '<div class="after ' + (ui.tab === 0 ? 'spend' : 'earn') + '">' +
        '<span>AFTER</span><b>' +
        (ui.tab === 0 ? gold - total : gold + total) + ' g</b></div>';
    }
    if (ui.msg) desc += '<div class="ebui-msg' + (ui.msgBad ? ' bad' : '') + '" style="margin-top:6px">' +
      E.esc(ui.msg) + '</div>';

    const foot = ui.mode === 'qty'
      ? '<b>&larr;&rarr;</b> quantity (shift &times;10) &middot; <b>E/Enter</b> ' +
        (ui.tab === 0 ? 'buy' : 'sell') + ' &middot; <b>Esc/Q</b> back'
      : '<b>&uarr;&darr;</b> pick &middot; <b>&larr;&rarr;</b> buy/sell &middot; <b>E/Enter</b> choose &middot; <b>Esc/Q</b> leave';

    const d = shopDef(ui.shopId);
    ui.panel.set({
      // the KEEPER titles the window — you are talking to a person, not a shop
      title: d.keeper || d.name, sub: d.keeper ? d.name : '', gold: null,
      html: tabs + '<div class="sh-grid">' +
        '<div class="eb-win sh-list">' + body + '</div>' +
        '<div class="eb-win sh-gold"><span class="lb">GOLD</span>' +
        '<span class="v">' + gold + '<small>g</small></span>' + after + '</div>' +
        '<div class="eb-win sh-desc">' + desc + '</div></div>',
      foot,
    });
  }

  function msg(text, bad) { ui.msg = text; ui.msgBad = !!bad; if (bad && ui.panel) ui.panel.shake(); render(); }

  function qtyMax(sel) {
    if (!sel) return 1;
    return ui.tab === 0
      ? Math.max(1, Math.min(99, maxAffordable(ui.shopId, sel.id)))
      : Math.max(1, Math.min(99, sel.count));
  }

  function onKey(a, ev) {
    const list = rows(), sel = list[ui.cur[ui.tab]] || null;
    const step = ev && ev.shiftKey ? 10 : 1;
    if (ui.mode === 'qty') {
      if (a === 'cancel') { ui.mode = 'list'; ui.msg = null; return render(); }
      if (a === 'left') { ui.qty = Math.max(1, ui.qty - step); return render(); }
      if (a === 'right') { ui.qty = Math.min(qtyMax(sel), ui.qty + step); return render(); }
      if (a === 'confirm') {
        if (!sel) return;
        const r = ui.tab === 0 ? buy(ui.shopId, sel.id, ui.qty) : sell(sel.id, ui.qty, ui.shopId);
        if (!r.ok) {
          msg(r.reason === 'gold' ? 'Not enough gold.' : 'Cannot do that (' + r.reason + ').', true);
          return;
        }
        ui.mode = 'list';
        msg(ui.tab === 0
          ? 'Bought ' + r.qty + ' ' + sel.def.name + ' for ' + r.spent + ' g.'
          : 'Sold ' + r.qty + ' ' + sel.def.name + ' for ' + r.earned + ' g.');
        return;
      }
      return;
    }
    // list mode
    if (a === 'cancel') return closeShop();
    if (a === 'up') { ui.cur[ui.tab] -= 1; ui.msg = null; return render(); }
    if (a === 'down') { ui.cur[ui.tab] += 1; ui.msg = null; return render(); }
    if (a === 'left' || a === 'right' || a === 'next') {
      ui.tab = (ui.tab + (a === 'left' ? TABS.length - 1 : 1)) % TABS.length;
      ui.msg = null; return render();
    }
    if (a === 'confirm') {
      if (!sel) return;
      if (ui.tab === 0 && sel.unit > window.GS.state.gold) return msg('Not enough gold.', true);
      ui.mode = 'qty'; ui.qty = 1; ui.msg = null; return render();
    }
  }

  function openShop(shopId) {
    if (!GSok()) { console.warn('[Shop] no rules data — openShop ignored'); return false; }
    if (!U() || !U().HAS_DOM) return false;
    if (ui) return false;                              // already open
    if (!shopDef(shopId)) { console.warn('[Shop] unknown shop "' + shopId + '"'); return false; }
    style();
    ui = { shopId, tab: 0, cur: [0, 0], mode: 'list', qty: 1, msg: null };
    near = false; U().prompt('shop', null);             // the counter prompt steps aside
    // name:'shop' takes UILOCK('shop') — the engine freezes phys() and the
    // scene-graph/debug key handlers for as long as this panel lives. On close the
    // player is still at the counter, so the prompt simply comes back next tick.
    // layout:'float' — the keeper's window, the stock list, the purse and the
    // description each float SEPARATELY over the frozen shop interior, rather
    // than one opaque dialog blanking out the room you are standing in.
    ui.panel = U().panel({ name: 'shop', layout: 'float', onKey, render, onClose() { ui = null; } });
    render();
    return true;
  }
  function closeShop() { if (ui && ui.panel) ui.panel.close(); return true; }

  // ==========================================================================
  // THE COUNTER PROMPT — arming mirrors play3d's sgTick exactly
  // ==========================================================================
  let sceneKey = null, myShop = null, anchor = null, armed = null, near = false;
  let driving = false, sceneKeyErrors = [];

  function scene() {
    try { return new URLSearchParams(location.search).get('scene') || 'dellhollow3d'; }
    catch (e) { return null; }
  }

  // 1. SIM.pad hook (zero coordinates here) > 2. shops.json `counter` >
  // 3. the GLB-derived fallback table. Re-tried each tick until it resolves,
  // because the GLB may still be loading when we first look.
  function resolveAnchor() {
    if (anchor) return anchor;
    const d = shopDef(myShop); if (!d) return null;
    try {
      if (window.SIM && window.SIM.pad) {
        const p = window.SIM.pad(PAD);
        if (p && p.center) return (anchor = { src: 'SIM.pad', at: p.center, min: p.min, max: p.max });
      }
    } catch (e) { /* SIM.pad is optional */ }
    if (d.counter && d.counter.length === 3) return (anchor = { src: 'shops.json', at: d.counter });
    const f = COUNTER_FALLBACK[d.sceneKey];
    if (f) return (anchor = { src: 'fallback', at: f });
    return null;
  }

  // Box test when the pad's extents are known (a 1.7x1.0m counter pad is not a
  // circle — the same reason the scene graph gave camera boundaries bands),
  // circle otherwise. |dy| <= the graph's own vTol.
  function hit(pos) {
    const a = anchor; if (!a || !pos) return { in: false, d: Infinity };
    const vt = U() ? U().sgDef('vTol') : 2;
    const dy = Math.abs(pos.y - a.at[1]);
    if (a.min && a.max) {
      const dx = Math.max(a.min[0] - PAD_MARGIN - pos.x, 0, pos.x - (a.max[0] + PAD_MARGIN));
      const dz = Math.max(a.min[2] - PAD_MARGIN - pos.z, 0, pos.z - (a.max[2] + PAD_MARGIN));
      const d = Math.hypot(dx, dz);
      return { d, dy, in: d <= 0.0001 && dy <= vt };
    }
    const d = Math.hypot(pos.x - a.at[0], pos.z - a.at[2]);
    return { d, dy, in: d <= CIRCLE_R && dy <= vt };
  }

  // One tick of the prompt state machine. Public and idempotent so a test — or a
  // future phys() hook — can drive it by hand instead of waiting for rAF.
  function tick() {
    if (!myShop || !GSok()) return null;
    if (!resolveAnchor()) return null;
    let pos = null;
    try { pos = window.SIM && window.SIM.pos && window.SIM.pos(); } catch (e) { }
    if (!pos) return null;
    const h = hit(pos);
    // ARRIVAL SUPPRESSION, exactly as sgTick does it: a region that already
    // contains you when you arrive starts DISARMED and arms when you step out.
    if (armed === null) { armed = !h.in; near = false; if (U()) U().prompt('shop', null); return h; }
    if (!h.in) { armed = true; if (near) { near = false; if (U()) U().prompt('shop', null); } return h; }
    // no prompt while ANY modal is up (our panel, the pause menu, a battle)
    if (!armed || (U() && U().locked)) return h;
    if (!near) {
      near = true;
      const d = shopDef(myShop);
      const label = d.keeper ? 'Talk to the ' + d.keeper : 'Shop';
      if (U()) U().prompt('shop', label, U().sgDef('key'));
    }
    return h;
  }

  function drive() {
    if (driving || !U() || !U().HAS_DOM) return;
    driving = true;
    const raf = () => { tick(); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    setInterval(tick, TICK_MS);      // keepalive for background tabs (rAF stops there)
  }

  // Reported, never silently adapted: a shops.json sceneKey that is not a real
  // scene-graph node means the data and the world disagree.
  function auditSceneKeys() {
    const s = shopsData(); if (!s) return;
    let nodes = null;
    try { const g = window.SIM && window.SIM.graph && window.SIM.graph(); if (g && g.nodes) nodes = g.nodes; }
    catch (e) { }
    if (!nodes) return;                            // graph not loaded yet; re-audited on the next call
    sceneKeyErrors = Object.keys(s.shops || {}).filter(id => nodes.indexOf(s.shops[id].sceneKey) < 0)
      .map(id => id + ' -> ' + s.shops[id].sceneKey);
    if (sceneKeyErrors.length) {
      console.warn('[Shop] shops.json sceneKey values with no scene-graph node: ' +
        sceneKeyErrors.join(', ') + ' — reporting, not adapting.');
    }
  }

  function registerPrompts() {
    if (!GSok()) return false;
    sceneKey = scene();
    auditSceneKeys();
    myShop = shopForScene(sceneKey);
    // Reset BEFORE the not-a-shop exit, not after. Under the old full page load
    // there was nothing to reset — the module was new. In place, walking out of a
    // shop into the street with the counter prompt still lit and a stale anchor
    // still resolved is exactly the leaked state the reload made impossible.
    armed = null; near = false; anchor = null;
    if (U()) U().prompt('shop', null);
    if (!myShop) return false;                     // not a shop interior: silent no-op
    if (U()) {
      // E at the counter. Suppressed by EBUI while any panel is open, so this can
      // never fight a panel's own keys — and returning false leaves the keystroke
      // to play3d (the door prompt) when we are not offering anything.
      U().onGlobalKey(U().sgDef('key'), () => {
        if (!near || !armed) return false;
        return openShop(myShop);
      });
    }
    drive();
    return true;
  }

  // ==========================================================================
  window.Shop = {
    // integration surface
    openShop, closeShop, registerPrompts, tick,
    // OPS (headless; what tools/economy_test.mjs asserts)
    shopForScene, shopDef, stock, sellable, buyPrice, sellPrice, rate, maxAffordable, buy, sell,
    // debug/test
    get isOpen() { return !!ui; },
    debug() {
      return {
        scene: sceneKey, shop: myShop, anchor, armed, near, open: !!ui,
        tab: ui ? ui.tab : null, mode: ui ? ui.mode : null, qty: ui ? ui.qty : null,
        sceneKeyErrors,
      };
    },
  };

  // Self-arming: the module is additive, so it registers itself as soon as the
  // store is ready. A coordinator hook that calls Shop.registerPrompts() again is
  // harmless (idempotent), and this works with no hook at all.
  if (window.GS && window.GS.ready && window.GS.ready.then) {
    window.GS.ready.then(() => { try { registerPrompts(); } catch (e) { console.error('[Shop]', e); } });
  }
  // play3d's ONE transition event. registerPrompts() is idempotent and re-reads
  // ?scene= (which play3d has already made truthful with history.replaceState
  // before dispatching), so re-registering IS the whole handler: it re-resolves the
  // shop, re-resolves the counter pad against the NEW bundle's SIM.pad, and clears
  // a prompt the previous interior may have left up. drive() self-guards, so the
  // rAF/interval pair is started once for the page and never stacked.
  // (the addEventListener check matters: economy_test boots this module with a bare
  // globalThis as `window` and no DOM — a suite, not a page)
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('eb-scene', function () {
      try { registerPrompts(); } catch (e) { console.error('[Shop] eb-scene', e); }
    });
  }
})();
