import * as THREE from 'three';
import type { Brush, MapDef } from '@/game/world/mapTypes';
import type { CollisionWorld } from '@/game/world/collision';
import { DECAL_CELLS, type DecalAtlas, type DecalCell } from '@/assets/textures/decalAtlas';
import { Rng } from '@/shared/rng';

// Instanced PBR decals (one draw call): grime along wall bases, streaks under ceilings and
// fixtures, water stains, cracks, peeling paint, moss near water, floor dirt, oil, scuffs and wet
// patches. Placement is seeded (same for every player) and only on faces that border open space.

export interface DecalInstance {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  /** Rotation around the normal (radians). */
  rot: number;
  w: number;
  h: number;
  cell: number;
  opacity: number;
}

export class DecalLayer {
  readonly mesh: THREE.InstancedMesh;

  constructor(atlas: DecalAtlas, list: DecalInstance[]) {
    const mat = new THREE.MeshStandardMaterial({
      name: 'decals',
      map: atlas.map,
      normalMap: atlas.normalMap,
      roughnessMap: atlas.ormMap,
      aoMap: atlas.ormMap,
      metalness: 0,
      roughness: 1,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      // one probe serves the whole map, so keep its (possibly wrong-colored) reflections faint;
      // wet and oily patches still pick up the real lights as highlights
      envMapIntensity: 0.25,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aCell;\nvarying float vDecalA;')
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
#ifdef USE_INSTANCING
  vec2 dUv = aCell.xy + uv * 0.25;
  #ifdef USE_MAP
    vMapUv = dUv;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = dUv;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = dUv;
  #endif
  #ifdef USE_AOMAP
    vAoMapUv = dUv;
  #endif
  vDecalA = aCell.w;
#endif`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDecalA;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a *= vDecalA;');
    };
    const geo = new THREE.PlaneGeometry(1, 1);
    const n = Math.max(1, list.length);
    const cell = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    geo.setAttribute('aCell', cell);
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qr = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    list.forEach((d, i) => {
      q.setFromUnitVectors(z, d.normal);
      qr.setFromAxisAngle(z, d.rot);
      q.multiply(qr);
      m4.compose(d.pos, q, new THREE.Vector3(d.w, d.h, 1));
      mesh.setMatrixAt(i, m4);
      const cx = (d.cell % 4) * 0.25;
      const cy = Math.floor(d.cell / 4) * 0.25;
      cell.setXYZW(i, cx, cy, 0, d.opacity);
    });
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.name = 'decals';
    mesh.userData.shadowExempt = 'decal: receives shadows, a flat overlay never casts';
    this.mesh = mesh;
  }
}

// peel flakes are cream-colored paint over bare plaster, so only light paints get them
const isPaint = (m: string) => /plasterCream|paintGrey/.test(m);
const isMasonry = (m: string) => /concrete|plaster|brick/.test(m);
const isTile = (m: string) => /tile/.test(m);
const isMetal = (m: string) => /metal|rust|steel|diamond/.test(m);

/**
 * Seeded decal scatter over a map's brushes. Only faces with open space in front of them get
 * decals, every decal stays inside the face it sits on (nothing hangs past a corner or into a
 * doorway) and floor decals avoid solid props.
 */
export function scatterDecals(map: MapDef, world: CollisionWorld, seed: number, activeTags: Set<string>, budget = 420): DecalInstance[] {
  const rng = new Rng(seed);
  const out: DecalInstance[] = [];
  const [bx0, , bz0] = map.bounds.min;
  const [bx1, , bz1] = map.bounds.max;
  const inside = (x: number, z: number) => x > bx0 && x < bx1 && z > bz0 && z < bz1;
  const open = (x: number, y: number, z: number, n: THREE.Vector3) => !world.cylinderBlocked(x + n.x * 0.12, y - 0.03, z + n.z * 0.12, 0.04, 0.06);
  const wet = (x: number, z: number) => map.decals.some((d) => d.kind === 'puddle' && Math.hypot(d.pos[0] - x, d.pos[2] - z) < 3);
  const up = new THREE.Vector3(0, 1, 0);

  interface Face {
    n: THREE.Vector3;
    /** World XZ at distance s along the face. */
    at: (s: number) => [number, number];
    len: number;
    y0: number;
    y1: number;
  }
  const faces = (br: Brush): Face[] => {
    const [x0, y0, z0] = br.min;
    const [x1, y1, z1] = br.max;
    return [
      { n: new THREE.Vector3(1, 0, 0), at: (s: number): [number, number] => [x1, z0 + s], len: z1 - z0, y0, y1 },
      { n: new THREE.Vector3(-1, 0, 0), at: (s: number): [number, number] => [x0, z0 + s], len: z1 - z0, y0, y1 },
      { n: new THREE.Vector3(0, 0, 1), at: (s: number): [number, number] => [x0 + s, z1], len: x1 - x0, y0, y1 },
      { n: new THREE.Vector3(0, 0, -1), at: (s: number): [number, number] => [x0 + s, z0], len: x1 - x0, y0, y1 },
    ];
  };
  /**
   * Places a wall decal centered near (s, y) on a face, shrunk and shifted so it stays on the
   * visible part of the face (y0..top) and in front of open space end to end. A rotated decal
   * keeps the whole cell's inscribed circle clear (its art can reach the cell edge).
   */
  const wallDecal = (f: Face, top: number, cell: DecalCell, s: number, y: number, w: number, h: number, rot: number, opacity: number) => {
    const H = top - f.y0;
    let hw = w / 2;
    let hh = h / 2;
    if (rot !== 0) hw = hh = Math.max(hw, hh);
    hw = Math.min(hw, f.len / 2 - 0.02);
    hh = Math.min(hh, H / 2 - 0.01);
    if (rot !== 0) hw = hh = Math.min(hw, hh);
    if (hw < 0.15 || hh < 0.12) return;
    const sc = Math.min(Math.max(s, hw + 0.02), f.len - hw - 0.02);
    const yc = Math.min(Math.max(y, f.y0 + hh + 0.01), top - hh - 0.01);
    const [x, z] = f.at(sc);
    const yTest = Math.min(Math.max(yc, f.y0 + 0.3), top - 0.05);
    if (!open(x, yTest, z, f.n)) return;
    // both ends too: no running into a perpendicular wall or a prop standing against this one
    const [xa, za] = f.at(sc - hw + 0.05);
    const [xb, zb] = f.at(sc + hw - 0.05);
    if (!open(xa, yTest, za, f.n) || !open(xb, yTest, zb, f.n)) return;
    const k = rot !== 0 ? (hw * 2) / Math.max(w, h) : 1;
    out.push({
      pos: new THREE.Vector3(x, yc, z).addScaledVector(f.n, 0.006),
      normal: f.n.clone(),
      rot,
      w: rot !== 0 ? w * k : hw * 2,
      h: rot !== 0 ? h * k : hh * 2,
      cell: DECAL_CELLS[cell],
      opacity,
    });
  };

  for (const br of map.brushes) {
    if (br.visible === false || br.solid === false) continue;
    if (br.tag && !activeTags.has(br.tag)) continue;
    const mat = br.sides ?? br.mat;
    // ---- walls (including the banded tile/paint courses walls are built from)
    if (br.max[1] - br.min[1] >= 0.6 && !br.walk) {
      for (const f of faces(br)) {
        if (f.len < 0.8) continue;
        const steps = Math.max(1, Math.floor(f.len / 2.2));
        for (let si = 0; si < steps; si++) {
          const s = ((si + 0.25 + rng.next() * 0.5) / steps) * f.len;
          const [bx, bz] = f.at(s);
          const px = bx + f.n.x * 0.12;
          const pz = bz + f.n.z * 0.12;
          if (!inside(px, pz)) continue;
          // the visible part of the face ends at the room's ceiling (walls run on into the roof)
          const top = Math.min(f.y1, world.ceilingHeight(px, pz, 0.05, f.y0 + 0.5));
          const H = top - f.y0;
          if (H < 0.6) continue;
          // grime / scuffs / mold along the bottom of walls standing on a floor
          if (f.y0 < 0.3 && rng.next() < 0.8) {
            const h = 0.45 + rng.next() * 0.35;
            const cell: DecalCell = wet(bx, bz) || isTile(mat) ? (rng.next() < 0.4 ? 'mold' : 'baseGrime') : rng.next() < 0.8 ? 'baseGrime' : 'scuff';
            wallDecal(f, top, cell, s, f.y0 + h / 2, 1.3 + rng.next() * 1.1, h, 0, 0.55 + rng.next() * 0.35);
          }
          // streaks running down from the ceiling line
          if (top >= 2.2 && H >= 1.0 && rng.next() < 0.32) {
            const h = Math.min(H * 0.8, 1.4 + rng.next() * 1.4);
            const cell: DecalCell = rng.next() < 0.25 ? 'leak' : rng.next() < 0.2 ? 'drip' : 'grimeStreak';
            wallDecal(f, top, cell, s, top - h / 2, 0.7 + rng.next() * 0.9, h, 0, 0.6 + rng.next() * 0.3);
          }
          if (top >= 2.2 && H >= 1.2 && rng.next() < 0.14) {
            wallDecal(f, top, 'waterStain', s, top - 0.6 - rng.next() * 0.4, 0.9 + rng.next() * 0.8, 0.8 + rng.next() * 0.6, 0, 0.7);
          }
          if (H >= 1.0) {
            const yMid = f.y0 + 0.4 + rng.next() * Math.max(0, H - 0.8);
            if (isMasonry(mat) && rng.next() < 0.18) wallDecal(f, top, 'crack', s, yMid, 0.8 + rng.next(), 0.8 + rng.next(), rng.next() * Math.PI, 0.85);
            else if (isPaint(mat) && rng.next() < 0.22) wallDecal(f, top, 'peel', s, yMid, 0.7 + rng.next() * 0.8, 0.6 + rng.next() * 0.7, rng.next() * Math.PI, 0.9);
          }
          if (f.y0 < 0.3 && wet(bx, bz) && rng.next() < 0.3) wallDecal(f, top, 'moss', s, f.y0 + 0.3 + rng.next() * 0.3, 0.8 + rng.next() * 0.7, 0.5 + rng.next() * 0.4, rng.next() * 0.6, 0.85);
          if (isMetal(mat) && top >= 1.6 && rng.next() < 0.12) wallDecal(f, top, 'rustStreak', s, top - 0.8, 0.5 + rng.next() * 0.4, 1.2 + rng.next() * 0.8, 0, 0.8);
        }
      }
    }
    // ---- walkable floors
    if (br.walk) {
      const [x0, , z0] = br.min;
      const [x1, y1, z1] = br.max;
      const area = (x1 - x0) * (z1 - z0);
      const n = Math.min(60, Math.floor(area / 7));
      for (let i = 0; i < n; i++) {
        const sz = 0.8 + rng.next() * 1.4;
        const sz2 = sz * (0.7 + rng.next() * 0.5);
        const m = Math.max(sz, sz2) * 0.4 + 0.05;
        if (x1 - x0 < 2 * m || z1 - z0 < 2 * m) continue;
        const x = x0 + m + rng.next() * (x1 - x0 - 2 * m);
        const z = z0 + m + rng.next() * (z1 - z0 - 2 * m);
        if (!inside(x, z) || world.cylinderBlocked(x, y1 + 0.02, z, 0.3, 0.3)) continue;
        const r = rng.next();
        const cell: DecalCell = wet(x, z) ? (r < 0.6 ? 'wet' : 'mold') : r < 0.38 ? 'dirt' : r < 0.55 ? 'scuff' : r < 0.68 ? 'oil' : r < 0.8 ? 'mud' : r < 0.9 ? 'wet' : 'soot';
        out.push({ pos: new THREE.Vector3(x, y1 + 0.006, z), normal: up.clone(), rot: rng.next() * Math.PI * 2, w: sz, h: sz2, cell: DECAL_CELLS[cell], opacity: 0.5 + rng.next() * 0.4 });
      }
    }
  }
  // over budget: keep a seeded random subset so wear spreads evenly instead of following brush order
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, budget);
}
