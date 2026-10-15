import { describe, expect, it } from 'vitest';
import { buildPlant, plantColliderRadius, type PlantKind } from '@/assets/models/plants';

const KINDS: PlantKind[] = ['fern', 'treeFern', 'palm', 'banana', 'monstera', 'bush', 'grass', 'buttress'];

describe('plants', () => {
  for (const kind of KINDS) {
    it(`${kind} builds clean geometry for several variants`, () => {
      for (let seed = 0; seed < 3; seed++) {
        const m = buildPlant(kind, seed);
        const geos = [m.leaves, m.trunk].filter((g): g is NonNullable<typeof g> => !!g);
        expect(geos.length).toBeGreaterThan(0);
        for (const g of geos) {
          const pos = g.getAttribute('position');
          const sway = g.getAttribute('aSway');
          expect(sway.count).toBe(pos.count);
          for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
          const idx = g.getIndex()!;
          for (let i = 0; i < idx.count; i++) expect(idx.getX(i)).toBeLessThan(pos.count);
          // everything grows up from the ground near its own origin
          g.computeBoundingBox();
          expect(g.boundingBox!.min.y).toBeGreaterThan(-0.5);
        }
        expect(m.height).toBeGreaterThan(0.3);
      }
    });
  }
  it('trees and palms block, ground plants do not', () => {
    expect(plantColliderRadius('buttress')).toBeGreaterThan(0.5);
    expect(plantColliderRadius('palm')).toBeGreaterThan(0.1);
    expect(plantColliderRadius('fern')).toBe(0);
  });
});
