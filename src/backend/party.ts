import {
  get,
  limitToLast,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  query,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
  type Unsubscribe,
} from 'firebase/database';
import type { PlaylistId } from '@/data/playlists';
import { party, partyChat, type PartyView, type PresenceState } from '@/app/social';
import { profile, pushToast, selectedPlaylist } from '@/app/state';
import { doc, getDoc } from 'firebase/firestore';
import { levelForXp } from '@/data/progression';
import type { Fb } from './firebase';

// Parties live in the Realtime Database (ephemeral, presence-aware):
//   /parties/{pid}    leader, state, playlist, room code, four seats, members
//   /invites/{to}/{from}
//   /partyChat/{pid}/{push}
// When the leader opens a room (private or matchmade) the code is published on the party
// and every member's client joins it automatically.

const SEATS = ['s0', 's1', 's2', 's3'];

interface PartyDoc {
  leader: string;
  state: 'idle' | 'queue' | 'room';
  playlist: PlaylistId;
  room?: string;
  seats?: Record<string, string>;
  members?: Record<string, { name: string; seat: string; ts: number }>;
}

export class PartyService {
  pid: string | null = null;
  private seat = '';
  private unsubParty: Unsubscribe | null = null;
  private unsubChat: Unsubscribe | null = null;
  private unsubInvites: Unsubscribe | null = null;
  private memberPresence = new Map<string, Unsubscribe>();
  private presence = new Map<string, PresenceState>();
  private memberInfo = new Map<string, { primary: string; level: number }>();
  private lastRoom = '';
  private leaving = false;
  private doc: PartyDoc | null = null;
  /** A member learns the room code the leader opened. */
  onRoomCode: ((code: string) => void) | null = null;
  /** Party id changed (presence shows it to friends). */
  onPartyChange: ((pid: string | null) => void) | null = null;

  constructor(
    private fb: Fb,
    private uid: string,
  ) {}

  start(): void {
    const seen = new Set<string>();
    this.unsubInvites = onValue(ref(this.fb.rtdb, `invites/${this.uid}`), (snap) => {
      const v = (snap.val() ?? {}) as Record<string, { party: string; fromName: string; ts: number }>;
      for (const [from, inv] of Object.entries(v)) {
        const key = `${from}:${inv.party}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const clear = () => void remove(ref(this.fb.rtdb, `invites/${this.uid}/${from}`)).catch(() => {});
        if (Date.now() - (inv.ts ?? 0) > 10 * 60_000 || inv.party === this.pid) {
          clear();
          continue;
        }
        pushToast({
          title: 'PARTY INVITE',
          body: `${inv.fromName} invited you to their party`,
          kind: 'invite',
          ttl: 30_000,
          actions: [
            {
              label: 'JOIN',
              primary: true,
              onClick: () => {
                clear();
                void this.join(inv.party).catch((e) => pushToast({ title: 'COULD NOT JOIN PARTY', body: (e as Error).message, kind: 'error' }));
              },
            },
            { label: 'DECLINE', onClick: clear },
          ],
        });
      }
    });
  }

  get isLeader(): boolean {
    return !!this.doc && this.doc.leader === this.uid;
  }

  async create(): Promise<string> {
    if (this.pid) return this.pid;
    const r = push(ref(this.fb.rtdb, 'parties'));
    const pid = r.key!;
    await set(r, {
      leader: this.uid,
      state: 'idle',
      playlist: selectedPlaylist.value,
      ts: serverTimestamp(),
      seats: { s0: this.uid },
      members: { [this.uid]: { name: profile.value.username.slice(0, 16), seat: 's0', ts: serverTimestamp() } },
    });
    await onDisconnect(r).remove();
    this.seat = 's0';
    this.watch(pid);
    return pid;
  }

  async invite(friendUid: string): Promise<void> {
    const pid = await this.create();
    await set(ref(this.fb.rtdb, `invites/${friendUid}/${this.uid}`), { party: pid, fromName: profile.value.username.slice(0, 16), ts: serverTimestamp() });
  }

  async join(pid: string): Promise<void> {
    if (this.pid === pid) return;
    if (this.pid) await this.leave();
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await get(ref(this.fb.rtdb, `parties/${pid}`));
      const d = snap.val() as PartyDoc | null;
      if (!d) throw new Error('That party no longer exists');
      const taken = new Set(Object.keys(d.seats ?? {}));
      const seat = SEATS.find((s) => !taken.has(s));
      if (!seat) throw new Error('That party is full');
      try {
        await update(ref(this.fb.rtdb, `parties/${pid}`), {
          [`seats/${seat}`]: this.uid,
          [`members/${this.uid}`]: { name: profile.value.username.slice(0, 16), seat, ts: serverTimestamp() },
        });
      } catch {
        continue; // seat raced away: try another
      }
      await onDisconnect(ref(this.fb.rtdb, `parties/${pid}`)).update({ [`seats/${seat}`]: null, [`members/${this.uid}`]: null });
      this.seat = seat;
      this.watch(pid);
      return;
    }
    throw new Error('Could not join the party');
  }

  async leave(): Promise<void> {
    const pid = this.pid;
    const d = this.doc;
    if (!pid) return;
    this.leaving = true;
    const r = ref(this.fb.rtdb, `parties/${pid}`);
    await onDisconnect(r).cancel().catch(() => {});
    try {
      if (d && d.leader === this.uid) {
        const others = Object.keys(d.members ?? {}).filter((u) => u !== this.uid);
        if (others.length) {
          // hand the party to the next member
          await update(r, { leader: others[0], [`members/${this.uid}`]: null, [`seats/${this.seat}`]: null });
        } else {
          await remove(ref(this.fb.rtdb, `partyChat/${pid}`)).catch(() => {});
          await remove(r);
        }
      } else {
        await update(r, { [`members/${this.uid}`]: null, [`seats/${this.seat}`]: null });
      }
    } finally {
      this.unwatch();
      this.leaving = false;
    }
  }

  async kick(uid: string): Promise<void> {
    const d = this.doc;
    if (!this.pid || !d || d.leader !== this.uid || uid === this.uid) return;
    const seat = d.members?.[uid]?.seat;
    await update(ref(this.fb.rtdb, `parties/${this.pid}`), { [`members/${uid}`]: null, ...(seat ? { [`seats/${seat}`]: null } : {}) });
  }

  async setPlaylist(id: PlaylistId): Promise<void> {
    if (this.pid && this.isLeader) await update(ref(this.fb.rtdb, `parties/${this.pid}`), { playlist: id });
  }

  /** Leader: publish the room everyone should be in (or clear it). */
  async setRoom(code: string | null, state: PartyDoc['state'] = code ? 'room' : 'idle'): Promise<void> {
    if (!this.pid || !this.isLeader) return;
    await update(ref(this.fb.rtdb, `parties/${this.pid}`), { room: code, state });
  }

  async chat(text: string): Promise<void> {
    if (!this.pid) return;
    const t = text.trim().slice(0, 140);
    if (!t) return;
    await push(ref(this.fb.rtdb, `partyChat/${this.pid}`), { uid: this.uid, name: profile.value.username.slice(0, 16), text: t, ts: serverTimestamp() });
  }

  private watch(pid: string): void {
    this.unwatch();
    this.pid = pid;
    this.onPartyChange?.(pid);
    partyChat.value = [];
    this.unsubParty = onValue(ref(this.fb.rtdb, `parties/${pid}`), (snap) => {
      const d = snap.val() as PartyDoc | null;
      if (!d || !d.members?.[this.uid]) {
        // dissolved or kicked
        if (!this.leaving) pushToast({ title: d ? 'REMOVED FROM PARTY' : 'PARTY DISBANDED', kind: 'info' });
        this.unwatch();
        return;
      }
      this.doc = d;
      this.syncMemberPresence(Object.keys(d.members));
      this.publish();
      if (d.leader !== this.uid && d.room && d.room !== this.lastRoom) {
        this.lastRoom = d.room;
        this.onRoomCode?.(d.room);
      }
      if (!d.room) this.lastRoom = '';
    });
    this.unsubChat = onChildAdded(query(ref(this.fb.rtdb, `partyChat/${pid}`), limitToLast(50)), (snap) => {
      const v = snap.val() as { uid: string; name: string; text: string };
      partyChat.value = [...partyChat.value.slice(-60), { from: v.uid, name: v.name, text: v.text }];
    });
  }

  private syncMemberPresence(uids: string[]): void {
    for (const [uid, off] of this.memberPresence) {
      if (!uids.includes(uid)) {
        off();
        this.memberPresence.delete(uid);
      }
    }
    for (const uid of uids) {
      if (!this.memberInfo.has(uid)) {
        this.memberInfo.set(uid, { primary: 'halberd', level: 1 });
        void getDoc(doc(this.fb.db, 'users', uid))
          .then((d) => {
            const x = d.data();
            if (x) this.memberInfo.set(uid, { primary: x.loadout?.primary ?? 'halberd', level: levelForXp(x.xp ?? 0).level });
            this.publish();
          })
          .catch(() => {});
      }
      if (this.memberPresence.has(uid)) continue;
      this.memberPresence.set(
        uid,
        onValue(ref(this.fb.rtdb, `status/${uid}`), (s) => {
          this.presence.set(uid, ((s.val() as { state?: PresenceState } | null)?.state ?? 'offline') as PresenceState);
          this.publish();
        }),
      );
    }
  }

  private publish(): void {
    const d = this.doc;
    if (!d || !this.pid) {
      party.value = null;
      return;
    }
    const view: PartyView = {
      id: this.pid,
      leader: d.leader,
      state: d.state,
      playlist: d.playlist,
      room: d.room,
      members: Object.entries(d.members ?? {})
        .map(([uid, m]) => ({
          uid,
          name: m.name,
          seat: m.seat,
          presence: this.presence.get(uid) ?? 'online',
          primary: this.memberInfo.get(uid)?.primary,
          level: this.memberInfo.get(uid)?.level,
        }))
        .sort((a, b) => a.seat.localeCompare(b.seat)),
    };
    party.value = view;
  }

  private unwatch(): void {
    this.unsubParty?.();
    this.unsubChat?.();
    this.unsubParty = this.unsubChat = null;
    for (const off of this.memberPresence.values()) off();
    this.memberPresence.clear();
    const had = this.pid;
    this.pid = null;
    this.doc = null;
    this.seat = '';
    this.lastRoom = '';
    party.value = null;
    partyChat.value = [];
    if (had) this.onPartyChange?.(null);
  }

  stop(): void {
    void this.leave().catch(() => {});
    this.unsubInvites?.();
    this.unsubInvites = null;
  }
}
