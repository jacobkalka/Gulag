import * as THREE from 'three';
import type { WeaponModel } from '@/assets/models/weapons';
import { clamp, damp } from '@/shared/math';
import { SoldierRig, alignFrames } from './SoldierRig';

// Procedural animation for the soldier skeleton, all in model space (body frame: faces -Z).
//
// Locomotion is a speed-synced gait: in stance a foot moves backward relative to the body at
// exactly the ground speed, so it stays planted in the world (no foot sliding by construction),
// and swings forward with a lift; legs reach the feet with two-bone IK. Walk, run and sprint differ
// in stride, duty factor, lift and lean; strafing and backpedaling come from the movement
// direction in the body frame (an 8-way blend for free). Crouch lowers the pelvis and the IK bends
// the knees; air tucks the legs; slides kick one leg forward. The upper body takes the aim pitch
// and twist across the spine, holds the weapon at the shoulder (raised to the eye in ADS, low and
// across the chest when sprinting), and both hands are solved onto the weapon's grips.
// State changes crossfade through damped weights.

export interface AnimInput {
  /** Planar velocity in the body frame (x right, z back), m/s. */
  vx: number;
  vz: number;
  speed: number;
  /** Aim pitch (up positive) and aim yaw relative to the body (left positive), radians. */
  pitch: number;
  twist: number;
  /** Turn rate of the body (rad/s), for leaning into turns. */
  turnRate: number;
  crouch: number;
  slide: boolean;
  grounded: boolean;
  ads: number;
  sprint: boolean;
  reloading: boolean;
  /** 0..1 progress of the current reload, for the hand motion. */
  reloadT: number;
}

const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** Hand frames in weapon space: wrist->knuckles direction and palm normal (from the old rig's grips). */
const GRIP = {
  pistolR: { dir: new THREE.Vector3(-0.35, 0.3, -1), palm: new THREE.Vector3(-1, -0.15, 0.1) },
  handguardL: { dir: new THREE.Vector3(0.85, 0.45, -0.55), palm: new THREE.Vector3(0.05, 1, 0.15) },
  vgripL: { dir: new THREE.Vector3(0.45, 0.15, -1), palm: new THREE.Vector3(1, 0, 0.1) },
  pistolSupportL: { dir: new THREE.Vector3(0.55, -0.25, -1), palm: new THREE.Vector3(1, -0.1, 0.2) },
};

const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export class SoldierAnimator {
  // gait state
  private phase = 0;
  private moveW = 0;
  private runW = 0;
  private sprintW = 0;
  private crouchW = 0;
  private airW = 0;
  private slideW = 0;
  private adsW = 0;
  private dirX = 0;
  private dirZ = -1;
  private landKick = 0;
  private wasGrounded = true;
  private recoil = 0;
  private flinch = 0;
  private flinchSide = 0;
  private flinchBack = 0;
  private t = 0;
  private lean = 0;
  // rest measurements
  private readonly pelvisY: number;
  private readonly ankleY: number;
  private readonly footLen: number;
  readonly weaponPos = new THREE.Vector3();
  readonly weaponQuat = new THREE.Quaternion();

  constructor(private rig: SoldierRig) {
    this.pelvisY = rig.rest('hips').y;
    const ankL = rig.rest('foot_L');
    const ankR = rig.rest('foot_R');
    this.ankleY = (ankL.y + ankR.y) / 2;
    this.footLen = rig.j('foot_L').length + rig.j('toe_L').length;
  }

  fire(): void {
    this.recoil = 1;
  }

  /** Hit reaction; `side` -1..1 (from the left / right), `back` 1 when hit from the front. */
  hit(side: number, back: number): void {
    this.flinch = 1;
    this.flinchSide = side;
    this.flinchBack = back;
  }

  update(a: AnimInput, weapon: WeaponModel | null, dt: number): void {
    const r = this.rig;
    r.begin();
    this.deathGrip = null;
    this.t += dt;
    // ---- crossfade weights
    const sp = a.speed;
    this.moveW = damp(this.moveW, smooth(0.15, 0.9, sp), 10, dt);
    this.runW = damp(this.runW, smooth(2.6, 4.6, sp), 8, dt);
    this.sprintW = damp(this.sprintW, a.sprint && sp > 3 ? 1 : 0, 8, dt);
    this.crouchW = damp(this.crouchW, a.slide ? 0 : a.crouch, 14, dt);
    this.slideW = damp(this.slideW, a.slide ? 1 : 0, 12, dt);
    this.airW = damp(this.airW, a.grounded ? 0 : 1, a.grounded ? 14 : 6, dt);
    this.adsW = damp(this.adsW, a.sprint ? 0 : a.ads, 16, dt);
    if (a.grounded && !this.wasGrounded) this.landKick = 1;
    this.wasGrounded = a.grounded;
    this.landKick = damp(this.landKick, 0, 7, dt);
    this.recoil = damp(this.recoil, 0, 16, dt);
    this.flinch = damp(this.flinch, 0, 6, dt);
    this.lean = damp(this.lean, clamp(a.turnRate * sp * 0.025, -0.25, 0.25), 6, dt);
    if (sp > 0.2) {
      const k = Math.min(1, dt * 10);
      this.dirX += (a.vx / sp - this.dirX) * k;
      this.dirZ += (a.vz / sp - this.dirZ) * k;
      const l = Math.hypot(this.dirX, this.dirZ) || 1;
      this.dirX /= l;
      this.dirZ /= l;
    }

    // ---- gait parameters (crouch walks take shorter, flatter steps)
    const crouch = this.crouchW;
    const cycle = THREE.MathUtils.lerp(THREE.MathUtils.lerp(1.45, 2.2, this.runW), 2.45, this.sprintW) * (1 - 0.3 * crouch);
    const duty = THREE.MathUtils.lerp(0.62, 0.36, this.runW);
    const lift = THREE.MathUtils.lerp(0.07, 0.17, this.runW) * (1 - 0.4 * crouch);
    if (a.grounded && !a.slide) this.phase = (this.phase + (sp / cycle) * dt) % 1;
    const stepLen = cycle * duty;

    // ---- pelvis
    const bob = (0.012 + 0.03 * this.runW) * this.moveW * (0.5 + 0.5 * Math.cos(this.phase * Math.PI * 4));
    const sway = 0.018 * this.moveW * (1 - this.runW) * Math.sin(this.phase * Math.PI * 2);
    let pelvisY = this.pelvisY - 0.36 * crouch - bob - 0.07 * this.landKick - 0.05 * this.runW;
    pelvisY = THREE.MathUtils.lerp(pelvisY, 0.42, this.slideW);
    const pelvis = new THREE.Vector3(sway, pelvisY + 0.06 * this.airW, 0.02 * this.slideW);
    const hipTurn = new THREE.Quaternion().setFromAxisAngle(Y, -0.12 * this.moveW * (1 - this.runW * 0.5) * Math.sin(this.phase * Math.PI * 2));
    r.setHips(pelvis, hipTurn);

    // ---- legs
    const restPoleKnee = new THREE.Vector3(0, 0, -1);
    for (const [side, ph, tag] of [[-1, this.phase, 'L'], [1, (this.phase + 0.5) % 1, 'R']] as const) {
      const hip = r.rest(side < 0 ? 'thigh_L' : 'thigh_R');
      const baseX = hip.x * (1 + 0.25 * crouch);
      let off: number;
      let up = 0;
      let roll: number;
      if (ph < duty) {
        const t = ph / duty;
        off = stepLen * (0.5 - t);
        // heel peels off late in stance, the toe stays down
        roll = smooth(0.62, 1, t) * 0.45 * this.moveW;
      } else {
        const t = (ph - duty) / (1 - duty);
        const e = t * t * (3 - 2 * t);
        off = stepLen * (-0.5 + e);
        up = lift * Math.sin(Math.PI * t);
        roll = (1 - smooth(0, 0.35, t)) * 0.4 * this.moveW - smooth(0.7, 1, t) * 0.15 * this.moveW;
      }
      off *= this.moveW;
      up *= this.moveW;
      const foot = new THREE.Vector3(baseX + this.dirX * off, this.ankleY + up, this.dirZ * off);
      // air: tuck the feet up under the body
      foot.y += this.airW * (side < 0 ? 0.28 : 0.18);
      foot.z += this.airW * (side < 0 ? -0.12 : 0.1);
      // slide: lead leg forward and out straight, trailing leg folded under
      if (this.slideW > 0.01) {
        const slideFoot = side < 0 ? new THREE.Vector3(baseX, 0.12, -0.75) : new THREE.Vector3(baseX + 0.06, 0.1, 0.05);
        foot.lerp(slideFoot, this.slideW);
      }
      // heel lift raises the ankle; the toe stays planted
      foot.y += Math.sin(roll) * this.footLen * 0.55;
      const pole = new THREE.Vector3(side * 0.25, 0, -1);
      r.ik(side < 0 ? 'thigh_L' : 'thigh_R', side < 0 ? 'shin_L' : 'shin_R', foot, pole, restPoleKnee);
      r.orient(tag === 'L' ? 'foot_L' : 'foot_R', tmpQ.setFromAxisAngle(X, -roll + 0.25 * this.slideW * (side < 0 ? -1 : 0)));
      r.rotate(tag === 'L' ? 'toe_L' : 'toe_R', tmpQ.setFromAxisAngle(X, roll * 0.8));
    }

    // ---- spine: aim pitch and twist spread over three bones, lean into sprint and turns
    const pitch = clamp(a.pitch, -1.2, 1.2);
    const twist = clamp(a.twist, -1.3, 1.3);
    const forward = -(0.06 * this.moveW + 0.22 * this.sprintW + 0.18 * crouch) + 0.35 * this.slideW;
    const breathe = 0.012 * Math.sin(this.t * 1.7) * (1 - this.moveW);
    const flinchQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.flinch * 0.22 * this.flinchBack, 0, -this.flinch * 0.18 * this.flinchSide));
    for (const [bone, k] of [['spine', 0.3], ['chest', 0.35], ['upperChest', 0.35]] as const) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * k * 0.7 + (forward + breathe) * (bone === 'spine' ? 1 : 0.3), twist * k * 0.8, -this.lean * k, 'YXZ'));
      if (bone === 'spine') q.multiply(flinchQ);
      r.rotate(bone, q);
    }
    // the head finishes the aim
    r.rotate('neck', tmpQ.setFromEuler(new THREE.Euler(pitch * 0.15 - forward * 0.3, twist * 0.1, 0, 'YXZ')));
    r.rotate('head', tmpQ.setFromEuler(new THREE.Euler(pitch * 0.15 - forward * 0.4, twist * 0.1, 0, 'YXZ')));
    r.rotate('clavicle_L');
    r.rotate('clavicle_R', tmpQ.setFromAxisAngle(Z, 0.06 * this.adsW));

    // ---- weapon: stock at the right shoulder, sights up to the eye in ADS
    const chestQ = r.delta('upperChest', new THREE.Quaternion());
    const aimQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, twist, 0, 'YXZ'));
    const eye = r.head('head').add(new THREE.Vector3(0.035, 0.085, -0.1).applyQuaternion(r.delta('head')));
    const shoulder = r.head('upperArm_R').add(new THREE.Vector3(-0.05, 0.0, -0.06).applyQuaternion(chestQ));
    if (weapon) {
      // hip: weapon pointed at the aim, stock in the shoulder pocket a little low
      const hipPos = shoulder.clone().add(new THREE.Vector3(-0.02, -0.05, -0.02).applyQuaternion(aimQ));
      const hipQ = aimQ.clone().multiply(tmpQ.setFromEuler(new THREE.Euler(-0.08, 0.04, 0)));
      // ADS: the weapon's eye point sits on the character's eye
      const adsQ = aimQ.clone();
      const adsPos = eye.clone().sub(weapon.eye.clone().applyQuaternion(adsQ));
      // sprint: muzzle down and across the body
      const sprintQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 0.75, 0.25, 'YXZ'));
      const sprintPos = r.head('upperChest').add(new THREE.Vector3(0.05, -0.12, -0.25));
      this.weaponPos.copy(hipPos).lerp(adsPos, this.adsW);
      this.weaponQuat.copy(hipQ).slerp(adsQ, this.adsW);
      this.weaponPos.lerp(sprintPos, this.sprintW);
      this.weaponQuat.slerp(sprintQ, this.sprintW);
      // reload: weapon rolls and drops a little, comes back up at the end
      const rl = a.reloading ? Math.sin(Math.PI * clamp(a.reloadT, 0, 1)) : 0;
      this.weaponQuat.multiply(tmpQ.setFromEuler(new THREE.Euler(0.25 * rl, 0, 0.5 * rl)));
      this.weaponPos.add(new THREE.Vector3(0, -0.08 * rl, 0.02 * rl));
      // recoil kick back along the barrel and up
      this.weaponPos.add(new THREE.Vector3(0, 0.01, 0.05).applyQuaternion(this.weaponQuat).multiplyScalar(this.recoil));
      this.weaponQuat.multiply(tmpQ.setFromAxisAngle(X, 0.08 * this.recoil));

      // ---- arms onto the grips
      const toModel = (p: THREE.Vector3) => p.clone().applyQuaternion(this.weaponQuat).add(this.weaponPos);
      const handFrame = (g: { dir: THREE.Vector3; palm: THREE.Vector3 }) => ({
        dir: g.dir.clone().normalize().applyQuaternion(this.weaponQuat),
        palm: g.palm.clone().normalize().applyQuaternion(this.weaponQuat),
      });
      const right = handFrame(GRIP.pistolR);
      const left = handFrame(weapon.leftHand === 'vgrip' ? GRIP.vgripL : weapon.leftHand === 'pistol' ? GRIP.pistolSupportL : GRIP.handguardL);
      let gripL = toModel(weapon.gripL);
      if (a.reloading && weapon.mag) {
        // support hand dips to the magazine and back
        const magPos = toModel(weapon.mag.position.clone().add(new THREE.Vector3(0, -0.12, 0)));
        const k = Math.sin(Math.PI * clamp(a.reloadT * 1.3 - 0.1, 0, 1));
        gripL = gripL.lerp(magPos, k);
      }
      this.solveArm('R', toModel(weapon.gripR), right.dir, right.palm, new THREE.Vector3(0.7, -1, 0.35));
      this.solveArm('L', gripL, left.dir, left.palm, new THREE.Vector3(-0.35, -1, 0.15));
    } else {
      r.rotate('upperArm_L');
      r.rotate('upperArm_R');
    }
  }

  /** Weapon pose relative to the right hand when the soldier died (it falls with the hand). */
  private deathGrip: THREE.Matrix4 | null = null;

  /**
   * Death crumple, `e` 0..1 eased progress: the knees give, the torso folds toward the fall and
   * the arms go limp; the view tips the whole body over. The weapon stays in the right hand.
   */
  updateDeath(e: number, fallDir: number, weapon: WeaponModel | null): void {
    const r = this.rig;
    if (!this.deathGrip) {
      const hand = new THREE.Matrix4().compose(r.head('hand_R'), r.delta('hand_R'), new THREE.Vector3(1, 1, 1));
      const wpn = new THREE.Matrix4().compose(this.weaponPos, this.weaponQuat, new THREE.Vector3(1, 1, 1));
      this.deathGrip = hand.invert().multiply(wpn);
    }
    r.begin();
    r.setHips(new THREE.Vector3(0, this.pelvisY - 0.32 * e, 0.06 * e * fallDir), tmpQ.setFromAxisAngle(X, -0.25 * e * fallDir));
    const restPoleKnee = new THREE.Vector3(0, 0, -1);
    for (const side of [-1, 1] as const) {
      const ank = r.rest(side < 0 ? 'foot_L' : 'foot_R');
      const foot = new THREE.Vector3(ank.x * (1 + 0.6 * e), this.ankleY, ank.z - 0.12 * e * side);
      r.ik(side < 0 ? 'thigh_L' : 'thigh_R', side < 0 ? 'shin_L' : 'shin_R', foot, new THREE.Vector3(side * 0.4, 0, -1), restPoleKnee);
      r.orient(side < 0 ? 'foot_L' : 'foot_R', tmpQ.identity());
    }
    r.rotate('spine', tmpQ.setFromAxisAngle(X, -0.4 * e * fallDir));
    r.rotate('chest', tmpQ.setFromAxisAngle(X, -0.25 * e * fallDir));
    r.rotate('upperChest');
    r.rotate('neck', tmpQ.setFromAxisAngle(X, -0.35 * e * fallDir));
    r.rotate('head', tmpQ.setFromAxisAngle(X, -0.3 * e * fallDir));
    for (const t of ['L', 'R'] as const) {
      const sg = t === 'L' ? 1 : -1;
      r.rotate(t === 'L' ? 'clavicle_L' : 'clavicle_R');
      r.rotate(t === 'L' ? 'upperArm_L' : 'upperArm_R', tmpQ.setFromEuler(new THREE.Euler(0.5 * e * fallDir, 0, -sg * 0.7 * e)));
      r.rotate(t === 'L' ? 'lowerArm_L' : 'lowerArm_R', tmpQ.setFromAxisAngle(X, 0.6 * e));
      r.rotate(t === 'L' ? 'hand_L' : 'hand_R');
    }
    if (weapon && this.deathGrip) {
      const hand = new THREE.Matrix4().compose(r.head('hand_R'), r.delta('hand_R'), new THREE.Vector3(1, 1, 1));
      hand.multiply(this.deathGrip).decompose(this.weaponPos, this.weaponQuat, new THREE.Vector3());
    }
  }

  /** Back to life (respawn): forget the death grip. */
  revive(): void {
    this.deathGrip = null;
  }

  /** Wrist placed so the palm sits on the grip, then upper/lower arm IK and the hand frame. */
  private solveArm(tag: 'L' | 'R', grip: THREE.Vector3, dir: THREE.Vector3, palm: THREE.Vector3, pole: THREE.Vector3): void {
    const r = this.rig;
    const hand = r.j(tag === 'L' ? 'hand_L' : 'hand_R');
    const wrist = grip.clone().addScaledVector(dir, -hand.length * 0.75).addScaledVector(palm, -0.02);
    r.rotate(tag === 'L' ? 'clavicle_L' : 'clavicle_R');
    r.ik(tag === 'L' ? 'upperArm_L' : 'upperArm_R', tag === 'L' ? 'lowerArm_L' : 'lowerArm_R', wrist, pole, new THREE.Vector3(0, 0, 1));
    // bind pose: hands hang straight down with palms facing the thighs
    const restPalm = new THREE.Vector3(tag === 'L' ? 1 : -1, 0, 0);
    r.point(tag === 'L' ? 'hand_L' : 'hand_R', dir, palm, restPalm);
    // fingers curl around the grip, thumb wraps over
    const curlAxis = new THREE.Vector3().crossVectors(palm, dir).normalize();
    const handQ = r.delta(tag === 'L' ? 'hand_L' : 'hand_R', tmpQ2);
    r.orient(tag === 'L' ? 'fingers_L' : 'fingers_R', new THREE.Quaternion().setFromAxisAngle(curlAxis, tag === 'L' ? 1.2 : -1.2).multiply(handQ));
    r.orient(tag === 'L' ? 'thumb_L' : 'thumb_R', new THREE.Quaternion().setFromAxisAngle(curlAxis, tag === 'L' ? 0.5 : -0.5).multiply(handQ));
    void alignFrames;
  }
}
