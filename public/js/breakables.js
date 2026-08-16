// breakables.js -- the props that come apart when you hit them.
//
// WHY.  The town is deliberately empty of enemies now: it is the one place you
// can look at the architecture without being swarmed. That solved a problem and
// created another, which is that there is nothing to DO in it. A barrel that
// bursts into staves when you swing at it costs almost nothing and turns a
// square you walk through into a square you play in -- and it uses the swing
// that already exists rather than adding a move.
//
// WHY THEY ARE THEIR OWN OBJECTS.  Everything else in the town is joined into
// two meshes so the draw count stays sane. That is exactly why a barrel could
// not be broken: there is no way to hide one barrel inside a mesh that contains
// all of them. `arch_lib.Town.breakable` keeps these out of the join and names
// them `BREAK_*`, so the runtime can find them and remove them one at a time.
//
// THE DEBRIS IS THE PROP.  Not a particle puff: a handful of chunks that
// inherit the prop's own material, thrown along the swing and tumbling under
// gravity, so what comes apart is visibly the thing that was there. They fade
// and are gone in a bit over a second, and the geometry is built once and
// shared -- a hundred smashes allocate nothing.

import * as THREE from 'three';

const CHUNKS = 9;
const LIFE = 1.35;

/**
 * @param scene  where the debris lives
 * @param solids the collision list a smashed prop must be removed from, or the
 *               player keeps walking into a barrel that is not there any more
 */
export function makeBreakables(scene, solids) {
  const props = [];        // { mesh, x, z, r, h, pod, broken }
  let found = 0;           // embercaps smashed
  const shards = [];       // live debris
  const pool = [];         // dead debris, reused

  // ONE geometry for every chunk. A stave is a slab, and at the size and speed
  // debris is seen, a slab is a stave.
  const geo = new THREE.BoxGeometry(0.11, 0.30, 0.055);
  const _v = new THREE.Vector3();

  /**
   * Register everything named BREAK_* under `root`, and match each to the
   * collision box it sits in so smashing it also opens the way through.
   */
  function collect(root) {
    // WORLD MATRICES FIRST. `Box3.setFromObject` reads `matrixWorld`, and at
    // load time nothing has rendered yet, so every prop reported a bounding box
    // at the origin -- four barrels stacked on the fountain, and a swing next
    // to a real one hitting nothing.
    root.updateWorldMatrix(true, true);
    const before = props.length;
    // MATCH THE NODE, NOT THE MESH.
    //
    // glTF gives a single-material prop a Mesh and a MULTI-material prop a
    // Group of Meshes, and only the node carries the name -- a barrel arrived
    // as `Group:BREAK_barrel_0` containing `Mesh:barrel` and `Mesh:barrel_1`.
    // Requiring `isMesh` therefore collected every crate and not one barrel,
    // and the barrel is the good one.
    root.traverse((o) => {
      if (!/^BREAK_/.test(o.name || '')) return;
      const bb = new THREE.Box3().setFromObject(o);
      const mid = bb.getCenter(new THREE.Vector3());
      const size = bb.getSize(new THREE.Vector3());
      props.push({
        mesh: o,
        x: mid.x, z: mid.z, y: bb.min.y,
        r: Math.max(size.x, size.z) * 0.5 + 0.35,   // a generous swing radius
        h: size.y,
        // A TREASURE OR A BARREL, told apart by name. The builder names the
        // pods `BREAK_pod_*`, and they burst brighter, further and upward --
        // a find has to look different from a crate or finding one means
        // nothing.
        pod: /pod/i.test(o.name),
        broken: false,
      });
    });
    return props.length - before;
  }

  /** Take the collision box out from under a smashed prop. */
  function freeSolid(p) {
    for (let i = solids.length - 1; i >= 0; i--) {
      const s = solids[i];
      if (Math.abs(s.x - p.x) < 0.6 && Math.abs(s.z - p.z) < 0.6) solids.splice(i, 1);
    }
  }

  function shard(at, dir, mat, pod = false) {
    const m = pool.pop() || new THREE.Mesh(geo, mat.clone());
    m.material = mat;
    m.visible = true;
    m.position.copy(at);
    m.rotation.set(Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283);
    scene.add(m);
    shards.push({
      m,
      // thrown ALONG the swing and up, so the burst reads as directional --
      // debris that goes evenly in all directions reads as an explosion, and
      // this is a sword. A pod is the exception: it goes UP and outward in all
      // directions, because that is what makes a find read as a find rather
      // than as another thing you knocked over.
      vx: (pod ? (Math.random() - 0.5) * 5.2 : dir.x * (2.2 + Math.random() * 2.6))
          + (Math.random() - 0.5) * 2.4,
      vy: pod ? 5.0 + Math.random() * 3.6 : 2.4 + Math.random() * 3.4,
      vz: (pod ? (Math.random() - 0.5) * 5.2 : dir.z * (2.2 + Math.random() * 2.6))
          + (Math.random() - 0.5) * 2.4,
      sx: (Math.random() - 0.5) * 14,
      sy: (Math.random() - 0.5) * 14,
      t: 0,
      floor: at.y - 0.25,
    });
  }

  /**
   * Try to smash whatever is within `reach` of (x, z) along `dir`.
   * Returns the number of props broken, so the caller can decide whether the
   * swing "connected" for the purposes of hit-stop and shake.
   */
  function hit(x, z, dir, reach, arc = 1.6) {
    let n = 0;
    for (const p of props) {
      if (p.broken) continue;
      const dx = p.x - x, dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d > reach + p.r) continue;
      // FACING, not a circle round the player. `dir` was passed in from the
      // first version and used ONLY to throw the debris: an audit measured
      // barrels breaking at 0.9-1.9 m while facing 180 degrees AWAY from them,
      // identically to facing them. A sword that breaks things behind you is
      // not a sword. Same cone the enemy hitbox uses, widened a little because
      // a prop is a static target and being strict about it reads as the swing
      // missing for no reason.
      if (d > 1e-4) {
        const cos = (dx / d) * dir.x + (dz / d) * dir.z;
        if (cos < Math.cos(arc / 2)) continue;
      }
      p.broken = true;
      p.mesh.visible = false;
      freeSolid(p);
      // the prop's own material, so a crate throws timber and a barrel throws
      // timber with a brass band in it
      const mats = [];
      p.mesh.traverse((o) => {
        if (o.isMesh && o.material && !o.material.isShaderMaterial) mats.push(o.material);
      });
      const chunks = p.pod ? CHUNKS + 7 : CHUNKS;
      for (let k = 0; k < chunks; k++) {
        _v.set(p.x + (Math.random() - 0.5) * 0.3,
               p.y + 0.15 + Math.random() * Math.max(0.2, p.h * 0.8),
               p.z + (Math.random() - 0.5) * 0.3);
        shard(_v, dir, mats[k % Math.max(1, mats.length)] || p.mesh.material,
              p.pod);
      }
      if (p.pod) found++;
      n++;
    }
    return n;
  }

  function update(dt) {
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.t += dt;
      s.vy -= 26 * dt;
      s.m.position.x += s.vx * dt;
      s.m.position.y += s.vy * dt;
      s.m.position.z += s.vz * dt;
      if (s.m.position.y < s.floor) {
        s.m.position.y = s.floor;
        s.vy *= -0.32;                       // one lazy bounce, then it lies there
        s.vx *= 0.55; s.vz *= 0.55;
        s.sx *= 0.4; s.sy *= 0.4;
      }
      s.m.rotation.x += s.sx * dt;
      s.m.rotation.y += s.sy * dt;
      if (s.t > LIFE - 0.4) {
        const k = Math.max(0, 1 - (s.t - (LIFE - 0.4)) / 0.4);
        s.m.scale.setScalar(k);
      }
      if (s.t >= LIFE) {
        scene.remove(s.m);
        s.m.scale.setScalar(1);
        s.m.visible = false;
        pool.push(s.m);
        shards.splice(i, 1);
      }
    }
  }

  return { collect, hit, update, get count() { return props.length; },
           get found() { return found; },
           get pods() { return props.filter((p) => p.pod).length; },
           /** For probes: where each prop thinks it is. */
           debug: () => props.map((p) => `${p.mesh.name}(${p.x.toFixed(1)},${p.z.toFixed(1)} r${p.r.toFixed(1)})`).join(' '),
           get broken() { return props.filter((p) => p.broken).length; },
           /** Put every prop back -- for the smoke suite, and for a respawn. */
           reset() {
             for (const p of props) { p.broken = false; p.mesh.visible = true; }
             found = 0;
           } };
}
