import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { activeBindings, inputModePatch, settings, updateSettings, resetSettings, type Settings } from '@/app/settings';
import { ACTION_LABELS, keyLabel, type Action } from '@/engine/Input';
import type { GameController } from '@/app/GameController';
import { Button, Segmented, Slider, Toggle } from '../components';

type Tab = 'controls' | 'video' | 'audio' | 'hud';

export function SettingsPanel(props: { game: GameController; compact?: boolean }): JSX.Element {
  const [tab, setTab] = useState<Tab>('controls');
  const [rebind, setRebind] = useState<Action | null>(null);
  const s = settings.value;
  const g = props.game;
  const set = (patch: Partial<Settings>, apply?: 'input' | 'video' | 'audio' | 'hud') => {
    updateSettings(patch);
    if (apply === 'input') g.applyInputSettings();
    if (apply === 'video') g.applyGraphicsSettings();
    if (apply === 'audio') g.applyAudioSettings();
    if (apply === 'hud') g.applyInputSettings();
  };
  const startRebind = (a: Action) => {
    setRebind(a);
    g.input.onRebindCapture = (code) => {
      g.input.onRebindCapture = null;
      setRebind(null);
      if (code === 'Escape') return;
      const touchpad = settings.value.inputMode === 'touchpad';
      const b = structuredClone(activeBindings(settings.value));
      // remove the code from other actions to avoid conflicts
      for (const k of Object.keys(b) as Action[]) b[k] = (b[k] ?? []).filter((c) => c !== code);
      b[a] = [code, ...(b[a] ?? []).filter((c) => c !== code)].slice(0, 2);
      set(touchpad ? { touchpadBindings: b } : { bindings: b }, 'input');
    };
  };
  return (
    <div class={`settings ${props.compact ? 'compact' : ''}`}>
      <nav class="settings-tabs">
        {(['controls', 'video', 'audio', 'hud'] as Tab[]).map((t) => (
          <button class={`settings-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t === 'hud' ? 'HUD & ACCESSIBILITY' : t.toUpperCase()}
          </button>
        ))}
      </nav>
      <div class="settings-body">
        {tab === 'controls' && (
          <div class="settings-grid">
            <div class="col">
              <Segmented
                label="Input mode"
                value={s.inputMode}
                options={[
                  { value: 'mouse', label: 'MOUSE' },
                  { value: 'touchpad', label: 'TOUCHPAD' },
                ]}
                onChange={(v) => set(inputModePatch(v), 'input')}
              />
              <p class="hint" data-testid="input-mode-hint">
                {s.inputMode === 'touchpad'
                  ? 'Touchpad: Space fires, Left Shift aims, E jumps, Q sprints, two-finger scroll swaps. Much tighter hip fire, lighter recoil and gentle aim assist.'
                  : 'Mouse: raw pointer input, left click fires, right click aims.'}
              </p>
              {s.inputMode === 'mouse' ? (
                <>
                  <Slider label="Mouse sensitivity" value={s.sensitivity} min={0.2} max={8} step={0.05} onInput={(v) => set({ sensitivity: v }, 'input')} />
                </>
              ) : (
                <>
                  <Slider label="Touchpad sensitivity" value={s.touchpadSensitivity} min={0.5} max={10} step={0.05} onInput={(v) => set({ touchpadSensitivity: v }, 'input')} />
                  <Slider label="Touchpad acceleration curve" value={s.touchpadCurve} min={1} max={2} step={0.05} onInput={(v) => set({ touchpadCurve: v }, 'input')} format={(v) => (v <= 1.001 ? 'LINEAR' : v.toFixed(2))} />
                  <Slider label="Touchpad smoothing" value={s.touchpadSmoothing} min={0} max={0.8} step={0.05} onInput={(v) => set({ touchpadSmoothing: v }, 'input')} format={(v) => `${Math.round(v * 100)}%`} />
                  <Slider label="Aim assist" value={s.aimAssist} min={0} max={1} step={0.05} onInput={(v) => set({ aimAssist: v }, 'input')} format={(v) => (v === 0 ? 'OFF' : `${Math.round(v * 100)}%`)} />
                  <Toggle label="Arrow keys turn the view" value={s.arrowLook} onChange={(v) => set({ arrowLook: v }, 'input')} />
                  {s.arrowLook && <Slider label="Arrow look speed" value={s.arrowLookSpeed} min={40} max={360} step={5} onInput={(v) => set({ arrowLookSpeed: v }, 'input')} format={(v) => `${Math.round(v)}°/s`} />}
                </>
              )}
              <Slider label="ADS sensitivity multiplier" value={s.adsSensitivity} min={0.3} max={1.5} step={0.01} onInput={(v) => set({ adsSensitivity: v }, 'input')} />
              <Slider label="Field of view" value={s.fov} min={70} max={115} step={1} onInput={(v) => set({ fov: v })} format={(v) => `${Math.round(v)}°`} />
              <Segmented
                label="Aim down sights"
                value={s.toggleAds ? 'toggle' : 'hold'}
                options={[
                  { value: 'hold', label: 'HOLD' },
                  { value: 'toggle', label: 'TOGGLE' },
                ]}
                onChange={(v) => set({ toggleAds: v === 'toggle' }, 'input')}
              />
              <Toggle label="Invert Y axis" value={s.invertY} onChange={(v) => set({ invertY: v }, 'input')} />
              <Toggle label="Toggle crouch" value={s.toggleCrouch} onChange={(v) => set({ toggleCrouch: v }, 'input')} />
              <Toggle label="Hold to sprint (off = tap)" value={s.holdSprint} onChange={(v) => set({ holdSprint: v }, 'input')} />
              <Toggle label="Auto sprint" value={s.autoSprint} onChange={(v) => set({ autoSprint: v }, 'input')} hint="Holding forward starts a sprint" />
            </div>
            <div class="col binds">
              <div class="binds-h">
                {s.inputMode === 'touchpad' ? 'TOUCHPAD KEY BINDINGS' : 'KEY BINDINGS'} <small>click to rebind · Esc cancels</small>
              </div>
              {(Object.keys(ACTION_LABELS) as Action[]).map((a) => (
                <div class="bind-row">
                  <span>{ACTION_LABELS[a]}</span>
                  <button class={`bind-key ${rebind === a ? 'listening' : ''}`} onClick={() => startRebind(a)}>
                    {rebind === a ? 'PRESS A KEY…' : (activeBindings(s)[a] ?? []).map(keyLabel).join(' / ') || '—'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === 'video' && (
          <div class="settings-grid">
            <div class="col">
              <Segmented
                label="Graphics quality"
                value={s.quality}
                options={[
                  { value: 'low', label: 'LOW' },
                  { value: 'medium', label: 'MEDIUM' },
                  { value: 'high', label: 'HIGH' },
                  { value: 'ultra', label: 'ULTRA' },
                ]}
                onChange={(v) => {
                  set({ quality: v }, 'video');
                }}
              />
              <p class="hint">Texture resolution changes apply after reloading the page.</p>
              <Slider label="Brightness" value={s.brightness} min={0.6} max={1.6} step={0.02} onInput={(v) => set({ brightness: v })} format={(v) => `${Math.round(v * 100)}%`} hint="Raise it if dark corners are hard to see into" />
              <Segmented
                label="Visual style"
                value={s.visualStyle}
                options={[
                  { value: 'cinematic', label: 'CINEMATIC' },
                  { value: 'balanced', label: 'BALANCED' },
                  { value: 'natural', label: 'NATURAL' },
                ]}
                onChange={(v) => set({ visualStyle: v }, 'video')}
              />
              <Slider label="Glow / bloom" value={s.glow} min={0} max={2} step={0.05} onInput={(v) => set({ glow: v }, 'video')} format={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="Contrast" value={s.contrast} min={0.6} max={1.5} step={0.02} onInput={(v) => set({ contrast: v }, 'video')} format={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="Resolution scale" value={s.resolutionScale} min={0.5} max={1} step={0.05} onInput={(v) => set({ resolutionScale: v }, 'video')} format={(v) => `${Math.round(v * 100)}%`} />
              <Toggle label="Motion blur" value={s.motionBlur} onChange={(v) => set({ motionBlur: v }, 'video')} />
              <Toggle label="Chromatic aberration" value={s.chromaticAberration} onChange={(v) => set({ chromaticAberration: v }, 'video')} />
              <Toggle label="Film grain" value={s.filmGrain} onChange={(v) => set({ filmGrain: v }, 'video')} />
              <Toggle label="Vignette" value={s.vignette} onChange={(v) => set({ vignette: v }, 'video')} />
            </div>
            <div class="col">
              <Toggle label="Show FPS" value={s.showFps} onChange={(v) => set({ showFps: v })} />
              <Toggle label="Show ping" value={s.showPing} onChange={(v) => set({ showPing: v })} />
              <div class="hint big">
                <b>Presets</b>
                <br />LOW — no AO/bloom, 512px textures, FXAA.
                <br />MEDIUM — half-res AO, bloom, SMAA, 1K hero textures.
                <br />HIGH — dynamic moon shadows, 2 shadowed lights, more lights.
                <br />ULTRA — full-res AO, 2K textures, 4K shadows, 16 lights.
              </div>
            </div>
          </div>
        )}
        {tab === 'audio' && (
          <div class="settings-grid">
            <div class="col">
              <Slider label="Master volume" value={s.masterVolume} min={0} max={1} onInput={(v) => set({ masterVolume: v }, 'audio')} format={(v) => `${Math.round(v * 100)}`} />
              <Slider label="Effects" value={s.sfxVolume} min={0} max={1} onInput={(v) => set({ sfxVolume: v }, 'audio')} format={(v) => `${Math.round(v * 100)}`} />
              <Slider label="Music" value={s.musicVolume} min={0} max={1} onInput={(v) => set({ musicVolume: v }, 'audio')} format={(v) => `${Math.round(v * 100)}`} />
              <Slider label="Interface" value={s.uiVolume} min={0} max={1} onInput={(v) => set({ uiVolume: v }, 'audio')} format={(v) => `${Math.round(v * 100)}`} />
            </div>
          </div>
        )}
        {tab === 'hud' && (
          <div class="settings-grid">
            <div class="col">
              <Segmented
                label="Crosshair style"
                value={s.crosshairStyle}
                options={[
                  { value: 'cross', label: 'CROSS' },
                  { value: 'dot', label: 'DOT' },
                  { value: 'circle', label: 'CIRCLE' },
                  { value: 'chevron', label: 'T-SHAPE' },
                ]}
                onChange={(v) => set({ crosshairStyle: v })}
              />
              <label class="field">
                <span class="field-l">Crosshair color</span>
                <input type="color" value={s.crosshairColor} onInput={(e) => set({ crosshairColor: (e.target as HTMLInputElement).value }, 'hud')} />
              </label>
              <Slider label="Size" value={s.crosshairSize} min={3} max={20} step={1} onInput={(v) => set({ crosshairSize: v })} format={(v) => `${v}`} />
              <Slider label="Gap" value={s.crosshairGap} min={0} max={16} step={1} onInput={(v) => set({ crosshairGap: v })} format={(v) => `${v}`} />
              <Slider label="Thickness" value={s.crosshairThickness} min={1} max={5} step={1} onInput={(v) => set({ crosshairThickness: v })} format={(v) => `${v}`} />
              <Toggle label="Center dot" value={s.crosshairDot} onChange={(v) => set({ crosshairDot: v })} />
              <Toggle label="Dynamic spread" value={s.crosshairDynamic} onChange={(v) => set({ crosshairDynamic: v })} />
              <CrosshairPreview />
            </div>
            <div class="col">
              <Toggle label="Damage numbers" value={s.damageNumbers} onChange={(v) => set({ damageNumbers: v })} />
              <Slider label="HUD scale" value={s.hudScale} min={0.75} max={1.4} step={0.05} onInput={(v) => set({ hudScale: v }, 'hud')} format={(v) => `${Math.round(v * 100)}%`} />
              <Segmented
                label="Color-blind team colors"
                value={s.colorblind}
                options={[
                  { value: 'off', label: 'OFF' },
                  { value: 'deuteranopia', label: 'DEUTER.' },
                  { value: 'protanopia', label: 'PROTAN.' },
                  { value: 'tritanopia', label: 'TRITAN.' },
                ]}
                onChange={(v) => set({ colorblind: v }, 'hud')}
              />
              <Toggle label="Audio cue subtitles" value={s.subtitles} onChange={(v) => set({ subtitles: v })} hint="Captions with direction for gunfire, footsteps, grenades and reloads" />
              <Slider label="Camera shake" value={s.cameraShake} min={0} max={1} step={0.05} onInput={(v) => set({ cameraShake: v })} format={(v) => `${Math.round(v * 100)}%`} hint="Head bob, landing, flinch when hit, explosions" />
              <Toggle
                label="Reduce motion"
                value={s.reduceMotion}
                onChange={(v) => {
                  set({ reduceMotion: v });
                  props.game.applyGraphicsSettings();
                }}
                hint="Less camera shake, roll and weapon bob; disables motion blur"
              />
            </div>
          </div>
        )}
      </div>
      <footer class="settings-f">
        <Button variant="ghost" size="sm" onClick={() => {
          resetSettings();
          g.applyInputSettings();
          g.applyAudioSettings();
          g.applyGraphicsSettings();
        }}>
          RESET TO DEFAULTS
        </Button>
      </footer>
    </div>
  );
}

function CrosshairPreview(): JSX.Element {
  const s = settings.value;
  const gap = s.crosshairGap;
  const size = s.crosshairSize;
  const th = s.crosshairThickness;
  const c = s.crosshairColor;
  const line = (x: number, y: number, w: number, h: number) => <div style={{ position: 'absolute', left: `${50 + x}px`, top: `${50 + y}px`, width: `${w}px`, height: `${h}px`, background: c, boxShadow: '0 0 0 1px #000' }} />;
  return (
    <div class="xh-preview">
      <div style={{ position: 'relative', width: '100px', height: '100px' }}>
        {(s.crosshairStyle === 'cross' || s.crosshairStyle === 'chevron') && (
          <>
            {s.crosshairStyle === 'cross' && line(-th / 2, -gap - size, th, size)}
            {line(-th / 2, gap, th, size)}
            {line(-gap - size, -th / 2, size, th)}
            {line(gap, -th / 2, size, th)}
          </>
        )}
        {s.crosshairStyle === 'circle' && (
          <div style={{ position: 'absolute', left: `${50 - gap - 4}px`, top: `${50 - gap - 4}px`, width: `${(gap + 4) * 2}px`, height: `${(gap + 4) * 2}px`, borderRadius: '50%', border: `2px solid ${c}` }} />
        )}
        {(s.crosshairDot || s.crosshairStyle === 'dot') && <div style={{ position: 'absolute', left: `${50 - (th + 1) / 2}px`, top: `${50 - (th + 1) / 2}px`, width: `${th + 1}px`, height: `${th + 1}px`, borderRadius: '50%', background: c }} />}
      </div>
    </div>
  );
}
