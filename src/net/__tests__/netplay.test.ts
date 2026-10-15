import { describe, expect, it } from 'vitest';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { CollisionWorld } from '@/game/world/collision';
import { PLAYLISTS } from '@/data/playlists';
import { DEFAULT_LOADOUT } from '@/data/progression';
import { BTN, DT, emptyInput, type GameEvent, type PlayerInput, type PlayerState } from '@/game/sim/types';
import { eyeHeight } from '@/game/sim/movement';
import type { ClientSession } from '@/game/session/ClientSession';
import type { HostSession } from '@/game/session/HostSession';
import { NetHost } from '../NetHost';
import { NetClient } from '../NetClient';
import { LoopbackLink, SimNetwork, type NetConditions } from '../link';
import { PROTOCOL_VERSION, encodeInputs } from '../protocol';

// End-to-end netcode tests over a simulated network (virtual clock, latency, jitter, loss).

const map = buildSublevel9();
const world1v1 = CollisionWorld.fromMap(map, PLAYLISTS['1v1'].rules.mapTags);

const GOOD: NetConditions = { latency: 50, jitter: 12, loss: 0.05 };

interface Ctx {
  net: SimNetwork;
  host: NetHost;
  client: NetClient;
  hs: HostSession;
  cs: ClientSession;
  hostEvents: GameEvent[];
  clientEvents: GameEvent[];
  hseq: number;
  cseq: number;
}

function setup(cond: NetConditions, fillBots = false, seed = 3): Ctx {
  const net = new SimNetwork(seed);
  const now = () => net.now;
  const host = new NetHost({
    code: 'TEST42',
    self: { pid: 'host', name: 'Host', level: 5, loadout: DEFAULT_LOADOUT },
    map,
    playlist: '1v1',
    difficulty: 'regular',
    now,
  });
  host.setFillBots(fillBots);
  const [hostSide, clientSide] = LoopbackLink.pair(net, 'host', 'c1', cond);
  host.acceptLink(hostSide);
  const client = new NetClient(clientSide, { map, pid: 'c1', name: 'Client', level: 3, loadout: DEFAULT_LOADOUT, now, world: world1v1 });
  net.advance(400);
  expect(host.room.members).toHaveLength(2);
  expect(client.room?.members).toHaveLength(2);
  const hs = host.startMatch(1234);
  net.advance(400);
  expect(client.session).not.toBeNull();
  return { net, host, client, hs, cs: client.session!, hostEvents: [], clientEvents: [], hseq: 0, cseq: 0 };
}

function frame(c: Ctx, hostIn: () => Partial<PlayerInput>, clientIn: () => Partial<PlayerInput>): void {
  c.net.advance(1000 / 60);
  c.hostEvents.push(...c.hs.update(DT, () => ({ ...emptyInput(++c.hseq), ...hostIn() })));
  c.client.update();
  c.clientEvents.push(...c.cs.update(DT, () => ({ ...emptyInput(++c.cseq), viewTick: c.cs.viewTick(), ...clientIn() })));
}

function runUntil(c: Ctx, cond: () => boolean, maxSec: number, hostIn = () => ({}), clientIn = () => ({})): void {
  for (let i = 0; i < maxSec * 60 && !cond(); i++) frame(c, hostIn, clientIn);
}

const local = (c: Ctx): PlayerState => c.cs.players.find((p) => p.id === c.cs.localId)!;

describe('netplay over a simulated network', () => {
  it('connects, mirrors the room and starts the match on the client', () => {
    const c = setup(GOOD);
    expect(c.cs.localId).toBe(1);
    expect(c.cs.players.map((p) => p.name).sort()).toEqual(['Client', 'Host']);
    runUntil(c, () => c.cs.round.phase === 'live', 8);
    expect(c.hs.round.phase).toBe('live');
    expect(c.cs.round.phase).toBe('live');
    expect(c.cs.snapshotsReceived).toBeGreaterThan(100);
    expect(c.cs.ping()).toBeGreaterThan(80);
    expect(c.cs.ping()).toBeLessThan(160);
  });

  it('predicts the local player identically to the host (small corrections only)', () => {
    const c = setup(GOOD);
    runUntil(c, () => c.hs.round.phase === 'live', 8);
    // start in the showers facing north (+z) with room to run
    Object.assign(c.hs.sim.player(1)!, { x: 0, y: 0, z: -4.5, vx: 0, vz: 0 });
    runUntil(c, () => false, 1, () => ({}), () => ({ yaw: Math.PI }));
    let maxCorr = 0;
    // run, strafe, sprint, jump and finally slam into the north wall
    for (let i = 0; i < 150; i++) {
      frame(
        c,
        () => ({}),
        () => ({ mz: 1, mx: i > 40 && i < 80 ? 1 : 0, yaw: Math.PI, buttons: (i > 90 ? BTN.SPRINT : 0) | (i === 60 ? BTN.JUMP : 0) }),
      );
      maxCorr = Math.max(maxCorr, c.cs.lastCorrection);
    }
    // stop and let everything settle
    runUntil(c, () => false, 0.7, () => ({}), () => ({ yaw: Math.PI }));
    const auth = c.hs.sim.player(1)!;
    const pred = local(c);
    expect(auth.z).toBeGreaterThan(3); // it really moved
    expect(Math.hypot(pred.x - auth.x, pred.z - auth.z)).toBeLessThan(0.01);
    expect(maxCorr).toBeLessThan(0.05);
  });

  for (const latency of [80, 150]) {
    it(`no rubber-banding at ${latency} ms with the faster movement (sprint, slide, slide-jump, strafe)`, () => {
      const c = setup({ latency, jitter: latency * 0.15, loss: 0.03 }, false, 11);
      runUntil(c, () => c.hs.round.phase === 'live', 10);
      Object.assign(c.hs.sim.player(1)!, { x: 0, y: 0, z: -4.5, vx: 0, vz: 0 });
      runUntil(c, () => false, 1.2, () => ({}), () => ({ yaw: Math.PI }));
      let maxCorr = 0;
      let corrSum = 0;
      const seqButtons = (i: number) =>
        (i > 10 && i < 70 ? BTN.SPRINT : 0) | (i >= 40 && i < 52 ? BTN.CROUCH : 0) | (i === 52 ? BTN.JUMP : 0) | (i === 95 ? BTN.JUMP : 0);
      for (let i = 0; i < 160; i++) {
        frame(c, () => ({}), () => ({ mz: i < 120 ? 1 : 0, mx: i > 75 && i < 110 ? (i % 30 < 15 ? 1 : -1) : 0, yaw: Math.PI + (i > 110 ? 0.4 : 0), buttons: seqButtons(i) }));
        maxCorr = Math.max(maxCorr, c.cs.lastCorrection);
        corrSum += c.cs.lastCorrection;
      }
      runUntil(c, () => false, 1.0, () => ({}), () => ({ yaw: Math.PI + 0.4 }));
      const auth = c.hs.sim.player(1)!;
      const pred = local(c);
      expect(Math.hypot(auth.x, auth.z + 4.5)).toBeGreaterThan(5); // it really moved
      expect(Math.hypot(pred.x - auth.x, pred.z - auth.z)).toBeLessThan(0.01);
      // corrections stay tiny (lost packets are re-sent redundantly, so prediction matches)
      expect(maxCorr).toBeLessThan(0.08);
      expect(corrSum).toBeLessThan(0.5);
    });
  }

  it('a client flooding inputs cannot move faster than normal', () => {
    const c = setup({ latency: 30, jitter: 0, loss: 0 });
    runUntil(c, () => c.hs.round.phase === 'live', 8);
    const p = c.hs.sim.player(1)!;
    // bypass the client session and hammer the host with 10 fresh inputs per tick
    const raw = (c.client as unknown as { link: LoopbackLink }).link;
    let seq = 1e6;
    const start = { x: p.x, z: p.z };
    for (let i = 0; i < 60; i++) {
      const burst: PlayerInput[] = [];
      for (let k = 0; k < 10; k++) burst.push({ ...emptyInput(++seq, Math.PI / 2, 0), mz: 1 });
      raw.sendU(encodeInputs(burst.slice(-8), 0));
      c.net.advance(1000 / 60);
      c.hs.update(DT, () => emptyInput(++c.hseq));
    }
    const moved = Math.hypot(p.x - start.x, p.z - start.z);
    expect(moved).toBeLessThan(4.6 * 1.05);
  });

  it('lag compensation: shots aimed at the interpolated target hit on the host', () => {
    const results = [true, false].map((lagComp) => {
      const c = setup(GOOD, false, 11);
      runUntil(c, () => c.hs.round.phase === 'live', 8);
      runUntil(c, () => false, 3.6); // spawn protection expires
      const hostP = c.hs.sim.player(0)!;
      const cliP = c.hs.sim.player(1)!;
      // put both players in the showers with a clear lane between them
      Object.assign(cliP, { x: 0, y: 0, z: -4.5, vx: 0, vz: 0 });
      Object.assign(hostP, { x: 0, y: 0, z: 3.5, vx: 0, vz: 0 });
      let dir = 1;
      const hostIn = (): Partial<PlayerInput> => {
        if (hostP.x > 1.3) dir = -1;
        if (hostP.x < -1.3) dir = 1;
        hostP.hp = 100;
        return { mx: dir, yaw: 0 };
      };
      let f = 0;
      const clientIn = (): Partial<PlayerInput> => {
        const me = local(c);
        const tgt = c.cs.players.find((p) => p.id === 0)!;
        const ex = me.x;
        const ey = me.y + eyeHeight(me);
        const ez = me.z;
        const dx = tgt.x - ex;
        const dy = tgt.y + 1.3 - ey;
        const dz = tgt.z - ez;
        f++;
        return {
          yaw: Math.atan2(-dx, -dz),
          pitch: Math.atan2(dy, Math.hypot(dx, dz)),
          buttons: BTN.ADS | (f % 16 === 0 ? BTN.FIRE : 0),
          viewTick: lagComp ? c.cs.viewTick() : 0,
        };
      };
      runUntil(c, () => false, 1, hostIn, clientIn); // settle after the teleport + ADS in
      c.hostEvents.length = 0;
      runUntil(c, () => false, 8, hostIn, clientIn);
      const shots = c.hostEvents.filter((e) => e.type === 'fire' && e.shooter === 1).length;
      const hits = c.hostEvents.filter((e) => e.type === 'damage' && e.attacker === 1).length;
      return { shots, hits, rate: hits / Math.max(1, shots) };
    });
    const [withComp, without] = results;
    expect(withComp.shots).toBeGreaterThan(20);
    expect(withComp.rate).toBeGreaterThan(0.85);
    expect(without.rate).toBeLessThan(withComp.rate - 0.3);
  });

  it('shows host-confirmed hits and remote shots on the client', () => {
    const c = setup(GOOD, false, 5);
    runUntil(c, () => c.hs.round.phase === 'live', 8);
    runUntil(c, () => false, 3.6);
    const hostP = c.hs.sim.player(0)!;
    const cliP = c.hs.sim.player(1)!;
    Object.assign(cliP, { x: 0, y: 0, z: -4.5 });
    Object.assign(hostP, { x: 0, y: 0, z: 3.5 });
    let f = 0;
    // the host shoots at the (stationary) client
    runUntil(
      c,
      () => false,
      3,
      () => {
        f++;
        cliP.hp = 100;
        const dx = cliP.x - hostP.x;
        const dz = cliP.z - hostP.z;
        return { yaw: Math.atan2(-dx, -dz), pitch: -0.03, buttons: BTN.ADS | (f % 20 === 0 ? BTN.FIRE : 0) };
      },
      () => ({ yaw: 0 }),
    );
    const remoteFire = c.clientEvents.filter((e) => e.type === 'fire' && e.shooter === 0).length;
    const hurt = c.clientEvents.filter((e) => e.type === 'damage' && e.victim === 1).length;
    expect(remoteFire).toBeGreaterThan(5);
    expect(hurt).toBeGreaterThan(3);
    // the client never double-plays its own predicted actions
    expect(c.clientEvents.filter((e) => e.type === 'fire' && e.shooter === 1)).toHaveLength(0);
  });

  it('respawns face the spawn direction even with stale inputs in flight', () => {
    const c = setup(GOOD);
    runUntil(c, () => c.hs.round.phase === 'live', 8);
    // emulate the match view: aim is free, but a new life adopts the spawn orientation
    let aim = 1.0;
    let seenLife = local(c).life;
    const clientIn = (): Partial<PlayerInput> => {
      const me = local(c);
      if (me.life !== seenLife) {
        seenLife = me.life;
        aim = me.yaw;
      }
      return { yaw: aim, life: me.life };
    };
    runUntil(c, () => false, 1, () => ({}), clientIn);
    expect(c.hs.sim.player(1)!.yaw).toBeCloseTo(1.0, 5);
    const lifeBefore = c.hs.sim.player(1)!.life;
    // kill the client on the host and wait for the next round
    c.hs.sim.player(1)!.spawnProt = 0;
    c.hs.sim.applyDamage(c.hs.sim.player(0)!, c.hs.sim.player(1)!, 500, 'head', 'halberd', 0, 1, 0);
    runUntil(c, () => c.hs.sim.player(1)!.life !== lifeBefore, 10, () => ({}), clientIn);
    runUntil(c, () => false, 0.5, () => ({}), clientIn);
    const spawnYaw = map.spawns.filter((s) => s.team === 1)[0].yaw;
    expect(aim).toBeCloseTo(spawnYaw, 5);
    expect(c.hs.sim.player(1)!.yaw).toBeCloseTo(spawnYaw, 5);
    expect(local(c).yaw).toBeCloseTo(spawnYaw, 5);
  });

  it('a leaver is replaced by a bot and the match goes on', () => {
    const c = setup(GOOD, true);
    runUntil(c, () => c.hs.round.phase === 'live', 8);
    c.client.leave();
    runUntil(c, () => false, 1);
    const p = c.hs.sim.player(1)!;
    expect(p.bot).toBe(true);
    expect(c.host.room.members).toHaveLength(1);
    // the bot keeps playing: it moves
    const x0 = p.x;
    runUntil(c, () => false, 3);
    expect(Math.abs(p.x - x0) + Math.abs(p.z)).toBeGreaterThan(0.5);
  });

  it('rejects clients running a different protocol version', () => {
    const net = new SimNetwork(1);
    const host = new NetHost({ code: 'ABCDEF', self: { pid: 'h', name: 'H', level: 1, loadout: DEFAULT_LOADOUT }, map, playlist: '2v2', difficulty: 'recruit', now: () => net.now });
    const [a, b] = LoopbackLink.pair(net, 'h', 'x', { latency: 10, jitter: 0, loss: 0 });
    host.acceptLink(a);
    const got: unknown[] = [];
    b.onR = (m) => got.push(m);
    b.sendR({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'old', level: 1, loadout: DEFAULT_LOADOUT });
    net.advance(100);
    expect(got).toEqual([{ t: 'reject', reason: expect.stringContaining('VERSION') }]);
    expect(host.room.members).toHaveLength(1);
  });
});
