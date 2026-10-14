import { signal } from '@preact/signals';
import type { GameController } from './GameController';
import { profile, pushToast, screen, selectedPlaylist } from './state';
import { settings } from './settings';
import { levelForXp } from '@/data/progression';
import { PLAYLISTS, type PlaylistId } from '@/data/playlists';
import type { BotDifficulty } from '@/game/bots/BotBrain';
import { NetHost, MAX_ROOM_SIZE } from '@/net/NetHost';
import { NetClient } from '@/net/NetClient';
import { acceptPeers, connectToHost } from '@/net/peer';
import { BroadcastSignaling, type Signaling } from '@/net/signaling';
import { PROTOCOL_VERSION, isRoomCode, normalizeRoomCode, randomRoomCode, type ChatLine, type RoomState } from '@/net/protocol';

// Private rooms: create/join by code, the room lobby, and handing matches to the game.
// The host's browser runs the authoritative simulation; everyone else connects over WebRTC.

export interface RoomView {
  role: 'host' | 'client';
  room: RoomState;
  selfPid: string;
  chat: ChatLine[];
  mode: 'local' | 'online';
}

export const roomView = signal<RoomView | null>(null);
/** Non-empty while creating/joining ("CONNECTING" etc.). */
export const roomBusy = signal('');

type SignalingFactory = () => Signaling;
let onlineSignaling: SignalingFactory | null = null;

/** Installed by the backend once Firebase is configured (internet rooms). */
export function setOnlineSignaling(f: SignalingFactory | null): void {
  onlineSignaling = f;
}

export function onlineRoomsAvailable(): boolean {
  return !!onlineSignaling && new URLSearchParams(location.search).get('net') !== 'local';
}

export class RoomController {
  private signaling: Signaling | null = null;
  private host: NetHost | null = null;
  private client: NetClient | null = null;
  private stopAccept: (() => void) | null = null;
  private leaving = false;

  constructor(private game: GameController) {}

  get active(): boolean {
    return !!(this.host || this.client);
  }
  get isHost(): boolean {
    return !!this.host;
  }

  private makeSignaling(): Signaling {
    return onlineRoomsAvailable() ? onlineSignaling!() : new BroadcastSignaling();
  }

  private me() {
    const p = profile.value;
    return { name: p.username, level: levelForXp(p.xp).level, loadout: p.loadout };
  }

  async createRoom(): Promise<void> {
    if (this.active || roomBusy.value) return;
    roomBusy.value = 'CREATING ROOM';
    let sig: Signaling | null = null;
    try {
      sig = this.makeSignaling();
      const me = this.me();
      const playlist = selectedPlaylist.value;
      let code = '';
      for (let i = 0; i < 6 && !code; i++) {
        const c = randomRoomCode();
        try {
          await sig.hostRoom({ code: c, hostId: sig.selfId, hostName: me.name, playlist, players: 1, capacity: capacityOf(playlist), version: PROTOCOL_VERSION });
          code = c;
        } catch {
          // code taken: try another
        }
      }
      if (!code) throw new Error('Could not reserve a room code');
      const host = new NetHost({ code, self: { pid: sig.selfId, ...me }, map: this.game.map, playlist, difficulty: settings.value.botDifficulty });
      const s = sig;
      host.onRoom = (room) => {
        this.updateRoom(room);
        s.updateRoom({ players: room.members.length, playlist: room.playlist, capacity: capacityOf(room.playlist) });
      };
      host.onChat = (line) => this.pushChat(line);
      this.stopAccept = acceptPeers(sig, (link) => host.acceptLink(link));
      this.signaling = sig;
      this.host = host;
      this.leaving = false;
      roomView.value = { role: 'host', room: host.room, selfPid: sig.selfId, chat: [], mode: sig.kind };
    } catch (e) {
      sig?.dispose();
      pushToast({ title: 'COULD NOT CREATE ROOM', body: errText(e), kind: 'error' });
    } finally {
      roomBusy.value = '';
    }
  }

  async joinRoom(rawCode: string): Promise<void> {
    if (this.active || roomBusy.value) return;
    const code = normalizeRoomCode(rawCode);
    if (!isRoomCode(code)) {
      pushToast({ title: 'INVALID CODE', body: 'Room codes are 6 letters/digits.', kind: 'error' });
      return;
    }
    roomBusy.value = 'FINDING ROOM';
    let sig: Signaling | null = null;
    try {
      sig = this.makeSignaling();
      const info = await sig.findRoom(code);
      if (!info) throw new Error(`No open room with code ${code}${sig.kind === 'local' ? ' on this device' : ''}.`);
      if (info.version !== PROTOCOL_VERSION) throw new Error('That room runs a different game version. Refresh both pages.');
      roomBusy.value = 'CONNECTING';
      const link = await connectToHost(sig, info.hostId);
      const me = this.me();
      const client = new NetClient(link, { map: this.game.map, pid: sig.selfId, ...me });
      this.signaling = sig;
      this.client = client;
      this.leaving = false;
      roomView.value = {
        role: 'client',
        room: { code, playlist: info.playlist as PlaylistId, fillBots: true, difficulty: 'regular', phase: 'lobby', members: [] },
        selfPid: sig.selfId,
        chat: [],
        mode: sig.kind,
      };
      client.onRoom = (room) => this.updateRoom(room);
      client.onChat = (line) => this.pushChat(line);
      client.onStart = (session) => {
        this.game.beginMatch(session);
        screen.value = 'match';
      };
      client.onLobby = () => {
        // the host closed the results; if we are still in a match view, go back to the room
        if (this.game.inMatch) {
          this.game.leaveMatch(true);
          screen.value = 'lobby';
        }
      };
      client.onClosed = (reason) => {
        const wasLeaving = this.leaving;
        this.cleanup();
        if (!wasLeaving) {
          pushToast({ title: 'DISCONNECTED FROM ROOM', body: humanReason(reason), kind: 'error' });
          if (this.game.inMatch) {
            this.game.leaveMatch(true);
            screen.value = 'lobby';
          }
        }
      };
    } catch (e) {
      sig?.dispose();
      this.client = null;
      this.signaling = null;
      pushToast({ title: 'COULD NOT JOIN', body: errText(e), kind: 'error' });
    } finally {
      roomBusy.value = '';
    }
  }

  /** Host: start a match with everyone in the room. */
  startMatch(): void {
    if (!this.host || this.host.session) return;
    const session = this.host.startMatch();
    this.game.beginMatch(session);
    screen.value = 'match';
  }

  /** After the results screen: host reopens the room lobby (clients follow automatically). */
  returnToRoom(): void {
    if (this.host) this.host.endMatch();
    screen.value = 'lobby';
  }

  leaveRoom(): void {
    if (!this.active) return;
    this.leaving = true;
    if (this.host) this.host.close();
    if (this.client) this.client.leave();
    this.cleanup();
  }

  private cleanup(): void {
    this.stopAccept?.();
    this.stopAccept = null;
    if (this.signaling) {
      const sig = this.signaling;
      sig.closeRoom();
      // let any final 'bye' signals flush
      setTimeout(() => sig.dispose(), 500);
    }
    this.signaling = null;
    this.host = null;
    this.client = null;
    roomView.value = null;
  }

  update(): void {
    this.client?.update();
  }

  // ---- lobby actions
  setPlaylist(id: PlaylistId): void {
    if (this.host && !this.host.setPlaylist(id)) {
      pushToast({ title: 'TOO MANY PLAYERS', body: `${PLAYLISTS[id].name} holds ${capacityOf(id)} players.`, kind: 'error' });
    }
  }
  setFillBots(on: boolean): void {
    this.host?.setFillBots(on);
  }
  setDifficulty(d: BotDifficulty): void {
    this.host?.setDifficulty(d);
  }
  setTeam(pid: string, team: 0 | 1): void {
    if (this.host) this.host.setTeam(pid, team);
    else this.client?.requestTeam(team);
  }
  kick(pid: string): void {
    this.host?.kick(pid);
  }
  setReady(ready: boolean): void {
    this.client?.setReady(ready);
  }
  chat(text: string): void {
    if (this.host) this.host.sendChat(text);
    else this.client?.chat(text);
  }
  syncLoadout(): void {
    const l = profile.value.loadout;
    if (this.host) this.host.setSelfLoadout(l);
    else this.client?.setLoadout(l);
  }

  private updateRoom(room: RoomState): void {
    const v = roomView.value;
    if (v) roomView.value = { ...v, room };
  }

  private pushChat(line: ChatLine): void {
    const v = roomView.value;
    if (v) roomView.value = { ...v, chat: [...v.chat.slice(-60), line] };
  }
}

export function capacityOf(id: PlaylistId): number {
  return Math.min(MAX_ROOM_SIZE, PLAYLISTS[id].rules.teamSize * 2);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function humanReason(r: string): string {
  if (r === 'peer closed' || r === 'channel closed') return 'The host left.';
  if (r === 'connection lost' || r === 'connection failed') return 'The connection to the host was lost.';
  return r;
}
