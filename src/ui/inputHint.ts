import { inputModePatch, settings, updateSettings } from '@/app/settings';
import { pushToast } from '@/app/state';
import type { GameController } from '@/app/GameController';

/** First launch: offer touchpad mode to laptop players (shown once; changeable in Settings). */
export function maybeShowInputHint(game: GameController): void {
  if (settings.value.seenInputHint) return;
  const choose = (mode: 'mouse' | 'touchpad') => {
    updateSettings({ ...inputModePatch(mode), seenInputHint: true });
    game.applyInputSettings();
  };
  pushToast({
    title: 'PLAYING ON A LAPTOP TOUCHPAD?',
    body: 'Touchpad mode: Space fires, Left Shift aims, much tighter hip fire and gentle aim assist. You can switch any time in Settings > Controls > Input mode.',
    kind: 'info',
    ttl: 0,
    actions: [
      { label: 'USE TOUCHPAD', primary: true, onClick: () => choose('touchpad') },
      { label: 'KEEP MOUSE', onClick: () => choose('mouse') },
    ],
  });
}
