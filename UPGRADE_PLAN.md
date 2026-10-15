# LOCKDOWN Upgrade Plan

The major upgrade (dark, dramatic visuals, three maps, the provided soldier models, real-sounding audio,
touchpad controls, camera feel and rebalancing) is built on top of the existing game, not a rewrite. This
file is the working plan: decisions, risks, and a checklist that maps every item of the request to the
milestone that delivers it. It is updated at the end of each milestone.

Safety net: the pre-upgrade state is tagged `v1-before-upgrade` (commit `705240d`). The tag exists in
the local clone; this session's git proxy refuses tag pushes, so on GitHub the same commit is
identified by its hash. Fixed-camera
screenshots of that build are in [`screenshots/before/`](screenshots/before/) (taken with
`node scripts/fixedshots.mjs screenshots/before medium`).

## 1. Where things stand (pre-upgrade)

| Area | Today | Main files |
|---|---|---|
| Rendering | three.js r186 WebGL2, pmndrs postprocessing (N8AO, bloom, ACES, SMAA, CA, grain, vignette, motion blur), one moon light through a roof hole, fixture point/spot light pool (4-16 lights, 0-4 shadowed), analytic light shafts, one PMREM reflection probe, static batching | `src/engine/Renderer.ts`, `src/engine/quality.ts`, `src/game/view/LightManager.ts`, `Atmosphere.ts`, `MapView.ts` |
| Textures | 30 GPU-generated PBR recipes (albedo, normal, ORM), sizes per quality preset | `src/assets/textures/*` |
| Models | Code-modeled weapons (15), operators (rigid-skinned), props | `src/assets/models/*` |
| Map | One indoor map, Sublevel 9 (~56 x 36 m, single floor), box colliders, 2D nav grid | `src/game/world/sublevel9.ts`, `collision.ts`, `src/game/bots/NavGrid.ts` |
| Simulation | Fixed 60 Hz, shared by host and predicting client: movement, weapons, hitboxes, lag compensation, rounds, capture point | `src/game/sim/*` |
| Netcode | Host-authoritative WebRTC (binary unreliable inputs/snapshots, JSON reliable events), prediction and reconciliation, interpolation | `src/net/*`, `src/game/session/*` |
| Online | Firebase Auth, Firestore profiles/friends/match records, RTDB presence, parties, rooms, matchmaking queue, signaling; security rules with tests | `src/backend/*`, `firebase/*` |
| Audio | WebAudio, everything synthesized at load into buffers, HRTF panning | `src/engine/audio/*` |
| UI | Preact screens and settings, DOM HUD | `src/ui/*` |

Observations from the before-shots: lit rooms read flat and evenly bright, with too much fill. The
muzzle-flash light floods a whole room orange on every shot. The sniper tracer is a long bright streak
crossing the scope view. The art test camera views look clean rather than lived-in.

## 2. Environment constraints found in Milestone 0

| Constraint | Effect | Plan |
|---|---|---|
| ambientCG, Poly Haven, Kenney, Quaternius, freesound, OpenGameArt, Sonniss, Hugging Face and the jsDelivr/unpkg CDNs are unreachable from the build container (proxy refuses the connection) | The CC0 texture, audio and animation downloads the request suggests are not possible from here | Upgrade the in-code generators instead: GPU PBR texture recipes with height, detail and decal passes, and physically modeled layered audio with generated impulse responses. Add a manifest-based loader so CC0 KTX2/Opus files can be dropped into `public/assets/` later without code changes. Look for CC0 mirrors on GitHub raw (reachable) and record any found in `CREDITS.md`. |
| Blender is not installed, but the `bpy` 5.2.2 module installs from PyPI | Rigging can be scripted here, so no Mixamo detour is needed | Soldier pipeline in Python/bpy (`tools/soldiers/`), run once; its output GLBs are committed |
| npm, PyPI, raw.githubusercontent.com and GitHub release downloads work | KTX-Software (`toktx`), meshoptimizer, three-mesh-bvh and recast-navigation are all available | Use them |
| Only SwiftShader (software GL) in the container | Real-GPU frame rates can't be measured here | Budget-driven performance: draw calls, triangles, shadow-map renders and texture memory per preset, measured with the `?perf` overlay and recorded in `docs/perf.md`. Software frame time is reported as a relative number only. |
| github.io is unreachable from the container | The live site can't be loaded from here | Verify the Pages deploy through the GitHub Actions run and the built artifact (base path, asset URLs). Ask the user to confirm in a browser. |

## 3. The provided soldiers

| File | Look | Mesh | Textures | Rig |
|---|---|---|---|---|
| `incoming/soldiers/soldier_7d94e15d.glb` | **Black-and-red** (black camo with red trims, helmet with NVG mount) | 1.9 M triangles, 0.98 units tall, A-pose, faces +X | 4096² albedo / ORM / normal (Tripo AI PBR) | None, no animations |
| `incoming/soldiers/soldier_a5f0105a.glb` | Woodland multicam camo, tan boots | 1.9 M triangles, 0.98 units tall, A-pose, faces +X | 4096² albedo / ORM / normal | None, no animations |

Both are clean A-pose characters with empty hands, which is ideal for automatic rigging.

Pipeline (`tools/soldiers/build.py`, Blender `bpy` headless). Steps 1-7 are offline, step 8 is runtime:
1. Decompress meshopt, import, rotate to -Z forward, scale to 1.80 m, feet at the origin.
2. Decimate to LOD0 about 24k triangles, LOD1 about 8k, LOD2 about 2.5k, preserving UV seams. Bake the
   high-poly normal detail into a new tangent-space normal map for LOD0 so the decimated silhouette keeps
   the detail.
3. Fit a humanoid skeleton to the mesh: joints found from cross-sections and limb analysis, then
   verified with overlay renders. Bone names match the engine's rig (hips, spine, chest, neck, head,
   clavicles, upper/lower arms, hands, fingers, thighs, shins, feet, toes).
4. Skin with bone-heat weights. If the heat solve fails on the non-manifold scan mesh, compute weights
   on a voxel-remeshed proxy and transfer them. Then smooth, limit to 4 influences and normalize.
5. Textures: 2048² for LOD0 and 1024² for LOD1/LOD2, encoded as KTX2 (UASTC for normals, ETC1S for
   color/ORM). Geometry compressed with meshopt.
6. Write `public/assets/soldiers/{red,camo}.glb` and render turntable proofs.
7. **Animation**: no mocap library is reachable, so clips are authored in code. An IK-driven gait
   generator plants the feet at exactly the ground speed, so there is no foot sliding by construction.
   It covers 8-way walk, run, sprint, crouch, jump, slide and mantle; key-posed clips cover reload per
   class, swap, hit reactions and death variants.
8. At runtime, `THREE.AnimationMixer` runs them in a state machine with crossfades, a 2D locomotion blend
   space and speed-synced playback. Upper-body aim offset and two-handed weapon IK are applied on top.
   **Fallback:** if the procedural clips look stiff, the next step from the request is to ask for
   Mixamo-rigged exports and animations, which the same runtime can load.

## 4. Key design decisions

- **Flashlight on `F`.** `F` was the flash grenade, so the tactical moves to `X` (still rebindable).
  The flashlight is a shadow-casting spotlight from the weapon. Its on/off state is a bit in the
  snapshot so other players see the beam.
- **Touchpad mode** adds key bindings on top of the normal set:
  - Fire on `Space`.
  - Aim on `Left Shift`, toggle by default.
  - Jump moves to `E`.
  - Sprint on `Q`, plus an Auto-sprint option that defaults on in touchpad mode.
  - Weapon swap by two-finger scroll or `1`/`2`.
  - Optional arrow-key look.

  The host stores each player's declared input mode. Touchpad hip spread uses a fixed host-side
  multiplier (0.45, clamped to 0.4-0.5 in `src/data/weapons.ts`), never a client-supplied value. Aim
  assist is a local camera slowdown and stickiness only.
- **Regeneration**: host-side in `GameSim`. Numbers live in `src/data/gameplay.ts` (delay 5 s, about
  3 s to refill). HP is already part of the snapshot, so clients see it without new messages.
- **Balance**: all stats stay in `src/data/weapons.ts`. Damage is scaled per class so TTK grows
  1.5-1.8x: snipers keep a one-shot headshot, and shotguns keep a close-range kill. `npm run balance`
  prints TTK per weapon at close/mid/long range, body and head, and a unit test keeps every weapon
  inside the target band.
- **Movement**: about 25% faster, with sharper acceleration and deceleration, more air control, a
  momentum-preserving slide and faster crouch. Host and client share `stepMovement`, so prediction stays
  exact. Prediction error and rubber-banding are tested with the simulated network at 80-150 ms.
- **Team skins**: the host draws `redTeam` (0 or 1) at match start and sends it with the start message
  (and in the late-join roster). It never changes within a match. Bots use the same assignment. HUD
  colors stay relative (friend/enemy, colorblind palettes) and independent of the skin.
- **Maps** are data plus code generators with a per-match seed for scatter and weather, sent by the
  host. Each map module is lazy-loaded with a real progress bar. Collision gains heightfield terrain,
  oriented boxes, cylinders, ramps and multi-level floors, with a uniform-grid broadphase. Bots move
  from the 2D grid to a **Recast navmesh** (`recast-navigation`, WASM, works in Node), generated from
  each map's collision geometry and cached.
- **Lighting budget**: a pool of 2 / 4 / 6 / 8 shadowed lights (Low/Medium/High/Ultra), reassigned to
  the most important fixtures near the camera with smooth fades. Unshadowed point lights and fake
  volumetric cones cover the rest. Static AO and bounce are baked at load (BVH ray casts into vertex AO
  and an irradiance probe grid), so shadows aren't flat gray. Per-map grading in a custom
  LUT/curve pass, eye adaptation, clamped bloom, and halo sprites.
- **ADS clarity**: while aiming, CA, grain, motion blur and vignette go to zero, bloom drops, and the
  scope mask covers only the area outside the lens.

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Auto-rigging a scanned mesh gives bad deformation (armpits, crotch, gear) | Medium | Voxel proxy weights, weight smoothing, rigid gear regions; inspect bend tests in `?animtest`; Mixamo fallback |
| Procedural animation looks robotic | Medium | IK gait with proper pelvis motion, counter-rotation and arm swing, crossfades and secondary motion; review GIF captures |
| Scope of three large maps with foliage | High | Shared generator toolkit (terrain, scatter, structures), instancing, LOD/impostors; maps built one after another with screenshots and sims |
| Performance of shadows and foliage on mid-range laptops | Medium | Hard budgets per preset; foliage only casts shadows from the nearest shadowed lights; impostors at distance; measured in `docs/perf.md` |
| Realistic audio without recorded samples | High | Layered physical-model synthesis plus convolution reverb gets close but is not equal to recordings; documented honestly; drop-in sample manifest for real CC0 files |
| Netcode regressions (new snapshot fields, map/skin sync) | Medium | Protocol unit tests, netplay tests over the simulated lossy network, multi-tab Playwright on each map |
| Firebase rules changes (map selection in parties, queue and rooms) | Low | Rules tests in the emulator suite (`npm run test:rules`) |
| Bundle size | Low | Procedural assets cost no download. Soldier GLBs are about 2-4 MB each after KTX2 and meshopt. Maps lazy-load. Total stays far below 400 MB. |

## 6. Checklist (request item → milestone)

Status: ☐ open, ☑ done (verified by running it), ◐ partial (see notes).

### Section 1 – Look
| Item | M | Status |
|---|---|---|
| 1A Much darker overall, very low ambient, dim cold moonlight at most | 2 | ☑ retuned to the user's "happy medium" (M2) |
| 1A Every visible light source is a real light with falloff, glow, shadows | 2 | ☑ LightRig: real-light pool + baked probes + halos (M2) |
| 1A Pools of light, deep shadows, cones through dust/steam/rain/snow, silhouettes | 2, 6, 7 | ◐ dust cones on Map 1; rain/snow with Maps 2-3 |
| 1A Flicker, buzz, swinging lights on chains, broken lights, varied color temperature | 2 | ☑ |
| 1A Readability guardrails (rim light, ambient floor), Brightness/Gamma setting | 2 | ☑ ambient floor + Brightness; rim light dropped at the user's request (enemies should be hard to see in the dark) |
| 1A Weapon flashlight on F, real shadowed spotlight, visible to other players | 2 | ☑ narrow 8.6° beam, harsh light on hands/gun, enemy lights 40% as bright |
| 1B Every object casts and receives shadows | 2, 5-7 | ◐ Map 1 passes `audit:shadows`; Maps 2-3 later |
| 1B Budgeted shadows: baked AO, pool of nearest shadow lights, fake cones for the rest, tuned bias | 2 | ☑ |
| 1B `npm run audit:shadows` with allow-list, run on every map | 2, 8 | ◐ passes on Map 1; runs on each new map |
| 1C Full PBR sets everywhere (albedo, normal, roughness, AO, metal/emissive, height on key surfaces) | 2 | ☑ `audit:textures` passes |
| 1C Break up repetition: macro variation, detail blending, vertex grime, decals, edge wear | 2 | ◐ macro variation + PBR decal atlas; edge wear open |
| 1C Wet surfaces look wet; snow looks like snow | 2, 7 | ◐ wet floors done (M2); snow in M7 |
| 1C `npm run audit:textures`, zero unexplained hits | 2 | ☑ |
| 1C KTX2/Basis textures, meshopt models, under 400 MB, lazy-load per map | 3, 8 | ☐ |
| 1D Upgraded models with more detail, damage, wear | 2, 5-7 | ☐ |
| 1D 3-5 variants of common props | 2 | ☑ crate x5, case x3, drum (dented/open), bench x2 |
| 1D Seeded scatter (same for all players), clear movement lanes, matching collision proxies | 2, 5 | ◐ seeded decals + wall-base clutter (no collision, lanes clear); full scatter with M5 |
| 1E ACES, GTAO, high-threshold bloom, grain, vignette, optional CA/MB off in ADS | 1, 2 | ☑ |
| 1E Light shafts, local fog, dust, steam, embers, per-map weather | 2, 6, 7 | ◐ shafts, haze, dust; steam/embers/weather open |
| 1E Low/Medium/High/Ultra scaling of every new effect, 60 FPS Medium target | 2, 8 | ◐ presets scale every new effect; FPS measured in M8 |
| 1F S-curve contrast, deep but not clipped blacks, high key-to-fill | 2 | ☑ |
| 1F Per-map grading (LUT or grading pass) with temperature contrast | 2, 6, 7 | ◐ grading pass live on Map 1; jungle/snow palettes ready |
| 1F Eye adaptation, disabled while scoped | 2 | ☑ |
| 1F Colored bounce/indirect light so shadows aren't plain gray | 2 | ☑ baked probes incl. floor bounce |
| 1F HDR emissives > 1, selective bloom, halos, tasteful flares, god rays | 2 | ◐ no lens flares yet |
| 1F Colored haze near lights | 2 | ☑ |
| 1F Small emissive details everywhere | 2, 5-7 | ◐ more with each map |
| 1F Specular highlights/reflections on wet, metal, ice (probes, cheap fallbacks) | 2 | ☑ reflections fade where little light reaches |
| 1F Rim light on players and bots | 2, 3 | dropped at the user's request (enemies should be hard to see in the dark) |
| 1F Layered depth, light guiding routes and objectives | 2, 5-7 | ◐ map reworks M5-7 |
| 1F Clamped glow; glow drops in ADS; HUD always readable | 1, 2 | ☑ |
| 1F Settings: Glow/Bloom, Contrast, Visual Style (Cinematic default) | 2 | ☑ |
| 1F `npm run audit:contrast` with histograms from fixed cameras on each map | 2, 8 | ◐ passes on Map 1 |

### Section 2 – Maps
| Item | M | Status |
|---|---|---|
| 2A ~2x indoor area, larger outdoor; 1v1 contact in 20-30 s; lanes, loops, flanks | 5-7 | ☐ |
| 2A Real elevation and multi-level spaces, mantle-able cover | 5-7 | ☐ |
| 2A Distinct zones and landmarks, signage, callouts on spawn | 5-7 | ☐ |
| 2A Cover at three heights, peeks, shortcuts, mixed engagement ranges, fair | 5-7 | ☐ |
| 2A Overtime capture point at a contested location on each map | 5-7 | ☐ |
| 2A Spawns for 1v1 to 4v4+, spawn protection, safe distance | 5-7 | ☐ |
| 2A Spatial structure for collision and raycasts | 5 | ☐ |
| 2A Navmesh per map; bots path, use cover, peek, flank, never stuck | 5-7 | ☐ |
| 2A Headless bot-vs-bot sims per map (stuck spots, unreachable areas, ~50/50 sides) | 5-7 | ☐ |
| 2A Map select (leader picks or Random), preview and description, synced via party and matchmaking | 8 | ☐ |
| 2A `docs/maps/<name>.md` design docs | 5-7 | ☐ |
| 2B Map 1: bigger, multi-level bunker, flooded section, catwalks, drainage, boiler room, irregular yet fair | 5 | ☐ |
| 2C Map 2: tropical jungle base at night in rain (see the user's references: buttress trees with vines, tree ferns, palms, fern carpet, boardwalks) | 6 | ☐ |
| 2D Map 3: snowy base at night, snow flying, drifts, hangar, radar dome | 7 | ☐ |

### Section 3 – Soldiers
| Item | M | Status |
|---|---|---|
| 3A Inspect GLBs (skeleton, materials, polycount, scale, orientation) | 0 | ☑ |
| 3A Normalize (1.8 m, -Z forward, feet at origin), clean materials, compress | 3 | ☐ |
| 3A Replace the old character everywhere (lobby, match, bots, spectator, end screen) | 3 | ☐ |
| 3A Hitboxes aligned to the new skeleton | 3 | ☐ |
| 3A Weapon on the right-hand bone, left-hand IK to the foregrip | 3 | ☐ |
| 3B One team black-and-red, random per match, host-synced, consistent all match | 3 | ☐ |
| 3B Relative HUD friend/enemy colors with colorblind option | 3 | ☐ |
| 3C Rig (bpy auto-weights; Mixamo fallback) | 3 | ☐ |
| 3C State machine with crossfades; all listed states; 8-way blend space | 3 | ☐ |
| 3C Upper/lower body layering with aim offset | 3 | ☐ |
| 3C No foot sliding (speed sync, foot planting/IK) | 3 | ☐ |
| 3C Networked compact state, animation derived locally | 3 | ☐ |
| 3C Lean into turns, head look-at, idle breathing, weapon sway | 3 | ☐ |
| 3C `?animtest` scene with screenshots/GIFs | 3 | ☐ |

### Section 4 – Scope and tracers
| Item | M | Status |
|---|---|---|
| Find and fix the cause of the faded scope view | 1 | ☑ |
| Crisp lens, mask only outside, correct magnification and tone mapping | 1 | ☑ |
| Disable/reduce DOF, MB, CA, grain, bloom, vignette in ADS | 1 | ☑ |
| Small believable scope sway (hold breath optional) | 1 | ☑ |
| Thin, short, fast tracers on every 3rd-5th round, offset from the muzzle | 1 | ☑ |
| Smaller muzzle flash (especially ADS), clamped light pulse | 1 | ☑ |
| Less smoke in front of the camera in ADS | 1 | ☑ |
| Screenshots of scoped continuous fire (sniper and AR) | 1 | ☑ |

### Section 5 – Audio
| Item | M | Status |
|---|---|---|
| Layered gunshots (transient, body, thump, tail), variations, class-distinct | 4 | ☐ |
| Convolution reverb per environment; distance low-pass and delay; occlusion | 4 | ☐ |
| Supersonic cracks, per-material impacts, casings, ricochets | 4 | ☐ |
| Per-surface foley (footsteps, slide, landing, cloth, reload, mantle) | 4 | ☐ |
| Weighty hit/kill feedback, heartbeat/breathing when hurt, muffled hearing | 4 | ☐ |
| Master limiter/compressor; buses: master, effects, music, voice/UI, ambience; ducked music | 4 | ☐ |
| Per-map ambience beds | 4, 6, 7 | ☐ |
| `?audiotest` page | 4 | ☐ |
| Sources recorded in CREDITS.md | 4 | ☐ |

### Section 6 – Controls
| Item | M | Status |
|---|---|---|
| Input Mode Mouse/Touchpad, persisted (profile and localStorage) | 1 | ☑ |
| Mouse mode keeps pointer lock with `unadjustedMovement` | 1 | ☑ |
| Touchpad: hip spread x0.4-0.5 from weapon data, host-clamped | 1 | ☑ |
| Touchpad: subtle aim assist (slowdown, stickiness) with a strength slider | 1 | ☑ |
| Touchpad: keyboard fire and ADS, ADS toggle/hold, optional arrow-key look | 1 | ☑ |
| Touchpad: separate sensitivity and curve | 1 | ☑ |
| Touchpad: lower visual recoil, larger hit forgiveness | 1 | ☑ |
| Touchpad: first-launch hint | 1 | ☑ |
| New settings: Brightness/Gamma, Camera Shake + Reduce Motion, Input Mode, Aim Assist, ADS Toggle/Hold, Flashlight key | 1, 2 | ☑ |

### Section 7 – Camera feel and damage
| Item | M | Status |
|---|---|---|
| Procedural movement shake (bob, sway, roll, footstep impulses), scaled, reduced in ADS | 1 | ☑ |
| Directional damage flinch, red edge flash, desaturation, low-HP pulse and heartbeat | 1 | ☑ |
| CoD-style regen (5 s delay, smooth refill), one config file, host-validated | 1 | ☑ |

### Section 8 – Balance
| Item | M | Status |
|---|---|---|
| TTK 1.5-1.8x longer; head multipliers kept; snipers strong; shotguns punishing | 1 | ☑ |
| Round time 2-2.5 min, overtime retuned | 1 | ☑ |
| Movement 20-30% faster, snappy accel/decel, air control, momentum slide, fast crouch, responsive jump | 1 | ☑ |
| Host validation and prediction updated; tested at 80-150 ms | 1 | ☑ |
| `npm run balance` (TTK per weapon, close/mid/long, body/head) | 1 | ☑ |

### Sections 9-11 – Networking, performance, testing
| Item | M | Status |
|---|---|---|
| Host syncs map, skin assignment, scatter seed, weather seed, round state | 3, 8 | ☐ |
| Multi-tab Playwright per map: join, round, win/lose, XP, back to lobby, party intact | 8 | ☐ |
| Compact snapshots, only what changed | 8 | ☐ |
| Instancing, LOD/impostors, culling, shared materials, shadow budget | 2, 6-8 | ◐ instanced decals, merged clutter, shadow budget; LOD/impostors with Maps 2-3 |
| Per-map lazy loading with branded progress bar | 8 | ☐ |
| `?perf` overlay (FPS, frame time, draw calls, triangles, shadow lights, memory) | 2 | ☑ |
| `docs/perf.md` per map | 8 | ☐ |
| Fixed-camera before/after screenshots per map | 0, 2, 5-9 | ◐ Map 1 before (M0) and after (M2) |
| Audits, balance, bot sims, typecheck/lint/unit tests (regen, damage, TTK, input-mode multipliers, team skins) | 1-8 | ◐ 3 audits, balance, scatter/flashlight tests; bot sims + skin tests later |
| ADS scoped screenshots (sniper and AR) while firing | 1 | ☑ |
| Touchpad mode end-to-end test | 1 | ☑ |

### Milestone 9 – Deploy
| Item | Status |
|---|---|
| Final screenshots, docs (README, SETUP, CREDITS, PLAN) updated | ☐ |
| Pushed to `main`, Pages build green, assets under `/Gulag/`, Firebase works, all maps load | ☐ |

## 7. Milestone log

- **M0** (this file): tagged `v1-before-upgrade`, inspected both GLBs, confirmed `bpy`, `toktx`,
  meshoptimizer, recast and three-mesh-bvh are installable, captured before-shots, wrote the plan.
- **M1** feel and fixes. Screenshots in [`screenshots/upgrade-m1/`](screenshots/upgrade-m1/).
  - *Why the scope looked faded*: the shooter's own muzzle smoke spawned 0.6 m in front of the
    camera and drifted through the lens; a 0.35 m HDR muzzle-flash sprite bloomed over the sight
    picture; tracers started 1 m in front of the eye on the sight line; grain, chromatic
    aberration, vignette and full bloom stayed on while scoped; distance fog washed out the
    magnified targets; and the overlay faded in with an opacity ramp. All fixed: no flash or
    smoke through a scope, local smoke pushed out of the sight picture, post effects fade with
    ADS, fog thins through the scope, hard-edged mask with an SVG duplex reticle that appears
    instantly.
  - Tracers are screen-space hairlines (1.6 px) with a 1.3 m streak on every 2nd-5th round, from
    the muzzle at the hip and from 5-16 m downrange when aiming; the local muzzle flash is a
    small sprite on the gun plus a clamped light (no more orange room flood).
  - Balance: damage 35-40% lower (body TTK 1.5-1.8x, `npm run balance`), rounds 2:00-2:30,
    movement ~25% faster with momentum slides, slide-jumps, coyote time and jump buffering;
    prediction verified at 80 and 150 ms.
  - Health regeneration from `src/data/gameplay.ts` (5 s delay, eased 3.2 s refill) in the shared
    host step; camera feel module; directional damage flash, low-health pulse, heartbeat.
  - Touchpad mode: separate bindings (Space fire, Shift aim), host-applied 0.45x hip spread and
    hit forgiveness, aim assist, sensitivity curve/smoothing, arrow look, auto sprint, first-launch
    hint, mode saved with the account (Firestore rule + test).
  - Verified: 80 unit tests, 22 rules tests, e2e (two-tab WebRTC match, touchpad mode, online
    accounts/party/matchmaking/XP against the emulators), typecheck, lint, production build.
- **M2** rendering overhaul on Sublevel 9. Screenshots in [`screenshots/upgrade-m2/`](screenshots/upgrade-m2/).
  - Lighting: every fixture drives a pooled real light (shadowed spots for the nearest/most
    important, points for the rest, chosen by distance and view direction); flicker, buzz,
    swinging chains, dead tubes, Kelvin colors; baked L2 light probes with bounce from each
    light, floor bounce (ceilings no longer black) and moonlight through the roof hole.
    Retuned to the user's "happy medium" after the first pass came out too dark.
  - Grading: ACES, S-curve, split toning, per-map palettes, Visual Style / Glow / Contrast
    settings, eye adaptation frozen while scoped, HDR clamp before bloom.
  - Surfaces: `audit:textures` passes (every lit material has albedo + normal or a stated
    reason). 16-cell PBR decal atlas scattered by seed (grime, streaks, stains, cracks, peel,
    moss, oil, wet) and kept on its face; world-space macro variation; wet floors from a
    top-down mask (puddles, sky openings, leaks); puddles and bullet holes have normal maps.
  - Darkness: per the user, no rim light; team strips are matte tape instead of glowing;
    reflections fade where little light reaches, so nothing glints in a dark corner. The
    flashlight is a tight 8.6° beam with harsh light on the hands and gun; enemy flashlights
    render at 40% of a teammate's.
  - Props: crate x5, small case x3, drum (dented, open with oil), bench x2 on unchanged collision
    proxies; seeded wall-base clutter (paper, cans, debris, bricks, rebar, trays), no collision.
  - Tools: `npm run audit:shadows|textures|contrast`, `?perf` overlay, art-test free camera,
    `#/swatches/decals` and `#/swatches/props` boards, enemy-in-the-dark match shots.

