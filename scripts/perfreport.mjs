// Per map x quality: match build time and ?perf overlay readings (draw calls, triangles, lights,
// shader programs, JS heap) from fixed viewpoints in a 4v4 practice match. Needs a running dev
// server (URL=..., default http://localhost:5173/). Results feed docs/perf.md.
// Usage: npm run perf:report -- [maps=sublevel9,monsoon] [qualities=low,medium,high]
import { chromium } from '@playwright/test';
const base = process.env.URL || 'http://localhost:5173/';
const maps = (process.argv[2] ?? 'sublevel9,monsoon').split(',');
const qs = (process.argv[3] ?? 'low,medium,high').split(',');
const VIEWS = {
  sublevel9: [
    { name: 'spawn', pos: null },
    { name: 'collapse', pos: [-7.4, 0, 6.9], yaw: -0.85 },
    { name: 'catwalk', pos: [-21.4, 3.2, 22.9], yaw: -1.9 },
  ],
  monsoon: [
    { name: 'spawn', pos: null },
    { name: 'helipad', pos: [-3.5, 0.15, -9.5], yaw: Math.PI - 0.15 },
    { name: 'jungle', pos: [-37.5, 0.3, -9.0], yaw: Math.PI * 0.85 },
  ],
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const rows = [];
for (const map of maps) {
  for (const q of qs) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(() => {
      const st = JSON.parse(localStorage.getItem('lockdown.settings.v1') || '{}');
      localStorage.setItem('lockdown.settings.v1', JSON.stringify({ ...st, seenInputHint: true }));
    });
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    const t0 = Date.now();
    await page.goto(`${base}?offline=1&quality=${q}&map=${map}&perf`, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="practice"]', { timeout: 300000 });
    const bootS = (Date.now() - t0) / 1000;
    // the view builds behind the deploy screen a moment after the match starts: time until it exists
    const buildMs = await page.evaluate(async () => {
      const g = window.__game;
      const t = performance.now();
      g.startBotMatch('4v4', 'regular', { primary: 'halberd', secondary: 'warden', lethal: 'frag', tactical: 'flash' }, 'Perf');
      while (!g.debug().match) await new Promise((r) => setTimeout(r, 20));
      return Math.round(performance.now() - t);
    });
    await page.evaluate(() => {
      window.__game.input.locked = true;
      document.querySelector('.overlay.deploy')?.remove();
    });
    for (const v of VIEWS[map]) {
      await page.evaluate((v) => {
        const g = window.__game;
        const s = g.debug().session;
        const me = s.players.find((p) => p.id === s.localId);
        if (v.pos) Object.assign(me, { x: v.pos[0], y: v.pos[1], z: v.pos[2], vx: 0, vz: 0 });
        if (v.yaw !== undefined) g.input.yaw = v.yaw;
        g.input.pitch = -0.03;
      }, v);
      await page.waitForTimeout(3500);
      const txt = await page.evaluate(() => document.querySelector('.perf-overlay')?.textContent ?? '');
      const num = (re) => { const m = txt.match(re); return m ? Number(m[1]) : NaN; };
      const row = {
        map, q, view: v.name, bootS: +bootS.toFixed(0), buildMs,
        calls: num(/draw calls\s*([\d.]+)/), trisK: num(/tris\s*([\d.]+)k/), lights: num(/lights\s*([\d.]+)/), shadow: num(/shadow lights\s*([\d.]+)/),
        programs: num(/programs\s*([\d.]+)/), heapMB: num(/JS heap\s*([\d.]+)/), cpuMs: num(/CPU\s*([\d.]+)\s*ms/),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    await page.close();
  }
}
await browser.close();
console.log('ROWS ' + JSON.stringify(rows));
