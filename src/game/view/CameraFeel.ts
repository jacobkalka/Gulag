import { clamp } from '@/shared/math';

// Procedural first-person camera motion: head bob and sway synced to footsteps, footstep
// impulses, strafe lean, jump/land springs, slide judder, damage flinch and explosion shake.
// Everything is scaled by the Camera Shake setting and damped while aiming down sights.
// Offsets are visual only (position, small rotations); aim-moving kicks are applied by the
// match view to the input angles so the crosshair always matches where bullets go.

export interface CameraFeelState {
  dt: number;
  /** Horizontal speed (m/s). */
  speed: number;
  /** Strafe velocity relative to the view (m/s, + = right). */
  strafe: number;
  grounded: boolean;
  sprinting: boolean;
  crouch: number;
  sliding: boolean;
  /** 0..1 aim-down-sights blend. */
  ads: number;
}

class Spring {
  x = 0;
  v = 0;
  constructor(
    private k: number,
    private c: number,
  ) {}
  kick(v: number): void {
    this.v += v;
  }
  step(dt: number): number {
    // semi-implicit Euler, substepped for stability at low frame rates
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * this.x - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

export class CameraFeel {
  /** Camera-local position offset (m): x right, y up. */
  readonly pos = { x: 0, y: 0 };
  /** Rotation offsets (radians). */
  readonly rot = { pitch: 0, yaw: 0, roll: 0 };
  /** Overall intensity (Camera Shake setting x reduce-motion). */
  scale = 0.6;
  private phase = 0;
  private lastStep = 0;
  private bob = 0;
  private lean = 0;
  private time = 0;
  private trauma = 0;
  private yS = new Spring(170, 18);
  private pitchS = new Spring(140, 16);
  private yawS = new Spring(120, 15);
  private rollS = new Spring(110, 13);

  /** Landing impact (m/s downward speed). */
  land(speed: number): void {
    const k = clamp((speed - 3) / 10, 0, 1);
    this.yS.kick(-0.9 * k - 0.15);
    this.pitchS.kick(-0.35 * k);
  }

  /** Takeoff: a slight upward glance. */
  jump(): void {
    this.pitchS.kick(0.12);
    this.yS.kick(0.25);
  }

  /**
   * Damage flinch. `side` is the attacker's bearing relative to the view (radians, + = left),
   * `amount` 0..1. The head jerks away from the hit and rolls.
   */
  flinch(side: number, amount: number): void {
    const a = clamp(amount, 0.15, 1);
    const lr = Math.sin(side);
    const fb = Math.cos(side);
    this.pitchS.kick(0.9 * a * (0.5 + 0.5 * fb));
    this.yawS.kick(-0.7 * a * lr);
    this.rollS.kick(1.3 * a * lr);
    this.yS.kick(-0.25 * a);
  }

  /** Explosion / heavy impact shake (decaying noise). */
  shake(amount: number): void {
    this.trauma = Math.min(1.4, this.trauma + amount);
  }

  update(st: CameraFeelState): void {
    const dt = Math.min(st.dt, 1 / 20);
    this.time += dt;
    const adsDamp = 1 - 0.8 * st.ads;
    const s = this.scale * adsDamp;
    // --- footstep cycle: one step per pi radians, stride grows with speed
    const moving = st.grounded && !st.sliding && st.speed > 0.6;
    const stride = st.sprinting ? 1.25 : st.crouch > 0.5 ? 0.62 : 0.95;
    if (moving) this.phase += (st.speed / stride) * Math.PI * dt;
    const targetBob = moving ? clamp(st.speed / 8.4, 0, 1) : 0;
    this.bob += (targetBob - this.bob) * Math.min(1, dt * 8);
    const step = Math.floor(this.phase / Math.PI);
    if (moving && step !== this.lastStep) {
      // heel strike: small dip and nod
      const k = (st.sprinting ? 1.3 : st.crouch > 0.5 ? 0.45 : 0.8) * this.bob;
      this.yS.kick(-0.16 * k);
      this.pitchS.kick(-0.05 * k);
    }
    this.lastStep = step;
    const amp = this.bob * (st.sprinting ? 1.45 : st.crouch > 0.5 ? 0.6 : 1);
    const bobY = -Math.abs(Math.sin(this.phase)) * 0.022 * amp + 0.011 * amp;
    const bobX = Math.sin(this.phase * 0.5) * 0.014 * amp;
    const bobRoll = Math.sin(this.phase * 0.5) * 0.006 * amp;
    // --- strafe lean
    const leanT = clamp(-st.strafe / 8, -1, 1) * 0.02 + (st.sliding ? 0 : 0);
    this.lean += (leanT - this.lean) * Math.min(1, dt * 6);
    // --- slide judder
    const judder = st.sliding ? (Math.sin(this.time * 47) * 0.6 + Math.sin(this.time * 71) * 0.4) * 0.0025 : 0;
    // --- explosion shake (smooth pseudo-noise)
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const tr = this.trauma * this.trauma;
    const nz = (f: number, o: number) => Math.sin(this.time * f + o) * 0.6 + Math.sin(this.time * f * 1.7 + o * 2.3) * 0.4;
    // --- springs
    const y = this.yS.step(dt);
    const p = this.pitchS.step(dt);
    const yw = this.yawS.step(dt);
    const r = this.rollS.step(dt);
    this.pos.x = (bobX + nz(23, 1) * 0.02 * tr) * s;
    this.pos.y = (bobY + y * 0.06 + nz(29, 4) * 0.02 * tr) * s;
    this.rot.pitch = (p * 0.03 + judder + nz(31, 2) * 0.012 * tr) * s;
    this.rot.yaw = (yw * 0.025 + nz(27, 5) * 0.01 * tr) * s;
    this.rot.roll = (bobRoll + this.lean + r * 0.035 + nz(19, 7) * 0.02 * tr) * s;
  }
}
