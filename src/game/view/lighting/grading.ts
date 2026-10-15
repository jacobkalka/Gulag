import type { GradeParams } from '@/engine/GradeEffect';
import type { Settings, VisualStyle } from '@/app/settings';

// Per-map color palettes and the Visual Style presets (Cinematic / Balanced / Natural).
// Cool shadows against warm highlights; each map adds its own temperature contrast.

export interface MapPalette {
  exposure: number;
  saturation: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** Eye adaptation target key (scene luminance the exposure aims for). */
  key: number;
}

export const PALETTES: Record<string, MapPalette> = {
  // bunker: sickly green fluorescents, warm tungsten pools, red emergency accents, cold blue-gray shadows
  sublevel9: { exposure: 2.3, saturation: 0.95, shadowTint: [0.94, 0.98, 1.05], highlightTint: [1.04, 1.0, 0.95], key: 0.07 },
  // tropical night: deep teal/green with amber lantern glow
  jungle: { exposure: 1.7, saturation: 1.12, shadowTint: [0.82, 1.02, 1.04], highlightTint: [1.1, 0.98, 0.82], key: 0.05 },
  // snow night: icy blue shadows, hot orange windows
  snow: { exposure: 1.6, saturation: 1.06, shadowTint: [0.86, 0.95, 1.14], highlightTint: [1.12, 0.98, 0.84], key: 0.06 },
  neutral: { exposure: 1, saturation: 1, shadowTint: [1, 1, 1], highlightTint: [1, 1, 1], key: 0.12 },
};

const STYLE: Record<VisualStyle, { contrast: number; split: number; sat: number }> = {
  cinematic: { contrast: 1.22, split: 0.45, sat: 1 },
  balanced: { contrast: 1.12, split: 0.3, sat: 0.97 },
  natural: { contrast: 1.03, split: 0.1, sat: 0.93 },
};

/** Grade for a map palette, the chosen visual style and the Contrast slider (0.6..1.5). */
export function gradeFor(palette: MapPalette, style: VisualStyle, contrast: number): GradeParams {
  const st = STYLE[style] ?? STYLE.cinematic;
  return {
    exposure: palette.exposure,
    contrast: 1 + (st.contrast - 1) * contrast + (contrast - 1) * 0.35,
    saturation: 1 + (palette.saturation - 1) * st.sat + (st.sat - 1) * 0.5,
    shadowTint: palette.shadowTint,
    highlightTint: palette.highlightTint,
    split: st.split,
    lift: 0.004,
  };
}

/** Renderer options for a map under the player's settings (Glow, Contrast, Visual Style). */
export function gradeOptions(mapId: string, s: Settings, quality: string = s.quality): { glow: number; grade: GradeParams; adaptKey: number } {
  const p = PALETTES[mapId] ?? PALETTES.neutral;
  const low = quality === 'low';
  return {
    glow: s.glow * (s.visualStyle === 'natural' ? 0.75 : 1),
    grade: gradeFor(p, s.visualStyle, s.contrast),
    // eye adaptation needs a readback every few frames; skip it on Low
    adaptKey: low ? 0 : p.key,
  };
}
