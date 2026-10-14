import { get, onChildAdded, onDisconnect, push, ref, remove, runTransaction, serverTimestamp, update, type Unsubscribe } from 'firebase/database';
import type { RoomInfo, SignalEnvelope, Signaling } from '@/net/signaling';
import type { Fb } from './firebase';

// WebRTC signaling over the Realtime Database:
//   /rooms/{code}          public room info, claimed atomically by the host (removed on disconnect)
//   /signals/{uid}/{push}  per-user inbox of offers/answers/ICE candidates (consumed on read)

export class FirebaseSignaling implements Signaling {
  readonly kind = 'online' as const;
  private subs = new Set<(env: SignalEnvelope) => void>();
  private unsubInbox: Unsubscribe | null = null;
  private hostedCode = '';

  constructor(
    private fb: Fb,
    readonly selfId: string,
  ) {
    const inbox = ref(fb.rtdb, `signals/${selfId}`);
    // stale messages from a previous session are useless: clear the inbox first
    void remove(inbox)
      .catch(() => {})
      .then(() => {
        this.unsubInbox = onChildAdded(inbox, (snap) => {
          const v = snap.val() as { from: string; kind: SignalEnvelope['kind']; data?: string; ts?: number } | null;
          void remove(snap.ref).catch(() => {});
          if (!v || typeof v.from !== 'string') return;
          let data: unknown;
          try {
            data = v.data ? JSON.parse(v.data) : undefined;
          } catch {
            return;
          }
          const env: SignalEnvelope = { from: v.from, to: this.selfId, kind: v.kind, data };
          for (const s of this.subs) s(env);
        });
      });
  }

  async hostRoom(info: RoomInfo): Promise<void> {
    const r = ref(this.fb.rtdb, `rooms/${info.code}`);
    const res = await runTransaction(r, (cur) => (cur ? undefined : { ...info, hostId: this.selfId, hostName: info.hostName.slice(0, 16), ts: Date.now() }), {
      applyLocally: false,
    });
    if (!res.committed) throw new Error('Room code already in use');
    this.hostedCode = info.code;
    await onDisconnect(r).remove();
  }

  updateRoom(info: Partial<RoomInfo>): void {
    if (!this.hostedCode) return;
    const patch: Record<string, unknown> = {};
    for (const k of ['players', 'capacity', 'playlist'] as const) if (info[k] !== undefined) patch[k] = info[k];
    if (Object.keys(patch).length) void update(ref(this.fb.rtdb, `rooms/${this.hostedCode}`), patch).catch(() => {});
  }

  closeRoom(): void {
    if (!this.hostedCode) return;
    const r = ref(this.fb.rtdb, `rooms/${this.hostedCode}`);
    this.hostedCode = '';
    void onDisconnect(r).cancel();
    void remove(r).catch(() => {});
  }

  async findRoom(code: string): Promise<RoomInfo | null> {
    const snap = await get(ref(this.fb.rtdb, `rooms/${code}`));
    return snap.exists() ? (snap.val() as RoomInfo) : null;
  }

  send(to: string, kind: SignalEnvelope['kind'], data?: unknown): void {
    const msg: Record<string, unknown> = { from: this.selfId, kind, ts: serverTimestamp() };
    if (data !== undefined) msg.data = JSON.stringify(data);
    void push(ref(this.fb.rtdb, `signals/${to}`), msg).catch((e) => console.warn('signal send failed', e));
  }

  subscribe(fn: (env: SignalEnvelope) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /**
   * Rooms come and go but this instance (and its inbox listener) is shared for the whole
   * session; subscribers unsubscribe themselves, room codes are released by closeRoom().
   */
  dispose(): void {}

  /** Tears down the inbox listener (sign-out). */
  shutdown(): void {
    this.closeRoom();
    this.subs.clear();
    this.unsubInbox?.();
    this.unsubInbox = null;
  }
}
