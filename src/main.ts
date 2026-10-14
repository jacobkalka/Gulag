import './ui/styles.css';
import './ui/menu.css';
import { render, h } from 'preact';

// Entry point. Hash routes: #/swatches and #/arttest are dev views; everything else boots the game.
const canvas = document.getElementById('c') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const route = location.hash.replace(/^#\/?/, '');

function fatal(title: string, msg: string): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="fatal"><div class="box"><h2>${title}</h2><p>${msg}</p></div></div>`,
  );
}

async function boot(): Promise<void> {
  if (route.startsWith('swatches')) {
    const { runSwatches } = await import('./dev/swatches');
    await runSwatches(canvas);
    return;
  }
  if (route.startsWith('arttest')) {
    const { runArtTest } = await import('./dev/arttest');
    await runArtTest(canvas);
    return;
  }
  const [{ GameController }, { App, Loading }, state] = await Promise.all([import('./app/GameController'), import('./ui/App'), import('./app/state')]);
  render(h(Loading, {}), uiRoot);
  let game: InstanceType<typeof GameController>;
  try {
    game = new GameController(canvas, uiRoot);
  } catch (e) {
    fatal('WebGL2 unavailable', 'LOCKDOWN needs a browser with WebGL2 (recent Chrome, Edge, Firefox or Safari) and hardware acceleration enabled.');
    throw e;
  }
  (window as unknown as { __game: unknown }).__game = game;
  // debug/test hook: UI state signals
  const social = await import('./app/social');
  (window as unknown as { __state: unknown }).__state = { ...state, ...social };
  await game.load((progress, label) => (state.loading.value = { progress, label }));
  render(h(App, { game }), uiRoot);
  state.screen.value = 'lobby';
  const { initBackend } = await import('./backend/init');
  await initBackend(game).catch((e) => console.warn('backend init failed', e));
}

boot().catch((e) => {
  console.error(e);
  fatal('Something went wrong', String(e?.message ?? e));
});
