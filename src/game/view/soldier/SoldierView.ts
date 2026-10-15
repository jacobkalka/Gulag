import * as THREE from 'three';
import type { MaterialLibrary } from '@/assets/materials';
import { buildWeapon, type WeaponModel } from '@/assets/models/weapons';
import { getWeapon } from '@/data/weapons';
import { angleDiff, clamp, damp, dampAngle } from '@/shared/math';
import type { RenderPlayer } from '../CharacterView';
import { instantiate, type SoldierAsset } from './soldierAssets';
import { SoldierRig } from './SoldierRig';
import { SoldierAnimator } from './SoldierAnimator';

// A rigged soldier (one of the provided models) driven by the procedural animator: remote players,
// bots, the lobby stage and spectator views all use this.

export class SoldierView {
  readonly root = new THREE.Group();
  readonly model: THREE.Group;
  readonly rig: SoldierRig;
  readonly anim: SoldierAnimator;
  private weapon: WeaponModel | null = null;
  private weaponId = '';
  private bodyYaw = 0;
  private lastYaw = 0;
  private turnRate = 0;
  private speedS = 0;
  private reloadStart = -1;
  private reloadLen = 1.5;
  private now = 0;
  private deadT = -1;
  private fallDir = 1;
  team: 0 | 1;
  visible = true;

  constructor(
    private lib: MaterialLibrary,
    asset: SoldierAsset,
    team: 0 | 1,
  ) {
    this.team = team;
    const inst = instantiate(asset);
    this.model = inst.root;
    this.root.add(this.model);
    this.rig = new SoldierRig(this.model);
    this.anim = new SoldierAnimator(this.rig);
    this.root.name = `soldier:${asset.skin}`;
  }

  setWeapon(id: string): void {
    const model = getWeapon(id).model;
    if (model === this.weaponId) return;
    if (this.weapon) this.model.remove(this.weapon.root);
    this.weapon = buildWeapon(this.lib, model);
    this.weapon.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.model.add(this.weapon.root);
    this.weaponId = model;
    this.reloadLen = getWeapon(id).reload;
  }

  /** Flinch away from a hit that came from `fromYaw` (world yaw of the shot direction). */
  hit(fromYaw: number): void {
    const rel = angleDiff(this.bodyYaw, fromYaw);
    this.anim.hit(-Math.sin(rel), Math.cos(rel) > 0 ? 1 : -1);
  }

  fire(): void {
    this.anim.fire();
  }

  update(p: RenderPlayer, dt: number): void {
    this.now += dt;
    this.root.position.set(p.x, p.y, p.z);
    this.setWeapon(p.weapon);
    if (!p.alive) {
      this.die(p, dt);
      return;
    }
    if (this.deadT >= 0) {
      // respawned
      this.deadT = -1;
      this.root.rotation.set(0, 0, 0);
      this.bodyYaw = p.yaw;
      this.lastYaw = p.yaw;
    }
    const speed = Math.hypot(p.vx, p.vz);
    this.speedS = damp(this.speedS, speed, 12, dt);
    // the body follows the aim when the twist gets large or when moving
    const twist = angleDiff(this.bodyYaw, p.yaw);
    if (Math.abs(twist) > 0.9 || speed > 0.5) this.bodyYaw = dampAngle(this.bodyYaw, p.yaw, speed > 0.5 ? 9 : 5, dt);
    this.turnRate = damp(this.turnRate, angleDiff(this.lastYaw, this.bodyYaw) / Math.max(dt, 1e-3), 8, dt);
    this.lastYaw = this.bodyYaw;
    this.root.rotation.set(0, this.bodyYaw, 0);
    // velocity in the body frame (x right, z back)
    const c = Math.cos(this.bodyYaw);
    const s = Math.sin(this.bodyYaw);
    const bx = p.vx * c - p.vz * s;
    const bz = p.vx * s + p.vz * c;
    if (p.reloading && this.reloadStart < 0) this.reloadStart = this.now;
    if (!p.reloading) this.reloadStart = -1;
    this.anim.update(
      {
        vx: bx,
        vz: bz,
        speed: this.speedS,
        pitch: p.pitch,
        twist: angleDiff(this.bodyYaw, p.yaw),
        turnRate: this.turnRate,
        crouch: p.crouch,
        slide: p.slide,
        grounded: p.grounded,
        ads: p.ads,
        sprint: p.sprint,
        reloading: p.reloading,
        reloadT: this.reloadStart >= 0 ? (this.now - this.reloadStart) / this.reloadLen : 0,
      },
      this.weapon,
      dt,
    );
    this.rig.commit();
    this.placeWeapon();
  }

  private placeWeapon(): void {
    if (!this.weapon) return;
    this.weapon.root.position.copy(this.anim.weaponPos);
    this.weapon.root.quaternion.copy(this.anim.weaponQuat);
  }

  private die(p: RenderPlayer, dt: number): void {
    if (this.deadT < 0) {
      this.deadT = 0;
      // fall away from the shot
      this.fallDir = Math.cos(angleDiff(this.bodyYaw, p.deathYaw)) > 0 ? 1 : -1;
    }
    this.deadT += dt;
    const t = clamp(this.deadT / 0.75, 0, 1);
    const e = t * t * (3 - 2 * t);
    this.anim.updateDeath(e, this.fallDir, this.weapon);
    this.rig.commit();
    this.placeWeapon();
    // the whole body tips over onto the floor
    this.root.rotation.set((Math.PI / 2.1) * e * e * this.fallDir, this.bodyYaw, 0, 'YXZ');
    this.root.position.y = p.y + 0.1 * e;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
