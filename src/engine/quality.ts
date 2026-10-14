// Graphics quality presets. The user picks a preset; individual toggles in settings
// (resolution scale, motion blur, chromatic aberration, grain) layer on top.

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  level: QualityLevel;
  /** Procedural texture resolution for hero surfaces (floors, walls, guns). */
  textureSize: number;
  /** Procedural texture resolution for secondary surfaces. */
  textureSizeSmall: number;
  shadows: boolean;
  /** Moonlight (directional) shadow map size. */
  sunShadowSize: number;
  /** Re-render the moonlight shadow map every frame (so players cast moon shadows). */
  sunShadowDynamic: boolean;
  /** How many fixture spot lights may cast shadows. */
  shadowedSpots: number;
  spotShadowSize: number;
  /** Max simultaneously active real-time fixture point lights (rest are baked/emissive). */
  fixtureLights: number;
  ao: 'off' | 'performance' | 'medium' | 'high';
  aoHalfRes: boolean;
  bloom: boolean;
  aa: 'fxaa' | 'smaa';
  maxPixelRatio: number;
  particleScale: number;
  anisotropy: number;
  reflectionProbeSize: number;
  lightShafts: boolean;
  decalLimit: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    level: 'low',
    textureSize: 512,
    textureSizeSmall: 256,
    shadows: true,
    sunShadowSize: 1024,
    sunShadowDynamic: false,
    shadowedSpots: 0,
    spotShadowSize: 512,
    fixtureLights: 4,
    ao: 'off',
    aoHalfRes: true,
    bloom: false,
    aa: 'fxaa',
    maxPixelRatio: 1,
    particleScale: 0.4,
    anisotropy: 2,
    reflectionProbeSize: 128,
    lightShafts: false,
    decalLimit: 64,
  },
  medium: {
    level: 'medium',
    textureSize: 1024,
    textureSizeSmall: 512,
    shadows: true,
    sunShadowSize: 2048,
    sunShadowDynamic: false,
    shadowedSpots: 1,
    spotShadowSize: 512,
    fixtureLights: 8,
    ao: 'performance',
    aoHalfRes: true,
    bloom: true,
    aa: 'smaa',
    maxPixelRatio: 1,
    particleScale: 0.7,
    anisotropy: 4,
    reflectionProbeSize: 256,
    lightShafts: true,
    decalLimit: 128,
  },
  high: {
    level: 'high',
    textureSize: 1024,
    textureSizeSmall: 512,
    shadows: true,
    sunShadowSize: 2048,
    sunShadowDynamic: true,
    shadowedSpots: 2,
    spotShadowSize: 1024,
    fixtureLights: 12,
    ao: 'medium',
    aoHalfRes: true,
    bloom: true,
    aa: 'smaa',
    maxPixelRatio: 1.5,
    particleScale: 1,
    anisotropy: 8,
    reflectionProbeSize: 256,
    lightShafts: true,
    decalLimit: 256,
  },
  ultra: {
    level: 'ultra',
    textureSize: 2048,
    textureSizeSmall: 1024,
    shadows: true,
    sunShadowSize: 4096,
    sunShadowDynamic: true,
    shadowedSpots: 4,
    spotShadowSize: 1024,
    fixtureLights: 16,
    ao: 'high',
    aoHalfRes: false,
    bloom: true,
    aa: 'smaa',
    maxPixelRatio: 2,
    particleScale: 1.3,
    anisotropy: 16,
    reflectionProbeSize: 512,
    lightShafts: true,
    decalLimit: 400,
  },
};

/** Rough guess at a sensible default preset for this device. */
export function detectDefaultQuality(): QualityLevel {
  if (typeof navigator === 'undefined') return 'medium';
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (mobile) return 'low';
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (cores >= 12 && mem >= 8) return 'high';
  if (cores <= 4 || mem <= 4) return 'low';
  return 'medium';
}
