// Scene audits, run against the real game in headless Chromium.
//   node scripts/audit.mjs shadows   - every mesh casts and receives shadows, or carries an
//                                      explicit exemption reason (userData.shadowExempt)
//   node scripts/audit.mjs textures  - every lit material has an albedo and a normal map, or an
//                                      explicit reason (userData.textureExempt)
//   node scripts/audit.mjs contrast  - luminance histograms from fixed cameras: fails if an image
//                                      is too flat, too crushed (black) or blown out (white)
// Options: --maps=sublevel9,... (default: all maps)  --quality=medium
// Needs a running dev server (URL env, default http://localhost:5173/) or E2E-style preview.
import { chromium } from '@playwright/test';

const kind = process.argv[2];
const args = Object.fromEntries(process.argv.slice(3).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const base = process.env.URL || 'http://localhost:5173/';
const quality = args.quality || 'medium';
if (!['shadows', 'textures', 'contrast'].includes(kind)) {
  console.error('usage: node scripts/audit.mjs <shadows|textures|contrast> [--maps=a,b] [--quality=medium]');
  process.exit(2);
}

// start a dev server unless one is already running at URL
let server = null;
const reachable = async () => {
  try {
    const r = await fetch(base);
    return r.ok;
  } catch {
    return false;
  }
};
if (!(await reachable())) {
  const { spawn } = await import('node:child_process');
  const port = new URL(base).port || '5173';
  server = spawn('npx', ['vite', '--port', port, '--strictPort'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 120 && !(await reachable()); i++) await new Promise((r) => setTimeout(r, 1000));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

/** Maps known to the game (asks the page so new maps are picked up automatically). */
async function mapList(page) {
  return page.evaluate(() => (window.__game.mapIds ? window.__game.mapIds() : ['sublevel9']));
}

async function bootMatch(page, mapId) {
  await page.addInitScript(() => {
    const st = JSON.parse(localStorage.getItem('lockdown.settings.v1') || '{}');
    localStorage.setItem('lockdown.settings.v1', JSON.stringify({ ...st, seenInputHint: true }));
  });
  await page.goto(`${base}?offline=1&quality=${quality}&map=${mapId}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="practice"]', { timeout: 240000 });
  await page.click('[data-testid="playlist-4v4"]');
  await page.$eval('[data-testid="practice"]', (el) => el.click());
  await page.waitForFunction(() => !!window.__game?.debug().match, null, { timeout: 240000 });
  await page.evaluate(() => {
    const g = window.__game;
    g.input.locked = true;
    document.querySelector('.overlay.deploy')?.remove();
    g.simulate(4.6, 0, 0, 0);
  });
  await page.waitForTimeout(1500);
}

let failed = false;

if (kind === 'shadows' || kind === 'textures') {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(`${base}?offline=1&quality=${quality}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="practice"]', { timeout: 240000 });
  const maps = args.maps ? args.maps.split(',') : await mapList(page);
  await page.close();
  for (const mapId of maps) {
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await bootMatch(p, mapId);
    const report = await p.evaluate((k) => {
      const mv = window.__game.debug().match;
      const exemptOf = (o, key) => {
        for (let q = o; q; q = q.parent) if (q.userData && q.userData[key]) return q.userData[key];
        return '';
      };
      const label = (o) => {
        const names = [];
        for (let q = o; q && names.length < 4; q = q.parent) if (q.name) names.push(q.name);
        return names.join(' < ') || o.type;
      };
      const out = { checked: 0, exempt: {}, problems: [] };
      if (k === 'shadows') {
        mv.scene.traverse((o) => {
          if (!(o.isMesh || o.isSkinnedMesh || o.isInstancedMesh)) return;
          out.checked++;
          const ex = exemptOf(o, 'shadowExempt');
          if (ex) {
            out.exempt[ex] = (out.exempt[ex] ?? 0) + 1;
            return;
          }
          if (!o.castShadow || !o.receiveShadow) out.problems.push(`${label(o)}: cast=${o.castShadow} receive=${o.receiveShadow}`);
        });
      } else {
        const seen = new Set();
        const visit = (o) => {
          if (!(o.isMesh || o.isSkinnedMesh || o.isInstancedMesh)) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m || seen.has(m)) continue;
            seen.add(m);
            out.checked++;
            const ex = m.userData?.textureExempt || exemptOf(o, 'textureExempt');
            if (ex) {
              out.exempt[ex] = (out.exempt[ex] ?? 0) + 1;
              continue;
            }
            if (m.isShaderMaterial || m.isRawShaderMaterial) {
              out.problems.push(`${m.type} '${m.name}' on ${label(o)}: custom shader without a textureExempt reason`);
              continue;
            }
            const lit = m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial;
            if (!lit) {
              out.problems.push(`${m.type} '${m.name}' on ${label(o)}: unlit material without a reason`);
              continue;
            }
            const miss = [];
            if (!m.map) miss.push('albedo');
            if (!m.normalMap) miss.push('normal');
            if (miss.length) out.problems.push(`'${m.name || m.uuid.slice(0, 8)}' on ${label(o)}: missing ${miss.join(' + ')} map`);
          }
        };
        mv.scene.traverse(visit);
        mv.vm.scene.traverse(visit);
      }
      return out;
    }, kind);
    console.log(`\n[${kind}] map ${mapId}: ${report.checked} checked, ${report.problems.length} problem(s)`);
    for (const [reason, n] of Object.entries(report.exempt)) console.log(`  exempt x${n}: ${reason}`);
    for (const pr of report.problems.slice(0, 80)) console.log(`  FAIL ${pr}`);
    if (report.problems.length > 80) console.log(`  ... and ${report.problems.length - 80} more`);
    if (report.problems.length) failed = true;
    await p.close();
  }
}

if (kind === 'contrast') {
  // fixed art-test cameras per map (the art test renders the map under final lighting, no HUD)
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}?offline=1#/arttest?q=${quality}&cam=list`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__artCams, null, { timeout: 240000 });
  const camsByMap = await page.evaluate(() => window.__artCams);
  await page.close();
  const maps = args.maps ? args.maps.split(',') : Object.keys(camsByMap);
  const LIMITS = { minRange: 0.32, minStd: 0.07, maxBlack: 0.35, maxWhite: 0.015 };
  console.log(`limits: p95-p5 >= ${LIMITS.minRange}, std >= ${LIMITS.minStd}, near-black <= ${LIMITS.maxBlack * 100}%, near-white <= ${LIMITS.maxWhite * 100}%`);
  for (const mapId of maps) {
    for (const cam of camsByMap[mapId] ?? []) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${base}?offline=1#/arttest?q=${quality}&map=${mapId}&cam=${cam}`, { waitUntil: 'load' });
      await p.waitForFunction(() => (window.__frames ?? 0) > 3, null, { timeout: 240000 });
      await p.waitForTimeout(2500);
      const png = await p.screenshot({ timeout: 180000 });
      const stats = await p.evaluate(async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const hist = new Uint32Array(256);
        let sum = 0;
        let sum2 = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          hist[Math.round(l)]++;
          sum += l / 255;
          sum2 += (l / 255) * (l / 255);
        }
        const pct = (q) => {
          let acc = 0;
          for (let i = 0; i < 256; i++) {
            acc += hist[i];
            if (acc >= q * n) return i / 255;
          }
          return 1;
        };
        let black = 0;
        let white = 0;
        for (let i = 0; i <= 4; i++) black += hist[i];
        for (let i = 251; i < 256; i++) white += hist[i];
        const mean = sum / n;
        return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), black: black / n, white: white / n };
      }, png.toString('base64'));
      const range = stats.p95 - stats.p5;
      const issues = [];
      if (range < LIMITS.minRange || stats.std < LIMITS.minStd) issues.push('too flat');
      if (stats.black > LIMITS.maxBlack) issues.push('crushed blacks');
      if (stats.white > LIMITS.maxWhite) issues.push('blown highlights');
      const f = (v) => v.toFixed(3);
      console.log(`${issues.length ? 'FAIL' : 'ok  '} ${mapId}/${cam.padEnd(9)} mean ${f(stats.mean)} std ${f(stats.std)} p5 ${f(stats.p5)} p50 ${f(stats.p50)} p95 ${f(stats.p95)} range ${f(range)} black ${(stats.black * 100).toFixed(1)}% white ${(stats.white * 100).toFixed(2)}%${issues.length ? '  <- ' + issues.join(', ') : ''}`);
      if (issues.length) failed = true;
      await p.close();
    }
  }
}

await browser.close();
if (server) process.kill(-server.pid);
if (failed) {
  console.log(`\naudit:${kind} FAILED`);
  process.exit(1);
}
console.log(`\naudit:${kind} passed`);
