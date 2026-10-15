# Soldier pipeline

Turns the two provided Tripo soldiers (`incoming/soldiers/*.glb`: 1.9 M triangles, 4096²
textures, no skeleton) into rigged game assets in `public/assets/soldiers/`. Run once, offline;
the outputs are committed, so the game build never needs these tools.

```bash
(cd tools/soldiers && npm i)   # gltf-transform, meshoptimizer, sharp
pip install bpy                 # Blender as a Python module (5.x)
tools/soldiers/build.sh         # BPY_PYTHON=/path/to/python if bpy lives in a venv
```

| Step | Script | What it does |
|---|---|---|
| 1 | `simplify.mjs` | meshoptimizer decimation to ~24k triangles. Attribute seams are kept, so the original textures still fit. |
| 2 | `rig.py` | Normalizes (1.80 m, faces -Z in glTF, feet on the origin), fits a humanoid skeleton from horizontal cross-sections of the mesh plus human proportions, skins it with bone-heat weights (voxel-proxy fallback), max 4 influences. Writes landmarks (heels, toes, joints) into the mesh extras for runtime IK, and renders proof images (rest pose and a bend test) to `work/proofs/`. |
| 3 | `finalize.mjs` | WebP textures (2048², normals lossless) and meshopt geometry compression. |

Bone names: `hips spine chest upperChest neck head`, and per side (`_L` = the character's left,
-X in glTF) `clavicle upperArm lowerArm hand fingers thumb thigh shin foot toe`.

The models carry no animation. The game drives the skeleton procedurally (gait with IK foot
planting, aim offset, two-handed weapon IK, reloads, hit reactions, deaths), see
`src/game/view/soldier/`.
