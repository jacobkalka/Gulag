import { describe, expect, it } from 'vitest';
import { WEAPONS, damageAt, getWeapon, shotsToKill, timeToKill, statBars } from '@/data/weapons';
import { LEVEL_XP, MAX_LEVEL, computeMatchXp, levelForXp, sanitizeLoadout, unlocksBetween, xpToNext, isUnlocked, MAX_MATCH_XP } from '@/data/progression';

describe('weapons data', () => {
  it('has 12-16 unique weapons with sane stats', () => {
    expect(WEAPONS.length).toBeGreaterThanOrEqual(12);
    expect(WEAPONS.length).toBeLessThanOrEqual(16);
    expect(new Set(WEAPONS.map((w) => w.id)).size).toBe(WEAPONS.length);
    for (const w of WEAPONS) {
      expect(w.rpm).toBeGreaterThan(0);
      expect(w.magSize).toBeGreaterThan(0);
      expect(w.damage.length).toBeGreaterThan(0);
      for (let i = 1; i < w.damage.length; i++) expect(w.damage[i][0]).toBeGreaterThan(w.damage[i - 1][0]);
    }
  });
  it('interpolates damage falloff', () => {
    const w = getWeapon('halberd');
    expect(damageAt(w, 0)).toBe(19.5);
    expect(damageAt(w, 11)).toBeCloseTo(18.25);
    expect(damageAt(w, 100)).toBe(13.5);
  });
  it('time to kill is in the longer-fight band for automatics', () => {
    for (const id of ['halberd', 'rook9', 'talon', 'kestrel']) {
      const ttk = timeToKill(getWeapon(id), 5);
      expect(ttk).toBeGreaterThan(300);
      expect(ttk).toBeLessThan(650);
    }
  });
  it('sniper still one-shots the head and upper chest; DMR is three to the body, two to the head', () => {
    expect(shotsToKill(getWeapon('vigil'), 20, 'chest')).toBe(1);
    expect(shotsToKill(getWeapon('vigil'), 20, 'head')).toBe(1);
    expect(shotsToKill(getWeapon('vigil'), 20, 'stomach')).toBe(2);
    expect(shotsToKill(getWeapon('lancet'), 10, 'head')).toBe(2);
    expect(shotsToKill(getWeapon('lancet'), 10, 'chest')).toBe(3);
  });
  it('shotgun is lethal up close and weak at range', () => {
    expect(shotsToKill(getWeapon('thresher'), 2)).toBe(1);
    expect(shotsToKill(getWeapon('thresher'), 15)).toBeGreaterThan(2);
  });
  it('burst TTK accounts for burst delay', () => {
    const c = getWeapon('cinder');
    expect(shotsToKill(c, 5)).toBe(4);
    expect(timeToKill(c, 5)).toBeLessThan(250);
    // a fifth round spills into the next burst
    expect(shotsToKill(c, 20)).toBe(5);
    expect(timeToKill(c, 20)).toBeGreaterThan(450);
  });
  it('stat bars are normalized', () => {
    for (const w of WEAPONS) {
      for (const v of Object.values(statBars(w))) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('progression', () => {
  it('xp curve is increasing', () => {
    for (let l = 1; l < MAX_LEVEL; l++) expect(xpToNext(l + 1)).toBeGreaterThan(xpToNext(l));
    expect(LEVEL_XP[1]).toBe(0);
    expect(LEVEL_XP[2]).toBe(xpToNext(1));
  });
  it('level for xp', () => {
    expect(levelForXp(0).level).toBe(1);
    expect(levelForXp(xpToNext(1)).level).toBe(2);
    expect(levelForXp(xpToNext(1) - 1).level).toBe(1);
    expect(levelForXp(1e9).level).toBe(MAX_LEVEL);
    const li = levelForXp(LEVEL_XP[10] + 100);
    expect(li.level).toBe(10);
    expect(li.into).toBe(100);
  });
  it('early unlocks come quickly', () => {
    const early = unlocksBetween(1, 10).filter((u) => u.kind === 'weapon');
    expect(early.length).toBeGreaterThanOrEqual(4);
  });
  it('computes match XP with a cap', () => {
    const r = computeMatchXp({ kills: 5, headshots: 2, assists: 1, captures: 1, damage: 640, roundsWon: 2, won: true, completed: true });
    expect(r.total).toBe(500 + 50 + 50 + 200 + 300 + 500 + 128 + 100);
    const big = computeMatchXp({ kills: 500, headshots: 500, assists: 0, captures: 0, damage: 0, roundsWon: 3, won: true, completed: true });
    expect(big.total).toBe(MAX_MATCH_XP);
  });
  it('sanitizes loadouts against level', () => {
    expect(sanitizeLoadout({ primary: 'vigil', secondary: 'ironjaw' }, 1).primary).toBe('halberd');
    expect(sanitizeLoadout({ primary: 'vigil', secondary: 'ironjaw' }, 40)).toMatchObject({ primary: 'vigil', secondary: 'ironjaw' });
    expect(sanitizeLoadout({ primary: 'warden' }, 50).primary).toBe('halberd'); // pistol cannot be primary
    expect(isUnlocked('flash', 2)).toBe(false);
    expect(isUnlocked('flash', 3)).toBe(true);
  });
});
