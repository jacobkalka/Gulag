import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc, deleteDoc, writeBatch, Timestamp, type Firestore } from 'firebase/firestore';
import { LEVEL_XP } from '@/data/progression';

let env: RulesTestEnvironment;

const zero = { kills: 0, deaths: 0, assists: 0, damage: 0, headshots: 0, shots: 0, hits: 0, captures: 0, roundsWon: 0, wins: 0, losses: 0, matches: 0 };
const loadout = { primary: 'halberd', secondary: 'warden', lethal: 'frag', tactical: 'none' };

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-lockdown',
    firestore: { rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
afterAll(async () => env?.cleanup());
beforeEach(async () => env.clearFirestore());

const db = (uid: string | null): Firestore => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore()) as unknown as Firestore;

/** The batched writes the client performs on first sign-in. */
function createProfile(f: Firestore, uid: string, name: string, code: string) {
  const b = writeBatch(f);
  b.set(doc(f, 'users', uid), { username: name, usernameLower: name.toLowerCase(), friendCode: code, xp: 0, loadout, stats: zero, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastClaim: '', lastClaimAt: serverTimestamp() });
  b.set(doc(f, 'usernames', name.toLowerCase()), { uid });
  b.set(doc(f, 'friendCodes', code), { uid });
  return b.commit();
}

/** Seeds data bypassing rules. */
async function seed(fn: (f: Firestore) => Promise<unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx.firestore() as unknown as Firestore);
  });
}

async function seedProfile(uid: string, name: string, code: string, xp = 0, lastClaimAgoMs = 60_000) {
  await seed(async (f) => {
    await setDoc(doc(f, 'users', uid), { username: name, usernameLower: name.toLowerCase(), friendCode: code, xp, loadout, stats: zero, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastClaim: '', lastClaimAt: Timestamp.fromMillis(Date.now() - lastClaimAgoMs) });
    await setDoc(doc(f, 'usernames', name.toLowerCase()), { uid });
    await setDoc(doc(f, 'friendCodes', code), { uid });
  });
}

const result = (o: Partial<Record<string, number | boolean>> = {}) => ({ kills: 3, deaths: 1, assists: 1, headshots: 1, damage: 455, shots: 40, hits: 12, captures: 0, roundsWon: 2, won: true, ...o });
// 3*100 + 25 + 50 + 0 + 2*150 + 500 + 45*2 + 100
const RESULT_XP = 1365;

async function seedMatch(id: string, host: string, humans: string[], results: Record<string, unknown>, state = 'done') {
  await seed((f) => setDoc(doc(f, 'matches', id), { host, playlist: '2v2', humans, bots: 4 - humans.length, state, startedAt: Timestamp.fromMillis(Date.now() - 120_000), endedAt: Timestamp.now(), results }));
}

function claim(f: Firestore, uid: string, mid: string, dxp: number, r: ReturnType<typeof result>, base = { xp: 0, stats: zero }) {
  const b = writeBatch(f);
  const s = base.stats;
  b.update(doc(f, 'users', uid), {
    xp: base.xp + dxp,
    lastClaim: mid,
    lastClaimAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    stats: {
      kills: s.kills + (r.kills as number), deaths: s.deaths + (r.deaths as number), assists: s.assists + (r.assists as number), damage: s.damage + (r.damage as number),
      headshots: s.headshots + (r.headshots as number), shots: s.shots + (r.shots as number), hits: s.hits + (r.hits as number), captures: s.captures + (r.captures as number),
      roundsWon: s.roundsWon + (r.roundsWon as number), matches: s.matches + 1, wins: s.wins + (r.won ? 1 : 0), losses: s.losses + (r.won ? 0 : 1),
    },
  });
  b.set(doc(f, 'users', uid, 'claims', mid), { xp: dxp, at: serverTimestamp() });
  return b.commit();
}

describe('profiles', () => {
  it('a signed-in player creates a profile with a unique name and friend code', async () => {
    await assertSucceeds(createProfile(db('alice'), 'alice', 'Alice_1', 'ABC234'));
  });
  it('signed-out users cannot read profiles', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    await assertFails(getDoc(doc(db(null), 'users', 'alice')));
    await assertSucceeds(getDoc(doc(db('bob'), 'users', 'alice')));
  });
  it('cannot take a username or friend code someone else owns', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    await assertFails(createProfile(db('bob'), 'bob', 'alice', 'XYZ234'));
    await assertFails(createProfile(db('bob'), 'bob', 'Bobby', 'ABC234'));
  });
  it('cannot create a profile with starting XP or for someone else', async () => {
    const f = db('bob');
    const b = writeBatch(f);
    b.set(doc(f, 'users', 'bob'), { username: 'Bob', usernameLower: 'bob', friendCode: 'XYZ234', xp: 99999, loadout, stats: zero, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastClaim: '', lastClaimAt: serverTimestamp() });
    b.set(doc(f, 'usernames', 'bob'), { uid: 'bob' });
    b.set(doc(f, 'friendCodes', 'XYZ234'), { uid: 'bob' });
    await assertFails(b.commit());
    await assertFails(createProfile(db('mallory'), 'bob', 'Bob', 'XYZ234'));
  });
  it('cannot edit XP or stats directly', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { xp: 50000, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { 'stats.kills': 500, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db('bob'), 'users', 'alice'), { loadout, updatedAt: serverTimestamp() }));
  });
  it('loadouts must be unlocked', async () => {
    await seedProfile('alice', 'Alice', 'ABC234', 0);
    await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { loadout: { ...loadout, primary: 'vigil' }, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { loadout: { ...loadout, primary: 'warden' }, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(db('alice'), 'users', 'alice'), { loadout: { ...loadout, primary: 'rook9' }, updatedAt: serverTimestamp() }));
    await seedProfile('bob', 'Bob', 'XYZ234', LEVEL_XP[50]);
    await assertSucceeds(updateDoc(doc(db('bob'), 'users', 'bob'), { loadout: { primary: 'vigil', secondary: 'wasp', lethal: 'frag', tactical: 'flash' }, updatedAt: serverTimestamp() }));
  });
  it('preferences: only a known input mode can be stored', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    const f = db('alice');
    await assertSucceeds(updateDoc(doc(f, 'users', 'alice'), { prefs: { inputMode: 'touchpad' }, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(f, 'users', 'alice'), { prefs: { inputMode: 'mouse' }, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(f, 'users', 'alice'), { prefs: { inputMode: 'aimbot' }, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(f, 'users', 'alice'), { prefs: { inputMode: 'mouse', xp: 9 }, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(f, 'users', 'alice'), { prefs: 'touchpad', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db('bob'), 'users', 'alice'), { prefs: { inputMode: 'mouse' }, updatedAt: serverTimestamp() }));
  });
  it('renaming claims the new name and releases the old one', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    const f = db('alice');
    const b = writeBatch(f);
    b.update(doc(f, 'users', 'alice'), { username: 'Ally', usernameLower: 'ally', updatedAt: serverTimestamp() });
    b.set(doc(f, 'usernames', 'ally'), { uid: 'alice' });
    b.delete(doc(f, 'usernames', 'alice'));
    await assertSucceeds(b.commit());
    // the freed name can be taken by someone else now
    await assertSucceeds(createProfile(db('bob'), 'bob', 'Alice', 'XYZ234'));
  });
});

describe('XP claims against host-reported match records', () => {
  it('a player claims exactly what the host reported, once', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    await seedMatch('m1', 'host1', ['host1', 'alice'], { alice: result(), host1: result({ won: false }) });
    await assertSucceeds(claim(db('alice'), 'alice', 'm1', RESULT_XP, result()));
    // second claim of the same match fails
    const after = { xp: RESULT_XP, stats: { ...zero, kills: 3, deaths: 1, assists: 1, damage: 455, headshots: 1, shots: 40, hits: 12, roundsWon: 2, matches: 1, wins: 1 } };
    await assertFails(claim(db('alice'), 'alice', 'm1', RESULT_XP, result(), after));
    // and a different match right away is rate limited
    await seedMatch('m9', 'host1', ['host1', 'alice'], { alice: result() });
    await assertFails(claim(db('alice'), 'alice', 'm9', RESULT_XP, result(), after));
  });
  it('claims are rate limited per player', async () => {
    await seedProfile('alice', 'Alice', 'ABC234', 0, 5_000);
    await seedMatch('m1', 'host1', ['host1', 'alice'], { alice: result() });
    await assertFails(claim(db('alice'), 'alice', 'm1', RESULT_XP, result()));
  });
  it('rejects claims above the formula, inflated stats or unfinished matches', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    await seedMatch('m1', 'host1', ['host1', 'alice'], { alice: result() });
    await assertFails(claim(db('alice'), 'alice', 'm1', RESULT_XP + 1, result()));
    await assertFails(claim(db('alice'), 'alice', 'm1', RESULT_XP, result({ kills: 9 })));
    await seedMatch('m2', 'host1', ['host1', 'alice'], { alice: result() }, 'live');
    await assertFails(claim(db('alice'), 'alice', 'm2', RESULT_XP, result()));
    await seedMatch('m3', 'host1', ['host1'], { host1: result() });
    await assertFails(claim(db('alice'), 'alice', 'm3', RESULT_XP, result()));
  });
  it('practice matches (one human) pay half', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    await seedMatch('p1', 'alice', ['alice'], { alice: result() });
    await assertFails(claim(db('alice'), 'alice', 'p1', RESULT_XP, result()));
    await assertSucceeds(claim(db('alice'), 'alice', 'p1', Math.round(RESULT_XP / 2), result()));
  });
  it('implausible host reports are rejected', async () => {
    await seedProfile('alice', 'Alice', 'ABC234');
    await seedMatch('m1', 'host1', ['host1', 'alice'], { alice: result({ kills: 500 }) });
    await assertFails(claim(db('alice'), 'alice', 'm1', 6000, result({ kills: 500 })));
  });
});

describe('match records', () => {
  const m = (host: string, o: Record<string, unknown> = {}) => ({ host, playlist: '2v2', humans: [host, 'bob'], bots: 2, state: 'live', startedAt: serverTimestamp(), endedAt: null, results: {}, ...o });
  it('only the host creates and finishes a record, and not too early', async () => {
    await assertSucceeds(setDoc(doc(db('alice'), 'matches', 'x1'), m('alice')));
    await assertFails(setDoc(doc(db('bob'), 'matches', 'x2'), m('alice')));
    await assertFails(setDoc(doc(db('alice'), 'matches', 'x3'), m('alice', { state: 'done' })));
    // finishing immediately is rejected (minimum match duration)
    await assertFails(updateDoc(doc(db('alice'), 'matches', 'x1'), { state: 'done', endedAt: serverTimestamp(), results: { alice: result() } }));
    await seed((f) => updateDoc(doc(f, 'matches', 'x1'), { startedAt: Timestamp.fromMillis(Date.now() - 20_000) }));
    await assertFails(updateDoc(doc(db('bob'), 'matches', 'x1'), { state: 'done', endedAt: serverTimestamp(), results: { bob: result() } }));
    await assertFails(updateDoc(doc(db('alice'), 'matches', 'x1'), { state: 'done', endedAt: serverTimestamp(), results: { eve: result() } }));
    await assertSucceeds(updateDoc(doc(db('alice'), 'matches', 'x1'), { state: 'done', endedAt: serverTimestamp(), results: { alice: result(), bob: result({ won: false }) } }));
    await assertFails(updateDoc(doc(db('alice'), 'matches', 'x1'), { state: 'done', endedAt: serverTimestamp(), results: { alice: result({ kills: 9 }) } }));
  });
});

describe('friendships', () => {
  const pair = (a: string, b: string, requester: string) => ({ users: [a, b].sort(), requester, status: 'pending', names: { [a]: a, [b]: b }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  it('request, accept, unfriend', async () => {
    await assertSucceeds(setDoc(doc(db('alice'), 'friendships', 'alice_bob'), pair('alice', 'bob', 'alice')));
    // requester cannot accept their own request
    await assertFails(updateDoc(doc(db('alice'), 'friendships', 'alice_bob'), { status: 'accepted', updatedAt: serverTimestamp() }));
    // outsiders see nothing
    await assertFails(getDoc(doc(db('eve'), 'friendships', 'alice_bob')));
    await assertSucceeds(updateDoc(doc(db('bob'), 'friendships', 'alice_bob'), { status: 'accepted', updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(doc(db('alice'), 'friendships', 'alice_bob')));
  });
  it('cannot forge requests for other people or with a wrong pair id', async () => {
    await assertFails(setDoc(doc(db('eve'), 'friendships', 'alice_bob'), pair('alice', 'bob', 'alice')));
    await assertFails(setDoc(doc(db('alice'), 'friendships', 'bob_alice'), pair('alice', 'bob', 'alice')));
    await assertFails(setDoc(doc(db('alice'), 'friendships', 'alice_bob'), { ...pair('alice', 'bob', 'alice'), status: 'accepted' }));
  });
});
