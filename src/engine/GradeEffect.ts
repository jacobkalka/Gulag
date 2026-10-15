import * as THREE from 'three';
import { Effect, Pass } from 'postprocessing';

// Cinematic color pipeline (replaces the plain ACES tone mapping effect):
//   exposure (with eye adaptation) -> ACES filmic -> display-space grade:
//   S-curve contrast with protected blacks/whites, split toning (cool shadows / warm highlights),
//   selective saturation, lift/gain. Per-map palettes and the Visual Style presets feed it.

export interface GradeParams {
  /** Base exposure multiplier. */
  exposure: number;
  /** S-curve strength (1 = neutral). */
  contrast: number;
  saturation: number;
  /** Shadow tint (multiplier around 1) and highlight tint. */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** 0..1 how strongly the split toning applies. */
  split: number;
  /** Black lift (keeps blacks from clipping to pure 0). */
  lift: number;
}

export const NEUTRAL_GRADE: GradeParams = {
  exposure: 1,
  contrast: 1,
  saturation: 1,
  shadowTint: [1, 1, 1],
  highlightTint: [1, 1, 1],
  split: 0,
  lift: 0.004,
};

const fragment = /* glsl */ `
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uSplit;
uniform float uLift;

vec3 acesFitted(vec3 x) {
  // Narkowicz ACES approximation (input pre-scaled like three.js' ACES)
  x *= 0.6;
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = acesFitted(inputColor.rgb * uExposure);
  vec3 s = toSrgb(c);
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  // split toning: tint by luminance zone
  vec3 tint = mix(uShadowTint, uHighlightTint, smoothstep(0.15, 0.75, l));
  s = mix(s, s * tint, uSplit);
  // S-curve around mid gray; blacks lifted a hair so they never clip to flat 0
  vec3 d = s - 0.42;
  s = 0.42 + d * uContrast / (1.0 + abs(d) * (uContrast - 1.0) * 1.15);
  s = max(s, vec3(0.0)) * (1.0 - uLift) + uLift;
  // saturation, gentler in the deep shadows (no colored noise in black areas)
  float l2 = dot(s, vec3(0.2126, 0.7152, 0.0722));
  float satK = mix(1.0, uSaturation, smoothstep(0.03, 0.2, l2));
  s = mix(vec3(l2), s, satK);
  outputColor = vec4(toLinear(clamp(s, 0.0, 1.0)), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', fragment, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uExposure', new THREE.Uniform(1)],
        ['uContrast', new THREE.Uniform(1)],
        ['uSaturation', new THREE.Uniform(1)],
        ['uShadowTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uSplit', new THREE.Uniform(0)],
        ['uLift', new THREE.Uniform(0.004)],
      ]),
    });
  }

  set(p: GradeParams, adaptedExposure: number): void {
    const u = this.uniforms;
    u.get('uExposure')!.value = p.exposure * adaptedExposure;
    u.get('uContrast')!.value = p.contrast;
    u.get('uSaturation')!.value = p.saturation;
    (u.get('uShadowTint')!.value as THREE.Vector3).set(...p.shadowTint);
    (u.get('uHighlightTint')!.value as THREE.Vector3).set(...p.highlightTint);
    u.get('uSplit')!.value = p.split;
    u.get('uLift')!.value = p.lift;
  }
}

const LUM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const LUM_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  // 4x4 taps per output texel, center-weighted (the HUD-free center matters most)
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec2 o = (vec2(float(x), float(y)) - 1.5) / vec2(128.0, 72.0);
    acc += texture2D(tDiffuse, vUv + o).rgb;
  }
  float l = dot(acc / 16.0, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(log(max(l, 1e-4)), 0.0, 0.0, 1.0);
}`;

/**
 * Measures scene luminance (pass-through): renders a small log-luminance image of the HDR input
 * and reads it back asynchronously every few frames. `adapted` eases toward the target exposure.
 */
export class LuminancePass extends Pass {
  private rt: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private buf = new Float32Array(32 * 18 * 4);
  private pending = false;
  private frame = 0;
  private lastT = performance.now();
  /** Geometric mean scene luminance (linear HDR), as last measured. */
  avg = 0.18;
  /** Adapted exposure multiplier (1 = neutral). */
  adapted = 1;
  /** When true (scoped), exposure holds still. */
  frozen = false;
  /** Target scene key and how much of the difference adaptation corrects (0..1). */
  key = 0.05;
  strength = 0.3;

  constructor() {
    super('LuminancePass');
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(32, 18, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.mat = new THREE.ShaderMaterial({ vertexShader: LUM_VERT, fragmentShader: LUM_FRAG, uniforms: { tDiffuse: { value: null } }, depthTest: false, depthWrite: false });
    this.fullscreenMaterial = this.mat;
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (++this.frame % 4 === 0 && !this.pending) {
      this.mat.uniforms.tDiffuse.value = inputBuffer.texture;
      renderer.setRenderTarget(this.rt);
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(null);
      this.pending = true;
      renderer
        .readRenderTargetPixelsAsync(this.rt, 0, 0, 32, 18, this.buf)
        .then(() => {
          let s = 0;
          for (let i = 0; i < 32 * 18; i++) s += this.buf[i * 4];
          this.avg = Math.exp(s / (32 * 18));
        })
        .catch(() => undefined)
        .finally(() => (this.pending = false));
    }
    if (!this.frozen) {
      // subtle: roughly +/- one third of a stop around the graded base exposure
      const target = THREE.MathUtils.clamp(Math.pow(this.key / Math.max(1e-3, this.avg), this.strength), 0.75, 1.35);
      // brighten slowly (eyes opening up in the dark), darken faster (glare)
      const rate = target > this.adapted ? 0.9 : 2.2;
      this.adapted += (target - this.adapted) * Math.min(1, dt * rate);
    }
  }

  override dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
    super.dispose();
  }
}

/** Clamps HDR values before bloom so a single hot pixel (spark, specular) can't white out. */
export class HdrClampPass extends Pass {
  constructor(max = 24) {
    super('HdrClampPass');
    this.fullscreenMaterial = new THREE.ShaderMaterial({
      vertexShader: LUM_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uMax;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float m = max(c.r, max(c.g, c.b));
          gl_FragColor = vec4(c.rgb * min(1.0, uMax / max(m, 1e-5)), c.a);
        }`,
      uniforms: { tDiffuse: { value: null }, uMax: { value: max } },
      depthTest: false,
      depthWrite: false,
    });
  }
  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget): void {
    (this.fullscreenMaterial as THREE.ShaderMaterial).uniforms.tDiffuse.value = inputBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }
}
