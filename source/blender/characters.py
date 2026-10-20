# Morning Route characters: dog, neighbor, cat, bird.
#
# Run inside Blender (5.x). Builds everything in its own scene
# "Morning Route characters" so other scenes are untouched, then exports one
# GLB per character to OUT. Each moving part is its own object with its origin
# at the joint, parented into a hierarchy under an empty called "root" whose
# origin sits on the ground. Characters face Blender -Y (three.js +Z).
import bpy, bmesh, math, os
from mathutils import Vector, Matrix

OUT = globals().get("OUT", "/tmp")
SCENE = "Morning Route characters"


def scene():
    sc = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    return sc


def mat(name, hexc, rough=0.8):
    m = bpy.data.materials.get("MR " + name) or bpy.data.materials.new("MR " + name)
    h = hexc.lstrip("#")
    lin = lambda c: (c / 255) ** 2.2
    m.diffuse_color = (lin(int(h[0:2], 16)), lin(int(h[2:4], 16)), lin(int(h[4:6], 16)), 1)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = m.diffuse_color
    b.inputs["Roughness"].default_value = rough
    return m


def vc_material():
    m = bpy.data.materials.get("MR vertex colour")
    if m:
        return m
    m = bpy.data.materials.new("MR vertex colour")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    b.inputs["Roughness"].default_value = 0.75
    a = nt.nodes.new("ShaderNodeVertexColor")
    a.layer_name = "Col"
    nt.links.new(a.outputs["Color"], b.inputs["Base Color"])
    return m


def blob(sc, loc, scale, m, segs=20, rings=12, rot=(0, 0, 0)):
    """Smooth ellipsoid as a new object (later joined into a part)."""
    me = bpy.data.meshes.new("blob")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("blob", me)
    sc.collection.objects.link(o)
    o.data.materials.append(m)
    o.scale = scale
    o.rotation_euler = rot
    o.location = loc
    for p in me.polygons:
        p.use_smooth = True
    return o


def cone(sc, loc, r1, r2, depth, m, segs=14, rot=(0, 0, 0)):
    me = bpy.data.meshes.new("cone")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r1, radius2=r2, depth=depth)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("cone", me)
    sc.collection.objects.link(o)
    o.data.materials.append(m)
    o.rotation_euler = rot
    o.location = loc
    for p in me.polygons:
        p.use_smooth = True
    return o


def torus(sc, loc, R, r, m, rot=(0, 0, 0), maj=24, mn=8):
    me = bpy.data.meshes.new("torus")
    bm = bmesh.new()
    for i in range(maj):
        a = 2 * math.pi * i / maj
        for j in range(mn):
            b = 2 * math.pi * j / mn
            bm.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
    bm.verts.ensure_lookup_table()
    for i in range(maj):
        for j in range(mn):
            a, b, c, d = i * mn + j, i * mn + (j + 1) % mn, ((i + 1) % maj) * mn + (j + 1) % mn, ((i + 1) % maj) * mn + j
            bm.faces.new([bm.verts[a], bm.verts[b], bm.verts[c], bm.verts[d]])
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("torus", me)
    sc.collection.objects.link(o)
    o.data.materials.append(m)
    o.rotation_euler = rot
    o.location = loc
    for p in me.polygons:
        p.use_smooth = True
    return o


PIVOT = {}


def part(sc, name, pieces, pivot, parent):
    """Merge pieces into one mesh object whose origin is the joint `pivot`
    (world space), parented without rotation so local = pivot - parent pivot."""
    pivot = Vector(pivot)
    mats, bm = [], bmesh.new()
    for o in pieces:
        me = o.data.copy()
        me.transform(Matrix.Translation(-pivot) @ o.matrix_basis)
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
    # Bake each piece's colour into a vertex colour so a whole part is one
    # material (one draw call in three.js).
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for p in me.polygons:
        c = mats[p.material_index].diffuse_color if mats else (1, 1, 1, 1)
        for li in p.loop_indices:
            col.data[li].color = c
        p.material_index = 0
        p.use_smooth = True
    me.color_attributes.active_color = col
    me.materials.append(vc_material())
    o = bpy.data.objects.new(name, me)
    sc.collection.objects.link(o)
    PIVOT[o.name] = pivot
    if parent:
        o.parent = parent
        o.location = pivot - PIVOT.get(parent.name, Vector())
    else:
        o.location = pivot
    return o


def root(sc, name):
    e = bpy.data.objects.new("root", None)
    e.empty_display_size = 0.1
    sc.collection.objects.link(e)
    e["character"] = name
    PIVOT[e.name] = Vector()
    return e


def face(sc, head_c, r, eye_dx, eye_z, fwd, dark, white, blush, eye_r=None):
    """Dot eyes with a highlight, rosy cheeks. Returns pieces."""
    eye_r = eye_r or r * 0.13
    out = []
    for s in (-1, 1):
        ex, ez = head_c[0] + s * eye_dx, head_c[2] + eye_z
        ey = head_c[1] - math.sqrt(max(1e-6, r * r - (s * eye_dx) ** 2 - eye_z ** 2)) * fwd
        out.append(blob(sc, (ex, ey, ez), (eye_r, eye_r * 0.7, eye_r * 1.15), dark, 12, 8))
        out.append(blob(sc, (ex + s * eye_r * 0.25, ey - eye_r * 0.55, ez + eye_r * 0.4), (eye_r * 0.32,) * 3, white, 8, 6))
        cx, cz = head_c[0] + s * eye_dx * 1.55, head_c[2] + eye_z - r * 0.32
        cy = head_c[1] - math.sqrt(max(1e-6, r * r - (s * eye_dx * 1.55) ** 2 - (eye_z - r * 0.32) ** 2)) * 0.93
        out.append(blob(sc, (cx, cy, cz), (r * 0.17, r * 0.06, r * 0.11), blush, 12, 8))
    return out


def dog(sc):
    fur, cream, dark, white, blush, collar = mat("dog fur", "#d9a066"), mat("dog cream", "#f6ead6"), mat("ink", "#2a2c30", 0.4), mat("white", "#ffffff", 0.3), mat("blush", "#f2a29a"), mat("collar", "#4f86c6")
    r = root(sc, "dog")
    body = part(sc, "body", [blob(sc, (0, 0.01, 0.24), (0.125, 0.19, 0.115), fur), blob(sc, (0, -0.09, 0.2), (0.09, 0.1, 0.08), cream), torus(sc, (0, -0.14, 0.31), 0.075, 0.016, collar, rot=(math.radians(70), 0, 0)), blob(sc, (0, -0.19, 0.27), (0.022, 0.012, 0.022), mat("tag", "#f1c84b", 0.3), 10, 6)], (0, 0, 0.24), r)
    for nm, x, y in (("leg_FL", 0.072, -0.11), ("leg_FR", -0.072, -0.11), ("leg_BL", 0.075, 0.12), ("leg_BR", -0.075, 0.12)):
        part(sc, nm, [blob(sc, (x, y, 0.1), (0.042, 0.045, 0.1), fur, 14, 8), blob(sc, (x, y - 0.012, 0.025), (0.046, 0.055, 0.03), cream, 14, 8)], (x, y, 0.19), body)
    hc = (0, -0.2, 0.4)
    head = part(sc, "head", [blob(sc, hc, (0.15, 0.135, 0.135), fur, 24, 14), blob(sc, (0, -0.31, 0.365), (0.075, 0.06, 0.05), cream, 18, 10), blob(sc, (0, -0.365, 0.385), (0.026, 0.018, 0.019), dark, 12, 8), blob(sc, (0, -0.33, 0.335), (0.02, 0.01, 0.008), mat("mouth", "#c96d6a"), 10, 6), blob(sc, (0, -0.25, 0.5), (0.05, 0.05, 0.035), cream, 14, 8)] + face(sc, hc, 0.138, 0.06, 0.02, 1, dark, white, blush, 0.019), (0, -0.16, 0.32), body)
    for nm, s in (("ear_L", 1), ("ear_R", -1)):
        part(sc, nm, [blob(sc, (s * 0.13, -0.2, 0.43), (0.035, 0.06, 0.09), mat("dog ear", "#b97b45"), 14, 8, rot=(math.radians(-10), math.radians(s * -25), 0))], (s * 0.11, -0.2, 0.5), head)
    part(sc, "tail", [blob(sc, (0, 0.24, 0.36), (0.035, 0.035, 0.08), fur, 14, 8, rot=(math.radians(-35), 0, 0)), blob(sc, (0, 0.27, 0.43), (0.032, 0.032, 0.04), cream, 12, 8)], (0, 0.18, 0.3), body)
    return r


def neighbor(sc):
    skin, hair, top, skirt, dark, white, blush = mat("skin", "#e3ad84"), mat("hair", "#6b4632"), mat("cardigan", "#9fbf9b"), mat("skirt", "#f1dc9a"), mat("ink", "#2a2c30", 0.4), mat("white", "#ffffff", 0.3), mat("blush", "#f2a29a")
    r = root(sc, "neighbor")
    shoe = mat("shoes", "#7a5a47")
    # Chibi proportions: big head, short round body, stubby legs.
    body = part(sc, "body", [
        blob(sc, (0, 0, 0.74), (0.2, 0.17, 0.2), top, 20, 12),
        blob(sc, (0, 0, 0.5), (0.25, 0.22, 0.17), skirt, 20, 10),
        blob(sc, (0.085, 0, 0.24), (0.065, 0.065, 0.12), skin, 12, 8), blob(sc, (-0.085, 0, 0.24), (0.065, 0.065, 0.12), skin, 12, 8),
        blob(sc, (0.085, -0.035, 0.06), (0.075, 0.1, 0.06), shoe, 12, 8), blob(sc, (-0.085, -0.035, 0.06), (0.075, 0.1, 0.06), shoe, 12, 8),
        blob(sc, (0.07, -0.17, 0.8), (0.013, 0.008, 0.013), white, 8, 6), blob(sc, (0.07, -0.18, 0.71), (0.013, 0.008, 0.013), white, 8, 6),
    ], (0, 0, 0.55), r)
    hc = (0, -0.01, 1.1)
    hat = mat("hat", "#f3e2b8")
    head = part(sc, "head", [
        blob(sc, hc, (0.25, 0.23, 0.23), skin, 20, 12),
        blob(sc, (0, 0.035, 1.16), (0.26, 0.235, 0.21), hair, 20, 12),
        blob(sc, (0.2, 0.0, 1.0), (0.06, 0.07, 0.1), hair, 12, 8), blob(sc, (-0.2, 0.0, 1.0), (0.06, 0.07, 0.1), hair, 12, 8),
        blob(sc, (0, 0.01, 1.3), (0.36, 0.36, 0.028), hat, 24, 6),
        blob(sc, (0, 0.01, 1.35), (0.19, 0.19, 0.1), hat, 20, 8),
        torus(sc, (0, 0.01, 1.31), 0.192, 0.016, mat("hat band", "#e98f7a"), maj=20, mn=6),
        blob(sc, (0.13, -0.12, 1.31), (0.035, 0.035, 0.03), mat("flower", "#f7f2e4"), 10, 6), blob(sc, (0.13, -0.15, 1.31), (0.015, 0.01, 0.015), mat("flower centre", "#f1c84b"), 8, 6),
        blob(sc, (0, -0.245, 1.07), (0.024, 0.016, 0.018), mat("nose", "#d99673"), 10, 6),
    ] + face(sc, hc, 0.232, 0.085, 0.005, 1, dark, white, blush, 0.026), (0, 0, 0.9), body)
    for nm, s in (("arm_L", 1), ("arm_R", -1)):
        part(sc, nm, [blob(sc, (s * 0.235, 0, 0.71), (0.06, 0.06, 0.12), top, 12, 8), blob(sc, (s * 0.24, -0.01, 0.58), (0.05, 0.05, 0.05), skin, 10, 8)], (s * 0.21, 0, 0.84), body)
    arm_r = bpy.data.objects["arm_R"]
    can_m = mat("can", "#7fb2d6", 0.5)
    part(sc, "can", [
        blob(sc, (-0.25, -0.12, 0.5), (0.085, 0.085, 0.08), can_m, 16, 10),
        cone(sc, (-0.25, -0.27, 0.55), 0.016, 0.01, 0.2, can_m, rot=(math.radians(-60), 0, 0)),
        blob(sc, (-0.25, -0.36, 0.61), (0.026, 0.012, 0.026), can_m, 10, 6, rot=(math.radians(-60), 0, 0)),
        torus(sc, (-0.25, -0.05, 0.58), 0.06, 0.011, can_m, rot=(0, math.radians(90), 0), maj=16, mn=6),
    ], (-0.24, -0.02, 0.58), arm_r)
    return r


def cat(sc):
    fur, cream, dark, white, blush, pink = mat("cat fur", "#9aa6b2"), mat("cat cream", "#eef0f2"), mat("ink", "#2a2c30", 0.4), mat("white", "#ffffff", 0.3), mat("blush", "#f2a29a"), mat("ear pink", "#f0b9b4")
    r = root(sc, "cat")
    body = part(sc, "body", [blob(sc, (0, 0.01, 0.1), (0.085, 0.1, 0.1), fur, 20, 12), blob(sc, (0, -0.05, 0.11), (0.055, 0.05, 0.075), cream, 16, 10), blob(sc, (0.035, -0.07, 0.02), (0.025, 0.035, 0.02), cream, 12, 8), blob(sc, (-0.035, -0.07, 0.02), (0.025, 0.035, 0.02), cream, 12, 8)], (0, 0, 0.1), r)
    hc = (0, -0.03, 0.225)
    pieces = [blob(sc, hc, (0.08, 0.072, 0.07), fur, 22, 12), blob(sc, (0, -0.085, 0.21), (0.035, 0.025, 0.025), cream, 14, 8), blob(sc, (0, -0.105, 0.218), (0.009, 0.006, 0.007), pink, 8, 6)]
    for s in (1, -1):
        pieces.append(cone(sc, (s * 0.045, -0.03, 0.29), 0.028, 0.0, 0.05, fur, 10, rot=(0, math.radians(s * -18), 0)))
        pieces.append(cone(sc, (s * 0.045, -0.036, 0.287), 0.016, 0.0, 0.035, pink, 8, rot=(0, math.radians(s * -18), 0)))
    head = part(sc, "head", pieces + face(sc, hc, 0.072, 0.03, 0.01, 1, dark, white, blush, 0.012), (0, -0.02, 0.18), body)
    part(sc, "tail", [blob(sc, (0.06, 0.1, 0.05), (0.02, 0.07, 0.02), fur, 12, 8, rot=(0, 0, math.radians(-40))), blob(sc, (0.1, 0.06, 0.06), (0.018, 0.018, 0.03), fur, 10, 6)], (0, 0.09, 0.04), body)
    return r


def bird(sc):
    blue, peach, dark, white, beak = mat("bird blue", "#6f9fd8"), mat("bird peach", "#f5c39b"), mat("ink", "#2a2c30", 0.4), mat("white", "#ffffff", 0.3), mat("beak", "#f0a64a", 0.5)
    r = root(sc, "bird")
    hc = (0, -0.035, 0.085)
    body = part(sc, "body", [
        blob(sc, (0, 0, 0.05), (0.04, 0.05, 0.038), blue, 16, 10),
        blob(sc, (0, -0.02, 0.043), (0.032, 0.03, 0.03), peach, 14, 8),
        blob(sc, hc, (0.03, 0.03, 0.03), blue, 16, 10),
        cone(sc, (0, -0.068, 0.083), 0.009, 0.0, 0.02, beak, 8, rot=(math.radians(90), 0, 0)),
        blob(sc, (0, 0.055, 0.06), (0.015, 0.03, 0.006), blue, 10, 6, rot=(math.radians(-25), 0, 0)),
        blob(sc, (0.012, -0.005, 0.008), (0.004, 0.004, 0.012), beak, 6, 4), blob(sc, (-0.012, -0.005, 0.008), (0.004, 0.004, 0.012), beak, 6, 4),
    ] + [blob(sc, (s * 0.018, -0.058, 0.093), (0.0055, 0.004, 0.0065), dark, 8, 6) for s in (1, -1)], (0, 0, 0.05), r)
    for nm, s in (("wing_L", 1), ("wing_R", -1)):
        part(sc, nm, [blob(sc, (s * 0.04, 0.005, 0.055), (0.012, 0.035, 0.025), blue, 12, 8, rot=(math.radians(-15), 0, 0))], (s * 0.035, -0.015, 0.068), body)
    return r


BUILD = {"dog": (dog, (0, 0, 0)), "neighbor": (neighbor, (0.8, 0, 0)), "cat": (cat, (-0.6, 0, 0)), "bird": (bird, (-0.95, 0, 0))}


def export_one(sc, name, r):
    os.makedirs(OUT, exist_ok=True)
    win = bpy.context.window
    prev = win.scene
    win.scene = sc
    try:
        for o in sc.objects:
            o.select_set(False)
        for o in [r] + list(r.children_recursive):
            o.select_set(True)
        bpy.context.view_layer.objects.active = r
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + ".glb"), export_format="GLB", use_selection=True, export_apply=True, export_yup=True, export_texcoords=False, export_normals=True, export_materials="EXPORT", export_vertex_color="ACTIVE", export_animations=False, export_extras=False)
    finally:
        win.scene = prev


def run(export=True):
    """Build every character (exporting each as it is built, while its part
    names are still plain), then rename and lay them out side by side."""
    sc = scene()
    roots = {}
    for name, (fn, at) in BUILD.items():
        PIVOT.clear()
        r = fn(sc)
        if export:
            export_one(sc, name, r)
        for o in [r] + list(r.children_recursive):
            o.name = name + "." + o.name
        r.location = at
        roots[name] = r
    return sc, roots
