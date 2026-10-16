import type { MapDef } from '@/game/world/mapTypes';
import type { MapId } from '@/data/maps';
import type { Loadout } from '@/data/progression';
import { ClientSession } from '@/game/session/ClientSession';
import type { CollisionWorld } from '@/game/world/collision';
import { ByteReader } from './codec';
import type { Link } from './link';
import { MSG, PROTOCOL_VERSION, decodeSnapshot, encodePing, type ChatLine, type ClientMsg, type HostMsg, type RoomState } from './protocol';

// Client side of a private room: says hello, mirrors the room lobby, and turns a 'start'
// message into a ClientSession that the match view drives.

export interface NetClientOptions {
  /** Builds (or returns the cached) map the host picked for a match. */
  getMap: (id: MapId) => MapDef;
  pid: string;
  name: string;
  level: number;
  loadout: Loadout;
  /** Declared touchpad input mode. */
  touchpad?: boolean;
  now?: () => number;
  /** Prebuilt collision world for the match's map (tests); built from the map when absent. */
  world?: CollisionWorld;
}

export class NetClient {
  room: RoomState | null = null;
  session: ClientSession | null = null;
  closedReason = '';
  rtt = 0;
  onRoom: ((room: RoomState) => void) | null = null;
  onChat: ((line: ChatLine) => void) | null = null;
  onStart: ((session: ClientSession) => void) | null = null;
  /** The host ended the match and everyone is back in the room lobby. */
  onLobby: (() => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private now: () => number;
  private lastPing = -1e9;
  private lastRttReport = -1e9;

  constructor(
    private link: Link,
    private o: NetClientOptions,
  ) {
    this.now = o.now ?? (() => performance.now());
    link.onR = (m) => this.onMsg(m as HostMsg);
    link.onU = (d) => this.onData(d);
    link.onClose = (reason) => this.handleClose(reason);
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: o.name, level: o.level, loadout: o.loadout, touchpad: !!o.touchpad });
  }

  get pid(): string {
    return this.o.pid;
  }

  get open(): boolean {
    return this.link.open && !this.closedReason;
  }

  send(m: ClientMsg): void {
    this.link.sendR(m);
  }

  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }
  requestTeam(team: 0 | 1): void {
    this.send({ t: 'team', team });
  }
  setLoadout(loadout: Loadout): void {
    this.o.loadout = loadout;
    this.send({ t: 'loadout', loadout });
  }
  chat(text: string): void {
    this.send({ t: 'chat', text });
  }
  setTouchpad(on: boolean): void {
    this.o.touchpad = on;
    if (this.session) this.session.setTouchpad(on);
    else this.send({ t: 'mode', touchpad: on });
  }

  /** Periodic upkeep (pings in the lobby). Call every frame. */
  update(): void {
    const t = this.now();
    if (!this.session && t - this.lastPing > 1000 && this.link.open) {
      this.lastPing = t;
      this.link.sendU(encodePing(t, MSG.PING));
    }
    if (t - this.lastRttReport > 2000 && this.link.open) {
      this.lastRttReport = t;
      this.send({ t: 'rtt', ms: Math.round(this.session ? this.session.ping() : this.rtt) });
    }
  }

  leave(): void {
    if (!this.link.open) return;
    this.session?.leave();
    this.send({ t: 'leave' });
    const link = this.link;
    setTimeout(() => link.close('left'), 150);
    this.closedReason = 'left';
  }

  private onMsg(m: HostMsg): void {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'room':
        this.room = m.room;
        this.onRoom?.(m.room);
        break;
      case 'chat':
        this.onChat?.(m.line);
        break;
      case 'reject':
      case 'kick':
        this.closedReason = m.reason;
        this.session?.onDisconnect(m.reason);
        this.link.close(m.reason);
        break;
      case 'start': {
        if (this.session && this.session.matchId === m.match.matchId) break;
        let map: MapDef;
        try {
          map = this.o.getMap(m.match.map);
        } catch {
          // a map this build doesn't know: the host runs a newer version
          this.closedReason = 'UNKNOWN MAP: REFRESH THE PAGE TO UPDATE';
          this.link.close(this.closedReason);
          break;
        }
        this.session = new ClientSession({
          map,
          start: m.match,
          localPid: this.o.pid,
          sendU: (d) => this.link.sendU(d),
          sendR: (msg) => this.link.sendR(msg),
          now: this.now,
          world: this.o.world,
        });
        this.onStart?.(this.session);
        break;
      }
      case 'ev':
        this.session?.onEvents(m.tick, m.events);
        break;
      case 'roster':
        this.session?.onRoster(m.players);
        break;
      case 'lobby':
        this.session = null;
        this.onLobby?.();
        break;
    }
  }

  private onData(data: Uint8Array): void {
    try {
      const r = new ByteReader(data);
      const type = r.u8();
      if (type === MSG.SNAPSHOT) this.session?.onSnapshot(decodeSnapshot(r));
      else if (type === MSG.PONG) {
        const t = r.f64();
        if (this.session) this.session.onPong(t);
        const sample = Math.max(0, this.now() - t);
        this.rtt = this.rtt === 0 ? sample : this.rtt + (sample - this.rtt) * 0.2;
      }
    } catch {
      // malformed packet: ignore
    }
  }

  private handleClose(reason: string): void {
    if (!this.closedReason) this.closedReason = reason || 'DISCONNECTED';
    this.session?.onDisconnect(this.closedReason === 'peer closed' ? 'THE HOST LEFT THE MATCH' : this.closedReason.toUpperCase());
    this.onClosed?.(this.closedReason);
  }
}
