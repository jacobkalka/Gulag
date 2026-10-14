import { signal } from '@preact/signals';
import type { MatchSummary } from '@/game/view/MatchView';
import { DEFAULT_LOADOUT, levelForXp, sanitizeLoadout, type Loadout } from '@/data/progression';
import type { PlaylistId } from '@/data/playlists';

// Global UI state (signals) and the local profile used when Firebase isn't configured
// or the player is a guest.

export type Screen = 'boot' | 'lobby' | 'match' | 'results';
export type LobbyTab = 'play' | 'loadout' | 'social' | 'stats' | 'settings';

export interface ProfileStats {
  kills: number;
  deaths: number;
  assists: number;
  wins: number;
  losses: number;
  matches: number;
  headshots: number;
  damage: number;
  shots: number;
  hits: number;
  captures: number;
  roundsWon: number;
}

export interface Profile {
  uid: string;
  username: string;
  friendCode: string;
  xp: number;
  loadout: Loadout;
  stats: ProfileStats;
  guest: boolean;
}

export function emptyProfileStats(): ProfileStats {
  return { kills: 0, deaths: 0, assists: 0, wins: 0, losses: 0, matches: 0, headshots: 0, damage: 0, shots: 0, hits: 0, captures: 0, roundsWon: 0 };
}

const PKEY = 'lockdown.profile.v1';

function randomName(): string {
  const a = ['Iron', 'Grim', 'Rust', 'Steel', 'Ash', 'Cell', 'Drift', 'Null', 'Vex', 'Riot', 'Cold', 'Static'];
  const b = ['Fox', 'Warden', 'Inmate', 'Ghost', 'Rook', 'Viper', 'Mole', 'Wolf', 'Crow', 'Shank', 'Lynx', 'Hound'];
  return `${a[Math.floor(Math.random() * a.length)]}${b[Math.floor(Math.random() * b.length)]}${Math.floor(Math.random() * 90 + 10)}`;
}

export function randomFriendCode(): string {
  const al = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += al[Math.floor(Math.random() * al.length)];
  return s;
}

function loadLocalProfile(): Profile {
  try {
    const raw = localStorage.getItem(PKEY);
    if (raw) {
      const p = JSON.parse(raw) as Profile;
      p.stats = { ...emptyProfileStats(), ...(p.stats ?? {}) };
      p.loadout = sanitizeLoadout(p.loadout, levelForXp(p.xp ?? 0).level);
      return p;
    }
  } catch {
    /* ignore */
  }
  return {
    uid: `local-${Math.random().toString(36).slice(2, 10)}`,
    username: randomName(),
    friendCode: randomFriendCode(),
    xp: 0,
    loadout: { ...DEFAULT_LOADOUT, tactical: 'none' },
    stats: emptyProfileStats(),
    guest: true,
  };
}

export const screen = signal<Screen>('boot');
export const lobbyTab = signal<LobbyTab>('play');
export const paused = signal(false);
export const profile = signal<Profile>(loadLocalProfile());
export const lastSummary = signal<MatchSummary | null>(null);
export const selectedPlaylist = signal<PlaylistId>('1v1');
export const loading = signal<{ progress: number; label: string }>({ progress: 0, label: 'Starting' });

export interface Toast {
  id: number;
  title: string;
  body?: string;
  kind?: 'info' | 'invite' | 'error' | 'success';
  actions?: { label: string; onClick: () => void; primary?: boolean }[];
  ttl?: number;
}
export const toasts = signal<Toast[]>([]);
let toastId = 1;
export function pushToast(t: Omit<Toast, 'id'>): number {
  const id = toastId++;
  toasts.value = [...toasts.value, { ...t, id }];
  const ttl = t.ttl ?? (t.actions ? 15000 : 4500);
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
  return id;
}
export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

let loadoutSaver: ((l: Loadout) => Promise<void>) | null = null;

/** Installed by the online backend: loadouts are stored in the Firestore profile. */
export function setLoadoutSaver(fn: ((l: Loadout) => Promise<void>) | null): void {
  loadoutSaver = fn;
}

/** Persist the local profile (offline mode only; online profiles live in Firestore). */
export function saveLocalProfile(p: Profile): void {
  profile.value = p;
  if (loadoutSaver) return;
  try {
    localStorage.setItem(PKEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Equips a loadout (anything not unlocked is replaced) and saves it. */
export async function updateLoadout(l: Loadout): Promise<void> {
  const p = profile.value;
  const clean = sanitizeLoadout(l, levelForXp(p.xp).level);
  profile.value = { ...p, loadout: clean };
  if (loadoutSaver) await loadoutSaver(clean);
  else saveLocalProfile(profile.value);
}
