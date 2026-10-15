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
  VignetteEffect,
} from 'postprocessing';
import { GradeEffect, HdrClampPass, LuminancePass, NEUTRAL_GRADE, type GradeParams } from './GradeEffect';
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
  /** Bloom intensity multiplier (Glow setting). */
  glow: number;
  /** Color grade (map palette x visual style x contrast). */
  grade: GradeParams;
  /** Eye adaptation target key; 0 disables adaptation. */
  adaptKey: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  quality: QUALITY_PRESETS.medium,
  resolutionScale: 1,
  motionBlur: false,
  chromaticAberration: true,
  filmGrain: true,
  vignette: true,
  exposure: 1,
  glow: 1,
  grade: NEUTRAL_GRADE,
  adaptKey: 0.1,
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
  private bloom: BloomEffect | null = null;
  private grade = new GradeEffect();
  private lum: LuminancePass | null = null;
  private ca: ChromaticAberrationEffect | null = null;
  private vignette: VignetteEffect | null = null;
  private noise: NoiseEffect | null = null;
  /** Current aim state: 0 hip .. 1 fully aimed; scoped = looking through a magnified scope. */
  private aim = 0;
  private scoped = false;
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
    this.bloom = null;
    this.ca = null;
    this.vignette = null;
    this.noise = null;
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

    // eye adaptation measures the HDR image; HDR values are clamped so nothing can white out bloom
    this.lum = null;
    if (this.options.adaptKey > 0) {
      this.lum = new LuminancePass();
      this.lum.key = this.options.adaptKey;
      composer.addPass(this.lum);
    }
    composer.addPass(new HdrClampPass(20));
    const hdrEffects = [];
    if (q.bloom) {
      // high threshold: only real light sources (HDR emissives > 1) bloom
      this.bloom = new BloomEffect({
        intensity: 0.9 * this.options.glow,
        luminanceThreshold: 1.0,
        luminanceSmoothing: 0.35,
        mipmapBlur: true,
        radius: 0.75,
      });
      hdrEffects.push(this.bloom);
    }
    this.grade = new GradeEffect();
    this.grade.set(this.options.grade, 1);
    hdrEffects.push(this.grade);
    composer.addPass(new EffectPass(camera, ...hdrEffects));

    if (q.aa === 'smaa') composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
    else composer.addPass(new EffectPass(camera, new FXAAEffect()));

    const finalEffects = [];
    if (this.options.chromaticAberration) {
      this.ca = new ChromaticAberrationEffect({
        offset: new THREE.Vector2(0.0009, 0.0006),
        radialModulation: true,
        modulationOffset: 0.35,
      });
      finalEffects.push(this.ca);
    }
    if (this.options.vignette) {
      this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.55 });
      finalEffects.push(this.vignette);
    }
    if (this.options.filmGrain) {
      this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
      this.noise.blendMode.opacity.value = 0.09;
      finalEffects.push(this.noise);
    }
    finalEffects.push(this.screenFx);
    composer.addPass(new EffectPass(camera, ...finalEffects));
    composer.setSize(this.width, this.height, false);
    this.applyAim();
  }

  /**
   * Aiming down sights: chromatic aberration, grain, vignette and motion blur fade out and bloom
   * drops, so the sight picture (and especially a magnified scope) stays crisp.
   */
  setAim(ads: number, scoped: boolean): void {
    if (Math.abs(ads - this.aim) < 0.002 && scoped === this.scoped) return;
    this.aim = ads;
    this.scoped = scoped;
    this.applyAim();
  }

  private applyAim(): void {
    const a = this.scoped ? 1 : this.aim;
    const keep = 1 - a;
    if (this.bloom) this.bloom.intensity = 0.9 * this.options.glow * (1 - 0.7 * a);
    if (this.lum) this.lum.frozen = this.scoped;
    if (this.ca) this.ca.offset.set(0.0009 * keep, 0.0006 * keep);
    if (this.vignette) this.vignette.darkness = 0.55 * (1 - 0.85 * a);
    if (this.noise) this.noise.blendMode.opacity.value = 0.09 * (1 - 0.9 * a);
    if (this.motionBlur) this.motionBlur.intensity = keep;
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

  /** Scenes currently drawn (world first, then the viewmodel), for the perf overlay. */
  activeScenes(): THREE.Scene[] {
    return [this.scene, this.vmScene].filter((s): s is THREE.Scene => !!s);
  }

  render(dt: number): void {
    if (!this.enabled || this.contextLost || !this.composer) return;
    this.gl.info.reset();
    this.motionBlur?.updateMatrices();
    this.grade.set(this.options.grade, (this.lum?.adapted ?? 1) * this.options.exposure);
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer?.dispose();
    this.gl.dispose();
  }
}
