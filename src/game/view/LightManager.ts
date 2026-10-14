import * as THREE from 'three';
import type { LightDef } from '@/game/world/mapTypes';
import type { MaterialLibrary } from '@/assets/materials';
import { buildFixture } from '@/assets/models/props';

/**
 * The map has dozens of light fixtures; a forward renderer can't afford them all.
 * A fixed pool of real-time lights is re-assigned every frame to the fixtures that
 * matter most near the camera (with fades). Fixture emissives always glow, so far-away
 * lights still read as light sources. Pool sizes never change during a match, so no
 * shader recompiles happen.
 */
export class LightManager {
  readonly group = new THREE.Group();
  private defs: LightDef[];
  /** Fixture models for steady lights; the map merges these into its static batches. */
  readonly staticFixtures: { group: THREE.Group; x: number; z: number }[] = [];
  private fixtures: { emissive: THREE.MeshStandardMaterial[]; base: number[] }[] = [];
  private points: THREE.PointLight[] = [];
  private pointSlots: { def: number; w: number }[] = [];
  private spots: THREE.SpotLight[] = [];
  private spotSlots: { def: number; w: number }[] = [];
  private flick: Float32Array;
  /** Global multiplier for fixture light intensities (artistic tuning). */
  intensityScale = 7;

  constructor(lib: MaterialLibrary, defs: LightDef[], poolSize: number, shadowSpots: number, spotShadowSize: number) {
    this.defs = defs;
    this.flick = new Float32Array(defs.length).fill(1);
    defs.forEach((d) => {
      if (d.fixture === 'none') {
        this.fixtures.push({ emissive: [], base: [] });
        return;
      }
      const flick = !!d.flicker;
      const f = buildFixture(lib, d.fixture, d.color, flick);
      f.group.position.set(...d.pos);
      f.group.rotation.y = d.rot ?? 0;
      if (flick) {
        this.group.add(f.group);
        this.fixtures.push({ emissive: f.emissive, base: f.emissive.map((m) => m.emissiveIntensity) });
      } else {
        this.staticFixtures.push({ group: f.group, x: d.pos[0], z: d.pos[2] });
        this.fixtures.push({ emissive: [], base: [] });
      }
    });
    for (let i = 0; i < poolSize; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      this.group.add(l);
      this.points.push(l);
      this.pointSlots.push({ def: -1, w: 0 });
    }
    for (let i = 0; i < shadowSpots; i++) {
      const s = new THREE.SpotLight(0xffffff, 0, 12, 1.25, 0.65, 2);
      s.castShadow = true;
      s.shadow.mapSize.set(spotShadowSize, spotShadowSize);
      s.shadow.bias = -0.0004;
      s.shadow.normalBias = 0.02;
      s.shadow.camera.near = 0.2;
      s.shadow.camera.far = 14;
      this.group.add(s);
      this.group.add(s.target);
      this.spots.push(s);
      this.spotSlots.push({ def: -1, w: 0 });
    }
  }

  /** 0..1 flicker multiplier for a light at time t. */
  private flickerAt(i: number, t: number): number {
    const seed = this.defs[i].flicker ?? 0;
    if (!seed) return 1;
    const style = seed % 3;
    const h = (n: number) => {
      const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    if (style === 0) {
      // fluorescent stutter: mostly on, bursts of rapid off/on
      const slot = Math.floor(t * 2.0);
      const burst = h(slot) > 0.82;
      if (!burst) return 1;
      const fast = Math.floor(t * 22);
      return h(fast + 0.5) > 0.45 ? 1 : 0.05;
    }
    if (style === 1) {
      // furnace: smooth warm wavering
      return 0.72 + 0.18 * Math.sin(t * 3.1 + seed) + 0.1 * Math.sin(t * 7.3 + seed * 2.0);
    }
    // dying bulb: slow pulse + occasional dropouts
    const slot = Math.floor(t * 1.3);
    if (h(slot + 0.25) > 0.88) return 0.15 + 0.15 * h(Math.floor(t * 30));
    return 0.82 + 0.18 * Math.sin(t * 1.7 + seed);
  }

  update(camPos: THREE.Vector3, t: number, dt: number): void {
    const n = this.defs.length;
    for (let i = 0; i < n; i++) {
      const f = this.flickerAt(i, t);
      this.flick[i] = f;
      const fx = this.fixtures[i];
      for (let k = 0; k < fx.emissive.length; k++) fx.emissive[k].emissiveIntensity = fx.base[k] * (0.08 + 0.92 * f);
    }
    const rate = 5;
    const score = (i: number, bonus: number) => {
      const d = this.defs[i];
      const dx = d.pos[0] - camPos.x;
      const dy = d.pos[1] - camPos.y;
      const dz = d.pos[2] - camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return (d.intensity * (1 + (d.priority ?? 0) * 0.5)) / (1 + (dist * dist) / (d.distance * d.distance * 0.35)) + bonus;
    };
    // --- shadowed spots (only defs flagged shadow)
    const spotTaken = new Set<number>();
    if (this.spots.length) {
      const cand: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        if (!this.defs[i].shadow) continue;
        const cur = this.spotSlots.some((s) => s.def === i) ? 0.3 : 0;
        cand.push([i, score(i, cur)]);
      }
      cand.sort((a, b) => b[1] - a[1]);
      const want = new Set(cand.slice(0, this.spots.length).map((c) => c[0]));
      this.assign(this.spotSlots, want, rate, dt);
      this.spotSlots.forEach((s, k) => {
        const L = this.spots[k];
        if (s.def < 0) {
          L.intensity = 0;
          L.visible = false;
          return;
        }
        spotTaken.add(s.def);
        const d = this.defs[s.def];
        L.visible = true;
        L.position.set(d.pos[0], d.pos[1] - 0.08, d.pos[2]);
        L.target.position.set(d.pos[0], 0, d.pos[2]);
        L.color.setHex(d.color);
        L.distance = d.distance * 1.15;
        L.intensity = d.intensity * this.intensityScale * 2.2 * s.w * this.flick[s.def];
      });
    }
    // --- unshadowed point pool
    const cand: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (spotTaken.has(i)) continue;
      const cur = this.pointSlots.some((s) => s.def === i) ? 0.25 : 0;
      cand.push([i, score(i, cur)]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    const want = new Set(cand.slice(0, this.points.length).map((c) => c[0]));
    this.assign(this.pointSlots, want, rate, dt);
    this.pointSlots.forEach((s, k) => {
      const L = this.points[k];
      if (s.def < 0) {
        L.intensity = 0;
        return;
      }
      const d = this.defs[s.def];
      L.position.set(d.pos[0], d.pos[1] - 0.12, d.pos[2]);
      L.color.setHex(d.color);
      L.distance = d.distance;
      L.intensity = d.intensity * this.intensityScale * s.w * this.flick[s.def];
    });
  }

  private assign(slots: { def: number; w: number }[], want: Set<number>, rate: number, dt: number): void {
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
      const free = slots.find((s) => s.def < 0);
      if (free) {
        free.def = d;
        free.w = 0;
      }
    }
    for (const s of slots) if (s.def >= 0 && want.has(s.def)) s.w = Math.min(1, s.w + dt * rate);
  }

  /** The n strongest active real-time lights near `pos` (for lighting the viewmodel scene). */
  nearestActive(pos: THREE.Vector3, n: number): { pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number }[] {
    const all: { pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; score: number }[] = [];
    for (const L of [...this.points, ...this.spots]) {
      if (L.intensity <= 0 || !L.visible) continue;
      const d = L.position.distanceTo(pos);
      if (d > L.distance) continue;
      all.push({ pos: L.position, color: L.color, intensity: L.intensity, distance: L.distance, score: L.intensity / (1 + d * d) });
    }
    all.sort((a, b) => b.score - a.score);
    return all.slice(0, n);
  }

  /** Snap all fades to their targets (useful for screenshots / first frame). */
  settle(camPos: THREE.Vector3, t: number): void {
    for (let i = 0; i < 20; i++) this.update(camPos, t, 0.1);
  }
}
