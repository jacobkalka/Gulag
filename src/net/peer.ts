import type { Link } from './link';
import type { Signaling, SignalEnvelope } from './signaling';

// WebRTC transport. Each connection carries two pre-negotiated data channels:
//   id 0 'r'  reliable + ordered   (JSON control messages, game events, chat)
//   id 1 'u'  unreliable + unordered, no retransmits (inputs, snapshots, pings)
// Clients make the offer; the host answers. ICE candidates trickle over the signaling channel.

const CONNECT_TIMEOUT_MS = 15_000;
/** Drop unreliable packets instead of queueing when the SCTP buffer backs up. */
const MAX_U_BUFFER = 64 * 1024;

/**
 * STUN servers are public. A TURN relay is only needed when both players sit behind strict
 * NATs; configure one at build time (see SETUP.md), never commit credentials:
 *   VITE_TURN_URLS=turn:host:3478,turns:host:5349   VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL
 * or VITE_TURN_CREDENTIALS_URL=https://...  (returns an RTCIceServer[] JSON, e.g. Metered/Twilio/
 * Cloudflare credential endpoints).
 */
export async function iceServers(): Promise<RTCIceServer[]> {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const env = import.meta.env;
  if (env.VITE_TURN_URLS) {
    servers.push({
      urls: String(env.VITE_TURN_URLS)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean),
      username: env.VITE_TURN_USERNAME,
      credential: env.VITE_TURN_CREDENTIAL,
    });
  }
  if (env.VITE_TURN_CREDENTIALS_URL) {
    try {
      const res = await fetch(String(env.VITE_TURN_CREDENTIALS_URL));
      const list = (await res.json()) as RTCIceServer[] | { iceServers: RTCIceServer[] };
      servers.push(...(Array.isArray(list) ? list : list.iceServers));
    } catch (e) {
      console.warn('TURN credentials fetch failed; continuing with STUN only', e);
    }
  }
  return servers;
}

export class PeerLink implements Link {
  onU: ((data: Uint8Array) => void) | null = null;
  onR: ((msg: unknown) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  readonly pc: RTCPeerConnection;
  private r: RTCDataChannel;
  private u: RTCDataChannel;
  private closed = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private haveRemote = false;
  private openWaiters: (() => void)[] = [];
  private closeHooks: (() => void)[] = [];

  constructor(
    readonly id: string,
    ice: RTCIceServer[],
    private signaling: Signaling,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ice });
    this.r = this.pc.createDataChannel('r', { negotiated: true, id: 0, ordered: true });
    this.u = this.pc.createDataChannel('u', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    this.u.binaryType = 'arraybuffer';
    this.r.onmessage = (e) => {
      try {
        this.onR?.(JSON.parse(String(e.data)));
      } catch {
        // ignore malformed JSON
      }
    };
    this.u.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onU?.(new Uint8Array(e.data));
    };
    const onOpen = () => {
      if (this.open) for (const w of this.openWaiters.splice(0)) w();
    };
    this.r.onopen = onOpen;
    this.u.onopen = onOpen;
    this.r.onclose = () => this.close('channel closed');
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.send(this.id, 'ice', e.candidate.toJSON());
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed' || st === 'closed') this.close(st === 'failed' ? 'connection failed' : 'closed');
      else if (st === 'disconnected') {
        // transient on network changes; give ICE a few seconds to recover
        this.disconnectTimer ??= setTimeout(() => this.close('connection lost'), 6000);
      } else if (st === 'connected' && this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
    };
  }

  get open(): boolean {
    return !this.closed && this.r.readyState === 'open' && this.u.readyState === 'open';
  }

  /** Internal cleanup that must run however the link closes (owners replace onClose). */
  addCloseHook(fn: () => void): void {
    this.closeHooks.push(fn);
  }

  waitOpen(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error('Connection timed out (a TURN relay may be required on this network)'));
        this.close('timeout');
      }, timeoutMs);
      this.openWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  sendU(data: Uint8Array): void {
    if (this.u.readyState !== 'open' || this.u.bufferedAmount > MAX_U_BUFFER) return;
    this.u.send(data as Uint8Array<ArrayBuffer>);
  }

  sendR(msg: unknown): void {
    if (this.r.readyState !== 'open') return;
    this.r.send(JSON.stringify(msg));
  }

  /** Feeds a signaling message from the remote peer into this connection. */
  async handleSignal(env: SignalEnvelope): Promise<void> {
    if (this.closed) return;
    if (env.kind === 'offer') {
      await this.pc.setRemoteDescription(env.data as RTCSessionDescriptionInit);
      this.haveRemote = true;
      await this.flushIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signaling.send(this.id, 'answer', { type: answer.type, sdp: answer.sdp });
    } else if (env.kind === 'answer') {
      await this.pc.setRemoteDescription(env.data as RTCSessionDescriptionInit);
      this.haveRemote = true;
      await this.flushIce();
    } else if (env.kind === 'ice') {
      if (!this.haveRemote) this.pendingIce.push(env.data as RTCIceCandidateInit);
      else await this.pc.addIceCandidate(env.data as RTCIceCandidateInit).catch(() => {});
    } else if (env.kind === 'bye') {
      this.close('peer closed');
    }
  }

  private async flushIce(): Promise<void> {
    for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
  }

  /** Client side: create and send the offer. */
  async offer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send(this.id, 'offer', { type: offer.type, sdp: offer.sdp });
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    try {
      this.signaling.send(this.id, 'bye');
    } catch {
      // signaling may already be gone
    }
    try {
      this.r.close();
      this.u.close();
      this.pc.close();
    } catch {
      // ignore
    }
    for (const h of this.closeHooks.splice(0)) h();
    this.onClose?.(reason);
  }
}

/** Client: connect to a room host through signaling. Resolves when both channels are open. */
export async function connectToHost(signaling: Signaling, hostId: string): Promise<PeerLink> {
  const link = new PeerLink(hostId, await iceServers(), signaling);
  const off = signaling.subscribe((env) => {
    if (env.from === hostId) void link.handleSignal(env).catch((e) => console.warn('signal error', e));
  });
  link.addCloseHook(off);
  await link.offer();
  try {
    await link.waitOpen();
  } catch (e) {
    off();
    throw e;
  }
  return link;
}

/**
 * Host: accept incoming offers. Each new peer becomes a PeerLink handed to `onLink` once its
 * channels are open. Returns a stop function.
 */
export function acceptPeers(signaling: Signaling, onLink: (link: PeerLink) => void): () => void {
  const links = new Map<string, PeerLink>();
  let ice: RTCIceServer[] | null = null;
  const off = signaling.subscribe((env) => {
    void (async () => {
      let link = links.get(env.from);
      if (env.kind === 'offer') {
        if (link) link.close('replaced');
        ice ??= await iceServers();
        link = new PeerLink(env.from, ice, signaling);
        links.set(env.from, link);
        const l = link;
        l.addCloseHook(() => {
          if (links.get(l.id) === l) links.delete(l.id);
        });
        l.waitOpen()
          .then(() => onLink(l))
          .catch(() => {});
      }
      if (link) await link.handleSignal(env);
    })().catch((e) => console.warn('signal error', e));
  });
  return () => {
    off();
    for (const l of links.values()) if (!l.open) l.close('stopped');
    links.clear();
  };
}
