import { onDisconnect, onValue, ref, serverTimestamp, set, type Unsubscribe } from 'firebase/database';
import type { PresenceState } from '@/app/social';
import type { Fb } from './firebase';

// Realtime presence: /status/{uid} is set while connected and flipped to offline by the
// server when the connection drops (onDisconnect).

export class PresenceService {
  private state: PresenceState = 'lobby';
  private partyId = '';
  private name = '';
  private uid = '';
  private unsubConn: Unsubscribe | null = null;

  constructor(private fb: Fb) {}

  start(uid: string, name: string): void {
    this.uid = uid;
    this.name = name;
    this.unsubConn?.();
    this.unsubConn = onValue(ref(this.fb.rtdb, '.info/connected'), (snap) => {
      if (snap.val() !== true) return;
      const r = ref(this.fb.rtdb, `status/${uid}`);
      void onDisconnect(r)
        .set({ state: 'offline', ts: serverTimestamp(), name: this.name })
        .then(() => this.push());
    });
  }

  set(state: PresenceState, opts: { party?: string; name?: string } = {}): void {
    this.state = state;
    if (opts.party !== undefined) this.partyId = opts.party;
    if (opts.name) this.name = opts.name;
    this.push();
  }

  private push(): void {
    if (!this.uid) return;
    const v: Record<string, unknown> = { state: this.state, ts: serverTimestamp(), name: this.name.slice(0, 16) };
    if (this.partyId) v.party = this.partyId;
    set(ref(this.fb.rtdb, `status/${this.uid}`), v).catch((e) => console.warn('presence', e));
  }

  stop(): void {
    this.unsubConn?.();
    this.unsubConn = null;
    if (this.uid) void set(ref(this.fb.rtdb, `status/${this.uid}`), { state: 'offline', ts: serverTimestamp(), name: this.name }).catch(() => {});
  }
}
