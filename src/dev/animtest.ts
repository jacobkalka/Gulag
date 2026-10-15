import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Renderer, DEFAULT_RENDER_OPTIONS } from '@/engine/Renderer';
import { QUALITY_PRESETS } from '@/engine/quality';
import { Assets } from '@/assets/Assets';
import type { SoldierSkin } from '@/game/view/soldier/soldierAssets';
import { SoldierView } from '@/game/view/soldier/SoldierView';
import type { RenderPlayer } from '@/game/view/CharacterView';
import { buildHitboxes } from '@/game/sim/hitboxes';

// ?animtest: both soldiers side by side cycling through every animation state on a tiled floor
// (planted feet must not slide over the tiles). Params: state=<id> holds one state,
// time=<s> freezes after that much simulated time (repeatable screenshots), hitboxes=1 overlays
// the simulation's hitboxes, weapon=<id>, cam=front|side|back.

interface StateDef {
  id: string;
  label: string;
  speed?: number;
  dir?: [number, number];
  sprint?: boolean;
  crouch?: number;
  ads?: number;
  pitch?: number;
  pitchWave?: boolean;
  air?: boolean;
  slide?: boolean;
  reload?: boolean;
  hit?: boolean;
  dead?: boolean;
  turn?: boolean;
}

export const ANIM_STATES: StateDef[] = [
  { id: 'idle', label: 'Idle (breathing)' },
  { id: 'walk', label: 'Walk forward', speed: 1.9, dir: [0, -1] },
  { id: 'back', label: 'Walk backward', speed: 1.5, dir: [0, 1] },
  { id: 'strafe', label: 'Strafe right', speed: 1.7, dir: [1, 0] },
  { id: 'diagonal', label: 'Walk forward-left', speed: 1.9, dir: [-0.7, -0.7] },
  { id: 'run', label: 'Run', speed: 4.8, dir: [0, -1] },
  { id: 'sprint', label: 'Sprint', speed: 6.6, dir: [0, -1], sprint: true },
  { id: 'turn', label: 'Turn in place', turn: true },
  { id: 'crouch', label: 'Crouch', crouch: 1 },
  { id: 'crouchwalk', label: 'Crouch walk', speed: 1.3, dir: [0, -1], crouch: 1 },
  { id: 'ads', label: 'Aim down sights', ads: 1, pitch: 0.05 },
  { id: 'aim', label: 'Aim up and down', pitchWave: true },
  { id: 'jump', label: 'Jump / in the air', air: true, speed: 4, dir: [0, -1] },
  { id: 'slide', label: 'Slide', slide: true, speed: 6, dir: [0, -1] },
  { id: 'reload', label: 'Reload', reload: true },
  { id: 'hit', label: 'Hit reaction', hit: true },
  { id: 'death', label: 'Death', dead: true },
];

export async function runAnimTest(canvas: HTMLCanvasElement): Promise<void> {
  const params = new URLSearchParams(location.search + '&' + (location.hash.split('?')[1] ?? ''));
  const quality = QUALITY_PRESETS.high;
  const renderer = new Renderer(canvas, { ...DEFAULT_RENDER_OPTIONS, quality, filmGrain: false, chromaticAberration: false, vignette: false });
  const assets = await Assets.create(renderer.gl, quality);
  const soldiers = assets.soldiers;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1e22);
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  assets.materials.setEnvMap(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), assets.materials.get('tileFloor'));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const uv = floor.geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 60, uv.getY(i) * 60);
  scene.add(floor);
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x2a2622, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
  sun.position.set(3, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -4;
  sun.shadow.camera.right = sun.shadow.camera.top = 4;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  const weapon = params.get('weapon') ?? 'halberd';
  const views: { skin: SoldierSkin; view: SoldierView; p: RenderPlayer; hit: THREE.Group }[] = [];
  (['red', 'camo'] as const).forEach((skin, i) => {
    const view = new SoldierView(assets.materials, soldiers[skin], i as 0 | 1);
    scene.add(view.root);
    const p: RenderPlayer = {
      id: i, team: i as 0 | 1, name: skin, alive: true, x: (i - 0.5) * 1.3, y: 0, z: 0, vx: 0, vz: 0,
      yaw: Math.PI, pitch: 0, crouch: 0, slide: false, grounded: true, ads: 0, sprint: false,
      weapon, reloading: false, hp: 100, deathYaw: 0,
    };
    const hit = new THREE.Group();
    hit.visible = params.get('hitboxes') === '1';
    scene.add(hit);
    views.push({ skin, view, p, hit });
  });
  const wire = new THREE.MeshBasicMaterial({ color: 0x42ff9e, wireframe: true, transparent: true, opacity: 0.55 });

  const label = document.createElement('div');
  Object.assign(label.style, { position: 'fixed', left: '16px', top: '12px', color: '#e8eef0', font: '600 18px system-ui, sans-serif', textShadow: '0 1px 3px #000' });
  document.body.appendChild(label);

  const cam = new THREE.PerspectiveCamera(36, 16 / 9, 0.05, 100);
  renderer.setScenes(scene, cam);
  renderer.resize();

  let fixed = params.get('state');
  let freezeAt = params.has('time') ? Number(params.get('time')) : Infinity;
  let camMode = params.get('cam') ?? 'threequarter';
  let stateIdx = Math.max(0, ANIM_STATES.findIndex((s) => s.id === fixed));
  let stateT = 0;
  let simT = 0;
  const DUR = 3.2;
  const reset = () => {
    views.forEach((v, i) => Object.assign(v.p, { x: (i - 0.5) * 1.3, z: 0, alive: true, yaw: Math.PI, pitch: 0 }));
    stateT = 0;
  };
  const step = (dt: number) => {
    const s = ANIM_STATES[stateIdx];
    stateT += dt;
    simT += dt;
    for (const v of views) {
      const p = v.p;
      // movement directions are in the soldier's frame (they face the camera, +Z)
      const sp = s.speed ?? 0;
      const [dx, dz] = s.dir ?? [0, 0];
      p.vx = -dx * sp;
      p.vz = -dz * sp;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.sprint = !!s.sprint;
      p.crouch = s.crouch ?? 0;
      p.ads = s.ads ?? 0;
      p.pitch = s.pitchWave ? Math.sin(stateT * 1.6) * 0.9 : (s.pitch ?? 0);
      p.slide = !!s.slide;
      p.grounded = !s.air || stateT % 1.1 > 0.8;
      p.y = s.air && !p.grounded ? Math.sin(((stateT % 1.1) / 0.8) * Math.PI) * 0.55 : 0;
      p.reloading = !!s.reload && stateT % 2.2 < 1.9;
      p.alive = !s.dead || stateT < 0.6;
      p.deathYaw = 0;
      if (s.turn) p.yaw = Math.PI + Math.sin(stateT * 1.2) * 1.4;
      if (s.hit && Math.floor(stateT / 0.9) !== Math.floor((stateT - dt) / 0.9)) v.view.hit(Math.PI * Math.random() * 2);
      v.view.update(p, dt);
      // hitboxes from the simulation, as the host sees them
      if (v.hit.visible) {
        v.hit.clear();
        const hb = buildHitboxes({ x: p.x, y: p.y, z: p.z, crouch: p.crouch, slide: p.slide, yaw: p.yaw });
        const head = new THREE.Mesh(new THREE.SphereGeometry(hb.head.r, 12, 8), wire);
        head.position.set(hb.head.x, hb.head.y, hb.head.z);
        v.hit.add(head);
        for (const [, c] of hb.parts) {
          const cap = new THREE.Mesh(new THREE.CapsuleGeometry(c.r, Math.max(0.01, c.by - c.ay), 4, 12), wire);
          cap.position.set(c.ax, (c.ay + c.by) / 2, c.az);
          v.hit.add(cap);
        }
      }
    }
    if (!fixed && stateT > DUR) {
      stateIdx = (stateIdx + 1) % ANIM_STATES.length;
      reset();
    }
    label.textContent = `${ANIM_STATES[stateIdx].label}   ·   black-and-red  |  woodland camo`;
  };
  (window as unknown as { __animtest: unknown }).__animtest = {
    states: ANIM_STATES.map((s) => s.id),
    /** Holds `id` and freezes after `time` seconds of it (for screenshots). */
    camera(mode: string) {
      camMode = mode;
    },
    show(id: string, time: number) {
      fixed = id;
      stateIdx = Math.max(0, ANIM_STATES.findIndex((s) => s.id === id));
      reset();
      simT = 0;
      freezeAt = time;
      for (const v of views) v.view.update(v.p, 0);
    },
    views,
    hitboxes(on: boolean) {
      for (const v of views) v.hit.visible = on;
    },
  };
  let frames = 0;
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now;
    if (simT < freezeAt) {
      // fixed steps keep frozen captures repeatable
      if (Number.isFinite(freezeAt)) {
        while (simT < freezeAt) step(1 / 60);
      } else step(dt);
    }
    const cx = (views[0].p.x + views[1].p.x) / 2;
    const cz = (views[0].p.z + views[1].p.z) / 2;
    const s = ANIM_STATES[stateIdx];
    const low = s.crouch || s.slide || s.dead ? 0.75 : 1.05;
    if (camMode === 'side') cam.position.set(cx + 5.2, 1.2, cz);
    else if (camMode === 'back') cam.position.set(cx + 0.6, 1.4, cz - 5);
    else if (camMode === 'front') cam.position.set(cx + 0.9, 1.35, cz + 5);
    else cam.position.set(cx + 3.6, 1.45, cz + 3.9);
    cam.lookAt(cx, low, cz);
    sun.position.set(cx + 3, 6, cz + 4);
    sun.target.position.set(cx, 0, cz);
    renderer.render(1 / 60);
    (window as unknown as { __frames: number }).__frames = ++frames;
    requestAnimationFrame(loop);
  };
  reset();
  loop();
}
