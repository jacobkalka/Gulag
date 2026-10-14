// Playlists and match rules. Team size is free-form; add a 4v4/5v5 entry here and the
// matchmaker, spawn system and HUD scale with it.

export type PlaylistId = '1v1' | '2v2' | '3v3' | '4v4';

export interface MatchRules {
  teamSize: number;
  roundsToWin: number;
  /** Seconds of regular play before overtime. */
  roundTime: number;
  countdown: number;
  roundEndDelay: number;
  /** Overtime ends after this many seconds: the team with more players alive (then more health) wins. */
  overtimeLimit: number;
  /** Seconds a single player needs on the flag to capture it. */
  captureTime: number;
  captureRadius: number;
  spawnProtection: number;
  /** Health regeneration delay and rate. */
  regenDelay: number;
  regenRate: number;
  /** Map tags to activate (e.g. shutters that tighten the arena for 1v1). */
  mapTags: string[];
  friendlyFire: boolean;
  /** Allow changing loadout during the countdown between rounds. */
  loadoutBetweenRounds: boolean;
}

export interface Playlist {
  id: PlaylistId;
  name: string;
  description: string;
  rules: MatchRules;
}

const base: Omit<MatchRules, 'teamSize' | 'roundsToWin' | 'mapTags'> = {
  roundTime: 90,
  countdown: 4,
  overtimeLimit: 45,
  roundEndDelay: 4.5,
  captureTime: 5,
  captureRadius: 2.5,
  spawnProtection: 3,
  regenDelay: 4.5,
  regenRate: 30,
  friendlyFire: false,
  loadoutBetweenRounds: true,
};

export const PLAYLISTS: Record<PlaylistId, Playlist> = {
  '1v1': {
    id: '1v1',
    name: 'Duel',
    description: '1v1. Best of 3. Side rooms sealed for a tighter fight.',
    rules: { ...base, teamSize: 1, roundsToWin: 2, mapTags: ['shutter1v1'], roundTime: 75 },
  },
  '2v2': {
    id: '2v2',
    name: 'Doubles',
    description: '2v2. First to 3 rounds.',
    rules: { ...base, teamSize: 2, roundsToWin: 3, mapTags: [] },
  },
  '3v3': {
    id: '3v3',
    name: 'Squads',
    description: '3v3. First to 3 rounds.',
    rules: { ...base, teamSize: 3, roundsToWin: 3, mapTags: [] },
  },
  '4v4': {
    id: '4v4',
    name: 'Riot',
    description: '4v4. First to 3 rounds. Full map.',
    rules: { ...base, teamSize: 4, roundsToWin: 3, mapTags: [], roundTime: 100 },
  },
};

export const PLAYLIST_ORDER: PlaylistId[] = ['1v1', '2v2', '3v3', '4v4'];
