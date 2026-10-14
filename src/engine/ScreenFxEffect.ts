import { Uniform } from 'three';
import { Effect } from 'postprocessing';

// Full-screen gameplay feedback: low-health desaturation + pulse, damage vignette,
// flashbang white-out, spawn-protection tint, and an optional color-blind safe tint.
const fragment = /* glsl */ `
uniform float uDamage;
uniform float uFlash;
uniform float uDesat;
uniform float uPulse;
uniform float uTime;
uniform float uShield;
uniform float uFade;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, vec3(l) * vec3(1.02, 0.98, 0.96), uDesat);

  vec2 d = (uv - 0.5) * vec2(1.25, 1.0);
  float r = length(d);
  float vig = smoothstep(0.32, 0.95, r);
  float pulse = 0.75 + 0.25 * sin(uTime * 7.0);
  float dmg = clamp(uDamage + uPulse * pulse * 0.6, 0.0, 1.0);
  c = mix(c, c * vec3(0.55, 0.08, 0.05) + vec3(0.16, 0.0, 0.0), vig * dmg);

  // Spawn protection: faint cool edge glow.
  c += vec3(0.05, 0.12, 0.16) * vig * uShield;

  // Flashbang: white-out that fades to an after-image tint.
  c = mix(c, vec3(1.0, 0.98, 0.94), clamp(uFlash, 0.0, 1.0));

  // Black fade for transitions.
  c *= (1.0 - uFade);
  outputColor = vec4(c, inputColor.a);
}
`;

export class ScreenFxEffect extends Effect {
  constructor() {
    super('ScreenFxEffect', fragment, {
      uniforms: new Map<string, Uniform>([
        ['uDamage', new Uniform(0)],
        ['uFlash', new Uniform(0)],
        ['uDesat', new Uniform(0)],
        ['uPulse', new Uniform(0)],
        ['uTime', new Uniform(0)],
        ['uShield', new Uniform(0)],
        ['uFade', new Uniform(0)],
      ]),
    });
  }
  set(name: 'uDamage' | 'uFlash' | 'uDesat' | 'uPulse' | 'uTime' | 'uShield' | 'uFade', v: number): void {
    this.uniforms.get(name)!.value = v;
  }
}
