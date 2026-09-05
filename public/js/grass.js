// grass.js -- the meadow's floor, populated.
//
// The floor was a vertex-coloured plane with five hundred hand-placed tufts
// on it, which at five metres is a lawn with a few weeds. What a meadow has is
// GRASS -- tens of thousands of clumps, all moving in the same wind. That is
// not a job for the builder (a tuft is eighty triangles of tube and lives in
// the GLB forever) but for the GPU: one clump of three blades is twelve
// triangles, placed by the same analytic terrain the player walks on, drawn
// as instances in chunks so the frustum culls what you cannot see. Fifteen
// thousand of them cost a handful of draw calls.
//
// Placement rules live here and only here: no grass on the road, none in the
// stream, none where the ground is too steep to hold soil -- the same three
// rules the builder's vertex colours already draw, read back off the terrain
// port so the two cannot disagree.

import * as THREE from 'three';
import { WIND } from './toon.js';

const GRASS_GLSL = /* glsl */`
  {
    #ifdef USE_INSTANCING
      vec2 ph = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
    #else
      vec2 ph = vec2(0.0);
    #endif
    float hh = clamp(position.y / 0.30, 0.0, 1.0);
    // one gust rolling across the field, phase from where the clump stands
    float g = sin(uWind * 1.15 + ph.x * 0.32 + ph.y * 0.19) * 0.5 + 0.5;
    float f = sin(uWind * 2.3 + ph.x * 1.7 - ph.y * 1.1) * 0.5 + 0.5;
    float b = (0.05 + 0.15 * g + 0.04 * f) * hh * hh * uGrassSway;
    transformed.x += b * (0.8 + 0.4 * sin(ph.y * 0.7));
    transformed.z += b * 0.4;
  }
`;

function clumpGeometry() {
  // three tapered blades, two segments each, leaning outward; colour runs
  // dark at the foot to light at the tip so a clump shades itself
  const pos = [], col = [], idx = [], nrm = [];
  // SHORT, NARROW, NEARLY UPRIGHT. The first clump was three 40 cm blades
  // leaning out at 10 cm with white-lit tips, and a field of them read as
  // agave. Four blades at 30 cm, 2 cm wide, leaning 5, with the tip held
  // under full white so the ramp's lit band does not bloom every one.
  const H = 0.30;
  let base = 0;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI + 0.2;
    const dx = Math.cos(a), dz = Math.sin(a);           // blade's width axis
    const lx = -dz * 0.05, lz = dx * 0.05;               // outward lean at tip
    const rows = [[0.0, 0.022, 0.50], [0.55, 0.016, 0.78], [1.0, 0.0, 0.92]];
    for (const [t, w, c] of rows) {
      const y = t * H, ox = lx * t * t, oz = lz * t * t;
      pos.push(ox - dx * w, y, oz - dz * w, ox + dx * w, y, oz + dz * w);
      col.push(c, c, c, c, c, c);
      // an upward-leaning normal so the toon ramp lights the field like ground
      // rather than like a wall of blades
      nrm.push(0, 1, 0, 0, 1, 0);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2,
             base + 2, base + 3, base + 4, base + 3, base + 5, base + 4);
    base += 6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export function makeGrass({ scene, terrain, material, spacing = 0.50, chunks = 8 }) {
  const { gateY, x0, x1, y1, streamY, streamHalf, streamX0, streamX1 } = terrain.cfg;
  const streamLine = (x) =>
    streamY + 3.4 * Math.sin(x * 0.055) + 1.5 * Math.sin(x * 0.128 + 1.1);
  const ramp = (v, a, b) => {
    if (v <= a) return 0;
    const k = Math.min(1, (v - a) / (b - a));
    return k * k * (3 - 2 * k);
  };
  // deterministic: the field is the same every load, and every capture
  let seed = 90210;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const geo = clumpGeometry();
  const mat = material({ vertexColors: true, key: 'grassfield', rimStrength: 0.06 });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.uWind = WIND;
    shader.uniforms.uGrassSway = { value: 1.0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;\nuniform float uGrassSway;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + GRASS_GLSL);
  };
  mat.side = THREE.DoubleSide;

  // gather placements per chunk first, then build one InstancedMesh each
  const yA = gateY + 2.0, yB = y1 - 1.0;
  const cw = (x1 - x0) / chunks, ch = (yB - yA) / chunks;
  const lists = [];
  for (let i = 0; i < chunks * chunks; i++) lists.push([]);
  // THE NEAR FIELD: a second grid offset by half a cell, kept in its own
  // meshes and drawn only for chunks within reach of the player. Density is
  // what the eye reads at five metres and what nobody can see at fifty, so
  // the far valley keeps the base spacing and the ground round the player
  // gets twice the blades for the cost of the chunks she is standing in.
  const nearLists = [];
  for (let i = 0; i < chunks * chunks; i++) nearLists.push([]);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  const E = new THREE.Euler(), V = new THREE.Vector3();
  let placed = 0;
  for (let pass = 0; pass < 2; pass++) {
  const target = pass === 0 ? lists : nearLists;
  const shift = pass === 0 ? 0 : spacing * 0.5;
  for (let y = yA + shift; y < yB; y += spacing) {
    for (let x = x0 + 1 + shift; x < x1 - 1; x += spacing) {
      const px = x + (rnd() - 0.5) * spacing, py = y + (rnd() - 0.5) * spacing;
      // the road and its verge: thin out rather than cut, so the edge is ragged
      const pw = 1 - ramp(Math.abs(px - terrain.pathAt(py)), 1.8, 4.8);
      if (pw > 0.05 && rnd() < pw * 1.6) continue;
      if (px > streamX0 - 3 && px < streamX1 + 3
          && Math.abs(py - streamLine(px)) < streamHalf + 1.4) continue;
      const h = terrain.heightXY(px, py);
      const e = 0.5;
      const gx = (terrain.heightXY(px + e, py) - terrain.heightXY(px - e, py)) / (2 * e);
      const gy = (terrain.heightXY(px, py + e) - terrain.heightXY(px, py - e)) / (2 * e);
      if (Math.hypot(gx, gy) > 0.85) continue;
      if (rnd() < 0.10) continue;
      // the jitter can put a clump a hair outside its row's chunk band
      const ci = Math.max(0, Math.min(chunks - 1, Math.floor((px - x0) / cw)));
      const cj = Math.max(0, Math.min(chunks - 1, Math.floor((py - yA) / ch)));
      const s = 0.8 + rnd() * 0.5;
      target[cj * chunks + ci].push([px, h - 0.02, -py, rnd() * Math.PI * 2, s, rnd()]);
      placed++;
    }
  }
  }
  const meshes = [];
  const nearMeshes = [];
  const c = new THREE.Color();
  const build = (list, near) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, y, z, yaw, s, tint], i) => {
      V.set(x, y, z); E.set(0, yaw, 0); Q.setFromEuler(E); S.set(s, s * (0.85 + tint * 0.4), s);
      M.compose(V, Q, S);
      im.setMatrixAt(i, M);
      // a little hue wander per clump: yellower here, bluer there
      c.setRGB(0.92 + tint * 0.16, 1.0, 0.86 + (1 - tint) * 0.18);
      im.setColorAt(i, c);
    });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.receiveShadow = true;
    im.castShadow = false;
    im.userData.isGrass = true;
    im.raycast = () => {};
    scene.add(im);
    (near ? nearMeshes : meshes).push(im);
  };
  for (const list of lists) build(list, false);
  for (const list of nearLists) build(list, true);
  let enabled = true;
  const NEAR = 30;
  return {
    meshes: meshes.concat(nearMeshes),
    count: placed,
    /** Show the near layer only for chunks within reach of `pos`. */
    update(pos) {
      for (const m of nearMeshes) {
        const sp = m.boundingSphere;
        if (!sp) continue;
        const d = Math.hypot(sp.center.x - pos.x, sp.center.z - pos.z) - sp.radius;
        m.visible = enabled && d < NEAR;
      }
    },
    set enabled(v) { enabled = v; for (const m of meshes) m.visible = v; if (!v) for (const m of nearMeshes) m.visible = false; },
    get enabled() { return enabled; },
  };
}
