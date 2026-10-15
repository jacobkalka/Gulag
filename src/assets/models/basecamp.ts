import { box, cyl, cylX, cylZ, rbox, torus, xf, type Geo } from '../geometry/toolkit';
import { Rng } from '@/shared/rng';
import { PROP_COLLIDERS } from '@/game/world/propColliders';
import { Sink } from './sink';
import type { PropDef } from './props';
import * as THREE from 'three';

// Outdoor base props for the jungle and snow maps: shipping containers, army tents, sandbag walls,
// razor wire, a jeep, a cargo truck and a wrecked helicopter. Prop-local space, origin on the
// ground; colliders match the visible shapes.

// -------------------------------------------------------------------------- container

const CONTAINER_COLORS = [0x8a3a2a, 0x2f5a78, 0x3d5a3a, 0xa8a49a, 0x9a6a2a];

/** 20 ft shipping container, 6.06 x 2.59 x 2.44 m, long axis along x, doors at +x. */
const container: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const body = lib.tinted('corrugated', CONTAINER_COLORS[v % CONTAINER_COLORS.length], `container${v % CONTAINER_COLORS.length}`);
    const L = 6.06;
    const H = 2.59;
    const Wd = 2.44;
    s.add(body, box(L - 0.16, H - 0.16, Wd - 0.06, { p: [0, H / 2, 0] }));
    // corner posts and rails
    for (const x of [-L / 2 + 0.08, L / 2 - 0.08]) for (const z of [-Wd / 2 + 0.06, Wd / 2 - 0.06]) s.add('darkMetal', box(0.16, H, 0.12, { p: [x, H / 2, z] }));
    for (const y of [0.08, H - 0.08]) for (const z of [-Wd / 2 + 0.05, Wd / 2 - 0.05]) s.add('darkMetal', box(L, 0.16, 0.1, { p: [0, y, z] }));
    // door bars and handles at the +x end
    for (const z of [-0.75, -0.35, 0.35, 0.75]) s.add('darkMetal', cyl(0.025, 0.025, H - 0.3, 6, { p: [L / 2 + 0.02, H / 2, z] }));
    for (const z of [-0.6, 0.6]) s.add('darkMetal', box(0.05, 0.08, 0.25, { p: [L / 2 + 0.05, 1.2, z] }));
    // vertical ribs along the long walls
    for (let i = -6; i <= 6; i++) for (const z of [-Wd / 2, Wd / 2]) s.add(body, box(0.12, H - 0.3, 0.05, { p: [i * 0.42, H / 2, z] }));
    return s.build('container');
  },
  colliders: (v) => PROP_COLLIDERS.container(v),
};

// -------------------------------------------------------------------------- tent

/** Army ridge tent, 4 m along x, 5 m along z, 2.4 m tall. Canvas hides you but doesn't stop bullets. */
const tent: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const hw = 2.0;
    const hl = 2.5;
    const H = 2.4;
    const wall = 1.0;
    const canvas = lib.tinted('canvas', v % 2 ? 0x8a8a6a : 0x7a7e5c, `tentCanvas${v % 2}`);
    // roof: two sloped panels from the side walls to the ridge
    const roof = (side: number) => {
      const g = new THREE.BufferGeometry();
      const pos = [side * hw, wall, -hl, 0, H, -hl, 0, H, hl, side * hw, wall, -hl, 0, H, hl, side * hw, wall, hl];
      const n = new THREE.Vector3(side * (H - wall), hw, 0).normalize();
      const nrm: number[] = [];
      for (let i = 0; i < 6; i++) nrm.push(n.x, n.y, n.z);
      const uv = [0, 0, 2.3, 0, 2.3, 5, 0, 0, 2.3, 5, 0, 5];
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      if (side < 0) g.index = null;
      return g;
    };
    s.add(canvas, roof(1), roof(-1));
    // side walls and gable ends
    for (const side of [-1, 1]) s.add(canvas, box(0.04, wall, hl * 2, { p: [side * hw, wall / 2, 0] }));
    for (const end of [-1, 1]) {
      const g = new THREE.BufferGeometry();
      const z = end * hl;
      const pos = [-hw, 0, z, hw, 0, z, hw, wall, z, -hw, 0, z, hw, wall, z, -hw, wall, z, -hw, wall, z, hw, wall, z, 0, H, z];
      const nrm: number[] = [];
      for (let i = 0; i < 9; i++) nrm.push(0, 0, end);
      const uv = [0, 0, 4, 0, 4, 1, 0, 0, 4, 1, 0, 1, 0, 1, 4, 1, 2, 2.4];
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      s.add(canvas, g);
    }
    // ridge pole, guy ropes and pegs
    s.add('wood', cylZ(0.04, hl * 2 + 0.3, 8, { p: [0, H + 0.02, 0] }));
    for (const z of [-hl, 0, hl]) {
      for (const side of [-1, 1]) {
        const rope = cyl(0.008, 0.008, 1.6, 4);
        xf(rope, { r: [0, 0, side * 0.9] });
        xf(rope, { p: [side * (hw + 0.55), wall * 0.55, z] });
        s.add('black', rope);
        s.add('darkMetal', box(0.04, 0.2, 0.04, { p: [side * (hw + 1.15), 0.08, z] }));
      }
    }
    return s.build('tent');
  },
  colliders: (v) => PROP_COLLIDERS.tent(v),
};

// -------------------------------------------------------------------------- sandbags

/** Sandbag wall segment, 2 m along x, 0.62 m deep, 1.0 m tall. */
const sandbags: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(600 + v * 17);
    // three courses of fat bags, single-bevel boxes (~110 triangles a bag: dozens of these line
    // the base, and every shadow-casting light draws them again)
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      const y = 0.16 + r * 0.32;
      const offset = r % 2 ? 0.3 : 0;
      for (let i = -2; i <= 2; i++) {
        const x = i * 0.6 + offset;
        if (Math.abs(x) > 1.0) continue;
        for (const z of [-0.15, 0.15]) {
          if (r === rows - 1 && z > 0 && rng.chance(0.5)) continue;
          const bag = rbox(0.58, 0.29, 0.3, 0.09, 1, { p: [x + rng.range(-0.02, 0.02), y, z + rng.range(-0.02, 0.02)], r: [rng.range(-0.05, 0.05), rng.range(-0.08, 0.08), rng.range(-0.04, 0.04)] });
          s.add(rng.chance(0.3) ? lib.tinted('sandbag', 0x8a7a5e, 'sandbagDark') : 'sandbag', bag);
        }
      }
    }
    return s.build('sandbags');
  },
  colliders: (v) => PROP_COLLIDERS.sandbags(v),
};

// -------------------------------------------------------------------------- razor wire

/** Concertina coil on stakes, 2.2 m long along x. Stops you walking, not bullets. */
const razorWire: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    const turns = 14;
    const parts: Geo[] = [];
    for (let i = 0; i < turns; i++) {
      const loop = torus(0.42, 0.006, 4, 22);
      xf(loop, { r: [0, Math.PI / 2 + 0.25, 0] });
      xf(loop, { p: [-1.05 + (i / (turns - 1)) * 2.1, 0.45, 0] });
      parts.push(loop);
    }
    s.add('chrome', ...parts);
    for (const x of [-1.0, 0, 1.0]) s.add('darkMetal', box(0.04, 0.9, 0.04, { p: [x, 0.45, 0], r: [0.1, 0, 0] }));
    return s.build('razorWire');
  },
  colliders: (v) => PROP_COLLIDERS.razorWire(v),
};

// -------------------------------------------------------------------------- vehicles

function wheel(s: Sink, x: number, z: number, r: number, w: number): void {
  s.add('gunRubber', cylZ(r, w, 18, { p: [x, r, z] }));
  s.add('darkMetal', cylZ(r * 0.55, w + 0.02, 12, { p: [x, r, z] }));
}

/** Open military jeep, 3.4 m along x (nose at +x), 1.6 m wide. */
const jeep: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const paint = lib.tinted('paintGreen', v % 2 ? 0x5a5f3a : 0x4a5236, `jeep${v % 2}`);
    s.add(paint, rbox(3.2, 0.55, 1.5, 0.06, 2, { p: [0, 0.75, 0] }));
    s.add(paint, rbox(1.1, 0.3, 1.45, 0.08, 2, { p: [1.1, 1.12, 0] })); // hood
    s.add(paint, box(0.05, 0.42, 1.4, { p: [0.45, 1.38, 0], r: [0, 0, 0.2] })); // windshield frame
    s.add('lens', box(0.02, 0.32, 1.25, { p: [0.47, 1.4, 0], r: [0, 0, 0.2] }));
    s.add('darkMetal', box(0.12, 0.3, 1.5, { p: [1.62, 0.7, 0] })); // grille
    for (const z of [-0.5, 0.5]) s.add('chrome', cylX(0.1, 0.06, 12, { p: [1.66, 0.92, z] })); // headlights
    for (const [x, z] of [[1.05, 0.72], [1.05, -0.72], [-1.05, 0.72], [-1.05, -0.72]] as const) wheel(s, x, z, 0.38, 0.28);
    s.add('gunRubber', cylX(0.38, 0.26, 18, { p: [-1.72, 0.85, 0] })); // spare
    s.add('leather', rbox(0.5, 0.45, 0.5, 0.06, 2, { p: [-0.2, 1.15, -0.38] }));
    s.add('leather', rbox(0.5, 0.45, 0.5, 0.06, 2, { p: [-0.2, 1.15, 0.38] }));
    s.add('darkMetal', box(0.04, 0.5, 1.3, { p: [-0.9, 1.3, 0] })); // roll bar
    return s.build('jeep');
  },
  colliders: (v) => PROP_COLLIDERS.jeep(v),
};

/** Cargo truck with a canvas-covered bed, 6.4 m along x (cab at +x), 2.4 m wide. */
const truck: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const paint = lib.tinted('paintGreen', v % 2 ? 0x55593a : 0x464d34, `truck${v % 2}`);
    s.add('darkMetal', box(6.2, 0.3, 1.2, { p: [0, 0.75, 0] })); // chassis
    s.add(paint, rbox(1.9, 1.7, 2.3, 0.08, 2, { p: [2.2, 1.8, 0] })); // cab
    s.add('lens', box(0.05, 0.7, 2.0, { p: [3.16, 2.2, 0] }));
    s.add(paint, rbox(1.0, 0.8, 2.2, 0.06, 2, { p: [3.35, 1.25, 0] })); // nose
    s.add(paint, box(4.0, 0.15, 2.4, { p: [-1.2, 1.15, 0] })); // bed floor
    for (const z of [-1.15, 1.15]) s.add(paint, box(4.0, 0.6, 0.08, { p: [-1.2, 1.5, z] }));
    s.add(paint, box(0.08, 0.6, 2.4, { p: [-3.2, 1.5, 0] }));
    // canvas over hoops
    s.add('canvas', box(4.0, 0.05, 2.5, { p: [-1.2, 3.05, 0] }));
    for (const z of [-1.22, 1.22]) s.add('canvas', box(4.0, 1.25, 0.05, { p: [-1.2, 2.4, z] }));
    for (const [x, z] of [[2.4, 1.05], [2.4, -1.05], [-0.6, 1.05], [-0.6, -1.05], [-1.9, 1.05], [-1.9, -1.05]] as const) wheel(s, x, z, 0.5, 0.35);
    return s.build('truck');
  },
  colliders: (v) => PROP_COLLIDERS.truck(v),
};

/** A crashed helicopter: the cabin on its side-skids, nose at +z, tail boom torn off beside it. */
const heliWreck: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    const olive = lib.tinted('paintGreen', 0x46503a, 'heliOlive');
    // cabin: rounded box with a tapered nose, slightly tilted
    const cabin = rbox(2.0, 1.9, 4.4, 0.35, 3, { p: [0, 1.25, 0] });
    xf(cabin, { r: [0.06, 0, 0.12] });
    s.add(olive, cabin);
    const nose = rbox(1.7, 1.3, 1.4, 0.45, 3, { p: [0, 1.0, 2.6] });
    xf(nose, { r: [0.2, 0, 0.12] });
    s.add(olive, nose);
    s.add('lens', box(1.5, 0.7, 0.05, { p: [0.05, 1.4, 3.2], r: [-0.6, 0, 0.12] }));
    // open side door, scorch, engine housing on top
    s.add('black', box(0.05, 1.2, 1.4, { p: [1.04, 1.25, 0.3], r: [0, 0, 0.12] }));
    s.add('darkMetal', rbox(1.2, 0.6, 2.0, 0.15, 2, { p: [-0.1, 2.35, -0.4], r: [0.06, 0, 0.12] }));
    // skids
    for (const x of [-0.95, 0.95]) {
      s.add('darkMetal', cylZ(0.05, 4.6, 8, { p: [x, 0.12, 0.2] }));
      s.add('darkMetal', box(0.06, 0.45, 0.06, { p: [x * 0.9, 0.35, 1.2] }));
      s.add('darkMetal', box(0.06, 0.45, 0.06, { p: [x * 0.9, 0.35, -1.0] }));
    }
    // rotor blades: one snapped, one bent down onto the pad
    s.add('darkMetal', cyl(0.12, 0.12, 0.4, 10, { p: [0, 2.85, -0.3] }));
    const b1 = box(5.0, 0.04, 0.3, { p: [2.5, 0, 0] });
    xf(b1, { r: [0, 0.4, -0.18] });
    xf(b1, { p: [0, 3.0, -0.3] });
    s.add('darkMetal', b1);
    const b2 = box(3.4, 0.04, 0.3, { p: [-1.7, 0, 0] });
    xf(b2, { r: [0, -0.5, 0.42] });
    xf(b2, { p: [0, 3.0, -0.3] });
    s.add('darkMetal', b2);
    // tail boom torn off, lying on the pad behind the cabin
    const boom = cylZ(0.32, 4.2, 12, { p: [0, 0, 0] }, 0.18);
    xf(boom, { r: [0.05, 0.35, 0] });
    xf(boom, { p: [0.5, 0.35, -4.4] });
    s.add(olive, boom);
    s.add('darkMetal', box(0.06, 1.1, 0.8, { p: [1.25, 0.8, -6.3], r: [0, 0.35, 0.3] }));
    return s.build('heliWreck');
  },
  colliders: (v) => PROP_COLLIDERS.heliWreck(v),
};

export const BASECAMP_PROPS: Record<string, PropDef> = { container, tent, sandbags, razorWire, jeep, truck, heliWreck };
