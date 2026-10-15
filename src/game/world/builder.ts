import type { Brush, DecalDef, LightDef, MapZone, PropPlacement, Ramp, Surface, V3, WaterVolume } from './mapTypes';

// Shared helpers for authoring maps as axis-aligned brushes: walls with doors and sills, floors with
// holes, catwalks with railings, stairs, props, lights, decals, water, zones and bot points of
// interest. `mirror()` emits the east half from the authored west half (fair by construction).

export const T = 0.3; // interior wall thickness
export const DOOR_H = 2.5;

export interface WallOpts {
  t?: number;
  /** Base of the wall (default 0); bands, door heads and sills are measured from here. */
  y0?: number;
  wainscot?: [string, number];
  /** Stacked material bands from the base up: [material, top height above the base]. */
  bands?: [string, number][];
  surface?: Surface;
  /** Skip the dark metal frames around openings. */
  noTrim?: boolean;
}

export interface Opening {
  a: number;
  b: number;
  /** Top of the opening above the wall base (default DOOR_H). */
  head?: number;
  /** Wall left below the opening (a window or an upper-level pass-through). */
  sill?: number;
}

export class Builder {
  brushes: Brush[] = [];
  ramps: Ramp[] = [];
  props: PropPlacement[] = [];
  lights: LightDef[] = [];
  decals: DecalDef[] = [];
  zones: MapZone[] = [];
  waters: WaterVolume[] = [];
  pois: V3[] = [];
  private mirrorOn = false;

  /** Runs fn twice: once as authored (west) and once mirrored across x = 0 (east). */
  mirror(fn: () => void): void {
    fn();
    const n0 = {
      b: this.brushes.length, r: this.ramps.length, p: this.props.length, l: this.lights.length,
      d: this.decals.length, z: this.zones.length, w: this.waters.length, i: this.pois.length,
    };
    this.mirrorOn = true;
    fn();
    this.mirrorOn = false;
    for (let i = n0.b; i < this.brushes.length; i++) mirBox(this.brushes[i]);
    for (let i = n0.r; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      mirBox(r);
      if (r.axis === 'x') r.dir = (r.dir === 1 ? -1 : 1) as 1 | -1;
    }
    for (let i = n0.p; i < this.props.length; i++) {
      const p = this.props[i];
      p.pos = [-p.pos[0], p.pos[1], p.pos[2]];
      p.rot = -(p.rot ?? 0);
    }
    for (let i = n0.l; i < this.lights.length; i++) {
      const l = this.lights[i];
      l.pos = [-l.pos[0], l.pos[1], l.pos[2]];
      l.rot = -(l.rot ?? 0);
      if (l.dir) l.dir = [-l.dir[0], l.dir[1], l.dir[2]];
    }
    for (let i = n0.d; i < this.decals.length; i++) {
      const d = this.decals[i];
      d.pos = [-d.pos[0], d.pos[1], d.pos[2]];
      d.normal = [-d.normal[0], d.normal[1], d.normal[2]];
    }
    for (let i = n0.z; i < this.zones.length; i++) mirBox(this.zones[i]);
    for (let i = n0.w; i < this.waters.length; i++) mirBox(this.waters[i]);
    for (let i = n0.i; i < this.pois.length; i++) this.pois[i] = [-this.pois[i][0], this.pois[i][1], this.pois[i][2]];
  }

  /** True during the mirrored pass of `mirror()` (for per-side names and colors). */
  get mirrored(): boolean {
    return this.mirrorOn;
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: string, o: Partial<Brush> = {}): Brush {
    const b: Brush = {
      min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
      max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
      mat,
      ...o,
    };
    this.brushes.push(b);
    return b;
  }

  /** Wall along X at z, spanning x0..x1, `h` tall above its base, with openings. */
  wallX(z: number, x0: number, x1: number, h: number, mat: string, openings: Opening[] = [], o: WallOpts = {}): void {
    this.wallRun('x', z, x0, x1, h, o.t ?? T, mat, openings, o);
  }

  wallZ(x: number, z0: number, z1: number, h: number, mat: string, openings: Opening[] = [], o: WallOpts = {}): void {
    this.wallRun('z', x, z0, z1, h, o.t ?? T, mat, openings, o);
  }

  private wallRun(axis: 'x' | 'z', c: number, s0: number, s1: number, h: number, t: number, mat: string, openings: Opening[], o: WallOpts): void {
    const base = o.y0 ?? 0;
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    const ops = [...openings].sort((a, b) => a.a - b.a);
    const segs: [number, number][] = [];
    let cur = lo;
    for (const op of ops) {
      if (op.a > cur) segs.push([cur, op.a]);
      cur = Math.max(cur, op.b);
    }
    if (cur < hi) segs.push([cur, hi]);
    const surface = o.surface ?? 'concrete';
    const emit = (a: number, b: number, y0: number, y1: number, m: string) => {
      if (b - a < 1e-3 || y1 - y0 < 1e-3) return;
      if (axis === 'x') this.box(a, base + y0, c - t / 2, b, base + y1, c + t / 2, m, { surface });
      else this.box(c - t / 2, base + y0, a, c + t / 2, base + y1, b, m, { surface });
    };
    const bands: [string, number][] = o.bands ?? (o.wainscot ? [o.wainscot] : []);
    const banded = (a: number, b: number, y0: number, y1: number) => {
      let y = y0;
      for (const [bm, bh] of bands) {
        if (bh <= y) continue;
        emit(a, b, y, Math.min(bh, y1), bm);
        y = Math.min(bh, y1);
        if (y >= y1) return;
      }
      emit(a, b, y, y1, mat);
    };
    for (const [a, b] of segs) banded(a, b, 0, h);
    for (const op of ops) {
      const head = op.head ?? DOOR_H;
      emit(op.a, op.b, head, h, mat);
      if (op.sill) banded(op.a, op.b, 0, op.sill);
      if (o.noTrim) continue;
      // dark metal frame around the opening
      const fr = 0.08;
      const y0 = base + (op.sill ?? 0);
      const y1 = base + head;
      const f = { surface: 'metal' as Surface };
      if (axis === 'x') {
        this.box(op.a - fr, y0, c - t / 2 - 0.03, op.a, y1, c + t / 2 + 0.03, 'darkMetal', f);
        this.box(op.b, y0, c - t / 2 - 0.03, op.b + fr, y1, c + t / 2 + 0.03, 'darkMetal', f);
        this.box(op.a - fr, y1, c - t / 2 - 0.03, op.b + fr, y1 + fr, c + t / 2 + 0.03, 'darkMetal', f);
      } else {
        this.box(c - t / 2 - 0.03, y0, op.a - fr, c + t / 2 + 0.03, y1, op.a, 'darkMetal', f);
        this.box(c - t / 2 - 0.03, y0, op.b, c + t / 2 + 0.03, y1, op.b + fr, 'darkMetal', f);
        this.box(c - t / 2 - 0.03, y1, op.a - fr, c + t / 2 + 0.03, y1 + fr, op.b + fr, 'darkMetal', f);
      }
    }
  }

  /** Walkable slab whose top is at `y` (0.4 m thick); seen from below (basements) it is bare concrete. */
  floor(x0: number, z0: number, x1: number, z1: number, mat: string, surface: Surface = 'concrete', y = 0): void {
    this.box(x0, y - 0.4, z0, x1, y, z1, mat, { surface, walk: true, bottom: 'concreteDark' });
  }

  /** Floor slab around one rectangular hole [hx0, hz0, hx1, hz1]. */
  floorAround(x0: number, z0: number, x1: number, z1: number, hole: [number, number, number, number], mat: string, surface: Surface = 'concrete', y = 0): void {
    const [hx0, hz0, hx1, hz1] = hole;
    if (hz0 > z0) this.floor(x0, z0, x1, hz0, mat, surface, y);
    if (z1 > hz1) this.floor(x0, hz1, x1, z1, mat, surface, y);
    if (hx0 > x0) this.floor(x0, hz0, hx0, hz1, mat, surface, y);
    if (x1 > hx1) this.floor(hx1, hz0, x1, hz1, mat, surface, y);
  }

  ceiling(x0: number, z0: number, x1: number, z1: number, y: number, mat = 'concreteDark', hole?: [number, number, number, number]): void {
    if (!hole) {
      this.box(x0, y, z0, x1, y + 0.35, z1, mat, { surface: 'concrete' });
      return;
    }
    const [hx0, hz0, hx1, hz1] = hole;
    this.box(x0, y, z0, x1, y + 0.35, hz0, mat);
    this.box(x0, y, hz1, x1, y + 0.35, z1, mat);
    this.box(x0, y, hz0, hx0, y + 0.35, hz1, mat);
    this.box(hx1, y, hz0, x1, y + 0.35, hz1, mat);
  }

  /** Diamond-plate walkway slab with its top at `y` (railings are added separately). */
  catwalk(x0: number, z0: number, x1: number, z1: number, y: number, mat = 'diamond'): void {
    this.box(x0, y - 0.2, z0, x1, y, z1, mat, { top: mat, surface: 'metal', walk: true });
  }

  /**
   * Railing along X (axis 'x', at z = c) or Z (at x = c) from s0 to s1, standing on `y`: posts, a top
   * and a mid rail and a kick plate you can see through and shoot through, over an invisible panel
   * that stops players walking off.
   */
  rail(axis: 'x' | 'z', c: number, s0: number, s1: number, y: number, o: { mat?: string; top?: string; h?: number } = {}): void {
    const a = Math.min(s0, s1);
    const b = Math.max(s0, s1);
    const h = o.h ?? 1.05;
    const mat = o.mat ?? 'paintGrey';
    const top = o.top ?? 'paintOrange';
    const vis = { surface: 'metal' as Surface, solid: false, opaque: false };
    const bar = (s0b: number, s1b: number, y0: number, y1: number, th: number, m: string) => {
      if (axis === 'x') this.box(s0b, y0, c - th / 2, s1b, y1, c + th / 2, m, vis);
      else this.box(c - th / 2, y0, s0b, c + th / 2, y1, s1b, m, vis);
    };
    bar(a, b, y + h - 0.05, y + h + 0.02, 0.07, top);
    bar(a, b, y + h * 0.52 - 0.025, y + h * 0.52 + 0.025, 0.05, mat);
    bar(a, b, y, y + 0.12, 0.03, mat);
    const n = Math.max(1, Math.round((b - a) / 1.5));
    for (let i = 0; i <= n; i++) {
      const s = a + ((b - a) * i) / n;
      bar(s - 0.03, s + 0.03, y, y + h, 0.06, mat);
    }
    if (axis === 'x') this.box(a, y, c - 0.05, b, y + h + 0.05, c + 0.05, 'black', { visible: false, opaque: false, surface: 'metal' });
    else this.box(c - 0.05, y, a, c + 0.05, y + h + 0.05, b, 'black', { visible: false, opaque: false, surface: 'metal' });
  }

  prop(type: string, x: number, y: number, z: number, rot = 0, v = 0, tag?: string, scale?: number): void {
    this.props.push({ type, pos: [x, y, z], rot, v, tag, scale });
  }

  light(pos: V3, color: number, intensity: number, distance: number, fixture: LightDef['fixture'], o: Partial<LightDef> = {}): void {
    this.lights.push({ pos, color, intensity, distance, fixture, ...o });
  }

  decal(pos: V3, normal: V3, size: [number, number], kind: DecalDef['kind'], o: Partial<DecalDef> = {}): void {
    this.decals.push({ pos, normal, size, kind, ...o });
  }

  ramp(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, axis: 'x' | 'z', dir: 1 | -1, mat: string, surface: Surface = 'metal', steps = false): void {
    this.ramps.push({ min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)], axis, dir, mat, surface, steps });
  }

  /** A staircase: drawn as steps, walked as a slope (rises along +axis for dir 1). */
  stairs(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, axis: 'x' | 'z', dir: 1 | -1, mat = 'concrete', surface: Surface = 'concrete'): void {
    this.ramp(x0, y0, z0, x1, y1, z1, axis, dir, mat, surface, true);
  }

  water(x0: number, z0: number, x1: number, z1: number, floorY: number, surfaceY: number): void {
    this.waters.push({ min: [Math.min(x0, x1), floorY, Math.min(z0, z1)], max: [Math.max(x0, x1), surfaceY, Math.max(z0, z1)] });
  }

  zone(name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.zones.push({ name, min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)] });
  }

  poi(x: number, y: number, z: number): void {
    this.pois.push([x, y, z]);
  }
}

function mirBox(b: { min: V3; max: V3 }): void {
  const x0 = -b.max[0];
  const x1 = -b.min[0];
  b.min = [x0, b.min[1], b.min[2]];
  b.max = [x1, b.max[1], b.max[2]];
}

/** Name of the zone containing a point (first match), or ''. */
export function zoneAt(zones: MapZone[] | undefined, x: number, y: number, z: number): string {
  if (!zones) return '';
  for (const zn of zones) {
    if (x >= zn.min[0] && x <= zn.max[0] && y >= zn.min[1] - 0.5 && y <= zn.max[1] && z >= zn.min[2] && z <= zn.max[2]) return zn.name;
  }
  return '';
}

/** Where to bake a map's reflection probe: its first probe, else the middle of the map at eye height. */
export function envProbePos(map: { probes: { pos: V3 }[] }): V3 {
  return map.probes[0]?.pos ?? [0, 1.7, 0];
}
