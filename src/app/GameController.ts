import * as THREE from 'three';
import { Renderer, DEFAULT_RENDER_OPTIONS } from '@/engine/Renderer';
import { QUALITY_PRESETS } from '@/engine/quality';
import { Input } from '@/engine/Input';
import { audio } from '@/engine/audio/AudioEngine';
import { Assets } from '@/assets/Assets';
import { settings } from './settings';
import { buildSublevel9 } from '@/game/world/sublevel9';
import type { MapDef } from '@/game/world/mapTypes';
import { HostSession } from '@/game/session/HostSession';
import type { MatchSession } from '@/game/session/Session';
import { MatchView, type MatchSummary } from '@/game/view/MatchView';
import { MapView } from '@/game/view/MapView';
import { bakeReflectionProbe } from '@/game/view/ReflectionProbe';
import type { PlaylistId } from '@/data/playlists';
import type { Loadout } from '@/data/progression';
import type { BotDifficulty } from '@/game/bots/BotBrain';
import { RoomController } from './rooms';
import { buildWeapon, type WeaponModel } from '@/assets/models/weapons';

// Owns the renderer, procedural assets, input and the frame loop. Screens (Preact) call
// into this to start/leave matches; it reports back through callbacks.

export type Screen = 'boot' | 'menu' | 'match' | 'results';

export class GameController {
  readonly renderer: Renderer;
  readonly input: Input;
  assets!: Assets;
  map!: MapDef;
  private match: MatchView | null = null;
  private session: MatchSession | null = null;
  private menuScene: THREE.Scene | null = null;
  private menuCam: THREE.PerspectiveCamera | null = null;
  private menuMap: MapView | null = null;
  private last = performance.now();
  private running = false;
  private menuT = 0;
  onMatchEnd: ((s: MatchSummary) => void) | null = null;
  onPauseChange: ((paused: boolean) => void) | null = null;
  paused = false;
  readonly rooms: RoomController;
  private bgWorker: Worker | null = null;
  /** Backend hooks: match records for XP validation (see src/backend/matches.ts). */
  readonly matchHooks: {
    begin: (session: MatchSession, meta: MatchMeta) => void;
    end: (session: MatchSession, summary: MatchSummary, meta: MatchMeta) => void;
  }[] = [];
  private matchMeta: MatchMeta = {};
  /** Loadout screen turntable (lights always exist so toggling never recompiles shaders). */
  private showcase: { group: THREE.Group; key: THREE.SpotLight; rim: THREE.PointLight; fill: THREE.PointLight; model: WeaponModel | null; id: string | null; t: number; blend: number } | null = null;

  constructor(readonly canvas: HTMLCanvasElement, readonly uiRoot: HTMLElement) {
    const st = settings.value;
    // ?quality=low|medium|high|ultra overrides the saved preset (weak hardware, automated tests)
    const qp = new URLSearchParams(location.search).get('quality') as keyof typeof QUALITY_PRESETS | null;
    const quality = qp && QUALITY_PRESETS[qp] ? QUALITY_PRESETS[qp] : QUALITY_PRESETS[st.quality];
    this.renderer = new Renderer(canvas, {
      ...DEFAULT_RENDER_OPTIONS,
      quality,
      resolutionScale: st.resolutionScale,
      motionBlur: st.motionBlur,
      chromaticAberration: st.chromaticAberration,
      filmGrain: st.filmGrain,
      vignette: st.vignette,
    });
    this.input = new Input(canvas, st.bindings, st);
    this.input.onPauseRequest = () => {
      if (this.match && !this.paused) this.setPaused(true);
    };
    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.match?.onResize();
    });
    canvas.addEventListener('click', () => {
      audio.unlock();
      if (this.match && !this.paused && !this.input.locked) this.input.requestLock();
    });
    this.renderer.onContextRestored = () => location.reload();
    // ?norender=1: simulate and network without drawing (automated multiplayer tests)
    if (new URLSearchParams(location.search).get('norender') === '1') this.renderer.enabled = false;
    this.rooms = new RoomController(this);
  }

  async load(onProgress: (f: number, label: string) => void): Promise<void> {
    onProgress(0.02, 'Initializing renderer');
    await tick();
    this.assets = await Assets.create(this.renderer.gl, this.renderer.options.quality, (f, l) => onProgress(0.05 + f * 0.55, l));
    onProgress(0.62, 'Building Sublevel 9');
    await tick();
    this.map = buildSublevel9();
    this.buildMenuScene();
    onProgress(0.75, 'Synthesizing audio');
    await tick();
    try {
      await audio.generate((f) => onProgress(0.75 + f * 0.24, 'Synthesizing audio'));
    } catch (e) {
      console.warn('audio generation failed', e);
    }
    onProgress(1, 'Ready');
    this.applyAudioSettings();
    this.startLoop();
  }

  applyAudioSettings(): void {
    const s = settings.value;
    audio.setVolumes({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume, ui: s.uiVolume });
  }

  /** Re-applies graphics settings (rebuilds passes; a quality change needs a reload for textures). */
  applyGraphicsSettings(): void {
    const s = settings.value;
    this.renderer.setOptions({
      quality: QUALITY_PRESETS[s.quality],
      resolutionScale: s.resolutionScale,
      motionBlur: s.motionBlur,
      chromaticAberration: s.chromaticAberration,
      filmGrain: s.filmGrain,
      vignette: s.vignette,
    });
    if (this.match) this.match.bindRenderer();
    else if (this.menuScene && this.menuCam) this.renderer.setScenes(this.menuScene, this.menuCam);
  }

  applyInputSettings(): void {
    const s = settings.value;
    this.input.bindings = structuredClone(s.bindings);
    this.input.settings = { ...this.input.settings, sensitivity: s.sensitivity, adsSensitivity: s.adsSensitivity, invertY: s.invertY, toggleAds: s.toggleAds, toggleCrouch: s.toggleCrouch, holdSprint: s.holdSprint };
    this.match?.applySettings();
  }

  private buildMenuScene(): void {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070a);
    scene.fog = new THREE.FogExp2(0x0b0f14, 0.03);
    const q = this.renderer.options.quality;
    this.menuMap = new MapView(this.map, this.assets.materials, { ...q, fixtureLights: Math.min(q.fixtureLights, 8) }, {});
    scene.add(this.menuMap.root);
    const cam = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
    this.menuMap.lights.settle(new THREE.Vector3(0, 1.7, 0), 0);
    const env = bakeReflectionProbe(this.renderer.gl, scene, new THREE.Vector3(0, 1.7, 0), q.reflectionProbeSize);
    this.assets.materials.setEnvMap(env);
    scene.environmentIntensity = 0.45;
    this.menuScene = scene;
    this.menuCam = cam;
    this.renderer.setScenes(scene, cam);
    this.menuMap.atmosphere.setPixelScale(window.innerHeight);
    // weapon showcase rig above the drain
    const group = new THREE.Group();
    group.position.set(0, 1.32, 0);
    scene.add(group);
    const key = new THREE.SpotLight(0xfff6ec, 0, 6, 0.6, 0.5, 1.5);
    key.position.set(-1.2, 2.6, 1.4);
    key.target = group;
    const rim = new THREE.PointLight(0x7fb6ff, 0, 5, 2);
    rim.position.set(1.1, 1.7, -0.9);
    const fill = new THREE.PointLight(0xdfe8ff, 0, 4, 2);
    fill.position.set(0.6, 0.9, 1.2);
    scene.add(key, rim, fill);
    this.showcase = { group, key, rim, fill, model: null, id: null, t: 0, blend: 0 };
  }

  /** Shows a weapon on the menu turntable (loadout screen), or null to return to the lobby view. */
  setShowcase(id: string | null): void {
    const sc = this.showcase;
    if (!sc || sc.id === id) return;
    sc.id = id;
    if (sc.model) {
      sc.group.remove(sc.model.root);
      sc.model = null;
    }
    if (!id) return;
    const m = buildWeapon(this.assets.materials, id);
    // center the model on the turntable
    const box = new THREE.Box3().setFromObject(m.root);
    const c = box.getCenter(new THREE.Vector3());
    m.root.position.sub(c);
    const pivot = new THREE.Group();
    pivot.add(m.root);
    sc.group.add(pivot);
    sc.model = { ...m, root: pivot };
    sc.t = 0;
  }

  private updateShowcase(dt: number): boolean {
    const sc = this.showcase;
    if (!sc || !this.menuCam) return false;
    const on = !!sc.id;
    sc.blend = Math.max(0, Math.min(1, sc.blend + (on ? dt : -dt) * 2.5));
    const k = sc.blend * sc.blend * (3 - 2 * sc.blend);
    sc.key.intensity = 16 * k;
    sc.rim.intensity = 6 * k;
    sc.fill.intensity = 1.4 * k;
    if (!sc.model) return k > 0.001;
    sc.t += dt;
    const len = sc.model.length || 0.8;
    sc.model.root.rotation.y = Math.PI / 2 + Math.sin(sc.t * 0.35) * 0.75 + sc.t * 0.05;
    sc.model.root.rotation.z = Math.sin(sc.t * 0.5) * 0.04;
    const dist = 0.75 + len * 1.25;
    // look slightly below the gun so it sits in the upper-middle of the screen above the stats
    const target = new THREE.Vector3(0, 1.2, 0);
    const camPos = new THREE.Vector3(0.05, 1.4, dist);
    if (k < 1) {
      // blend from the lobby dolly
      this.menuCam.position.lerp(camPos, Math.min(1, k + 0.02));
    } else this.menuCam.position.copy(camPos);
    this.menuCam.lookAt(target);
    return true;
  }

  /** Lobby/menu backdrop: slow dolly through the showers. */
  setMenuCamera(t: number): void {
    if (!this.menuCam) return;
    const a = t * 0.04;
    this.menuCam.position.set(Math.sin(a) * 5.5, 1.5 + Math.sin(t * 0.13) * 0.15, Math.cos(a) * 4.0);
    this.menuCam.lookAt(0, 1.4, 0);
  }

  startBotMatch(playlist: PlaylistId, difficulty: BotDifficulty, loadout: Loadout, name: string): void {
    const session = new HostSession({ map: this.map, playlist, local: { name, loadout }, fillBots: true, difficulty });
    session.matchId = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.beginMatch(session, { host: true });
  }

  beginMatch(session: MatchSession, meta: MatchMeta = {}): void {
    this.leaveMatch(false);
    this.session = session;
    this.matchMeta = meta;
    for (const h of this.matchHooks) {
      try {
        h.begin(session, meta);
      } catch (e) {
        console.warn('match hook failed', e);
      }
    }
    const mv = new MatchView({
      renderer: this.renderer,
      assets: this.assets,
      session,
      input: this.input,
      hudParent: this.uiRoot,
      onMatchEnd: (s) => {
        this.input.releaseLock();
        for (const h of this.matchHooks) {
          try {
            h.end(session, s, meta);
          } catch (e) {
            console.warn('match hook failed', e);
          }
        }
        this.onMatchEnd?.(s);
      },
    });
    mv.init();
    this.match = mv;
    this.paused = false;
    this.input.clearPresses();
    this.input.requestLock();
  }

  leaveMatch(restoreMenu = true): void {
    if (this.match) {
      this.match.dispose();
      this.match = null;
    }
    if (this.session) {
      this.session.leave();
      this.session = null;
    }
    this.input.releaseLock();
    this.paused = false;
    if (restoreMenu && this.menuScene && this.menuCam) {
      this.renderer.setScenes(this.menuScene, this.menuCam);
      audio.playMusic('musicMenu');
    }
  }

  get inMatch(): boolean {
    return !!this.match;
  }

  get currentSession(): MatchSession | null {
    return this.session;
  }

  get currentMatchMeta(): MatchMeta {
    return this.matchMeta;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.match?.setPaused(p);
    this.input.enabled = !p;
    if (p) this.input.releaseLock();
    else this.input.requestLock();
    this.onPauseChange?.(p);
  }

  private startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.startBackgroundTicker();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.rooms.update();
      if (this.match) this.match.frame(dt);
      else if (this.menuScene && this.menuCam && this.menuMap) {
        this.menuT += dt;
        this.setMenuCamera(this.menuT);
        this.updateShowcase(dt);
        this.menuMap.update(this.menuCam, this.menuT, dt);
        this.renderer.render(dt);
      }
      (window as unknown as { __frames: number }).__frames = ((window as unknown as { __frames: number }).__frames ?? 0) + 1;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /**
   * Browsers pause requestAnimationFrame in hidden tabs. A host that alt-tabs must keep the
   * match running for everyone, so a worker timer (not throttled like main-thread timers)
   * drives simulation-only ticks whenever frames stop arriving.
   */
  private startBackgroundTicker(): void {
    if (this.bgWorker || typeof Worker === 'undefined') return;
    const src = 'let t;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';
    try {
      this.bgWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.bgWorker.onmessage = () => {
        const now = performance.now();
        if (now - this.last < 120) return; // frames are flowing normally
        const dt = Math.min(0.25, (now - this.last) / 1000);
        this.last = now;
        this.rooms.update();
        this.match?.backgroundTick(dt);
      };
      this.bgWorker.postMessage(20);
    } catch {
      this.bgWorker = null;
    }
  }

  /** Test hook: exposes internals for automated tests. */
  debug() {
    return { session: this.session, match: this.match, input: this.input, rooms: this.rooms };
  }

  /** Test hook: fast-forward the current match (see MatchView.simulate). */
  simulate(seconds: number, buttons = 0, mz = 0, yawDelta = 0): void {
    if (!this.match || !this.session) return;
    let seq = 1e6;
    const s = this.session;
    this.match.simulate(seconds, () => {
      const p = s.players.find((q) => q.id === s.localId);
      this.input.yaw += yawDelta / 20;
      return { seq: ++seq + Math.floor(performance.now()), mx: 0, mz, yaw: this.input.yaw, pitch: this.input.pitch, buttons, slot: p ? p.slot : 0, viewTick: s.viewTick() };
    });
  }
}

/** How the local machine relates to a match (set by whoever starts it). */
export interface MatchMeta {
  /** This browser runs the authoritative simulation. */
  host?: boolean;
  /** Peer ids (Firebase uids online) of the human players, by player id (host only). */
  pids?: Map<number, string>;
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
