// Headless bot-vs-bot matches on a map, to find layout problems before players do:
//   - round wins per side (the layout should not favor a spawn),
//   - time to first contact (1v1 players should find each other in about 20-30 s),
//   - bots stuck in one place, where the fights happen (per zone), and parts of the map bots
//     never reach.
// Usage: npm run botsim -- [mapId] [matchesPerPlaylist] [--md out.md] [--playlist 1v1] [--seed 1000]
import { writeFileSync } from 'node:fs';
import { buildMap, MAP_IDS } from '@/game/world/maps';
import { GameSim } from '@/game/sim/GameSim';
import { PLAYLISTS, PLAYLIST_ORDER } from '@/data/playlists';
import { NavGrid } from '@/game/bots/NavGrid';
import { BotBrain } from '@/game/bots/BotBrain';
import { zoneAt } from '@/game/world/builder';

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : '';
};
const flagValues = new Set(['--md', '--playlist', '--seed'].map(flag).filter(Boolean));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !flagValues.has(a));
const mdOut = flag('--md');
const onlyPlaylist = flag('--playlist');
const seedBase = Number(flag('--seed') || 1000);
const mapId = args[0] ?? MAP_IDS[0];
const perPlaylist = Number(args[1] ?? 8);
const map = buildMap(mapId);

interface Agg {
  rounds: number;
  wins: [number, number];
  draws: number;
  contact: number[];
  stuck: string[];
  matchSec: number[];
}
const zoneTime = new Map<string, number>();
const zoneKills = new Map<string, number>();
const visited = new Map<string, { nav: NavGrid; seen: Uint8Array }>();
const byPlaylist = new Map<string, Agg>();

for (const pl of PLAYLIST_ORDER) {
  if (onlyPlaylist && pl !== onlyPlaylist) continue;
  const rules = PLAYLISTS[pl].rules;
  const agg: Agg = { rounds: 0, wins: [0, 0], draws: 0, contact: [], stuck: [], matchSec: [] };
  byPlaylist.set(pl, agg);
  for (let m = 0; m < perPlaylist; m++) {
    const seed = seedBase + m * 17 + rules.teamSize;
    const sim = new GameSim(map, rules, seed);
    const navKey = rules.mapTags.join(',');
    let vis = visited.get(navKey);
    if (!vis) {
      const nav = new NavGrid(sim.world, map);
      vis = { nav, seen: new Uint8Array(nav.nodes.length) };
      visited.set(navKey, vis);
    }
    const nav = vis.nav;
    const brains = new Map<number, BotBrain>();
    // same skill on both sides, so any imbalance comes from the map
    for (let i = 0; i < rules.teamSize * 2; i++) {
      sim.addPlayer({ id: i, team: (i % 2) as 0 | 1, name: `B${i}`, bot: true });
      brains.set(i, new BotBrain(i, 'regular', seed));
    }
    sim.start();
    let liveAt = -1;
    let contacted = false;
    const still = new Map<number, { x: number; z: number; t: number }>();
    let t = 0;
    for (; t < 60 * 60 * 15 && sim.round.phase !== 'matchEnd'; t++) {
      sim.step((p) => brains.get(p.id)!.think(sim, nav, p));
      for (const p of sim.players) brains.get(p.id)!.observe(sim.events, sim, p);
      for (const e of sim.events) {
        if (e.type === 'roundLive') {
          liveAt = t;
          contacted = false;
        }
        if (e.type === 'damage' && !contacted && liveAt >= 0) {
          contacted = true;
          agg.contact.push((t - liveAt) / 60);
        }
        if (e.type === 'kill') {
          const v = sim.player(e.victim);
          if (v) {
            const z = zoneAt(map.zones, v.x, v.y + 0.1, v.z) || '(none)';
            zoneKills.set(z, (zoneKills.get(z) ?? 0) + 1);
          }
        }
        if (e.type === 'roundEnd') {
          agg.rounds++;
          if (e.winner === 0 || e.winner === 1) agg.wins[e.winner]++;
          else agg.draws++;
        }
      }
      if (sim.round.phase !== 'live' && sim.round.phase !== 'overtime') {
        still.clear();
        continue;
      }
      if (t % 30 === 0) {
        for (const p of sim.players) {
          if (!p.alive) continue;
          const z = zoneAt(map.zones, p.x, p.y + 0.1, p.z) || '(none)';
          zoneTime.set(z, (zoneTime.get(z) ?? 0) + 0.5);
          const id = nav.nearest(p.x, p.y, p.z);
          if (id >= 0) {
            // mark everything within 3 m as seen (bots look around)
            const n0 = nav.nodes[id];
            for (const n of nav.nodes) if (Math.abs(n.y - n0.y) < 1.5 && Math.hypot(n.x - n0.x, n.z - n0.z) < 3) vis.seen[n.id] = 1;
          }
        }
      }
      for (const p of sim.players) {
        if (!p.alive) continue;
        const s = still.get(p.id);
        if (!s || Math.hypot(p.x - s.x, p.z - s.z) > 1.0) still.set(p.id, { x: p.x, z: p.z, t: 0 });
        else {
          s.t += 1 / 60;
          if (s.t > 12 && s.t < 12 + 1 / 60 + 1e-9) agg.stuck.push(`${pl} seed ${seed}: ${p.name} at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} (${zoneAt(map.zones, p.x, p.y + 0.1, p.z)}) ${brains.get(p.id)!.debugInfo()}`);
        }
      }
    }
    agg.matchSec.push(t / 60);
  }
}

const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const lines: string[] = [];
lines.push(`# Bot simulation: ${map.name}`, '');
lines.push(`${perPlaylist} matches per playlist, all bots on Regular, same skill on both sides. Generated by \`npm run botsim -- ${mapId} ${perPlaylist}\`.`, '');
lines.push('| Playlist | Rounds | Side A wins | Side B wins | Draws | First contact (median) | Match length (median) | Stuck bots |', '|---|---|---|---|---|---|---|---|');
for (const [pl, a] of byPlaylist) {
  const pa = a.rounds ? Math.round((a.wins[0] / a.rounds) * 100) : 0;
  const pb = a.rounds ? Math.round((a.wins[1] / a.rounds) * 100) : 0;
  lines.push(`| ${pl} | ${a.rounds} | ${a.wins[0]} (${pa}%) | ${a.wins[1]} (${pb}%) | ${a.draws} | ${med(a.contact).toFixed(1)} s | ${med(a.matchSec).toFixed(0)} s | ${a.stuck.length} |`);
}
const totalW: [number, number] = [0, 0];
for (const a of byPlaylist.values()) {
  totalW[0] += a.wins[0];
  totalW[1] += a.wins[1];
}
lines.push('', `All playlists: side A ${totalW[0]} round wins, side B ${totalW[1]} (${Math.round((totalW[0] / Math.max(1, totalW[0] + totalW[1])) * 100)}% / ${Math.round((totalW[1] / Math.max(1, totalW[0] + totalW[1])) * 100)}%).`, '');
const tt = [...zoneTime.values()].reduce((s, v) => s + v, 0);
lines.push('| Zone | Share of bot time | Kills |', '|---|---|---|');
for (const [z, v] of [...zoneTime.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${z} | ${((v / tt) * 100).toFixed(1)}% | ${zoneKills.get(z) ?? 0} |`);
lines.push('');
for (const [key, vis] of visited) {
  const perZone = new Map<string, { n: number; seen: number }>();
  for (const n of vis.nav.nodes) {
    const z = zoneAt(map.zones, n.x, n.y + 0.1, n.z) || '(none)';
    const e = perZone.get(z) ?? { n: 0, seen: 0 };
    e.n++;
    e.seen += vis.seen[n.id];
    perZone.set(z, e);
  }
  const cold = [...perZone.entries()].filter(([, e]) => e.seen / e.n < 0.5).map(([z, e]) => `${z} ${Math.round((e.seen / e.n) * 100)}%`);
  const comps = new Set(Array.from(vis.nav.comp)).size;
  const all = vis.seen.reduce((s, v) => s + v, 0);
  lines.push(`Nav ${key || 'full map'}: ${vis.nav.nodes.length} nodes in ${comps} connected area(s), ${Math.round((all / vis.nav.nodes.length) * 100)}% visited. Zones under half visited: ${cold.length ? cold.join(', ') : 'none'}.`);
}
const stuck = [...byPlaylist.values()].flatMap((a) => a.stuck);
if (stuck.length) lines.push('', 'Stuck reports:', ...stuck.map((s) => `- ${s}`));
const out = lines.join('\n');
console.log(out);
if (mdOut) writeFileSync(mdOut, out + '\n');
