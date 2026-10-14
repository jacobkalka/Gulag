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
import { buildCharacter, poseWithWeapon, type Rig } from '@/assets/models/character';

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
  /** Lobby lineup: the player's operator (and party members) holding their primaries. */
  private stage: { group: THREE.Group; ops: Operator[]; on: boolean; blend: number } | null = null;
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
      motionBlur: st.motionBlur && !st.reduceMotion,
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
      motionBlur: s.motionBlur && !s.reduceMotion,
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
    const stageGroup = new THREE.Group();
    stageGroup.position.set(0, 0, 0.4);
    scene.add(stageGroup);
    this.stage = { group: stageGroup, ops: [], on: false, blend: 0 };
  }

  /**
   * Lobby lineup. Index 0 is the local player (center); others stand to the sides. Pass an
   * empty list (or setOperatorsVisible(false)) to show the plain backdrop.
   */
  setOperators(list: { key: string; weapon: string }[]): void {
    const st = this.stage;
    if (!st || !this.assets) return;
    const keep = new Set(list.map((o) => o.key));
    for (const op of [...st.ops]) {
      if (!keep.has(op.key)) {
        st.group.remove(op.rig.root);
        st.ops.splice(st.ops.indexOf(op), 1);
      }
    }
    list.slice(0, 4).forEach((o, i) => {
      let op = st.ops.find((x) => x.key === o.key);
      if (!op) {
        const rig = buildCharacter(this.assets.materials, 0);
        const mount = new THREE.Group();
        rig.chest.add(mount);
        st.group.add(rig.root);
        op = { key: o.key, rig, mount, weapon: null, weaponId: '', phase: Math.random() * 6 };
        st.ops.push(op);
      }
      if (op.weaponId !== o.weapon) {
        if (op.weapon) op.mount.remove(op.weapon.root);
        op.weapon = buildWeapon(this.assets.materials, o.weapon);
        op.weaponId = o.weapon;
      }
      // you in the middle, then left, right, far left (the right side of the screen holds the UI)
      const slot = [0, -1, 1, -2][i] ?? 0;
      op.rig.root.position.set(slot * 0.95, 0, -Math.abs(slot) * 0.35);
      // rigs face -Z: turn around to face the camera, angled slightly toward it (+X)
      op.rig.root.rotation.y = Math.PI + 0.28 - slot * 0.12;
      op.index = i;
    });
  }

  setOperatorsVisible(on: boolean): void {
    if (this.stage) this.stage.on = on;
  }

  /** Screen positions above each operator's head (lobby name tags). */
  operatorTags(): { key: string; x: number; y: number }[] {
    const st = this.stage;
    const cam = this.menuCam;
    if (!st || !cam || st.blend < 0.6 || this.inMatch) return [];
    const out: { key: string; x: number; y: number }[] = [];
    const v = new THREE.Vector3();
    for (const op of st.ops) {
      op.rig.head.getWorldPosition(v);
      v.y += 0.32;
      v.project(cam);
      if (v.z > 1) continue;
      out.push({ key: op.key, x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight });
    }
    return out;
  }

  private updateStage(dt: number, t: number): number {
    const st = this.stage;
    if (!st || !this.menuCam) return 0;
    const on = st.on && st.ops.length > 0 && !this.showcase?.id;
    st.blend = Math.max(0, Math.min(1, st.blend + (on ? dt : -dt) * 2));
    st.group.visible = st.blend > 0.01;
    if (!st.group.visible) return 0;
    for (const op of st.ops) {
      const r = op.rig;
      const b = Math.sin(t * 1.7 + op.phase);
      // relaxed low-ready stance with a little breathing
      r.spine.rotation.x = 0.04 + b * 0.012;
      r.chest.rotation.set(0.02 + b * 0.008, 0.1, 0);
      r.neck.rotation.set(-0.06, -0.08 + Math.sin(t * 0.4 + op.phase) * 0.12, 0);
      r.hipL.rotation.set(-0.08, 0, 0.06);
      r.kneeL.rotation.x = 0.12;
      r.hipR.rotation.set(0.1, 0, -0.08);
      r.kneeR.rotation.x = 0.05;
      // low ready: muzzle down and across the body so the silhouette reads from the front
      if (op.weapon) poseWithWeapon(r, op.weapon, -0.5, op.mount, 0.75);
    }
    const k = st.blend * st.blend * (3 - 2 * st.blend);
    // frame the lineup on the left half of the screen (UI lives on the right)
    const camPos = new THREE.Vector3(1.3 + Math.sin(t * 0.07) * 0.08, 1.5, 3.3);
    this.menuCam.position.lerp(camPos, Math.min(1, k + 0.02));
    const look = new THREE.Vector3(1.0, 1.15, 0.2);
    const cur = new THREE.Vector3(0, 1.4, 0).lerp(look, k);
    this.menuCam.lookAt(cur);
    return k;
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

  private updateShowcase(dt: number, stageK = 0): boolean {
    const sc = this.showcase;
    if (!sc || !this.menuCam) return false;
    const on = !!sc.id;
    sc.blend = Math.max(0, Math.min(1, sc.blend + (on ? dt : -dt) * 2.5));
    const k = sc.blend * sc.blend * (3 - 2 * sc.blend);
    // the same rig lights the lobby lineup (softer) and the loadout turntable
    sc.key.intensity = 16 * k + 9 * stageK;
    sc.rim.intensity = 6 * k + 5 * stageK;
    sc.fill.intensity = 1.4 * k + 1.0 * stageK;
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
        const stageK = this.updateStage(dt, this.menuT);
        this.updateShowcase(dt, stageK);
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

interface Operator {
  key: string;
  rig: Rig;
  mount: THREE.Group;
  weapon: WeaponModel | null;
  weaponId: string;
  phase: number;
  index?: number;
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
