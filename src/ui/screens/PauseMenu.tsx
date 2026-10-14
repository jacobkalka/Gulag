import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { GameController } from '@/app/GameController';
import { Button } from '../components';
import { SettingsPanel } from './SettingsPanel';
import { QuickLoadout } from './Loadout';

export function PauseMenu(props: { game: GameController; onLeave: () => void; inRoom?: boolean }): JSX.Element {
  const [view, setView] = useState<'main' | 'settings' | 'confirm' | 'loadout'>('main');
  return (
    <div class="overlay pause" onClick={(e) => e.stopPropagation()}>
      {view === 'main' && (
        <div class="pause-box">
          <div class="pause-title">PAUSED</div>
          <div class="pause-sub">The match keeps running.</div>
          <Button variant="primary" size="lg" onClick={() => props.game.setPaused(false)} testid="resume">
            RESUME
          </Button>
          <Button variant="secondary" size="lg" onClick={() => setView('loadout')} testid="pause-loadout">
            LOADOUT
          </Button>
          <Button variant="secondary" size="lg" onClick={() => setView('settings')}>
            SETTINGS
          </Button>
          <Button variant="danger" size="lg" onClick={() => setView('confirm')}>
            LEAVE MATCH
          </Button>
        </div>
      )}
      {view === 'settings' && (
        <div class="pause-settings">
          <SettingsPanel game={props.game} compact />
          <Button variant="primary" onClick={() => setView('main')}>
            BACK
          </Button>
        </div>
      )}
      {view === 'loadout' && (
        <div class="pause-settings">
          <div class="pause-title">LOADOUT</div>
          <div class="pause-sub">Changes apply when you next spawn (immediately during the round countdown).</div>
          <QuickLoadout onPick={(l) => props.game.currentSession?.setLoadout(l)} />
          <Button variant="primary" onClick={() => setView('main')}>
            BACK
          </Button>
        </div>
      )}
      {view === 'confirm' && (
        <div class="pause-box">
          <div class="pause-title">LEAVE?</div>
          <div class="pause-sub">
            {props.inRoom
              ? props.game.rooms.isHost
                ? 'You are the host: leaving ends the match for everyone and closes the room.'
                : 'You will leave the room. A bot takes over your slot.'
              : 'You will forfeit this match.'}
          </div>
          <Button variant="danger" size="lg" onClick={props.onLeave}>
            LEAVE MATCH
          </Button>
          <Button variant="secondary" size="lg" onClick={() => setView('main')}>
            CANCEL
          </Button>
        </div>
      )}
    </div>
  );
}
