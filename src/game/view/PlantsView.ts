import * as THREE from 'three';
import type { MaterialLibrary } from '@/assets/materials';
import type { PlantKind, PlantPlacement } from '@/game/world/mapTypes';
import { applyWind, buildLeafAtlas, buildPlant, WIND } from '@/assets/models/plants';

// Plants drawn as a few BatchedMeshes: every (kind, variant) shape is uploaded once and each plant
// is an instance, so the whole jungle costs one draw call per material per pass, with per-plant
// frustum culling (shadow passes included). Leaves share one alpha-tested, wind-swayed material;
// trunks use bark. Ground cover is split off: it casts no shadows and fades out with distance.

const TRUNK_MAT: Record<PlantKind, string> = {
  fern: 'bark',
  treeFern: 'bark',
  palm: 'palmBark',
  banana: 'palmBark',
  monstera: 'bark',
  bush: 'bark',
  grass: 'bark',
  buttress: 'bark',
};

/** Big plants cast shadows; ground cover only receives (it would cost more than it shows). */
const CASTS: Record<PlantKind, boolean> = { fern: false, treeFern: true, palm: true, banana: true, monstera: false, bush: false, grass: false, buttress: true };

/** Ground cover farther than this from the camera isn't drawn (in the rain and dark it's invisible anyway). */
const GROUND_RANGE = 34;

interface Batch {
  mesh: THREE.BatchedMesh;
  geoIds: Map<string, number>;
}

export class PlantsView {
  readonly group = new THREE.Group();
  private leafMat: THREE.MeshStandardMaterial;
  /** Ground cover instances (for distance culling): instance id, x, z. */
  private ground: { id: number; x: number; z: number }[] = [];
  private groundMesh: THREE.BatchedMesh | null = null;
  private lastCull = new THREE.Vector3(1e9, 0, 0);
  /**
   * Shadow cameras the trees render into (the moon's). Fixture spot lights skip them: a
   * floodlight's frustum takes in dozens of trees, each drawn again per light per frame.
   * Null = every shadow-casting light.
   */
  shadowCameras: Set<THREE.Camera> | null = null;

  constructor(plants: PlantPlacement[], lib: MaterialLibrary, opts: { density: number } = { density: 1 }) {
    this.group.name = 'plants';
    const atlas = buildLeafAtlas(1024);
    this.leafMat = new THREE.MeshStandardMaterial({
      name: 'leaves',
      map: atlas.map,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.42,
      metalness: 0,
      envMapIntensity: 0.55,
    });
    applyWind(this.leafMat);
    lib.adopt('leaves', this.leafMat);
    // ground cover thins out on low quality (keep every big plant: they block and hide)
    const keep = (p: PlantPlacement, i: number) => CASTS[p.kind] || opts.density >= 1 || (i * 2654435761) % 1000 < opts.density * 1000;
    const kept = plants.filter(keep);
    const shapes = new Map<string, ReturnType<typeof buildPlant>>();
    const shapeOf = (p: PlantPlacement) => {
      const k = `${p.kind}|${p.v}`;
      let s = shapes.get(k);
      if (!s) shapes.set(k, (s = buildPlant(p.kind, p.v)));
      return s;
    };
    // one batch per (material, casts shadows)
    const plan = new Map<string, { mat: THREE.Material; cast: boolean; part: 'leaves' | 'trunk'; items: PlantPlacement[] }>();
    for (const p of kept) {
      const s = shapeOf(p);
      const cast = CASTS[p.kind];
      if (s.leaves) {
        const k = `leaves|${cast}`;
        if (!plan.has(k)) plan.set(k, { mat: this.leafMat, cast, part: 'leaves', items: [] });
        plan.get(k)!.items.push(p);
      }
      if (s.trunk) {
        const k = `${TRUNK_MAT[p.kind]}|${cast}`;
        if (!plan.has(k)) plan.set(k, { mat: lib.get(TRUNK_MAT[p.kind]), cast, part: 'trunk', items: [] });
        plan.get(k)!.items.push(p);
      }
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const pos = new THREE.Vector3();
    for (const [key, b] of plan) {
      // size the buffers: every distinct shape once
      const used = new Map<string, THREE.BufferGeometry>();
      for (const p of b.items) {
        const g = shapeOf(p)[b.part];
        if (g) used.set(`${p.kind}|${p.v}`, g);
      }
      let verts = 0;
      let idx = 0;
      for (const g of used.values()) {
        verts += g.getAttribute('position').count;
        idx += g.index ? g.index.count : 0;
      }
      const batch: Batch = { mesh: new THREE.BatchedMesh(b.items.length, verts, idx, b.mat), geoIds: new Map() };
      for (const [k, g] of used) batch.geoIds.set(k, batch.mesh.addGeometry(g));
      for (const p of b.items) {
        const id = batch.mesh.addInstance(batch.geoIds.get(`${p.kind}|${p.v}`)!);
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.rot);
        sc.setScalar(p.scale);
        pos.set(p.pos[0], p.pos[1], p.pos[2]);
        batch.mesh.setMatrixAt(id, m4.compose(pos, q, sc));
        if (!b.cast && b.part === 'leaves') this.ground.push({ id, x: p.pos[0], z: p.pos[2] });
      }
      const mesh = batch.mesh;
      if (b.cast) {
        const cull = mesh.onBeforeShadow.bind(mesh);
        mesh.onBeforeShadow = (renderer, object, camera, shadowCamera, geometry, depthMaterial, group) => {
          cull(renderer, object, camera, shadowCamera, geometry, depthMaterial, group);
          // BatchedMesh draws _multiDrawCount ranges; none for lights the trees don't shadow
          if (this.shadowCameras && !this.shadowCameras.has(shadowCamera)) (mesh as unknown as { _multiDrawCount: number })._multiDrawCount = 0;
        };
      }
      mesh.castShadow = b.cast;
      mesh.receiveShadow = true;
      if (!b.cast) {
        mesh.userData.shadowExempt = 'ground cover: receives shadows only';
        if (b.part === 'leaves') this.groundMesh = mesh;
      }
      mesh.name = `plants:${key}`;
      this.group.add(mesh);
    }
    for (const s of shapes.values()) {
      s.leaves?.dispose();
      s.trunk?.dispose();
    }
  }

  /** Wind time, and ground cover culled by distance (re-checked after the camera moves a meter). */
  update(t: number, camera?: THREE.Camera): void {
    WIND.uTime.value = t;
    if (!camera || !this.groundMesh) return;
    const c = camera.position;
    if (Math.abs(c.x - this.lastCull.x) + Math.abs(c.z - this.lastCull.z) < 1) return;
    this.lastCull.copy(c);
    const r2 = GROUND_RANGE * GROUND_RANGE;
    for (const g of this.ground) this.groundMesh.setVisibleAt(g.id, (g.x - c.x) ** 2 + (g.z - c.z) ** 2 < r2);
  }
}
