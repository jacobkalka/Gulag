import { BTN } from '@/game/sim/types';
import { clamp } from '@/shared/math';

// Keyboard/mouse (pointer lock) + gamepad input with rebindable actions.

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'fire'
  | 'ads'
  | 'reload'
  | 'melee'
  | 'swap'
  | 'primary'
  | 'secondary'
  | 'lethal'
  | 'tactical'
  | 'interact'
  | 'inspect'
  | 'scoreboard'
  | 'ping'
  | 'flashlight';

export type Bindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['KeyC', 'ControlLeft'],
  sprint: ['ShiftLeft'],
  fire: ['Mouse0'],
  ads: ['Mouse2'],
  reload: ['KeyR'],
  melee: ['KeyV', 'Mouse3'],
  swap: ['KeyQ', 'WheelUp', 'WheelDown'],
  primary: ['Digit1'],
  secondary: ['Digit2'],
  lethal: ['KeyG'],
  tactical: ['KeyX'],
  interact: ['KeyE'],
  inspect: ['KeyI'],
  scoreboard: ['Tab'],
  ping: ['KeyZ'],
  flashlight: ['KeyF'],
};

/**
 * Touchpad mode defaults: fire and aim from the keyboard (clicking while dragging a touchpad is
 * awkward). Space fires, Left Shift aims, E jumps, Q sprints, two-finger scroll swaps weapons.
 */
export const TOUCHPAD_BINDINGS: Bindings = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['KeyE'],
  crouch: ['KeyC', 'ControlLeft'],
  sprint: ['KeyQ'],
  fire: ['Space', 'Mouse0'],
  ads: ['ShiftLeft', 'Mouse2'],
  reload: ['KeyR'],
  melee: ['KeyV'],
  swap: ['WheelUp', 'WheelDown'],
  primary: ['Digit1'],
  secondary: ['Digit2'],
  lethal: ['KeyG'],
  tactical: ['KeyX'],
  interact: [],
  inspect: ['KeyI'],
  scoreboard: ['Tab'],
  ping: ['KeyZ'],
  flashlight: ['KeyF'],
};

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Strafe left',
  right: 'Strafe right',
  jump: 'Jump / mantle',
  crouch: 'Crouch / slide',
  sprint: 'Sprint',
  fire: 'Fire',
  ads: 'Aim down sights',
  reload: 'Reload',
  melee: 'Melee (shiv)',
  swap: 'Swap weapon',
  primary: 'Primary weapon',
  secondary: 'Secondary weapon',
  lethal: 'Throw frag',
  tactical: 'Throw flash',
  interact: 'Interact',
  inspect: 'Inspect weapon',
  scoreboard: 'Scoreboard',
  ping: 'Ping',
  flashlight: 'Weapon flashlight',
};

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
    WheelUp: 'Wheel ↑', WheelDown: 'Wheel ↓', Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', Tab: 'Tab', Escape: 'Esc',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', CapsLock: 'Caps',
  };
  return map[code] ?? code;
}

export interface InputSettings {
  sensitivity: number; // degrees per 1000 px-ish
  adsSensitivity: number; // multiplier while aiming
  invertY: boolean;
  toggleAds: boolean;
  toggleCrouch: boolean;
  holdSprint: boolean;
  /** 'touchpad' uses its own sensitivity, acceleration curve and smoothing. */
  mode: 'mouse' | 'touchpad';
  touchpadSensitivity: number;
  touchpadCurve: number;
  touchpadSmoothing: number;
  /** Arrow keys turn the view instead of moving. */
  arrowLook: boolean;
  /** Degrees per second for arrow-key look. */
  arrowLookSpeed: number;
  /** Sprint automatically while pushing forward. */
  autoSprint: boolean;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  sensitivity: 2.2,
  adsSensitivity: 0.85,
  invertY: false,
  toggleAds: false,
  toggleCrouch: false,
  holdSprint: false,
  mode: 'mouse',
  touchpadSensitivity: 3.2,
  touchpadCurve: 1.25,
  touchpadSmoothing: 0.25,
  arrowLook: false,
  arrowLookSpeed: 150,
  autoSprint: false,
};

export class Input {
  bindings: Bindings;
  settings: InputSettings;
  yaw = 0;
  pitch = 0;
  /** Accumulated look delta since last read (radians), for viewmodel sway. */
  lookDX = 0;
  lookDY = 0;
  private down = new Set<string>();
  private pressedOnce = new Set<string>();
  private wheelPulse = new Set<string>();
  private adsToggled = false;
  private crouchToggled = false;
  private sprintLatched = false;
  locked = false;
  enabled = true;
  /** Set by the game: current ADS fraction and zoom so ADS sensitivity scales with FOV. */
  adsFactor = 0;
  zoom = 1;
  /** Set by the game each frame: look speed multiplier (touchpad aim-assist slowdown). */
  lookScale = 1;
  private smoothX = 0;
  private smoothY = 0;
  private autoSprintT = 0;
  onPauseRequest: (() => void) | null = null;
  onRebindCapture: ((code: string) => void) | null = null;
  private gamepadIndex = -1;

  constructor(private el: HTMLElement, bindings: Bindings = DEFAULT_BINDINGS, settings?: Partial<InputSettings>) {
    this.bindings = structuredClone(bindings);
    this.settings = { ...DEFAULT_INPUT_SETTINGS, ...settings };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    el.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', this.onLockChange);
    window.addEventListener('blur', () => this.down.clear());
    window.addEventListener('gamepadconnected', (e) => (this.gamepadIndex = (e as GamepadEvent).gamepad.index));
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.el.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onLockChange);
  }

  requestLock(): void {
    const el = this.el as HTMLElement & { requestPointerLock: (o?: unknown) => Promise<void> | void };
    const plain = () => {
      try {
        const r2 = el.requestPointerLock();
        if (r2 && typeof (r2 as Promise<void>).catch === 'function') (r2 as Promise<void>).catch(() => undefined);
      } catch {
        /* needs a user gesture; the deploy overlay will ask for a click */
      }
    };
    // touchpads feel better with the OS pointer acceleration, so raw input is mouse-only
    if (this.settings.mode === 'touchpad') return plain();
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(plain);
    } catch {
      plain();
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private onLockChange = () => {
    const was = this.locked;
    this.locked = document.pointerLockElement === this.el;
    if (was && !this.locked) {
      this.down.clear();
      this.onPauseRequest?.();
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.onRebindCapture) {
      e.preventDefault();
      this.onRebindCapture(e.code);
      return;
    }
    if (!this.enabled) return;
    if (e.code === 'Tab' || (this.locked && (e.code === 'Space' || e.code.startsWith('Arrow')))) e.preventDefault();
    if (!this.down.has(e.code)) this.pressedOnce.add(e.code);
    this.down.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };
  private onMouseDown = (e: MouseEvent) => {
    const code = `Mouse${e.button}`;
    if (this.onRebindCapture) {
      e.preventDefault();
      this.onRebindCapture(code);
      return;
    }
    if (!this.locked) return;
    if (!this.down.has(code)) this.pressedOnce.add(code);
    this.down.add(code);
  };
  private onMouseUp = (e: MouseEvent) => {
    this.down.delete(`Mouse${e.button}`);
  };
  private onWheel = (e: WheelEvent) => {
    if (!this.locked) return;
    const code = e.deltaY < 0 ? 'WheelUp' : 'WheelDown';
    this.wheelPulse.add(code);
    this.pressedOnce.add(code);
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked || !this.enabled) return;
    // Base: sensitivity 1.0 = 0.022 deg per count (classic), scaled for zoom when aiming.
    const st = this.settings;
    const adsMul = 1 + (st.adsSensitivity / this.zoom - 1) * this.adsFactor;
    let mx = clamp(e.movementX, -400, 400);
    let my = clamp(e.movementY, -400, 400);
    let sens = st.sensitivity;
    if (st.mode === 'touchpad') {
      // acceleration curve around a typical 6-count movement, then light smoothing
      const mag = Math.hypot(mx, my);
      if (mag > 0) {
        const g = Math.pow(mag / 6, st.touchpadCurve - 1);
        mx *= g;
        my *= g;
      }
      const sm = clamp(st.touchpadSmoothing, 0, 0.8);
      this.smoothX = this.smoothX * sm + mx * (1 - sm);
      this.smoothY = this.smoothY * sm + my * (1 - sm);
      mx = this.smoothX;
      my = this.smoothY;
      sens = st.touchpadSensitivity;
    }
    const k = 0.022 * (Math.PI / 180) * sens * adsMul * this.lookScale;
    const dx = mx * k;
    const dy = my * k * (st.invertY ? -1 : 1);
    this.yaw -= dx;
    this.pitch = clamp(this.pitch - dy, -1.47, 1.47);
    this.lookDX += dx;
    this.lookDY += dy;
  };

  isDown(a: Action): boolean {
    const arrowsLook = this.settings.arrowLook && (a === 'forward' || a === 'back' || a === 'left' || a === 'right');
    for (const c of this.bindings[a] ?? []) {
      if (arrowsLook && c.startsWith('Arrow')) continue;
      if (this.down.has(c) || this.wheelPulse.has(c)) return true;
    }
    return false;
  }

  /** True while a physical key/button is held (used by tests and arrow look). */
  isCodeDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once per physical press. */
  consume(a: Action): boolean {
    for (const c of this.bindings[a] ?? []) {
      if (this.pressedOnce.has(c)) {
        this.pressedOnce.delete(c);
        return true;
      }
    }
    return false;
  }

  /** Read movement axes (-1..1). */
  axes(): { mx: number; mz: number } {
    let mx = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let mz = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);
    const gp = this.gamepad();
    if (gp) {
      const ax = dz(gp.axes[0] ?? 0);
      const az = dz(gp.axes[1] ?? 0);
      if (Math.abs(ax) > Math.abs(mx)) mx = ax;
      if (Math.abs(az) > Math.abs(mz)) mz = -az;
    }
    return { mx, mz };
  }

  private gamepad(): Gamepad | null {
    if (this.gamepadIndex < 0 || !navigator.getGamepads) return null;
    return navigator.getGamepads()[this.gamepadIndex] ?? null;
  }

  /** Gamepad and arrow-key look integration (call each frame). */
  updateGamepad(dt: number): void {
    if (this.settings.arrowLook && this.locked && this.enabled) {
      const ax = (this.down.has('ArrowRight') ? 1 : 0) - (this.down.has('ArrowLeft') ? 1 : 0);
      const ay = (this.down.has('ArrowDown') ? 1 : 0) - (this.down.has('ArrowUp') ? 1 : 0);
      const adsMul = 1 + (this.settings.adsSensitivity / this.zoom - 1) * this.adsFactor;
      const rate = (this.settings.arrowLookSpeed * Math.PI) / 180 * adsMul * this.lookScale * dt;
      this.yaw -= ax * rate;
      this.pitch = clamp(this.pitch - ay * rate * (this.settings.invertY ? -1 : 1), -1.47, 1.47);
      this.lookDX += ax * rate;
      this.lookDY += ay * rate;
    }
    const gp = this.gamepad();
    if (!gp) return;
    const rx = dz(gp.axes[2] ?? 0);
    const ry = dz(gp.axes[3] ?? 0);
    const rate = 3.2 * this.settings.sensitivity * 0.5 * (1 + (0.55 / this.zoom - 1) * this.adsFactor);
    this.yaw -= Math.sign(rx) * rx * rx * rate * dt;
    this.pitch = clamp(this.pitch - Math.sign(ry) * ry * ry * rate * dt * (this.settings.invertY ? -1 : 1), -1.47, 1.47);
  }

  /** Builds the button bitfield for this tick. */
  buttons(): number {
    let b = 0;
    const gp = this.gamepad();
    const gpb = (i: number) => !!gp?.buttons[i]?.pressed;
    if (this.isDown('jump') || gpb(0)) b |= BTN.JUMP;
    // crouch (hold or toggle)
    const crouchHeld = this.isDown('crouch') || gpb(1);
    if (this.settings.toggleCrouch) {
      if (this.consume('crouch')) this.crouchToggled = !this.crouchToggled;
      if (this.crouchToggled) b |= BTN.CROUCH;
    } else if (crouchHeld) b |= BTN.CROUCH;
    // sprint: tap to latch (auto-run style) unless holdSprint
    const sprintKey = this.isDown('sprint') || gpb(10);
    if (this.settings.holdSprint) {
      if (sprintKey) b |= BTN.SPRINT;
    } else {
      if (this.consume('sprint') || (gp && gpb(10))) this.sprintLatched = true;
      const { mz } = this.axes();
      if (mz < 0.5) this.sprintLatched = false;
      // auto sprint: holding forward for a moment starts a sprint (not while aiming)
      if (this.settings.autoSprint && mz > 0.9 && !this.isDown('ads') && !this.adsToggled) {
        this.autoSprintT += 1;
        if (this.autoSprintT > 9) this.sprintLatched = true;
      } else this.autoSprintT = 0;
      if (this.sprintLatched || sprintKey) b |= BTN.SPRINT;
    }
    if (this.isDown('fire') || (gp?.buttons[7]?.value ?? 0) > 0.4) b |= BTN.FIRE;
    if (this.settings.toggleAds) {
      if (this.consume('ads')) this.adsToggled = !this.adsToggled;
      if (this.adsToggled) b |= BTN.ADS;
    } else if (this.isDown('ads') || (gp?.buttons[6]?.value ?? 0) > 0.4) b |= BTN.ADS;
    if (this.isDown('reload') || gpb(2)) b |= BTN.RELOAD;
    if (this.isDown('melee') || gpb(11)) b |= BTN.MELEE;
    if (this.consume('swap') || gpb(3)) b |= BTN.SWAP;
    if (this.isDown('lethal') || gpb(5)) b |= BTN.LETHAL;
    if (this.isDown('tactical') || gpb(4)) b |= BTN.TACTICAL;
    if (this.isDown('interact')) b |= BTN.INTERACT;
    if (this.isDown('inspect')) b |= BTN.INSPECT;
    if (this.isDown('flashlight') || gpb(12)) b |= BTN.FLASHLIGHT;
    if (b & BTN.FIRE) this.sprintLatched = false;
    this.wheelPulse.clear();
    return b;
  }

  /** Slot request from number keys (-1 = none). */
  slotRequest(): number {
    if (this.consume('primary')) return 0;
    if (this.consume('secondary')) return 1;
    return -1;
  }

  takeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return r;
  }

  clearPresses(): void {
    this.pressedOnce.clear();
  }

  resetToggles(): void {
    this.adsToggled = false;
    this.crouchToggled = false;
    this.sprintLatched = false;
  }
}

function dz(v: number): number {
  const d = 0.15;
  return Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);
}
