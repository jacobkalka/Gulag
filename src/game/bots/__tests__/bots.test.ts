import { describe, expect, it } from 'vitest';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { GameSim } from '@/game/sim/GameSim';
import { PLAYLISTS } from '@/data/playlists';
import { NavGrid } from '@/game/bots/NavGrid';
import { BotBrain } from '@/game/bots/BotBrain';

const map = buildSublevel9();

describe('nav grid', () => {
  const sim = new GameSim(map, PLAYLISTS['2v2'].rules, 3);
  const t0 = performance.now();
  const nav = new NavGrid(sim.world, map);
  const ms = performance.now() - t0;
  it('builds quickly with many nodes and cover spots', () => {
    expect(nav.nodes.length).toBeGreaterThan(2500);
    expect(nav.cover.length).toBeGreaterThan(80);
    expect(ms).toBeLessThan(4000);
  });
  it('finds a path from spawn A to spawn B', () => {
    const a = nav.nearest(-23.4, 0, 0);
    const b = nav.nearest(23.4, 0, 0);
    const p = nav.findPath(a, b);
    expect(p).not.toBeNull();
    expect(p!.length).toBeGreaterThan(40);
  });
  it('finds a path up onto the catwalk', () => {
    const a = nav.nearest(-14, 0, 9);
    const b = nav.nearest(0, 2.8, 15.6);
    expect(nav.nodes[b].y).toBeCloseTo(2.8, 1);
    expect(nav.findPath(a, b)).not.toBeNull();
  });
  it('reaches the cells through their doors', () => {
    const a = nav.nearest(-16.5, 0, -8);
    const b = nav.nearest(-16.5, 0, -12.5);
    expect(nav.findPath(a, b)).not.toBeNull();
  });
});

describe('bot hunting', () => {
  it('finds and kills a player hiding behind the spawn counter (1v1 shutters closed)', () => {
    const sim = new GameSim(map, PLAYLISTS['1v1'].rules, 5);
    const nav = new NavGrid(sim.world, map);
    sim.addPlayer({ id: 0, team: 0, name: 'Dummy', bot: false });
    sim.addPlayer({ id: 1, team: 1, name: 'Bot', bot: true });
    const brain = new BotBrain(1, 'regular', 3);
    sim.start();
    let t = 0;
    for (; t < 60 * 60 && sim.round.phase !== 'roundEnd'; t++) {
      const d0 = sim.player(0)!;
      d0.x = -21.7;
      d0.z = -0.8;
      sim.step((p) => (p.id === 0 ? { seq: t, mx: 0, mz: 0, yaw: -Math.PI / 2, pitch: 0, buttons: 0, slot: 0, viewTick: 0 } : brain.think(sim, nav, p)));
      brain.observe(sim.events, sim, sim.player(1)!);
    }
    expect(sim.round.lastReason).toBe('elimination');
    expect(sim.round.lastWinner).toBe(1);
  });
  it('every walkable area is reachable from both spawns', () => {
    const sim = new GameSim(map, PLAYLISTS['2v2'].rules, 5);
    const nav = new NavGrid(sim.world, map);
    const points: [number, number, number][] = [
      [0, 0, 0], [0, 2.8, 15.6], [-14, 0, 2], [14, 0, -2], [-16.5, 0, -12.5], [16.5, 0, -12.5], [0, 0, -15.8],
      [-22, 0, 12], [22, 0, -12], [-22, 0, -12], [0, 0, 8.2], [-5, 0, -8.2],
    ];
    for (const sp of [[-23.4, 0, 0], [23.4, 0, 0]] as const) {
      const a = nav.nearest(sp[0], sp[1], sp[2]);
      for (const [x, y, z] of points) {
        const b = nav.nearest(x, y, z);
        expect(nav.findPath(a, b), `path from ${sp} to ${x},${y},${z}`).not.toBeNull();
      }
    }
  });
});

describe('bot match', () => {
  it('2v2 bots play a full match to completion', () => {
    const sim = new GameSim(map, PLAYLISTS['2v2'].rules, 11);
    const nav = new NavGrid(sim.world, map);
    const brains = new Map<number, BotBrain>();
    for (let i = 0; i < 4; i++) {
      sim.addPlayer({ id: i, team: (i % 2) as 0 | 1, name: `Bot${i}`, bot: true });
      brains.set(i, new BotBrain(i, 'regular', 5));
    }
    sim.start();
    let kills = 0;
    let shots = 0;
    const maxTicks = 60 * 60 * 8;
    let t = 0;
    for (; t < maxTicks && sim.round.phase !== 'matchEnd'; t++) {
      sim.step((p) => brains.get(p.id)!.think(sim, nav, p));
      for (const p of sim.players) brains.get(p.id)!.observe(sim.events, sim, p);
      for (const e of sim.events) {
        if (e.type === 'kill') kills++;
        if (e.type === 'fire') shots++;
      }
    }
    const summary = sim.players.map((p) => `${p.name} k${p.stats.kills} d${p.stats.deaths} dmg${p.stats.damage} hit ${p.stats.hits}/${p.stats.shots}`).join(' | ');
    console.log(`match ${sim.round.phase} after ${(t / 60).toFixed(0)}s, score ${sim.round.score}, rounds ${sim.round.round}, kills ${kills}, shots ${shots}\n${summary}`);
    expect(sim.round.phase).toBe('matchEnd');
    expect(kills).toBeGreaterThan(3);
  });
});
