"""geo_lib -- geometry, rig and skin helpers for the vinyl-toon character pipeline.

Everything here is built analytically.  Meshes are generated ring-by-ring along
a spine, so every vertex knows BY CONSTRUCTION which bones drive it: weights are
authored together with the geometry and there is no automatic weighting anywhere
in this pipeline.  That is the whole reason deformation is predictable -- a
limb bends the way the section list says it bends, and a bad bend is a data bug
with one obvious place to fix it, not a weight-paint hunt.

Conventions (Blender, Z-up):
    +Z  up
    -Y  the direction the character FACES
    +X  the character's LEFT

Every bone is rolled so its local +Z points along world -Y (forward).  The
consequence is uniform across the whole skeleton and worth memorising, because
all animation authoring depends on it:

    rotate about local X  ->  forward/back flexion   (positive = forward)
    rotate about local Y  ->  twist along the limb
    rotate about local Z  ->  sideways swing

glTF export turns this into Y-up with the character facing +Z, which is what the
three.js runtime expects.
"""
import bpy
import bmesh
import math
from mathutils import Vector, Matrix

TAU = math.pi * 2.0


# ----------------------------------------------------------------- materials

def material(name, color, roughness=0.65, metallic=0.0, emission=0.0):
    """A flat colour-ID material.  The runtime re-shades these as toon ramps, so
    only the base colour really travels -- roughness/metallic are here to make
    the Blender preview renders legible while authoring."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    r, g, b = color
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission:
        bsdf.inputs["Emission Color"].default_value = (r, g, b, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission
    mat.diffuse_color = (r, g, b, 1.0)   # workbench preview
    return mat


# ------------------------------------------------------------ mesh plumbing

def _new_obj(name, verts, faces, mat=None, smooth=True, recalc=True):
    """`recalc` runs bmesh's normal repair, which infers orientation from
    enclosed volume.  That works for a closed shape and GUESSES for an open one:
    an open swept tube (a bowl, a ring, a sleeve) can come out consistently
    INSIDE-OUT.  The visible symptom is brutal -- an inverted-hull outline then
    inflates inward and paints the whole object in outline colour -- so anything
    that already knows its winding should pass recalc=False."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()

    if recalc:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()

    for poly in me.polygons:
        poly.use_smooth = smooth

    obj = bpy.data.objects.new(name, me)
    if mat is not None:
        me.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    return obj


def _apply_weights(obj, vert_weights):
    """vert_weights: list parallel to obj.data.vertices, each a {bone: weight}."""
    groups = {}
    for i, w in enumerate(vert_weights):
        for bone, weight in w.items():
            if weight <= 0.0:
                continue
            g = groups.get(bone)
            if g is None:
                g = groups[bone] = obj.vertex_groups.new(name=bone)
            g.add([i], float(weight), 'REPLACE')


def _superellipse(k, seg, n):
    """Point on a superellipse of exponent n.  n=2 is a circle; larger n squares
    it off, which is what gives the limbs their soft-box vinyl read."""
    a = TAU * k / seg
    c, s = math.cos(a), math.sin(a)
    e = 2.0 / n
    return (math.copysign(abs(c) ** e, c), math.copysign(abs(s) ** e, s))


def _frames(points, up=None):
    """Parallel-transport frames along a polyline: returns (tangent, u, v) per
    point.  Parallel transport rather than a fixed up-vector because limbs bend
    through the vertical and a fixed up would flip the rings mid-tube.

    `up` pins the SEED so that v -- the axis `ry` scales -- starts aligned with
    it.  Without a seed the starting frame falls out of whichever world axis is
    least parallel to the first tangent, which is fine for a limb (where the
    cross-section is nearly round) and treacherous for anything else: a fountain
    wall authored as 0.30 radial by 0.44 tall came out 0.44 radial by 0.30 tall,
    and an arch swapped its thickness with its depth.  Pass `up` whenever rx and
    ry differ and you care which is which."""
    n = len(points)
    tangents = []
    for i in range(n):
        if i == 0:
            t = points[1] - points[0]
        elif i == n - 1:
            t = points[-1] - points[-2]
        else:
            t = (points[i + 1] - points[i - 1])
        if t.length < 1e-9:
            t = Vector((0, 0, 1))
        tangents.append(t.normalized())

    t0 = tangents[0]
    # seed frame: whichever world axis is least parallel to the first tangent
    seed = min((Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))),
               key=lambda a: abs(a.dot(t0)))
    u = (seed - t0 * seed.dot(t0)).normalized()
    if up is not None:
        # v starts along `up`; u is whatever completes the frame.  t0 x u == v.
        v0 = Vector(up)
        v0 = (v0 - t0 * v0.dot(t0))
        # ...UNLESS `up` IS THE SWEEP DIRECTION, in which case it cannot seed
        # anything and the answer is the unseeded frame above.
        #
        # The old fallback here was `Vector((0, 0, 1))`, and the case this
        # actually arises in is a VERTICAL sweep passed up=(0,0,1) -- the single
        # most natural thing to write, and the same vector again. `u` came out
        # (0,0,0) because mathutils normalizes a zero vector to itself rather
        # than raising, `v` with it, and every ring collapsed onto the spine:
        # 30 vertices and 20 faces of exactly zero area. Such an object still
        # exists, still joins, still exports, and draws NOTHING. It cost a rock
        # ridge, the outcrop's five shelves and part of the stone circle, all
        # of which had correct collision the whole time -- which is the worst
        # possible failure mode, because you can stand on them.
        # 1e-3, NOT 1e-9. `v0.length` here is the sine of the angle between
        # `up` and the sweep, and the tangent is normalized in float32 -- so a
        # perfectly parallel `up` leaves a residue of about 1.2e-7, which sails
        # past a 1e-9 test and then normalizes to the parallel direction again.
        # That is the first fix for this bug, and it did not work; the assert
        # below is what caught it.
        if v0.length > 1e-3:
            u = v0.normalized().cross(t0).normalized()
    # A DEGENERATE FRAME IS A BUILD FAILURE, NOT A SHRUG. Everything about the
    # collapsed-ring bug was silent: the object was created, joined, exported,
    # counted in the part total and drawn as nothing, while its collision --
    # authored separately from the same numbers -- worked perfectly. Nobody
    # finds that by looking at a build log. `normalized()` on a zero vector
    # returns a zero vector here, so this is the one place it can be caught.
    if u.length < 0.9:
        raise ValueError(f"degenerate sweep frame: tangent {tuple(t0)}, up {up}")
    frames = [(t0, u, t0.cross(u).normalized())]

    for i in range(1, n):
        prev_t, prev_u, _ = frames[-1]
        t = tangents[i]
        q = prev_t.rotation_difference(t)
        u = (q @ prev_u)
        u = (u - t * u.dot(t))
        u = u.normalized() if u.length > 1e-9 else prev_u
        frames.append((t, u, t.cross(u).normalized()))
    return frames


def tube(name, sections, seg=16, mat=None, squircle=2.0, smooth=True, up=None):
    """Build a swept tube and its skin weights in one pass.

    sections: list of dicts
        p  Vector    spine point
        r  float | (rx, ry)   ring radius; 0 collapses the ring to a pole vertex,
                              which is how a cap closes
        w  dict      bone -> weight, applied to every vertex on that ring
        n  float     optional per-ring squircle exponent (defaults to squircle)

    Because a ring is one weight dict, a joint is authored by placing several
    rings across it with blended weights -- see `limb()`.
    """
    pts = [Vector(s["p"]) for s in sections]
    frames = _frames(pts, up=up)

    verts, faces, vweights = [], [], []
    rings = []           # list of vertex-index lists (1 entry if it is a pole)

    for s, (t, u, v) in zip(sections, frames):
        r = s["r"]
        rx, ry = (r, r) if isinstance(r, (int, float)) else r
        p = Vector(s["p"])
        w = s.get("w") or {}          # architecture has no skeleton
        if max(rx, ry) < 1e-6:
            rings.append([len(verts)])
            verts.append(p)
            vweights.append(dict(w))
            continue
        n = s.get("n", squircle)
        idx = []
        for k in range(seg):
            cx, cy = _superellipse(k, seg, n)
            idx.append(len(verts))
            verts.append(p + u * (rx * cx) + v * (ry * cy))
            vweights.append(dict(w))
        rings.append(idx)

    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:                       # START pole -> ring: triangle fan
            # wound the opposite way round from the end cap: at the start of the
            # sweep "outward" is -t, at the end it is +t
            for k in range(seg):
                faces.append((a[0], b[(k + 1) % seg], b[k]))
        elif len(b) == 1:                     # ring -> END pole
            for k in range(seg):
                faces.append((a[k], a[(k + 1) % seg], b[0]))
        else:
            for k in range(seg):
                k2 = (k + 1) % seg
                faces.append((a[k], a[k2], b[k2], b[k]))

    # Winding above is outward BY CONSTRUCTION -- the frame keeps v = t x u, so
    # a side quad's normal works out to +u, the outward radial.  Nothing here
    # needs to be guessed, so do not let recalc guess.
    obj = _new_obj(name, verts, faces, mat=mat, smooth=smooth, recalc=False)
    _apply_weights(obj, vweights)
    return obj


def dome(sections, at="end", steps=3, height=None):
    """Close a section list with a hemispherical cap.  Returns a NEW list.

    The cap inherits the weights of the ring it grows from, which is correct:
    a fingertip belongs to the hand, a shoulder cap to the upper arm."""
    out = list(sections)
    if at in ("end", "both"):
        s, prev = out[-1], out[-2]
        t = (Vector(s["p"]) - Vector(prev["p"])).normalized()
        r = s["r"] if isinstance(s["r"], (int, float)) else sum(s["r"]) / 2.0
        h = r if height is None else height
        rx, ry = (s["r"], s["r"]) if isinstance(s["r"], (int, float)) else s["r"]
        for i in range(1, steps + 1):
            a = (math.pi / 2) * (i / steps)
            k = math.cos(a)
            out.append({"p": Vector(s["p"]) + t * (h * math.sin(a)),
                        "r": (rx * k, ry * k), "w": dict(s.get("w") or {}),
                        "n": s.get("n", 2.0)})
    if at in ("start", "both"):
        s, nxt = out[0], out[1]
        t = (Vector(s["p"]) - Vector(nxt["p"])).normalized()
        r = s["r"] if isinstance(s["r"], (int, float)) else sum(s["r"]) / 2.0
        h = r if height is None else height
        rx, ry = (s["r"], s["r"]) if isinstance(s["r"], (int, float)) else s["r"]
        head = []
        for i in range(steps, 0, -1):
            a = (math.pi / 2) * (i / steps)
            k = math.cos(a)
            head.append({"p": Vector(s["p"]) + t * (h * math.sin(a)),
                         "r": (rx * k, ry * k), "w": dict(s.get("w") or {}),
                         "n": s.get("n", 2.0)})
        out = head + out
    return out


def limb(joints, radii, blend=0.22, per_seg=3):
    """Section list for a chain of bones, with the joints already blended.

    joints : [(Vector, bone_name_of_the_segment_that_STARTS_here), ...] -- the
             last entry's bone name is ignored (it is the chain's tip).
    radii  : one radius (float or (rx,ry)) per joint, lerped along each segment.
    blend  : fraction of the shorter adjacent segment over which two bones share
             influence.  This is the knob that decides whether an elbow creases
             or balloons.

    Rings are placed densely across each joint so the weight ramp has somewhere
    to live; a joint with no rings across it can only ever bend as a crease.
    """
    def rad_at(i, t):
        a, b = radii[i], radii[i + 1]
        a = (a, a) if isinstance(a, (int, float)) else a
        b = (b, b) if isinstance(b, (int, float)) else b
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

    n_seg = len(joints) - 1
    out = []
    for i in range(n_seg):
        p0, bone = Vector(joints[i][0]), joints[i][1]
        p1 = Vector(joints[i + 1][0])
        nxt = joints[i + 1][1] if i + 1 < n_seg else None
        prv = joints[i - 1][1] if i > 0 else None

        stops = [j / per_seg for j in range(per_seg + 1)]
        if nxt:
            stops += [1.0 - blend, 1.0 - blend * 0.5]
        if prv:
            stops += [blend * 0.5, blend]
        stops = sorted(set(round(s, 4) for s in stops if 0.0 <= s <= 1.0))
        if i > 0:
            stops = [s for s in stops if s > 1e-6]   # ring already placed

        for t in stops:
            w = {bone: 1.0}
            if nxt and t > 1.0 - blend:
                k = (t - (1.0 - blend)) / blend          # 0 -> 1 across the joint
                w = {bone: 1.0 - 0.5 * k, nxt: 0.5 * k}
            elif prv and t < blend:
                k = t / blend                            # 0 -> 1 leaving the joint
                w = {bone: 0.5 + 0.5 * k, prv: 0.5 - 0.5 * k}
            out.append({"p": p0 + (p1 - p0) * t, "r": rad_at(i, t), "w": w})
    return out


def blob(name, center, size, bone, mat=None, seg=20, rings=12, squircle=2.0):
    """A superellipsoid -- the workhorse for heads, hands, shoes and pauldrons.
    Rigid-bound to one bone, which is exactly right for a vinyl-toy read."""
    cx, cy, cz = Vector(center)
    sx, sy, sz = size
    verts, faces, vw = [], [], []
    w = {} if bone is None else ({bone: 1.0} if isinstance(bone, str) else dict(bone))

    ring_idx = []
    for i in range(rings + 1):
        phi = math.pi * i / rings
        zc = math.cos(phi)
        rc = math.sin(phi)
        e = 2.0 / squircle
        zc = math.copysign(abs(zc) ** e, zc)
        rc = abs(rc) ** e
        if i == 0 or i == rings:
            ring_idx.append([len(verts)])
            verts.append(Vector((cx, cy, cz + sz * zc)))
            vw.append(dict(w))
            continue
        idx = []
        for k in range(seg):
            ux, uy = _superellipse(k, seg, squircle)
            idx.append(len(verts))
            verts.append(Vector((cx + sx * rc * ux, cy + sy * rc * uy, cz + sz * zc)))
            vw.append(dict(w))
        ring_idx.append(idx)

    for a, b in zip(ring_idx, ring_idx[1:]):
        if len(a) == 1:
            for k in range(seg):
                faces.append((a[0], b[k], b[(k + 1) % seg]))
        elif len(b) == 1:
            for k in range(seg):
                faces.append((a[k], a[(k + 1) % seg], b[0]))
        else:
            for k in range(seg):
                k2 = (k + 1) % seg
                faces.append((a[k], a[k2], b[k2], b[k]))

    obj = _new_obj(name, verts, faces, mat=mat)
    _apply_weights(obj, vw)
    return obj


def rounded_box(name, center, size, bevel, bone, mat=None, segments=3, smooth=True):
    """A bevelled cube.  Hard-surface props (sword teeth, belt buckles) read
    better as a bevelled box than as a superellipsoid.

    `size` is SEMI-axes, matching blob() and tube() radii.  It is worth being
    pedantic about: the first sword had its guard built from full extents and
    the crossbars came out half as long as the loop they were meant to close, so
    the guard rendered as four disconnected floating sticks."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
    bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                    offset=bevel, segments=segments, profile=0.5,
                    affect='EDGES', clamp_overlap=True)
    for v in bm.verts:
        v.co += Vector(center)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = smooth
    obj = bpy.data.objects.new(name, me)
    if mat is not None:
        me.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    w = {} if bone is None else ({bone: 1.0} if isinstance(bone, str) else dict(bone))
    _apply_weights(obj, [w] * len(me.vertices))
    return obj


def set_uvs(obj, uv_per_vertex, name="UVMap"):
    """Attach a UV layer from a per-VERTEX uv list (loops inherit by index).

    ACTIVE AND ACTIVE_RENDER both get set. A texture node with nothing wired to
    its Vector input resolves to the mesh's render UV layer, and the glTF
    exporter follows the same rule -- so a layer that exists but is not flagged
    exports no TEXCOORD_0 at all, and the texture arrives in the file attached
    to geometry that has no way to sample it.
    """
    me = obj.data
    uvl = me.uv_layers.get(name) or me.uv_layers.new(name=name)
    for li, loop in enumerate(me.loops):
        uvl.data[li].uv = uv_per_vertex[loop.vertex_index]
    me.uv_layers.active = uvl
    uvl.active_render = True
    # `export_apply=True` exports the DEPSGRAPH-EVALUATED mesh, and writing UVs
    # straight into mesh data does not on its own mark that copy dirty -- so a
    # layer added after a join was present in Blender and absent from the file.
    me.update()
    obj.update_tag()
    bpy.context.view_layer.update()
    return uvl


def set_vertex_colors(obj, rgb_per_vertex, name="Col"):
    """Write a per-vertex colour layer, for blending materials that cannot be
    blended any other way.

    WHY THIS EXISTS. The meadow's ground assigned one of three materials PER
    FACE, so the grass/path transition could never be finer than a 1.6 m quad --
    an audit's description was "large axis-aligned rectangles of different tint
    in effectively every outdoor frame", and it was right, and no amount of
    noise on the threshold fixes it because the threshold is evaluated once per
    face. A vertex colour interpolates ACROSS the face, so the boundary stops
    being made of quads at all.

    glTF carries COLOR_0 and three.js multiplies it into the material when
    `vertexColors` is on, so this survives the export intact.
    """
    me = obj.data
    layer = me.color_attributes.get(name)
    if layer is None:
        layer = me.color_attributes.new(name=name, type='FLOAT_COLOR',
                                        domain='POINT')
    for i, c in enumerate(rgb_per_vertex):
        layer.data[i].color = (c[0], c[1], c[2], 1.0)
    me.color_attributes.active_color = layer
    me.color_attributes.render_color_index = 0
    me.update()
    return layer


def box_uvs(obj, tile=2.0, name="UVMap"):
    """Per-face planar projection along each face's dominant normal axis.

    Architecture here is bevelled boxes at arbitrary yaws, which have no natural
    unwrap -- but every face is very nearly axis-aligned, so projecting each one
    down its dominant axis is exact for the flat parts and only slightly sheared
    on the bevels, which are a few millimetres wide and carry an outline anyway.

    Loop-level rather than vertex-level, because a shared corner vertex belongs
    to faces on different axes and needs a different UV in each.
    """
    me = obj.data
    uvl = me.uv_layers.get(name) or me.uv_layers.new(name=name)
    for poly in me.polygons:
        n = poly.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if az >= ax and az >= ay:
                u, v = co.x, co.y          # floors and roofs, from above
            elif ax >= ay:
                u, v = co.y, co.z          # walls facing +/-X
            else:
                u, v = co.x, co.z          # walls facing +/-Y
            uvl.data[li].uv = (u / tile, v / tile)
    me.uv_layers.active = uvl
    uvl.active_render = True
    me.update()
    obj.update_tag()
    bpy.context.view_layer.update()
    return uvl


def image_material(name, image, roughness=0.7, preview=(0.8, 0.8, 0.8),
                   uv_layer="UVMap", vertex_color=None):
    """A material whose base colour comes from an image.

    `vertex_color` names a colour attribute to MULTIPLY the texture by. It has
    to be wired into the node tree and not merely present on the mesh: the glTF
    exporter decides what to emit from the graph, and with the attribute unused
    it says so plainly -- "The active Vertex Color will not be exported, as it
    is not used in the node tree of the material" -- and ships geometry with no
    COLOR_0. Which, for a ground whose entire grass-to-path blend lives in that
    attribute, is a field of flat mottled white.
    """
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = 'Linear'
    # AN EXPLICIT UV MAP NODE. With nothing wired to the texture's Vector input
    # the sampling UVs are implicit, and the glTF exporter then declined to emit
    # TEXCOORD_0 at all -- the image shipped inside the file attached to geometry
    # with no way to sample it, and the ground rendered flat grey. Naming the
    # layer here makes the dependency something the exporter can see.
    uvn = mat.node_tree.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = uv_layer
    mat.node_tree.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    # links.new(FROM output, TO input) -- reversed, it silently creates nothing
    # and the texture never reaches the shader
    if vertex_color:
        att = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        att.layer_name = vertex_color
        mix = mat.node_tree.nodes.new("ShaderNodeMix")
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs["Factor"].default_value = 1.0
        mat.node_tree.links.new(tex.outputs["Color"], mix.inputs[6])
        mat.node_tree.links.new(att.outputs["Color"], mix.inputs[7])
        mat.node_tree.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    else:
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = (*preview, 1.0)
    return mat


def transform(obj, rotate=None, around=None, translate=None, scale=None, quat=None,
              matrix=None):
    """Post-hoc placement.  Applied to mesh data so the object transform stays
    identity -- the armature bind expects parts to live in world space."""
    me = obj.data
    if matrix is not None:
        # a full 4x4 is how you place something in ANOTHER object's frame --
        # e.g. a prop in the local space of the hand bone that holds it
        for v in me.vertices:
            v.co = matrix @ v.co
        return obj
    piv = Vector(around) if around else Vector((0, 0, 0))
    for v in me.vertices:
        p = Vector(v.co)
        if scale:
            p = piv + Vector(((p.x - piv.x) * scale[0],
                              (p.y - piv.y) * scale[1],
                              (p.z - piv.z) * scale[2]))
        if rotate:
            m = Matrix.Rotation(math.radians(rotate[0]), 3, 'X') @ \
                Matrix.Rotation(math.radians(rotate[1]), 3, 'Y') @ \
                Matrix.Rotation(math.radians(rotate[2]), 3, 'Z')
            p = piv + m @ (p - piv)
        if quat is not None:
            # a quaternion is the honest way to aim a prop along a measured
            # direction; euler triples are for poses a human is choosing
            p = piv + quat.to_matrix() @ (p - piv)
        if translate:
            p = p + Vector(translate)
        v.co = p
    return obj


def mirror(obj, name):
    """Mirror a part across X, renaming .L vertex groups to .R (and back)."""
    me = obj.data.copy()
    dup = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(dup)
    for v in me.vertices:
        v.co.x = -v.co.x
    me.flip_normals()
    for vg in obj.vertex_groups:
        flipped = vg.name.replace(".L", ".R") if vg.name.endswith(".L") else \
                  vg.name.replace(".R", ".L") if vg.name.endswith(".R") else vg.name
        dup.vertex_groups.new(name=flipped)
    for i, v in enumerate(me.vertices):
        for g in obj.data.vertices[i].groups:
            src = obj.vertex_groups[g.group].name
            dst = src.replace(".L", ".R") if src.endswith(".L") else \
                  src.replace(".R", ".L") if src.endswith(".R") else src
            dup.vertex_groups[dst].add([i], g.weight, 'REPLACE')
    return dup


# ------------------------------------------------------------------- rigging

def build_armature(name, spec, forward=Vector((0, -1, 0))):
    """spec: [(bone, head, tail, parent|None, connected_bool[, roll_vec]), ...]

    Every roll is aligned to `forward`, which is what makes "+X rotation bends
    forward" true for every bone in the skeleton.  Animation code depends on
    this; do not create bones any other way."""
    arm = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, arm)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')

    made = {}
    for entry in spec:
        bone, head, tail, parent, connected = entry[:5]
        eb = arm.edit_bones.new(bone)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        # An optional 6th field overrides the roll target for this bone.  Radial
        # parts -- a ring of spines around a body -- need their own hinge each,
        # or a single rotation swings them all the same way in world space
        # instead of fanning them outward.
        eb.align_roll(Vector(entry[5]) if len(entry) > 5 else Vector(forward))
        made[bone] = eb
    for entry in spec:
        bone, parent, connected = entry[0], entry[3], entry[4]
        if parent:
            made[bone].parent = made[parent]
            made[bone].use_connect = bool(connected)

    bpy.ops.object.mode_set(mode='OBJECT')
    return obj


def join(parts, name):
    """Join objects into one mesh, preserving material slots and vertex groups.

    One mesh with many material slots exports as one glTF mesh with one
    primitive per material, which is what keeps the runtime's draw call count
    proportional to the PALETTE rather than to the number of props."""
    parts = [p for p in parts if p.name in bpy.data.objects]
    if not parts:
        return None
    for o in bpy.data.objects:
        o.select_set(False)
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    return obj


def check_weights(obj, sources=None):
    """Every vertex on a skinned mesh MUST have a bone.  Refuse to ship one that
    does not.

    An unweighted vertex does not error, does not warn, and does not look wrong
    in the bind pose -- it simply stays behind in world space the moment the
    character animates.  That shipped as "the hair is detached from his head
    when he moves": the fringe, side locks and spikes were all built from
    section lists with no `w` key, so three whole hair pieces stayed frozen at
    the origin pose while the skull turned.  Cheap to check, invisible to debug.
    """
    orphans = [i for i, v in enumerate(obj.data.vertices)
               if not any(g.weight > 0.0 for g in v.groups)]
    if not orphans:
        return
    hint = ""
    if sources:
        # name the parts whose vertices fall in the orphaned range
        lo, hi = min(orphans), max(orphans)
        hint = f"  (vertex index range {lo}..{hi} of {len(obj.data.vertices)})"
    raise RuntimeError(
        f"{len(orphans)} of {len(obj.data.vertices)} vertices on '{obj.name}' "
        f"have no bone weight; they will not follow the skeleton.{hint}\n"
        f"Every tube() section needs a 'w' dict, and blob()/rounded_box() need "
        f"a bone argument.")


def bind(parts, arm_obj, name="Body"):
    """Join the parts into one mesh and bind it to the armature."""
    body = join(parts, name)
    check_weights(body, sources=parts)

    mod = body.modifiers.new("Armature", 'ARMATURE')
    mod.object = arm_obj
    body.parent = arm_obj
    return body


# ----------------------------------------------------------------- animation

def action(arm_obj, name):
    if arm_obj.animation_data is None:
        arm_obj.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm_obj.animation_data.action = act
    if hasattr(arm_obj.animation_data, "action_slot"):
        # Blender 4.4+ slotted actions: the exporter needs a bound slot
        if act.slots:
            arm_obj.animation_data.action_slot = act.slots[0]
        else:
            arm_obj.animation_data.action_slot = act.slots.new('OBJECT', arm_obj.name)
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = 'XYZ'
    return act


def key(arm_obj, frame, pose, loc=None, scale=None):
    """Key a pose.  `pose` maps bone -> (rx, ry, rz) in DEGREES, in the bone's
    local frame (see the module docstring: +X is forward flexion everywhere).
    `loc` maps bone -> (x, y, z) offset in bone-local units, for root motion."""
    for pb in arm_obj.pose.bones:
        if pb.name in pose:
            pb.rotation_euler = [math.radians(a) for a in pose[pb.name]]
        if loc and pb.name in loc:
            pb.location = loc[pb.name]
        if scale and pb.name in scale:
            v = scale[pb.name]
            pb.scale = (v, v, v) if isinstance(v, (int, float)) else v
    keys = set(pose) | set(loc or {}) | set(scale or {})
    for bone in keys:
        pb = arm_obj.pose.bones.get(bone)
        if pb is None:
            continue
        if bone in pose:
            pb.keyframe_insert("rotation_euler", frame=frame)
        if loc and bone in loc:
            pb.keyframe_insert("location", frame=frame)
        # BONE SCALE is how a creature's silhouette changes -- a Bellow
        # inflating is a scale key, not a modelled shape
        if scale and bone in scale:
            pb.keyframe_insert("scale", frame=frame)


def rest(arm_obj):
    for pb in arm_obj.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)


def fcurves(act):
    """Blender 4.4+ moved F-curves out of `action.fcurves` and into
    layer/strip/channelbag, so reach them the long way when the flat list is
    gone.  Both spellings are handled because this pipeline should survive a
    Blender upgrade without an archaeology session."""
    flat = getattr(act, "fcurves", None)
    if flat is not None:
        return list(flat)
    out = []
    for layer in getattr(act, "layers", []):
        for strip in getattr(layer, "strips", []):
            bags = getattr(strip, "channelbags", None)
            if bags is None:
                continue
            for cb in bags:
                out.extend(cb.fcurves)
    return out


def interp(act, mode='BEZIER'):
    for fc in fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = mode


# -------------------------------------------------------------------- output

def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures,
                  bpy.data.actions):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def verify_glb(path, animations=None, images=None):
    """Read back the GLB that was just written and check it contains what the
    build thinks it does.

    Exporting is the one step whose result nothing downstream re-derives, so a
    silent failure there ships.  This one has bitten twice: once when a stray
    preview ground plane rode along inside the character, and once when a
    diagnostic cleared the armature's animation data and every clip vanished --
    which made the export depend on whether --render was passed.  Cheap to
    verify, expensive to notice by eye.
    """
    import json
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"glTF":
        raise RuntimeError(f"{path} is not a GLB")
    ln = int.from_bytes(data[12:16], "little")
    js = json.loads(data[20:20 + ln].decode("utf-8"))

    got = [a.get("name", "?") for a in js.get("animations", [])]
    if animations is not None:
        missing = [n for n in animations if n not in got]
        if missing:
            raise RuntimeError(
                f"{path}: missing animations {missing}; exported {got or 'NONE'}")
    if images is not None and len(js.get("images", [])) < images:
        raise RuntimeError(
            f"{path}: expected >= {images} image(s), got "
            f"{len(js.get('images', []))}")
    return {"animations": got,
            "images": len(js.get("images", [])),
            "meshes": len(js.get("meshes", [])),
            "nodes": len(js.get("nodes", []))}


def export_glb(path, arm_obj=None):
    """Export the rig and everything parented to it -- AND NOTHING ELSE.

    Exporting the whole scene once shipped the preview ground plane and camera
    inside hero.glb; in the browser that plane landed coplanar with the game's
    own ground and the two z-fought into a blocky mess that looked exactly like
    shadow acne.  Scoping the export to the rig makes the preview props free.
    """
    import os
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    use_selection = False
    if arm_obj is not None:
        arm_obj.select_set(True)
        for child in arm_obj.children_recursive:
            child.select_set(True)
        bpy.context.view_layer.objects.active = arm_obj
        use_selection = True
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=use_selection,
        export_apply=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_nla_strips=False,
        export_bake_animation=False,
        export_force_sampling=True,
        export_optimize_animation_size=False,
        export_yup=True,
        export_skins=True,
        export_materials='EXPORT',
        export_texcoords=True,
        export_normals=True,
    )
    return path
