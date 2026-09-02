// npc.js -- the people in the town, and the reach that starts a conversation.
//
// WHY THIS IS OURS AND NOT PORTED.  The dialogue WINDOW is vendored wholesale
// from Emberbrook (public/js/vendor/), because a text box is a text box and
// that one is better than anything worth rewriting here. The NPC is the other
// half and it cannot be vendored: theirs reads a pre-rendered scene's walk
// network, its `SIM.blocked`, its `groundAt`, and its fixed-camera prompt
// placement. Every one of those is a different thing in this project. What
// survives the port is the SHAPE -- data-driven roster, proximity arms a
// prompt, a key press opens the window, the world freezes while you talk --
// and that shape is worth keeping exactly.
//
// BODIES ARE CLONES OF THE CAST. `buildCharacter` has already done the
// expensive and fiddly work on vesper/lake/maren: toon materials keyed to the
// look table, an inverted-hull outline per mesh, foot-IK leg lookups. Cloning
// the finished group with SkeletonUtils gets all of it for free, and a clone
// shares its geometry and (unless tinted) its materials, so a townsperson
// costs a mixer and a draw call rather than a second 3.5 MB parse.
//
// TINTS MAKE A CAST OUT OF THREE RIGS. Emberbrook dresses thirty-nine people
// in six bodies by tinting them, and it works because a toon ramp reads
// silhouette and value long before it reads a face. A tint clones the
// materials -- which is the one thing that costs -- so it is opt-in per NPC.

import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// How close you must be for the prompt to arm, unless a roster row says
// otherwise. 2.2 m rather than Emberbrook's 1.9: this camera is behind the
// player rather than fixed, so you approach people at a shallower angle and a
// tight radius reads as the prompt refusing to appear.
const REACH = 2.2;
// ...and how much height difference still counts as "next to". A person on the
// gallery deck is not someone you can talk to from the square below them.
const V_TOL = 1.8;
// The prompt hides again a little further out than it appears, so standing on
// the boundary does not flicker it on and off every frame.
const HYST = 0.45;

export function makeNpcs({ scene, chars, groundAt, hud }) {
  const npcs = [];
  let near = null;          // the one the prompt is for
  // The person the OPEN window belongs to. Set when the conversation
  // starts and never re-read from proximity, so walking away mid-line does
  // not silently hand the gesture to somebody else.
  let speaker = null;
  let armed = false;

  // ---- the prompt banner -------------------------------------------------
  // Deliberately NOT one of Emberbrook's EBUI prompts: those are styled for a
  // 16:9 letterboxed stage with its own HUD idiom, and this game already has a
  // prompt language (the `.panel` blocks in index.html). A talk prompt that
  // looks like a stranger to the HUD it sits next to is worse than a plain one.
  const prompt = document.createElement('div');
  prompt.className = 'panel';
  prompt.id = 'talkprompt';
  prompt.style.cssText =
    'left:50%;bottom:96px;transform:translateX(-50%);display:none;'
    + 'pointer-events:none;text-align:center;letter-spacing:.06em;';
  document.body.appendChild(prompt);

  function setPrompt(name) {
    if (!name) { prompt.style.display = 'none'; return; }
    prompt.innerHTML = '<b style="color:#ffe9a8">E</b>&nbsp; talk to ' + name;
    prompt.style.display = '';
  }

  // ---- bodies ------------------------------------------------------------
  function body(def) {
    const src = chars[def.rig];
    if (!src) { console.warn('[npc] no rig', def.rig, 'for', def.id); return null; }
    const group = new THREE.Group();
    // CLONE THE BUILT GROUP, not the raw glTF. It carries the toon materials
    // and the outline hulls that `buildCharacter` put there; a raw clone would
    // arrive in whatever the exporter wrote and read as a different game.
    const root = skeletonClone(src.group.children[0]);
    root.visible = true;
    root.traverse((o) => { o.frustumCulled = false; });
    if (def.tint) {
      // MATERIALS ARE SHARED BY DEFAULT, so tinting one townsperson would tint
      // the player too. Clone only when a tint is asked for.
      const t = new THREE.Color(def.tint);
      root.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        // the outline hull is solid black by design -- tinting it turns the
        // silhouette into a coloured halo
        if (o.userData.isOutline) return;
        o.material = o.material.clone();
        if (o.material.color) o.material.color.multiply(t);
      });
    }
    group.add(root);
    if (def.scale && def.scale !== 1) group.scale.setScalar(def.scale);
    scene.add(group);

    const mixer = new THREE.AnimationMixer(root);
    const clips = {};
    for (const c of src.rawClips || []) clips[c.name] = mixer.clipAction(c);
    // A ROOM FULL OF PEOPLE BREATHING IN UNISON reads as a rank of clockwork.
    // One shared idle clip, started at a different phase per person, is the
    // cheapest fix there is and the only one anybody would notice the lack of.
    const idle = clips.idle;
    if (idle) {
      idle.play();
      idle.time = (def.phase !== undefined ? def.phase : Math.random()) *
                  (idle.getClip().duration || 1);
    }
    // WHICH GESTURE THIS PERSON USES, fixed per person rather than picked per
    // conversation. A townsperson who talks with their hands should do it
    // every time you speak to them -- that is what makes it read as character
    // instead of as randomness -- and it costs one hash of the id.
    let h = 0;
    for (let i = 0; i < def.id.length; i++) h = (h * 31 + def.id.charCodeAt(i)) | 0;
    const gesture = def.gesture ||
      ((h & 3) === 0 ? 'talk_emphatic' : 'talk');
    // the walk is the run clip at half speed; nobody in this square is in a hurry
    if (clips.run) clips.run.timeScale = 0.55;
    return { group, mixer, clips, current: idle || null, gesture };
  }

  // Same crossfade main.js uses on the player. Kept here rather than shared
  // because npc.js owns its own mixers and main.js's `play` closes over `cur`.
  function setClip(b, name, fade = 0.28) {
    const next = b.clips[name];
    if (!next || next === b.current) return;
    next.reset().setEffectiveWeight(1).play();
    if (b.current) next.crossFadeFrom(b.current, fade, false);
    b.current = next;
  }

  function place(n) {
    const g = groundAt(n.x, n.z, (n.y === undefined ? 4 : n.y) + 2);
    n.gy = g === null ? (n.y || 0) : g;
    n.b.group.position.set(n.x, n.gy, n.z);
    n.b.group.rotation.y = n.facing;
  }

  /** Roster rows in, people in the world out. */
  function load(roster) {
    for (const def of roster) {
      const b = body(def);
      if (!b) continue;
      const n = {
        id: def.id, name: def.name, node: def.dialogue,
        x: def.x, z: def.z, y: def.y,
        facing: (def.facing || 0) * Math.PI / 180,
        restFacing: (def.facing || 0) * Math.PI / 180,
        path: def.path || null, leg: 0, wait: 1.0 + Math.random() * 3.0,
        speed: def.speed || 1.1,
        reach: def.reach || REACH,
        b, yaw: (def.facing || 0) * Math.PI / 180,
      };
      place(n);
      npcs.push(n);
    }
    return npcs.length;
  }

  // ---- per frame ---------------------------------------------------------
  const _p = new THREE.Vector3();

  function update(dt, pos) {
    let best = null, bestD = 1e9;
    // WHO IS SPEAKING, not who is nearest. `near` keeps moving while the
    // window is open -- the player can still be nudged around by knockback or
    // by the camera settling -- so reading it here would hand the gesture to
    // whoever drifted closest mid-sentence.
    const talk0 = talking();
    const speaking = talk0 ? speaker : null;
    for (const n of npcs) {
      n.b.mixer.update(dt);
      const dx = n.x - pos.x, dz = n.z - pos.z;
      const d = Math.hypot(dx, dz);
      const close = d < n.reach + 1.6 && Math.abs(n.gy - pos.y) < V_TOL;
      // ERRANDS. A person with a `path` walks it -- waypoint to waypoint, a
      // pause at each -- and stops for you the moment you are in reach, which
      // is the whole difference between a square with people in it and a
      // square with statues. The speaking person never walks off mid-line.
      let walking = false;
      if (n.path && !close && n !== speaking && !talk0) {
        if (n.wait > 0) {
          n.wait -= dt;
        } else {
          const [tx, tz] = n.path[n.leg];
          const ex = tx - n.x, ez = tz - n.z;
          const dist = Math.hypot(ex, ez);
          if (dist < 0.15) {
            n.leg = (n.leg + 1) % n.path.length;
            n.wait = 2.5 + Math.random() * 4.0;
            n.facing = n.restFacing;
          } else {
            const step = Math.min(dist, n.speed * dt);
            n.x += ex / dist * step;
            n.z += ez / dist * step;
            n.facing = Math.atan2(ex, ez);
            walking = true;
            const g = groundAt(n.x, n.z, n.gy + 2);
            if (g !== null) n.gy = g;
            n.b.group.position.set(n.x, n.gy, n.z);
          }
        }
      }
      setClip(n.b, n === speaking ? n.b.gesture : (walking ? 'run' : 'idle'));
      // TURN TO FACE YOU. It is the whole of the body language budget and it
      // is what makes a standing figure read as a person rather than a statue
      // -- and it has to happen BEFORE you press anything, or the first frame
      // of every conversation is somebody's back.
      const want = close
        ? Math.atan2(pos.x - n.x, pos.z - n.z)
        : n.facing;
      const turn = ((want - n.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      n.yaw += turn * Math.min(1, dt * 5.0);
      n.b.group.rotation.y = n.yaw;

      if (Math.abs(n.gy - pos.y) > V_TOL) continue;
      if (d < bestD) { bestD = d; best = n; }
    }
    // hysteresis: arm at `reach`, disarm only past `reach + HYST`
    if (best && bestD <= best.reach) armed = true;
    else if (!best || bestD > (near ? near.reach : REACH) + HYST) armed = false;
    near = armed ? best : null;
    const talk = talking();
    setPrompt(talk ? null : (near && near.name));
    // one class, and index.html decides what it means -- the styling of this
    // game's own HUD is not npc.js's business
    document.body.classList.toggle('talking', talk);
  }

  // `isOpen` IS A GETTER, not a method -- `get isOpen() { return !!S; }`
  // upstream. Calling it threw, and it threw from inside the frame loop, which
  // is the loudest possible place. Read it as the property it is.
  function talking() {
    return !!(window.Dialogue && window.Dialogue.isOpen);
  }

  /** Returns true if it consumed the key -- the caller must then NOT attack. */
  function tryTalk() {
    if (!near || talking()) return false;
    if (!window.Dialogue || !window.Dialogue.play) return false;
    setPrompt(null);
    speaker = near;
    window.Dialogue.play(near.node);
    return true;
  }

  return {
    load, update, tryTalk, talking,
    get count() { return npcs.length; },
    get near() { return near ? near.id : null; },
    /** For probes: where everybody thinks they are. */
    debug: () => npcs.map((n) =>
      `${n.id}@(${n.x.toFixed(1)},${n.z.toFixed(1)},y${n.gy.toFixed(2)})`).join(' '),
    at: (id) => npcs.find((n) => n.id === id) || null,
    /** Every body, so a draw-budget probe can tell a person from a wall. */
    get bodies() { return npcs.map((n) => n.b.group); },
  };
}
