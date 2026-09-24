// grass.js -- a field you can walk through.
//
// THE MEADOW WAS A FLOOR. A heightfield with a green vertex colour and five
// hundred modelled tufts scattered across nine thousand square metres of it --
// one per eighteen square metres, which from a third-person camera is bare
// ground with the occasional weed. Grass is most of what a JRPG field IS: it is
// the thing that moves when the wind does, the thing you wade through, the
// thing that makes a slope read as a slope and a path read as worn.
//
// HOW IT IS DRAWN. Not placed -- GENERATED ON THE GPU around the camera. Two
// instanced meshes (a dense near field and a sparser far one) are laid out on
// a fixed world-space lattice that is re-centred on the camera every frame.
// Because the lattice is snapped to its own spacing, a given tuft always lands
// on the same world point with the same random size and turn, so nothing swims
// as you move; tufts at the edge simply shrink to nothing.
//
// WHERE IT GROWS is baked once into a small texture from the same analytic
// terrain the physics uses: height (so every tuft stands exactly on the
// ground), density (zero on the road, in the stream, on anything too steep to
// hold soil and under every wall, rock and trunk in the collision set), and a
// height multiplier (it grows short along the verges, where it is walked on).
//
// WHAT IT DOES. Bends in a wind that travels across the field in visible gusts
// -- the single most alive thing a meadow can do -- and parts around whoever is
// walking through it.

import * as THREE from 'three';
import { NOISE_GLSL, PAINT } from './paint.js';

const RES = 0.5;                    // metres per texel of the field map

function ramp(v, a, b) {
  if (v <= a) return 0;
  const k = Math.min(1, (v - a) / (b - a));
  return k * k * (3 - 2 * k);
}

/** The field map: R height, G density, B height multiplier. Runtime x,z. */
function bakeField(terrain, solids) {
  const c = terrain.cfg;
  // runtime z = -blender y
  const x0 = c.gridX0, x1 = -c.gridX0;
  const z0 = -112, z1 = -c.gateY;
  const W = Math.ceil((x1 - x0) / RES) + 1;
  const H = Math.ceil((z1 - z0) / RES) + 1;
  const data = new Uint16Array(W * H * 4);
  const f = THREE.DataUtils.toHalfFloat;

  // solids first, as a coverage mask, so the per-texel loop is a lookup
  const blocked = new Uint8Array(W * H);
  for (const s of solids) {
    if ((s.top ?? 3) < 0.25) continue;         // curbs and sills are walkable, grass can touch them
    const r = Math.hypot(s.hx, s.hz) + 0.3;
    const i0 = Math.max(0, Math.floor((s.x - r - x0) / RES)), i1 = Math.min(W - 1, Math.ceil((s.x + r - x0) / RES));
    const j0 = Math.max(0, Math.floor((s.z - r - z0) / RES)), j1 = Math.min(H - 1, Math.ceil((s.z + r - z0) / RES));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = x0 + i * RES - s.x, dz = z0 + j * RES - s.z;
      // into the box's frame -- the same rotation main.js's collision uses
      const lx = dx * s.c - dz * s.s, lz = dx * s.s + dz * s.c;
      if (Math.abs(lx) < s.hx + 0.18 && Math.abs(lz) < s.hz + 0.18) blocked[j * W + i] = 1;
    }
  }

  const e = 0.6;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = x0 + i * RES, z = z0 + j * RES;
      const k = (j * W + i) * 4;
      const by = -z;
      let dens = 0, hmul = 1, h = 0;
      if (terrain.owns(x, z)) {
        h = terrain.heightAt(x, z);
        const road = Math.abs(x - terrain.pathAt(by));
        dens = ramp(road, 2.7, 4.9);
        hmul = 0.45 + 0.55 * ramp(road, 3.0, 7.5);
        // steep ground is rock (meadow_build colours it so at the same slopes)
        const gx = (terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z)) / (2 * e);
        const gz = (terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e)) / (2 * e);
        dens *= 1 - ramp(Math.hypot(gx, gz), 0.78, 1.2);
        // the stream: nothing in the channel; short grass on its banks
        if (c.streamX0 !== undefined) {
          const sl = c.streamY + 3.4 * Math.sin(x * 0.055) + 1.5 * Math.sin(x * 0.128 + 1.1);
          const d = Math.abs(by - sl);
          if (x > c.streamX0 - 4 && x < c.streamX1 + 4) {
            dens *= ramp(d, c.streamHalf + 0.3, c.streamHalf + 1.7);
            hmul *= 0.6 + 0.4 * ramp(d, c.streamHalf, c.streamHalf + 3);
          }
        }
        if (blocked[j * W + i]) dens = 0;
        // just inside the gate the town's paving takes over
        dens *= ramp(by, c.gateY + 0.8, c.gateY + 3.0);
      }
      data[k] = f(h);
      data[k + 1] = f(dens);
      data[k + 2] = f(hmul);
      data[k + 3] = f(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, rect: new THREE.Vector4(x0, z0, x0 + (W - 1) * RES, z0 + (H - 1) * RES) };
}

/**
 * One tuft: `blades` blades round a root, each a tapered strip of `segs`
 * segments and a tip. Attributes: position (blade-local, height normalised to
 * 1), aT (0 root .. 1 tip), aSide (-1..1 across the blade).
 */
function tuftGeometry(blades, segs, width, spread, seed) {
  const pos = [], at = [], idx = [];
  let rnd = seed;
  const R = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < blades; b++) {
    const ang = R() * Math.PI * 2;
    const ox = (R() - 0.5) * spread, oz = (R() - 0.5) * spread;
    const lean = 0.10 + R() * 0.22;           // blades fan out from the root
    const lx = Math.cos(ang + 1.3) * lean, lz = Math.sin(ang + 1.3) * lean;
    const hgt = 0.65 + R() * 0.45;
    const cx = Math.cos(ang), cz = Math.sin(ang);
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / (segs + 1);
      const w = width * (1 - t * 0.85) * 0.5;
      const y = t * hgt;
      const bx = ox + lx * t * t, bz = oz + lz * t * t;
      pos.push(bx - cx * w, y, bz - cz * w, bx + cx * w, y, bz + cz * w);
      at.push(t, t);
    }
    pos.push(ox + lx, hgt, oz + lz);           // tip
    at.push(1);
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const last = base + segs * 2;
    idx.push(last, last + 1, last + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 1));
  // every blade is lit like the ground it grows from, with a lean toward its
  // own facing -- which is what makes a field read as one surface from a
  // distance and as blades up close
  const n = [];
  for (let i = 0; i < pos.length / 3; i++) n.push(0, 1, 0);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  g.setIndex(idx);
  return g;
}

const SHARED = {
  uField: { value: null },
  uRect: { value: new THREE.Vector4() },
  uCam: { value: new THREE.Vector3() },
  uPlayer: { value: new THREE.Vector3(0, -99, 0) },
  // EVERYONE PARTS THE GRASS, not just the player: up to eight bodies a frame
  // (xyz + radius). A nettle is 40 cm tall and the meadow grows to 55, so
  // without this the monsters fought in it were invisible.
  uPush: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -99, 0, 0)) },
};

function grassMaterial(layer) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.82, metalness: 0, side: THREE.DoubleSide,
    envMapIntensity: 0.8,
  });
  const u = {
    uOrigin: { value: new THREE.Vector2() },
    uSpacing: { value: layer.spacing },
    uRIn: { value: layer.rIn }, uROut: { value: layer.rOut },
    uHeight: { value: layer.height },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, SHARED);
    sh.uniforms.uTime = PAINT.uTime;
    sh.uniforms.uSunDir = PAINT.uSunDir;
    sh.uniforms.uSunCol = PAINT.uSunCol;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aT;
        attribute vec2 aCell;
        uniform vec2 uOrigin;
        uniform float uSpacing, uRIn, uROut, uHeight, uTime;
        uniform sampler2D uField;
        uniform vec4 uRect;
        uniform vec3 uCam, uPlayer;
        uniform vec4 uPush[8];
        varying vec3 vGW;
        varying float vGT;
        varying float vGShade;
        varying float vGFlower;
        varying float vGFlowerHue;
        float gh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        vec2 cellW = uOrigin + aCell * uSpacing;
        float h1 = gh(cellW), h2 = gh(cellW + 17.13), h3 = gh(cellW + 5.71), h4 = gh(cellW + 31.7);
        vec2 root = cellW + (vec2(h1, h2) - 0.5) * uSpacing * 0.95;
        vec2 fuv = (root - uRect.xy) / (uRect.zw - uRect.xy);
        vec4 fld = texture2D(uField, fuv);
        float inside = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
        float dens = fld.g * inside;
        float keep = step(h3, dens);
        float dc = length(root - uCam.xz);
        // grow in at the outer edge, and (for the far layer) hand over to the
        // near one across a band rather than at a line
        float edge = (1.0 - smoothstep(uROut * 0.72, uROut, dc)) * smoothstep(uRIn * 0.8, uRIn, dc);
        float s = keep * edge * mix(0.72, 1.28, h4) * fld.b;
        float ang = gh(cellW + 3.3) * 6.2831853;
        float ca = cos(ang), sa = sin(ang);
        vec3 p = position;
        p.xz = mat2(ca, -sa, sa, ca) * p.xz;
        float hy = p.y * uHeight * s;
        p.xz *= mix(1.0, s, 0.5);

        // WIND. A gust is a band of stronger bend that travels across the
        // field; under it, each blade flutters on its own phase.
        vec2 wdir = normalize(vec2(0.8, 0.45));
        float along = dot(root, wdir);
        float gust = sin(along * 0.16 - uTime * 1.35) * 0.5 + 0.5;
        gust = gust * gust * (0.55 + 0.45 * sin(along * 0.05 + root.y * 0.07 - uTime * 0.4));
        float flutter = sin(uTime * 3.1 + h1 * 6.28 + along * 0.9) * 0.25;
        float bend = (0.22 + gust * 0.95 + flutter * 0.4) * aT * aT;
        vec2 off = wdir * bend * uHeight * s * 0.55;

        // PARTING. Blades within a body's reach lean out and flatten.
        float flatK = 0.0;
        for (int k = 0; k < 8; k++) {
          vec4 P = uPush[k];
          if (P.w <= 0.0) continue;
          vec2 away = root - P.xz;
          float pd = length(away);
          float push = (1.0 - smoothstep(P.w * 0.25, P.w, pd)) * step(abs(P.y - fld.r), 1.5);
          off += normalize(away + 1e-4) * push * 0.42 * aT * aT * uHeight * s;
          flatK = max(flatK, push);
        }
        hy *= 1.0 - flatK * 0.55;

        vec3 transformed = vec3(root.x + p.x + off.x, fld.r + hy, root.y + p.z + off.y);
        vGW = transformed;
        vGT = aT;
        vGShade = mix(0.85, 1.15, h2);
        // WILDFLOWERS: one tuft in forty is in flower -- clustered, because
        // flowers grow in drifts -- and stands a little taller than the grass
        float drift = smoothstep(0.55, 0.8, fract(sin(dot(floor(root / 6.0), vec2(7.1, 3.3))) * 9173.1));
        vGFlower = step(gh(cellW + 9.9), 0.025 + drift * 0.08) * step(0.5, dens);
        vGFlowerHue = gh(floor(root / 6.0) + 1.7);
        transformed.y += vGFlower * aT * 0.10 * s;
      `)
      .replace('#include <beginnormal_vertex>', /* glsl */`
        vec3 objectNormal = vec3(0.0, 1.0, 0.0);
      `);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vGW;
        varying float vGT;
        varying float vGShade;
        varying float vGFlower;
        varying float vGFlowerHue;
        uniform vec3 uSunDir, uSunCol;
        ${NOISE_GLSL}
      `)
      .replace('#include <map_fragment>', /* glsl */`
        // THE SAME PATCHES AS THE GROUND (paint.js FIELD), so tufts and the
        // floor under them agree about where the grass is lush and where it
        // is sun-bleached
        float big = pFbm(vGW * 0.045 + 3.0);
        float mid = pFbm(vGW * 0.19 + 7.0);
        vec3 cool = vec3(0.13, 0.33, 0.11);
        vec3 lush = vec3(0.26, 0.50, 0.10);
        vec3 warm = vec3(0.58, 0.60, 0.17);
        vec3 tip = mix(cool, lush, smoothstep(0.35, 0.62, mid));
        tip = mix(tip, warm, smoothstep(0.52, 0.72, big));
        // the root matches the floor (paint.js FIELD) so the gaps between
        // tufts read as grass in shadow rather than as ground
        vec3 root = tip * 0.34;
        diffuseColor.rgb = mix(root, tip * vGShade, smoothstep(0.0, 0.9, vGT));
        if (vGFlower > 0.5 && vGT > 0.78) {
          vec3 fc = vGFlowerHue < 0.4 ? vec3(0.95, 0.92, 0.80)
                  : vGFlowerHue < 0.7 ? vec3(0.95, 0.75, 0.18)
                  : vGFlowerHue < 0.88 ? vec3(0.85, 0.40, 0.62) : vec3(0.45, 0.55, 0.95);
          diffuseColor.rgb = fc;
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          // light through the blade tips toward the sun
          vec3 V = normalize(vGW - cameraPosition);
          float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 4.0);
          totalEmissiveRadiance += diffuseColor.rgb * uSunCol * back * vGT * 1.4;
        }
      `);
  };
  mat.customProgramCacheKey = () => 'grass';
  return { mat, u };
}

export function makeGrass({ scene, terrain, solids }) {
  const { tex, rect } = bakeField(terrain, solids);
  SHARED.uField.value = tex;
  SHARED.uRect.value.copy(rect);
  PAINT.uField.value = tex;
  PAINT.uRect.value.copy(rect);

  // near: dense, four-blade tufts in three segments
  // far: sparse, three-blade tufts in one, handed over from 13 m
  const LAYERS = [
    { spacing: 0.17, rIn: 0, rOut: 11, height: 0.44, blades: 5, segs: 2, width: 0.075, spread: 0.20 },
    { spacing: 0.36, rIn: 9, rOut: 42, height: 0.48, blades: 4, segs: 1, width: 0.12, spread: 0.34 },
  ];
  const meshes = [];
  for (const [li, L] of LAYERS.entries()) {
    const n = Math.ceil((L.rOut * 2) / L.spacing);
    const cells = [];
    const half = n / 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const cx = i - half, cz = j - half;
      const r = Math.hypot(cx, cz) * L.spacing;
      // the square's corners and the near layer's hole are never drawn
      if (r > L.rOut + L.spacing || r < L.rIn * 0.75) continue;
      cells.push(cx, cz);
    }
    const geo = new THREE.InstancedBufferGeometry();
    const tuft = tuftGeometry(L.blades, L.segs, L.width, L.spread, 7 + li * 13);
    geo.index = tuft.index;
    geo.setAttribute('position', tuft.getAttribute('position'));
    geo.setAttribute('normal', tuft.getAttribute('normal'));
    geo.setAttribute('aT', tuft.getAttribute('aT'));
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
    geo.instanceCount = cells.length / 2;
    const { mat, u } = grassMaterial(L);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.layer = { ...L, u, instances: cells.length / 2 };
    scene.add(mesh);
    meshes.push(mesh);
  }

  return {
    meshes,
    /** Re-centre on the camera. Cheap: two uniforms per layer. */
    /** @param pushers  [{x,y,z,r}] -- bodies that part the grass, nearest first */
    update(camPos, playerPos, pushers) {
      SHARED.uCam.value.copy(camPos);
      if (playerPos) SHARED.uPlayer.value.copy(playerPos);
      const P = SHARED.uPush.value;
      const list = pushers || (playerPos ? [{ x: playerPos.x, y: playerPos.y, z: playerPos.z, r: 1.1 }] : []);
      for (let i = 0; i < 8; i++) {
        const b = list[i];
        if (b) P[i].set(b.x, b.y, b.z, b.r); else P[i].w = 0;
      }
      for (const m of meshes) {
        const L = m.userData.layer;
        L.u.uOrigin.value.set(Math.round(camPos.x / L.spacing) * L.spacing,
                              Math.round(camPos.z / L.spacing) * L.spacing);
      }
    },
    set visible(v) { for (const m of meshes) m.visible = v; },
    _debug: () => meshes.map((m) => ({ instances: m.userData.layer.instances,
                                      tris: m.userData.layer.instances * (m.geometry.index.count / 3) })),
  };
}
