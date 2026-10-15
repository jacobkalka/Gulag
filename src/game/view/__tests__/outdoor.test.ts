import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildWetMask } from '@/engine/surfaceFx';
import { canopyShade } from '../canopy';
import { buildMap, MAP_IDS } from '@/game/world/maps';
import { CollisionWorld } from '@/game/world/collision';
import { terrainBounds } from '@/game/world/terrain';

describe('roof heights in the wet mask', () => {
  const mask = buildWetMask({ min: [-10, 0, -10], max: [10, 5, 10] }, [], [], 99, [
    // a 4 x 2 m slab at 3 m, turned 90 degrees: covers x -1..1, z -2..2
    { x: 0, z: 0, hx: 2, hz: 1, rot: Math.PI / 2, top: 3 },
    // a lower slab overlapping its corner: the higher cover wins
    { x: 1, z: 2, hx: 1, hz: 1, rot: 0, top: 1.5 },
  ]);
  const img = mask.texture.image as { data: Uint8Array; width: number; height: number };
  const roof = (x: number, z: number) => {
    const i = Math.floor(((x + 10) / 20) * img.width);
    const j = Math.floor(((z + 10) / 20) * img.height);
    return (img.data[(j * img.width + i) * 4 + 1] / 255) * 16;
  };

  it('stores the cover height under rotated rectangles, nothing in the open', () => {
    expect(roof(0, 1.8)).toBeCloseTo(3, 1);
    expect(roof(0.8, -1.5)).toBeCloseTo(3, 1);
    // outside the turned slab (it would be inside if the rotation were ignored)
    expect(roof(1.8, -0.5)).toBe(0);
    expect(roof(1.7, 2.6)).toBeCloseTo(1.5, 1);
    expect(roof(0.5, 1.5)).toBeCloseTo(3, 1);
    expect(roof(-6, 6)).toBe(0);
  });
});

describe('Monsoon', () => {
  const map = buildMap('monsoon');
  const world = CollisionWorld.fromMap(map, []);

  it('is registered and deterministic', () => {
    expect(MAP_IDS).toContain('monsoon');
    expect(JSON.stringify(buildMap('monsoon').plants)).toBe(JSON.stringify(map.plants));
  });

  it('stands every spawn on walkable ground with room to move', () => {
    expect(map.spawns.filter((s) => s.team === 0)).toHaveLength(8);
    expect(map.spawns.filter((s) => s.team === 1)).toHaveLength(8);
    for (const s of map.spawns) {
      const g = world.supportHeight(s.pos[0], s.pos[2], 0.3, s.pos[1] + 0.5, 0.6, 3);
      expect(Math.abs(g.y - s.pos[1])).toBeLessThan(0.25);
      expect(world.cylinderBlocked(s.pos[0], g.y + 0.05, s.pos[2], 0.35, 1.6)).toBe(false);
    }
  });

  it('mirrors the plants and keeps them on the ground', () => {
    const plants = map.plants ?? [];
    expect(plants.length).toBeGreaterThan(1000);
    const t = map.terrain!;
    const b = terrainBounds(t);
    for (let i = 0; i < plants.length; i += 2) {
      const a = plants[i];
      const m = plants[i + 1];
      expect(m.kind).toBe(a.kind);
      expect(m.pos[0]).toBeCloseTo(-a.pos[0], 5);
      expect(m.pos[2]).toBeCloseTo(a.pos[2], 5);
      expect(a.pos[0]).toBeGreaterThan(b.minX);
      expect(a.pos[0]).toBeLessThan(b.maxX);
      expect(a.pos[2]).toBeGreaterThan(b.minZ);
      expect(a.pos[2]).toBeLessThan(b.maxZ);
    }
  });

  it('shades sky light under the canopy but not over the open base', () => {
    const shade = canopyShade(map);
    const up = new THREE.Vector3(0, 1, 0);
    expect(shade(0, 1, -10, up)).toBe(1);
    const jungle = [shade(-40, 1, 12, up), shade(-38, 1, -14, up), shade(-20, 1, 28, up)];
    for (const j of jungle) {
      expect(j).toBeLessThan(0.8);
      expect(j).toBeGreaterThan(0.15);
    }
  });
});
