import { Builder, T, type Opening } from './builder';
import type { LightDef, MapDef } from './mapTypes';

// SUBLEVEL 9: a flooded prison bunker on three levels, 72 m x 48 m, mirrored across x = 0.
// Design doc: docs/maps/sublevel9.md. North is +z.
//
//  z=+24 +--------+-----------+------------------------+-----------+--------+
//        | PUMP   | GENERATORS|  BOILER HALL (catwalk) | GENERATORS| PUMP   |
//        | ROOM A |  A (stair)|  boilers, trench, spine|  B (stair)| ROOM B |
//  z=+11 |        +-----------+------------------------+-----------+        |
//  z=+8  +--------+           |  north balcony (U)     |           +--------+
//        | INTAKE | LOCKERS A |  COLLAPSE: pit down to | LOCKERS B | INTAKE |
//        |   A    | (drain    |  the CISTERN (B), split|  (drain   |   B    |
//        | spawn  |  stairs)  |  stairs to balconies   |   stairs) | spawn  |
//  z=-8  +--------+           |  south balcony (U)     |           +--------+
//  z=-9  |        +-----------+------------------------+-----------+        |
//        | LAUNDRY| INFIRMARY |  CELL BLOCK 9: two     | INFIRMARY | LAUNDRY|
//        |   A    |    A      |  tiers, gallery, gantry|    B      |   B    |
//  z=-24 +--------+-----------+------------------------+-----------+--------+
//       x=-36    x=-24       x=-11                    x=+11       x=+24    x=+36
//
// Levels: B (cistern and drains) -2.8 m, G (main floor) 0, U (catwalks, balconies, gallery) 3.2 m.
// Only the west half (x < 0) and the center line are authored; `mirror()` emits the east half.

const B = -2.8;
const U = 3.2;
const TO = 0.5; // exterior wall thickness

const H = {
  intake: 3.6,
  laundry: 3.6,
  infirmary: 3.8,
  lockers: 4.0,
  pump: 4.6,
  generator: 6.4,
  boiler: 7.2,
  atrium: 7.6,
  cells: 6.2,
  outer: 8.0,
};

/** Collapse in the atrium floor down to the cistern [x0, z0, x1, z1]. */
const PIT: [number, number, number, number] = [-6, -4.5, 6, 4.5];
/** Cistern under the atrium (half extents). */
const CIS = { x: 9.5, z: 7.5 };
/** Roof opening over the pit (moonlight). */
const SKY: [number, number, number, number] = [-4, -3, 4, 3];
/** Drain tunnel under each locker room: z half-width and the stair top (west end). */
const DRAIN = { z: 1.2, stairTop: -20.6, stairFoot: -15 };

const WARM = 0xffc58a;
const SODIUM = 0xffa860;
const COOL = 0xcfe6ff;
const SUMP = 0x5fe0c8;
const AMBER = 0xffb030;
const TEAM_A = 0xff6a1a;
const TEAM_B = 0x3cc8ff;
const RED = 0xff2a12;

/**
 * Mood pass over the fixtures: sickly green fluorescents, warm tungsten cages, sodium pendants
 * swinging on chains with dust cones, dead and dying fixtures, red emergency accents.
 */
function restyleLights(lights: LightDef[]): void {
  lights.forEach((l, i) => {
    switch (l.fixture) {
      case 'tube':
        l.color = 0xe4fbe9;
        l.intensity *= 0.6;
        l.distance = Math.min(l.distance, 8.5);
        break;
      case 'tubeBroken':
        l.color = 0xe4fbe9;
        l.broken = true;
        l.flicker = l.flicker || 15;
        break;
      case 'cage':
        l.kelvin = 3300;
        l.intensity *= 0.7;
        l.distance = Math.min(l.distance, 7.5);
        l.shadow = true;
        // every third low-priority cage is dead
        if (l.priority === 0 && i % 3 === 0) l.broken = true;
        break;
      case 'pendant':
        l.kelvin = 2900;
        l.intensity *= 0.8;
        l.cone = true;
        l.angle = 0.8;
        l.shadow = true;
        if (i % 2 === 0) l.swing = 0.1;
        break;
      case 'none':
        // furnace mouths: a warm fire glow, not a saturated orange flood
        if (l.color === 0xff6a1c) {
          l.color = 0xff9a5c;
          l.intensity *= 0.8;
        }
        break;
      default:
        break;
    }
  });
}

const TILE_BANDS: [string, number][] = [['tileGreen', 1.2], ['tileWhite', 2.4]];
const GREEN_WAINSCOT: [string, number] = ['paintGreen', 1.2];

export function buildSublevel9(): MapDef {
  const b = new Builder();

  // ------------------------------------------------------------------ shell
  b.wallX(24 + TO / 2, -36 - TO, 36 + TO, H.outer, 'brick', [], { t: TO });
  b.wallX(-24 - TO / 2, -36 - TO, 36 + TO, H.outer, 'concrete', [], { t: TO });
  b.mirror(() => b.wallZ(-36 - TO / 2, -24 - TO, 24 + TO, H.outer, 'concrete', [], { t: TO }));
  // one roof over everything; only the collapse is open to the sky
  b.ceiling(-36.5, -24.5, 36.5, 24.5, H.outer, 'concreteDark', SKY);

  atrium(b);
  cistern(b);
  boilerHall(b);
  cellBlock(b);
  b.mirror(() => {
    lockers(b);
    drain(b);
    generators(b);
    infirmary(b);
    intake(b);
    pumpRoom(b);
    laundry(b);
  });

  // ------------------------------------------------------------------ spawns: 8 per side for 1v1 up to 4v4 and beyond
  const spawns: MapDef['spawns'] = [];
  for (let i = 0; i < 8; i++) {
    const z = -5.25 + i * 1.5;
    const x = 33.2 - (i % 2) * 0.9;
    spawns.push({ team: 0, pos: [-x, 0, z], yaw: -Math.PI / 2 });
    spawns.push({ team: 1, pos: [x, 0, z], yaw: Math.PI / 2 });
  }

  // central points of interest (sides are added in their rooms)
  b.poi(0, B, 2.4);
  b.poi(0, B, -2.4);
  b.poi(0, U, 16.5);
  b.poi(0, U, -13.5);
  b.poi(0, 0, 15.6);
  b.poi(0, 0, -11.2);
  b.poi(0, 0, 7.4);
  b.poi(0, 0, -7.2);

  // callouts: more specific zones first (walkways over halls, the cistern under the collapse)
  const zones = [
    ...b.zones.filter((z) => z.name !== 'BOILER HALL' && z.name !== 'COLLAPSE' && z.name !== 'CELL BLOCK'),
    ...b.zones.filter((z) => z.name === 'BOILER HALL' || z.name === 'COLLAPSE' || z.name === 'CELL BLOCK'),
  ];

  const probes: MapDef['probes'] = [
    { pos: [0, 1.7, 7.2], min: [-11, -0.5, -9], max: [11, H.atrium, 11] },
    { pos: [0, -1.2, -5.8], min: [-CIS.x, B, -CIS.z], max: [CIS.x, -0.4, CIS.z] },
    { pos: [0, 2.2, 15.6], min: [-11, -1, 11], max: [11, H.boiler, 24] },
    { pos: [0, 1.7, -12], min: [-11, 0, -24], max: [11, H.cells, -9] },
  ];
  for (const s of [-1, 1]) {
    probes.push({ pos: [s * 17.5, 1.7, 3], min: [s > 0 ? 11 : -24, 0, -9], max: [s > 0 ? 24 : -11, H.lockers, 11] });
    probes.push({ pos: [s * 30, 1.7, 0], min: [s > 0 ? 24 : -36, 0, -8], max: [s > 0 ? 36 : -24, H.intake, 8] });
  }

  restyleLights(b.lights);

  return {
    id: 'sublevel9',
    name: 'Sublevel 9',
    bounds: { min: [-36, -3.2, -24], max: [36, H.outer + 0.4, 24] },
    brushes: b.brushes,
    ramps: b.ramps,
    props: b.props,
    lights: b.lights,
    decals: b.decals,
    spawns,
    capture: { pos: [0, B, 0], radius: 2.5, name: 'CISTERN' },
    zones,
    water: b.waters,
    pois: b.pois,
    navTopY: U + 0.4,
    probes,
    skyHoles: [{ min: [SKY[0], H.outer + 0.4, SKY[1]], max: [SKY[2], H.outer + 0.4, SKY[3]] }],
    moonDir: [0.12, -1, 0.08],
  };
}

// ==================================================================== COLLAPSE (atrium over the pit)

function atrium(b: Builder): void {
  // the old shower block: its floor fell into the cistern, the roof above it is gone
  b.floorAround(-11, -9, 11, 11, PIT, 'tileFloor', 'tile');
  b.ceiling(-11, -9, 11, 11, H.atrium, 'concreteDark', SKY);
  b.zone('COLLAPSE', -11, -0.5, -9, 11, H.atrium, 11);
  // jagged edges with rebar around the pit and the roof hole
  for (const [x, rot, v] of [[-3.1, Math.PI, 50], [3.1, Math.PI, 51]] as const) b.prop('holeEdge', x, 0, PIT[3], rot, v);
  for (const [x, rot, v] of [[-3.1, 0, 52], [3.1, 0, 53]] as const) b.prop('holeEdge', x, 0, PIT[1], rot, v);
  b.prop('holeEdge', 0, H.atrium, SKY[1], 0, 56);
  b.prop('holeEdge', 0, H.atrium, SKY[3], Math.PI, 57);
  b.decal([0, 2.25, 10.82], [0, 0, -1], [2.2, 0.8], 'sign', { text: 'SHOWERS\nBLOCK C', color: '#d9d2c0' });
  b.decal([0, 2.4, -8.82], [0, 0, 1], [2.6, 0.8], 'sign', { text: 'CELL BLOCK 9  ▼', color: '#d6d0bf' });

  // balconies at U along the north and south walls, joined to the boiler catwalk and the cell
  // gallery by the spine and the gantry
  b.catwalk(-11, 8.6, 11, 11, U);
  b.catwalk(-11, -9, 11, -6.6, U);
  b.rail('x', 8.6, -9.2, 9.2, U);
  b.rail('x', -6.6, -9.2, 9.2, U);
  b.zone('NORTH BALCONY', -11, U - 0.4, 8.6, 11, H.atrium, 11);
  b.zone('SOUTH BALCONY', -11, U - 0.4, -9, 11, H.atrium, -6.6);
  b.poi(0, U, 9.8);
  b.poi(0, U, -7.8);

  b.mirror(() => {
    // walls to the locker rooms: one door at each corner, under the balconies
    b.wallZ(-11, -9, 11, H.atrium, 'plasterCream', [{ a: -8.8, b: -6.8 }, { a: 8.8, b: 10.8 }], { bands: TILE_BANDS, surface: 'tile' });
    // split stairs on the side wall: one flight up to each balcony
    b.stairs(-10.85, 0, 0.6, -9.2, U, 8.6, 'z', 1, 'diamond', 'metal');
    b.stairs(-10.85, 0, -6.6, -9.2, U, 0, 'z', -1, 'diamond', 'metal');
    // rubble ramp from the cistern floor up to the atrium (one per side)
    b.ramp(PIT[0], B, -3.6, -1.8, 0, -1.4, 'x', -1, 'concrete', 'concrete');
    b.prop('rubble', -2.4, B, -4.15, 0.3, 11);
    b.prop('rubble', -4.6, B, -0.85, 1.9, 12);
    b.prop('rubble', -6.9, 0, -4.5, 0.7, 13);
    // the rim: low broken curbs to crouch behind, open in between
    b.box(-6.9, 0, 2.2, -6.25, 0.55, 3.6, 'concrete', { surface: 'concrete' });
    b.box(-4.6, 0, 4.75, -2.6, 0.5, 5.35, 'concrete', { surface: 'concrete' });
    b.box(-4.6, 0, -5.35, -3.0, 0.5, -4.75, 'concrete', { surface: 'concrete' });
    // shower stall stubs and heads on the end walls, between the openings
    for (const x of [-4.4, -2.6]) {
      b.box(x - 0.06, 0, 10.0, x + 0.06, 1.95, 10.85, 'tileWhite', { surface: 'tile' });
      b.box(x - 0.06, 0, -8.85, x + 0.06, 1.95, -8.0, 'tileWhite', { surface: 'tile' });
    }
    for (const x of [-3.5, -1.6]) {
      b.prop('showerHead', x, 2.05, 10.85, 0);
      b.prop('showerHead', x, 2.05, -8.85, Math.PI);
    }
    // cover on the balconies: steel plates you crouch behind, gaps to peek through
    b.box(-7.4, U, 8.75, -6.0, U + 0.95, 8.9, 'rust', { surface: 'metal' });
    b.box(-7.4, U, -6.9, -6.0, U + 0.95, -6.75, 'rust', { surface: 'metal' });
    b.prop('crateSmall', -9.9, U, 10.4, 0.2, 2);
    b.prop('crateSmall', -4.2, U, -8.4, -0.3, 3);
    // crates and a fallen locker on the atrium floor
    b.prop('crate', -8.2, 0, 4.4, 0.15, 3);
    b.prop('crate', -8.1, 0, -3.8, -0.1, 4);
    // lights: tubes under the balconies, red emergency lamps on them, moonlight through the roof
    b.light([-6.5, U - 0.32, 9.8], COOL, 4.6, 9, 'tube', { priority: 2 });
    b.light([-6.5, U - 0.32, -7.8], COOL, 4.2, 9, 'tube', { priority: 2, flicker: b.mirrored ? 0 : 3 });
    b.light([-10.6, U + 2.2, 9.8], RED, 2.4, 7, 'emergency', { priority: 1 });
    b.light([-10.6, U + 2.2, -7.8], RED, 2.4, 7, 'emergency', { priority: 1 });
    // cages over the balcony walkways
    b.light([-3.6, U + 2.5, 10.55], WARM, 3.2, 8, 'cage', { priority: 1 });
    b.light([-3.6, U + 2.5, -8.75], WARM, 3.2, 8, 'cage', { priority: 1, flicker: b.mirrored ? 0 : 6 });
    b.light([-9.0, H.atrium - 0.3, 1.5], SODIUM, 5.5, 13, 'pendant', { priority: 1 });
    b.decal([-10.84, 1.9, 4.6], [1, 0, 0], [2.4, 1.0], 'graffiti', { text: 'NO WAY\nOUT', color: '#c8331c' });
    b.decal([-8.6, 0.01, 6.4], [0, 1, 0], [2.6, 1.8], 'puddle');
    b.decal([-8.0, 0.01, -6.2], [0, 1, 0], [2.2, 1.6], 'puddle');
    b.poi(-8.5, 0, 6.2);
    b.poi(-8.5, 0, -5.4);
    b.poi(-7.6, 0, 0.2);
    b.poi(-6.0, U, 9.8);
    b.poi(-6.0, U, -7.8);
  });
}

// ==================================================================== CISTERN (B, under the collapse; overtime objective)

function cistern(b: Builder): void {
  b.floor(-CIS.x, -CIS.z, CIS.x, CIS.z, 'floor', 'concrete', B);
  b.water(-CIS.x, -CIS.z, CIS.x, CIS.z, B, B + 0.22);
  b.zone('CISTERN', -CIS.x, B - 0.4, -CIS.z, CIS.x, -0.45, CIS.z);
  b.wallX(CIS.z + T / 2, -CIS.x - T, CIS.x + T, 2.4, 'concrete', [], { y0: B, wainscot: ['concreteDark', 0.9] });
  b.wallX(-CIS.z - T / 2, -CIS.x - T, CIS.x + T, 2.4, 'concrete', [], { y0: B, wainscot: ['concreteDark', 0.9] });
  // the sump pump at the drain: chest-high housing, its broken riser pipe climbing into the moonlight
  b.box(-1.3, B, -0.7, 1.3, B + 1.1, 0.7, 'paintGreen', { surface: 'metal' });
  b.box(-1.36, B + 1.1, -0.76, 1.36, B + 1.18, 0.76, 'darkMetal', { surface: 'metal' });
  b.box(-0.35, B + 1.18, -0.35, 0.35, 6.2, 0.35, 'rust', { surface: 'metal' });
  b.prop('drain', 0, B, 1.6);
  // the objective reads from anywhere: a work lamp clamped to the riser, a slow red beacon on the pump
  b.light([0.5, B + 2.4, 0], SUMP, 3.6, 10, 'cage', { priority: 3 });
  b.light([-0.5, B + 2.4, 0], SUMP, 3.6, 10, 'cage', { priority: 3 });
  b.light([0, B + 1.32, 0.0], RED, 1.4, 6, 'beacon', { priority: 2, spin: 1.6 });
  // the crawl spaces under the rim: lamps in the middle of the north and south runs
  b.light([0, -0.72, 6.6], SUMP, 2.6, 7, 'cage', { priority: 2 });
  b.light([0, -0.72, -6.6], SUMP, 2.6, 7, 'cage', { priority: 2, flicker: 33 });
  b.decal([0, -1.0, CIS.z - 0.16], [0, 0, -1], [2.4, 0.8], 'sign', { text: 'CISTERN 9', color: '#d6d0bf' });
  b.mirror(() => {
    b.wallZ(-CIS.x - T / 2, -CIS.z, CIS.z, 2.4, 'concrete', [{ a: -DRAIN.z, b: DRAIN.z, head: 2.4 }], { y0: B, wainscot: ['concreteDark', 0.9], noTrim: true });
    // pillars holding up the floor around the collapse
    for (const [x, z, w] of [[-7.75, 5.9, 0.7], [-7.75, -5.9, 0.7], [-3.2, 6.1, 0.6], [-3.2, -6.1, 0.6], [-7.75, 2.7, 0.6], [-7.75, -2.7, 0.6]] as const) {
      b.box(x - w / 2, B, z - w / 2, x + w / 2, -0.4, z + w / 2, 'concrete', { surface: 'concrete' });
    }
    // fallen floor plates leaning on rubble (rise toward the middle on both sides)
    b.prop('slab', -3.6, B, 2.7, b.mirrored ? Math.PI : 0, 21);
    b.prop('rubble', -5.2, B, 5.6, 0.6, 22);
    b.prop('pipes', -6.0, B, -6.9, 0, 2);
    b.prop('valve', -8.9, B, 4.6, Math.PI / 2, 2);
    // sump lamps: an eerie green-cyan down here, nothing like the rooms above
    b.light([-9.2, -0.9, 4.2], SUMP, 2.6, 7, 'cage', { priority: 2 });
    b.light([-9.2, -0.9, -4.2], SUMP, 2.4, 7, 'cage', { priority: 2, flicker: b.mirrored ? 0 : 7 });
    b.light([-4.4, -0.8, -7.2], SUMP, 2.4, 7, 'cage', { priority: 1 });
    b.light([-6.2, -0.8, 7.2], SUMP, 2.4, 7, 'cage', { priority: 1 });
    b.light([-3.2, -0.75, 5.65], SUMP, 2.2, 6, 'cage', { priority: 1 });
    b.light([-3.2, -0.75, -5.65], SUMP, 2.2, 6, 'cage', { priority: 1 });
    b.decal([-CIS.x + 0.16, -1.1, 3.0], [1, 0, 0], [1.8, 0.7], 'sign', { text: b.mirrored ? 'DRAIN 2B ▶' : '◀ DRAIN 2A', color: '#d6d0bf' });
    b.poi(-7.6, B, 0);
    b.poi(-5.0, B, 5.6);
    b.poi(-5.0, B, -5.8);
  });
}

// ==================================================================== BOILER HALL (G + catwalk at U)

function boilerHall(b: Builder): void {
  const TR = { z0: 12.6, z1: 13.8, y: -0.6 };
  // thick floor so the drainage trench has solid sides
  b.box(-11, -1.0, 11, 11, 0, TR.z0, 'floor', { surface: 'concrete', walk: true });
  b.box(-11, -1.0, TR.z1, 11, 0, 24, 'floor', { surface: 'concrete', walk: true });
  b.floor(-11, TR.z0, 11, TR.z1, 'concreteDark', 'concrete', TR.y);
  b.water(-11, TR.z0, 11, TR.z1, TR.y, TR.y + 0.1);
  b.ceiling(-11, 11, 11, 24, H.boiler, 'concreteDark');
  b.zone('BOILER HALL', -11, -1, 11, 11, H.boiler, 24);
  b.zone('TRENCH', -11, TR.y - 0.5, TR.z0, 11, -0.2, TR.z1);
  // wall to the atrium: two wide openings at G, the spine passes through at U
  const atriumOpenings: Opening[] = [
    { a: -8.5, b: -5.5, head: 2.8 },
    { a: 5.5, b: 8.5, head: 2.8 },
    { a: -1.2, b: 1.2, sill: U, head: U + 2.5 },
  ];
  b.wallX(11, -11, 11, H.atrium, 'plasterCream', atriumOpenings, { bands: TILE_BANDS, surface: 'tile' });
  // catwalk along the north wall through both generator rooms, and the spine down to the balcony
  b.catwalk(-23.85, 21.6, 23.85, 24, U);
  b.catwalk(-1.2, 11, 1.2, 21.6, U);
  b.rail('z', -1.2, 11.15, 21.6, U);
  b.rail('z', 1.2, 11.15, 21.6, U);
  b.rail('x', 21.6, -18.8, -1.2, U);
  b.rail('x', 21.6, 1.2, 18.8, U);
  b.zone('CATWALK', -23.85, U - 0.4, 21.6, 23.85, H.generator, 24);
  b.zone('SPINE', -1.2, U - 0.4, 11, 1.2, H.boiler, 21.6);
  for (const z of [15.2, 18.6]) for (const x of [-1.0, 1.0]) b.box(x - 0.1, 0, z - 0.1, x + 0.1, U - 0.2, z + 0.1, 'paintGrey', { surface: 'metal' });
  b.prop('valve', 0, 0, 23.2, Math.PI, 3);
  b.light([0, H.boiler - 0.3, 23.0], SODIUM, 5.0, 13, 'pendant', { priority: 1 });
  b.decal([0, 5.0, 23.83], [0, 0, -1], [3.0, 1.1], 'sign', { text: 'BOILER ROOM\nB-9', color: '#e6c84a' });
  b.mirror(() => {
    // the trench climbs out at both ends
    b.ramp(-11, TR.y, TR.z0, -9.6, 0, TR.z1, 'x', -1, 'concrete', 'concrete');
    b.prop('boiler', -6, 0, 18.4, 0, b.mirrored ? 1 : 0);
    for (const x of [-4, -8.5]) b.box(x - 0.11, 0, 21.7, x + 0.11, U - 0.2, 21.92, 'paintGrey', { surface: 'metal' });
    // cover on the hall floor
    b.prop('crate', -9.6, 0, 20.3, 0.1, 0);
    b.prop('crate', -9.5, 1.0, 20.3, 0.35, 1);
    b.prop('crate', -8.5, 0, 20.5, Math.PI / 2, 2);
    b.prop('valve', -3.0, 0, 15.6, 0, 0);
    b.prop('barrel', -10.3, 0, 14.6, 0, 0);
    b.prop('barrel', -9.7, 0, 14.9, 0, 1);
    b.prop('pipes', -5.5, 0, 23.1, 0, 0);
    b.prop('crateSmall', -11.0 + 1.1, U, 23.3, 0.3, 0);
    // furnace glow and sodium pendants
    b.light([-6, 0.9, 16.75], 0xff6a1c, 3.2, 6, 'none', { priority: 3, flicker: b.mirrored ? 11 : 9 });
    b.light([-6.5, H.boiler - 0.4, 13.8], SODIUM, 6.5, 15, 'pendant', { priority: 1 });
    b.light([-3.4, H.boiler - 0.6, 20.0], SODIUM, 5.5, 13, 'pendant', { priority: 1 });
    b.light([-5.5, U - 0.32, 22.8], COOL, 3.4, 8, 'tube', { priority: 1, flicker: b.mirrored ? 0 : 9 });
    b.light([-9.5, 5.4, 23.4], WARM, 4.0, 10, 'cage', { priority: 1 });
    b.decal([-7.0, 0.012, 21.0], [0, 1, 0], [2.4, 1.5], 'puddle');
    b.poi(-8.5, 0, 17.0);
    b.poi(-3.2, 0, 19.8);
    b.poi(-7.0, -0.6, 13.2);
    b.poi(-8.0, U, 22.8);
  });
}

// ==================================================================== CELL BLOCK 9 (G corridor, two tiers of cells, gallery at U)

function cellBlock(b: Builder): void {
  const C = { back: -24, front: -20, gallery: -18 };
  b.floor(-11, -24, 11, -9, 'floor', 'concrete');
  b.ceiling(-11, -24, 11, -9, H.cells, 'concreteDark');
  b.zone('GALLERY', -11, U - 0.4, -24, 11, H.cells, C.gallery);
  b.zone('GANTRY', -1.2, U - 0.4, C.gallery, 1.2, H.cells, -9);
  b.zone('CELL BLOCK', -11, -0.5, -24, 11, H.cells, -9);
  // wall to the atrium: two openings at G, the gantry passes through at U
  b.wallX(-9, -11, 11, H.atrium, 'plasterCream', [
    { a: -8.5, b: -5.5, head: 2.8 },
    { a: 5.5, b: 8.5, head: 2.8 },
    { a: -1.2, b: 1.2, sill: U, head: U + 2.5 },
  ], { wainscot: GREEN_WAINSCOT });
  // upper tier: cell floors, the gallery and the gantry across the corridor
  b.box(-10.85, U - 0.3, C.back, 10.85, U, C.front, 'concrete', { top: 'floor', surface: 'concrete', walk: true });
  b.catwalk(-10.85, C.front, 10.85, C.gallery, U);
  b.catwalk(-1.2, C.gallery, 1.2, -9, U);
  b.rail('x', C.gallery, -9.2, -1.2, U);
  b.rail('x', C.gallery, 1.2, 9.2, U);
  b.rail('z', -1.2, C.gallery, -9.15, U);
  b.rail('z', 1.2, C.gallery, -9.15, U);
  for (const z of [-12.5, -15.5]) for (const x of [-1.0, 1.0]) b.box(x - 0.1, 0, z - 0.1, x + 0.1, U - 0.2, z + 0.1, 'paintGrey', { surface: 'metal' });
  b.box(-10.85, U + 2.6, C.back, 10.85, U + 2.9, C.front, 'concreteDark');
  // guard booth in the middle of the corridor: crouch walls, bars, a roof
  const bz = -14.4;
  b.box(-1.6, 0, bz - 0.8, 1.6, 1.15, bz - 0.65, 'paintGreen', { surface: 'metal' });
  b.box(-1.6, 0, bz + 0.65, 1.6, 1.15, bz + 0.8, 'paintGreen', { surface: 'metal' });
  b.box(-1.6, 0, bz - 0.65, -1.45, 1.15, bz + 0.65, 'paintGreen', { surface: 'metal' });
  b.box(1.45, 0, bz - 0.65, 1.6, 1.15, bz + 0.65, 'paintGreen', { surface: 'metal' });
  b.box(-1.7, 2.35, bz - 0.9, 1.7, 2.45, bz + 0.9, 'paintGrey', { surface: 'metal' });
  b.box(-1.6, 1.15, bz - 0.8, 1.6, 2.35, bz + 0.8, 'black', { visible: false, opaque: false, surface: 'metal' });
  b.prop('bars', 0, 1.15, bz - 0.725, 0, 32);
  b.prop('bars', 0, 1.15, bz + 0.725, 0, 32);
  b.prop('desk', 0, 0, bz, 0, 0);
  b.light([0, 2.3, bz], WARM, 3.2, 7, 'cage', { priority: 2 });
  b.mirror(() => {
    b.stairs(-10.85, 0, C.gallery, -9.2, U, -11, 'z', -1, 'concrete', 'concrete');
    // cells: 3.35 m end cell, then 3 m cells; the middle one straddles the center line
    const doorsAt = [-9.2, -6.0, -3.0, 0];
    const doors: Opening[] = doorsAt.map((x) => (x === 0 ? { a: -0.55, b: 0, head: 2.2 } : { a: x - 0.55, b: x + 0.55, head: 2.2 }));
    b.wallX(C.front, -10.85, 0, U - 0.3, 'concrete', doors, { wainscot: GREEN_WAINSCOT });
    b.wallX(C.front, -10.85, 0, 2.6, 'concrete', doors, { y0: U, wainscot: GREEN_WAINSCOT });
    for (const x of [-7.5, -4.5, -1.5]) {
      b.wallZ(x, C.back, C.front, U - 0.3, 'concrete');
      b.wallZ(x, C.back, C.front, 2.6, 'concrete', [], { y0: U });
    }
    doorsAt.forEach((x, i) => {
      if (x === 0) return;
      for (const y of [0, U]) {
        b.prop('bunk', x + (i % 2 ? 0.85 : -0.85), y, -22.6, Math.PI / 2, i + (y ? 4 : 0));
        b.prop('toilet', x + (i % 2 ? -0.85 : 0.85), y, -23.55, Math.PI, i);
      }
      b.light([x, U - 0.45, -22.0], WARM, 2.0, 5.5, 'cage', { flicker: i + 20, priority: 0 });
      b.light([x, U + 2.45, -22.0], WARM, 2.0, 5.5, 'cage', { flicker: i + 24, priority: 0 });
      b.decal([x, 2.45, C.front + 0.16], [0, 0, 1], [0.5, 0.35], 'number', { text: `C${String(b.mirrored ? 7 - i : i + 1).padStart(2, '0')}`, color: '#e8e2d0' });
    });
    // corridor cover
    b.prop('bunkTipped', -6.6, 0, -12.0, 0, 0);
    b.prop('mattress', -4.0, 0, -17.0, 0.4, 0);
    b.prop('crate', -8.6, 0, -15.6, 0.0, 4);
    b.prop('barrel', -9.9, 0, -9.9, 0, 3);
    b.prop('barrel', -9.5, 0, -10.5, 0, 2);
    b.prop('crateSmall', -6.2, U, -19.4, 0.4, 1);
    // lights
    b.light([-7.0, 5.5, -12.0], SODIUM, 6.0, 13, 'pendant', { priority: 1 });
    b.light([-4.0, 5.5, -16.2], SODIUM, 5.5, 13, 'pendant', { priority: 1, flicker: b.mirrored ? 0 : 5 });
    b.light([-9.0, U + 2.4, -19.0], WARM, 3.0, 8, 'cage', { priority: 1 });
    b.light([-3.4, 2.5, -9.45], WARM, 3.2, 8, 'cage', { priority: 1 });
    b.light([-10.6, 2.4, -11.4], RED, 2.6, 7, 'emergency', { priority: 0 });
    b.light([-5.0, U + 2.3, -19.0], WARM, 3.0, 8, 'cage', { priority: 1 });
    b.decal([-8.0, 1.6, -9.16], [0, 0, -1], [2.4, 1.0], 'graffiti', { text: 'LOCKDOWN', color: '#e05a1a' });
    b.poi(-8.0, 0, -12.4);
    b.poi(-5.0, 0, -18.9);
    b.poi(-6.0, U, -19.0);
    b.poi(-6.0, U, -22.4);
    b.poi(-6.0, 0, -22.4);
  });
  // the middle cell (both tiers)
  for (const y of [0, U]) b.prop('bunk', 0, y, -22.6, Math.PI / 2, y ? 9 : 8);
  b.light([0, U - 0.45, -22.0], WARM, 2.0, 5.5, 'cage', { flicker: 27, priority: 0 });
}

// ==================================================================== WEST SIDE (mirrored)

function lockers(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.floorAround(-24, -9, -11, 11, [DRAIN.stairTop, -DRAIN.z, DRAIN.stairFoot, DRAIN.z], 'tileFloor', 'tile');
  b.ceiling(-24, -9, -11, 11, H.lockers);
  b.zone(`LOCKERS ${n}`, -24, -0.5, -9, -11, H.lockers, 11);
  // walls to the generator room and the infirmary
  b.wallX(11, -24, -11, H.generator, 'plasterCream', [{ a: -17.5, b: -15 }], { wainscot: ['plasterGreen', 1.3] });
  b.wallX(-9, -24, -11, H.lockers, 'plasterCream', [{ a: -17.5, b: -15 }], { wainscot: ['plasterGreen', 1.3] });
  // railings around the drain stairwell (open at the top of the stairs)
  b.rail('x', -DRAIN.z - 0.05, -19.4, DRAIN.stairFoot, 0);
  b.rail('x', DRAIN.z + 0.05, -19.4, DRAIN.stairFoot, 0);
  b.rail('z', DRAIN.stairFoot + 0.05, -DRAIN.z, DRAIN.z, 0);
  // locker islands, a fallen bank, benches
  b.prop('lockersDouble', -16.0, 0, 6.2, 0, 6);
  b.prop('lockersDouble', -16.0, 0, -5.6, 0, 7);
  b.prop('lockers', -21.2, 0, 10.55, Math.PI, 4);
  b.prop('lockers', -13.2, 0, -8.55, 0, 3);
  b.prop('lockersFallen', -13.0, 0, 2.6, 0, 0);
  b.prop('bench', -19.6, 0, 4.0, 0, 2);
  b.prop('bench', -19.6, 0, -4.0, 0, 3);
  b.prop('bench', -12.6, 0, -2.4, Math.PI / 2, 1);
  b.light([-17.5, H.lockers - 0.12, 4.6], COOL, 4.0, 10, 'tube', { priority: 1 });
  b.light([-17.5, H.lockers - 0.12, -4.6], COOL, 3.6, 10, 'tube', { priority: 1, flicker: 15 }); // buzzing, stutters now and then
  b.light([-22.4, H.lockers - 0.12, 0.0], COOL, 3.4, 9, 'tube', { priority: 1 });
  b.light([-12.8, H.lockers - 0.12, -1.6], COOL, 3.4, 9, 'tube', { priority: 1 });
  b.light([-12.4, H.lockers - 0.12, 8.0], COOL, 3.0, 8, 'tubeBroken', { priority: 0 });
  b.decal([-11.16, 2.2, 1.4], [-1, 0, 0], [2.2, 0.9], 'sign', { text: 'LOCKER ROOM', color: '#d8d0b8' });
  b.poi(-17.5, 0, 8.2);
  b.poi(-19.0, 0, -6.8);
  b.poi(-13.2, 0, 0.0);
}

function drain(b: Builder): void {
  const n = b.mirrored ? '2B' : '2A';
  // stairs from the locker room down to the drain, which runs east under the floor to the cistern
  b.stairs(DRAIN.stairTop, B, -DRAIN.z, DRAIN.stairFoot, 0, DRAIN.z, 'x', -1, 'concrete', 'concrete');
  b.floor(DRAIN.stairFoot, -DRAIN.z, -CIS.x, DRAIN.z, 'concreteDark', 'concrete', B);
  b.water(DRAIN.stairFoot, -DRAIN.z, -CIS.x, DRAIN.z, B, B + 0.1);
  for (const z of [-DRAIN.z - T / 2, DRAIN.z + T / 2]) b.wallX(z, DRAIN.stairTop, -CIS.x - T, 2.4, 'concrete', [], { y0: B, wainscot: ['concreteDark', 0.8] });
  b.zone(`DRAIN ${n}`, DRAIN.stairTop, B - 0.4, -DRAIN.z, -CIS.x, -1.0, DRAIN.z);
  b.prop('pipes', -12.4, B + 1.55, -0.86, 0, 1);
  b.light([-12.0, -0.75, 0], SUMP, 1.6, 5, 'emergency', { priority: 0, flicker: b.mirrored ? 30 : 0 });
  b.poi(-12.6, B, 0);
}

function generators(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.floor(-24, 11, -11, 24, 'floor', 'concrete');
  b.ceiling(-24, 11, -11, 24, H.generator);
  b.zone(`GENERATORS ${n}`, -24, -0.5, 11, -11, H.generator, 24);
  // wall to the boiler hall: a door at G, the catwalk passes through at U
  b.wallZ(-11, 11, 24, H.boiler, 'concrete', [{ a: 15.5, b: 18 }, { a: 21.6, b: 24, sill: U, head: U + 2.6 }], { wainscot: GREEN_WAINSCOT });
  // freestanding stairs up to the catwalk
  b.stairs(-20.4, 0, 12.8, -18.8, U, 21.6, 'z', 1, 'diamond', 'metal');
  b.rail('x', 21.6, -23.85, -20.4, U);
  b.prop('generator', -14.6, 0, 14.4, 0, b.mirrored ? 1 : 0);
  b.prop('generator', -14.6, 0, 18.6, Math.PI, b.mirrored ? 0 : 1);
  b.prop('barrel', -23.2, 0, 12.0, 0, 5);
  b.prop('barrel', -22.6, 0, 11.8, 0, 6);
  b.prop('barrel', -23.0, 0, 12.6, 0, 7);
  b.prop('crate', -12.2, 0, 22.9, 0.1, 2);
  b.prop('crateSmall', -12.3, 1.0, 22.9, 0.5, 2);
  for (const x of [-15, -22]) b.box(x - 0.11, 0, 21.7, x + 0.11, U - 0.2, 21.92, 'paintGrey', { surface: 'metal' });
  // amber warning beacons: the generator rooms read yellow from anywhere
  b.light([-11.4, 4.8, 13.0], AMBER, 3.2, 9, 'beacon', { priority: 2, spin: 2.4, rot: -Math.PI / 2 });
  b.light([-17.5, H.generator - 0.15, 16.5], WARM, 3.8, 10, 'cage', { priority: 1 });
  b.light([-22.0, 5.3, 23.4], WARM, 3.0, 8, 'cage', { priority: 1, flicker: b.mirrored ? 6 : 0 });
  b.light([-14.6, H.generator - 0.5, 16.5], SODIUM, 5.5, 13, 'pendant', { priority: 1 });
  b.light([-16.5, U - 0.32, 22.8], COOL, 3.2, 8, 'tube', { priority: 1 });
  b.light([-13.0, 5.4, 23.4], WARM, 3.0, 8, 'cage', { priority: 1 });
  b.decal([-23.84, 2.4, 15.6], [1, 0, 0], [3.0, 1.1], 'sign', { text: 'GENERATORS', color: '#e6c84a' });
  b.decal([-14.6, 0.01, 16.5], [0, 1, 0], [2.0, 1.3], 'puddle');
  b.poi(-16.8, 0, 16.5);
  b.poi(-12.6, 0, 20.4);
  b.poi(-21.6, U, 22.8);
}

function infirmary(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.floor(-24, -24, -11, -9, 'tileFloor', 'tile');
  b.ceiling(-24, -24, -11, -9, H.infirmary);
  b.zone(`INFIRMARY ${n}`, -24, -0.5, -24, -11, H.infirmary, -9);
  // wall to the cell block: one door, under the gallery
  b.wallZ(-11, -24, -9, H.cells, 'plasterCream', [{ a: -19.8, b: -18.2 }], { wainscot: ['plasterGreen', 1.3] });
  // nurse station: chest-high counters in the middle
  b.box(-19.4, 0, -16.9, -15.4, 1.15, -16.6, 'plasterGreen', { surface: 'concrete' });
  b.box(-19.4, 0, -16.6, -19.1, 1.15, -14.6, 'plasterGreen', { surface: 'concrete' });
  b.box(-19.5, 1.15, -17.0, -15.3, 1.22, -16.5, 'wood', { surface: 'wood' });
  b.prop('desk', -17.4, 0, -15.6, 0, 1);
  // beds along the walls, cabinets, curtain rails
  for (let i = 0; i < 4; i++) b.prop('bunk', -22.9, 0, -22.4 + i * 2.6, 0, 10 + i);
  for (const [z, v] of [[-22.9, 14], [-14.6, 15], [-12.2, 16]] as const) b.prop('bunk', -11.6, 0, z, Math.PI / 2, v);
  b.prop('lockers', -20.8, 0, -9.45, 0, 1);
  b.prop('cart', -15.0, 0, -11.6, 0.4, 2);
  for (const z of [-21.1, -18.5, -15.9]) b.box(-23.8, 2.2, z - 0.02, -21.8, 2.24, z + 0.02, 'chrome', { surface: 'metal', solid: false, opaque: false });
  b.light([-20.0, H.infirmary - 0.12, -19.5], COOL, 3.4, 9, 'tube', { priority: 1, flicker: b.mirrored ? 0 : 18 });
  b.light([-15.0, H.infirmary - 0.12, -13.0], COOL, 3.2, 9, 'tube', { priority: 1 });
  b.light([-15.0, H.infirmary - 0.12, -21.0], COOL, 2.6, 8, 'tubeBroken', { priority: 0 });
  b.decal([-11.16, 2.2, -14.0], [-1, 0, 0], [2.2, 0.9], 'sign', { text: 'INFIRMARY', color: '#d8e8dc' });
  b.decal([-21.0, 0.01, -12.5], [0, 1, 0], [1.8, 1.2], 'puddle');
  b.poi(-17.2, 0, -12.2);
  b.poi(-14.2, 0, -19.2);
}

function intake(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.floor(-36, -8, -24, 8, 'floor', 'concrete');
  b.ceiling(-36, -8, -24, 8, H.intake);
  b.zone(`INTAKE ${n}`, -36, -0.5, -8, -24, H.intake, 8);
  // walls: two doors to the locker room, one each to the pump room and the laundry (shut in 1v1)
  b.wallZ(-24, -8, 8, H.lockers, 'concrete', [{ a: -5, b: -3 }, { a: 3, b: 5 }], { wainscot: GREEN_WAINSCOT });
  b.wallX(8, -36, -24, H.pump, 'concrete', [{ a: -33, b: -31 }], { wainscot: GREEN_WAINSCOT });
  b.wallX(-8, -36, -24, H.laundry, 'concrete', [{ a: -33, b: -31 }], { wainscot: GREEN_WAINSCOT });
  b.box(-33, 0, 7.92, -31, 2.5, 8.08, 'rust', { surface: 'metal', tag: 'shutter1v1' });
  b.box(-33, 0, -8.08, -31, 2.5, -7.92, 'rust', { surface: 'metal', tag: 'shutter1v1' });
  // check-in counter between the doors, benches, metal detectors in the doorways
  b.box(-26.4, 0, -1.4, -25.7, 1.15, 1.4, 'paintGrey', { surface: 'metal' });
  b.box(-26.5, 1.15, -1.5, -25.6, 1.22, 1.5, 'wood', { surface: 'wood' });
  b.prop('bench', -35.4, 0, -2.6, Math.PI / 2, 0);
  b.prop('bench', -35.4, 0, 2.6, Math.PI / 2, 1);
  b.prop('detector', -24.6, 0, 4, Math.PI / 2, 0);
  b.prop('detector', -24.6, 0, -4, Math.PI / 2, 1);
  b.prop('crateSmall', -35.3, 0, 6.9, 0.2, 1);
  b.light([-35.6, H.intake - 0.3, 0.0], b.mirrored ? TEAM_B : TEAM_A, 1.6, 7, 'emergency', { priority: 1 });
  // the spawn room is the one well-lit place: four cages over the floor
  b.light([-32.4, H.intake - 0.15, 3.6], WARM, 4.6, 8, 'cage', { priority: 2 });
  b.light([-32.4, H.intake - 0.15, -3.6], WARM, 4.6, 8, 'cage', { priority: 2, flicker: b.mirrored ? 4 : 0 });
  b.light([-27.4, H.intake - 0.15, 3.6], WARM, 4.2, 8, 'cage', { priority: 2 });
  b.light([-27.4, H.intake - 0.15, -3.6], WARM, 4.2, 8, 'cage', { priority: 2 });
  b.light([-35.2, H.intake - 0.4, 0.0], WARM, 4.2, 8, 'cage', { priority: 2 });
  b.decal([-35.73, 2.2, 0], [1, 0, 0], [3.2, 1.2], 'sign', { text: `INTAKE ${n}`, color: b.mirrored ? '#3cc8ff' : '#ff6a1a' });
  b.poi(-26.8, 0, 4.0);
  b.poi(-26.8, 0, -4.0);
}

function pumpRoom(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.floor(-36, 8, -24, 24, 'floor', 'concrete');
  b.ceiling(-36, 8, -24, 24, H.pump);
  b.zone(`PUMP ROOM ${n}`, -36, -0.5, 8, -24, H.pump, 24);
  b.wallZ(-24, 8, 24, H.generator, 'concrete', [{ a: 17.5, b: 20 }], { wainscot: GREEN_WAINSCOT });
  b.box(-24.08, 0, 17.5, -23.92, 2.5, 20, 'rust', { surface: 'metal', tag: 'shutter1v1' });
  b.prop('pump', -33.6, 0, 12.4, Math.PI / 2, 0);
  b.prop('pump', -33.2, 0, 18.6, Math.PI / 2, 1);
  b.prop('pipes', -29.0, 0, 23.2, 0, 2);
  b.prop('valve', -26.0, 0, 13.6, Math.PI / 2, 1);
  b.prop('crate', -25.2, 0, 22.8, 0.0, 5);
  b.prop('crate', -29.8, 0, 15.6, 0.3, 6);
  b.prop('barrel', -35.2, 0, 9.2, 0, 4);
  b.prop('barrel', -35.3, 0, 22.9, 0, 5);
  b.light([-30.0, H.pump - 0.15, 12.0], WARM, 3.8, 10, 'cage', { priority: 1, flicker: b.mirrored ? 7 : 0 });
  b.light([-30.0, H.pump - 0.15, 20.0], WARM, 3.4, 10, 'cage', { priority: 1 });
  b.decal([-35.73, 2.4, 16.0], [1, 0, 0], [3.0, 1.1], 'sign', { text: `PUMP ROOM ${n}`, color: '#d6d0bf' });
  b.decal([-31.0, 0.01, 21.0], [0, 1, 0], [2.4, 1.6], 'puddle');
  b.poi(-29.0, 0, 18.4);
  b.poi(-26.4, 0, 10.4);
}

function laundry(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.floor(-36, -24, -24, -8, 'tileFloor', 'tile');
  b.ceiling(-36, -24, -24, -8, H.laundry);
  b.zone(`LAUNDRY ${n}`, -36, -0.5, -24, -24, H.laundry, -8);
  b.wallZ(-24, -24, -8, H.infirmary, 'concrete', [{ a: -14, b: -12 }], { wainscot: GREEN_WAINSCOT });
  b.box(-24.08, 0, -14, -23.92, 2.5, -12, 'rust', { surface: 'metal', tag: 'shutter1v1' });
  for (let i = 0; i < 5; i++) b.prop('washer', -35.3, 0, -22.6 + i * 1.25, -Math.PI / 2, i);
  // folding tables
  b.box(-31.2, 0, -19.2, -29.8, 0.95, -15.4, 'paintGrey', { surface: 'metal' });
  b.box(-31.3, 0.95, -19.3, -29.7, 1.0, -15.3, 'chrome', { surface: 'metal' });
  b.box(-27.4, 0, -22.6, -26.0, 0.95, -19.6, 'paintGrey', { surface: 'metal' });
  b.box(-27.5, 0.95, -22.7, -25.9, 1.0, -19.5, 'chrome', { surface: 'metal' });
  b.prop('cart', -28.0, 0, -12.4, 0.6, 0);
  b.prop('cart', -33.0, 0, -10.2, -0.3, 1);
  b.light([-30.0, H.laundry - 0.15, -18.0], COOL, 3.6, 10, 'tube', { priority: 1, flicker: b.mirrored ? 0 : 12 });
  b.light([-30.0, H.laundry - 0.15, -11.0], COOL, 3.0, 9, 'tube', { priority: 1 });
  b.decal([-35.73, 2.2, -16.0], [1, 0, 0], [2.6, 1.0], 'sign', { text: `LAUNDRY ${n}`, color: '#d6d0bf' });
  b.poi(-28.6, 0, -16.0);
  b.poi(-26.4, 0, -10.6);
}
