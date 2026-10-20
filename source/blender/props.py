# Willow Lane props (trees, bush, picket fence, mailbox, sprinkler).
# Run inside Blender after exec'ing cast.py (uses its helpers: M, blob, lathe,
# tube, part, root, mod, pull, puff, quadsphere, obj, V, Matrix, PIVOT, SC).
# Exports one props.glb; each prop is a root empty named after it, front
# facing -Y (three.js +Z), sitting on the ground at its origin.
import bpy, bmesh, math, os, random
from mathutils import Vector as V, Matrix


def noise_puff(o, amp, seed, freq=7.0):
    rnd = random.Random(seed)
    ph = [rnd.uniform(0, 6.28) for _ in range(6)]
    c = sum((v.co for v in o.data.vertices), V()) / len(o.data.vertices)
    for v in o.data.vertices:
        d = (v.co - c)
        if d.length < 1e-6:
            continue
        n = d.normalized()
        k = math.sin(n.x * freq + ph[0]) * math.sin(n.y * freq + ph[1]) * math.sin(n.z * freq + ph[2]) + 0.5 * math.sin(n.x * freq * 2.1 + ph[3]) * math.sin(n.z * freq * 1.7 + ph[4])
        v.co += n * amp * k


def tree(name, tall=False, seed=1):
    bark = M("bark", "#8a6a4a", 0.8, noise=0.1)
    leaf = M("leaves " + name, "#7fae6f" if not tall else "#8fbb78", 0.7, sheen=0.4, noise=0.12)
    leaf2 = M("leaves deep " + name, "#6a9a5e" if not tall else "#79a866", 0.72, sheen=0.4)
    r = root(name)
    h = 2.4 if not tall else 3.0
    trunk = lathe("trunk", [(0.0, h + 0.4), (0.13, h + 0.35), (0.15, h * 0.6), (0.19, 0.35), (0.28, 0.08), (0.34, 0.0)], bark, segs=12, cap_top=True)
    # A couple of branches into the canopy.
    br = [tube("branch", [V((0, 0, h * 0.62)), V((s * 0.35, 0.05, h * 0.85)), V((s * 0.55, 0.1, h + 0.1))], [0.08, 0.06, 0.04], bark, 8) for s in (1, -1)]
    rnd = random.Random(seed)
    clumps = []
    spec = [(0, 0, h + 1.1, 1.25 if not tall else 1.05, 1.0 if not tall else 1.45)] + [(rnd.uniform(-0.7, 0.7), rnd.uniform(-0.6, 0.6), h + rnd.uniform(0.5, 1.5) * (1.3 if tall else 1), rnd.uniform(0.6, 0.85), 1) for _ in range(5)]
    for i, (x, y, z, s, sz) in enumerate(spec):
        b = blob("clump", (x, y, z), (s, s, s * sz * 0.9), leaf if i % 3 else leaf2, 4)
        noise_puff(b, s * 0.08, seed * 10 + i)
        clumps.append(b)
    part("canopy", clumps, (0, 0, h), r)
    part("trunk", [trunk, *br], (0, 0, 0), r)
    return r


def bush(seed=3):
    leaf = M("bush", "#6f9b62", 0.72, sheen=0.4, noise=0.1)
    leaf2 = M("bush light", "#86b073", 0.72, sheen=0.4)
    petals = [M("flower " + c, c, 0.6) for c in ("#f29c8c", "#f6d36b", "#fbf7ee")]
    r = root("bush")
    rnd = random.Random(seed)
    parts = []
    for i in range(5):
        x, y = rnd.uniform(-0.35, 0.35), rnd.uniform(-0.25, 0.25)
        s = rnd.uniform(0.32, 0.45)
        b = blob("lobe", (x, y, s * 0.75), (s, s, s * 0.85), leaf if i % 2 else leaf2, 4)
        noise_puff(b, s * 0.07, seed + i)
        parts.append(b)
    for i in range(9):
        a = rnd.uniform(0, 6.28)
        p = V((math.cos(a) * 0.45, math.sin(a) * 0.33, rnd.uniform(0.35, 0.65)))
        parts.append(blob("flower", p, (0.045, 0.045, 0.03), petals[i % 3], 3))
    part("bush", parts, (0, 0, 0), r)
    return r


def fence():
    paint = M("fence paint", "#f7f3ea", 0.55, noise=0.06)
    r = root("fence")
    W = 2.0
    pieces = []

    def picket(x, h, w=0.09, d=0.025):
        bm = bmesh.new()
        prof = [(-w / 2, 0), (w / 2, 0), (w / 2, h - w * 0.55), (0, h), (-w / 2, h - w * 0.55)]
        vs = [bm.verts.new((px, -d / 2, pz)) for px, pz in prof] + [bm.verts.new((px, d / 2, pz)) for px, pz in prof]
        bm.faces.new(vs[:5][::-1])
        bm.faces.new(vs[5:])
        for i in range(5):
            j = (i + 1) % 5
            bm.faces.new([vs[i], vs[j], vs[5 + j], vs[5 + i]])
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.006, segments=1, affect="EDGES")
        bmesh.ops.translate(bm, verts=bm.verts, vec=(x, 0, 0))
        o = obj("picket", bm, paint, smooth=False)
        return o

    n = 13
    for i in range(n):
        x = -W / 2 + 0.11 + i * (W - 0.22) / (n - 1)
        pieces.append(picket(x, 0.86 + 0.04 * math.sin(i / (n - 1) * math.pi)))
    for z in (0.22, 0.62):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=(W, 0.035, 0.07), verts=bm.verts)
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0.03, z))
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.008, segments=2, affect="EDGES")
        pieces.append(obj("rail", bm, paint, smooth=False))
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, vec=(0.11, 0.11, 1.0), verts=bm.verts)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(-W / 2, 0.02, 0.5))
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.012, segments=2, affect="EDGES")
    pieces.append(obj("post", bm, paint, smooth=False))
    pieces.append(blob("post cap", (-W / 2, 0.02, 1.02), (0.07, 0.07, 0.04), paint, 4))
    part("fence", pieces, (0, 0, 0), r)
    return r


def mailbox():
    body = M("mailbox", "#5f7f9f", 0.42, spec=0.5)
    inside = M("mailbox inside", "#2f3b45", 0.8)
    wood = M("mailbox post", "#f7f3ea", 0.55)
    red = M("mailbox flag", "#e05a4a", 0.45)
    metal = M("mailbox metal", "#c9cdd0", 0.3, spec=0.8)
    r = root("mailbox")
    L, Wd, H0 = 0.5, 0.24, 1.0  # length (along Y), width, base height
    # Tunnel shell: flat bottom, round top, open at the front (-Y), hollow.
    prof = []
    for i in range(13):
        a = math.pi * i / 12
        prof.append((Wd / 2 * math.cos(a), 0.13 + Wd / 2 * math.sin(a)))
    ring = [(Wd / 2, 0.0)] + prof + [(-Wd / 2, 0.0)]
    bm = bmesh.new()
    cols = []
    for y in (-L / 2, L / 2):
        cols.append([bm.verts.new((x, y, H0 + z)) for x, z in ring])
    for i in range(len(ring) - 1):
        bm.faces.new([cols[0][i], cols[0][i + 1], cols[1][i + 1], cols[1][i]])
    bm.faces.new([cols[0][-1], cols[0][0], cols[1][0], cols[1][-1]])  # floor
    back = bm.faces.new(cols[1][::-1])  # closed back
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    shell = obj("shell", bm, body)
    mod(shell, "SOLIDIFY", thickness=0.012, offset=1, material_offset=1)
    shell.data.materials.append(inside)
    # Rolled rim at the opening.
    rim = tube("rim", [V((x, -L / 2, H0 + z)) for x, z in ring] + [V((ring[0][0], -L / 2, H0 + ring[0][1]))], 0.008, body, 6, cap=False)
    # Post, bracket and a number plate.
    post = lathe("post", [(0.055, H0 - 0.02), (0.06, 0.05), (0.07, 0.0)], wood, segs=12)
    plate = blob("plate", (Wd / 2 + 0.006, 0.05, H0 + 0.1), (0.004, 0.08, 0.035), M("plate", "#fbf7ee", 0.5), 3)
    digits = []
    try:
        cu = bpy.data.curves.new("num", "FONT")
        cu.body = "14"
        cu.size = 0.05
        cu.extrude = 0.002
        cu.align_x = "CENTER"
        cu.align_y = "CENTER"
        t = bpy.data.objects.new("num", cu)
        SC.collection.objects.link(t)
        t.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        t.location = (Wd / 2 + 0.011, 0.05, H0 + 0.1)
        t.data.materials.append(M("ink plate", "#2f3b45", 0.6))
        bpy.context.view_layer.update()
        me = bpy.data.meshes.new_from_object(t.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        dob = bpy.data.objects.new("digits", me)
        SC.collection.objects.link(dob)
        dob.matrix_world = t.matrix_world.copy()
        bpy.data.objects.remove(t, do_unlink=True)
        digits.append(dob)
    except Exception:
        pass
    box = part("body", [shell, rim, post, plate, *digits], (0, 0, 0), r)
    # Door: hinged along its bottom front edge.
    dbm = bmesh.new()
    vs = [dbm.verts.new((x, 0, z)) for x, z in ring]
    dbm.faces.new(vs)
    bmesh.ops.recalc_face_normals(dbm, faces=dbm.faces)
    door = obj("door", dbm, body)
    for v in door.data.vertices:
        v.co = V((v.co.x * 1.02, -L / 2 - 0.006, H0 + v.co.z * 1.02))
    mod(door, "SOLIDIFY", thickness=0.012, offset=-1)
    knob = blob("latch", (0, -L / 2 - 0.025, H0 + 0.21), (0.02, 0.02, 0.012), metal, 3)
    part("door", [door, knob], (0, -L / 2, H0), box)
    # Flag on the side, pivoting near the back.
    arm = blob("flag arm", (Wd / 2 + 0.014, 0.08, H0 + 0.09), (0.006, 0.11, 0.012), red, 3)
    flag = blob("flag", (Wd / 2 + 0.014, -0.02, H0 + 0.09), (0.006, 0.05, 0.035), red, 3)
    hub = blob("flag hub", (Wd / 2 + 0.012, 0.18, H0 + 0.09), (0.012, 0.016, 0.016), metal, 3)
    part("flag", [arm, flag, hub], (Wd / 2 + 0.014, 0.18, H0 + 0.09), box)
    return r


def sprinkler():
    base_m = M("sprinkler", "#e2a33c", 0.45, spec=0.5)
    metal = M("sprinkler metal", "#c9cdd0", 0.3, spec=0.8)
    r = root("sprinkler")
    base = lathe("base", [(0.0, 0.05), (0.07, 0.05), (0.1, 0.02), (0.1, 0.0), (0.0, 0.0)], base_m, segs=16, cap_top=True, cap_bottom=True)
    stem = lathe("stem", [(0.015, 0.2), (0.018, 0.05)], metal, segs=10)
    b = part("base", [base, stem], (0, 0, 0), r)
    arm = tube("arm", [V((-0.11, 0, 0.21)), V((0, 0, 0.23)), V((0.11, 0, 0.21))], 0.012, metal, 8)
    noz = [blob("nozzle", (s * 0.12, 0, 0.215), (0.02, 0.02, 0.02), base_m, 3) for s in (1, -1)]
    part("head", [arm, *noz], (0, 0, 0.21), b)
    return r


PROPS = {"tree_a": lambda: tree("tree_a", False, 1), "tree_b": lambda: tree("tree_b", True, 2), "bush": bush, "fence": fence, "mailbox": mailbox, "sprinkler": sprinkler}


def build_props(export_path=None):
    """Build every prop into the cast scene (SC must be set) and optionally
    export them all to one GLB."""
    roots = {}
    for key, fn in PROPS.items():
        PIVOT.clear()
        r = fn()
        r.name = key
        roots[key] = r
    if export_path:
        for o in SC.objects:
            o.select_set(False)
        for r in roots.values():
            for o in [r] + list(r.children_recursive):
                o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=export_path, export_format="GLB", use_selection=True, export_apply=True, export_yup=True, export_texcoords=False, export_normals=True, export_materials="EXPORT", export_animations=False, export_extras=False)
    return roots
