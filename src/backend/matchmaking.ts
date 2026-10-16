import { onDisconnect, onValue, ref, remove, runTransaction, serverTimestamp, set, type Unsubscribe } from 'firebase/database';
import { PLAYLISTS, type PlaylistId } from '@/data/playlists';
import { matchmaking, party } from '@/app/social';
import { profile, pushToast, selectedMap } from '@/app/state';
import { pickMatchMap } from '@/data/maps';
import { roomView, type RoomController } from '@/app/rooms';
import { PROTOCOL_VERSION, randomRoomCode } from '@/net/protocol';
import type { Fb } from './firebase';

// Serverless matchmaking on the Realtime Database.
//
// Every searching player (or party leader) holds a ticket at /queue/{playlist}/{uid}. All
// queued clients watch the queue; the *oldest* unassigned ticket acts as coordinator: once it
// can fill both teams (or has waited long enough), it opens a room, claims the other tickets
// with a transaction on their `assign` child (so two coordinators can never grab the same
// ticket) and hosts. Assigned players join that room automatically; empty slots get bots.

const FILL_WITH_BOTS_AFTER_MS = 20_000; // start short-handed (bots fill) once two humans wait this long
const SOLO_AFTER_MS = 45_000; // nobody else around: play with bots
const HOST_WAIT_MS = 20_000; // how long the host waits for assigned players to connect

interface Ticket {
  id: string;
  size: number;
  names: string;
  ts: number;
  version: number;
  members?: Record<string, boolean>;
  /** The ticket holder's map pick (the coordinator chooses among the picks). */
  map?: string;
  assign?: { host: string; room: string; team: 0 | 1; ts: number };
}

export class Matchmaker {
  private playlist: PlaylistId | null = null;
  private unsubQueue: Unsubscribe | null = null;
  private unsubOffset: Unsubscribe | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickets: Ticket[] = [];
  private serverOffset = 0;
  private forming = false;

  constructor(
    private fb: Fb,
    private uid: string,
    private rooms: RoomController,
    private partyApi: { isLeader: () => boolean; setRoom: (code: string | null, state?: 'idle' | 'queue' | 'room') => Promise<void> },
  ) {
    this.unsubOffset = onValue(ref(fb.rtdb, '.info/serverTimeOffset'), (s) => (this.serverOffset = (s.val() as number) ?? 0));
  }

  private now(): number {
    return Date.now() + this.serverOffset;
  }

  async find(playlist: PlaylistId): Promise<void> {
    if (this.playlist) await this.cancel();
    const pv = party.value;
    if (pv && pv.leader !== this.uid) throw new Error('Only the party leader can start matchmaking');
    const teamSize = PLAYLISTS[playlist].rules.teamSize;
    const members = pv ? pv.members.map((m) => m.uid) : [this.uid];
    if (members.length > teamSize) throw new Error(`Your party is too big for ${playlist}`);
    const r = ref(this.fb.rtdb, `queue/${playlist}/${this.uid}`);
    await set(r, {
      size: members.length,
      names: pv ? pv.members.map((m) => m.name).join(', ').slice(0, 80) : profile.value.username,
      ts: serverTimestamp(),
      version: PROTOCOL_VERSION,
      members: Object.fromEntries(members.map((u) => [u, true])),
      map: pv ? pv.map : selectedMap.value,
    });
    await onDisconnect(r).remove();
    this.playlist = playlist;
    this.forming = false;
    if (pv) await this.partyApi.setRoom(null, 'queue');
    matchmaking.value = { state: 'searching', playlist, since: Date.now(), queued: members.length, needed: teamSize * 2 };
    this.unsubQueue = onValue(ref(this.fb.rtdb, `queue/${playlist}`), (snap) => {
      const v = (snap.val() ?? {}) as Record<string, Omit<Ticket, 'id'>>;
      this.tickets = Object.entries(v)
        .map(([id, t]) => ({ id, ...t }))
        .filter((t) => t.version === PROTOCOL_VERSION && typeof t.ts === 'number')
        .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
      void this.evaluate();
    });
    this.timer = setInterval(() => void this.evaluate(), 2000);
  }

  private async evaluate(): Promise<void> {
    const playlist = this.playlist;
    if (!playlist || this.forming) return;
    const mine = this.tickets.find((t) => t.id === this.uid);
    if (mine?.assign) return this.onAssigned(playlist, mine.assign);
    const open = this.tickets.filter((t) => !t.assign);
    const teamSize = PLAYLISTS[playlist].rules.teamSize;
    matchmaking.value = { ...matchmaking.value, queued: open.reduce((a, t) => a + t.size, 0), needed: teamSize * 2 };
    if (!mine || open[0]?.id !== this.uid) return; // someone older coordinates
    // greedy: oldest tickets first, each party into the team with more room
    const counts: [number, number] = [0, 0];
    const pick: { t: Ticket; team: 0 | 1 }[] = [];
    for (const t of open) {
      const team: 0 | 1 = counts[0] <= counts[1] ? 0 : 1;
      const alt: 0 | 1 = team === 0 ? 1 : 0;
      if (counts[team] + t.size <= teamSize) {
        counts[team] += t.size;
        pick.push({ t, team });
      } else if (counts[alt] + t.size <= teamSize) {
        counts[alt] += t.size;
        pick.push({ t, team: alt });
      }
      if (counts[0] + counts[1] >= teamSize * 2) break;
    }
    const humans = counts[0] + counts[1];
    const waited = this.now() - mine.ts;
    const ready = humans >= teamSize * 2 || (humans >= 2 && waited > FILL_WITH_BOTS_AFTER_MS) || waited > SOLO_AFTER_MS;
    if (ready) await this.form(playlist, pick);
  }

  /** Coordinator: open the room, claim the selected tickets, host. */
  private async form(playlist: PlaylistId, pick: { t: Ticket; team: 0 | 1 }[]): Promise<void> {
    this.forming = true;
    let code = randomRoomCode();
    const expected = new Map<string, 0 | 1>();
    for (const { t, team } of pick) for (const u of Object.keys(t.members ?? { [t.id]: true })) expected.set(u, team);
    try {
      const map = pickMatchMap(pick.map((p) => p.t), Math.random());
      await this.rooms.createRoom({ code, playlist, map, fillBots: true, expect: { teams: expected, timeoutMs: HOST_WAIT_MS } });
    } catch (e) {
      this.forming = false;
      console.warn('matchmade room failed', e);
      return;
    }
    if (!this.rooms.active || !roomView.value) {
      this.forming = false;
      return;
    }
    code = roomView.value.room.code; // in case the preferred code was taken
    // claim the other tickets (a ticket another coordinator already took is skipped)
    for (const { t, team } of pick) {
      if (t.id === this.uid) continue;
      const res = await runTransaction(ref(this.fb.rtdb, `queue/${playlist}/${t.id}/assign`), (cur) =>
        cur ? undefined : { host: this.uid, room: code, team, ts: Date.now() },
      ).catch(() => null);
      if (!res?.committed) for (const u of Object.keys(t.members ?? { [t.id]: true })) this.rooms.forgetExpected(u);
    }
    if (party.value) await this.partyApi.setRoom(code, 'room');
    matchmaking.value = { ...matchmaking.value, state: 'found' };
    await this.leaveQueue();
  }

  private async onAssigned(playlist: PlaylistId, a: NonNullable<Ticket['assign']>): Promise<void> {
    this.forming = true;
    matchmaking.value = { ...matchmaking.value, state: 'found' };
    await this.leaveQueue();
    if (party.value && this.partyApi.isLeader()) await this.partyApi.setRoom(a.room, 'room');
    void playlist;
    await this.rooms.joinRoom(a.room, { auto: true });
  }

  private async leaveQueue(): Promise<void> {
    const pl = this.playlist;
    this.unsubQueue?.();
    this.unsubQueue = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playlist = null;
    if (pl) {
      const r = ref(this.fb.rtdb, `queue/${pl}/${this.uid}`);
      await onDisconnect(r).cancel().catch(() => {});
      await remove(r).catch(() => {});
    }
    setTimeout(() => {
      if (!this.playlist) matchmaking.value = { ...matchmaking.value, state: 'idle' };
    }, 1500);
  }

  async cancel(): Promise<void> {
    if (!this.playlist) return;
    await this.leaveQueue();
    matchmaking.value = { ...matchmaking.value, state: 'idle' };
    if (party.value && this.partyApi.isLeader()) await this.partyApi.setRoom(null, 'idle');
  }

  stop(): void {
    void this.cancel().catch(() => {});
    this.unsubOffset?.();
  }
}

export function matchmakingError(e: unknown): void {
  pushToast({ title: 'MATCHMAKING', body: (e as Error).message ?? String(e), kind: 'error' });
}
