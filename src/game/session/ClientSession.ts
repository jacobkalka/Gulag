import type { MapDef } from '@/game/world/mapTypes';
import { CollisionWorld, OPAQUE } from '@/game/world/collision';
import { PLAYLISTS, type MatchRules, type PlaylistId } from '@/data/playlists';
import type { Loadout } from '@/data/progression';
import { DT, TICK_RATE, type GameEvent, type GrenadeState, type PlayerInput, type PlayerState, type RoundState, type ShotTrace } from '@/game/sim/types';
import { MAX_RANGE, finishPlayerStep, isCombat, isFrozen, makePlayer, poseOf, stepPlayerCore } from '@/game/sim/GameSim';
import { eyeHeight } from '@/game/sim/movement';
import { spreadDirection, type FireRequest } from '@/game/sim/weaponLogic';
import { rayVsBody, type BodyPose } from '@/game/sim/hitboxes';
import { lerpAngle } from '@/shared/math';
import {
  INPUT_REDUNDANCY,
  MSG,
  applySelf,
  encodeInputs,
  encodePing,
  quantizeInput,
  type ClientMsg,
  type MatchStart,
  type RosterEntry,
  type SelfState,
  type SnapPlayer,
  type Snapshot,
} from '@/net/protocol';
import type { MatchSession, RenderPose } from './Session';

// The client side of a networked match.
//  - The local player is predicted: every 60 Hz input is simulated immediately with the same
//    movement/weapon code the host runs, then reconciled against the authoritative state in each
//    snapshot (rewind to the acknowledged input, replay the unacknowledged ones). Small
//    corrections are smoothed out visually instead of snapping.
//  - Everyone else is interpolated ~100 ms in the past between snapshots; that render time is
//    sent with every input so the host can rewind targets (lag compensation).
//  - Host events are released in step with the state they belong to: immediately-relevant ones
//    once the matching snapshot has been applied, remote players' cosmetic ones at render time.

/** Remote players are drawn this many ticks behind the newest snapshot (100 ms). */
const INTERP_TICKS = 6;
const MAX_SAMPLES = 40;
const MAX_PENDING = 240;
/** Events waiting longer than this are released even if their snapshot never arrived. */
const EVENT_MAX_WAIT_MS = 300;

interface PoseSample {
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
  vx: number;
  vy: number;
  vz: number;
}

interface QueuedEvent {
  tick: number;
  e: GameEvent;
  /** Remote cosmetic event: released at render time rather than snapshot time. */
  interp: boolean;
  at: number;
}

export interface ClientSessionOptions {
  map: MapDef;
  start: MatchStart;
  localPid: string;
  sendU: (data: Uint8Array) => void;
  sendR: (msg: ClientMsg) => void;
  /** Millisecond clock (injectable for tests). */
  now?: () => number;
  world?: CollisionWorld;
}

export class ClientSession implements MatchSession {
  readonly localId: number;
  readonly map: MapDef;
  readonly rules: MatchRules;
  readonly world: CollisionWorld;
  readonly playlistId: PlaylistId;
  readonly players: PlayerState[] = [];
  round: RoundState;
  grenades: GrenadeState[] = [];
  tick: number;
  readonly matchId: string;

  private now: () => number;
  private pending: PlayerInput[] = [];
  private acc = 0;
  private alpha = 1;
  private prevLocal = { x: 0, y: 0, z: 0, crouch: 0 };
  private smooth = { x: 0, y: 0, z: 0 };
  private samples = new Map<number, PoseSample[]>();
  private clockOffset: number | null = null;
  private snapTick = -1;
  private lastSnapAt = -1;
  private events: QueuedEvent[] = [];
  private predictedShots = new Set<number>();
  private scratch: GameEvent[] = [];
  private rtt = 0;
  private lastPingAt = -1e9;
  private rawGrenades: { g: GrenadeState; at: number }[] = [];
  private pings = new Map<number, number>();
  private ended = false;
  private disconnected = '';
  /** Correction distance of the last reconciliation (diagnostics/tests). */
  lastCorrection = 0;
  snapshotsReceived = 0;

  constructor(private o: ClientSessionOptions) {
    const pl = PLAYLISTS[o.start.playlist];
    this.matchId = o.start.matchId;
    this.playlistId = o.start.playlist;
    this.map = o.map;
    this.rules = pl.rules;
    this.world = o.world ?? CollisionWorld.fromMap(o.map, pl.rules.mapTags);
    this.now = o.now ?? (() => performance.now());
    for (const info of o.start.players) {
      const p = makePlayer({ id: info.id, team: info.team, name: info.name, bot: info.bot, loadout: info.loadout, touchpad: info.touchpad });
      p.alive = false;
      this.players.push(p);
    }
    this.localId = o.start.players.find((p) => p.pid === o.localPid)?.id ?? -1;
    this.tick = o.start.tick;
    this.snapTick = o.start.tick;
    this.round = {
      phase: 'countdown',
      timer: pl.rules.countdown,
      round: 1,
      score: [0, 0],
      capture: { active: false, team: -1, progress: 0, contested: false },
      lastWinner: -1,
      lastReason: '',
      matchWinner: -1,
    };
  }

  // ------------------------------------------------------------------ MatchSession

  update(dt: number, sampleInput: () => PlayerInput): GameEvent[] {
    const out: GameEvent[] = [];
    const nowMs = this.now();
    this.acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this.acc >= DT && steps < 8) {
      this.capturePrevLocal();
      const inp = quantizeInput(sampleInput());
      if (!this.ended && !this.disconnected) {
        this.pending.push(inp);
        if (this.pending.length > MAX_PENDING) this.pending.shift();
        const local = this.localPlayer();
        if (local) this.predict(local, inp, (this.snapTick + this.pending.length) * DT, out);
        this.sendInputs();
      }
      this.acc -= DT;
      steps++;
    }
    if (steps >= 8) this.acc = 0;
    this.alpha = this.acc / DT;
    if (nowMs - this.lastPingAt > 1000 && !this.disconnected) {
      this.lastPingAt = nowMs;
      this.o.sendU(encodePing(nowMs, MSG.PING));
    }
    this.releaseEvents(out, nowMs);
    this.interpolateRemotes();
    this.extrapolateGrenades(nowMs);
    const k = Math.exp(-dt * 12);
    this.smooth.x *= k;
    this.smooth.y *= k;
    this.smooth.z *= k;
    return out;
  }

  renderPose(id: number, out: RenderPose): boolean {
    const p = this.players.find((q) => q.id === id);
    if (!p) return false;
    if (id === this.localId) {
      const a = this.alpha;
      const pr = this.prevLocal;
      const far = Math.hypot(p.x - pr.x, p.z - pr.z) > 3;
      out.x = (far ? p.x : pr.x + (p.x - pr.x) * a) + this.smooth.x;
      out.y = (far ? p.y : pr.y + (p.y - pr.y) * a) + this.smooth.y;
      out.z = (far ? p.z : pr.z + (p.z - pr.z) * a) + this.smooth.z;
      out.crouch = far ? p.crouch : pr.crouch + (p.crouch - pr.crouch) * a;
    } else {
      out.x = p.x;
      out.y = p.y;
      out.z = p.z;
      out.crouch = p.crouch;
    }
    out.yaw = p.yaw;
    out.pitch = p.pitch;
    return true;
  }

  /** Host tick at which remote players are currently drawn (sent for lag compensation). */
  viewTick(): number {
    return Math.max(0, this.renderTick());
  }

  setLoadout(l: Loadout): void {
    this.o.sendR({ t: 'loadout', loadout: l });
  }

  setTouchpad(on: boolean): void {
    const me = this.players.find((p) => p.id === this.localId);
    if (me) me.touchpad = on;
    this.o.sendR({ t: 'mode', touchpad: on });
  }

  ping(): number {
    return Math.round(this.rtt);
  }

  pingOf(id: number): number {
    return id === this.localId ? this.ping() : (this.pings.get(id) ?? 0);
  }

  status(): { connected: boolean; message: string } {
    if (this.disconnected) return { connected: false, message: this.disconnected };
    if (this.snapshotsReceived > 0 && this.now() - this.lastSnapAt > 1500) return { connected: true, message: 'CONNECTION INTERRUPTED' };
    return { connected: true, message: '' };
  }

  /** Stops sending inputs. Leaving the room itself is the NetClient's job. */
  leave(): void {
    this.ended = true;
  }

  // ------------------------------------------------------------------ network input

  onSnapshot(s: Snapshot): void {
    if (s.tick <= this.snapTick && this.snapshotsReceived > 0) return; // stale / reordered
    const nowMs = this.now();
    this.snapshotsReceived++;
    this.updateClock(s.tick, nowMs);
    this.snapTick = s.tick;
    this.tick = s.tick;
    this.lastSnapAt = nowMs;
    this.round = s.round;
    this.rawGrenades = s.grenades.map((g) => ({ g, at: nowMs }));
    this.grenades = s.grenades.map((g) => ({ ...g }));
    for (const sp of s.players) {
      let p = this.players.find((q) => q.id === sp.id);
      if (!p) {
        p = makePlayer({ id: sp.id, team: sp.team, name: `Player ${sp.id}`, bot: sp.bot });
        this.players.push(p);
      }
      if (sp.id === this.localId) {
        // display fields only; the full state arrives in the self block
        p.team = sp.team;
        p.connected = sp.connected;
        continue;
      }
      this.applyRemote(p, sp, s.tick);
    }
    const local = this.localPlayer();
    if (local && s.self) this.reconcile(local, s.self, s.ack, s.tick);
  }

  onEvents(tick: number, events: GameEvent[]): void {
    const at = this.now();
    for (const e of events) {
      const q = this.classify(e);
      if (q) this.events.push({ tick, e: q.e, interp: q.interp, at });
    }
  }

  onRoster(entries: RosterEntry[]): void {
    for (const r of entries) {
      let p = this.players.find((q) => q.id === r.id);
      if (!p) {
        p = makePlayer({ id: r.id, team: r.team, name: r.name, bot: r.bot, loadout: r.loadout });
        p.alive = false;
        this.players.push(p);
      }
      p.name = r.name;
      p.team = r.team;
      p.bot = r.bot;
      p.connected = r.connected;
      p.loadout = { ...r.loadout };
      p.stats = { ...r.stats };
      this.pings.set(r.id, r.ping);
    }
  }

  onPong(sentAt: number): void {
    const sample = Math.max(0, this.now() - sentAt);
    this.rtt = this.rtt === 0 ? sample : this.rtt + (sample - this.rtt) * 0.2;
  }

  /** The host went away or the connection dropped. */
  onDisconnect(reason: string): void {
    if (!this.disconnected) this.disconnected = reason || 'DISCONNECTED FROM HOST';
  }

  // ------------------------------------------------------------------ internals

  private localPlayer(): PlayerState | undefined {
    return this.localId >= 0 ? this.players.find((p) => p.id === this.localId) : undefined;
  }

  private capturePrevLocal(): void {
    const p = this.localPlayer();
    if (!p) return;
    this.prevLocal.x = p.x;
    this.prevLocal.y = p.y;
    this.prevLocal.z = p.z;
    this.prevLocal.crouch = p.crouch;
  }

  private sendInputs(): void {
    const n = Math.min(INPUT_REDUNDANCY, this.pending.length);
    if (!n) return;
    this.o.sendU(encodeInputs(this.pending.slice(this.pending.length - n), Math.round(this.rtt)));
  }

  /** One predicted tick of the local player. `out` is null while replaying (no new events). */
  private predict(p: PlayerState, inp: PlayerInput, now: number, out: GameEvent[] | null): void {
    if (!p.alive) {
      p.deadT += DT;
      p.prevButtons = inp.buttons;
      p.lastInputSeq = inp.seq;
      return;
    }
    const frozen = isFrozen(this.round.phase);
    const combat = isCombat(this.round.phase);
    const ev = out ?? this.scratch;
    const fire = stepPlayerCore(p, inp, this.world, frozen, combat, now, ev);
    if (fire && out) this.traceLocalShot(p, fire, out);
    finishPlayerStep(p, inp);
    if (!out) this.scratch.length = 0;
  }

  /** Predicted shot: tracer + wall impact now; hits are confirmed by the host. */
  private traceLocalShot(p: PlayerState, f: FireRequest, out: GameEvent[]): void {
    const w = f.weapon;
    this.predictedShots.add(p.shotCount);
    if (this.predictedShots.size > 64) this.predictedShots.delete(this.predictedShots.values().next().value!);
    const ox = p.x;
    const oy = p.y + eyeHeight(p);
    const oz = p.z;
    const pose: BodyPose = { x: 0, y: 0, z: 0, crouch: 0, slide: false, yaw: 0 };
    for (let k = 0; k < (w.pellets ?? 1); k++) {
      const [dx, dy, dz] = spreadDirection(f.yaw, f.pitch, f.spread, f.seed, k, w.pelletSpread ?? 0);
      const wall = this.world.raycast(ox, oy, oz, dx, dy, dz, MAX_RANGE, OPAQUE);
      let maxT = wall ? wall.t : MAX_RANGE;
      let hitPlayer = -1;
      for (const t of this.players) {
        if (t === p || !t.alive || !t.connected) continue;
        if (t.team === p.team && !this.rules.friendlyFire) continue;
        Object.assign(pose, poseOf(t));
        const h = rayVsBody(ox, oy, oz, dx, dy, dz, maxT, pose);
        if (h && h.t < maxT) {
          maxT = h.t;
          hitPlayer = t.id;
        }
      }
      const trace: ShotTrace = {
        shooter: p.id, weapon: w.id, ox, oy, oz, ex: ox + dx * maxT, ey: oy + dy * maxT, ez: oz + dz * maxT,
        nx: 0, ny: 0, nz: 0, surface: 'none', hitPlayer, pellet: k, shot: p.shotCount,
      };
      // a predicted player hit draws no impact: blood appears when the host confirms it
      if (hitPlayer < 0 && wall) {
        trace.nx = wall.nx;
        trace.ny = wall.ny;
        trace.nz = wall.nz;
        trace.surface = wall.surface;
      }
      out.push({ type: 'shot', trace });
    }
  }

  private reconcile(p: PlayerState, self: SelfState, ack: number, tick: number): void {
    const bx = p.x;
    const by = p.y;
    const bz = p.z;
    const wasAlive = p.alive;
    applySelf(p, self);
    let i = 0;
    while (i < this.pending.length && this.pending[i].seq <= ack) i++;
    if (i) this.pending.splice(0, i);
    for (let k = 0; k < this.pending.length; k++) this.predict(p, this.pending[k], (tick + k + 1) * DT, null);
    const dx = p.x - bx;
    const dy = p.y - by;
    const dz = p.z - bz;
    const err = Math.hypot(dx, dy, dz);
    this.lastCorrection = err;
    // keep the intra-tick interpolation continuous, then hide the jump behind a decaying offset
    this.prevLocal.x += dx;
    this.prevLocal.y += dy;
    this.prevLocal.z += dz;
    if (err > 2 || !wasAlive || !p.alive) {
      this.smooth.x = this.smooth.y = this.smooth.z = 0;
      this.prevLocal.x = p.x;
      this.prevLocal.y = p.y;
      this.prevLocal.z = p.z;
    } else {
      this.smooth.x -= dx;
      this.smooth.y -= dy;
      this.smooth.z -= dz;
    }
  }

  private applyRemote(p: PlayerState, sp: SnapPlayer, tick: number): void {
    const wasAlive = p.alive;
    p.alive = sp.alive;
    p.connected = sp.connected;
    p.grounded = sp.grounded;
    p.sprinting = sp.sprinting;
    p.team = sp.team;
    p.bot = sp.bot;
    p.flashlight = sp.flashlight;
    p.hp = sp.hp;
    p.slot = sp.slot;
    p.weapons[sp.slot].id = sp.weapon;
    p.ads = sp.ads;
    p.flash = sp.flash;
    p.slideT = sp.slideT;
    p.mantleT = sp.mantleT;
    p.reloadT = sp.reloadT;
    p.reloadTotal = sp.reloadTotal;
    p.meleeT = sp.meleeT;
    p.swapT = sp.swapT;
    p.spawnProt = sp.spawnProt;
    p.deadT = sp.deadT;
    p.killedBy = sp.killedBy;
    p.shotCount = sp.shotCount;
    let buf = this.samples.get(p.id);
    if (!buf) this.samples.set(p.id, (buf = []));
    // a respawn is a teleport: start a fresh history so we never interpolate across it
    if (sp.alive && !wasAlive) buf.length = 0;
    buf.push({ tick, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: sp.pitch, crouch: sp.crouch, vx: sp.vx, vy: sp.vy, vz: sp.vz });
    if (buf.length > MAX_SAMPLES) buf.shift();
    if (buf.length === 1) {
      p.x = sp.x;
      p.y = sp.y;
      p.z = sp.z;
      p.yaw = sp.yaw;
      p.pitch = sp.pitch;
      p.crouch = sp.crouch;
    }
  }

  private interpolateRemotes(): void {
    const rt = this.renderTick();
    for (const p of this.players) {
      if (p.id === this.localId) continue;
      const buf = this.samples.get(p.id);
      if (!buf || !buf.length) continue;
      let a = buf[0];
      let b = buf[buf.length - 1];
      let t = 0;
      if (rt <= a.tick) b = a;
      else if (rt >= b.tick) a = b;
      else {
        for (let i = 0; i < buf.length - 1; i++) {
          if (buf[i].tick <= rt && buf[i + 1].tick >= rt) {
            a = buf[i];
            b = buf[i + 1];
            break;
          }
        }
        t = b.tick > a.tick ? (rt - a.tick) / (b.tick - a.tick) : 0;
        if (Math.hypot(b.x - a.x, b.z - a.z) > 3) t = t < 0.5 ? 0 : 1;
      }
      p.x = a.x + (b.x - a.x) * t;
      p.y = a.y + (b.y - a.y) * t;
      p.z = a.z + (b.z - a.z) * t;
      p.yaw = lerpAngle(a.yaw, b.yaw, t);
      p.pitch = a.pitch + (b.pitch - a.pitch) * t;
      p.crouch = a.crouch + (b.crouch - a.crouch) * t;
      p.vx = a.vx + (b.vx - a.vx) * t;
      p.vy = a.vy + (b.vy - a.vy) * t;
      p.vz = a.vz + (b.vz - a.vz) * t;
    }
  }

  private extrapolateGrenades(nowMs: number): void {
    for (let i = 0; i < this.rawGrenades.length && i < this.grenades.length; i++) {
      const { g, at } = this.rawGrenades[i];
      const t = Math.min(0.05, Math.max(0, (nowMs - at) / 1000));
      const d = this.grenades[i];
      d.x = g.x + g.vx * t;
      d.y = g.y + g.vy * t - 10 * t * t;
      d.z = g.z + g.vz * t;
    }
  }

  private updateClock(tick: number, nowMs: number): void {
    const sample = tick - (nowMs / 1000) * TICK_RATE;
    if (this.clockOffset === null || sample > this.clockOffset) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.01;
  }

  private estHostTick(): number {
    if (this.clockOffset === null) return this.snapTick;
    return (this.now() / 1000) * TICK_RATE + this.clockOffset;
  }

  private renderTick(): number {
    return Math.min(this.estHostTick() - INTERP_TICKS, this.snapTick);
  }

  /** Decides how (and whether) a host event is shown on this client. */
  private classify(e: GameEvent): { e: GameEvent; interp: boolean } | null {
    const L = this.localId;
    switch (e.type) {
      case 'fire':
        if (e.shooter === L) return this.predictedShots.has(e.n) ? null : { e, interp: false };
        return { e, interp: true };
      case 'shot':
        if (e.trace.shooter === L) {
          if (!this.predictedShots.has(e.trace.shot)) return { e, interp: false };
          return e.trace.surface === 'flesh' ? { e: { ...e, impactOnly: true }, interp: false } : null;
        }
        return { e, interp: true };
      case 'reload':
      case 'swap':
      case 'jump':
      case 'land':
        return e.player === L ? null : { e, interp: true };
      case 'melee':
        return { e, interp: e.player !== L };
      case 'grenade':
        return { e, interp: e.owner !== L };
      default:
        return { e, interp: false };
    }
  }

  private releaseEvents(out: GameEvent[], nowMs: number): void {
    if (!this.events.length) return;
    const rt = this.renderTick();
    const keep: QueuedEvent[] = [];
    for (const q of this.events) {
      const due = q.interp ? q.tick <= rt + 0.001 : q.tick <= this.snapTick;
      if (due || nowMs - q.at > EVENT_MAX_WAIT_MS) out.push(q.e);
      else keep.push(q);
    }
    this.events = keep;
  }
}
