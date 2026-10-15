import type * as THREE from 'three';
import type { MapDef, PlantKind } from '@/game/world/mapTypes';

// How much sky light reaches a point under the jungle canopy, for the probe bake. Two layers:
// the high rainforest roof over everything outside the open sky area (the giants' crowns, out of
// sight above the trunks) and the crowns of the palms, tree ferns and bananas you can see.

const CROWN: Partial<Record<PlantKind, { h: number; r: number; d: number }>> = {
  palm: { h: 8, r: 3.4, d: 0.4 },
  treeFern: { h: 3.1, r: 2.0, d: 0.45 },
  banana: { h: 2.0, r: 1.5, d: 0.35 },
  buttress: { h: 20, r: 8, d: 0.4 },
};

/** Share of the sky the high canopy hides over the jungle (outside the open area). */
const HIGH_COVER = 0.25;
const HIGH_Y = 21;
const CELL = 4;

interface Crown {
  x: number;
  z: number;
  r: number;
  d: number;
}

export function canopyShade(map: MapDef): (x: number, y: number, z: number, dir: THREE.Vector3) => number {
  const open = map.openSky;
  const layers: { h: number; cells: Map<number, Crown[]> }[] = [];
  const key = (i: number, j: number) => i * 4099 + j;
  for (const kind of Object.keys(CROWN) as PlantKind[]) {
    const c = CROWN[kind]!;
    const cells = new Map<number, Crown[]>();
    for (const p of map.plants ?? []) {
      if (p.kind !== kind) continue;
      const crown = { x: p.pos[0], z: p.pos[2], r: c.r * p.scale, d: c.d };
      const i0 = Math.floor((crown.x - crown.r) / CELL);
      const i1 = Math.floor((crown.x + crown.r) / CELL);
      const j0 = Math.floor((crown.z - crown.r) / CELL);
      const j1 = Math.floor((crown.z + crown.r) / CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(crown);
        }
      }
    }
    if (cells.size) layers.push({ h: c.h, cells });
  }
  /** 1 inside the open area, fading to 0 over 6 m outside it. */
  const openness = (x: number, z: number) => {
    if (!open) return 0;
    const dx = Math.max(open.min[0] - x, 0, x - open.max[0]);
    const dz = Math.max(open.min[2] - z, 0, z - open.max[2]);
    return Math.max(0, 1 - Math.hypot(dx, dz) / 6);
  };
  return (x, y, z, dir) => {
    if (dir.y <= 0.05) return 1;
    const kx = dir.x / dir.y;
    const kz = dir.z / dir.y;
    let t = 1;
    if (y < HIGH_Y) {
      const lift = HIGH_Y - y;
      t *= 1 - HIGH_COVER * (1 - openness(x + kx * lift, z + kz * lift));
    }
    for (const L of layers) {
      if (y >= L.h) continue;
      const lift = L.h - y;
      const cx = x + kx * lift;
      const cz = z + kz * lift;
      const list = L.cells.get(key(Math.floor(cx / CELL), Math.floor(cz / CELL)));
      if (!list) continue;
      for (const c of list) {
        const q = ((cx - c.x) ** 2 + (cz - c.z) ** 2) / (c.r * c.r);
        if (q < 1) t *= 1 - c.d * (1 - q);
      }
    }
    return t;
  };
}
