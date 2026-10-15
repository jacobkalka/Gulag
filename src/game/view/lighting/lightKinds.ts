import * as THREE from 'three';
import type { LightDef } from '@/game/world/mapTypes';

// Shared light conventions for the real-time light rig and the probe bake.

/** Map light `intensity` x this = candela of the real-time light. */
export const INTENSITY_SCALE = 7;

/** Approximate blackbody color (linear sRGB, normalized so the brightest channel is 1). */
export function kelvinColor(k: number, out = new THREE.Color()): THREE.Color {
  const t = THREE.MathUtils.clamp(k, 1000, 12000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  out.setRGB(THREE.MathUtils.clamp(r, 0, 255) / 255, THREE.MathUtils.clamp(g, 0, 255) / 255, THREE.MathUtils.clamp(b, 0, 255) / 255, THREE.SRGBColorSpace);
  const m = Math.max(out.r, out.g, out.b) || 1;
  return out.multiplyScalar(1 / m);
}

/** Light color (linear) for a def: its kelvin temperature when given, else its hex color. */
export function lightColor(l: LightDef, out = new THREE.Color()): THREE.Color {
  if (l.kelvin) return kelvinColor(l.kelvin, out);
  return out.setHex(l.color, THREE.SRGBColorSpace);
}

/** Average flicker level of a light (used by the bake; dead lights give nothing). */
export function averageFlicker(l: LightDef): number {
  if (l.broken) return l.flicker ? 0.12 : 0;
  if (!l.flicker) return 1;
  const style = l.flicker % 3;
  return style === 0 ? 0.92 : style === 1 ? 0.72 : 0.8;
}

/** Color x candela, averaged over flicker: what the probe bake integrates. */
export function lightRadiance(l: LightDef, out = new THREE.Color()): THREE.Color {
  return lightColor(l, out).multiplyScalar(l.intensity * INTENSITY_SCALE * averageFlicker(l));
}
