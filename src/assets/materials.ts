import * as THREE from 'three';
import type { TextureFactory } from './textures/TextureFactory';
import { reticleTexture } from './textures/canvasTextures';

interface MatDef {
  tex?: string;
  color?: number;
  rough?: number;
  metal?: number;
  env?: number;
  normalScale?: number;
  ao?: number;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  physical?: boolean;
}

// Every named material used by the map, props, weapons and characters.
const DEFS: Record<string, MatDef> = {
  // --- Architecture
  concrete: { tex: 'concrete', env: 0.6 },
  concreteDark: { tex: 'concreteDark', env: 0.5 },
  floor: { tex: 'floor', env: 1.0 },
  tileWhite: { tex: 'tileWhite', env: 0.9 },
  tileGreen: { tex: 'tileGreen', env: 0.9 },
  tileFloor: { tex: 'tileFloor', env: 1.0 },
  paintGreen: { tex: 'paintGreen', env: 0.8 },
  paintGrey: { tex: 'paintGrey', env: 0.8 },
  paintBlue: { tex: 'paintBlue', env: 0.8 },
  paintOrange: { tex: 'paintOrange', env: 0.8 },
  rust: { tex: 'rust', env: 0.6 },
  diamond: { tex: 'diamond', env: 1.0 },
  brick: { tex: 'brick', env: 0.4 },
  plasterCream: { tex: 'plasterCream', env: 0.6 },
  plasterGreen: { tex: 'plasterGreen', env: 0.6 },
  wood: { tex: 'wood', env: 0.4 },
  hazard: { tex: 'hazard', env: 0.6 },
  mattress: { tex: 'mattress', env: 0.3 },
  rubberMat: { tex: 'rubber', env: 0.4 },
  steelPipe: { tex: 'paintGrey', env: 1.0, color: 0xb8bcc0 },
  ceramic: { color: 0xe8e4da, rough: 0.12, metal: 0, env: 1.2 },
  chrome: { color: 0xc8ccd0, rough: 0.18, metal: 1, env: 1.3 },
  darkMetal: { tex: 'gunSteel', color: 0x777777, env: 0.9 },
  black: { color: 0x0a0a0b, rough: 0.9, metal: 0, env: 0.2 },
  // --- Light fixtures (emissive)
  lampWarm: { color: 0x000000, emissive: 0xffd3a0, emissiveIntensity: 9, rough: 0.4 },
  lampCool: { color: 0x000000, emissive: 0xd6ecff, emissiveIntensity: 9, rough: 0.4 },
  lampRed: { color: 0x000000, emissive: 0xff2a12, emissiveIntensity: 7, rough: 0.4 },
  lampOrange: { color: 0x000000, emissive: 0xff7a1c, emissiveIntensity: 7, rough: 0.4 },
  lampCyan: { color: 0x000000, emissive: 0x3cc8ff, emissiveIntensity: 7, rough: 0.4 },
  furnace: { color: 0x000000, emissive: 0xff6a18, emissiveIntensity: 5, rough: 0.6 },
  glassFixture: { color: 0xeef4ff, rough: 0.05, metal: 0, transparent: true, opacity: 0.35, env: 1.5 },
  // --- Guns
  gunSteel: { tex: 'gunSteel', env: 1.15 },
  gunPolymer: { tex: 'gunPolymer', env: 0.9 },
  gunPolymerTan: { tex: 'gunPolymerTan', env: 0.9 },
  gunGrip: { tex: 'gunGrip', env: 0.8 },
  gunAlu: { tex: 'gunAlu', env: 1.15 },
  gunAluTan: { tex: 'gunAluTan', env: 1.1 },
  gunWood: { tex: 'gunWood', env: 0.8, rough: 0.8 },
  gunRubber: { tex: 'rubber', env: 0.5 },
  gunDark: { color: 0x050506, rough: 0.7, metal: 0.2, env: 0.4 },
  gunBrass: { color: 0xc9a050, rough: 0.28, metal: 1, env: 1.2 },
  lens: { color: 0x1a2a33, rough: 0.04, metal: 0.3, env: 2.2, physical: true },
  sightGlass: { color: 0x9fd8c8, rough: 0.02, metal: 0, transparent: true, opacity: 0.16, env: 1.6 },
  tritium: { color: 0x000000, emissive: 0x6dff8a, emissiveIntensity: 4 },
  accentOrange: { color: 0x000000, emissive: 0xff6a13, emissiveIntensity: 3, rough: 0.5 },
  // --- Characters
  fabricA: { tex: 'fabricA', env: 0.5 },
  fabricB: { tex: 'fabricB', env: 0.5 },
  armor: { tex: 'armor', env: 0.8 },
  leather: { tex: 'leather', env: 0.6 },
  visor: { color: 0x07090b, rough: 0.08, metal: 0.6, env: 1.8, physical: true },
  teamA: { color: 0xff6a13, emissive: 0xff5a0a, emissiveIntensity: 2.2, rough: 0.5 },
  teamB: { color: 0x3cc8ff, emissive: 0x2ab8ff, emissiveIntensity: 2.2, rough: 0.5 },
};

export type MaterialName = keyof typeof DEFS;

export class MaterialLibrary {
  private cache = new Map<string, THREE.Material>();
  private reticles = new Map<string, THREE.MeshBasicMaterial>();
  envMap: THREE.Texture | null = null;

  constructor(private textures: TextureFactory) {}

  get(name: string): THREE.MeshStandardMaterial {
    const hit = this.cache.get(name);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const def = DEFS[name];
    if (!def) throw new Error(`Unknown material '${name}'`);
    const params: THREE.MeshPhysicalMaterialParameters = {
      name,
      color: def.color ?? 0xffffff,
      roughness: def.rough ?? 1,
      metalness: def.metal ?? (def.tex ? 1 : 0),
      envMapIntensity: def.env ?? 1,
      side: def.side ?? THREE.FrontSide,
      transparent: !!def.transparent,
      opacity: def.opacity ?? 1,
    };
    if (def.tex) {
      const set = this.textures.get(def.tex);
      params.map = set.map;
      params.normalMap = set.normalMap;
      params.roughnessMap = set.ormMap;
      params.metalnessMap = set.ormMap;
      params.aoMap = set.ormMap;
      params.aoMapIntensity = def.ao ?? 1;
      params.normalScale = new THREE.Vector2(def.normalScale ?? 1, def.normalScale ?? 1);
      if (def.rough !== undefined) params.roughness = def.rough;
    }
    if (def.emissive !== undefined) {
      params.emissive = new THREE.Color(def.emissive);
      params.emissiveIntensity = def.emissiveIntensity ?? 1;
    }
    if (def.transparent) params.depthWrite = false;
    const mat = def.physical
      ? new THREE.MeshPhysicalMaterial({ ...params, clearcoat: 1, clearcoatRoughness: 0.05 })
      : new THREE.MeshStandardMaterial(params);
    if (this.envMap) mat.envMap = this.envMap;
    this.cache.set(name, mat);
    return mat;
  }

  /** Clone of a named material with a different tint (e.g. per-weapon colorways). */
  tinted(name: string, color: number, key = `${name}#${color.toString(16)}`): THREE.MeshStandardMaterial {
    const hit = this.cache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = this.get(name).clone();
    m.color.setHex(color);
    this.cache.set(key, m);
    return m;
  }

  reticle(style: 'holo' | 'dot' | 'chevron', color: number): THREE.MeshBasicMaterial {
    const key = `${style}:${color}`;
    let m = this.reticles.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        map: reticleTexture(style),
        color: new THREE.Color(color).multiplyScalar(4),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        toneMapped: true,
      });
      this.reticles.set(key, m);
    }
    return m;
  }

  /** Assigns an environment map to every standard material created so far (and future ones). */
  setEnvMap(env: THREE.Texture | null): void {
    this.envMap = env;
    for (const m of this.cache.values()) {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        (m as THREE.MeshStandardMaterial).envMap = env;
        m.needsUpdate = true;
      }
    }
  }

  all(): THREE.Material[] {
    return [...this.cache.values()];
  }
}
