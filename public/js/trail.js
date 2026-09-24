// trail.js -- the arc a blade leaves behind it.
//
// WHY.  A reviewer looking at a screenshot with the HUD reading `attack` could
// not tell a swing was happening.  Every other part of impact was there --
// hit-stop, knockback, sparks, numbers, shake -- and all of it fires on
// CONTACT.  Nothing at all marked the swing itself, so a whiff was invisible
// and a hit looked like the enemy spontaneously flinching.
//
// HOW IT READS.  Not an additive glow smear; this is a flat-shaded toon game
// and a soft bloom would be the one thing in frame that belongs to a different
// renderer.  It is a hard-edged ribbon in three opacity steps -- a pale core
// along the blade's path and a fainter edge trailing it -- that narrows to
// nothing from the tail, the way a brush stroke lifts.
//
// The geometry is a strip between two sampled world points per frame, spanning
// the OUTER part of the blade rather than hand-to-tip: a metre-wide ribbon
// reads as a flag being waved, and the part of a blade that leaves a mark is
// the fast end.

import * as THREE from 'three';

const MAX_SEG = 12;               // raw samples: the active window is ~7 frames
const SUB = 4;                    // Catmull-Rom subdivisions between samples
const MAX_PTS = (MAX_SEG - 1) * SUB + 1;

// THE SLASH IS LIGHT, NOT A PANE. It used to be a flat white ribbon drawn with
// alpha -- in a lit, bloomed world that read as a sheet of paper swung through
// the air. Now it is drawn additively in HDR: a white-hot leading edge where
// the tip has just been, bleeding into a coloured tail that cools and thins as
// it ages, so bloom turns it into the arc of light the genre swings.
const VERT = `
attribute float age;
attribute float side;
varying float vAge;
varying float vSide;
void main() {
  vAge = age;
  vSide = side;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uFade;
varying float vAge;
varying float vSide;
void main() {
  float a = clamp(1.0 - vAge, 0.0, 1.0);
  if (a <= 0.01) discard;
  // bright along the tip's path, dim toward the hilt
  float edge = smoothstep(0.15, 1.0, vSide);
  float hot = pow(vSide, 6.0) * pow(a, 2.0);
  vec3 c = mix(uEdge * edge * 1.6, uCore * 3.2, hot);
  gl_FragColor = vec4(c * pow(a, 1.4) * uFade, 1.0);
}`;

const _g = new THREE.Vector3(), _t = new THREE.Vector3();
function cr(a, b, c, d, t, out) {
  const t2 = t * t, t3 = t2 * t;
  for (const k of ['x', 'y', 'z']) {
    out[k] = 0.5 * ((2 * b[k]) + (-a[k] + c[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t2
                    + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * t3);
  }
  return out;
}

export function makeTrail(scene) {
  const pos = new Float32Array(MAX_PTS * 2 * 3);
  const age = new Float32Array(MAX_PTS * 2);
  const side = new Float32Array(MAX_PTS * 2);
  for (let i = 0; i < MAX_PTS; i++) { side[i * 2] = 0; side[i * 2 + 1] = 1; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('age', new THREE.BufferAttribute(age, 1));
  geo.setAttribute('side', new THREE.BufferAttribute(side, 1));

  const idx = [];
  for (let i = 0; i < MAX_PTS - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uCore: { value: new THREE.Color(0xfff6e0) },
      uEdge: { value: new THREE.Color(0x58c8ff) },
      uFade: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;      // it is rebuilt from world points every frame
  mesh.renderOrder = 3;
  mesh.visible = false;
  scene.add(mesh);

  /** Ring of {guard, tip} samples, newest last. */
  const samples = [];
  let live = false;

  return {
    mesh,

    /** Begin a stroke. Old samples are dropped so strokes never join up. */
    start() { samples.length = 0; live = true; },

    /** End the stroke; what is already drawn fades out on its own. */
    stop() { live = false; },

    /**
     * Add this frame's blade position. `guard` and `tip` are world points.
     * Called only while the stroke is live; ageing continues after it ends.
     */
    sample(guard, tip) {
      if (!live) return;
      samples.push({ g: guard.clone(), t: tip.clone(), age: 0 });
      if (samples.length > MAX_SEG) samples.shift();
    },

    /** The arc's colour -- each character swings their own. */
    setColor(edge, core) {
      mat.uniforms.uEdge.value.set(edge);
      if (core !== undefined) mat.uniforms.uCore.value.set(core);
    },

    update(dt) {
      // age everything and drop what has expired
      for (const s of samples) s.age += dt * 5.2;   // gone in ~0.19 s
      while (samples.length && samples[0].age >= 1) samples.shift();
      if (samples.length < 2) { mesh.visible = false; return; }

      // SMOOTH THE ARC. Seven samples of a fast swing are seven straight
      // chords; a Catmull-Rom through them is the curve the blade actually
      // described. TAPER FROM THE TAIL, so the ribbon narrows to nothing
      // instead of ending in a square edge hanging in the air.
      const N = samples.length;
      const at = (i) => samples[Math.max(0, Math.min(N - 1, i))];
      let n = 0;
      for (let i = 0; i < N - 1; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        const steps = i === N - 2 ? SUB + 1 : SUB;
        for (let k = 0; k < steps; k++) {
          const t = k / SUB;
          const g = cr(p0.g, p1.g, p2.g, p3.g, t, _g);
          const tp = cr(p0.t, p1.t, p2.t, p3.t, t, _t);
          const ag = p1.age + (p2.age - p1.age) * t;
          const w = 1 - ag * 0.85;
          pos.set([g.x, g.y, g.z], n * 3); age[n] = ag; n++;
          pos.set([g.x + (tp.x - g.x) * w, g.y + (tp.y - g.y) * w, g.z + (tp.z - g.z) * w], n * 3);
          age[n] = ag; n++;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.age.needsUpdate = true;
      geo.setDrawRange(0, (n / 2 - 1) * 6);
      mesh.visible = true;
    },
  };
}
