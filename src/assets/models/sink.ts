import * as THREE from 'three';
import type { MaterialLibrary } from '../materials';
import { merge, type Geo } from '../geometry/toolkit';

/** Collects prop geometry per material and builds one merged mesh per material. */
export class Sink {
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
