import * as THREE from 'three';
import { envProbePos } from '@/game/world/builder';
import { Renderer, DEFAULT_RENDER_OPTIONS } from '@/engine/Renderer';
import { QUALITY_PRESETS, type QualityLevel } from '@/engine/quality';
import { Assets } from '@/assets/Assets';
import { buildWeapon, weaponIds } from '@/assets/models/weapons';
import { SoldierView } from '@/game/view/soldier/SoldierView';
import type { RenderPlayer } from '@/game/view/renderPlayer';
import { buildMap, MAP_IDS } from '@/game/world/maps';
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
//   Query: ?q=low|medium|high|ultra  &map=<id>  &cam=<name>
/** Fixed cameras per map used by screenshots and `npm run audit:contrast`. */
export const ART_CAMS: Record<string, string[]> = {
  sublevel9: ['hero', 'shaft', 'boiler', 'cells', 'lockers', 'spawn', 'fpcells', 'cistern', 'catwalk'],
  monsoon: ['pad', 'jungle', 'swamp', 'ridge', 'river', 'barracks', 'motor', 'spawn', 'fpgate'],
};

/**
 * Contrast limits per map for the audit where they differ from the defaults. Monsoon's jungle is
 * dark on purpose (under the canopy the flashlight does the work), so its views may hold more
 * near-black and a narrower range than the bunker's.
 */
export const ART_LIMITS: Record<string, { minRange?: number; minStd?: number; maxBlack?: number }> = {
  monsoon: { minRange: 0.15, minStd: 0.05, maxBlack: 0.5 },
};

export async function runArtTest(canvas: HTMLCanvasElement): Promise<void> {
  (window as unknown as { __artCams: unknown }).__artCams = ART_CAMS;
  (window as unknown as { __artLimits: unknown }).__artLimits = ART_LIMITS;
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

type Cam = { pos: [number, number, number]; look: [number, number, number]; fov: number };

const CAMS: Record<string, Cam> = {
  // soldier at the collapse's north-west corner, the split stairs and balcony behind
  hero: { pos: [-2.4, 1.5, 5.4], look: [-7.6, 1.5, 7.6], fov: 60 },
  // from the north balcony down into the pit, moonlight and the riser
  shaft: { pos: [-4.6, 4.9, 8.95], look: [0.6, -2.4, -1.2], fov: 68 },
  char: { pos: [-5.5, 1.45, 5.5], look: [-7.4, 1.1, 7.0], fov: 45 },
  guns: { pos: [-4.3, 1.55, 6.1], look: [-5.0, 1.0, 7.4], fov: 45 },
  fp: { pos: [-8.6, 1.62, 6.2], look: [0, 0.2, -1.5], fov: 72 },
  fpcells: { pos: [-9.4, 1.62, -12.8], look: [3, 1.6, -14.8], fov: 72 },
  boiler: { pos: [-9.8, 1.7, 12.1], look: [1.0, 2.8, 19.5], fov: 70 },
  cells: { pos: [-9.6, 1.7, -10.4], look: [5.0, 2.6, -19.0], fov: 68 },
  lockers: { pos: [-12.0, 1.65, -7.8], look: [-20.0, 1.1, 2.5], fov: 68 },
  spawn: { pos: [-25.4, 1.65, -6.4], look: [-33.0, 1.2, 2.5], fov: 70 },
  // down in the pit: the pump and its riser, the lit crawl space beyond
  cistern: { pos: [-5.0, -1.15, 4.0], look: [3.4, -1.9, -1.6], fov: 72 },
  catwalk: { pos: [-21.4, 4.82, 22.9], look: [0, 3.0, 17.0], fov: 70 },
};

const MONSOON_CAMS: Record<string, Cam> = {
  // the soldier by the helipad sandbags, the wreck and the command post on stilts behind
  hero: { pos: [-9.6, 1.6, -9.6], look: [-4.8, 1.3, -4.6], fov: 60 },
  pad: { pos: [-3.5, 1.7, -12.5], look: [0.5, 1.8, 8.0], fov: 70 },
  char: { pos: [-7.6, 1.4, -8.4], look: [-6.0, 1.1, -6.4], fov: 45 },
  guns: { pos: [-6.3, 1.5, -8.0], look: [-5.3, 1.0, -6.9], fov: 45 },
  // west jungle north of the spawn clearing: a buttress giant, palms, tree ferns, ferns
  jungle: { pos: [-35.5, 1.7, 2.5], look: [-44.0, 0.9, 13.0], fov: 70 },
  swamp: { pos: [-28.5, 1.9, 20.5], look: [-40.0, 0.6, 26.0], fov: 70 },
  ridge: { pos: [2.5, 1.75, 18.6], look: [-1.0, 4.4, 28.0], fov: 70 },
  river: { pos: [-9.0, 1.2, -21.6], look: [3.0, 0.0, -30.5], fov: 70 },
  barracks: { pos: [-28.0, 1.7, -3.0], look: [-17.0, 1.6, -10.5], fov: 70 },
  motor: { pos: [-7.5, 1.7, 5.8], look: [-20.0, 1.4, 10.5], fov: 70 },
  spawn: { pos: [-44.6, 2.1, -4.5], look: [-31.0, 1.4, 1.0], fov: 70 },
  // first person at the west gate looking into the base
  fpgate: { pos: [-39.0, 1.62, -3.0], look: [-20.0, 1.3, -2.5], fov: 72 },
};

/** Per map: the cameras, where the soldier stands and the crate with the guns. */
const ART_SCENES: Record<string, { cams: Record<string, Cam>; soldier: { x: number; z: number; y: number; yaw: number }; crate: { x: number; z: number; y: number } }> = {
  sublevel9: { cams: CAMS, soldier: { x: -7.4, z: 6.9, y: 0, yaw: -0.85 }, crate: { x: -5.0, z: 7.4, y: 0 } },
  monsoon: { cams: MONSOON_CAMS, soldier: { x: -6.2, z: -6.0, y: 0.15, yaw: -0.4 }, crate: { x: -4.6, z: -6.7, y: 0.15 } },
};

async function scene(renderer: Renderer, assets: Assets, params: URLSearchParams): Promise<void> {
  const quality = renderer.options.quality;
  const mapId = MAP_IDS.includes(params.get('map') ?? '') ? params.get('map')! : 'sublevel9';
  const map = buildMap(mapId);
  const art = ART_SCENES[mapId] ?? ART_SCENES.sublevel9;
  renderer.options = { ...renderer.options, ...gradeOptions(mapId, { ...DEFAULT_SETTINGS, quality: quality.level, visualStyle: (params.get('style') ?? 'cinematic') as 'cinematic' | 'balanced' | 'natural' }) };
  const view = new MapView(map, assets.materials, quality);
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(0x05070a);
  sc.fog = new THREE.FogExp2(map.fog?.color ?? 0x0b0f14, map.fog?.density ?? 0.028);
  sc.add(view.root);

  // Soldier holding the Halberd near the map's showpiece
  const soldier = new SoldierView(assets.materials, assets.soldiers.red, 0);
  sc.add(soldier.root);
  soldier.update(standing({ x: art.soldier.x, y: art.soldier.y, z: art.soldier.z, yaw: art.soldier.yaw, pitch: -0.12, weapon: 'halberd' }), 1 / 60);

  // Weapons laid on a crate in the foreground
  const C = art.crate;
  const crate = PROPS.crate.build(assets.materials, 0);
  crate.position.set(C.x, C.y, C.z);
  crate.rotation.y = 0.35;
  sc.add(crate);
  const rook = buildWeapon(assets.materials, 'rook9');
  rook.root.position.set(C.x - 0.13, C.y + 1.03, C.z + 0.15);
  rook.root.rotation.set(0, 0.35 + Math.PI / 2 + 0.25, Math.PI / 2);
  sc.add(rook.root);
  const warden = buildWeapon(assets.materials, 'warden');
  warden.root.position.set(C.x + 0.2, C.y + 1.022, C.z - 0.2);
  warden.root.rotation.set(0, -0.9, Math.PI / 2);
  sc.add(warden.root);

  const camName = params.get('cam') ?? 'hero';
  // free camera for inspection: cam=free&pos=x,y,z&look=x,y,z&fov=60
  const v3 = (k: string) => (params.get(k) ?? '').split(',').map(Number) as [number, number, number];
  const cv = camName === 'free' ? { pos: v3('pos'), look: v3('look'), fov: Number(params.get('fov') ?? 60) } : (art.cams[camName] ?? art.cams.hero);
  const cam = new THREE.PerspectiveCamera(cv.fov, 16 / 9, 0.05, 200);
  cam.position.set(...cv.pos);
  cam.lookAt(...cv.look);

  // Settle lights then bake the reflection probe from the room center.
  view.lights.settle(new THREE.Vector3(...envProbePos(map)), 0);
  const env = bakeReflectionProbe(renderer.gl, sc, new THREE.Vector3(...envProbePos(map)), quality.reflectionProbeSize);
  assets.materials.setEnvMap(env);
  view.setEnvMap(env);
  view.lights.settle(cam.position, 0, cam.getWorldDirection(new THREE.Vector3()));

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
  (window as any).__artView = view;
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
    const soldier = new SoldierView(assets.materials, i % 2 ? assets.soldiers.camo : assets.soldiers.red, (i % 2) as 0 | 1);
    scene.add(soldier.root);
    soldier.update(standing({ x: -2.4 + i * 1.6, z: 0, yaw, pitch: -0.1, weapon: i === 3 ? 'rook9' : 'halberd' }), 1 / 60);
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

/** A standing, aiming render state for static dev shots. */
function standing(o: { x: number; y?: number; z: number; yaw: number; pitch: number; weapon: string }): RenderPlayer {
  return {
    id: 0, team: 0, name: 'soldier', alive: true, x: o.x, y: o.y ?? 0, z: o.z, vx: 0, vz: 0, yaw: o.yaw, pitch: o.pitch,
    crouch: 0, slide: false, grounded: true, ads: 0, sprint: false, weapon: o.weapon, reloading: false, hp: 100, deathYaw: 0,
  };
}
