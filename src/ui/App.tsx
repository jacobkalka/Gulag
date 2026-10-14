import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { screen, paused, lastSummary, toasts, dismissToast, loading, selectedPlaylist, profile } from '@/app/state';
import type { GameController } from '@/app/GameController';
import { awardMatch, type MatchAward } from '@/app/progressionService';
import { settings } from '@/app/settings';
import { Lobby } from './screens/Lobby';
import { PauseMenu } from './screens/PauseMenu';
import { Results } from './screens/Results';
import { Button } from './components';
import { audio } from '@/engine/audio/AudioEngine';

export function Loading(): JSX.Element {
  const l = loading.value;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return (
    <div class="loading" data-testid="loading">
      <div class="logo">
        LOCK<span>DOWN</span>
      </div>
      <div class="tag">Sublevel 9 · win the round · earn the surface</div>
      <div class="bar">
        <i style={{ width: `${Math.round(l.progress * 100)}%` }} />
      </div>
      <div class="status">{l.label}</div>
      {mobile && <div class="mobile-note">LOCKDOWN is built for desktop browsers with a mouse and keyboard. It may run on this device, but expect a rough ride.</div>}
    </div>
  );
}

function Toasts(): JSX.Element {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div class={`toast ${t.kind ?? 'info'}`} key={t.id}>
          <div class="toast-t">{t.title}</div>
          {t.body && <div class="toast-b">{t.body}</div>}
          {t.actions && (
            <div class="toast-a">
              {t.actions.map((a) => (
                <Button
                  size="sm"
                  variant={a.primary ? 'primary' : 'secondary'}
                  onClick={() => {
                    a.onClick();
                    dismissToast(t.id);
                  }}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
          <button class="toast-x" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function DeployPrompt(props: { game: GameController }): JSX.Element | null {
  const [locked, setLocked] = useState(props.game.input.locked);
  useEffect(() => {
    const h = () => setLocked(document.pointerLockElement != null);
    document.addEventListener('pointerlockchange', h);
    return () => document.removeEventListener('pointerlockchange', h);
  }, []);
  if (locked || paused.value) return null;
  return (
    <div
      class="overlay deploy"
      onClick={() => {
        audio.unlock();
        props.game.input.requestLock();
      }}
    >
      <div class="deploy-box">
        <div class="deploy-t">CLICK TO DEPLOY</div>
        <div class="deploy-s">WASD move · SHIFT sprint · C crouch/slide · SPACE jump/mantle · LMB fire · RMB aim · R reload · Q swap · G frag · F flash · V shiv · TAB scores · ESC pause</div>
      </div>
    </div>
  );
}

export function App(props: { game: GameController }): JSX.Element {
  const g = props.game;
  const [award, setAward] = useState<MatchAward | null>(null);
  void settings.value;
  useEffect(() => {
    g.onMatchEnd = (s) => {
      lastSummary.value = s;
      screen.value = 'results';
      setAward(null);
      const session = g.currentSession;
      const botMatch = !!session && session.players.every((p) => p.bot || p.id === session.localId);
      void awardMatch(s, botMatch).then(setAward);
      g.leaveMatch(true);
      audio.playMusic('musicMenu');
    };
    g.onPauseChange = (p) => (paused.value = p);
  }, [g]);
  const sc = screen.value;
  return (
    <>
      {sc === 'boot' && <Loading />}
      {sc === 'lobby' && <Lobby game={g} />}
      {sc === 'match' && (
        <>
          {paused.value && (
            <PauseMenu
              game={g}
              onLeave={() => {
                g.leaveMatch(true);
                paused.value = false;
                screen.value = 'lobby';
              }}
            />
          )}
          <DeployPrompt game={g} />
        </>
      )}
      {sc === 'results' && lastSummary.value && (
        <Results
          summary={lastSummary.value}
          award={award}
          onPlayAgain={() => {
            const p = profile.value;
            g.startBotMatch(selectedPlaylist.value, settings.value.botDifficulty, p.loadout, p.username);
            screen.value = 'match';
          }}
          onLobby={() => (screen.value = 'lobby')}
        />
      )}
      <Toasts />
    </>
  );
}
