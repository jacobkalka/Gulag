import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { QUALITY_PRESETS, type QualityPreset } from './quality';
import { ScreenFxEffect } from './ScreenFxEffect';
import { MotionBlurEffect } from './MotionBlurEffect';

export interface RenderOptions {
  quality: QualityPreset;
  /** 0.5 – 1.0 multiplier on the backbuffer resolution. */
  resolutionScale: number;
  motionBlur: boolean;
  chromaticAberration: boolean;
  filmGrain: boolean;
  vignette: boolean;
  /** Exposure multiplier applied before tone mapping. */
  exposure: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  quality: QUALITY_PRESETS.medium,
  resolutionScale: 1,
  motionBlur: false,
  chromaticAberration: true,
  filmGrain: true,
  vignette: true,
  exposure: 1,
};

/**
 * Owns the WebGL renderer and the post-processing chain:
 *   world → N8AO → motion blur → viewmodel (depth cleared) → bloom+ACES → SMAA/FXAA → CA+vignette+grain+screen fx
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  composer!: EffectComposer;
  readonly screenFx = new ScreenFxEffect();
  options: RenderOptions;

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private vmScene: THREE.Scene | null = null;
  private vmCamera: THREE.PerspectiveCamera | null = null;
  private aoPass: N8AOPostPass | null = null;
  private motionBlur: MotionBlurEffect | null = null;
  private width = 1;
  private height = 1;
  contextLost = false;
  onContextRestored: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: RenderOptions = DEFAULT_RENDER_OPTIONS) {
    this.canvas = canvas;
    this.options = { ...options };
    const gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      depth: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl.capabilities.isWebGL2) throw new Error('WebGL2 is required.');
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.NoToneMapping;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.info.autoReset = false;
    this.gl = gl;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.onContextRestored?.();
    });
    this.resize();
  }

  /** The ambient occlusion pass, if enabled (exposed for live tuning). */
  get ao(): N8AOPostPass | null {
    return this.aoPass;
  }

  get maxAnisotropy(): number {
    return Math.min(this.gl.capabilities.getMaxAnisotropy(), this.options.quality.anisotropy);
  }

  setScenes(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    vmScene: THREE.Scene | null = null,
    vmCamera: THREE.PerspectiveCamera | null = null,
  ): void {
    this.scene = scene;
    this.camera = camera;
    this.vmScene = vmScene;
    this.vmCamera = vmCamera;
    this.rebuild();
  }

  setOptions(opts: Partial<RenderOptions>): void {
    this.options = { ...this.options, ...opts };
    this.resize();
    this.rebuild();
  }

  /** Rebuilds the post-processing chain for the current scenes and options. */
  rebuild(): void {
    if (this.composer) this.composer.dispose();
    const q = this.options.quality;
    this.gl.shadowMap.enabled = q.shadows;
    const composer = new EffectComposer(this.gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer = composer;
    this.aoPass = null;
    this.motionBlur = null;
    if (!this.scene || !this.camera) return;
    const camera = this.camera;

    composer.addPass(new RenderPass(this.scene, camera));

    if (q.ao !== 'off') {
      const ao = new N8AOPostPass(this.scene, camera, this.width, this.height);
      ao.configuration.gammaCorrection = false;
      ao.configuration.aoRadius = 1.6;
      ao.configuration.distanceFalloff = 0.6;
      ao.configuration.intensity = 3.2;
      ao.configuration.halfRes = q.aoHalfRes;
      ao.configuration.depthAwareUpsampling = true;
      ao.setQualityMode(q.ao === 'performance' ? 'Performance' : q.ao === 'medium' ? 'Medium' : 'High');
      composer.addPass(ao);
      this.aoPass = ao;
    }

    // Motion blur runs on the HDR world image *before* the viewmodel is drawn, so the
    // depth texture holds world depth only and the gun is never smeared.
    if (this.options.motionBlur) {
      this.motionBlur = new MotionBlurEffect(camera);
      composer.addPass(new EffectPass(camera, this.motionBlur));
    }

    if (this.vmScene && this.vmCamera) {
      const vm = new RenderPass(this.vmScene, this.vmCamera);
      vm.clearPass.color = false;
      vm.clearPass.depth = true;
      vm.clearPass.stencil = false;
      vm.ignoreBackground = true;
      vm.skipShadowMapUpdate = true;
      composer.addPass(vm);
    }

    const hdrEffects = [];
    if (q.bloom) {
      hdrEffects.push(
        new BloomEffect({
          intensity: 1.15,
          luminanceThreshold: 0.92,
          luminanceSmoothing: 0.25,
          mipmapBlur: true,
          radius: 0.72,
        }),
      );
    }
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    hdrEffects.push(tone);
    composer.addPass(new EffectPass(camera, ...hdrEffects));

    if (q.aa === 'smaa') composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
    else composer.addPass(new EffectPass(camera, new FXAAEffect()));

    const finalEffects = [];
    if (this.options.chromaticAberration) {
      finalEffects.push(
        new ChromaticAberrationEffect({
          offset: new THREE.Vector2(0.0009, 0.0006),
          radialModulation: true,
          modulationOffset: 0.35,
        }),
      );
    }
    if (this.options.vignette) finalEffects.push(new VignetteEffect({ offset: 0.32, darkness: 0.55 }));
    if (this.options.filmGrain) {
      const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
      noise.blendMode.opacity.value = 0.09;
      finalEffects.push(noise);
    }
    finalEffects.push(this.screenFx);
    composer.addPass(new EffectPass(camera, ...finalEffects));
    composer.setSize(this.width, this.height, false);
  }

  resize(): void {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight || window.innerHeight));
    const pr = Math.min(window.devicePixelRatio || 1, this.options.quality.maxPixelRatio) * this.options.resolutionScale;
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h, false);
    this.width = w;
    this.height = h;
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this.vmCamera) {
      this.vmCamera.aspect = w / h;
      this.vmCamera.updateProjectionMatrix();
    }
    if (this.composer) this.composer.setSize(w, h, false);
  }

  /** When false, frames are skipped entirely (automated network tests, hidden tabs). */
  enabled = true;

  render(dt: number): void {
    if (!this.enabled || this.contextLost || !this.composer) return;
    this.gl.info.reset();
    this.motionBlur?.updateMatrices();
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer?.dispose();
    this.gl.dispose();
  }
}
