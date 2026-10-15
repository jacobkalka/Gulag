import type { CollisionWorld } from '@/game/world/collision';
import type { WeaponStats } from '@/data/weapons';
import { BTN, type PlayerInput, type PlayerState } from './types';

// Character movement shared by host simulation and client-side prediction.
// Deterministic given (state, input, dt).

export const MOVE = {
  radius: 0.32,
  standH: 1.8,
  crouchH: 1.15,
  slideH: 0.95,
  eyeStand: 1.62,
  eyeCrouch: 1.02,
  eyeSlide: 0.82,
  step: 0.42,
  gravity: 22.5,
  jumpV: 6.5,
  walk: 5.8,
  sprint: 8.4,
  crouchSpeed: 3.2,
  backMul: 0.88,
  accel: 95,
  airAccel: 24,
  decel: 75,
  /** Minimum slide entry speed; faster entries keep their speed (momentum). */
  slideSpeed: 10.2,
  /** Extra speed added on slide entry. */
  slideBoost: 1.0,
  slideTime: 0.85,
  /** Friction (1/s) early in the slide and near its end. */
  slideFrictionStart: 0.9,
  slideFrictionEnd: 4.2,
  slideCd: 0.85,
  mantleMax: 1.35,
  mantleTime: 0.3,
  crouchRate: 12,
  snapDown: 0.45,
  /** Jump still allowed this long after running off a ledge. */
  coyoteTime: 0.1,
  /** A jump pressed this long before landing fires on touchdown. */
  jumpBuffer: 0.12,
};

export interface MoveResult {
  jumped: boolean;
  landed: number; // impact speed if landed this tick, else 0
  mantled: boolean;
  slid: boolean;
}

export function playerHeight(p: PlayerState): number {
  if (p.slideT > 0) return MOVE.slideH;
  return MOVE.standH + (MOVE.crouchH - MOVE.standH) * p.crouch;
}

export function eyeHeight(p: PlayerState): number {
  if (p.slideT > 0) return MOVE.eyeSlide;
  return MOVE.eyeStand + (MOVE.eyeCrouch - MOVE.eyeStand) * p.crouch;
}

function pressed(inp: PlayerInput, p: PlayerState, b: number): boolean {
  return (inp.buttons & b) !== 0 && (p.prevButtons & b) === 0;
}

export function stepMovement(p: PlayerState, inp: PlayerInput, world: CollisionWorld, dt: number, frozen: boolean, w: WeaponStats): MoveResult {
  const res: MoveResult = { jumped: false, landed: 0, mantled: false, slid: false };
  if (inp.life === undefined || inp.life === p.life) {
    p.yaw = inp.yaw;
    p.pitch = Math.max(-1.48, Math.min(1.48, inp.pitch));
  }
  if (p.slideCd > 0) p.slideCd -= dt;
  if (p.coyoteT > 0) p.coyoteT -= dt;
  if (p.jumpBufT > 0) p.jumpBufT -= dt;

  // ---- mantle in progress: scripted arc onto the ledge
  if (p.mantleT > 0) {
    p.mantleT -= dt;
    const t = 1 - Math.max(0, p.mantleT) / MOVE.mantleTime;
    const rise = Math.min(1, t / 0.6);
    const fwd = Math.max(0, (t - 0.35) / 0.65);
    p.x = p.mantleFrom[0] + (p.mantleTo[0] - p.mantleFrom[0]) * fwd;
    p.z = p.mantleFrom[2] + (p.mantleTo[2] - p.mantleFrom[2]) * fwd;
    p.y = p.mantleFrom[1] + (p.mantleTo[1] - p.mantleFrom[1]) * (1 - (1 - rise) * (1 - rise));
    p.vx = p.vz = p.vy = 0;
    if (p.mantleT <= 0) {
      p.mantleT = 0;
      p.grounded = true;
      p.y = p.mantleTo[1];
    }
    return res;
  }

  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);
  let mx = frozen ? 0 : Math.max(-1, Math.min(1, inp.mx));
  let mz = frozen ? 0 : Math.max(-1, Math.min(1, inp.mz));
  const ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }
  const wantCrouch = (inp.buttons & BTN.CROUCH) !== 0;
  const horizSpeed = Math.hypot(p.vx, p.vz);

  // ---- sprint
  const reloadingFull = p.reloadT > 0 && p.reloadKind !== 2;
  const canSprint = !frozen && p.grounded && mz > 0.5 && p.ads < 0.3 && p.slideT <= 0 && !(wantCrouch && p.crouch > 0.5) && !(inp.buttons & BTN.FIRE);
  p.sprinting = canSprint && (inp.buttons & BTN.SPRINT) !== 0 && !(reloadingFull && false);

  // ---- slide: sprint + crouch press
  if (!frozen && p.sprinting && pressed(inp, p, BTN.CROUCH) && p.slideCd <= 0 && horizSpeed > 5) {
    p.slideT = MOVE.slideTime;
    p.slideCd = MOVE.slideCd + MOVE.slideTime;
    const boost = Math.max(horizSpeed + MOVE.slideBoost, MOVE.slideSpeed);
    const hl = horizSpeed > 0.01 ? horizSpeed : 1;
    p.vx = (p.vx / hl) * boost;
    p.vz = (p.vz / hl) * boost;
    p.sprinting = false;
    res.slid = true;
  }

  // ---- crouch height (stand up only with headroom)
  let crouchTarget = wantCrouch ? 1 : 0;
  if (p.slideT > 0) crouchTarget = 1;
  if (crouchTarget < p.crouch && world.cylinderBlocked(p.x, p.y + 0.05, p.z, MOVE.radius * 0.95, MOVE.standH - 0.05)) crouchTarget = 1;
  if (p.crouch < crouchTarget) p.crouch = Math.min(crouchTarget, p.crouch + MOVE.crouchRate * dt);
  else if (p.crouch > crouchTarget) p.crouch = Math.max(crouchTarget, p.crouch - MOVE.crouchRate * dt);

  // ---- jump / mantle (a press in the air is buffered briefly; coyote time after a ledge)
  const jumpPress = !frozen && pressed(inp, p, BTN.JUMP);
  if (jumpPress && !p.grounded && p.coyoteT <= 0) p.jumpBufT = MOVE.jumpBuffer;
  const canGroundJump = p.grounded || p.coyoteT > 0;
  if (jumpPress || (p.jumpBufT > 0 && p.grounded && !frozen)) {
    if (jumpPress && tryMantle(p, world, fx, fz)) {
      res.mantled = true;
      p.jumpBufT = 0;
      return res;
    }
    if (canGroundJump && p.slideT > 0) {
      // jumping out of a slide: a hop that keeps the slide's horizontal momentum
      p.vy = MOVE.jumpV * 0.92;
      p.grounded = false;
      p.coyoteT = 0;
      p.jumpBufT = 0;
      p.slideT = 0;
      p.crouch = Math.min(p.crouch, 0.5);
      res.jumped = true;
    } else if (canGroundJump && p.crouch < 0.6) {
      p.vy = MOVE.jumpV;
      p.grounded = false;
      p.coyoteT = 0;
      p.jumpBufT = 0;
      res.jumped = true;
    } else if (p.grounded && p.crouch >= 0.6) {
      // jump while crouched = stand up
      p.crouch = Math.max(0, p.crouch - 0.01);
      p.jumpBufT = 0;
    }
  }
  // airborne auto-mantle when pushing into a ledge
  if (!frozen && !p.grounded && p.vy < 2 && mz > 0.5 && (inp.buttons & BTN.JUMP) !== 0) {
    if (tryMantle(p, world, fx, fz)) {
      res.mantled = true;
      return res;
    }
  }

  // ---- target velocity
  let speed = p.sprinting ? MOVE.sprint : MOVE.walk;
  speed = speed + (MOVE.crouchSpeed - speed) * p.crouch;
  speed *= 1 + (w.adsMove - 1) * p.ads;
  speed *= w.move;
  if (mz < -0.1) speed *= MOVE.backMul;
  const wx = (fx * mz + rx * mx) * speed;
  const wz = (fz * mz + rz * mx) * speed;

  if (p.slideT > 0) {
    p.slideT -= dt;
    // momentum-preserving slide: low friction at first, more toward the end
    const prog = 1 - Math.max(0, p.slideT) / MOVE.slideTime;
    const fr = MOVE.slideFrictionStart + (MOVE.slideFrictionEnd - MOVE.slideFrictionStart) * prog * prog;
    const f = Math.exp(-fr * dt);
    p.vx *= f;
    p.vz *= f;
    // steering: rotate the slide direction a little toward the strafe input
    p.vx += rx * mx * 4 * dt;
    p.vz += rz * mx * 4 * dt;
    if (p.slideT <= 0 || Math.hypot(p.vx, p.vz) < 2.6) p.slideT = 0;
  } else if (p.grounded) {
    const ax = wx - p.vx;
    const az = wz - p.vz;
    const al = Math.hypot(ax, az);
    const rate = ml > 0.01 ? MOVE.accel : MOVE.decel;
    const maxD = rate * dt;
    if (al <= maxD) {
      p.vx = wx;
      p.vz = wz;
    } else {
      p.vx += (ax / al) * maxD;
      p.vz += (az / al) * maxD;
    }
  } else if (ml > 0.01) {
    // air control: steer toward the wish direction without exceeding current speed much
    const cur = Math.hypot(p.vx, p.vz);
    p.vx += (wx - p.vx) * Math.min(1, MOVE.airAccel * dt * 0.15);
    p.vz += (wz - p.vz) * Math.min(1, MOVE.airAccel * dt * 0.15);
    const nl = Math.hypot(p.vx, p.vz);
    const cap = Math.max(cur, speed);
    if (nl > cap) {
      p.vx *= cap / nl;
      p.vz *= cap / nl;
    }
  }

  if (!p.grounded) p.vy -= MOVE.gravity * dt;

  // ---- integrate with substeps
  const h = playerHeight(p);
  const wasGrounded = p.grounded;
  const preVy = p.vy;
  const disp = Math.hypot(p.vx, p.vz, p.vy) * dt;
  const steps = Math.max(1, Math.ceil(disp / (MOVE.radius * 0.5)));
  const sdt = dt / steps;
  const startX = p.x;
  const startZ = p.z;
  let landedThis = false;
  for (let s = 0; s < steps; s++) {
    p.x += p.vx * sdt;
    p.z += p.vz * sdt;
    world.resolveCylinder(p, MOVE.radius, h, MOVE.step);
    p.y += p.vy * sdt;
    // ground
    const sup = world.supportHeight(p.x, p.z, MOVE.radius, p.y, MOVE.step, 2);
    if (p.vy <= 0 && sup.y > -Infinity && sup.y >= p.y - 1e-3) {
      if (!p.grounded) landedThis = true;
      p.y = sup.y;
      p.vy = 0;
      p.grounded = true;
    } else if (p.grounded && p.vy <= 0 && sup.y > -Infinity && p.y - sup.y <= MOVE.snapDown) {
      p.y = sup.y; // stick to slopes / stairs going down
      p.vy = 0;
    } else {
      if (p.grounded && p.vy <= 0) p.coyoteT = MOVE.coyoteTime;
      p.grounded = false;
    }
    // ceiling
    if (p.vy > 0) {
      const ceil = world.ceilingHeight(p.x, p.z, MOVE.radius * 0.9, p.y + 0.2);
      if (p.y + h > ceil) {
        p.y = ceil - h;
        p.vy = 0;
      }
    }
  }
  // velocity follows the actual horizontal displacement (slide along walls)
  if (steps > 0 && p.slideT <= 0) {
    const ax = (p.x - startX) / dt;
    const az = (p.z - startZ) / dt;
    const want = Math.hypot(p.vx, p.vz);
    const got = Math.hypot(ax, az);
    if (got < want - 0.01) {
      p.vx = ax;
      p.vz = az;
    }
  }
  // safety: never fall out of the world
  if (p.y < -5) {
    p.y = 0.5;
    p.vy = 0;
  }
  if (landedThis && !wasGrounded) res.landed = -preVy;
  return res;
}

/** Climb onto a ledge in front of the player if it is within reach and there is room on top. */
function tryMantle(p: PlayerState, world: CollisionWorld, fx: number, fz: number): boolean {
  const r = MOVE.radius;
  // something solid directly in front, between the shins and the chest
  if (!world.cylinderBlocked(p.x + fx * (r + 0.12), p.y + 0.15, p.z + fz * (r + 0.12), 0.1, 0.9)) return false;
  const reach = r + 0.42;
  const px = p.x + fx * reach;
  const pz = p.z + fz * reach;
  const sup = world.supportHeight(px, pz, r * 0.7, p.y, MOVE.mantleMax, 0);
  if (sup.y === -Infinity) return false;
  const rise = sup.y - p.y;
  const minRise = p.grounded ? MOVE.step : 0.12;
  if (rise <= minRise || rise > MOVE.mantleMax) return false;
  // headroom above the player while rising and on top of the ledge
  if (world.cylinderBlocked(p.x, sup.y + 0.02, p.z, r * 0.9, MOVE.crouchH)) return false;
  if (world.cylinderBlocked(px, sup.y + 0.02, pz, r * 0.9, MOVE.crouchH)) return false;
  p.mantleT = MOVE.mantleTime;
  p.mantleFrom = [p.x, p.y, p.z];
  p.mantleTo = [px, sup.y, pz];
  p.slideT = 0;
  p.sprinting = false;
  p.grounded = false;
  // land crouched if a standing height won't fit
  if (world.cylinderBlocked(px, sup.y + 0.02, pz, r * 0.9, MOVE.standH)) p.crouch = 1;
  return true;
}
