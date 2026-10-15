import { Builder, type Opening } from './builder';
import { makeTerrain, terrainHeight, type TerrainDef } from './terrain';
import type { LightDef, MapDef, PlantKind, PlantPlacement } from './mapTypes';
import { Rng } from '@/shared/rng';

// MONSOON: a jungle outpost at night in a tropical downpour. 96 m x 72 m, mirrored across x = 0
// (team A in the west jungle, team B in the east). Design doc: docs/maps/monsoon.md. North is +z.
//
//  z=+36  jungle ............. RIDGE + WATCHTOWER (searchlight), MG nest ............. jungle
//         SWAMP A (boardwalk)                                                SWAMP B (boardwalk)
//  z=+19  ...........+------------------------ sandbag perimeter ------------------------+......
//                    | MOTOR POOL A         COMMAND POST (stilts)          MOTOR POOL B |
//   JUNGLE A  CONTAINERS A   TENTS A        HELIPAD (wreck)        TENTS B   CONTAINERS B  JUNGLE B
//   (spawn)          | BARRACKS A               PUMP HOUSE              BARRACKS B   |   (spawn)
//  z=-19.5 ..........+-----------------------------+--+----------------------------------+......
//         river bank ======== RIVER ========= BRIDGE ========= RIVER ======== river bank
//  z=-36  jungle strip along the south bank
//       x=-48                                                                          x=+48

const W = 48;
const D = 36;
/** How far the ground and the jungle continue past the walls. */
const OUT_X = 14;
const OUT_Z = 12;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Ground height: flat base pad, jungle swells, the north ridge, swamp hollows, the river. */
export function monsoonHeight(x: number, z: number): number {
  const ax = Math.abs(x);
  const swell = 0.45 * Math.sin(ax * 0.21 + z * 0.13) + 0.35 * Math.sin(z * 0.27 - ax * 0.08 + 1.3) + 0.22 * Math.sin((ax + z) * 0.41);
  const base = (1 - smooth(30, 35, ax)) * (1 - smooth(18.5, 22.5, z)) * smooth(-23, -19.5, z);
  const ridge = 3.6 * smooth(21, 29, z) * (1 - smooth(14, 28, ax)) + 1.1 * smooth(24, 32, z);
  const swamp = -0.75 * smooth(29, 34, ax) * smooth(11, 16, z) * (1 - smooth(28, 32, z));
  let h = (1 - base) * (swell * 0.7 + ridge + swamp);
  // the river runs east-west along z = -28 under everything
  h -= 1.3 * (1 - smooth(2.4, 4.8, Math.abs(z + 28)));
  // spawn clearings: flat ground around the boardwalk platforms
  const c = 1 - smooth(6, 10, Math.hypot(ax - 43, z));
  return h * (1 - c) + 0.1 * c;
}

const FLOOD = 0xdfe8ff;
const SODIUM = 0xffa860;
const WARM = 0xffc58a;
const LANTERN = 0xffb46a;
const RED = 0xff2a12;
// team lanterns: a tint of the team color, not a saturated wash over the spawn
const TEAM_A = 0xffa070;
const TEAM_B = 0x9cc8e8;

export function buildMonsoon(): MapDef {
  const b = new Builder();
  // the ground runs on past the walls under the jungle that closes the map in (view only)
  const terrain = makeTerrain({ minX: -W - OUT_X, minZ: -D - OUT_Z, maxX: W + OUT_X, maxZ: D + OUT_Z, cell: 1, mat: 'jungleFloor', surface: 'dirt' }, monsoonHeight);
  terrain.overlay = { mat: 'mud', weights: mudWeights(terrain) };
  const ground = (x: number, z: number) => terrainHeight(terrain, x, z);

  // ------------------------------------------------------------------ edges: thick jungle closes the map
  b.mirror(() => b.box(-W, -3, -D, -W + 1, 12, D, 'black', { visible: false, opaque: false, surface: 'dirt' }));
  b.box(-W, -3, D - 1, W, 12, D, 'black', { visible: false, opaque: false, surface: 'dirt' });
  b.box(-W, -3, -D, W, 12, -D + 1, 'black', { visible: false, opaque: false, surface: 'dirt' });
  b.water(-W - OUT_X, -31.5, W + OUT_X, -24.5, -1.6, -0.85);

  // the whole walled base, checked last so the named areas inside it win
  b.zone('BASE', -35, -1, -20, 35, 8, 20);
  helipad(b);
  commandPost(b);
  ridge(b, ground);
  pumpHouseAndBridge(b, ground);
  b.mirror(() => {
    barracks(b);
    motorPool(b);
    containers(b);
    tents(b);
    perimeter(b);
    spawnArea(b, ground);
    swamp(b, ground);
  });

  // ------------------------------------------------------------------ spawns: 8 per side on the boardwalk platforms
  const spawns: MapDef['spawns'] = [];
  for (let i = 0; i < 8; i++) {
    const z = -5.25 + i * 1.5;
    const x = 43.4 - (i % 2) * 0.9;
    spawns.push({ team: 0, pos: [-x, 0.45, z], yaw: -Math.PI / 2 });
    spawns.push({ team: 1, pos: [x, 0.45, z], yaw: Math.PI / 2 });
  }

  // central points of interest
  b.poi(0, 0.15, -4.4);
  b.poi(0, 0.15, 6.4);
  b.poi(0, 1.8, 13.5);
  b.poi(0, 3.6, 26.5);
  b.poi(0, 0, -15.0);
  b.poi(0, 0.25, -27.0);

  const zones = [
    ...b.zones.filter((z) => z.name !== 'BASE'),
    ...b.zones.filter((z) => z.name === 'BASE'),
  ];

  restyle(b.lights);

  return {
    id: 'monsoon',
    name: 'Monsoon',
    bounds: { min: [-W, -2, -D], max: [W, 12, D] },
    brushes: b.brushes,
    ramps: b.ramps,
    props: b.props,
    lights: b.lights,
    decals: b.decals,
    spawns,
    capture: { pos: [0, 0.15, -3.4], radius: 2.5, name: 'HELIPAD' },
    zones,
    water: b.waters,
    pois: b.pois,
    navTopY: 5.5,
    probes: [{ pos: [0, 2.2, -8.5], min: [-W, -2, -D], max: [W, 12, D] }],
    skyHoles: [],
    moonDir: [0.32, -0.86, 0.22],
    wetMaxY: 99,
    outdoor: true,
    // the moon lights the cleared base; the jungle around it is under the canopy
    openSky: { min: [-31, -2, -20], max: [31, 12, 19.5] },
    fog: { color: 0x11171a, density: 0.03 },
    terrain,
    plants: scatterPlants(terrain, b),
    weather: { rain: 1, mist: 0.6, lightning: true, wind: 1 },
  };
}

/** Floodlights read cold, lanterns warm; dead and flickering fixtures as indoors. */
function restyle(lights: LightDef[]): void {
  for (const l of lights) {
    if (l.fixture === 'flood' || l.fixture === 'lamppost') {
      l.cone = true;
      l.shadow = true;
      l.angle = l.angle ?? 0.75;
    }
    if (l.fixture === 'searchlight') {
      l.cone = true;
      l.shadow = true;
    }
  }
}

// ==================================================================== HELIPAD (objective)

function helipad(b: Builder): void {
  b.box(-7, -0.6, -6, 7, 0.15, 6, 'concrete', { surface: 'concrete', walk: true });
  b.decal([0, 0.16, 0], [0, 1, 0], [7, 7], 'sign', { text: 'H', color: '#d6cfb4' });
  b.zone('HELIPAD', -7.5, -1, -6.5, 7.5, 6, 6.5);
  // the wreck lies nose north along the center line: the same cover from both sides
  b.prop('heliWreck', 0, 0.15, 2.0, 0, 0);
  b.light([0, 0.9, 4.6], 0xff7a2a, 2.6, 7, 'none', { priority: 2, flicker: 13 }); // embers in the engine bay
  b.mirror(() => {
    // sandbag corners and a pallet of crates
    b.prop('sandbags', -6.2, 0.15, -5.0, 0, 0);
    b.prop('sandbags', -6.9, 0.15, -3.9, Math.PI / 2, 1);
    b.prop('sandbags', -6.2, 0.15, 5.0, 0, 2);
    b.prop('crate', -4.6, 0.15, -1.2, 0.2, 3);
    b.prop('crateSmall', -4.4, 1.15, -1.1, 0.5, 2);
    // floodlights on poles at the corners, one of them dead
    pole(b, -7.6, 6.6, 5.4);
    pole(b, -7.6, -6.6, 5.4);
    b.light([-7.4, 5.3, 6.4], FLOOD, 9, 22, 'flood', { priority: 3, dir: [0.55, -0.7, -0.45], angle: 0.7 });
    b.light([-7.4, 5.3, -6.4], FLOOD, 9, 22, 'flood', { priority: 3, dir: [0.55, -0.7, 0.45], angle: 0.7, broken: !b.mirrored, flicker: b.mirrored ? 0 : 21 });
    b.poi(-5.0, 0.15, 3.0);
  });
}

/** A wooden pole for a floodlight or lamp. */
function pole(b: Builder, x: number, z: number, h: number): void {
  b.box(x - 0.09, -0.4, z - 0.09, x + 0.09, h, z + 0.09, 'deck', { surface: 'wood' });
}

// ==================================================================== COMMAND POST (on stilts, overlooking the pad)

function commandPost(b: Builder): void {
  const F = 1.8;
  b.box(-5, F - 0.2, 10, 5, F, 17, 'deck', { top: 'deck', surface: 'wood', walk: true });
  b.zone('COMMAND POST', -5.5, F - 0.5, 10, 5.5, 5, 17.5);
  const win: Opening[] = [{ a: -3.4, b: -2.2, sill: 0.9, head: 1.9 }, { a: 2.2, b: 3.4, sill: 0.9, head: 1.9 }, { a: -0.6, b: 0.6, head: 2.1 }];
  b.wallX(11, -5, 5, 2.6, 'deck', win, { y0: F, surface: 'wood', noTrim: true });
  b.wallX(17, -5, 5, 2.6, 'deck', [{ a: -1.8, b: -0.6, sill: 0.9, head: 1.9 }, { a: 0.6, b: 1.8, sill: 0.9, head: 1.9 }], { y0: F, surface: 'wood', noTrim: true });
  b.box(-5.6, F + 2.6, 9.6, 5.6, F + 2.75, 17.6, 'rust', { surface: 'metal' });
  b.rail('x', 10.05, -2.8, 2.8, F, { mat: 'deck', top: 'deck' });
  b.box(0.15, F + 2.75, 13.4, 0.3, F + 6.0, 13.55, 'darkMetal', { surface: 'metal' }); // radio mast
  b.light([0.22, F + 6.1, 13.47], RED, 1.6, 8, 'beacon', { priority: 1, spin: 1.2 });
  b.light([0, F + 1.9, 14.0], WARM, 3.4, 8, 'window', { priority: 2 });
  b.light([0, F + 2.3, 10.4], LANTERN, 2.4, 6, 'lantern', { priority: 1, swing: 0.15 });
  b.prop('desk', 0, F, 15.6, Math.PI, 2);
  b.prop('crateSmall', 3.2, F, 15.9, 0, 3);
  b.mirror(() => {
    b.wallZ(-5, 11, 17, 2.6, 'deck', [{ a: 13.2, b: 14.8, sill: 0.9, head: 1.9 }], { y0: F, surface: 'wood', noTrim: true });
    // stilts and stairs up to the porch
    for (const [x, z] of [[-4.8, 10.2], [-4.8, 16.8], [-1.5, 16.8]] as const) b.box(x - 0.12, -0.4, z - 0.12, x + 0.12, F - 0.2, z + 0.12, 'deck', { surface: 'wood' });
    b.stairs(-4.4, 0, 6.6, -3.0, F, 10, 'z', 1, 'deck', 'wood');
    b.poi(-3.6, 0, 7.6);
  });
}

// ==================================================================== RIDGE (north high ground) and WATCHTOWER

function ridge(b: Builder, ground: (x: number, z: number) => number): void {
  const top = ground(0, 28);
  b.zone('RIDGE', -20, -1, 21.5, 20, 12, 35);
  // sandbagged MG nest on the crest, open to the south
  b.prop('sandbags', 0, top, 26.2, 0, 3);
  b.mirror(() => {
    b.prop('sandbags', -1.9, ground(-1.9, 27.2), 27.2, Math.PI / 2, 4);
    b.prop('sandbags', -4.6, ground(-4.6, 25.8), 25.8, 0.3, 5);
  });
  // the watchtower is landmark only: posts, a platform and the sweeping searchlight up top
  const tz = 31;
  const ty = ground(0, tz);
  b.mirror(() => {
    for (const z of [tz - 1.3, tz + 1.3]) b.box(-1.45, ty - 0.4, z - 0.12, -1.21, ty + 7.6, z + 0.12, 'deck', { surface: 'wood' });
  });
  b.box(-1.8, ty + 7.6, tz - 1.7, 1.8, ty + 7.8, tz + 1.7, 'deck', { surface: 'wood' });
  b.box(-1.9, ty + 9.6, tz - 1.8, 1.9, ty + 9.75, tz + 1.8, 'rust', { surface: 'metal' });
  b.light([0, ty + 8.6, tz - 1.4], FLOOD, 14, 46, 'searchlight', { priority: 3, spin: 0.35, angle: 0.22, dir: [0, -0.35, -1] });
  b.poi(-6.0, ground(-6, 25), 25.0);
}

// ==================================================================== PUMP HOUSE and the BRIDGE over the river

function pumpHouseAndBridge(b: Builder, ground: (x: number, z: number) => number): void {
  b.floor(-4, -21.5, 4, -16.5, 'concrete', 'concrete', 0.05);
  b.zone('PUMP HOUSE', -4, -0.6, -21.5, 4, 3.4, -16.5);
  b.wallX(-16.5, -4, 4, 3.0, 'concrete', [{ a: -0.8, b: 0.8 }], { y0: 0.05, wainscot: ['paintGreen', 1.1] });
  b.wallX(-21.5, -4, 4, 3.0, 'concrete', [{ a: -2.6, b: -1.6, sill: 1.2, head: 2.0 }, { a: 1.6, b: 2.6, sill: 1.2, head: 2.0 }], { y0: 0.05, wainscot: ['paintGreen', 1.1] });
  b.box(-4.3, 3.05, -21.8, 4.3, 3.3, -16.2, 'concreteDark');
  b.prop('pump', 0, 0.05, -20.2, 0, 2);
  b.light([0, 2.9, -16.0], WARM, 3.0, 8, 'cage', { priority: 2 });
  b.light([0, 2.6, -19.0], 0xe4fbe9, 2.6, 7, 'tube', { priority: 1, flicker: 16 });
  b.mirror(() => b.wallZ(-4, -21.5, -16.5, 3.0, 'concrete', [{ a: -19.8, b: -18.2 }], { y0: 0.05, wainscot: ['paintGreen', 1.1] }));
  // bridge deck on posts, rails both sides
  const z0 = -33.5;
  const z1 = -22.5;
  b.box(-2.2, 0.05, z0, 2.2, 0.3, z1, 'deck', { top: 'deck', surface: 'wood', walk: true });
  // no standing room between the riverbed and the deck: keep everyone out from under it (shots pass)
  b.box(-2.2, -2.0, -31.5, 2.2, 0.05, -24.5, 'black', { visible: false, opaque: false, surface: 'wood' });
  b.zone('BRIDGE', -2.4, -0.5, z0, 2.4, 3, z1);
  b.zone('RIVER', -W, -2, -31.5, W, 1.2, -24.5);
  b.mirror(() => {
    b.rail('z', -2.15, z0 + 0.3, z1 - 0.3, 0.3, { mat: 'deck', top: 'deck' });
    for (const z of [-30, -26]) b.box(-2.0, -1.8, z - 0.14, -1.72, 0.05, z + 0.14, 'deck', { surface: 'wood' });
    pole(b, -2.7, z1 + 0.4, 4.0);
    b.light([-2.6, 4.0, z1 + 0.4], SODIUM, 5, 14, 'lamppost', { priority: 2, angle: 0.9 });
    b.poi(-12, ground(-12, -27.5), -27.5);
    b.poi(-24, ground(-24, -33), -33);
  });
  b.poi(0, 0.3, -30);
}

// ==================================================================== WEST SIDE (mirrored)

function barracks(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  const F = 0.6;
  const [x0, x1, z0, z1] = [-24, -12, -15, -7];
  b.box(x0, F - 0.3, z0, x1, F, z1, 'deck', { top: 'deck', surface: 'wood', walk: true });
  b.zone(`BARRACKS ${n}`, x0, -0.5, z0, x1, 3.4, z1);
  const windows: Opening[] = [-22, -19, -16, -13.6].map((x) => ({ a: x - 0.6, b: x + 0.6, sill: 0.95, head: 1.9 }));
  b.wallX(z1, x0, x1, 2.6, 'deck', windows, { y0: F, surface: 'wood', noTrim: true });
  b.wallX(z0, x0, x1, 2.6, 'deck', windows, { y0: F, surface: 'wood', noTrim: true });
  b.wallZ(x0, z0, z1, 2.6, 'deck', [{ a: -11.8, b: -10.2, head: 2.1 }], { y0: F, surface: 'wood', noTrim: true });
  b.wallZ(x1, z0, z1, 2.6, 'deck', [{ a: -11.8, b: -10.2, head: 2.1 }], { y0: F, surface: 'wood', noTrim: true });
  b.box(x0 - 0.5, F + 2.6, z0 - 0.6, x1 + 0.5, F + 2.75, z1 + 0.6, 'rust', { surface: 'metal' });
  // steps up to both doors
  b.ramp(x0 - 1.2, 0, -11.8, x0, F, -10.2, 'x', 1, 'deck', 'wood');
  b.ramp(x1, 0, -11.8, x1 + 1.2, F, -10.2, 'x', -1, 'deck', 'wood');
  for (let i = 0; i < 4; i++) {
    b.prop('bunk', -22 + i * 3, F, -13.9, 0, i);
    b.prop('bunk', -22 + i * 3, F, -8.1, Math.PI, i + 4);
  }
  b.prop('crate', -18, F, -11, 0.4, 2);
  // glowing windows and a lantern by each door
  b.light([-21, F + 2.1, -11], WARM, 3.2, 8, 'window', { priority: 2 });
  b.light([-15, F + 2.1, -11], WARM, 3.0, 8, 'window', { priority: 2, flicker: b.mirrored ? 0 : 25 });
  b.light([x0 - 0.4, F + 2.4, -9.7], LANTERN, 2.2, 6, 'lantern', { priority: 1, swing: 0.12 });
  b.light([x1 + 0.4, F + 2.4, -9.7], LANTERN, 2.2, 6, 'lantern', { priority: 1, swing: 0.12 });
  b.poi(-19.6, F, -11);
  b.poi(-25.6, 0, -11);
}

function motorPool(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.zone(`MOTOR POOL ${n}`, -25, -0.5, 5, -11, 4, 15);
  // tarp on poles over the vehicles
  for (const x of [-24, -18, -12]) for (const z of [6, 14]) b.box(x - 0.08, -0.4, z - 0.08, x + 0.08, 3.3, z + 0.08, 'darkMetal', { surface: 'metal' });
  b.box(-24.3, 3.3, 5.7, -11.7, 3.38, 14.3, 'canvas', { surface: 'fabric' });
  b.prop('truck', -20.6, 0, 10.2, Math.PI / 2, b.mirrored ? 1 : 0);
  b.prop('jeep', -14.4, 0, 9.0, -Math.PI / 2 + 0.25, b.mirrored ? 1 : 0);
  b.prop('barrel', -23.2, 0, 6.6, 0, 1);
  b.prop('barrel', -22.6, 0, 6.4, 0, 2);
  b.prop('barrel', -23.0, 0, 7.2, 0, 3);
  b.prop('generator', -12.9, 0, 13.0, Math.PI / 2, 1);
  b.prop('crate', -16.8, 0, 13.4, 0.1, 4);
  // the jeep's headlights are still on, aimed across the pool
  b.light([-12.6, 0.95, 9.4], 0xfff1d6, 6, 18, 'none', { priority: 2, dir: [1, -0.06, 0.25], angle: 0.45, cone: true });
  b.light([-18, 3.1, 10], SODIUM, 3.4, 9, 'cage', { priority: 1 });
  b.poi(-17.4, 0, 7.0);
  b.poi(-22.5, 0, 13.0);
}

function containers(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.zone(`CONTAINERS ${n}`, -35, -0.5, -9, -25, 6, 9);
  b.prop('container', -30.0, 0, -5.6, 0, 0);
  b.prop('container', -27.6, 0, 1.2, Math.PI / 2, 1);
  b.prop('container', -32.2, 0, 3.4, Math.PI / 2, 2);
  b.prop('container', -32.2, 2.59, 3.4, Math.PI / 2, 3);
  b.prop('container', -30.6, 0, 7.6, 0, 4);
  // crates to climb onto the low containers
  b.prop('crate', -29.4, 0, -3.95, 0, 1);
  b.prop('crate', -29.4, 1.0, -3.95, 0.15, 2);
  pole(b, -26.0, -8.6, 6.0);
  b.light([-26.0, 5.9, -8.4], FLOOD, 8, 20, 'flood', { priority: 2, dir: [-0.6, -0.65, 0.45], angle: 0.75 });
  b.poi(-29.0, 0, -1.6);
  b.poi(-33.6, 0, -2.0);
}

function tents(b: Builder): void {
  const n = b.mirrored ? 'B' : 'A';
  b.zone(`TENTS ${n}`, -15, -0.5, -5, -8, 3, 5);
  b.prop('tent', -11.5, 0, -2.7, Math.PI / 2, 0);
  b.prop('tent', -11.5, 0, 2.7, Math.PI / 2, 1);
  b.light([-9.0, 1.9, 0], LANTERN, 2.0, 6, 'lantern', { priority: 1, swing: 0.1 });
  b.poi(-9.0, 0, 0);
}

function perimeter(b: Builder): void {
  // sandbag walls along the west edge of the base (gate in the middle) and the north and south edges
  for (const z of [-17.8, -15.8, -13.8, -7.4, -5.4, 5.4, 7.4, 13.8, 15.8]) b.prop('sandbags', -31.0, 0, z, Math.PI / 2, Math.abs(Math.round(z)));
  for (const x of [-29.6, -27.6, -25.6, -9.0, -7.0]) {
    b.prop('sandbags', x, 0, 18.6, 0, Math.abs(Math.round(x)));
    b.prop('sandbags', x, 0, -19.2, 0, Math.abs(Math.round(x)) + 1);
  }
  for (const z of [-17, -6.4, 6.4, 15]) b.prop('razorWire', -32.2, 0, z, Math.PI / 2, Math.abs(Math.round(z)));
  pole(b, -31.6, 3.0, 5.6);
  b.light([-31.5, 5.5, 3.0], FLOOD, 8, 20, 'flood', { priority: 2, dir: [-0.7, -0.6, -0.35], angle: 0.75 });
  b.light([-5.0, 4.2, 9.0], SODIUM, 4.6, 13, 'lamppost', { priority: 1 });
  pole(b, -5.2, 9.0, 4.2);
}

function spawnArea(b: Builder, ground: (x: number, z: number) => number): void {
  const n = b.mirrored ? 'B' : 'A';
  // boardwalk platform in the clearing, lanterns in the team color
  b.box(-46, 0.25, -6.5, -40, 0.45, 6.5, 'deck', { top: 'deck', surface: 'wood', walk: true });
  b.zone(`JUNGLE ${n}`, -W, -2, -24, -35, 10, 24);
  for (const [x, z] of [[-46.2, -6.7], [-46.2, 6.7], [-39.8, -6.7], [-39.8, 6.7]] as const) b.box(x - 0.1, -0.5, z - 0.1, x + 0.1, 2.4, z + 0.1, 'deck', { surface: 'wood' });
  b.light([-39.8, 2.5, -6.7], b.mirrored ? TEAM_B : TEAM_A, 1.4, 7, 'lantern', { priority: 2 });
  b.light([-39.8, 2.5, 6.7], b.mirrored ? TEAM_B : TEAM_A, 1.4, 7, 'lantern', { priority: 2 });
  b.light([-46.2, 2.5, 0], LANTERN, 2.0, 7, 'lantern', { priority: 1 });
  b.poi(-37.5, ground(-37.5, 0), 0);
  b.poi(-38.5, ground(-38.5, -13), -13);
  // a lantern on a post where the south trail leaves the clearing, a fire in a drum by the river
  const ty = ground(-36.6, -12.2);
  b.box(-36.67, ty - 0.4, -12.27, -36.53, ty + 2.2, -12.13, 'deck', { surface: 'wood' });
  b.light([-36.6, ty + 2.05, -12.2], LANTERN, 1.8, 7, 'lantern', { priority: 1 });
  const fy = ground(-15.5, -23.2);
  b.prop('barrel', -15.5, fy, -23.2, 0, 5);
  b.light([-15.5, fy + 1.15, -23.2], 0xff8a3a, 3.2, 8, 'none', { priority: 2, flicker: 9 });
}

function swamp(b: Builder, ground: (x: number, z: number) => number): void {
  const n = b.mirrored ? 'B' : 'A';
  b.water(-46, 12, -29, 31, -1.2, -0.42);
  b.zone(`SWAMP ${n}`, -W, -2, 12, -27, 6, 33);
  // boardwalk from the spawn clearing up through the swamp toward the ridge
  b.box(-44.2, 0.2, 6.5, -42.4, 0.4, 24.5, 'deck', { top: 'deck', surface: 'wood', walk: true });
  b.box(-44.2, 0.2, 22.7, -30.5, 0.4, 24.5, 'deck', { top: 'deck', surface: 'wood', walk: true });
  for (let z = 8; z < 24; z += 3) b.box(-44.0, -1.4, z - 0.08, -42.6, 0.2, z + 0.08, 'deck', { surface: 'wood' });
  // lanterns hung on posts along the boardwalk, one guttering
  for (const [x, z, f] of [[-42.25, 10.5, 0], [-42.25, 19.0, 27], [-36.0, 22.55, 0]] as const) {
    b.box(x - 0.07, -1.2, z - 0.07, x + 0.07, 2.1, z + 0.07, 'deck', { surface: 'wood' });
    b.light([x, 1.95, z], LANTERN, 1.7, 7, 'lantern', { priority: 1, flicker: b.mirrored ? 0 : f });
  }
  b.poi(-43.3, 0.4, 18);
  b.poi(-36, 0.4, 23.6);
  b.poi(-24, ground(-24, 26), 26);
}

// ==================================================================== mud

/** Mud over the ground: roads and paths between the buildings, trampled base ground, river banks. */
function mudWeights(t: TerrainDef): Float32Array {
  // [x0, z0, x1, z1, half width] segments, west half (mirrored)
  const roads: [number, number, number, number, number][] = [
    [-33, 0, -7, 0, 2.2], // west gate to the helipad
    [0, -6, 0, -22.5, 1.8], // helipad to the pump house and bridge
    [0, 6, 0, 10, 1.6], // helipad to the command post stairs
    [0, 17, 0, 26, 1.3], // up the ridge to the MG nest
    [-18, 0, -18, -6.5, 1.4], // to the barracks
    [-25, -11, -18, -11, 1.0],
    [-18, 0, -18, 6, 1.6], // motor pool
    [-41, 0, -33, 0, 1.6], // spawn clearing to the gate
    [-30, 9, -24, 18, 1.2],
  ];
  const segDist = (x: number, z: number, [x0, z0, x1, z1]: number[]) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l2 = dx * dx + dz * dz || 1;
    const k = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
    return Math.hypot(x - (x0 + dx * k), z - (z0 + dz * k));
  };
  const w = new Float32Array(t.nx * t.nz);
  for (let j = 0; j < t.nz; j++) {
    for (let i = 0; i < t.nx; i++) {
      const x = t.originX + i * t.cell;
      const z = t.originZ + j * t.cell;
      const ax = -Math.abs(x);
      const breakup = 0.75 + 0.25 * Math.sin(x * 1.7 + z * 0.9) * Math.sin(z * 1.3 - x * 0.4);
      let v = 0;
      for (const r of roads) v = Math.max(v, 1 - smooth(r[4] * 0.6, r[4] * 1.4, segDist(ax, z, r)));
      if (inBase(x, z)) v = Math.max(v, 0.35);
      const bank = Math.abs(Math.abs(z + 28) - 3.6);
      v = Math.max(v, 1 - smooth(0.6, 2.2, bank));
      w[j * t.nx + i] = Math.min(1, v * breakup);
    }
  }
  return w;
}

// ==================================================================== plants

/** Where the base stands: few plants inside, the jungle all around. */
function inBase(x: number, z: number): boolean {
  return Math.abs(x) < 31.5 && z < 19.5 && z > -20;
}

/** Deterministic, mirrored scatter: thick jungle outside the base, a few plants inside. */
function scatterPlants(t: TerrainDef, b: Builder): PlantPlacement[] {
  const rng = new Rng(9091);
  const out: PlantPlacement[] = [];
  // keep plants off walkways, platforms, buildings and the river channel
  const blockers = b.brushes.filter((br) => br.solid !== false || br.walk);
  const clear = (x: number, z: number, r: number) => {
    for (const br of blockers) if (x > br.min[0] - r && x < br.max[0] + r && z > br.min[2] - r && z < br.max[2] + r) return false;
    for (const p of b.props) if (Math.hypot(p.pos[0] - x, p.pos[2] - z) < r + 1.4) return false;
    return true;
  };
  const add = (kind: PlantKind, x: number, z: number, scale: number) => {
    const v = rng.int(0, 2);
    const rot = rng.next() * Math.PI * 2;
    // the spawn clearings stay open (checked after the draws so every other plant keeps its place)
    if (kind !== 'fern' && kind !== 'grass' && Math.hypot(Math.abs(x) - 43, z) < 8) return;
    const y = terrainHeight(t, x, z);
    out.push({ kind, pos: [x, y, z], rot, scale, v });
    out.push({ kind, pos: [-x, terrainHeight(t, -x, z), z], rot: -rot, scale, v });
  };
  const tryPlace = (kind: PlantKind, n: number, area: (x: number, z: number) => boolean, r: number, scale: [number, number]) => {
    for (let i = 0, tries = 0; i < n && tries < n * 30; tries++) {
      const x = -rng.range(0.5, W - 1.5);
      const z = rng.range(-D + 1.5, D - 1.5);
      if (!area(x, z) || !clear(x, z, r)) continue;
      add(kind, x, z, rng.range(scale[0], scale[1]));
      i++;
    }
  };
  const jungle = (x: number, z: number) => !inBase(x, z) && Math.abs(z + 28) > 3.2 && !(z < -31 && Math.abs(x) < 3);
  const riverBank = (x: number, z: number) => Math.abs(Math.abs(z + 28) - 4) < 1.4 && Math.abs(x) > 4;
  const baseEdge = (x: number, z: number) => inBase(x, z) && (Math.abs(x) > 27 || z > 16 || z < -17) && Math.abs(x) > 2;
  // giants first, hand-tuned spots around the spawn clearing and the jungle edges
  for (const [x, z, s] of [
    [-38.5, -10.5, 1.0], [-38.0, 11.0, 1.1], [-46.0, -14.5, 0.9], [-41.0, 21.0, 1.0], [-35.5, 30.0, 1.15],
    [-24.0, 31.5, 1.0], [-13.0, 33.0, 0.9], [-39.0, -24.0, 1.0], [-30.0, -34.0, 1.05], [-17.0, -34.2, 0.95],
    [-46.0, 30.0, 0.9], [-34.0, -18.0, 0.85],
  ] as const) add('buttress', x, z, s);
  tryPlace('palm', 32, (x, z) => jungle(x, z) || riverBank(x, z) || baseEdge(x, z), 1.2, [0.8, 1.15]);
  tryPlace('treeFern', 38, jungle, 1.1, [0.8, 1.2]);
  tryPlace('banana', 26, (x, z) => jungle(x, z) || baseEdge(x, z), 1.0, [0.8, 1.2]);
  tryPlace('monstera', 60, jungle, 0.7, [0.8, 1.3]);
  tryPlace('bush', 100, (x, z) => jungle(x, z) || baseEdge(x, z), 0.8, [0.8, 1.25]);
  tryPlace('grass', 120, (x, z) => riverBank(x, z) || baseEdge(x, z) || (jungle(x, z) && rng.chance(0.3)), 0.4, [0.8, 1.3]);
  tryPlace('fern', 420, jungle, 0.4, [0.7, 1.35]);
  // beyond the walls: a dense band of jungle so no view ends in open horizon (never reached)
  const placed: [number, number, number][] = [];
  const outer = (kind: PlantKind, n: number, r: number, scale: [number, number]) => {
    for (let i = 0, tries = 0; i < n && tries < n * 40; tries++) {
      const x = -rng.range(0.5, W + OUT_X - 1);
      const z = rng.range(-D - OUT_Z + 1, D + OUT_Z - 1);
      if (x > -W + 0.6 && Math.abs(z) < D - 0.6) continue;
      if (Math.abs(z + 28) < 2.8) continue; // the river runs on through
      if (placed.some(([px, pz, pr]) => Math.hypot(px - x, pz - z) < pr + r)) continue;
      placed.push([x, z, r]);
      add(kind, x, z, rng.range(scale[0], scale[1]));
      i++;
    }
  };
  outer('buttress', 7, 4.0, [0.9, 1.15]);
  outer('palm', 26, 1.4, [0.85, 1.2]);
  outer('treeFern', 30, 1.1, [0.9, 1.3]);
  outer('banana', 18, 0.9, [0.9, 1.3]);
  outer('bush', 50, 0.7, [1.0, 1.5]);
  outer('monstera', 30, 0.5, [1.0, 1.4]);
  return out;
}
