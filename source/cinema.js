import * as T from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// The film's lens and lab: depth of field, a soft bloom on highlights, then a
// grade (warm highlights, cool shadows, gentle S-curve), halation, vignette,
// a touch of edge fringing and fine grain. Only used while the film plays.

const Grade = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uStrength: { value: 1 },
    uAspect: { value: 1.78 },
    uFade: { value: 0 },
  },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uStrength, uAspect, uFade;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float r = length(c * vec2(uAspect, 1.0)) / uAspect;
      // Gentle edge fringing.
      vec2 off = c * 0.0035 * uStrength * smoothstep(0.15, 0.6, r * 2.0);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      // Grade in a perceptual-ish space (input is linear HDR).
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 shadows = vec3(0.9, 0.96, 1.08), highs = vec3(1.06, 1.0, 0.92);
      col *= mix(shadows, highs, smoothstep(0.05, 0.75, l));
      col = mix(vec3(l), col, 1.0 + 0.22 * uStrength);           // a little richer
      // Contrast S-curve around mid grey (linear ~0.18).
      col = 0.18 * pow(col / 0.18, vec3(1.0 + 0.24 * uStrength));
      col = col / (1.0 + col * 0.04);                             // shoulder
      // Halation: warm glow bleeding from bright areas.
      float glow = smoothstep(0.7, 1.4, l);
      col += vec3(0.05, 0.02, 0.0) * glow * uStrength;
      // Vignette.
      col *= mix(1.0, smoothstep(1.05, 0.2, r * 1.3), 0.7 * uStrength);
      // Grain.
      float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime * 37.0) * 91.0) - 0.5;
      col += g * 0.018 * uStrength * (1.0 - l * 0.5);
      col *= 1.0 - uFade;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

export class Cinema {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const size = renderer.getSize(new T.Vector2()),
      pr = Math.min(renderer.getPixelRatio(), 1.5);
    const target = new T.WebGLRenderTarget(size.x * pr, size.y * pr, { type: T.HalfFloatType, samples: 2 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(size.x, size.y);
    this.renderPass = new RenderPass(scene, camera);
    this.bokeh = new BokehPass(scene, camera, { focus: 10, aperture: 0.00012, maxblur: 0.0055 });
    this.bloom = new UnrealBloomPass(new T.Vector2(size.x / 2, size.y / 2), 0.16, 0.55, 0.96);
    this.grade = new ShaderPass(Grade);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bokeh);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.onResize = () => {
      const s = renderer.getSize(new T.Vector2());
      this.composer.setSize(s.x, s.y);
      this.bloom.setSize(s.x / 2, s.y / 2);
    };
    addEventListener("resize", this.onResize);
  }
  // focus: distance to the subject in metres (0 disables depth of field).
  render(t, { focus = 0, aperture = 0.00012, fade = 0 } = {}) {
    const cam = this.camera;
    this.renderPass.camera = cam;
    this.bokeh.camera = cam;
    this.bokeh.enabled = focus > 0;
    if (focus > 0) {
      this.bokeh.uniforms.focus.value = focus;
      this.bokeh.uniforms.aperture.value = aperture;
      this.bokeh.uniforms.nearClip.value = cam.near;
      this.bokeh.uniforms.farClip.value = cam.far;
      this.bokeh.uniforms.aspect.value = cam.aspect;
    }
    this.grade.uniforms.uTime.value = t;
    this.grade.uniforms.uAspect.value = cam.aspect;
    this.grade.uniforms.uFade.value = fade;
    this.composer.render();
  }
  dispose() {
    removeEventListener("resize", this.onResize);
    this.composer.passes.forEach((p) => p.dispose?.());
    this.composer.dispose();
  }
}
