import * as THREE from 'three';
import type { Renderer } from '@/engine/Renderer';
import type { Assets } from '@/assets/Assets';
import type { Input } from '@/engine/Input';
import { audio } from '@/engine/audio/AudioEngine';
import { settings, teamColors } from '@/app/settings';
import { getWeapon } from '@/data/weapons';
import type { MatchSession, RenderPose } from '@/game/session/Session';
import { BTN, type GameEvent, type PlayerInput, type PlayerState } from '@/game/sim/types';
import { eyeHeight, MOVE } from '@/game/sim/movement';
import { currentSpread, recoilKick } from '@/game/sim/weaponLogic';
import { SURFACES, OPAQUE } from '@/game/world/collision';
import { MapView } from './MapView';
import { Viewmodel } from './Viewmodel';
import { CharacterView, type RenderPlayer } from './CharacterView';
import { Effects } from './Effects';
import { bakeReflectionProbe } from './ReflectionProbe';
import { Hud, type ScoreRow } from '@/ui/hud/Hud';
import { DEG, clamp, damp, wrapAngle } from '@/shared/math';

export interface MatchSummary {
  winner: -1 | 0 | 1;
  localTeam: 0 | 1;
  score: [number, number];
  players: ScoreRow[];
  local: PlayerState | null;
  rounds: number;
  playlist: string;
}

export interface MatchViewOptions {
  renderer: Renderer;
  assets: Assets;
  session: MatchSession;
  input: Input;
  hudParent: HTMLElement;
  onMatchEnd: (s: MatchSummary) => void;
}

const STEP_SOUND: Record<string, string> = {
  concrete: 'stepConcrete',
  metal: 'stepMetal',
  tile: 'stepTile',
  wood: 'stepConcrete',
  water: 'stepWater',
  fabric: 'stepConcrete',
  glass: 'stepTile',
  dirt: 'stepConcrete',
};

const IMPACT_SOUND: Record<string, string> = {
  concrete: 'impactConcrete',
  tile: 'impactConcrete',
  metal: 'impactMetal',
  wood: 'impactWood',
  water: 'impactWater',
  flesh: 'impactFlesh',
  fabric: 'impactWood',
  glass: 'impactConcrete',
  dirt: 'impactConcrete',
};

export class MatchView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly hud: Hud;
  private mapView: MapView;
  private vm: Viewmodel;
  private chars = new Map<number, CharacterView>();
  private effects: Effects;
  private grenadeMeshes = new Map<number, THREE.Mesh>();
  private env: THREE.Texture | null = null;
  private seq = 0;
  private time = 0;
  private pose: RenderPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 0 };
  // camera feel
  private kickPitch = 0;
  private kickYaw = 0;
  private debtPitch = 0;
  private lastFire = -10;
  private punch = 0;
  private shake = 0;
  private landDip = 0;
  private eyeSmooth = MOVE.eyeStand;
  private camRoll = 0;
  // state
  private spectateId = -1;
  private stepDist = new Map<number, number>();
  private lastWeaponModel = '';
  private lastSlot = -1;
  private ended = false;
  private endTimer = -1;
  private fpsT = 0;
  private fpsN = 0;
  private fps = 60;
  private reloadSounds: { t: number; name: string }[] = [];
  private lastCountdown = -1;
  private puddles: { x: number; z: number; r: number }[] = [];
  private deathYaw = new Map<number, number>();
  private flashSound = 0;
  paused = false;
  private disposed = false;
  private aimLife = -1;

  constructor(private o: MatchViewOptions) {
    const q = o.renderer.options.quality;
    const s = o.session;
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 220);
    this.scene.background = new THREE.Color(0x05070a);
    this.scene.fog = new THREE.FogExp2(0x0b0f14, 0.022);
    this.mapView = new MapView(s.map, o.assets.materials, q, { activeTags: s.rules.mapTags });
    this.scene.add(this.mapView.root);
    this.effects = new Effects({ particleScale: q.particleScale, decalLimit: q.decalLimit });
    this.scene.add(this.effects.group);
    this.vm = new Viewmodel(o.assets.materials);
    this.hud = new Hud(o.hudParent);
    for (const d of s.map.decals) if (d.kind === 'puddle') this.puddles.push({ x: d.pos[0], z: d.pos[2], r: Math.min(d.size[0], d.size[1]) * 0.42 });
    const local = this.localPlayer();
    if (local) {
      this.hud.localTeam = local.team;
      this.vm.setTeamAccent(local.team);
      o.input.yaw = local.yaw;
      o.input.pitch = 0;
    }
  }

  /** Bakes the reflection probe and wires the render passes. Call once after construction. */
  init(): void {
    const r = this.o.renderer;
    this.mapView.lights.settle(new THREE.Vector3(0, 1.7, 0), 0);
    this.env = bakeReflectionProbe(r.gl, this.scene, new THREE.Vector3(0, 1.7, 0), r.options.quality.reflectionProbeSize);
    this.o.assets.materials.setEnvMap(this.env);
    this.scene.environmentIntensity = 0.45;
    r.setScenes(this.scene, this.camera, this.vm.scene, this.vm.camera);
    r.resize();
    this.onResize();
    audio.startAmbience(0.45);
    audio.playMusic('musicMatch');
  }

  /** (Re)binds this match's scenes to the renderer (after graphics settings change). */
  bindRenderer(): void {
    this.o.renderer.setScenes(this.scene, this.camera, this.vm.scene, this.vm.camera);
  }

  onResize(): void {
    const h = this.o.renderer.canvas.clientHeight || window.innerHeight;
    this.effects.setPixelScale(h);
    this.mapView.atmosphere.setPixelScale(h);
  }

  private localPlayer(): PlayerState | undefined {
    return this.o.session.players.find((p) => p.id === this.o.session.localId);
  }

  private sampleInput = (): PlayerInput => {
    const inp = this.o.input;
    const s = this.o.session;
    const ax = this.paused ? { mx: 0, mz: 0 } : inp.axes();
    const buttons = this.paused ? 0 : inp.buttons();
    const slot = this.paused ? -1 : inp.slotRequest();
    const lp = this.localPlayer();
    return {
      seq: ++this.seq,
      mx: ax.mx,
      mz: ax.mz,
      yaw: inp.yaw,
      pitch: inp.pitch,
      buttons,
      slot: slot >= 0 ? slot : lp ? lp.slot : 0,
      viewTick: s.viewTick(),
      life: lp ? lp.life : 0,
    };
  };

  /** On a new life (respawn), adopt the spawn orientation the simulation chose. */
  private syncSpawnAim(local: PlayerState | undefined): void {
    if (!local || local.life === this.aimLife) return;
    this.aimLife = local.life;
    this.o.input.yaw = local.yaw;
    this.o.input.pitch = local.pitch;
    this.kickPitch = this.kickYaw = this.debtPitch = 0;
  }

  frame(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    const s = this.o.session;
    const input = this.o.input;
    input.updateGamepad(dt);
    const events = s.update(dt, this.sampleInput);
    for (const e of events) this.handleEvent(e);
    const local = this.localPlayer();
    this.syncSpawnAim(local);

    // ---- recoil recovery (view returns partway after you stop firing)
    if (local) {
      const w = getWeapon(local.weapons[local.slot].id);
      if (this.time - this.lastFire > 0.14 && this.debtPitch > 0) {
        const back = Math.min(this.debtPitch, this.debtPitch * w.recoil.recover * dt + 0.02 * dt);
        input.pitch -= back * 0.55;
        this.debtPitch -= back;
      }
      input.adsFactor = local.ads;
      input.zoom = w.zoom;
    }
    // smooth kick application (spread over a few frames)
    const kp = this.kickPitch * Math.min(1, dt * 30);
    const ky = this.kickYaw * Math.min(1, dt * 30);
    input.pitch = clamp(input.pitch + kp, -1.47, 1.47);
    input.yaw += ky;
    this.kickPitch -= kp;
    this.kickYaw -= ky;

    this.updateCamera(dt, local);
    this.updateCharacters(dt, local);
    this.updateViewmodel(dt, local);
    this.updateGrenades();
    this.mapView.update(this.camera, this.time, dt);
    this.effects.update(dt);
    this.updateHud(dt, local);
    this.updateAudio(dt);
    this.o.renderer.render(dt);

    // perf counters
    this.fpsT += dt;
    this.fpsN++;
    if (this.fpsT > 0.5) {
      this.fps = this.fpsN / this.fpsT;
      this.fpsT = 0;
      this.fpsN = 0;
    }
    if (this.ended) {
      this.endTimer -= dt;
      if (this.endTimer <= 0 && this.endTimer > -100) {
        this.endTimer = -1000;
        this.o.onMatchEnd(this.summary());
      }
    }
  }

  /** Keeps the session running while the tab is hidden (no rendering, rAF is paused). */
  backgroundTick(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    const events = this.o.session.update(dt, this.sampleInput);
    for (const e of events) this.handleEvent(e);
    if (this.ended) {
      this.endTimer -= dt;
      if (this.endTimer <= 0 && this.endTimer > -100) {
        this.endTimer = -1000;
        this.o.onMatchEnd(this.summary());
      }
    }
  }

  /**
   * Test/debug hook: advances the session by `seconds` of game time using the provided input
   * function (or the live input), processing events but rendering only once at the end.
   */
  simulate(seconds: number, inputFn?: () => PlayerInput): void {
    const steps = Math.ceil(seconds / 0.05);
    for (let i = 0; i < steps; i++) {
      const events = this.o.session.update(0.05, inputFn ?? this.sampleInput);
      for (const e of events) this.handleEvent(e);
      this.effects.update(0.05);
    }
    if (this.ended && this.endTimer > 0) this.endTimer -= seconds;
    this.frame(1 / 60);
  }

  summary(): MatchSummary {
    const s = this.o.session;
    const local = this.localPlayer() ?? null;
    return {
      winner: s.round.matchWinner,
      localTeam: local?.team ?? 0,
      score: [...s.round.score] as [number, number],
      players: this.scoreRows(),
      local,
      rounds: s.round.round,
      playlist: s.playlistId,
    };
  }

  private scoreRows(): ScoreRow[] {
    const s = this.o.session;
    return s.players
      .filter((p) => p.connected || p.stats.kills + p.stats.deaths > 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        kills: p.stats.kills,
        deaths: p.stats.deaths,
        assists: p.stats.assists,
        damage: p.stats.damage,
        alive: p.alive,
        local: p.id === s.localId,
        bot: p.bot,
        ping: p.bot || !s.pingOf ? undefined : s.pingOf(p.id),
      }));
  }

  // ------------------------------------------------------------------ events

  private handleEvent(e: GameEvent): void {
    const s = this.o.session;
    const localId = s.localId;
    const local = this.localPlayer();
    switch (e.type) {
      case 'fire': {
        const w = getWeapon(e.weapon);
        const shooter = s.players.find((p) => p.id === e.shooter);
        if (e.shooter === localId && local) {
          this.vm.fire(w.class === 'sniper' || w.class === 'shotgun' ? 1.6 : w.class === 'pistol' ? 0.8 : 1);
          const k = recoilKick(w, local.recoilIdx, (local.id * 7919 + local.shotCount * 104729) >>> 0, local.ads);
          this.kickPitch += k.pitch;
          this.kickYaw += k.yaw;
          this.debtPitch += k.pitch;
          this.lastFire = this.time;
          this.punch = Math.min(1, this.punch + (w.class === 'sniper' ? 1 : 0.35));
          audio.play(`gun_${w.id}`, { volume: 0.9 });
          if (w.fireMode === 'pump') this.queueSound('pump', 0.32);
          if (w.fireMode === 'bolt') {
            this.queueSound('boltBack', 0.45);
            this.queueSound('boltForward', 0.85);
          }
          const mz = this.vmMuzzleWorld();
          if (mz && !(w.scope && local.ads > 0.9)) this.effects.muzzleFlash(mz.x, mz.y, mz.z, w.class === 'shotgun' ? 0.45 : 0.32, true);
        } else if (shooter) {
          const cv = this.chars.get(e.shooter);
          cv?.fire();
          const mp = this.characterMuzzle(shooter);
          this.effects.muzzleFlash(mp.x, mp.y, mp.z, 0.4, true);
          const d = Math.hypot(shooter.x - this.camera.position.x, shooter.z - this.camera.position.z);
          const occluded = !s.world.lineOfSight(this.camera.position.x, this.camera.position.y, this.camera.position.z, mp.x, mp.y, mp.z);
          audio.play(`gun_${w.id}`, { pos: mp, volume: 1.0, lowpass: occluded ? 900 : d > 25 ? 3500 : undefined });
        }
        break;
      }
      case 'shot': {
        const t = e.trace;
        const isLocal = t.shooter === localId;
        let ox = t.ox;
        let oy = t.oy;
        let oz = t.oz;
        if (isLocal) {
          const mz = this.tracerOriginLocal();
          if (mz) {
            ox = mz.x;
            oy = mz.y;
            oz = mz.z;
          }
        } else {
          const sh = s.players.find((p) => p.id === t.shooter);
          if (sh) {
            const mp = this.characterMuzzle(sh);
            ox = mp.x;
            oy = mp.y;
            oz = mp.z;
          }
        }
        const w = getWeapon(t.weapon);
        if (!e.impactOnly && t.pellet === 0 && (t.shot % w.tracerEvery === 0 || !isLocal)) this.effects.tracer(ox, oy, oz, t.ex, t.ey, t.ez, w.class === 'sniper' ? 0.012 : 0.007);
        if (t.surface !== 'none') {
          this.effects.impact(t.ex, t.ey, t.ez, t.nx, t.ny, t.nz, t.surface, this.camera.position, t.surface !== 'flesh');
          if (t.pellet % 3 === 0) {
            const snd = IMPACT_SOUND[t.surface] ?? 'impactConcrete';
            audio.play(snd, { pos: { x: t.ex, y: t.ey, z: t.ez }, volume: t.surface === 'flesh' ? 0.8 : 0.55 });
            if (t.surface === 'metal' && Math.random() < 0.3) audio.play('ricochet', { pos: { x: t.ex, y: t.ey, z: t.ez }, volume: 0.4 });
          }
        }
        // near-miss whiz for the local player
        if (!isLocal && !e.impactOnly && local && local.alive && t.hitPlayer !== localId) {
          const d = segPointDist(t.ox, t.oy, t.oz, t.ex, t.ey, t.ez, local.x, local.y + 1.5, local.z);
          if (d < 1.2) audio.play('whiz', { volume: 0.5 });
        }
        break;
      }
      case 'damage': {
        if (e.attacker === localId && e.victim !== localId) {
          this.hud.hitmarker(e.killed ? 'kill' : e.hitbox === 'head' ? 'head' : 'body');
          audio.ui(e.hitbox === 'head' ? 'headshot' : 'hitmarker', 0.9);
          const sp = this.project(e.x, e.y, e.z);
          if (sp) this.hud.damageNumber(sp.x + (Math.random() - 0.5) * 20, sp.y - 10, e.amount, e.hitbox === 'head');
        }
        if (e.victim === localId && local) {
          const att = s.players.find((p) => p.id === e.attacker);
          if (att) {
            const ang = Math.atan2(-(att.x - local.x), -(att.z - local.z));
            this.hud.damageIndicator(-wrapAngle(ang - this.o.input.yaw));
          }
          this.shake = Math.min(1, this.shake + e.amount / 60);
          audio.play('hurt', { volume: 0.7 });
        }
        const victim = this.chars.get(e.victim);
        const att = s.players.find((p) => p.id === e.attacker);
        if (victim && att) victim.hit(Math.atan2(-(att.x - e.x), -(att.z - e.z)));
        if (e.killed && att) this.deathYaw.set(e.victim, Math.atan2(-(e.x - att.x), -(e.z - att.z)));
        break;
      }
      case 'kill': {
        const killer = s.players.find((p) => p.id === e.killer);
        const victim = s.players.find((p) => p.id === e.victim);
        if (victim) {
          this.hud.killfeed(killer && killer !== victim ? killer.name : '', victim.name, e.weapon, e.headshot, killer?.team ?? -1, victim.team, e.killer === localId || e.victim === localId);
        }
        if (e.killer === localId && e.victim !== localId) audio.ui('killConfirm', 1);
        if (e.victim === localId) {
          this.spectateId = -1;
          this.vm.scene.visible = false;
        }
        break;
      }
      case 'reload': {
        if (e.player === localId) {
          this.vm.reload(e.duration);
          if (e.kind === 2) this.queueSound('shellIn', e.duration * 0.6);
          else {
            this.queueSound('magOut', e.duration * 0.18);
            this.queueSound('magIn', e.duration * 0.58);
            if (e.kind === 1) {
              this.queueSound('boltBack', e.duration * 0.8);
              this.queueSound('boltForward', e.duration * 0.88);
            }
          }
        } else {
          const p = s.players.find((q) => q.id === e.player);
          if (p) audio.play('magOut', { pos: { x: p.x, y: p.y + 1.2, z: p.z }, volume: 0.4 });
        }
        break;
      }
      case 'swap':
        if (e.player === localId) {
          this.vm.swap();
          audio.play('swap', { volume: 0.6 });
        }
        break;
      case 'melee':
        if (e.player === localId) {
          audio.play(e.hit ? 'meleeHit' : 'melee', { volume: 0.8 });
          this.vm.swap();
        } else {
          const p = s.players.find((q) => q.id === e.player);
          if (p) audio.play(e.hit ? 'meleeHit' : 'melee', { pos: { x: p.x, y: p.y + 1.2, z: p.z }, volume: 0.7 });
        }
        break;
      case 'jump': {
        const p = s.players.find((q) => q.id === e.player);
        if (p) audio.play('jump', p.id === localId ? { volume: 0.4 } : { pos: { x: p.x, y: p.y, z: p.z }, volume: 0.5 });
        break;
      }
      case 'land': {
        const p = s.players.find((q) => q.id === e.player);
        if (p) audio.play('land', p.id === localId ? { volume: 0.5 } : { pos: { x: p.x, y: p.y, z: p.z }, volume: 0.6 });
        if (e.player === localId) this.landDip = Math.min(0.12, e.speed * 0.012);
        break;
      }
      case 'grenade': {
        const p = s.players.find((q) => q.id === e.owner);
        if (p) audio.play('pin', p.id === localId ? { volume: 0.6 } : { pos: { x: e.x, y: e.y, z: e.z }, volume: 0.6 });
        break;
      }
      case 'explode': {
        this.effects.explosion(e.x, e.y, e.z, e.kind);
        audio.play(e.kind === 'frag' ? 'explosion' : 'flashbang', { pos: { x: e.x, y: e.y, z: e.z }, volume: 1.2 });
        const d = Math.hypot(e.x - this.camera.position.x, e.y - this.camera.position.y, e.z - this.camera.position.z);
        this.shake = Math.min(1.5, this.shake + Math.max(0, 1 - d / 14) * (e.kind === 'frag' ? 1.2 : 0.5));
        break;
      }
      case 'roundStart':
        this.hud.showBanner(`ROUND ${e.round}`, s.rules.roundsToWin > 1 ? `FIRST TO ${s.rules.roundsToWin}` : '', 'neutral', 2.0);
        this.effects.clear();
        this.vm.scene.visible = true;
        this.debtPitch = 0;
        this.lastCountdown = -1;
        this.o.input.resetToggles();
        break;
      case 'roundLive':
        this.hud.showBanner('FIGHT', '', 'warn', 1.0);
        audio.ui('countGo', 0.9);
        break;
      case 'overtime':
        this.hud.showBanner('OVERTIME', 'CAPTURE THE DRAIN', 'warn', 2.6);
        audio.ui('overtime', 0.9);
        break;
      case 'capture':
        audio.ui('capture', 1);
        break;
      case 'roundEnd': {
        const myTeam = local?.team ?? 0;
        const won = e.winner === myTeam;
        const reason = e.reason === 'capture' ? 'OBJECTIVE CAPTURED' : e.reason === 'draw' ? 'NO SURVIVORS' : 'ELIMINATION';
        if (e.winner < 0) this.hud.showBanner('DRAW', reason, 'neutral', 3.5);
        else this.hud.showBanner(won ? 'ROUND WON' : 'ROUND LOST', reason, won ? 'win' : 'lose', 3.5);
        audio.ui(won ? 'roundWin' : 'roundLose', 0.9);
        break;
      }
      case 'matchEnd': {
        const myTeam = local?.team ?? 0;
        const won = e.winner === myTeam;
        this.hud.showBanner(won ? 'VICTORY' : 'DEFEAT', `${s.round.score[myTeam]} — ${s.round.score[myTeam === 0 ? 1 : 0]}`, won ? 'win' : 'lose', 4.5);
        this.ended = true;
        this.endTimer = 4.0;
        break;
      }
      default:
        break;
    }
  }

  private queueSound(name: string, delay: number): void {
    this.reloadSounds.push({ t: this.time + delay, name });
  }

  // ------------------------------------------------------------------ camera

  private updateCamera(dt: number, local: PlayerState | undefined): void {
    const s = this.o.session;
    const input = this.o.input;
    const st = settings.value;
    const aspect = this.camera.aspect;
    const baseV = 2 * Math.atan(Math.tan((st.fov * DEG) / 2) / Math.max(1, aspect)) / DEG;
    this.punch = damp(this.punch, 0, 12, dt);
    this.shake = damp(this.shake, 0, 5, dt);
    this.landDip = damp(this.landDip, 0, 8, dt);
    if (local && local.alive) {
      s.renderPose(local.id, this.pose);
      const eye = local.slideT > 0 ? MOVE.eyeSlide : eyeHeight({ ...local, crouch: this.pose.crouch } as PlayerState);
      this.eyeSmooth = damp(this.eyeSmooth, eye, 18, dt);
      const shakeX = (Math.random() - 0.5) * this.shake * 0.04;
      const shakeY = (Math.random() - 0.5) * this.shake * 0.04;
      this.camera.position.set(this.pose.x, this.pose.y + this.eyeSmooth - this.landDip, this.pose.z);
      // slide / lean roll
      const targetRoll = local.slideT > 0 ? 0.08 : 0;
      this.camRoll = damp(this.camRoll, targetRoll, 10, dt);
      const pitch = input.pitch + this.punch * 0.012 + shakeY;
      this.camera.rotation.set(pitch, input.yaw + shakeX, this.camRoll, 'YXZ');
      const w = getWeapon(local.weapons[local.slot].id);
      const zoom = 1 + (w.zoom - 1) * local.ads;
      const v = (2 * Math.atan(Math.tan((baseV * DEG) / 2) / zoom)) / DEG;
      if (Math.abs(this.camera.fov - v) > 0.01) {
        this.camera.fov = v;
        this.camera.updateProjectionMatrix();
      }
      this.spectateId = -1;
      // screen feedback
      const fx = this.o.renderer.screenFx;
      fx.set('uFlash', Math.pow(clamp(local.flash, 0, 1), 0.7));
      fx.set('uDesat', local.hp < 40 ? (40 - local.hp) / 55 : 0);
      fx.set('uPulse', local.hp < 30 ? 1 : 0);
      fx.set('uDamage', clamp(this.shake * 0.6, 0, 0.8));
      fx.set('uShield', s.round.phase === 'live' && local.spawnProt > 0 ? 0.6 : 0);
      fx.set('uTime', this.time);
      if (local.flash > 0.5 && this.flashSound <= 0) {
        audio.play('tinnitus', { volume: 0.5 * local.flash });
        this.flashSound = 3;
      }
      this.flashSound -= dt;
    } else {
      this.spectate(dt, local);
      const fx = this.o.renderer.screenFx;
      fx.set('uFlash', 0);
      fx.set('uDesat', 0.35);
      fx.set('uPulse', 0);
      fx.set('uDamage', 0);
      fx.set('uShield', 0);
      if (Math.abs(this.camera.fov - baseV) > 0.01) {
        this.camera.fov = baseV;
        this.camera.updateProjectionMatrix();
      }
    }
    this.camera.updateMatrixWorld();
  }

  private spectate(dt: number, local: PlayerState | undefined): void {
    const s = this.o.session;
    const input = this.o.input;
    const team = local?.team ?? 0;
    const alive = s.players.filter((p) => p.alive && p.connected);
    const mates = alive.filter((p) => p.team === team);
    const pool = mates.length ? mates : alive;
    if (!pool.length) {
      // nobody alive (round over): slow overview orbit of the drain
      const t = this.time * 0.15;
      this.camera.position.set(Math.sin(t) * 7, 3.2, Math.cos(t) * 7);
      this.camera.lookAt(0, 0.8, 0);
      this.hud.setSpectate(null);
      return;
    }
    if (!pool.find((p) => p.id === this.spectateId)) {
      // first look at your killer briefly if visible, then teammates
      const killer = local ? s.players.find((p) => p.id === local.killedBy && p.alive) : undefined;
      this.spectateId = local && local.deadT < 2.5 && killer ? killer.id : pool[0].id;
    }
    if (input.consume('fire')) {
      const i = pool.findIndex((p) => p.id === this.spectateId);
      this.spectateId = pool[(i + 1) % pool.length].id;
    }
    if (input.consume('ads')) {
      const i = pool.findIndex((p) => p.id === this.spectateId);
      this.spectateId = pool[(i - 1 + pool.length) % pool.length].id;
    }
    const target = s.players.find((p) => p.id === this.spectateId)!;
    s.renderPose(target.id, this.pose);
    const yaw = this.pose.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const head = new THREE.Vector3(this.pose.x, this.pose.y + 1.55, this.pose.z);
    let back = 2.3;
    const ox = -fx * back + rx * 0.55;
    const oz = -fz * back + rz * 0.55;
    const hit = s.world.raycast(head.x, head.y, head.z, ox, 0.35, oz, 1, OPAQUE);
    if (hit) back = Math.max(0.3, back * hit.t - 0.25);
    const k = back / 2.3;
    const want = new THREE.Vector3(head.x + ox * k, head.y + 0.35 * k, head.z + oz * k);
    this.camera.position.lerp(want, 1 - Math.exp(-dt * 12));
    const look = head.clone().add(new THREE.Vector3(fx * 6, Math.sin(this.pose.pitch) * 6, fz * 6));
    this.camera.lookAt(look);
    this.hud.setSpectate(target.name + (target.team !== team ? ' (ENEMY)' : ''));
  }

  // ------------------------------------------------------------------ characters & viewmodel

  private updateCharacters(dt: number, local: PlayerState | undefined): void {
    const s = this.o.session;
    for (const p of s.players) {
      let cv = this.chars.get(p.id);
      if (!p.connected) {
        if (cv) cv.root.visible = false;
        continue;
      }
      if (!cv) {
        cv = new CharacterView(this.o.assets.materials, p.team);
        this.chars.set(p.id, cv);
        this.scene.add(cv.root);
      }
      const isLocalFP = local && p.id === local.id && p.alive;
      cv.root.visible = !isLocalFP && (p.alive || p.deadT < 12);
      if (!cv.root.visible) continue;
      s.renderPose(p.id, this.pose);
      const rp: RenderPlayer = {
        id: p.id,
        team: p.team,
        name: p.name,
        alive: p.alive,
        x: this.pose.x,
        y: this.pose.y,
        z: this.pose.z,
        vx: p.vx,
        vz: p.vz,
        yaw: this.pose.yaw,
        pitch: this.pose.pitch,
        crouch: this.pose.crouch,
        slide: p.slideT > 0,
        grounded: p.grounded,
        ads: p.ads,
        sprint: p.sprinting,
        weapon: p.weapons[p.slot].id,
        reloading: p.reloadT > 0,
        hp: p.hp,
        deathYaw: this.deathYaw.get(p.id) ?? p.yaw + Math.PI,
      };
      cv.update(rp, dt);
      this.footsteps(p, dt, p.id === s.localId);
    }
  }

  private footsteps(p: PlayerState, dt: number, isLocal: boolean): void {
    if (!p.alive || !p.grounded || p.slideT > 0) return;
    const speed = Math.hypot(p.vx, p.vz);
    if (speed < 1.2) return;
    const d = (this.stepDist.get(p.id) ?? 0) + speed * dt;
    const stride = p.sprinting ? 2.3 : p.crouch > 0.5 ? 1.4 : 1.8;
    if (d < stride) {
      this.stepDist.set(p.id, d);
      return;
    }
    this.stepDist.set(p.id, 0);
    const sup = this.o.session.world.supportHeight(p.x, p.z, 0.2, p.y + 0.1, 0.2, 0.3);
    let surf = SURFACES[sup.surface] ?? 'concrete';
    for (const pd of this.puddles) if (Math.hypot(p.x - pd.x, p.z - pd.z) < pd.r && p.y < 0.2) surf = 'water';
    const name = STEP_SOUND[surf] ?? 'stepConcrete';
    const vol = (p.sprinting ? 0.85 : p.crouch > 0.5 ? 0.25 : 0.55) * (isLocal ? 0.45 : 1);
    if (isLocal) audio.play(name, { volume: vol });
    else audio.play(name, { pos: { x: p.x, y: p.y, z: p.z }, volume: vol * 1.4 });
  }

  private updateViewmodel(dt: number, local: PlayerState | undefined): void {
    if (!local || !local.alive) {
      this.vm.scene.visible = false;
      return;
    }
    this.vm.scene.visible = true;
    const w = getWeapon(local.weapons[local.slot].id);
    if (w.model !== this.lastWeaponModel) {
      this.vm.setWeapon(w.model);
      this.lastWeaponModel = w.model;
    }
    if (local.slot !== this.lastSlot) this.lastSlot = local.slot;
    // hide the gun when looking through a full-zoom scope
    const scoped = !!w.scope && local.ads > 0.92;
    this.vm.scene.visible = !scoped;
    this.hud.setScope(scoped);
    this.vm.syncFromWorld(this.camera, this.mapView.lights.nearestActive(this.camera.position, 4), this.env);
    const look = this.o.input.takeLook();
    this.vm.update(dt, {
      ads: local.ads,
      sprint: local.sprinting ? 1 : 0,
      moveSpeed: Math.hypot(local.vx, local.vz),
      grounded: local.grounded,
      crouch: local.crouch,
      lookDX: look.dx,
      lookDY: look.dy,
    });
  }

  private updateGrenades(): void {
    const s = this.o.session;
    const seen = new Set<number>();
    for (const g of s.grenades) {
      seen.add(g.id);
      let m = this.grenadeMeshes.get(g.id);
      if (!m) {
        m = new THREE.Mesh(
          g.kind === 'frag' ? new THREE.SphereGeometry(0.05, 10, 8) : new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10),
          this.o.assets.materials.get(g.kind === 'frag' ? 'paintGreen' : 'paintGrey'),
        );
        m.castShadow = true;
        this.scene.add(m);
        this.grenadeMeshes.set(g.id, m);
      }
      m.position.set(g.x, g.y, g.z);
      m.rotation.x += 0.2;
      m.rotation.z += 0.13;
    }
    for (const [id, m] of this.grenadeMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(m);
        m.geometry.dispose();
        this.grenadeMeshes.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ HUD + audio

  private updateHud(dt: number, local: PlayerState | undefined): void {
    const s = this.o.session;
    const hud = this.hud;
    const input = this.o.input;
    hud.update(dt);
    const alive = [0, 0] as [number, number];
    for (const p of s.players) if (p.alive) alive[p.team]++;
    hud.setRound(s.round, s.rules, alive, s.rules.teamSize);
    if (local) {
      hud.localTeam = local.team;
      hud.setHealth(local.alive ? local.hp : 0);
      hud.setAmmo(local);
      const w = getWeapon(local.weapons[local.slot].id);
      // crosshair gap in pixels from the cone half-angle
      const spread = currentSpread(local, w) + (w.pellets ? w.pelletSpread ?? 0 : 0);
      const h = this.o.renderer.canvas.clientHeight || window.innerHeight;
      const px = (Math.tan(spread * DEG) / Math.tan((this.camera.fov * DEG) / 2)) * (h / 2);
      const showCross = local.alive && local.ads < 0.6 && !local.sprinting && local.meleeT <= 0;
      hud.setCrosshair(px, showCross);
      hud.setAliveHud(local.alive);
      const mates = s.players.filter((p) => p.team === local.team && p.connected);
      hud.setRoster(
        s.rules.teamSize > 1 ? mates.map((p) => ({ id: p.id, name: p.name, hp: p.alive ? p.hp : 0, alive: p.alive, local: p.id === local.id })) : [],
      );
      if (local.alive) hud.setSpectate(null);
      // countdown beeps
      if (s.round.phase === 'countdown') {
        const c = Math.ceil(s.round.timer);
        if (c !== this.lastCountdown && c <= 3 && c > 0) {
          this.lastCountdown = c;
          hud.showBanner(String(c), '', 'count', 0.9);
          audio.ui('countBeep', 0.8);
        }
      }
      // markers: teammates' names and the overtime objective
      const markers: { x: number; y: number; text: string; kind: 'friend' | 'objective' | 'enemy' }[] = [];
      for (const p of mates) {
        if (p.id === local.id || !p.alive) continue;
        s.renderPose(p.id, this.pose);
        const sp = this.project(this.pose.x, this.pose.y + 2.05, this.pose.z);
        if (sp) markers.push({ x: sp.x, y: sp.y, text: p.name, kind: 'friend' });
      }
      if (s.round.capture.active) {
        const cp = s.map.capture.pos;
        const sp = this.project(cp[0], cp[1] + 1.2, cp[2]);
        const d = Math.hypot(cp[0] - this.camera.position.x, cp[2] - this.camera.position.z);
        if (sp) markers.push({ x: sp.x, y: sp.y, text: `◆ DRAIN ${Math.round(d)}m`, kind: 'objective' });
      }
      hud.setMarkers(markers);
    }
    const tab = input.isDown('scoreboard');
    hud.setScoreboard(tab, tab ? this.scoreRows() : [], `${s.round.score[0]} : ${s.round.score[1]} · ROUND ${s.round.round}`);
    hud.setPerf(this.fps, s.ping());
    const st = s.status();
    hud.setConnection(st.connected ? st.message : st.message || 'CONNECTION LOST');
  }

  private updateAudio(_dt: number): void {
    const c = this.camera;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    audio.setListener(c.position.x, c.position.y, c.position.z, f.x, f.y, f.z);
    while (this.reloadSounds.length && this.reloadSounds[0].t <= this.time) {
      const s = this.reloadSounds.shift()!;
      audio.play(s.name, { volume: 0.7 });
    }
    this.reloadSounds.sort((a, b) => a.t - b.t);
  }

  // ------------------------------------------------------------------ helpers

  private project(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    const w = this.o.renderer.canvas.clientWidth || window.innerWidth;
    const h = this.o.renderer.canvas.clientHeight || window.innerHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }

  /** World position of the viewmodel muzzle (vm scene shares world coordinates). */
  private vmMuzzleWorld(): THREE.Vector3 | null {
    const w = this.vm.weapon;
    if (!w) return null;
    w.root.updateWorldMatrix(true, false);
    return w.muzzle.clone().applyMatrix4(w.root.matrixWorld);
  }

  /** Tracer origin for the local player: where the muzzle appears on screen, pushed into the world. */
  private tracerOriginLocal(): THREE.Vector3 | null {
    const mz = this.vmMuzzleWorld();
    if (!mz) return null;
    const ndc = mz.clone().project(this.vm.camera);
    const p = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera);
    const dir = p.sub(this.camera.position).normalize();
    return this.camera.position.clone().addScaledVector(dir, 1.0);
  }

  private characterMuzzle(p: PlayerState): { x: number; y: number; z: number } {
    this.o.session.renderPose(p.id, this.pose);
    const fx = -Math.sin(this.pose.yaw) * Math.cos(this.pose.pitch);
    const fy = Math.sin(this.pose.pitch);
    const fz = -Math.cos(this.pose.yaw) * Math.cos(this.pose.pitch);
    const rx = Math.cos(this.pose.yaw);
    const rz = -Math.sin(this.pose.yaw);
    const eye = this.pose.y + MOVE.eyeStand + (MOVE.eyeCrouch - MOVE.eyeStand) * this.pose.crouch;
    return { x: this.pose.x + fx * 0.75 + rx * 0.14, y: eye - 0.18 + fy * 0.75, z: this.pose.z + fz * 0.75 + rz * 0.14 };
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  applySettings(): void {
    this.hud.applyColors();
    const c = teamColors(settings.value.colorblind);
    void c;
  }

  dispose(): void {
    this.disposed = true;
    this.hud.dispose();
    audio.stopAmbience();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
  }
}

function segPointDist(ax: number, ay: number, az: number, bx: number, by: number, bz: number, px: number, py: number, pz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2, 0, 1);
  return Math.hypot(ax + dx * t - px, ay + dy * t - py, az + dz * t - pz);
}

void BTN;
