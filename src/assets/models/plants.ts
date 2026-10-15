import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '@/shared/rng';
import { heightToNormalTexture } from '@/assets/textures/canvasTextures';
import type { PlantKind } from '@/game/world/mapTypes';
import { PLANT_TRUNK } from '@/game/world/propColliders';

// Jungle plants for outdoor maps: a procedural leaf atlas and geometry for ferns, tree ferns, palms,
// banana plants, monstera, bushes, grass and buttress trees hung with lianas. Leaves are alpha-
// tested cards bent along curves with a slight fold down the middle. Every vertex carries a sway
// amplitude (aSway, meters) so one wind shader moves fern tips a little and palm crowns a lot.

export type { PlantKind } from '@/game/world/mapTypes';

/** Leaf atlas cells (4 x 2). */
export const LEAF = { fern: 0, palm: 1, banana: 2, broad: 3, grass: 4, vine: 5, treeFern: 6, monstera: 7 } as const;
const COLS = 4;
const ROWS = 2;

export interface PlantModel {
  leaves: THREE.BufferGeometry | null;
  trunk: THREE.BufferGeometry | null;
  /** Rough height and canopy radius (for culling and placement). */
  height: number;
  radius: number;
}

// ------------------------------------------------------------------ geometry accumulation

class Part {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  sway: number[] = [];
  idx: number[] = [];
  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, s: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.sway.push(s);
    return this.pos.length / 3 - 1;
  }
  geometry(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/** Atlas UV for a cell, with a small inset against bleeding. */
function cellUV(cell: number, u: number, v: number): [number, number] {
  const cx = cell % COLS;
  const cy = Math.floor(cell / COLS);
  const inset = 0.012;
  return [(cx + inset + u * (1 - 2 * inset)) / COLS, 1 - (cy + 1 - inset - v * (1 - 2 * inset)) / ROWS];
}

/**
 * A leaf card bent along a gravity curve: starts at `base` heading along `dir` (unit), droops by
 * `droop * len` at the tip, folds along its midrib. The texture runs base (v=0) to tip (v=1).
 */
function frond(part: Part, base: THREE.Vector3, dir: THREE.Vector3, len: number, width: number, droop: number, cell: number, baseSway: number, tipSway: number, segs = 6, fold = 0.14, twist = 0): void {
  const rows: number[][] = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    // centerline and tangent
    _p.copy(base).addScaledVector(dir, len * t);
    _p.y -= droop * len * t * t;
    _t.copy(dir).multiplyScalar(len);
    _t.y -= 2 * droop * len * t;
    _t.normalize();
    // side vector: horizontal-ish, perpendicular to the tangent, turned by the twist
    _s.crossVectors(_t, UP);
    if (_s.lengthSq() < 1e-6) _s.set(1, 0, 0);
    _s.normalize();
    _n.crossVectors(_s, _t).normalize();
    if (twist) {
      const a = twist * t;
      const c = Math.cos(a);
      const si = Math.sin(a);
      _q.copy(_s).multiplyScalar(c).addScaledVector(_n, si);
      _n.multiplyScalar(c).addScaledVector(_s, -si);
      _s.copy(_q);
    }
    const w = width * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.15 + 0.08) * Math.PI * 0.5 + 0.1));
    const sw = baseSway + (tipSway - baseSway) * Math.pow(t, 1.5);
    const row: number[] = [];
    for (const k of [-1, 0, 1]) {
      const p = _q.copy(_p).addScaledVector(_s, (k * w) / 2);
      if (k === 0) p.addScaledVector(_n, w * fold);
      const [u, v] = cellUV(cell, (k + 1) / 2, t);
      row.push(part.vert(p, _n, u, v, sw));
    }
    rows.push(row);
  }
  for (let s = 0; s < segs; s++) {
    const a = rows[s];
    const b = rows[s + 1];
    for (let k = 0; k < 2; k++) part.idx.push(a[k], a[k + 1], b[k + 1], a[k], b[k + 1], b[k]);
  }
}

/** A tube along a polyline with a radius per point (trunks, stems, lianas). */
function tube(part: Part, pts: THREE.Vector3[], radii: number[], sways: number[], seg: number, uvScale: [number, number] = [1, 1]): void {
  const rings: number[][] = [];
  let along = 0;
  const prevSide = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    const t = _t.copy(pts[Math.min(pts.length - 1, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
    // keep the ring frame from twisting: side stays close to the previous one
    const side = prevSide.clone().addScaledVector(t, -prevSide.dot(t));
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1).addScaledVector(t, -t.z);
    side.normalize();
    prevSide.copy(side);
    const bi = new THREE.Vector3().crossVectors(t, side).normalize();
    if (i > 0) along += pts[i].distanceTo(pts[i - 1]);
    const ring: number[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const n = _n.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(bi, Math.sin(a));
      const p = _p.copy(pts[i]).addScaledVector(n, radii[i]);
      ring.push(part.vert(p, n, (k / seg) * uvScale[0], along * uvScale[1], sways[i]));
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a = rings[i][k];
      const b = rings[i][k + 1];
      const c = rings[i + 1][k + 1];
      const d = rings[i + 1][k];
      part.idx.push(a, d, c, a, c, b);
    }
  }
}

/** Points along a quadratic curve from a to c bending toward b. */
function curve(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(new THREE.Vector3(
      u * u * a.x + 2 * u * t * b.x + t * t * c.x,
      u * u * a.y + 2 * u * t * b.y + t * t * c.y,
      u * u * a.z + 2 * u * t * b.z + t * t * c.z,
    ));
  }
  return out;
}

function polar(yaw: number, elev: number): THREE.Vector3 {
  const c = Math.cos(elev);
  return new THREE.Vector3(Math.sin(yaw) * c, Math.sin(elev), Math.cos(yaw) * c);
}

// ------------------------------------------------------------------ plants

function fern(rng: Rng): PlantModel {
  const leaves = new Part();
  const n = rng.int(9, 15);
  const size = rng.range(0.75, 1.15);
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const len = size * rng.range(0.55, 0.95);
    frond(leaves, new THREE.Vector3(0, 0.02, 0), polar(yaw, rng.range(0.55, 1.1)), len, len * 0.42, rng.range(0.35, 0.6), LEAF.fern, 0, 0.05 * len, 6, 0.12, rng.range(-0.4, 0.4));
  }
  return { leaves: leaves.geometry(), trunk: null, height: size * 0.6, radius: size * 0.8 };
}

function treeFern(rng: Rng): PlantModel {
  const leaves = new Part();
  const trunk = new Part();
  const h = rng.range(2.4, 3.8);
  const lean = new THREE.Vector3(rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3));
  const top = new THREE.Vector3(lean.x, h, lean.z);
  const pts = curve(new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean.x * 0.2, h * 0.5, lean.z * 0.2), top, 8);
  tube(trunk, pts, pts.map((_, i) => 0.17 - (i / 8) * 0.06), pts.map((p) => 0.02 * (p.y / h) ** 2), 9, [2 * Math.PI * 0.15, 1]);
  // dead fronds hanging under the crown (skirt) and the live crown
  const n = rng.int(11, 16);
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const len = rng.range(1.5, 2.3);
    frond(leaves, top, polar(yaw, rng.range(0.25, 0.75)), len, len * 0.38, rng.range(0.4, 0.65), LEAF.treeFern, 0.03, 0.16, 8, 0.1, rng.range(-0.3, 0.3));
  }
  for (let i = 0; i < 4; i++) {
    const yaw = rng.next() * Math.PI * 2;
    frond(leaves, top.clone().add(new THREE.Vector3(0, -0.15, 0)), polar(yaw, -1.0), 1.1, 0.35, 0.1, LEAF.treeFern, 0.02, 0.04, 4, 0.05);
  }
  return { leaves: leaves.geometry(), trunk: trunk.geometry(), height: h + 0.8, radius: 2.0 };
}

function palm(rng: Rng): PlantModel {
  const leaves = new Part();
  const trunk = new Part();
  const h = rng.range(6.5, 10);
  const bend = rng.range(0.6, 1.8);
  const yaw = rng.next() * Math.PI * 2;
  const bx = Math.sin(yaw) * bend;
  const bz = Math.cos(yaw) * bend;
  const pts = curve(new THREE.Vector3(0, 0, 0), new THREE.Vector3(bx * 0.15, h * 0.55, bz * 0.15), new THREE.Vector3(bx, h, bz), 12);
  tube(trunk, pts, pts.map((_, i) => 0.24 - (i / 12) * 0.09 + (i === 0 ? 0.08 : 0)), pts.map((p) => 0.12 * (p.y / h) ** 2), 10, [2 * Math.PI * 0.2, 1]);
  const top = pts[pts.length - 1];
  const n = rng.int(12, 17);
  for (let i = 0; i < n; i++) {
    const fy = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const len = rng.range(2.8, 4.0);
    frond(leaves, top, polar(fy, rng.range(0.1, 0.65)), len, 0.9, rng.range(0.45, 0.75), LEAF.palm, 0.12, 0.45, 9, 0.08, rng.range(-0.5, 0.5));
  }
  // a few dead fronds hanging against the trunk
  for (let i = 0; i < 3; i++) frond(leaves, top.clone().add(new THREE.Vector3(0, -0.2, 0)), polar(rng.next() * Math.PI * 2, -1.2), 2.2, 0.6, 0.05, LEAF.palm, 0.1, 0.14, 5, 0.04);
  return { leaves: leaves.geometry(), trunk: trunk.geometry(), height: h + 1.5, radius: 3.5 };
}

function banana(rng: Rng): PlantModel {
  const leaves = new Part();
  const trunk = new Part();
  const h = rng.range(1.3, 2.1);
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, h * 0.5, 0), new THREE.Vector3(rng.range(-0.08, 0.08), h, rng.range(-0.08, 0.08))];
  tube(trunk, pts, [0.13, 0.1, 0.08], [0, 0.01, 0.03], 8, [2 * Math.PI * 0.1, 1]);
  const top = pts[2];
  const n = rng.int(6, 9);
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const len = rng.range(1.2, 1.9);
    frond(leaves, top.clone().add(new THREE.Vector3(0, rng.range(-0.3, 0.1), 0)), polar(yaw, rng.range(0.5, 1.1)), len, len * 0.42, rng.range(0.35, 0.6), LEAF.banana, 0.03, 0.12, 7, 0.06, rng.range(-0.3, 0.3));
  }
  return { leaves: leaves.geometry(), trunk: trunk.geometry(), height: h + 1.2, radius: 1.6 };
}

function monstera(rng: Rng): PlantModel {
  const leaves = new Part();
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    // long petiole, then the broad leaf near its end
    const base = polar(yaw, 0).multiplyScalar(rng.range(0.15, 0.45));
    base.y = rng.range(0.35, 0.8);
    const len = rng.range(0.6, 0.95);
    frond(leaves, base, polar(yaw, rng.range(0.15, 0.6)), len, len * 0.85, rng.range(0.2, 0.45), LEAF.monstera, 0.02, 0.07, 5, 0.1, rng.range(-0.4, 0.4));
  }
  return { leaves: leaves.geometry(), trunk: null, height: 1.2, radius: 1.1 };
}

function bush(rng: Rng): PlantModel {
  const leaves = new Part();
  const r = rng.range(0.6, 0.95);
  const h = rng.range(0.9, 1.5);
  const n = rng.int(22, 32);
  for (let i = 0; i < n; i++) {
    const yaw = rng.next() * Math.PI * 2;
    const el = rng.range(-0.2, 1.1);
    const d = polar(yaw, el);
    const base = new THREE.Vector3(d.x * r * 0.35, h * rng.range(0.15, 0.6), d.z * r * 0.35);
    const len = rng.range(0.5, 0.8);
    frond(leaves, base, d, len, len * 0.9, rng.range(0.05, 0.25), LEAF.broad, 0.01, 0.05, 2, 0.04, rng.range(-1, 1));
  }
  return { leaves: leaves.geometry(), trunk: null, height: h + 0.4, radius: r + 0.5 };
}

function grass(rng: Rng): PlantModel {
  const leaves = new Part();
  const n = rng.int(5, 8);
  const h = rng.range(0.7, 1.25);
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI + rng.range(-0.3, 0.3);
    frond(leaves, new THREE.Vector3(rng.range(-0.1, 0.1), 0, rng.range(-0.1, 0.1)), polar(yaw, 1.25 + rng.range(-0.15, 0.15)), h, 0.5, rng.range(0.05, 0.2), LEAF.grass, 0, 0.08, 3, 0.02, 0);
  }
  return { leaves: leaves.geometry(), trunk: null, height: h, radius: 0.4 };
}

/**
 * A rainforest giant: the trunk climbs out of sight, flared buttress roots run out across the
 * ground, lianas hang from high branches, ferns grow on the bark.
 */
function buttress(rng: Rng): PlantModel {
  const trunk = new Part();
  const leaves = new Part();
  const r0 = rng.range(0.75, 1.15);
  const H = 24;
  const lean = new THREE.Vector3(rng.range(-0.6, 0.6), 0, rng.range(-0.6, 0.6));
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push(new THREE.Vector3(lean.x * t * t, t * H, lean.z * t * t));
    radii.push(r0 * (1 - 0.35 * t) * (1 + 0.25 * Math.exp(-t * 18)));
  }
  tube(trunk, pts, radii, pts.map(() => 0), 16, [2 * Math.PI * r0, 1]);
  // buttress fins: thin curved plates, tallest at the trunk
  const fins = rng.int(4, 7);
  for (let f = 0; f < fins; f++) {
    const yaw = (f / fins) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const reach = r0 + rng.range(1.6, 3.0);
    const hFin = rng.range(2.2, 3.6);
    const wig = rng.range(-0.4, 0.4);
    const th = rng.range(0.1, 0.18);
    const steps = 9;
    const top: THREE.Vector3[] = [];
    const bot: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = r0 * 0.75 + (reach - r0 * 0.75) * t;
      const a = yaw + wig * Math.sin(t * Math.PI);
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      top.push(new THREE.Vector3(x, hFin * Math.pow(1 - t, 1.7) + 0.05, z));
      bot.push(new THREE.Vector3(x, -0.15, z));
    }
    // two faces offset by the fin thickness, plus the top edge
    const side = (sign: number) => {
      const ids: number[][] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = yaw + wig * Math.sin(t * Math.PI);
        const perp = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(sign);
        const off = perp.clone().multiplyScalar(th * (1 - 0.6 * t) * 0.5);
        const u = (t * (reach - r0)) / 1.5;
        ids.push([
          trunk.vert(bot[i].clone().add(off), perp, u, 0, 0),
          trunk.vert(top[i].clone().add(off), perp, u, top[i].y / 1.5, 0),
        ]);
      }
      for (let i = 0; i < steps; i++) {
        const [a0, a1] = ids[i];
        const [b0, b1] = ids[i + 1];
        if (sign > 0) trunk.idx.push(a0, b0, b1, a0, b1, a1);
        else trunk.idx.push(a0, b1, b0, a0, a1, b1);
      }
      return ids;
    };
    const L = side(1);
    const R = side(-1);
    for (let i = 0; i < steps; i++) {
      const a = L[i][1];
      const b = L[i + 1][1];
      const c = R[i + 1][1];
      const d = R[i][1];
      trunk.idx.push(a, d, c, a, c, b);
    }
  }
  // lianas: hang from high up, sag, some reach the ground
  const vines = rng.int(4, 8);
  for (let v = 0; v < vines; v++) {
    const yaw = rng.next() * Math.PI * 2;
    const hy = rng.range(8, 15);
    const out = rng.range(1.5, 4.5);
    const a = new THREE.Vector3(Math.sin(yaw) * (r0 * 0.7), hy, Math.cos(yaw) * (r0 * 0.7));
    const end = new THREE.Vector3(Math.sin(yaw + rng.range(-0.6, 0.6)) * out, rng.chance(0.6) ? 0 : rng.range(1.5, 5), Math.cos(yaw + rng.range(-0.6, 0.6)) * out);
    const mid = a.clone().lerp(end, 0.5);
    mid.y -= rng.range(0.5, 2.5);
    const vp = curve(a, mid, end, 12);
    tube(trunk, vp, vp.map(() => rng.range(0.025, 0.045)), vp.map((p) => 0.04 * Math.min(1, (hy - p.y) / 6)), 5, [0.25, 1]);
    // leafy strips along the lower part of the liana
    for (let k = 4; k < 11; k += 3) {
      const p = vp[k];
      const d = vp[k + 1].clone().sub(p).normalize();
      frond(leaves, p, d, 0.9, 0.32, 0, LEAF.vine, 0.04, 0.05, 2, 0.02, rng.range(-1, 1));
    }
  }
  // epiphyte ferns clinging to the trunk
  for (let e = 0; e < rng.int(2, 5); e++) {
    const yaw = rng.next() * Math.PI * 2;
    const y = rng.range(2.5, 7);
    const rr = r0 * (1 - 0.35 * (y / H));
    const base = new THREE.Vector3(Math.sin(yaw) * rr + lean.x * (y / H) ** 2, y, Math.cos(yaw) * rr + lean.z * (y / H) ** 2);
    for (let i = 0; i < 6; i++) frond(leaves, base, polar(yaw + rng.range(-0.9, 0.9), rng.range(-0.2, 0.7)), rng.range(0.4, 0.7), 0.25, 0.4, LEAF.fern, 0.01, 0.04, 4, 0.1);
  }
  // the crown: limbs spreading from high on the trunk, each ending in a mass of leafy sprigs
  // (seen from the ground it's a dark roof with gaps of storm sky)
  const limbs = rng.int(5, 8);
  for (let l = 0; l < limbs; l++) {
    const yaw = (l / limbs) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const y0 = rng.range(14, 19);
    const t0 = y0 / H;
    const start = new THREE.Vector3(lean.x * t0 * t0, y0, lean.z * t0 * t0);
    const out = rng.range(4.5, 8.5);
    const end = start.clone().add(new THREE.Vector3(Math.sin(yaw) * out, rng.range(2.5, 5.5), Math.cos(yaw) * out));
    const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 1.2, 0));
    const lp = curve(start, mid, end, 6);
    tube(trunk, lp, lp.map((_, i) => r0 * 0.38 * (1 - i / 8)), lp.map(() => 0), 7, [1.2, 1]);
    // a dome of sprigs around the outer half of the limb
    for (let k = 0; k < 26; k++) {
      const at = lp[Math.floor(rng.range(3, 6.99))].clone().add(new THREE.Vector3(rng.range(-1.6, 1.6), rng.range(-0.4, 1.4), rng.range(-1.6, 1.6)));
      const dir = polar(rng.next() * Math.PI * 2, rng.range(-0.35, 0.75));
      frond(leaves, at, dir, rng.range(2.6, 4.0), rng.range(1.2, 1.8), rng.range(0.1, 0.35), rng.chance(0.5) ? LEAF.palm : LEAF.fern, 0.05, 0.25, 3, 0.1, rng.range(-0.6, 0.6));
    }
  }
  return { leaves: leaves.geometry(), trunk: trunk.geometry(), height: H, radius: r0 + 9 };
}

const BUILDERS: Record<PlantKind, (rng: Rng) => PlantModel> = { fern, treeFern, palm, banana, monstera, bush, grass, buttress };

/** Builds one variant of a plant (deterministic per seed). */
export function buildPlant(kind: PlantKind, seed: number): PlantModel {
  return BUILDERS[kind](new Rng(1013 + seed * 7919 + kind.length * 31));
}

/** Trunk radius for collision (0 = walk through it). */
export function plantColliderRadius(kind: PlantKind, scale = 1): number {
  return PLANT_TRUNK[kind] * scale;
}

/** Merges geometries that share the same attribute set (instanced prototypes of several variants). */
export function mergePlantGeometry(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const valid = list.filter(Boolean);
  if (!valid.length) return null;
  return mergeGeometries(valid, false);
}

// ------------------------------------------------------------------ leaf atlas

type Ctx = CanvasRenderingContext2D;

/** Draws the leaves (color + height for the normal map) into a 4 x 2 atlas. */
export function buildLeafAtlas(size = 1024): { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } {
  const W = size;
  const H = size / 2;
  const cw = W / COLS;
  const ch = H / ROWS;
  const col = document.createElement('canvas');
  col.width = W;
  col.height = H;
  const hgt = document.createElement('canvas');
  hgt.width = W;
  hgt.height = H;
  const g = col.getContext('2d')!;
  const hg = hgt.getContext('2d')!;
  hg.fillStyle = '#000';
  hg.fillRect(0, 0, W, H);
  const rng = new Rng(4242);
  // each cell is drawn base at the bottom, tip at the top
  const cell = (idx: number, draw: (c: Ctx, hc: Ctx, w: number, h: number) => void) => {
    const x = (idx % COLS) * cw;
    const y = Math.floor(idx / COLS) * ch;
    for (const c of [g, hg]) {
      c.save();
      c.beginPath();
      c.rect(x, y, cw, ch);
      c.clip();
      c.translate(x, y);
    }
    draw(g, hg, cw, ch);
    g.restore();
    hg.restore();
  };
  // muted, olive-leaning greens: rain-dark foliage at night, never neon
  const green = (l: number, s = 0) => {
    const r = Math.round(46 + l * 32 + s * 20);
    const gg = Math.round(64 + l * 38 + s * 8);
    const b = Math.round(38 + l * 22);
    return `rgb(${r},${gg},${b})`;
  };
  /** pinnate frond: rachis plus leaflets, largest low on the frond, tapering to the tip */
  const pinnate = (c: Ctx, hc: Ctx, w: number, h: number, o: { pairs: number; len: number; width: number; angle: number; lobes: number; tone: number }) => {
    const cx = w / 2;
    for (let i = 0; i < o.pairs; i++) {
      const t = (i + 0.5) / o.pairs;
      const y = h * (1 - t * 0.97);
      const L = w * o.len * Math.sin(Math.PI * (0.18 + 0.82 * t)) * (1 - t * 0.45);
      for (const side of [-1, 1]) {
        const a = side * o.angle;
        const tone = o.tone + rng.range(-0.15, 0.15);
        for (const [cc, fill] of [[c, green(tone)], [hc, '#888']] as const) {
          cc.save();
          cc.translate(cx, y);
          cc.rotate(a);
          cc.fillStyle = fill;
          cc.beginPath();
          cc.ellipse(side * L * 0.5, 0, L * 0.5, w * o.width * (1 - t * 0.5), 0, 0, Math.PI * 2);
          cc.fill();
          // lobed edges
          for (let k = 1; k <= o.lobes; k++) {
            const lx = side * (L * k) / (o.lobes + 1);
            cc.beginPath();
            cc.ellipse(lx, 0, (L / (o.lobes + 1)) * 0.6, w * o.width * 1.25 * (1 - t * 0.5), 0, 0, Math.PI * 2);
            cc.fill();
          }
          cc.restore();
        }
        // midvein of the leaflet
        hc.save();
        hc.translate(cx, y);
        hc.rotate(a);
        hc.strokeStyle = '#ccc';
        hc.lineWidth = 1.2;
        hc.beginPath();
        hc.moveTo(0, 0);
        hc.lineTo(side * L * 0.95, 0);
        hc.stroke();
        hc.restore();
      }
    }
    // rachis
    for (const [cc, st, lw] of [[c, green(o.tone - 0.4, 0.6), 3], [hc, '#fff', 3]] as const) {
      cc.strokeStyle = st;
      cc.lineWidth = lw;
      cc.beginPath();
      cc.moveTo(cx, h);
      cc.quadraticCurveTo(cx + w * 0.02, h * 0.5, cx, h * 0.02);
      cc.stroke();
    }
  };
  cell(LEAF.fern, (c, hc, w, h) => pinnate(c, hc, w, h, { pairs: 18, len: 0.46, width: 0.035, angle: -1.05, lobes: 4, tone: 0.45 }));
  cell(LEAF.palm, (c, hc, w, h) => pinnate(c, hc, w, h, { pairs: 26, len: 0.5, width: 0.016, angle: -1.2, lobes: 0, tone: 0.35 }));
  cell(LEAF.treeFern, (c, hc, w, h) => pinnate(c, hc, w, h, { pairs: 16, len: 0.48, width: 0.05, angle: -1.15, lobes: 7, tone: 0.55 }));
  // banana: a broad paddle with a pale midrib, parallel veins and wind tears
  cell(LEAF.banana, (c, hc, w, h) => {
    const cx = w / 2;
    c.fillStyle = green(0.6);
    hc.fillStyle = '#888';
    for (const cc of [c, hc]) {
      cc.beginPath();
      cc.ellipse(cx, h * 0.5, w * 0.44, h * 0.49, 0, 0, Math.PI * 2);
      cc.fill();
    }
    c.strokeStyle = 'rgba(25,40,18,0.6)';
    hc.strokeStyle = '#aaa';
    for (let i = 0; i < 40; i++) {
      const y = h * (0.03 + 0.94 * (i / 40));
      for (const [cc, lw] of [[c, 1], [hc, 1.5]] as const) {
        cc.lineWidth = lw;
        cc.beginPath();
        cc.moveTo(cx, y);
        cc.lineTo(cx - w * 0.45, y - h * 0.06);
        cc.moveTo(cx, y);
        cc.lineTo(cx + w * 0.45, y - h * 0.06);
        cc.stroke();
      }
    }
    // tears: cut along veins from the edge inward
    c.globalCompositeOperation = 'destination-out';
    hc.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 9; i++) {
      const y = h * rng.range(0.1, 0.9);
      const side = rng.chance(0.5) ? -1 : 1;
      c.lineWidth = rng.range(1.5, 4);
      c.beginPath();
      c.moveTo(cx + side * w * 0.5, y - h * 0.065);
      c.lineTo(cx + side * w * rng.range(0.05, 0.3), y);
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = 'rgb(150,170,110)';
    hc.strokeStyle = '#fff';
    for (const [cc, lw] of [[c, 4], [hc, 5]] as const) {
      cc.lineWidth = lw;
      cc.beginPath();
      cc.moveTo(cx, h);
      cc.lineTo(cx, 0);
      cc.stroke();
    }
  });
  // broadleaf cluster for bushes
  cell(LEAF.broad, (c, hc, w, h) => {
    for (let i = 0; i < 9; i++) {
      const x = w * rng.range(0.2, 0.8);
      const y = h * rng.range(0.2, 0.85);
      const L = w * rng.range(0.16, 0.3);
      const a = rng.range(-1.2, 1.2) - Math.PI / 2;
      for (const [cc, fill] of [[c, green(rng.range(0.3, 0.8))], [hc, '#888']] as const) {
        cc.save();
        cc.translate(x, y);
        cc.rotate(a);
        cc.fillStyle = fill;
        cc.beginPath();
        cc.moveTo(0, 0);
        cc.quadraticCurveTo(L * 0.5, L * 0.32, L, 0);
        cc.quadraticCurveTo(L * 0.5, -L * 0.32, 0, 0);
        cc.fill();
        cc.restore();
      }
      hc.save();
      hc.translate(x, y);
      hc.rotate(a);
      hc.strokeStyle = '#ddd';
      hc.lineWidth = 1.5;
      hc.beginPath();
      hc.moveTo(0, 0);
      hc.lineTo(L, 0);
      hc.stroke();
      hc.restore();
    }
  });
  // grass blades
  cell(LEAF.grass, (c, hc, w, h) => {
    for (let i = 0; i < 16; i++) {
      const x0 = w * rng.range(0.2, 0.8);
      const lean = w * rng.range(-0.3, 0.3);
      const top = h * rng.range(0.02, 0.3);
      const bw = rng.range(3, 6);
      for (const [cc, fill] of [[c, green(rng.range(0.2, 0.7), 0.3)], [hc, '#999']] as const) {
        cc.fillStyle = fill;
        cc.beginPath();
        cc.moveTo(x0 - bw, h);
        cc.quadraticCurveTo(x0 + lean * 0.3, h * 0.5, x0 + lean, top);
        cc.quadraticCurveTo(x0 + lean * 0.3 + bw * 0.5, h * 0.5, x0 + bw, h);
        cc.fill();
      }
    }
  });
  // vine: a wavy stem with small heart-shaped leaves
  cell(LEAF.vine, (c, hc, w, h) => {
    const cx = w / 2;
    c.strokeStyle = green(0.1, 0.5);
    hc.strokeStyle = '#fff';
    for (const cc of [c, hc]) {
      cc.lineWidth = 3;
      cc.beginPath();
      for (let y = 0; y <= h; y += 4) cc.lineTo(cx + Math.sin(y * 0.05) * w * 0.06, h - y);
      cc.stroke();
    }
    for (let i = 0; i < 14; i++) {
      const y = h * (0.04 + 0.92 * (i / 14));
      const side = i % 2 ? 1 : -1;
      const x = cx + Math.sin((h - y) * 0.05) * w * 0.06;
      const s = w * rng.range(0.1, 0.16);
      for (const [cc, fill] of [[c, green(rng.range(0.4, 0.9))], [hc, '#888']] as const) {
        cc.save();
        cc.translate(x + side * s * 0.9, y);
        cc.rotate(side * 0.6);
        cc.fillStyle = fill;
        cc.beginPath();
        cc.arc(-s * 0.3, 0, s * 0.45, 0, Math.PI * 2);
        cc.arc(s * 0.3, 0, s * 0.45, 0, Math.PI * 2);
        cc.moveTo(-s * 0.7, s * 0.15);
        cc.lineTo(0, s * 1.1);
        cc.lineTo(s * 0.7, s * 0.15);
        cc.fill();
        cc.restore();
      }
    }
  });
  // monstera: heart-shaped leaf with slits and holes
  cell(LEAF.monstera, (c, hc, w, h) => {
    const cx = w / 2;
    for (const [cc, fill] of [[c, green(0.35)], [hc, '#888']] as const) {
      cc.fillStyle = fill;
      cc.beginPath();
      cc.moveTo(cx, h * 0.98);
      cc.bezierCurveTo(cx - w * 0.62, h * 0.85, cx - w * 0.5, h * 0.05, cx, h * 0.04);
      cc.bezierCurveTo(cx + w * 0.5, h * 0.05, cx + w * 0.62, h * 0.85, cx, h * 0.98);
      cc.fill();
    }
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) {
      const y = h * (0.15 + 0.7 * (i / 7));
      for (const side of [-1, 1]) {
        c.lineWidth = w * 0.035;
        c.beginPath();
        c.moveTo(cx + side * w * 0.5, y - h * 0.08);
        c.lineTo(cx + side * w * 0.2, y);
        c.stroke();
        if (i % 2) {
          c.beginPath();
          c.ellipse(cx + side * w * 0.12, y + h * 0.02, w * 0.025, h * 0.035, 0, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
    c.globalCompositeOperation = 'source-over';
    hc.strokeStyle = '#fff';
    c.strokeStyle = green(0.8, 0.4);
    for (const [cc, lw] of [[c, 3], [hc, 4]] as const) {
      cc.lineWidth = lw;
      cc.beginPath();
      cc.moveTo(cx, h * 0.98);
      cc.lineTo(cx, h * 0.06);
      cc.stroke();
    }
  });
  // height field -> normal map (alpha comes from the color canvas)
  const hd = hg.getImageData(0, 0, W, H).data;
  const field = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) field[i] = hd[i * 4] / 255;
  const normalMap = heightToNormalTexture(field, W, H, 3.0);
  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  return { map, normalMap };
}

// ------------------------------------------------------------------ material with wind

/** Shared wind clock: the map view advances uTime every frame. */
export const WIND = { uTime: { value: 0 }, uWind: { value: 1 } };

/** Adds the sway (per-vertex amplitude aSway, phase from the plant's position) to a material. */
export function applyWind(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = WIND.uTime;
    shader.uniforms.uWind = WIND.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #if defined( USE_BATCHING )
            vec2 org = vec2(batchingMatrix[3][0], batchingMatrix[3][2]);
          #elif defined( USE_INSTANCING )
            vec2 org = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          #else
            vec2 org = vec2(modelMatrix[3][0], modelMatrix[3][2]);
          #endif
          float ph = dot(org, vec2(0.37, 0.61)) + position.y * 0.6;
          float gust = 0.65 + 0.35 * sin(uTime * 0.31 + org.x * 0.05);
          float s = aSway * uWind * gust;
          transformed.x += sin(uTime * 1.6 + ph) * s;
          transformed.z += cos(uTime * 1.3 + ph * 1.27) * s * 0.8;
          transformed.y += sin(uTime * 2.3 + ph * 2.0) * s * 0.25;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'wind1';
}
