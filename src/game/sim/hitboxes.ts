import type { Hitbox } from '@/data/weapons';
import { MOVE } from './movement';

// Player hitboxes (head sphere + three body capsules) and ray tests, plus the
// per-tick position history the host uses for lag-compensated hit detection.

export interface Capsule {
  ax: number;
  ay: number;
  az: number;
  by: number; // vertical capsule: same x/z, from ay to by
  r: number;
}

export interface BodyPose {
  x: number;
  y: number;
  z: number;
  crouch: number;
  slide: boolean;
  yaw: number;
}

export interface HitResult {
  t: number;
  hitbox: Hitbox;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function buildHitboxes(p: BodyPose): { head: { x: number; y: number; z: number; r: number }; parts: [Hitbox, Capsule][] } {
  const c = p.slide ? 1.2 : p.crouch;
  const eye = p.slide ? MOVE.eyeSlide : lerp(MOVE.eyeStand, MOVE.eyeCrouch, c);
  const fx = -Math.sin(p.yaw) * 0.04;
  const fz = -Math.cos(p.yaw) * 0.04;
  const head = { x: p.x + fx, y: p.y + eye + 0.035, z: p.z + fz, r: 0.13 };
  const k = (stand: number, crouch: number) => p.y + lerp(stand, crouch, Math.min(1, c));
  const parts: [Hitbox, Capsule][] = [
    ['chest', { ax: p.x, ay: k(1.12, 0.64), az: p.z, by: k(1.42, 0.9), r: 0.21 }],
    ['stomach', { ax: p.x, ay: k(0.86, 0.44), az: p.z, by: k(1.12, 0.64), r: 0.19 }],
    ['legs', { ax: p.x, ay: p.y + 0.08, az: p.z, by: k(0.86, 0.44), r: lerp(0.16, 0.22, Math.min(1, c)) }],
  ];
  return { head, parts };
}

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): number {
  const fx = ox - cx;
  const fy = oy - cy;
  const fz = oz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 ? t : Infinity;
}

/** Ray vs vertical capsule (segment from (ax,ay,az) to (ax,by,az), radius r). */
function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, c: Capsule): number {
  let best = Infinity;
  // infinite cylinder in XZ
  const fx = ox - c.ax;
  const fz = oz - c.az;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const b = 2 * (fx * dx + fz * dz);
    const cc = fx * fx + fz * fz - c.r * c.r;
    const disc = b * b - 4 * a * cc;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0) {
        const y = oy + dy * t;
        if (y >= c.ay && y <= c.by) best = t;
      }
    }
  }
  best = Math.min(best, raySphere(ox, oy, oz, dx, dy, dz, c.ax, c.ay, c.az, c.r));
  best = Math.min(best, raySphere(ox, oy, oz, dx, dy, dz, c.ax, c.by, c.az, c.r));
  return best;
}

/**
 * Nearest hitbox hit along the ray within maxT, or null. Direction should be unit length.
 * `inflate` grows every hitbox radius (touchpad hit forgiveness, decided by the host).
 */
export function rayVsBody(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, pose: BodyPose, inflate = 0): HitResult | null {
  // broadphase: bounding cylinder
  const hb = buildHitboxes(pose);
  if (inflate > 0) {
    hb.head.r += inflate * 0.6;
    for (const [, cap] of hb.parts) cap.r += inflate;
  }
  const quick = rayCapsule(ox, oy, oz, dx, dy, dz, { ax: pose.x, ay: pose.y, az: pose.z, by: pose.y + 1.85, r: 0.45 + inflate });
  if (quick > maxT) return null;
  let bestT = maxT;
  let best: Hitbox | null = null;
  const th = raySphere(ox, oy, oz, dx, dy, dz, hb.head.x, hb.head.y, hb.head.z, hb.head.r);
  if (th < bestT) {
    bestT = th;
    best = 'head';
  }
  for (const [name, cap] of hb.parts) {
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, cap);
    if (t < bestT) {
      bestT = t;
      best = name;
    }
  }
  return best ? { t: bestT, hitbox: best } : null;
}

/** Ring buffer of past poses for lag compensation (one per player). */
export class PoseHistory {
  private ticks: Int32Array;
  private data: Float32Array; // x, y, z, crouch, slide, yaw, alive
  private head = 0;
  constructor(private size = 64) {
    this.ticks = new Int32Array(size).fill(-1);
    this.data = new Float32Array(size * 7);
  }
  push(tick: number, p: BodyPose, alive: boolean): void {
    const i = this.head;
    this.ticks[i] = tick;
    const o = i * 7;
    this.data[o] = p.x;
    this.data[o + 1] = p.y;
    this.data[o + 2] = p.z;
    this.data[o + 3] = p.crouch;
    this.data[o + 4] = p.slide ? 1 : 0;
    this.data[o + 5] = p.yaw;
    this.data[o + 6] = alive ? 1 : 0;
    this.head = (i + 1) % this.size;
  }
  /** Pose at a fractional tick (interpolated); null if out of range or dead at that time. */
  sample(tick: number, out: BodyPose): boolean {
    let lo = -1;
    let hi = -1;
    let loT = -Infinity;
    let hiT = Infinity;
    for (let i = 0; i < this.size; i++) {
      const t = this.ticks[i];
      if (t < 0) continue;
      if (t <= tick && t > loT) {
        loT = t;
        lo = i;
      }
      if (t >= tick && t < hiT) {
        hiT = t;
        hi = i;
      }
    }
    if (lo < 0 && hi < 0) return false;
    if (lo < 0) lo = hi;
    if (hi < 0) hi = lo;
    const a = lo * 7;
    const b = hi * 7;
    if (this.data[a + 6] < 0.5 && this.data[b + 6] < 0.5) return false;
    const f = hiT > loT && Number.isFinite(hiT) && Number.isFinite(loT) ? (tick - loT) / (hiT - loT) : 0;
    out.x = lerp(this.data[a], this.data[b], f);
    out.y = lerp(this.data[a + 1], this.data[b + 1], f);
    out.z = lerp(this.data[a + 2], this.data[b + 2], f);
    out.crouch = lerp(this.data[a + 3], this.data[b + 3], f);
    out.slide = this.data[b + 4] > 0.5;
    out.yaw = this.data[b + 5];
    return true;
  }
  clear(): void {
    this.ticks.fill(-1);
  }
}
