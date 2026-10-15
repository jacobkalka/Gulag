import * as THREE from 'three';
import type { MaterialLibrary } from '@/assets/materials';
import type { TerrainDef } from '@/game/world/terrain';
import { applySurfaceFx } from '@/engine/surfaceFx';

// Renders a heightfield with the same triangle split the collision uses, plus an optional overlay
// (mud paths, trampled ground) blended over it with per-vertex alpha.

function grid(t: TerrainDef, withAlpha: Float32Array | null): THREE.BufferGeometry {
  const { nx, nz, cell } = t;
  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const col = withAlpha ? new Float32Array(nx * nz * 4) : null;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = t.originX + i * cell;
      const z = t.originZ + j * cell;
      pos[k * 3] = x;
      pos[k * 3 + 1] = t.heights[k];
      pos[k * 3 + 2] = z;
      uv[k * 2] = x;
      uv[k * 2 + 1] = -z;
      if (col && withAlpha) {
        col[k * 4] = 1;
        col[k * 4 + 1] = 1;
        col[k * 4 + 2] = 1;
        col[k * 4 + 3] = withAlpha[k];
      }
    }
  }
  // two triangles per cell, split along (i, j)-(i+1, j+1) like terrainHeight(); wound counter-clockwise seen from above
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = a + nx;
      if (withAlpha) {
        // skip cells the overlay doesn't touch at all
        if (withAlpha[a] + withAlpha[b] + withAlpha[c] + withAlpha[d] < 0.01) continue;
      }
      idx.push(a, c, b, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function buildTerrainMeshes(t: TerrainDef, lib: MaterialLibrary): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const ground = new THREE.Mesh(grid(t, null), lib.get(t.mat));
  ground.name = 'terrain';
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.userData.shadowExempt = 'terrain: receives shadows; its own relief casting would cost a full shadow pass';
  ground.matrixAutoUpdate = false;
  out.push(ground);
  if (t.overlay) {
    const base = lib.get(t.overlay.mat);
    const mat = base.clone();
    mat.name = `${t.overlay.mat}:overlay`;
    // clones don't keep onBeforeCompile: give the film the same wetness as the ground under it
    if (base.userData.surfaceFx) {
      delete mat.userData.surfaceFx;
      applySurfaceFx(mat);
    }
    mat.vertexColors = true;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    lib.adopt(`${t.overlay.mat}:overlay`, mat);
    const m = new THREE.Mesh(grid(t, t.overlay.weights), mat);
    m.name = 'terrain:overlay';
    m.receiveShadow = true;
    m.renderOrder = 1;
    m.userData.shadowExempt = 'terrain overlay: a film over the ground';
    m.matrixAutoUpdate = false;
    out.push(m);
  }
  return out;
}
