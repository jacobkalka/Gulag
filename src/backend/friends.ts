import { collection, deleteDoc, doc, getDoc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, type Unsubscribe } from 'firebase/firestore';
import { onValue, ref, type Unsubscribe as RtdbUnsub } from 'firebase/database';
import { levelForXp } from '@/data/progression';
import { friends, type FriendView, type PresenceState } from '@/app/social';
import { profile, pushToast } from '@/app/state';
import type { Fb } from './firebase';

// Friends: Firestore friendships/{a_b} documents (pending -> accepted) plus each friend's
// realtime presence from /status/{uid}.

interface Pair {
  id: string;
  users: [string, string];
  requester: string;
  status: 'pending' | 'accepted';
  names: Record<string, string>;
}

export class FriendsService {
  private pairs = new Map<string, Pair>();
  private unsub: Unsubscribe | null = null;
  private presence = new Map<string, { state: PresenceState; party?: string; name?: string }>();
  private presenceUnsubs = new Map<string, RtdbUnsub>();
  private info = new Map<string, { name: string; level: number }>();
  private initial = true;

  constructor(
    private fb: Fb,
    private uid: string,
  ) {}

  start(): void {
    const q = query(collection(this.fb.db, 'friendships'), where('users', 'array-contains', this.uid));
    this.unsub = onSnapshot(q, (snap) => {
      const next = new Map<string, Pair>();
      for (const d of snap.docs) next.set(d.id, { id: d.id, ...(d.data() as Omit<Pair, 'id'>) });
      // new incoming requests get a toast (not on the initial load)
      if (!this.initial) {
        for (const p of next.values()) {
          if (p.status === 'pending' && p.requester !== this.uid && !this.pairs.has(p.id)) {
            const name = p.names?.[p.requester] ?? 'Someone';
            pushToast({
              title: 'FRIEND REQUEST',
              body: `${name} wants to be friends`,
              kind: 'invite',
              actions: [
                { label: 'ACCEPT', primary: true, onClick: () => void this.accept(p.id) },
                { label: 'DECLINE', onClick: () => void this.remove(p.id) },
              ],
            });
          }
        }
      }
      this.initial = false;
      this.pairs = next;
      this.syncPresence();
      this.publish();
    });
  }

  private other(p: Pair): string {
    return p.users[0] === this.uid ? p.users[1] : p.users[0];
  }

  private syncPresence(): void {
    const want = new Set([...this.pairs.values()].map((p) => this.other(p)));
    for (const [uid, off] of this.presenceUnsubs) {
      if (!want.has(uid)) {
        off();
        this.presenceUnsubs.delete(uid);
      }
    }
    for (const uid of want) {
      if (this.presenceUnsubs.has(uid)) continue;
      this.presenceUnsubs.set(
        uid,
        onValue(ref(this.fb.rtdb, `status/${uid}`), (s) => {
          const v = s.val() as { state?: PresenceState; party?: string; name?: string } | null;
          this.presence.set(uid, { state: v?.state ?? 'offline', party: v?.party, name: v?.name });
          this.publish();
        }),
      );
      if (!this.info.has(uid)) {
        void getDoc(doc(this.fb.db, 'users', uid))
          .then((d) => {
            const x = d.data();
            if (x) this.info.set(uid, { name: x.username, level: levelForXp(x.xp ?? 0).level });
            this.publish();
          })
          .catch(() => {});
      }
    }
  }

  private publish(): void {
    const order: Record<FriendView['status'], number> = { incoming: 0, friend: 1, outgoing: 2 };
    const rank = (s: PresenceState) => (s === 'offline' ? 1 : 0);
    const list: FriendView[] = [...this.pairs.values()].map((p) => {
      const uid = this.other(p);
      const pr = this.presence.get(uid);
      const inf = this.info.get(uid);
      return {
        pair: p.id,
        uid,
        name: pr?.name || inf?.name || p.names?.[uid] || 'Unknown',
        level: inf?.level ?? 1,
        status: p.status === 'accepted' ? 'friend' : p.requester === this.uid ? 'outgoing' : 'incoming',
        presence: pr?.state ?? 'offline',
        party: pr?.party,
      };
    });
    list.sort((a, b) => order[a.status] - order[b.status] || rank(a.presence) - rank(b.presence) || a.name.localeCompare(b.name));
    friends.value = list;
  }

  /** Sends a request by friend code (6 chars) or exact username. */
  async add(input: string): Promise<string> {
    const s = input.trim();
    if (!s) throw new Error('Enter a friend code or name');
    const db = this.fb.db;
    let target: string | null = null;
    if (/^[A-Za-z0-9]{6}$/.test(s)) {
      const c = await getDoc(doc(db, 'friendCodes', s.toUpperCase()));
      if (c.exists()) target = c.data().uid;
    }
    if (!target && /^[A-Za-z0-9_]{3,16}$/.test(s)) {
      const n = await getDoc(doc(db, 'usernames', s.toLowerCase()));
      if (n.exists()) target = n.data().uid;
    }
    if (!target) throw new Error('No player with that code or name');
    if (target === this.uid) throw new Error("That's you");
    const users = [this.uid, target].sort() as [string, string];
    const id = users.join('_');
    const existing = this.pairs.get(id);
    if (existing?.status === 'accepted') throw new Error('Already friends');
    if (existing && existing.requester !== this.uid) {
      await this.accept(id);
      return 'Request accepted';
    }
    if (existing) throw new Error('Request already sent');
    const targetDoc = await getDoc(doc(db, 'users', target));
    const targetName = targetDoc.data()?.username ?? s;
    await setDoc(doc(db, 'friendships', id), {
      users,
      requester: this.uid,
      status: 'pending',
      names: { [this.uid]: profile.value.username, [target]: targetName },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return `Request sent to ${targetName}`;
  }

  async accept(id: string): Promise<void> {
    await updateDoc(doc(this.fb.db, 'friendships', id), { status: 'accepted', updatedAt: serverTimestamp(), [`names.${this.uid}`]: profile.value.username });
  }

  async remove(id: string): Promise<void> {
    await deleteDoc(doc(this.fb.db, 'friendships', id));
  }

  stop(): void {
    this.unsub?.();
    for (const off of this.presenceUnsubs.values()) off();
    this.presenceUnsubs.clear();
    this.pairs.clear();
    friends.value = [];
  }
}
