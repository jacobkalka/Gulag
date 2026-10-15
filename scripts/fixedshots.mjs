// Fixed-camera screenshots for before/after comparisons.
// Usage: node scripts/fixedshots.mjs <outDir> [quality] [only=name1,name2]
//   Art-test cameras render the map under final lighting from fixed positions.
//   Match shots start an offline practice match and capture ADS / scoped fire, hip fire and
//   damage feedback with real mouse input (bots are idled so they don't interfere).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const [outDir = 'screenshots/tmp/fixed', quality = 'medium', onlyArg = ''] = process.argv.slice(2);
const only = onlyArg.startsWith('only=') ? new Set(onlyArg.slice(5).split(',')) : null;
const base = process.env.URL || 'http://localhost:5173/';
mkdirSync(outDir, { recursive: true });

const ART_CAMS = ['hero', 'shaft', 'fpcells', 'boiler', 'cells', 'lockers', 'spawn', 'fp'];
const MATCH_SHOTS = [
  { name: 'scope-vigil', primary: 'vigil', kind: 'ads' },
  { name: 'ads-halberd', primary: 'halberd', kind: 'ads' },
  { name: 'hip-halberd', primary: 'halberd', kind: 'hip' },
  { name: 'hurt', primary: 'halberd', kind: 'hurt' },
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

async function matchShot({ name, primary, kind }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript((p) => {
    const prof = { uid: 'local-shots', username: 'Shots', friendCode: 'SHOT-0000', xp: 5e6, loadout: { primary: p, secondary: 'warden', lethal: 'frag', tactical: 'flash' }, stats: {}, guest: true };
    localStorage.setItem('lockdown.profile.v1', JSON.stringify(prof));
    const st = JSON.parse(localStorage.getItem('lockdown.settings.v1') || '{}');
    localStorage.setItem('lockdown.settings.v1', JSON.stringify({ ...st, seenInputHint: true }));
  }, primary);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?offline=1&quality=${quality}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="practice"]', { timeout: 240000 });
  await page.click(`[data-testid="playlist-${kind === 'ads' ? '4v4' : '1v1'}"]`);
  // the click starts a synchronous match build; don't let Playwright wait on the busy page
  await page.$eval('[data-testid="practice"]', (el) => el.click());
  await page.waitForFunction(() => !!window.__game?.debug().session, null, { timeout: 240000 });
  await page.waitForTimeout(800);
  await page.evaluate((aimLong) => {
    const g = window.__game;
    g.input.locked = true;
    document.querySelector('.overlay.deploy')?.remove();
    g.simulate(4.6, 0, 0, 0);
    const s = g.debug().session;
    // idle the bots so they don't knock us out of ADS
    for (const b of s.bots?.values?.() ?? []) b.think = () => ({ seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, slot: 0, viewTick: 0 });
    const me = s.players.find((p) => p.id === s.localId);
    if (aimLong) {
      // stand at the west end of the cell block corridor and look east down its length
      Object.assign(me, { x: -17.5, z: -8.2, vx: 0, vz: 0 });
      g.input.yaw = -Math.PI / 2;
    } else {
      // look down the longest clear sightline from where we stand
      let best = 0;
      for (let i = 0; i < 48; i++) {
        const yaw = (i / 48) * Math.PI * 2;
        const hit = s.world.raycast(me.x, me.y + 1.5, me.z, -Math.sin(yaw), 0, -Math.cos(yaw), 80);
        const d = hit ? hit.t : 80;
        if (d > best) {
          best = d;
          g.input.yaw = yaw;
        }
      }
    }
    g.input.pitch = -0.02;
  }, kind === 'ads');
  await page.mouse.move(640, 360);
  if (kind === 'ads') {
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/${name}-aim.png`, timeout: 180000 });
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(60);
    await page.screenshot({ path: `${outDir}/${name}-fire.png`, timeout: 180000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/${name}-fire2.png`, timeout: 180000 });
    await page.mouse.up({ button: 'left' });
    await page.mouse.up({ button: 'right' });
  } else if (kind === 'hip') {
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${outDir}/${name}-fire.png`, timeout: 180000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}/${name}-fire2.png`, timeout: 180000 });
    await page.mouse.up({ button: 'left' });
  } else if (kind === 'hurt') {
    // freeze real time so the transient effects can be captured deterministically
    const hurt = (amount, frames, setHp) =>
      page.evaluate(([a, n, hp]) => {
        const g = window.__game;
        g.frozen = true;
        const s = g.debug().session;
        const me = s.players.find((p) => p.id === s.localId);
        const bot = s.players.find((p) => p.id !== s.localId);
        me.spawnProt = 0;
        if (hp) me.hp = hp;
        s.sim.applyDamage(bot, me, a, 'chest', 'halberd', me.x, me.y + 1.2, me.z);
        // damage applied outside a sim step: hand the event to the view directly
        g.debug().match.handleEvent({ type: 'damage', attacker: bot.id, victim: me.id, amount: a, hitbox: 'chest', x: me.x, y: me.y + 1.2, z: me.z, weapon: 'halberd', killed: false });
        for (let i = 0; i < n; i++) g.debug().match.frame(1 / 60);
      }, [amount, frames, setHp ?? 0]);
    await hurt(30, 4);
    await page.screenshot({ path: `${outDir}/${name}-hit.png`, timeout: 180000 });
    await hurt(20, 40, 40);
    await page.screenshot({ path: `${outDir}/${name}-low.png`, timeout: 180000 });
  }
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
