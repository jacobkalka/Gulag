import * as THREE from 'three';
import type { MaterialLibrary } from '@/assets/materials';
import { buildCharacter, poseWithWeapon, type Rig } from '@/assets/models/character';
import { buildWeapon, type WeaponModel } from '@/assets/models/weapons';
import { getWeapon } from '@/data/weapons';
import { angleDiff, clamp, damp, dampAngle } from '@/shared/math';

// Procedural animation for remote players (and the local player's body in spectator cams).

export interface RenderPlayer {
  id: number;
  team: 0 | 1;
  name: string;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  pitch: number;
  crouch: number;
  slide: boolean;
  grounded: boolean;
  ads: number;
  sprint: boolean;
  weapon: string;
  reloading: boolean;
  hp: number;
  /** Direction (yaw) the killing shot came from, for the death fall. */
  deathYaw: number;
}

export class CharacterView {
  readonly rig: Rig;
  readonly root: THREE.Group;
  private mount = new THREE.Group();
  private weapon: WeaponModel | null = null;
  private weaponId = '';
  private bodyYaw = 0;
  private phase = 0;
  private speedS = 0;
  private flinch = 0;
  private flinchSide = 0;
  private recoil = 0;
  private deadT = -1;
  private fallDir = 1;
  team: 0 | 1;
  visible = true;

  constructor(private lib: MaterialLibrary, team: 0 | 1) {
    this.team = team;
    this.rig = buildCharacter(lib, team);
    this.root = this.rig.root;
    this.rig.chest.add(this.mount);
  }

  setWeapon(id: string): void {
    const model = getWeapon(id).model;
    if (model === this.weaponId) return;
    if (this.weapon) this.mount.remove(this.weapon.root);
    this.weapon = buildWeapon(this.lib, model);
    this.weaponId = model;
  }

  hit(fromYaw: number): void {
    this.flinch = 1;
    this.flinchSide = Math.sin(angleDiff(this.bodyYaw, fromYaw));
  }

  fire(): void {
    this.recoil = 1;
  }

  update(p: RenderPlayer, dt: number): void {
    const r = this.rig;
    this.root.position.set(p.x, p.y, p.z);
    if (!p.alive) {
      this.animateDeath(p, dt);
      return;
    }
    if (this.deadT >= 0) {
      // respawned
      this.deadT = -1;
      this.root.rotation.set(0, 0, 0);
      this.bodyYaw = p.yaw;
    }
    this.setWeapon(p.weapon);
    const speed = Math.hypot(p.vx, p.vz);
    this.speedS = damp(this.speedS, speed, 10, dt);
    // body turns toward the aim when the twist gets large or when moving
    const twist = angleDiff(this.bodyYaw, p.yaw);
    if (Math.abs(twist) > 0.9 || speed > 0.5) this.bodyYaw = dampAngle(this.bodyYaw, p.yaw, speed > 0.5 ? 8 : 4, dt);
    this.root.rotation.set(0, this.bodyYaw, 0);
    const twistNow = angleDiff(this.bodyYaw, p.yaw);

    // movement direction in body space
    const fx = -Math.sin(this.bodyYaw);
    const fz = -Math.cos(this.bodyYaw);
    const rx = Math.cos(this.bodyYaw);
    const rz = -Math.sin(this.bodyYaw);
    const lf = speed > 0.1 ? (p.vx * fx + p.vz * fz) / speed : 0;
    const ls = speed > 0.1 ? (p.vx * rx + p.vz * rz) / speed : 0;
    const stride = p.sprint ? 1.9 : 1.35;
    this.phase += (this.speedS / stride) * Math.PI * dt * (p.grounded ? 1 : 0.2);
    const moveAmt = clamp(this.speedS / 4.5, 0, 1.3);
    const c = p.slide ? 1 : p.crouch;

    // ---- legs
    const swing = Math.sin(this.phase) * 0.55 * moveAmt;
    const lift = (s: number) => Math.max(0, s) * 0.9 * moveAmt;
    const crouchHip = -1.05 * c;
    const crouchKnee = 1.9 * c;
    r.hips.position.y = 0.98 - 0.4 * c - Math.abs(Math.sin(this.phase)) * 0.03 * moveAmt;
    for (const [hip, knee, foot, sgn] of [[r.hipL, r.kneeL, r.footL, 1], [r.hipR, r.kneeR, r.footR, -1]] as const) {
      const s = swing * sgn;
      hip.rotation.x = crouchHip - s * lf * 1.0;
      hip.rotation.z = s * ls * 0.5 + (c > 0.5 ? sgn * -0.12 : 0);
      knee.rotation.x = crouchKnee + lift(-Math.sin(this.phase) * sgn) + (p.grounded ? 0 : 0.6);
      foot.rotation.x = -crouchHip * 0.4 - crouchKnee * 0.45;
    }
    if (p.slide) {
      r.hipL.rotation.x = -1.4;
      r.kneeL.rotation.x = 0.4;
      r.hipR.rotation.x = -0.6;
      r.kneeR.rotation.x = 2.0;
    }

    // ---- torso: lean into sprint, twist toward aim, pitch split between spine/chest/head
    this.flinch = damp(this.flinch, 0, 6, dt);
    this.recoil = damp(this.recoil, 0, 18, dt);
    const lean = p.sprint ? 0.25 : moveAmt * 0.08 * lf;
    r.spine.rotation.set(lean + c * 0.25 - this.flinch * 0.25, twistNow * 0.35, this.flinch * this.flinchSide * 0.3);
    r.chest.rotation.set(-p.pitch * 0.35, twistNow * 0.45, 0);
    r.neck.rotation.set(-p.pitch * 0.25, twistNow * 0.2, 0);
    r.head.rotation.set(-p.pitch * 0.2, 0, 0);

    // ---- weapon + arms
    if (this.weapon) {
      const aimPitch = p.sprint ? -0.6 : -p.pitch * 0.4 + this.recoil * 0.08 - (p.reloading ? 0.3 : 0);
      poseWithWeapon(r, this.weapon, aimPitch, this.mount);
      if (p.sprint) this.mount.rotation.y = 0.6;
      else this.mount.rotation.y = 0;
      this.mount.position.z = -0.24 + this.recoil * 0.04;
    }
  }

  private animateDeath(p: RenderPlayer, dt: number): void {
    const r = this.rig;
    if (this.deadT < 0) {
      this.deadT = 0;
      // fall away from the shot
      this.fallDir = Math.cos(angleDiff(this.bodyYaw, p.deathYaw)) > 0 ? 1 : -1;
    }
    this.deadT += dt;
    const t = clamp(this.deadT / 0.7, 0, 1);
    const e = t * t * (3 - 2 * t);
    // crumple: knees give, torso pitches, whole body pivots to the floor
    r.kneeL.rotation.x = 1.4 * e;
    r.kneeR.rotation.x = 0.9 * e;
    r.hipL.rotation.x = -0.6 * e;
    r.hipR.rotation.x = -0.2 * e;
    r.hips.position.y = 0.98 - 0.72 * e;
    r.spine.rotation.x = 0.3 * e * this.fallDir;
    r.chest.rotation.x = 0.2 * e * this.fallDir;
    r.head.rotation.x = 0.4 * e * this.fallDir;
    this.root.rotation.set((Math.PI / 2.15) * e * this.fallDir, this.bodyYaw, 0, 'YXZ');
    this.root.position.y = p.y + 0.12 * e;
    r.shoulderL.rotation.z = -1.2 * e;
    r.shoulderR.rotation.z = 1.1 * e;
  }
}
