import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

// Camera motion blur by depth reprojection. Runs on the HDR world image before the
// viewmodel is drawn, so the gun in your hands is never smeared.
const fragment = /* glsl */ `
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uStrength;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * ndc;
  world /= world.w;
  vec4 prev = uPrevViewProj * world;
  vec2 prevUv = (prev.xy / prev.w) * 0.5 + 0.5;
  vec2 vel = (uv - prevUv) * uStrength;
  float len = length(vel);
  float maxLen = 0.035;
  if (len > maxLen) vel *= maxLen / len;
  if (len < 0.0006) { outputColor = inputColor; return; }
  vec4 acc = inputColor;
  float total = 1.0;
  for (int i = 1; i <= 6; i++) {
    float t = float(i) / 6.0 - 0.5;
    vec2 suv = clamp(uv + vel * t, vec2(0.001), vec2(0.999));
    acc += texture2D(inputBuffer, suv);
    total += 1.0;
  }
  outputColor = acc / total;
}
`;

export class MotionBlurEffect extends Effect {
  private camera: THREE.Camera;
  private prev = new THREE.Matrix4();
  private cur = new THREE.Matrix4();
  private hasPrev = false;
  private lastTime = performance.now();

  constructor(camera: THREE.Camera) {
    super('MotionBlurEffect', fragment, {
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uInvViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uPrevViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uStrength', new THREE.Uniform(0.5)],
      ]),
    });
    this.camera = camera;
  }

  /** Call once per frame before rendering (after the camera has moved). */
  updateMatrices(): void {
    const now = performance.now();
    const dt = Math.max(1, now - this.lastTime) / 1000;
    this.lastTime = now;
    this.camera.updateMatrixWorld();
    this.cur.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    if (!this.hasPrev) {
      this.prev.copy(this.cur);
      this.hasPrev = true;
    }
    this.uniforms.get('uPrevViewProj')!.value.copy(this.prev);
    this.uniforms.get('uInvViewProj')!.value.copy(this.cur).invert();
    // Normalize blur to a 1/60 s shutter regardless of the actual frame time.
    this.uniforms.get('uStrength')!.value = THREE.MathUtils.clamp(1 / 60 / dt, 0.3, 1.5) * 0.55;
    this.prev.copy(this.cur);
  }
}
