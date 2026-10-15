import * as THREE from 'three';

// Two-bone arm IK and the standard weapon grips, used by the first-person viewmodel (the third-person
// soldiers have their own rig in game/view/soldier).

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
  lenA = 0.3,
  lenB = 0.27,
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
