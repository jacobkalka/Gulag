#!/usr/bin/env bash
# Builds public/assets/soldiers/{red,camo}.glb from the provided Tripo GLBs (run once, offline).
# Needs: node (tool deps: cd tools/soldiers && npm i), Blender's bpy module for Python
# (BPY_PYTHON, default /opt/bpyenv/bin/python, `pip install bpy`).
set -euo pipefail
cd "$(dirname "$0")/../.."
PY="${BPY_PYTHON:-/opt/bpyenv/bin/python}"
WORK=tools/soldiers/work
OUT=public/assets/soldiers
mkdir -p "$WORK" "$OUT" "$WORK/proofs"
for pair in "red:soldier_7d94e15d" "camo:soldier_a5f0105a"; do
  name="${pair%%:*}"
  src="incoming/soldiers/${pair#*:}.glb"
  node tools/soldiers/simplify.mjs "$src" "$WORK/$name-lod0.glb" "${LOD0_TRIS:-24000}"
  EGL_PLATFORM=surfaceless "$PY" tools/soldiers/rig.py -- "$WORK/$name-lod0.glb" "$WORK/$name-rigged.glb" "$WORK/proofs" "$name"
  node tools/soldiers/finalize.mjs "$WORK/$name-rigged.glb" "$OUT/$name.glb" "${TEX_SIZE:-2048}"
done
ls -la "$OUT"
