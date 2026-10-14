import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { MatchSummary } from '@/game/view/MatchView';
import type { MatchAward } from '@/app/progressionService';
import { levelForXp } from '@/data/progression';
import { WEAPON_MAP } from '@/data/weapons';
import { audio } from '@/engine/audio/AudioEngine';
import { settings, teamColors } from '@/app/settings';
import { Button, Bar } from '../components';

/** End-of-match screen: result, scoreboard with per-player stats, XP breakdown, level-ups and unlocks. */
export function Results(props: {
  summary: MatchSummary;
  award: MatchAward | null;
  /** Set when the match was played in a private room (changes the action buttons). */
  room?: 'host' | 'client' | null;
  onPlayAgain: () => void;
  onLobby: () => void;
}): JSX.Element {
  const { summary, award } = props;
  const won = summary.winner >= 0 && summary.winner === summary.localTeam;
  const draw = summary.winner < 0;
  const [shownXp, setShownXp] = useState(0);
  const [levelUp, setLevelUp] = useState(false);
  const colors = teamColors(settings.value.colorblind);
  useEffect(() => {
    if (!award) return;
    let raf = 0;
    const start = performance.now();
    const dur = 1600;
    let ticks = 0;
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / dur);
      const v = Math.round(award.total * (1 - Math.pow(1 - t, 3)));
      setShownXp(v);
      if (ticks++ % 4 === 0 && t < 1) audio.ui('xpTick', 0.5);
      if (t < 1) raf = requestAnimationFrame(step);
      else if (award.levelAfter > award.levelBefore) {
        setLevelUp(true);
        audio.ui('levelUp', 0.9);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [award]);
  const xpNow = award ? award.xpBefore + shownXp : 0;
  const li = levelForXp(xpNow);
  const lp = summary.local;
  const acc = lp && lp.stats.shots ? Math.round((lp.stats.hits / lp.stats.shots) * 100) : 0;
  const rows = [...summary.players].sort((a, b) => a.team - b.team || b.kills - a.kills);
  return (
    <div class="results" data-testid="results">
      <div class={`res-banner ${won ? 'win' : draw ? 'draw' : 'lose'}`}>
        <div class="res-title">{won ? 'VICTORY' : draw ? 'DRAW' : 'DEFEAT'}</div>
        <div class="res-score">
          <span style={{ color: colors.friendly }}>{summary.score[summary.localTeam]}</span>
          <i>—</i>
          <span style={{ color: colors.enemy }}>{summary.score[summary.localTeam === 0 ? 1 : 0]}</span>
        </div>
        <div class="res-sub">
          {summary.playlist.toUpperCase()} · SUBLEVEL 9 · {summary.rounds} ROUNDS
        </div>
      </div>
      <div class="res-body">
        <section class="res-board">
          <table>
            <thead>
              <tr>
                <th>OPERATOR</th>
                <th>K</th>
                <th>D</th>
                <th>A</th>
                <th>DMG</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class={`${r.local ? 'me' : ''} ${r.team === summary.localTeam ? 'f' : 'e'}`}>
                  <td>{r.name}</td>
                  <td>{r.kills}</td>
                  <td>{r.deaths}</td>
                  <td>{r.assists}</td>
                  <td>{r.damage}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {lp && (
            <div class="res-mine">
              <div>
                <small>KILLS</small>
                <b>{lp.stats.kills}</b>
              </div>
              <div>
                <small>DEATHS</small>
                <b>{lp.stats.deaths}</b>
              </div>
              <div>
                <small>DAMAGE</small>
                <b>{lp.stats.damage}</b>
              </div>
              <div>
                <small>ACCURACY</small>
                <b>{acc}%</b>
              </div>
              <div>
                <small>HEADSHOTS</small>
                <b>{lp.stats.headshots}</b>
              </div>
              <div>
                <small>CAPTURES</small>
                <b>{lp.stats.captures}</b>
              </div>
            </div>
          )}
        </section>
        <section class="res-xp">
          <h3>EXPERIENCE</h3>
          {award ? (
            <>
              <ul class="xp-lines">
                {award.lines.map((l) => (
                  <li>
                    <span>
                      {l.label}
                      {l.count > 1 ? ` ×${l.count}` : ''}
                    </span>
                    <b>{l.xp ? `+${l.xp}` : ''}</b>
                  </li>
                ))}
              </ul>
              <div class="xp-total">
                <span>TOTAL</span>
                <b>+{shownXp} XP</b>
              </div>
              <div class="xp-level">
                <div class="lv">LV {li.level}</div>
                <Bar value={li.progress} class="xp big" />
              </div>
              {levelUp && (
                <div class="levelup">
                  <div class="lu-t">LEVEL UP!</div>
                  <div class="lu-n">LEVEL {award.levelAfter}</div>
                  {award.unlocks.map((u) => (
                    <div class="unlock">
                      <small>UNLOCKED</small>
                      <b>{u.name.toUpperCase()}</b>
                      {u.kind === 'weapon' && WEAPON_MAP[u.id] && <span>{WEAPON_MAP[u.id].description}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p class="hint">Calculating…</p>
          )}
        </section>
      </div>
      <div class="res-actions">
        <Button variant="primary" size="lg" onClick={props.onPlayAgain} testid="play-again">
          {props.room ? 'BACK TO ROOM' : 'PLAY AGAIN'}
        </Button>
        <Button variant="secondary" size="lg" onClick={props.onLobby} testid="back-lobby">
          {props.room ? 'LEAVE ROOM' : 'BACK TO LOBBY'}
        </Button>
      </div>
    </div>
  );
}
