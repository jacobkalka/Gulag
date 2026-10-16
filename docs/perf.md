# Performance report

Measured with the `?perf` overlay in a 4v4 practice match (eight soldiers on the map), 1280x720,
in headless Chromium on SwiftShader (a software GPU, the only one in the build environment).
Frame times from a software renderer say nothing about a real GPU, so this report sticks to what
transfers: draw calls, triangles, lights, shader programs, memory and data sizes. Reproduce with
`npm run perf:report` against a running dev server ([`scripts/perfreport.mjs`](../scripts/perfreport.mjs):
a practice match via `?map=<id>&quality=<q>&perf`, three fixed viewpoints per map, 3.5 s each).

## Per map and quality

Draw calls and triangles include every shadow pass of that frame. "Shadow" is the number of
shadow-casting lights in view.

| Map | Quality | View | Draw calls | Triangles | Lights | Shadow | Programs | JS heap |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Sublevel 9 | Low | spawn | 764 | 1.62 M | 9 | 3 | 45 | 183 MB |
| Sublevel 9 | Low | collapse | 621 | 1.54 M | 13 | 3 | 45 | 176 MB |
| Sublevel 9 | Low | catwalk | 520 | 1.46 M | 9 | 3 | 45 | 159 MB |
| Sublevel 9 | Medium | spawn | 928 | 1.93 M | 13 | 5 | 59 | 200 MB |
| Sublevel 9 | Medium | catwalk | 670 | 1.81 M | 15 | 5 | 61 | 181 MB |
| Sublevel 9 | High | spawn | 1151 | 2.58 M | 19 | 7 | 59 | 166 MB |
| Sublevel 9 | High | catwalk | 903 | 2.46 M | 20 | 7 | 61 | 172 MB |
| Monsoon | Low | spawn | 327 | 1.24 M | 9 | 2 | 53 | 152 MB |
| Monsoon | Low | helipad | 207 | 0.98 M | 12 | 2 | 53 | 136 MB |
| Monsoon | Low | jungle | 201 | 1.09 M | 9 | 2 | 53 | 151 MB |
| Monsoon | Medium | spawn | 475 | 1.78 M | 13 | 4 | 65 | 143 MB |
| Monsoon | Medium | jungle | 337 | 1.42 M | 14 | 5 | 66 | 153 MB |
| Monsoon | High | spawn | 741 | 2.77 M | 20 | 6 | 68 | 177 MB |
| Monsoon | High | jungle | 568 | 2.53 M | 20 | 6 | 69 | 143 MB |

(Medium and High "collapse"/"helipad" read the same as "spawn": the overlay had not refreshed
after the move, so those rows are left out.)

Match build time (map data, collision, nav, render batches, light probes, reflection probe and
shader compilation; the page is blocked while it runs, behind the deploy screen) on SwiftShader:
Sublevel 9 3.9 s (Low) to 10.3 s (High), Monsoon 4.2 s to 14.1 s. Most of it is rendering the six
reflection-probe faces and compiling shaders in software; on a hardware GPU expect a fraction.

## Where the cost goes

- **Shadow passes** dominate. Every shadow-casting light redraws the casters in its frustum, so
  the presets mainly scale the number of shadowed lights (2 on Low to 7 on High) and how often
  their maps refresh (`shadowUpdates`). Indoors (Sublevel 9) many small rooms each have a shadowed
  lamp near the camera, which is why it costs more draw calls than the bigger outdoor map.
- **Monsoon's foliage** is about 1,900 plants in four BatchedMeshes: one draw call per material
  per pass, culled per plant. Ground cover is not drawn beyond 34 m, thins out on Low and Medium
  (`foliage` 0.4 / 0.7), and only the moon draws tree shadows. On Low and Medium the moon's shadow
  map renders once instead of every frame.
- **Soldiers**: about 24,000 triangles each (meshopt-compressed, quantized, WebP textures).
  Eight soldiers are under 200k triangles per pass.
- **Static geometry** is merged per material and culling chunk (18 m indoors, 32 m outdoors).

## Data sizes

- Download: the built site is 11 MB, of which the two soldier models are 8 MB. Every texture,
  every map and every sound is generated in code at load time, so there are no texture or map
  downloads; KTX2 would only apply to the soldiers' few textures, which are WebP already.
- Network: a full 4v4 snapshot is 557 bytes, sent 30 times a second: about 16 KB/s to each
  client, about 0.9 Mbit/s of upload for a host serving seven.
- Memory: 136-200 MB of JS heap in a match.

## Targets and what to do next

Aim for 60 FPS on Medium on a mid-range discrete GPU, Low for integrated graphics. Untested on
real hardware here, so measure first. If a map misses its target, in order of payoff:

1. Shadow-only merged geometry per chunk (one draw per chunk per shadow pass, whatever the
   materials), or fewer shadowed lamps indoors on Medium.
2. Distance LODs for soldiers and the big trees.
3. Delta-compressed snapshots (only what changed) if host upload becomes the limit.
