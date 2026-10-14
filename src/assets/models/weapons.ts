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
  glathe,
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
import { box, cylX, front, latheZ, rbox, sphere, type Geo, type P2 } from '../geometry/toolkit';

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

interface SmgSpec {
  id: string;
  tan?: boolean;
  shroudEnd: number;
  optic: 'holo' | 'reflex';
  stock: 'wire' | 'skeleton' | 'adjustable';
  mag: 'straight' | 'drum';
  magLen?: number;
  vgrip: boolean;
  muzzle: 'comp' | 'flash' | 'thread';
  reticle?: number;
}

function buildSmg(lib: MaterialLibrary, spec: SmgSpec): WeaponModel {
  const m = gunMats(lib, { tan: spec.tan });
  const s = new PartSink();
  const ctx = { lib, m, s };
  const boreU = 0.034;
  const body = spec.tan ? m.furniture : m.furniture;
  // Polymer receiver: upper block + lower fire-control housing
  s.add(body, sideAt([[-0.13, 0.0], [0.17, 0.0], [0.18, 0.012], [0.18, 0.06], [0.16, 0.068], [-0.12, 0.068], [-0.135, 0.055]], 0.046, 0, { round: 0.008, bevel: 0.004 }));
  s.add(body, sideAt([[-0.075, 0.002], [0.12, 0.002], [0.12, -0.02], [0.10, -0.036], [-0.02, -0.036], [-0.06, -0.026]], 0.04, 0, { round: 0.006, bevel: 0.003 }));
  for (const sx of [1, -1]) {
    s.add(m.grip, gbox(-0.09, 0.0, 0.018, 0.05, 0.0012, sx * 0.0232));
    s.add(m.receiver, gbox(0.02, 0.15, 0.04, 0.056, 0.0012, sx * 0.0232));
  }
  s.add(m.dark, gbox(0.03, 0.085, 0.036, 0.056, 0.0008, 0.0234));
  s.add(body, sideAt([[-0.01, -0.03], [0.06, -0.03], [0.058, -0.064], [0.0, -0.068], [-0.018, -0.056]], 0.012, 0, { round: 0.005, bevel: 0.002, holes: [[[-0.004, -0.036], [0.052, -0.036], [0.05, -0.058], [0.0, -0.06]]] }));
  s.add(m.steel, sideAt([[0.012, -0.034], [0.02, -0.034], [0.022, -0.044], [0.018, -0.055], [0.014, -0.054], [0.016, -0.044]], 0.006, 0, { round: 0.002 }));
  pistolGrip(s, m, -0.006, -0.03, m.grip, 1.0);
  ventedShroud(s, m, 0.175, spec.shroudEnd, boreU, 0.022, body);
  barrel(s, m, 0.15, spec.shroudEnd + 0.03, boreU, 0.0085);
  const muzzleF = muzzle(s, m, spec.shroudEnd + 0.026, boreU, spec.muzzle, 0.0115);
  s.add(m.steel, gcyl(0.09, spec.shroudEnd - 0.01, 0.064, 0.0065, 14));
  s.add(m.steel, box(0.024, 0.006, 0.01, { p: [-0.014, 0.064, -(spec.shroudEnd - 0.03)] }));
  s.add(m.rubber, rbox(0.01, 0.012, 0.014, 0.003, 2, { p: [-0.028, 0.064, -(spec.shroudEnd - 0.03)] }));
  rail(s, m, -0.11, 0.165, 0.068);
  const gripF = Math.min(spec.shroudEnd - 0.065, 0.235);
  if (spec.vgrip) {
    s.add(m.grip, latheZ([[0.0001, 0], [0.014, 0], [0.015, 0.055], [0.012, 0.075], [0.0001, 0.077]], 20, { p: [0, 0.002, -gripF], r: [Math.PI / 2, 0, 0] }));
  } else {
    // hand stop
    s.add(m.grip, sideAt([[gripF - 0.02, 0.0], [gripF + 0.02, 0.0], [gripF + 0.018, -0.022], [gripF - 0.01, -0.016]], 0.018, 0, { round: 0.004, bevel: 0.002 }));
  }
  rail(s, m, gripF - 0.035, gripF + 0.035, -0.0005, 0.009);
  // stocks meet the receiver end plate (-0.135); adjustable stocks ride a short buffer tube
  if (spec.stock === 'adjustable') bufferTube(s, m, -0.3, -0.13, 0.034);
  const stockRear = spec.stock === 'skeleton' ? -0.272 : spec.stock === 'adjustable' ? -0.32 : -0.33;
  const rearF = stock(s, m, stockRear, 0.032, spec.stock, spec.stock === 'wire' ? m.steel : body);
  s.add(m.steel, gbox(-0.15, -0.125, 0.0, 0.06, 0.02));
  if (spec.stock === 'skeleton') {
    // folding hinge
    s.add(m.steel, gcyl(-0.14, -0.118, 0.032, 0.008, 12));
    s.add(m.steel, cylX(0.006, 0.05, 12, { p: [0, 0.032, 0.128] }));
  }
  screws(s, m, [[-0.1, 0.06], [0.14, 0.012], [-0.04, -0.02]], 0.0235);
  const opt = optic(s, m, lib, spec.optic, 0.0, 0.0745, spec.reticle ?? 0xff3a1a);
  const mag = magazine(m, spec.mag, 0.072, -0.03, { len: spec.magLen ?? 0.16, depth: spec.mag === 'drum' ? 0.04 : 0.034, w: 0.02, mat: m.furniture });
  if (spec.mag === 'straight') mag.rotation.x = -0.12;
  const boltS = new PartSink();
  boltS.add(m.steel, gbox(0.035, 0.08, 0.04, 0.054, 0.004, 0.019));
  const bolt = boltS.build('bolt');
  return finish(spec.id, ctx, {
    mag,
    bolt,
    boltTravel: new THREE.Vector3(0, 0, 0.035),
    muzzleF,
    boreU,
    eject: v(0.03, 0.045, 0.06),
    opt,
    gripR: v(0, -0.07, -0.045),
    gripL: spec.vgrip ? v(0, -0.05, gripF) : v(0, -0.01, gripF + 0.04),
    leftHand: spec.vgrip ? 'vgrip' : 'handguard',
    rearF,
  });
}

// ======================================================================= PISTOLS

interface PistolSpec {
  id: string;
  extended?: boolean;
  comp?: boolean;
  slideLen?: number;
}

function buildPistol(lib: MaterialLibrary, spec: PistolSpec): WeaponModel {
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
  let muzzleF = 0.107;
  if (spec.comp) {
    // compensator block with ports
    s.add(m.steel, sideAt([[0.104, 0.012], [0.15, 0.012], [0.15, 0.04], [0.104, 0.04]], 0.026, 0, { round: 0.003, bevel: 0.0015 }));
    s.add(m.dark, gbox(0.115, 0.14, 0.039, 0.0405, 0.004));
    s.add(m.dark, gbox(0.118, 0.124, 0.02, 0.034, 0.0006, 0.0131));
    s.add(m.dark, gbox(0.13, 0.136, 0.02, 0.034, 0.0006, 0.0131));
    muzzleF = 0.15;
    // folding front grip under the dust cover
    s.add(m.grip, sideAt([[0.06, -0.014], [0.085, -0.014], [0.08, -0.07], [0.064, -0.07]], 0.016, 0, { round: 0.004, bevel: 0.002 }));
  }
  const mag = magazine(m, 'pistol', -0.02, -0.004, { len: spec.extended ? 0.17 : 0.1, depth: 0.034, w: 0.022, mat: m.steel });
  mag.rotation.x = 0.31;
  const opt: OpticResult = { sightU: 0.0485, eyeF: -0.24, extras: [], zoom: 1 };
  return finish(spec.id, ctx, {
    mag,
    bolt: slide,
    boltTravel: new THREE.Vector3(0, 0, 0.032),
    muzzleF,
    boreU,
    eject: v(0.018, 0.04, 0.02),
    opt,
    gripR: v(0, -0.05, -0.04),
    gripL: spec.comp ? v(0, -0.045, 0.072) : v(-0.012, -0.06, -0.035),
    leftHand: spec.comp ? 'vgrip' : 'pistol',
    rearF: -0.084,
  });
}

// ======================================================================= REVOLVER

function buildRevolver(lib: MaterialLibrary): WeaponModel {
  const m = gunMats(lib);
  const s = new PartSink();
  const ctx = { lib, m, s };
  const boreU = 0.03;
  // frame
  s.add(m.steel, sideAt([[-0.06, 0.004], [0.032, 0.004], [0.034, 0.05], [-0.02, 0.054], [-0.05, 0.05], [-0.064, 0.03]], 0.03, 0, { round: 0.004, bevel: 0.002, holes: [[[-0.012, 0.012], [0.028, 0.012], [0.028, 0.046], [-0.012, 0.046]]] }));
  // barrel + top rib + ejector shroud
  s.add(m.steel, gcyl(0.03, 0.17, boreU, 0.0085, 18));
  s.add(m.steel, gbox(0.03, 0.17, boreU + 0.004, boreU + 0.014, 0.006));
  s.add(m.steel, sideAt([[0.03, boreU - 0.008], [0.17, boreU - 0.008], [0.17, boreU - 0.02], [0.035, boreU - 0.024]], 0.016, 0, { round: 0.004, bevel: 0.0015 }));
  s.add(m.dark, gcyl(0.169, 0.1705, boreU, 0.0045, 12));
  // front sight blade (tritium) + rear notch
  s.add(m.steel, sideAt([[0.155, boreU + 0.014], [0.166, boreU + 0.014], [0.166, boreU + 0.024], [0.158, boreU + 0.024]], 0.004, 0, { round: 0.001 }));
  s.add(m.tritium, gcyl(0.16, 0.163, boreU + 0.021, 0.0012, 8));
  s.add(m.steel, gbox(-0.045, -0.035, 0.054, 0.06, 0.008));
  // trigger guard + trigger + hammer
  s.add(m.steel, sideAt([[-0.012, 0.0], [0.03, 0.0], [0.028, -0.022], [-0.004, -0.028], [-0.016, -0.018]], 0.009, 0, { round: 0.004, bevel: 0.0015, holes: [[[-0.006, -0.004], [0.024, -0.004], [0.022, -0.018], [-0.002, -0.022]]] }));
  s.add(m.steel, sideAt([[0.004, 0.0], [0.01, 0.0], [0.012, -0.012], [0.006, -0.02]], 0.005, 0, { round: 0.002 }));
  s.add(m.steel, sideAt([[-0.064, 0.04], [-0.05, 0.044], [-0.062, 0.066], [-0.072, 0.062]], 0.008, 0, { round: 0.002, bevel: 0.001 }));
  // wooden grip
  s.add(m.wood, sideAt([[-0.06, 0.006], [-0.024, 0.004], [-0.032, -0.03], [-0.048, -0.086], [-0.082, -0.09], [-0.078, -0.04], [-0.07, 0.0]], 0.032, 0, { round: 0.01, bevel: 0.006 }));
  s.add(m.steel, cylX(0.004, 0.034, 10, { p: [0, -0.03, 0.06] }));
  // cylinder (rotates on fire, swings out on reload)
  const cs = new PartSink();
  // local frame: axis along Z, spanning F -0.02..0.02 (rear face toward the shooter)
  cs.add(m.steel, glathe([[0.0001, 0], [0.017, 0], [0.019, 0.004], [0.019, 0.036], [0.017, 0.04], [0.0001, 0.04]], 24, -0.02, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 2;
    const cx = Math.cos(a) * 0.011;
    const cy = Math.sin(a) * 0.011;
    // chamber mouths on the front face, case heads peeking out the back
    cs.add(m.dark, gcyl(0.0195, 0.0205, cy, 0.0042, 10, cx));
    cs.add(m.brass, gcyl(-0.0208, -0.0196, cy, 0.0038, 10, cx));
    // flutes between chambers
    const fa = a + Math.PI / 6;
    cs.add(m.dark, box(0.003, 0.006, 0.026, { p: [Math.cos(fa) * 0.0185, Math.sin(fa) * 0.0185, 0.0], r: [0, 0, fa] }));
  }
  const cyl = cs.build('cylinder');
  cyl.position.set(0, boreU - 0.002, -0.008);
  const opt: OpticResult = { sightU: boreU + 0.022, eyeF: -0.26, extras: [], zoom: 1 };
  return finish('ironjaw', ctx, {
    mag: cyl,
    bolt: null,
    parts: { cylinder: cyl },
    muzzleF: 0.171,
    boreU,
    eject: v(0, 0.03, 0),
    opt,
    gripR: v(0, -0.04, -0.05),
    gripL: v(-0.012, -0.05, -0.045),
    leftHand: 'pistol',
    rearF: -0.08,
  });
}

// ======================================================================= SHOTGUNS

function buildShotgun(lib: MaterialLibrary, spec: { id: string; pump: boolean }): WeaponModel {
  const m = gunMats(lib, { woodFurniture: spec.pump });
  const s = new PartSink();
  const ctx = { lib, m, s };
  const boreU = 0.03;
  // receiver
  s.add(m.steel, sideAt([[-0.09, -0.012], [0.12, -0.012], [0.12, 0.05], [-0.07, 0.05], [-0.095, 0.035]], 0.034, 0, { round: 0.005, bevel: 0.002 }));
  s.add(m.dark, gbox(0.0, 0.07, 0.012, 0.04, 0.0006, 0.0172));
  s.add(m.steel, sideAt([[-0.01, -0.012], [0.06, -0.012], [0.058, -0.042], [0.0, -0.046], [-0.018, -0.034]], 0.012, 0, { round: 0.005, bevel: 0.002, holes: [[[-0.004, -0.018], [0.052, -0.018], [0.05, -0.036], [0.0, -0.038]]] }));
  s.add(m.steel, sideAt([[0.014, -0.014], [0.022, -0.014], [0.024, -0.026], [0.018, -0.036], [0.016, -0.026]], 0.006, 0, { round: 0.002 }));
  // barrel + magazine tube
  s.add(m.steel, gcyl(0.11, 0.58, boreU, 0.0115, 22));
  s.add(m.dark, gcyl(0.579, 0.5805, boreU, 0.008, 14));
  s.add(m.steel, gcyl(0.11, 0.5, boreU - 0.026, 0.0105, 18));
  s.add(m.steel, gcyl(0.49, 0.505, boreU - 0.026, 0.0125, 18));
  s.add(m.steel, gbox(0.5, 0.52, boreU - 0.03, boreU + 0.002, 0.008));
  s.add(m.brass, gcyl(0.574, 0.582, boreU + 0.013, 0.0025, 10));
  let muzzleF = 0.582;
  let mag: THREE.Group | null = null;
  let bolt: THREE.Group | null = null;
  let opt: OpticResult;
  let rearF: number;
  if (spec.pump) {
    // pump forend (animated) - wooden with grooves
    const ps = new PartSink();
    ps.add(m.wood, glathe([[0.0001, 0], [0.018, 0], [0.021, 0.01], [0.021, 0.15], [0.018, 0.16], [0.0001, 0.16]], 22, 0.27, boreU - 0.026));
    for (let i = 0; i < 7; i++) ps.add(m.dark, gcyl(0.3 + i * 0.016, 0.304 + i * 0.016, boreU - 0.026, 0.0212, 22));
    bolt = ps.build('pump');
    rearF = stock(s, m, -0.37, 0.028, 'wood', m.wood);
    s.add(m.wood, sideAt([[-0.06, -0.008], [-0.1, -0.02], [-0.14, -0.06], [-0.1, -0.075], [-0.045, -0.04]], 0.03, 0, { round: 0.01, bevel: 0.005 }));
    // ghost ring rear sight
    s.add(m.steel, sideAt([[-0.07, 0.05], [-0.05, 0.05], [-0.052, 0.068], [-0.068, 0.068]], 0.024, 0, { round: 0.002, holes: [[[-0.064, 0.056], [-0.056, 0.056], [-0.056, 0.064], [-0.064, 0.064]]] }));
    opt = { sightU: 0.06, eyeF: -0.22, extras: [], zoom: 1 };
    // shells on the side saddle
    for (let i = 0; i < 4; i++) {
      s.add(m.dark, gbox(-0.05 + i * 0.022, -0.032 + i * 0.022, 0.014, 0.046, 0.002, -0.0185));
      s.add(m.brass, cylX(0.0095, 0.012, 10, { p: [-0.022, 0.03, 0.039 - i * 0.022] }));
    }
  } else {
    // semi-auto: polymer furniture, box magazine, rail + reflex sight
    s.add(m.furniture, front([[-0.026, -0.04], [0.026, -0.04], [0.026, 0.012], [-0.026, 0.012]], 0.3, 0.13, { round: 0.008, bevel: 0.003 }));
    rail(s, m, -0.07, 0.12, 0.05);
    pistolGrip(s, m, -0.02, -0.014);
    bufferTube(s, m, -0.3, -0.09, 0.025);
    rearF = stock(s, m, -0.34, 0.025, 'adjustable', m.furniture);
    opt = optic(s, m, lib, 'reflex', -0.03, 0.0535, 0xff3a1a);
    mag = magazine(m, 'shells', 0.03, -0.012, { len: 0.12, depth: 0.07, w: 0.03, mat: m.furniture });
    muzzleF = muzzle(s, m, 0.575, boreU, 'brake', 0.0155);
  }
  return finish(spec.id, ctx, {
    mag,
    bolt,
    boltTravel: spec.pump ? new THREE.Vector3(0, 0, 0.09) : new THREE.Vector3(0, 0, 0.04),
    muzzleF,
    boreU,
    eject: v(0.02, 0.03, 0.03),
    opt,
    gripR: v(0, -0.055, spec.pump ? -0.08 : -0.06),
    gripL: v(0, boreU - 0.05, spec.pump ? 0.35 : 0.3),
    leftHand: spec.pump ? 'pump' : 'handguard',
    rearF,
  });
}

// ======================================================================= PRECISION RIFLE

function buildSniper(lib: MaterialLibrary): WeaponModel {
  const m = gunMats(lib);
  const s = new PartSink();
  const ctx = { lib, m, s };
  const boreU = 0.032;
  // chassis (aluminum) with lightening cuts
  s.add(m.receiver, sideAt([[-0.16, -0.01], [0.42, -0.01], [0.42, 0.02], [0.2, 0.024], [-0.12, 0.024], [-0.16, 0.01]], 0.05, 0, { round: 0.006, bevel: 0.003, holes: [[[0.24, -0.002], [0.38, -0.002], [0.38, 0.014], [0.24, 0.014]]] }));
  s.add(m.receiver, sideAt([[0.1, -0.036], [0.41, -0.036], [0.41, -0.01], [0.1, -0.01]], 0.046, 0, { round: 0.006, bevel: 0.003, holes: [[[0.14, -0.03], [0.2, -0.03], [0.2, -0.016], [0.14, -0.016]], [[0.24, -0.03], [0.3, -0.03], [0.3, -0.016], [0.24, -0.016]], [[0.34, -0.03], [0.39, -0.03], [0.39, -0.016], [0.34, -0.016]]] }));
  // round action
  s.add(m.steel, gcyl(-0.12, 0.13, boreU, 0.017, 24));
  s.add(m.dark, gbox(-0.03, 0.04, boreU - 0.004, boreU + 0.012, 0.0006, 0.0172));
  // fluted barrel
  s.add(m.steel, gcyl(0.13, 0.68, boreU, 0.0118, 24, 0, 0.0102));
  const flutes: Geo[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    flutes.push(box(0.003, 0.003, 0.3, { p: [Math.cos(a) * 0.0108, boreU + Math.sin(a) * 0.0108, -0.47], r: [0, 0, a] }));
  }
  s.add(m.dark, flutes);
  const muzzleF = muzzle(s, m, 0.675, boreU, 'brake', 0.016);
  // stock
  const rearF = stock(s, m, -0.42, boreU - 0.002, 'precision', m.furniture);
  s.add(m.receiver, gbox(-0.3, -0.15, boreU - 0.006, boreU + 0.006, 0.012));
  pistolGrip(s, m, -0.03, -0.012);
  s.add(m.steel, sideAt([[-0.01, -0.012], [0.05, -0.012], [0.048, -0.038], [0.0, -0.042], [-0.016, -0.03]], 0.012, 0, { round: 0.005, bevel: 0.002, holes: [[[-0.004, -0.017], [0.042, -0.017], [0.04, -0.033], [0.0, -0.035]]] }));
  rail(s, m, -0.11, 0.12, boreU + 0.017);
  // folded bipod
  s.add(m.steel, gbox(0.36, 0.4, -0.05, -0.036, 0.016));
  s.add(m.steel, box(0.008, 0.008, 0.18, { p: [0.012, -0.056, -0.29] }));
  s.add(m.steel, box(0.008, 0.008, 0.18, { p: [-0.012, -0.056, -0.29] }));
  const opt = optic(s, m, lib, 'scope', -0.06, boreU + 0.02);
  const mag = magazine(m, 'sniper', 0.02, -0.01, { len: 0.075, depth: 0.075, w: 0.03, mat: m.steel });
  // bolt handle (animated)
  const bs = new PartSink();
  bs.add(m.steel, gcyl(-0.11, -0.08, boreU, 0.0122, 14));
  bs.add(m.steel, box(0.05, 0.007, 0.007, { p: [0.03, boreU - 0.008, 0.095], r: [0, 0, -0.35] }));
  bs.add(m.steel, sphere(0.009, 10, 8, { p: [0.054, boreU - 0.017, 0.095] }));
  const bolt = bs.build('bolt');
  return finish('vigil', ctx, {
    mag,
    bolt,
    boltTravel: new THREE.Vector3(0, 0, 0.07),
    muzzleF,
    boreU,
    eject: v(0.025, boreU, 0.0),
    opt,
    gripR: v(0, -0.05, -0.07),
    gripL: v(0, -0.04, 0.3),
    leftHand: 'handguard',
    rearF,
  });
}

// ======================================================================= REGISTRY

type Builder = (lib: MaterialLibrary) => WeaponModel;

const BUILDERS: Record<string, Builder> = {
  halberd: (lib) => buildRifle(lib, { id: 'halberd', handguardEnd: 0.47, barrelEnd: 0.5, muzzle: 'brake', stock: 'adjustable', optic: 'holo', opticF: 0.0, mag: 'curved' }),
  talon: (lib) => buildRifle(lib, { id: 'talon', tan: true, handguardEnd: 0.41, barrelEnd: 0.45, muzzle: 'flash', stock: 'skeleton', optic: 'reflex', opticF: 0.01, mag: 'curved', vgrip: true }),
  cinder: (lib) => buildRifle(lib, { id: 'cinder', handguardEnd: 0.37, barrelEnd: 0.41, muzzle: 'comp', stock: 'adjustable', optic: 'holo', opticF: 0.0, mag: 'straight', magLen: 0.15, reticle: 0x3cff8a }),
  anvil: (lib) => buildRifle(lib, { id: 'anvil', handguardEnd: 0.5, barrelEnd: 0.58, muzzle: 'brake', stock: 'fixed', optic: 'lpvo', opticF: -0.03, mag: 'straight', magLen: 0.13, heavy: true }),
  lancet: (lib) => buildRifle(lib, { id: 'lancet', tan: true, handguardEnd: 0.52, barrelEnd: 0.66, muzzle: 'flash', stock: 'precision', optic: 'lpvo', opticF: -0.04, mag: 'straight', magLen: 0.11 }),
  bulwark: (lib) => buildRifle(lib, { id: 'bulwark', handguardEnd: 0.48, barrelEnd: 0.62, muzzle: 'flash', stock: 'fixed', optic: 'holo', opticF: -0.02, mag: 'box', heavy: true, bipod: true }),
  vigil: buildSniper,
  rook9: (lib) => buildSmg(lib, { id: 'rook9', shroudEnd: 0.3, optic: 'reflex', stock: 'wire', mag: 'straight', vgrip: true, muzzle: 'comp' }),
  kestrel: (lib) => buildSmg(lib, { id: 'kestrel', tan: true, shroudEnd: 0.27, optic: 'holo', stock: 'skeleton', mag: 'straight', magLen: 0.2, vgrip: false, muzzle: 'flash', reticle: 0xff5a1a }),
  riptide: (lib) => buildSmg(lib, { id: 'riptide', shroudEnd: 0.32, optic: 'reflex', stock: 'adjustable', mag: 'drum', vgrip: true, muzzle: 'comp', reticle: 0x3cff8a }),
  thresher: (lib) => buildShotgun(lib, { id: 'thresher', pump: true }),
  cyclone: (lib) => buildShotgun(lib, { id: 'cyclone', pump: false }),
  warden: (lib) => buildPistol(lib, { id: 'warden' }),
  wasp: (lib) => buildPistol(lib, { id: 'wasp', extended: true, comp: true }),
  ironjaw: buildRevolver,
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

void grbox;
