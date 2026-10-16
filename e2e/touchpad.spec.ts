import { test, expect, type Page } from '@playwright/test';

// Touchpad mode end to end: the first-launch hint switches modes, Space fires and Left Shift
// aims from the keyboard, the host applies the reduced hip spread, and aim assist slows the look
// over an enemy only when it is enabled.

const session = (page: Page, fn: string) => page.evaluate(`(() => { const s = window.__game.debug().session; return s ? (${fn}) : null; })()`);
const local = (fn: string) => `(() => { const p = s.players.find((q) => q.id === s.localId); return ${fn}; })()`;

test('touchpad mode: keyboard fire and aim, reduced hip spread, aim assist on/off', async ({ page }) => {
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  await page.goto('/?quality=low&norender=1&offline=1');
  await page.waitForSelector('[data-testid="practice"]', { timeout: 150_000 });

  // first launch: the hint offers touchpad mode
  const use = page.getByRole('button', { name: 'USE TOUCHPAD' });
  await expect(use).toBeVisible({ timeout: 10_000 });
  await use.click();
  await expect.poll(() => page.evaluate(() => (window as any).__settings.settings.value.inputMode)).toBe('touchpad');
  expect(await page.evaluate(() => (window as any).__settings.settings.value.toggleAds)).toBe(true);

  // practice match; skip the countdown
  await page.click('[data-testid="playlist-1v1"]');
  await page.$eval('[data-testid="practice"]', (el) => (el as HTMLElement).click());
  // the match view is built a moment after the session starts (behind the deploy screen)
  await page.waitForFunction(() => !!(window as any).__game?.debug().match, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const g = (window as any).__game;
    g.input.locked = true;
    document.querySelector('.overlay.deploy')?.remove();
    g.simulate(4.6, 0, 0, 0);
    // keep the bot still so it can't interfere
    const s = g.debug().session;
    for (const b of s.bots.values()) b.think = () => ({ seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, slot: 0, viewTick: 0 });
  });
  expect(await session(page, 's.round.phase')).toBe('live');
  // the host knows this player is in touchpad mode
  expect(await session(page, local('p.touchpad'))).toBe(true);

  // Space fires
  const shots0 = (await session(page, local('p.stats.shots'))) as number;
  await page.keyboard.down('Space');
  await page.waitForTimeout(700);
  await page.keyboard.up('Space');
  await expect.poll(() => session(page, local('p.stats.shots')), { timeout: 5_000 }).toBeGreaterThan(shots0);

  // Left Shift toggles aim down sights
  await page.keyboard.press('ShiftLeft');
  await expect.poll(() => session(page, local('p.ads')), { timeout: 5_000 }).toBeGreaterThan(0.9);
  await page.keyboard.press('ShiftLeft');
  await expect.poll(() => session(page, local('p.ads')), { timeout: 5_000 }).toBeLessThan(0.1);

  // reduced hip-fire spread on the host simulation
  const spreads = (await page.evaluate(() => {
    const g = (window as any).__game;
    const id = g.debug().session.localId;
    return { pad: g.debugHipSpread(id, true), mouse: g.debugHipSpread(id, false) };
  })) as { pad: number; mouse: number };
  expect(spreads.pad / spreads.mouse).toBeGreaterThanOrEqual(0.4);
  expect(spreads.pad / spreads.mouse).toBeLessThanOrEqual(0.5);

  // aim assist: put the enemy right in front of the crosshair
  const placeEnemy = () =>
    page.evaluate(() => {
      const g = (window as any).__game;
      const s = g.debug().session;
      const me = s.players.find((q: any) => q.id === s.localId);
      const en = s.players.find((q: any) => q.id !== s.localId);
      const fx = -Math.sin(g.input.yaw);
      const fz = -Math.cos(g.input.yaw);
      // find a clear spot 3-8 m ahead
      for (let d = 8; d >= 3; d -= 1) {
        if (s.world.lineOfSight(me.x, me.y + 1.5, me.z, me.x + fx * d, me.y + 1.3, me.z + fz * d)) {
          Object.assign(en, { x: me.x + fx * d, y: me.y, z: me.z + fz * d, vx: 0, vz: 0, alive: true });
          break;
        }
      }
      g.input.pitch = Math.atan2(1.25 - 1.62, Math.hypot(en.x - me.x, en.z - me.z));
    });
  await placeEnemy();
  await expect.poll(() => page.evaluate(() => (window as any).__game.input.lookScale), { timeout: 5_000 }).toBeLessThan(0.95);
  await page.evaluate(() => {
    (window as any).__settings.updateSettings({ aimAssist: 0 });
    (window as any).__game.applyInputSettings();
  });
  await placeEnemy();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__game.input.lookScale)).toBe(1);
});
