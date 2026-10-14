import type { Brush, DecalDef, LightDef, MapDef, PropPlacement, Ramp, Surface, V3 } from './mapTypes';

// SUBLEVEL 9: a flooded prison-bunker shower block. 50 m x 34 m, mirrored across X = 0.
//
//   z=+17 +----------+--------------------------------------+----------+
//         | PUMP RM  |  BOILER HALL (catwalk on north wall)  | PUMP RM  |
//   z=+6  +----------+---------+------------------+---------+----------+
//         | INTAKE A | LOCKERS |  SHOWERS (drain) | LOCKERS | INTAKE B |
//   z=-6  +----------+---------+------------------+---------+----------+
//         | LAUNDRY  |  CELL BLOCK corridor / cells / pipe chase       | LAUNDRY  |
//   z=-17 +----------+--------------------------------------+----------+
//        x=-25     x=-19     x=-9              x=+9      x=+19      x=+25
//
// Only the WEST half (x < 0) and the center line are authored; `mirror()` emits the east half.

const T = 0.3; // interior wall thickness
const TO = 0.5; // exterior wall thickness

const H = {
  spawn: 3.4,
  pump: 3.8,
  laundry: 3.4,
  locker: 3.6,
  showers: 4.4,
  boiler: 6.4,
  corridor: 3.6,
  cells: 3.2,
  chase: 3.2,
  outer: 6.8,
};

const DOOR_H = 2.5;

interface WallOpts {
  t?: number;
  wainscot?: [string, number];
  /** Stacked material bands from the floor up: [material, top height]. */
  bands?: [string, number][];
  surface?: Surface;
}

interface Opening {
  a: number;
  b: number;
  head?: number;
}

class Builder {
  brushes: Brush[] = [];
  ramps: Ramp[] = [];
  props: PropPlacement[] = [];
  lights: LightDef[] = [];
  decals: DecalDef[] = [];
  private mirrorOn = false;

  /** Runs fn twice: once as authored (west) and once mirrored (east). */
  mirror(fn: () => void): void {
    fn();
    const b0 = this.brushes.length;
    const r0 = this.ramps.length;
    const p0 = this.props.length;
    const l0 = this.lights.length;
    const d0 = this.decals.length;
    this.mirrorOn = true;
    fn();
    this.mirrorOn = false;
    for (let i = b0; i < this.brushes.length; i++) mirBrush(this.brushes[i]);
    for (let i = r0; i < this.ramps.length; i++) mirRamp(this.ramps[i]);
    for (let i = p0; i < this.props.length; i++) {
      const p = this.props[i];
      p.pos = [-p.pos[0], p.pos[1], p.pos[2]];
      p.rot = -(p.rot ?? 0);
    }
    for (let i = l0; i < this.lights.length; i++) {
      const l = this.lights[i];
      l.pos = [-l.pos[0], l.pos[1], l.pos[2]];
      l.rot = -(l.rot ?? 0);
    }
    for (let i = d0; i < this.decals.length; i++) {
      const d = this.decals[i];
      d.pos = [-d.pos[0], d.pos[1], d.pos[2]];
      d.normal = [-d.normal[0], d.normal[1], d.normal[2]];
    }
  }

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

  /** Wall along X at z, spanning x0..x1, with door openings. Optional wainscot material up to wainscotH. */
  wallX(z: number, x0: number, x1: number, h: number, mat: string, openings: Opening[] = [], o: WallOpts = {}): void {
    const t = o.t ?? T;
    this.wallRun('x', z, x0, x1, h, t, mat, openings, o);
  }

  wallZ(x: number, z0: number, z1: number, h: number, mat: string, openings: Opening[] = [], o: WallOpts = {}): void {
    const t = o.t ?? T;
    this.wallRun('z', x, z0, z1, h, t, mat, openings, o);
  }

  private wallRun(axis: 'x' | 'z', c: number, s0: number, s1: number, h: number, t: number, mat: string, openings: Opening[], o: WallOpts): void {
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
    const emit = (a: number, b: number, y0: number, y1: number, m: string) => {
      if (b - a < 1e-3 || y1 - y0 < 1e-3) return;
      if (axis === 'x') this.box(a, y0, c - t / 2, b, y1, c + t / 2, m, { surface: o.surface ?? 'concrete' });
      else this.box(c - t / 2, y0, a, c + t / 2, y1, b, m, { surface: o.surface ?? 'concrete' });
    };
    const bands: [string, number][] = o.bands ?? (o.wainscot ? [o.wainscot] : []);
    for (const [a, b] of segs) {
      let y = 0;
      for (const [bm, bh] of bands) {
        emit(a, b, y, Math.min(bh, h), bm);
        y = Math.min(bh, h);
      }
      emit(a, b, y, h, mat);
    }
    for (const op of ops) {
      const head = op.head ?? DOOR_H;
      emit(op.a, op.b, head, h, mat);
      // door frame trims
      const fr = 0.08;
      if (axis === 'x') {
        this.box(op.a - fr, 0, c - t / 2 - 0.03, op.a, head, c + t / 2 + 0.03, 'darkMetal', { surface: 'metal' });
        this.box(op.b, 0, c - t / 2 - 0.03, op.b + fr, head, c + t / 2 + 0.03, 'darkMetal', { surface: 'metal' });
        this.box(op.a - fr, head, c - t / 2 - 0.03, op.b + fr, head + fr, c + t / 2 + 0.03, 'darkMetal', { surface: 'metal' });
      } else {
        this.box(c - t / 2 - 0.03, 0, op.a - fr, c + t / 2 + 0.03, head, op.a, 'darkMetal', { surface: 'metal' });
        this.box(c - t / 2 - 0.03, 0, op.b, c + t / 2 + 0.03, head, op.b + fr, 'darkMetal', { surface: 'metal' });
        this.box(c - t / 2 - 0.03, head, op.a - fr, c + t / 2 + 0.03, head + fr, op.b + fr, 'darkMetal', { surface: 'metal' });
      }
    }
  }

  floor(x0: number, z0: number, x1: number, z1: number, mat: string, surface: Surface = 'concrete', y = 0): void {
    this.box(x0, y - 0.4, z0, x1, y, z1, mat, { surface, shadow: false });
  }

  ceiling(x0: number, z0: number, x1: number, z1: number, y: number, mat = 'concreteDark', holes: [number, number, number, number][] = []): void {
    if (!holes.length) {
      this.box(x0, y, z0, x1, y + 0.35, z1, mat, { surface: 'concrete' });
      return;
    }
    // split around one rectangular hole (enough for our roofs)
    const [hx0, hz0, hx1, hz1] = holes[0];
    this.box(x0, y, z0, x1, y + 0.35, hz0, mat);
    this.box(x0, y, hz1, x1, y + 0.35, z1, mat);
    this.box(x0, y, hz0, hx0, y + 0.35, hz1, mat);
    this.box(hx1, y, hz0, x1, y + 0.35, hz1, mat);
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

  ramp(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, axis: 'x' | 'z', dir: 1 | -1, mat: string, surface: Surface = 'metal'): void {
    this.ramps.push({ min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)], axis, dir, mat, surface });
  }
}

function mirBrush(b: Brush): void {
  const x0 = -b.max[0];
  const x1 = -b.min[0];
  b.min = [x0, b.min[1], b.min[2]];
  b.max = [x1, b.max[1], b.max[2]];
}
function mirRamp(r: Ramp): void {
  const x0 = -r.max[0];
  const x1 = -r.min[0];
  r.min = [x0, r.min[1], r.min[2]];
  r.max = [x1, r.max[1], r.max[2]];
  if (r.axis === 'x') r.dir = (r.dir === 1 ? -1 : 1) as 1 | -1;
}

const WARM = 0xffc58a;
const SODIUM = 0xffa860;
const COOL = 0xcfe6ff;
const TEAM_A = 0xff6a1a;

export function buildSublevel9(): MapDef {
  const b = new Builder();

  // ------------------------------------------------------------------ shell (center-symmetric pieces)
  b.wallX(17 + TO / 2, -25 - TO, 25 + TO, H.outer, 'brick', [], { t: TO });
  b.wallX(-17 - TO / 2, -25 - TO, 25 + TO, H.outer, 'concrete', [], { t: TO });

  // Center floors
  b.floor(-9, -6, 9, 6, 'tileFloor', 'tile'); // showers
  b.floor(-19, 6, 19, 17, 'floor', 'concrete'); // boiler hall
  b.floor(-19, -17, 19, -6, 'floor', 'concrete'); // cell block

  // ------------------------------------------------------------------ SHOWERS (center)
  // North wall (to boiler hall) with two doors, south wall (to cells) with two breaches.
  const SHOWER_BANDS: [string, number][] = [['tileGreen', 1.2], ['tileWhite', 2.4]];
  b.wallX(6, -9, 9, H.boiler, 'plasterCream', [{ a: -6.2, b: -4.4 }, { a: 4.4, b: 6.2 }], { bands: SHOWER_BANDS, surface: 'tile' });
  b.wallX(-6, -9, 9, H.showers, 'plasterCream', [{ a: -6.4, b: -4.2, head: 2.9 }, { a: 4.2, b: 6.4, head: 2.9 }], { bands: SHOWER_BANDS, surface: 'tile' });
  // The shower ceiling is the roof here: a thick slab broken open over the drain.
  b.box(-9, H.showers, -6, 9, H.showers + 0.6, -2.2, 'concreteDark');
  b.box(-9, H.showers, 2.2, 9, H.showers + 0.6, 6, 'concreteDark');
  b.box(-9, H.showers, -2.2, -2.6, H.showers + 0.6, 2.2, 'concreteDark');
  b.box(2.6, H.showers, -2.2, 9, H.showers + 0.6, 2.2, 'concreteDark');
  // Outer roof over everything except the shower block
  b.box(-25.5, H.outer, -17.5, 25.5, H.outer + 0.4, -6, 'concreteDark');
  b.box(-25.5, H.outer, 6, 25.5, H.outer + 0.4, 17.5, 'concreteDark');
  b.box(-25.5, H.outer, -6, -9, H.outer + 0.4, 6, 'concreteDark');
  b.box(9, H.outer, -6, 25.5, H.outer + 0.4, 6, 'concreteDark');
  // Jagged broken edges + hanging rebar around the roof hole
  b.prop('holeEdge', 0, H.showers, -2.2, 0, 52, undefined);
  b.prop('holeEdge', 0, H.showers, 2.2, Math.PI, 53, undefined);
  b.prop('holeEdge', -2.6, H.showers, 0, -Math.PI / 2, 44, undefined);
  b.prop('holeEdge', 2.6, H.showers, 0, Math.PI / 2, 45, undefined);
  // Central drain + capture point
  b.prop('drain', 0, 0, 0);
  // Rubble from the collapse (mirrored pairs keep it fair)
  b.mirror(() => {
    b.prop('rubble', -2.9, 0, 1.3, 0.4, 1);
    b.prop('rubble', -1.3, 0, -2.1, 1.2, 2);
    b.prop('slab', -3.4, 0, -0.6, Math.PI / 2, 3);
    // Full-height tiled pillars around the drain: strafe-peek cover
    for (const pz of [3.2, -3.2]) {
      b.box(-4.35, 0, pz - 0.35, -3.65, 1.2, pz + 0.35, 'tileGreen', { surface: 'tile' });
      b.box(-4.35, 1.2, pz - 0.35, -3.65, 2.4, pz + 0.35, 'tileWhite', { surface: 'tile' });
      b.box(-4.35, 2.4, pz - 0.35, -3.65, H.showers, pz + 0.35, 'plasterCream', { surface: 'concrete' });
    }
    // Crouch-height tiled partition walls (1.2 m)
    b.box(-7.4, 0, -0.1, -5.0, 1.2, 0.1, 'tileWhite', { surface: 'tile' });
    b.box(-7.5, 1.2, -0.14, -4.9, 1.28, 0.14, 'tileGreen', { surface: 'tile' });
    // Shower stall stubs along north and south walls (1.9 m), shower heads in between
    for (const x of [-8.2, -3.0, -1.4]) {
      b.box(x - 0.06, 0, 5.0, x + 0.06, 1.95, 5.85, 'tileWhite', { surface: 'tile' });
      b.box(x - 0.06, 0, -5.85, x + 0.06, 1.95, -5.0, 'tileWhite', { surface: 'tile' });
    }
    for (const x of [-7.4, -2.2, -0.7]) {
      b.prop('showerHead', x, 2.05, 5.85, 0);
      b.prop('showerHead', x, 2.05, -5.85, Math.PI);
    }
    // West wall to lockers with two doors
    b.wallZ(-9, -6, 6, H.showers, 'plasterCream', [{ a: -4.0, b: -2.2 }, { a: 2.2, b: 4.0 }], { bands: [['tileGreen', 1.2], ['tileWhite', 2.4]], surface: 'tile' });
    // Rubble at breach feet
    b.prop('rubble', -5.3, 0, -6.45, 0, 4);
    b.prop('rubble', -5.3, 0, -5.55, 2.4, 5);
    // Lights: caged tubes (one flickering)
    b.light([-5.6, H.showers - 0.12, 3.2], COOL, 5.5, 11, 'tube', { priority: 2, shadow: true });
    b.light([-5.6, H.showers - 0.12, -3.2], COOL, 5.5, 11, 'tube', { priority: 2, flicker: b.mirrored ? 0 : 3 });
    b.decal([-8.84, 1.9, 0.0], [1, 0, 0], [2.4, 1.0], 'graffiti', { text: 'NO WAY\nOUT', color: '#c8331c' });
    b.decal([-6.0, 0.01, 1.6], [0, 1, 0], [3.0, 2.2], 'puddle');
    b.decal([-3.2, 0.01, -3.8], [0, 1, 0], [2.4, 1.6], 'puddle');
  });
  b.decal([0, 2.3, 5.84], [0, 0, -1], [2.2, 0.9], 'sign', { text: 'SHOWERS\nBLOCK C', color: '#d9d2c0' });
  b.decal([0, 0.01, 0], [0, 1, 0], [6.5, 6.5], 'puddle');

  // ------------------------------------------------------------------ BOILER HALL (center + mirrored)
  b.ceiling(-19, 6, 19, 17, H.boiler, 'concreteDark', []);
  // Catwalk along north wall at 2.8 m
  const CW = { z0: 14.4, z1: 16.75, y: 2.8 };
  b.box(-12.5, CW.y - 0.2, CW.z0, 12.5, CW.y, CW.z1, 'diamond', { top: 'diamond', surface: 'metal' });
  b.box(-12.5, CW.y, CW.z0 - 0.05, 12.5, CW.y + 1.0, CW.z0 + 0.05, 'paintGrey', { surface: 'metal' });
  b.box(-12.55, CW.y + 1.0, CW.z0 - 0.08, 12.55, CW.y + 1.08, CW.z0 + 0.08, 'paintOrange', { surface: 'metal' });
  // Center boiler
  b.prop('boiler', 0, 0, 10.9, 0, 0);
  b.mirror(() => {
    b.prop('boiler', -8, 0, 10.6, 0, 1);
    // Ramp up to catwalk, open at the bottom, railing on the upper part
    b.ramp(-17.6, 0, CW.z0, -12.5, CW.y, CW.z1, 'x', 1, 'diamond');
    b.box(-15.4, 1.0, CW.z0 - 0.05, -12.5, CW.y + 1.0, CW.z0 + 0.05, 'paintGrey', { surface: 'metal' });
    // Catwalk supports
    for (const x of [-12.4, -8.3, -4.2]) b.box(x - 0.12, 0, CW.z0 + 0.02, x + 0.12, CW.y - 0.2, CW.z0 + 0.26, 'paintGrey', { surface: 'metal' });
    // Floor clutter: crates, valve station, pipe bundle
    b.prop('crate', -16.6, 0, 7.4, 0, 0);
    b.prop('crate', -16.6, 1.0, 7.4, 0.2, 1);
    b.prop('crate', -15.5, 0, 7.3, Math.PI / 2, 2);
    b.prop('valve', -4.2, 0, 7.6, 0, 0);
    b.prop('pipes', -12.6, 0, 9.0, Math.PI / 2, 0);
    b.prop('barrel', -18.3, 0, 12.2, 0, 0);
    b.prop('barrel', -17.7, 0, 12.5, 0, 1);
    b.prop('crateSmall', -11.0, CW.y, 15.7, 0.3, 0);
    // Lights: sodium pendants over the floor, furnace glow
    b.light([-12.0, 5.2, 10.2], SODIUM, 7, 16, 'pendant', { priority: 1 });
    b.light([-4.2, 5.2, 9.0], SODIUM, 6, 14, 'pendant', { priority: 1 });
    b.light([-8.0, 0.9, 8.85], 0xff6a1c, 3.2, 6, 'none', { priority: 3, flicker: 9 });
    b.light([-15.0, 4.6, 15.6], WARM, 4.5, 10, 'cage', { priority: 1 });
    b.decal([-18.84, 3.4, 12.0], [1, 0, 0], [3.0, 1.1], 'sign', { text: 'BOILER ROOM\nB-9', color: '#e6c84a' });
    b.decal([-8.0, 0.012, 13.6], [0, 1, 0], [2.4, 1.5], 'puddle');
  });
  b.light([0, 0.9, 9.15], 0xff6a1c, 3.2, 6, 'none', { priority: 3, flicker: 11 });
  b.light([0, 5.2, 13.2], SODIUM, 5, 14, 'pendant', { priority: 1 });

  // ------------------------------------------------------------------ CELL BLOCK (center + mirrored)
  const CORR = { z0: -10.4, z1: -6 };
  const CELL = { z0: -14.6, z1: -10.4 };
  b.ceiling(-19, CORR.z0, 19, CORR.z1, H.corridor, 'concreteDark');
  b.ceiling(-19, -17, 19, CORR.z0, H.cells, 'concreteDark');
  // Guard booth at the corridor center: crouch walls + bars + roof
  b.box(-1.6, 0, -9.0, 1.6, 1.15, -8.85, 'paintGreen', { surface: 'metal' });
  b.box(-1.6, 0, -7.55, 1.6, 1.15, -7.4, 'paintGreen', { surface: 'metal' });
  b.box(-1.6, 0, -8.85, -1.45, 1.15, -7.55, 'paintGreen', { surface: 'metal' });
  b.box(1.45, 0, -8.85, 1.6, 1.15, -7.55, 'paintGreen', { surface: 'metal' });
  b.box(-1.7, 2.35, -9.1, 1.7, 2.45, -7.3, 'paintGrey', { surface: 'metal' });
  b.box(-1.6, 1.15, -9.0, 1.6, 2.35, -7.4, 'black', { visible: false, opaque: false, surface: 'metal' });
  b.prop('bars', 0, 1.15, -8.925, 0, 32);
  b.prop('bars', 0, 1.15, -7.475, 0, 32);
  b.prop('desk', 0, 0, -8.2, 0, 0);
  b.light([0, 2.3, -8.2], WARM, 3.2, 7, 'cage', { priority: 2 });
  b.decal([0, 2.8, -6.16], [0, 0, 1], [2.6, 0.8], 'sign', { text: 'CELL BLOCK 9', color: '#d6d0bf' });
  b.mirror(() => {
    // Cell front wall with doors, partitions, back wall with breaches
    const doors: Opening[] = [];
    for (let i = 0; i < 6; i++) {
      const cx = -16.5 + i * 3;
      doors.push({ a: cx - 0.55, b: cx + 0.55, head: 2.2 });
    }
    b.wallX(CELL.z1, -19, 0, H.corridor, 'concrete', doors, { wainscot: ['paintGreen', 1.3] });
    for (let i = 0; i <= 6; i++) {
      const x = -18 + i * 3;
      if (x === -9) {
        // broken partition: knee-high stub + rubble
        b.box(x - T / 2, 0, CELL.z0, x + T / 2, 0.55, CELL.z1, 'concrete');
        b.prop('rubble', x, 0, -12.5, 0.8, 7);
        continue;
      }
      if (x === 0) continue; // center line handled after mirror
      b.wallZ(x, CELL.z0, CELL.z1, H.cells, 'concrete');
    }
    const backOpen: Opening[] = [
      { a: -14.4, b: -12.6, head: 2.3 },
      { a: -2.4, b: -0.6, head: 2.3 },
    ];
    b.wallX(CELL.z0, -19, 0, H.cells, 'concrete', backOpen);
    b.prop('rubble', -13.5, 0, CELL.z0 - 0.5, 2.0, 8);
    b.prop('rubble', -1.5, 0, CELL.z0 + 0.5, 0.5, 9);
    // Cell furniture
    for (let i = 0; i < 6; i++) {
      const cx = -16.5 + i * 3;
      if (i % 2 === 0) b.prop('bunk', cx - 0.95, 0, -12.8, Math.PI / 2, i);
      else b.prop('bunk', cx + 0.95, 0, -12.8, Math.PI / 2, i);
      b.prop('toilet', cx + (i % 2 === 0 ? 0.95 : -0.95), 0, -14.15, Math.PI, i);
      if (i === 1 || i === 4) b.light([cx, H.cells - 0.15, -12.5], WARM, 2.2, 6, 'cage', { flicker: i + 20, priority: 0 });
    }
    // Corridor clutter: overturned bunk + mattress + barrels
    b.prop('bunkTipped', -11.2, 0, -7.0, 0, 0);
    b.prop('mattress', -6.0, 0, -9.6, 0.4, 0);
    b.prop('barrel', -16.6, 0, -6.6, 0, 3);
    b.prop('crate', -4.3, 0, -9.7, 0.0, 4);
    // Corridor lights
    b.light([-15.0, H.corridor - 0.15, -8.2], WARM, 4.2, 10, 'cage', { priority: 1 });
    b.light([-7.5, H.corridor - 0.15, -8.2], WARM, 4.0, 10, 'cage', { priority: 1, flicker: b.mirrored ? 0 : 5 });
    b.light([-18.5, 2.6, -15.8], 0xff2a12, 3.0, 7, 'emergency', { priority: 0 });
    for (let i = 0; i < 6; i++) b.decal([-16.5 + i * 3, 2.55, CELL.z1 + 0.16], [0, 0, 1], [0.5, 0.35], 'number', { text: `C${String(i + 1).padStart(2, '0')}`, color: '#e8e2d0' });
    b.decal([-12.0, 1.6, CORR.z1 - 0.16], [0, 0, -1], [2.4, 1.0], 'graffiti', { text: 'LOCKDOWN', color: '#e05a1a' });
  });
  // Center partition between the two center cells
  b.wallZ(0, CELL.z0, CELL.z1, H.cells, 'concrete');
  b.wallX(-17 + 0.05, -19, 19, 0.3, 'concreteDark', [], { t: 0.1 }); // chase floor curb
  b.prop('pipes', 0, 0, -16.2, 0, 1);

  // ------------------------------------------------------------------ WEST COLUMN + LOCKERS (mirrored)
  b.mirror(() => {
    const W = -19;
    // Floors
    b.floor(-25, -6, -19, 6, 'floor', 'concrete');
    b.floor(-25, 6, -19, 17, 'floor', 'concrete');
    b.floor(-25, -17, -19, -6, 'tileFloor', 'tile');
    b.floor(-19, -6, -9, 6, 'tileFloor', 'tile');
    // Outer west wall
    b.wallZ(-25 - TO / 2, -17 - TO, 17 + TO, H.outer, 'concrete', [], { t: TO });
    // x = -19 separation with doors (pump->boiler, spawn->lockers x2, laundry->corridor, laundry->chase)
    b.wallZ(W, -17, 17, H.boiler, 'concrete', [
      { a: 8.5, b: 11.0 },
      { a: 1.6, b: 3.4 },
      { a: -3.4, b: -1.6 },
      { a: -9.4, b: -7.2 },
      { a: -16.4, b: -15.0, head: 2.2 },
    ], { wainscot: ['paintGreen', 1.2] });
    // spawn north/south walls with doors into pump room & laundry
    b.wallX(6, -25, W, H.pump, 'concrete', [{ a: -23.6, b: -21.6 }], { wainscot: ['paintGreen', 1.2] });
    b.wallX(-6, -25, W, H.spawn, 'concrete', [{ a: -23.6, b: -21.6 }], { wainscot: ['paintGreen', 1.2] });
    // 1v1 shutters (only present in 1v1 playlists)
    b.box(-23.6, 0, 5.92, -21.6, DOOR_H, 6.08, 'rust', { surface: 'metal', tag: 'shutter1v1' });
    b.box(-23.6, 0, -6.08, -21.6, DOOR_H, -5.92, 'rust', { surface: 'metal', tag: 'shutter1v1' });
    // Ceilings
    b.ceiling(-25, -6, W, 6, H.spawn);
    b.ceiling(-25, 6, W, 17, H.pump);
    b.ceiling(-25, -17, W, -6, H.laundry);
    b.ceiling(W, -6, -9, 6, H.locker);
    // Locker room walls (north to boiler, south to corridor)
    b.wallX(6, W, -9, H.boiler, 'plasterCream', [{ a: -15.2, b: -13.2 }], { wainscot: ['plasterGreen', 1.3] });
    b.wallX(-6, W, -9, H.corridor, 'plasterCream', [{ a: -15.2, b: -13.2 }], { wainscot: ['plasterGreen', 1.3] });

    // --- INTAKE (spawn): check-in counter shields the doors; benches; detector frames
    b.box(-21.3, 0, -1.0, -20.6, 1.15, 1.0, 'paintGrey', { surface: 'metal' });
    b.box(-21.4, 1.15, -1.1, -20.5, 1.22, 1.1, 'wood', { surface: 'wood' });
    b.prop('bench', -24.4, 0, -2.5, Math.PI / 2, 0);
    b.prop('bench', -24.4, 0, 2.5, Math.PI / 2, 1);
    b.prop('detector', -19.6, 0, 2.5, Math.PI / 2, 0);
    b.prop('detector', -19.6, 0, -2.5, Math.PI / 2, 1);
    b.prop('crateSmall', -24.3, 0, 5.2, 0.2, 1);
    b.light([-24.6, H.spawn - 0.3, 0.0], b.mirrored ? 0x3cc8ff : TEAM_A, 1.6, 7, 'emergency', { priority: 1 });
    b.light([-21.8, H.spawn - 0.15, 2.6], WARM, 3.0, 8, 'cage', { priority: 2 });
    b.light([-21.8, H.spawn - 0.15, -2.6], WARM, 3.0, 8, 'cage', { priority: 2, flicker: b.mirrored ? 4 : 0 });
    b.decal([-24.73, 2.2, 0], [1, 0, 0], [3.2, 1.2], 'sign', { text: b.mirrored ? 'INTAKE B' : 'INTAKE A', color: b.mirrored ? '#3cc8ff' : '#ff6a1a' });

    // --- PUMP ROOM
    b.prop('pump', -22.8, 0, 9.8, Math.PI / 2, 0);
    b.prop('pump', -22.4, 0, 14.6, Math.PI / 2, 1);
    b.prop('crate', -20.0, 0, 15.9, 0.0, 5);
    b.prop('barrel', -24.2, 0, 7.0, 0, 4);
    b.prop('valve', -20.0, 0, 12.6, Math.PI / 2, 1);
    b.light([-22.0, H.pump - 0.15, 12.0], WARM, 3.8, 10, 'cage', { priority: 1, flicker: b.mirrored ? 7 : 0 });

    // --- LAUNDRY
    for (let i = 0; i < 4; i++) b.prop('washer', -24.3, 0, -15.6 + i * 1.25, -Math.PI / 2, i);
    b.box(-22.2, 0, -12.2, -20.8, 0.95, -9.0, 'paintGrey', { surface: 'metal' });
    b.box(-22.3, 0.95, -12.3, -20.7, 1.0, -8.9, 'chrome', { surface: 'metal' });
    b.prop('cart', -20.2, 0, -14.4, 0.6, 0);
    b.prop('cart', -23.4, 0, -7.6, -0.3, 1);
    b.light([-22.0, H.laundry - 0.15, -11.5], COOL, 3.6, 10, 'tube', { priority: 1, flicker: b.mirrored ? 0 : 12 });

    // --- LOCKER ROOM
    b.prop('lockersDouble', -15.9, 0, 0, Math.PI / 2, 6); // center island (back-to-back)
    b.prop('lockers', -12.0, 0, 5.55, 0, 4); // along north wall
    b.prop('lockers', -17.8, 0, -5.55, Math.PI, 3); // along south wall
    b.prop('lockersFallen', -11.4, 0, -3.9, 0, 0);
    b.prop('bench', -13.6, 0, 1.6, 0, 2);
    b.prop('bench', -13.6, 0, -1.6, 0, 3);
    b.light([-14.0, H.locker - 0.12, 3.0], COOL, 4.0, 10, 'tube', { priority: 1 });
    b.light([-14.0, H.locker - 0.12, -3.0], COOL, 3.6, 10, 'tubeBroken', { priority: 1, flicker: 15 });
    b.decal([-9.16, 2.2, 0], [-1, 0, 0], [2.2, 0.9], 'sign', { text: 'LOCKER ROOM', color: '#d8d0b8' });
  });

  // ------------------------------------------------------------------ spawns
  const spawns: MapDef['spawns'] = [];
  for (let i = 0; i < 6; i++) {
    const z = -3.75 + i * 1.5;
    spawns.push({ team: 0, pos: [-23.4, 0, z], yaw: -Math.PI / 2 });
    spawns.push({ team: 1, pos: [23.4, 0, z], yaw: Math.PI / 2 });
  }

  const probes: MapDef['probes'] = [
    { pos: [0, 1.7, 0], min: [-9, 0, -6], max: [9, 5, 6] },
    { pos: [0, 2.4, 10.5], min: [-19, 0, 6], max: [19, 7, 17] },
    { pos: [0, 1.7, -8.2], min: [-19, 0, -17], max: [19, 4, -6] },
    { pos: [-14, 1.7, 0], min: [-19, 0, -6], max: [-9, 4, 6] },
    { pos: [14, 1.7, 0], min: [9, 0, -6], max: [19, 4, 6] },
    { pos: [-22, 1.7, 0], min: [-25, 0, -17], max: [-19, 4, 17] },
    { pos: [22, 1.7, 0], min: [19, 0, -17], max: [25, 4, 17] },
  ];

  return {
    id: 'sublevel9',
    name: 'Sublevel 9',
    bounds: { min: [-25, -0.5, -17], max: [25, H.outer, 17] },
    brushes: b.brushes,
    ramps: b.ramps,
    props: b.props,
    lights: b.lights,
    decals: b.decals,
    spawns,
    capture: { pos: [0, 0, 0], radius: 2.5 },
    probes,
    skyHoles: [{ min: [-2.6, H.showers + 0.6, -2.2], max: [2.6, H.showers + 0.6, 2.2] }],
    moonDir: [0.12, -1, 0.08],
  };
}
