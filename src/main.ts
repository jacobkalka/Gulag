// Entry point. Hash routes: #/swatches and #/arttest are dev views; everything else boots the game.
const canvas = document.getElementById('c') as HTMLCanvasElement;
const route = location.hash.replace(/^#\/?/, '');

async function boot(): Promise<void> {
  if (route.startsWith('swatches')) {
    const { runSwatches } = await import('./dev/swatches');
    await runSwatches(canvas);
  } else if (route.startsWith('arttest')) {
    const { runArtTest } = await import('./dev/arttest');
    await runArtTest(canvas);
  }
}
boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;left:0;color:#f66;background:#000;padding:8px">${String(e?.stack ?? e)}</pre>`);
});
