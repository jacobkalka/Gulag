import * as THREE from 'three';
import type { LightDef } from '@/game/world/mapTypes';
import type { MaterialLibrary } from '@/assets/materials';
import { buildFixture } from '@/assets/models/props';
import { radialTexture } from '@/assets/textures/canvasTextures';
import { INTENSITY_SCALE, lightColor } from './lightKinds';

// The map's fixtures carry the scene. A forward renderer can't afford dozens of real lights, so:
//  - a pool of shadow-casting spot lights (2-8 by quality) follows the most important fixtures
//    near the camera, fading smoothly as assignments change, with shadow maps refreshed on a
//    staggered budget (moving lights every frame, the rest round-robin);
//  - a pool of unshadowed point lights covers the next most important fixtures;
//  - every fixture keeps its HDR emissive, a soft halo sprite, and optionally a fake volumetric
//    cone, so lights outside the pools still read as light sources (their indirect light is in
//    the baked probes).
// Behaviors: flicker/buzz/dying styles, dead fixtures, lamps swinging on chains (moving light
// and shadows), rotating searchlights/beacons. Light counts never change, so no shader recompiles.

export interface LightRigOptions {
  points: number;
  shadowSpots: number;
  shadowSize: number;
  /** Shadow maps re-rendered per frame (beyond moving lights). */
  shadowUpdates: number;
}

interface FixtureState {
  def: LightDef;
  color: THREE.Color;
  /** Visible fixture model (pivot for swinging lamps) when it animates, else null (static batch). */
  model: THREE.Object3D | null;
  emissive: THREE.MeshStandardMaterial[];
  base: number[];
  /** Current emitter position and light direction (animated for swing/spin). */
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  flick: number;
  moving: boolean;
}

interface Slot {
  def: number;
  w: number;
}

const HALO_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute float iSize;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = iColor;
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  // pull the halo a little toward the camera so it isn't clipped by the fixture housing
  mv.xyz += normalize(-mv.xyz) * min(0.25, iSize * 0.3);
  mv.xy += position.xy * iSize;
  gl_Position = projectionMatrix * mv;
}`;

const HALO_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uGain;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float a = texture2D(uMap, vUv).a;
  // hot core + soft wide falloff
  float r = length(vUv - 0.5) * 2.0;
  float core = exp(-r * r * 18.0);
  vec3 c = vColor.rgb * vColor.a * uGain * (a * 0.55 + core * 1.6);
  gl_FragColor = vec4(c, 1.0);
}`;

const CONE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iColor;
attribute vec2 iShape; // length, radius at the far end
varying vec3 vLocal;
varying vec4 vColor;
varying vec3 vWorld;
varying vec3 vAxis;
varying vec3 vApex;
vec3 rotq(vec3 v, vec4 q) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vLocal = position; // unit cone: apex at origin, opening along -Y to y = -1, radius 1 at the base
  vColor = iColor;
  vec3 p = vec3(position.x * iShape.y, position.y * iShape.x, position.z * iShape.y);
  vec3 w = rotq(p, iQuat) + iPos;
  vWorld = w;
  vAxis = rotq(vec3(0.0, -1.0, 0.0), iQuat);
  vApex = iPos;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const CONE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGain;
varying vec3 vLocal;
varying vec4 vColor;
varying vec3 vWorld;
varying vec3 vAxis;
varying vec3 vApex;
float n3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(n3(i), n3(i + vec3(1,0,0)), f.x), mix(n3(i + vec3(0,1,0)), n3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(n3(i + vec3(0,0,1)), n3(i + vec3(1,0,1)), f.x), mix(n3(i + vec3(0,1,1)), n3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main() {
  float along = clamp(-vLocal.y, 0.0, 1.0);
  float radial = length(vLocal.xz) / max(along, 0.001);
  // soft edges (fresnel against the view), fade with distance from the apex
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vWorld - (vApex + vAxis * dot(vWorld - vApex, vAxis)));
  float edge = pow(abs(dot(n, v)), 1.6);
  float fall = (1.0 - along) * (1.0 - along) * smoothstep(0.0, 0.08, along);
  float dust = 0.7 + 0.6 * vnoise(vWorld * 2.3 + vec3(0.0, uTime * 0.25, uTime * 0.1));
  // fade when the camera is inside or right at the cone
  float camD = length(cameraPosition - vApex);
  float near = smoothstep(0.6, 2.0, camD);
  float a = edge * fall * dust * near * (1.0 - smoothstep(0.85, 1.0, radial));
  gl_FragColor = vec4(vColor.rgb * vColor.a * a * uGain, 1.0);
}`;

export class LightRig {
  readonly group = new THREE.Group();
  /** Fixture models for lights that never move; the map merges these into its static batches. */
  readonly staticFixtures: { group: THREE.Group; x: number; z: number }[] = [];
  private fx: FixtureState[] = [];
  private points: THREE.PointLight[] = [];
  private pointSlots: Slot[] = [];
  private spots: THREE.SpotLight[] = [];
  private spotSlots: Slot[] = [];
  private shadowRR = 0;
  private opts: LightRigOptions;
  // halos
  private haloMesh: THREE.InstancedMesh | null = null;
  private haloColor: THREE.InstancedBufferAttribute | null = null;
  private haloPos: THREE.InstancedBufferAttribute | null = null;
  private haloIdx: number[] = [];
  readonly haloMat: THREE.ShaderMaterial;
  // cones
  private coneMesh: THREE.InstancedMesh | null = null;
  private coneColor: THREE.InstancedBufferAttribute | null = null;
  private conePos: THREE.InstancedBufferAttribute | null = null;
  private coneQuat: THREE.InstancedBufferAttribute | null = null;
  private coneIdx: number[] = [];
  readonly coneMat: THREE.ShaderMaterial;
  private tmpQ = new THREE.Quaternion();
  private down = new THREE.Vector3(0, -1, 0);

  constructor(lib: MaterialLibrary, defs: LightDef[], opts: LightRigOptions) {
    this.opts = opts;
    for (const d of defs) {
      const color = lightColor(d);
      const animated = !!d.flicker || !!d.swing || !!d.spin || !!d.broken;
      const st: FixtureState = {
        def: d,
        color,
        model: null,
        emissive: [],
        base: [],
        pos: new THREE.Vector3(...d.pos),
        dir: d.dir ? new THREE.Vector3(...d.dir).normalize() : new THREE.Vector3(0, -1, 0),
        flick: 1,
        moving: !!d.swing || !!d.spin,
      };
      if (d.fixture !== 'none') {
        const f = buildFixture(lib, fixtureModel(d.fixture), color.getHex(THREE.SRGBColorSpace), animated);
        f.group.rotation.y = d.rot ?? 0;
        if (d.swing) {
          // pivot at the ceiling attachment so the lamp swings on its chain
          const pivot = new THREE.Group();
          pivot.position.set(d.pos[0], d.pos[1] + 0.9, d.pos[2]);
          f.group.position.set(0, -0.9, 0);
          pivot.add(f.group);
          this.group.add(pivot);
          st.model = pivot;
        } else if (animated) {
          f.group.position.set(...d.pos);
          this.group.add(f.group);
          st.model = f.group;
        } else {
          f.group.position.set(...d.pos);
          this.staticFixtures.push({ group: f.group, x: d.pos[0], z: d.pos[2] });
        }
        if (animated) {
          st.emissive = f.emissive;
          st.base = f.emissive.map((m) => m.emissiveIntensity);
        }
      }
      this.fx.push(st);
    }
    for (let i = 0; i < opts.points; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      this.group.add(l);
      this.points.push(l);
      this.pointSlots.push({ def: -1, w: 0 });
    }
    for (let i = 0; i < opts.shadowSpots; i++) {
      const s = new THREE.SpotLight(0xffffff, 0, 12, 1.2, 0.6, 2);
      s.castShadow = true;
      s.shadow.mapSize.set(opts.shadowSize, opts.shadowSize);
      s.shadow.bias = -0.00025;
      s.shadow.normalBias = 0.025;
      s.shadow.radius = 2;
      s.shadow.camera.near = 0.12;
      s.shadow.camera.far = 16;
      s.shadow.autoUpdate = false;
      this.group.add(s);
      this.group.add(s.target);
      this.spots.push(s);
      this.spotSlots.push({ def: -1, w: 0 });
    }
    this.haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: { uMap: { value: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 128) }, uGain: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.haloMat.userData.textureExempt = 'light effect: additive halo shader';
    this.coneMat = new THREE.ShaderMaterial({
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      uniforms: { uTime: { value: 0 }, uGain: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.coneMat.userData.textureExempt = 'light effect: volumetric cone shader';
    this.buildHalos();
    this.buildCones();
  }

  private buildHalos(): void {
    this.haloIdx = this.fx.map((_, i) => i).filter((i) => this.fx[i].def.fixture !== 'none' && this.fx[i].def.fixture !== 'window');
    const n = this.haloIdx.length;
    if (!n) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = geo.index;
    ig.setAttribute('position', geo.getAttribute('position'));
    ig.setAttribute('uv', geo.getAttribute('uv'));
    this.haloPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.haloColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const size = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.haloIdx.forEach((i, k) => {
      const d = this.fx[i].def;
      size.setX(k, haloSize(d));
    });
    ig.setAttribute('iPos', this.haloPos);
    ig.setAttribute('iColor', this.haloColor);
    ig.setAttribute('iSize', size);
    ig.instanceCount = n;
    const mesh = new THREE.Mesh(ig, this.haloMat) as unknown as THREE.InstancedMesh;
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    mesh.name = 'fx:halos';
    mesh.userData.shadowExempt = 'light effect: additive glow, no surface';
    this.group.add(mesh);
    this.haloMesh = mesh;
  }

  private buildCones(): void {
    this.coneIdx = this.fx.map((_, i) => i).filter((i) => this.fx[i].def.cone);
    const n = this.coneIdx.length;
    if (!n) return;
    const cone = unitCone(24);
    const ig = new THREE.InstancedBufferGeometry();
    ig.setAttribute('position', cone.getAttribute('position'));
    this.conePos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.coneQuat = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.coneColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const shape = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    this.coneIdx.forEach((i, k) => {
      const d = this.fx[i].def;
      const len = Math.min(d.distance * 0.75, d.pos[1] + 0.2 > 0 && !d.dir ? d.pos[1] : d.distance * 0.75);
      const ang = d.angle ?? 0.55;
      shape.setXY(k, len, Math.tan(ang) * len);
    });
    ig.setAttribute('iPos', this.conePos);
    ig.setAttribute('iQuat', this.coneQuat);
    ig.setAttribute('iColor', this.coneColor);
    ig.setAttribute('iShape', shape);
    ig.instanceCount = n;
    const mesh = new THREE.Mesh(ig, this.coneMat) as unknown as THREE.InstancedMesh;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.name = 'fx:cones';
    mesh.userData.shadowExempt = 'light effect: fake volumetric cone, no surface';
    this.group.add(mesh);
    this.coneMesh = mesh;
  }

  /** 0..1 flicker multiplier for a fixture at time t. */
  private flickerAt(d: LightDef, t: number): number {
    const seed = d.flicker ?? 0;
    const h = (n: number) => {
      const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    if (d.broken) {
      if (!seed) return 0;
      // a dead tube that occasionally sputters
      const slot = Math.floor(t * 3);
      return h(slot) > 0.86 ? (h(Math.floor(t * 40)) > 0.5 ? 0.6 : 0.05) : 0;
    }
    if (!seed) return 1;
    const style = seed % 3;
    if (style === 0) {
      // fluorescent buzz/stutter: mostly on, bursts of rapid off/on
      const slot = Math.floor(t * 2.0);
      const burst = h(slot) > 0.82;
      if (!burst) return 0.97 + 0.03 * Math.sin(t * 377);
      const fast = Math.floor(t * 22);
      return h(fast + 0.5) > 0.45 ? 1 : 0.05;
    }
    if (style === 1) {
      // fire / furnace: smooth warm wavering
      return 0.72 + 0.18 * Math.sin(t * 3.1 + seed) + 0.1 * Math.sin(t * 7.3 + seed * 2.0);
    }
    // dying bulb: slow pulse with occasional dropouts
    const slot = Math.floor(t * 1.3);
    if (h(slot + 0.25) > 0.88) return 0.15 + 0.15 * h(Math.floor(t * 30));
    return 0.82 + 0.18 * Math.sin(t * 1.7 + seed);
  }

  /**
   * Animates fixtures and hands the real-time light slots to the fixtures that matter most for
   * this view. `camDir` (unit forward vector) favors lights in front of the camera; without it
   * only distance counts.
   */
  update(camPos: THREE.Vector3, t: number, dt: number, camDir?: THREE.Vector3): void {
    const n = this.fx.length;
    // --- behaviors
    for (let i = 0; i < n; i++) {
      const s = this.fx[i];
      const d = s.def;
      s.flick = this.flickerAt(d, t);
      for (let k = 0; k < s.emissive.length; k++) s.emissive[k].emissiveIntensity = s.base[k] * (0.04 + 0.96 * s.flick);
      if (d.swing && s.model) {
        const ph = (d.flicker ?? 1) * 1.7 + i;
        const ax = d.swing * Math.sin(t * 1.9 + ph);
        const az = d.swing * 0.6 * Math.sin(t * 1.43 + ph * 0.7);
        s.model.rotation.set(ax, 0, az);
        // emitter hangs 0.9 m below the pivot
        const p = new THREE.Vector3(0, -0.9, 0).applyEuler(s.model.rotation);
        s.pos.set(d.pos[0] + p.x, d.pos[1] + 0.9 + p.y, d.pos[2] + p.z);
        s.dir.copy(p).normalize();
      } else if (d.spin) {
        const a = t * d.spin + (d.rot ?? 0);
        const base = d.dir ? new THREE.Vector3(...d.dir).normalize() : new THREE.Vector3(1, -0.4, 0).normalize();
        s.dir.set(base.x * Math.cos(a) - base.z * Math.sin(a), base.y, base.x * Math.sin(a) + base.z * Math.cos(a)).normalize();
        if (s.model) s.model.rotation.y = -a;
      }
    }
    const rate = 4;
    const score = (i: number, bonus: number) => {
      const s = this.fx[i];
      const d = s.def;
      if (d.broken && !d.flicker) return -1;
      const dx = s.pos.x - camPos.x;
      const dy = s.pos.y - camPos.y;
      const dz = s.pos.z - camPos.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      // lights ahead light what you see; ones behind still spill forward, so they only lose some weight
      let facing = 1;
      if (camDir && dist2 > 1) {
        const c = (dx * camDir.x + dy * camDir.y + dz * camDir.z) / Math.sqrt(dist2);
        const k = Math.min(1, Math.max(0, (c + 0.6) / 1.2));
        facing = 0.5 + 0.5 * k * k * (3 - 2 * k);
      }
      return ((d.intensity * (1 + (d.priority ?? 0) * 0.5)) / (1 + dist2 / (d.distance * d.distance * 0.35))) * facing + bonus;
    };
    // --- shadowed spots: lights flagged for shadows, plus directional fixtures
    const spotTaken = new Set<number>();
    if (this.spots.length) {
      const cand: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const d = this.fx[i].def;
        if (!(d.shadow || d.dir || d.swing || d.spin)) continue;
        const cur = this.spotSlots.some((s) => s.def === i) ? 0.3 : 0;
        const sc = score(i, cur);
        if (sc > 0) cand.push([i, sc]);
      }
      cand.sort((a, b) => b[1] - a[1]);
      const want = new Set(cand.slice(0, this.spots.length).map((c) => c[0]));
      const changed = this.assign(this.spotSlots, want, rate, dt);
      let budget = this.opts.shadowUpdates;
      this.spotSlots.forEach((slot, k) => {
        const L = this.spots[k];
        if (slot.def < 0) {
          L.intensity = 0;
          return;
        }
        spotTaken.add(slot.def);
        const s = this.fx[slot.def];
        const d = s.def;
        L.position.copy(s.pos).addScaledVector(s.dir, 0.08);
        L.target.position.copy(s.pos).addScaledVector(s.dir, 4);
        L.target.updateMatrixWorld();
        L.color.copy(s.color);
        L.angle = d.angle ?? 1.2;
        L.penumbra = d.angle ? 0.35 : 0.6;
        L.distance = d.distance * 1.15;
        L.shadow.camera.far = Math.min(30, d.distance * 1.2);
        L.intensity = d.intensity * INTENSITY_SCALE * 2.2 * slot.w * s.flick;
        if (s.moving || changed.has(k)) {
          L.shadow.needsUpdate = true;
        }
      });
      // round-robin refresh for the rest (players move through the light)
      for (let r = 0; r < this.spots.length && budget > 0; r++) {
        const k = (this.shadowRR + r) % this.spots.length;
        const L = this.spots[k];
        if (this.spotSlots[k].def < 0 || L.shadow.needsUpdate) continue;
        L.shadow.needsUpdate = true;
        budget--;
      }
      this.shadowRR = (this.shadowRR + Math.max(1, this.opts.shadowUpdates)) % Math.max(1, this.spots.length);
    }
    // --- unshadowed point pool
    const cand: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (spotTaken.has(i)) continue;
      const cur = this.pointSlots.some((s) => s.def === i) ? 0.25 : 0;
      const sc = score(i, cur);
      if (sc > 0) cand.push([i, sc]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    const want = new Set(cand.slice(0, this.points.length).map((c) => c[0]));
    this.assign(this.pointSlots, want, rate, dt);
    this.pointSlots.forEach((slot, k) => {
      const L = this.points[k];
      if (slot.def < 0) {
        L.intensity = 0;
        return;
      }
      const s = this.fx[slot.def];
      L.position.copy(s.pos).addScaledVector(s.dir, 0.12);
      L.color.copy(s.color);
      L.distance = s.def.distance;
      L.intensity = s.def.intensity * INTENSITY_SCALE * slot.w * s.flick;
    });
    // --- halos and cones follow the fixtures and their flicker
    if (this.haloMesh && this.haloPos && this.haloColor) {
      this.haloIdx.forEach((i, k) => {
        const s = this.fx[i];
        this.haloPos!.setXYZ(k, s.pos.x, s.pos.y, s.pos.z);
        const g = haloGain(s.def) * s.flick;
        this.haloColor!.setXYZW(k, s.color.r, s.color.g, s.color.b, g);
      });
      this.haloPos.needsUpdate = true;
      this.haloColor.needsUpdate = true;
    }
    if (this.coneMesh && this.conePos && this.coneQuat && this.coneColor) {
      this.coneMat.uniforms.uTime.value = t;
      this.coneIdx.forEach((i, k) => {
        const s = this.fx[i];
        this.conePos!.setXYZ(k, s.pos.x, s.pos.y, s.pos.z);
        this.tmpQ.setFromUnitVectors(this.down, s.dir);
        this.coneQuat!.setXYZW(k, this.tmpQ.x, this.tmpQ.y, this.tmpQ.z, this.tmpQ.w);
        this.coneColor!.setXYZW(k, s.color.r, s.color.g, s.color.b, 0.09 * s.flick * Math.min(1.5, s.def.intensity / 4));
      });
      this.conePos.needsUpdate = true;
      this.coneQuat.needsUpdate = true;
      this.coneColor.needsUpdate = true;
    }
  }

  /** Fades slots toward the wanted set; returns slot indices that were (re)assigned. */
  private assign(slots: Slot[], want: Set<number>, rate: number, dt: number): Set<number> {
    const changed = new Set<number>();
    for (const s of slots) {
      if (s.def >= 0 && !want.has(s.def)) {
        s.w -= dt * rate;
        if (s.w <= 0) {
          s.w = 0;
          s.def = -1;
        }
      }
    }
    for (const d of want) {
      if (slots.some((s) => s.def === d)) continue;
      const k = slots.findIndex((s) => s.def < 0);
      if (k >= 0) {
        slots[k].def = d;
        slots[k].w = 0;
        changed.add(k);
      }
    }
    for (const s of slots) if (s.def >= 0 && want.has(s.def)) s.w = Math.min(1, s.w + dt * rate);
    return changed;
  }

  /** Number of shadow-casting lights currently lit (for the perf overlay). */
  activeShadowLights(): number {
    return this.spots.filter((s) => s.intensity > 0).length;
  }

  /** The n strongest active real-time lights near `pos` (for lighting the viewmodel scene). */
  nearestActive(pos: THREE.Vector3, n: number): { pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number }[] {
    const all: { pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; score: number }[] = [];
    for (const L of [...this.points, ...this.spots]) {
      if (L.intensity <= 0) continue;
      const d = L.position.distanceTo(pos);
      if (d > L.distance) continue;
      all.push({ pos: L.position, color: L.color, intensity: L.intensity, distance: L.distance, score: L.intensity / (1 + d * d) });
    }
    all.sort((a, b) => b.score - a.score);
    return all.slice(0, n);
  }

  /** Snap all fades to their targets and render every shadow map (screenshots / first frame). */
  settle(camPos: THREE.Vector3, t: number, camDir?: THREE.Vector3): void {
    for (let i = 0; i < 20; i++) this.update(camPos, t, 0.1, camDir);
    for (const s of this.spots) s.shadow.needsUpdate = true;
  }
}

/** Open cone: apex at the origin, unit-radius rim at y = -1. */
function unitCone(seg: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    pos.push(0, 0, 0, Math.cos(a1), -1, Math.sin(a1), Math.cos(a0), -1, Math.sin(a0));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Fixture types without a dedicated model reuse the closest existing one. */
function fixtureModel(f: LightDef['fixture']): Parameters<typeof buildFixture>[1] {
  switch (f) {
    case 'lantern':
      return 'cage';
    case 'lamppost':
    case 'searchlight':
      return 'flood';
    case 'beacon':
      return 'emergency';
    case 'window':
      return 'none';
    default:
      return f;
  }
}

function haloSize(d: LightDef): number {
  switch (d.fixture) {
    case 'tube':
    case 'tubeBroken':
      return 0.9;
    case 'flood':
    case 'searchlight':
    case 'lamppost':
      return 1.6;
    case 'emergency':
    case 'beacon':
      return 0.7;
    case 'furnace':
      return 1.4;
    default:
      return 0.75;
  }
}

function haloGain(d: LightDef): number {
  const base = d.fixture === 'flood' || d.fixture === 'searchlight' ? 0.9 : d.fixture === 'emergency' || d.fixture === 'beacon' ? 0.8 : 0.55;
  return base * Math.min(1.6, d.intensity / 4);
}
