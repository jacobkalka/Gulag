import * as THREE from 'three';
import type { Brush, DecalDef, MapDef, Ramp } from '@/game/world/mapTypes';
import type { MaterialLibrary } from '@/assets/materials';
import { PROPS } from '@/assets/models/props';
import { decalTexture, radialTexture } from '@/assets/textures/canvasTextures';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LightManager } from './LightManager';
import { Atmosphere } from './Atmosphere';
import type { QualityPreset } from '@/engine/quality';

// Builds the renderable map from a MapDef: merged static geometry per material,
// props, decals, light fixtures (via LightManager) and atmosphere.

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
  readonly lights: LightManager;
  readonly atmosphere: Atmosphere;
  readonly map: MapDef;
  private puddleMat: THREE.MeshStandardMaterial | null = null;

  constructor(map: MapDef, lib: MaterialLibrary, quality: QualityPreset, opts: { activeTags?: string[] } = {}) {
    this.map = map;
    this.root.name = 'map';
    const tags = new Set(opts.activeTags ?? []);
    // Static geometry is merged into per-(material, zone chunk, shadow) batches so the whole
    // map draws in roughly (materials x 9) calls while keeping coarse frustum culling.
    const batches = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[] }>();
    const chunkOf = (x: number, z: number) => (z < -6 ? 0 : z > 6 ? 2 : 1) * 3 + (x < -9 ? 0 : x > 9 ? 2 : 1);
    const addGeo = (mat: THREE.Material, cast: boolean, chunk: number, g: THREE.BufferGeometry) => {
      const key = `${mat.uuid}|${chunk}|${cast ? 1 : 0}`;
      let b = batches.get(key);
      if (!b) batches.set(key, (b = { mat, cast, geos: [] }));
      b.geos.push(g);
    };
    // ---- brushes
    for (const br of map.brushes) {
      if (br.visible === false) continue;
      if (br.tag && !tags.has(br.tag)) continue;
      const buckets = new Map<string, Bucket>();
      brushFaces(br, buckets, br.shadow === false ? 'noshadow' : 'shadow');
      const chunk = chunkOf((br.min[0] + br.max[0]) / 2, (br.min[2] + br.max[2]) / 2);
      for (const [key, b] of buckets) addGeo(lib.get(key.split('|')[0]), br.shadow !== false, chunk, bucketGeo(b));
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
        addGeo(mesh.material as THREE.Material, mesh.castShadow, chunk, g);
      });
    };
    for (const p of map.props) {
      if (p.tag && !tags.has(p.tag)) continue;
      const def = PROPS[p.type];
      if (!def) continue;
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
    }
    for (const g of cache.values()) g.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
    // ---- lights: steady fixtures merge into the static batches, flickering ones stay separate
    this.lights = new LightManager(lib, map.lights, quality.fixtureLights, quality.shadows ? quality.shadowedSpots : 0, quality.spotShadowSize);
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
      this.root.add(pm);
    }
    // ---- build batches
    for (const b of batches.values()) {
      const mesh = new THREE.Mesh(mergeGeos(b.geos), b.mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `static:${b.mat.name}`;
      this.root.add(mesh);
    }
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
        this.puddleMat = new THREE.MeshStandardMaterial({
          color: 0x0b0c0d,
          roughness: 0.04,
          metalness: 0.0,
          transparent: true,
          opacity: 0.88,
          alphaMap: puddleAlpha(),
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          envMapIntensity: 1.6,
        });
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
        map: tex,
        transparent: true,
        depthWrite: false,
        roughness: 0.75,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        envMapIntensity: 0.6,
      });
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
    return mesh;
  }

  update(camera: THREE.Camera, t: number, dt: number): void {
    this.lights.update(camera.position, t, dt);
    this.atmosphere.update(t);
  }
}

let _puddle: THREE.Texture | null = null;
function puddleAlpha(): THREE.Texture {
  if (_puddle) return _puddle;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  // Irregular blob: radial falloff modulated by low-frequency noise.
  const n = (x: number, y: number) =>
    Math.sin(x * 3.1 + Math.sin(y * 2.3) * 1.7) * 0.5 + Math.sin(y * 4.7 + Math.sin(x * 1.9) * 2.1) * 0.35 + Math.sin((x + y) * 7.3) * 0.15;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S - 0.5;
      const v = y / S - 0.5;
      const r = Math.hypot(u, v) * 2;
      const a = 1 - smooth(0.45 + n(u * 6, v * 6) * 0.22, 0.95, r);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, a * 255));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  _puddle = new THREE.CanvasTexture(c);
  return _puddle;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

void radialTexture;
