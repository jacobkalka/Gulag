// Headless screenshot helper used during development to judge visuals.
// Usage: node scripts/screenshot.mjs <url> <out.png> [waitMs] [width] [height] [evalJs]
import { chromium } from '@playwright/test';

const [url = 'http://localhost:5173/', out = 'screenshots/tmp/shot.png', waitMs = '4000', w = '1280', h = '720', evalJs = ''] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
if (evalJs) await page.evaluate(evalJs);
await page.waitForTimeout(+waitMs);
await page.screenshot({ path: out, timeout: 180000 });
const info = await page.evaluate(() => ({ frames: window.__frames, gl: window.__gl, stats: window.__stats }));
console.log(JSON.stringify(info), `elapsed ${Date.now() - t0}ms`);
console.log(logs.slice(-40).join('\n'));
await browser.close();
