// groundfog.js -- a band of mist lying on the meadow.
//
// Depth in a painted landscape comes from air: the further a thing is, the
// more the atmosphere sits between you and it. Scene fog does that per pixel
// by distance, which fades everything equally; what a valley actually has is
// mist POOLED IN THE LOW GROUND, drifting, thinner where the land rises. This
// is one large plane at knee height over the meadow, with an alpha that is a
// scrolling noise field falling off with height above the plane, so the road
// climbing to the pass rises out of it.
//
// Unlit, unoutlined, drawn after the world: atmosphere, not geometry.

import * as THREE from 'three';
import { WIND } from './toon.js';

export function makeGroundFog({ scene, heightAt = null, x0 = -50, x1 = 50, z0 = -118, z1 = -10, y = 0.9 }) {
  const w = x1 - x0, d = z1 - z0;
  // THE SHEET FOLLOWS THE GROUND. A flat plane at knee height is under the
  // hill and over the stream; a 4 m grid pushed up to the terrain plus a
  // lift lies on every slope, and the noise does the pooling.
  const geo = new THREE.PlaneGeometry(w, d, Math.round(w / 4), Math.round(d / 4));
  geo.rotateX(-Math.PI / 2);
  if (heightAt) {
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const gx = pa.getX(i) + (x0 + x1) / 2, gz = pa.getZ(i) + (z0 + z1) / 2;
      const g = heightAt(gx, gz);
      pa.setY(i, (g === null || g === undefined ? 0 : g) + y - (z0 + z1) / 2 * 0 - 0);
    }
    pa.needsUpdate = true;
  }
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uWind: WIND,
      uColor: { value: new THREE.Color(0xe6e2d6) },
      uAlpha: { value: 0.55 },
      uCam: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uWind; uniform vec3 uColor; uniform float uAlpha; uniform vec3 uCam;
      varying vec3 vW;
      // value noise, two octaves, scrolled by the wind clock
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 p = vW.xz * 0.045 + vec2(uWind * 0.05, uWind * 0.02);
        float a = n(p) * 0.65 + n(p * 2.3 + 7.0) * 0.35;
        a = smoothstep(0.35, 0.85, a);
        // thin near the camera so it never becomes a wall in front of the face
        float dc = length(vW.xz - uCam.xz);
        a *= smoothstep(4.0, 16.0, dc);
        // fade at the plane's edges
        vec2 e = vec2(${(w / 2).toFixed(1)}, ${(d / 2).toFixed(1)}) - abs(vW.xz - vec2(${((x0 + x1) / 2).toFixed(1)}, ${((z0 + z1) / 2).toFixed(1)}));
        a *= smoothstep(0.0, 12.0, min(e.x, e.y));
        gl_FragColor = vec4(uColor, a * uAlpha);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((x0 + x1) / 2, heightAt ? 0 : y, (z0 + z1) / 2);
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;
  mesh.userData.isFog = true;
  scene.add(mesh);
  return {
    mesh,
    update(camPos, { dusk = 0, color = null } = {}) {
      mat.uniforms.uCam.value.copy(camPos);
      mat.uniforms.uAlpha.value = 0.45 + 0.35 * dusk;
      if (color) mat.uniforms.uColor.value.copy(color);
    },
    set enabled(v) { mesh.visible = v; },
    get enabled() { return mesh.visible; },
  };
}
