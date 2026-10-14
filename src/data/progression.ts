import { WEAPONS } from './weapons';

// XP, levels and unlocks. Pure functions so they can be unit tested and mirrored in
// Firestore security rules (see firebase/firestore.rules for the threshold table).

export const MAX_LEVEL = 50;

/** XP needed to go from level L to L+1. Fast early, slower later. */
export function xpToNext(level: number): number {
  return Math.round(600 + 140 * Math.pow(Math.max(0, level - 1), 1.25));
}

/** Total XP required to reach each level (index = level). LEVEL_XP[1] = 0. */
export const LEVEL_XP: number[] = (() => {
  const t = [0, 0];
  for (let l = 1; l < MAX_LEVEL; l++) t.push(t[l] + xpToNext(l));
  return t;
})();

export interface LevelInfo {
  level: number;
  /** XP accumulated inside the current level. */
  into: number;
  /** XP required for the next level (0 at max level). */
  need: number;
  /** 0..1 progress to next level. */
  progress: number;
}

export function levelForXp(xp: number): LevelInfo {
  const total = Math.max(0, Math.floor(xp));
  let level = 1;
  while (level < MAX_LEVEL && total >= LEVEL_XP[level + 1]) level++;
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, into: total - LEVEL_XP[MAX_LEVEL], need: 0, progress: 1 };
  const into = total - LEVEL_XP[level];
  const need = LEVEL_XP[level + 1] - LEVEL_XP[level];
  return { level, into, need, progress: into / need };
}

export const XP_AWARD = {
  kill: 100,
  headshot: 25,
  assist: 50,
  capture: 200,
  roundWin: 150,
  matchWin: 500,
  participation: 100,
  /** Per 10 damage dealt (rewards trading even without kills). */
  damage10: 2,
} as const;

/** Upper bound for a single match (also enforced by security rules). */
export const MAX_MATCH_XP = 6000;

export interface MatchStatsForXp {
  kills: number;
  headshots: number;
  assists: number;
  captures: number;
  damage: number;
  roundsWon: number;
  won: boolean;
  completed: boolean;
}

export interface XpLine {
  label: string;
  count: number;
  xp: number;
}

export function computeMatchXp(s: MatchStatsForXp): { lines: XpLine[]; total: number } {
  const lines: XpLine[] = [];
  const add = (label: string, count: number, per: number) => {
    if (count > 0) lines.push({ label, count, xp: Math.round(count * per) });
  };
  add('Kills', s.kills, XP_AWARD.kill);
  add('Headshots', s.headshots, XP_AWARD.headshot);
  add('Assists', s.assists, XP_AWARD.assist);
  add('Objective captures', s.captures, XP_AWARD.capture);
  add('Rounds won', s.roundsWon, XP_AWARD.roundWin);
  if (s.won) add('Match victory', 1, XP_AWARD.matchWin);
  add('Damage dealt', Math.floor(s.damage / 10), XP_AWARD.damage10);
  if (s.completed) add('Participation', 1, XP_AWARD.participation);
  const total = Math.min(MAX_MATCH_XP, lines.reduce((a, l) => a + l.xp, 0));
  return { lines, total };
}

export interface Unlock {
  level: number;
  kind: 'weapon' | 'equipment' | 'cosmetic';
  id: string;
  name: string;
}

export const EQUIPMENT = [
  { id: 'frag', name: 'Breaker Frag', kind: 'lethal' as const, unlockLevel: 1 },
  { id: 'flash', name: 'Blinder Flash', kind: 'tactical' as const, unlockLevel: 3 },
];

export const UNLOCKS: Unlock[] = [
  ...WEAPONS.map((w) => ({ level: w.unlockLevel, kind: 'weapon' as const, id: w.id, name: w.name })),
  ...EQUIPMENT.map((e) => ({ level: e.unlockLevel, kind: 'equipment' as const, id: e.id, name: e.name })),
].sort((a, b) => a.level - b.level);

export function isUnlocked(id: string, level: number): boolean {
  const u = UNLOCKS.find((x) => x.id === id);
  return !!u && u.level <= level;
}

/** Unlocks gained when going from level `from` to level `to` (exclusive of from). */
export function unlocksBetween(from: number, to: number): Unlock[] {
  return UNLOCKS.filter((u) => u.level > from && u.level <= to);
}

/** Next unlock at or above the given level. */
export function nextUnlock(level: number): Unlock | null {
  return UNLOCKS.find((u) => u.level > level) ?? null;
}

export interface Loadout {
  primary: string;
  secondary: string;
  lethal: string;
  tactical: string;
}

export const DEFAULT_LOADOUT: Loadout = { primary: 'halberd', secondary: 'warden', lethal: 'frag', tactical: 'flash' };

/** Replaces anything not yet unlocked with defaults. */
export function sanitizeLoadout(l: Partial<Loadout> | undefined, level: number): Loadout {
  const out = { ...DEFAULT_LOADOUT, ...(l ?? {}) };
  const prim = WEAPONS.find((w) => w.id === out.primary && w.slot === 'primary');
  const sec = WEAPONS.find((w) => w.id === out.secondary && w.slot === 'secondary');
  if (!prim || prim.unlockLevel > level) out.primary = DEFAULT_LOADOUT.primary;
  if (!sec || sec.unlockLevel > level) out.secondary = DEFAULT_LOADOUT.secondary;
  if (!isUnlocked(out.lethal, level)) out.lethal = DEFAULT_LOADOUT.lethal;
  if (!isUnlocked(out.tactical, level)) out.tactical = 'none';
  return out;
}
