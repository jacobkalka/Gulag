import type { MapDef, Surface } from './mapTypes';
import { PLANT_COVER, PLANT_TRUNK, PROP_COLLIDERS, type PropCollider } from './propColliders';
import { rayTerrain, terrainHeight, type TerrainDef } from './terrain';

// Static collision world: AABBs, vertical cylinders and ramps (wedges) in a uniform XZ grid.
// Used by player movement (cylinder vs world), bullets/LOS (raycasts) and bot navigation.
// Pure data + math: no three.js, safe to run on the host simulation.

export const SOLID = 1;
export const OPAQUE = 2;
/** Blocks sight but not bullets: foliage, tents. Bots look through OPAQUE | CONCEAL. */
export const CONCEAL = 4;

export const SURFACES: Surface[] = ['concrete', 'metal', 'tile', 'wood', 'water', 'fabric', 'glass', 'dirt'];

export interface Prim {
  kind: 0 | 1 | 2; // box | cylinder | ramp
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** cylinder center/radius (kind 1) */
  cx: number;
  cz: number;
  r: number;
  /** ramp: rises along axis 0=x / 1=z in direction dir */
  axis: 0 | 1;
  dir: 1 | -1;
  flags: number;
  surface: number;
}

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  surface: Surface;
  prim: number;
}

const EPS = 1e-6;

export class CollisionWorld {
  readonly prims: Prim[] = [];
  readonly cellSize = 2;
  originX = -28;
  originZ = -20;
  nx = 28;
  nz = 20;
  private cells: number[][] = [];
  /** Outdoor ground (a heightfield under everything else). */
  terrain: TerrainDef | null = null;
  private terrainSurface = 0;
  private stamp: Uint32Array = new Uint32Array(0);
  private stampId = 1;

  constructor(bounds?: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    if (bounds) {
      this.originX = Math.floor(bounds.minX) - 2;
      this.originZ = Math.floor(bounds.minZ) - 2;
      this.nx = Math.ceil((bounds.maxX - this.originX + 2) / this.cellSize);
      this.nz = Math.ceil((bounds.maxZ - this.originZ + 2) / this.cellSize);
    }
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
  }

  static fromMap(map: MapDef, activeTags: string[] = []): CollisionWorld {
    const tags = new Set(activeTags);
    const w = new CollisionWorld({ minX: map.bounds.min[0], minZ: map.bounds.min[2], maxX: map.bounds.max[0], maxZ: map.bounds.max[2] });
    for (const b of map.brushes) {
      if (b.tag && !tags.has(b.tag)) continue;
      const solid = b.solid !== false;
      const opaque = b.opaque !== false && b.visible !== false;
      if (!solid && !opaque) continue;
      w.addBox(b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2], (solid ? SOLID : 0) | (opaque ? OPAQUE : 0), b.surface ?? 'concrete');
    }
    for (const r of map.ramps) {
      w.addRamp(r.min[0], r.min[1], r.min[2], r.max[0], r.max[1], r.max[2], r.axis === 'x' ? 0 : 1, r.dir, SOLID | OPAQUE, r.surface ?? 'metal');
    }
    for (const p of map.props) {
      if (p.tag && !tags.has(p.tag)) continue;
      const cols = PROP_COLLIDERS[p.type];
      if (!cols) continue;
      for (const c of cols(p.v ?? 0)) w.addPropCollider(c, p.pos, p.rot ?? 0, p.scale ?? 1);
    }
    // plants: trunks block everything, leafy plants hide you without stopping bullets
    for (const pl of map.plants ?? []) {
      const r = PLANT_TRUNK[pl.kind] * pl.scale;
      if (r > 0) w.addCyl(pl.pos[0], pl.pos[2], r, pl.pos[1] - 0.5, pl.pos[1] + (pl.kind === 'buttress' ? 24 : 3.5 * pl.scale), SOLID | OPAQUE, 'wood');
      const cover = PLANT_COVER[pl.kind];
      if (cover) w.addCyl(pl.pos[0], pl.pos[2], cover.r * pl.scale, pl.pos[1], pl.pos[1] + cover.h * pl.scale, CONCEAL, 'fabric');
    }
    if (map.terrain) {
      w.terrain = map.terrain;
      w.terrainSurface = Math.max(0, SURFACES.indexOf(map.terrain.surface));
    }
    w.finalize();
    return w;
  }

  addBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, flags: number, surface: Surface): void {
    this.prims.push({
      kind: 0,
      minX: Math.min(x0, x1), minY: Math.min(y0, y1), minZ: Math.min(z0, z1),
      maxX: Math.max(x0, x1), maxY: Math.max(y0, y1), maxZ: Math.max(z0, z1),
      cx: 0, cz: 0, r: 0, axis: 0, dir: 1, flags, surface: Math.max(0, SURFACES.indexOf(surface)),
    });
  }

  addCyl(x: number, z: number, r: number, y0: number, y1: number, flags: number, surface: Surface): void {
    this.prims.push({
      kind: 1, minX: x - r, minY: y0, minZ: z - r, maxX: x + r, maxY: y1, maxZ: z + r,
      cx: x, cz: z, r, axis: 0, dir: 1, flags, surface: Math.max(0, SURFACES.indexOf(surface)),
    });
  }

  addRamp(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, axis: 0 | 1, dir: 1 | -1, flags: number, surface: Surface): void {
    this.prims.push({
      kind: 2,
      minX: Math.min(x0, x1), minY: Math.min(y0, y1), minZ: Math.min(z0, z1),
      maxX: Math.max(x0, x1), maxY: Math.max(y0, y1), maxZ: Math.max(z0, z1),
      cx: 0, cz: 0, r: 0, axis, dir, flags, surface: Math.max(0, SURFACES.indexOf(surface)),
    });
  }

  /** Transforms a prop-local collider by yaw (multiples of 90 deg are exact; others use a bounding box). */
  addPropCollider(c: PropCollider, pos: [number, number, number], rot: number, scale: number): void {
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // three.js yaw rotation: x' = x cos + z sin ; z' = -x sin + z cos
    const tf = (x: number, z: number): [number, number] => [pos[0] + (x * cos + z * sin) * scale, pos[2] + (-x * sin + z * cos) * scale];
    const flags = c.flags === 'solid' ? SOLID : c.flags === 'conceal' ? SOLID | CONCEAL : SOLID | OPAQUE;
    if (c.kind === 'cyl') {
      const [x, z] = tf(c.x, c.z);
      this.addCyl(x, z, c.r * scale, pos[1] + c.y0 * scale, pos[1] + c.y1 * scale, flags, c.surface);
      return;
    }
    const corners = [tf(c.min[0], c.min[2]), tf(c.max[0], c.min[2]), tf(c.max[0], c.max[2]), tf(c.min[0], c.max[2])];
    const xs = corners.map((p) => p[0]);
    const zs = corners.map((p) => p[1]);
    const y0 = pos[1] + c.min[1] * scale;
    const y1 = pos[1] + c.max[1] * scale;
    if (c.kind === 'box') {
      this.addBox(Math.min(...xs), y0, Math.min(...zs), Math.max(...xs), y1, Math.max(...zs), flags, c.surface);
      return;
    }
    // ramp: rotate the rise direction by the yaw (snapped to 90 degrees)
    const q = ((Math.round(rot / (Math.PI / 2)) % 4) + 4) % 4;
    let axis: 0 | 1 = c.axis === 'x' ? 0 : 1;
    let dir = c.dir;
    // local +x maps to world: q=0 +x, q=1 -z, q=2 -x, q=3 +z ; local +z: q=0 +z, q=1 +x, q=2 -z, q=3 -x
    if (axis === 0) {
      if (q === 1) { axis = 1; dir = (-dir) as 1 | -1; }
      else if (q === 2) { dir = (-dir) as 1 | -1; }
      else if (q === 3) { axis = 1; }
    } else {
      if (q === 1) { axis = 0; }
      else if (q === 2) { dir = (-dir) as 1 | -1; }
      else if (q === 3) { axis = 0; dir = (-dir) as 1 | -1; }
    }
    this.addRamp(Math.min(...xs), y0, Math.min(...zs), Math.max(...xs), y1, Math.max(...zs), axis, dir, flags, c.surface);
  }

  finalize(): void {
    for (const c of this.cells) c.length = 0;
    this.prims.forEach((p, i) => {
      const x0 = this.cellX(p.minX);
      const x1 = this.cellX(p.maxX);
      const z0 = this.cellZ(p.minZ);
      const z1 = this.cellZ(p.maxZ);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells[z * this.nx + x].push(i);
    });
    this.stamp = new Uint32Array(this.prims.length);
  }

  private cellX(x: number): number {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.originX) / this.cellSize)));
  }
  private cellZ(z: number): number {
    return Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.originZ) / this.cellSize)));
  }

  /** Calls cb for every primitive whose cell range overlaps the XZ rectangle (deduplicated). */
  queryXZ(minX: number, minZ: number, maxX: number, maxZ: number, cb: (p: Prim, i: number) => void): void {
    const id = ++this.stampId;
    if (id === 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const x0 = this.cellX(minX);
    const x1 = this.cellX(maxX);
    const z0 = this.cellZ(minZ);
    const z1 = this.cellZ(maxZ);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const list = this.cells[z * this.nx + x];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (this.stamp[i] === id) continue;
          this.stamp[i] = id;
          const p = this.prims[i];
          if (p.maxX < minX || p.minX > maxX || p.maxZ < minZ || p.minZ > maxZ) continue;
          cb(p, i);
        }
      }
    }
  }

  /** Height of a ramp's top surface at (x,z) clamped into its footprint. */
  rampHeight(p: Prim, x: number, z: number): number {
    if (p.axis === 0) {
      const t = (Math.min(p.maxX, Math.max(p.minX, x)) - p.minX) / Math.max(EPS, p.maxX - p.minX);
      return p.minY + (p.dir > 0 ? t : 1 - t) * (p.maxY - p.minY);
    }
    const t = (Math.min(p.maxZ, Math.max(p.minZ, z)) - p.minZ) / Math.max(EPS, p.maxZ - p.minZ);
    return p.minY + (p.dir > 0 ? t : 1 - t) * (p.maxY - p.minY);
  }

  /** Top height of a primitive at (x, z) for a body of radius r (ramps sample the uphill side). */
  topAt(p: Prim, x: number, z: number, r: number): number {
    if (p.kind !== 2) return p.maxY;
    const ox = p.axis === 0 ? p.dir * r * 0.5 : 0;
    const oz = p.axis === 1 ? p.dir * r * 0.5 : 0;
    return this.rampHeight(p, x + ox, z + oz);
  }

  /** Highest walkable surface under a circle with top in [feetY - maxDown, feetY + maxUp]. Returns -Infinity if none. */
  supportHeight(x: number, z: number, r: number, feetY: number, maxUp: number, maxDown = 10): { y: number; surface: number } {
    let best = -Infinity;
    let surf = 0;
    const rr = r * 0.85;
    this.queryXZ(x - rr, z - rr, x + rr, z + rr, (p) => {
      if (!(p.flags & SOLID)) return;
      if (!overlapCircle(p, x, z, rr)) return;
      const top = this.topAt(p, x, z, rr);
      if (top > feetY + maxUp || top < feetY - maxDown) return;
      if (top > best) {
        best = top;
        surf = p.surface;
      }
    });
    if (this.terrain) {
      const top = terrainHeight(this.terrain, x, z);
      if (top <= feetY + maxUp && top >= feetY - maxDown && top > best) {
        best = top;
        surf = this.terrainSurface;
      }
    }
    return { y: best, surface: surf };
  }

  /** Lowest ceiling (primitive bottom) above `fromY` overlapping the circle; Infinity if none. */
  ceilingHeight(x: number, z: number, r: number, fromY: number): number {
    let best = Infinity;
    this.queryXZ(x - r, z - r, x + r, z + r, (p) => {
      if (!(p.flags & SOLID)) return;
      if (p.minY < fromY - 0.01) return;
      if (!overlapCircle(p, x, z, r)) return;
      if (p.minY < best) best = p.minY;
    });
    return best;
  }

  /**
   * Pushes a vertical cylinder (feet at y, height h, radius r) out of solid geometry horizontally.
   * Geometry whose top is within `step` of the feet is ignored (it is stepped onto instead).
   */
  resolveCylinder(pos: { x: number; y: number; z: number }, r: number, h: number, step: number): boolean {
    let collided = false;
    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;
      this.queryXZ(pos.x - r, pos.z - r, pos.x + r, pos.z + r, (p) => {
        if (!(p.flags & SOLID)) return;
        const top = p.kind === 2 ? this.rampHeight(p, pos.x, pos.z) : p.maxY;
        if (top <= pos.y + step + 1e-4) return;
        if (p.minY >= pos.y + h - 1e-4) return;
        if (p.kind === 1) {
          const dx = pos.x - p.cx;
          const dz = pos.z - p.cz;
          const d = Math.hypot(dx, dz);
          const min = r + p.r;
          if (d < min) {
            const nx = d > EPS ? dx / d : 1;
            const nz = d > EPS ? dz / d : 0;
            pos.x = p.cx + nx * min;
            pos.z = p.cz + nz * min;
            pushed = true;
          }
          return;
        }
        const cx = Math.max(p.minX, Math.min(pos.x, p.maxX));
        const cz = Math.max(p.minZ, Math.min(pos.z, p.maxZ));
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) return;
        if (d2 > EPS) {
          const d = Math.sqrt(d2);
          pos.x += (dx / d) * (r - d);
          pos.z += (dz / d) * (r - d);
        } else {
          // center inside: exit along the smallest penetration
          const pl = pos.x - p.minX + r;
          const pr = p.maxX - pos.x + r;
          const pb = pos.z - p.minZ + r;
          const pf = p.maxZ - pos.z + r;
          const m = Math.min(pl, pr, pb, pf);
          if (m === pl) pos.x -= pl;
          else if (m === pr) pos.x += pr;
          else if (m === pb) pos.z -= pb;
          else pos.z += pf;
        }
        pushed = true;
      });
      if (!pushed) break;
      collided = true;
    }
    return collided;
  }

  /** True if a vertical cylinder overlaps any solid primitive (used to test standing up). */
  cylinderBlocked(x: number, y: number, z: number, r: number, h: number): boolean {
    // the ground only blocks a body buried in it (standing on a slope is fine)
    if (this.terrain && terrainHeight(this.terrain, x, z) > y + 0.3) return true;
    let blocked = false;
    this.queryXZ(x - r, z - r, x + r, z + r, (p) => {
      if (blocked || !(p.flags & SOLID)) return;
      const top = p.kind === 2 ? this.rampHeight(p, x, z) : p.maxY;
      if (top <= y + 0.02 || p.minY >= y + h) return;
      if (overlapCircle(p, x, z, r * 0.98)) blocked = true;
    });
    return blocked;
  }

  /** Nearest hit along a ray (dir need not be normalized; t is in units of |dir|). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, mask = OPAQUE): RayHit | null {
    let best: RayHit | null = null;
    let bestT = maxT;
    // the ground stops everything: test it first so the grid walk can stop early
    if (this.terrain && mask & (SOLID | OPAQUE)) {
      const h = rayTerrain(this.terrain, ox, oy, oz, dx, dy, dz, maxT);
      if (h) {
        bestT = h.t;
        best = { t: h.t, x: ox + dx * h.t, y: oy + dy * h.t, z: oz + dz * h.t, nx: h.nx, ny: h.ny, nz: h.nz, surface: surfaceName(this.terrainSurface), prim: -1 };
      }
    }
    const id = ++this.stampId;
    // 2D DDA over XZ cells
    let cx = this.cellX(ox);
    let cz = this.cellZ(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invX = Math.abs(dx) > EPS ? 1 / dx : Infinity;
    const invZ = Math.abs(dz) > EPS ? 1 / dz : Infinity;
    const nextBX = this.originX + (cx + (stepX > 0 ? 1 : 0)) * this.cellSize;
    const nextBZ = this.originZ + (cz + (stepZ > 0 ? 1 : 0)) * this.cellSize;
    let tMaxX = Number.isFinite(invX) ? (nextBX - ox) * invX : Infinity;
    let tMaxZ = Number.isFinite(invZ) ? (nextBZ - oz) * invZ : Infinity;
    const tDX = Number.isFinite(invX) ? this.cellSize * Math.abs(invX) : Infinity;
    const tDZ = Number.isFinite(invZ) ? this.cellSize * Math.abs(invZ) : Infinity;
    for (let guard = 0; guard < 512; guard++) {
      const list = this.cells[cz * this.nx + cx];
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (this.stamp[i] === id) continue;
        this.stamp[i] = id;
        const p = this.prims[i];
        if (!(p.flags & mask)) continue;
        const h = rayPrim(p, ox, oy, oz, dx, dy, dz, bestT);
        if (h && h.t < bestT) {
          bestT = h.t;
          h.prim = i;
          best = h;
        }
      }
      const tExit = Math.min(tMaxX, tMaxZ);
      if (bestT <= tExit || tExit > maxT) break;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDX;
        if (cx < 0 || cx >= this.nx) break;
      } else {
        cz += stepZ;
        tMaxZ += tDZ;
        if (cz < 0 || cz >= this.nz) break;
      }
    }
    return best;
  }

  /** Line of sight between two points (true if nothing opaque in between). */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    return this.raycast(ax, ay, az, dx, dy, dz, 0.999, OPAQUE) === null;
  }

  /** Whether a person at a could see b: like lineOfSight, but foliage and tents hide you too. */
  canSee(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.raycast(ax, ay, az, bx - ax, by - ay, bz - az, 0.999, OPAQUE | CONCEAL) === null;
  }
}

function overlapCircle(p: Prim, x: number, z: number, r: number): boolean {
  if (p.kind === 1) {
    const dx = x - p.cx;
    const dz = z - p.cz;
    return dx * dx + dz * dz < (r + p.r) * (r + p.r);
  }
  const cx = Math.max(p.minX, Math.min(x, p.maxX));
  const cz = Math.max(p.minZ, Math.min(z, p.maxZ));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

function surfaceName(i: number): Surface {
  return SURFACES[i] ?? 'concrete';
}

function rayPrim(p: Prim, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): RayHit | null {
  if (p.kind === 0) return rayBox(p, ox, oy, oz, dx, dy, dz, maxT);
  if (p.kind === 1) return rayCyl(p, ox, oy, oz, dx, dy, dz, maxT);
  return rayRamp(p, ox, oy, oz, dx, dy, dz, maxT);
}

function rayBox(p: Prim, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): RayHit | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = -1;
  let sgn = 0;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [p.minX, p.minY, p.minZ];
  const mx = [p.maxX, p.maxY, p.maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < EPS) {
      if (o[a] < mn[a] || o[a] > mx[a]) return null;
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (mn[a] - o[a]) * inv;
    let t2 = (mx[a] - o[a]) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = a;
      sgn = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin < 0 || tmin > maxT || axis < 0) return null; // origin inside or behind: ignore
  const n = [0, 0, 0];
  n[axis] = sgn;
  return { t: tmin, x: ox + dx * tmin, y: oy + dy * tmin, z: oz + dz * tmin, nx: n[0], ny: n[1], nz: n[2], surface: surfaceName(p.surface), prim: -1 };
}

function rayCyl(p: Prim, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): RayHit | null {
  let best = Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  // side
  const fx = ox - p.cx;
  const fz = oz - p.cz;
  const a = dx * dx + dz * dz;
  if (a > EPS) {
    const b = 2 * (fx * dx + fz * dz);
    const c = fx * fx + fz * fz - p.r * p.r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t < best) {
        const y = oy + dy * t;
        if (y >= p.minY && y <= p.maxY) {
          best = t;
          nx = (fx + dx * t) / p.r;
          nz = (fz + dz * t) / p.r;
          ny = 0;
        }
      }
    }
  }
  // caps
  if (Math.abs(dy) > EPS) {
    for (const [y, s] of [[p.maxY, 1], [p.minY, -1]] as const) {
      const t = (y - oy) / dy;
      if (t >= 0 && t < best) {
        const hx = fx + dx * t;
        const hz = fz + dz * t;
        if (hx * hx + hz * hz <= p.r * p.r) {
          best = t;
          nx = 0;
          nz = 0;
          ny = s;
        }
      }
    }
  }
  if (best > maxT) return null;
  return { t: best, x: ox + dx * best, y: oy + dy * best, z: oz + dz * best, nx, ny, nz, surface: surfaceName(p.surface), prim: -1 };
}

function rayRamp(p: Prim, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): RayHit | null {
  // Convex wedge as the intersection of half-spaces n.x <= d (Cyrus-Beck clipping).
  const planes: [number, number, number, number][] = [
    [-1, 0, 0, -p.minX],
    [1, 0, 0, p.maxX],
    [0, 0, -1, -p.minZ],
    [0, 0, 1, p.maxZ],
    [0, -1, 0, -p.minY],
  ];
  const rise = p.maxY - p.minY;
  if (p.axis === 0) {
    const run = Math.max(EPS, p.maxX - p.minX);
    const s = rise / run;
    // dir +1: y <= minY + (x-minX)*s  ->  -s*x + y <= minY - minX*s
    if (p.dir > 0) planes.push([-s, 1, 0, p.minY - p.minX * s]);
    else planes.push([s, 1, 0, p.minY + p.maxX * s]);
  } else {
    const run = Math.max(EPS, p.maxZ - p.minZ);
    const s = rise / run;
    if (p.dir > 0) planes.push([0, 1, -s, p.minY - p.minZ * s]);
    else planes.push([0, 1, s, p.minY + p.maxZ * s]);
  }
  let tE = 0;
  let tL = maxT;
  let hit = -1;
  for (let i = 0; i < planes.length; i++) {
    const [a, b, c, d] = planes[i];
    const num = d - (a * ox + b * oy + c * oz);
    const den = a * dx + b * dy + c * dz;
    if (Math.abs(den) < EPS) {
      if (num < 0) return null;
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > tE) {
        tE = t;
        hit = i;
      }
    } else if (t < tL) tL = t;
    if (tE > tL) return null;
  }
  if (hit < 0) return null; // origin inside
  const [a, b, c] = planes[hit];
  const l = Math.hypot(a, b, c);
  return { t: tE, x: ox + dx * tE, y: oy + dy * tE, z: oz + dz * tE, nx: a / l, ny: b / l, nz: c / l, surface: surfaceName(p.surface), prim: -1 };
}
