// Fixed-camera screenshots for before/after comparisons.
// Usage: node scripts/fixedshots.mjs <outDir> [quality] [only=name1,name2]
//   Art-test cameras render the map under final lighting from fixed positions.
//   Match shots start an offline practice match and capture ADS / scoped fire.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const [outDir = 'screenshots/tmp/fixed', quality = 'medium', onlyArg = ''] = process.argv.slice(2);
const only = onlyArg.startsWith('only=') ? new Set(onlyArg.slice(5).split(',')) : null;
const base = process.env.URL || 'http://localhost:5173/';
mkdirSync(outDir, { recursive: true });

const ART_CAMS = ['hero', 'shaft', 'fpcells', 'boiler', 'cells', 'lockers', 'spawn', 'fp'];
const MATCH_SHOTS = [
  { name: 'scope-vigil', primary: 'vigil' },
  { name: 'ads-halberd', primary: 'halberd' },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

async function artShot(cam) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}?offline=1#/arttest?q=${quality}&cam=${cam}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window.__frames ?? 0) > 3, null, { timeout: 240000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/${cam}.png`, timeout: 180000 });
  console.log('shot', cam);
  await page.close();
}

async function matchShot({ name, primary }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript((p) => {
    const prof = { uid: 'local-shots', username: 'Shots', friendCode: 'SHOT-0000', xp: 5e6, loadout: { primary: p, secondary: 'warden', lethal: 'frag', tactical: 'flash' }, stats: {}, guest: true };
    localStorage.setItem('lockdown.profile.v1', JSON.stringify(prof));
  }, primary);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?offline=1&quality=${quality}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="practice"]', { timeout: 240000 });
  await page.click('[data-testid="playlist-1v1"]');
  // the click starts a synchronous match build; don't let Playwright wait on the busy page
  await page.$eval('[data-testid="practice"]', (el) => el.click());
  await page.waitForFunction(() => !!window.__game?.debug().session, null, { timeout: 240000 });
  await page.waitForTimeout(800);
  const sim = (sec, buttons = 0) =>
    page.evaluate(([a, b]) => {
      const g = window.__game;
      g.input.locked = true;
      document.querySelector('.overlay.deploy')?.remove();
      g.simulate(a, b, 0, 0);
    }, [sec, buttons]);
  const FIRE = 8, ADS = 16;
  await sim(4.6);
  await sim(1.0, ADS);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/${name}-aim.png`, timeout: 180000 });
  await sim(0.05, ADS | FIRE);
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${outDir}/${name}-fire.png`, timeout: 180000 });
  await sim(0.25, ADS | FIRE);
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${outDir}/${name}-fire2.png`, timeout: 180000 });
  console.log('shot', name, errors.length ? `errors: ${errors.join(' | ')}` : '');
  await page.close();
}

const jobs = [
  ...ART_CAMS.filter((c) => !only || only.has(c)).map((c) => () => artShot(c)),
  ...MATCH_SHOTS.filter((m) => !only || only.has(m.name)).map((m) => () => matchShot(m)),
];
// two at a time: software GL is CPU bound
for (let i = 0; i < jobs.length; i += 2) await Promise.all(jobs.slice(i, i + 2).map((j) => j()));
await browser.close();
