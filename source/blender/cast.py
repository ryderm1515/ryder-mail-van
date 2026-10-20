# Willow Lane cast (see DESIGN.md). Run inside Blender 5.x.
#
# Characters are modelled from purpose-built meshes: sculpted quad-sphere
# heads, lathed garments from designed profiles, swept tubes, solidified hair
# shells. Each moving part becomes one object with its origin at the joint,
# under an empty "root" on the ground. Characters face Blender -Y.
import bpy, bmesh, math, os
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

OUT = globals().get("OUT", "/tmp")
RENDERS = globals().get("RENDERS", "/tmp")
SCENE = "Willow Lane cast"
V = Vector

# ---------------------------------------------------------------- materials


def lin(hexc):
    h = hexc.lstrip("#")
    return tuple((int(h[i : i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4)) + (1,)


def setin(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val


def M(name, hexc, rough=0.62, sheen=0.0, coat=0.0, spec=0.35, noise=0.0):
    m = bpy.data.materials.get("WL " + name) or bpy.data.materials.new("WL " + name)
    m.use_nodes = True
    m.diffuse_color = lin(hexc)
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in ("BSDF_PRINCIPLED", "OUTPUT_MATERIAL"):
            nt.nodes.remove(n)
    b = nt.nodes.get("Principled BSDF")
    setin(b, "Base Color", lin(hexc))
    setin(b, "Roughness", rough)
    setin(b, "Specular IOR Level", spec)
    setin(b, "Sheen Weight", sheen)
    setin(b, "Sheen Roughness", 0.6)
    setin(b, "Coat Weight", coat)
    setin(b, "Coat Roughness", 0.08)
    if noise:
        tx = nt.nodes.new("ShaderNodeTexNoise")
        setin(tx, "Scale", 60.0)
        mr = nt.nodes.new("ShaderNodeMapRange")
        setin(mr, "To Min", rough - noise)
        setin(mr, "To Max", rough + noise)
        nt.links.new(tx.outputs["Fac"], mr.inputs["Value"])
        nt.links.new(mr.outputs["Result"], b.inputs["Roughness"])
    return m


# ------------------------------------------------------------------- meshes
SC = None


def obj(name, bm, mat, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    SC.collection.objects.link(o)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    return o


def quadsphere(n=6):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=n - 1, use_grid_fill=True)
    for v in bm.verts:
        v.co.normalize()
    return bm


def blob(name, at, size, mat, n=5, rot=None):
    bm = quadsphere(n)
    m = Matrix.Translation(V(at)) @ (rot or Matrix.Identity(4)) @ Matrix.Diagonal(V(size).to_4d())
    m[3][3] = 1
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj(name, bm, mat)


def lathe(name, profile, mat, segs=24, sx=1.0, sy=1.0, at=(0, 0, 0), cap_top=False, cap_bottom=False, a0=0.0, a1=2 * math.pi, frame=None):
    """Revolve (r, z) points about local Z. Partial arcs if a1-a0 < 2pi."""
    bm = bmesh.new()
    full = abs(a1 - a0 - 2 * math.pi) < 1e-6
    cols = segs if full else segs + 1
    rings = []
    for r, z in profile:
        ring = []
        for i in range(cols):
            a = a0 + (a1 - a0) * i / segs
            ring.append(bm.verts.new((r * math.cos(a) * sx, r * math.sin(a) * sy, z)))
        rings.append(ring)
    for k in range(len(rings) - 1):
        for i in range(segs):
            j = (i + 1) % cols
            bm.faces.new([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]])
    if full:
        if cap_top:
            c = bm.verts.new((0, 0, profile[0][1]))
            for i in range(segs):
                bm.faces.new([c, rings[0][(i + 1) % cols], rings[0][i]])
        if cap_bottom:
            c = bm.verts.new((0, 0, profile[-1][1]))
            for i in range(segs):
                bm.faces.new([c, rings[-1][i], rings[-1][(i + 1) % cols]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    m = Matrix.Translation(V(at)) @ (frame or Matrix.Identity(4))
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj(name, bm, mat)


def cone(name, at, r1, r2, depth, mat, segs=12, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r1, radius2=r2, depth=depth)
    from mathutils import Euler
    m = Matrix.Translation(V(at)) @ Euler(rot).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj(name, bm, mat)


def tube(name, pts, radii, mat, segs=8, cap=True):
    pts = [V(p) for p in pts]
    if not hasattr(radii, "__len__"):
        radii = [radii] * len(pts)
    bm = bmesh.new()
    t0 = (pts[1] - pts[0]).normalized()
    ref = V((0, 0, 1)) if abs(t0.z) < 0.9 else V((1, 0, 0))
    nrm = ref.cross(t0).normalized()
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        nrm = (nrm - t * nrm.dot(t)).normalized()
        b = t.cross(nrm)
        rings.append([bm.verts.new(p + (nrm * math.cos(2 * math.pi * k / segs) + b * math.sin(2 * math.pi * k / segs)) * radii[i]) for k in range(segs)])
    for a, b2 in zip(rings, rings[1:]):
        for k in range(segs):
            bm.faces.new([a[k], a[(k + 1) % segs], b2[(k + 1) % segs], b2[k]])
    if cap:
        for ring, p in ((rings[0], pts[0]), (rings[-1], pts[-1])):
            c = bm.verts.new(p)
            for k in range(segs):
                bm.faces.new([c, ring[k], ring[(k + 1) % segs]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj(name, bm, mat)


def xf(o, m):
    o.data.transform(m)


def pull(o, center, radius, delta):
    """Proportional-edit style move with smooth falloff."""
    c, d = V(center), V(delta)
    for v in o.data.vertices:
        t = (v.co - c).length / radius
        if t < 1:
            v.co += d * (1 - t * t) ** 2


def puff(o, center, radius, amount):
    """Inflate along the direction from `center`."""
    c = V(center)
    for v in o.data.vertices:
        off = v.co - c
        t = off.length / radius
        if t < 1 and off.length > 1e-6:
            v.co += off.normalized() * amount * (1 - t * t) ** 2


def mod(o, kind, **kw):
    m = o.modifiers.new(kind, kind)
    for k, v in kw.items():
        setattr(m, k, v)
    return m


# ------------------------------------------------------- surface features


def bvh_of(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.transform(o.matrix_world)
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


def frame(n, up=V((0, 0, 1)), roll=0.0):
    n = n.normalized()
    x = up.cross(n)
    if x.length < 1e-4:
        x = V((1, 0, 0))
    x.normalize()
    y = n.cross(x)
    m = Matrix((x, y, n)).transposed().to_4x4()
    return m @ Matrix.Rotation(roll, 4, "Z")


def hit(bvh, center, d):
    d = V(d).normalized()
    loc, nrm, _, _ = bvh.ray_cast(V(center) + d * 3, -d)
    return loc, nrm


def decal(name, bvh, center, d, size, mat, sink=0.4, roll=0.0, n=4, lift=0.0):
    """A lens-shaped piece set into a surface (eyes, blush, patches)."""
    loc, nrm = hit(bvh, center, d)
    f = frame(nrm, roll=roll)
    m = Matrix.Translation(loc + nrm * (lift - size[2] * sink)) @ f @ Matrix.Diagonal(V(size).to_4d())
    m[3][3] = 1
    bm = quadsphere(n)
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj(name, bm, mat), loc, nrm, f


def on_surface(bvh, center, dirs, offset):
    out = []
    for d in dirs:
        loc, nrm = hit(bvh, center, d)
        out.append(loc + nrm * offset)
    return out


def front_pts(bvh, xz, offset, y0=-3.0):
    out = []
    for x, z in xz:
        loc, nrm, _, _ = bvh.ray_cast(V((x, y0, z)), V((0, 1, 0)))
        if loc is not None:
            out.append(loc + nrm * offset)
    return out


def arc_dirs(base, x0, x1, z0, z1, bend, n=9):
    out = []
    for i in range(n):
        t = i / (n - 1)
        x = x0 + (x1 - x0) * t
        z = z0 + (z1 - z0) * t + bend * math.sin(math.pi * t)
        out.append(V((x, base, z)))
    return out


def eye(prefix, bvh, center, d, w, h, ink, white, depth=0.026, roll=0.0, lash=None, side=1):
    """Glossy lens eye sunk into the face: a big and a small highlight (lit
    from the same side on both eyes) and an optional lid line that flicks
    out at the outer corner."""
    o, loc, nrm, f = decal(prefix, bvh, center, d, (w, h, depth), ink, sink=0.55, roll=roll, n=5)
    x, y = f.col[0].xyz, f.col[1].xyz
    top = loc + nrm * depth * 0.42
    R = f.to_3x3().to_4x4()
    out = [o, blob(prefix + " hl", top - x * w * 0.32 + y * h * 0.36, (w * 0.3, h * 0.26, depth * 0.25), white, 3, R), blob(prefix + " hl2", top + x * w * 0.34 - y * h * 0.42, (w * 0.12, h * 0.11, depth * 0.2), white, 3, R)]
    if lash:
        pts = []
        for i in range(7):
            a = math.pi * (0.12 + 0.76 * i / 6)
            pts.append(loc + x * (math.cos(a) * w * 1.05 * -side) + y * (math.sin(a) * h * 1.04) + nrm * depth * 0.3)
        pts.append(pts[-1] + x * side * w * 0.42 + y * h * 0.28)
        out.append(tube(prefix + " lid", pts, [0.0025, 0.0038, 0.0045, 0.0048, 0.0048, 0.0045, 0.004, 0.0015], lash, 6))
    return out


# ------------------------------------------------------------- assembly
PIVOT = {}


def part(name, pieces, pivot, parent):
    """Merge pieces (modifiers applied) into one object with origin at pivot."""
    pivot = V(pivot)
    dg = bpy.context.evaluated_depsgraph_get()
    mats, bm = [], bmesh.new()
    for o in pieces:
        ev = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev)
        me.transform(Matrix.Translation(-pivot) @ o.matrix_world)
        remap = []
        for m in me.materials:
            if m not in mats:
                mats.append(m)
            remap.append(mats.index(m))
        for p in me.polygons:
            p.material_index = remap[p.material_index] if remap else 0
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        old = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if old.users == 0:
            bpy.data.meshes.remove(old)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    SC.collection.objects.link(o)
    PIVOT[o.name] = pivot
    if parent:
        o.parent = parent
        o.location = pivot - PIVOT.get(parent.name, V())
    else:
        o.location = pivot
    return o


def root(name):
    e = bpy.data.objects.new("root", None)
    e.empty_display_size = 0.15
    SC.collection.objects.link(e)
    e["character"] = name
    PIVOT[e.name] = V()
    return e


def refresh():
    bpy.context.view_layer.update()


# ===================================================================== JUNIPER


def juniper():
    skin = M("skin", "#f0c4a0", 0.55, sheen=0.15)
    blush = M("blush", "#f29c8c", 0.75)
    ink = M("eye", "#2f2422", 0.18, coat=1.0, spec=0.5)
    white = M("eye light", "#fffaf2", 0.2, spec=0.2)
    brow = M("brow", "#5a3626", 0.7)
    lip = M("mouth", "#9b4a3f", 0.6)
    hair = M("hair", "#6b4430", 0.5, sheen=0.25, noise=0.04)
    dress = M("smock", "#8fb08a", 0.7, sheen=0.35, noise=0.12)
    dress_dk = M("smock seam", "#76976f", 0.75, sheen=0.3)
    cream = M("apron", "#f3e9d2", 0.72, sheen=0.35, noise=0.12)
    piping = M("piping", "#c9714f", 0.65, sheen=0.25)
    collar = M("collar", "#fbf6ec", 0.7, sheen=0.4)
    glove = M("gloves", "#e0915a", 0.68, sheen=0.3, noise=0.1)
    boot = M("boots", "#d9a441", 0.38, spec=0.5)
    sole = M("soles", "#8a6a3e", 0.6)
    straw = M("straw", "#e8cf94", 0.75, noise=0.15)
    ribbon = M("ribbon", "#c9714f", 0.5, sheen=0.4)
    petal = M("petal", "#fffaf0", 0.6)
    yolk = M("flower centre", "#f2c14e", 0.6)
    can = M("can", "#8fb7cf", 0.35, spec=0.6)
    can_dk = M("can trim", "#6f97b2", 0.4, spec=0.6)

    r = root("neighbor")
    HC = V((0, 0, 0.95))  # head centre

    # ---- body: bell smock with seams, collar, apron
    smock = lathe("smock", [(0.055, 0.735), (0.092, 0.728), (0.13, 0.7), (0.152, 0.655), (0.158, 0.6), (0.16, 0.545), (0.172, 0.48), (0.196, 0.41), (0.222, 0.345), (0.24, 0.3), (0.246, 0.282), (0.24, 0.272), (0.228, 0.27)], dress, segs=32, sy=0.86, cap_top=True)
    hem = tube("hem", [V((0.245 * math.cos(a), 0.245 * 0.86 * math.sin(a), 0.279)) for a in [i * 2 * math.pi / 40 for i in range(41)]], 0.009, dress_dk, 6, cap=False)
    waist = tube("waist seam", [V((0.163 * math.cos(a), 0.163 * 0.86 * math.sin(a), 0.535)) for a in [i * 2 * math.pi / 36 for i in range(37)]], 0.005, dress_dk, 6, cap=False)
    # Apron: front skirt panel + bib + pocket, piped edges.
    apron = lathe("apron", [(0.168, 0.53), (0.182, 0.47), (0.204, 0.4), (0.228, 0.335), (0.244, 0.3)], cream, segs=18, sy=0.86, a0=math.radians(-155), a1=math.radians(-25))
    for v in apron.data.vertices:
        v.co.xy *= 1.035
    bib = lathe("bib", [(0.146, 0.665), (0.155, 0.62), (0.159, 0.575), (0.163, 0.535)], cream, segs=10, sy=0.86, a0=math.radians(-122), a1=math.radians(-58))
    for v in bib.data.vertices:
        v.co.xy *= 1.04
    pip = []
    for a in (-155, -25):
        aa = math.radians(a)
        pip.append(tube("apron edge", [V((rr * 1.035 * math.cos(aa), rr * 1.035 * 0.86 * math.sin(aa), z)) for rr, z in [(0.168, 0.53), (0.182, 0.47), (0.204, 0.4), (0.228, 0.335), (0.244, 0.3)]], 0.0045, piping, 6))
    pip.append(tube("apron hem", [V((0.252 * math.cos(aa), 0.252 * 0.86 * math.sin(aa), 0.298)) for aa in [math.radians(-155 + 130 * i / 24) for i in range(25)]], 0.0045, piping, 6))
    pip.append(tube("bib top", [V((0.152 * math.cos(aa), 0.152 * 0.86 * math.sin(aa), 0.666)) for aa in [math.radians(-122 + 64 * i / 12) for i in range(13)]], 0.0042, piping, 6))
    # Pocket with a stitched rim on the apron front.
    pocket = blob("pocket", (0.075, -0.205, 0.39), (0.05, 0.012, 0.04), cream, 4, Matrix.Rotation(math.radians(-18), 4, "Z"))
    pocket_rim = tube("pocket rim", [V((0.075 + 0.05 * math.cos(a) * math.cos(math.radians(18)), -0.214 + 0.05 * math.cos(a) * math.sin(math.radians(18)) * -1, 0.39 + 0.035 * math.sin(a))) for a in [math.pi * (0.0 + i / 16) for i in range(17)]], 0.0035, piping, 6, cap=False)
    # A seed packet peeking from the pocket.
    seeds = blob("seed packet", (0.085, -0.208, 0.43), (0.025, 0.006, 0.03), M("seed packet", "#e98a6b", 0.6), 3, Matrix.Rotation(math.radians(-12), 4, "Y"))
    # Apron straps over the shoulders and a bow at the back.
    straps = []
    for s in (1, -1):
        straps.append(tube("strap", [V((s * 0.075, -0.13, 0.666)), V((s * 0.095, -0.1, 0.72)), V((s * 0.105, 0.0, 0.738)), V((s * 0.1, 0.1, 0.71)), V((s * 0.09, 0.135, 0.62)), V((s * 0.04, 0.15, 0.54))], 0.006, cream, 6))
    bow = [blob("bow loop", (s * 0.045, 0.16, 0.54), (0.04, 0.012, 0.022), cream, 4, Matrix.Rotation(math.radians(s * 20), 4, "Y")) for s in (1, -1)]
    bow.append(blob("bow knot", (0, 0.162, 0.54), (0.016, 0.012, 0.016), cream, 3))
    bow += [tube("bow tail", [V((s * 0.01, 0.16, 0.535)), V((s * 0.03, 0.17, 0.49)), V((s * 0.04, 0.165, 0.45))], [0.008, 0.01, 0.006], cream, 6) for s in (1, -1)]
    # Peter Pan collar: two rounded flaps resting on the shoulders.
    col = []
    for s in (1, -1):
        c = blob("collar", (s * 0.05, -0.085, 0.722), (0.058, 0.04, 0.011), collar, 4, Matrix.Rotation(math.radians(-28), 4, "X") @ Matrix.Rotation(math.radians(s * 22), 4, "Z"))
        col.append(c)
    col.append(tube("collar band", [V((0.066 * math.cos(a), 0.066 * 0.9 * math.sin(a), 0.737)) for a in [i * 2 * math.pi / 24 for i in range(25)]], 0.009, collar, 6, cap=False))
    neck = lathe("neck", [(0.046, 0.77), (0.048, 0.745), (0.052, 0.72)], skin, segs=16)
    # Legs and rain boots (toe-shaped foot + lathed shaft with a rolled lip).
    legs, boots = [], []
    for s in (1, -1):
        x = s * 0.085
        legs.append(lathe("leg", [(0.04, 0.33), (0.042, 0.25), (0.04, 0.17)], skin, segs=14, at=(x, 0.0, 0)))
        boots.append(lathe("boot shaft", [(0.052, 0.185), (0.056, 0.15), (0.058, 0.09), (0.06, 0.05)], boot, segs=18, at=(x, 0.005, 0)))
        boots.append(tube("boot lip", [V((x + 0.058 * math.cos(a), 0.005 + 0.058 * math.sin(a), 0.186)) for a in [i * 2 * math.pi / 20 for i in range(21)]], 0.01, boot, 6, cap=False))
        foot = blob("boot foot", (x, -0.03, 0.045), (0.064, 0.092, 0.05), boot, 5)
        pull(foot, (x, -0.11, 0.07), 0.07, (0, -0.005, -0.012))
        boots.append(foot)
        boots.append(blob("sole", (x, -0.03, 0.012), (0.066, 0.094, 0.014), sole, 4))
    body = part("body", [smock, hem, waist, apron, bib, pocket, pocket_rim, seeds, *pip, *straps, *bow, *col, neck, *legs, *boots], (0, 0, 0.55), r)

    # ---- head
    head = blob("head", HC, (0.262, 0.238, 0.25), skin, 8)
    pull(head, HC + V((0.0, -0.06, -0.21)), 0.16, (0, 0.0, 0.03))  # soften chin up
    for s in (1, -1):
        pull(head, HC + V((s * 0.17, -0.14, -0.08)), 0.13, (s * 0.012, -0.012, -0.004))  # round cheeks
    pull(head, HC + V((0, 0.18, 0.05)), 0.2, (0, 0.025, 0.01))  # fuller skull
    refresh()
    hb = bvh_of(head)
    face = []
    for s in (1, -1):
        face += eye("eye", hb, HC, (s * 0.37, -1, -0.08), 0.037, 0.05, ink, white, roll=math.radians(s * -4), lash=brow, side=s)
        face.append(decal("cheek", hb, HC, (s * 0.62, -1, -0.32), (0.05, 0.032, 0.008), blush, sink=0.6)[0])
        bp = on_surface(hb, HC, arc_dirs(-1, s * 0.22, s * 0.58, 0.18, 0.14, 0.05, 7), 0.004)
        face.append(tube("brow", bp, [0.003, 0.0045, 0.005, 0.005, 0.0045, 0.0035, 0.002], brow, 6))
    face.append(decal("nose", hb, HC, (0, -1, -0.2), (0.022, 0.015, 0.016), M("nose", "#e8b08a", 0.5), sink=0.3)[0])
    mp = on_surface(hb, HC, arc_dirs(-1, -0.13, 0.13, -0.36, -0.36, -0.05, 9), 0.002)
    face.append(tube("mouth", mp, [0.002, 0.0035, 0.0045, 0.005, 0.005, 0.005, 0.0045, 0.0035, 0.002], lip, 6))
    ears = [blob("ear", HC + V((s * 0.255, 0.02, -0.03)), (0.03, 0.045, 0.05), skin, 3) for s in (1, -1)]

    # ---- hair: bob shell with scalloped bangs, ends flipped out
    # Parametric shell: rows run from the crown down to a designed hairline
    # (scalloped bangs at the front, face-framing sides, longer at the nape),
    # so the edge is clean instead of cut from a sphere.
    sm = lambda x: (lambda y: y * y * (3 - 2 * y))(max(0.0, min(1.0, x)))
    A, B, C = 0.285, 0.262, 0.272
    hc = HC + V((0, 0.012, 0.018))

    def edge(phi):
        ap = abs(phi)
        bang = 0.058 + 0.026 * math.cos(phi * 11)
        side = -0.11 - 0.075 * sm((ap - math.pi / 2) / (math.pi / 2))
        return bang + (side - bang) * sm((ap - 0.7) / 0.55)

    cols, rows = 72, 18
    hbm = bmesh.new()
    pole = hbm.verts.new(hc + V((0, 0, C)))
    grid = []
    for j in range(1, rows + 1):
        v = j / rows
        ring = []
        for i in range(cols):
            th = 2 * math.pi * i / cols
            phi = math.atan2(math.sin(th + math.pi / 2), math.cos(th + math.pi / 2))
            z = C + (edge(phi) - C) * v ** 0.85
            rr = math.sqrt(max(0.0, 1 - (z / C) ** 2))
            ring.append(hbm.verts.new(hc + V((A * rr * math.cos(th), B * rr * math.sin(th), z))))
        grid.append(ring)
    for i in range(cols):
        hbm.faces.new([pole, grid[0][(i + 1) % cols], grid[0][i]])
    for a_, b_ in zip(grid, grid[1:]):
        for i in range(cols):
            hbm.faces.new([a_[i], a_[(i + 1) % cols], b_[(i + 1) % cols], b_[i]])
    bmesh.ops.recalc_face_normals(hbm, faces=hbm.faces)
    hairo = obj("hair", hbm, hair)
    for s in (1, -1):
        pull(hairo, HC + V((s * 0.27, 0.02, -0.12)), 0.12, (s * 0.04, 0, 0.02))  # flip
    pull(hairo, HC + V((0, 0.24, -0.13)), 0.14, (0, 0.03, 0.025))
    pull(hairo, HC + V((0, -0.2, 0.12)), 0.12, (0, -0.012, -0.004))  # bangs sit forward
    mod(hairo, "SOLIDIFY", thickness=0.024, offset=-1)

    # ---- two short braids with terracotta ties
    braids = []
    for s_ in (1, -1):
        p0 = HC + V((s_ * 0.215, 0.05, -0.15))
        c = p0
        for k in range(6):
            t = k / 5
            c = p0 + V((s_ * 0.022 * t, 0.012 * t, -0.034 * k))
            sz = 0.04 - 0.0045 * k
            side = 1 if k % 2 else -1  # plait: lobes lean left and right in turn
            braids.append(blob("braid", c + V((side * 0.007, 0, 0)), (sz, sz * 0.82, sz * 0.62), hair, 4, Matrix.Rotation(math.radians(side * 28), 4, "Y")))
        braids.append(lathe("braid tie", [(0.019, 0.011), (0.023, 0.0), (0.019, -0.011)], ribbon, segs=12, at=c + V((0, 0, -0.026))))
        braids.append(blob("braid tuft", c + V((s_ * 0.004, 0, -0.058)), (0.022, 0.02, 0.034), hair, 4))
    # ---- straw hat tipped back with ribbon, bow and a daisy
    tip = Matrix.Translation(HC + V((0, 0.012, 0.172))) @ Matrix.Rotation(math.radians(-7), 4, "X")
    hat = lathe("hat", [(0.0, 0.15), (0.08, 0.148), (0.145, 0.135), (0.195, 0.1), (0.218, 0.05), (0.226, 0.012), (0.232, 0.0), (0.29, -0.008), (0.34, -0.02), (0.375, -0.036)], straw, segs=40, cap_top=True, frame=tip)
    mod(hat, "SOLIDIFY", thickness=0.012, offset=-1)
    band = lathe("band", [(0.221, 0.05), (0.226, 0.026), (0.229, 0.008)], ribbon, segs=40, frame=tip)
    bowp = tip @ V((0.15, -0.09, 0.03))
    bows = [blob("hat bow", tip @ V((0.17 + dx, -0.14, 0.03)), (0.032, 0.012, 0.02), ribbon, 3, Matrix.Rotation(math.radians(-35), 4, "Z") @ Matrix.Rotation(math.radians(r_), 4, "Y")) for dx, r_ in ((0.02, 25), (-0.03, -25))]
    flower = [blob("daisy petal", tip @ V((-0.15 + 0.03 * math.cos(a), -0.172, 0.035 + 0.03 * math.sin(a))), (0.02, 0.006, 0.01), petal, 3, Matrix.Rotation(math.radians(-40), 4, "Z") @ Matrix.Rotation(a, 4, "Y")) for a in [i * 2 * math.pi / 7 for i in range(7)]]
    flower.append(blob("daisy centre", tip @ V((-0.15, -0.177, 0.035)), (0.013, 0.009, 0.013), yolk, 3))
    headpart = part("head", [head, *face, *ears, hairo, *braids, hat, band, *bows, *flower], (0, 0, 0.78), body)

    # ---- arms: puff sleeves, cuffs, gardening gloves
    for nm, s in (("arm_L", 1), ("arm_R", -1)):
        sh = V((s * 0.152, 0.0, 0.68))
        fr = Matrix.Translation(sh) @ Matrix.Rotation(math.radians(-14), 4, "X") @ Matrix.Rotation(math.radians(-s * 30), 4, "Y") @ Matrix.Rotation(math.radians(180), 4, "X")
        sleeve = lathe("sleeve", [(0.0, -0.03), (0.04, -0.028), (0.06, 0.0), (0.066, 0.04), (0.06, 0.08), (0.046, 0.098), (0.04, 0.1)], dress, segs=18, cap_top=True, frame=fr)
        cuff = tube("cuff", [fr @ V((0.043 * math.cos(a), 0.043 * math.sin(a), 0.098)) for a in [i * 2 * math.pi / 18 for i in range(19)]], 0.0065, collar, 6, cap=False)
        fore = lathe("forearm", [(0.034, 0.1), (0.033, 0.16), (0.036, 0.19)], skin, segs=14, frame=fr)
        gl = lathe("glove cuff", [(0.045, 0.17), (0.048, 0.185), (0.044, 0.2)], glove, segs=14, frame=fr)
        hand = blob("mitten", fr @ V((0, 0, 0.235)), (0.044, 0.036, 0.05), glove, 4, fr.to_3x3().to_4x4())
        thumb = blob("thumb", fr @ V((-s * 0.0 + 0.0, -0.035, 0.215)), (0.016, 0.02, 0.022), glove, 3, fr.to_3x3().to_4x4())
        arm = part(nm, [sleeve, cuff, fore, gl, hand, thumb], sh, body)
        if nm == "arm_R":
            hand_at = fr @ V((0, 0, 0.235))
            hold = hand_at + V((0.0, -0.02, -0.03))
            cbody = lathe("can body", [(0.0, 0.12), (0.06, 0.12), (0.075, 0.105), (0.078, 0.06), (0.074, 0.01), (0.07, 0.0), (0.0, 0.0)], can, segs=24, cap_top=True, cap_bottom=True, at=hold + V((0, -0.06, -0.17)))
            rim = tube("can rim", [hold + V((0.062 * math.cos(a), -0.06 + 0.062 * math.sin(a), -0.05)) for a in [i * 2 * math.pi / 24 for i in range(25)]], 0.006, can_dk, 6, cap=False)
            handle = tube("can handle", [hold + V((0, 0.015, -0.06)), hold + V((0, 0.03, 0.0)), hold + V((0, -0.02, 0.03)), hold + V((0, -0.08, 0.0)), hold + V((0, -0.1, -0.06))], 0.009, can_dk, 8)
            spout = tube("can spout", [hold + V((0, -0.13, -0.15)), hold + V((0, -0.2, -0.1)), hold + V((0, -0.26, -0.04))], [0.014, 0.011, 0.009], can, 10)
            rose = lathe("can rose", [(0.012, 0.0), (0.024, 0.025), (0.026, 0.03), (0.0, 0.031)], can_dk, segs=14, cap_top=False, frame=Matrix.Translation(hold + V((0, -0.26, -0.04))) @ Matrix.Rotation(math.radians(-50), 4, "X") @ Matrix.Rotation(math.radians(180), 4, "X") @ Matrix.Rotation(math.radians(180), 4, "X"))
            part("can", [cbody, rim, handle, spout, rose], hold, arm)
    return r


# ===================================================================== BISCUIT


def biscuit():
    fur = M("dog fur", "#c98a3c", 0.6, sheen=0.2, noise=0.08)
    cream = M("dog cream", "#f6ead6", 0.62, sheen=0.5, noise=0.1)
    ink = M("eye", "#2f2422", 0.18, coat=1.0, spec=0.5)
    white = M("eye light", "#fffaf2", 0.2, spec=0.2)
    nose = M("dog nose", "#3b2a26", 0.25, coat=0.8, spec=0.5)
    pink = M("dog pink", "#f2a2a0", 0.55)
    mouth = M("dog mouth", "#5a3a32", 0.6)
    band = M("bandana", "#8fb7cf", 0.68, sheen=0.4, noise=0.1)
    dots = M("bandana dots", "#fbf6ec", 0.68)
    blush = M("blush", "#f29c8c", 0.75)

    r = root("dog")
    # ---- body loaf, cream belly, bandana
    torso = blob("torso", (0, 0.03, 0.2), (0.118, 0.17, 0.105), fur, 7)
    puff(torso, (0, -0.12, 0.17), 0.13, 0.018)  # chest
    pull(torso, (0, 0.16, 0.22), 0.12, (0, 0.02, 0.012))  # rump
    refresh()
    tb = bvh_of(torso)
    belly = decal("belly", tb, (0, 0.0, 0.2), (0, -0.55, -1), (0.08, 0.13, 0.025), cream, sink=0.55)[0]
    chest = decal("chest", tb, (0, 0.0, 0.2), (0, -1, -0.2), (0.075, 0.07, 0.03), cream, sink=0.5)[0]
    scarf_ring = tube("bandana ring", [V((0.09 * math.cos(a), -0.1 + 0.07 * math.sin(a), 0.27 + 0.02 * math.sin(a))) for a in [i * 2 * math.pi / 28 for i in range(29)]], 0.016, band, 8, cap=False)
    flap = blob("bandana flap", (0, -0.165, 0.215), (0.07, 0.016, 0.06), band, 4, Matrix.Rotation(math.radians(-25), 4, "X"))
    for v in flap.data.vertices:  # point the flap down into a triangle
        rel = v.co - V((0, -0.165, 0.215))
        if rel.z < 0:
            v.co.x *= 1 - min(0.85, -rel.z / 0.06 * 0.85)
    refresh()
    fb = bvh_of(flap)
    spots = [decal("dot", fb, (0, -0.165, 0.215), (dx, -1, dz), (0.009, 0.009, 0.004), dots, sink=0.2, n=3)[0] for dx, dz in ((-0.35, 0.25), (0.35, 0.3), (0.0, 0.0), (-0.15, -0.35), (0.2, -0.3), (0.55, -0.05), (-0.55, -0.05))]
    tag = blob("tag", (0.0, -0.18, 0.26), (0.016, 0.006, 0.02), M("tag", "#f2c14e", 0.3, spec=0.7), 3)
    body = part("body", [torso, belly, chest, scarf_ring, flap, *spots, tag], (0, 0.03, 0.2), r)

    # ---- legs with cream socks and pink beans
    for nm, x, y in (("leg_FL", 0.068, -0.085), ("leg_FR", -0.068, -0.085), ("leg_BL", 0.072, 0.13), ("leg_BR", -0.072, 0.13)):
        leg = lathe("leg", [(0.0, 0.17), (0.034, 0.165), (0.04, 0.12), (0.038, 0.07)], fur, segs=14, cap_top=True, at=(x, y, 0))
        sock = lathe("sock", [(0.039, 0.075), (0.041, 0.04), (0.0, 0.04)], cream, segs=14, cap_bottom=True, at=(x, y, 0))
        paw = blob("paw", (x, y - 0.012, 0.024), (0.044, 0.054, 0.026), cream, 4)
        bean = blob("bean", (x, y - 0.015, 0.0015), (0.018, 0.02, 0.003), pink, 3)
        toes = [tube("toe line", [V((x + dx, y - 0.062, 0.03)), V((x + dx, y - 0.066, 0.014))], 0.0025, M("toe", "#d9c5a8", 0.6), 5) for dx in (-0.012, 0.012)]
        part(nm, [leg, sock, paw, bean, *toes], (x, y, 0.16), body)

    # ---- head: big and round, with a sunk-in muzzle
    HC = V((0, -0.13, 0.37))
    head = blob("head", HC, (0.165, 0.142, 0.138), fur, 8)
    for s in (1, -1):
        pull(head, HC + V((s * 0.13, -0.05, -0.07)), 0.1, (s * 0.018, -0.006, -0.012))  # fluffy cheeks
    pull(head, HC + V((0, -0.02, 0.13)), 0.12, (0, 0, 0.012))
    refresh()
    hb = bvh_of(head)
    muzzle, mloc, mn, mf = decal("muzzle", hb, HC, (0, -1, -0.42), (0.075, 0.058, 0.06), cream, sink=0.55, n=6)
    pull(muzzle, mloc + V((0, 0, 0.04)), 0.06, (0, 0.01, -0.008))
    refresh()
    mb = bvh_of(muzzle)
    noseo = decal("nose", mb, mloc - mn * 0.03, (0, -1, 0.6), (0.026, 0.018, 0.02), nose, sink=0.15, n=4)
    nobj, nloc = noseo[0], noseo[1]
    pull(nobj, nloc + V((0, 0, -0.03)), 0.03, (0, 0.002, 0.009))  # rounded triangle
    shine = blob("nose shine", nloc + V((0.007, -0.012, 0.008)), (0.006, 0.003, 0.004), white, 3)
    z0 = nloc.z - 0.026
    mo = [tube("mouth", front_pts(mb, [(-0.034 + 0.068 * t, z0 - 0.014 * abs(math.sin(2 * math.pi * t)) + 0.006 * (abs(t - 0.5) * 2) ** 3) for t in [i / 16 for i in range(17)]], 0.0015), [0.0018] + [0.0036] * 15 + [0.0018], mouth, 6)]
    mo.append(tube("philtrum", front_pts(mb, [(0, nloc.z - 0.012), (0, z0)], 0.0015), [0.003, 0.0034], mouth, 6))
    tongue = blob("tongue", front_pts(mb, [(0.012, z0 - 0.02)], -0.004)[0], (0.014, 0.008, 0.016), pink, 4, Matrix.Rotation(math.radians(10), 4, "Y"))
    face = []
    for s in (1, -1):
        face += eye("eye", hb, HC, (s * 0.52, -1, 0.02), 0.03, 0.036, ink, white, depth=0.022, side=s)
        face.append(decal("brow dot", hb, HC, (s * 0.42, -1, 0.42), (0.02, 0.014, 0.007), cream, sink=0.5)[0])
        face.append(decal("cheek", hb, HC, (s * 0.8, -1, -0.22), (0.026, 0.018, 0.006), blush, sink=0.6)[0])
    forehead = decal("blaze", hb, HC, (0, -0.5, 1), (0.03, 0.06, 0.012), cream, sink=0.55)[0]
    headp = part("head", [head, muzzle, nobj, shine, *mo, tongue, *face, forehead], (0, -0.1, 0.29), body)

    # ---- ears: one perky, one folded (sculpted teardrops)
    for nm, s, fold in (("ear_L", 1, 0.25), ("ear_R", -1, 1.0)):
        base = HC + V((s * 0.11, 0.0, 0.11))
        e = blob("ear", base + V((0, 0, 0.065)), (0.05, 0.018, 0.075), fur, 5)
        for v in e.data.vertices:
            rel = v.co - base
            h = max(0.0, rel.z) / 0.14
            v.co.x += s * 0.03 * h  # flare outward
            ang = fold * 1.9 * h * h  # bend the tip forward and down
            y0, z0 = rel.y, rel.z
            v.co.y = base.y + y0 * math.cos(ang) - z0 * math.sin(ang) * 0.8
            v.co.z = base.z + y0 * math.sin(ang) + z0 * math.cos(ang)
            v.co.x *= 1 - 0.35 * max(0, rel.z - 0.08) / 0.07  # taper the tip
        inner = blob("ear inner", base + V((0, -0.012, 0.055)), (0.03, 0.008, 0.045), pink, 4)
        for v in inner.data.vertices:
            rel = v.co - base
            h = max(0.0, rel.z) / 0.14
            v.co.x += s * 0.03 * h
            ang = fold * 1.9 * h * h
            y0, z0 = rel.y, rel.z
            v.co.y = base.y + y0 * math.cos(ang) - z0 * math.sin(ang) * 0.8
            v.co.z = base.z + y0 * math.sin(ang) + z0 * math.cos(ang)
        part(nm, [e, inner], base, headp)

    # ---- tail: fluffy curl with a cream tip
    pts, rad = [], []
    cy, cz = 0.175, 0.345
    for i in range(22):
        t = i / 21
        a = math.radians(-80 + 320 * t)  # from the rump, up, over and round
        rr = 0.06 * (1 - 0.45 * t)
        pts.append(V((0.0, cy + rr * math.cos(a) * 0.9, cz + rr * math.sin(a))))
        rad.append(0.036 * (1 - 0.5 * t) + 0.004 * math.sin(t * 12))
    pts.insert(0, V((0, 0.2, 0.25)))
    rad.insert(0, 0.034)
    tl = tube("tail", pts, rad, fur, 12)
    tip = blob("tail tip", pts[-1], (0.022, 0.022, 0.022), cream, 3)
    part("tail", [tl, tip], pts[0], body)
    return r


# ======================================================================= MOCHI


def mochi():
    fur = M("cat fur", "#9aa7b5", 0.62, sheen=0.4, noise=0.08)
    stripe = M("cat stripe", "#7f8c9b", 0.65, sheen=0.35)
    cream = M("cat cream", "#f3efe8", 0.62, sheen=0.45, noise=0.08)
    ink = M("eye", "#2f2422", 0.18, coat=1.0, spec=0.5)
    iris = M("cat iris", "#c9b55a", 0.2, coat=1.0, spec=0.5)
    white = M("eye light", "#fffaf2", 0.2, spec=0.2)
    pink = M("cat pink", "#f0aeb0", 0.55)
    mouth = M("cat mouth", "#5a4a50", 0.6)
    bell = M("bell", "#f2c14e", 0.3, spec=0.8)
    collar = M("cat collar", "#c9714f", 0.55, sheen=0.3)
    r = root("cat")
    # Sitting loaf body with a cream bib, front paws tucked, haunches.
    torso = blob("torso", (0, 0.02, 0.09), (0.085, 0.092, 0.09), fur, 6)
    pull(torso, (0, 0.02, 0.0), 0.12, (0, 0, -0.008))
    for s in (1, -1):
        pull(torso, (s * 0.07, 0.05, 0.05), 0.08, (s * 0.015, 0.0, 0.0))  # haunches
    refresh()
    tb = bvh_of(torso)
    bib = decal("bib", tb, (0, 0.02, 0.1), (0, -1, 0.1), (0.05, 0.075, 0.025), cream, sink=0.5)[0]
    paws = [blob("paw", (s * 0.035, -0.07, 0.018), (0.026, 0.04, 0.02), cream, 4) for s in (1, -1)]
    stripes = [decal("stripe", tb, (0, 0.02, 0.1), (s * 1, 0.4, 0.3 - 0.35 * k), (0.012, 0.035, 0.006), stripe, sink=0.4, n=3)[0] for s in (1, -1) for k in range(2)]
    ring = tube("collar", [V((0.055 * math.cos(a), -0.01 + 0.05 * math.sin(a), 0.172)) for a in [i * 2 * math.pi / 22 for i in range(23)]], 0.008, collar, 6, cap=False)
    bel = blob("bell", (0, -0.064, 0.16), (0.014, 0.014, 0.014), bell, 4)
    body = part("body", [torso, bib, *paws, *stripes, ring, bel], (0, 0, 0.1), r)
    # Head: wide cheeks, sleepy half-lidded eyes (calm, a little judgmental).
    HC = V((0, -0.02, 0.255))
    head = blob("head", HC, (0.11, 0.092, 0.088), fur, 7)
    for s in (1, -1):
        pull(head, HC + V((s * 0.095, -0.025, -0.035)), 0.06, (s * 0.014, 0, -0.008))
    refresh()
    hb = bvh_of(head)
    face = []
    for s in (1, -1):
        e, loc, nrm, f = decal("eye", hb, HC, (s * 0.5, -1, 0.02), (0.02, 0.021, 0.014), iris, sink=0.5, n=4)
        x, y = f.col[0].xyz, f.col[1].xyz
        pupil = blob("pupil", loc + nrm * 0.004, (0.006, 0.012, 0.003), ink, 3, f.to_3x3().to_4x4())
        hl = blob("eye hl", loc + nrm * 0.005 - x * 0.006 + y * 0.007, (0.004, 0.004, 0.002), white, 3, f.to_3x3().to_4x4())
        lid = decal("lid", hb, HC, (s * 0.5, -1, 0.17), (0.024, 0.013, 0.014), fur, sink=0.3, n=4)[0]  # half-lidded
        lidline = tube("lid line", [loc + x * (-s * 0.017) + y * 0.004 + nrm * 0.004, loc + y * 0.006 + nrm * 0.006, loc + x * (s * 0.019) + y * 0.002 + nrm * 0.004], [0.0018, 0.0024, 0.0016], mouth, 5)
        face += [e, pupil, hl, lid, lidline]
        face.append(decal("cheek", hb, HC, (s * 0.85, -1, -0.32), (0.016, 0.011, 0.004), pink, sink=0.6)[0])
        for k in range(2):  # whisker dots
            face.append(decal("whisker dot", hb, HC, (s * (0.3 + 0.12 * k), -1, -0.45), (0.003, 0.003, 0.002), stripe, sink=0.2, n=3)[0])
    muzzle = decal("muzzle", hb, HC, (0, -1, -0.38), (0.032, 0.022, 0.02), cream, sink=0.55)[0]
    refresh()
    nose = decal("nose", hb, HC, (0, -1, -0.18), (0.008, 0.006, 0.006), pink, sink=0.2, n=3)
    face += [muzzle, nose[0]]
    nl = nose[1]
    face.append(tube("mouth", [nl + V((-0.012, -0.004, -0.012)), nl + V((-0.006, -0.006, -0.016)), nl + V((0, -0.006, -0.01)), nl + V((0.006, -0.006, -0.016)), nl + V((0.012, -0.004, -0.012))], 0.0016, mouth, 5))
    ears = []
    for s in (1, -1):
        ears.append(cone("ear", HC + V((s * 0.062, 0.0, 0.088)), 0.036, 0.004, 0.06, fur, 10, rot=(math.radians(-6), math.radians(s * 16), 0)))
        ears.append(cone("ear inner", HC + V((s * 0.062, -0.014, 0.084)), 0.021, 0.002, 0.04, pink, 8, rot=(math.radians(-6), math.radians(s * 16), 0)))
    face.append(decal("forehead stripe", hb, HC, (0, -0.4, 1), (0.01, 0.03, 0.005), stripe, sink=0.4)[0])
    part("head", [head, *face, *ears], (0, -0.01, 0.175), body)
    # Long tail wrapped around the paws.
    pts, rad = [], []
    for i in range(16):
        t = i / 15
        a = math.radians(90 + 200 * t)
        pts.append(V((0.085 * math.cos(a) * -1, 0.04 + 0.075 * math.sin(a), 0.02 + 0.01 * math.sin(t * math.pi))))
        rad.append(0.017 * (1 - 0.3 * t))
    tl = tube("tail", pts, rad, fur, 10)
    tip = blob("tail tip", pts[-1], (0.016, 0.016, 0.016), stripe, 3)
    part("tail", [tl, tip], pts[0], body)
    return r


# ========================================================================= PIP


def pip():
    blue = M("bird blue", "#6f9fd8", 0.6, sheen=0.4)
    deep = M("bird wing", "#5582c0", 0.6, sheen=0.4)
    peach = M("bird peach", "#f5c39b", 0.62, sheen=0.4)
    beak = M("beak", "#f0a64a", 0.45)
    ink = M("eye", "#2f2422", 0.18, coat=1.0, spec=0.5)
    white = M("eye light", "#fffaf2", 0.2, spec=0.2)
    blush = M("blush", "#f29c8c", 0.75)
    r = root("bird")
    C = V((0, 0, 0.055))
    b = blob("body", C, (0.042, 0.048, 0.045), blue, 6)
    pull(b, C + V((0, -0.03, 0.04)), 0.04, (0, -0.004, 0.006))  # head bump
    pull(b, C + V((0, 0.04, -0.01)), 0.03, (0, 0.006, -0.004))
    refresh()
    bb = bvh_of(b)
    chest = decal("chest", bb, C, (0, -1, -0.4), (0.03, 0.035, 0.02), peach, sink=0.55)[0]
    face = []
    for s in (1, -1):
        e, loc, nrm, f = decal("eye", bb, C, (s * 0.55, -1, 0.42), (0.0065, 0.008, 0.005), ink, sink=0.45, n=3)
        face += [e, blob("eye hl", loc + nrm * 0.003 + f.col[1].xyz * 0.003, (0.002, 0.002, 0.001), white, 3)]
        face.append(decal("cheek", bb, C, (s * 0.75, -1, 0.15), (0.007, 0.005, 0.002), blush, sink=0.5, n=3)[0])
    bk = decal("beak", bb, C, (0, -1, 0.28), (0.007, 0.006, 0.012), beak, sink=0.1, n=3)
    pull(bk[0], bk[1] - bk[2] * 0.0 + V((0, -0.012, 0)), 0.012, (0, -0.006, -0.002))
    tail = blob("tail", C + V((0, 0.055, 0.005)), (0.02, 0.025, 0.005), deep, 4, Matrix.Rotation(math.radians(-25), 4, "X"))
    feet = [tube("foot", [V((s * 0.012, -0.004, 0.016)), V((s * 0.012, -0.008, 0.0)), V((s * 0.012, -0.018, 0.0))], 0.0025, beak, 5) for s in (1, -1)]
    tuft = [tube("tuft", [C + V((0, -0.01, 0.043)), C + V((0, -0.005, 0.056)), C + V((0, 0.006, 0.06))], [0.004, 0.003, 0.0015], blue, 5)]
    body = part("body", [b, chest, *face, bk[0], tail, *feet, *tuft], C, r)
    for nm, s in (("wing_L", 1), ("wing_R", -1)):
        w = blob("wing", C + V((s * 0.04, 0.008, 0.002)), (0.012, 0.03, 0.022), deep, 4, Matrix.Rotation(math.radians(-15), 4, "X") @ Matrix.Rotation(math.radians(s * 12), 4, "Y"))
        part(nm, [w], C + V((s * 0.036, -0.012, 0.016)), body)
    return r


BUILD = {"neighbor": (juniper, (0.42, 0, 0)), "dog": (biscuit, (-0.42, 0.05, 0)), "cat": (mochi, (-0.95, 0.1, 0)), "bird": (pip, (-1.3, 0.1, 0))}


def new_scene():
    global SC
    sc = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    SC = sc
    return sc


def export_one(name, r):
    os.makedirs(OUT, exist_ok=True)
    for o in SC.objects:
        o.select_set(False)
    for o in [r] + list(r.children_recursive):
        o.select_set(True)
    bpy.context.view_layer.objects.active = r
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + ".glb"), export_format="GLB", use_selection=True, export_apply=True, export_yup=True, export_texcoords=False, export_normals=True, export_materials="EXPORT", export_animations=False, export_extras=False)


def run(names=None, export=False):
    sc = new_scene()
    win = bpy.context.window
    prev = win.scene
    win.scene = sc
    roots = {}
    try:
        for name, (fn, at) in BUILD.items():
            if names and name not in names:
                continue
            PIVOT.clear()
            r = fn()
            refresh()
            if export:
                export_one(name, r)
            for o in [r] + list(r.children_recursive):
                o.name = name + "." + o.name
            r.location = at
            roots[name] = r
    finally:
        win.scene = prev
    return sc, roots


# ---------------------------------------------------------------- studio


def studio(sc):
    """Cyclorama, soft three-point light, camera. Returns the camera."""
    for o in list(sc.objects):
        if o.name.startswith("studio."):
            bpy.data.objects.remove(o, do_unlink=True)
    bm = bmesh.new()
    prof = [(-3.0, 0.0)] + [(1.2 + 0.6 * math.sin(a), 0.6 - 0.6 * math.cos(a)) for a in [i * (math.pi / 2) / 10 for i in range(11)]] + [(1.8, 3.0)]
    rows = []
    for y, z in prof:
        rows.append([bm.verts.new((x, y, z)) for x in (-4, 4)])
    for a, b in zip(rows, rows[1:]):
        bm.faces.new([a[0], a[1], b[1], b[0]])
    cyc = obj("studio.cyc", bm, M("studio", "#ece7df", 0.9))
    mod(cyc, "SUBSURF", levels=2, render_levels=2)
    for nm, loc, rot, power, size, col in (
        ("key", (-1.6, -2.2, 2.4), (math.radians(52), 0, math.radians(-35)), 520, 1.6, (1.0, 0.96, 0.9)),
        ("fill", (2.2, -1.8, 1.2), (math.radians(70), 0, math.radians(50)), 170, 2.4, (0.9, 0.95, 1.0)),
        ("rim", (0.6, 2.0, 2.2), (math.radians(-55), 0, math.radians(165)), 300, 1.2, (1.0, 0.95, 0.9)),
    ):
        L = bpy.data.lights.new("studio." + nm, "AREA")
        L.energy, L.size, L.color = power, size, col
        o = bpy.data.objects.new("studio." + nm, L)
        o.location, o.rotation_euler = loc, rot
        sc.collection.objects.link(o)
    cam = bpy.data.cameras.new("studio.cam")
    cam.lens = 70
    co = bpy.data.objects.new("studio.cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    w = bpy.data.worlds.get("WL studio") or bpy.data.worlds.new("WL studio")
    w.color = (0.75, 0.74, 0.72)
    sc.world = w
    eng = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    sc.render.engine = next((e for e in eng if "EEVEE" in e), eng[0])
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    try:
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    try:
        sc.eevee.taa_render_samples = 64
        sc.eevee.use_shadows = True
    except Exception:
        pass
    return co


def shoot(sc, cam, path, eye, look, lens=70):
    cam.data.lens = lens
    cam.location = V(eye)
    d = V(look) - V(eye)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = path
    win = bpy.context.window
    prev = win.scene
    win.scene = sc
    try:
        bpy.ops.render.render(write_still=True)
    finally:
        win.scene = prev


def turn(roots, deg):
    for r in roots.values():
        r.rotation_euler.z = math.radians(deg)
