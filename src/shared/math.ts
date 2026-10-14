// Small math helpers shared by simulation and rendering (no three.js dependency).

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** Frame-rate independent exponential approach: rate is "per second" sharpness. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return lerpAngle(current, target, 1 - Math.exp(-rate * dt));
}
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}
export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}
export function v3copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}
export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
export function v3len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
export function v3dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function v3distXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
export function v3normalize(out: Vec3, a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  out.x = a.x / l;
  out.y = a.y / l;
  out.z = a.z / l;
  return out;
}
export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
/** Forward direction for a yaw/pitch pair. Yaw 0 looks toward -Z (three.js camera convention). */
export function dirFromYawPitch(yaw: number, pitch: number, out: Vec3 = v3()): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}
