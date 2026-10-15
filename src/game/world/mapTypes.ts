// Data model for arena maps. Pure data: used by the simulation (collision, spawns,
// objective, nav) and by the client view (meshes, lights, decals).

export type V3 = [number, number, number];

/** Physical surface, drives impact VFX/decals and footstep sounds. */
export type Surface = 'concrete' | 'metal' | 'tile' | 'wood' | 'water' | 'fabric' | 'glass' | 'dirt';

export interface Brush {
  min: V3;
  max: V3;
  /** Render material for all faces (see MaterialLibrary). */
  mat: string;
  /** Optional per-face overrides. */
  top?: string;
  bottom?: string;
  sides?: string;
  surface?: Surface;
  /** Blocks player movement (default true). */
  solid?: boolean;
  /** Blocks bullets and vision (default true). */
  opaque?: boolean;
  /** Rendered (default true). */
  visible?: boolean;
  /** Casts shadows (default true). */
  shadow?: boolean;
  /** Group tag used by playlist-dependent shutters, etc. */
  tag?: string;
  /** Walkable floor slab (gets floor grime decals; nav hint). */
  walk?: boolean;
}

/** Wedge: AABB footprint whose top slopes up along +axis (dir 1) or -axis (dir -1). */
export interface Ramp {
  min: V3;
  max: V3;
  axis: 'x' | 'z';
  dir: 1 | -1;
  mat: string;
  surface?: Surface;
}

export interface PropPlacement {
  type: string;
  pos: V3;
  /** Yaw in radians. Collision-relevant props should use multiples of PI/2. */
  rot?: number;
  scale?: number;
  /** Free-form variant/seed. */
  v?: number;
  /** Tag for playlist-dependent props. */
  tag?: string;
}

export type FixtureType =
  | 'cage'
  | 'tube'
  | 'tubeBroken'
  | 'pendant'
  | 'flood'
  | 'emergency'
  | 'furnace'
  | 'lantern'
  | 'lamppost'
  | 'searchlight'
  | 'beacon'
  | 'window'
  | 'none';

export interface LightDef {
  pos: V3;
  color: number;
  intensity: number;
  distance: number;
  /** Visible fixture model generated at the light position. */
  fixture: FixtureType;
  /** 0 = steady, otherwise flicker style seed. */
  flicker?: number;
  /** Prefer for real-time shadow (spot facing down). */
  shadow?: boolean;
  /** Importance for the dynamic light pool (higher = kept more often). */
  priority?: number;
  /** Fixture yaw. */
  rot?: number;
  /** Color temperature in kelvin; overrides `color` (red/colored lights keep `color`). */
  kelvin?: number;
  /** Pendulum swing amplitude (radians) for lamps hanging on chains. */
  swing?: number;
  /** Dead fixture: no light at all (or only a faint stutter if `flicker` is set). */
  broken?: boolean;
  /** Spot direction for floodlights / searchlights (defaults to straight down). */
  dir?: V3;
  /** Spot cone half-angle (radians) for directional fixtures. */
  angle?: number;
  /** Draw a fake volumetric cone under the light (dust, steam, rain, snow). */
  cone?: boolean;
  /** Searchlights / beacons: rotation speed (radians per second). */
  spin?: number;
}

export interface DecalDef {
  pos: V3;
  /** Surface normal axis the decal faces. */
  normal: V3;
  size: [number, number];
  kind: 'sign' | 'graffiti' | 'stain' | 'crack' | 'puddle' | 'hazard' | 'number';
  text?: string;
  color?: string;
  rot?: number;
}

export interface SpawnPoint {
  team: 0 | 1;
  pos: V3;
  yaw: number;
}

export interface ReflectionProbe {
  pos: V3;
  /** Box bounds of the zone the probe serves. */
  min: V3;
  max: V3;
}

export interface MapDef {
  id: string;
  name: string;
  bounds: { min: V3; max: V3 };
  brushes: Brush[];
  ramps: Ramp[];
  props: PropPlacement[];
  lights: LightDef[];
  decals: DecalDef[];
  spawns: SpawnPoint[];
  capture: { pos: V3; radius: number };
  probes: ReflectionProbe[];
  /** Openings to the sky (for moonlight shafts), as XZ rectangles at roof height. */
  skyHoles: { min: V3; max: V3 }[];
  /** Directional moonlight direction (pointing from the moon toward the ground). */
  moonDir: V3;
  /** Floors get wet (puddles, rain, leaks) only below this height (default 0.6 m). */
  wetMaxY?: number;
}
