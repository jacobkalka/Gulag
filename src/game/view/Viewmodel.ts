import * as THREE from 'three';
import type { MaterialLibrary } from '@/assets/materials';
import { buildWeapon, type WeaponModel } from '@/assets/models/weapons';
import { capsule, cyl, merge, rbox, torus, xf, type Geo } from '@/assets/geometry/toolkit';
import { GRIPS, leftGrip, solveArm, wristTarget } from '@/assets/models/character';
import { clamp, damp, lerp } from '@/shared/math';
import { radialTexture } from '@/assets/textures/canvasTextures';

// First-person viewmodel: gloved arms solved onto the weapon with 2-bone IK, procedural
// hip / ADS / sprint poses, sway, bob, recoil kick, and reload/swap/inspect animations.

const UPPER = 0.29;
const FORE = 0.27;
const SHOULDER_R = new THREE.Vector3(0.2, -0.32, 0.16);
const SHOULDER_L = new THREE.Vector3(-0.22, -0.34, 0.08);
/** Comfortable reach; beyond it the shoulder leans in toward the grip (long foregrips). */
const REACH = (UPPER + FORE) * 0.96;
const _tl = new THREE.Vector3();

function handMesh(lib: MaterialLibrary, side: 1 | -1, curl: number): THREE.Group {
  const glove = lib.get('leather');
  const pad = lib.get('armor');
  const g: Geo[] = [];
  // Hand joint at the wrist; palm extends along -Y; fingers curl toward -Z (palm side).
  g.push(rbox(0.082, 0.095, 0.032, 0.014, 2, { p: [0, -0.05, 0] }));
  for (let i = 0; i < 4; i++) {
    const x = -0.03 + i * 0.02;
    const len = i === 1 || i === 2 ? 0.05 : 0.044;
    const f1 = capsule(0.0095, len * 0.5, 2, 6, { p: [0, -len * 0.4, 0] });
    xf(f1, { r: [curl * 0.55, 0, 0] });
    xf(f1, { p: [x, -0.098, 0] });
    const f2 = capsule(0.0088, len * 0.42, 2, 6, { p: [0, -len * 0.35, 0] });
    xf(f2, { r: [curl * 1.25, 0, 0] });
    xf(f2, { p: [x, -0.098 - Math.cos(curl * 0.55) * len * 0.75, -Math.sin(curl * 0.55) * len * 0.75] });
    g.push(f1, f2);
  }
  const th = capsule(0.011, 0.04, 2, 6, { p: [0, -0.03, 0] });
  xf(th, { r: [0.5, 0, side * 0.9] });
  xf(th, { p: [-side * 0.04, -0.035, -0.012] });
  g.push(th);
  const grp = new THREE.Group();
  const m = new THREE.Mesh(merge(g), glove);
  m.castShadow = false;
  grp.add(m);
  const knuckle = new THREE.Mesh(rbox(0.07, 0.03, 0.012, 0.005, 1, { p: [0, -0.07, 0.018] }), pad);
  grp.add(knuckle);
  return grp;
}

function buildArm(lib: MaterialLibrary, side: 1 | -1, curl: number): { shoulder: THREE.Group; elbow: THREE.Group; hand: THREE.Group } {
  const fabric = lib.tinted('fabricA', 0x9a9a92, 'fpSleeve');
  const glove = lib.get('leather');
  const accent = lib.get('teamA');
  const shoulder = new THREE.Group();
  const elbow = new THREE.Group();
  elbow.position.y = -UPPER;
  shoulder.add(elbow);
  const hand = new THREE.Group();
  hand.position.y = -FORE;
  elbow.add(hand);
  const up = new THREE.Mesh(merge([capsule(0.058, 0.2, 3, 12, { p: [0, -0.15, 0] })]), fabric);
  shoulder.add(up);
  const band = new THREE.Mesh(cyl(0.061, 0.061, 0.02, 14, { p: [0, -0.1, 0] }), accent);
  shoulder.add(band);
  const fore: Geo[] = [capsule(0.05, 0.16, 3, 12, { p: [0, -0.11, 0] }), torus(0.05, 0.015, 6, 14, Math.PI * 2, { p: [0, -0.05, 0], r: [Math.PI / 2, 0, 0] })];
  elbow.add(new THREE.Mesh(merge(fore), fabric));
  elbow.add(new THREE.Mesh(cyl(0.047, 0.044, 0.07, 12, { p: [0, -0.235, 0] }), glove));
  hand.add(handMesh(lib, side, curl));
  for (const o of [shoulder]) o.traverse((c) => ((c as THREE.Mesh).castShadow = false));
  return { shoulder, elbow, hand };
}

export interface ViewmodelState {
  ads: number; // 0..1
  sprint: number; // 0..1
  moveSpeed: number; // m/s
  grounded: boolean;
  crouch: number;
  lookDX: number; // mouse delta this frame (radians)
  lookDY: number;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private rig = new THREE.Group(); // follows the world camera
  private holder = new THREE.Group(); // animated weapon placement
  weapon: WeaponModel | null = null;
  private armR: ReturnType<typeof buildArm>;
  private armL: ReturnType<typeof buildArm>;
  private lights: THREE.PointLight[] = [];
  private hemi: THREE.HemisphereLight;
  // animation state
  private bobT = 0;
  private sway = new THREE.Vector2();
  private kick = 0;
  private kickRot = 0;
  private kickSide = 0;
  private reloadT = -1;
  private reloadDur = 2;
  private swapT = -1;
  private inspectT = -1;
  boltBack = 0;
  private hipPos = new THREE.Vector3(0.15, -0.17, -0.38);
  /** Small muzzle flash sprite + light that live with the gun (local player only). */
  private flash: THREE.Sprite;
  private flashLight: THREE.PointLight;
  private flashT = 0;
  /** Visual recoil multiplier (touchpad mode lowers it). */
  kickScale = 1;

  constructor(private lib: MaterialLibrary, fov = 60) {
    this.camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.01, 10);
    this.scene.add(this.rig);
    this.rig.add(this.camera);
    this.rig.add(this.holder);
    this.armR = buildArm(lib, 1, 1.15);
    this.armL = buildArm(lib, -1, 1.25);
    this.rig.add(this.armR.shoulder, this.armL.shoulder);
    this.armR.shoulder.position.copy(SHOULDER_R);
    this.armL.shoulder.position.copy(SHOULDER_L);
    this.hemi = new THREE.HemisphereLight(0x7d8aa0, 0x2a2622, 0.2);
    this.scene.add(this.hemi);
    // over-the-shoulder fill follows the camera
    this.fill.position.set(-0.6, 1.0, 0.6);
    this.rig.add(this.fill, this.fill.target);
    this.fill.target.position.set(0.1, -0.2, -0.5);
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialTexture('rgba(255,240,205,1)', 'rgba(255,130,40,0)', 64),
        color: new THREE.Color(1, 0.8, 0.52).multiplyScalar(2.2),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        toneMapped: true,
      }),
    );
    this.flash.visible = false;
    this.flash.renderOrder = 5;
    this.flashLight = new THREE.PointLight(0xffb26a, 0, 1.2, 2);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 12, 2);
      this.scene.add(l);
      this.lights.push(l);
    }
  }

  /** 1 = full weapon bob/sway, lower for the reduce-motion setting. */
  motionScale = 1;

  setWeapon(id: string): void {
    if (this.weapon) this.holder.remove(this.weapon.root);
    this.weapon = buildWeapon(this.lib, id);
    this.weapon.root.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) m.castShadow = false;
    });
    this.holder.add(this.weapon.root);
    this.weapon.root.add(this.flash, this.flashLight);
    this.flash.position.copy(this.weapon.muzzle);
    this.flashLight.position.copy(this.weapon.muzzle);
    // Pistols sit closer and lower; long guns a little further out.
    const pistol = this.weapon.leftHand === 'pistol';
    this.hipPos.set(pistol ? 0.12 : 0.15, pistol ? -0.15 : -0.17, pistol ? -0.34 : -0.38);
  }

  /**
   * Ambient for the gun from the baked probes at the camera (sky = from above, ground = from
   * below), plus a soft key from over the shoulder scaled by the same light, so the weapon reads
   * in the dark without glowing.
   */
  setAmbient(up: THREE.Color, down: THREE.Color): void {
    this.hemi.color.copy(up);
    this.hemi.groundColor.copy(down);
    this.hemi.intensity = Math.PI;
    const lum = Math.max(0.0, (up.r + up.g + up.b) / 3);
    this.fill.color.copy(up).multiplyScalar(1 / Math.max(1e-4, lum)).lerp(new THREE.Color(1, 1, 1), 0.5);
    this.fill.intensity = Math.min(2.5, 0.25 + lum * 10);
  }
  private fill = new THREE.DirectionalLight(0xffffff, 0.3);

  /** Copy world camera transform + sync a few world lights so the gun is lit like the room. */
  syncFromWorld(worldCam: THREE.PerspectiveCamera, lights: { pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number }[], env: THREE.Texture | null): void {
    this.rig.position.copy(worldCam.position);
    this.rig.quaternion.copy(worldCam.quaternion);
    this.scene.environment = env;
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      const s = lights[i];
      if (!s) {
        L.intensity = 0;
        continue;
      }
      L.position.copy(s.pos);
      L.color.copy(s.color);
      L.intensity = s.intensity;
      L.distance = s.distance;
    }
  }

  fire(strength = 1): void {
    const s = strength * this.kickScale;
    this.kick = Math.min(1.6, this.kick + 0.55 * s);
    this.kickRot = Math.min(1.6, this.kickRot + 0.5 * s);
    this.kickSide = (Math.random() - 0.5) * 0.6 * s;
    this.boltBack = 1;
  }

  /** Brief, small muzzle flash at the gun; much smaller and dimmer while aiming. */
  muzzleFlash(ads: number, size = 1): void {
    this.flashT = 0.035;
    const k = (1 - 0.65 * ads) * size;
    this.flash.scale.setScalar((0.075 + Math.random() * 0.03) * k);
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flash.material.opacity = 1 - 0.5 * ads;
    this.flashLight.intensity = 0.9 * (1 - 0.6 * ads);
  }
  reload(duration: number): void {
    this.reloadT = 0;
    this.reloadDur = duration;
  }
  swap(): void {
    this.swapT = 0;
  }
  inspect(): void {
    this.inspectT = 0;
  }
  get reloading(): boolean {
    return this.reloadT >= 0;
  }

  update(dt: number, st: ViewmodelState): void {
    const w = this.weapon;
    if (!w) return;
    // --- sway (lags behind mouse look) and bob (from movement)
    this.sway.x = damp(this.sway.x, clamp(-st.lookDX * 4, -0.06, 0.06), 10, dt);
    this.sway.y = damp(this.sway.y, clamp(st.lookDY * 4, -0.05, 0.05), 10, dt);
    const speed = st.grounded ? st.moveSpeed : 0;
    this.bobT += dt * (5 + speed * 1.3);
    const bobAmt = Math.min(1, speed / 6) * (1 - st.ads * 0.85) * this.motionScale;
    const bobX = Math.sin(this.bobT) * 0.012 * bobAmt;
    const bobY = -Math.abs(Math.cos(this.bobT)) * 0.012 * bobAmt;
    // --- muzzle flash lifetime
    if (this.flashT > 0) this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    if (this.flashT <= 0) this.flashLight.intensity = 0;
    // --- recoil recovery
    this.kick = damp(this.kick, 0, 14, dt);
    this.kickRot = damp(this.kickRot, 0, 11, dt);
    this.kickSide = damp(this.kickSide, 0, 12, dt);
    this.boltBack = damp(this.boltBack, 0, 26, dt);

    // --- base pose: lerp hip -> ADS (eye point onto the line of sight)
    const ads = st.ads;
    const adsPos = new THREE.Vector3(-w.eye.x, -w.eye.y, -w.eye.z - (w.scoped ? 0.0 : 0.02));
    const pos = new THREE.Vector3().lerpVectors(this.hipPos, adsPos, ads);
    let rx = 0;
    let ry = 0;
    let rz = 0;
    // sprint: tilt the weapon down/inward
    const sp = st.sprint * (1 - ads);
    pos.x += sp * -0.05;
    pos.y += sp * -0.05;
    pos.z += sp * 0.04;
    rx += sp * -0.55;
    ry += sp * 0.7;
    rz += sp * 0.25;
    // crouch: slight cant
    rz += st.crouch * 0.05 * (1 - ads);
    // sway + bob
    const swayScale = (1 - ads * 0.7) * (0.4 + 0.6 * this.motionScale);
    pos.x += (this.sway.x + bobX) * swayScale;
    pos.y += (this.sway.y + bobY) * swayScale;
    ry += this.sway.x * 1.2 * swayScale;
    rx += this.sway.y * 1.2 * swayScale;
    rz += this.sway.x * 1.5 * swayScale;
    // recoil
    pos.z += this.kick * 0.035 * (1 - ads * 0.5);
    pos.y += this.kick * 0.006;
    rx += this.kickRot * 0.07 * (1 - ads * 0.6);
    ry += this.kickSide * 0.02;
    // swap (lower + raise)
    if (this.swapT >= 0) {
      this.swapT += dt;
      const t = this.swapT / 0.45;
      const k = t < 0.5 ? t * 2 : (1 - t) * 2;
      pos.y -= clamp(k, 0, 1) * 0.25;
      rx -= clamp(k, 0, 1) * 0.6;
      if (t >= 1) this.swapT = -1;
    }
    // reload: tilt the gun, drop the mag, bring a new one, rack
    let magDrop = 0;
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      const t = clamp(this.reloadT / this.reloadDur, 0, 1);
      const tilt = Math.sin(Math.min(1, t * 1.2) * Math.PI);
      rz += tilt * 0.45;
      rx += tilt * 0.12;
      pos.x -= tilt * 0.04;
      pos.y += tilt * 0.02;
      if (t > 0.18 && t < 0.62) magDrop = t < 0.3 ? (t - 0.18) / 0.12 : t > 0.5 ? 1 - (t - 0.5) / 0.12 : 1;
      if (t > 0.78 && t < 0.92) this.boltBack = Math.sin(((t - 0.78) / 0.14) * Math.PI);
      if (t >= 1) this.reloadT = -1;
    }
    if (this.inspectT >= 0) {
      this.inspectT += dt;
      const t = this.inspectT / 2.4;
      const k = Math.sin(clamp(t, 0, 1) * Math.PI);
      ry += k * -0.9;
      rz += k * 0.35;
      pos.x -= k * 0.06;
      pos.z += k * 0.05;
      if (t >= 1) this.inspectT = -1;
    }
    this.holder.position.copy(pos);
    this.holder.rotation.set(rx, ry, rz, 'YXZ');
    // animated parts
    if (w.mag) {
      w.mag.userData.base ??= w.mag.position.clone();
      (w.mag.position as THREE.Vector3).copy(w.mag.userData.base).add(new THREE.Vector3(0, -0.22 * magDrop, 0.02 * magDrop));
      w.mag.visible = magDrop < 0.98;
    }
    if (w.bolt) {
      w.bolt.userData.base ??= w.bolt.position.clone();
      (w.bolt.position as THREE.Vector3).copy(w.bolt.userData.base).addScaledVector(w.boltTravel, this.boltBack);
    }
    this.solveArms(magDrop);
  }

  private solveArms(magDrop: number): void {
    const w = this.weapon!;
    this.rig.updateMatrixWorld(true);
    const wq = new THREE.Quaternion();
    w.root.getWorldQuaternion(wq);
    const toWorld = (v: THREE.Vector3) => v.clone().applyMatrix4(w.root.matrixWorld);
    const gripR = toWorld(w.gripR);
    let gripL = toWorld(w.gripL);
    if (magDrop > 0 && w.mag) {
      // left hand goes to the magazine during the reload
      const mw = new THREE.Vector3();
      w.mag.getWorldPosition(mw);
      gripL = gripL.lerp(mw.add(new THREE.Vector3(0, -0.06, 0).applyQuaternion(wq)), clamp(magDrop * 1.5, 0, 1));
    }
    const rigQ = this.rig.quaternion;
    const handRq = wq.clone().multiply(GRIPS.pistolR);
    const handLq = wq.clone().multiply(leftGrip(w.leftHand));
    const poleR = this.rig.position.clone().add(new THREE.Vector3(0.9, -1.2, 0.3).applyQuaternion(rigQ));
    const poleL = this.rig.position.clone().add(new THREE.Vector3(-0.9, -1.2, 0.1).applyQuaternion(rigQ));
    const wristR = wristTarget(gripR, handRq);
    const wristL = wristTarget(gripL, handLq);
    this.fitShoulder(this.armR.shoulder, SHOULDER_R, wristR);
    this.fitShoulder(this.armL.shoulder, SHOULDER_L, wristL);
    solveArm(this.armR.shoulder, this.armR.elbow, this.armR.hand, wristR, poleR, UPPER, FORE, handRq);
    solveArm(this.armL.shoulder, this.armL.elbow, this.armL.hand, wristL, poleL, UPPER, FORE, handLq);
  }

  /** Moves a shoulder toward an out-of-reach wrist target so the hand always lands on its grip. */
  private fitShoulder(shoulder: THREE.Object3D, base: THREE.Vector3, wristWorld: THREE.Vector3): void {
    const d = this.rig.worldToLocal(_tl.copy(wristWorld)).sub(base);
    const len = d.length();
    shoulder.position.copy(base);
    if (len > REACH) shoulder.position.addScaledVector(d, (len - REACH) / len);
    shoulder.updateMatrixWorld(true);
  }

  setTeamAccent(team: 0 | 1): void {
    const mat = this.lib.get(team === 0 ? 'teamA' : 'teamB');
    for (const arm of [this.armR, this.armL]) {
      arm.shoulder.children.forEach((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh && (m.material as THREE.Material).name.startsWith('team')) m.material = mat;
      });
    }
  }
}

void lerp;
