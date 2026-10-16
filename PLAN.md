# LOCKDOWN: Build Plan

LOCKDOWN is a fast, round-based, small-arena multiplayer shooter that runs in the browser.
Two teams (1v1 up to 4v4+) fight in **Sublevel 9**, a flooded prison-bunker shower block.
*(Original plan. The upgrade rebuilt Sublevel 9 on three levels and added a second map, Monsoon,
with a map select; see [UPGRADE_PLAN.md](UPGRADE_PLAN.md) and the map docs in [docs/maps/](docs/maps/).)*
The last team standing wins the round. If the clock runs out, a capture point opens over the
central drain and the first team to take it wins.

This file is the engineering plan. `README.md` covers players, `SETUP.md` covers the owner's
manual steps, and `CREDITS.md` lists assets.

---

## 1. Constraints → decisions

| Constraint | Decision |
|---|---|
| Static hosting (GitHub Pages) | Vite static build, `base: './'` (relative URLs work under any repo path), **hash routing** (`#/lobby`), deployed by GitHub Actions. |
| No custom server | **Firebase** (Spark/free). Firestore: profiles, unique usernames/friend codes, friendships, match records and XP claims. Realtime Database: presence, room codes + WebRTC signaling, parties, invites, party chat and the matchmaking queue (ephemeral data with `onDisconnect` cleanup). |
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
- Vitest (simulation, bots, netcode over a simulated lossy network, rules sync), Playwright (2-tab WebRTC
  match, online flow against emulators, screenshots), Firebase Emulator Suite (security rules).

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
    bots/                 bot brains (perception, nav, cover, aim, grenades)
    session/              MatchSession: HostSession (authoritative sim + bots) and ClientSession (prediction)
    view/                 client presentation: map meshes, characters, viewmodel, VFX, decals, camera, spectator
  net/                    binary codec + protocol, links (WebRTC PeerLink, loopback test network), signaling, NetHost/NetClient
  backend/                firebase init, account, presence, friends, parties, RTDB signaling, matchmaking, match records
  ui/                     Preact screens (lobby, room, loadout, social, stats, settings, pause, results) + imperative HUD
  data/                   weapons.ts (all stats), progression.ts (XP curve, unlocks), playlists.ts
  shared/                 math, rng
firebase/                 firestore.rules, database.rules.json, indexes, emulator config, rules tests
e2e/                      Playwright tests
scripts/                  dev helpers (screenshots)
```

The simulation (`game/sim`, `game/world`, `game/bots`) never imports three.js. It runs on the host and is
reused by the client for prediction.

## 4. Simulation & netcode

- Fixed **60 Hz** tick. `GameSim.step(inputFor)` is deterministic given its inputs. Per-player logic lives in
  `stepPlayerCore` / `finishPlayerStep`, which the client also runs for prediction.
- `PlayerInput { seq, mx, mz, yaw, pitch, buttons, slot, viewTick, life }`. Buttons are a bitfield:
  jump, crouch, sprint, fire, ads, reload, melee, swap, lethal, tactical, interact, inspect.
  `life` is a per-spawn counter: aim from inputs produced before the client saw a respawn is ignored,
  so the spawn orientation sticks.
- **Client prediction**: every input is simulated immediately with the shared code (quantized to wire
  precision first, so both sides compute identical results). Each snapshot carries the receiver's full
  simulation state and the last processed input; the client rewinds to it, replays unacknowledged inputs
  and hides any correction behind a decaying visual offset (teleports snap).
- **Interpolation**: remote players render 6 ticks (100 ms) behind the newest snapshot, using a host-clock
  estimate that tracks the fastest-arriving snapshots.
- **Lag compensation**: the host keeps ~1 s of per-tick hitbox history. Every input carries the client's
  render tick; shots are resolved against targets rewound to it (capped at 250 ms). Loopback test: 27/27
  hits on a strafing target at ~160 ms total delay, 0/27 with compensation disabled.
- **Host validation**: clients only send inputs. The host simulates at most one input per player per tick
  (a jitter buffer of 6; excess inputs are dropped with their one-shot buttons carried forward), so
  flooding cannot speed anyone up. Inputs are sanitized (NaN, ranges, slots); fire rate, ammo, reloads,
  movement and damage are all host-computed. Chat is rate limited; protocol versions must match.
- **Channels** (pre-negotiated data channels): `u` (unordered, no retransmits) carries inputs (newest 3 per
  packet) at 60 Hz, 30 Hz binary snapshots and pings; `r` (reliable) carries JSON: room lobby, match start,
  batched game events (shots, damage, kills, rounds), roster/stats and chat.
- **Snapshot** (binary): tick, ack, round state, per-player pose/velocity/flags/hp/weapon/timers, grenades,
  plus the receiver's full prediction state (`SelfState`). About 300 bytes for 4 players.
- **Events on clients**: released in step with state: immediately relevant ones once the matching snapshot
  is applied, remote players' cosmetic ones (shots, reloads, footstep-like events) at render time. The
  client's own predicted shots are deduplicated by shot number; host-confirmed hits still show blood.
- **Signaling**: `rooms/{CODE}` (claimed atomically by the host, removed on disconnect) and per-user inboxes
  `signals/{uid}/{push}` in RTDB. In offline mode `BroadcastChannel` connects tabs on one device. ICE uses
  public STUN plus optional TURN from build env (`VITE_TURN_*` or `VITE_TURN_CREDENTIALS_URL`).
- Host leaves → the match ends for everyone (no host migration; documented). Clients who leave are replaced
  by bots; late joiners take a bot's slot. A worker timer keeps a hidden host tab simulating.

## 5. Data model (Firebase)

Firestore (`firebase/firestore.rules`)
- `users/{uid}`: username, usernameLower, friendCode, xp, loadout{primary,secondary,lethal,tactical},
  stats{kills,deaths,assists,damage,headshots,shots,hits,captures,roundsWon,wins,losses,matches},
  createdAt, updatedAt, lastClaim, lastClaimAt. Loadouts must be unlocked by XP (table generated from game
  data and checked by a unit test).
- `usernames/{lower}` → {uid}, `friendCodes/{code}` → {uid}: unique registries written in the same batch as
  the profile.
- `friendships/{uidA_uidB}` (sorted pair): users[2], requester, status pending|accepted, names.
- `matches/{matchId}`: host, playlist, humans[uids], bots, state live|done, startedAt, endedAt,
  results{uid: kills, deaths, assists, headshots, damage, shots, hits, captures, roundsWon, won}.
  Only the host writes it, results only for listed humans, not before 15 s.
- `users/{uid}/claims/{matchId}`: one XP claim per match, written together with the profile update. Rules
  recompute the maximum XP from the host's result (the formula in `progression.ts`, halved for practice),
  require stats to grow by exactly the reported numbers, bound the values, and rate-limit claims (20 s).

Realtime Database (`firebase/database.rules.json`)
- `status/{uid}`: state online|lobby|room|queue|match|offline, name, party, ts (`onDisconnect` → offline).
- `rooms/{CODE}`: hostId, hostName, playlist, players, capacity, version; `signals/{uid}/{push}`: inbox.
- `parties/{pid}`: leader, state idle|queue|room, playlist, room, `seats/s0..s3` (claiming a seat caps a
  party at four), `members/{uid}`; `invites/{to}/{from}`; `partyChat/{pid}/{push}`.
- `queue/{playlist}/{ticket}`: size, names, members, ts, version, `assign` {host, room, team}.

Matchmaking (no server): each solo player or party leader holds a ticket. All queued clients watch the
queue; the **oldest** unassigned ticket coordinates. When both teams can be filled (or after 20 s with two
humans, or 45 s alone) it opens a room, claims the chosen tickets with a transaction on their `assign` child
(so two coordinators can never take the same ticket) and hosts. Assigned players (and their parties) join
by code automatically; the host starts when everyone is in or after 20 s, filling gaps with bots.

## 6. Map: Sublevel 9 (50 m × 34 m, mirrored on X)

> Superseded: this is the first version of the map. The current Sublevel 9 (72 m × 48 m on three
> levels) and Monsoon are described in [docs/maps/sublevel9.md](docs/maps/sublevel9.md) and
> [docs/maps/monsoon.md](docs/maps/monsoon.md).

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
  with multiple materials and emissive sights. Characters are armored operators: rigid parts skinned to a bone hierarchy
  (one SkinnedMesh per material keeps draw calls low), animated procedurally (locomotion, crouch, aim IK, recoil, hit
  flinch, directional death fall).
- Lighting: a pooled set of real-time lights reassigned to the nearest fixtures (no shader recompiles), a narrow
  shadowed moonlight spot through the roof hole, flickering fixtures, a reflection probe (PMREM cubemap) for wet floors
  and metal, emissive fixtures + bloom, fog, analytic volumetric light shafts and drifting dust; static geometry is
  batched per material and zone.
- Quality presets Low/Medium/High/Ultra (shadow map sizes, AO, bloom, AA, texture size, particles, light count) + resolution scale.
- Audio: synthesized at load with OfflineAudioContext (per-weapon gunshot layers, mechanics, footsteps per surface,
  impacts, UI, ambience, music loop). Positional HRTF panners. Volume buses.

## 8. Progression

- XP: kill 100, headshot +25, assist 50, capture 200, round win 150, match win 500, participation 100.
- Level curve: `xpToNext(L) = round(600 + 140·(L−1)^1.25)`, level cap 50. Weapon unlocks are front-loaded:
  every 1–2 levels early on, then every 3–5.
- All weapon stats live in `src/data/weapons.ts`.

## 9. Milestones

1. **Foundation + art test** ✅ renderer, postfx, texture factory, model toolkit, weapons, a character, map section; screenshots.
2. **Solo loop** ✅ controller, 15 weapons, hit detection, full map + collision + nav, bots, rounds/overtime, HUD, end screen.
3. **Networking** ✅ WebRTC host-authoritative rooms, prediction/interpolation/lag comp, loopback + 2-tab Playwright tests.
4. **Social** ✅ auth, usernames, friends, presence, parties, invites, chat, matchmaking, rules + emulator tests, online e2e.
5. **Progression** ✅ XP/levels/unlocks, loadout screen with 3D preview, persistence and validated claims.
6. **Polish** ✅ captions, reduce motion, lobby lineup, bot grenades, spectator camera, tracer/viewmodel fixes.
7. **Deploy** ✅ CI (checks, rules, e2e) and Pages workflows; docs. Going live needs the owner's steps in SETUP.md.

After each milestone: typecheck, lint, unit tests, screenshots, commit.
