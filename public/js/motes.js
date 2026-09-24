// motes.js -- things in the air.
//
// Pollen and dust in the afternoon, fireflies once the light goes. Two point
// clouds that live in a box around the camera and wrap at its edges, so there
// is always air in front of you and no particle is ever spawned or killed.
//
// They are small and there are not many of them, and they do a lot: dust that
// lights up when you look toward a low sun is most of what makes a frame read
// as warm air rather than as a clear render, and fireflies are the cheapest
// way there is to tell the player it is evening without a single word.

import * as THREE from 'three';
import { PAINT } from './paint.js';

const VERT = /* glsl */`
attribute vec4 aSeed;
uniform vec3 uCam;
uniform float uTime, uBox, uSize, uNight, uKind;
uniform float uPR;
uniform vec3 uSunDir;
varying float vGlow;
varying float vFade;
varying float vBlink;
float h(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  // drift: wind plus a slow personal wander
  vec3 p = aSeed.xyz * uBox;
  float t = uTime;
  vec3 drift = uKind < 0.5
    ? vec3(t * 0.35, sin(t * 0.3 + aSeed.w * 9.0) * 0.6, t * 0.18)
    : vec3(sin(t * 0.45 + aSeed.w * 13.0) * 1.4, sin(t * 0.7 + aSeed.w * 7.0) * 0.5,
           cos(t * 0.38 + aSeed.w * 11.0) * 1.4);
  p += drift;
  // WRAP INTO A BOX CENTRED ON THE CAMERA, so the cloud goes where you go
  vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 w = uCam + rel;
  // fireflies hug the ground; dust fills the lower air
  if (uKind > 0.5) w.y = uCam.y - 1.2 + aSeed.y * 2.2 + sin(t + aSeed.w * 20.0) * 0.3;
  else w.y = uCam.y - 1.6 + aSeed.y * 5.5 + drift.y;
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  // fade in from the box edge and out right in front of the lens
  vFade = (1.0 - smoothstep(uBox * 0.32, uBox * 0.5, length(rel.xz))) * smoothstep(0.6, 2.0, dist);
  vec3 V = normalize(w - cameraPosition);
  vGlow = pow(max(dot(V, normalize(uSunDir)), 0.0), 6.0);
  vBlink = uKind > 0.5 ? smoothstep(0.2, 1.0, sin(t * (1.3 + aSeed.w * 1.7) + aSeed.w * 40.0)) : 1.0;
  gl_PointSize = uSize * uPR * (0.6 + aSeed.w * 0.8) / dist * 300.0;
}`;

const FRAG = /* glsl */`
uniform vec3 uSunCol;
uniform float uNight, uKind, uAmount;
varying float vGlow;
varying float vFade;
varying float vBlink;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = smoothstep(0.5, 0.0, r);
  a *= a;
  vec3 col;
  float k;
  if (uKind < 0.5) {
    // dust: barely there, until the sun is behind it
    col = mix(vec3(1.0, 0.95, 0.85), uSunCol * 1.4, 0.6);
    k = (0.10 + vGlow * 2.4) * (1.0 - uNight * 0.8);
  } else {
    col = vec3(0.85, 1.0, 0.45) * 3.0;
    k = vBlink * uNight;
  }
  gl_FragColor = vec4(col * a * k * vFade * uAmount, 1.0);
}`;

function cloud(n, kind, box, size) {
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(n * 4);
  let s = kind ? 99 : 7;
  const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) seeds.set([R(), R(), R(), R()], i * 4);
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uCam: { value: new THREE.Vector3() }, uTime: PAINT.uTime, uBox: { value: box },
      uSize: { value: size }, uNight: { value: 0 }, uKind: { value: kind }, uPR: { value: 1 },
      uSunDir: PAINT.uSunDir, uSunCol: PAINT.uSunCol, uAmount: { value: 1 },
    },
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  return pts;
}

export function makeMotes({ scene }) {
  const dust = cloud(1400, 0, 34, 0.05);
  const flies = cloud(260, 1, 40, 0.09);
  scene.add(dust, flies);
  return {
    /**
     * @param cam     camera position
     * @param night   0 afternoon .. 1 dark
     * @param meadow  true where fireflies belong (not in the paved square)
     */
    update(cam, night, meadow, pr) {
      for (const p of [dust, flies]) {
        p.material.uniforms.uCam.value.copy(cam);
        p.material.uniforms.uPR.value = pr || 1;
      }
      dust.material.uniforms.uNight.value = night;
      const f = flies.material.uniforms;
      f.uNight.value = THREE.MathUtils.smoothstep(night, 0.45, 0.9);
      f.uAmount.value += ((meadow ? 1 : 0.15) - f.uAmount.value) * 0.05;
    },
  };
}
