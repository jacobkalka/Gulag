import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { ref, set, get, remove, update, type Database } from 'firebase/database';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-lockdown',
    database: { rules: readFileSync(resolve(__dirname, '../database.rules.json'), 'utf8'), host: '127.0.0.1', port: 9000 },
  });
});
afterAll(async () => env?.cleanup());
beforeEach(async () => env.clearDatabase());

const rtdb = (uid: string | null): Database => (uid ? env.authenticatedContext(uid).database() : env.unauthenticatedContext().database()) as unknown as Database;
const now = () => Date.now();
async function seed(path: string, value: unknown) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database() as unknown as Database, path), value);
  });
}

describe('presence', () => {
  it('only you write your status; signed-in users read it', async () => {
    await assertSucceeds(set(ref(rtdb('alice'), 'status/alice'), { state: 'online', ts: now(), name: 'Alice' }));
    await assertFails(set(ref(rtdb('bob'), 'status/alice'), { state: 'offline', ts: now() }));
    await assertFails(set(ref(rtdb('alice'), 'status/alice'), { state: 'hacking', ts: now() }));
    await assertSucceeds(get(ref(rtdb('bob'), 'status/alice')));
    await assertFails(get(ref(rtdb(null), 'status/alice')));
  });
});

describe('rooms and signaling', () => {
  const room = (host: string) => ({ hostId: host, hostName: host, playlist: '2v2', players: 1, capacity: 4, version: 1, ts: now() });
  it('claim a code, only the host updates it', async () => {
    await assertSucceeds(set(ref(rtdb('alice'), 'rooms/ABC234'), room('alice')));
    await assertFails(set(ref(rtdb('bob'), 'rooms/ABC234'), room('bob')));
    await assertFails(update(ref(rtdb('bob'), 'rooms/ABC234'), { players: 3 }));
    await assertSucceeds(update(ref(rtdb('alice'), 'rooms/ABC234'), { players: 2 }));
    await assertFails(set(ref(rtdb('alice'), 'rooms/abc001'), room('alice')));
    await assertSucceeds(remove(ref(rtdb('alice'), 'rooms/ABC234')));
  });
  it('signals: anyone may drop a message in your inbox, only you read and clear it', async () => {
    const msg = { from: 'bob', kind: 'offer', data: '{"sdp":"x"}', ts: now() };
    await assertSucceeds(set(ref(rtdb('bob'), 'signals/alice/m1'), msg));
    await assertFails(set(ref(rtdb('eve'), 'signals/alice/m2'), msg)); // spoofed sender
    await assertFails(set(ref(rtdb('bob'), 'signals/alice/m3'), { ...msg, kind: 'evil' }));
    await assertFails(set(ref(rtdb('bob'), 'signals/alice/m4'), { ...msg, data: 'x'.repeat(20000) }));
    await assertFails(get(ref(rtdb('bob'), 'signals/alice')));
    await assertSucceeds(get(ref(rtdb('alice'), 'signals/alice')));
    await assertFails(set(ref(rtdb('bob'), 'signals/alice/m1'), { ...msg, kind: 'answer' })); // no overwrite
    await assertSucceeds(remove(ref(rtdb('alice'), 'signals/alice/m1')));
    // the owner may clear the whole inbox (stale signals from a previous session), nobody else
    await assertSucceeds(set(ref(rtdb('bob'), 'signals/alice/m5'), msg));
    await assertFails(remove(ref(rtdb('bob'), 'signals/alice')));
    await assertFails(set(ref(rtdb('alice'), 'signals/alice'), { x: { from: 'alice', kind: 'bye', ts: now() } }));
    await assertSucceeds(remove(ref(rtdb('alice'), 'signals/alice')));
  });
});

describe('parties, invites and party chat', () => {
  const party = (leader: string) => ({ leader, state: 'idle', playlist: '2v2', ts: now(), seats: { s0: leader }, members: { [leader]: { name: leader, seat: 's0', ts: now() } } });
  const join = (uid: string, seat: string, pid = 'p1') =>
    update(ref(rtdb(uid), `parties/${pid}`), { [`seats/${seat}`]: uid, [`members/${uid}`]: { name: uid, seat, ts: now() } });
  const leave = (uid: string, seat: string) => update(ref(rtdb(uid), 'parties/p1'), { [`seats/${seat}`]: null, [`members/${uid}`]: null });
  it('leader creates; others take a free seat to join and leave themselves; max four', async () => {
    await assertSucceeds(set(ref(rtdb('alice'), 'parties/p1'), party('alice')));
    await assertFails(set(ref(rtdb('eve'), 'parties/p2'), party('alice')));
    await assertSucceeds(join('bob', 's1'));
    await assertFails(join('carol', 's1')); // seat taken
    await assertFails(set(ref(rtdb('bob'), 'parties/p1/members/carol'), { name: 'carol', seat: 's2', ts: now() }));
    await assertFails(update(ref(rtdb('bob'), 'parties/p1'), { state: 'queue' }));
    await assertSucceeds(update(ref(rtdb('alice'), 'parties/p1'), { state: 'queue' }));
    await assertSucceeds(join('carol', 's2'));
    await assertSucceeds(join('dave', 's3'));
    await assertFails(join('erin', 's4')); // only four seats
    await assertSucceeds(leave('bob', 's1'));
    await assertSucceeds(update(ref(rtdb('alice'), 'parties/p1'), { 'members/carol': null, 'seats/s2': null })); // leader kicks
    await assertFails(join('bob', 's1', 'nope')); // no such party
  });
  it('invites and chat', async () => {
    await seed('parties/p1', party('alice'));
    await assertSucceeds(set(ref(rtdb('alice'), 'invites/bob/alice'), { party: 'p1', fromName: 'alice', ts: now() }));
    await assertFails(set(ref(rtdb('eve'), 'invites/bob/alice'), { party: 'p1', fromName: 'alice', ts: now() }));
    await assertFails(get(ref(rtdb('alice'), 'invites/bob')));
    await assertSucceeds(get(ref(rtdb('bob'), 'invites/bob')));
    await assertSucceeds(remove(ref(rtdb('bob'), 'invites/bob/alice')));
    await assertSucceeds(set(ref(rtdb('alice'), 'partyChat/p1/c1'), { uid: 'alice', name: 'alice', text: 'yo', ts: now() }));
    await assertFails(set(ref(rtdb('eve'), 'partyChat/p1/c2'), { uid: 'eve', name: 'eve', text: 'hi', ts: now() }));
    await assertFails(get(ref(rtdb('eve'), 'partyChat/p1')));
    await assertSucceeds(get(ref(rtdb('alice'), 'partyChat/p1')));
  });
});

describe('matchmaking queue', () => {
  const ticket = (n = 1) => ({ size: n, names: 'x', ts: now(), version: 1 });
  it('own ticket only; a queued host may assign others once', async () => {
    await assertSucceeds(set(ref(rtdb('alice'), 'queue/2v2/alice'), ticket()));
    await assertFails(set(ref(rtdb('alice'), 'queue/2v2/bob'), ticket()));
    await assertSucceeds(set(ref(rtdb('bob'), 'queue/2v2/bob'), ticket()));
    const assign = { host: 'alice', room: 'ABC234', team: 1, ts: now() };
    await assertFails(set(ref(rtdb('eve'), 'queue/2v2/bob/assign'), { ...assign, host: 'eve' })); // eve is not queued
    await assertSucceeds(set(ref(rtdb('alice'), 'queue/2v2/bob/assign'), assign));
    await assertFails(set(ref(rtdb('alice'), 'queue/2v2/bob/assign'), { ...assign, room: 'XYZ234' })); // already assigned
    await assertSucceeds(remove(ref(rtdb('bob'), 'queue/2v2/bob')));
    await assertFails(set(ref(rtdb('carol'), 'queue/9v9/carol'), ticket()));
  });
});
