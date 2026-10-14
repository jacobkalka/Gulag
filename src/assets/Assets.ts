import type * as THREE from 'three';
import { TextureFactory } from './textures/TextureFactory';
import { RECIPES } from './textures/recipes';
import { MaterialLibrary } from './materials';
import type { QualityPreset } from '@/engine/quality';

/** Procedurally generated assets shared by the lobby, matches and dev views. */
export class Assets {
  readonly textures: TextureFactory;
  readonly materials: MaterialLibrary;

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
    await tf.generateAll(RECIPES, (d, t) => onProgress?.(d / t, `Generating materials ${d}/${t}`));
    return new Assets(tf);
  }
}
