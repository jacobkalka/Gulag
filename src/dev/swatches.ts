import * as THREE from 'three';
import { Renderer, DEFAULT_RENDER_OPTIONS } from '@/engine/Renderer';
import { QUALITY_PRESETS } from '@/engine/quality';
import { TextureFactory } from '@/assets/textures/TextureFactory';
import { RECIPES } from '@/assets/textures/recipes';
import { MaterialLibrary } from '@/assets/materials';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DecalLayer, type DecalInstance } from '@/game/view/Decals';
import { DECAL_CELLS } from '@/assets/textures/decalAtlas';
import { PROPS } from '@/assets/models/props';

// Dev page: every procedural material on a sphere + a flat tile under a key light.
export async function runSwatches(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = new Renderer(canvas, { ...DEFAULT_RENDER_OPTIONS, quality: QUALITY_PRESETS.high, filmGrain: false, chromaticAberration: false, vignette: false });
  const t0 = performance.now();
  const tf = new TextureFactory(renderer.gl, 512, 512, 8);
  await tf.generateAll(RECIPES);
  const genMs = performance.now() - t0;
  const lib = new MaterialLibrary(tf);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15181b);
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  lib.setEnvMap(env);
  if (location.hash.includes('decals')) {
    decalBoard(scene, lib, renderer);
  } else if (location.hash.includes('props')) {
    propBoard(scene, lib);
  } else layoutSwatches(scene, lib);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-3, 4, 5);
  scene.add(key);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  cam.position.set(0, 0.2, 9.5);
  if (location.hash.includes('props')) {
    cam.position.set(0, 1.6, 4.2);
    cam.lookAt(0, -1.7, -2.4);
  }
  renderer.setScenes(scene, cam);
  renderer.resize();
  (window as any).__stats = { genMs: Math.round(genMs) };
  let frames = 0;
  const loop = () => {
    renderer.render(1 / 60);
    (window as any).__frames = ++frames;
    requestAnimationFrame(loop);
  };
  loop();
}

/** #/swatches/decals: every decal atlas cell on a concrete wall (top) and a floor tile (bottom). */
function decalBoard(scene: THREE.Scene, lib: MaterialLibrary, renderer: Renderer): void {
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(9, 5.4), lib.get('plasterCream'));
  const uv = wall.geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 9, uv.getY(k) * 5.4);
  scene.add(wall);
  const list: DecalInstance[] = [];
  const names = Object.keys(DECAL_CELLS) as (keyof typeof DECAL_CELLS)[];
  names.forEach((n, i) => {
    const x = (i % 8) - 3.5;
    const y = i < 8 ? 1.2 : -1.2;
    list.push({ pos: new THREE.Vector3(x * 1.08, y, 0.01), normal: new THREE.Vector3(0, 0, 1), rot: 0, w: 1, h: 2, cell: DECAL_CELLS[n], opacity: 1 });
  });
  const layer = new DecalLayer(lib.decalAtlas(), list);
  scene.add(layer.mesh);
  void renderer;
}

/** #/swatches/props: every variant of the common props on a concrete floor. */
function propBoard(scene: THREE.Scene, lib: MaterialLibrary): void {
  const rows: [string, number[]][] = [
    ['crate', [0, 1, 2, 3, 4]],
    ['crateSmall', [0, 1, 2]],
    ['barrel', [0, 1, 2, 3, 4, 7]],
    ['bench', [0, 1]],
  ];
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 9), lib.get('floor'));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -2.2, -1.5);
  scene.add(floor);
  rows.forEach(([type, vs], r) => {
    vs.forEach((v, i) => {
      const g = PROPS[type].build(lib, v);
      g.position.set((i - (vs.length - 1) / 2) * 1.5, -2.2, -4 + r * 1.6);
      g.rotation.y = 0.5;
      scene.add(g);
    });
  });
}

function layoutSwatches(scene: THREE.Scene, lib: MaterialLibrary): void {
  const cols = 8;
  RECIPES.forEach((r, i) => {
    const x = (i % cols) - (cols - 1) / 2;
    const y = -Math.floor(i / cols) + 1.5;
    const m = lib.get(r.id === 'rubber' ? 'rubberMat' : r.id);
    const sph = new THREE.Mesh(new THREE.SphereGeometry(0.28, 48, 32), m);
    sph.position.set(x * 1.05 - 0.2, y * 1.0, 0);
    scene.add(sph);
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), m);
    tile.position.set(x * 1.05 + 0.27, y * 1.0, 0);
    // scale UVs so the tile shows ~1 texture repeat
    const uv = tile.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * r.tileMeters, uv.getY(k) * r.tileMeters);
    scene.add(tile);
  });
}
