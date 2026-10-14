import * as THREE from 'three';
import { box, cylZ, cylX, front, latheZ, merge, rbox, side, top, type Geo, type P2, xf } from '../geometry/toolkit';
import type { MaterialLibrary } from '../materials';

// Reusable weapon parts. Coordinates: f = forward (toward muzzle), u = up, x = right.
// Model space: z = -f, y = u.

export type M = THREE.Material;

export interface GunMats {
  receiver: M;
  furniture: M;
  grip: M;
  steel: M;
  dark: M;
  rubber: M;
  alu: M;
  glass: M;
  lens: M;
  tritium: M;
  brass: M;
  wood: M;
}

export function gunMats(lib: MaterialLibrary, opts: { tan?: boolean; woodFurniture?: boolean } = {}): GunMats {
  return {
    receiver: lib.get(opts.tan ? 'gunAluTan' : 'gunAlu'),
    furniture: lib.get(opts.woodFurniture ? 'gunWood' : opts.tan ? 'gunPolymerTan' : 'gunPolymer'),
    grip: lib.get('gunGrip'),
    steel: lib.get('gunSteel'),
    dark: lib.get('gunDark'),
    rubber: lib.get('gunRubber'),
    alu: lib.get('gunAlu'),
    glass: lib.get('sightGlass'),
    lens: lib.get('lens'),
    tritium: lib.get('tritium'),
    brass: lib.get('gunBrass'),
    wood: lib.get('gunWood'),
  };
}

/** Collects parts per material for one weapon (static parts get merged). */
export class PartSink {
  map = new Map<M, Geo[]>();
  add(m: M, ...g: (Geo | Geo[])[]): void {
    let l = this.map.get(m);
    if (!l) this.map.set(m, (l = []));
    for (const x of g) {
      if (Array.isArray(x)) l.push(...x);
      else l.push(x);
    }
  }
  build(name: string): THREE.Group {
    const grp = new THREE.Group();
    grp.name = name;
    for (const [m, list] of this.map) {
      if (!list.length) continue;
      const mesh = new THREE.Mesh(merge(list), m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      grp.add(mesh);
    }
    this.map.clear();
    return grp;
  }
}

// ---------------------------------------------------------------- helpers

/** Box in (f, u, x) gun coordinates, given min/max forward & up and half width. */
export function gbox(f0: number, f1: number, u0: number, u1: number, hw: number, xc = 0): Geo {
  return box(hw * 2, u1 - u0, f1 - f0, { p: [xc, (u0 + u1) / 2, -(f0 + f1) / 2] });
}
export function grbox(f0: number, f1: number, u0: number, u1: number, hw: number, r: number, xc = 0): Geo {
  return rbox(hw * 2, u1 - u0, f1 - f0, r, 2, { p: [xc, (u0 + u1) / 2, -(f0 + f1) / 2] });
}
/** Cylinder along forward axis from f0 to f1 at (x, u). */
export function gcyl(f0: number, f1: number, u: number, r: number, seg = 18, x = 0, rEnd = r): Geo {
  return cylZ(r, f1 - f0, seg, { p: [x, u, -(f0 + f1) / 2] }, rEnd);
}
export function sideAt(points: P2[], width: number, x = 0, opts: { round?: number; bevel?: number; holes?: P2[][] } = {}): Geo {
  const g = side(points, width, opts);
  if (x) xf(g, { p: [x, 0, 0] });
  return g;
}

/** Picatinny rail from f0 to f1 sitting on u (base bottom). */
export function rail(s: PartSink, m: GunMats, f0: number, f1: number, u: number, hw = 0.0105): void {
  if (hw <= 0) return;
  s.add(m.alu, gbox(f0, f1, u, u + 0.0035, hw));
  const n = Math.floor((f1 - f0) / 0.01);
  const teeth: Geo[] = [];
  for (let i = 0; i < n; i++) {
    const fc = f0 + 0.005 + i * 0.01;
    teeth.push(gbox(fc - 0.0028, fc + 0.0028, u + 0.0035, u + 0.0065, hw - 0.0008));
  }
  s.add(m.alu, teeth);
}

/** Row of screw heads on a side surface (x>0 right). */
/** Cylinder between two points given in (x, u, f) gun coordinates. */
export function rod(a: [number, number, number], b: [number, number, number], r: number, seg = 10): Geo {
  const A = new THREE.Vector3(a[0], a[1], -a[2]);
  const B = new THREE.Vector3(b[0], b[1], -b[2]);
  const len = A.distanceTo(B);
  const g = cylZ(r, len, seg);
  const mid = A.clone().add(B).multiplyScalar(0.5);
  const dir = B.clone().sub(A).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  g.applyQuaternion(q);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

export function screws(s: PartSink, m: GunMats, pts: [number, number][], x: number): void {
  const g: Geo[] = [];
  for (const [f, u] of pts) {
    g.push(cylX(0.0028, 0.0016, 10, { p: [x, u, -f] }));
    g.push(cylX(0.0028, 0.0016, 10, { p: [-x, u, -f] }));
  }
  s.add(m.steel, g);
}

// ---------------------------------------------------------------- receivers & furniture

export function arLower(s: PartSink, m: GunMats, mat: M = m.receiver): void {
  const pts: P2[] = [
    [-0.09, 0.0],
    [0.118, 0.0],
    [0.126, -0.012],
    [0.126, -0.046],
    [0.118, -0.062],
    [0.058, -0.062],
    [0.054, -0.03],
    [-0.02, -0.03],
    [-0.04, -0.026],
    [-0.086, -0.012],
  ];
  s.add(mat, sideAt(pts, 0.0245, 0, { round: 0.004, bevel: 0.0018 }));
  // Magwell flare
  s.add(mat, sideAt([[0.054, -0.044], [0.13, -0.044], [0.13, -0.064], [0.054, -0.064]], 0.0275, 0, { round: 0.003, bevel: 0.0015 }));
  // Trigger guard
  s.add(mat, sideAt(
    [[-0.004, -0.028], [0.058, -0.028], [0.058, -0.036], [0.05, -0.058], [0.0, -0.06], [-0.012, -0.05]],
    0.011, 0, { round: 0.004, bevel: 0.0015, holes: [[[0.004, -0.034], [0.05, -0.034], [0.044, -0.052], [0.004, -0.053]]] },
  ));
  // Trigger blade
  s.add(m.steel, sideAt([[0.016, -0.03], [0.024, -0.03], [0.026, -0.04], [0.022, -0.051], [0.018, -0.05], [0.02, -0.04]], 0.005, 0, { round: 0.002, bevel: 0.0008 }));
  // Selector + bolt catch + mag release
  s.add(m.steel, box(0.003, 0.006, 0.02, { p: [-0.0138, -0.012, 0.012], r: [0.6, 0, 0] }));
  s.add(m.steel, cylX(0.0055, 0.003, 12, { p: [-0.0138, -0.012, 0.012] }));
  s.add(m.steel, box(0.003, 0.016, 0.006, { p: [-0.0138, -0.022, -0.06] }));
  s.add(m.steel, cylX(0.0042, 0.004, 12, { p: [0.0142, -0.02, -0.052] }));
  screws(s, m, [[0.04, -0.02], [-0.06, -0.006]], 0.0128);
}

export function arUpper(s: PartSink, m: GunMats, f1 = 0.17, mat: M = m.receiver): void {
  s.add(mat, sideAt([[-0.098, 0.0], [f1, 0.0], [f1, 0.05], [-0.09, 0.05], [-0.098, 0.044]], 0.026, 0, { round: 0.003, bevel: 0.0018 }));
  // Ejection port + dust cover (right side)
  s.add(m.dark, gbox(0.002, 0.07, 0.018, 0.04, 0.0006, 0.0132));
  s.add(m.steel, gbox(0.0, 0.072, 0.012, 0.018, 0.0012, 0.0136));
  // Forward assist
  s.add(mat, gcyl(-0.075, -0.045, 0.034, 0.0072, 16, 0.017));
  s.add(m.steel, gcyl(-0.08, -0.074, 0.034, 0.0055, 14, 0.017));
  // Brass deflector bump
  s.add(mat, grbox(-0.03, -0.005, 0.03, 0.048, 0.004, 0.002, 0.0145));
  // Charging handle
  s.add(m.alu, gbox(-0.112, -0.096, 0.04, 0.049, 0.0175));
  s.add(m.alu, grbox(-0.116, -0.104, 0.038, 0.05, 0.004, 0.002, -0.018));
}

/** Slotted octagonal handguard (real cut-out slots you can see the barrel through). */
export function slottedHandguard(s: PartSink, m: GunMats, f0: number, f1: number, u0: number, u1: number, hw: number, mat: M = m.receiver): void {
  const len = f1 - f0;
  const slots: P2[][] = [];
  const nSlots = Math.max(2, Math.floor((len - 0.03) / 0.046));
  const uc = (u0 + u1) / 2;
  for (let i = 0; i < nSlots; i++) {
    const a = f0 + 0.02 + i * 0.046;
    slots.push([[a, uc - 0.0045], [a + 0.031, uc - 0.0045], [a + 0.031, uc + 0.0045], [a, uc + 0.0045]]);
  }
  const sideP: P2[] = [[f0, u0 + 0.008], [f1, u0 + 0.008], [f1, u1 - 0.008], [f0, u1 - 0.008]];
  s.add(mat, sideAt(sideP, 0.004, hw - 0.002, { round: 0.001, bevel: 0.0012, holes: slots }));
  s.add(mat, sideAt(sideP, 0.004, -(hw - 0.002), { round: 0.001, bevel: 0.0012, holes: slots }));
  // top & bottom plates
  s.add(mat, gbox(f0, f1, u1 - 0.006, u1, hw - 0.006));
  const bottomHoles: P2[][] = [];
  for (let i = 0; i < nSlots; i++) {
    const a = f0 + 0.02 + i * 0.046;
    bottomHoles.push([[-0.004, a], [0.004, a], [0.004, a + 0.031], [-0.004, a + 0.031]]);
  }
  s.add(mat, top([[-(hw - 0.006), f0], [hw - 0.006, f0], [hw - 0.006, f1], [-(hw - 0.006), f1]], 0.005, { bevel: 0.0012, holes: bottomHoles, t: { p: [0, u0 + 0.0025, 0] } }));
  // chamfer strips (octagon corners)
  const c = 0.0085;
  for (const sx of [1, -1]) {
    s.add(mat, box(0.004, c, len, { p: [sx * (hw - 0.0045), u1 - 0.0045, -(f0 + f1) / 2], r: [0, 0, sx * Math.PI / 4] }));
    s.add(mat, box(0.004, c, len, { p: [sx * (hw - 0.0045), u0 + 0.0045, -(f0 + f1) / 2], r: [0, 0, -sx * Math.PI / 4] }));
  }
  // end cap
  s.add(mat, front([[-hw + 0.003, u0 + 0.002], [hw - 0.003, u0 + 0.002], [hw - 0.003, u1 - 0.002], [-hw + 0.003, u1 - 0.002]], 0.006, f1 - 0.006, { round: 0.006, bevel: 0.001, holes: [[[-0.012, uc - 0.012], [0.012, uc - 0.012], [0.012, uc + 0.012], [-0.012, uc + 0.012]]] }));
}

/** Round barrel shroud with vent holes (SMGs). */
export function ventedShroud(s: PartSink, _m: GunMats, f0: number, f1: number, u: number, r: number, mat: M): void {
  const len = f1 - f0;
  const holes: P2[][] = [];
  const n = Math.max(2, Math.floor(len / 0.028));
  for (let i = 0; i < n; i++) {
    const a = f0 + 0.012 + i * 0.028;
    holes.push([[a, u - 0.005], [a + 0.016, u - 0.005], [a + 0.016, u + 0.005], [a, u + 0.005]]);
  }
  const sp: P2[] = [[f0, u - r * 0.75], [f1, u - r * 0.75], [f1, u + r * 0.75], [f0, u + r * 0.75]];
  s.add(mat, sideAt(sp, 0.004, r - 0.002, { holes, bevel: 0.001, round: 0.001 }));
  s.add(mat, sideAt(sp, 0.004, -(r - 0.002), { holes, bevel: 0.001, round: 0.001 }));
  s.add(mat, gbox(f0, f1, u + r - 0.005, u + r, r * 0.8));
  s.add(mat, gbox(f0, f1, u - r, u - r + 0.005, r * 0.8));
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      s.add(mat, box(0.004, r * 0.75, len, { p: [sx * r * 0.82, u + sy * r * 0.82, -(f0 + f1) / 2], r: [0, 0, sx * sy * -Math.PI / 4] }));
    }
  }
}

export function barrel(s: PartSink, m: GunMats, f0: number, f1: number, u: number, r = 0.0085): void {
  s.add(m.steel, gcyl(f0, f1, u, r, 20));
  // dark bore at the crown
  s.add(m.dark, gcyl(f1 - 0.001, f1 + 0.0004, u, r * 0.45, 12));
}

export type MuzzleStyle = 'brake' | 'flash' | 'comp' | 'suppressor' | 'thread';

export function muzzle(s: PartSink, m: GunMats, f: number, u: number, style: MuzzleStyle, r = 0.0125): number {
  if (style === 'thread') {
    s.add(m.steel, latheZ([[0.0001, 0], [r * 0.8, 0], [r * 0.8, 0.018], [r * 0.6, 0.02], [0.0001, 0.02]], 20, { p: [0, u, -f] }));
    return f + 0.02;
  }
  if (style === 'suppressor') {
    const L = 0.16;
    s.add(m.steel, latheZ([[0.0001, 0], [r * 0.9, 0], [r * 1.25, 0.012], [r * 1.25, L - 0.01], [r * 1.05, L], [0.0001, L]], 28, { p: [0, u, -f] }));
    s.add(m.dark, gcyl(f + L - 0.001, f + L + 0.0004, u, r * 0.4, 12));
    // knurled ring
    const ribs: Geo[] = [];
    for (let i = 0; i < 6; i++) ribs.push(gcyl(f + 0.016 + i * 0.006, f + 0.019 + i * 0.006, u, r * 1.3, 24));
    s.add(m.steel, ribs);
    return f + L;
  }
  const L = style === 'flash' ? 0.055 : 0.06;
  s.add(m.steel, latheZ([[0.0001, 0], [r * 0.75, 0], [r, 0.006], [r, L - 0.004], [r * 0.85, L], [0.0001, L]], 22, { p: [0, u, -f] }));
  const dark: Geo[] = [];
  if (style === 'brake') {
    for (let i = 0; i < 3; i++) {
      const a = f + 0.012 + i * 0.014;
      dark.push(gbox(a, a + 0.008, u - 0.006, u + 0.006, 0.0006, r - 0.0002));
      dark.push(gbox(a, a + 0.008, u - 0.006, u + 0.006, 0.0006, -(r - 0.0002)));
    }
  } else if (style === 'flash') {
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * Math.PI * 2 + Math.PI / 4;
      dark.push(box(0.0018, 0.0012, 0.028, { p: [Math.cos(ang) * (r - 0.0003), u + Math.sin(ang) * (r - 0.0003), -(f + L - 0.016)], r: [0, 0, ang] }));
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const a = f + 0.01 + i * 0.011;
      dark.push(gbox(a, a + 0.006, u + r - 0.0008, u + r + 0.0003, 0.004));
    }
  }
  s.add(m.dark, dark);
  return f + L;
}

export function bufferTube(s: PartSink, m: GunMats, f0: number, f1: number, u: number): void {
  s.add(m.alu, gcyl(f0, f1, u, 0.0145, 20));
  s.add(m.steel, gcyl(f1 - 0.008, f1, u, 0.0172, 8));
  const ribs: Geo[] = [];
  for (let i = 0; i < 5; i++) ribs.push(gbox(f0 + 0.03 + i * 0.022, f0 + 0.034 + i * 0.022, u - 0.0172, u - 0.0135, 0.004));
  s.add(m.alu, ribs);
}

export type StockStyle = 'adjustable' | 'fixed' | 'skeleton' | 'wire' | 'precision' | 'wood' | 'none';

export function stock(s: PartSink, m: GunMats, fRear: number, u: number, style: StockStyle, mat: M): number {
  if (style === 'none') return fRear;
  if (style === 'adjustable') {
    const p: P2[] = [
      [fRear + 0.135, u + 0.022],
      [fRear + 0.018, u + 0.032],
      [fRear + 0.005, u + 0.02],
      [fRear + 0.005, u - 0.098],
      [fRear + 0.02, u - 0.11],
      [fRear + 0.05, u - 0.104],
      [fRear + 0.105, u - 0.03],
      [fRear + 0.135, u - 0.014],
    ];
    s.add(mat, sideAt(p, 0.038, 0, { round: 0.008, bevel: 0.004, holes: [[[fRear + 0.03, u - 0.07], [fRear + 0.07, u - 0.03], [fRear + 0.03, u - 0.03]]] }));
    s.add(mat, sideAt([[fRear + 0.12, u + 0.03], [fRear + 0.03, u + 0.036], [fRear + 0.03, u + 0.02], [fRear + 0.12, u + 0.02]], 0.03, 0, { round: 0.004, bevel: 0.003 }));
    s.add(m.rubber, sideAt([[fRear + 0.006, u + 0.034], [fRear - 0.01, u + 0.034], [fRear - 0.012, u - 0.112], [fRear + 0.006, u - 0.112]], 0.042, 0, { round: 0.006, bevel: 0.004 }));
    s.add(m.steel, gbox(fRear + 0.06, fRear + 0.075, u - 0.03, u - 0.02, 0.0205));
    return fRear - 0.012;
  }
  if (style === 'fixed' || style === 'precision') {
    const tall = style === 'precision' ? 0.012 : 0;
    const p: P2[] = [
      [fRear + 0.17, u + 0.012],
      [fRear + 0.03, u + 0.03 + tall],
      [fRear + 0.008, u + 0.03 + tall],
      [fRear + 0.004, u - 0.105],
      [fRear + 0.03, u - 0.11],
      [fRear + 0.07, u - 0.07],
      [fRear + 0.13, u - 0.045],
      [fRear + 0.17, u - 0.035],
    ];
    s.add(mat, sideAt(p, 0.036, 0, { round: 0.01, bevel: 0.005, holes: style === 'precision' ? [[[fRear + 0.04, u - 0.06], [fRear + 0.1, u - 0.04], [fRear + 0.04, u - 0.02]]] : [] }));
    s.add(m.rubber, sideAt([[fRear + 0.008, u + 0.032 + tall], [fRear - 0.01, u + 0.032 + tall], [fRear - 0.012, u - 0.108], [fRear + 0.006, u - 0.108]], 0.04, 0, { round: 0.006, bevel: 0.004 }));
    if (style === 'precision') s.add(m.alu, gbox(fRear + 0.03, fRear + 0.12, u + 0.03 + tall, u + 0.04 + tall, 0.014));
    return fRear - 0.012;
  }
  if (style === 'skeleton') {
    const p: P2[] = [
      [fRear + 0.15, u + 0.02],
      [fRear + 0.01, u + 0.03],
      [fRear + 0.0, u - 0.09],
      [fRear + 0.02, u - 0.1],
      [fRear + 0.15, u - 0.02],
    ];
    s.add(mat, sideAt(p, 0.024, 0, { round: 0.008, bevel: 0.003, holes: [[[fRear + 0.02, u + 0.012], [fRear + 0.12, u + 0.006], [fRear + 0.12, u - 0.012], [fRear + 0.02, u - 0.07]]] }));
    s.add(m.rubber, gbox(fRear - 0.01, fRear + 0.004, u - 0.1, u + 0.032, 0.014));
    return fRear - 0.01;
  }
  if (style === 'wire') {
    for (const sx of [1, -1]) {
      s.add(m.steel, rod([sx * 0.016, u + 0.012, fRear + 0.005], [sx * 0.016, u + 0.012, fRear + 0.2], 0.0042));
      s.add(m.steel, rod([sx * 0.016, u - 0.07, fRear + 0.005], [sx * 0.016, u - 0.03, fRear + 0.2], 0.0042));
    }
    s.add(m.rubber, grbox(fRear - 0.012, fRear + 0.006, u - 0.085, u + 0.028, 0.022, 0.005));
    s.add(m.steel, gbox(fRear + 0.19, fRear + 0.215, u - 0.035, u + 0.02, 0.019));
    return fRear - 0.012;
  }
  // wood
  const p: P2[] = [
    [fRear + 0.25, u + 0.01],
    [fRear + 0.02, u + 0.028],
    [fRear + 0.002, u + 0.026],
    [fRear, u - 0.11],
    [fRear + 0.03, u - 0.112],
    [fRear + 0.25, u - 0.03],
  ];
  s.add(mat, sideAt(p, 0.038, 0, { round: 0.012, bevel: 0.006 }));
  s.add(m.rubber, sideAt([[fRear + 0.002, u + 0.026], [fRear - 0.012, u + 0.026], [fRear - 0.014, u - 0.11], [fRear, u - 0.11]], 0.04, 0, { round: 0.005, bevel: 0.004 }));
  return fRear - 0.014;
}

export function pistolGrip(s: PartSink, m: GunMats, f: number, u: number, mat: M = m.grip, scale = 1): void {
  const k = scale;
  const p: P2[] = [
    [f + 0.006 * k, u],
    [f - 0.004 * k, u - 0.03 * k],
    [f + 0.0 * k, u - 0.038 * k],
    [f - 0.01 * k, u - 0.055 * k],
    [f - 0.006 * k, u - 0.064 * k],
    [f - 0.018 * k, u - 0.084 * k],
    [f - 0.022 * k, u - 0.104 * k],
    [f - 0.07 * k, u - 0.108 * k],
    [f - 0.062 * k, u - 0.06 * k],
    [f - 0.046 * k, u - 0.02 * k],
    [f - 0.036 * k, u],
  ];
  s.add(mat, sideAt(p, 0.029, 0, { round: 0.006, bevel: 0.005 }));
  // beavertail
  s.add(mat, sideAt([[f - 0.036, u + 0.002], [f - 0.06, u - 0.008], [f - 0.056, u - 0.016], [f - 0.04, u - 0.012]], 0.024, 0, { round: 0.004, bevel: 0.003 }));
}

// ---------------------------------------------------------------- magazines

export type MagStyle = 'curved' | 'straight' | 'pistol' | 'drum' | 'box' | 'tube' | 'shells' | 'sniper';

/** Builds a magazine group positioned with its top at (f, u). Returns the group and its insertion top point. */
export function magazine(m: GunMats, style: MagStyle, f: number, u: number, opts: { len?: number; w?: number; depth?: number; mat?: M; angle?: number } = {}): THREE.Group {
  const s = new PartSink();
  const w = opts.w ?? 0.022;
  const mat = opts.mat ?? m.furniture;
  const len = opts.len ?? 0.17;
  const depth = opts.depth ?? 0.056;
  if (style === 'curved') {
    const c = 0.04;
    const p: P2[] = [
      [0, 0.0], [depth, 0.0],
      [depth + 0.006, -len * 0.35], [depth + c * 0.6, -len * 0.7], [depth + c, -len],
      [c + 0.002, -len - 0.008], [c * 0.55, -len * 0.7], [0.008, -len * 0.35],
    ];
    s.add(mat, sideAt(p, w, 0, { round: 0.006, bevel: 0.0025 }));
    // ribs
    const ribs: Geo[] = [];
    for (let i = 0; i < 4; i++) {
      const t = 0.25 + i * 0.16;
      const fo = c * t * t * 1.1;
      ribs.push(gbox(0.008 + fo, depth + fo - 0.004, -len * t - 0.003, -len * t + 0.003, w / 2 + 0.0012));
    }
    s.add(mat, ribs);
    s.add(m.furniture, sideAt([[c - 0.004, -len - 0.004], [depth + c + 0.006, -len + 0.0], [depth + c + 0.008, -len - 0.012], [c - 0.006, -len - 0.016]], w + 0.004, 0, { round: 0.004, bevel: 0.002 }));
  } else if (style === 'straight' || style === 'sniper') {
    const lean = style === 'sniper' ? 0.0 : 0.012;
    const p: P2[] = [[0, 0], [depth, 0], [depth + lean, -len], [lean, -len]];
    s.add(mat, sideAt(p, w, 0, { round: 0.004, bevel: 0.002 }));
    s.add(m.furniture, gbox(lean - 0.004, depth + lean + 0.004, -len - 0.012, -len + 0.002, w / 2 + 0.002));
    const ribs: Geo[] = [];
    for (let i = 0; i < 3; i++) {
      const t = 0.3 + i * 0.2;
      ribs.push(gbox(0.006 + lean * t, depth + lean * t - 0.006, -len * t - 0.002, -len * t + 0.002, w / 2 + 0.001));
    }
    s.add(mat, ribs);
  } else if (style === 'pistol') {
    s.add(m.steel, sideAt([[0, 0], [depth, 0], [depth - 0.01, -len], [-0.01, -len]], w, 0, { round: 0.003, bevel: 0.001 }));
    s.add(m.furniture, sideAt([[-0.014, -len], [depth - 0.006, -len], [depth - 0.006, -len - 0.012], [-0.016, -len - 0.012]], w + 0.006, 0, { round: 0.004, bevel: 0.002 }));
  } else if (style === 'drum') {
    s.add(mat, sideAt([[0, 0], [depth, 0], [depth, -0.05], [0, -0.05]], w, 0, { round: 0.003, bevel: 0.002 }));
    const drum = cylX(0.062, 0.075, 28, { p: [0, -0.1, -depth * 0.5] });
    s.add(mat, drum);
    s.add(m.steel, cylX(0.02, 0.08, 16, { p: [0, -0.1, -depth * 0.5] }));
    const ribs: Geo[] = [];
    for (let i = 0; i < 2; i++) ribs.push(cylX(0.064, 0.006, 28, { p: [(i ? 1 : -1) * 0.028, -0.1, -depth * 0.5] }));
    s.add(m.furniture, ribs);
  } else if (style === 'box') {
    s.add(mat, sideAt([[0, 0], [depth, 0], [depth, -0.12], [0, -0.12]], 0.075, 0.02, { round: 0.006, bevel: 0.003 }));
    s.add(m.steel, gbox(0.004, depth - 0.004, -0.124, -0.118, 0.04, 0.02));
    s.add(m.rubber, gbox(depth * 0.3, depth * 0.7, -0.05, -0.03, 0.002, 0.059));
  } else if (style === 'shells') {
    // shotgun box magazine with visible shell base
    s.add(mat, sideAt([[0, 0], [depth, 0], [depth + 0.004, -len], [0.004, -len]], w, 0, { round: 0.005, bevel: 0.003 }));
    s.add(m.brass, gbox(0.006, depth - 0.006, -0.004, 0.003, w / 2 - 0.002));
  }
  const g = s.build('mag');
  g.position.set(0, u, -f);
  if (opts.angle) g.rotation.x = opts.angle;
  return g;
}

// ---------------------------------------------------------------- optics

export type OpticStyle = 'holo' | 'reflex' | 'scope' | 'lpvo' | 'irons';

export interface OpticResult {
  /** Up coordinate of the line of sight. */
  sightU: number;
  /** Forward position of the eye for ADS (behind the optic). */
  eyeF: number;
  /** Extra meshes (reticles) that must not be merged. */
  extras: THREE.Object3D[];
  /** Magnification (1 = red dot). */
  zoom: number;
}

export function optic(s: PartSink, m: GunMats, lib: MaterialLibrary, style: OpticStyle, f: number, u: number, color = 0xff5a1a): OpticResult {
  const extras: THREE.Object3D[] = [];
  if (style === 'holo') {
    const L = 0.088;
    s.add(m.alu, gbox(f + 0.006, f + L - 0.004, u, u + 0.009, 0.0125));
    s.add(m.alu, gbox(f + 0.02, f + 0.05, u - 0.004, u + 0.004, 0.0135));
    const outer: P2[] = [[-0.0235, u + 0.008], [0.0235, u + 0.008], [0.0235, u + 0.06], [-0.0235, u + 0.06]];
    const inner: P2[] = [[-0.0178, u + 0.016], [0.0178, u + 0.016], [0.0178, u + 0.053], [-0.0178, u + 0.053]];
    s.add(m.furniture, front(outer, L, f, { round: 0.006, bevel: 0.002, holes: [inner] }));
    s.add(m.furniture, front([[-0.0235, u + 0.008], [0.0235, u + 0.008], [0.0235, u + 0.02], [-0.0235, u + 0.02]], L * 0.6, f + 0.0, { round: 0.004, bevel: 0.002 }));
    // battery cap + buttons
    s.add(m.alu, cylX(0.0078, 0.012, 16, { p: [0.029, u + 0.022, -(f + 0.03)] }));
    s.add(m.rubber, grbox(f + 0.004, f + 0.014, u + 0.011, u + 0.018, 0.006, 0.002, 0.0));
    s.add(m.rubber, grbox(f + 0.016, f + 0.026, u + 0.011, u + 0.018, 0.006, 0.002, 0.0));
    const glassF = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.037), m.glass);
    glassF.position.set(0, u + 0.0345, -(f + L - 0.004));
    const glassB = glassF.clone();
    glassB.position.z = -(f + 0.006);
    const ret = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.03), lib.reticle('holo', color));
    ret.position.set(0, u + 0.0345, -(f + L - 0.006));
    ret.renderOrder = 10;
    extras.push(glassF, glassB, ret);
    return { sightU: u + 0.0345, eyeF: f - 0.1, extras, zoom: 1.0 };
  }
  if (style === 'reflex') {
    s.add(m.alu, gbox(f, f + 0.05, u, u + 0.008, 0.012));
    const outer: P2[] = [[-0.017, u + 0.006], [0.017, u + 0.006], [0.015, u + 0.036], [-0.015, u + 0.036]];
    const inner: P2[] = [[-0.0125, u + 0.011], [0.0125, u + 0.011], [0.0115, u + 0.031], [-0.0115, u + 0.031]];
    s.add(m.alu, front(outer, 0.01, f + 0.036, { round: 0.006, bevel: 0.0015, holes: [inner] }));
    s.add(m.alu, gbox(f + 0.004, f + 0.03, u + 0.006, u + 0.016, 0.014));
    s.add(m.alu, cylX(0.006, 0.006, 12, { p: [0.016, u + 0.012, -(f + 0.018)] }));
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.026, 0.022), m.glass);
    glass.position.set(0, u + 0.021, -(f + 0.04));
    glass.rotation.x = -0.12;
    const ret = new THREE.Mesh(new THREE.PlaneGeometry(0.016, 0.016), lib.reticle('dot', color));
    ret.position.set(0, u + 0.021, -(f + 0.041));
    ret.renderOrder = 10;
    extras.push(glass, ret);
    return { sightU: u + 0.021, eyeF: f - 0.12, extras, zoom: 1.0 };
  }
  if (style === 'scope' || style === 'lpvo') {
    const big = style === 'scope';
    const r = big ? 0.0175 : 0.015;
    const L = big ? 0.3 : 0.24;
    const axis = u + (big ? 0.05 : 0.042);
    // rings
    for (const rf of [f + 0.06, f + L - 0.08]) {
      s.add(m.alu, gbox(rf - 0.009, rf + 0.009, u, u + 0.012, 0.012));
      s.add(m.alu, latheZ([[r + 0.0005, 0], [r + 0.005, 0], [r + 0.005, 0.018], [r + 0.0005, 0.018]], 24, { p: [0, axis, -(rf - 0.009)] }));
      s.add(m.alu, gbox(rf - 0.009, rf + 0.009, u + 0.008, axis, 0.007));
    }
    // tube
    const objR = big ? 0.026 : 0.02;
    s.add(m.receiver, latheZ([
      [0.0001, 0],
      [r + 0.006, 0], [r + 0.006, 0.05], [r, 0.07],
      [r, L - 0.11], [objR, L - 0.06], [objR + 0.002, L - 0.004], [objR, L], [0.0001, L],
    ], 32, { p: [0, axis, -f] }));
    // turrets
    s.add(m.alu, cyl0(0.009, 0.018, [0, axis + r + 0.006, -(f + L * 0.45)]));
    s.add(m.alu, cylX(0.009, 0.018, 16, { p: [r + 0.006, axis, -(f + L * 0.45)] }));
    s.add(m.alu, gbox(f + L * 0.45 - 0.012, f + L * 0.45 + 0.012, axis - 0.004, axis + r + 0.002, r + 0.002));
    // lenses
    const front = new THREE.Mesh(new THREE.CircleGeometry(objR - 0.001, 28), m.lens);
    front.position.set(0, axis, -(f + L + 0.0005));
    front.rotation.y = Math.PI;
    const rear = new THREE.Mesh(new THREE.CircleGeometry(r + 0.004, 28), m.lens);
    rear.position.set(0, axis, -(f - 0.0005));
    extras.push(front, rear);
    return { sightU: axis, eyeF: f - 0.07, extras, zoom: big ? 4.0 : 2.0 };
  }
  // irons: folding front + rear sights
  s.add(m.steel, gbox(f, f + 0.02, u, u + 0.012, 0.011));
  s.add(m.steel, sideAt([[f + 0.004, u + 0.01], [f + 0.016, u + 0.01], [f + 0.014, u + 0.03], [f + 0.006, u + 0.03]], 0.02, 0, { round: 0.002, bevel: 0.001, holes: [[[f + 0.008, u + 0.016], [f + 0.012, u + 0.016], [f + 0.012, u + 0.024], [f + 0.008, u + 0.024]]] }));
  return { sightU: u + 0.022, eyeF: f - 0.15, extras, zoom: 1.0 };
}

function cyl0(r: number, h: number, p: [number, number, number]): Geo {
  return latheZ([[0.0001, 0], [r, 0], [r, h], [0.0001, h]], 18, { p, r: [-Math.PI / 2, 0, 0] });
}

/** Front sight post with protective ears (rifles running irons). */
export function frontPost(s: PartSink, m: GunMats, f: number, u: number): void {
  s.add(m.steel, gbox(f - 0.01, f + 0.01, u, u + 0.01, 0.009));
  s.add(m.steel, sideAt([[f - 0.008, u + 0.008], [f + 0.008, u + 0.008], [f + 0.004, u + 0.036], [f - 0.004, u + 0.036]], 0.004, 0.009, { round: 0.002 }));
  s.add(m.steel, sideAt([[f - 0.008, u + 0.008], [f + 0.008, u + 0.008], [f + 0.004, u + 0.036], [f - 0.004, u + 0.036]], 0.004, -0.009, { round: 0.002 }));
  s.add(m.steel, gbox(f - 0.0015, f + 0.0015, u + 0.008, u + 0.03, 0.0015));
}

export { merge };
