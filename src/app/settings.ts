import { signal } from '@preact/signals';
import { DEFAULT_BINDINGS, TOUCHPAD_BINDINGS, type Bindings, type InputSettings } from '@/engine/Input';
import { detectDefaultQuality, type QualityLevel } from '@/engine/quality';

// Player settings, persisted per browser in localStorage.

export type CrosshairStyle = 'cross' | 'dot' | 'circle' | 'chevron';
export type InputMode = 'mouse' | 'touchpad';
export type VisualStyle = 'cinematic' | 'balanced' | 'natural';
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
  /** Mouse (pointer lock, raw input) or laptop touchpad (keyboard fire/aim, assists). */
  inputMode: InputMode;
  touchpadBindings: Bindings;
  touchpadSensitivity: number;
  /** Touchpad acceleration exponent (1 = linear, higher = slow precise moves, fast flicks). */
  touchpadCurve: number;
  /** Touchpad smoothing 0..0.8 (low-pass on look deltas). */
  touchpadSmoothing: number;
  /** Touchpad aim assist strength 0..1 (slowdown + light stickiness, never auto-aim). */
  aimAssist: number;
  /** Arrow keys turn the view (touchpad fallback). */
  arrowLook: boolean;
  arrowLookSpeed: number;
  /** Sprint automatically when pushing forward. */
  autoSprint: boolean;
  /** The first-launch input mode hint was shown. */
  seenInputHint: boolean;
  // view
  fov: number;
  /** Camera shake intensity 0..1 (movement bob, landing, damage flinch, explosions). */
  cameraShake: number;
  // graphics
  quality: QualityLevel;
  resolutionScale: number;
  motionBlur: boolean;
  chromaticAberration: boolean;
  filmGrain: boolean;
  vignette: boolean;
  /** Display gamma/brightness multiplier (1 = default). */
  brightness: number;
  /** Glow / bloom intensity multiplier. */
  glow: number;
  /** Contrast multiplier for the color grade. */
  contrast: number;
  visualStyle: VisualStyle;
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
  inputMode: 'mouse',
  touchpadBindings: TOUCHPAD_BINDINGS,
  touchpadSensitivity: 3.2,
  touchpadCurve: 1.25,
  touchpadSmoothing: 0.25,
  aimAssist: 0.5,
  arrowLook: false,
  arrowLookSpeed: 150,
  autoSprint: false,
  seenInputHint: false,
  fov: 90,
  cameraShake: 0.6,
  quality: detectDefaultQuality(),
  resolutionScale: 1,
  motionBlur: false,
  chromaticAberration: true,
  filmGrain: true,
  vignette: true,
  brightness: 1,
  glow: 1,
  contrast: 1,
  visualStyle: 'cinematic',
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
    const merged = { ...structuredClone(DEFAULT_SETTINGS), ...s, bindings: { ...DEFAULT_BINDINGS, ...(s.bindings ?? {}) }, touchpadBindings: { ...TOUCHPAD_BINDINGS, ...(s.touchpadBindings ?? {}) } };
    // v1 saves bound the flash grenade to F, which is now the flashlight
    if (!s.bindings?.flashlight && merged.bindings.tactical.includes('KeyF')) merged.bindings.tactical = ['KeyX'];
    return merged;
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

/** The binding set for the current input mode. */
export function activeBindings(s: Settings): Bindings {
  return s.inputMode === 'touchpad' ? s.touchpadBindings : s.bindings;
}

/** Input-system settings derived from the player settings. */
export function inputSettingsOf(s: Settings): InputSettings {
  return {
    sensitivity: s.sensitivity,
    adsSensitivity: s.adsSensitivity,
    invertY: s.invertY,
    toggleAds: s.toggleAds,
    toggleCrouch: s.toggleCrouch,
    holdSprint: s.holdSprint,
    mode: s.inputMode,
    touchpadSensitivity: s.touchpadSensitivity,
    touchpadCurve: s.touchpadCurve,
    touchpadSmoothing: s.touchpadSmoothing,
    arrowLook: s.arrowLook,
    arrowLookSpeed: s.arrowLookSpeed,
    autoSprint: s.autoSprint,
  };
}

/**
 * Switching to touchpad mode the first time also turns on the defaults that suit it
 * (toggle aim, auto sprint). Returns the settings patch.
 */
export function inputModePatch(mode: InputMode): Partial<Settings> {
  const s = settings.value;
  if (mode === s.inputMode) return {};
  if (mode === 'touchpad') return { inputMode: mode, toggleAds: true, autoSprint: true, seenInputHint: true };
  return { inputMode: mode, toggleAds: false, autoSprint: false, seenInputHint: true };
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
