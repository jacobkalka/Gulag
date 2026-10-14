import * as THREE from 'three';
import type { MaterialLibrary } from '../materials';
import { box, capsule, cyl, cylX, rbox, side, sphere, torus, xf, type Geo, type P2 } from '../geometry/toolkit';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponModel } from './weapons';

// Armored operator built from rigid parts on a joint hierarchy (no skinning).
// Limbs extend along -Y from their joint in the rest pose. Faceless by design:
// balaclava + respirator + goggles + helmet.

export type Team = 0 | 1;

export interface CharacterMats {
  fabric: THREE.Material;
  armor: THREE.Material;
  leather: THREE.Material;
  rubber: THREE.Material;
  visor: THREE.Material;
  accent: THREE.Material;
  steel: THREE.Material;
  pouch: THREE.Material;
  dark: THREE.Material;
}

export function characterMats(lib: MaterialLibrary, team: Team): CharacterMats {
  return {
    fabric: lib.get(team === 0 ? 'fabricA' : 'fabricB'),
    armor: team === 0 ? lib.get('armor') : lib.tinted('armor', 0x8a96a8),
    leather: lib.get('leather'),
    rubber: lib.get('gunRubber'),
    visor: lib.get('visor'),
    accent: lib.get(team === 0 ? 'teamA' : 'teamB'),
    steel: lib.get('gunSteel'),
    pouch: team === 0 ? lib.tinted('armor', 0x6a6a60, 'pouchA') : lib.tinted('armor', 0x58606c, 'pouchB'),
    dark: lib.get('gunDark'),
  };
}

/** Collects part geometry per material, tagged with the bone that drives it (rigid skinning). */
class Sink {
  parts: { mat: THREE.Material; geo: Geo; bone: THREE.Bone }[] = [];
  private pending = new Map<THREE.Material, Geo[]>();
  add(m: THREE.Material, ...g: Geo[]): void {
    let l = this.pending.get(m);
    if (!l) this.pending.set(m, (l = []));
    l.push(...g);
  }
  into(bone: THREE.Bone, _name: string): void {
    for (const [mat, list] of this.pending) for (const geo of list) this.parts.push({ mat, geo, bone });
    this.pending.clear();
  }
}

export interface Rig {
  root: THREE.Group;
  hips: THREE.Bone;
  spine: THREE.Bone;
  chest: THREE.Bone;
  neck: THREE.Bone;
  head: THREE.Bone;
  shoulderL: THREE.Bone;
  elbowL: THREE.Bone;
  handL: THREE.Bone;
  shoulderR: THREE.Bone;
  elbowR: THREE.Bone;
  handR: THREE.Bone;
  hipL: THREE.Bone;
  kneeL: THREE.Bone;
  footL: THREE.Bone;
  hipR: THREE.Bone;
  kneeR: THREE.Bone;
  footR: THREE.Bone;
  meshes: THREE.SkinnedMesh[];
}

export const DIM = {
  hipsY: 0.98,
  spineLen: 0.13,
  chestLen: 0.24,
  neckLen: 0.09,
  upperArm: 0.3,
  foreArm: 0.27,
  thigh: 0.45,
  shin: 0.44,
  shoulderX: 0.2,
  hipX: 0.1,
};

function joint(name: string, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone {
  const g = new THREE.Bone();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

export function buildCharacter(lib: MaterialLibrary, team: Team): Rig {
  const m = characterMats(lib, team);
  const root = new THREE.Group();
  root.name = 'character';
  const hips = joint('hips', root, 0, DIM.hipsY, 0);
  const spine = joint('spine', hips, 0, 0.06, 0);
  const chest = joint('chest', spine, 0, DIM.spineLen, 0);
  const neck = joint('neck', chest, 0, DIM.chestLen, -0.01);
  const head = joint('head', neck, 0, DIM.neckLen, 0.01);
  const shoulderL = joint('shoulderL', chest, -DIM.shoulderX, DIM.chestLen - 0.06, 0);
  const elbowL = joint('elbowL', shoulderL, 0, -DIM.upperArm, 0);
  const handL = joint('handL', elbowL, 0, -DIM.foreArm, 0);
  const shoulderR = joint('shoulderR', chest, DIM.shoulderX, DIM.chestLen - 0.06, 0);
  const elbowR = joint('elbowR', shoulderR, 0, -DIM.upperArm, 0);
  const handR = joint('handR', elbowR, 0, -DIM.foreArm, 0);
  const hipL = joint('hipL', hips, -DIM.hipX, -0.04, 0);
  const kneeL = joint('kneeL', hipL, 0, -DIM.thigh, 0);
  const footL = joint('footL', kneeL, 0, -DIM.shin, 0);
  const hipR = joint('hipR', hips, DIM.hipX, -0.04, 0);
  const kneeR = joint('kneeR', hipR, 0, -DIM.thigh, 0);
  const footR = joint('footR', kneeR, 0, -DIM.shin, 0);
  const s = new Sink();

  // ---------------- pelvis: belt, pouches, groin
  s.add(m.fabric, rbox(0.32, 0.17, 0.2, 0.06, 3, { p: [0, -0.03, 0] }));
  s.add(m.leather, rbox(0.345, 0.05, 0.225, 0.02, 2, { p: [0, 0.03, 0] }));
  s.add(m.steel, rbox(0.06, 0.04, 0.012, 0.004, 1, { p: [0, 0.03, -0.116] }));
  for (const [x, z, w] of [[0.15, 0.04, 0.06], [-0.16, 0.0, 0.07], [0.1, 0.11, 0.08], [-0.08, 0.115, 0.07]] as const) {
    s.add(m.pouch, rbox(w, 0.08, 0.05, 0.012, 2, { p: [x, 0.0, z], r: [0, Math.atan2(x, z) * 0.0, 0] }));
  }
  s.add(m.armor, rbox(0.12, 0.1, 0.03, 0.02, 2, { p: [0, -0.07, -0.108], r: [0.15, 0, 0] }));
  s.into(hips, 'pelvis');

  // ---------------- abdomen
  s.add(m.fabric, rbox(0.29, 0.17, 0.19, 0.07, 3, { p: [0, 0.06, 0] }));
  s.add(m.armor, rbox(0.33, 0.075, 0.22, 0.025, 2, { p: [0, 0.1, 0] }));
  s.into(spine, 'abdomen');

  // ---------------- chest: torso, plate carrier, mag pouches, back pack
  s.add(m.fabric, rbox(0.4, 0.2, 0.23, 0.08, 3, { p: [0, 0.15, 0] }));
  s.add(m.fabric, rbox(0.33, 0.16, 0.21, 0.07, 3, { p: [0, 0.04, 0] }));
  s.add(m.armor, rbox(0.31, 0.28, 0.055, 0.03, 3, { p: [0, 0.1, -0.11] }));
  s.add(m.armor, rbox(0.31, 0.3, 0.055, 0.03, 3, { p: [0, 0.11, 0.11] }));
  s.add(m.armor, rbox(0.06, 0.2, 0.2, 0.025, 2, { p: [0.165, 0.06, 0] }));
  s.add(m.armor, rbox(0.06, 0.2, 0.2, 0.025, 2, { p: [-0.165, 0.06, 0] }));
  // shoulder straps
  s.add(m.armor, rbox(0.07, 0.03, 0.24, 0.012, 2, { p: [0.11, 0.24, 0] }));
  s.add(m.armor, rbox(0.07, 0.03, 0.24, 0.012, 2, { p: [-0.11, 0.24, 0] }));
  // triple mag pouch
  for (let i = 0; i < 3; i++) {
    const x = -0.085 + i * 0.085;
    s.add(m.pouch, rbox(0.075, 0.1, 0.045, 0.012, 2, { p: [x, 0.02, -0.15] }));
    s.add(m.pouch, rbox(0.077, 0.03, 0.05, 0.01, 2, { p: [x, 0.075, -0.152] }));
  }
  // radio pouch + antenna
  s.add(m.pouch, rbox(0.06, 0.12, 0.05, 0.014, 2, { p: [-0.14, 0.13, -0.12] }));
  s.add(m.dark, cyl(0.004, 0.004, 0.28, 6, { p: [-0.13, 0.4, 0.13], r: [0.15, 0, 0.1] }));
  // back pack
  s.add(m.pouch, rbox(0.24, 0.26, 0.09, 0.03, 3, { p: [0, 0.1, 0.165] }));
  s.add(m.pouch, rbox(0.2, 0.06, 0.1, 0.02, 2, { p: [0, 0.255, 0.165] }));
  // team ID strips (emissive) front & back
  s.add(m.accent, rbox(0.12, 0.018, 0.006, 0.004, 1, { p: [0, 0.2, -0.131] }));
  s.add(m.accent, rbox(0.16, 0.02, 0.006, 0.004, 1, { p: [0, 0.24, 0.212] }));
  // collar
  s.add(m.fabric, torus(0.075, 0.03, 8, 16, Math.PI * 2, { p: [0, 0.255, 0], r: [Math.PI / 2, 0, 0] }));
  s.into(chest, 'chest');

  // ---------------- neck
  s.add(m.fabric, cyl(0.058, 0.064, 0.09, 12, { p: [0, 0.035, 0] }));
  s.into(neck, 'neck');

  // ---------------- head: balaclava, respirator, goggles, helmet
  s.add(m.fabric, sphere(0.1, 20, 14, { p: [0, 0.08, 0], s: [0.92, 1.08, 1.0] }));
  // respirator
  s.add(m.armor, rbox(0.1, 0.07, 0.07, 0.03, 3, { p: [0, 0.035, -0.08] }));
  s.add(m.dark, cyl(0.022, 0.022, 0.03, 12, { p: [0.05, 0.03, -0.1], r: [Math.PI / 2, 0, -0.6] }));
  s.add(m.dark, cyl(0.022, 0.022, 0.03, 12, { p: [-0.05, 0.03, -0.1], r: [Math.PI / 2, 0, 0.6] }));
  // goggles band
  s.add(m.visor, rbox(0.17, 0.05, 0.05, 0.022, 3, { p: [0, 0.11, -0.072] }));
  s.add(m.rubber, torus(0.1, 0.008, 6, 24, Math.PI * 2, { p: [0, 0.11, 0.0], r: [Math.PI / 2, 0, 0], s: [1.0, 1.05, 1] }));
  // helmet shell
  s.add(m.armor, sphere(0.128, 24, 14, { p: [0, 0.115, 0.008], s: [0.98, 0.92, 1.05] }, 0, Math.PI * 2, 0, Math.PI * 0.52));
  s.add(m.armor, rbox(0.26, 0.012, 0.29, 0.006, 2, { p: [0, 0.112, 0.01] }));
  // side rails + NVG shroud
  s.add(m.dark, rbox(0.012, 0.03, 0.12, 0.004, 1, { p: [0.124, 0.135, 0.005] }));
  s.add(m.dark, rbox(0.012, 0.03, 0.12, 0.004, 1, { p: [-0.124, 0.135, 0.005] }));
  s.add(m.dark, rbox(0.045, 0.03, 0.02, 0.006, 1, { p: [0, 0.18, -0.118] }));
  // team stripe on helmet top + IR strobe
  s.add(m.accent, rbox(0.03, 0.006, 0.18, 0.003, 1, { p: [0, 0.243, 0.02] }));
  s.add(m.accent, rbox(0.022, 0.016, 0.03, 0.005, 1, { p: [0, 0.23, 0.11] }));
  s.into(head, 'head');

  // ---------------- arms
  for (const [sh, el, ha, sx] of [[shoulderL, elbowL, handL, -1], [shoulderR, elbowR, handR, 1]] as const) {
    s.add(m.fabric, capsule(0.064, 0.19, 4, 12, { p: [0, -0.15, 0] }));
    s.add(m.armor, sphere(0.085, 14, 10, { p: [sx * 0.012, -0.03, 0], s: [1, 0.85, 1.1] }, 0, Math.PI * 2, 0, Math.PI * 0.55));
    s.add(m.accent, cyl(0.062, 0.062, 0.022, 14, { p: [0, -0.12, 0] }));
    s.into(sh, sx < 0 ? 'upperArmL' : 'upperArmR');
    s.add(m.fabric, capsule(0.054, 0.17, 4, 12, { p: [0, -0.13, 0] }));
    s.add(m.fabric, torus(0.054, 0.016, 6, 14, Math.PI * 2, { p: [0, -0.06, 0], r: [Math.PI / 2, 0, 0] }));
    s.add(m.armor, rbox(0.075, 0.07, 0.07, 0.03, 2, { p: [0, -0.01, 0.03] }));
    s.add(m.leather, cyl(0.05, 0.046, 0.06, 12, { p: [0, -0.245, 0] }));
    s.into(el, sx < 0 ? 'forearmL' : 'forearmR');
    // gloved hand: palm, fingers wrapped (grip pose), thumb
    s.add(m.leather, rbox(0.085, 0.1, 0.035, 0.015, 2, { p: [0, -0.05, 0] }));
    s.add(m.leather, rbox(0.085, 0.045, 0.04, 0.018, 2, { p: [0, -0.1, -0.022], r: [0.9, 0, 0] }));
    s.add(m.leather, capsule(0.013, 0.04, 3, 8, { p: [-sx * 0.045, -0.06, -0.02], r: [0.6, 0, sx * 0.5] }));
    s.add(m.armor, rbox(0.07, 0.03, 0.012, 0.006, 1, { p: [0, -0.04, 0.02] }));
    s.into(ha, sx < 0 ? 'handL' : 'handR');
  }

  // ---------------- legs
  for (const [hp, kn, ft, sx] of [[hipL, kneeL, footL, -1], [hipR, kneeR, footR, 1]] as const) {
    s.add(m.fabric, capsule(0.1, 0.16, 4, 14, { p: [0, -0.13, 0] }));
    s.add(m.fabric, capsule(0.088, 0.2, 4, 14, { p: [0, -0.28, 0] }));
    if (sx > 0) {
      // drop-leg holster with a pistol grip sticking out
      s.add(m.pouch, rbox(0.04, 0.17, 0.11, 0.015, 2, { p: [0.09, -0.22, 0.0] }));
      s.add(m.dark, rbox(0.03, 0.08, 0.04, 0.008, 1, { p: [0.09, -0.12, 0.02], r: [0.3, 0, 0] }));
      s.add(m.leather, cyl(0.088, 0.088, 0.03, 14, { p: [0, -0.28, 0] }));
    } else {
      s.add(m.pouch, rbox(0.04, 0.13, 0.1, 0.02, 2, { p: [-0.095, -0.24, 0.0] }));
    }
    s.into(hp, sx < 0 ? 'thighL' : 'thighR');
    s.add(m.fabric, capsule(0.076, 0.18, 4, 12, { p: [0, -0.14, 0] }));
    s.add(m.fabric, capsule(0.066, 0.16, 4, 12, { p: [0, -0.27, 0] }));
    s.add(m.armor, rbox(0.115, 0.15, 0.07, 0.032, 3, { p: [0, -0.02, -0.07] }));
    s.into(kn, sx < 0 ? 'shinL' : 'shinR');
    // boot
    const bootP: P2[] = [[-0.05, 0.02], [0.03, 0.02], [0.05, -0.02], [0.17, -0.045], [0.18, -0.07], [0.17, -0.085], [-0.06, -0.085], [-0.065, -0.04]];
    const boot = side(bootP, 0.105, { round: 0.02, bevel: 0.012 });
    s.add(m.leather, boot);
    s.add(m.rubber, side([[-0.068, -0.075], [0.178, -0.075], [0.18, -0.095], [-0.07, -0.095]], 0.112, { round: 0.008, bevel: 0.004 }));
    s.add(m.fabric, cyl(0.068, 0.07, 0.08, 12, { p: [0, 0.02, 0] }));
    s.into(ft, sx < 0 ? 'footL' : 'footR');
  }

  // ---------------- bind: bake parts into rest-pose model space, one SkinnedMesh per material
  const bones = [hips, spine, chest, neck, head, shoulderL, elbowL, handL, shoulderR, elbowR, handR, hipL, kneeL, footL, hipR, kneeR, footR];
  root.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, Geo[]>();
  for (const part of s.parts) {
    const g = part.geo;
    g.applyMatrix4(part.bone.matrixWorld);
    const n = g.getAttribute('position').count;
    const bi = bones.indexOf(part.bone);
    const idx = new Uint16Array(n * 4);
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      idx[i * 4] = bi;
      w[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    let l = byMat.get(part.mat);
    if (!l) byMat.set(part.mat, (l = []));
    l.push(g);
  }
  const skeleton = new THREE.Skeleton(bones);
  const meshes: THREE.SkinnedMesh[] = [];
  for (const [mat, list] of byMat) {
    const merged = mergeGeometries(list, false)!;
    for (const g of list) g.dispose();
    const mesh = new THREE.SkinnedMesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.bind(skeleton);
    root.add(mesh);
    meshes.push(mesh);
  }
  return { root, hips, spine, chest, neck, head, shoulderL, elbowL, handL, shoulderR, elbowR, handR, hipL, kneeL, footL, hipR, kneeR, footR, meshes };
}

// ------------------------------------------------------------------ IK helpers

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

/** Orients `bone` so its local -Y axis points along world direction `dir`, with local -Z facing `fwdHint`. */
export function aimBone(bone: THREE.Object3D, dir: THREE.Vector3, fwdHint: THREE.Vector3): void {
  _y.copy(dir).normalize().negate(); // local +Y = -dir
  _z.copy(fwdHint).negate();
  _x.crossVectors(_y, _z).normalize();
  if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  _q.setFromRotationMatrix(_m);
  bone.parent!.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(_q));
}

/**
 * Two-bone IK: places shoulder→elbow→hand so the hand reaches `target` (world), elbow bending toward `pole`.
 * Afterwards orients the hand to `handQuat` (world) if provided.
 */
export function solveArm(
  shoulder: THREE.Object3D,
  elbow: THREE.Object3D,
  hand: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  lenA = DIM.upperArm,
  lenB = DIM.foreArm,
  handQuat?: THREE.Quaternion,
): void {
  shoulder.updateWorldMatrix(true, false);
  const S = _a.setFromMatrixPosition(shoulder.matrixWorld);
  const toT = _b.copy(target).sub(S);
  let dist = toT.length();
  dist = Math.min(dist, (lenA + lenB) * 0.999);
  dist = Math.max(dist, Math.abs(lenA - lenB) + 1e-3);
  const dirT = toT.normalize();
  // angle at the shoulder between dirT and the upper arm
  const cosA = (lenA * lenA + dist * dist - lenB * lenB) / (2 * lenA * dist);
  const angA = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
  // bend plane: contains dirT and the pole direction
  const poleDir = _c.copy(pole).sub(S);
  const bendAxis = _d.crossVectors(dirT, poleDir).normalize();
  if (bendAxis.lengthSq() < 1e-6) bendAxis.set(1, 0, 0);
  const upperDir = dirT.clone().applyAxisAngle(bendAxis, -angA);
  // Elbow pointing direction hint: toward the pole
  const fwdHint = poleDir.clone().normalize();
  aimBone(shoulder, upperDir, fwdHint);
  shoulder.updateWorldMatrix(false, true);
  const E = new THREE.Vector3().setFromMatrixPosition(elbow.matrixWorld);
  const lowerDir = target.clone().sub(E).normalize();
  aimBone(elbow, lowerDir, fwdHint);
  elbow.updateWorldMatrix(false, true);
  if (handQuat) {
    hand.parent!.getWorldQuaternion(_pq);
    hand.quaternion.copy(_pq.invert().multiply(handQuat));
  }
}

/**
 * Hand orientation in weapon space from where the fingers point (wrist→knuckles) and which way
 * the palm faces. Hand meshes extend along local -Y from the wrist with the palm on local -Z.
 */
export function handQuatWeapon(finger: THREE.Vector3, palm: THREE.Vector3): THREE.Quaternion {
  const y = finger.clone().normalize().negate();
  let z = palm.clone().normalize().negate();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Standard grips (weapon space: -Z forward, +X right, +Y up). */
export const GRIPS = {
  // right hand around a pistol grip: knuckles point forward-left-up, palm faces left
  pistolR: handQuatWeapon(new THREE.Vector3(-0.35, 0.3, -1), new THREE.Vector3(-1, -0.15, 0.1)),
  // left hand under a handguard: knuckles point right-forward-up, palm faces up
  handguardL: handQuatWeapon(new THREE.Vector3(0.85, 0.45, -0.55), new THREE.Vector3(0.05, 1, 0.15)),
  // left hand around a vertical foregrip: knuckles forward-right, palm faces right
  vgripL: handQuatWeapon(new THREE.Vector3(0.45, 0.15, -1), new THREE.Vector3(1, 0, 0.1)),
  // support hand cupping a pistol grip from the left
  pistolSupportL: handQuatWeapon(new THREE.Vector3(0.55, -0.25, -1), new THREE.Vector3(1, -0.1, 0.2)),
};

export function leftGrip(style: string): THREE.Quaternion {
  return style === 'vgrip' ? GRIPS.vgripL : style === 'pistol' ? GRIPS.pistolSupportL : GRIPS.handguardL;
}

/** World-space wrist target: grip point moved back along the finger axis and off the grip surface. */
export function wristTarget(grip: THREE.Vector3, handWorld: THREE.Quaternion, reach = 0.065, standoff = 0.018): THREE.Vector3 {
  const fingerDir = new THREE.Vector3(0, -1, 0).applyQuaternion(handWorld);
  const palmDir = new THREE.Vector3(0, 0, -1).applyQuaternion(handWorld);
  return grip.clone().addScaledVector(fingerDir, -reach).addScaledVector(palmDir, -standoff);
}

/**
 * Attaches a weapon to the character in an aiming pose and solves both arms onto it.
 * `aimPitch` tilts the weapon; the weapon is mounted relative to the chest.
 */
export function poseWithWeapon(rig: Rig, weapon: WeaponModel, aimPitch: number, mount: THREE.Object3D, aimYaw = 0): void {
  // Weapon mount lives under the chest: stock at the right shoulder pocket.
  mount.position.set(0.12, 0.14, -0.24);
  mount.rotation.set(aimPitch, aimYaw, 0, 'YXZ');
  if (weapon.root.parent !== mount) mount.add(weapon.root);
  weapon.root.position.set(0, 0, 0);
  rig.root.updateMatrixWorld(true);
  const gripR = weapon.gripR.clone().applyMatrix4(weapon.root.matrixWorld);
  const gripL = weapon.gripL.clone().applyMatrix4(weapon.root.matrixWorld);
  const wq = new THREE.Quaternion();
  weapon.root.getWorldQuaternion(wq);
  const handR = wq.clone().multiply(GRIPS.pistolR);
  const handL = wq.clone().multiply(leftGrip(weapon.leftHand));
  const chestPos = new THREE.Vector3().setFromMatrixPosition(rig.chest.matrixWorld);
  const down = new THREE.Vector3(0, -1, 0);
  const poleR = chestPos.clone().add(new THREE.Vector3(0.6, -0.5, 0.2).applyQuaternion(rig.root.quaternion)).add(down);
  const poleL = chestPos.clone().add(new THREE.Vector3(-0.6, -0.6, -0.2).applyQuaternion(rig.root.quaternion)).add(down);
  solveArm(rig.shoulderR, rig.elbowR, rig.handR, wristTarget(gripR, handR), poleR, DIM.upperArm, DIM.foreArm, handR);
  solveArm(rig.shoulderL, rig.elbowL, rig.handL, wristTarget(gripL, handL), poleL, DIM.upperArm, DIM.foreArm, handL);
}

void box;
void cylX;
void xf;
