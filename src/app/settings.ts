import { signal } from '@preact/signals';
import { DEFAULT_BINDINGS, type Bindings } from '@/engine/Input';
import { detectDefaultQuality, type QualityLevel } from '@/engine/quality';

// Player settings, persisted per browser in localStorage.

export type CrosshairStyle = 'cross' | 'dot' | 'circle' | 'chevron';
export type ColorblindMode = 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia';

export interface Settings {
  // controls
  sensitivity: number;
  adsSensitivity: number;
  invertY: boolean;
  toggleAds: boolean;
  toggleCrouch: boolean;
  holdSprint: boolean;
  bindings: Bindings;
  // view
  fov: number;
  // graphics
  quality: QualityLevel;
  resolutionScale: number;
  motionBlur: boolean;
  chromaticAberration: boolean;
  filmGrain: boolean;
  vignette: boolean;
  // audio
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  uiVolume: number;
  // HUD
  crosshairStyle: CrosshairStyle;
  crosshairColor: string;
  crosshairSize: number;
  crosshairGap: number;
  crosshairThickness: number;
  crosshairDot: boolean;
  crosshairDynamic: boolean;
  damageNumbers: boolean;
  hudScale: number;
  showFps: boolean;
  showPing: boolean;
  colorblind: ColorblindMode;
  subtitles: boolean;
  /** Reduces camera shake, roll, head/weapon bob and motion blur (motion sickness). */
  reduceMotion: boolean;
  // gameplay
  botDifficulty: 'recruit' | 'regular' | 'veteran';
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 2.2,
  adsSensitivity: 0.85,
  invertY: false,
  toggleAds: false,
  toggleCrouch: false,
  holdSprint: false,
  bindings: DEFAULT_BINDINGS,
  fov: 90,
  quality: detectDefaultQuality(),
  resolutionScale: 1,
  motionBlur: false,
  chromaticAberration: true,
  filmGrain: true,
  vignette: true,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  musicVolume: 0.45,
  uiVolume: 0.7,
  crosshairStyle: 'cross',
  crosshairColor: '#ffffff',
  crosshairSize: 9,
  crosshairGap: 5,
  crosshairThickness: 2,
  crosshairDot: true,
  crosshairDynamic: true,
  damageNumbers: true,
  hudScale: 1,
  showFps: false,
  showPing: true,
  colorblind: 'off',
  subtitles: false,
  reduceMotion: false,
  botDifficulty: 'regular',
};

const KEY = 'lockdown.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw) as Partial<Settings>;
    return { ...structuredClone(DEFAULT_SETTINGS), ...s, bindings: { ...DEFAULT_BINDINGS, ...(s.bindings ?? {}) } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export const settings = signal<Settings>(load());

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings.value));
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

export function resetSettings(): void {
  settings.value = structuredClone(DEFAULT_SETTINGS);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Team colors, adjusted for color-blind modes (friend vs enemy must stay distinct). */
export function teamColors(mode: ColorblindMode): { friendly: string; enemy: string; friendlyHex: number; enemyHex: number } {
  switch (mode) {
    case 'deuteranopia':
    case 'protanopia':
      return { friendly: '#3d9cff', enemy: '#ffb000', friendlyHex: 0x3d9cff, enemyHex: 0xffb000 };
    case 'tritanopia':
      return { friendly: '#00c8a0', enemy: '#ff4d6d', friendlyHex: 0x00c8a0, enemyHex: 0xff4d6d };
    default:
      return { friendly: '#3cc8ff', enemy: '#ff5a1f', friendlyHex: 0x3cc8ff, enemyHex: 0xff5a1f };
  }
}
