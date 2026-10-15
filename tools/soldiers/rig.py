"""Soldier pipeline step 2: normalize, fit a skeleton, skin, export (Blender `bpy`, headless).

    EGL_PLATFORM=surfaceless python tools/soldiers/rig.py -- <in.glb> <out.glb> <proofDir> <name>

* Normalizes the mesh: faces -Z in glTF (+Y in Blender), 1.80 m tall, feet centered on the origin.
* Fits a humanoid skeleton to the mesh itself: legs, arms and torso are found from horizontal
  cross-sections (runs of occupied space along X), joints from those runs plus human proportions.
* Skins with segment-aware distance weights: the mesh is split into arms, legs and torso with the
  same cross-sections (the arms hang 1-3 cm from the body, which bone-heat and voxel proxies
  fuse together), then each vertex is weighted by its distance to the bones of its segment, with
  blending across the shoulders and hips. Max 4 influences, normalized.
* Stores the landmarks (heel, toe, palm...) in the mesh extras for runtime IK, exports a skinned
  GLB without animation (clips are generated at runtime) and renders proof images, including a
  bend test (arms, elbows, knees, spine) to check the deformation.
"""

import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
SRC, OUT, PROOF, NAME = argv[0], argv[1], argv[2], argv[3]
HEIGHT = 1.80
os.makedirs(PROOF, exist_ok=True)


def log(*a):
    print("[rig]", *a, flush=True)


# ------------------------------------------------------------------ import + normalize
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
if len(meshes) > 1:
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = f"soldier_{NAME}"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(bpy.context.scene.objects):
    if o != body:
        bpy.data.objects.remove(o, do_unlink=True)


def verts():
    n = len(body.data.vertices)
    a = np.empty(n * 3, dtype=np.float64)
    body.data.vertices.foreach_get("co", a)
    return a.reshape(n, 3)


V = verts()
dims = V.max(0) - V.min(0)
assert dims[2] >= dims.max() * 0.99, f"expected Z-up after import, dims {dims}"
zmin, zmax = V[:, 2].min(), V[:, 2].max()
H0 = zmax - zmin
# forward = from the shins toward the toes (feet stick out in front of the legs)
feet = V[V[:, 2] < zmin + 0.05 * H0]
shins = V[(V[:, 2] > zmin + 0.11 * H0) & (V[:, 2] < zmin + 0.16 * H0)]
fwd = feet[:, :2].mean(0) - shins[:, :2].mean(0)
# scans come axis-aligned: snap to the nearest axis (splayed feet skew the raw estimate)
ang = round(math.atan2(fwd[1], fwd[0]) / (math.pi / 2)) * (math.pi / 2)
rot = Matrix.Rotation(math.pi / 2 - ang, 4, "Z")  # forward -> +Y
s = HEIGHT / H0
M = Matrix.Scale(s, 4) @ rot @ Matrix.Translation((0, 0, -zmin))
body.data.transform(M)
body.data.update()
V = verts()
# center between the shins
shins = V[(V[:, 2] > 0.11 * HEIGHT) & (V[:, 2] < 0.16 * HEIGHT)]
c = shins[:, :2].mean(0)
body.data.transform(Matrix.Translation((-c[0], -c[1], 0)))
body.data.update()
# glTF splits vertices along UV seams; merge them (UVs live on face corners in Blender) so the
# surface is connected for segmentation and hole filling
import bmesh as _bm

_m = _bm.new()
_m.from_mesh(body.data)
_n0 = len(_m.verts)
_bm.ops.remove_doubles(_m, verts=_m.verts, dist=1e-5)
_m.to_mesh(body.data)
_m.free()
body.data.update()
V = verts()
log(f"merged seam duplicates: {_n0} -> {len(V)} vertices")
H = HEIGHT
log(f"normalized: {len(V)} verts, forward was {math.degrees(ang):.1f} deg, scale {s:.3f}")

# ------------------------------------------------------------------ cross-section analysis
BIN = 0.006 * H


def slice_pts(z, half=0.006):
    return V[np.abs(V[:, 2] - z) < half * H]


def runs(pts, lo=-0.4 * H, hi=0.4 * H, gap=1):
    """Occupied runs along X: list of (x0, x1, points) left to right; `gap` empty bins bridge."""
    if len(pts) == 0:
        return []
    nb = int((hi - lo) / BIN)
    idx = np.clip(((pts[:, 0] - lo) / BIN).astype(int), 0, nb - 1)
    occ = np.bincount(idx, minlength=nb) > 0
    out = []
    i = 0
    while i < nb:
        if not occ[i]:
            i += 1
            continue
        j = i
        empty = 0
        while j + 1 < nb and (occ[j + 1] or empty < gap):
            j += 1
            empty = 0 if occ[j] else empty + 1
        while not occ[j]:
            j -= 1
        x0, x1 = lo + i * BIN, lo + (j + 1) * BIN
        sel = pts[(pts[:, 0] >= x0) & (pts[:, 0] < x1)]
        out.append((x0, x1, sel))
        i = j + 1
    return out


def central(z):
    """Torso run at height z: (center xyz, half width)."""
    for x0, x1, p in runs(slice_pts(z)):
        if x0 <= 0 <= x1:
            return p.mean(0), max(-x0, x1)
    p = slice_pts(z)
    p = p[np.abs(p[:, 0]) < 0.1 * H]
    return p.mean(0), 0.1 * H


# crotch: lowest height where the slice is continuous across the midline
crotch = None
for z in np.arange(0.30, 0.62, 0.003) * H:
    sl = slice_pts(z, 0.003)
    if len(sl) == 0:
        continue
    mid = np.abs(sl[:, 0]) < 0.012 * H
    if mid.sum() > 0.04 * len(sl):
        crotch = z
        break
assert crotch is not None, "no crotch found"
# gear between the legs (pouches, groin plate) can close the gap early; keep it anatomical
crotch = float(np.clip(crotch, 0.43 * H, 0.49 * H))
log(f"crotch {crotch / H:.3f} H")


def leg_center(side, z):
    p = slice_pts(z)
    p = p[(np.sign(p[:, 0]) == side) & (np.abs(p[:, 0]) < 0.16 * H)]
    rs = [r for r in runs(p) if (r[0] + r[1]) / 2 * side > 0]
    if not rs:
        return p.mean(0)
    # the leg is the run nearest the midline
    rs.sort(key=lambda r: abs((r[0] + r[1]) / 2))
    return rs[0][2].mean(0)


def arm_track(side):
    """Outermost run on one side, from the hand up to where it merges with the torso."""
    track = []
    for z in np.arange(0.30, 0.80, 0.005) * H:
        rs = runs(slice_pts(z, 0.004))
        rs = [r for r in rs if (r[0] + r[1]) / 2 * side > 0]
        if len(rs) < 2:
            continue
        r = rs[-1] if side > 0 else rs[0]
        cx = (r[0] + r[1]) / 2
        if abs(cx) < 0.12 * H:
            continue
        track.append((z, r[2].mean(0), r[0], r[1]))
    return track


J = {}
ARMS = {}
ARMPIT = {}
for side, tag in ((-1, "L"), (1, "R")):
    # legs
    ank = leg_center(side, 0.09 * H)
    J[f"ankle_{tag}"] = Vector((ank[0], ank[1], 0.055 * H))
    knee = leg_center(side, 0.29 * H)
    J[f"knee_{tag}"] = Vector((knee[0], knee[1] + 0.006 * H, 0.29 * H))
    hip = leg_center(side, crotch - 0.035 * H)
    J[f"hip_{tag}"] = Vector((hip[0] * 0.85, 0.0, crotch + 0.035 * H))
    foot = V[(V[:, 2] < 0.05 * H) & (np.sign(V[:, 0]) == side)]
    toe_y = np.percentile(foot[:, 1], 99.5)
    heel_y = np.percentile(foot[:, 1], 0.5)
    J[f"toe_{tag}"] = Vector((ank[0], toe_y - 0.01 * H, 0.02 * H))
    J[f"ball_{tag}"] = Vector((ank[0], ank[1] + 0.68 * (toe_y - ank[1]), 0.022 * H))
    J[f"heel_{tag}"] = Vector((ank[0], heel_y, 0.0))
    # arms
    tr = arm_track(side)
    assert len(tr) > 10, f"arm {tag} not found"
    ARMS[side] = tr
    tip_z = tr[0][0]
    zs = np.array([t[0] for t in tr])
    cs = np.array([t[1] for t in tr])

    def at(z):
        k = int(np.argmin(np.abs(zs - z)))
        return cs[k]

    torso_c, _ = central(0.78 * H)
    # shoulder joint: above the armpit, a little inside the upper arm's center line
    pit = [t for t in tr if t[0] < 0.79 * H][-1]
    sh = Vector((pit[1][0] * 0.9, torso_c[1], 0.815 * H))
    ARMPIT[side] = pit[0]
    wz = tip_z + 0.105 * H
    w = at(wz)
    J[f"wrist_{tag}"] = Vector((w[0], w[1], wz))
    ez = sh.z - 0.56 * (sh.z - wz)
    e = at(ez)
    J[f"elbow_{tag}"] = Vector((e[0], e[1] - 0.008 * H, ez))
    J[f"shoulder_{tag}"] = sh
    kz = tip_z + 0.048 * H
    k = at(kz)
    J[f"knuckle_{tag}"] = Vector((k[0], k[1], kz))
    J[f"fingertip_{tag}"] = Vector((k[0], k[1], tip_z + 0.004 * H))
    J[f"clav_{tag}"] = Vector((side * 0.02 * H, torso_c[1] + 0.01 * H, 0.80 * H))
    log(f"arm {tag}: tip {tip_z / H:.3f} H, wrist {wz / H:.3f} H, elbow {ez / H:.3f} H, shoulder x {sh.x:.3f}")

for name, z in (("pelvis", None), ("spine", 0.62), ("chest", 0.70), ("upperChest", 0.78), ("neck", 0.835), ("headBase", 0.875)):
    zz = crotch + 0.035 * H if z is None else z * H
    c, _ = central(zz)
    J[name] = Vector((0.0, c[1], zz))
head_pts = V[V[:, 2] > 0.88 * H]
J["headTop"] = Vector((0.0, float(np.median(head_pts[:, 1])), 0.985 * H))
for tag in ("L", "R"):
    J[f"hip_{tag}"].y = J["pelvis"].y

# ------------------------------------------------------------------ armature
arm_data = bpy.data.armatures.new("rig")
rig = bpy.data.objects.new("rig", arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones


def bone(name, head, tail, parent=None, connect=False):
    b = eb.new(name)
    b.head = head
    b.tail = tail
    if parent:
        b.parent = eb[parent]
        b.use_connect = connect
    return b


bone("hips", J["pelvis"], J["spine"])
bone("spine", J["spine"], J["chest"], "hips", True)
bone("chest", J["chest"], J["upperChest"], "spine", True)
bone("upperChest", J["upperChest"], J["neck"], "chest", True)
bone("neck", J["neck"], J["headBase"], "upperChest", True)
bone("head", J["headBase"], J["headTop"], "neck", True)
for t in ("L", "R"):
    bone(f"clavicle_{t}", J[f"clav_{t}"], J[f"shoulder_{t}"], "upperChest")
    bone(f"upperArm_{t}", J[f"shoulder_{t}"], J[f"elbow_{t}"], f"clavicle_{t}", True)
    bone(f"lowerArm_{t}", J[f"elbow_{t}"], J[f"wrist_{t}"], f"upperArm_{t}", True)
    bone(f"hand_{t}", J[f"wrist_{t}"], J[f"knuckle_{t}"], f"lowerArm_{t}", True)
    bone(f"fingers_{t}", J[f"knuckle_{t}"], J[f"fingertip_{t}"], f"hand_{t}", True)
    # thumb: from the base of the palm, forward and down
    wr, kn = J[f"wrist_{t}"], J[f"knuckle_{t}"]
    base = wr.lerp(kn, 0.3) + Vector((0, 0.012 * H, 0))
    bone(f"thumb_{t}", base, base + Vector((0, 0.025 * H, -0.03 * H)), f"hand_{t}")
    bone(f"thigh_{t}", J[f"hip_{t}"], J[f"knee_{t}"], "hips")
    bone(f"shin_{t}", J[f"knee_{t}"], J[f"ankle_{t}"], f"thigh_{t}", True)
    bone(f"foot_{t}", J[f"ankle_{t}"], J[f"ball_{t}"], f"shin_{t}", True)
    bone(f"toe_{t}", J[f"ball_{t}"], J[f"toe_{t}"], f"foot_{t}", True)
# predictable rolls: limbs bend around their local X axis
bpy.ops.armature.select_all(action="SELECT")
bpy.ops.armature.calculate_roll(type="GLOBAL_POS_Y")
bpy.ops.object.mode_set(mode="OBJECT")

# ------------------------------------------------------------------ skinning
# segment every vertex (arm / leg / torso), then weight it by distance to its segment's bones
bpy.ops.object.mode_set(mode="EDIT")
SEG = {b.name: (np.array(b.head), np.array(b.tail)) for b in arm_data.edit_bones}
bpy.ops.object.mode_set(mode="OBJECT")


def seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-9), 0.0, 1.0)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


n = len(V)
CHAINS = {
    "armL": ["upperArm_L", "lowerArm_L", "hand_L", "fingers_L", "thumb_L"],
    "armR": ["upperArm_R", "lowerArm_R", "hand_R", "fingers_R", "thumb_R"],
    "legL": ["thigh_L", "shin_L", "foot_L", "toe_L"],
    "legR": ["thigh_R", "shin_R", "foot_R", "toe_R"],
    "torso": ["hips", "spine", "chest", "upperChest", "neck", "head", "clavicle_L", "clavicle_R"],
}
names = list(CHAINS)
Dc = np.stack([np.min(np.stack([seg_dist(V, *SEG[b]) for b in CHAINS[c]], 1), 1) for c in names], 1)
# seeds: vertices clearly nearest one chain, distances measured in that chain's thickness
# (the armored torso is ~16 cm deep, arms ~6 cm, legs ~9 cm)
RADIUS = {"armL": 0.065, "armR": 0.065, "legL": 0.09, "legR": 0.09, "torso": 0.16}
Dn = Dc / np.array([RADIUS[c] for c in names])
order = np.sort(Dn, 1)
best = np.argmin(Dn, 1)
seed = order[:, 0] < 0.6 * order[:, 1]
label = np.where(seed, best, -1)

# surface graph: mesh edges plus links between split copies of the same point (UV seams)
key = np.round(V / 1e-5).astype(np.int64)
_, inv = np.unique(key, axis=0, return_inverse=True)
inv = inv.ravel()
adj = [[] for _ in range(n)]
for e in body.data.edges:
    a, b = e.vertices
    d = float(np.linalg.norm(V[a] - V[b]))
    adj[a].append((b, d))
    adj[b].append((a, d))
groups = {}
for i, g in enumerate(inv):
    groups.setdefault(int(g), []).append(i)
for members in groups.values():
    for a in members[1:]:
        adj[members[0]].append((a, 0.0))
        adj[a].append((members[0], 0.0))
# multi-source geodesic growth: unlabeled vertices join the seed region that reaches them first
import heapq

dist = np.full(n, np.inf)
heap = []
for i in np.where(label >= 0)[0]:
    dist[i] = 0.0
    heap.append((0.0, int(i)))
heapq.heapify(heap)
while heap:
    d, i = heapq.heappop(heap)
    if d > dist[i]:
        continue
    for j, w in adj[i]:
        nd = d + w
        if nd < dist[j]:
            dist[j] = nd
            label[j] = label[i]
            heapq.heappush(heap, (nd, j))
label[label < 0] = names.index("torso")
lab = np.array(names, dtype=object)[label]
log("segments:", {c: int((lab == c).sum()) for c in names})

# Scans fuse limbs wherever they touch (hands on thighs, elbows on the torso). Below the armpits,
# cut the faces that bridge an arm to anything else, then close each side's hole separately.
import bmesh

bm = bmesh.new()
bm.from_mesh(body.data)
bm.faces.ensure_lookup_table()
pit_z = min(ARMPIT.values()) - 0.03 * H
bridges = []
for f in bm.faces:
    labs = {lab[v.index] for v in f.verts}
    arms = {l for l in labs if l.startswith("arm")}
    if arms and len(labs) > 1 and f.calc_center_median().z < pit_z:
        bridges.append(f)
touched = {v for f in bridges for v in f.verts}
_c = np.array([list(f.calc_center_median()) for f in bridges]) if bridges else np.zeros((0, 3))
if len(_c):
    for _side in (-1, 1):
        _m = np.sign(_c[:, 0]) == _side
        if _m.any():
            log(f"cut faces side {_side}: {int(_m.sum())}, x {_c[_m, 0].min():.3f}..{_c[_m, 0].max():.3f}, y {_c[_m, 1].min():.3f}..{_c[_m, 1].max():.3f}, z {_c[_m, 2].min():.3f}..{_c[_m, 2].max():.3f}")
    _pairs = {}
    for f in bridges:
        k = tuple(sorted({lab[v.index] for v in f.verts}))
        _pairs[k] = _pairs.get(k, 0) + 1
    log(f"cut label pairs {_pairs}")
bmesh.ops.delete(bm, geom=bridges, context="FACES_ONLY")
edges = [e for e in bm.edges if e.is_boundary and all(v in touched for v in e.verts)]
deg = {}
for e in edges:
    for v in e.verts:
        deg[v] = deg.get(v, 0) + 1
hist = {}
for d in deg.values():
    hist[d] = hist.get(d, 0) + 1
log(f"boundary edges {len(edges)}, vertex degree histogram {hist}")
deg_edges = set(edges)
# fill each closed boundary loop on its own as an n-gon, then triangulate it
filled = {"faces": []}
seen = set()
comps = []
for e0 in edges:
    if e0 in seen:
        continue
    comp = []
    stack = [e0]
    while stack:
        e = stack.pop()
        if e in seen:
            continue
        seen.add(e)
        comp.append(e)
        for v in e.verts:
            stack.extend(x for x in v.link_edges if x in deg_edges and x not in seen)
    comps.append(comp)
ok = 0
for comp in comps:
    if len(comp) < 3:
        continue
    try:
        r = bmesh.ops.edgeloop_fill(bm, edges=comp, mat_nr=0, use_smooth=True)
        if r["faces"]:
            filled["faces"] += r["faces"]
            ok += 1
            continue
    except Exception:
        pass
    try:
        r = bmesh.ops.holes_fill(bm, edges=comp, sides=0)
        if r["faces"]:
            filled["faces"] += r["faces"]
            ok += 1
    except Exception:
        pass
log(f"boundary loops {len(comps)}, filled {ok}")
if filled["faces"]:
    tri = bmesh.ops.triangulate(bm, faces=filled["faces"], quad_method="BEAUTY", ngon_method="BEAUTY")
    # new faces have no real UVs: borrow each corner's UV from the vertex's original faces so the
    # patch continues the surrounding camo instead of rendering a dark smear
    new = set(tri["faces"])
    for uvl in bm.loops.layers.uv.values():
        for f in new:
            for loop in f.loops:
                for other in loop.vert.link_loops:
                    if other.face not in new:
                        loop[uvl].uv = other[uvl].uv.copy()
                        break
bm.to_mesh(body.data)
bm.free()
body.data.update()
log(f"cut {len(bridges)} bridging faces, filled {len(filled['faces'])} faces")

below_pit = V[:, 2] < pit_z
CANDS = {
    "armL": ["upperChest", "clavicle_L", "upperArm_L", "lowerArm_L", "hand_L", "fingers_L", "thumb_L"],
    "armR": ["upperChest", "clavicle_R", "upperArm_R", "lowerArm_R", "hand_R", "fingers_R", "thumb_R"],
    "legL": ["hips", "thigh_L", "shin_L", "foot_L", "toe_L"],
    "legR": ["hips", "thigh_R", "shin_R", "foot_R", "toe_R"],
    "torso": ["hips", "spine", "chest", "upperChest", "neck", "head", "clavicle_L", "clavicle_R", "upperArm_L", "upperArm_R"],
}
for b in SEG:
    body.vertex_groups.new(name=b)
weights = {b: ([], []) for b in SEG}
for kind, bones in CANDS.items():
    idx = np.where(lab == kind)[0]
    if not len(idx):
        continue
    P = V[idx]
    D = np.stack([seg_dist(P, *SEG[b]) for b in bones], axis=1)
    if kind == "torso":
        # only the shoulder caps follow the upper arms (the chest's sides must not)
        for j, b in enumerate(bones):
            if b.startswith("upperArm"):
                sj = np.array(SEG[b][0])
                far = np.linalg.norm(P - sj, axis=1) > 0.09
                D[far | below_pit[idx], j] = np.inf
    W = 1.0 / (D + 0.012) ** 4
    order_w = np.argsort(-W, axis=1)
    keep = np.zeros_like(W, dtype=bool)
    np.put_along_axis(keep, order_w[:, :3], True, axis=1)
    W = np.where(keep, W, 0.0)
    W /= W.sum(1, keepdims=True)
    for j, b in enumerate(bones):
        m = W[:, j] > 0.01
        weights[b][0].extend(idx[m].tolist())
        weights[b][1].extend(W[m, j].tolist())
for b, (ids, ws) in weights.items():
    g = body.vertex_groups[b]
    for i, w in zip(ids, ws):
        g.add([int(i)], float(w), "REPLACE")
body.parent = rig
am = body.modifiers.new("rig", "ARMATURE")
am.object = rig
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
bpy.ops.object.mode_set(mode="OBJECT")
log(f"weights: {sum(len(w[0]) for w in weights.values())} entries, unweighted {sum(1 for v in body.data.vertices if not v.groups)}")

# landmarks for runtime IK and hitboxes (glTF Y-up, -Z forward: (x, y, z)_blender -> (x, z, -y))
to_gl = lambda v: [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]
body["lockdown_rig"] = json.dumps({"height": H, "landmarks": {k: to_gl(v) for k, v in J.items()}})

# ------------------------------------------------------------------ export
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_yup=True,
    export_skins=True,
    export_animations=False,
    export_extras=True,
    export_apply=False,
    export_materials="EXPORT",
)
log(f"wrote {OUT}")

# ------------------------------------------------------------------ proofs
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "TEXTURE"
scene.render.resolution_x = 480
scene.render.resolution_y = 720
scene.world = bpy.data.worlds.new("w")
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.1
scene.collection.objects.link(cam)
scene.camera = cam


def shoot(tag):
    for view, loc, rz in (("front", (0, 5, 0.95), math.pi), ("side", (5, 0, 0.95), math.pi / 2)):
        cam.location = loc
        cam.rotation_euler = (math.pi / 2, 0, rz)
        scene.render.filepath = os.path.join(PROOF, f"{NAME}_{tag}_{view}.png")
        bpy.ops.render.render(write_still=True)


shoot("rest")
# bend test: rotations in world space around each joint (arms forward, elbows, a stride, a twist)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="POSE")
pb = rig.pose.bones


def turn(name, axis, deg):
    b = pb[name]
    M = b.matrix.copy()
    pivot = M.to_translation()
    b.matrix = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(deg), 4, axis) @ Matrix.Translation(-pivot) @ M
    bpy.context.view_layer.update()


turn("upperArm_R", "X", 75)
turn("lowerArm_R", "X", 65)
turn("upperArm_L", "Y", -60)
turn("lowerArm_L", "X", 50)
turn("thigh_L", "X", 60)
turn("shin_L", "X", -85)
turn("thigh_R", "X", -20)
turn("spine", "Z", 20)
turn("neck", "X", -15)
bpy.ops.object.mode_set(mode="OBJECT")
shoot("bend")
log("proofs done")
