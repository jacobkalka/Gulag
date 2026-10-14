import type { JSX } from 'preact';
import { profile } from '@/app/state';
import { levelForXp, nextUnlock, LEVEL_XP } from '@/data/progression';
import { Panel, Bar } from '../components';

export function StatsTab(): JSX.Element {
  const p = profile.value;
  const s = p.stats;
  const li = levelForXp(p.xp);
  const nu = nextUnlock(li.level);
  const kd = s.deaths ? (s.kills / s.deaths).toFixed(2) : s.kills.toFixed(2);
  const acc = s.shots ? `${((s.hits / s.shots) * 100).toFixed(1)}%` : '—';
  const hs = s.kills ? `${((s.headshots / s.kills) * 100).toFixed(0)}%` : '—';
  const wr = s.matches ? `${((s.wins / s.matches) * 100).toFixed(0)}%` : '—';
  const cells: [string, string][] = [
    ['MATCHES', String(s.matches)],
    ['WINS', String(s.wins)],
    ['WIN RATE', wr],
    ['KILLS', String(s.kills)],
    ['DEATHS', String(s.deaths)],
    ['K/D', kd],
    ['ASSISTS', String(s.assists)],
    ['HEADSHOT %', hs],
    ['ACCURACY', acc],
    ['DAMAGE', String(s.damage)],
    ['ROUNDS WON', String(s.roundsWon)],
    ['CAPTURES', String(s.captures)],
  ];
  return (
    <div class="tab-wrap stats">
      <Panel title="SERVICE RECORD">
        <div class="lvl-big">
          <div class="lvl-n">{li.level}</div>
          <div class="lvl-r">
            <div>LEVEL {li.level}</div>
            <Bar value={li.progress} class="xp big" />
            <small>
              {li.need ? `${li.into} / ${li.need} XP` : 'MAX LEVEL'} · TOTAL {p.xp} XP
            </small>
            {nu && (
              <small class="next">
                NEXT UNLOCK: <b>{nu.name.toUpperCase()}</b> AT LEVEL {nu.level} ({Math.max(0, LEVEL_XP[nu.level] - p.xp)} XP)
              </small>
            )}
          </div>
        </div>
        <div class="stat-grid">
          {cells.map(([k, v]) => (
            <div class="stat">
              <small>{k}</small>
              <b>{v}</b>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
