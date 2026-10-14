import * as THREE from 'three';
import type { MaterialLibrary } from '../materials';
import {
  PartSink,
  arLower,
  arUpper,
  barrel,
  bufferTube,
  frontPost,
  gbox,
  gcyl,
  grbox,
  gunMats,
  magazine,
  muzzle,
  optic,
  pistolGrip,
  rail,
  screws,
  sideAt,
  slottedHandguard,
  stock,
  ventedShroud,
  type GunMats,
  type OpticResult,
} from './gunParts';
import { box, cylX, cylZ, front, latheZ, rbox, type Geo, type P2 } from '../geometry/toolkit';

// Code-modeled weapons. Each model exposes rigging points used by the first-person
// viewmodel (hands, ADS alignment, muzzle flash, casing ejection) and animations.

export interface WeaponModel {
  id: string;
  root: THREE.Group;
  /** Moves on reload (magazine / shells). */
  mag: THREE.Object3D | null;
  /** Moves on fire / charging (slide, bolt, pump). */
  bolt: THREE.Object3D | null;
  boltTravel: THREE.Vector3;
  /** Extra animated parts (revolver cylinder, etc). */
  parts: Record<string, THREE.Object3D>;
  muzzle: THREE.Vector3;
  eject: THREE.Vector3;
  /** Point that sits on the line of sight when aiming down sights. */
  sight: THREE.Vector3;
  /** Where the eye should be along the line of sight for ADS (model space). */
  eye: THREE.Vector3;
  gripR: THREE.Vector3;
  gripL: THREE.Vector3;
  /** Left hand style: on handguard, vertical grip, pump, or wrapped on the pistol grip. */
  leftHand: 'handguard' | 'vgrip' | 'pump' | 'pistol' | 'magwell';
  zoom: number;
  scoped: boolean;
  length: number;
}

function v(x: number, u: number, f: number): THREE.Vector3 {
  return new THREE.Vector3(x, u, -f);
}

interface BuildCtx {
  lib: MaterialLibrary;
  m: GunMats;
  s: PartSink;
}

function finish(
  id: string,
  ctx: BuildCtx,
  o: {
    mag: THREE.Object3D | null;
    bolt?: THREE.Object3D | null;
    boltTravel?: THREE.Vector3;
    parts?: Record<string, THREE.Object3D>;
    muzzleF: number;
    boreU: number;
    eject: THREE.Vector3;
    opt: OpticResult;
    gripR: THREE.Vector3;
    gripL: THREE.Vector3;
    leftHand: WeaponModel['leftHand'];
    rearF: number;
  },
): WeaponModel {
  const root = ctx.s.build(id);
  if (o.mag) root.add(o.mag);
  if (o.bolt) root.add(o.bolt);
  for (const p of Object.values(o.parts ?? {})) if (!p.parent) root.add(p);
  for (const e of o.opt.extras) root.add(e);
  root.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return {
    id,
    root,
    mag: o.mag,
    bolt: o.bolt ?? null,
    boltTravel: o.boltTravel ?? new THREE.Vector3(0, 0, 0.05),
    parts: o.parts ?? {},
    muzzle: v(0, o.boreU, o.muzzleF),
    eject: o.eject,
    sight: v(0, o.opt.sightU, 0.05),
    eye: v(0, o.opt.sightU, o.opt.eyeF),
    gripR: o.gripR,
    gripL: o.gripL,
    leftHand: o.leftHand,
    zoom: o.opt.zoom,
    scoped: o.opt.zoom > 1.5,
    length: o.muzzleF - o.rearF,
  };
}

// ======================================================================= RIFLES

interface RifleSpec {
  id: string;
  tan?: boolean;
  handguardEnd: number;
  barrelEnd: number;
  muzzle: 'brake' | 'flash' | 'comp' | 'suppressor';
  stock: 'adjustable' | 'fixed' | 'skeleton' | 'precision';
  optic: 'holo' | 'reflex' | 'scope' | 'lpvo' | 'irons';
  opticF: number;
  mag: 'curved' | 'straight' | 'box' | 'sniper';
  magLen?: number;
  reticle?: number;
  heavy?: boolean;
  vgrip?: boolean;
  bipod?: boolean;
}

function buildRifle(lib: MaterialLibrary, spec: RifleSpec): WeaponModel {
  const m = gunMats(lib, { tan: spec.tan });
  const s = new PartSink();
  const ctx = { lib, m, s };
  const boreU = 0.026;
  arLower(s, m);
  arUpper(s, m);
  // Upper/lower takedown pins
  s.add(m.steel, cylX(0.0035, 0.029, 10, { p: [0, 0.004, -0.11] }));
  s.add(m.steel, cylX(0.0035, 0.029, 10, { p: [0, 0.004, 0.075] }));
  const hgW = spec.heavy ? 0.03 : 0.0255;
  slottedHandguard(s, m, 0.172, spec.handguardEnd, -0.006, 0.05, hgW, spec.tan ? m.receiver : m.alu);
  barrel(s, m, 0.1, spec.barrelEnd, boreU, spec.heavy ? 0.011 : 0.0085);
  // Gas block peeking out in front of the handguard on long barrels
  if (spec.barrelEnd - spec.handguardEnd > 0.06) s.add(m.steel, gbox(spec.handguardEnd + 0.008, spec.handguardEnd + 0.03, boreU - 0.01, boreU + 0.014, 0.011));
  const muzzleF = muzzle(s, m, spec.barrelEnd - 0.004, boreU, spec.muzzle, spec.heavy ? 0.016 : 0.0125);
  rail(s, m, -0.094, spec.handguardEnd - 0.004, 0.05);
  // Side rail segments on handguard front
  rail(s, m, spec.handguardEnd - 0.08, spec.handguardEnd - 0.01, 0.0, 0.0);
  bufferTube(s, m, -0.3, -0.098, 0.03);
  const rearF = stock(s, m, -0.34, 0.03, spec.stock, m.furniture);
  pistolGrip(s, m, 0.0, -0.022);
  screws(s, m, [[0.2, 0.04], [spec.handguardEnd - 0.02, 0.04]], hgW + 0.001);
  // QD sling cup + swivel on the stock side
  s.add(m.steel, cylX(0.0065, 0.004, 14, { p: [0.02, 0.0, 0.2] }));
  if (spec.vgrip) {
    s.add(m.grip, latheZ([[0.0001, 0], [0.015, 0], [0.016, 0.06], [0.013, 0.085], [0.0001, 0.087]], 20, { p: [0, -0.008, -(spec.handguardEnd - 0.1)], r: [Math.PI / 2, 0, 0] }));
  }
  if (spec.bipod) {
    s.add(m.steel, gbox(spec.handguardEnd - 0.05, spec.handguardEnd - 0.01, -0.016, -0.006, 0.014));
    s.add(m.steel, box(0.007, 0.007, 0.16, { p: [0.012, -0.03, -(spec.handguardEnd - 0.12)], r: [0.05, 0.08, 0] }));
    s.add(m.steel, box(0.007, 0.007, 0.16, { p: [-0.012, -0.03, -(spec.handguardEnd - 0.12)], r: [0.05, -0.08, 0] }));
  }
  const opt = optic(s, m, lib, spec.optic, spec.opticF, 0.0565, spec.reticle ?? 0xff5a1a);
  if (spec.optic === 'irons') frontPost(s, m, spec.handguardEnd - 0.015, 0.0565);
  const magDepth = spec.mag === 'box' ? 0.07 : 0.056;
  const mag = magazine(m, spec.mag === 'box' ? 'box' : spec.mag, 0.064, -0.02, { len: spec.magLen ?? 0.17, depth: magDepth, w: spec.heavy ? 0.026 : 0.022, mat: spec.mag === 'sniper' ? m.steel : m.furniture });
  // Bolt carrier visible through the port (moves on fire)
  const boltS = new PartSink();
  boltS.add(m.steel, gbox(0.006, 0.066, 0.02, 0.038, 0.004, 0.009));
  boltS.add(m.steel, gcyl(0.03, 0.04, 0.03, 0.0035, 10, 0.0145));
  const bolt = boltS.build('bolt');
  return finish(spec.id, ctx, {
    mag,
    bolt,
    boltTravel: new THREE.Vector3(0, 0, 0.045),
    muzzleF,
    boreU,
    eject: v(0.02, 0.03, 0.04),
    opt,
    gripR: v(0, -0.06, -0.04),
    gripL: spec.vgrip ? v(0, -0.06, spec.handguardEnd - 0.1) : v(0, -0.008, Math.min(spec.handguardEnd - 0.06, 0.34)),
    leftHand: spec.vgrip ? 'vgrip' : 'handguard',
    rearF,
  });
}

// ======================================================================= SMGs

function buildRook(lib: MaterialLibrary): WeaponModel {
  const m = gunMats(lib);
  const s = new PartSink();
  const ctx = { lib, m, s };
  const boreU = 0.034;
  // Polymer receiver: upper block + lower fire-control housing
  s.add(m.furniture, sideAt([[-0.13, 0.0], [0.17, 0.0], [0.18, 0.012], [0.18, 0.06], [0.16, 0.068], [-0.12, 0.068], [-0.135, 0.055]], 0.046, 0, { round: 0.008, bevel: 0.004 }));
  s.add(m.furniture, sideAt([[-0.075, 0.002], [0.12, 0.002], [0.12, -0.02], [0.10, -0.036], [-0.02, -0.036], [-0.06, -0.026]], 0.04, 0, { round: 0.006, bevel: 0.003 }));
  // Side ribs / texture panels
  for (const sx of [1, -1]) {
    s.add(m.grip, gbox(-0.09, 0.0, 0.018, 0.05, 0.0012, sx * 0.0232));
    s.add(m.receiver, gbox(0.02, 0.15, 0.04, 0.056, 0.0012, sx * 0.0232));
  }
  // Ejection port
  s.add(m.dark, gbox(0.03, 0.085, 0.036, 0.056, 0.0008, 0.0234));
  // Trigger guard (molded) + trigger
  s.add(m.furniture, sideAt([[-0.01, -0.03], [0.06, -0.03], [0.058, -0.064], [0.0, -0.068], [-0.018, -0.056]], 0.012, 0, { round: 0.005, bevel: 0.002, holes: [[[-0.004, -0.036], [0.052, -0.036], [0.05, -0.058], [0.0, -0.06]]] }));
  s.add(m.steel, sideAt([[0.012, -0.034], [0.02, -0.034], [0.022, -0.044], [0.018, -0.055], [0.014, -0.054], [0.016, -0.044]], 0.006, 0, { round: 0.002 }));
  pistolGrip(s, m, -0.006, -0.03, m.grip, 1.0);
  // Shroud + barrel + muzzle
  ventedShroud(s, m, 0.175, 0.3, boreU, 0.022, m.furniture);
  barrel(s, m, 0.15, 0.33, boreU, 0.0085);
  const muzzleF = muzzle(s, m, 0.326, boreU, 'comp', 0.0115);
  // Cocking tube + handle (left side, forward)
  s.add(m.steel, gcyl(0.09, 0.29, 0.064, 0.0065, 14));
  s.add(m.steel, box(0.024, 0.006, 0.01, { p: [-0.014, 0.064, -0.27] }));
  s.add(m.rubber, rbox(0.01, 0.012, 0.014, 0.003, 2, { p: [-0.028, 0.064, -0.27] }));
  rail(s, m, -0.11, 0.165, 0.068);
  // Vertical foregrip
  s.add(m.grip, latheZ([[0.0001, 0], [0.014, 0], [0.015, 0.055], [0.012, 0.075], [0.0001, 0.077]], 20, { p: [0, 0.002, -0.235], r: [Math.PI / 2, 0, 0] }));
  rail(s, m, 0.2, 0.27, -0.0005, 0.009);
  // Wire stock
  const rearF = stock(s, m, -0.33, 0.032, 'wire', m.steel);
  s.add(m.steel, gbox(-0.15, -0.125, 0.0, 0.06, 0.02));
  screws(s, m, [[-0.1, 0.06], [0.14, 0.012], [-0.04, -0.02]], 0.0235);
  const opt = optic(s, m, lib, 'reflex', 0.0, 0.0745, 0xff3a1a);
  const mag = magazine(m, 'straight', 0.072, -0.03, { len: 0.16, depth: 0.034, w: 0.02, mat: m.furniture });
  mag.rotation.x = -0.12;
  const boltS = new PartSink();
  boltS.add(m.steel, gbox(0.035, 0.08, 0.04, 0.054, 0.004, 0.019));
  const bolt = boltS.build('bolt');
  return finish('rook9', ctx, {
    mag,
    bolt,
    boltTravel: new THREE.Vector3(0, 0, 0.035),
    muzzleF,
    boreU,
    eject: v(0.03, 0.045, 0.06),
    opt,
    gripR: v(0, -0.07, -0.045),
    gripL: v(0, -0.05, 0.235),
    leftHand: 'vgrip',
    rearF,
  });
}

// ======================================================================= PISTOLS

function buildWarden(lib: MaterialLibrary): WeaponModel {
  const m = gunMats(lib);
  const s = new PartSink();
  const ctx = { lib, m, s };
  const boreU = 0.024;
  // Frame (polymer) with dust-cover rail, integrated trigger guard, grip
  s.add(m.furniture, sideAt([[-0.07, 0.012], [0.098, 0.012], [0.1, 0.0], [0.07, -0.012], [-0.065, -0.012]], 0.026, 0, { round: 0.003, bevel: 0.002 }));
  s.add(m.furniture, sideAt([[-0.004, -0.008], [0.06, -0.008], [0.064, -0.016], [0.058, -0.04], [0.004, -0.046], [-0.016, -0.034]], 0.012, 0, { round: 0.006, bevel: 0.002, holes: [[[0.002, -0.014], [0.054, -0.014], [0.05, -0.036], [0.004, -0.038]]] }));
  const grip: P2[] = [
    [-0.006, -0.006], [-0.014, -0.04], [-0.01, -0.048], [-0.02, -0.066], [-0.017, -0.074], [-0.026, -0.092], [-0.03, -0.108],
    [-0.075, -0.112], [-0.072, -0.07], [-0.07, -0.03], [-0.068, -0.008],
  ];
  s.add(m.furniture, sideAt(grip, 0.03, 0, { round: 0.006, bevel: 0.005 }));
  // Stippled grip panels
  const panel: P2[] = [[-0.022, -0.03], [-0.03, -0.09], [-0.068, -0.094], [-0.064, -0.03]];
  s.add(m.grip, sideAt(panel, 0.002, 0.0152, { round: 0.006, bevel: 0.0008 }));
  s.add(m.grip, sideAt(panel, 0.002, -0.0152, { round: 0.006, bevel: 0.0008 }));
  rail(s, m, 0.05, 0.095, -0.014, 0.01);
  // Trigger
  s.add(m.furniture, sideAt([[0.016, -0.01], [0.024, -0.01], [0.026, -0.022], [0.021, -0.034], [0.017, -0.033], [0.019, -0.022]], 0.007, 0, { round: 0.002 }));
  // Slide (moves) with serrations, port, sights
  const sl = new PartSink();
  sl.add(m.steel, sideAt([[-0.082, 0.012], [0.106, 0.012], [0.106, 0.034], [0.098, 0.042], [-0.078, 0.042], [-0.084, 0.034]], 0.0255, 0, { round: 0.002, bevel: 0.0016 }));
  const serr: Geo[] = [];
  for (let i = 0; i < 7; i++) {
    const f = -0.074 + i * 0.0055;
    serr.push(gbox(f, f + 0.0022, 0.018, 0.038, 0.0005, 0.0128));
    serr.push(gbox(f, f + 0.0022, 0.018, 0.038, 0.0005, -0.0128));
  }
  for (let i = 0; i < 4; i++) {
    const f = 0.07 + i * 0.0055;
    serr.push(gbox(f, f + 0.0022, 0.02, 0.038, 0.0005, 0.0128));
    serr.push(gbox(f, f + 0.0022, 0.02, 0.038, 0.0005, -0.0128));
  }
  sl.add(m.dark, serr);
  sl.add(m.dark, gbox(0.0, 0.045, 0.028, 0.042, 0.0006, 0.0128));
  sl.add(m.brass, gbox(0.004, 0.04, 0.03, 0.04, 0.006, 0.006));
  // Sights + tritium
  sl.add(m.steel, gbox(0.088, 0.098, 0.042, 0.05, 0.0018));
  sl.add(m.tritium, gcyl(0.0925, 0.0985, 0.0475, 0.0012, 8));
  sl.add(m.steel, sideAt([[-0.078, 0.042], [-0.06, 0.042], [-0.062, 0.05], [-0.076, 0.05]], 0.022, 0, { round: 0.001, holes: [] }));
  sl.add(m.dark, gbox(-0.0775, -0.06, 0.045, 0.0505, 0.0022));
  sl.add(m.tritium, gcyl(-0.08, -0.077, 0.047, 0.0011, 8, 0.0055));
  sl.add(m.tritium, gcyl(-0.08, -0.077, 0.047, 0.0011, 8, -0.0055));
  const slide = sl.build('slide');
  // Barrel crown + guide rod
  s.add(m.steel, gcyl(0.1, 0.1065, boreU, 0.0062, 16));
  s.add(m.dark, gcyl(0.106, 0.1068, boreU, 0.0042, 12));
  s.add(m.steel, gcyl(0.085, 0.104, 0.0035, 0.0035, 10));
  // Slide stop + takedown
  s.add(m.steel, gbox(-0.02, 0.025, 0.004, 0.009, 0.0008, -0.0136));
  s.add(m.steel, cylX(0.003, 0.028, 10, { p: [0, 0.005, -0.035] }));
  const mag = magazine(m, 'pistol', -0.02, -0.004, { len: 0.1, depth: 0.034, w: 0.022, mat: m.steel });
  mag.rotation.x = 0.31;
  const opt: OpticResult = { sightU: 0.0485, eyeF: -0.24, extras: [], zoom: 1 };
  return finish('warden', ctx, {
    mag,
    bolt: slide,
    boltTravel: new THREE.Vector3(0, 0, 0.032),
    muzzleF: 0.107,
    boreU,
    eject: v(0.018, 0.04, 0.02),
    opt,
    gripR: v(0, -0.05, -0.04),
    gripL: v(-0.012, -0.06, -0.035),
    leftHand: 'pistol',
    rearF: -0.084,
  });
}

// ======================================================================= REGISTRY

type Builder = (lib: MaterialLibrary) => WeaponModel;

const BUILDERS: Record<string, Builder> = {
  halberd: (lib) =>
    buildRifle(lib, { id: 'halberd', handguardEnd: 0.47, barrelEnd: 0.5, muzzle: 'brake', stock: 'adjustable', optic: 'holo', opticF: 0.0, mag: 'curved' }),
  rook9: buildRook,
  warden: buildWarden,
};

export function weaponIds(): string[] {
  return Object.keys(BUILDERS);
}

const cache = new Map<string, WeaponModel>();

/** Builds (or clones from cache) a weapon model. */
export function buildWeapon(lib: MaterialLibrary, id: string): WeaponModel {
  const b = BUILDERS[id] ?? BUILDERS.halberd;
  const hit = cache.get(id);
  if (hit) return cloneModel(hit);
  const model = b(lib);
  cache.set(id, model);
  return cloneModel(model);
}

function cloneModel(src: WeaponModel): WeaponModel {
  const root = src.root.clone(true);
  const find = (o: THREE.Object3D | null): THREE.Object3D | null => {
    if (!o) return null;
    const idx = src.root.children.indexOf(o);
    return idx >= 0 ? root.children[idx] : null;
  };
  const parts: Record<string, THREE.Object3D> = {};
  for (const [k, p] of Object.entries(src.parts)) {
    const f = find(p);
    if (f) parts[k] = f;
  }
  return {
    ...src,
    root,
    mag: find(src.mag),
    bolt: find(src.bolt),
    parts,
    muzzle: src.muzzle.clone(),
    eject: src.eject.clone(),
    sight: src.sight.clone(),
    eye: src.eye.clone(),
    gripR: src.gripR.clone(),
    gripL: src.gripL.clone(),
    boltTravel: src.boltTravel.clone(),
  };
}

// Silence unused-import lint for helpers reserved for upcoming weapons.
void grbox;
void cylZ;
void front;
