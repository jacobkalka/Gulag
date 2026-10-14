# LOCKDOWN: Build Plan

LOCKDOWN is a fast, round-based, small-arena multiplayer shooter that runs in the browser.
Two teams (1v1 up to 4v4+) fight in **Sublevel 9**, a flooded prison-bunker shower block.
The last team standing wins the round. If the clock runs out, a capture point opens over the
central drain and the first team to take it wins.

This file is the engineering plan. `README.md` covers players, `SETUP.md` covers the owner's
manual steps, and `CREDITS.md` lists assets.

---

## 1. Constraints → decisions

| Constraint | Decision |
|---|---|
| Static hosting (GitHub Pages) | Vite static build, `base: './'` (relative URLs work under any repo path), **hash routing** (`#/lobby`), deployed by GitHub Actions. |
| No custom server | **Firebase** (Spark/free): Auth, Firestore (profiles, friends, parties, queue, matches), Realtime Database (presence + WebRTC signaling, since `onDisconnect` makes cleanup reliable). |
| Real-time play | **WebRTC data channels**, star topology, **host-authoritative**: one player's browser runs the simulation; others send inputs and receive snapshots. |
| Asset CDNs (ambientCG, Poly Haven, Kenney, freesound) are unreachable from the build sandbox | **Everything is procedural and original**: GPU-generated PBR textures, code-modeled weapons/characters/props, WebAudio-synthesized sound. No downloads, no licensing risk, tiny payload. Fonts are OFL via `@fontsource`. |
| Works before Firebase is configured | **Offline mode**: local guest profile (localStorage), bot matches, and same-browser multi-tab rooms via `BroadcastChannel` signaling (also used by automated tests). |

Switching to a Node WebSocket server was considered and rejected for now. P2P avoids hosting cost and
cold starts, but it trusts the host and depends on NAT traversal, so a TURN fallback is supported.
See README "Known limitations".

## 2. Tech stack

- TypeScript (strict) · Vite 8 · three.js r186 (WebGL2)
- `postprocessing` (pmndrs) + `n8ao` (GTAO-style SSAO): ACES filmic, bloom, SMAA/FXAA, vignette, grain, chromatic aberration, motion blur (toggles).
- Custom collision (cylinder-vs-AABB/ramp sweep, grid-accelerated raycasts). No physics engine is needed for a box-built arena.
- Preact + signals for menus; the HUD is imperative DOM that updates only changed values, for speed.
- Firebase JS SDK v13 (modular).
- Vitest (pure logic), Playwright (screenshots, solo smoke test, 2-tab WebRTC test), Firebase Emulator Suite (rules).

## 3. Folder structure

```
src/
  main.ts                 boot: loading screen → app
  app/                    app state machine, routing, settings store, match session glue
  engine/                 renderer, quality presets, postfx, input (pointer lock, rebinding, gamepad), audio engine, loop
  assets/                 procedural generators: textures (GPU), geometry toolkit, weapon/character/prop models, sounds
  game/
    sim/                  PURE simulation (no three.js): GameSim, movement, weapons, damage, rounds, objective, lag-comp history
    world/                collision world, raycasts, map definition (data), nav grid
    bots/                 bot brains (perception, nav, cover, aim)
    view/                 client presentation: map meshes, characters, viewmodel, VFX, decals, camera, spectator
  net/                    signaling (RTDB, BroadcastChannel), peer manager, binary protocol, host/client runners
  backend/                firebase init, auth, profile, friends, presence, parties, matchmaking, results
  ui/                     Preact screens (lobby, loadout, social, stats, settings, matchmaking, end screen) + imperative HUD
  data/                   weapons.ts (all stats), progression.ts (XP curve, unlocks), playlists.ts, constants
  shared/                 shared types, math, rng, binary reader/writer
firebase/                 firestore.rules, database.rules.json, indexes, emulator config, rules tests
e2e/                      Playwright tests
scripts/                  dev helpers (screenshots)
```

The simulation (`game/sim`, `game/world`, `game/bots`) never imports three.js. It runs on the host and is
reused by the client for prediction.

## 4. Simulation & netcode

- Fixed **60 Hz** tick. `GameSim.step(inputsByPlayer)` is deterministic given its inputs.
- `PlayerInput { seq, moveX, moveZ, yaw, pitch, buttons, weaponSlot, viewTick }`. Buttons are a bitfield:
  jump, crouch, sprint, fire, ads, reload, melee, swap, lethal, tactical, interact.
- **Client prediction**: the local player runs the shared movement code every tick. Unacknowledged inputs
  are kept and replayed when an authoritative snapshot (carrying `lastInputSeq`) arrives. Small errors are
  smoothed and large ones snap.
- **Interpolation**: remote players render about 100 ms in the past, between buffered snapshots.
- **Lag compensation**: the host keeps 1 s of per-tick hitbox history. Each shot carries the client's
  interpolated `viewTick`. The host rewinds targets to that tick (capped at 250 ms) before raycasting.
- **Host validation**: inputs are applied by the host (clients never send positions). At most 2 inputs are
  processed per client per tick. Fire rate, ammo, reload and ADS timings, and damage are all computed by
  the host. View angles are clamped.
- **Channels**: `u` (unordered, no retransmit) carries inputs at 60 Hz with 3-input redundancy and
  snapshots at 30 Hz. `r` (reliable) carries JSON control messages: welcome, config, loadout, chat,
  kill feed, round/match events, ping.
- **Snapshot** (binary, quantized): tick, round phase/timer, objective, and per-player data
  (pos 16-bit fixed, yaw/pitch 16-bit, vel 8-bit, flags, hp, weapon, ammo for the owner only), plus the
  shots fired since the last snapshot (shooter, end point, surface, hit flag) so remote tracers and impacts render.
- **Signaling**: `rooms/{roomId}/peers` and `rooms/{roomId}/signals/{to}/{push}` in RTDB, with
  `onDisconnect` cleanup. ICE uses public STUN plus optional TURN from env (`VITE_TURN_*`) or a
  credentials URL (`VITE_TURN_CREDENTIALS_URL`, e.g. Metered/Cloudflare).
- Host leaves → the match ends for everyone (no host migration; documented).

## 5. Data model (Firebase)

Firestore
- `users/{uid}`: username, usernameLower, friendCode, xp, level, stats{kills,deaths,wins,losses,matches,headshots,damage,shots,hits,captures}, loadout{primary,secondary,lethal,tactical}, createdAt
- `usernames/{lower}`: {uid}, created in the same batch as the profile, which makes usernames unique
- `friendCodes/{code}`: {uid}
- `friendships/{uidA_uidB}` (sorted pair): members[2], status pending|accepted, requestedBy, createdAt
- `users/{uid}/blocked/{otherUid}`
- `parties/{partyId}`: leader, members[], memberInfo{uid:{name,level,ready,color}}, playlist, state idle|queued|matched, ticketId, matchId, updatedAt
- `parties/{partyId}/messages/{id}`: party chat
- `invites/{partyId_toUid}`: from, fromName, to, partyId, createdAt
- `queue/{ticketId}`: partyId, leader, playlist, members[], size, status waiting|matched|cancelled, matchId, createdAt, heartbeat
- `matches/{matchId}`: playlist, host, teams{A[],B[]}, players[], bots, state forming|live|finished, createdAt, result{winner, rounds, players{uid:{kills,deaths,assists,damage,headshots,captures,won,xp}}}
- `users/{uid}/claims/{matchId}`: an XP claim. Rules check that the XP delta equals the match result award and that a match can only be claimed once.

Realtime Database
- `status/{uid}`: {state online|offline, activity lobby|party|queue|match, partyId, t}, with `onDisconnect` set to offline
- `rooms/{roomId}`: {host, code, playlist, createdAt}, `peers/{uid}`, `signals/{toUid}/{pushId}`
- `roomCodes/{CODE}`: roomId (private matches)

Matchmaking (no server): each party leader writes a queue ticket and heartbeats it. The leader of the
**oldest** live ticket for a playlist acts as matchmaker. Every 2 s it packs parties into two teams
(first-fit by age), then in a transaction re-validates the tickets, writes them `matched`, and creates the
match doc with itself as host. Stale tickets (no heartbeat for 20 s) are ignored. After 30 s, missing slots can be
filled by bots (leader toggle).

## 6. Map: Sublevel 9 (50 m × 34 m, mirrored on X)

```
 z=+17 ┌──────────┬───────────────────────────────────────────┬──────────┐
       │ PUMP RM  │  BOILER HALL  (6 m tall, catwalk on N wall │ PUMP RM  │
       │          │  at 2.7 m, ramps at both ends, 3 boilers)   │          │
 z=+5  ├──────────┤ ─ ─door─ ─ ─ ─ door ─ ─ door ─ ─ ─ door─ ─ ├──────────┤
       │ INTAKE A │ LOCKER RM │      SHOWERS / THE DRAIN    │LOCKER RM│ INTAKE B │
       │ (spawn)  │ lockers,  │ tiled half-walls, pillars,  │         │ (spawn)  │
       │          │ benches   │ roof hole + capture point   │         │          │
 z=-5  ├──────────┤ ─ ─door─ ─ ─ ─ breach ─ ─ breach ─ ─ ─door─ ─ ├──────────┤
       │ LAUNDRY  │  CELL BLOCK corridor + 2×5 cells (broken walls)│ LAUNDRY  │
 z=-17 └──────────┴───────────────────────────────────────────┴──────────┘
      x=-25     x=-19   x=-9                          x=+9    x=+19     x=+25
```

- Cover vocabulary: **low rubble** 0.5 m (step/mantle), **crouch cover** 1.2 m (hides a crouched player, standing can fire over),
  **chest cover** 1.4 m (head-glitch peeks), **full cover** ≥ 2 m (strafe peeks).
- Sightlines: the longest are the catwalk (~26 m) and the cell corridor (broken by a guard checkpoint at x=0), so no lane dominates.
- Optional shutters close the side rooms for 1v1 so the arena is tighter.
- Overtime flag: radius 2.5 m at the drain (0,0), under the collapsed roof's moonlight shaft.

## 7. Rendering & assets

- GPU **TextureFactory**: fragment shaders write albedo / normal / ORM maps (concrete, wet floor, tiles, painted & rusty metal,
  grating, wood, rubber, gun finishes, fabrics) into render targets with mipmaps. Resolution depends on quality.
- **Geometry toolkit**: beveled boxes, beveled profile extrusions, lathes, rails/screws. Weapons are built from 20–60 parts
  with multiple materials and emissive sights. Characters are armored operators built from rigid parts on a joint hierarchy
  and animated procedurally (locomotion blend, crouch, aim IK, recoil, hit flinch, ragdoll-lite death).
- Lighting: real-time key lights (moon shaft shadows, a few shadowed spots), many unshadowed fixture lights with flicker,
  a reflection probe (the map rendered to a PMREM cubemap) for wet-floor and metal reflections, emissive fixtures + bloom,
  height fog and light-shaft cards, plus baked per-vertex AO/light where it pays off.
- Quality presets Low/Medium/High/Ultra (shadow map sizes, AO, bloom, AA, texture size, particles, light count) + resolution scale.
- Audio: synthesized at load with OfflineAudioContext (per-weapon gunshot layers, mechanics, footsteps per surface,
  impacts, UI, ambience, music loop). Positional HRTF panners. Volume buses.

## 8. Progression

- XP: kill 100, headshot +25, assist 50, capture 200, round win 150, match win 500, participation 100.
- Level curve: `xpToNext(L) = round(600 + 140·(L−1)^1.25)`, level cap 50. Weapon unlocks are front-loaded:
  every 1–2 levels early on, then every 3–5.
- All weapon stats live in `src/data/weapons.ts`.

## 9. Milestones

1. **Foundation + art test**: renderer, postfx, texture factory, model toolkit, two weapons, a character, a map section; screenshots.
2. **Solo loop**: controller, weapons, hit detection, full map + collision + nav, bots, rounds/overtime, HUD, end screen.
3. **Networking**: WebRTC host-authoritative rooms, prediction/interpolation/lag-comp, Playwright 2-tab test.
4. **Social**: auth, usernames, friends, presence, parties, invites, chat, matchmaking, rules + emulator tests.
5. **Progression**: XP/levels/unlocks, loadout screen with 3D preview, persistence & validated claims.
6. **Polish**: audio, VFX, animation, UI juice, perf/quality tuning, accessibility, bugs.
7. **Deploy**: Actions → Pages, docs, live verification.

After each milestone: typecheck, lint, unit tests, screenshots, commit.
