import { CollisionWorld, OPAQUE, SOLID } from '@/game/world/collision';
import type { MapDef } from '@/game/world/mapTypes';

// Navigation for bots: a multi-layer walkable grid sampled from the collision world,
// A* search, line-of-sight path smoothing, and precomputed cover spots.

export interface NavNode {
  id: number;
  x: number;
  y: number;
  z: number;
  cx: number;
  cz: number;
  /** Neighbor node ids. */
  links: number[];
  /** Distance to the nearest blocked cell (meters, capped) — keeps paths off walls. */
  clearance: number;
}

export interface CoverSpot {
  node: number;
  x: number;
  y: number;
  z: number;
  /** Unit vector pointing from the cover obstacle toward the spot (the "safe" side). */
  nx: number;
  nz: number;
  /** 'low' = crouch behind it, 'high' = full cover (peek by strafing). */
  kind: 'low' | 'high';
}

const CELL = 0.5;
const NAV_R = 0.26;
const STEP = 0.45;

class Heap {
  private a: number[] = [];
  private f: Float64Array;
  constructor(n: number) {
    this.f = new Float64Array(n);
  }
  push(id: number, f: number): void {
    this.f[id] = f;
    const a = this.a;
    a.push(id);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[a[p]] <= this.f[a[i]]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l;
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.a.length;
  }
}

export class NavGrid {
  readonly nodes: NavNode[] = [];
  readonly cover: CoverSpot[] = [];
  private byCell = new Map<number, number[]>();
  readonly minX: number;
  readonly minZ: number;
  readonly nx: number;
  readonly nz: number;

  constructor(readonly world: CollisionWorld, map: MapDef, maxWalkY = 3.3) {
    this.minX = Math.floor(map.bounds.min[0]);
    this.minZ = Math.floor(map.bounds.min[2]);
    this.nx = Math.ceil((map.bounds.max[0] - this.minX) / CELL) + 1;
    this.nz = Math.ceil((map.bounds.max[2] - this.minZ) / CELL) + 1;
    // Nothing walkable exists above the catwalks; sampling from just above them skips
    // roofs and ceiling plenums entirely.
    this.build(maxWalkY);
  }

  private key(cx: number, cz: number): number {
    return cz * this.nx + cx;
  }

  cellOf(x: number, z: number): [number, number] {
    return [Math.round((x - this.minX) / CELL), Math.round((z - this.minZ) / CELL)];
  }

  private build(topY: number): void {
    const w = this.world;
    for (let cz = 0; cz < this.nz; cz++) {
      for (let cx = 0; cx < this.nx; cx++) {
        const x = this.minX + cx * CELL;
        const z = this.minZ + cz * CELL;
        let probe = topY;
        for (let layer = 0; layer < 8; layer++) {
          const s = w.supportHeight(x, z, NAV_R, probe, 0, probe + 2);
          if (s.y === -Infinity) break;
          const y = s.y;
          if (!w.cylinderBlocked(x, y + 0.05, z, NAV_R, 1.65)) {
            const id = this.nodes.length;
            this.nodes.push({ id, x, y, z, cx, cz, links: [], clearance: 0 });
            const k = this.key(cx, cz);
            const list = this.byCell.get(k);
            if (list) list.push(id);
            else this.byCell.set(k, [id]);
          }
          probe = y - 0.9;
          if (probe < -0.5) break;
        }
      }
    }
    // links (8-neighborhood, height step limited, diagonal must not cut corners)
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    for (const n of this.nodes) {
      for (const [dx, dz] of dirs) {
        const list = this.byCell.get(this.key(n.cx + dx, n.cz + dz));
        if (!list) continue;
        for (const mId of list) {
          const m = this.nodes[mId];
          if (Math.abs(m.y - n.y) > STEP) continue;
          if (dx !== 0 && dz !== 0) {
            if (!this.nodeAt(n.cx + dx, n.cz, n.y) || !this.nodeAt(n.cx, n.cz + dz, n.y)) continue;
          }
          n.links.push(mId);
        }
      }
    }
    this.pruneIslands(40);
    // clearance: BFS distance (in cells) from nodes with missing neighbors
    const dist = new Int32Array(this.nodes.length).fill(-1);
    const q: number[] = [];
    for (const n of this.nodes) {
      if (n.links.length < 8) {
        dist[n.id] = 0;
        q.push(n.id);
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const id = q[qi];
      for (const l of this.nodes[id].links) {
        if (dist[l] < 0) {
          dist[l] = dist[id] + 1;
          q.push(l);
        }
      }
    }
    for (const n of this.nodes) n.clearance = Math.min(4, Math.max(0, dist[n.id])) * CELL;
    this.buildCover();
  }

  /** Drops small disconnected components (tops of crates/counters reachable only by mantling). */
  private pruneIslands(minSize: number): void {
    const comp = new Int32Array(this.nodes.length).fill(-1);
    const sizes: number[] = [];
    for (const n of this.nodes) {
      if (comp[n.id] >= 0) continue;
      const c = sizes.length;
      let size = 0;
      const stack = [n.id];
      comp[n.id] = c;
      while (stack.length) {
        const id = stack.pop()!;
        size++;
        for (const l of this.nodes[id].links) {
          if (comp[l] < 0) {
            comp[l] = c;
            stack.push(l);
          }
        }
      }
      sizes.push(size);
    }
    const keep = this.nodes.filter((n) => sizes[comp[n.id]] >= minSize);
    if (keep.length === this.nodes.length) return;
    const remap = new Int32Array(this.nodes.length).fill(-1);
    keep.forEach((n, i) => (remap[n.id] = i));
    for (const n of keep) {
      n.links = n.links.map((l) => remap[l]).filter((l) => l >= 0);
      n.id = remap[n.id];
    }
    this.nodes.length = 0;
    this.nodes.push(...keep);
    this.byCell.clear();
    for (const n of this.nodes) {
      const k = this.key(n.cx, n.cz);
      const list = this.byCell.get(k);
      if (list) list.push(n.id);
      else this.byCell.set(k, [n.id]);
    }
  }

  private nodeAt(cx: number, cz: number, y: number): number {
    const list = this.byCell.get(this.key(cx, cz));
    if (!list) return -1;
    for (const id of list) if (Math.abs(this.nodes[id].y - y) <= STEP) return id;
    return -1;
  }

  /** Nearest node to a world position (same floor level strongly preferred). */
  nearest(x: number, y: number, z: number): number {
    const [cx, cz] = this.cellOf(x, z);
    let best = -1;
    let bestD = Infinity;
    let foundRing = -1;
    for (let r = 0; r <= 8; r++) {
      if (foundRing >= 0 && r > foundRing + 1) break;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const list = this.byCell.get(this.key(cx + dx, cz + dz));
          if (!list) continue;
          for (const id of list) {
            const n = this.nodes[id];
            const dy = n.y - y;
            const d = (n.x - x) ** 2 + (n.z - z) ** 2 + dy * dy * 9 + (Math.abs(dy) > 0.6 ? 25 : 0);
            if (d < bestD) {
              bestD = d;
              best = id;
              if (foundRing < 0) foundRing = r;
            }
          }
        }
      }
    }
    return best;
  }

  /** A* from a to b; returns node ids (including both ends) or null. */
  findPath(a: number, b: number, maxIter = 20000): number[] | null {
    if (a < 0 || b < 0) return null;
    if (a === b) return [a];
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new Heap(N);
    const goal = this.nodes[b];
    g[a] = 0;
    heap.push(a, 0);
    let iter = 0;
    while (heap.size && iter++ < maxIter) {
      const cur = heap.pop();
      if (cur === b) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cn = this.nodes[cur];
      for (const nb of cn.links) {
        if (closed[nb]) continue;
        const nn = this.nodes[nb];
        const step = Math.hypot(nn.x - cn.x, nn.z - cn.z, (nn.y - cn.y) * 1.5);
        const wallPenalty = nn.clearance < 0.6 ? (0.6 - nn.clearance) * 1.2 : 0;
        const ng = g[cur] + step + wallPenalty;
        if (ng < g[nb]) {
          g[nb] = ng;
          came[nb] = cur;
          heap.push(nb, ng + Math.hypot(goal.x - nn.x, goal.z - nn.z, goal.y - nn.y));
        }
      }
    }
    if (came[b] < 0) return null;
    const path = [b];
    let c = b;
    while (c !== a) {
      c = came[c];
      if (c < 0) return null;
      path.push(c);
    }
    return path.reverse();
  }

  /** Removes intermediate waypoints that can be walked straight past. */
  smooth(path: number[]): { x: number; y: number; z: number }[] {
    const pts = path.map((id) => this.nodes[id]);
    if (pts.length <= 2) return pts.map((n) => ({ x: n.x, y: n.y, z: n.z }));
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 24);
      for (; j > i + 1; j--) if (this.walkable(pts[i], pts[j])) break;
      out.push(pts[j]);
      i = j;
    }
    return out.map((n) => ({ x: n.x, y: n.y, z: n.z }));
  }

  /** Straight walk check between two nodes (no wall at knee/waist height, small height change). */
  walkable(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
    if (Math.abs(a.y - b.y) > 1.0) return false;
    const w = this.world;
    for (const h of [0.35, 0.9, 1.5]) {
      for (const off of [-0.34, -0.22, -0.11, 0, 0.11, 0.22, 0.34]) {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const px = (-dz / l) * off;
        const pz = (dx / l) * off;
        if (w.raycast(a.x + px, a.y + h, a.z + pz, dx, b.y - a.y, dz, 1, SOLID)) return false;
      }
    }
    // ground continuity: sample midpoints for holes (catwalk edge)
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.8);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      const sup = w.supportHeight(x, z, 0.2, y + 0.3, 0.3, 0.6);
      if (sup.y === -Infinity) return false;
    }
    return true;
  }

  private buildCover(): void {
    const w = this.world;
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
    ];
    for (const n of this.nodes) {
      if (n.clearance > 0.6) continue;
      for (const [dx, dz] of dirs) {
        // obstacle right next to the node in this direction?
        const lowHit = w.raycast(n.x, n.y + 0.9, n.z, dx, 0, dz, 0.8, OPAQUE);
        if (!lowHit) continue;
        const highHit = w.raycast(n.x, n.y + 1.7, n.z, dx, 0, dz, 0.8, OPAQUE);
        const crouchHit = w.raycast(n.x, n.y + 1.15, n.z, dx, 0, dz, 0.8, OPAQUE);
        if (!crouchHit) continue;
        // skip spots against long walls with no peek opportunity: require an edge within 1.2 m sideways for high cover
        const kind: 'low' | 'high' = highHit ? 'high' : 'low';
        if (kind === 'high') {
          const sx = -dz;
          const sz = dx;
          let edge = false;
          for (const side of [1, -1]) {
            for (const d of [0.6, 1.0, 1.4]) {
              const px = n.x + sx * side * d;
              const pz = n.z + sz * side * d;
              if (!w.raycast(px, n.y + 1.5, pz, dx, 0, dz, 1.0, OPAQUE)) {
                edge = true;
                break;
              }
            }
            if (edge) break;
          }
          if (!edge) continue;
        }
        this.cover.push({ node: n.id, x: n.x, y: n.y, z: n.z, nx: -dx, nz: -dz, kind });
        break;
      }
    }
  }
}
