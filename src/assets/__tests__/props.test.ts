import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PROPS } from '@/assets/models/props';
import { hasMaterial, type MaterialLibrary } from '@/assets/materials';
import { buildMap, MAP_IDS } from '@/game/world/maps';

// Props and maps name their materials with strings; a typo only shows up as a crash when the map
// is built in the browser. Build everything here against a library that checks the names.

const used = new Set<string>();
const fakeLib = {
  get(name: string) {
    used.add(name);
    if (!hasMaterial(name)) throw new Error(`unknown material '${name}'`);
    return new THREE.MeshStandardMaterial({ name });
  },
  tinted(name: string) {
    return fakeLib.get(name);
  },
} as unknown as MaterialLibrary;

describe('props', () => {
  for (const [type, def] of Object.entries(PROPS)) {
    it(`${type} builds with known materials for every variant`, () => {
      for (let v = 0; v < 6; v++) {
        const g = def.build(fakeLib, v);
        let meshes = 0;
        g.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) meshes++;
        });
        expect(meshes).toBeGreaterThan(0);
      }
    });
  }
});

describe('maps', () => {
  for (const id of MAP_IDS) {
    it(`${id} uses only known props and materials`, () => {
      const map = buildMap(id);
      for (const b of map.brushes) for (const m of [b.mat, b.top, b.bottom, b.sides]) if (m) expect(hasMaterial(m), `brush material ${m}`).toBe(true);
      for (const r of map.ramps) expect(hasMaterial(r.mat), `ramp material ${r.mat}`).toBe(true);
      for (const p of map.props) expect(PROPS[p.type], `prop ${p.type}`).toBeDefined();
    });
  }
});
