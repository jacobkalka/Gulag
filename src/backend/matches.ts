import { doc, onSnapshot, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import type { GameController } from '@/app/GameController';
import { computeMatchXp, levelForXp, unlocksBetween } from '@/data/progression';
import type { MatchAward } from '@/app/progressionService';
import type { Fb } from './firebase';

// Match records and XP claims.
//  - The host writes matches/{id} when a match starts and fills in every human's result at
//    the end (security rules: only the host, not before 30 s, results only for listed humans).
//  - Each human then claims XP for *their* reported result: the profile update and a
//    claims/{matchId} marker are written together and checked by the rules against the record.

interface HostResult {
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  shots: number;
  hits: number;
  captures: number;
  roundsWon: number;
  won: boolean;
}

interface MatchDoc {
  host: string;
  humans: string[];
  state: 'live' | 'done';
  results: Record<string, HostResult>;
}

/** Records matches this browser hosts (solo practice and network rooms). */
export function installMatchRecorder(game: GameController, fb: Fb): void {
  const started = new Set<string>();
  game.matchHooks.push({
    begin(session, meta) {
      const uid = fb.auth.currentUser?.uid;
      if (!uid || !meta.host || !session.matchId) return;
      // in online rooms peer ids are Firebase uids; local-tab rooms have no records
      const humans = meta.pids ? [...new Set(meta.pids.values())] : [uid];
      if (!humans.includes(uid)) return;
      started.add(session.matchId);
      const bots = session.players.filter((p) => p.bot).length;
      setDoc(doc(fb.db, 'matches', session.matchId), {
        host: uid,
        playlist: session.playlistId,
        humans,
        bots,
        state: 'live',
        startedAt: serverTimestamp(),
        endedAt: null,
        results: {},
      }).catch((e) => console.warn('match record failed', e));
    },
    end(session, summary, meta) {
      const uid = fb.auth.currentUser?.uid;
      if (!uid || !meta.host || !session.matchId || !started.has(session.matchId)) return;
      started.delete(session.matchId);
      const results: Record<string, HostResult> = {};
      for (const p of session.players) {
        const pid = meta.pids ? meta.pids.get(p.id) : p.id === session.localId ? uid : undefined;
        if (!pid) continue;
        const s = p.stats;
        results[pid] = {
          kills: s.kills,
          deaths: s.deaths,
          assists: s.assists,
          headshots: s.headshots,
          damage: Math.round(s.damage),
          shots: s.shots,
          hits: s.hits,
          captures: s.captures,
          roundsWon: s.roundsWon,
          won: summary.winner === p.team,
        };
      }
      updateDoc(doc(fb.db, 'matches', session.matchId), { state: 'done', endedAt: serverTimestamp(), results }).catch((e) =>
        console.warn('match result failed', e),
      );
    },
  });
}

function waitForResult(fb: Fb, matchId: string, timeoutMs: number): Promise<MatchDoc | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    const off = onSnapshot(
      doc(fb.db, 'matches', matchId),
      (snap) => {
        const d = snap.data() as MatchDoc | undefined;
        if (d?.state === 'done') {
          clearTimeout(t);
          off();
          resolve(d);
        }
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/**
 * Claims this player's XP for a finished match. Returns the award actually granted (computed
 * from the host's record, which is what the rules check), or null if there is nothing to claim.
 */
export async function claimMatchXp(fb: Fb, matchId: string): Promise<MatchAward | null> {
  const uid = fb.auth.currentUser?.uid;
  if (!uid) return null;
  const m = await waitForResult(fb, matchId, 25_000);
  const r = m?.results?.[uid];
  if (!m || !r) return null;
  const practice = m.humans.length < 2;
  const base = computeMatchXp({ ...r, completed: true });
  const total = practice ? Math.round(base.total * 0.5) : base.total;
  const lines = base.lines.map((l) => ({ ...l, xp: practice ? Math.round(l.xp * 0.5) : l.xp }));
  if (practice) lines.push({ label: 'Practice match (50%)', count: 0, xp: 0 });
  const userRef = doc(fb.db, 'users', uid);
  let xpBefore = 0;
  await runTransaction(fb.db, async (tx) => {
    const snap = await tx.get(userRef);
    const d = snap.data();
    if (!d) throw new Error('no profile');
    if (d.lastClaim === matchId) throw new Error('already claimed');
    xpBefore = d.xp;
    const s = d.stats;
    tx.update(userRef, {
      xp: d.xp + total,
      lastClaim: matchId,
      updatedAt: serverTimestamp(),
      stats: {
        kills: s.kills + r.kills,
        deaths: s.deaths + r.deaths,
        assists: s.assists + r.assists,
        damage: s.damage + r.damage,
        headshots: s.headshots + r.headshots,
        shots: s.shots + r.shots,
        hits: s.hits + r.hits,
        captures: s.captures + r.captures,
        roundsWon: s.roundsWon + r.roundsWon,
        matches: s.matches + 1,
        wins: s.wins + (r.won ? 1 : 0),
        losses: s.losses + (r.won ? 0 : 1),
      },
    });
    tx.set(doc(userRef, 'claims', matchId), { xp: total, at: serverTimestamp() });
  });
  const lb = levelForXp(xpBefore).level;
  const la = levelForXp(xpBefore + total).level;
  return { lines, total, xpBefore, xpAfter: xpBefore + total, levelBefore: lb, levelAfter: la, unlocks: unlocksBetween(lb, la), won: r.won };
}
