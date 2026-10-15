import { damageAt, fireInterval, type WeaponStats } from './weapons';
import { HEALTH } from './gameplay';
import { spreadDirection } from '@/game/sim/weaponLogic';

// Time-to-kill model used by `npm run balance` and the balance tests. Every shot is aimed at the
// center of the chest (body) or head and fired while fully aimed; single-projectile weapons
// always land, shotgun pellets land where their spread pattern puts them on a standing target.

export const RANGES = { close: 6, mid: 18, long: 38 } as const;
export type RangeName = keyof typeof RANGES;
export type AimPoint = 'body' | 'head';

/** Target silhouette relative to the chest center (meters): head circle and torso box. */
const HEAD = { y: 0.38, r: 0.13 };
const TORSO = { x: 0.21, top: 0.15, bottom: -0.45 };

/** Expected damage of one trigger pull at `dist`, aimed at `aim` (pellets averaged over seeds). */
export function shotDamage(w: WeaponStats, dist: number, aim: AimPoint): number {
  const base = damageAt(w, dist);
  if (!w.pellets) return base * (aim === 'head' ? w.headMul : (w.chestMul ?? 1));
  const spread = w.adsSpread;
  const trials = 64;
  let total = 0;
  for (let s = 0; s < trials; s++) {
    for (let i = 0; i < w.pellets; i++) {
      // yaw 0 / pitch 0 looks down -Z: x offset = d.x / -d.z, y offset = d.y / -d.z
      const d = spreadDirection(0, 0, spread, 1000 + s * 7, i, w.pelletSpread ?? 0);
      const ox = (d[0] / -d[2]) * dist;
      const oy = (d[1] / -d[2]) * dist + (aim === 'head' ? HEAD.y : 0);
      if (Math.hypot(ox, oy - HEAD.y) <= HEAD.r) total += base * w.headMul;
      else if (Math.abs(ox) <= TORSO.x && oy <= TORSO.top && oy >= TORSO.bottom) total += base * (oy > -0.15 ? (w.chestMul ?? 1) : 1);
    }
  }
  return total / trials;
}

export function shotsToKillAt(w: WeaponStats, dist: number, aim: AimPoint, hp = HEALTH.max): number {
  const per = shotDamage(w, dist, aim);
  return per <= 0.01 ? Infinity : Math.ceil(hp / per - 1e-9);
}

/** Milliseconds from the first shot to the killing shot. */
export function ttkMs(w: WeaponStats, shots: number): number {
  if (!Number.isFinite(shots)) return Infinity;
  if (w.fireMode === 'burst' && w.burstCount) {
    const per = w.burstCount;
    const bursts = Math.floor((shots - 1) / per);
    const inBurst = (shots - 1) % per;
    return Math.round((bursts * ((per - 1) * fireInterval(w) + (w.burstDelay ?? 0.25)) + inBurst * fireInterval(w)) * 1000);
  }
  return Math.round((shots - 1) * fireInterval(w) * 1000);
}

export interface TtkRow {
  id: string;
  name: string;
  cls: string;
  cells: Record<RangeName, Record<AimPoint, { shots: number; ms: number }>>;
}

export function ttkTable(weapons: WeaponStats[]): TtkRow[] {
  return weapons.map((w) => {
    const cells = {} as TtkRow['cells'];
    for (const r of Object.keys(RANGES) as RangeName[]) {
      cells[r] = {} as Record<AimPoint, { shots: number; ms: number }>;
      for (const aim of ['body', 'head'] as AimPoint[]) {
        const shots = shotsToKillAt(w, RANGES[r], aim);
        cells[r][aim] = { shots, ms: ttkMs(w, shots) };
      }
    }
    return { id: w.id, name: w.name, cls: w.class, cells };
  });
}
