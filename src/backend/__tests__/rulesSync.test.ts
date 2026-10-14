import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEAPONS } from '@/data/weapons';
import { EQUIPMENT, LEVEL_XP, XP_AWARD, MAX_MATCH_XP } from '@/data/progression';

// The Firestore rules embed the unlock table and the XP formula. This test keeps them in sync
// with the game data (UPDATE_RULES=1 rewrites the generated block).

const RULES = resolve(__dirname, '../../../firebase/firestore.rules');
const START = '    // <generated:unlocks>';
const END = '    // </generated:unlocks>';

function generated(): string {
  const map = (slot: 'primary' | 'secondary') =>
    WEAPONS.filter((w) => w.slot === slot)
      .map((w) => `'${w.id}': ${LEVEL_XP[w.unlockLevel]}`)
      .join(', ');
  const flash = EQUIPMENT.find((e) => e.id === 'flash')!;
  return [
    `${START} Regenerate with: UPDATE_RULES=1 npx vitest run src/backend/__tests__/rulesSync.test.ts`,
    `    function primaryXp() {`,
    `      return {${map('primary')}};`,
    `    }`,
    `    function secondaryXp() {`,
    `      return {${map('secondary')}};`,
    `    }`,
    `    function flashXp() {`,
    `      return ${LEVEL_XP[flash.unlockLevel]};`,
    `    }`,
    END,
  ].join('\n');
}

describe('firestore.rules stays in sync with game data', () => {
  it('unlock table', () => {
    const src = readFileSync(RULES, 'utf8');
    const a = src.indexOf(START);
    const b = src.indexOf(END);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const current = src.slice(a, b + END.length);
    const want = generated();
    if (process.env.UPDATE_RULES && current !== want) {
      writeFileSync(RULES, src.slice(0, a) + want + src.slice(b + END.length));
      return;
    }
    expect(current).toBe(want);
  });
  it('XP formula constants', () => {
    const src = readFileSync(RULES, 'utf8');
    expect(src).toContain(`r.kills * ${XP_AWARD.kill} + r.headshots * ${XP_AWARD.headshot} + r.assists * ${XP_AWARD.assist} + r.captures * ${XP_AWARD.capture}`);
    expect(src).toContain(`+ r.roundsWon * ${XP_AWARD.roundWin} + (r.won ? ${XP_AWARD.matchWin} : 0) + (r.damage - r.damage % 10) / 10 * ${XP_AWARD.damage10} + ${XP_AWARD.participation};`);
    expect(src).toContain(`let capped = full > ${MAX_MATCH_XP} ? ${MAX_MATCH_XP} : full;`);
  });
});
