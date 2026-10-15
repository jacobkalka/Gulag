import { describe, expect, it } from 'vitest';
import { makeTerrain, rayTerrain, terrainHeight, terrainNormal } from '../terrain';
import { Rng } from '@/shared/rng';

const box = { minX: -20, minZ: -15, maxX: 20, maxZ: 15, cell: 1, mat: 'floor' };

describe('terrain', () => {
  it('samples a sloped plane exactly', () => {
    const t = makeTerrain(box, (x, z) => 0.5 * x - 0.25 * z);
    expect(terrainHeight(t, 2, 0)).toBeCloseTo(1, 6);
    expect(terrainHeight(t, 3.3, -2.7)).toBeCloseTo(0.5 * 3.3 + 0.25 * 2.7, 6);
    const n = terrainNormal(t, 1.2, 0.7);
    const l = Math.hypot(0.5, 1, 0.25);
    expect(n[0]).toBeCloseTo(-0.5 / l, 4);
    expect(n[1]).toBeCloseTo(1 / l, 4);
    expect(n[2]).toBeCloseTo(0.25 / l, 4);
  });

  it('hits the ground straight down and at an angle', () => {
    const flat = makeTerrain(box, () => 0);
    expect(rayTerrain(flat, 0.3, 5, 0.6, 0, -1, 0, 20)!.t).toBeCloseTo(5, 6);
    const hit = rayTerrain(flat, -10, 4, 0, 1, -0.5, 0, 50)!;
    expect(hit.t).toBeCloseTo(8, 5);
    expect(hit.ny).toBeCloseTo(1, 6);
    expect(rayTerrain(flat, 0, 5, 0, 1, 0.1, 0, 50)).toBeNull(); // rising away
    expect(rayTerrain(flat, 0, -1, 0, 0, -1, 0, 50)).toBeNull(); // starts underground
  });

  it('agrees with a brute-force march on bumpy ground', () => {
    const t = makeTerrain(box, (x, z) => Math.sin(x * 0.7) * 1.2 + Math.cos(z * 0.9) * 0.8 + Math.sin((x + z) * 0.3) * 1.5);
    const rng = new Rng(7);
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      const ox = rng.range(-18, 18);
      const oz = rng.range(-13, 13);
      const oy = terrainHeight(t, ox, oz) + rng.range(0.2, 4);
      const a = rng.next() * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const dy = rng.range(-0.6, 0.15);
      const maxT = 30;
      const got = rayTerrain(t, ox, oy, oz, dx, dy, dz, maxT);
      // march in small steps and refine the first crossing by bisection
      let want: number | null = null;
      let prev = 0;
      for (let s = 0.01; s <= maxT; s += 0.01) {
        const x = ox + dx * s;
        const z = oz + dz * s;
        if (x < -20 || x > 20 || z < -15 || z > 15) break;
        if (oy + dy * s < terrainHeight(t, x, z)) {
          let lo = prev;
          let hi = s;
          for (let i = 0; i < 40; i++) {
            const m = (lo + hi) / 2;
            if (oy + dy * m < terrainHeight(t, ox + dx * m, oz + dz * m)) hi = m;
            else lo = m;
          }
          want = (lo + hi) / 2;
          break;
        }
        prev = s;
      }
      // a hit must lie on the surface and come no later than the march's crossing (the march can
      // step over a ray that only grazes the ground, the exact test can't)
      if (got) {
        const gap = oy + dy * got.t - terrainHeight(t, ox + dx * got.t, oz + dz * got.t);
        expect(Math.abs(gap)).toBeLessThan(1e-3);
      }
      if (want !== null) {
        hits++;
        expect(got).not.toBeNull();
        expect(got!.t).toBeLessThan(want + 2e-3);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });
});
