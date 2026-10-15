// Every weapon stat lives here for easy balancing. All names and designs are original.
//
// Units: meters, seconds, degrees, damage points (players have 100 HP).
// damage: [[distance, damage], ...] is linearly interpolated, clamped at the ends.

export type WeaponClass = 'pistol' | 'smg' | 'ar' | 'shotgun' | 'marksman' | 'sniper' | 'lmg';
export type FireMode = 'auto' | 'semi' | 'burst' | 'pump' | 'bolt';
export type WeaponSlot = 'primary' | 'secondary';

export interface RecoilSpec {
  /** Upward kick per shot (degrees). */
  up: number;
  /** Random horizontal kick range per shot (+/- degrees). */
  side: number;
  /** Consistent horizontal drift per shot (degrees, + = right). */
  drift: number;
  /** First-shot multiplier (pistols/ARs feel snappy on the first round). */
  first: number;
  /** Multiplier while aiming down sights. */
  adsMul: number;
  /** How fast the view settles back after you stop firing (fraction per second of the climb recovered). */
  recover: number;
}

export interface WeaponStats {
  id: string;
  name: string;
  class: WeaponClass;
  slot: WeaponSlot;
  unlockLevel: number;
  description: string;
  fireMode: FireMode;
  rpm: number;
  burstCount?: number;
  /** Pause between bursts (s). */
  burstDelay?: number;
  damage: [number, number][];
  pellets?: number;
  headMul: number;
  /** Upper-chest multiplier (default 1). Lets the sniper keep its one-shot to the upper body. */
  chestMul?: number;
  limbMul: number;
  magSize: number;
  reserve: number;
  reload: number;
  reloadEmpty: number;
  /** Shell-by-shell reload time per round (pump shotguns, revolvers); overrides magazine reload. */
  reloadPerRound?: number;
  equip: number;
  ads: number;
  /** FOV divisor while fully aimed (1.25 = 25% zoom). */
  zoom: number;
  scope?: boolean;
  sprintToFire: number;
  /** Movement speed multiplier while holding this weapon. */
  move: number;
  /** Additional movement multiplier while aiming. */
  adsMove: number;
  hipSpread: number;
  adsSpread: number;
  /** Extra spread when moving at full speed (deg). */
  moveSpread: number;
  bloomPerShot: number;
  bloomMax: number;
  /** Bloom recovery (deg per second). */
  bloomRecover: number;
  /** Shotgun pellet cone (deg). */
  pelletSpread?: number;
  recoil: RecoilSpec;
  /** Effective range shown on the stat bars (m). */
  range: number;
  /** Visual model id (see assets/models/weapons.ts). */
  model: string;
  /** Audio synthesis profile. */
  sound: { body: number; crack: number; tail: number; pitch: number; mech: number };
  /** Every Nth round is a tracer (shotguns: the lead pellet of every Nth shell). */
  tracerEvery: number;
}

export const WEAPONS: WeaponStats[] = [
  // ----------------------------------------------------------- PISTOLS (secondary)
  {
    id: 'warden', name: 'Warden 9', class: 'pistol', slot: 'secondary', unlockLevel: 1,
    description: 'Dependable 9mm sidearm. Quick to draw, quicker to aim.',
    fireMode: 'semi', rpm: 420, damage: [[0, 20], [12, 16], [26, 12.5]], headMul: 1.5, limbMul: 0.9,
    magSize: 15, reserve: 60, reload: 1.35, reloadEmpty: 1.6, equip: 0.35, ads: 0.15, zoom: 1.15, sprintToFire: 0.1,
    move: 1.05, adsMove: 0.8, hipSpread: 2.2, adsSpread: 0.25, moveSpread: 1.0, bloomPerShot: 0.35, bloomMax: 2.2, bloomRecover: 6,
    recoil: { up: 1.1, side: 0.35, drift: 0.05, first: 1.2, adsMul: 0.75, recover: 3.5 },
    range: 18, model: 'warden', sound: { body: 0.6, crack: 0.8, tail: 0.4, pitch: 1.25, mech: 0.6 }, tracerEvery: 4,
  },
  {
    id: 'ironjaw', name: 'Ironjaw .45', class: 'pistol', slot: 'secondary', unlockLevel: 5,
    description: 'Six-shot revolver. Three to the chest ends most arguments.',
    fireMode: 'semi', rpm: 180, damage: [[0, 40], [16, 35], [32, 24]], headMul: 1.6, limbMul: 0.85,
    magSize: 6, reserve: 30, reload: 2.3, reloadEmpty: 2.3, equip: 0.45, ads: 0.2, zoom: 1.2, sprintToFire: 0.14,
    move: 1.02, adsMove: 0.8, hipSpread: 2.8, adsSpread: 0.2, moveSpread: 1.2, bloomPerShot: 0.8, bloomMax: 2.6, bloomRecover: 5,
    recoil: { up: 3.4, side: 0.8, drift: 0.2, first: 1.0, adsMul: 0.8, recover: 3.0 },
    range: 22, model: 'ironjaw', sound: { body: 1.1, crack: 0.9, tail: 0.8, pitch: 0.85, mech: 0.9 }, tracerEvery: 3,
  },
  {
    id: 'wasp', name: 'Wasp MP', class: 'pistol', slot: 'secondary', unlockLevel: 14,
    description: 'Full-auto machine pistol. Empties fast, hits hard up close.',
    fireMode: 'auto', rpm: 1100, damage: [[0, 13.5], [7, 11], [16, 8.5]], headMul: 1.35, limbMul: 0.9,
    magSize: 22, reserve: 88, reload: 1.5, reloadEmpty: 1.8, equip: 0.35, ads: 0.14, zoom: 1.12, sprintToFire: 0.1,
    move: 1.04, adsMove: 0.82, hipSpread: 3.0, adsSpread: 0.6, moveSpread: 1.2, bloomPerShot: 0.12, bloomMax: 2.0, bloomRecover: 7,
    recoil: { up: 0.42, side: 0.4, drift: -0.05, first: 1.0, adsMul: 0.8, recover: 4.0 },
    range: 10, model: 'wasp', sound: { body: 0.5, crack: 0.7, tail: 0.3, pitch: 1.35, mech: 0.4 }, tracerEvery: 5,
  },
  // ----------------------------------------------------------- SMGs
  {
    id: 'rook9', name: 'Rook-9', class: 'smg', slot: 'primary', unlockLevel: 1,
    description: 'Fast-firing 9mm SMG built for tight corridors.',
    fireMode: 'auto', rpm: 900, damage: [[0, 16], [9, 14], [21, 10.5]], headMul: 1.35, limbMul: 0.9,
    magSize: 32, reserve: 128, reload: 1.8, reloadEmpty: 2.2, equip: 0.4, ads: 0.18, zoom: 1.2, sprintToFire: 0.14,
    move: 1.0, adsMove: 0.72, hipSpread: 2.6, adsSpread: 0.35, moveSpread: 0.9, bloomPerShot: 0.05, bloomMax: 1.2, bloomRecover: 6,
    recoil: { up: 0.34, side: 0.28, drift: 0.04, first: 1.0, adsMul: 0.7, recover: 4.0 },
    range: 14, model: 'rook9', sound: { body: 0.6, crack: 0.75, tail: 0.45, pitch: 1.15, mech: 0.5 }, tracerEvery: 4,
  },
  {
    id: 'kestrel', name: 'Kestrel PDW', class: 'smg', slot: 'primary', unlockLevel: 4,
    description: 'Compact defense weapon with a long reach for an SMG.',
    fireMode: 'auto', rpm: 820, damage: [[0, 18], [12, 15.5], [25, 12]], headMul: 1.35, limbMul: 0.9,
    magSize: 40, reserve: 160, reload: 2.0, reloadEmpty: 2.4, equip: 0.42, ads: 0.2, zoom: 1.25, sprintToFire: 0.15,
    move: 0.99, adsMove: 0.7, hipSpread: 2.8, adsSpread: 0.3, moveSpread: 0.9, bloomPerShot: 0.05, bloomMax: 1.1, bloomRecover: 6,
    recoil: { up: 0.38, side: 0.24, drift: -0.06, first: 1.0, adsMul: 0.68, recover: 4.0 },
    range: 18, model: 'kestrel', sound: { body: 0.65, crack: 0.8, tail: 0.5, pitch: 1.1, mech: 0.5 }, tracerEvery: 4,
  },
  {
    id: 'riptide', name: 'Riptide', class: 'smg', slot: 'primary', unlockLevel: 17,
    description: 'Drum-fed hose. Sixty rounds of keep-your-head-down.',
    fireMode: 'auto', rpm: 1000, damage: [[0, 14.5], [8, 12], [18, 9.5]], headMul: 1.3, limbMul: 0.9,
    magSize: 60, reserve: 180, reload: 2.8, reloadEmpty: 3.2, equip: 0.5, ads: 0.22, zoom: 1.18, sprintToFire: 0.16,
    move: 0.97, adsMove: 0.7, hipSpread: 2.4, adsSpread: 0.45, moveSpread: 0.9, bloomPerShot: 0.04, bloomMax: 1.3, bloomRecover: 6,
    recoil: { up: 0.3, side: 0.34, drift: 0.08, first: 1.0, adsMul: 0.72, recover: 4.0 },
    range: 12, model: 'riptide', sound: { body: 0.55, crack: 0.7, tail: 0.45, pitch: 1.2, mech: 0.45 }, tracerEvery: 5,
  },
  // ----------------------------------------------------------- ASSAULT RIFLES
  {
    id: 'halberd', name: 'Halberd AR', class: 'ar', slot: 'primary', unlockLevel: 1,
    description: 'Balanced 5.56 rifle. Wins at any range if you do your part.',
    fireMode: 'auto', rpm: 760, damage: [[0, 19.5], [22, 17], [45, 13.5]], headMul: 1.5, limbMul: 0.85,
    magSize: 30, reserve: 120, reload: 2.1, reloadEmpty: 2.6, equip: 0.5, ads: 0.25, zoom: 1.3, sprintToFire: 0.22,
    move: 0.95, adsMove: 0.62, hipSpread: 3.4, adsSpread: 0.12, moveSpread: 1.4, bloomPerShot: 0.04, bloomMax: 0.8, bloomRecover: 6,
    recoil: { up: 0.5, side: 0.22, drift: 0.07, first: 1.25, adsMul: 0.62, recover: 3.5 },
    range: 38, model: 'halberd', sound: { body: 0.9, crack: 1.0, tail: 0.8, pitch: 1.0, mech: 0.7 }, tracerEvery: 4,
  },
  {
    id: 'talon', name: 'Talon AR', class: 'ar', slot: 'primary', unlockLevel: 11,
    description: 'High cyclic rate rifle. Trades range for a brutal close TTK.',
    fireMode: 'auto', rpm: 860, damage: [[0, 17.5], [18, 15], [38, 12]], headMul: 1.45, limbMul: 0.85,
    magSize: 32, reserve: 128, reload: 2.0, reloadEmpty: 2.5, equip: 0.48, ads: 0.23, zoom: 1.28, sprintToFire: 0.2,
    move: 0.97, adsMove: 0.65, hipSpread: 3.2, adsSpread: 0.15, moveSpread: 1.3, bloomPerShot: 0.05, bloomMax: 0.9, bloomRecover: 6,
    recoil: { up: 0.46, side: 0.3, drift: -0.08, first: 1.2, adsMul: 0.64, recover: 3.5 },
    range: 30, model: 'talon', sound: { body: 0.85, crack: 1.0, tail: 0.7, pitch: 1.06, mech: 0.6 }, tracerEvery: 4,
  },
  {
    id: 'cinder', name: 'Cinder Carbine', class: 'ar', slot: 'primary', unlockLevel: 7,
    description: 'Four-round burst carbine. One clean burst drops a target up close.',
    fireMode: 'burst', rpm: 900, burstCount: 4, burstDelay: 0.36, damage: [[0, 28], [10, 25.5], [28, 22], [50, 19]], headMul: 1.45, limbMul: 0.85,
    magSize: 30, reserve: 120, reload: 2.2, reloadEmpty: 2.6, equip: 0.5, ads: 0.24, zoom: 1.35, sprintToFire: 0.22,
    move: 0.95, adsMove: 0.62, hipSpread: 3.2, adsSpread: 0.1, moveSpread: 1.4, bloomPerShot: 0.03, bloomMax: 0.6, bloomRecover: 6,
    recoil: { up: 0.62, side: 0.18, drift: 0.05, first: 1.0, adsMul: 0.6, recover: 4.5 },
    range: 42, model: 'cinder', sound: { body: 0.9, crack: 1.05, tail: 0.85, pitch: 0.98, mech: 0.7 }, tracerEvery: 4,
  },
  {
    id: 'anvil', name: 'Anvil-30 BR', class: 'ar', slot: 'primary', unlockLevel: 20,
    description: 'Full-power battle rifle. Four hits at nearly any range, heavy kick.',
    fireMode: 'auto', rpm: 520, damage: [[0, 29], [32, 26], [60, 23.5]], headMul: 1.4, limbMul: 0.85,
    magSize: 20, reserve: 80, reload: 2.4, reloadEmpty: 2.9, equip: 0.6, ads: 0.3, zoom: 1.6, sprintToFire: 0.26,
    move: 0.92, adsMove: 0.58, hipSpread: 4.0, adsSpread: 0.1, moveSpread: 1.6, bloomPerShot: 0.06, bloomMax: 0.9, bloomRecover: 6,
    recoil: { up: 1.05, side: 0.35, drift: 0.12, first: 1.1, adsMul: 0.6, recover: 3.0 },
    range: 50, model: 'anvil', sound: { body: 1.15, crack: 1.1, tail: 1.0, pitch: 0.85, mech: 0.8 }, tracerEvery: 3,
  },
  // ----------------------------------------------------------- SHOTGUNS
  {
    id: 'thresher', name: 'Thresher-12', class: 'shotgun', slot: 'primary', unlockLevel: 2,
    description: 'Pump-action 12 gauge. Owns every doorway in the building.',
    fireMode: 'pump', rpm: 72, damage: [[0, 15], [5, 12], [11, 6], [18, 2]], pellets: 8, pelletSpread: 3.4, headMul: 1.25, limbMul: 0.9,
    magSize: 6, reserve: 24, reload: 0.5, reloadEmpty: 0.5, reloadPerRound: 0.48, equip: 0.55, ads: 0.24, zoom: 1.15, sprintToFire: 0.2,
    move: 0.97, adsMove: 0.7, hipSpread: 1.2, adsSpread: 0.6, moveSpread: 0.4, bloomPerShot: 0, bloomMax: 0, bloomRecover: 6,
    recoil: { up: 4.5, side: 0.9, drift: 0, first: 1.0, adsMul: 0.85, recover: 3.0 },
    range: 9, model: 'thresher', sound: { body: 1.4, crack: 0.9, tail: 1.1, pitch: 0.7, mech: 1.0 }, tracerEvery: 2,
  },
  {
    id: 'cyclone', name: 'Cyclone Auto', class: 'shotgun', slot: 'primary', unlockLevel: 24,
    description: 'Magazine-fed semi-auto shotgun. Fast follow-ups, shorter reach.',
    fireMode: 'semi', rpm: 210, damage: [[0, 11], [5, 8], [10, 4], [15, 1.5]], pellets: 8, pelletSpread: 3.8, headMul: 1.2, limbMul: 0.9,
    magSize: 8, reserve: 32, reload: 2.5, reloadEmpty: 2.9, equip: 0.55, ads: 0.24, zoom: 1.15, sprintToFire: 0.2,
    move: 0.96, adsMove: 0.7, hipSpread: 1.4, adsSpread: 0.7, moveSpread: 0.4, bloomPerShot: 0.2, bloomMax: 1.0, bloomRecover: 5,
    recoil: { up: 2.6, side: 0.8, drift: 0.1, first: 1.0, adsMul: 0.85, recover: 3.5 },
    range: 8, model: 'cyclone', sound: { body: 1.25, crack: 0.85, tail: 1.0, pitch: 0.78, mech: 0.8 }, tracerEvery: 3,
  },
  // ----------------------------------------------------------- MARKSMAN / SNIPER
  {
    id: 'lancet', name: 'Lancet DMR', class: 'marksman', slot: 'primary', unlockLevel: 9,
    description: 'Semi-auto marksman rifle with a 2x optic. Three body shots, two to the head.',
    fireMode: 'semi', rpm: 345, damage: [[0, 40], [40, 36], [70, 32]], headMul: 1.75, limbMul: 0.85,
    magSize: 15, reserve: 60, reload: 2.4, reloadEmpty: 2.9, equip: 0.6, ads: 0.32, zoom: 2.0, sprintToFire: 0.28,
    move: 0.92, adsMove: 0.55, hipSpread: 4.5, adsSpread: 0.05, moveSpread: 2.0, bloomPerShot: 0.15, bloomMax: 0.6, bloomRecover: 4,
    recoil: { up: 1.9, side: 0.4, drift: 0.1, first: 1.0, adsMul: 0.65, recover: 4.0 },
    range: 60, model: 'lancet', sound: { body: 1.2, crack: 1.2, tail: 1.1, pitch: 0.9, mech: 0.8 }, tracerEvery: 3,
  },
  {
    id: 'vigil', name: 'Vigil .338', class: 'sniper', slot: 'primary', unlockLevel: 32,
    description: 'Bolt-action precision rifle. One shot to the upper body. Be sure.',
    fireMode: 'bolt', rpm: 46, damage: [[0, 92], [60, 88]], headMul: 2.0, chestMul: 1.15, limbMul: 0.8,
    magSize: 5, reserve: 20, reload: 2.8, reloadEmpty: 3.3, equip: 0.7, ads: 0.45, zoom: 4.0, scope: true, sprintToFire: 0.34,
    move: 0.88, adsMove: 0.5, hipSpread: 8.0, adsSpread: 0.0, moveSpread: 3.0, bloomPerShot: 0, bloomMax: 0, bloomRecover: 4,
    recoil: { up: 5.5, side: 0.6, drift: 0.2, first: 1.0, adsMul: 0.7, recover: 3.0 },
    range: 80, model: 'vigil', sound: { body: 1.6, crack: 1.4, tail: 1.5, pitch: 0.7, mech: 1.0 }, tracerEvery: 2,
  },
  // ----------------------------------------------------------- LMG
  {
    id: 'bulwark', name: 'Bulwark LMG', class: 'lmg', slot: 'primary', unlockLevel: 28,
    description: 'Belt of 100 rounds and a bipod you will never get to use. Suppressive.',
    fireMode: 'auto', rpm: 680, damage: [[0, 20], [30, 17.5], [55, 15]], headMul: 1.4, limbMul: 0.85,
    magSize: 100, reserve: 200, reload: 4.4, reloadEmpty: 4.8, equip: 0.7, ads: 0.38, zoom: 1.35, sprintToFire: 0.32,
    move: 0.85, adsMove: 0.5, hipSpread: 4.2, adsSpread: 0.2, moveSpread: 1.8, bloomPerShot: 0.03, bloomMax: 1.0, bloomRecover: 5,
    recoil: { up: 0.42, side: 0.32, drift: 0.06, first: 1.1, adsMul: 0.6, recover: 3.0 },
    range: 45, model: 'bulwark', sound: { body: 1.05, crack: 1.05, tail: 0.95, pitch: 0.9, mech: 0.8 }, tracerEvery: 3,
  },
];

/**
 * Input-mode tuning, applied by the host from each player's declared mode (never a client value).
 * Touchpad players get much tighter hip fire, gentler visual recoil and a little hit forgiveness.
 */
export const INPUT_TUNING = {
  touchpad: {
    /** Hip-fire spread multiplier; clamped to 0.4..0.5 wherever it is used. */
    hipSpreadMul: 0.45,
    /** Camera and weapon kick multiplier (visual recoil). */
    visualRecoilMul: 0.55,
    /** Aim climb multiplier (the part of recoil that moves your view). */
    recoilMul: 0.8,
    /** Extra hitbox radius for shots fired by touchpad players (m); clamped to 0..0.05. */
    hitForgiveness: 0.035,
  },
};

export function touchpadHipMul(): number {
  return Math.min(0.5, Math.max(0.4, INPUT_TUNING.touchpad.hipSpreadMul));
}

export function touchpadForgiveness(): number {
  return Math.min(0.05, Math.max(0, INPUT_TUNING.touchpad.hitForgiveness));
}

export const WEAPON_MAP: Record<string, WeaponStats> = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export const WEAPON_INDEX: Record<string, number> = Object.fromEntries(WEAPONS.map((w, i) => [w.id, i]));

export function getWeapon(id: string): WeaponStats {
  return WEAPON_MAP[id] ?? WEAPON_MAP.halberd;
}

/** Damage for one bullet/pellet at distance (before hitbox multiplier). */
export function damageAt(w: WeaponStats, dist: number): number {
  const d = w.damage;
  if (dist <= d[0][0]) return d[0][1];
  for (let i = 1; i < d.length; i++) {
    if (dist <= d[i][0]) {
      const [x0, y0] = d[i - 1];
      const [x1, y1] = d[i];
      return y0 + ((dist - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return d[d.length - 1][1];
}

export type Hitbox = 'head' | 'chest' | 'stomach' | 'legs';

export function hitboxMultiplier(w: WeaponStats, hb: Hitbox): number {
  if (hb === 'head') return w.headMul;
  if (hb === 'legs') return w.limbMul;
  if (hb === 'chest') return w.chestMul ?? 1;
  return 1;
}

/** Seconds between shots. */
export function fireInterval(w: WeaponStats): number {
  return 60 / w.rpm;
}

/** Shots to kill a 100 HP target at distance, to the body. */
export function shotsToKill(w: WeaponStats, dist: number, hb: Hitbox = 'chest'): number {
  const per = damageAt(w, dist) * hitboxMultiplier(w, hb) * (w.pellets ?? 1);
  return Math.ceil(100 / Math.max(0.01, per));
}

/** Time to kill (ms) at distance with every shot landing on `hb`. */
export function timeToKill(w: WeaponStats, dist: number, hb: Hitbox = 'chest'): number {
  const n = shotsToKill(w, dist, hb);
  if (w.fireMode === 'burst' && w.burstCount) {
    const perBurst = w.burstCount;
    const bursts = Math.floor((n - 1) / perBurst);
    const inBurst = (n - 1) % perBurst;
    return Math.round((bursts * ((perBurst - 1) * fireInterval(w) + (w.burstDelay ?? 0.25)) + inBurst * fireInterval(w)) * 1000);
  }
  return Math.round((n - 1) * fireInterval(w) * 1000);
}

/** Normalized 0..1 stat bars for the loadout screen. */
export function statBars(w: WeaponStats): { damage: number; fireRate: number; range: number; accuracy: number; mobility: number; handling: number } {
  const dmg = Math.min(1, (damageAt(w, 0) * (w.pellets ?? 1)) / 120);
  return {
    damage: Math.min(1, dmg * 1.1),
    fireRate: Math.min(1, w.rpm / 1100),
    range: Math.min(1, w.range / 80),
    accuracy: Math.max(0, Math.min(1, 1 - (w.recoil.up * w.recoil.adsMul) / 3.5 - w.adsSpread / 2)),
    mobility: Math.max(0, Math.min(1, (w.move - 0.8) / 0.27)),
    handling: Math.max(0, Math.min(1, 1 - (w.ads - 0.12) / 0.38)),
  };
}

export const PRIMARY_IDS = WEAPONS.filter((w) => w.slot === 'primary').map((w) => w.id);
export const SECONDARY_IDS = WEAPONS.filter((w) => w.slot === 'secondary').map((w) => w.id);
export const CLASS_LABEL: Record<WeaponClass, string> = {
  pistol: 'Pistols',
  smg: 'Submachine Guns',
  ar: 'Assault Rifles',
  shotgun: 'Shotguns',
  marksman: 'Marksman Rifles',
  sniper: 'Sniper Rifles',
  lmg: 'Light Machine Guns',
};
