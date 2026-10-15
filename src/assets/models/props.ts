import * as THREE from 'three';
import type { MaterialLibrary } from '../materials';
import { box, capsule, cyl, cylX, cylZ, lathe, merge, rbox, rock, sphere, torus, xf, type Geo } from '../geometry/toolkit';
import { Rng } from '@/shared/rng';
import { PROP_COLLIDERS, type PropCollider } from '@/game/world/propColliders';

// Map props: visual builders + collision proxies (in prop-local space, origin on the floor).

export type { PropCollider } from '@/game/world/propColliders';

class Sink {
  map = new Map<THREE.Material, Geo[]>();
  constructor(private lib: MaterialLibrary) {}
  add(mat: string | THREE.Material, ...g: Geo[]): void {
    const m = typeof mat === 'string' ? this.lib.get(mat) : mat;
    let l = this.map.get(m);
    if (!l) this.map.set(m, (l = []));
    l.push(...g);
  }
  build(name: string, cast = true): THREE.Group {
    const grp = new THREE.Group();
    grp.name = name;
    for (const [m, list] of this.map) {
      if (!list.length) continue;
      const mesh = new THREE.Mesh(merge(list), m);
      const sm = m as THREE.MeshStandardMaterial;
      const emitter = !!sm.emissive && sm.emissiveIntensity > 1 && sm.color?.getHex() === 0;
      mesh.castShadow = cast && !sm.transparent && !emitter;
      mesh.receiveShadow = true;
      if (sm.transparent) mesh.userData.shadowExempt = 'glass: light passes through';
      else if (emitter) mesh.userData.shadowExempt = 'light emitter: would shadow its own light';
      else if (!cast) mesh.userData.shadowExempt = `${name}: built without shadows`;
      grp.add(mesh);
    }
    this.map.clear();
    return grp;
  }
}


export interface PropDef {
  build(lib: MaterialLibrary, v: number): THREE.Group;
  colliders(v: number): PropCollider[];
  /** Static geometry can be cached per variant and cloned. */
  cacheable?: boolean;
}

// -------------------------------------------------------------------------- rubble

function rubbleChunks(s: Sink, rng: Rng, cx: number, cz: number, rx: number, rz: number, h: number, n: number, tile = false): void {
  for (let i = 0; i < n; i++) {
    const a = rng.next() * Math.PI * 2;
    const d = Math.sqrt(rng.next());
    const x = cx + Math.cos(a) * rx * d;
    const z = cz + Math.sin(a) * rz * d;
    const peak = h * (1 - d * d) + 0.03;
    const sz = 0.06 + rng.next() * (0.24 - d * 0.12);
    const slabby = rng.chance(0.3);
    const g = rock(sz * rng.range(0.9, 1.7), sz * (slabby ? 0.35 : rng.range(0.55, 1.0)), sz * rng.range(0.8, 1.5), rng.next() * 1000, 0, 0.25);
    xf(g, { p: [x, Math.max(sz * 0.35, peak * rng.range(0.4, 0.95)), z], r: [rng.range(-0.6, 0.6), rng.next() * 6.28, rng.range(-0.6, 0.6)] });
    const r = rng.next();
    s.add(r < 0.12 ? 'brick' : r < 0.55 ? 'concrete' : 'concreteDark', g);
  }
  // Rebar
  for (let i = 0; i < 4; i++) {
    const g = cyl(0.007, 0.007, rng.range(0.4, 0.9), 5);
    xf(g, { p: [cx + rng.range(-rx, rx) * 0.5, h * rng.range(0.3, 0.7), cz + rng.range(-rz, rz) * 0.5], r: [rng.range(-1.2, 1.2), rng.next() * 6, rng.range(0.6, 1.4)] });
    s.add('rust', g);
  }
  // Small debris + tile shards scattered around the mound
  for (let i = 0; i < n * 1.5; i++) {
    const a = rng.next() * Math.PI * 2;
    const d = 0.9 + rng.next() * 0.9;
    const px = cx + Math.cos(a) * rx * d;
    const pz = cz + Math.sin(a) * rz * d;
    if (tile && rng.chance(0.35)) {
      const t = box(rng.range(0.05, 0.12), 0.008, rng.range(0.05, 0.12), { p: [px, 0.006, pz], r: [rng.range(-0.15, 0.15), rng.next() * 6, rng.range(-0.15, 0.15)] });
      s.add('ceramic', t);
      continue;
    }
    const sz = 0.02 + rng.next() * 0.05;
    const g = rock(sz * 1.3, sz * 0.6, sz, rng.next() * 1000, 0, 0.2);
    xf(g, { p: [px, sz * 0.25, pz], r: [0, rng.next() * 6, 0] });
    s.add(rng.chance(0.5) ? 'concrete' : 'concreteDark', g);
  }
}

const rubble: PropDef = {
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(1000 + v * 77);
    rubbleChunks(s, rng, 0, 0, 0.75, 0.6, 0.55, 42, true);
    return s.build('rubble');
  },
  colliders: (v) => PROP_COLLIDERS.rubble(v),
};

const slab: PropDef = {
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(2000 + v * 31);
    // Broken ceiling slab leaning on a rubble mound (rises along +x), cracked into plates
    // with exposed rebar mesh and a tiled underside.
    const tilt = 0.42;
    const plates: [number, number, number, number][] = [
      // x center, z center, len x, len z (in slab-local coords before tilt)
      [-0.55, -0.38, 0.95, 0.66],
      [-0.6, 0.36, 0.9, 0.7],
      [0.32, -0.4, 0.78, 0.62],
      [0.3, 0.34, 0.74, 0.74],
    ];
    for (const [px, pz, lx, lz] of plates) {
      const g = rock(lx * 0.5, 0.11, lz * 0.5, rng.next() * 1000, 1, 0.9);
      xf(g, { r: [0, rng.range(-0.06, 0.06), 0] });
      xf(g, { p: [px, 0.0, pz] });
      xf(g, { r: [rng.range(-0.04, 0.04), 0, tilt + rng.range(-0.05, 0.05)] });
      xf(g, { p: [0, 0.5, 0] });
      s.add('concreteDark', g);
      const t = box(lx * 0.9, 0.012, lz * 0.9, { p: [px, -0.1, pz] });
      xf(t, { r: [0, 0, tilt] });
      xf(t, { p: [0, 0.5, 0] });
      s.add('tileWhite', t);
    }
    // rebar grid poking out of the cracks
    for (let i = 0; i < 7; i++) {
      const r = cyl(0.007, 0.007, rng.range(0.5, 1.3), 5);
      xf(r, { r: [Math.PI / 2, 0, 0] });
      xf(r, { p: [-0.9 + i * 0.3, 0.02, rng.range(-0.15, 0.15)] });
      xf(r, { r: [0, 0, tilt] });
      xf(r, { p: [0, 0.5, 0] });
      s.add('rust', r);
    }
    rubbleChunks(s, rng, 0.85, 0, 0.45, 0.6, 0.6, 24, true);
    for (let i = 0; i < 5; i++) {
      const r = cyl(0.009, 0.009, rng.range(0.3, 0.7), 6);
      xf(r, { p: [1.05 + rng.range(-0.05, 0.1), 1.0 + rng.range(-0.1, 0.1), rng.range(-0.6, 0.6)], r: [rng.range(-0.4, 0.4), 0, rng.range(0.6, 1.4)] });
      s.add('rust', r);
    }
    return s.build('slab');
  },
  colliders: (v) => PROP_COLLIDERS.slab(v),
};

/** Broken concrete teeth + bent rebar hanging along one edge of a ceiling hole (local X axis, hole toward +Z). */
const holeEdge: PropDef = {
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(3000 + v * 13);
    const L = v >= 50 ? 5.4 : 4.6;
    for (let i = 0; i < 16; i++) {
      const x = -L / 2 + rng.next() * L;
      const g = rock(rng.range(0.12, 0.3), rng.range(0.08, 0.2), rng.range(0.1, 0.24), rng.next() * 1000, 0, 0.5);
      xf(g, { p: [x, rng.range(-0.12, 0.08), rng.range(-0.05, 0.18)], r: [rng.range(-0.4, 0.4), rng.next() * 6, rng.range(-0.4, 0.4)] });
      s.add(rng.chance(0.5) ? 'concreteDark' : 'concrete', g);
    }
    for (let i = 0; i < 10; i++) {
      const x = -L / 2 + rng.next() * L;
      const len = rng.range(0.3, 1.1);
      const g = cyl(0.008, 0.008, len, 5);
      xf(g, { p: [x, -len * 0.4, 0.1 + len * 0.25], r: [rng.range(0.3, 0.9), 0, rng.range(-0.3, 0.3)] });
      s.add('rust', g);
    }
    // a dangling cable
    const cable = cyl(0.012, 0.012, 1.4, 6);
    xf(cable, { p: [rng.range(-L / 3, L / 3), -0.65, 0.25], r: [0.12, 0, 0.08] });
    s.add('black', cable);
    return s.build('holeEdge');
  },
  colliders: (v) => PROP_COLLIDERS.holeEdge(v),
};

// -------------------------------------------------------------------------- industrial

/** Pushes a lathe/cylinder surface inward around a point (dents in drums and cans). */
function dent(g: Geo, angle: number, y: number, radius: number, depth: number): Geo {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const cx = Math.cos(angle);
  const cz = Math.sin(angle);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    // distance on the surface from the dent center (arc length around + height)
    const arc = Math.acos(THREE.MathUtils.clamp((x * cx + z * cz) / r, -1, 1)) * r;
    const d = Math.hypot(arc, pos.getY(i) - y) / radius;
    if (d >= 1) continue;
    const k = 1 - depth * (1 - d * d) * (1 - d * d) / r;
    pos.setXYZ(i, x * k, pos.getY(i), z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// Crates come in five builds with the same 1 m footprint (one collision box for all):
// 0 braced wood, 1 slatted wood with rope handles, 2 painted military, 3 weathered with the lid
// knocked askew, 4 steel-cornered plywood case with straps and a hasp.
const crate: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const kind = ((v % 5) + 5) % 5;
    const size = 1.0;
    const h = size / 2;
    const t = 0.09;
    if (kind === 4) {
      s.add(lib.tinted('wood', 0xc9b08a, 'woodPly'), rbox(size - 0.02, size - 0.02, size - 0.02, 0.015, 2, { p: [0, h, 0] }));
      for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
        s.add('darkMetal', rbox(0.13, 0.13, 0.13, 0.012, 1, { p: [sx * (h - 0.055), sy * (size - 0.11) + 0.055, sz * (h - 0.055)] }));
      }
      for (const x of [-0.27, 0.27]) s.add('darkMetal', box(0.05, size + 0.008, size + 0.008, { p: [x, h, 0] }));
      s.add('darkMetal', box(0.09, 0.13, 0.025, { p: [0, size - 0.12, h + 0.008] }));
      s.add('darkMetal', torus(0.025, 0.006, 6, 12, Math.PI * 2, { p: [0, size - 0.2, h + 0.022] }));
      return s.build('crate');
    }
    const woodMat = kind === 3 ? lib.tinted('wood', 0xa9a49a, 'woodWeathered') : kind === 1 ? lib.tinted('wood', 0xb89a74, 'woodDark') : lib.get('wood');
    const frameMat = kind === 2 ? 'paintGreen' : woodMat;
    const bodyH = kind === 3 ? size - 0.07 : size;
    s.add(kind === 2 ? 'paintGreen' : woodMat, rbox(size - 0.04, bodyH - 0.04, size - 0.04, 0.01, 1, { p: [0, bodyH / 2, 0] }));
    // frame boards along the edges (the weathered one has lost its lid frame)
    const frame: Geo[] = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        frame.push(rbox(t, bodyH, t, 0.01, 1, { p: [sx * (h - t / 2), bodyH / 2, sz * (h - t / 2)] }));
        frame.push(rbox(size, t, t, 0.01, 1, { p: [0, t / 2, sz * (h - t / 2)] }));
        frame.push(rbox(t, t, size, 0.01, 1, { p: [sx * (h - t / 2), t / 2, 0] }));
        if (kind !== 3) {
          frame.push(rbox(size, t, t, 0.01, 1, { p: [0, size - t / 2, sz * (h - t / 2)] }));
          frame.push(rbox(t, t, size, 0.01, 1, { p: [sx * (h - t / 2), size - t / 2, 0] }));
        }
      }
    }
    if (kind === 1) {
      // horizontal mid slats instead of braces, rope handles on two sides
      frame.push(rbox(size, t * 0.8, 0.03, 0.008, 1, { p: [0, h, h + 0.005] }));
      frame.push(rbox(0.03, t * 0.8, size, 0.008, 1, { p: [h + 0.005, h, 0] }));
      frame.push(rbox(size, t * 0.8, 0.03, 0.008, 1, { p: [0, h, -h - 0.005] }));
      for (const sx of [-1, 1]) s.add('rubberMat', torus(0.09, 0.012, 6, 16, Math.PI, { p: [sx * (h + 0.012), size * 0.7, 0], r: [0, Math.PI / 2, Math.PI] }));
    } else {
      frame.push(rbox(size * 1.25, t * 0.9, 0.03, 0.008, 1, { p: [0, h, h + 0.005], r: [0, 0, Math.PI / 4] }));
      frame.push(rbox(0.03, t * 0.9, size * 1.25, 0.008, 1, { p: [h + 0.005, h, 0], r: [Math.PI / 4, 0, 0] }));
    }
    s.add(frameMat, ...frame);
    if (kind === 2) {
      // stamped steel handles and corner plates on the painted crate
      for (const sz of [-1, 1]) s.add('darkMetal', torus(0.08, 0.01, 6, 14, Math.PI, { p: [0, size * 0.72, sz * (h + 0.012)], r: [0, 0, Math.PI] }));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) s.add('darkMetal', box(0.11, 0.11, 0.11, { p: [sx * (h - 0.05), size - 0.05, sz * (h - 0.05)] }));
    }
    if (kind === 3) {
      // lid knocked askew: three loose planks, one split, sliding off one edge
      const lid: Geo[] = [];
      for (let i = 0; i < 3; i++) {
        const len = i === 1 ? size * 0.62 : size * 0.98;
        lid.push(rbox(len, 0.035, 0.3, 0.008, 1, { p: [0.04 + (i === 1 ? -0.17 : 0), bodyH + 0.018 + i * 0.004, -0.33 + i * 0.33], r: [0, 0.06 - i * 0.025, 0.02 * (i - 1)] }));
      }
      s.add(woodMat, ...lid);
    }
    return s.build('crate');
  },
  colliders: (v) => PROP_COLLIDERS.crate(v),
};

// Small cases: 0 green ammo can, 1 tan polymer case, 2 grey steel case with a carry handle.
const crateSmall: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const kind = ((v % 3) + 3) % 3;
    const body = kind === 1 ? 'gunPolymerTan' : kind === 2 ? 'paintGrey' : 'paintGreen';
    s.add(body, rbox(0.62, 0.42, 0.42, kind === 1 ? 0.05 : 0.03, 2, { p: [0, 0.21, 0] }));
    s.add(kind === 1 ? 'gunPolymer' : 'darkMetal', rbox(0.64, 0.04, 0.44, 0.01, 1, { p: [0, 0.42, 0] }));
    for (const x of [-0.18, 0.18]) s.add('darkMetal', box(0.08, 0.05, 0.03, { p: [x, 0.3, -0.215] }));
    if (kind === 2) {
      s.add('darkMetal', torus(0.07, 0.01, 6, 14, Math.PI, { p: [0, 0.44, 0], r: [0, 0, 0] }));
      for (const x of [-0.29, 0.29]) s.add('darkMetal', box(0.03, 0.4, 0.44, { p: [x, 0.21, 0] }));
    }
    if (kind === 1) for (const z of [-0.12, 0.12]) s.add('gunPolymer', box(0.6, 0.02, 0.03, { p: [0, 0.12, z * 1.85] }));
    return s.build('crateSmall');
  },
  colliders: (v) => PROP_COLLIDERS.crateSmall(v),
};

// Drums: five paint colors; every third one is dented, every fourth one open with oil inside.
const barrel: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const mat = ['paintBlue', 'rust', 'paintOrange', 'paintGreen', 'rust'][((v % 5) + 5) % 5];
    const r = 0.29;
    const open = v % 4 === 3;
    const shell = lathe(open ? [[r - 0.01, 0], [r, 0.02], [r, 0.86], [r - 0.004, 0.88]] : [[0.0001, 0], [r - 0.01, 0], [r, 0.02], [r, 0.86], [r - 0.012, 0.88], [0.0001, 0.88]], 28);
    if (v % 3 === 1) {
      dent(shell, 0.7 + v, 0.45, 0.2, 0.05);
      dent(shell, 2.9 + v, 0.72, 0.12, 0.025);
    }
    s.add(mat, shell);
    for (const y of [0.29, 0.59]) s.add(mat, torus(r + 0.004, 0.012, 6, 28, Math.PI * 2, { p: [0, y, 0], r: [Math.PI / 2, 0, 0] }));
    s.add('darkMetal', torus(r - 0.01, 0.01, 6, 28, Math.PI * 2, { p: [0, 0.875, 0], r: [Math.PI / 2, 0, 0] }));
    if (open) {
      // inner wall (reversed profile faces inward) and a dark oil surface below the rim
      s.add(mat, lathe([[r - 0.006, 0.88], [r - 0.006, 0.7]], 28));
      s.add('black', cyl(r - 0.008, r - 0.008, 0.01, 28, { p: [0, 0.72, 0] }));
    } else {
      s.add('darkMetal', cyl(0.03, 0.03, 0.02, 10, { p: [0.15, 0.885, 0.05] }));
    }
    return s.build('barrel');
  },
  colliders: (v) => PROP_COLLIDERS.barrel(v),
};

const valve: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    s.add('concrete', rbox(1.0, 0.12, 0.7, 0.02, 1, { p: [0, 0.06, 0] }));
    s.add('paintGreen', cyl(0.12, 0.12, 1.1, 16, { p: [-0.3, 0.67, 0] }));
    s.add('paintGreen', cyl(0.12, 0.12, 1.1, 16, { p: [0.3, 0.67, 0] }));
    s.add('paintGreen', cylX(0.1, 0.62, 16, { p: [0, 1.0, 0] }));
    s.add('paintGreen', cylX(0.1, 0.62, 16, { p: [0, 0.4, 0] }));
    for (const x of [-0.3, 0.3]) {
      s.add('darkMetal', cyl(0.16, 0.16, 0.04, 16, { p: [x, 0.2, 0] }));
      s.add('darkMetal', cyl(0.16, 0.16, 0.04, 16, { p: [x, 1.18, 0] }));
    }
    // Valve wheels
    for (const [x, y] of [[0, 1.0], [0, 0.4]] as const) {
      s.add('paintOrange', torus(0.14, 0.014, 6, 24, Math.PI * 2, { p: [x, y, -0.22] }));
      for (let k = 0; k < 3; k++) s.add('paintOrange', box(0.28, 0.016, 0.016, { p: [x, y, -0.22], r: [0, 0, (k * Math.PI) / 3] }));
      s.add('darkMetal', cylZ(0.025, 0.12, 8, { p: [x, y, -0.16] }));
    }
    // Gauge
    s.add('darkMetal', cylZ(0.07, 0.04, 16, { p: [0.3, 1.32, -0.06] }));
    s.add('ceramic', cylZ(0.06, 0.005, 16, { p: [0.3, 1.32, -0.082] }));
    return s.build('valve');
  },
  colliders: (v) => PROP_COLLIDERS.valve(v),
};

const pipes: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const L = 3.0;
    const mats = ['paintGrey', 'paintGreen', 'rust'];
    const rows: [number, number, number][] = [[0.18, 0.2, 0.17], [-0.2, 0.2, 0.14], [0.0, 0.52, 0.16]];
    rows.forEach(([z, y, r], i) => {
      s.add(mats[(i + v) % 3], cylX(r, L, 20, { p: [0, y, z] }));
      for (const x of [-L / 2 + 0.2, 0, L / 2 - 0.2]) s.add('darkMetal', cylX(r + 0.035, 0.05, 20, { p: [x, y, z] }));
    });
    for (const x of [-1.1, 1.1]) {
      s.add('darkMetal', box(0.08, 0.7, 0.75, { p: [x, 0.35, 0] }));
    }
    return s.build('pipes');
  },
  colliders: (v) => PROP_COLLIDERS.pipes(v),
};

const boiler: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const R = 1.42;
    s.add('concrete', rbox(3.3, 0.3, 3.3, 0.05, 2, { p: [0, 0.15, 0] }));
    s.add(v % 2 ? 'rust' : 'paintGreen', lathe([
      [0.0001, 0.3], [R, 0.3], [R, 3.9], [R * 0.92, 4.25], [R * 0.6, 4.55], [0.3, 4.7], [0.0001, 4.72],
    ], 40));
    for (const y of [0.7, 1.9, 3.1, 3.85]) s.add('darkMetal', torus(R + 0.01, 0.035, 6, 40, Math.PI * 2, { p: [0, y, 0], r: [Math.PI / 2, 0, 0] }));
    // Rivets
    const riv: Geo[] = [];
    for (const y of [0.7, 1.9, 3.1]) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        riv.push(sphere(0.022, 6, 4, { p: [Math.sin(a) * (R + 0.04), y + 0.05, Math.cos(a) * (R + 0.04)] }));
      }
    }
    s.add('darkMetal', ...riv);
    // Furnace door (front = -Z), glowing window
    s.add('darkMetal', rbox(0.9, 0.75, 0.2, 0.04, 2, { p: [0, 0.95, -R + 0.02] }));
    s.add('furnace', box(0.6, 0.12, 0.05, { p: [0, 0.98, -R - 0.08] }));
    s.add('furnace', box(0.6, 0.12, 0.05, { p: [0, 0.8, -R - 0.08] }));
    s.add('darkMetal', box(0.68, 0.06, 0.07, { p: [0, 1.08, -R - 0.08] }));
    s.add('darkMetal', box(0.68, 0.04, 0.07, { p: [0, 0.89, -R - 0.08] }));
    s.add('darkMetal', box(0.68, 0.06, 0.07, { p: [0, 0.71, -R - 0.08] }));
    s.add('chrome', cylX(0.025, 0.3, 8, { p: [0.25, 1.25, -R - 0.12] }));
    // Gauges
    for (const [x, y] of [[-0.55, 1.6], [0.5, 1.75]] as const) {
      s.add('darkMetal', cylZ(0.1, 0.06, 18, { p: [x, y, -R - 0.03] }));
      s.add('ceramic', cylZ(0.085, 0.005, 18, { p: [x, y, -R - 0.065] }));
      s.add('black', box(0.008, 0.07, 0.004, { p: [x + 0.02, y + 0.02, -R - 0.07], r: [0, 0, -0.6] }));
    }
    // Flue + pipes to ceiling
    s.add('rust', cyl(0.28, 0.28, 1.8, 18, { p: [0, 5.5, 0.2] }));
    s.add('paintGrey', cyl(0.12, 0.12, 2.0, 14, { p: [0.9, 5.2, 0.6] }));
    s.add('paintGrey', torus(0.25, 0.12, 8, 12, Math.PI / 2, { p: [0.65, 4.2, 0.6], r: [0, 0, 0] }));
    s.add('paintGrey', cylX(0.12, 0.5, 14, { p: [0.4, 3.95, 0.6] }));
    // Ladder rungs on the side
    for (let i = 0; i < 9; i++) s.add('darkMetal', cylZ(0.016, 0.36, 6, { p: [R + 0.08, 0.6 + i * 0.36, 0] }));
    s.add('darkMetal', cyl(0.02, 0.02, 3.4, 6, { p: [R + 0.08, 2.1, 0.18] }));
    s.add('darkMetal', cyl(0.02, 0.02, 3.4, 6, { p: [R + 0.08, 2.1, -0.18] }));
    return s.build('boiler');
  },
  colliders: (v) => PROP_COLLIDERS.boiler(v),
};

const pump: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    s.add('concrete', rbox(2.4, 0.2, 1.2, 0.03, 1, { p: [0, 0.1, 0] }));
    s.add('darkMetal', box(2.2, 0.12, 0.9, { p: [0, 0.26, 0] }));
    s.add(v % 2 ? 'paintBlue' : 'paintGreen', cylX(0.34, 1.0, 24, { p: [-0.45, 0.72, 0] }));
    for (let i = 0; i < 9; i++) s.add('darkMetal', cylX(0.36, 0.025, 24, { p: [-0.85 + i * 0.1, 0.72, 0] }));
    s.add('paintOrange', lathe([[0.0001, 0], [0.42, 0], [0.48, 0.1], [0.48, 0.3], [0.3, 0.4], [0.0001, 0.4]], 24, { p: [0.45, 0.72, 0], r: [0, 0, -Math.PI / 2] }));
    s.add('paintGrey', cyl(0.14, 0.14, 2.6, 16, { p: [0.65, 2.3, 0] }));
    s.add('paintGrey', cylZ(0.13, 1.0, 16, { p: [0.65, 0.72, 0.5] }));
    s.add('darkMetal', box(0.2, 0.4, 0.3, { p: [-0.95, 0.72, 0] }));
    return s.build('pump');
  },
  colliders: (v) => PROP_COLLIDERS.pump(v),
};

// -------------------------------------------------------------------------- showers / cells / rooms

const showerHead: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    // mounted on a wall facing -Z (prop rotated to face into the room)
    s.add('chrome', cyl(0.018, 0.018, 0.6, 8, { p: [0, -0.3, 0.03] }));
    s.add('chrome', cylZ(0.016, 0.22, 8, { p: [0, 0.0, -0.08] }));
    s.add('chrome', lathe([[0.0001, 0], [0.04, 0], [0.065, 0.05], [0.0001, 0.055]], 16, { p: [0, -0.02, -0.2], r: [Math.PI * 0.75, 0, 0] }));
    s.add('chrome', cylZ(0.035, 0.04, 12, { p: [0, -0.45, 0.0] }));
    s.add('chrome', torus(0.04, 0.008, 6, 12, Math.PI * 2, { p: [0, -0.45, -0.025] }));
    return s.build('showerHead');
  },
  colliders: (v) => PROP_COLLIDERS.showerHead(v),
};

const drain: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    s.add('darkMetal', cyl(0.42, 0.42, 0.03, 32, { p: [0, 0.005, 0] }));
    s.add('black', cyl(0.36, 0.36, 0.031, 32, { p: [0, 0.006, 0] }));
    for (let k = 0; k < 10; k++) s.add('darkMetal', box(0.74, 0.035, 0.035, { p: [0, 0.012, 0], r: [0, (k * Math.PI) / 10, 0] }));
    s.add('darkMetal', torus(0.18, 0.02, 6, 24, Math.PI * 2, { p: [0, 0.014, 0], r: [Math.PI / 2, 0, 0] }));
    return s.build('drain');
  },
  colliders: (v) => PROP_COLLIDERS.drain(v),
};

const bars: PropDef = {
  build(lib, v) {
    const s = new Sink(lib);
    const n = Math.max(4, v);
    const W = 3.1;
    for (let i = 0; i < n; i++) s.add('darkMetal', cyl(0.012, 0.012, 1.2, 6, { p: [-W / 2 + (i + 0.5) * (W / n), 0.6, 0] }));
    s.add('darkMetal', box(W, 0.04, 0.04, { p: [0, 0.6, 0] }));
    return s.build('bars');
  },
  colliders: (v) => PROP_COLLIDERS.bars(v),
};

const desk: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    s.add('paintGrey', rbox(1.5, 0.05, 0.7, 0.01, 1, { p: [0, 0.75, 0] }));
    s.add('paintGrey', box(0.45, 0.72, 0.66, { p: [-0.5, 0.36, 0] }));
    for (let i = 0; i < 3; i++) s.add('darkMetal', box(0.4, 0.015, 0.02, { p: [-0.5, 0.2 + i * 0.22, -0.335] }));
    s.add('paintGrey', box(0.04, 0.72, 0.66, { p: [0.71, 0.36, 0] }));
    s.add('black', rbox(0.36, 0.26, 0.06, 0.01, 1, { p: [0.2, 0.92, 0.15], r: [-0.15, 0, 0] }));
    s.add('lampCool', box(0.32, 0.2, 0.005, { p: [0.2, 0.925, 0.115], r: [-0.15, 0, 0] }));
    return s.build('desk');
  },
  colliders: (v) => PROP_COLLIDERS.desk(v),
};

const bunk: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    const L = 1.9;
    const W = 0.8;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) s.add('darkMetal', box(0.05, 1.6, 0.05, { p: [sx * (L / 2), 0.8, sz * (W / 2)] }));
    for (const y of [0.35, 1.3]) {
      s.add('darkMetal', box(L, 0.05, 0.05, { p: [0, y, W / 2] }));
      s.add('darkMetal', box(L, 0.05, 0.05, { p: [0, y, -W / 2] }));
      s.add('darkMetal', box(L, 0.03, W, { p: [0, y, 0] }));
      s.add('mattress', rbox(L - 0.08, 0.12, W - 0.06, 0.04, 2, { p: [0, y + 0.08, 0] }));
    }
    for (let i = 0; i < 4; i++) s.add('darkMetal', cylZ(0.015, W, 6, { p: [L / 2, 0.5 + i * 0.25, 0] }));
    return s.build('bunk');
  },
  colliders: (v) => PROP_COLLIDERS.bunk(v),
};

const bunkTipped: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    // Bunk lying on its side, mattress hanging out: chest-high cover along X.
    s.add('darkMetal', box(1.9, 0.05, 0.05, { p: [0, 0.05, -0.4] }));
    s.add('darkMetal', box(1.9, 0.05, 0.05, { p: [0, 1.15, -0.4] }));
    s.add('darkMetal', box(1.9, 0.05, 0.05, { p: [0, 0.05, 0.4] }));
    s.add('darkMetal', box(1.9, 0.05, 0.05, { p: [0, 1.15, 0.4] }));
    for (const x of [-0.95, 0.95]) s.add('darkMetal', box(0.05, 1.2, 0.85, { p: [x, 0.6, 0] }));
    s.add('darkMetal', box(1.9, 1.15, 0.03, { p: [0, 0.6, 0.0] }));
    s.add('mattress', rbox(1.8, 0.7, 0.13, 0.04, 2, { p: [0.1, 0.4, -0.12], r: [0.1, 0.05, 0] }));
    return s.build('bunkTipped');
  },
  colliders: (v) => PROP_COLLIDERS.bunkTipped(v),
};

const mattress: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    s.add('mattress', rbox(1.85, 0.13, 0.78, 0.05, 2, { p: [0, 0.065, 0] }));
    return s.build('mattress');
  },
  colliders: (v) => PROP_COLLIDERS.mattress(v),
};

const toilet: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    s.add('chrome', rbox(0.42, 0.42, 0.55, 0.08, 3, { p: [0, 0.21, 0.02] }));
    s.add('black', cyl(0.14, 0.12, 0.02, 16, { p: [0, 0.425, 0.05] }));
    s.add('chrome', rbox(0.5, 0.35, 0.18, 0.04, 2, { p: [0, 0.6, 0.24] }));
    return s.build('toilet');
  },
  colliders: (v) => PROP_COLLIDERS.toilet(v),
};

const bench: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    if (v % 2 === 1) {
      // steel locker-room bench: diamond-plate seat on welded grey legs
      s.add('diamond', rbox(1.8, 0.04, 0.36, 0.01, 1, { p: [0, 0.44, 0] }));
      for (const x of [-0.78, 0.78]) {
        s.add('paintGrey', box(0.05, 0.42, 0.05, { p: [x, 0.21, -0.13] }));
        s.add('paintGrey', box(0.05, 0.42, 0.05, { p: [x, 0.21, 0.13] }));
        s.add('paintGrey', box(0.05, 0.05, 0.3, { p: [x, 0.06, 0] }));
      }
      s.add('paintGrey', box(1.5, 0.04, 0.04, { p: [0, 0.08, 0] }));
      return s.build('bench');
    }
    for (let i = 0; i < 3; i++) s.add('wood', rbox(1.8, 0.035, 0.11, 0.01, 1, { p: [0, 0.44, -0.12 + i * 0.12] }));
    for (const x of [-0.75, 0.75]) {
      s.add('darkMetal', box(0.04, 0.42, 0.04, { p: [x, 0.21, -0.14] }));
      s.add('darkMetal', box(0.04, 0.42, 0.04, { p: [x, 0.21, 0.14] }));
      s.add('darkMetal', box(0.04, 0.04, 0.36, { p: [x, 0.4, 0] }));
    }
    return s.build('bench');
  },
  colliders: (v) => PROP_COLLIDERS.bench(v),
};

const detector: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    for (const x of [-0.8, 0.8]) s.add('paintGrey', rbox(0.12, 2.1, 0.5, 0.03, 2, { p: [x, 1.05, 0] }));
    s.add('paintGrey', rbox(1.72, 0.2, 0.5, 0.03, 2, { p: [0, 2.2, 0] }));
    s.add('lampRed', box(0.1, 0.05, 0.05, { p: [0, 2.2, -0.28] }));
    s.add('black', box(0.3, 0.1, 0.02, { p: [0, 2.2, -0.28] }));
    return s.build('detector');
  },
  colliders: (v) => PROP_COLLIDERS.detector(v),
};

const washer: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    s.add(v % 2 ? 'paintGrey' : 'chrome', rbox(1.0, 1.35, 1.0, 0.04, 2, { p: [0, 0.675, 0] }));
    s.add('darkMetal', torus(0.27, 0.05, 8, 24, Math.PI * 2, { p: [0, 0.7, -0.5] }));
    s.add('glassFixture', cylZ(0.25, 0.02, 24, { p: [0, 0.7, -0.5] }));
    s.add('black', box(0.6, 0.15, 0.03, { p: [0, 1.18, -0.5] }));
    s.add('lampCyan', box(0.06, 0.03, 0.01, { p: [0.2, 1.18, -0.52] }));
    return s.build('washer');
  },
  colliders: (v) => PROP_COLLIDERS.washer(v),
};

const cart: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    s.add('mattress', rbox(0.95, 0.6, 0.6, 0.06, 2, { p: [0, 0.6, 0] }));
    s.add('darkMetal', box(1.0, 0.04, 0.64, { p: [0, 0.28, 0] }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      s.add('darkMetal', box(0.03, 0.9, 0.03, { p: [sx * 0.48, 0.45, sz * 0.3] }));
      s.add('gunRubber', cylX(0.06, 0.04, 12, { p: [sx * 0.45, 0.06, sz * 0.28] }));
    }
    return s.build('cart');
  },
  colliders: (v) => PROP_COLLIDERS.cart(v),
};

function lockerUnits(s: Sink, n: number, zFace: number, faceDir: 1 | -1): void {
  const W = 0.45;
  const L = n * W;
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + (i + 0.5) * W;
    s.add('paintBlue', rbox(W - 0.012, 1.95, 0.48, 0.01, 1, { p: [x, 0.985, zFace - faceDir * 0.24] }));
    // vents + handle + number plate on the door face
    for (let k = 0; k < 4; k++) s.add('black', box(0.22, 0.012, 0.004, { p: [x, 1.65 + k * 0.04, zFace + faceDir * 0.002] }));
    s.add('chrome', box(0.02, 0.12, 0.02, { p: [x + 0.15, 1.05, zFace + faceDir * 0.01] }));
    s.add('ceramic', box(0.08, 0.04, 0.004, { p: [x, 1.85, zFace + faceDir * 0.002] }));
  }
  s.add('darkMetal', box(L, 0.08, 0.5, { p: [0, 0.04, zFace - faceDir * 0.24] }));
}

const lockers: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    lockerUnits(s, v || 4, -0.25 + 0.0, -1);
    return s.build('lockers');
  },
  colliders: (v) => PROP_COLLIDERS.lockers(v),
};

const lockersDouble: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    lockerUnits(s, v || 6, -0.5, -1);
    lockerUnits(s, v || 6, 0.5, 1);
    return s.build('lockersDouble');
  },
  colliders: (v) => PROP_COLLIDERS.lockersDouble(v),
};

const lockersFallen: PropDef = {
  cacheable: true,
  build(lib) {
    const s = new Sink(lib);
    const g = new Sink(lib);
    lockerUnits(g, 3, 0, 1);
    for (const [m, list] of g.map) {
      for (const geo of list) {
        // lay on its back: rotate -90deg around X so the doors face up
        xf(geo, { r: [-Math.PI / 2, 0, 0], p: [0, 0.0, 0] });
        xf(geo, { p: [0, 0.5, 1.0] });
        s.add(m, geo);
      }
    }
    return s.build('lockersFallen');
  },
  colliders: (v) => PROP_COLLIDERS.lockersFallen(v),
};

// -------------------------------------------------------------------------- light fixtures

export interface FixtureBuild {
  group: THREE.Group;
  /** Emissive materials to modulate when the light flickers. */
  emissive: THREE.MeshStandardMaterial[];
}

const lampCache = new Map<number, THREE.MeshStandardMaterial>();

export function buildFixture(lib: MaterialLibrary, type: string, color: number, unique: boolean): FixtureBuild {
  const s = new Sink(lib);
  let lampMat: THREE.MeshStandardMaterial;
  if (unique) {
    lampMat = lib.get('lampWarm').clone();
    lampMat.emissive.setHex(color);
  } else {
    let cached = lampCache.get(color);
    if (!cached) {
      cached = lib.get('lampWarm').clone();
      cached.emissive.setHex(color);
      lampCache.set(color, cached);
    }
    lampMat = cached;
  }
  const emissive = [lampMat];
  if (type === 'tube' || type === 'tubeBroken') {
    s.add('paintGrey', rbox(1.3, 0.06, 0.22, 0.015, 1, { p: [0, 0.05, 0] }));
    s.add(lampMat, capsule(0.022, 1.12, 3, 10, { p: [0, -0.01, 0.05], r: [0, 0, Math.PI / 2] }));
    if (type === 'tube') s.add(lampMat, capsule(0.022, 1.12, 3, 10, { p: [0, -0.01, -0.05], r: [0, 0, Math.PI / 2] }));
    else s.add(lampMat, capsule(0.022, 0.5, 3, 10, { p: [-0.35, -0.1, -0.05], r: [0.3, 0, Math.PI / 2 + 0.4] }));
    for (let i = 0; i < 6; i++) s.add('darkMetal', box(0.012, 0.012, 0.2, { p: [-0.55 + i * 0.22, -0.05, 0] }));
    s.add('darkMetal', box(1.24, 0.012, 0.012, { p: [0, -0.05, 0.1] }));
    s.add('darkMetal', box(1.24, 0.012, 0.012, { p: [0, -0.05, -0.1] }));
    s.add('darkMetal', cyl(0.006, 0.006, 0.3, 4, { p: [-0.5, 0.22, 0] }));
    s.add('darkMetal', cyl(0.006, 0.006, 0.3, 4, { p: [0.5, 0.22, 0] }));
  } else if (type === 'cage') {
    s.add('darkMetal', cyl(0.08, 0.08, 0.04, 14, { p: [0, 0.1, 0] }));
    s.add(lampMat, sphere(0.05, 12, 8, { p: [0, 0.02, 0] }));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      s.add('darkMetal', box(0.008, 0.14, 0.008, { p: [Math.cos(a) * 0.075, 0.02, Math.sin(a) * 0.075] }));
    }
    s.add('darkMetal', torus(0.075, 0.005, 4, 16, Math.PI * 2, { p: [0, -0.04, 0], r: [Math.PI / 2, 0, 0] }));
    s.add('darkMetal', torus(0.075, 0.005, 4, 16, Math.PI * 2, { p: [0, 0.04, 0], r: [Math.PI / 2, 0, 0] }));
  } else if (type === 'pendant') {
    s.add('darkMetal', cyl(0.008, 0.008, 1.2, 4, { p: [0, 0.75, 0] }));
    s.add('paintGreen', lathe([[0.05, 0.2], [0.07, 0.17], [0.3, 0.02], [0.31, 0.0], [0.29, 0.0], [0.07, 0.15], [0.04, 0.17]], 24));
    s.add(lampMat, sphere(0.07, 12, 8, { p: [0, 0.06, 0] }));
  } else if (type === 'emergency') {
    s.add('darkMetal', cyl(0.07, 0.08, 0.05, 14, { p: [0, 0.12, 0] }));
    const g = sphere(0.065, 14, 8, { p: [0, 0.08, 0] }, 0, Math.PI * 2, Math.PI * 0.4, Math.PI * 0.6);
    s.add(lampMat, g);
    s.add('darkMetal', box(0.2, 0.04, 0.04, { p: [0, 0.16, 0] }));
  } else if (type === 'flood') {
    s.add('darkMetal', rbox(0.35, 0.25, 0.15, 0.03, 2, { p: [0, 0, 0] }));
    s.add(lampMat, box(0.3, 0.2, 0.01, { p: [0, 0, -0.08] }));
  }
  // housings cast (cage wires and shades throw shadows); bulbs and glass are exempt
  return { group: s.build(`fixture:${type}`, true), emissive };
}

// -------------------------------------------------------------------------- registry

// -------------------------------------------------------------------------- clutter
// Small loose items scattered along walls (see game/view/Clutter.ts). No collision: they're
// ankle-high at most, so walking through them never snags.

const noColliders = (): PropCollider[] => [];

const paperClutter: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(4100 + v * 31);
    const kind = v % 3;
    if (kind === 2) {
      // crumpled balls
      for (let i = 0; i < 2; i++) {
        const g = rock(0.07, 0.06, 0.07, rng.next() * 1000, 1, 0.1);
        s.add('paper', xf(g, { p: [rng.range(-0.15, 0.15), 0.03, rng.range(-0.1, 0.1)], r: [rng.next(), rng.next() * 6, rng.next()] }));
      }
    } else {
      for (let i = 0; i <= kind; i++) {
        s.add('paper', box(0.21, 0.002, 0.297, { p: [rng.range(-0.08, 0.08), 0.001 + i * 0.002, rng.range(-0.06, 0.06)], r: [rng.range(-0.04, 0.04), rng.next() * 6.28, rng.range(-0.04, 0.04)] }));
      }
    }
    return s.build('clutter:paper');
  },
  colliders: noColliders,
};

const canClutter: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const lying = v % 2 === 1;
    const g = cyl(0.037, 0.037, 0.11, 14);
    if (v % 3 !== 0) dent(g, v * 1.3, 0.0, 0.035, 0.012);
    s.add(v % 4 === 0 ? 'rust' : 'paintGrey', xf(g, lying ? { p: [0, 0.037, 0], r: [Math.PI / 2, 0, v * 0.7] } : { p: [0, 0.055, 0] }));
    return s.build('clutter:can');
  },
  colliders: noColliders,
};

const chunkClutter: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(5200 + v * 17);
    const n = 2 + (v % 3);
    for (let i = 0; i < n; i++) {
      const sz = rng.range(0.04, 0.11);
      const g = rock(sz * rng.range(1, 1.6), sz * rng.range(0.5, 0.9), sz, rng.next() * 1000, 0, 0.25);
      s.add(rng.chance(0.4) ? 'concreteDark' : 'concrete', xf(g, { p: [rng.range(-0.2, 0.2), sz * 0.3, rng.range(-0.12, 0.12)], r: [rng.range(-0.4, 0.4), rng.next() * 6, rng.range(-0.4, 0.4)] }));
    }
    return s.build('clutter:chunk');
  },
  colliders: noColliders,
};

const brickClutter: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(6300 + v * 13);
    const n = 1 + (v % 2);
    for (let i = 0; i < n; i++) {
      s.add('brick', rbox(0.21, 0.065, 0.1, 0.006, 1, { p: [rng.range(-0.1, 0.1), 0.0325 + (i === 1 && v % 4 === 3 ? 0.065 : 0), rng.range(-0.08, 0.08)], r: [0, rng.next() * 6, 0] }));
    }
    return s.build('clutter:brick');
  },
  colliders: noColliders,
};

const rebarClutter: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const rng = new Rng(7400 + v * 7);
    for (let i = 0; i < 2; i++) {
      const len = rng.range(0.5, 1.1);
      s.add('rust', cyl(0.007, 0.007, len, 6, { p: [rng.range(-0.1, 0.1), 0.008 + i * 0.012, rng.range(-0.1, 0.1)], r: [Math.PI / 2, rng.next() * 6, rng.range(-0.05, 0.05)] }));
    }
    return s.build('clutter:rebar');
  },
  colliders: noColliders,
};

const trayClutter: PropDef = {
  cacheable: true,
  build(lib, v) {
    const s = new Sink(lib);
    const flipped = v % 2 === 1;
    s.add('chrome', rbox(0.36, 0.022, 0.26, 0.008, 1, { p: [0, flipped ? 0.011 : 0.011, 0], r: [flipped ? Math.PI : 0, 0, 0] }));
    if (!flipped) s.add('paintGrey', rbox(0.32, 0.004, 0.22, 0.002, 1, { p: [0, 0.021, 0] }));
    return s.build('clutter:tray');
  },
  colliders: noColliders,
};

/** Clutter prop types (view only, no collision). */
export const CLUTTER = ['clutterPaper', 'clutterCan', 'clutterChunk', 'clutterBrick', 'clutterRebar', 'clutterTray'] as const;
export type ClutterType = (typeof CLUTTER)[number];

export const PROPS: Record<string, PropDef> = {
  clutterPaper: paperClutter,
  clutterCan: canClutter,
  clutterChunk: chunkClutter,
  clutterBrick: brickClutter,
  clutterRebar: rebarClutter,
  clutterTray: trayClutter,
  rubble,
  holeEdge,
  slab,
  crate,
  crateSmall,
  barrel,
  valve,
  pipes,
  boiler,
  pump,
  showerHead,
  drain,
  bars,
  desk,
  bunk,
  bunkTipped,
  mattress,
  toilet,
  bench,
  detector,
  washer,
  cart,
  lockers,
  lockersDouble,
  lockersFallen,
};
