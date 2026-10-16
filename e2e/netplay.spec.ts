import { test, expect, type Page } from '@playwright/test';

// Two browser tabs play a private-room match over real WebRTC data channels, with
// BroadcastChannel signaling (?net=local) and rendering disabled (?norender=1) so the
// simulation runs in real time under a software GPU.

type AnyWin = Window & { __game: any };

async function boot(page: Page): Promise<void> {
  page.on('pageerror', (e) => console.log(`[${page.url()}] pageerror: ${e.message}`));
  await page.goto('/?net=local&norender=1&quality=low');
  await page.waitForSelector('[data-testid="practice"]', { timeout: 150_000 });
}

const session = (page: Page, fn: string) => page.evaluate(`(() => { const s = window.__game.debug().session; return s ? (${fn}) : null; })()`);

test('two tabs: create a room, join by code, chat, play a networked round', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const guest = await ctx.newPage();
  await Promise.all([boot(host), boot(guest)]);

  // host creates a 1v1 room
  await host.click('[data-testid="playlist-1v1"]');
  await host.click('[data-testid="create-room"]');
  const codeEl = host.locator('[data-testid="room-code"]');
  await expect(codeEl).toHaveText(/^[A-Z2-9]{6}$/, { timeout: 15_000 });
  const code = (await codeEl.textContent())!.trim();

  // guest joins by code over WebRTC
  await guest.fill('[data-testid="join-code"]', code);
  await guest.click('[data-testid="join-room"]');
  await expect(guest.locator('[data-testid="room"]')).toBeVisible({ timeout: 30_000 });
  await expect(host.locator('.member:not(.empty)')).toHaveCount(2, { timeout: 15_000 });
  await expect(guest.locator('.member:not(.empty)')).toHaveCount(2);

  // lobby chat both ways
  await guest.fill('[data-testid="chat-input"]', 'gl hf');
  await guest.press('[data-testid="chat-input"]', 'Enter');
  await expect(host.locator('[data-testid="chat-lines"]')).toContainText('gl hf', { timeout: 10_000 });

  // the host starts; both build the map (behind the deploy screen) and end up in the match
  await host.click('[data-testid="start-match"]');
  await expect.poll(() => session(guest, 's.snapshotsReceived ?? -1'), { timeout: 60_000 }).toBeGreaterThan(10);
  expect(await session(guest, 's.localId')).toBe(1);
  for (const p of [host, guest]) await expect.poll(() => p.evaluate(() => (window as unknown as AnyWin).__game.inMatch), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => session(guest, 's.round.phase'), { timeout: 30_000 }).toBe('live');

  // the guest runs forward for a bit (keyboard state injected directly; no pointer lock headless)
  const start = (await session(host, '({ x: s.sim.player(1).x, z: s.sim.player(1).z })')) as { x: number; z: number };
  await guest.evaluate(() => (window as unknown as AnyWin).__game.debug().input.down.add('KeyW'));
  await guest.waitForTimeout(1500);
  await guest.evaluate(() => (window as unknown as AnyWin).__game.debug().input.down.delete('KeyW'));
  await guest.waitForTimeout(800);
  const auth = (await session(host, '({ x: s.sim.player(1).x, z: s.sim.player(1).z })')) as { x: number; z: number };
  const pred = (await session(guest, '(() => { const p = s.players.find((q) => q.id === s.localId); return { x: p.x, z: p.z }; })()')) as { x: number; z: number };
  expect(Math.hypot(auth.x - start.x, auth.z - start.z)).toBeGreaterThan(1.5);
  expect(Math.hypot(pred.x - auth.x, pred.z - auth.z)).toBeLessThan(0.05);
  const ping = (await session(guest, 's.ping()')) as number;
  expect(ping).toBeGreaterThan(0);
  expect(ping).toBeLessThan(250);

  // the guest leaves mid-match: a bot takes over the slot, the host's room shows one member
  await guest.evaluate(() => {
    const g = (window as unknown as AnyWin).__game;
    g.leaveMatch(true);
    g.rooms.leaveRoom();
  });
  await expect.poll(() => session(host, 's.sim.player(1).bot'), { timeout: 15_000 }).toBe(true);
  await host.evaluate(() => (window as unknown as AnyWin).__game.debug().rooms.leaveRoom());
  await ctx.close();
});

test("two tabs on Monsoon: the host's map pick, a full match, XP, back to the room together", async ({ browser }) => {
  test.setTimeout(360_000);
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const guest = await ctx.newPage();
  await Promise.all([boot(host), boot(guest)]);
  const xpBefore = (await guest.evaluate(() => JSON.parse(localStorage.getItem('lockdown.profile.v1') || '{"xp":0}').xp)) as number;

  // the host picks Monsoon and opens a 1v1 room
  await host.click('[data-testid="playlist-1v1"]');
  await host.click('[data-testid="map-monsoon"]');
  await host.click('[data-testid="create-room"]');
  const codeEl = host.locator('[data-testid="room-code"]');
  await expect(codeEl).toHaveText(/^[A-Z2-9]{6}$/, { timeout: 15_000 });
  await guest.fill('[data-testid="join-code"]', (await codeEl.textContent())!.trim());
  await guest.click('[data-testid="join-room"]');
  await expect(guest.locator('[data-testid="room"]')).toBeVisible({ timeout: 30_000 });
  // the guest's room panel shows the host's pick
  await expect(guest.locator('[data-testid="map-monsoon"]')).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });

  // both tabs build and play Monsoon
  await host.click('[data-testid="start-match"]');
  await expect.poll(() => session(guest, 's.snapshotsReceived ?? -1'), { timeout: 60_000 }).toBeGreaterThan(10);
  expect(await session(host, 's.map.id')).toBe('monsoon');
  expect(await session(guest, 's.map.id')).toBe('monsoon');

  // play it out: the host's simulation knocks the guest down every live round until someone wins
  await expect
    .poll(
      () =>
        host.evaluate(() => {
          const s = (window as unknown as AnyWin).__game.debug().session;
          if (!s) return 'gone';
          if (s.round.matchWinner !== -1) return 'over';
          const v = s.sim.player(1);
          if (s.round.phase === 'live' && v?.alive) s.sim.applyDamage(s.sim.player(0), v, 500, 'head', 'halberd', v.x, v.y + 1.6, v.z);
          return s.round.phase;
        }),
      { timeout: 150_000, intervals: [500] },
    )
    .toMatch(/over|gone/);

  // results on both screens, with XP for the guest
  await expect(host.locator('[data-testid="results"]')).toBeVisible({ timeout: 30_000 });
  await expect(guest.locator('[data-testid="results"]')).toBeVisible({ timeout: 30_000 });
  await expect(guest.locator('.res-sub')).toContainText('MONSOON');
  await expect.poll(() => guest.evaluate(() => JSON.parse(localStorage.getItem('lockdown.profile.v1') || '{"xp":0}').xp) as Promise<number>, { timeout: 30_000 }).toBeGreaterThan(xpBefore);

  // both go back to the room (a guest reading the results isn't pulled away); the room is intact
  await host.click('[data-testid="play-again"]');
  await expect(host.locator('[data-testid="room"]')).toBeVisible({ timeout: 15_000 });
  await guest.click('[data-testid="play-again"]');
  await expect(guest.locator('[data-testid="room"]')).toBeVisible({ timeout: 30_000 });
  await expect(host.locator('.member:not(.empty)')).toHaveCount(2, { timeout: 15_000 });
  await expect(guest.locator('[data-testid="map-monsoon"]')).toHaveAttribute('aria-checked', 'true');

  await guest.evaluate(() => (window as unknown as AnyWin).__game.rooms.leaveRoom());
  await host.evaluate(() => (window as unknown as AnyWin).__game.rooms.leaveRoom());
  await ctx.close();
});
