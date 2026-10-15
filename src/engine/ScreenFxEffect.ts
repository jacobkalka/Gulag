import { Uniform, Vector2 } from 'three';
import { Effect } from 'postprocessing';

// Full-screen gameplay feedback (after tone mapping, before output encoding):
// damage edge flash biased toward the hit direction, low-health pulse and desaturation,
// flashbang white-out, spawn-protection tint, black fades, and the player's brightness (gamma).
const fragment = /* glsl */ `
uniform float uDamage;
uniform vec2 uDamageDir;
uniform float uFlash;
uniform float uDesat;
uniform float uLowHp;
uniform float uTime;
uniform float uShield;
uniform float uFade;
uniform float uGamma;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, vec3(l) * vec3(1.03, 0.97, 0.95), clamp(uDesat, 0.0, 1.0));

  vec2 d = (uv - 0.5) * vec2(1.3, 1.0);
  float r = length(d);
  float vig = smoothstep(0.30, 0.92, r);
  float vigHit = smoothstep(0.22, 0.85, r);
  // directional weighting: the edge facing the attacker flashes harder
  float dirW = 1.0;
  if (dot(uDamageDir, uDamageDir) > 0.01) dirW = 0.6 + 0.7 * max(0.0, dot(normalize(d + 1e-5), normalize(uDamageDir)));
  // heartbeat-shaped pulse (lub-dub) for low health
  float beat = fract(uTime * 1.25);
  float pulse = exp(-pow((beat - 0.08) * 22.0, 2.0)) + 0.6 * exp(-pow((beat - 0.26) * 22.0, 2.0));
  float low = uLowHp * (0.55 + 0.45 * pulse);
  vec3 blood = c * vec3(0.42, 0.06, 0.04) + vec3(0.13, 0.0, 0.0);
  // fresh hits: a wider edge flash plus a faint red wash; low health: pulsing edges
  float hit = clamp(uDamage * dirW, 0.0, 1.0);
  c = mix(c, blood, clamp(vigHit * hit * 1.1 + vig * low, 0.0, 0.92));
  c = mix(c, c * vec3(1.0, 0.78, 0.74) + vec3(0.02, 0.0, 0.0), uDamage * 0.18);

  // spawn protection: faint cool edge glow
  c += vec3(0.05, 0.12, 0.16) * vig * uShield;

  // flashbang: white-out that fades to an after-image tint
  c = mix(c, vec3(1.0, 0.98, 0.94), clamp(uFlash, 0.0, 1.0));

  // player brightness (gamma), then black fades
  c = pow(c, vec3(1.0 / max(0.3, uGamma)));
  c *= (1.0 - uFade);
  outputColor = vec4(c, inputColor.a);
}
`;

export type ScreenFxUniform = 'uDamage' | 'uFlash' | 'uDesat' | 'uLowHp' | 'uTime' | 'uShield' | 'uFade' | 'uGamma';

export class ScreenFxEffect extends Effect {
  constructor() {
    super('ScreenFxEffect', fragment, {
      uniforms: new Map<string, Uniform>([
        ['uDamage', new Uniform(0)],
        ['uDamageDir', new Uniform(new Vector2())],
        ['uFlash', new Uniform(0)],
        ['uDesat', new Uniform(0)],
        ['uLowHp', new Uniform(0)],
        ['uTime', new Uniform(0)],
        ['uShield', new Uniform(0)],
        ['uFade', new Uniform(0)],
        ['uGamma', new Uniform(1)],
      ]),
    });
  }
  set(name: ScreenFxUniform, v: number): void {
    this.uniforms.get(name)!.value = v;
  }
  /** Screen-space direction (x right, y up) of the latest hit, or zero for none. */
  setDamageDir(x: number, y: number): void {
    (this.uniforms.get('uDamageDir')!.value as Vector2).set(x, y);
  }
}
