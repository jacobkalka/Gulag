import { test, expect, type Browser, type Page } from '@playwright/test';

// Online features end to end against the Firebase Emulator Suite (auth, firestore, database).
// Run the emulators first (npm run emulators, plus the RTDB rules upload described in SETUP.md),
// then: E2E_EMULATORS=1 npx playwright test e2e/online.spec.ts

test.skip(!process.env.E2E_EMULATORS, 'needs the Firebase emulators (set E2E_EMULATORS=1)');

type W = Window & { __game: any; __state: any };

async function player(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  await page.goto('/?emulators=1&norender=1&quality=low');
  await page.waitForSelector('[data-testid="practice"]', { timeout: 150_000 });
  await page.click('[data-testid="nav-social"]');
  await expect(page.locator('[data-testid="account-status"]')).toHaveText('GUEST (CLOUD SAVE)', { timeout: 30_000 });
  return page;
}

const st = (p: Page, expr: string) => p.evaluate(`(() => { const s = window.__state; return ${expr}; })()`);

test('accounts, friends, party, room, networked match, XP claims, matchmaking', async ({ browser }) => {
  test.setTimeout(420_000);
  const [a, b] = await Promise.all([player(browser), player(browser)]);
  const nameA = (await st(a, 's.profile.value.username')) as string;
  const nameB = (await st(b, 's.profile.value.username')) as string;
  const codeB = (await b.locator('[data-testid="friend-code"]').textContent())!.trim();
  expect(codeB).toMatch(/^[A-Z2-9]{6}$/);

  // rename B (unique name registry)
  const newB = `Bee${Date.now() % 100000}`;
  await b.fill('[data-testid="name-input"]', newB);
  await b.click('[data-testid="rename"]');
  await expect.poll(() => st(b, 's.profile.value.username'), { timeout: 10_000 }).toBe(newB);

  // friend request by code, accepted by B
  await a.fill('[data-testid="add-friend-input"]', codeB);
  await a.click('[data-testid="add-friend"]');
  await expect(b.locator(`[data-testid="accept-${nameA}"]`)).toBeVisible({ timeout: 15_000 });
  await b.click(`[data-testid="accept-${nameA}"]`);
  await expect(a.locator(`[data-testid="friend-${newB}"]`)).toContainText('IN LOBBY', { timeout: 15_000 });

  // party invite -> join
  await a.click(`[data-testid="invite-${newB}"]`);
  await b.locator('.toast', { hasText: 'PARTY INVITE' }).getByText('JOIN').click({ timeout: 15_000 });
  await expect(a.locator('[data-testid="party-members"] .member')).toHaveCount(2, { timeout: 15_000 });
  await a.fill('[data-testid="party-chat-input"]', 'squad up');
  await a.press('[data-testid="party-chat-input"]', 'Enter');
  await expect(b.locator('.chat-lines.short')).toContainText('squad up', { timeout: 10_000 });

  // the leader opens a 1v1 room; the party member follows automatically
  await a.click('[data-testid="nav-play"]');
  await a.click('[data-testid="playlist-1v1"]');
  await a.click('[data-testid="create-room"]');
  await expect(a.locator('.member:not(.empty)')).toHaveCount(2, { timeout: 30_000 });
  await b.click('[data-testid="nav-play"]');
  await expect(b.locator('[data-testid="room"]')).toBeVisible({ timeout: 10_000 });

  // play: host starts; force a quick decisive finish after the 30 s minimum
  await a.click('[data-testid="start-match"]');
  await expect.poll(() => b.evaluate(() => (window as unknown as W).__game.debug().session?.snapshotsReceived ?? 0), { timeout: 30_000 }).toBeGreaterThan(10);
  await a.waitForTimeout(33_000);
  await a.evaluate(() => {
    const sim = (window as unknown as W).__game.debug().session.sim;
    sim.round.score = [sim.rules.roundsToWin - 1, 0];
    const host = sim.players.find((p: any) => p.id === 0);
    for (const p of sim.players) if (p.team === 1) { p.spawnProt = 0; sim.applyDamage(host, p, 999, 'head', 'halberd', 0, 1, 0); }
  });
  for (const p of [a, b]) await expect(p.locator('[data-testid="results"]')).toBeVisible({ timeout: 60_000 });
  // validated XP claims land in both profiles
  await expect.poll(() => st(a, 's.profile.value.xp'), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => st(b, 's.profile.value.xp'), { timeout: 30_000 }).toBeGreaterThan(0);
  const xpA = (await st(a, 's.profile.value.xp')) as number;
  const xpB = (await st(b, 's.profile.value.xp')) as number;
  expect(xpA).toBeGreaterThan(xpB); // the winner earns more
  expect(await st(a, 's.profile.value.stats.wins')).toBe(1);
  expect(await st(b, 's.profile.value.stats.losses')).toBe(1);

  // leave the room and the party, then find each other through matchmaking
  await a.click('[data-testid="back-lobby"]');
  await b.click('[data-testid="back-lobby"]');
  await a.click('[data-testid="nav-social"]');
  await a.click('[data-testid="leave-party"]');
  await expect.poll(() => st(b, 's.party.value'), { timeout: 15_000 }).toBeNull().catch(async () => {
    await b.click('[data-testid="nav-social"]');
    await b.click('[data-testid="leave-party"]');
  });
  for (const p of [a, b]) {
    await p.click('[data-testid="nav-play"]');
    await p.click('[data-testid="playlist-1v1"]');
  }
  await a.click('[data-testid="find-match"]');
  await b.click('[data-testid="find-match"]');
  await expect.poll(() => b.evaluate(() => (window as unknown as W).__game.debug().session?.snapshotsReceived ?? 0), { timeout: 60_000 }).toBeGreaterThan(10);
  expect(await a.evaluate(() => (window as unknown as W).__game.debug().session?.sim?.players.filter((p: any) => !p.bot).length)).toBe(2);
  void nameB;
});
