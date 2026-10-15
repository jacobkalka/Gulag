import * as THREE from 'three';
import { LightProbeGridWebGL } from 'three/examples/jsm/lighting/LightProbeGridWebGL.js';
import type { CollisionWorld } from '@/game/world/collision';
import type { LightDef, MapDef } from '@/game/world/mapTypes';
import { lightRadiance } from './lightKinds';

// Baked indirect light. Every map light (not just the few real-time ones near the camera) is
// projected into an L2 spherical-harmonics probe at each grid point, with ray-cast visibility,
// and scaled to a bounce-light level. The result fills three.js' light-probe grid, which every
// standard material samples: shadows pick up the tint of nearby lamps instead of going flat gray,
// far lights still glow on their surroundings, and characters are lit by where they stand.

export interface ProbeBakeOptions {
  /** Probe spacing (m). */
  spacing: number;
  /** Fraction of a light's direct irradiance that comes back as diffuse bounce. */
  bounce: number;
  /** Minimum ambient irradiance everywhere (readability floor), linear RGB. */
  floor: [number, number, number];
  /** Moonlight through sky openings (irradiance on a surface facing the moon). */
  moon?: { color: number; irradiance: number };
  /** Light from an overcast sky overhead (irradiance on an upward-facing surface in the open). */
  sky?: { color: number; irradiance: number };
  /** How much light gets through soft cover (tree crowns) from a probe toward a sky direction, 0..1. */
  shade?: (x: number, y: number, z: number, dir: THREE.Vector3) => number;
}

const UP = new THREE.Vector3(0, 1, 0);
/** SH of a uniform upper hemisphere per unit of up-facing irradiance: Y00 * 2, Y1(y) * 1. */
const SKY_C0 = 0.282095 * 2;
const SKY_C1 = 0.488603;

const SH_BASIS = new Float32Array(9);
/** SH basis for light arriving from straight below (floor bounce). */
const DOWN_BASIS = new Float32Array(9);
/**
 * Floor-bounce strength relative to the direct bounce lobe: a ceiling sees roughly the floor's
 * albedo times the floor irradiance (~0.3 E), which `bounce` (0.22) times this reproduces.
 */
const FLOOR_BOUNCE = 1.4;

/** Real SH basis (three.js SphericalHarmonics3 order) for a unit direction. */
function basis(x: number, y: number, z: number, out: Float32Array): void {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
}
basis(0, -1, 0, DOWN_BASIS);

/** L2 irradiance from SH coefficients (same constants as the three.js shader). */
export function shIrradiance(c: ArrayLike<number>, o: number, x: number, y: number, z: number, out: THREE.Color): THREE.Color {
  const e = (k: number) =>
    c[o + 0 * 3 + k] * 0.886227 +
    2 * 0.511664 * (c[o + 1 * 3 + k] * y + c[o + 2 * 3 + k] * z + c[o + 3 * 3 + k] * x) +
    2 * 0.429043 * (c[o + 4 * 3 + k] * x * y + c[o + 5 * 3 + k] * y * z + c[o + 7 * 3 + k] * x * z) +
    c[o + 6 * 3 + k] * (0.743125 * z * z - 0.247708) +
    0.429043 * c[o + 8 * 3 + k] * (x * x - y * y);
  return out.setRGB(Math.max(0, e(0)), Math.max(0, e(1)), Math.max(0, e(2)));
}

export class BakedProbes {
  readonly grid: LightProbeGridWebGL;
  readonly min = new THREE.Vector3();
  readonly max = new THREE.Vector3();
  readonly res = new THREE.Vector3();
  /** 27 floats per probe (9 RGB coefficients), x fastest, then y, then z. */
  readonly sh: Float32Array;
  readonly bakeMs: number;
  private tmp = new THREE.Color();

  constructor(map: MapDef, world: CollisionWorld, lights: LightDef[], opts: ProbeBakeOptions) {
    const t0 = performance.now();
    const b = map.bounds;
    const sp = opts.spacing;
    const nx = Math.min(96, Math.max(2, Math.round((b.max[0] - b.min[0]) / sp) + 1));
    const nz = Math.min(96, Math.max(2, Math.round((b.max[2] - b.min[2]) / sp) + 1));
    // from just above the lowest floor (basements) to head height on the highest walkways
    const bottom = Math.min(0, b.min[1] + 0.5) + 0.25;
    const top = Math.max(2.4, Math.min(b.max[1], 7.5));
    const ny = Math.min(12, Math.max(2, Math.round((top - bottom) / 1.1) + 1));
    this.min.set(b.min[0], bottom, b.min[2]);
    this.max.set(b.max[0], top, b.max[2]);
    this.res.set(nx, ny, nz);
    const n = nx * ny * nz;
    const sh = new Float32Array(n * 27);
    const valid = new Uint8Array(n);
    const step = new THREE.Vector3((this.max.x - this.min.x) / (nx - 1), (this.max.y - this.min.y) / (ny - 1), (this.max.z - this.min.z) / (nz - 1));
    const col = new THREE.Color();
    const moonDir = new THREE.Vector3(...map.moonDir).normalize().negate(); // toward the moon
    const moonCol = opts.moon ? new THREE.Color(opts.moon.color) : null;
    const skyCol = opts.sky ? new THREE.Color(opts.sky.color) : null;
    const lightCols = lights.map((l) => lightRadiance(l, new THREE.Color()));
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const idx = ix + iy * nx + iz * nx * ny;
          const px = this.min.x + ix * step.x;
          const py = this.min.y + iy * step.y;
          const pz = this.min.z + iz * step.z;
          if (world.cylinderBlocked(px, py - 0.02, pz, 0.03, 0.04)) continue;
          valid[idx] = 1;
          const floorY = world.supportHeight(px, pz, 0.05, py, 0, 12).y;
          const hasFloor = Number.isFinite(floorY);
          const o = idx * 27;
          for (let li = 0; li < lights.length; li++) {
            const L = lights[li];
            const dx = L.pos[0] - px;
            const dy = L.pos[1] - py;
            const dz = L.pos[2] - pz;
            const d2 = dx * dx + dy * dy + dz * dz;
            const reach = L.distance * 1.4;
            if (d2 > reach * reach) continue;
            const d = Math.sqrt(d2);
            // stop just short of the fixture so its own housing doesn't block the ray
            if (d > 0.3 && world.raycast(px, py, pz, dx / d, dy / d, dz / d, d - 0.25) !== null) continue;
            const win = Math.max(0, 1 - Math.pow(d / reach, 4));
            const e = (lightCols[li].r + lightCols[li].g + lightCols[li].b > 0 ? 1 : 0) * (win * win) / Math.max(d2, 0.35);
            if (e <= 0) continue;
            basis(dx / Math.max(d, 1e-4), dy / Math.max(d, 1e-4), dz / Math.max(d, 1e-4), SH_BASIS);
            col.copy(lightCols[li]).multiplyScalar(e * opts.bounce);
            for (let k = 0; k < 9; k++) {
              sh[o + k * 3] += col.r * SH_BASIS[k];
              sh[o + k * 3 + 1] += col.g * SH_BASIS[k];
              sh[o + k * 3 + 2] += col.b * SH_BASIS[k];
            }
            // light the fixture throws on the floor under this probe comes back up from below
            // (what lights ceilings and the undersides of things in a real room)
            const fy = hasFloor ? Math.max(0.01, L.pos[1] - floorY) : 0;
            const fd2 = (L.pos[0] - px) ** 2 + fy * fy + (L.pos[2] - pz) ** 2;
            const fw = Math.max(0, 1 - Math.pow(Math.sqrt(fd2) / reach, 4));
            const ef = hasFloor ? ((fw * fw) / Math.max(fd2, 0.35)) * (fy / Math.sqrt(fd2)) * FLOOR_BOUNCE : 0;
            if (ef > 0 && py > floorY + 0.05) {
              col.copy(lightCols[li]).multiplyScalar(ef * opts.bounce);
              for (let k = 0; k < 9; k++) {
                sh[o + k * 3] += col.r * DOWN_BASIS[k];
                sh[o + k * 3 + 1] += col.g * DOWN_BASIS[k];
                sh[o + k * 3 + 2] += col.b * DOWN_BASIS[k];
              }
            }
          }
          if (moonCol && opts.moon) {
            // sky visible along the moon direction?
            if (world.raycast(px, py, pz, moonDir.x, moonDir.y, moonDir.z, 60) === null) {
              const through = opts.shade ? opts.shade(px, py, pz, moonDir) : 1;
              basis(moonDir.x, moonDir.y, moonDir.z, SH_BASIS);
              col.copy(moonCol).multiplyScalar(opts.moon.irradiance * opts.bounce * through);
              for (let k = 0; k < 9; k++) {
                sh[o + k * 3] += col.r * SH_BASIS[k];
                sh[o + k * 3 + 1] += col.g * SH_BASIS[k];
                sh[o + k * 3 + 2] += col.b * SH_BASIS[k];
              }
            }
          }
          if (skyCol && opts.sky && world.raycast(px, py, pz, 0, 1, 0, 40) === null) {
            // open sky overhead, dimmed under the canopy: a uniformly bright upper hemisphere
            // projects onto the constant and the vertical terms only (E up = irradiance,
            // E sideways = half of it, E down = 0)
            const through = opts.shade ? opts.shade(px, py, pz, UP) : 1;
            col.copy(skyCol).multiplyScalar(opts.sky.irradiance * through);
            for (let ch = 0; ch < 3; ch++) {
              const e = ch === 0 ? col.r : ch === 1 ? col.g : col.b;
              sh[o + ch] += e * SKY_C0;
              sh[o + 3 + ch] += e * SKY_C1;
            }
          }
          // ambient floor: constant term only (the shader's irradiance from c0 is c0 * 0.886227)
          sh[o] += opts.floor[0] / 0.886227;
          sh[o + 1] += opts.floor[1] / 0.886227;
          sh[o + 2] += opts.floor[2] / 0.886227;
        }
      }
    }
    // probes inside walls take the average of their valid neighbors (repeat to grow into thick solids)
    for (let pass = 0; pass < 4; pass++) {
      const fill: number[] = [];
      for (let idx = 0; idx < n; idx++) {
        if (valid[idx]) continue;
        const ix = idx % nx;
        const iy = Math.floor(idx / nx) % ny;
        const iz = Math.floor(idx / (nx * ny));
        let cnt = 0;
        const acc = new Float32Array(27);
        for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const jx = ix + ox;
          const jy = iy + oy;
          const jz = iz + oz;
          if (jx < 0 || jy < 0 || jz < 0 || jx >= nx || jy >= ny || jz >= nz) continue;
          const j = jx + jy * nx + jz * nx * ny;
          if (!valid[j]) continue;
          for (let k = 0; k < 27; k++) acc[k] += sh[j * 27 + k];
          cnt++;
        }
        if (!cnt) continue;
        for (let k = 0; k < 27; k++) sh[idx * 27 + k] = acc[k] / cnt;
        fill.push(idx);
      }
      for (const idx of fill) valid[idx] = 1;
      if (!fill.length) break;
    }
    this.sh = sh;

    // Pack into the atlas layout the shader expects: 7 RGBA sub-volumes stacked along Z, each
    // with one padding slice at both ends.
    const depth = 7 * (nz + 2);
    const data = new Uint16Array(nx * ny * depth * 4);
    const put = (slice: number, ix: number, iy: number, v: [number, number, number, number]) => {
      const o = ((slice * ny + iy) * nx + ix) * 4;
      for (let k = 0; k < 4; k++) data[o + k] = THREE.DataUtils.toHalfFloat(v[k]);
    };
    const packed = (idx: number, t: number): [number, number, number, number] => {
      const c = (k: number, ch: number) => sh[idx * 27 + k * 3 + ch];
      switch (t) {
        case 0: return [c(0, 0), c(0, 1), c(0, 2), c(1, 0)];
        case 1: return [c(1, 1), c(1, 2), c(2, 0), c(2, 1)];
        case 2: return [c(2, 2), c(3, 0), c(3, 1), c(3, 2)];
        case 3: return [c(4, 0), c(4, 1), c(4, 2), c(5, 0)];
        case 4: return [c(5, 1), c(5, 2), c(6, 0), c(6, 1)];
        case 5: return [c(6, 2), c(7, 0), c(7, 1), c(7, 2)];
        default: return [c(8, 0), c(8, 1), c(8, 2), 0];
      }
    };
    for (let t = 0; t < 7; t++) {
      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const v = packed(ix + iy * nx + iz * nx * ny, t);
            put(t * (nz + 2) + 1 + iz, ix, iy, v);
            if (iz === 0) put(t * (nz + 2), ix, iy, v);
            if (iz === nz - 1) put(t * (nz + 2) + nz + 1, ix, iy, v);
          }
        }
      }
    }
    const tex = new THREE.Data3DTexture(data, nx, ny, depth);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.HalfFloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;

    const size = new THREE.Vector3().subVectors(this.max, this.min);
    this.grid = new LightProbeGridWebGL(size.x, size.y, size.z, nx, ny, nz);
    this.grid.position.addVectors(this.min, this.max).multiplyScalar(0.5);
    this.grid.updateBoundingBox();
    this.grid.texture = tex;
    this.bakeMs = Math.round(performance.now() - t0);
  }

  /** Irradiance at a world point for a surface facing `n` (trilinear, CPU side). */
  sample(p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color): THREE.Color {
    const r = this.res;
    const fx = THREE.MathUtils.clamp(((p.x - this.min.x) / (this.max.x - this.min.x)) * (r.x - 1), 0, r.x - 1);
    const fy = THREE.MathUtils.clamp(((p.y - this.min.y) / (this.max.y - this.min.y)) * (r.y - 1), 0, r.y - 1);
    const fz = THREE.MathUtils.clamp(((p.z - this.min.z) / (this.max.z - this.min.z)) * (r.z - 1), 0, r.z - 1);
    const x0 = Math.min(r.x - 2, Math.floor(fx));
    const y0 = Math.min(r.y - 2, Math.floor(fy));
    const z0 = Math.min(r.z - 2, Math.floor(fz));
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    out.setRGB(0, 0, 0);
    for (let k = 0; k < 8; k++) {
      const ox = k & 1;
      const oy = (k >> 1) & 1;
      const oz = (k >> 2) & 1;
      const w = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty) * (oz ? tz : 1 - tz);
      if (w <= 0) continue;
      const idx = x0 + ox + (y0 + oy) * r.x + (z0 + oz) * r.x * r.y;
      shIrradiance(this.sh, idx * 27, n.x, n.y, n.z, this.tmp);
      out.r += this.tmp.r * w;
      out.g += this.tmp.g * w;
      out.b += this.tmp.b * w;
    }
    return out;
  }

  dispose(): void {
    this.grid.texture?.dispose();
    this.grid.texture = null;
  }
}
