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

const MAX_SEG = 10;               // the active window is ~7 frames long
const VERT_PER_SEG = 2;

const VERT = `
attribute float age;
varying float vAge;
varying float vSide;
void main() {
  vAge = age;
  vSide = float(gl_VertexID % 2);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Two flat bands and a hard cut, so it reads as ink rather than as light.
const FRAG = `
precision mediump float;
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uFade;
varying float vAge;
varying float vSide;
void main() {
  float a = clamp(1.0 - vAge, 0.0, 1.0);
  if (a <= 0.02) discard;
  vec3 c = vSide > 0.5 ? uEdge : uCore;
  // banded, not smooth: three steps is the whole ramp, and the trailing edge
  // is much fainter than the core so it reads as a stroke lifting
  float band = a > 0.66 ? 0.62 : (a > 0.33 ? 0.34 : 0.13);
  float side = vSide > 0.5 ? 0.55 : 1.0;
  gl_FragColor = vec4(c, band * side * uFade);
}`;

export function makeTrail(scene) {
  const pos = new Float32Array(MAX_SEG * VERT_PER_SEG * 3);
  const age = new Float32Array(MAX_SEG * VERT_PER_SEG);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('age', new THREE.BufferAttribute(age, 1));

  // one strip: 0-1-2, 2-1-3, ...
  const idx = [];
  for (let i = 0; i < MAX_SEG - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      // a pale warm core with only a hint of cool at the trailing edge. The
      // first pass used a saturated blue and it was the loudest thing in frame.
      uCore: { value: new THREE.Color(0xfffaf0) },
      uEdge: { value: new THREE.Color(0xdfeaf2) },
      uFade: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
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

    update(dt) {
      // age everything and drop what has expired
      for (const s of samples) s.age += dt * 7.5;   // gone in ~0.13 s
      while (samples.length && samples[0].age >= 1) samples.shift();
      if (samples.length < 2) { mesh.visible = false; return; }

      // TAPER FROM THE TAIL. The oldest end of the stroke pulls its outer edge
      // in toward the inner one, so the ribbon narrows to nothing instead of
      // ending in a square edge hanging in the air.
      let n = 0;
      for (const s of samples) {
        const k = 1 - s.age * 0.85;
        pos[n * 3 + 0] = s.g.x; pos[n * 3 + 1] = s.g.y; pos[n * 3 + 2] = s.g.z;
        age[n] = s.age;
        n++;
        pos[n * 3 + 0] = s.g.x + (s.t.x - s.g.x) * k;
        pos[n * 3 + 1] = s.g.y + (s.t.y - s.g.y) * k;
        pos[n * 3 + 2] = s.g.z + (s.t.z - s.g.z) * k;
        age[n] = s.age;
        n++;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.age.needsUpdate = true;
      geo.setDrawRange(0, (samples.length - 1) * 6);
      mesh.visible = true;
    },
  };
}
