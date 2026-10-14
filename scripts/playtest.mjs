// Drives the real game in headless Chromium: lobby -> practice match -> fast-forwarded play -> results.
// Usage: node scripts/playtest.mjs [outPrefix] [playlist] [quality]
import { chromium } from '@playwright/test';

const [prefix = 'screenshots/tmp/play', playlist = '2v2', quality = 'medium'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
const base = process.env.URL || 'http://localhost:5173/';
await page.goto(`${base}?quality=${quality}`, { waitUntil: 'load' });
await page.waitForSelector('[data-testid="practice"]', { timeout: 240000 });
await page.click(`[data-testid="playlist-${playlist}"]`);
await page.click('[data-testid="practice"]');
await page.waitForTimeout(800);
const state = () => page.evaluate(() => {
  const s = window.__game.debug().session;
  if (!s) return null;
  return { phase: s.round.phase, timer: +s.round.timer.toFixed(1), round: s.round.round, score: s.round.score, players: s.players.map((p) => `${p.name.slice(0, 8)}:${p.alive ? Math.round(p.hp) : 'X'}@${p.x.toFixed(1)},${p.z.toFixed(1)} k${p.stats.kills}`).join(' | ') };
});
const sim = async (sec, buttons = 0, mz = 0, yaw = 0) => {
  await page.evaluate(([a, b, c, d]) => { const g = window.__game; g.input.locked = true; document.querySelector('.overlay.deploy')?.remove(); g.simulate(a, b, c, d); }, [sec, buttons, mz, yaw]);
};
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${prefix}-${name}.png` }); console.log(name, JSON.stringify(await state())); };
const SPRINT = 4, FIRE = 8, ADS = 16;
await sim(4.6);
await shot('a-live');
await sim(1.6, SPRINT, 1);
await shot('b-sprint');
await sim(0.6, ADS, 0);
await shot('c-ads');
await sim(0.4, ADS | FIRE, 0);
await shot('d-fire');
// let the bots play the rest of the match out (local player idles)
for (let i = 0; i < 40; i++) {
  await sim(6);
  const st = await state();
  if (i % 4 === 0) await shot(`e-${String(i).padStart(2, '0')}`);
  if (!st || st.phase === 'matchEnd') break;
}
if (await state()) await sim(5);
await page.waitForTimeout(6000);
await page.screenshot({ path: `${prefix}-z-results.png` });
console.log('results visible:', await page.$('[data-testid="results"]') !== null);
console.log(logs.slice(-25).join('\n'));
await browser.close();
