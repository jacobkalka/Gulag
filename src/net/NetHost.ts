import type { MapDef } from '@/game/world/mapTypes';
import { PLAYLISTS, type PlaylistId } from '@/data/playlists';
import { sanitizeLoadout, type Loadout } from '@/data/progression';
import type { BotDifficulty } from '@/game/bots/BotBrain';
import { HostSession } from '@/game/session/HostSession';
import type { GameEvent } from '@/game/sim/types';
import { ByteReader } from './codec';
import type { Link } from './link';
import {
  MSG,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY,
  compactEvents,
  decodeInputs,
  encodePing,
  encodeSnapshot,
  type ChatLine,
  type ClientMsg,
  type HostMsg,
  type MatchStart,
  type RoomMember,
  type RoomState,
  type RosterEntry,
} from './protocol';

// Host side of a private room: owns the room lobby (members, teams, ready state, chat) and,
// during a match, the authoritative HostSession. Clients connect through any Link.

export const MAX_ROOM_SIZE = 8;
const ROSTER_EVERY = 30; // ticks
const HELLO_TIMEOUT_MS = 10_000;
const CHAT_MAX = 140;

interface Peer {
  link: Link;
  pid: string;
  name: string;
  level: number;
  loadout: Loadout;
  team: 0 | 1;
  ready: boolean;
  rtt: number;
  /** Player id in the running match (-1 when not playing). */
  playerId: number;
  chatTimes: number[];
}

export interface NetHostOptions {
  code: string;
  self: { pid: string; name: string; level: number; loadout: Loadout };
  map: MapDef;
  playlist: PlaylistId;
  difficulty: BotDifficulty;
  now?: () => number;
}

export class NetHost {
  room: RoomState;
  session: HostSession | null = null;
  match: MatchStart | null = null;
  private peers = new Map<string, Peer>();
  private selfTeam: 0 | 1 = 0;
  private selfLoadout: Loadout;
  private pendingEvents: GameEvent[] = [];
  private lastRosterTick = -1000;
  private now: () => number;
  private closed = false;
  onRoom: ((room: RoomState) => void) | null = null;
  onChat: ((line: ChatLine) => void) | null = null;

  constructor(private o: NetHostOptions) {
    this.now = o.now ?? (() => performance.now());
    this.selfLoadout = { ...o.self.loadout };
    this.room = { code: o.code, playlist: o.playlist, fillBots: true, difficulty: o.difficulty, phase: 'lobby', members: [] };
    this.refreshMembers();
  }

  get selfPid(): string {
    return this.o.self.pid;
  }

  /** Number of humans in the room including the host. */
  get humanCount(): number {
    return this.peers.size + 1;
  }

  /** A transport to a would-be member is open; they must say hello first. */
  acceptLink(link: Link): void {
    if (this.closed) {
      link.close('room closed');
      return;
    }
    const timer = setTimeout(() => {
      if (!this.peers.has(link.id)) link.close('no hello');
    }, HELLO_TIMEOUT_MS);
    link.onR = (raw) => {
      const m = raw as ClientMsg;
      if (!m || m.t !== 'hello') return;
      clearTimeout(timer);
      this.onHello(link, m);
    };
    link.onClose = () => clearTimeout(timer);
  }

  private reject(link: Link, reason: string): void {
    link.sendR({ t: 'reject', reason } satisfies HostMsg);
    // let the message flush before closing
    setTimeout(() => link.close(reason), 300);
  }

  private onHello(link: Link, m: Extract<ClientMsg, { t: 'hello' }>): void {
    if (m.v !== PROTOCOL_VERSION) return this.reject(link, 'VERSION MISMATCH: REFRESH THE PAGE TO UPDATE');
    if (this.peers.has(link.id)) return this.reject(link, 'ALREADY IN THE ROOM');
    if (this.humanCount >= this.capacity()) return this.reject(link, 'ROOM IS FULL');
    const team = this.pickTeam();
    if (this.session && this.session.replaceableBot(team) < 0 && this.session.replaceableBot(team === 0 ? 1 : 0) < 0) {
      return this.reject(link, 'MATCH IN PROGRESS: TRY AGAIN WHEN IT ENDS');
    }
    const peer: Peer = {
      link,
      pid: link.id,
      name: sanitizeName(m.name),
      level: Math.max(1, Math.min(50, Math.floor(Number(m.level) || 1))),
      loadout: sanitizeLoadout(m.loadout, 50),
      team,
      ready: false,
      rtt: 0,
      playerId: -1,
      chatTimes: [],
    };
    this.peers.set(peer.pid, peer);
    link.onR = (raw) => this.onPeerMsg(peer, raw as ClientMsg);
    link.onU = (data) => this.onPeerData(peer, data);
    link.onClose = () => this.dropPeer(peer, 'left');
    this.refreshMembers();
    this.broadcastRoom();
    this.systemChat(`${peer.name} joined`);
    if (this.session) this.joinInProgress(peer);
  }

  private capacity(): number {
    return Math.min(MAX_ROOM_SIZE, PLAYLISTS[this.room.playlist].rules.teamSize * 2);
  }

  private teamCounts(): [number, number] {
    const c: [number, number] = [0, 0];
    c[this.selfTeam]++;
    for (const p of this.peers.values()) c[p.team]++;
    return c;
  }

  private pickTeam(): 0 | 1 {
    const c = this.teamCounts();
    return c[1] < c[0] ? 1 : 0;
  }

  private onPeerMsg(peer: Peer, m: ClientMsg): void {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ready':
        peer.ready = !!m.ready;
        break;
      case 'team':
        if (this.room.phase === 'lobby' && (m.team === 0 || m.team === 1) && m.team !== peer.team) {
          if (this.teamCounts()[m.team] < PLAYLISTS[this.room.playlist].rules.teamSize) peer.team = m.team;
        }
        break;
      case 'loadout':
        peer.loadout = sanitizeLoadout(m.loadout, 50);
        if (this.session && peer.playerId >= 0) this.session.sim.setLoadout(peer.playerId, peer.loadout);
        return;
      case 'chat': {
        const now = this.now();
        peer.chatTimes = peer.chatTimes.filter((t) => now - t < 5000);
        if (peer.chatTimes.length >= 5) return;
        peer.chatTimes.push(now);
        const text = sanitizeText(String(m.text ?? ''));
        if (text) this.broadcastChat({ from: peer.pid, name: peer.name, text });
        return;
      }
      case 'rtt':
        peer.rtt = Math.max(0, Math.min(9999, Math.round(Number(m.ms) || 0)));
        // the lobby shows everyone's ping; during a match the roster carries it
        if (this.room.phase !== 'lobby') return;
        break;
      case 'leave':
        peer.link.close('left');
        return;
      default:
        return;
    }
    this.refreshMembers();
    this.broadcastRoom();
  }

  private onPeerData(peer: Peer, data: Uint8Array): void {
    try {
      const r = new ByteReader(data);
      const type = r.u8();
      if (type === MSG.INPUT) {
        const { rtt, inputs } = decodeInputs(r);
        peer.rtt = rtt;
        if (this.session && peer.playerId >= 0) this.session.pushRemoteInputs(peer.playerId, inputs);
      } else if (type === MSG.PING) {
        peer.link.sendU(encodePing(r.f64(), MSG.PONG));
      }
    } catch {
      // malformed packet: ignore
    }
  }

  private dropPeer(peer: Peer, why: string): void {
    if (!this.peers.has(peer.pid)) return;
    this.peers.delete(peer.pid);
    if (this.session && peer.playerId >= 0) {
      if (this.room.fillBots) this.session.botify(peer.playerId);
      else this.session.removeRemote(peer.playerId);
      this.sendRoster();
    }
    this.refreshMembers();
    this.broadcastRoom();
    this.systemChat(`${peer.name} ${why === 'kicked' ? 'was removed' : 'left'}`);
  }

  // ------------------------------------------------------------------ host controls

  setPlaylist(id: PlaylistId): boolean {
    if (this.room.phase !== 'lobby') return false;
    if (this.humanCount > Math.min(MAX_ROOM_SIZE, PLAYLISTS[id].rules.teamSize * 2)) return false;
    this.room.playlist = id;
    this.rebalance();
    this.refreshMembers();
    this.broadcastRoom();
    return true;
  }

  setFillBots(on: boolean): void {
    this.room.fillBots = on;
    this.broadcastRoom();
  }

  setDifficulty(d: BotDifficulty): void {
    this.room.difficulty = d;
    this.broadcastRoom();
  }

  setSelfLoadout(l: Loadout): void {
    this.selfLoadout = { ...l };
    if (this.session && this.session.localId >= 0) this.session.sim.setLoadout(this.session.localId, l);
  }

  /** Moves a member (or the host, by its pid) to a team if there is room. */
  setTeam(pid: string, team: 0 | 1): void {
    if (this.room.phase !== 'lobby') return;
    const size = PLAYLISTS[this.room.playlist].rules.teamSize;
    if (this.teamCounts()[team] >= size) return;
    if (pid === this.selfPid) this.selfTeam = team;
    else {
      const p = this.peers.get(pid);
      if (!p) return;
      p.team = team;
    }
    this.refreshMembers();
    this.broadcastRoom();
  }

  kick(pid: string): void {
    const p = this.peers.get(pid);
    if (!p) return;
    p.link.sendR({ t: 'kick', reason: 'REMOVED BY THE HOST' } satisfies HostMsg);
    this.dropPeer(p, 'kicked');
    setTimeout(() => p.link.close('kicked'), 300);
  }

  sendChat(text: string): void {
    const t = sanitizeText(text);
    if (t) this.broadcastChat({ from: this.selfPid, name: this.o.self.name, text: t });
  }

  /** Keeps both teams within the playlist size (after a playlist change). */
  private rebalance(): void {
    const size = PLAYLISTS[this.room.playlist].rules.teamSize;
    for (const p of this.peers.values()) {
      const c = this.teamCounts();
      if (c[p.team] > size) p.team = p.team === 0 ? 1 : 0;
    }
  }

  // ------------------------------------------------------------------ match

  startMatch(seed = (Math.random() * 0xffffffff) >>> 0): HostSession {
    if (this.session) return this.session;
    this.rebalance();
    const peers = [...this.peers.values()];
    peers.forEach((p, i) => (p.playerId = i + 1));
    const session = new HostSession({
      map: this.o.map,
      playlist: this.room.playlist,
      local: { name: this.o.self.name, loadout: this.selfLoadout, team: this.selfTeam },
      remotes: peers.map((p) => ({ id: p.playerId, name: p.name, team: p.team, loadout: p.loadout })),
      fillBots: this.room.fillBots,
      difficulty: this.room.difficulty,
      seed,
    });
    this.session = session;
    this.match = {
      matchId: `${this.room.code}-${seed.toString(36)}`,
      playlist: this.room.playlist,
      seed,
      tick: session.tick,
      players: [],
    };
    this.refreshMatchPlayers();
    this.room.phase = 'match';
    for (const p of peers) p.ready = false;
    this.refreshMembers();
    for (const p of peers) p.link.sendR({ t: 'start', match: this.match } satisfies HostMsg);
    this.broadcastRoom();
    session.onTick = (events) => this.afterTick(events);
    session.pingProvider = (id) => this.pingOf(id);
    this.pendingEvents = [];
    this.lastRosterTick = -1000;
    return session;
  }

  private refreshMatchPlayers(): void {
    if (!this.session || !this.match) return;
    const byPlayer = new Map<number, string>();
    for (const p of this.peers.values()) if (p.playerId >= 0) byPlayer.set(p.playerId, p.pid);
    this.match.players = this.session.players.map((p) => ({
      id: p.id,
      pid: p.id === this.session!.localId ? this.selfPid : (byPlayer.get(p.id) ?? null),
      name: p.name,
      team: p.team,
      bot: p.bot,
      loadout: { ...p.loadout },
    }));
  }

  /** A member joined while a match is running: they take over a bot's slot. */
  private joinInProgress(peer: Peer): void {
    const s = this.session!;
    let team = peer.team;
    let bot = s.replaceableBot(team);
    if (bot < 0) {
      team = team === 0 ? 1 : 0;
      bot = s.replaceableBot(team);
    }
    if (bot < 0) return;
    peer.team = team;
    peer.playerId = Math.max(...s.players.map((p) => p.id)) + 1;
    s.addRemote(peer.playerId, peer.name, team, peer.loadout);
    this.refreshMatchPlayers();
    peer.link.sendR({ t: 'start', match: { ...this.match!, tick: s.tick } } satisfies HostMsg);
    this.refreshMembers();
    this.broadcastRoom();
    this.sendRoster();
  }

  /** After the results screen: everyone returns to the room lobby. */
  endMatch(): void {
    if (!this.session) return;
    this.session.onTick = null;
    this.session.leave();
    this.session = null;
    this.match = null;
    this.room.phase = 'lobby';
    for (const p of this.peers.values()) {
      p.playerId = -1;
      p.ready = false;
      p.link.sendR({ t: 'lobby' } satisfies HostMsg);
    }
    this.refreshMembers();
    this.broadcastRoom();
  }

  private afterTick(events: GameEvent[]): void {
    const s = this.session;
    if (!s) return;
    if (events.length) this.pendingEvents.push(...events);
    const tick = s.tick;
    const ended = events.some((e) => e.type === 'matchEnd');
    if (tick % SNAPSHOT_EVERY === 0 || ended) {
      const sim = s.sim;
      if (this.pendingEvents.length) {
        const msg: HostMsg = { t: 'ev', tick, events: compactEvents(this.pendingEvents) };
        for (const p of this.peers.values()) if (p.playerId >= 0) p.link.sendR(msg);
        this.pendingEvents = [];
      }
      for (const p of this.peers.values()) {
        if (p.playerId < 0) continue;
        const self = sim.player(p.playerId) ?? null;
        p.link.sendU(encodeSnapshot(tick, sim.round, sim.players, sim.grenades, self, self?.lastInputSeq ?? 0));
      }
    }
    if (ended || tick - this.lastRosterTick >= ROSTER_EVERY) this.sendRoster();
  }

  private sendRoster(): void {
    const s = this.session;
    if (!s) return;
    this.lastRosterTick = s.tick;
    const pingOf = new Map<number, number>();
    for (const p of this.peers.values()) if (p.playerId >= 0) pingOf.set(p.playerId, p.rtt);
    const players: RosterEntry[] = s.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      bot: p.bot,
      connected: p.connected,
      ping: pingOf.get(p.id) ?? 0,
      loadout: { ...p.loadout },
      stats: { ...p.stats },
    }));
    const msg: HostMsg = { t: 'roster', players };
    for (const p of this.peers.values()) if (p.playerId >= 0) p.link.sendR(msg);
  }

  /** Ping per player id for the scoreboard (host sees everyone's reported RTT). */
  pingOf(id: number): number {
    for (const p of this.peers.values()) if (p.playerId === id) return p.rtt;
    return 0;
  }

  // ------------------------------------------------------------------ room state

  private refreshMembers(): void {
    const members: RoomMember[] = [
      { pid: this.selfPid, name: this.o.self.name, level: this.o.self.level, team: this.selfTeam, ready: true, host: true, ping: 0 },
    ];
    for (const p of this.peers.values()) members.push({ pid: p.pid, name: p.name, level: p.level, team: p.team, ready: p.ready, host: false, ping: p.rtt });
    this.room = { ...this.room, members };
  }

  private broadcastRoom(): void {
    const msg: HostMsg = { t: 'room', room: this.room };
    for (const p of this.peers.values()) p.link.sendR(msg);
    this.onRoom?.(this.room);
  }

  private broadcastChat(line: ChatLine): void {
    const msg: HostMsg = { t: 'chat', line };
    for (const p of this.peers.values()) p.link.sendR(msg);
    this.onChat?.(line);
  }

  private systemChat(text: string): void {
    this.broadcastChat({ from: '', name: '', text, system: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.session) {
      this.session.onTick = null;
      this.session.leave();
    }
    for (const p of this.peers.values()) {
      p.link.sendR({ t: 'kick', reason: 'THE HOST CLOSED THE ROOM' } satisfies HostMsg);
      const link = p.link;
      setTimeout(() => link.close('room closed'), 200);
    }
    this.peers.clear();
  }
}

/** Replaces control characters (and optionally extra characters) with `sub`. */
function stripControl(s: string, sub: string, extra = ''): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c < 32 || c === 127 || extra.includes(ch) ? sub : ch;
  }
  return out;
}

export function sanitizeName(s: string): string {
  const t = stripControl(String(s ?? ''), '', '<>')
    .trim()
    .slice(0, 16);
  return t || 'Inmate';
}

export function sanitizeText(s: string): string {
  return stripControl(s, ' ').trim().slice(0, CHAT_MAX);
}
