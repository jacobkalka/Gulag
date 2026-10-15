import type { PlantKind, Surface, V3 } from './mapTypes';

// Collision proxies for props, in prop-local space (origin on the floor, yaw applied by the map).
// Kept free of rendering code so the simulation never depends on three.js.

/**
 * How a collider blocks: default is everything (movement, bullets, sight); 'solid' stops movement
 * only (razor wire); 'conceal' stops movement and sight but not bullets (tents).
 */
export type ColliderFlags = 'solid' | 'conceal';

export interface PropAABB {
  kind: 'box';
  min: V3;
  max: V3;
  surface: Surface;
  flags?: ColliderFlags;
}
export interface PropCyl {
  kind: 'cyl';
  x: number;
  z: number;
  r: number;
  y0: number;
  y1: number;
  surface: Surface;
  flags?: ColliderFlags;
}
export interface PropRamp {
  kind: 'ramp';
  min: V3;
  max: V3;
  axis: 'x' | 'z';
  dir: 1 | -1;
  surface: Surface;
  flags?: ColliderFlags;
}
export type PropCollider = PropAABB | PropCyl | PropRamp;

const bx = (min: V3, max: V3, surface: Surface = 'concrete', flags?: ColliderFlags): PropAABB => ({ kind: 'box', min, max, surface, flags });

/** Trunk radius per plant kind at scale 1 (0 = walk through it). */
export const PLANT_TRUNK: Record<PlantKind, number> = { fern: 0, treeFern: 0.16, palm: 0.24, banana: 0.12, monstera: 0, bush: 0, grass: 0, buttress: 0.95 };

/** Foliage that hides a player from sight (bots too) without stopping bullets: radius and height at scale 1. */
export const PLANT_COVER: Partial<Record<PlantKind, { r: number; h: number }>> = { bush: { r: 0.75, h: 1.45 }, banana: { r: 0.9, h: 2.4 }, monstera: { r: 0.7, h: 1.1 } };

export const PROP_COLLIDERS: Record<string, (v: number) => PropCollider[]> = {
  rubble: () => [bx([-0.7, 0, -0.55], [0.7, 0.28, 0.55]), bx([-0.4, 0, -0.32], [0.4, 0.5, 0.32])],
  slab: () => [
    { kind: 'ramp', min: [-1.05, 0, -0.7], max: [0.95, 1.0, 0.7], axis: 'x', dir: 1, surface: 'concrete' },
    bx([0.95, 0, -0.7], [1.25, 1.0, 0.7]),
  ],
  holeEdge: () => [],
  crate: () => [bx([-0.5, 0, -0.5], [0.5, 1.0, 0.5], 'wood')],
  crateSmall: () => [bx([-0.31, 0, -0.21], [0.31, 0.44, 0.21], 'metal')],
  barrel: () => [{ kind: 'cyl', x: 0, z: 0, r: 0.3, y0: 0, y1: 0.89, surface: 'metal' }],
  valve: () => [bx([-0.5, 0, -0.35], [0.5, 1.3, 0.35], 'metal')],
  pipes: () => [bx([-1.5, 0, -0.38], [1.5, 0.7, 0.38], 'metal')],
  boiler: () => [bx([-1.65, 0, -1.65], [1.65, 0.3, 1.65]), { kind: 'cyl', x: 0, z: 0, r: 1.48, y0: 0, y1: 4.7, surface: 'metal' }],
  pump: () => [bx([-1.2, 0, -0.6], [1.2, 1.25, 0.6], 'metal'), { kind: 'cyl', x: 0.65, z: 0, r: 0.16, y0: 0, y1: 3.8, surface: 'metal' }],
  showerHead: () => [],
  drain: () => [],
  bars: () => [],
  desk: () => [bx([-0.75, 0, -0.35], [0.75, 0.78, 0.35], 'metal')],
  bunk: () => [bx([-0.97, 0, -0.42], [0.97, 1.62, 0.42], 'metal')],
  bunkTipped: () => [bx([-0.97, 0, -0.42], [0.97, 1.2, 0.42], 'metal')],
  mattress: () => [],
  toilet: () => [bx([-0.22, 0, -0.25], [0.22, 0.45, 0.33], 'metal')],
  bench: () => [bx([-0.9, 0, -0.19], [0.9, 0.46, 0.19], 'wood')],
  detector: () => [bx([-0.86, 0, -0.25], [-0.74, 2.3, 0.25], 'metal'), bx([0.74, 0, -0.25], [0.86, 2.3, 0.25], 'metal')],
  washer: () => [bx([-0.5, 0, -0.5], [0.5, 1.35, 0.5], 'metal')],
  cart: () => [bx([-0.5, 0, -0.32], [0.5, 0.92, 0.32], 'fabric')],
  lockers: (v) => {
    const L = (v || 4) * 0.45;
    return [bx([-L / 2, 0, -0.25], [L / 2, 1.98, 0.25], 'metal')];
  },
  lockersDouble: (v) => {
    const L = (v || 6) * 0.45;
    return [bx([-L / 2, 0, -0.5], [L / 2, 1.98, 0.5], 'metal')];
  },
  lockersFallen: () => [bx([-0.68, 0, 0.0], [0.68, 0.52, 2.0], 'metal')],
  generator: () => [bx([-1.6, 0, -0.75], [1.6, 1.75, 0.75], 'metal'), { kind: 'cyl', x: 1.15, z: 0.35, r: 0.14, y0: 1.75, y1: 3.4, surface: 'metal' }],
  // outdoor base props (see assets/models/basecamp.ts)
  container: () => [bx([-3.03, 0, -1.22], [3.03, 2.59, 1.22], 'metal')],
  tent: () => [bx([-2.0, 0, -2.5], [2.0, 2.2, 2.5], 'fabric', 'conceal')],
  sandbags: () => [bx([-1.0, 0, -0.31], [1.0, 1.0, 0.31], 'fabric')],
  razorWire: () => [bx([-1.1, 0, -0.4], [1.1, 0.85, 0.4], 'metal', 'solid')],
  jeep: () => [bx([-1.75, 0, -0.78], [1.7, 1.25, 0.78], 'metal')],
  truck: () => [bx([1.25, 0, -1.2], [3.9, 2.7, 1.2], 'metal'), bx([-3.25, 0, -1.25], [1.25, 3.1, 1.25], 'metal')],
  heliWreck: () => [bx([-1.15, 0, -2.2], [1.15, 2.2, 2.2], 'metal'), bx([-0.85, 0, 2.2], [0.85, 1.6, 3.3], 'metal'), bx([-0.4, 0, -6.6], [1.4, 0.7, -2.2], 'metal')],
};
