import * as THREE from 'three';
import { Renderer, DEFAULT_RENDER_OPTIONS } from '@/engine/Renderer';
import { QUALITY_PRESETS, type QualityLevel } from '@/engine/quality';
import { Assets } from '@/assets/Assets';
import { buildWeapon, weaponIds } from '@/assets/models/weapons';
import { buildCharacter, poseWithWeapon } from '@/assets/models/character';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { MapView } from '@/game/view/MapView';
import { bakeReflectionProbe } from '@/game/view/ReflectionProbe';
import { PROPS } from '@/assets/models/props';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Viewmodel } from '@/game/view/Viewmodel';
import { gradeOptions } from '@/game/view/lighting/grading';
import { DEFAULT_SETTINGS } from '@/app/settings';

// Art test views:
//   #/arttest            – map section + character + weapons under final lighting
//   #/arttest/guns       – weapon lineup under studio light
//   Query: ?q=low|medium|high|ultra  &cam=<name>
export async function runArtTest(canvas: HTMLCanvasElement): Promise<void> {
  const parts = location.hash.split('/');
  const mode = parts[2] ?? 'scene';
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const ql = (params.get('q') ?? 'high') as QualityLevel;
  const quality = QUALITY_PRESETS[ql] ?? QUALITY_PRESETS.high;
  const style = (params.get('style') ?? 'cinematic') as 'cinematic' | 'balanced' | 'natural';
  const renderer = new Renderer(canvas, {
    ...DEFAULT_RENDER_OPTIONS,
    quality,
    ...gradeOptions('sublevel9', { ...DEFAULT_SETTINGS, quality: ql, visualStyle: style }),
  });
  const t0 = performance.now();
  const assets = await Assets.create(renderer.gl, quality);
  (window as any).__stats = { texMs: Math.round(performance.now() - t0) };
  if (mode.startsWith('guns')) return gunLineup(renderer, assets);
  if (mode.startsWith('char')) return charLineup(renderer, assets);
  return scene(renderer, assets, params);
}

const CAMS: Record<string, { pos: [number, number, number]; look: [number, number, number]; fov: number }> = {
  hero: { pos: [4.4, 1.45, -2.4], look: [0.2, 1.15, 2.0], fov: 60 },
  shaft: { pos: [6.8, 1.7, 4.6], look: [0, 1.2, -0.5], fov: 66 },
  char: { pos: [2.4, 1.45, 0.7], look: [0.6, 1.1, 2.6], fov: 45 },
  guns: { pos: [3.3, 1.55, -1.5], look: [2.75, 1.0, -0.65], fov: 45 },
  fp: { pos: [5.6, 1.62, -3.4], look: [0.4, 1.45, 1.6], fov: 72 },
  fpcells: { pos: [-16.5, 1.62, -8.4], look: [-6, 1.45, -8.0], fov: 72 },
  boiler: { pos: [-15.5, 1.7, 7.4], look: [-4, 2.2, 12.5], fov: 68 },
  cells: { pos: [-17.5, 1.65, -8.0], look: [-2, 1.2, -8.6], fov: 66 },
  lockers: { pos: [-10.0, 1.65, -4.8], look: [-17, 1.1, 2.5], fov: 68 },
  spawn: { pos: [-20.5, 1.65, -4.5], look: [-24, 1.2, 3], fov: 70 },
};

async function scene(renderer: Renderer, assets: Assets, params: URLSearchParams): Promise<void> {
  const quality = renderer.options.quality;
  const map = buildSublevel9();
  const view = new MapView(map, assets.materials, quality);
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(0x05070a);
  sc.fog = new THREE.FogExp2(0x0b0f14, 0.028);
  sc.add(view.root);

  // Character holding the Halberd beside the pillar
  const rig = buildCharacter(assets.materials, 0);
  rig.root.position.set(0.6, 0, 2.6);
  rig.root.rotation.y = -0.55;
  sc.add(rig.root);
  rig.spine.rotation.x = 0.05;
  rig.chest.rotation.y = 0.12;
  rig.neck.rotation.x = -0.05;
  rig.hipL.rotation.x = -0.18;
  rig.kneeL.rotation.x = 0.28;
  rig.hipR.rotation.x = 0.12;
  rig.kneeR.rotation.x = 0.12;
  rig.footL.rotation.x = -0.1;
  const halberd = buildWeapon(assets.materials, 'halberd');
  const mount = new THREE.Group();
  rig.chest.add(mount);
  poseWithWeapon(rig, halberd, -0.12, mount);

  // Weapons laid on a crate in the foreground
  const crate = PROPS.crate.build(assets.materials, 0);
  crate.position.set(2.75, 0, -0.65);
  crate.rotation.y = 0.35;
  sc.add(crate);
  const rook = buildWeapon(assets.materials, 'rook9');
  rook.root.position.set(2.62, 1.03, -0.5);
  rook.root.rotation.set(0, 0.35 + Math.PI / 2 + 0.25, Math.PI / 2);
  sc.add(rook.root);
  const warden = buildWeapon(assets.materials, 'warden');
  warden.root.position.set(2.95, 1.022, -0.85);
  warden.root.rotation.set(0, -0.9, Math.PI / 2);
  sc.add(warden.root);

  const camName = params.get('cam') ?? 'hero';
  const cv = CAMS[camName] ?? CAMS.hero;
  const cam = new THREE.PerspectiveCamera(cv.fov, 16 / 9, 0.05, 200);
  cam.position.set(...cv.pos);
  cam.lookAt(...cv.look);

  // Settle lights then bake the reflection probe from the room center.
  view.lights.settle(new THREE.Vector3(0, 1.7, 0), 0);
  const env = bakeReflectionProbe(renderer.gl, sc, new THREE.Vector3(0, 1.7, 0), quality.reflectionProbeSize);
  assets.materials.setEnvMap(env);
  sc.environmentIntensity = 0.45;
  view.lights.settle(cam.position, 0);

  // First-person views: viewmodel with the chosen weapon (hip or ADS)
  let vm: Viewmodel | null = null;
  if (camName.startsWith('fp')) {
    vm = new Viewmodel(assets.materials);
    vm.setWeapon(params.get('w') ?? 'halberd');
    const ads = params.get('ads') === '1' ? 1 : 0;
    const st = { ads, sprint: 0, moveSpeed: 0, grounded: true, crouch: 0, lookDX: 0, lookDY: 0 };
    vm.syncFromWorld(cam, view.lights.nearestActive(cam.position, 4), env);
    for (let i = 0; i < 30; i++) vm.update(1 / 30, st);
    renderer.setScenes(sc, cam, vm.scene, vm.camera);
  } else renderer.setScenes(sc, cam);
  renderer.resize();
  view.atmosphere.setPixelScale(renderer.canvas.clientHeight);
  let frames = 0;
  const start = performance.now();
  const stats = (window as any).__stats;
  const loop = () => {
    const t = (performance.now() - start) / 1000;
    view.update(cam, t + 3, 1 / 60);
    if (vm) {
      vm.syncFromWorld(cam, view.lights.nearestActive(cam.position, 4), env);
      vm.update(1 / 60, { ads: params.get('ads') === '1' ? 1 : 0, sprint: 0, moveSpeed: 0, grounded: true, crouch: 0, lookDX: 0, lookDY: 0 });
    }
    renderer.render(1 / 60);
    frames++;
    (window as any).__frames = frames;
    stats.calls = renderer.gl.info.render.calls;
    stats.tris = renderer.gl.info.render.triangles;
    requestAnimationFrame(loop);
  };
  loop();
}

function gunLineup(renderer: Renderer, assets: Assets): void {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d20);
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  assets.materials.setEnvMap(env);
  scene.environmentIntensity = 0.35;
  const ids = (location.hash.split('/')[3] ?? weaponIds().join(',')).split(',');
  // grid: up to 3 columns, muzzles pointing right on screen (-X)
  const cols = ids.length > 4 ? 3 : 1;
  const rows = Math.ceil(ids.length / cols);
  const labels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = [];
  ids.forEach((id, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const w = buildWeapon(assets.materials, id);
    w.root.rotation.y = Math.PI / 2;
    w.root.position.set(((cols - 1) / 2 - c) * 1.15, ((rows - 1) / 2 - r) * 0.34, 0);
    scene.add(w.root);
    const el = document.createElement('div');
    el.textContent = id.toUpperCase();
    el.style.cssText = 'position:fixed;color:#ff6a13;font:600 13px monospace;letter-spacing:2px;pointer-events:none;transform:translate(-50%,0)';
    document.body.appendChild(el);
    labels.push({ el, pos: w.root.position.clone().add(new THREE.Vector3(0, -0.12, 0)) });
  });
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(1.5, 2, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc8ff, 1.4);
  rim.position.set(-2, 1, -2);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const dist = cols === 1 ? 1.75 + Math.max(0, rows - 3) * 0.3 : 3.7;
  cam.position.set(0.12, 0.04, -dist);
  cam.lookAt(0.12, 0.02, 0);
  renderer.setScenes(scene, cam);
  renderer.resize();
  let frames = 0;
  const v = new THREE.Vector3();
  const loop = () => {
    for (const l of labels) {
      v.copy(l.pos).project(cam);
      l.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      l.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
    }
    renderer.render(1 / 60);
    (window as any).__frames = ++frames;
    requestAnimationFrame(loop);
  };
  loop();
}

function charLineup(renderer: Renderer, assets: Assets): void {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15181b);
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  assets.materials.setEnvMap(env);
  scene.environmentIntensity = 0.25;
  const yaws = [0, Math.PI / 2, Math.PI, -Math.PI / 4];
  yaws.forEach((yaw, i) => {
    const rig = buildCharacter(assets.materials, (i % 2) as 0 | 1);
    rig.root.position.set(-2.4 + i * 1.6, 0, 0);
    rig.root.rotation.y = yaw;
    scene.add(rig.root);
    const w = buildWeapon(assets.materials, i === 3 ? 'rook9' : 'halberd');
    const mount = new THREE.Group();
    rig.chest.add(mount);
    poseWithWeapon(rig, w, -0.1, mount);
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), assets.materials.get('concreteDark'));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const key = new THREE.DirectionalLight(0xfff2e0, 3.0);
  key.position.set(2, 4, -4);
  key.castShadow = true;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc8ff, 1.5);
  rim.position.set(-3, 2, 3);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  cam.position.set(0, 1.3, -8.5);
  cam.lookAt(0, 0.95, 0);
  renderer.setScenes(scene, cam);
  renderer.resize();
  let frames = 0;
  const loop = () => {
    renderer.render(1 / 60);
    (window as any).__frames = ++frames;
    requestAnimationFrame(loop);
  };
  loop();
}
