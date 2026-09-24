// air.js -- what is between the camera and the world.
//
// One full-screen pass, run on the linear HDR image straight after the scene
// and before bloom, doing three things that all need the depth buffer and none
// of which a material can do on its own:
//
//   1. CONTACT SHADOW (ambient occlusion). Where two surfaces meet, less sky
//      reaches the corner. Without it every object looks placed on the ground
//      rather than standing on it, and a street is a set of boxes on a plane.
//   2. AIR. Haze that is thicker near the ground and thins with height, lit by
//      the sun when you look toward it. This is "aerial perspective": it is how
//      the eye reads distance, and it is what turns a far hill from "the same
//      green, smaller" into "far away".
//   3. LIGHT SHAFTS. The sky is marched from each pixel toward the sun, so gaps
//      in a canopy, an arcade or a skyline throw visible beams.
//
// It replaces three's material fog in the painted look: fog in a material only
// knows its own distance, where this knows the world position of every pixel
// and so can do height, sun and occlusion in one place.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform mat4 uProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uFogCol;
uniform vec3 uSunFogCol;
uniform float uFogNear, uFogFar, uFogBase, uFogHeight, uFogMax;
uniform float uAO, uAORadius;
uniform float uRays;
uniform vec2 uSunUv;
uniform float uSunVis;
uniform vec2 uRes;
varying vec2 vUv;

vec3 viewPos(vec2 uv, float d) {
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  bool sky = d >= 0.99999;
  vec3 vp = viewPos(vUv, d);
  vec3 wp = (uViewInv * vec4(vp, 1.0)).xyz;
  vec3 dir = normalize(wp - uCamPos);

  if (!sky) {
    // ---- 1. contact shadow ------------------------------------------
    if (uAO > 0.0) {
      vec3 n = normalize(cross(dFdx(vp), dFdy(vp)));
      float rPx = uAORadius * uProj[1][1] * 0.5 * uRes.y / max(0.1, -vp.z);
      rPx = min(rPx, 80.0);
      float occ = 0.0;
      float rot = ign(gl_FragCoord.xy) * 6.2831853;
      const int N = 12;
      for (int i = 0; i < N; i++) {
        float t = (float(i) + 0.5) / float(N);
        float a = rot + float(i) * 2.39996323;      // golden angle spiral
        vec2 off = vec2(cos(a), sin(a)) * sqrt(t) * rPx / uRes;
        vec2 suv = vUv + off;
        vec3 s = viewPos(suv, texture2D(tDepth, suv).x);
        vec3 v = s - vp;
        float l2 = dot(v, v);
        float range = 1.0 - smoothstep(0.0, uAORadius * uAORadius * 4.0, l2);
        occ += max(0.0, dot(v, n) / sqrt(l2 + 1e-4) - 0.12) * range;
      }
      occ = clamp(occ / float(N) * 2.2, 0.0, 1.0);
      // fade it out with distance: at 60 m the kernel is a pixel wide and
      // occlusion there is only noise
      occ *= 1.0 - smoothstep(35.0, 70.0, -vp.z);
      col *= 1.0 - occ * uAO;
    }

    // ---- 2. air -----------------------------------------------------
    float dist = length(vp);
    float f = clamp((dist - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
    f = 1.0 - exp(-f * 2.6);
    // thicker in the valley, thinner up the hills: the far ridge keeps its
    // shape against the sky instead of dissolving into it
    float hk = exp(-max(wp.y - uFogBase, 0.0) / uFogHeight);
    f *= mix(0.45, 1.0, hk);
    float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 5.0);
    vec3 fc = mix(uFogCol, uSunFogCol, sunAmt * 0.85);
    col = mix(col, fc, clamp(f, 0.0, uFogMax));
  }

  // ---- 3. light shafts ----------------------------------------------
  if (uRays > 0.0 && uSunVis > 0.0) {
    vec2 delta = (uSunUv - vUv) / 36.0;
    vec2 uv = vUv + delta * ign(gl_FragCoord.xy + 7.0);
    float acc = 0.0, w = 1.0, wsum = 0.0;
    for (int i = 0; i < 36; i++) {
      uv += delta;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      acc += step(0.99999, texture2D(tDepth, uv).x) * w;
      wsum += w;
      w *= 0.955;
    }
    acc /= max(wsum, 1e-3);
    float toward = pow(max(dot(dir, uSunDir), 0.0), 3.0);
    // only the OCCLUDED part is a shaft; open sky already has its glow
    float shaft = acc * toward * (sky ? 0.35 : 1.0);
    col += uSunFogCol * shaft * uRays * uSunVis;
  }

  gl_FragColor = vec4(col, 1.0);
}`;

export class AirPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null }, tDepth: { value: null },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFogCol: { value: new THREE.Color(0xcfd8e6) }, uSunFogCol: { value: new THREE.Color(0xffe0b0) },
      uFogNear: { value: 20 }, uFogFar: { value: 180 }, uFogBase: { value: 0 },
      uFogHeight: { value: 14 }, uFogMax: { value: 0.62 },
      uAO: { value: 0.55 }, uAORadius: { value: 0.6 },
      uRays: { value: 0.22 },
      uSunUv: { value: new THREE.Vector2() }, uSunVis: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this._v = new THREE.Vector3();
  }

  setSize(w, h) { this.uniforms.uRes.value.set(w, h); }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms, cam = this.camera;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uProj.value.copy(cam.projectionMatrix);
    u.uViewInv.value.copy(cam.matrixWorld);
    cam.getWorldPosition(u.uCamPos.value);
    // where is the sun on screen, and is it anywhere near the frame
    const s = this._v.copy(u.uSunDir.value).multiplyScalar(1000).add(u.uCamPos.value).project(cam);
    u.uSunUv.value.set(s.x * 0.5 + 0.5, s.y * 0.5 + 0.5);
    const behind = s.z > 1;
    const off = Math.max(Math.abs(s.x), Math.abs(s.y));
    u.uSunVis.value = behind ? 0 : 1 - THREE.MathUtils.smoothstep(off, 1.2, 2.2);
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }
}
