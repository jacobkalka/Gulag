import { signal } from '@preact/signals';
import type { PlaylistId } from '@/data/playlists';
import type { ChatLine } from '@/net/protocol';

// UI-facing state for accounts, friends, parties and matchmaking. The Firebase backend
// (src/backend) fills these in and installs the `social` API; without Firebase they stay
// empty and the UI shows offline/guest states.

export type PresenceState = 'online' | 'offline' | 'lobby' | 'room' | 'queue' | 'match';

export interface AccountInfo {
  uid: string;
  anonymous: boolean;
  provider: 'anonymous' | 'google' | 'password';
  email?: string;
}

export const account = signal<AccountInfo | null>(null);
export const backendState = signal<'offline' | 'connecting' | 'online' | 'error'>('offline');
export const backendError = signal('');

export interface FriendView {
  pair: string;
  uid: string;
  name: string;
  level: number;
  status: 'friend' | 'incoming' | 'outgoing';
  presence: PresenceState;
  party?: string;
}
export const friends = signal<FriendView[]>([]);

export interface PartyMember {
  uid: string;
  name: string;
  seat: string;
  presence: PresenceState;
}
export interface PartyView {
  id: string;
  leader: string;
  members: PartyMember[];
  state: 'idle' | 'queue' | 'room';
  playlist: PlaylistId;
  room?: string;
}
export const party = signal<PartyView | null>(null);
export const partyChat = signal<ChatLine[]>([]);

export interface MatchmakingView {
  state: 'idle' | 'searching' | 'found';
  playlist: PlaylistId;
  since: number;
  /** Players currently queued in this playlist (including you). */
  queued: number;
  needed: number;
}
export const matchmaking = signal<MatchmakingView>({ state: 'idle', playlist: '2v2', since: 0, queued: 0, needed: 0 });

export interface SocialApi {
  signInWithGoogle(): Promise<void>;
  signInWithEmail(email: string, password: string, create: boolean): Promise<void>;
  signOut(): Promise<void>;
  rename(name: string): Promise<void>;
  addFriend(codeOrName: string): Promise<void>;
  acceptFriend(pair: string): Promise<void>;
  removeFriend(pair: string): Promise<void>;
  createParty(): Promise<string>;
  invite(uid: string): Promise<void>;
  joinParty(pid: string): Promise<void>;
  leaveParty(): Promise<void>;
  kickFromParty(uid: string): Promise<void>;
  sendPartyChat(text: string): Promise<void>;
  setPartyPlaylist(id: PlaylistId): Promise<void>;
  findMatch(playlist: PlaylistId): Promise<void>;
  cancelMatchmaking(): Promise<void>;
}

export const social = signal<SocialApi | null>(null);
