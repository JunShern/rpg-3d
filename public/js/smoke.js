// smoke.js -- chimney smoke.
//
// The cheapest sign there is that people live somewhere: a thin line of smoke
// going up from a few chimneys and bending away with the wind. Soft round
// puffs that rise, swell, drift downwind and fade, each chimney on its own
// clock. The builder records where every chimney is (manifest `smokes`); only
// some of them are lit, because not every hearth is burning at four o'clock.

import * as THREE from 'three';
import { PAINT } from './paint.js';

const PER = 90;          // puffs per chimney: enough that they merge into a plume
const LIFE = 9.0;        // seconds a puff lives

const VERT = /* glsl */`
attribute vec4 aSeed;          // phase, lateral jitter x, jitter z, size
attribute vec3 aBase;
uniform float uTime;
uniform vec2 uWind;
uniform float uPR;
varying float vA;
varying float vShade;
void main() {
  float t = fract(uTime / ${LIFE.toFixed(1)} + aSeed.x);
  // rises slowing down, leans downwind faster as it climbs out of the lee
  vec3 p = aBase;
  p.y += 5.5 * (1.0 - pow(1.0 - t, 1.6));
  p.xz += uWind * (t * t * 7.0 + t * 1.2);
  p.xz += (aSeed.yz - 0.5) * (0.3 + t * 2.2);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = (0.8 + t * 3.6) * aSeed.w;
  gl_PointSize = size * uPR * 300.0 / max(1.0, -mv.z);
  vA = smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.30, 1.0, t)) * 0.13;
  vShade = 0.72 + 0.28 * aSeed.y;
}`;

const FRAG = /* glsl */`
uniform vec3 uSunCol;
uniform vec3 uSky;
varying float vA;
varying float vShade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = smoothstep(0.5, 0.0, r) * smoothstep(0.5, 0.0, r) * vA;
  if (a < 0.004) discard;
  // lit from above-left by the sun, from below by the sky
  float lit = clamp(0.55 - c.y * 0.9 - c.x * 0.4, 0.0, 1.0);
  vec3 col = mix(uSky * 0.55, uSunCol * 1.2 + 0.25, lit) * vShade;
  gl_FragColor = vec4(col, a);
}`;

export function makeSmoke({ scene, sources }) {
  // not every hearth: every other chimney, which reads as a town going about
  // its afternoon rather than as a town on fire
  const lit = sources.filter((_, i) => i % 2 === 0);
  const n = lit.length * PER;
  const g = new THREE.BufferGeometry();
  const base = new Float32Array(n * 3), seed = new Float32Array(n * 4);
  let s = 3;
  const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  lit.forEach((src, j) => {
    for (let i = 0; i < PER; i++) {
      const k = j * PER + i;
      base.set([src.x, src.y, src.z], k * 3);
      seed.set([i / PER + R() * 0.02, R(), R(), 0.7 + R() * 0.6], k * 4);
    }
  });
  g.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
  g.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    uniforms: {
      uTime: PAINT.uTime, uWind: { value: new THREE.Vector2(0.8, 0.45).normalize() },
      uPR: { value: 1 }, uSunCol: PAINT.uSunCol, uSky: { value: new THREE.Color(0.7, 0.78, 0.9) },
    },
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  scene.add(pts);
  return {
    update(pr) { mat.uniforms.uPR.value = pr || 1; },
    count: lit.length,
  };
}
