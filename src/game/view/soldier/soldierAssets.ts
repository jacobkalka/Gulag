import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { MaterialLibrary } from '@/assets/materials';

// The two provided soldiers, rigged by tools/soldiers (public/assets/soldiers/*.glb).
// Loaded once at startup; every player gets a skeleton clone sharing geometry and textures.

export type SoldierSkin = 'red' | 'camo';
export const SOLDIER_SKINS: SoldierSkin[] = ['red', 'camo'];

export interface SoldierLandmarks {
  height: number;
  landmarks: Record<string, [number, number, number]>;
}

export interface SoldierAsset {
  skin: SoldierSkin;
  scene: THREE.Group;
  rig: SoldierLandmarks;
}

export interface SoldierInstance {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
}

/** Which skin a team wears this match: `skinTeam` (host-synced) is the black-and-red side. */
export function skinFor(team: 0 | 1, skinTeam: 0 | 1): SoldierSkin {
  return team === skinTeam ? 'red' : 'camo';
}

export async function loadSoldiers(lib: MaterialLibrary, base = import.meta.env.BASE_URL): Promise<Record<SoldierSkin, SoldierAsset>> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const load = async (skin: SoldierSkin): Promise<SoldierAsset> => {
    const gltf = await loader.loadAsync(`${base}assets/soldiers/${skin}.glb`);
    const scene = gltf.scene;
    let rig: SoldierLandmarks = { height: 1.8, landmarks: {} };
    scene.traverse((o) => {
      const raw = o.userData?.lockdown_rig;
      if (typeof raw === 'string') rig = JSON.parse(raw) as SoldierLandmarks;
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // skinned bounds don't follow the pose; a generous sphere keeps culling cheap and safe
      mesh.frustumCulled = false;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.name = `soldier:${skin}`;
      // the library hands these the reflection probe along with its own materials
      lib.adopt(`soldier:${skin}`, mat);
    });
    return { skin, scene, rig };
  };
  const [red, camo] = await Promise.all([load('red'), load('camo')]);
  return { red, camo };
}

export function instantiate(asset: SoldierAsset): SoldierInstance {
  const root = cloneSkinned(asset.scene) as THREE.Group;
  let mesh: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) throw new Error('soldier asset has no skinned mesh');
  root.name = `soldier:${asset.skin}`;
  return { root, mesh };
}
