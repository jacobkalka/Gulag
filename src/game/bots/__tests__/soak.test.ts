import { describe, expect, it } from 'vitest';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { GameSim } from '@/game/sim/GameSim';
import { PLAYLISTS, type PlaylistId } from '@/data/playlists';
import { NavGrid } from '@/game/bots/NavGrid';
import { BotBrain } from '@/game/bots/BotBrain';

// Soak test: many full bot matches; no bot may stay stuck in one spot for long.
const map = buildSublevel9();

describe('bot soak', () => {
  const runs: [PlaylistId, number][] = [['1v1', 1], ['1v1', 2], ['2v2', 3], ['2v2', 4], ['3v3', 5], ['3v3', 6], ['4v4', 7]];
  const nades = { thrown: 0, fragKills: 0, selfKills: 0 };
  for (const [pl, seed] of runs) {
    it(`${pl} seed ${seed}`, () => {
      const rules = PLAYLISTS[pl].rules;
      const sim = new GameSim(map, rules, seed);
      const nav = new NavGrid(sim.world, map);
      const brains = new Map<number, BotBrain>();
      for (let i = 0; i < rules.teamSize * 2; i++) {
        sim.addPlayer({ id: i, team: (i % 2) as 0 | 1, name: `B${i}`, bot: true });
        brains.set(i, new BotBrain(i, (['recruit', 'regular', 'veteran'] as const)[(i + seed) % 3], seed));
      }
      sim.start();
      const still = new Map<number, { x: number; z: number; t: number }>();
      const stuckReports: string[] = [];
      let kills = 0;
      let t = 0;
      for (; t < 60 * 60 * 10 && sim.round.phase !== 'matchEnd'; t++) {
        sim.step((p) => brains.get(p.id)!.think(sim, nav, p));
        for (const p of sim.players) brains.get(p.id)!.observe(sim.events, sim, p);
        for (const e of sim.events) {
          if (e.type === 'kill') {
            kills++;
            if (e.weapon === 'frag') {
              nades.fragKills++;
              if (e.killer === e.victim) nades.selfKills++;
            }
          }
          if (e.type === 'grenade') nades.thrown++;
        }
        if (sim.round.phase !== 'live' && sim.round.phase !== 'overtime') {
          still.clear();
          continue;
        }
        for (const p of sim.players) {
          if (!p.alive) continue;
          const s = still.get(p.id);
          if (!s || Math.hypot(p.x - s.x, p.z - s.z) > 1.0) still.set(p.id, { x: p.x, z: p.z, t: 0 });
          else {
            s.t += 1 / 60;
            if (s.t > 12 && s.t < 12 + 1 / 60 + 1e-9) stuckReports.push(`${p.name} stuck at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} (${brains.get(p.id)!.debugInfo()}) round ${sim.round.round}`);
          }
        }
      }
      if (stuckReports.length) console.log(stuckReports.join('\n'));
      console.log(`${pl}#${seed}: ${sim.round.phase} in ${(t / 60).toFixed(0)}s, score ${sim.round.score}, rounds ${sim.round.round}, kills ${kills}`);
      expect(sim.round.phase).toBe('matchEnd');
      expect(stuckReports.length).toBeLessThanOrEqual(1);
    });
  }
  it('bots throw grenades and rarely blow themselves up', () => {
    console.log(`grenades thrown ${nades.thrown}, frag kills ${nades.fragKills}, self kills ${nades.selfKills}`);
    expect(nades.thrown).toBeGreaterThan(3);
    expect(nades.selfKills).toBeLessThanOrEqual(Math.max(1, nades.thrown * 0.1));
  });
});
