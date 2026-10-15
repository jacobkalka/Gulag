import * as THREE from 'three';
import type { Brush, DecalDef, MapDef, PropPlacement, Ramp } from '@/game/world/mapTypes';
import type { MaterialLibrary } from '@/assets/materials';
import { PROPS } from '@/assets/models/props';
import { decalTexture, heightToNormalTexture, paintNormalTexture, radialTexture } from '@/assets/textures/canvasTextures';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LightRig } from './lighting/LightRig';
import { BakedProbes } from './lighting/ProbeBaker';
import { Atmosphere } from './Atmosphere';
import type { QualityPreset } from '@/engine/quality';
import { CollisionWorld } from '@/game/world/collision';
import { DecalLayer, scatterDecals } from './Decals';
import { scatterClutter } from './Clutter';
import { DECAL_CELLS } from '@/assets/textures/decalAtlas';
import { bindWetMask, buildWetMask, type WetMask, type WetSource } from '@/engine/surfaceFx';

// Builds the renderable map from a MapDef: merged static geometry per material,
// props, decals, light fixtures (via LightRig), baked probes and atmosphere.

interface Bucket {
  pos: number[];
  nrm: number[];
  uv: number[];
}

function bucket(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) map.set(key, (b = { pos: [], nrm: [], uv: [] }));
  return b;
}

/** Appends a quad (a,b,c,d counter-clockwise seen from the normal side). */
function quad(b: Bucket, a: number[], bb: number[], c: number[], d: number[], n: number[], uvs: number[][]): void {
  const tri = [a, bb, c, a, c, d];
  const tuv = [uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]];
  for (let i = 0; i < 6; i++) {
    b.pos.push(tri[i][0], tri[i][1], tri[i][2]);
    b.nrm.push(n[0], n[1], n[2]);
    b.uv.push(tuv[i][0], tuv[i][1]);
  }
}

function tri(b: Bucket, a: number[], bb: number[], c: number[], n: number[], uvs: number[][]): void {
  for (const [p, t] of [[a, uvs[0]], [bb, uvs[1]], [c, uvs[2]]] as const) {
    b.pos.push(p[0], p[1], p[2]);
    b.nrm.push(n[0], n[1], n[2]);
    b.uv.push(t[0], t[1]);
  }
}

function brushFaces(br: Brush, buckets: Map<string, Bucket>, shadowKey: string): void {
  const [x0, y0, z0] = br.min;
  const [x1, y1, z1] = br.max;
  const side = br.sides ?? br.mat;
  const topM = br.top ?? br.mat;
  const botM = br.bottom ?? br.mat;
  const k = (m: string) => `${m}|${shadowKey}`;
  // +X
  quad(bucket(buckets, k(side)), [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [[-z1, y0], [-z0, y0], [-z0, y1], [-z1, y1]]);
  // -X
  quad(bucket(buckets, k(side)), [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
  // +Z
  quad(bucket(buckets, k(side)), [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  // -Z
  quad(bucket(buckets, k(side)), [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [[-x1, y0], [-x0, y0], [-x0, y1], [-x1, y1]]);
  // +Y (top)
  quad(bucket(buckets, k(topM)), [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [[x0, -z1], [x1, -z1], [x1, -z0], [x0, -z0]]);
  // -Y (bottom) - skip for floor-resting brushes
  if (y0 > 0.01) quad(bucket(buckets, k(botM)), [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
}

function rampFaces(r: Ramp, buckets: Map<string, Bucket>): void {
  const [x0, y0, z0] = r.min;
  const [x1, y1, z1] = r.max;
  const B = bucket(buckets, `${r.mat}|shadow`);
  // Heights at the four top corners
  const hAt = (x: number, z: number) => {
    if (r.axis === 'x') return r.dir > 0 ? y0 + ((x - x0) / (x1 - x0)) * (y1 - y0) : y0 + ((x1 - x) / (x1 - x0)) * (y1 - y0);
    return r.dir > 0 ? y0 + ((z - z0) / (z1 - z0)) * (y1 - y0) : y0 + ((z1 - z) / (z1 - z0)) * (y1 - y0);
  };
  const a = [x0, hAt(x0, z1), z1];
  const b = [x1, hAt(x1, z1), z1];
  const c = [x1, hAt(x1, z0), z0];
  const d = [x0, hAt(x0, z0), z0];
  const n = new THREE.Vector3().crossVectors(new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2])).normalize();
  if (n.y < 0) n.negate();
  // sloped top: UVs along the slope length
  const slopeLen = r.axis === 'x' ? Math.hypot(x1 - x0, y1 - y0) : Math.hypot(z1 - z0, y1 - y0);
  if (r.axis === 'x') quad(B, a, b, c, d, [n.x, n.y, n.z], [[0, -z1], [slopeLen, -z1], [slopeLen, -z0], [0, -z0]]);
  else quad(B, a, b, c, d, [n.x, n.y, n.z], [[x0, slopeLen], [x1, slopeLen], [x1, 0], [x0, 0]]);
  // sides (triangles / quads) - simple: vertical faces from floor to top edge
  const side = (p: number[], q: number[], nn: number[]) => {
    // vertical quad from y0 to the top edge between p and q
    quad(B, [p[0], y0, p[2]], [q[0], y0, q[2]], q, p, nn, [[0, y0], [1, y0], [1, q[1]], [0, p[1]]]);
  };
  side(a, b, [0, 0, 1]);
  side(c, d, [0, 0, -1]);
  side(b, c, [1, 0, 0]);
  side(d, a, [-1, 0, 0]);
  void tri;
}

function bucketGeo(b: Bucket): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  return g;
}

/** Merges geometries that may differ in indexing / attribute sets (normalizes to position/normal/uv). */
function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const norm = list.map((g) => {
    let n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
    if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
    if (!n.getAttribute('normal')) n.computeVertexNormals();
    n.morphAttributes = {};
    n = n as THREE.BufferGeometry;
    return n;
  });
  const out = mergeGeometries(norm, false);
  if (!out) throw new Error('merge failed');
  out.computeBoundingSphere();
  for (const g of norm) g.dispose();
  return out;
}

export class MapView {
  readonly root = new THREE.Group();
  readonly lights: LightRig;
  readonly probes: BakedProbes;
  readonly atmosphere: Atmosphere;
  readonly map: MapDef;
  decals: DecalLayer | null = null;
  private puddleMat: THREE.MeshStandardMaterial | null = null;
  private camDir = new THREE.Vector3();
  readonly wetMask: WetMask;
  /** Materials created here rather than in the library (decals, puddles, signs). */
  private ownMats: THREE.MeshStandardMaterial[] = [];

  constructor(map: MapDef, lib: MaterialLibrary, quality: QualityPreset, opts: { activeTags?: string[]; world?: CollisionWorld } = {}) {
    this.map = map;
    this.root.name = 'map';
    const tags = new Set(opts.activeTags ?? []);
    // Static geometry is merged into per-(material, zone chunk, shadow) batches so the whole
    // map draws in roughly (materials x 9) calls while keeping coarse frustum culling.
    const batches = new Map<string, { mat: THREE.Material; cast: boolean; exempt: string; geos: THREE.BufferGeometry[] }>();
    const chunkOf = (x: number, z: number) => (z < -6 ? 0 : z > 6 ? 2 : 1) * 3 + (x < -9 ? 0 : x > 9 ? 2 : 1);
    const addGeo = (mat: THREE.Material, cast: boolean, chunk: number, g: THREE.BufferGeometry, exempt = '') => {
      const key = `${mat.uuid}|${chunk}|${cast ? 1 : 0}|${exempt}`;
      let b = batches.get(key);
      if (!b) batches.set(key, (b = { mat, cast, exempt, geos: [] }));
      b.geos.push(g);
    };
    // ---- brushes
    for (const br of map.brushes) {
      if (br.visible === false) continue;
      if (br.tag && !tags.has(br.tag)) continue;
      const buckets = new Map<string, Bucket>();
      brushFaces(br, buckets, br.shadow === false ? 'noshadow' : 'shadow');
      const chunk = chunkOf((br.min[0] + br.max[0]) / 2, (br.min[2] + br.max[2]) / 2);
      for (const [key, b] of buckets) addGeo(lib.get(key.split('|')[0]), br.shadow !== false, chunk, bucketGeo(b), br.shadow === false ? 'brush flagged shadow:false (see map data)' : '');
    }
    for (const r of map.ramps) {
      const buckets = new Map<string, Bucket>();
      rampFaces(r, buckets);
      const chunk = chunkOf((r.min[0] + r.max[0]) / 2, (r.min[2] + r.max[2]) / 2);
      for (const [key, b] of buckets) addGeo(lib.get(key.split('|')[0]), true, chunk, bucketGeo(b));
    }
    // ---- props (static: transformed into world space and merged)
    const cache = new Map<string, THREE.Group>();
    const m4 = new THREE.Matrix4();
    const mergeObject = (obj: THREE.Object3D, chunk: number) => {
      obj.updateMatrixWorld(true);
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry.clone();
        m4.copy(mesh.matrixWorld);
        g.applyMatrix4(m4);
        addGeo(mesh.material as THREE.Material, mesh.castShadow, chunk, g, mesh.castShadow ? '' : (mesh.userData.shadowExempt as string) || 'prop part without shadows');
      });
    };
    const placeProp = (p: PropPlacement) => {
      const def = PROPS[p.type];
      if (!def) return;
      const key = `${p.type}:${p.v ?? 0}`;
      let src = def.cacheable ? cache.get(key) : undefined;
      if (!src) {
        src = def.build(lib, p.v ?? 0);
        if (def.cacheable) cache.set(key, src);
      }
      const holder = new THREE.Group();
      holder.position.set(...p.pos);
      holder.rotation.y = p.rot ?? 0;
      if (p.scale) holder.scale.setScalar(p.scale);
      holder.add(src);
      mergeObject(holder, chunkOf(p.pos[0], p.pos[2]));
      holder.remove(src);
    };
    for (const p of map.props) {
      if (p.tag && !tags.has(p.tag)) continue;
      placeProp(p);
    }
    for (const g of cache.values()) g.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
    cache.clear();
    // ---- lights: steady fixtures merge into the static batches, flickering ones stay separate
    this.lights = new LightRig(lib, map.lights, {
      points: quality.fixtureLights,
      shadowSpots: quality.shadows ? quality.shadowedSpots : 0,
      shadowSize: quality.spotShadowSize,
      shadowUpdates: quality.shadowUpdates,
    });
    for (const f of this.lights.staticFixtures) mergeObject(f.group, chunkOf(f.x, f.z));
    this.root.add(this.lights.group);
    // ---- puddles merged into one mesh; signs keep their own canvas textures
    const puddles: THREE.BufferGeometry[] = [];
    for (const d of map.decals) {
      if (d.kind === 'puddle') {
        const o = this.buildDecal(d, lib) as THREE.Mesh;
        o.updateMatrix();
        puddles.push(o.geometry.clone().applyMatrix4(o.matrix));
        continue;
      }
      this.root.add(this.buildDecal(d, lib));
    }
    if (puddles.length && this.puddleMat) {
      const pm = new THREE.Mesh(mergeGeos(puddles), this.puddleMat);
      pm.renderOrder = 2;
      pm.receiveShadow = true;
      pm.userData.shadowExempt = 'decal: puddles receive shadows, a flat film never casts';
      this.root.add(pm);
    }
    // ---- grime, streaks, stains: seeded so every player sees the same wear
    const world = opts.world ?? CollisionWorld.fromMap(map, [...tags]);
    // ---- loose clutter along the walls (seeded, view only), merged like the props
    for (const c of scatterClutter(map, world, hashSeed(map.id), tags, quality.clutter)) placeProp(c);
    for (const g of cache.values()) g.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
    cache.clear();
    const grime = scatterDecals(map, world, hashSeed(map.id), tags, quality.grimeDecals);
    if (grime.length) {
      this.decals = new DecalLayer(lib.decalAtlas(), grime);
      this.ownMats.push(this.decals.mesh.material as THREE.MeshStandardMaterial);
      this.root.add(this.decals.mesh);
    }
    // ---- wet floors: around puddles, under sky openings, below leaks running down walls
    const wet: WetSource[] = [];
    for (const d of map.decals) {
      if (d.kind !== 'puddle') continue;
      const r = Math.max(d.size[0], d.size[1]) * 0.5;
      wet.push({ x: d.pos[0], z: d.pos[2], r: r * 1.1, soft: r * 1.4 + 0.6, wet: 1 });
    }
    for (const g of grime) {
      if (g.normal.y > 0.5 || (g.cell !== DECAL_CELLS.leak && g.cell !== DECAL_CELLS.drip)) continue;
      wet.push({ x: g.pos.x + g.normal.x * 0.35, z: g.pos.z + g.normal.z * 0.35, r: g.w * 0.3, soft: 0.7, wet: 0.85 });
    }
    const holes = map.skyHoles.map((h) => ({ min: [h.min[0], h.min[2]] as [number, number], max: [h.max[0], h.max[2]] as [number, number], wet: 0.6, soft: 1.2 }));
    this.wetMask = buildWetMask(map.bounds, wet, holes, map.wetMaxY ?? 0.6);
    // ---- build batches
    for (const b of batches.values()) {
      const mesh = new THREE.Mesh(mergeGeos(b.geos), b.mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = true;
      if (!b.cast) mesh.userData.shadowExempt = b.exempt || 'static batch without shadows';
      mesh.matrixAutoUpdate = false;
      mesh.name = `static:${b.mat.name}`;
      this.root.add(mesh);
    }
    // baked bounce light from every fixture (and the moon through the roof)
    this.probes = new BakedProbes(map, world, map.lights, {
      spacing: 1.0,
      bounce: 0.22,
      floor: [0.003, 0.0034, 0.0042],
      moon: { color: 0x9db4ff, irradiance: 1.1 },
    });
    this.root.add(this.probes.grid);
    this.atmosphere = new Atmosphere(map, {
      shadows: quality.shadows,
      shadowSize: quality.sunShadowSize,
      lightShafts: quality.lightShafts,
      particleScale: quality.particleScale,
    });
    this.root.add(this.atmosphere.group);
    this.root.updateMatrixWorld(true);
  }

  private buildDecal(d: DecalDef, lib: MaterialLibrary): THREE.Object3D {
    const geo = new THREE.PlaneGeometry(d.size[0], d.size[1]);
    let mat: THREE.Material;
    if (d.kind === 'puddle') {
      if (!this.puddleMat) {
        const t = puddleTextures();
        this.puddleMat = new THREE.MeshStandardMaterial({
          name: 'puddle',
          map: t.map,
          normalMap: t.normalMap,
          normalScale: new THREE.Vector2(0.07, 0.07),
          roughnessMap: t.roughMap,
          roughness: 1,
          metalness: 0.0,
          transparent: true,
          opacity: 0.88,
          alphaMap: t.alphaMap,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          envMapIntensity: 1.6,
        });
        this.ownMats.push(this.puddleMat);
      }
      mat = this.puddleMat;
    } else {
      const tex = decalTexture({
        text: d.text ?? '',
        color: d.color ?? '#ddd',
        spray: d.kind === 'graffiti',
        w: 512,
        h: d.kind === 'number' ? 256 : 256,
      });
      mat = new THREE.MeshStandardMaterial({
        name: `decal:${d.kind}`,
        map: tex,
        normalMap: paintNormalTexture(tex.image as HTMLCanvasElement),
        normalScale: new THREE.Vector2(0.6, 0.6),
        transparent: true,
        depthWrite: false,
        roughness: 0.75,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        envMapIntensity: 0.6,
      });
      this.ownMats.push(mat as THREE.MeshStandardMaterial);
    }
    void lib;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...d.pos);
    const n = new THREE.Vector3(...d.normal).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    if (d.rot) mesh.rotateZ(d.rot);
    mesh.position.addScaledVector(n, 0.004);
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.userData.shadowExempt = 'decal: receives shadows, a flat overlay never casts';
    return mesh;
  }

  /** Reflection probe for the decals, puddles and signs built here (library materials get it from the library). */
  setEnvMap(env: THREE.Texture | null): void {
    for (const m of this.ownMats) {
      m.envMap = env;
      m.needsUpdate = true;
    }
  }

  update(camera: THREE.Camera, t: number, dt: number): void {
    bindWetMask(this.wetMask);
    this.lights.update(camera.position, t, dt, camera.getWorldDirection(this.camDir));
    this.atmosphere.update(t);
  }
}

interface PuddleTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughMap: THREE.Texture;
  alphaMap: THREE.Texture;
}
let _puddle: PuddleTextures | null = null;
/**
 * Puddle film: near-black water with silt settling toward the rim, glossy in the middle and
 * rougher where it thins out, with faint ripples breaking up the reflections.
 */
function puddleTextures(): PuddleTextures {
  if (_puddle) return _puddle;
  const S = 256;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    return { c, g, img: g.createImageData(S, S) };
  };
  const alpha = mk();
  const albedo = mk();
  const rough = mk();
  const height = new Float32Array(S * S);
  // Irregular blob: radial falloff modulated by low-frequency noise.
  const n = (x: number, y: number) =>
    Math.sin(x * 3.1 + Math.sin(y * 2.3) * 1.7) * 0.5 + Math.sin(y * 4.7 + Math.sin(x * 1.9) * 2.1) * 0.35 + Math.sin((x + y) * 7.3) * 0.15;
  const waves = Array.from({ length: 13 }, (_, i) => {
    const a = i * 2.39996 + 0.3;
    return { dx: Math.cos(a), dy: Math.sin(a), f: 9 + i * 3.1 + (i % 3) * 2.3, ph: i * 1.7 };
  });
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S - 0.5;
      const v = y / S - 0.5;
      const r = Math.hypot(u, v) * 2;
      const a = 1 - smooth(0.45 + n(u * 6, v * 6) * 0.22, 0.95, r);
      const i = (y * S + x) * 4;
      alpha.img.data[i] = alpha.img.data[i + 1] = alpha.img.data[i + 2] = Math.max(0, Math.min(255, a * 255));
      alpha.img.data[i + 3] = 255;
      // silt toward the rim (where the film is thin), dark water in the middle
      const rim = 1 - smooth(0.0, 0.85, a);
      const grain = 0.85 + 0.15 * Math.sin(x * 1.37 + Math.sin(y * 0.71) * 3) * Math.sin(y * 1.13 - x * 0.29);
      albedo.img.data[i] = (11 + rim * 30) * grain;
      albedo.img.data[i + 1] = (12 + rim * 24) * grain;
      albedo.img.data[i + 2] = (13 + rim * 16) * grain;
      albedo.img.data[i + 3] = 255;
      const ro = 0.05 + rim * 0.45;
      rough.img.data[i] = rough.img.data[i + 1] = rough.img.data[i + 2] = ro * 255;
      rough.img.data[i + 3] = 255;
      let h = 0;
      for (const w of waves) h += Math.sin((u * w.dx + v * w.dy) * w.f + w.ph) / w.f;
      height[y * S + x] = h * 6 + rim * 0.6;
    }
  }
  const tex = (o: { c: HTMLCanvasElement; g: CanvasRenderingContext2D; img: ImageData }, srgb: boolean) => {
    o.g.putImageData(o.img, 0, 0);
    const t = new THREE.CanvasTexture(o.c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  _puddle = {
    map: tex(albedo, true),
    normalMap: heightToNormalTexture(height, S, S, 6),
    roughMap: tex(rough, false),
    alphaMap: tex(alpha, false),
  };
  return _puddle;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

void radialTexture;
