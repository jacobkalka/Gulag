import type * as THREE from 'three';
import { TextureFactory } from './textures/TextureFactory';
import { RECIPES } from './textures/recipes';
import { MaterialLibrary } from './materials';
import type { QualityPreset } from '@/engine/quality';
import { loadSoldiers, type SoldierAsset, type SoldierSkin } from '@/game/view/soldier/soldierAssets';

/** Procedurally generated assets shared by the lobby, matches and dev views. */
export class Assets {
  readonly textures: TextureFactory;
  readonly materials: MaterialLibrary;
  /** The two rigged soldier models (black-and-red, woodland camo). */
  soldiers!: Record<SoldierSkin, SoldierAsset>;

  private constructor(textures: TextureFactory) {
    this.textures = textures;
    this.materials = new MaterialLibrary(textures);
  }

  static async create(
    gl: THREE.WebGLRenderer,
    quality: QualityPreset,
    onProgress?: (fraction: number, label: string) => void,
  ): Promise<Assets> {
    const aniso = Math.min(gl.capabilities.getMaxAnisotropy(), quality.anisotropy);
    const tf = new TextureFactory(gl, quality.textureSize, quality.textureSizeSmall, aniso);
    await tf.generateAll(RECIPES, (d, t) => onProgress?.((d / t) * 0.9, `Generating materials ${d}/${t}`));
    const assets = new Assets(tf);
    onProgress?.(0.92, 'Loading soldiers');
    assets.soldiers = await loadSoldiers(assets.materials);
    return assets;
  }
}
