// game_state.js — THE game-state store (coordinator-owned).
// One serializable object holds everything that persists: party, inventory,
// gold, equipment, flags. Systems (battle/shop/menu/encounters) read and write
// ONLY through this API and never keep their own copies. GS.serialize() is the
// save format. Loads its rules data from public/game/*.json; every consumer
// must await GS.ready before touching it. No-ops safely if data files 404.
(function () {
  const DATA_FILES = { monsters: 'game/monsters.json', items: 'game/items.json',
    encounters: 'game/encounters.json', growth: 'game/growth.json', shops: 'game/shops.json' };
  // SAVE SLOT vs SAVE VERSION. The KEY is the slot's name and never moves again:
  // renaming it on every schema bump orphans the very save the migration exists to
  // rescue. `v` inside the payload is the version, and load() UPGRADES it.
  // 'emberbrook-save-v1' is the pre-2026-08-02 key, read once and migrated forward.
  // LOCAL EDIT (rpg-3d): the save SLOT has to be per-game. Two games served from
  // localhost cannot share one localStorage key -- the first one to load would
  // read the other's party and silently migrate it. Everything else in this file
  // is upstream byte-for-byte so it can be re-copied when Emberbrook improves it.
  const SAVE_KEY = (typeof window !== 'undefined' && window.EB_SAVE_KEY) || 'emberbrook-save';
  const LEGACY_KEYS = ['emberbrook-save-v1'];
  const SAVE_V = 2;
  const listeners = {};

  const GS = window.GS = {
    data: null,          // rules data (read-only after load)
    state: null,         // the serializable save state
    ready: null,         // Promise — await before use
    ok: false,           // data loaded and state initialised

    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    emit(ev, arg) { (listeners[ev] || []).forEach(cb => { try { cb(arg); } catch (e) { console.error('[GS]', ev, e); } }); },

    // ---- lifecycle -------------------------------------------------------
    async init() {
      const data = {};
      try {
        for (const [k, url] of Object.entries(DATA_FILES)) {
          const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
          data[k] = await r.json();
        }
      } catch (e) { console.warn('[GS] rules data unavailable — game systems disabled:', e.message); return; }
      GS.data = data;
      if (!GS.load()) GS.newGame();
      GS.ok = true; GS.emit('ready', GS.state);
    },

    newGame() {
      const g = GS.data.growth;
      const party = Object.entries(g.characters).map(([id, c]) => GS.freshMember(id, c));
      GS.state = { v: SAVE_V, party, gold: g.startGold || 0,
        inventory: Object.assign({}, g.startInventory || {}), flags: {},
        // WHERE THE PLAYER IS — the only resume authority (docs/plans/end-to-end-wiring.md §5).
        // A v1 save restored gold and levels into whatever scene the URL happened to name.
        at: { chapter: 1, scene: null, cam: null, pos: null, yaw: null },
        beats: {},                       // the once:true ledger; a reload cannot replay a beat
        meta: { savedAt: null, playSeconds: 0 } };
      // start equipment lives in equip slots, not inventory
      GS.emit('change', GS.state);
    },
    freshMember(id, c) {
      c = c || GS.charDef(id);
      return { id, active: !!c.active, level: 1, xp: 0,
        hp: c.base.hp, equip: Object.assign({ weapon: null, armor: null }, c.startEquip || {}) };
    },

    // ---- story flags (the ONLY writer a beat may use) --------------------
    // A beat never writes GS.state.flags by hand: it goes through here, so the
    // save, every listening panel and the join sync all agree. Same vocabulary
    // dialogue.js's effects() already speaks.
    flag(k) { return GS.state && GS.state.flags ? GS.state.flags[k] : undefined; },
    setFlags(map) {
      if (!GS.state || !map) return false;
      let changed = false;
      for (const k in map) { if (GS.state.flags[k] !== map[k]) { GS.state.flags[k] = map[k]; changed = true; } }
      if (changed) { GS.syncJoins(); GS.emit('change', GS.state); }
      return changed;
    },
    // growth.json:33 declared `joinFlag: "maren-joined"` and NOTHING read it
    // (the audit's G8). menu.js:15 already documents the intended behaviour —
    // "Maren joining is `active` flipping in the save". This is that line.
    syncJoins() {
      if (!GS.data || !GS.state) return 0;
      let n = 0;
      for (const [id, c] of Object.entries(GS.data.growth.characters)) {
        if (!c.joinFlag) continue;
        const want = !!GS.state.flags[c.joinFlag];
        if (!want) continue;                       // a join is one-way; nothing un-joins
        let ch = GS.state.party.find(p => p.id === id);
        if (!ch) { ch = GS.freshMember(id, c); GS.state.party.push(ch); }
        if (!ch.active) { ch.active = true; n++; }
      }
      return n;
    },
    // ---- where the player is ---------------------------------------------
    setAt(patch) {
      if (!GS.state || !patch) return null;
      GS.state.at = Object.assign({ chapter: 1, scene: null, cam: null, pos: null, yaw: null },
                                  GS.state.at, patch);
      return GS.state.at;
    },

    // ---- derived stats ---------------------------------------------------
    charDef(id) { return GS.data.growth.characters[id]; },
    baseStats(ch) {                    // level-scaled, before equipment
      const c = GS.charDef(ch.id), L = ch.level - 1, out = {};
      for (const k of ['hp', 'atk', 'def', 'spd']) out[k] = Math.floor(c.base[k] + c.growth[k] * L);
      return out;
    },
    stats(ch) {                        // with equipment statMods
      // Single source of truth for character math: when the battle kernel is
      // loaded, delegate to it (it must also run in node without GS, so the
      // math lives there). The inline version below is the no-kernel fallback
      // and MUST stay behaviorally identical.
      if (window.Rules && Rules.derive && Rules.derive.charStats)
        return Rules.derive.charStats(GS.data.growth, GS.data.items.items, ch);
      const s = GS.baseStats(ch);
      for (const slot of ['weapon', 'armor']) {
        const it = ch.equip[slot] && GS.data.items.items[ch.equip[slot]];
        if (it && it.statMods) for (const [k, v] of Object.entries(it.statMods)) s[k] = (s[k] || 0) + v;
      }
      s.maxHp = s.hp; return s;
    },
    activeParty() { return GS.state.party.filter(p => p.active); },

    // ---- xp / leveling ---------------------------------------------------
    xpToNext(level) { const c = GS.data.growth.curve; return Math.floor(c.k * level * level); },
    grantXp(amount) {                  // split across active members; returns level-up events
      const alive = GS.activeParty(), events = [];
      const share = Math.max(1, Math.floor(amount / Math.max(1, alive.length)));
      for (const ch of alive) {
        ch.xp += share;
        while (ch.xp >= GS.xpToNext(ch.level)) {
          ch.xp -= GS.xpToNext(ch.level); ch.level++;
          ch.hp = GS.stats(ch).maxHp;                 // level-up heals to new max
          events.push({ char: ch.id, level: ch.level });
        }
      }
      if (events.length) GS.emit('levelup', events);
      GS.emit('change', GS.state); return events;
    },

    // ---- inventory / gold ------------------------------------------------
    itemDef(id) { return GS.data.items.items[id]; },
    count(id) { return GS.state.inventory[id] || 0; },
    addItem(id, n) { n = n == null ? 1 : n; GS.state.inventory[id] = GS.count(id) + n;
      if (GS.state.inventory[id] <= 0) delete GS.state.inventory[id];
      GS.emit('change', GS.state); },
    removeItem(id, n) { if (GS.count(id) < (n == null ? 1 : n)) return false;
      GS.addItem(id, -(n == null ? 1 : n)); return true; },
    addGold(n) { GS.state.gold = Math.max(0, GS.state.gold + n); GS.emit('change', GS.state); },
    spendGold(n) { if (GS.state.gold < n) return false; GS.addGold(-n); return true; },

    // ---- hp / item use (granted to battle-core + economy agents) ---------
    setHp(charId, hp) {                // clamped [0, maxHp]; battles/revives use this
      const ch = GS.state.party.find(p => p.id === charId); if (!ch) return false;
      ch.hp = Math.max(0, Math.min(GS.stats(ch).maxHp, hp));
      GS.emit('change', GS.state); return true;
    },
    useItem(charId, itemId) {          // apply a consumable's effect; consumes on success
      const ch = GS.state.party.find(p => p.id === charId), it = itemId && GS.itemDef(itemId);
      if (!ch || !it || !it.effect) return { ok: false, reason: 'invalid' };
      const max = GS.stats(ch).maxHp, heal = it.effect.heal || 0;
      if (heal && ch.hp >= max) return { ok: false, reason: 'full' };
      if (!GS.removeItem(itemId)) return { ok: false, reason: 'none' };
      const before = ch.hp; if (heal) ch.hp = Math.min(max, ch.hp + heal);
      GS.emit('change', GS.state); return { ok: true, healed: ch.hp - before };
    },

    // ---- equipment -------------------------------------------------------
    equip(charId, itemId) {            // itemId null = unequip slot back to bag
      const ch = GS.state.party.find(p => p.id === charId); if (!ch) return false;
      const it = itemId && GS.itemDef(itemId);
      if (itemId && (!it || !it.slot)) return false;
      if (itemId && !GS.removeItem(itemId)) return false;
      const slot = itemId ? it.slot : arguments[2];      // unequip needs explicit slot
      if (!slot) return false;
      if (ch.equip[slot]) GS.addItem(ch.equip[slot]);
      ch.equip[slot] = itemId || null;
      const s = GS.stats(ch); if (ch.hp > s.maxHp) ch.hp = s.maxHp;
      GS.emit('change', GS.state); return true;
    },

    // ---- battle boundary -------------------------------------------------
    applyBattleResult(res) {           // the ONLY way battles touch the world
      if (res.partyHp) for (const ch of GS.state.party) if (res.partyHp[ch.id] != null) ch.hp = res.partyHp[ch.id];
      if (res.outcome === 'victory') {
        if (res.gold) GS.addGold(res.gold);
        (res.drops || []).forEach(d => GS.addItem(d));
        if (res.xp) GS.grantXp(res.xp);
      }
      GS.emit('battle-applied', res); GS.emit('change', GS.state);
    },

    // ---- save / load -----------------------------------------------------
    serialize() { return JSON.stringify(GS.state); },
    // save() DOES NOT MUTATE THE STATE. economy_test asserts serialize -> save ->
    // load is byte-identical, and it is right to: a writer that edits what it is
    // writing makes "the save is the state" untrue and every round-trip test a lie.
    save() { try { localStorage.setItem(SAVE_KEY, GS.serialize()); GS.emit('saved'); return true; }
      catch (e) { console.warn('[GS] save failed', e); return false; } },
    // AUTOSAVE. Called on every scene change and after every once:true beat, so a
    // playthrough survives a reload without the player ever opening the menu. The
    // manual SAVE stays what it always was — "make a restore point". Only the
    // autosave stamps meta, which is diagnostics and never gameplay.
    autosave() { if (!GS.state) return false;
      GS.state.meta = Object.assign({}, GS.state.meta, { savedAt: new Date().toISOString() });
      return GS.save(); },
    // MIGRATION IS NOT OPTIONAL AND IT NEVER REFUSES (audit R7). The old load()
    // returned false on any v !== 1, and false means newGame() — i.e. an unreadable
    // version silently ERASED a real playthrough. A save is only ever refused when
    // it will not parse at all.
    migrate(st) {
      const from = st.v;
      if (!st.party || !Array.isArray(st.party)) st.party = [];
      if (!st.flags || typeof st.flags !== 'object') st.flags = {};
      if (!st.inventory || typeof st.inventory !== 'object') st.inventory = {};
      if (typeof st.gold !== 'number') st.gold = (GS.data.growth.startGold || 0);
      // v1 -> v2: the three fields v1 had no concept of. Defaults are the OPENING
      // of the game, which is the only honest answer for a save that never recorded
      // where it was.
      if (!st.at || typeof st.at !== 'object')
        st.at = { chapter: 1, scene: null, cam: null, pos: null, yaw: null };
      if (!st.beats || typeof st.beats !== 'object') st.beats = {};
      if (!st.meta || typeof st.meta !== 'object') st.meta = { savedAt: null, playSeconds: 0 };
      // A CHARACTER ADDED TO THE GAME AFTER THE SAVE WAS WRITTEN still has to exist:
      // Lake has no record in any v1 save, and a party the runtime cannot find is a
      // crash in the battle screen, not a missing feature. Unknown ids are KEPT —
      // this reconciles forward, it never prunes.
      const have = new Set(st.party.map(p => p.id));
      for (const [id, c] of Object.entries(GS.data.growth.characters))
        if (!have.has(id)) st.party.push(GS.freshMember(id, c));
      st.v = SAVE_V;
      if (from !== SAVE_V) console.log('[GS] save migrated v' + from + ' -> v' + SAVE_V);
      return st;
    },
    load() { try {
      let raw = localStorage.getItem(SAVE_KEY), legacy = null;
      if (!raw) for (const k of LEGACY_KEYS) { const r = localStorage.getItem(k); if (r) { raw = r; legacy = k; break; } }
      if (!raw) return false;
      const st = JSON.parse(raw);
      if (!st || typeof st !== 'object') return false;
      GS.state = GS.migrate(st);
      GS.syncJoins();
      if (legacy) { GS.save(); try { localStorage.removeItem(legacy); } catch (e) { } }
      GS.emit('change', GS.state); return true;
    } catch (e) { console.warn('[GS] load failed', e); return false; } },
    hasSave() { try { if (localStorage.getItem(SAVE_KEY)) return true;
      return LEGACY_KEYS.some(k => !!localStorage.getItem(k)); } catch (e) { return false; } },
    reset() { try { localStorage.removeItem(SAVE_KEY);
      for (const k of LEGACY_KEYS) localStorage.removeItem(k); } catch (e) { } GS.newGame(); },
  };

  GS.ready = GS.init();
})();
