import type { MapDef } from '@/game/world/mapTypes';
import { PLAYLISTS, type PlaylistId } from '@/data/playlists';
import type { Loadout } from '@/data/progression';
import { GameSim, type SimPlayerConfig } from '@/game/sim/GameSim';
import { DT, type GameEvent, type PlayerInput, type PlayerState } from '@/game/sim/types';
import { NavGrid } from '@/game/bots/NavGrid';
import { BotBrain, type BotDifficulty } from '@/game/bots/BotBrain';
import { lerpAngle } from '@/shared/math';
import type { MatchSession, RenderPose } from './Session';

// The authoritative side: runs the GameSim at a fixed 60 Hz with bots, the local player,
// and (in networked matches) remote players whose inputs arrive over WebRTC.

const BOT_NAMES = ['Rook', 'Vasquez', 'Brick', 'Nomad', 'Kilo', 'Mags', 'Patch', 'Sable', 'Dutch', 'Ox', 'Juno', 'Wick', 'Shade', 'Tank', 'Echo', 'Vise'];

export interface HostOptions {
  map: MapDef;
  playlist: PlaylistId;
  local: { name: string; loadout: Loadout; team?: 0 | 1 } | null;
  /** Remote humans already known when the match starts. */
  remotes?: { id: number; name: string; team: 0 | 1; loadout: Loadout }[];
  /** Fill empty slots with bots. */
  fillBots: boolean;
  difficulty: BotDifficulty;
  seed?: number;
}

interface Prev {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
}

export class HostSession implements MatchSession {
  readonly sim: GameSim;
  readonly nav: NavGrid;
  readonly localId: number;
  readonly playlistId: string;
  private bots = new Map<number, BotBrain>();
  private acc = 0;
  private alpha = 1;
  private prev = new Map<number, Prev>();
  /** Queued inputs from remote players (host only). */
  private remoteQueues = new Map<number, PlayerInput[]>();
  private lastRemote = new Map<number, PlayerInput>();
  /** Called after every simulation tick (host networking hooks in here). */
  onTick: ((events: GameEvent[]) => void) | null = null;
  private left = false;

  constructor(opts: HostOptions) {
    const pl = PLAYLISTS[opts.playlist];
    this.playlistId = opts.playlist;
    this.sim = new GameSim(opts.map, pl.rules, opts.seed ?? (Date.now() & 0xffff));
    this.nav = new NavGrid(this.sim.world, opts.map);
    let nextId = 0;
    const counts = [0, 0];
    if (opts.local) {
      const team = opts.local.team ?? 0;
      this.sim.addPlayer({ id: nextId, team, name: opts.local.name, bot: false, loadout: opts.local.loadout });
      this.localId = nextId++;
      counts[team]++;
    } else this.localId = -1;
    for (const r of opts.remotes ?? []) {
      this.sim.addPlayer({ id: r.id, team: r.team, name: r.name, bot: false, loadout: r.loadout });
      nextId = Math.max(nextId, r.id + 1);
      counts[r.team]++;
    }
    if (opts.fillBots) {
      let n = 0;
      const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
      for (const team of [0, 1] as const) {
        while (counts[team] < pl.rules.teamSize) {
          const id = nextId++;
          const cfg: SimPlayerConfig = { id, team, name: `${names[n % names.length]} [BOT]`, bot: true, loadout: botLoadout(id) };
          this.sim.addPlayer(cfg);
          this.bots.set(id, new BotBrain(id, opts.difficulty, opts.seed ?? 1));
          counts[team]++;
          n++;
        }
      }
    }
    this.sim.start();
    this.capturePrev();
  }

  get map(): MapDef {
    return this.sim.map;
  }
  get rules() {
    return this.sim.rules;
  }
  get world() {
    return this.sim.world;
  }
  get players(): PlayerState[] {
    return this.sim.players;
  }
  get round() {
    return this.sim.round;
  }
  get grenades() {
    return this.sim.grenades;
  }
  get tick(): number {
    return this.sim.tick;
  }

  private capturePrev(): void {
    for (const p of this.sim.players) {
      let pr = this.prev.get(p.id);
      if (!pr) this.prev.set(p.id, (pr = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 0 }));
      pr.x = p.x;
      pr.y = p.y;
      pr.z = p.z;
      pr.yaw = p.yaw;
      pr.pitch = p.pitch;
      pr.crouch = p.crouch;
    }
  }

  /** Adds a remote human mid-match (they spawn next round). */
  addRemote(id: number, name: string, team: 0 | 1, loadout: Loadout): void {
    // replace a bot on that team if one exists
    const bot = this.sim.players.find((p) => p.bot && p.team === team && p.connected);
    if (bot) {
      this.sim.removePlayer(bot.id);
      this.bots.delete(bot.id);
    }
    this.sim.addPlayer({ id, team, name, bot: false, loadout });
    this.remoteQueues.set(id, []);
  }

  removeRemote(id: number): void {
    this.sim.removePlayer(id);
    this.remoteQueues.delete(id);
  }

  /** Queue inputs received from a remote player (duplicates from redundancy are dropped). */
  pushRemoteInputs(id: number, inputs: PlayerInput[]): void {
    const q = this.remoteQueues.get(id);
    if (!q) return;
    const last = this.lastRemote.get(id)?.seq ?? this.sim.player(id)?.lastInputSeq ?? 0;
    const lastQueued = q.length ? q[q.length - 1].seq : last;
    for (const inp of inputs) if (inp.seq > lastQueued && inp.seq > last) q.push(inp);
    // never let a client run ahead too far
    while (q.length > 12) q.shift();
  }

  private remoteInput(id: number): PlayerInput | null {
    const q = this.remoteQueues.get(id);
    let inp = q && q.length ? q.shift()! : null;
    // catch up if the queue grows (client clock running fast): consume one extra
    if (q && q.length > 4 && inp) inp = q.shift()!;
    if (inp) {
      this.lastRemote.set(id, inp);
      return inp;
    }
    // starvation: repeat the last movement but release one-shot buttons
    const last = this.lastRemote.get(id);
    if (!last) return null;
    return { ...last, buttons: last.buttons & ~(32 | 64 | 128 | 256 | 512) };
  }

  update(dt: number, sampleInput: () => PlayerInput): GameEvent[] {
    if (this.left) return [];
    this.acc += Math.min(dt, 0.25);
    const out: GameEvent[] = [];
    let steps = 0;
    while (this.acc >= DT && steps < 8) {
      this.capturePrev();
      const local = this.localId >= 0 ? sampleInput() : null;
      this.sim.step((p) => {
        if (p.id === this.localId) return local;
        const bot = this.bots.get(p.id);
        if (bot) return bot.think(this.sim, this.nav, p);
        return this.remoteInput(p.id);
      });
      for (const [id, b] of this.bots) {
        const p = this.sim.player(id);
        if (p) b.observe(this.sim.events, this.sim, p);
      }
      out.push(...this.sim.events);
      this.onTick?.(this.sim.events);
      this.acc -= DT;
      steps++;
    }
    if (steps >= 8) this.acc = 0;
    this.alpha = this.acc / DT;
    return out;
  }

  renderPose(id: number, out: RenderPose): boolean {
    const p = this.sim.player(id);
    if (!p) return false;
    const pr = this.prev.get(id);
    const a = this.alpha;
    if (!pr || Math.hypot(p.x - pr.x, p.z - pr.z) > 3) {
      out.x = p.x;
      out.y = p.y;
      out.z = p.z;
      out.yaw = p.yaw;
      out.pitch = p.pitch;
      out.crouch = p.crouch;
      return true;
    }
    out.x = pr.x + (p.x - pr.x) * a;
    out.y = pr.y + (p.y - pr.y) * a;
    out.z = pr.z + (p.z - pr.z) * a;
    out.yaw = lerpAngle(pr.yaw, p.yaw, a);
    out.pitch = pr.pitch + (p.pitch - pr.pitch) * a;
    out.crouch = pr.crouch + (p.crouch - pr.crouch) * a;
    return true;
  }

  viewTick(): number {
    return this.sim.tick;
  }

  setLoadout(l: Loadout): void {
    if (this.localId >= 0) this.sim.setLoadout(this.localId, l);
  }

  ping(): number {
    return 0;
  }

  status() {
    return { connected: true, message: '' };
  }

  leave(): void {
    this.left = true;
  }
}

function botLoadout(id: number): Loadout {
  const prim = ['halberd', 'rook9', 'kestrel', 'cinder', 'thresher', 'talon', 'lancet', 'anvil'][id % 8];
  const sec = ['warden', 'ironjaw', 'wasp'][id % 3];
  return { primary: prim, secondary: sec, lethal: 'frag', tactical: 'flash' };
}
