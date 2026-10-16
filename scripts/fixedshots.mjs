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

const ART_CAMS = ['hero', 'shaft', 'fpcells', 'boiler', 'cells', 'lockers', 'spawn', 'fp', 'cistern', 'catwalk'];
const MATCH_SHOTS = [
  { name: 'scope-vigil', primary: 'vigil', kind: 'ads' },
  { name: 'ads-halberd', primary: 'halberd', kind: 'ads' },
  { name: 'hip-halberd', primary: 'halberd', kind: 'hip' },
  { name: 'hurt', primary: 'halberd', kind: 'hurt' },
  { name: 'dark', primary: 'halberd', kind: 'dark' },
  { name: 'enemy-dark', primary: 'halberd', kind: 'enemyDark' },
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
  // DOM click: the menu keeps the main thread busy rendering, which stalls Playwright's actionability checks
  await page.$eval(`[data-testid="playlist-${kind === 'ads' ? '4v4' : '1v1'}"]`, (el) => el.click());
  // the click starts a synchronous match build; don't let Playwright wait on the busy page
  await page.$eval('[data-testid="practice"]', (el) => el.click());
  await page.waitForFunction(() => !!window.__game?.debug().match, null, { timeout: 240000 });
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
      Object.assign(me, { x: -8.4, z: -10.3, vx: 0, vz: 0 });
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
  } else if (kind === 'dark') {
    // an enemy 7 m ahead in the corridor; first without lights, then with both flashlights on
    await page.evaluate(() => {
      const g = window.__game;
      const s = g.debug().session;
      const me = s.players.find((p) => p.id === s.localId);
      const en = s.players.find((p) => p.id !== s.localId);
      // cell block corridor, along the edge of the gallery
      Object.assign(me, { x: -9.4, z: -16.6, vx: 0, vz: 0 });
      g.input.yaw = -Math.PI / 2;
      g.input.pitch = -0.05;
      Object.assign(en, { x: -2.4, z: -16.6, vx: 0, vz: 0, yaw: Math.PI / 2, pitch: -0.05 });
      // the idled bots feed yaw 0; keep this one facing us so its flashlight points at the camera
      const bot = s.bots?.get?.(en.id);
      if (bot) bot.think = () => ({ seq: 0, mx: 0, mz: 0, yaw: Math.PI / 2, pitch: -0.05, buttons: 0, slot: 0, viewTick: 0 });
    });
    // give eye adaptation time to settle so the two frames compare at a steady exposure
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${outDir}/${name}-off.png`, timeout: 180000 });
    await page.evaluate(() => {
      const s = window.__game.debug().session;
      for (const p of s.players) p.flashlight = true;
    });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${outDir}/${name}-on.png`, timeout: 180000 });
    // the other player's flashlight alone, seen as an enemy and then as a teammate (enemy
    // flashlights render dimmer). Time is frozen so the team swap can't touch round logic.
    const lightOnly = (asMate) =>
      page.evaluate((mate) => {
        const g = window.__game;
        g.frozen = true;
        const s = g.debug().session;
        const me = s.players.find((p) => p.id === s.localId);
        const other = s.players.find((p) => p.id !== s.localId);
        me.flashlight = false;
        other.flashlight = true;
        if (other.realTeam === undefined) other.realTeam = other.team;
        other.team = mate ? me.team : other.realTeam;
        for (let i = 0; i < 30; i++) g.debug().match.frame(1 / 60);
      }, asMate);
    await lightOnly(false);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${outDir}/${name}-enemylight.png`, timeout: 180000 });
    await lightOnly(true);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${outDir}/${name}-matelight.png`, timeout: 180000 });
  } else if (kind === 'enemyDark') {
    // an enemy at the darkest spot we can see 6-14 m away: should be hard to make out until a
    // flashlight (his or ours) gives him away
    const placed = await page.evaluate(() => {
      const g = window.__game;
      const s = g.debug().session;
      const mv = g.debug().match.mapView;
      const me = s.players.find((p) => p.id === s.localId);
      const en = s.players.find((p) => p.id !== s.localId);
      const P = mv.probes;
      const V3 = P.min.constructor;
      const col = () => ({ r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } });
      const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const dirs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      const light = (x, z) => dirs.reduce((a, d) => a + lum(P.sample(new V3(x, 1.2, z), new V3(...d), col())), 0) / 6;
      // stand at the west end of the cell block corridor and pick the darkest visible standing spot
      Object.assign(me, { x: -8.6, z: -10.4, vx: 0, vz: 0 });
      let best = null;
      for (let x = -35; x <= 35; x += 0.5) {
        for (let z = -23; z <= 23; z += 0.5) {
          const d = Math.hypot(x - me.x, z - me.z);
          if (d < 6 || d > 14) continue;
          if (s.world.supportHeight(x, z, 0.3, 0.1, 0.2, 0.3).y !== 0) continue; // on the main floor
          if (s.world.cylinderBlocked(x, 0.05, z, 0.4, 1.75)) continue;
          if (!s.world.lineOfSight(me.x, 1.6, me.z, x, 1.3, z)) continue;
          const l = light(x, z);
          if (l <= 0.004) continue; // inside geometry / unlit void
          if (!best || l < best.l) best = { x, z, l, d };
        }
      }
      if (!best) return null;
      Object.assign(en, { x: best.x, z: best.z, vx: 0, vz: 0, yaw: Math.atan2(-(me.x - best.x), -(me.z - best.z)), pitch: 0 });
      g.input.yaw = Math.atan2(-(best.x - me.x), -(best.z - me.z));
      g.input.pitch = -0.06;
      return best;
    });
    console.log('enemy-dark spot', JSON.stringify(placed));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/${name}-off.png`, timeout: 180000 });
    await page.evaluate(() => {
      const s = window.__game.debug().session;
      const me = s.players.find((p) => p.id === s.localId);
      me.flashlight = true;
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/${name}-mine.png`, timeout: 180000 });
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
