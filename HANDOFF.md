# HANDOFF: LOCKDOWN (repo `jacobkalka/Gulag`)

Paste this whole file into a new chat as the first message. It says where the project is, what is
open, and what the user asked last.

Written 2026-10-21. Git: `main` and `claude/determined-einstein-gx2izo` are both at `216ab40`.

## 1. What the project is

"LOCKDOWN": a browser arena shooter in TypeScript + Vite + three.js (r186) + Firebase + WebRTC with
host-authoritative netcode. Live at https://jacobkalka.github.io/Gulag/ (GitHub Pages, deployed
from `main`).

The user gave an upgrade prompt (`/root/.claude/uploads/5f2f7a2d-3400-50d8-a32c-b29775627305/7cbb41b0-claude-code-gulag-upgrade-prompt.md`):
"Do not rebuild it from scratch", milestones M0-M9, "Do not claim something works unless you ran
it. Ask me questions only when you are truly blocked."

## 2. Progress right now

| Milestone | State |
|---|---|
| M0 safety tag, M1 feel, M2 rendering, M3 soldiers | done |
| M4 audio | skipped at the user's request ("skip the audio section its fine") |
| M5 Sublevel 9 rework (3 levels, bots, sims) | done |
| M6 Monsoon jungle map | done (82521d5) |
| M7 snow map | scrapped at the user's request ("Scrap map 3 for now") |
| M8 map select, net sync, tests, perf docs | done (44eb888) |
| M9 deploy | pushed to `main` (216ab40); the Pages deploy workflow succeeded |

At the last full local run: lint and typecheck clean, 149 unit tests, 23 rules tests, e2e passing
locally. Working tree was clean at 216ab40 (this `HANDOFF.md` is new and uncommitted).

### CI status of 216ab40 (checked 2026-10-21)
- Branch run (`claude/determined-einstein-gx2izo`): **all 3 jobs green**.
- `main` run [38842032347](https://github.com/jacobkalka/Gulag/actions/runs/38842032347): typecheck/lint/unit/build
  and the rules job green, but **"Two-tab WebRTC match (Playwright)" failed** in test 2, "two tabs
  on Monsoon" (`e2e/netplay.spec.ts:96`): `snapshotsReceived` stayed 0 on the guest for 60 s after the
  host clicked Start. Test 1 (Sublevel 9) passed in the same run. The same commit passed that job
  on the branch run, so it is intermittent. Not diagnosed yet. A re-run was not tried.
  Likely area: the hidden-tab build path in `GameController.beginMatch` / `pendingBuild`
  (216ab40), or the slow software-GPU Monsoon build (4-14 s) racing the 60 s window.
- Deploy workflow for 216ab40 succeeded, so the live site is up to date.

## 3. OPEN BUG (highest priority for the user): live site shows only lights

User's reports (with screenshot): "this is what i get when i play. only the lights show. i run into
the buildings but i cant see them. fix this now." Then: "even on my PC with a good gpu the same
thing happens. Fix it please". Gun and HUD render; map solid surfaces do not (Mac Genspark/Chromium
and a Windows PC with a good GPU).

**Not fixed. Not reproduced. Hypothesis only.** A lit-material shader may fail to link because it
uses more than 16 texture samplers (the Chrome/ANGLE `MAX_TEXTURE_IMAGE_UNITS` limit): material
maps (map, normal, ORM) + the `surfaceFx` wet map + the light-probe 3D texture + one shadow map per
shadow-casting light (3-7 by quality) + envMap. Halo/emissive sprites and the separate viewmodel
scene use simpler shaders, which fits what the user sees. The build machine's SwiftShader has a
higher limit, so it never reproduced there.

Plan once the user allows coding again:
1. Verify first. Count active sampler uniforms per program against `MAX_TEXTURE_IMAGE_UNITS` on
   high/medium, and look for shader compile/link errors in the console. (A script for this,
   `samplers.mjs`, was planned in the scratchpad and never run.)
2. If confirmed: cap shadow-casting lights/shadow maps to `limit - fixed samplers`; drop envMap or
   the probe sampler on the heaviest materials; add a runtime guard that reads
   `MAX_TEXTURE_IMAGE_UNITS` and lowers `shadowedSpots`; add a test/audit that fails when any
   program exceeds the limit; redeploy.
3. Do not claim a fix unless it was run.
Workaround to suggest meanwhile: Settings → Graphics quality → Low. The user may also paste the
browser console output (F12) and `chrome://gpu`.

The user said **"I dont want you to code anything now."** Do not start coding on this until they say so.

Environment caveat: the cloud container cannot open `jacobkalka.github.io` (network policy; the
host would have to be added under Allowed domains).

## 4. The Unreal Engine question (UNANSWERED, answer this first)

Conversation so far:
- The user asked whether moving the game to Unreal Engine is feasible. Answer given: feasible, but
  a full rewrite; browser delivery is lost; networking needs dedicated servers or EOS/Steam;
  design/balance data and the soldier GLBs carry over.
- Can Claude Code do it without them coding? Answer given: not fully from the cloud. With a local
  Claude Code + an Unreal MCP + Python editor scripting + viewport screenshots it can do most of
  it; the user still sets up, approves and play-tests.
- Latest screenshot: Unreal Engine 5.8 editor, project "Lockdown" (Lvl_FirstPerson template, 63
  actors) with a Claude Code terminal (v2.1.306, Opus 5.5, cwd `C:\Program Files\Epic Games\UE_5.8`)
  docked inside it. The user wrote: **"as you can see, i connected claude code to the terminal in
  unreal engine, since i want to transfer the lockdown game you made here into unreal engine to
  get the best graphics and models possivle. what should i do next"**. This was never answered.

Suggested answer (no coding needed to give it):
1. Do not run the local Claude Code from `C:\Program Files\Epic Games\UE_5.8`. Start it in the
   **project folder** of "Lockdown" (the folder with `Lockdown.uproject`), and keep a second folder
   for the web-game repo.
2. Clone `jacobkalka/Gulag` on the PC (so the local Claude can read it): `UPGRADE_PLAN.md`,
   `PLAN.md`, `docs/maps/*.md` (+ `monsoon-layout.png`), `src/data/weapons.ts`,
   `src/data/playlists.ts`, `src/data/progression.ts`, `src/data/maps.ts`,
   `public/assets/soldiers/{red,camo}.glb`, `CREDITS.md`.
3. Check what the editor connection really gives it: does the Unreal MCP expose Python execution
   and viewport screenshots? If not, install/enable the Python Editor Script Plugin and an MCP
   that can run it. Without a screenshot loop it works blind.
4. Plan a **vertical slice** before anything else: one map (Sublevel 9 or Monsoon) blockout from
   the `docs/maps` layouts, one weapon class, the soldier GLB imported, bots, local play.
   Then weapons/progression data, then netcode.
5. Decide networking (dedicated server vs EOS/Steam) and the browser question (UE5 Pixel
   Streaming is an option but costs server GPUs) before building multiplayer.
6. Licensing stays mandatory: only assets whose licenses allow a public game; list them in
   `CREDITS.md`; no ripped or trademarked content (Marketplace/Fab assets included).
7. Note the local Claude Code is Opus 5.5 on the user's own plan, so usage limits apply; work in
   small steps and commit often.
Also ask whether to fix the web bug first or in parallel (Section 3), since the live game is
currently unplayable for them.

## 5. Standing constraints (still in force)

- "Include STUN and a TURN fallback config (document how to plug in a free TURN provider and read
  credentials from env/config, never commit secrets)."
- "Write proper security rules and keep them in the repo." (`firebase/database.rules.json`, tests in
  `firebase/__tests__`)
- "Licensing is mandatory: only use assets whose licenses allow use in a public game; keep
  CREDITS.md ... Never use ripped game assets or trademarked content."
- "If you judge a small Node WebSocket authoritative server ... is clearly better ... STOP and ask
  me before switching."
- Do not commit the user's stock reference photos (probably copyrighted).
- Lighting feedback: a happy medium (not too dark, not super-saturated); **no rim light** ("i want
  it to be hard to see the enemy while its dark"); every player keeps a flashlight, enemy
  flashlights dimmer; narrow beam, harsh light only on the player's own hands and gun.
- Avoid long polish loops ("youve been on the same thing forever. continue").
- Git: develop and push on `claude/determined-einstein-gx2izo` with
  `git push -u origin claude/determined-einstein-gx2izo`. Pushing `main` was authorized for M9
  only. Commit trailers: `Co-Authored-By: <model> <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01H1sp3YswvAXtWyDdXgrNeG`. No PR unless asked.

## 6. Technical map

- **Maps**: builder with mirror symmetry, zones, water volumes, bot POIs. Registry `buildMap(id)`
  and `MAP_IDS` in `src/game/world/maps.ts` (`sublevel9`, `monsoon`); lobby data in
  `src/data/maps.ts` (`MAP_INFO`, `MAP_ORDER`, `isMapChoice`, `resolveMapChoice`,
  `mapChoiceName`, `pickMatchMap`). `src/game/world/monsoon.ts` is the 96 x 72 m jungle base.
- **Collision/AI**: 2 m grid broadphase, flags SOLID / OPAQUE / CONCEAL (foliage hides but does not
  stop bullets), heightfield terrain (`terrain.ts`), multi-layer nav grid, bot lanes.
- **Rendering**: LightRig (real-light pool + baked SH probe grid + halos), `engine/surfaceFx.ts`
  (macro variation + wet mask, shader cache key `surfaceFx2`), `view/Weather.ts` (storm sky, rain,
  seeded lightning, fireflies, moon SpotLight), `PlantsView.ts` (BatchedMesh), `canopy.ts`,
  `TerrainView.ts`, `MapView.ts`, `lighting/ProbeBaker.ts`, per-map grading (`PALETTES`),
  per-quality presets (`foliage`, `sunShadowDynamic`, `shadowedSpots`, `shadowUpdates`).
- **Netcode**: protocol version 4; `RoomState.map`, `MatchStart.map`; the host resolves Random
  from the match seed; lightning is seeded by the match id and timed by `session.tick * DT`.
  Files: `net/NetHost.ts`, `NetClient.ts`, `protocol.ts`; backend in `backend/party.ts`,
  `matchmaking.ts`, `init.ts`; rules validate the `map` fields.
- **Deploy screen**: `GameController.beginMatch` shows the `deploying` signal and builds the match
  view in `setTimeout(run, 50)`; hidden tabs build immediately and the worker ticker runs
  `pendingBuild`.
- **UI**: `ui/screens/MapPicker.tsx`, `Lobby.tsx`, `Room.tsx`, `Results.tsx`, `App.tsx`,
  `menu.css`. Selected map is a signal stored in localStorage `lockdown.map.v1`, or `?map=`.
- **Tools**: `npm run botsim`, `audit:shadows|textures|contrast`, `perf:report`, `test:rules`
  (needs emulators); Playwright e2e: `e2e/netplay.spec.ts`, `touchpad.spec.ts`, `online.spec.ts`
  (`E2E_EMULATORS=1`).
- **Docs**: `UPGRADE_PLAN.md` (milestone log), `PLAN.md`, `README.md`, `SETUP.md`, `CREDITS.md`,
  `docs/perf.md`, `docs/maps/monsoon.md`, `docs/maps/monsoon-botsim.md`, screenshots in
  `screenshots/upgrade-m6/`.
- **Gotchas**: Vite HMR reloads pages when runtime modules change, so do not edit `src/` while
  audits or shots run. Firebase emulators: use `--config firebase/emulators.dev.json` and upload
  the RTDB rules with a curl PUT (`npm run emulators` fails with "Unable to parse JSON"). Tests
  must wait for `debug().match` now that the deploy screen exists. Use a pattern like
  `pkill -f '[a]udit.mjs'` so `pkill` does not match its own shell. Local CI repro: Chromium
  headless shell at `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`
  via `CHROMIUM_PATH`.

## 7. Other loose ends

- Ask the user to confirm the **Tripo license** for the soldier models allows public use.
- `scripts/fixedshots.mjs` still holds a rejected-but-applied enemylight/matelight edit; offer to
  remove it.
- Monsoon swamp contrast view is 54.5 % near-black against a 50 % limit.
- Performance numbers in `docs/perf.md` come from software rendering only; nothing has been
  measured on a real GPU.

## 8. First moves in the new chat

1. Answer the Unreal question in Section 4 (text only, no coding).
2. Ask which to do first: the live-site invisible-map fix (Section 3) or the Unreal move. Do not
   code without a go-ahead.
3. If the user says go on the bug: verify the sampler-limit hypothesis first, fix, test, deploy,
   and report only what was run.
4. Separately, re-run or investigate the intermittent Monsoon two-tab CI failure (Section 2).
