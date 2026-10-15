"""Soldier pipeline step 2: normalize, fit a skeleton, skin, export (Blender `bpy`, headless).

    EGL_PLATFORM=surfaceless python tools/soldiers/rig.py -- <in.glb> <out.glb> <proofDir> <name>

* Normalizes the mesh: faces -Z in glTF (+Y in Blender), 1.80 m tall, feet centered on the origin.
* Fits a humanoid skeleton to the mesh itself: legs, arms and torso are found from horizontal
  cross-sections (runs of occupied space along X), joints from those runs plus human proportions.
* Skins with bone-heat weights; if the heat solve leaves vertices unweighted (common on scanned,
  non-manifold meshes) the weights are solved on a voxel-remeshed proxy and transferred.
  Max 4 influences, normalized.
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
ang = math.atan2(fwd[1], fwd[0])
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
V = verts()
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
        track.append((z, r[2].mean(0)))
    return track


J = {}
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
    tip_z = tr[0][0]
    zs = np.array([t[0] for t in tr])
    cs = np.array([t[1] for t in tr])

    def at(z):
        k = int(np.argmin(np.abs(zs - z)))
        return cs[k]

    torso_c, torso_w = central(0.78 * H)
    sh = Vector((side * max(0.095 * H, torso_w - 0.035 * H), torso_c[1], 0.815 * H))
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
def unweighted(obj):
    n = 0
    for v in obj.data.vertices:
        if not any(g.weight > 1e-4 for g in v.groups):
            n += 1
    return n


def auto_weights(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


auto_weights(body)
bad = unweighted(body)
log(f"bone heat: {bad} of {len(body.data.vertices)} vertices unweighted")
if bad > 0.002 * len(body.data.vertices):
    log("falling back to a voxel proxy")
    for g in list(body.vertex_groups):
        body.vertex_groups.remove(g)
    body.parent = None
    for m in list(body.modifiers):
        body.modifiers.remove(m)
    proxy = body.copy()
    proxy.data = body.data.copy()
    bpy.context.scene.collection.objects.link(proxy)
    rm = proxy.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = 0.012
    bpy.context.view_layer.objects.active = proxy
    bpy.ops.object.modifier_apply(modifier=rm.name)
    auto_weights(proxy)
    log(f"proxy: {unweighted(proxy)} of {len(proxy.data.vertices)} unweighted")
    for b in arm_data.bones:
        body.vertex_groups.new(name=b.name)
    dt = body.modifiers.new("transfer", "DATA_TRANSFER")
    dt.object = proxy
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    bpy.data.objects.remove(proxy, do_unlink=True)
    body.parent = rig
    am = body.modifiers.new("rig", "ARMATURE")
    am.object = rig
    log(f"after transfer: {unweighted(body)} unweighted")

bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
bpy.ops.object.mode_set(mode="OBJECT")

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
# bend test in pose mode
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="POSE")
pb = rig.pose.bones


def rot(name, axis, deg):
    b = pb[name]
    b.rotation_mode = "XYZ"
    e = list(b.rotation_euler)
    e["XYZ".index(axis)] += math.radians(deg)
    b.rotation_euler = e


for t, sgn in (("L", -1), ("R", 1)):
    rot(f"upperArm_{t}", "X", 70)
    rot(f"lowerArm_{t}", "X", 70)
    rot(f"thigh_{t}", "X", -55 if t == "L" else 25)
    rot(f"shin_{t}", "X", 70 if t == "L" else 20)
rot("spine", "Y", 20)
rot("neck", "X", 15)
bpy.ops.object.mode_set(mode="OBJECT")
shoot("bend")
log("proofs done")
