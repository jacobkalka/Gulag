import * as THREE from 'three';
import { envProbePos } from '@/game/world/builder';
import { Renderer, DEFAULT_RENDER_OPTIONS } from '@/engine/Renderer';
import { QUALITY_PRESETS } from '@/engine/quality';
import { Input } from '@/engine/Input';
import { audio } from '@/engine/audio/AudioEngine';
import { Assets } from '@/assets/Assets';
import { activeBindings, inputSettingsOf, settings } from './settings';
import { deploying, saveInputModePref, selectedMap } from './state';
import { gradeOptions } from '@/game/view/lighting/grading';
import { currentSpread } from '@/game/sim/weaponLogic';
import { getWeapon } from '@/data/weapons';
import { buildMap, MAP_IDS } from '@/game/world/maps';
import { MAP_INFO, resolveMapChoice, type MapId } from '@/data/maps';
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
import { SoldierView } from '@/game/view/soldier/SoldierView';
import type { SoldierSkin } from '@/game/view/soldier/soldierAssets';
import type { RenderPlayer } from '@/game/view/renderPlayer';
import { PerfOverlay } from '@/ui/PerfOverlay';

// Owns the renderer, procedural assets, input and the frame loop. Screens (Preact) call
// into this to start/leave matches; it reports back through callbacks.

export type Screen = 'boot' | 'menu' | 'match' | 'results';


/** Menu stage position per backdrop map: the lineup faces +z toward the camera from here. */
const MENU_ANCHORS: Record<string, [number, number, number]> = {
  // north floor of the collapse, the pit and the moonlight behind the lineup
  sublevel9: [0, 0, 6.2],
  // the helipad, the wrecked helicopter and the command post behind the lineup
  monsoon: [0, 0.15, -9.5],
};

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

  /** Every map id (audits and tests ask for this). */
  mapIds(): string[] {
    return [...MAP_IDS];
  }

  private builtMaps = new Map<string, MapDef>();
  /** A map's data, built once per page (builders are deterministic, so host and clients agree). */
  mapFor(id: MapId): MapDef {
    if (this.map?.id === id) return this.map;
    let m = this.builtMaps.get(id);
    if (!m) this.builtMaps.set(id, (m = buildMap(id)));
    return m;
  }

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
      ...gradeOptions('sublevel9', st, quality.level),
    });
    this.input = new Input(canvas, activeBindings(st), inputSettingsOf(st));
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
    // ?perf: frame time, draw calls, triangles, shadow lights, memory
    if (new URLSearchParams(location.search).has('perf')) this.perf = new PerfOverlay();
    this.rooms = new RoomController(this);
  }

  async load(onProgress: (f: number, label: string) => void): Promise<void> {
    onProgress(0.02, 'Initializing renderer');
    await tick();
    this.assets = await Assets.create(this.renderer.gl, this.renderer.options.quality, (f, l) => onProgress(0.05 + f * 0.55, l));
    // ?map=<id> picks the map (until the map vote lands)
    const want = new URLSearchParams(location.search).get('map') ?? 'sublevel9';
    const mapId = MAP_IDS.includes(want) ? want : 'sublevel9';
    onProgress(0.62, 'Building the map');
    await tick();
    this.map = buildMap(mapId);
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
      ...gradeOptions(this.match ? this.match.mapId : (this.map?.id ?? 'sublevel9'), s, QUALITY_PRESETS[s.quality].level),
    });
    if (this.match) this.match.bindRenderer();
    else if (this.menuScene && this.menuCam) this.renderer.setScenes(this.menuScene, this.menuCam);
  }

  applyInputSettings(): void {
    const s = settings.value;
    this.input.bindings = structuredClone(activeBindings(s));
    this.input.settings = inputSettingsOf(s);
    const touchpad = s.inputMode === 'touchpad';
    saveInputModePref(s.inputMode);
    this.session?.setTouchpad(touchpad);
    this.rooms.syncInputMode();
    this.match?.applySettings();
  }

  private buildMenuScene(): void {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070a);
    scene.fog = new THREE.FogExp2(this.map.fog?.color ?? 0x0b0f14, this.map.fog?.density ?? 0.03);
    const q = this.renderer.options.quality;
    this.renderer.options = { ...this.renderer.options, ...gradeOptions(this.map.id, settings.value, q.level) };
    this.menuMap = new MapView(this.map, this.assets.materials, { ...q, fixtureLights: Math.min(q.fixtureLights, 8) }, {});
    scene.add(this.menuMap.root);
    const cam = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
    this.menuMap.lights.settle(new THREE.Vector3(...envProbePos(this.map)), 0);
    const env = bakeReflectionProbe(this.renderer.gl, scene, new THREE.Vector3(...envProbePos(this.map)), q.reflectionProbeSize);
    this.assets.materials.setEnvMap(env);
    this.menuMap.setEnvMap(env);
    this.menuScene = scene;
    this.menuCam = cam;
    this.renderer.setScenes(scene, cam);
    this.menuMap.atmosphere.setPixelScale(window.innerHeight);
    // weapon showcase rig above the drain
    // everything on the menu stage is placed relative to the map's menu anchor
    const A = this.menuAnchor;
    const group = new THREE.Group();
    group.position.copy(A).add(new THREE.Vector3(0, 1.32, 0));
    scene.add(group);
    const key = new THREE.SpotLight(0xfff6ec, 0, 6, 0.6, 0.5, 1.5);
    key.position.copy(A).add(new THREE.Vector3(-1.2, 2.6, 1.4));
    key.target = group;
    const rim = new THREE.PointLight(0x7fb6ff, 0, 5, 2);
    rim.position.copy(A).add(new THREE.Vector3(1.1, 1.7, -0.9));
    const fill = new THREE.PointLight(0xdfe8ff, 0, 4, 2);
    fill.position.copy(A).add(new THREE.Vector3(0.6, 0.9, 1.2));
    scene.add(key, rim, fill);
    this.showcase = { group, key, rim, fill, model: null, id: null, t: 0, blend: 0 };
    const stageGroup = new THREE.Group();
    stageGroup.position.copy(A).add(new THREE.Vector3(0, 0, 0.4));
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
        op.view.dispose();
        st.ops.splice(st.ops.indexOf(op), 1);
      }
    }
    list.slice(0, 4).forEach((o, i) => {
      let op = st.ops.find((x) => x.key === o.key);
      if (!op) {
        // you in black-and-red, the party alternating woodland camo and black-and-red
        const skin: SoldierSkin = i % 2 === 0 ? 'red' : 'camo';
        const view = new SoldierView(this.assets.materials, this.assets.soldiers[skin], 0);
        st.group.add(view.root);
        op = { key: o.key, view, weaponId: '', phase: Math.random() * 6, x: 0, z: 0, yaw: 0 };
        st.ops.push(op);
      }
      if (op.weaponId !== o.weapon) {
        op.view.setWeapon(o.weapon);
        op.weaponId = o.weapon;
      }
      // you in the middle, then left, right, far left (the right side of the screen holds the UI)
      const slot = [0, -1, 1, -2][i] ?? 0;
      op.x = slot * 0.95;
      op.z = -Math.abs(slot) * 0.35;
      // soldiers face -Z: turn around to face the camera, angled slightly toward it (+X)
      op.yaw = Math.PI + 0.28 - slot * 0.12;
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
      op.view.rig.j('head').bone.getWorldPosition(v);
      v.y += 0.3;
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
      // relaxed low ready: muzzle down, glancing around now and then
      const rp: RenderPlayer = {
        id: op.index ?? 0, team: 0, name: op.key, alive: true, x: op.x, y: 0, z: op.z, vx: 0, vz: 0,
        yaw: op.yaw + Math.sin(t * 0.4 + op.phase) * 0.12, pitch: -0.5, crouch: 0, slide: false, grounded: true,
        ads: 0, sprint: false, weapon: op.weaponId || 'halberd', reloading: false, hp: 100, deathYaw: 0,
      };
      op.view.update(rp, dt);
    }
    const k = st.blend * st.blend * (3 - 2 * st.blend);
    // frame the lineup on the left half of the screen (UI lives on the right)
    const A = this.menuAnchor;
    const camPos = new THREE.Vector3(1.3 + Math.sin(t * 0.07) * 0.08, 1.5, 3.3).add(A);
    this.menuCam.position.lerp(camPos, Math.min(1, k + 0.02));
    const look = new THREE.Vector3(1.0, 1.15, 0.2).add(A);
    const cur = new THREE.Vector3(0, 1.4, 0).add(A).lerp(look, k);
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
    // aim right of the model so it sits left of center, clear of the item list
    const target = new THREE.Vector3(0.22, 1.2, 0).add(this.menuAnchor);
    const camPos = new THREE.Vector3(0.27, 1.4, dist).add(this.menuAnchor);
    if (k < 1) {
      // blend from the lobby dolly
      this.menuCam.position.lerp(camPos, Math.min(1, k + 0.02));
    } else this.menuCam.position.copy(camPos);
    this.menuCam.lookAt(target);
    return true;
  }

  /** Lobby/menu backdrop: a slow dolly along the edge of the collapse. */
  setMenuCamera(t: number): void {
    if (!this.menuCam) return;
    const A = this.menuAnchor;
    const a = t * 0.04;
    this.menuCam.position.set(A.x + Math.sin(a) * 5.5, A.y + 1.5 + Math.sin(t * 0.13) * 0.15, A.z + 1.6 + Math.cos(a) * 2.2);
    this.menuCam.lookAt(A.x, A.y + 0.4, A.z - 6.6);
  }

  /** Where the menu stage stands in the backdrop map (open floor with a view). */
  private get menuAnchor(): THREE.Vector3 {
    const a = MENU_ANCHORS[this.map.id] ?? [0, 0, 0];
    return new THREE.Vector3(a[0], a[1], a[2]);
  }

  startBotMatch(playlist: PlaylistId, difficulty: BotDifficulty, loadout: Loadout, name: string): void {
    const map = this.mapFor(resolveMapChoice(selectedMap.value, (Math.random() * 0xffffffff) >>> 0));
    const session = new HostSession({ map, playlist, local: { name, loadout, touchpad: settings.value.inputMode === 'touchpad' }, fillBots: true, difficulty });
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
    // Building the map's view takes a moment (seconds on slow machines) and blocks the page:
    // put the deploy screen up first, then build once it has painted.
    const token = ++this.buildToken;
    deploying.value = MAP_INFO[session.map.id as MapId]?.name ?? session.map.name;
    setTimeout(() => {
      if (token !== this.buildToken) return;
      try {
        this.buildMatchView(session, meta);
      } finally {
        if (token === this.buildToken) deploying.value = null;
      }
    }, 50);
  }

  private buildToken = 0;

  private buildMatchView(session: MatchSession, meta: MatchMeta): void {
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
    // a match still waiting to be built is dropped
    this.buildToken++;
    deploying.value = null;
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
      const interval = now - this.last;
      const dt = Math.min(0.1, interval / 1000);
      this.last = now;
      this.rooms.update();
      if (this.match) {
        if (!this.frozen) this.match.frame(dt);
      }
      else if (this.menuScene && this.menuCam && this.menuMap) {
        this.menuT += dt;
        this.setMenuCamera(this.menuT);
        const stageK = this.updateStage(dt, this.menuT);
        this.updateShowcase(dt, stageK);
        this.menuMap.update(this.menuCam, this.menuT, dt);
        this.renderer.render(dt);
      }
      this.perf?.frame(interval, performance.now() - now, this.renderer);
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

  /** Test hook: stops advancing the match from the render loop (frames are driven by tests). */
  frozen = false;
  /** `?perf` overlay (null unless requested). */
  private perf: PerfOverlay | null = null;

  /** Test hook: exposes internals for automated tests. */
  debug() {
    return { session: this.session, match: this.match, input: this.input, rooms: this.rooms };
  }

  /** Test hook: standing hip-fire spread (deg) of a player, with or without touchpad tuning. */
  debugHipSpread(id: number, touchpad: boolean): number {
    const p = this.session?.players.find((q) => q.id === id);
    if (!p) return NaN;
    const probe = { ...p, vx: 0, vz: 0, bloom: 0, ads: 0, grounded: true, slideT: 0, crouch: 0, touchpad };
    return currentSpread(probe, getWeapon(p.weapons[p.slot].id));
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
  view: SoldierView;
  weaponId: string;
  phase: number;
  x: number;
  z: number;
  yaw: number;
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
