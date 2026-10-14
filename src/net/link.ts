// Transport abstraction: a connection to one remote peer with an unreliable/unordered
// binary channel and a reliable/ordered JSON channel. Implemented by WebRTC (PeerLink)
// and by an in-memory simulated network for tests (LoopbackLink).

export interface Link {
  /** Remote peer id. */
  readonly id: string;
  readonly open: boolean;
  sendU(data: Uint8Array): void;
  sendR(msg: unknown): void;
  onU: ((data: Uint8Array) => void) | null;
  onR: ((msg: unknown) => void) | null;
  onClose: ((reason: string) => void) | null;
  close(reason?: string): void;
}

export interface NetConditions {
  /** One-way latency in ms. */
  latency: number;
  /** Uniform random extra delay 0..jitter ms (unreliable channel may reorder). */
  jitter: number;
  /** Packet loss probability on the unreliable channel. */
  loss: number;
}

/** Virtual clock + delivery queue shared by loopback links (deterministic tests). */
export class SimNetwork {
  now = 0;
  private queue: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  private rngState: number;

  constructor(seed = 1) {
    this.rngState = seed >>> 0 || 1;
  }

  random(): number {
    // xorshift32
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  schedule(delayMs: number, fn: () => void): void {
    this.queue.push({ at: this.now + delayMs, seq: this.seq++, fn });
  }

  /** Advances virtual time, delivering everything due. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (q.at > end) continue;
        if (best < 0 || q.at < this.queue[best].at || (q.at === this.queue[best].at && q.seq < this.queue[best].seq)) best = i;
      }
      if (best < 0) break;
      const item = this.queue.splice(best, 1)[0];
      this.now = Math.max(this.now, item.at);
      item.fn();
    }
    this.now = end;
  }
}

export class LoopbackLink implements Link {
  onU: ((data: Uint8Array) => void) | null = null;
  onR: ((msg: unknown) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  peer!: LoopbackLink;
  open = true;
  /** Reliable messages keep order: each is delivered no earlier than the previous one. */
  private lastReliableAt = 0;
  bytesSent = 0;
  packetsSent = 0;

  constructor(
    readonly id: string,
    private net: SimNetwork,
    public cond: NetConditions,
  ) {}

  static pair(net: SimNetwork, aId: string, bId: string, cond: NetConditions): [LoopbackLink, LoopbackLink] {
    // a's peer id is b and vice versa
    const a = new LoopbackLink(bId, net, cond);
    const b = new LoopbackLink(aId, net, cond);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  sendU(data: Uint8Array): void {
    if (!this.open) return;
    this.bytesSent += data.byteLength;
    this.packetsSent++;
    if (this.net.random() < this.cond.loss) return;
    const copy = data.slice();
    const delay = this.cond.latency + this.net.random() * this.cond.jitter;
    this.net.schedule(delay, () => {
      if (this.peer.open) this.peer.onU?.(copy);
    });
  }

  sendR(msg: unknown): void {
    if (!this.open) return;
    const json = JSON.stringify(msg);
    this.bytesSent += json.length;
    const at = Math.max(this.net.now + this.cond.latency + this.net.random() * this.cond.jitter, this.lastReliableAt);
    this.lastReliableAt = at;
    this.net.schedule(at - this.net.now, () => {
      if (this.peer.open) this.peer.onR?.(JSON.parse(json));
    });
  }

  close(reason = 'closed'): void {
    if (!this.open) return;
    this.open = false;
    this.onClose?.(reason);
    const peer = this.peer;
    this.net.schedule(this.cond.latency, () => {
      if (!peer.open) return;
      peer.open = false;
      peer.onClose?.('peer closed');
    });
  }
}
