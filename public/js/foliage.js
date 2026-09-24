// foliage.js -- trees that look like trees.
//
// WHAT THE TREES WERE. A canopy was a handful of smooth low-poly blobs on a
// cylinder, and a pine was three cones stacked on a stick. Under a cel ramp
// with an ink line that is a legitimate style; under light it is a lollipop,
// and it was the single most "placeholder" thing left in the frame once the
// ground had grass on it.
//
// WHAT THEY ARE NOW. The blob stays, as the canopy's dark core -- but its
// surface is covered in thousands of small painted leaf-cluster cards, each
// one facing the camera, each lit with the normal of the blob at the point it
// grows from. That is the standard way a painterly tree is made: lit as one
// soft volume (so it still reads as a mass with a sunny side and a shady
// side), but with a silhouette made of leaves instead of a polygon edge, and
// light breaking through the gaps.
//
// It is generated at load from the existing canopy meshes, so every tree the
// builders placed -- and every one they place later -- gets it for free.

import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { PAINT } from './paint.js';

/** A cluster of leaves painted on a canvas: white shapes on transparent. */
function leafTexture(kind) {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  let seed = kind === 'needle' ? 11 : 5;
  const R = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#fff';
  if (kind === 'needle') {
    // a spray of needles radiating from a point below centre
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const a = -Math.PI / 2 + (R() - 0.5) * 2.6;
      const l = S * (0.22 + R() * 0.26);
      const x0 = S * 0.5 + (R() - 0.5) * S * 0.2, y0 = S * 0.62 + (R() - 0.5) * S * 0.1;
      g.lineWidth = 2.2 + R() * 2.2;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x0 + Math.cos(a) * l, y0 + Math.sin(a) * l);
      g.stroke();
    }
  } else {
    // a round cluster of leaves, denser in the middle
    for (let i = 0; i < 34; i++) {
      const r = Math.sqrt(R()) * S * 0.36;
      const a = R() * Math.PI * 2;
      const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
      const len = S * (0.10 + R() * 0.07), wid = len * (0.45 + R() * 0.2);
      g.save();
      g.translate(x, y);
      g.rotate(R() * Math.PI * 2);
      g.beginPath();
      g.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const VERT_PARS = /* glsl */`
attribute vec3 aCenter;
attribute vec3 aNrm;
attribute vec4 aRnd;          // size, rotation, shade, phase
uniform float uTime;
uniform float uWindAmp;
varying float vShade;
varying float vDepth;
varying vec3 vFW;
varying vec3 vFN;
`;
// the card faces the camera; its NORMAL is the canopy's at the point it grows
const VERT_BEGIN = /* glsl */`
vec3 transformed = aCenter;
float ph = aCenter.x * 0.35 + aCenter.z * 0.27 + aRnd.w * 6.28;
transformed.x += (sin(uTime * 1.1 + ph) * 0.68 + sin(uTime * 2.3 + ph * 1.7) * 0.32) * uWindAmp;
transformed.z += sin(uTime * 0.87 + ph * 1.3) * uWindAmp * 0.5;
transformed.y += sin(uTime * 2.7 + ph * 2.0) * uWindAmp * 0.25;
vShade = fract(aRnd.z);
vDepth = floor(aRnd.z) / 9.0;
vFW = transformed;
vFN = aNrm;
`;
const VERT_PROJECT = /* glsl */`
vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
{
  float c = cos(aRnd.y), s = sin(aRnd.y);
  // CARDS SHRINK AWAY FROM THE LENS. A leaf cluster a metre across is right
  // at ten metres and a green hand over the screen at one; when the camera
  // brushes a canopy the cards nearest it get out of the way.
  float near = smoothstep(0.8, 3.2, -mvPosition.z);
  vec2 corner = mat2(c, -s, s, c) * position.xy * aRnd.x * near;
  mvPosition.xy += corner;
}
gl_Position = projectionMatrix * mvPosition;
`;

function patch(mat, extraFrag) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = PAINT.uTime;
    sh.uniforms.uWindAmp = mat.userData.windAmp;
    sh.uniforms.uSunDir = PAINT.uSunDir;
    sh.uniforms.uSunCol = PAINT.uSunCol;
    sh.uniforms.uTint = mat.userData.tint;
    sh.uniforms.uTint2 = mat.userData.tint2;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', VERT_BEGIN)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = aNrm;')
      .replace('#include <project_vertex>', VERT_PROJECT);
    if (extraFrag) extraFrag(sh);
  };
}

function cardsFor(meshes, { count, size, lift, kind, tint, tint2, windAmp }) {
  // sample every source mesh in proportion to its surface area
  const src = [];
  let total = 0;
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    g.computeVertexNormals();
    const tmp = new THREE.Mesh(g);
    const pos = g.attributes.position;
    const idx = g.index;
    let a = 0;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const tri = new THREE.Triangle();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      va.fromBufferAttribute(pos, i0); vb.fromBufferAttribute(pos, i1); vc.fromBufferAttribute(pos, i2);
      tri.set(va, vb, vc);
      a += tri.getArea();
    }
    src.push({ mesh: tmp, area: a });
    total += a;
  }
  if (!total) return null;

  const centers = [], normals = [], rnd = [];
  const p = new THREE.Vector3(), nrm = new THREE.Vector3();
  let seed = 1234;
  const R = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const s of src) {
    const sampler = new MeshSurfaceSampler(s.mesh).build();
    sampler.randomFunction = R;
    const k = Math.round(count * s.area / total);
    for (let i = 0; i < k; i++) {
      sampler.sample(p, nrm);
      // lean each normal a little outward-and-up so the crown catches the sky
      nrm.y += 0.15;
      nrm.normalize();
      const depth = R();
      const out = lift * (-0.4 + depth * 1.6);
      centers.push(p.x + nrm.x * out, p.y + nrm.y * out, p.z + nrm.z * out);
      normals.push(nrm.x, nrm.y, nrm.z);
      // z packs two things: the card's own shade (0..1) in the fraction and
      // how deep in the canopy it sits (0 inside .. 1 outside) in the integer
      // tenths, so the fragment can darken the interior without a 5th attribute
      rnd.push(size * (0.7 + R() * 0.6), R() * Math.PI * 2,
               Math.floor(depth * 9.99) + R() * 0.99, R());
    }
  }

  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(centers), 3));
  geo.setAttribute('aNrm', new THREE.InstancedBufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(new Float32Array(rnd), 4));
  geo.instanceCount = centers.length / 3;

  const tex = leafTexture(kind);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, alphaMap: tex, alphaTest: 0.5, roughness: 0.78, metalness: 0,
    side: THREE.DoubleSide, envMapIntensity: 0.9,
  });
  // alphaMap needs a UV and a map-less material needs its map transform
  mat.userData.windAmp = { value: windAmp };
  mat.userData.tint = { value: new THREE.Color(tint) };
  mat.userData.tint2 = { value: new THREE.Color(tint2) };
  patch(mat, (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying float vShade;
        varying float vDepth;
        varying vec3 vFW;
        varying vec3 vFN;
        uniform vec3 uSunDir, uSunCol, uTint, uTint2;
        float fh(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 17853.7); }
      `)
      .replace('#include <map_fragment>', /* glsl */`
        // EVERY TREE ITS OWN GREEN. The cell a card sits in is roughly the
        // tree it belongs to; hash it into a hue so an orchard is a dozen
        // trees and not one colour repeated.
        float tree = fh(floor(vFW.xz / 4.0));
        vec3 a = mix(uTint, uTint * vec3(1.15, 0.95, 0.70), step(0.6, tree));
        a = mix(a, uTint * vec3(0.80, 1.00, 1.15), step(0.85, tree));
        vec3 lc = mix(a, uTint2 * mix(0.9, 1.1, tree), vShade);
        // self-shadow: the underside and the INSIDE of the crown are dark,
        // which is what gives a canopy its lumps
        lc *= mix(0.50, 1.10, smoothstep(-0.7, 0.7, vFN.y));
        lc *= mix(0.45, 1.0, smoothstep(0.0, 0.8, vDepth));
        diffuseColor.rgb = lc;
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          vec3 V = normalize(vFW - cameraPosition);
          float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 3.0);
          float away = clamp(-dot(vFN, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
          totalEmissiveRadiance += diffuseColor.rgb * uSunCol * back * (0.4 + away) * 1.3;
        }
      `);
  });
  mat.customProgramCacheKey = () => 'leafcard';

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking,
                                              alphaMap: tex, alphaTest: 0.5 });
  depth.userData.windAmp = mat.userData.windAmp;
  depth.userData.tint = mat.userData.tint;
  depth.userData.tint2 = mat.userData.tint2;
  patch(depth);
  depth.customProgramCacheKey = () => 'leafcard-depth';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.customDepthMaterial = depth;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.cards = geo.instanceCount;
  return mesh;
}

/**
 * Dress every canopy in `roots` with leaf cards.
 * Returns the card meshes (already added to `parent`).
 */
export function makeFoliage({ roots, parent }) {
  const leaf = [], conifer = [];
  for (const r of roots) {
    r.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.userData.matName;
      if (n === 'leaf') leaf.push(o);
      else if (n === 'conifer') conifer.push(o);
    });
  }
  const out = [];
  const broad = cardsFor(leaf, {
    count: 42000, size: 0.95, lift: 0.26, kind: 'leaf',
    tint: 0x3e7a2c, tint2: 0x7e9e36, windAmp: 0.07,
  });
  if (broad) { parent.add(broad); out.push(broad); }
  const pine = cardsFor(conifer, {
    count: 16000, size: 0.6, lift: 0.10, kind: 'needle',
    tint: 0x2a5a3a, tint2: 0x4f8246, windAmp: 0.035,
  });
  if (pine) { parent.add(pine); out.push(pine); }
  // the cores darken, so gaps between cards read as depth, not as another surface
  for (const o of [...leaf, ...conifer]) {
    const m = o.material;
    if (m && m.color) m.color.multiplyScalar(0.5);
  }
  return out;
}
