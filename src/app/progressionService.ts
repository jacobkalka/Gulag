import { computeMatchXp, levelForXp, unlocksBetween, type Unlock, type XpLine } from '@/data/progression';
import type { MatchSummary } from '@/game/view/MatchView';
import { profile, saveLocalProfile, type Profile } from './state';

// Applies a finished match to the player's profile (XP, stats). For signed-in players the
// backend replaces `persist` with a Firestore claim validated by security rules.

export interface MatchAward {
  lines: XpLine[];
  total: number;
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  unlocks: Unlock[];
  won: boolean;
}

/**
 * Saves a match result. Local mode stores the computed profile; the online backend claims XP
 * from the host's match record instead and returns the award actually granted (the UI then
 * shows that), or null when nothing could be claimed.
 */
export type PersistFn = (p: Profile, award: MatchAward, summary: MatchSummary) => Promise<MatchAward | null | void>;

let persist: PersistFn = async (p) => saveLocalProfile(p);
let online = false;

export function setProfilePersistence(fn: PersistFn, isOnline = false): void {
  persist = fn;
  online = isOnline;
}

export function computeAward(summary: MatchSummary, botMatch: boolean, xpBefore: number): MatchAward {
  const lp = summary.local;
  const won = summary.winner >= 0 && summary.winner === summary.localTeam;
  const base = computeMatchXp({
    kills: lp?.stats.kills ?? 0,
    headshots: lp?.stats.headshots ?? 0,
    assists: lp?.stats.assists ?? 0,
    captures: lp?.stats.captures ?? 0,
    damage: lp?.stats.damage ?? 0,
    roundsWon: lp?.stats.roundsWon ?? 0,
    won,
    completed: true,
  });
  // practice against bots pays half
  const mul = botMatch ? 0.5 : 1;
  const lines = base.lines.map((l) => ({ ...l, xp: Math.round(l.xp * mul) }));
  if (botMatch) lines.push({ label: 'Practice match (50%)', count: 0, xp: 0 });
  const total = Math.round(base.total * mul);
  const xpAfter = xpBefore + total;
  const lb = levelForXp(xpBefore).level;
  const la = levelForXp(xpAfter).level;
  return { lines, total, xpBefore, xpAfter, levelBefore: lb, levelAfter: la, unlocks: unlocksBetween(lb, la), won };
}

export async function awardMatch(summary: MatchSummary, botMatch: boolean): Promise<MatchAward> {
  const p = profile.value;
  const award = computeAward(summary, botMatch, p.xp);
  if (online) {
    // the profile listener applies the validated result; show what was actually granted
    try {
      const granted = await persist(p, award, summary);
      if (granted) return granted;
    } catch (e) {
      console.warn('XP claim failed', e);
    }
    return { ...award, lines: [{ label: 'No XP recorded (host left or match too short)', count: 0, xp: 0 }], total: 0, xpAfter: p.xp, levelAfter: award.levelBefore, unlocks: [] };
  }
  const lp = summary.local;
  const st = { ...p.stats };
  if (lp) {
    st.kills += lp.stats.kills;
    st.deaths += lp.stats.deaths;
    st.assists += lp.stats.assists;
    st.headshots += lp.stats.headshots;
    st.damage += lp.stats.damage;
    st.shots += lp.stats.shots;
    st.hits += lp.stats.hits;
    st.captures += lp.stats.captures;
    st.roundsWon += lp.stats.roundsWon;
  }
  st.matches += 1;
  if (award.won) st.wins += 1;
  else st.losses += 1;
  const next: Profile = { ...p, xp: award.xpAfter, stats: st };
  profile.value = next;
  try {
    await persist(next, award, summary);
  } catch (e) {
    console.warn('Failed to persist match result', e);
  }
  return award;
}
