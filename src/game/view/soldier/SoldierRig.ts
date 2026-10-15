import * as THREE from 'three';

// Pose layer over a soldier skeleton loaded from GLB. Poses are written in the soldier's model
// space (character faces -Z, +X is its right, feet at the origin) as rotations relative to the
// bind pose, so code never depends on how the bones' local axes happen to be rolled. Each frame:
//   begin() -> setHips / rotate (FK, parents first) -> ik() for limbs -> aim() for hands/feet -> commit()

export const BONE_NAMES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'clavicle_L', 'upperArm_L', 'lowerArm_L', 'hand_L', 'fingers_L', 'thumb_L',
  'clavicle_R', 'upperArm_R', 'lowerArm_R', 'hand_R', 'fingers_R', 'thumb_R',
  'thigh_L', 'shin_L', 'foot_L', 'toe_L', 'thigh_R', 'shin_R', 'foot_R', 'toe_R',
] as const;
export type BoneName = (typeof BONE_NAMES)[number];

interface Joint {
  name: BoneName;
  bone: THREE.Bone;
  parent: Joint | null;
  /** Bind pose, local to the parent bone (or to the armature node for the hips). */
  restLocalP: THREE.Vector3;
  restLocalQ: THREE.Quaternion;
  /** Bind pose in model space. */
  restP: THREE.Vector3;
  restQ: THREE.Quaternion;
  /** Unit direction head -> first child head in model space (bone axis), and its length. */
  restDir: THREE.Vector3;
  length: number;
  /** Current pose in model space. */
  p: THREE.Vector3;
  q: THREE.Quaternion;
  set: boolean;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/** Rotation taking the frame (dirA, upA) onto (dirB, upB); both pairs need not be orthogonal. */
export function alignFrames(dirA: THREE.Vector3, upA: THREE.Vector3, dirB: THREE.Vector3, upB: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  const basis = (d: THREE.Vector3, u: THREE.Vector3, m: THREE.Matrix4) => {
    const x = d.clone().normalize();
    const y = u.clone().addScaledVector(x, -u.dot(x));
    if (y.lengthSq() < 1e-8) {
      // up was parallel to the direction: pick any perpendicular
      y.set(x.y, -x.x, 0);
      if (y.lengthSq() < 1e-8) y.set(0, x.z, -x.y);
    }
    y.normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    return m.makeBasis(x, y, z);
  };
  basis(dirB, upB, _m);
  basis(dirA, upA, _m2);
  _m.multiply(_m2.transpose());
  return out.setFromRotationMatrix(_m);
}

export class SoldierRig {
  readonly joints = new Map<BoneName, Joint>();
  private order: Joint[] = [];
  /** Armature node -> model space (static). */
  private armatureQ = new THREE.Quaternion();
  private armatureM = new THREE.Matrix4();
  private armatureInv = new THREE.Matrix4();

  constructor(readonly model: THREE.Object3D) {
    model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    const byName = new Map<string, THREE.Bone>();
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone);
    });
    for (const name of BONE_NAMES) {
      const bone = byName.get(name);
      if (!bone) throw new Error(`soldier skeleton is missing bone '${name}'`);
      const m = new THREE.Matrix4().multiplyMatrices(inv, bone.matrixWorld);
      const restP = new THREE.Vector3();
      const restQ = new THREE.Quaternion();
      m.decompose(restP, restQ, _v);
      const parentBone = bone.parent as THREE.Bone;
      const parent = parentBone && (parentBone as THREE.Bone).isBone ? this.joints.get(parentBone.name as BoneName) ?? null : null;
      const j: Joint = {
        name, bone, parent,
        restLocalP: bone.position.clone(), restLocalQ: bone.quaternion.clone(),
        restP, restQ, restDir: new THREE.Vector3(0, 1, 0), length: 0.1,
        p: restP.clone(), q: restQ.clone(), set: false,
      };
      this.joints.set(name, j);
      this.order.push(j);
    }
    // bone axes from each bone's first child (end bones keep their own local +Y, as Blender exports it)
    for (const j of this.order) {
      const child = this.order.find((c) => c.parent === j && !c.name.startsWith('thumb') && !c.name.startsWith('clavicle') && !c.name.startsWith('thigh'));
      if (child) {
        j.restDir.copy(child.restP).sub(j.restP);
        j.length = j.restDir.length();
        j.restDir.normalize();
      } else {
        j.restDir.set(0, 1, 0).applyQuaternion(j.restQ);
        j.length = 0.08;
      }
    }
    const hips = this.joints.get('hips')!;
    const arm = hips.bone.parent!;
    this.armatureM.multiplyMatrices(inv, arm.matrixWorld);
    this.armatureM.decompose(_v, this.armatureQ, _v2);
    this.armatureInv.copy(this.armatureM).invert();
  }

  j(name: BoneName): Joint {
    return this.joints.get(name)!;
  }

  /** Bind-pose position of a joint in model space. */
  rest(name: BoneName): THREE.Vector3 {
    return this.j(name).restP;
  }

  /** Starts a frame: everything back to the bind pose. */
  begin(): void {
    for (const j of this.order) {
      j.p.copy(j.restP);
      j.q.copy(j.restQ);
      j.set = false;
    }
  }

  /** Moves the hips (and so the whole body) and turns them by `delta` (model space). */
  setHips(pos: THREE.Vector3, delta: THREE.Quaternion): void {
    const h = this.j('hips');
    h.p.copy(pos);
    h.q.copy(delta).multiply(h.restQ);
    h.set = true;
  }

  /** Model-space rotation inherited from the parent (its delta from the bind pose). */
  private parentDelta(j: Joint, out: THREE.Quaternion): THREE.Quaternion {
    if (!j.parent) return out.identity();
    return out.copy(j.parent.q).multiply(_q2.copy(j.parent.restQ).invert());
  }

  /** Head position from the parent's current pose. */
  private follow(j: Joint): void {
    if (!j.parent) return;
    j.p.copy(j.restLocalP).applyQuaternion(j.parent.q).add(j.parent.p);
  }

  /** FK: the bone keeps its parent's motion and adds `delta` (model space, about its head). */
  rotate(name: BoneName, delta?: THREE.Quaternion): void {
    const j = this.j(name);
    this.follow(j);
    this.parentDelta(j, _q);
    if (delta) _q.premultiply(delta);
    j.q.copy(_q).multiply(j.restQ);
    j.set = true;
  }

  /** Points a bone along `dir` with its bend side toward `side` (both model space). */
  point(name: BoneName, dir: THREE.Vector3, side: THREE.Vector3, restSide: THREE.Vector3): void {
    const j = this.j(name);
    this.follow(j);
    alignFrames(j.restDir, restSide, dir, side, _q);
    j.q.copy(_q).multiply(j.restQ);
    j.set = true;
  }

  /** Sets a bone's absolute model orientation as `delta` applied to its bind orientation. */
  orient(name: BoneName, delta: THREE.Quaternion): void {
    const j = this.j(name);
    this.follow(j);
    j.q.copy(delta).multiply(j.restQ);
    j.set = true;
  }

  /** Current head position (model space) of a bone whose parent is already posed. */
  head(name: BoneName, out = new THREE.Vector3()): THREE.Vector3 {
    const j = this.j(name);
    if (!j.set) this.follow(j);
    return out.copy(j.p);
  }

  /** Current orientation delta from bind pose (model space). */
  delta(name: BoneName, out = new THREE.Quaternion()): THREE.Quaternion {
    const j = this.j(name);
    return out.copy(j.q).multiply(_q2.copy(j.restQ).invert());
  }

  /**
   * Two-bone IK (upper, lower) so the lower bone's tip reaches `target`, bending toward `pole`.
   * `restPole` is the bend direction in the bind pose (knees forward, elbows back).
   */
  ik(upper: BoneName, lower: BoneName, target: THREE.Vector3, pole: THREE.Vector3, restPole: THREE.Vector3): void {
    const U = this.j(upper);
    const L = this.j(lower);
    this.follow(U);
    const a = U.p;
    const l1 = U.length;
    const l2 = L.length;
    const toT = _v.copy(target).sub(a);
    let d = toT.length();
    d = THREE.MathUtils.clamp(d, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-4);
    const dir = toT.normalize();
    const side = _v2.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (side.lengthSq() < 1e-8) side.copy(restPole).addScaledVector(dir, -restPole.dot(dir));
    side.normalize();
    const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const mid = new THREE.Vector3().copy(a).addScaledVector(dir, l1 * cosA).addScaledVector(side, l1 * sinA);
    const end = new THREE.Vector3().copy(a).addScaledVector(dir, d);
    const u1 = mid.clone().sub(a).normalize();
    const u2 = end.sub(mid).normalize();
    // bend side at each segment: perpendicular to the segment, in the bend plane, toward the pole
    const s1 = side.clone().addScaledVector(u1, -side.dot(u1));
    const s2 = side.clone().addScaledVector(u2, -side.dot(u2)).negate();
    alignFrames(U.restDir, restPole, u1, s1, _q);
    U.q.copy(_q).multiply(U.restQ);
    U.set = true;
    L.p.copy(mid);
    const restPoleL = restPole.clone().negate();
    alignFrames(L.restDir, restPoleL, u2, s2, _q);
    L.q.copy(_q).multiply(L.restQ);
    L.set = true;
  }

  /** Writes the pose into the bones (local transforms). */
  commit(): void {
    for (const j of this.order) {
      if (!j.set) {
        // untouched bones keep their parent's motion
        this.follow(j);
        this.parentDelta(j, _q);
        j.q.copy(_q).multiply(j.restQ);
      }
      if (j.parent) {
        j.bone.quaternion.copy(_q.copy(j.parent.q).invert().multiply(j.q));
        j.bone.position.copy(j.restLocalP);
      } else {
        // hips: relative to the armature node
        j.bone.quaternion.copy(_q.copy(this.armatureQ).invert().multiply(j.q));
        j.bone.position.copy(j.p).applyMatrix4(this.armatureInv);
      }
    }
  }
}
