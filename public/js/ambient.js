// ambient.js -- the air is not empty.
//
// A still frame of this world looked finished and a moving one looked like a
// diorama, because nothing between the camera and the buildings ever moved.
// Two cheap things fix most of that: DUST in the sunlight -- a couple of
// hundred motes that drift and catch the key, which is what makes a shaft of
// light read as light -- and PETALS, small tumbling quads that ride the wind
// the grass and the bunting already share. Both live in a box that follows the
// player and wrap at its edges, so wherever you stand the air near you is
// occupied and nothing is spent on air forty metres away.
//
// Nothing here is outlined, shadowed or picked: it is atmosphere, drawn last.

import * as THREE from 'three';
import { WIND } from './toon.js';

const BOX = { x: 16, y: 7, z: 16 };     // half-extents of the follow box

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeAmbient({ scene, groundAt = null }) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const centre = new THREE.Vector3();

  // ---- motes -------------------------------------------------------------
  const N_MOTES = 220;
  const mpos = new Float32Array(N_MOTES * 3);
  const mvel = new Float32Array(N_MOTES * 3);
  const mph = new Float32Array(N_MOTES);
  for (let i = 0; i < N_MOTES; i++) {
    mpos[i * 3] = rnd(-BOX.x, BOX.x);
    mpos[i * 3 + 1] = rnd(0.2, BOX.y);
    mpos[i * 3 + 2] = rnd(-BOX.z, BOX.z);
    mvel[i * 3] = rnd(-0.08, 0.08);
    mvel[i * 3 + 1] = rnd(-0.05, 0.03);
    mvel[i * 3 + 2] = rnd(-0.08, 0.08);
    mph[i] = rnd(0, Math.PI * 2);
  }
  const mgeo = new THREE.BufferGeometry();
  mgeo.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
  const motes = new THREE.Points(mgeo, new THREE.PointsMaterial({
    map: softDot(), size: 0.075, sizeAttenuation: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
    color: new THREE.Color(0xffe6b0).multiplyScalar(0.55), fog: true,
  }));
  motes.frustumCulled = false;
  motes.renderOrder = 5;
  scene.add(motes);

  // ---- petals ------------------------------------------------------------
  const N_PET = 70;
  const pgeo = new THREE.PlaneGeometry(0.11, 0.075);
  const pmat = new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.DoubleSide, vertexColors: true, fog: true,
  });
  // per-instance colour: three blossom tones, a touch of leaf
  const palette = [0xf7c7d0, 0xfde3d2, 0xfff4e0, 0xc8dca0];
  const petals = new THREE.InstancedMesh(pgeo, pmat, N_PET);
  petals.frustumCulled = false;
  const pcol = new Float32Array(N_PET * 3);
  const P = [];
  const c = new THREE.Color();
  for (let i = 0; i < N_PET; i++) {
    c.set(palette[i % palette.length]);
    pcol[i * 3] = c.r; pcol[i * 3 + 1] = c.g; pcol[i * 3 + 2] = c.b;
    P.push({
      x: rnd(-BOX.x, BOX.x), y: rnd(0.3, BOX.y), z: rnd(-BOX.z, BOX.z),
      rx: rnd(0, 6.28), ry: rnd(0, 6.28), rz: rnd(0, 6.28),
      wx: rnd(-2.2, 2.2), wy: rnd(-2.2, 2.2), wz: rnd(-2.2, 2.2),   // tumble
      fall: rnd(0.16, 0.30), ph: rnd(0, 6.28), s: rnd(0.7, 1.3),
    });
  }
  pgeo.setAttribute('color', new THREE.InstancedBufferAttribute(pcol, 3));
  // InstancedMesh reads per-instance colour from instanceColor, not geometry
  petals.instanceColor = new THREE.InstancedBufferAttribute(pcol, 3);
  scene.add(petals);

  const M = new THREE.Matrix4();
  const E = new THREE.Euler();
  const Q = new THREE.Quaternion();
  const S = new THREE.Vector3();
  const V = new THREE.Vector3();
  let t = 0;
  let enabled = true;

  function wrap(v, lo, hi) {
    const span = hi - lo;
    while (v < lo) v += span;
    while (v > hi) v -= span;
    return v;
  }

  function update(dt, pos) {
    if (!enabled) return;
    t += dt;
    centre.copy(pos);
    // the wind the rest of the world uses, as a horizontal push
    const w = Math.sin(WIND.value * 0.9) * 0.5 + 0.5;         // 0..1 gust
    const wx = 0.35 + 0.9 * w, wz = 0.10 + 0.25 * w;
    // motes: drift, wobble, wrap
    for (let i = 0; i < N_MOTES; i++) {
      const k = i * 3;
      mpos[k] += (mvel[k] + wx * 0.08) * dt + Math.sin(t * 0.7 + mph[i]) * 0.0015;
      mpos[k + 1] += mvel[k + 1] * dt + Math.cos(t * 0.5 + mph[i]) * 0.0012;
      mpos[k + 2] += (mvel[k + 2] + wz * 0.08) * dt;
      mpos[k] = wrap(mpos[k], centre.x - BOX.x, centre.x + BOX.x);
      mpos[k + 1] = wrap(mpos[k + 1], centre.y + 0.1, centre.y + BOX.y);
      mpos[k + 2] = wrap(mpos[k + 2], centre.z - BOX.z, centre.z + BOX.z);
    }
    mgeo.attributes.position.needsUpdate = true;
    // petals: fall, sway, tumble, wrap -- and respawn at the top when they
    // reach the ground, so the fall is a fall and not a loop through the floor
    for (let i = 0; i < N_PET; i++) {
      const p = P[i];
      p.x += (wx * 0.9 + Math.sin(t * 1.3 + p.ph) * 0.35) * dt;
      p.z += (wz * 0.9 + Math.cos(t * 1.1 + p.ph) * 0.25) * dt;
      p.y -= p.fall * dt * (0.8 + 0.4 * Math.sin(t * 2.0 + p.ph));
      p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
      p.x = wrap(p.x, centre.x - BOX.x, centre.x + BOX.x);
      p.z = wrap(p.z, centre.z - BOX.z, centre.z + BOX.z);
      const g = groundAt ? groundAt(p.x, p.z, p.y + 2) : null;
      const floor = g === null ? centre.y - 0.5 : g;
      if (p.y < floor + 0.02 || p.y > centre.y + BOX.y + 1) {
        p.y = centre.y + BOX.y * rnd(0.6, 1.0);
        p.x = centre.x + rnd(-BOX.x, BOX.x);
        p.z = centre.z + rnd(-BOX.z, BOX.z);
      }
      E.set(p.rx, p.ry, p.rz);
      Q.setFromEuler(E);
      S.set(p.s, p.s, p.s);
      V.set(p.x, p.y, p.z);
      M.compose(V, Q, S);
      petals.setMatrixAt(i, M);
    }
    petals.instanceMatrix.needsUpdate = true;
  }

  return {
    update,
    set enabled(v) { enabled = v; motes.visible = v; petals.visible = v; },
    get enabled() { return enabled; },
    get counts() { return { motes: N_MOTES, petals: N_PET }; },
  };
}
