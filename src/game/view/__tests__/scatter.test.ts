import { describe, expect, it } from 'vitest';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { CollisionWorld } from '@/game/world/collision';
import { scatterDecals } from '../Decals';
import { scatterClutter } from '../Clutter';
import { buildWetMask } from '@/engine/surfaceFx';

const map = buildSublevel9();
const world = CollisionWorld.fromMap(map, []);
const none = new Set<string>();

describe('grime decals', () => {
  it('are seeded: same seed, same wear for every player', () => {
    const a = scatterDecals(map, world, 42, none, 400);
    const b = scatterDecals(map, world, 42, none, 400);
    const c = scatterDecals(map, world, 43, none, 400);
    expect(a.length).toBeGreaterThan(100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('respect the budget', () => {
    expect(scatterDecals(map, world, 42, none, 50)).toHaveLength(50);
  });

  it('never hang off a wall into open air (corners, doorways, wall tops)', () => {
    const decals = scatterDecals(map, world, 42, none, 100000);
    let checked = 0;
    for (const d of decals) {
      if (Math.abs(d.normal.y) > 0.5) continue;
      // tangent along the wall
      const tx = -d.normal.z;
      const tz = d.normal.x;
      // rotated decals keep their art inside a circle; unrotated ones fill the rectangle
      const pts: [number, number][] =
        d.rot !== 0
          ? [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
              const a = (k / 8) * Math.PI * 2;
              const r = Math.min(d.w, d.h) * 0.45;
              return [Math.cos(a) * r, Math.sin(a) * r];
            })
          : [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [u * (d.w / 2 - 0.01), v * (d.h / 2 - 0.01)]);
      for (const [u, v] of pts) {
        // a point just behind the decal must be inside solid wall
        const x = d.pos.x + tx * u - d.normal.x * 0.03;
        const y = d.pos.y + v;
        const z = d.pos.z + tz * u - d.normal.z * 0.03;
        expect(world.cylinderBlocked(x, y - 0.005, z, 0.004, 0.01), `decal cell ${d.cell} at ${d.pos.toArray().map((n) => n.toFixed(2))}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(400);
  });
});

describe('clutter', () => {
  it('is seeded, stays inside the map and off the spawns', () => {
    const a = scatterClutter(map, world, 7, none, 1000);
    const b = scatterClutter(map, world, 7, none, 1000);
    expect(a.length).toBeGreaterThan(60);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const c of a) {
      expect(c.pos[0]).toBeGreaterThan(map.bounds.min[0]);
      expect(c.pos[0]).toBeLessThan(map.bounds.max[0]);
      expect(c.pos[2]).toBeGreaterThan(map.bounds.min[2]);
      expect(c.pos[2]).toBeLessThan(map.bounds.max[2]);
      for (const s of map.spawns) expect(Math.hypot(s.pos[0] - c.pos[0], s.pos[2] - c.pos[2])).toBeGreaterThanOrEqual(1.2);
      // clutter sits on something walkable, never inside props or walls
      expect(world.cylinderBlocked(c.pos[0], c.pos[1] + 0.02, c.pos[2], 0.08, 0.3)).toBe(false);
    }
  });
});

describe('wet mask', () => {
  it('rasterizes wet discs and sky openings, dry elsewhere', () => {
    const mask = buildWetMask(
      { min: [-10, 0, -10], max: [10, 5, 10] },
      [{ x: 2, z: 3, r: 1, soft: 1, wet: 1 }],
      [{ min: [-8, -8], max: [-6, -6], wet: 0.5, soft: 0.5 }],
      0.6,
    );
    const img = mask.texture.image as { data: Uint8Array; width: number; height: number };
    const at = (x: number, z: number) => {
      const i = Math.floor(((x + 10) / 20) * img.width);
      const j = Math.floor(((z + 10) / 20) * img.height);
      return img.data[(j * img.width + i) * 4] / 255;
    };
    expect(at(2, 3)).toBeCloseTo(1, 1);
    expect(at(-7, -7)).toBeCloseTo(0.5, 1);
    expect(at(6, -6)).toBe(0);
    expect(mask.maxY).toBe(0.6);
  });
});
