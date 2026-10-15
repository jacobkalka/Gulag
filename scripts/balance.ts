// Prints time-to-kill for every weapon at close / mid / long range, to the body and to the head,
// straight from src/data/weapons.ts. Usage: npm run balance [-- --json] [-- --compare]
//   --compare  also shows the pre-upgrade (v1) TTK and the ratio new / v1.
import { WEAPONS } from '../src/data/weapons';
import { RANGES, ttkTable, type AimPoint, type RangeName } from '../src/data/balance';
import { HEALTH } from '../src/data/gameplay';
import v1 from '../src/data/__tests__/ttk-v1.json' with { type: 'json' };

const args = new Set(process.argv.slice(2));
const rows = ttkTable(WEAPONS);
if (args.has('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}
const compare = args.has('--compare');
const ranges = Object.keys(RANGES) as RangeName[];
const aims: AimPoint[] = ['body', 'head'];
const v1Map = new Map((v1 as typeof rows).map((r) => [r.id, r]));

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`Time to kill (${HEALTH.max} HP, every shot lands, fully aimed). ms (shots)` + (compare ? '  [x ratio vs v1]' : ''));
console.log(`Ranges: ${ranges.map((r) => `${r} ${RANGES[r]} m`).join(', ')}`);
const head = ['weapon'.padEnd(16), 'class'.padEnd(9)];
for (const r of ranges) for (const a of aims) head.push(pad(`${r}/${a}`, compare ? 20 : 13));
console.log(head.join(' '));
for (const row of rows) {
  const line = [row.name.padEnd(16), row.cls.padEnd(9)];
  for (const r of ranges) {
    for (const a of aims) {
      const c = row.cells[r][a];
      let cell = Number.isFinite(c.ms) ? `${c.ms} (${c.shots})` : 'n/a';
      if (compare) {
        const old = v1Map.get(row.id)?.cells[r][a];
        if (old && Number.isFinite(old.ms) && old.ms > 0 && Number.isFinite(c.ms)) cell += ` x${(c.ms / old.ms).toFixed(2)}`;
        else if (old && old.ms === 0 && c.ms === 0) cell += ' x1.00';
      }
      line.push(pad(cell, compare ? 20 : 13));
    }
  }
  console.log(line.join(' '));
}
