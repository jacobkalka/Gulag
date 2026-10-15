import { describe, expect, it } from 'vitest';
import { WEAPONS } from '@/data/weapons';
import { ttkTable, type AimPoint, type RangeName } from '@/data/balance';
import v1 from './ttk-v1.json';

// The upgrade lengthens fights: body-shot time-to-kill is 1.5-1.8x the pre-upgrade value at
// close and mid range (small tolerance for shot-count rounding). Exceptions keep their role:
// shotguns stay punishing up close and the sniper keeps its one-shot to the head/upper chest.
const v1Rows = new Map((v1 as unknown as ReturnType<typeof ttkTable>).map((r) => [r.id, r]));
const EXEMPT_CLOSE = new Set(['thresher', 'cyclone']);

describe('balance: longer time to kill', () => {
  const rows = ttkTable(WEAPONS);
  it('body TTK at close and mid range is 1.5-1.8x the pre-upgrade value', () => {
    const bad: string[] = [];
    for (const r of rows) {
      if (r.id === 'vigil') continue;
      for (const range of ['close', 'mid'] as RangeName[]) {
        if (r.cls === 'shotgun' && range !== 'close') continue;
        const now = r.cells[range].body.ms;
        const old = v1Rows.get(r.id)!.cells[range].body.ms;
        const ratio = now / old;
        const lo = EXEMPT_CLOSE.has(r.id) ? 1.0 : 1.45;
        if (!(ratio >= lo && ratio <= 1.85)) bad.push(`${r.id} ${range}: ${old} -> ${now} ms (x${ratio.toFixed(2)})`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('headshots stay rewarding (never slower than a body shot, never much faster than before)', () => {
    for (const r of rows) {
      if (r.cls === 'shotgun') continue; // a pellet pattern centered on the head lands fewer pellets
      for (const range of ['close', 'mid', 'long'] as RangeName[]) {
        const c = r.cells[range];
        if (!Number.isFinite(c.head.ms) || !Number.isFinite(c.body.ms)) continue;
        expect(c.head.ms, `${r.id} ${range}`).toBeLessThanOrEqual(c.body.ms);
        const old = v1Rows.get(r.id)!.cells[range].head.ms;
        if (old > 0 && r.cls !== 'shotgun') expect(c.head.ms / old, `${r.id} ${range} head`).toBeGreaterThan(0.85);
      }
    }
  });
  it('snipers stay strong and shotguns stay punishing up close', () => {
    const get = (id: string, range: RangeName, aim: AimPoint) => rows.find((r) => r.id === id)!.cells[range][aim];
    expect(get('vigil', 'long', 'body').shots).toBe(1);
    expect(get('vigil', 'long', 'head').shots).toBe(1);
    expect(get('thresher', 'close', 'body').shots).toBeLessThanOrEqual(2);
  });
});
