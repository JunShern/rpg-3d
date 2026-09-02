// post.js -- the frame after the frame.
//
// Everything the renderer draws is *correct* and none of it is *directed*. A
// forward-rendered toon scene with no post pass is the same picture whatever
// the art wants: the shadows are whatever grey the fill leaves, the highlights
// are whatever the key produces, the sky is a gradient and the far distance is
// a linear fog. What every stylised game of the last decade does on top of
// that is small and cheap and is most of the difference between "rendered"
// and "painted":
//
//   AO        contact shadow where things meet, so they stop floating
//   bloom     a little glow off the brightest 10%, so light reads as light
//   grade     cool shadows, warm highlights, a touch more saturation -- the
//             palette decision the materials cannot make on their own
//   vignette  the frame gets a centre
//   grain     kills the plastic flatness of perfectly clean pixels
//
// ORDER MATTERS. Bloom wants linear HDR, so it runs before tone mapping. The
// grade wants display-referred colour -- lifting shadows in linear light does
// something quite different -- so it runs after OutputPass, on sRGB, and must
// not re-encode.
//
// The MSAA target is the reason the edges survive: `antialias: true` on the
// renderer only applies to the default framebuffer, and the moment a composer
// renders to a texture that flag does nothing. Four samples on a half-float
// target is the WebGL2 way to keep the lines clean without an SMAA pass.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// The grade. Lift is ADDED into the dark end, gain MULTIPLIES the bright end,
// so the two can carry different hues -- that split is the whole trick behind
// a warm-light / cool-shade palette.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
    uGain: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
    uSat: { value: 1.0 },
    uContrast: { value: 1.0 },
    uVignette: { value: 0.0 },
    uGrain: { value: 0.0 },
    uTime: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec3 uLift;
    uniform vec3 uGain;
    uniform float uSat;
    uniform float uContrast;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = luma(c);
      // shadows take the lift, highlights take the gain; the midtones get a
      // blend, so a colour cast never lands as a flat wash over the whole frame
      c += uLift * (1.0 - smoothstep(0.0, 0.6, l));
      c *= mix(vec3(1.0), uGain, smoothstep(0.35, 1.0, l));
      // contrast about mid-grey, applied after the casts so it sharpens them
      c = (c - 0.5) * uContrast + 0.5;
      float g = luma(c);
      c = mix(vec3(g), c, uSat);
      // vignette: gentle, and it starts well outside the character
      vec2 d = (vUv - 0.5) * vec2(1.15, 1.0);
      c *= 1.0 - uVignette * smoothstep(0.42, 0.95, length(d) * 1.35);
      // grain: tiny, animated, more in the shadows where flatness shows most
      float n = fract(sin(dot(vUv * 913.0 + fract(uTime) * 7.0,
                               vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * uGrain * (1.0 - l * 0.6);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

// A named set of knobs. `painted` is the look; `flat` is the A/B control that
// renders the same frame through the same passes with every effect at zero,
// so a comparison isolates the grade from the pass structure itself.
export const POST = {
  painted: {
    ao: true,
    aoIntensity: 0.5,
    bloom: 0.20, bloomRadius: 0.55, bloomThreshold: 0.84,
    lift: [0.008, 0.012, 0.030],       // shadows drift blue-violet
    gain: [1.030, 1.008, 0.972],       // highlights warm, gently
    sat: 1.08,
    contrast: 1.05,
    vignette: 0.26,
    grain: 0.022,
  },
  flat: {
    ao: false, aoIntensity: 0,
    bloom: 0, bloomRadius: 0, bloomThreshold: 1,
    lift: [0, 0, 0], gain: [1, 1, 1], sat: 1, contrast: 1, vignette: 0, grain: 0,
  },
};

export function makePost({ renderer, scene, camera, width, height }) {
  const size = new THREE.Vector2(width, height);
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, target);

  const renderPass = new RenderPass(scene, camera);
  const ao = new GTAOPass(scene, camera, width, height);
  ao.output = GTAOPass.OUTPUT.Default;
  // TOON SURFACES ARE FLAT BY DESIGN, so the AO has to be about CONTACT, not
  // about crevices -- a small radius and a hard fall-off, or every wall gets a
  // smudged gradient up it that reads as dirt.
  ao.updateGtaoMaterial({
    radius: 0.35, distanceExponent: 1.0, thickness: 1.0,
    scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false,
  });
  const bloom = new UnrealBloomPass(size.clone(), 0.2, 0.5, 0.85);
  const output = new OutputPass();
  const grade = new ShaderPass(GradeShader);

  composer.addPass(renderPass);
  composer.addPass(ao);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(grade);

  let cfg = { ...POST.painted };

  function apply(next = {}) {
    cfg = { ...cfg, ...next };
    ao.enabled = !!cfg.ao;
    ao.blendIntensity = cfg.aoIntensity;
    bloom.enabled = cfg.bloom > 0;
    bloom.strength = cfg.bloom;
    bloom.radius = cfg.bloomRadius;
    bloom.threshold = cfg.bloomThreshold;
    const u = grade.uniforms;
    u.uLift.value.fromArray(cfg.lift);
    u.uGain.value.fromArray(cfg.gain);
    u.uSat.value = cfg.sat;
    u.uContrast.value = cfg.contrast;
    u.uVignette.value = cfg.vignette;
    u.uGrain.value = cfg.grain;
    return { ...cfg };
  }
  apply();

  let t = 0;
  return {
    composer,
    render(dt = 0) {
      t += dt;
      grade.uniforms.uTime.value = t;
      composer.render();
    },
    resize(w, h) {
      composer.setSize(w, h);
      ao.setSize(w, h);
      bloom.setSize(w, h);
    },
    /** Set knobs by name, or a whole preset by string. Returns the live config. */
    set(next) {
      if (typeof next === 'string') {
        if (!POST[next]) return `unknown post preset: ${Object.keys(POST).join(', ')}`;
        return apply(POST[next]);
      }
      return apply(next || {});
    },
    get config() { return { ...cfg }; },
  };
}
