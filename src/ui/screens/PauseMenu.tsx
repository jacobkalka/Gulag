import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { GameController } from '@/app/GameController';
import { Button } from '../components';
import { SettingsPanel } from './SettingsPanel';

export function PauseMenu(props: { game: GameController; onLeave: () => void }): JSX.Element {
  const [view, setView] = useState<'main' | 'settings' | 'confirm'>('main');
  return (
    <div class="overlay pause" onClick={(e) => e.stopPropagation()}>
      {view === 'main' && (
        <div class="pause-box">
          <div class="pause-title">PAUSED</div>
          <div class="pause-sub">The match keeps running.</div>
          <Button variant="primary" size="lg" onClick={() => props.game.setPaused(false)} testid="resume">
            RESUME
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
      {view === 'confirm' && (
        <div class="pause-box">
          <div class="pause-title">LEAVE?</div>
          <div class="pause-sub">You will forfeit this match.</div>
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
