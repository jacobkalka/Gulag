// Signaling: how peers find a room host and exchange WebRTC offers/answers/ICE candidates.
// Implementations: BroadcastChannel (same browser, for local testing and offline play between
// tabs) and Firebase Realtime Database (internet play; see firebaseSignaling.ts).

export interface SignalEnvelope {
  from: string;
  to: string;
  kind: 'offer' | 'answer' | 'ice' | 'bye';
  data?: unknown;
}

export interface RoomInfo {
  code: string;
  hostId: string;
  hostName: string;
  playlist: string;
  players: number;
  capacity: number;
  version: number;
}

export interface Signaling {
  /** This peer's id (also its identity on the host side). */
  readonly selfId: string;
  /** Short label for UI/diagnostics ('local' or 'online'). */
  readonly kind: 'local' | 'online';
  /** Host: claim a room code. Rejects if the code is already in use. */
  hostRoom(info: RoomInfo): Promise<void>;
  /** Host: update the public room info (player count etc.). */
  updateRoom(info: Partial<RoomInfo>): void;
  /** Host: release the room code. */
  closeRoom(): void;
  /** Client: look up the host of a room code. */
  findRoom(code: string): Promise<RoomInfo | null>;
  send(to: string, kind: SignalEnvelope['kind'], data?: unknown): void;
  /** Subscribes to signals addressed to this peer. Returns an unsubscribe function. */
  subscribe(fn: (env: SignalEnvelope) => void): () => void;
  dispose(): void;
}

export function randomPeerId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

type BcMsg =
  | { type: 'find'; code: string; from: string; nonce: string }
  | { type: 'found'; to: string; nonce: string; info: RoomInfo }
  | { type: 'signal'; env: SignalEnvelope };

/** Same-origin, same-browser signaling over BroadcastChannel (tabs on one machine). */
export class BroadcastSignaling implements Signaling {
  readonly kind = 'local' as const;
  private ch: BroadcastChannel;
  private hosted: RoomInfo | null = null;
  private subs = new Set<(env: SignalEnvelope) => void>();
  private finds = new Map<string, (info: RoomInfo) => void>();

  constructor(readonly selfId: string = randomPeerId(), channel = 'lockdown-signal-v1') {
    this.ch = new BroadcastChannel(channel);
    this.ch.onmessage = (e) => this.handle(e.data as BcMsg);
  }

  private handle(m: BcMsg): void {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'find') {
      if (this.hosted && this.hosted.code === m.code) this.ch.postMessage({ type: 'found', to: m.from, nonce: m.nonce, info: this.hosted } satisfies BcMsg);
    } else if (m.type === 'found') {
      if (m.to === this.selfId) this.finds.get(m.nonce)?.(m.info);
    } else if (m.type === 'signal') {
      if (m.env.to === this.selfId) for (const s of this.subs) s(m.env);
    }
  }

  async hostRoom(info: RoomInfo): Promise<void> {
    const existing = await this.findRoom(info.code, 250);
    if (existing) throw new Error('Room code already in use');
    this.hosted = { ...info, hostId: this.selfId };
  }

  updateRoom(info: Partial<RoomInfo>): void {
    if (this.hosted) this.hosted = { ...this.hosted, ...info };
  }

  closeRoom(): void {
    this.hosted = null;
  }

  findRoom(code: string, timeoutMs = 1200): Promise<RoomInfo | null> {
    const nonce = randomPeerId();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.finds.delete(nonce);
        resolve(null);
      }, timeoutMs);
      this.finds.set(nonce, (info) => {
        clearTimeout(t);
        this.finds.delete(nonce);
        resolve(info);
      });
      this.ch.postMessage({ type: 'find', code, from: this.selfId, nonce } satisfies BcMsg);
    });
  }

  send(to: string, kind: SignalEnvelope['kind'], data?: unknown): void {
    this.ch.postMessage({ type: 'signal', env: { from: this.selfId, to, kind, data } } satisfies BcMsg);
  }

  subscribe(fn: (env: SignalEnvelope) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  dispose(): void {
    this.hosted = null;
    this.subs.clear();
    this.ch.close();
  }
}
