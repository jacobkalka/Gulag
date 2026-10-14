import { getWeapon, type WeaponStats } from '@/data/weapons';
import { DEG } from '@/shared/math';
import { BTN, type GameEvent, type PlayerInput, type PlayerState } from './types';
import { MOVE } from './movement';

// Weapon state machine (fire modes, ammo, reloads, swaps, ADS, bloom, melee).
// Runs identically on the host and the predicting client.

export interface FireRequest {
  shooter: number;
  weapon: WeaponStats;
  /** Seed for deterministic spread (shared by host and client). */
  seed: number;
  yaw: number;
  pitch: number;
  spread: number;
  viewTick: number;
}

export function activeWeapon(p: PlayerState): WeaponStats {
  return getWeapon(p.weapons[p.slot].id);
}

function edge(inp: PlayerInput, p: PlayerState, b: number): boolean {
  return (inp.buttons & b) !== 0 && (p.prevButtons & b) === 0;
}

/** Cone half-angle in degrees for the next shot. */
export function currentSpread(p: PlayerState, w: WeaponStats): number {
  const speed = Math.hypot(p.vx, p.vz);
  let s = w.hipSpread + (w.adsSpread - w.hipSpread) * p.ads;
  s += w.moveSpread * Math.min(1, speed / MOVE.walk) * (1 - p.ads * 0.6);
  s += p.bloom;
  if (!p.grounded) s += 2.5 * (1 - p.ads * 0.5);
  if (p.slideT > 0) s += 1.5;
  s *= 1 - p.crouch * 0.15;
  return Math.max(0, s);
}

/** Small integer hash -> [0,1). */
export function hashSeed(a: number, b: number, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Direction of a shot/pellet after spread, as a unit vector. */
export function spreadDirection(yaw: number, pitch: number, spreadDeg: number, seed: number, pellet: number, pelletSpreadDeg = 0): [number, number, number] {
  const cp = Math.cos(pitch);
  const f = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  // basis around f
  const rgt = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [f[1] * rgt[2] - f[2] * rgt[1], f[2] * rgt[0] - f[0] * rgt[2], f[0] * rgt[1] - f[1] * rgt[0]];
  const ang = (spreadDeg + pelletSpreadDeg) * DEG;
  const u = hashSeed(seed, pellet, 1);
  const v = hashSeed(seed, pellet, 2);
  // shotgun pellets: fixed pattern ring + jitter keeps spread consistent shot to shot
  let r: number;
  let theta: number;
  if (pelletSpreadDeg > 0) {
    const ring = pellet === 0 ? 0 : pellet < 4 ? 0.45 : 0.9;
    r = (ring * 0.75 + u * 0.25) * ang;
    theta = (pellet / 8) * Math.PI * 2 * 2.39996 + v * 0.5;
  } else {
    r = Math.sqrt(u) * ang;
    theta = v * Math.PI * 2;
  }
  const ox = Math.cos(theta) * Math.tan(r);
  const oy = Math.sin(theta) * Math.tan(r);
  const d = [f[0] + rgt[0] * ox + up[0] * oy, f[1] + rgt[1] * ox + up[1] * oy, f[2] + rgt[2] * ox + up[2] * oy];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** View kick for a shot (radians): applied to the shooter's own aim client-side (and by bots). */
export function recoilKick(w: WeaponStats, recoilIdx: number, seed: number, ads: number): { pitch: number; yaw: number } {
  const r = w.recoil;
  const m = 1 + (r.adsMul - 1) * ads;
  const first = recoilIdx <= 1 ? r.first : 1;
  // vertical kick ramps slightly through a spray, then plateaus
  const ramp = 1 + Math.min(recoilIdx, 12) * 0.025;
  const up = r.up * first * ramp * m;
  const side = (hashSeed(seed, 7, 3) * 2 - 1) * r.side * m + r.drift * m * Math.min(recoilIdx, 10) * 0.25;
  return { pitch: up * DEG, yaw: -side * DEG };
}

export function totalAmmo(p: PlayerState): number {
  const wr = p.weapons[p.slot];
  return wr.mag + wr.reserve;
}

function startReload(p: PlayerState, w: WeaponStats, events: GameEvent[]): void {
  const wr = p.weapons[p.slot];
  if (wr.mag >= w.magSize || wr.reserve <= 0 || p.reloadT > 0) return;
  if (w.reloadPerRound) {
    p.reloadKind = 2;
    p.reloadT = w.reloadPerRound + (wr.mag === 0 ? 0.25 : 0);
  } else {
    p.reloadKind = wr.mag === 0 ? 1 : 0;
    p.reloadT = wr.mag === 0 ? w.reloadEmpty : w.reload;
  }
  p.reloadTotal = p.reloadT;
  p.burstLeft = 0;
  events.push({ type: 'reload', player: p.id, weapon: w.id, duration: p.reloadT, kind: p.reloadKind });
}

/**
 * Advances weapon timers and handles input. Returns a fire request when a round leaves the barrel.
 */
export function stepWeapon(p: PlayerState, inp: PlayerInput, dt: number, frozen: boolean, now: number, events: GameEvent[]): FireRequest | null {
  let w = activeWeapon(p);
  if (p.fireCd > 0) p.fireCd -= dt;
  if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - w.bloomRecover * dt);
  if (now - p.lastShotT > 0.32) p.recoilIdx = 0;

  // ---- weapon swap (explicit slot or swap button)
  let wantSlot = inp.slot === 0 || inp.slot === 1 ? inp.slot : p.slot;
  if (edge(inp, p, BTN.SWAP)) wantSlot = p.slot === 0 ? 1 : 0;
  if (wantSlot !== p.slot && p.meleeT <= 0) {
    p.slot = wantSlot as 0 | 1;
    w = activeWeapon(p);
    p.swapT = w.equip;
    p.reloadT = 0;
    p.burstLeft = 0;
    p.ads = 0;
    p.fireCd = 0;
    events.push({ type: 'swap', player: p.id, slot: p.slot });
  }
  if (p.swapT > 0) p.swapT -= dt;

  // ---- sprint blend (sprint-to-fire delay)
  if (p.sprinting) p.sprintBlend = 1;
  else if (p.sprintBlend > 0) p.sprintBlend = Math.max(0, p.sprintBlend - dt / Math.max(0.05, w.sprintToFire));

  // ---- ADS
  const wantAds = (inp.buttons & BTN.ADS) !== 0 && !p.sprinting && p.swapT <= 0 && p.slideT <= 0 && p.mantleT <= 0 && !frozen;
  const adsRate = dt / Math.max(0.05, w.ads);
  p.ads = wantAds ? Math.min(1, p.ads + adsRate) : Math.max(0, p.ads - adsRate * 1.4);

  // ---- melee
  if (p.meleeT > 0) {
    p.meleeT -= dt;
  } else if (!frozen && edge(inp, p, BTN.MELEE) && p.swapT <= 0) {
    p.meleeT = 0.62;
    p.meleeHitDone = false;
    p.reloadT = 0;
    p.burstLeft = 0;
  }

  // ---- reload progress
  const wr = p.weapons[p.slot];
  if (p.reloadT > 0) {
    p.reloadT -= dt;
    // shell-by-shell reloads can be interrupted by firing
    if (p.reloadKind === 2 && (inp.buttons & BTN.FIRE) && wr.mag > 0) {
      p.reloadT = 0;
    } else if (p.reloadT <= 0) {
      if (p.reloadKind === 2) {
        wr.mag += 1;
        wr.reserve -= 1;
        if (wr.mag < w.magSize && wr.reserve > 0) {
          p.reloadT = w.reloadPerRound!;
          p.reloadTotal = p.reloadT;
        } else p.reloadT = 0;
      } else {
        const take = Math.min(w.magSize - wr.mag, wr.reserve);
        wr.mag += take;
        wr.reserve -= take;
        p.reloadT = 0;
      }
    }
  }
  if (!frozen && edge(inp, p, BTN.RELOAD) && p.swapT <= 0 && p.meleeT <= 0) startReload(p, w, events);

  // ---- fire
  const fireHeld = (inp.buttons & BTN.FIRE) !== 0;
  const firePressed = edge(inp, p, BTN.FIRE);
  const busy = frozen || p.swapT > 0 || p.meleeT > 0 || p.mantleT > 0 || (p.reloadT > 0 && p.reloadKind !== 2) || p.slideT > 0.1;
  if (busy) {
    if (p.burstLeft > 0 && (p.reloadT > 0 || p.swapT > 0)) p.burstLeft = 0;
    return null;
  }
  if (fireHeld && p.sprinting) return null; // sprint is cancelled by movement code next tick
  if (p.sprintBlend > 0.05) return null;
  let trigger = false;
  if (w.fireMode === 'auto') trigger = fireHeld;
  else if (w.fireMode === 'burst') {
    if (p.burstLeft > 0) trigger = true;
    else if (firePressed && p.fireCd <= 0) {
      p.burstLeft = w.burstCount ?? 3;
      trigger = true;
    }
  } else trigger = firePressed;
  if (!trigger || p.fireCd > 0) return null;
  if (wr.mag <= 0) {
    p.burstLeft = 0;
    if (firePressed || fireHeld) startReload(p, w, events);
    return null;
  }
  // ---- release a round
  wr.mag -= 1;
  p.shotCount += 1;
  p.recoilIdx += 1;
  p.lastShotT = now;
  p.spawnProt = 0;
  p.stats.shots += 1;
  const spread = currentSpread(p, w);
  p.bloom = Math.min(w.bloomMax, p.bloom + w.bloomPerShot * (1 - p.ads * 0.3));
  let interval = 60 / w.rpm;
  if (w.fireMode === 'burst') {
    p.burstLeft -= 1;
    if (p.burstLeft <= 0) interval = w.burstDelay ?? 0.25;
  }
  p.fireCd += interval;
  if (p.fireCd < interval * 0.5) p.fireCd = interval;
  events.push({ type: 'fire', shooter: p.id, weapon: w.id });
  return { shooter: p.id, weapon: w, seed: (p.id * 7919 + p.shotCount * 104729) >>> 0, yaw: p.yaw, pitch: p.pitch, spread, viewTick: inp.viewTick };
}
