import type { Surface } from './mapTypes';

// Heightfield terrain for outdoor maps: a regular grid of heights (x fastest, then z). Every cell
// is split into two triangles along its (x0, z0)-(x1, z1) diagonal; the collision world, the bot
// nav grid and the renderer all use the same split, so what you see is what you stand on.

export interface TerrainDef {
  /** World position of vertex (0, 0). */
  originX: number;
  originZ: number;
  /** Cell size (m). */
  cell: number;
  /** Vertex counts along x and z. */
  nx: number;
  nz: number;
  heights: Float32Array;
  /** Ground material. */
  mat: string;
  surface: Surface;
  /** Optional overlay (e.g. mud): weight 0..1 per vertex, drawn over the ground. */
  overlay?: { mat: string; weights: Float32Array };
}

export interface TerrainHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Builds a terrain by sampling `height(x, z)` on the grid. */
export function makeTerrain(o: { minX: number; minZ: number; maxX: number; maxZ: number; cell: number; mat: string; surface?: Surface }, height: (x: number, z: number) => number): TerrainDef {
  const nx = Math.round((o.maxX - o.minX) / o.cell) + 1;
  const nz = Math.round((o.maxZ - o.minZ) / o.cell) + 1;
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = height(o.minX + i * o.cell, o.minZ + j * o.cell);
  return { originX: o.minX, originZ: o.minZ, cell: o.cell, nx, nz, heights, mat: o.mat, surface: o.surface ?? 'dirt' };
}

export function terrainBounds(t: TerrainDef): { minX: number; minZ: number; maxX: number; maxZ: number } {
  return { minX: t.originX, minZ: t.originZ, maxX: t.originX + (t.nx - 1) * t.cell, maxZ: t.originZ + (t.nz - 1) * t.cell };
}

const hAt = (t: TerrainDef, i: number, j: number) => t.heights[j * t.nx + i];

/** Height at (x, z); outside the grid the edge heights continue. */
export function terrainHeight(t: TerrainDef, x: number, z: number): number {
  const fx = (x - t.originX) / t.cell;
  const fz = (z - t.originZ) / t.cell;
  const i = Math.min(t.nx - 2, Math.max(0, Math.floor(fx)));
  const j = Math.min(t.nz - 2, Math.max(0, Math.floor(fz)));
  const u = Math.min(1, Math.max(0, fx - i));
  const v = Math.min(1, Math.max(0, fz - j));
  const h00 = hAt(t, i, j);
  const h10 = hAt(t, i + 1, j);
  const h01 = hAt(t, i, j + 1);
  const h11 = hAt(t, i + 1, j + 1);
  if (u >= v) return h00 + (h10 - h00) * u + (h11 - h10) * v;
  return h00 + (h11 - h01) * u + (h01 - h00) * v;
}

/** Unit surface normal at (x, z). */
export function terrainNormal(t: TerrainDef, x: number, z: number): [number, number, number] {
  const e = t.cell * 0.5;
  const dx = (terrainHeight(t, x + e, z) - terrainHeight(t, x - e, z)) / (2 * e);
  const dz = (terrainHeight(t, x, z + e) - terrainHeight(t, x, z - e)) / (2 * e);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
}

const EPS = 1e-9;

/** Ray/triangle (Möller-Trumbore); returns t or -1. */
function rayTri(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, a: number[], b: number[], c: number[]): number {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < EPS) return -1;
  const inv = 1 / det;
  const tx = ox - a[0];
  const ty = oy - a[1];
  const tz = oz - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}

const _a = [0, 0, 0];
const _b = [0, 0, 0];
const _c = [0, 0, 0];
const _d = [0, 0, 0];

/**
 * Nearest hit of a ray with the terrain surface from above (dir need not be normalized; t is in
 * units of |dir|). Walks the cells under the ray's ground track. Rays starting below the
 * surface are ignored, like the inside of a box.
 */
export function rayTerrain(t: TerrainDef, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): TerrainHit | null {
  if (oy < terrainHeight(t, ox, oz) - 1e-4) return null;
  const b = terrainBounds(t);
  // clip the ground track to the grid
  let t0 = 0;
  let t1 = maxT;
  for (const [o, d, lo, hi] of [[ox, dx, b.minX, b.maxX], [oz, dz, b.minZ, b.maxZ]] as const) {
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let a0 = (lo - o) / d;
    let a1 = (hi - o) / d;
    if (a0 > a1) [a0, a1] = [a1, a0];
    t0 = Math.max(t0, a0);
    t1 = Math.min(t1, a1);
    if (t0 > t1) return null;
  }
  const cs = t.cell;
  const sx = ox + dx * t0;
  const sz = oz + dz * t0;
  let ci = Math.min(t.nx - 2, Math.max(0, Math.floor((sx - t.originX) / cs)));
  let cj = Math.min(t.nz - 2, Math.max(0, Math.floor((sz - t.originZ) / cs)));
  const stepI = dx > 0 ? 1 : -1;
  const stepJ = dz > 0 ? 1 : -1;
  const invX = Math.abs(dx) > EPS ? 1 / dx : Infinity;
  const invZ = Math.abs(dz) > EPS ? 1 / dz : Infinity;
  let tMaxX = Number.isFinite(invX) ? (t.originX + (ci + (stepI > 0 ? 1 : 0)) * cs - ox) * invX : Infinity;
  let tMaxZ = Number.isFinite(invZ) ? (t.originZ + (cj + (stepJ > 0 ? 1 : 0)) * cs - oz) * invZ : Infinity;
  const tDX = Number.isFinite(invX) ? cs * Math.abs(invX) : Infinity;
  const tDZ = Number.isFinite(invZ) ? cs * Math.abs(invZ) : Infinity;
  let tEnter = t0;
  for (let guard = 0; guard < t.nx + t.nz + 4; guard++) {
    const tExit = Math.min(tMaxX, tMaxZ, t1);
    // quick reject: the ray stays above every corner of this cell
    const h00 = hAt(t, ci, cj);
    const h10 = hAt(t, ci + 1, cj);
    const h01 = hAt(t, ci, cj + 1);
    const h11 = hAt(t, ci + 1, cj + 1);
    const top = Math.max(h00, h10, h01, h11);
    const yIn = oy + dy * tEnter;
    const yOut = oy + dy * tExit;
    if (Math.min(yIn, yOut) <= top + 1e-6) {
      const x0 = t.originX + ci * cs;
      const z0 = t.originZ + cj * cs;
      _a[0] = x0; _a[1] = h00; _a[2] = z0;
      _b[0] = x0 + cs; _b[1] = h10; _b[2] = z0;
      _c[0] = x0 + cs; _c[1] = h11; _c[2] = z0 + cs;
      _d[0] = x0; _d[1] = h01; _d[2] = z0 + cs;
      let best = -1;
      let tri = 0;
      const ta = rayTri(ox, oy, oz, dx, dy, dz, _a, _b, _c);
      if (ta >= 0 && ta <= maxT) {
        best = ta;
        tri = 1;
      }
      const tb = rayTri(ox, oy, oz, dx, dy, dz, _a, _c, _d);
      if (tb >= 0 && tb <= maxT && (best < 0 || tb < best)) {
        best = tb;
        tri = 2;
      }
      if (best >= 0) {
        // normal of the triangle that was hit (pointing up)
        const nx = tri === 1 ? -(h10 - h00) / cs : -(h11 - h01) / cs;
        const nz = tri === 1 ? -(h11 - h10) / cs : -(h01 - h00) / cs;
        const l = Math.hypot(nx, 1, nz);
        return { t: best, nx: nx / l, ny: 1 / l, nz: nz / l };
      }
    }
    if (tExit >= t1) break;
    tEnter = tExit;
    if (tMaxX < tMaxZ) {
      ci += stepI;
      tMaxX += tDX;
      if (ci < 0 || ci > t.nx - 2) break;
    } else {
      cj += stepJ;
      tMaxZ += tDZ;
      if (cj < 0 || cj > t.nz - 2) break;
    }
  }
  return null;
}
