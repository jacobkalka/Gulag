import type { Brush, MapDef, PropPlacement } from '@/game/world/mapTypes';
import type { CollisionWorld } from '@/game/world/collision';
import { CLUTTER, type ClutterType } from '@/assets/models/props';
import { Rng } from '@/shared/rng';

// Seeded loose clutter (paper, cans, concrete chunks, bricks, rebar, food trays) along the foot
// of walls and in corners. Same seed for every player, view only (no collision), and kept
// against the walls so movement lanes and doorways stay clear.

/** Relative odds per clutter type; tiles and paint rooms lean to paper and trays, bare rooms to debris. */
const ODDS: Record<ClutterType, [number, number]> = {
  // [finished rooms, rough rooms]
  clutterPaper: [5, 2],
  clutterCan: [3, 2],
  clutterChunk: [1, 5],
  clutterBrick: [1, 3],
  clutterRebar: [0.3, 2],
  clutterTray: [2, 0.4],
};

function pick(rng: Rng, rough: boolean): ClutterType {
  const k = rough ? 1 : 0;
  const total = CLUTTER.reduce((a, t) => a + ODDS[t][k], 0);
  let r = rng.next() * total;
  for (const t of CLUTTER) {
    r -= ODDS[t][k];
    if (r <= 0) return t;
  }
  return CLUTTER[0];
}

export function scatterClutter(map: MapDef, world: CollisionWorld, seed: number, activeTags: Set<string>, budget: number): PropPlacement[] {
  const rng = new Rng(seed ^ 0x5eed);
  const out: PropPlacement[] = [];
  const [bx0, , bz0] = map.bounds.min;
  const [bx1, , bz1] = map.bounds.max;
  const spawns = map.spawns.map((s) => [s.pos[0], s.pos[2]] as const);
  const faces = (br: Brush) => {
    const [x0, , z0] = br.min;
    const [x1, , z1] = br.max;
    return [
      { nx: 1, nz: 0, at: (s: number) => [x1, z0 + s], len: z1 - z0 },
      { nx: -1, nz: 0, at: (s: number) => [x0, z0 + s], len: z1 - z0 },
      { nx: 0, nz: 1, at: (s: number) => [x0 + s, z1], len: x1 - x0 },
      { nx: 0, nz: -1, at: (s: number) => [x0 + s, z0], len: x1 - x0 },
    ];
  };
  for (const br of map.brushes) {
    if (br.visible === false || br.solid === false || br.walk) continue;
    if (br.tag && !activeTags.has(br.tag)) continue;
    // walls standing on a floor, at least knee high
    if (br.min[1] > 0.3 || br.max[1] - br.min[1] < 0.6) continue;
    const mat = br.sides ?? br.mat;
    const rough = !/tile|paint|plaster/.test(mat);
    for (const f of faces(br)) {
      if (f.len < 1.2) continue;
      const n = Math.floor(f.len / 3.2) + (rng.next() < (f.len % 3.2) / 3.2 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        // keep 0.4 m clear of the face ends (doorways and corners stay walkable)
        const s = 0.4 + rng.next() * Math.max(0, f.len - 0.8);
        const off = 0.12 + rng.next() * 0.3;
        const [wx, wz] = f.at(s);
        const x = wx + f.nx * off;
        const z = wz + f.nz * off;
        if (x < bx0 || x > bx1 || z < bz0 || z > bz1) continue;
        const floorY = world.supportHeight(x, z, 0.12, br.min[1] + 0.3, 0.3, 0.6).y;
        if (!Number.isFinite(floorY)) continue;
        if (world.cylinderBlocked(x, floorY + 0.02, z, 0.08, 0.3)) continue;
        if (spawns.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 1.2)) continue;
        out.push({ type: pick(rng, rough), pos: [x, floorY, z], rot: rng.next() * Math.PI * 2, v: Math.floor(rng.next() * 6) });
      }
    }
  }
  // over budget: a seeded random subset, so clutter spreads evenly over the map
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, budget);
}
