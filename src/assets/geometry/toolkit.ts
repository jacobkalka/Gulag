import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// Geometry toolkit for code-authored models. Conventions:
//  * meters, +Y up. Weapons face -Z (camera forward), +X is the weapon's right side.
//  * Every helper returns NON-indexed geometry with position/normal/uv so parts can be merged.
//  * UVs are in meters (box projected); texture sets carry their own repeat = 1/tileMeters.

export type Geo = THREE.BufferGeometry;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

function finalize(g: Geo): Geo {
  let out = g.index ? g.toNonIndexed() : g;
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  // Keep only the attributes all parts share.
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
  }
  if (!out.getAttribute('uv')) {
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
  }
  out.morphAttributes = {};
  out.clearGroups();
  if (out !== g) g.dispose();
  out = out as Geo;
  return out;
}

/** Projects UVs from position along the dominant normal axis (meters * scale). */
export function boxProjectUV(g: Geo, scale = 1, offset: [number, number] = [0, 0]): Geo {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    let u: number, v: number;
    if (nx >= ny && nx >= nz) {
      u = nrm.getX(i) > 0 ? -z : z;
      v = y;
    } else if (ny >= nx && ny >= nz) {
      u = x;
      v = nrm.getY(i) > 0 ? -z : z;
    } else {
      u = nrm.getZ(i) > 0 ? x : -x;
      v = y;
    }
    uv[i * 2] = u * scale + offset[0];
    uv[i * 2 + 1] = v * scale + offset[1];
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

export interface Xf {
  p?: [number, number, number];
  r?: [number, number, number];
  s?: [number, number, number] | number;
}

/** Applies a transform (position, euler rotation XYZ in radians, scale) in place. */
export function xf(g: Geo, t: Xf): Geo {
  _p.set(...(t.p ?? [0, 0, 0]));
  _e.set(...(t.r ?? [0, 0, 0]));
  _q.setFromEuler(_e);
  if (typeof t.s === 'number') _s.set(t.s, t.s, t.s);
  else _s.set(...(t.s ?? [1, 1, 1]));
  _m.compose(_p, _q, _s);
  g.applyMatrix4(_m);
  return g;
}

export function box(w: number, h: number, d: number, t?: Xf): Geo {
  const g = boxProjectUV(finalize(new THREE.BoxGeometry(w, h, d)));
  return t ? xf(g, t) : g;
}

export function rbox(w: number, h: number, d: number, r: number, seg = 2, t?: Xf): Geo {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const g = boxProjectUV(finalize(new RoundedBoxGeometry(w, h, d, seg, Math.max(rr, 1e-4))));
  return t ? xf(g, t) : g;
}

export function cyl(rTop: number, rBot: number, h: number, seg = 16, t?: Xf, open = false): Geo {
  const g = finalize(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open));
  cylUV(g, (rTop + rBot) / 2);
  return t ? xf(g, t) : g;
}

/** Cylinder along Z (forward axis). */
export function cylZ(r: number, len: number, seg = 16, t?: Xf, rEnd = r): Geo {
  const g = cyl(rEnd, r, len, seg);
  xf(g, { r: [Math.PI / 2, 0, 0] });
  return t ? xf(g, t) : g;
}

/** Cylinder along X (side axis). */
export function cylX(r: number, len: number, seg = 16, t?: Xf): Geo {
  const g = cyl(r, r, len, seg);
  xf(g, { r: [0, 0, Math.PI / 2] });
  return t ? xf(g, t) : g;
}

function cylUV(g: Geo, r: number): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.abs(nrm.getY(i)) > 0.9) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else {
      uv[i * 2] = Math.atan2(x, z) * r;
      uv[i * 2 + 1] = y;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export function sphere(r: number, ws = 16, hs = 12, t?: Xf, phiStart = 0, phiLen = Math.PI * 2, thetaStart = 0, thetaLen = Math.PI): Geo {
  const g = boxProjectUV(finalize(new THREE.SphereGeometry(r, ws, hs, phiStart, phiLen, thetaStart, thetaLen)));
  return t ? xf(g, t) : g;
}

export function capsule(r: number, len: number, capSeg = 4, radial = 12, t?: Xf): Geo {
  const g = boxProjectUV(finalize(new THREE.CapsuleGeometry(r, len, capSeg, radial)));
  return t ? xf(g, t) : g;
}

export function torus(r: number, tube: number, rs = 8, ts = 24, arc = Math.PI * 2, t?: Xf): Geo {
  const g = boxProjectUV(finalize(new THREE.TorusGeometry(r, tube, rs, ts, arc)));
  return t ? xf(g, t) : g;
}

/** Lathe around Y from [radius, y] points. */
export function lathe(points: [number, number][], seg = 24, t?: Xf): Geo {
  const g = finalize(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), seg));
  cylUV(g, points.reduce((a, b) => a + b[0], 0) / points.length);
  return t ? xf(g, t) : g;
}

/** Lathe around Z (forward), points are [radius, z]. */
export function latheZ(points: [number, number][], seg = 24, t?: Xf): Geo {
  const g = lathe(points.map(([r, z]) => [r, z] as [number, number]), seg);
  xf(g, { r: [Math.PI / 2, 0, 0] });
  return t ? xf(g, t) : g;
}

export type P2 = [number, number];

/** Builds a THREE.Shape from a polyline with optional per-vertex corner rounding. */
export function shapeFrom(points: P2[], round = 0, holes: P2[][] = []): THREE.Shape {
  const s = new THREE.Shape();
  pathFrom(s, points, round);
  for (const h of holes) {
    const hp = new THREE.Path();
    pathFrom(hp, h, round * 0.5);
    s.holes.push(hp);
  }
  return s;
}

function pathFrom(path: THREE.Path, pts: P2[], round: number): void {
  const n = pts.length;
  if (round <= 0) {
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
    return;
  }
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const d0 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const d2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const r = Math.min(round, d0 * 0.45, d2 * 0.45);
    const a: P2 = [p1[0] + ((p0[0] - p1[0]) / d0) * r, p1[1] + ((p0[1] - p1[1]) / d0) * r];
    const b: P2 = [p1[0] + ((p2[0] - p1[0]) / d2) * r, p1[1] + ((p2[1] - p1[1]) / d2) * r];
    if (i === 0) path.moveTo(a[0], a[1]);
    else path.lineTo(a[0], a[1]);
    path.quadraticCurveTo(p1[0], p1[1], b[0], b[1]);
  }
  path.closePath();
}

export function roundedRectPts(x0: number, y0: number, x1: number, y1: number): P2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Extrudes a shape along +Z by depth with beveled edges, centered on Z. */
export function extrude(shape: THREE.Shape, depth: number, bevel = 0.002, bevelSeg = 2, curveSeg = 8): Geo {
  const b = Math.min(bevel, depth * 0.45);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, depth - b * 2),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: bevelSeg,
    curveSegments: curveSeg,
  });
  g.translate(0, 0, -depth / 2 + b);
  // Smooth across bevels and curves, keep hard edges between flat faces.
  const creased = toCreasedNormals(g, 0.62);
  g.dispose();
  return boxProjectUV(finalize(creased));
}

/**
 * Side profile: points are [forward, up] (forward = -Z in model space), extruded across X (width), centered.
 */
export function side(points: P2[], width: number, opts: { round?: number; bevel?: number; holes?: P2[][]; t?: Xf; curveSeg?: number } = {}): Geo {
  const shape = shapeFrom(points, opts.round ?? 0, opts.holes ?? []);
  const g = extrude(shape, width, opts.bevel ?? 0.0015, 2, opts.curveSeg ?? 6);
  // shape x → -Z (forward), shape y → +Y, extrusion z → +X
  xf(g, { r: [0, Math.PI / 2, 0] });
  boxProjectUV(g);
  return opts.t ? xf(g, opts.t) : g;
}

/**
 * Front profile: points are [right, up] (cross-section), extruded along forward (-Z) by length,
 * starting at forward = start.
 */
export function front(points: P2[], length: number, start = 0, opts: { round?: number; bevel?: number; holes?: P2[][]; t?: Xf } = {}): Geo {
  const shape = shapeFrom(points, opts.round ?? 0, opts.holes ?? []);
  const g = extrude(shape, length, opts.bevel ?? 0.0015);
  // centered on z; move so it spans forward [start, start+length] i.e. z in [-(start+length), -start]
  xf(g, { p: [0, 0, -(start + length / 2)] });
  boxProjectUV(g);
  return opts.t ? xf(g, opts.t) : g;
}

/** Top profile: points are [right, forward], extruded along Y by height, centered. */
export function top(points: P2[], height: number, opts: { round?: number; bevel?: number; holes?: P2[][]; t?: Xf } = {}): Geo {
  const shape = shapeFrom(points.map(([x, f]) => [x, f] as P2), opts.round ?? 0, opts.holes ?? []);
  const g = extrude(shape, height, opts.bevel ?? 0.0015);
  // shape (x, y=forward) → (x, -z); extrusion z → +y
  xf(g, { r: [-Math.PI / 2, 0, 0] });
  boxProjectUV(g);
  return opts.t ? xf(g, opts.t) : g;
}

export function merge(geos: Geo[]): Geo {
  const valid = geos.filter((g) => g && g.getAttribute('position').count > 0);
  const m = mergeGeometries(valid, false);
  if (!m) throw new Error('mergeGeometries failed');
  for (const g of valid) g.dispose();
  return m;
}

/** Repeats a geometry along a direction n times (for rail teeth, ribs, serrations). */
export function repeat(make: (i: number) => Geo, n: number): Geo[] {
  const out: Geo[] = [];
  for (let i = 0; i < n; i++) out.push(make(i));
  return out;
}

/**
 * Collects geometry per material and builds one merged mesh per material.
 */
export class ModelBuilder {
  private parts = new Map<THREE.Material, Geo[]>();

  add(material: THREE.Material, ...geos: (Geo | Geo[])[]): this {
    let list = this.parts.get(material);
    if (!list) {
      list = [];
      this.parts.set(material, list);
    }
    for (const g of geos) {
      if (Array.isArray(g)) list.push(...g);
      else list.push(g);
    }
    return this;
  }

  get empty(): boolean {
    return this.parts.size === 0;
  }

  build(name = 'model', opts: { castShadow?: boolean; receiveShadow?: boolean } = {}): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, geos] of this.parts) {
      if (!geos.length) continue;
      const mesh = new THREE.Mesh(merge(geos), mat);
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = opts.receiveShadow ?? true;
      mesh.name = `${name}:${(mat as THREE.Material).name || 'mat'}`;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }
}

/**
 * Faceted irregular chunk (broken concrete / stone): a jittered icosahedron,
 * optionally flattened, with flat normals so every facet catches light.
 */
export function rock(sx: number, sy: number, sz: number, seed: number, detail = 0, flatten = 0.3): Geo {
  const base = new THREE.IcosahedronGeometry(1, detail);
  const pos = base.getAttribute('position') as THREE.BufferAttribute;
  // jitter shared vertices consistently: hash by rounded position
  const h = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.123) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 0.72 + h(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100)) * 0.5;
    let yy = y * k;
    if (yy < -flatten) yy = -flatten + (yy + flatten) * 0.15; // flat-ish bottom
    pos.setXYZ(i, x * k * sx, yy * sy, z * k * sz);
  }
  const g = base.index ? base.toNonIndexed() : base;
  if (g !== base) base.dispose();
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  boxProjectUV(g);
  return g;
}
