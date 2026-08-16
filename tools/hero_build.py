"""hero_build -- the style-test hero: a chunky vinyl-toon JRPG protagonist.

This is the CHARACTER PROBE.  The open question for this project was whether a
hand-scripted Blender pipeline can produce a stylised humanoid good enough to
carry a Kingdom Hearts-shaped game, so this file answers it end to end: forms,
skeleton, analytic skin weights, three authored animations, and a GLB the
three.js runtime loads.  Nothing here is generated or auto-weighted.

PROPORTIONS (the style call: vinyl-toy forms, ~5.4 heads)
    total height        1.74 m with hair
    head                0.33 m -- deliberately oversized
    shoulder width      0.39 m -- broad, to read at play distance
    hands and shoes     oversized; they carry the silhouette when the character
                        is 6 m from a third-person camera

THE FACE IS TWO INTERSECTING ELLIPSOIDS.  The hair is a slightly larger blob
pushed BACK in +Y; the head pokes out of its front.  The hairline is therefore
the intersection curve of the two surfaces -- it is never modelled, and it stays
correct for any head shape you dial in.  That trick is the reason this file has
no hand-authored hairline geometry.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/hero_build.py -- \
      --out public/assets/hero.glb --render docs/qa/hero
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_lib as K
import face_tex

TAU = math.tau
FACE_TEX = [None]          # filled in by main(), read by build_face()
HEAD_W = {"head": 1.0}     # every hair strand rides the head bone


# ------------------------------------------------------------------ palette
#
# Flat colour IDs.  The runtime re-shades every one of these as a toon ramp, so
# these values are the ramp's MIDTONE, not a final pixel colour.  Keep them
# saturated: a toon ramp darkens the shadow band hard, and desaturated midtones
# turn to mud once banded.

C = {
    "skin":    (0.98, 0.76, 0.62),
    # darker than instinct: a mid brown runs blond once the toon ramp lifts it
    "hair":    (0.34, 0.17, 0.09),
    "hair_lo": (0.24, 0.11, 0.06),
    "lash":    (0.11, 0.08, 0.11),
    "jacket":  (0.13, 0.15, 0.22),
    "trim":    (0.82, 0.17, 0.20),
    "pants":   (0.20, 0.26, 0.40),
    "glove":   (0.94, 0.94, 0.91),
    "shoe":    (0.97, 0.79, 0.22),
    "sole":    (0.35, 0.30, 0.26),
    "eye":     (0.99, 0.99, 0.99),
    "iris":    (0.15, 0.52, 0.86),
    "pupil":   (0.08, 0.07, 0.10),
    "metal":   (0.78, 0.82, 0.88),
    "gold":    (0.93, 0.72, 0.24),
}
M = {}


# ------------------------------------------------------------------- joints
#
# One dictionary, consulted by both the mesh and the rig.  This is the single
# source of truth for the character's proportions -- change a number here and
# the geometry AND the skeleton move together, which is the whole point of
# building the two from shared data.

J = {
    "root":     Vector((0.000,  0.000, 0.000)),
    "hips":     Vector((0.000,  0.000, 0.930)),
    "spine":    Vector((0.000,  0.000, 1.045)),
    "chest":    Vector((0.000,  0.000, 1.170)),
    "neck":     Vector((0.000,  0.000, 1.310)),
    "head":     Vector((0.000,  0.000, 1.370)),
    "headtop":  Vector((0.000,  0.000, 1.720)),

    "shldr.L":  Vector((0.050,  0.000, 1.250)),
    "arm.L":    Vector((0.166,  0.000, 1.232)),
    "elbow.L":  Vector((0.268,  0.000, 1.038)),
    "wrist.L":  Vector((0.340,  0.000, 0.856)),
    "handtip.L": Vector((0.378, 0.000, 0.764)),

    "hip.L":    Vector((0.105,  0.000, 0.880)),
    "knee.L":   Vector((0.112,  0.000, 0.470)),
    "ankle.L":  Vector((0.118,  0.000, 0.118)),
    "toe.L":    Vector((0.118, -0.170, 0.048)),
}

# Head 0.35 of a 1.72 character -- just under 5 heads.  The first pass built a
# 5.3-head figure on 0.56 m shoulders and the head read as a pinhead: what sells
# a chunky style is the RATIO of shoulder span to head width, not head height in
# isolation.  0.52 / 0.33 = 1.57 is the number that made it click.
HEAD_C = Vector((0.000, -0.006, 1.545))
HEAD_S = (0.166, 0.172, 0.176)
HAIR_C = Vector((0.000,  0.030, 1.566))
HAIR_S = (0.180, 0.176, 0.190)
JAW_C = HEAD_C + Vector((0, -0.030, -0.068))
JAW_S = (0.134, 0.142, 0.094)

# the face decal: an ellipse in (x, z) that conforms to the skull
FACE_C = Vector((0.000, 0.000, 1.558))
FACE_R = (0.150, 0.142)


def _mir(v):
    return Vector((-v.x, v.y, v.z))


# --------------------------------------------------------------------- rig

def build_rig():
    spec = [
        ("root",  J["root"],  J["root"] + Vector((0, 0, 0.18)), None,    False),
        ("hips",  J["hips"],  J["spine"],   "root",  False),
        ("spine", J["spine"], J["chest"],   "hips",  True),
        ("chest", J["chest"], J["neck"],    "spine", True),
        ("neck",  J["neck"],  J["head"],    "chest", True),
        ("head",  J["head"],  J["headtop"], "neck",  True),
    ]
    for s in ("L", "R"):
        f = (lambda v: v) if s == "L" else _mir
        spec += [
            (f"shoulder.{s}", f(J["shldr.L"]), f(J["arm.L"]),     "chest",         False),
            (f"upperarm.{s}", f(J["arm.L"]),   f(J["elbow.L"]),   f"shoulder.{s}", True),
            (f"forearm.{s}",  f(J["elbow.L"]), f(J["wrist.L"]),   f"upperarm.{s}", True),
            (f"hand.{s}",     f(J["wrist.L"]), f(J["handtip.L"]), f"forearm.{s}",  True),
            (f"thigh.{s}",    f(J["hip.L"]),   f(J["knee.L"]),    "hips",          False),
            (f"shin.{s}",     f(J["knee.L"]),  f(J["ankle.L"]),   f"thigh.{s}",    True),
            (f"foot.{s}",     f(J["ankle.L"]), f(J["toe.L"]),     f"shin.{s}",     True),
        ]
    return K.build_armature("Hero_Rig", spec)


# -------------------------------------------------------------------- forms

def build_torso():
    """Jacket, neck, belt, collar.  The torso narrows at the waist and flares at
    the chest -- the classic JRPG-hero wedge, exaggerated because a toon ramp
    flattens form and the silhouette has to do the work."""
    parts = []

    sec = K.limb(
        joints=[(Vector((0, 0, 0.930)), "hips"),
                (Vector((0, 0, 1.020)), "spine"),
                (Vector((0, 0, 1.170)), "chest"),
                (Vector((0, 0, 1.268)), "chest")],
        radii=[(0.142, 0.110), (0.130, 0.100), (0.188, 0.130), (0.160, 0.116)],
        blend=0.30, per_seg=3)
    for s in sec:
        s["n"] = 2.7                              # soft box, not a cylinder
    sec = K.dome(sec, at="both", steps=3, height=0.10)
    parts.append(K.tube("jacket", sec, seg=20, mat=M["jacket"], squircle=2.7))

    # pelvis: the mass the legs grow out of.  Without it the thigh tubes read as
    # two pipes hanging off a torso, which is exactly how the first build looked.
    # The jacket ends ON TOP of it and the belt hides the seam.
    parts.append(K.blob("pelvis", Vector((0, 0, 0.885)), (0.158, 0.116, 0.118),
                        "hips", M["pants"], seg=20, rings=12, squircle=2.6))

    neck = K.limb(joints=[(Vector((0, -0.004, 1.195)), "chest"),
                          (Vector((0, -0.004, 1.290)), "neck"),
                          (Vector((0, -0.004, 1.390)), "neck")],
                  radii=[0.078, 0.072, 0.076], blend=0.30, per_seg=2)
    parts.append(K.tube("neck", neck, seg=14, mat=M["skin"]))

    collar = K.limb(joints=[(Vector((0, 0, 1.222)), "chest"),
                            (Vector((0, 0, 1.296)), "chest")],
                    radii=[(0.124, 0.104), (0.100, 0.090)], per_seg=2)
    for s in collar:
        s["n"] = 2.6
    parts.append(K.tube("collar", collar, seg=18, mat=M["trim"], squircle=2.6))

    belt = K.limb(joints=[(Vector((0, 0, 0.928)), "hips"),
                          (Vector((0, 0, 0.998)), "hips")],
                  radii=[(0.160, 0.126), (0.158, 0.124)], per_seg=1)
    for s in belt:
        s["n"] = 2.7
    parts.append(K.tube("belt", belt, seg=20, mat=M["trim"], squircle=2.7))

    parts.append(K.rounded_box("buckle", (0, -0.128, 0.963),
                               (0.020, 0.007, 0.016), 0.006, "hips", M["gold"]))
    return parts


def build_head():
    # Resolution is higher here than anywhere else on the body for one reason:
    # the hairline is the INTERSECTION of the skull and hair surfaces, and a
    # coarse mesh turns that curve into a visible staircase across the forehead.
    parts = [K.blob("head", HEAD_C, HEAD_S, "head", M["skin"], seg=32, rings=20,
                    squircle=2.3)]

    # jaw: a second blob low and forward, so the chin has a definite point
    parts.append(K.blob("jaw", JAW_C, JAW_S, "head", M["skin"],
                        seg=26, rings=16, squircle=2.5))

    parts.append(K.blob("hair", HAIR_C, HAIR_S, "head", M["hair"], seg=32,
                        rings=20, squircle=2.2))
    parts += build_fringe()
    parts += build_hair_spikes()
    parts += build_sidelocks()
    parts += build_face()
    return parts


def _hair_point(az, el, k=0.95):
    """A point on the hair shell, from azimuth (0 = back of head, 180 = face)
    and elevation in degrees."""
    a, e = math.radians(az), math.radians(el)
    n = Vector((math.cos(e) * math.sin(a), math.cos(e) * math.cos(a), math.sin(e)))
    return HAIR_C + Vector((HAIR_S[0] * n.x, HAIR_S[1] * n.y,
                            HAIR_S[2] * n.z)) * k, n.normalized()


def build_fringe():
    """Bangs over the forehead.

    This is the single biggest thing the first head was missing.  Without a
    fringe the hair is a smooth cap and the character reads as bald-with-spikes;
    the fringe is what makes the silhouette say 'hair'.  Each strand is a flat
    tapered lock -- WIDE across the brow and THIN front-to-back, which is why the
    tube needs an explicit `up`."""
    out = []
    #   azimuth  elev   len    width  depth  outward
    plan = [
        (136.0, 21.0, 0.074, 0.058, 0.030, 0.38),
        (153.0, 31.0, 0.098, 0.066, 0.032, 0.30),
        (168.0, 39.0, 0.120, 0.072, 0.034, 0.23),
        (180.0, 44.0, 0.130, 0.074, 0.034, 0.18),
        (192.0, 39.0, 0.120, 0.072, 0.034, 0.23),
        (207.0, 31.0, 0.096, 0.066, 0.032, 0.30),
        (224.0, 21.0, 0.072, 0.058, 0.030, 0.38),
    ]
    for i, (az, el, ln, w, dp, outward) in enumerate(plan):
        base, n = _hair_point(az, el, 0.94)
        # down, a little forward, plus a share of the surface normal so strands
        # splay instead of all hanging in one plane
        d = (Vector((0, -0.30, -1.0)).normalized() * (1.0 - outward)
             + n * outward).normalized()
        sec = [
            {"p": base + d * -0.02, "r": (w, dp), "w": HEAD_W, "n": 2.2},
            {"p": base + d * (ln * 0.55), "r": (w * 0.86, dp * 0.9), "w": HEAD_W, "n": 2.2},
            {"p": base + d * (ln * 0.88) + Vector((0, -0.012, 0)),
             "r": (w * 0.5, dp * 0.6), "w": HEAD_W, "n": 2.2},
            {"p": base + d * ln + Vector((0, -0.020, 0)), "r": 0.0, "w": HEAD_W, "n": 2.2},
        ]
        out.append(K.tube(f"fringe{i}", sec, seg=12, mat=M["hair"],
                          squircle=2.2, up=(0, 1, 0)))
    return out


def build_sidelocks():
    """Two locks in front of the ears.  They frame the face and stop the head
    reading as a sphere with a hat on."""
    out = []
    for i, az in enumerate((113.0, -113.0)):
        base, n = _hair_point(az, 6.0, 0.96)
        d = (Vector((0, -0.14, -1.0)).normalized() * 0.78 + n * 0.22).normalized()
        sec = [
            {"p": base + d * -0.02, "r": (0.036, 0.048), "w": HEAD_W, "n": 2.3},
            {"p": base + d * 0.065, "r": (0.030, 0.040), "w": HEAD_W, "n": 2.3},
            {"p": base + d * 0.115, "r": 0.0, "w": HEAD_W, "n": 2.3},
        ]
        out.append(K.tube(f"sidelock{i}", sec, seg=10, mat=M["hair"],
                          squircle=2.3, up=(0, 1, 0)))
    return out


def build_hair_spikes():
    """Spikes as swept tubes off the hair blob.

    Six identical cones read as a jester's hat.  What makes hair look like hair
    is VARIETY and CURVE: every spike gets its own length, weight and bend, and
    each is a four-section arc rather than a straight cone, so the tips flick
    instead of ending in a point aimed at nothing.
    """
    spikes = []
    # azimuth is measured from +Y, so 0 is the BACK of the head and 180 the face
    #   azimuth  elev   len    base_r  bend  sag
    plan = [
        (   0.0,  64.0, 0.250, 0.068,  0.90, 0.30),
        (  40.0,  50.0, 0.290, 0.074,  0.95, 0.34),
        ( -40.0,  50.0, 0.275, 0.070,  0.95, 0.30),
        (  74.0,  34.0, 0.230, 0.060,  0.88, 0.26),
        ( -74.0,  34.0, 0.245, 0.062,  0.88, 0.30),
        ( 118.0,  20.0, 0.190, 0.052,  0.82, 0.22),
        (-118.0,  20.0, 0.180, 0.050,  0.82, 0.22),
        (  22.0,  78.0, 0.215, 0.056,  1.00, 0.36),
    ]
    drift = Vector((0, 0.62, 0.55)).normalized()   # sweep back and up
    for i, (az, el, ln, br, bend, sag) in enumerate(plan):
        base, n = _hair_point(az, el, 0.86)

        def at(t, base=base, n=n, ln=ln, bend=bend, sag=sag):
            return (base + n * (ln * t)
                    + drift * (ln * bend * t * t)
                    - Vector((0, 0, ln * sag * t * t * 0.4)))

        sec = [{"p": at(0.00), "r": (br, br * 0.86), "w": HEAD_W, "n": 2.4},
               {"p": at(0.42), "r": (br * 0.66, br * 0.56), "w": HEAD_W, "n": 2.4},
               {"p": at(0.76), "r": (br * 0.32, br * 0.27), "w": HEAD_W, "n": 2.4},
               {"p": at(1.00), "r": 0.0, "w": HEAD_W, "n": 2.4}]
        spikes.append(K.tube(f"spike{i}", sec, seg=10, mat=M["hair"],
                             squircle=2.4, up=(0, 0, 1)))
    return spikes


def _skull_front(x, z):
    """Frontmost point of the skull at (x, z), and its outward normal.

    The head and jaw are superellipsoids, so this is solved rather than
    raycast: |dx/sx|^n + |dy/sy|^n + |dz/sz|^n = 1 gives y directly, and the
    gradient of that same expression gives the normal.  Whichever of the two
    blobs is further forward wins.
    """
    best = None
    for c, sz, n in ((HEAD_C, HEAD_S, 2.3), (JAW_C, JAW_S, 2.5)):
        ax = abs((x - c.x) / sz[0]) ** n
        az = abs((z - c.z) / sz[2]) ** n
        rem = 1.0 - ax - az
        if rem <= 1e-6:
            continue
        y = c.y - sz[1] * rem ** (1.0 / n)
        if best is not None and y >= best[0]:
            continue
        d = ((x - c.x) / sz[0], (y - c.y) / sz[1], (z - c.z) / sz[2])
        g = Vector(tuple(
            n * math.copysign(abs(d[i]) ** (n - 1), d[i]) / sz[i]
            for i in range(3)))
        best = (y, g.normalized())
    return best


def build_face():
    """The face, as a DECAL conforming to the skull.

    Geometry could not carry this.  Eyes, brows and a mouth built as separate
    closed solids all sit proud of the head and read as parts glued on, which is
    exactly how the first two attempts looked.  So the features are drawn into an
    image (see face_tex.py) and this builds the surface that carries it: an
    ellipse of grid points, each solved onto the skull and pushed out along the
    surface normal.

    THE OFFSET TAPERS TO NOTHING AT THE RIM.  A decal held at a constant height
    would show a visible lip all the way round its edge; fading the offset to
    0.4 mm means the patch merges into the head and only the middle stands proud
    enough to avoid z-fighting.
    """
    R, S = 22, 48
    verts, uvs, faces = [], [], []

    def place(x, z):
        hit = _skull_front(x, z)
        if hit is None:                      # outside the skull: clamp to equator
            hit = (HEAD_C.y - HEAD_S[1] * 0.02, Vector((0, -1, 0)))
        return hit

    def uv_of(x, z):
        return ((x - (FACE_C.x - FACE_R[0])) / (2 * FACE_R[0]),
                (z - (FACE_C.z - FACE_R[1])) / (2 * FACE_R[1]))

    def emit(x, z, r):
        y, nrm = place(x, z)
        off = 0.0022 * (1.0 - r ** 2.2) + 0.0005
        verts.append(Vector((x, y, z)) + nrm * off)
        uvs.append(uv_of(x, z))

    emit(FACE_C.x, FACE_C.z, 0.0)
    for i in range(1, R + 1):
        r = i / R
        for j in range(S):
            a = TAU * j / S
            emit(FACE_C.x + FACE_R[0] * r * math.cos(a),
                 FACE_C.z + FACE_R[1] * r * math.sin(a), r)

    def vid(i, j):
        return 1 + (i - 1) * S + (j % S)

    # winding chosen so face normals come out -Y (forward); see geo_lib.tube for
    # why this is derived rather than left to recalc_face_normals
    for j in range(S):
        faces.append((0, vid(1, j), vid(1, j + 1)))
    for i in range(2, R + 1):
        for j in range(S):
            faces.append((vid(i - 1, j), vid(i, j), vid(i, j + 1), vid(i - 1, j + 1)))

    img = FACE_TEX[0]
    mat = K.image_material("face", img, preview=(0.95, 0.74, 0.60))
    obj = K._new_obj("face_decal", verts, faces, mat=mat, smooth=True, recalc=False)
    K._apply_weights(obj, [{"head": 1.0}] * len(verts))
    K.set_uvs(obj, uvs)
    return [obj]


def build_arm():
    """Bare forearm, short jacket sleeve, mitten glove -- all on the LEFT; the
    right side is mirrored later."""
    parts = []

    arm = K.limb(joints=[(J["arm.L"], "upperarm.L"),
                         (J["elbow.L"], "forearm.L"),
                         (J["wrist.L"], "forearm.L")],
                 radii=[0.082, 0.066, 0.056], blend=0.26, per_seg=4)
    parts.append(K.tube("arm.L", arm, seg=14, mat=M["skin"]))

    # THE SHOULDER IS A BALL CENTRED ON THE JOINT, BOUND TO THE ARM.
    #
    # The first rig bound this pad to `shoulder.L` while the sleeve below it was
    # bound to `upperarm.L`; the moment the arm swung in the run cycle the two
    # rotated by different amounts and the shoulder tore open into a lumpy mess.
    # A sphere centred exactly on the rotation axis and rigid to the arm can
    # never open a gap, no matter how far the arm swings -- it just spins in
    # place inside the torso.  That is the whole trick of the vinyl-toy build,
    # and it is why this character needs no corrective shapes anywhere.
    parts.append(K.blob("shoulderpad.L", J["arm.L"], (0.112, 0.112, 0.108),
                        "upperarm.L", M["jacket"], seg=18, rings=11, squircle=2.4))

    sleeve_end = J["arm.L"] + (J["elbow.L"] - J["arm.L"]) * 0.42
    sl = K.limb(joints=[(J["arm.L"], "upperarm.L"), (sleeve_end, "upperarm.L")],
                radii=[(0.104, 0.100), (0.098, 0.094)], per_seg=3)
    for s in sl:
        s["n"] = 2.5
    parts.append(K.tube("sleeve.L", sl, seg=16, mat=M["jacket"], squircle=2.5))

    # glove: a mitten swept along the forearm axis, thumb as a stub blob
    d = (J["wrist.L"] - J["elbow.L"]).normalized()
    g0 = J["wrist.L"] - d * 0.014
    gl = [{"p": g0,            "r": (0.062, 0.055), "w": {"hand.L": 1.0}, "n": 2.4},
          {"p": g0 + d * 0.045, "r": (0.086, 0.064), "w": {"hand.L": 1.0}, "n": 2.4},
          {"p": g0 + d * 0.100, "r": (0.088, 0.064), "w": {"hand.L": 1.0}, "n": 2.4},
          {"p": g0 + d * 0.140, "r": (0.070, 0.055), "w": {"hand.L": 1.0}, "n": 2.4}]
    gl = K.dome(gl, at="end", steps=3, height=0.055)
    parts.append(K.tube("glove.L", gl, seg=16, mat=M["glove"], squircle=2.4))
    parts.append(K.blob("thumb.L", g0 + d * 0.055 + Vector((-0.048, -0.026, 0.008)),
                        (0.032, 0.036, 0.042), "hand.L", M["glove"],
                        seg=12, rings=8, squircle=2.2))

    cuff = K.limb(joints=[(J["wrist.L"] - d * 0.058, "forearm.L"),
                          (J["wrist.L"] - d * 0.008, "hand.L")],
                  radii=[(0.068, 0.062), (0.070, 0.064)], per_seg=2)
    for s in cuff:
        s["n"] = 2.4
    parts.append(K.tube("cuff.L", cuff, seg=16, mat=M["trim"], squircle=2.4))
    return parts


def build_leg():
    parts = []
    leg = K.limb(joints=[(J["hip.L"] + Vector((0, 0, 0.015)), "thigh.L"),
                         (J["knee.L"], "shin.L"),
                         (J["ankle.L"] + Vector((0, 0, 0.020)), "shin.L")],
                 radii=[(0.108, 0.102), (0.090, 0.088), (0.070, 0.070)],
                 blend=0.26, per_seg=4)
    for s in leg:
        s["n"] = 2.4
    leg = K.dome(leg, at="start", steps=3, height=0.085)   # tucks into the pelvis
    parts.append(K.tube("leg.L", leg, seg=16, mat=M["pants"], squircle=2.4))

    # shoe: swept forward along -Y from the ankle, squared off to sit flat.
    # Oversized on purpose -- the shoes and gloves are what hold the silhouette
    # together once the camera is 6 m out and the toon ramp has flattened form.
    a = J["ankle.L"]
    sh = [{"p": a + Vector((0,  0.090, -0.030)), "r": (0.078, 0.062), "w": {"foot.L": 1.0}, "n": 3.0},
          {"p": a + Vector((0,  0.015, -0.042)), "r": (0.092, 0.076), "w": {"foot.L": 1.0}, "n": 3.0},
          {"p": a + Vector((0, -0.090, -0.052)), "r": (0.096, 0.076), "w": {"foot.L": 1.0}, "n": 3.0},
          {"p": a + Vector((0, -0.180, -0.055)), "r": (0.082, 0.064), "w": {"foot.L": 1.0}, "n": 3.0}]
    sh = K.dome(sh, at="both", steps=3, height=0.052)
    shoe = K.tube("shoe.L", sh, seg=18, mat=M["shoe"], squircle=3.0)
    # flatten anything that would sink below the floor plane
    for v in shoe.data.vertices:
        if v.co.z < 0.012:
            v.co.z = 0.012 + (v.co.z - 0.012) * 0.18
    parts.append(shoe)

    sole = [{"p": a + Vector((0,  0.076, -0.070)), "r": (0.079, 0.017), "w": {"foot.L": 1.0}, "n": 3.2},
            {"p": a + Vector((0, -0.090, -0.086)), "r": (0.097, 0.019), "w": {"foot.L": 1.0}, "n": 3.2},
            {"p": a + Vector((0, -0.172, -0.086)), "r": (0.083, 0.017), "w": {"foot.L": 1.0}, "n": 3.2}]
    s_obj = K.tube("sole.L", K.dome(sole, at="both", steps=2, height=0.020),
                   seg=16, mat=M["sole"], squircle=3.2)
    for v in s_obj.data.vertices:
        if v.co.z < 0.008:
            v.co.z = 0.008
    parts.append(s_obj)
    return parts


def build_sword():
    """Held in the right hand, aimed forward-down at rest.  Rigid to hand.R --
    a weapon is the one place where rigid binding is not a compromise."""
    parts = []
    # BUILT IN ITS OWN FRAME: grip at the origin, blade running down -Z, guard
    # loop square to world X.  rounded_box is axis-aligned, so a guard built
    # directly on a tilted blade comes out skewed and the loop never closes --
    # build square, then rotate the finished assembly into the fist.
    W = {"hand.R": 1.0}
    parts = []

    # A sword has to read as a BLUNT INSTRUMENT: short and thick, not long and
    # thin.  The first pass was 0.72 long on a 0.024 shaft and read as a cane.
    shaft = [{"p": Vector((0, 0,  0.095)), "r": (0.034, 0.034), "w": W, "n": 2.8},
             {"p": Vector((0, 0,  0.020)), "r": (0.040, 0.040), "w": W, "n": 2.8},
             {"p": Vector((0, 0, -0.070)), "r": (0.040, 0.036), "w": W, "n": 3.0},
             {"p": Vector((0, 0, -0.520)), "r": (0.044, 0.032), "w": W, "n": 3.2},
             {"p": Vector((0, 0, -0.600)), "r": (0.038, 0.028), "w": W, "n": 3.2}]
    parts.append(K.tube("kb_shaft", K.dome(shaft, at="both", steps=2, height=0.030),
                        seg=12, mat=M["metal"], squircle=3.0))

    # guard: a closed rectangular loop -- two side bars joined by two crossbars.
    # The crossbar semi-length must exceed the side-bar offset or the loop opens.
    gz = -0.125
    for i, x in enumerate((0.082, -0.082)):
        parts.append(K.rounded_box(f"kb_guard{i}", (x, 0, gz),
                                   (0.009, 0.020, 0.046), 0.006, "hand.R", M["gold"]))
    for i, z in enumerate((gz - 0.078, gz + 0.070)):
        parts.append(K.rounded_box(f"kb_cross{i}", (0, 0, z),
                                   (0.091, 0.019, 0.010), 0.006, "hand.R", M["gold"]))

    # teeth: the key head at the far end
    parts.append(K.rounded_box("kb_tooth0", (0.072, 0, -0.552),
                               (0.050, 0.016, 0.015), 0.007, "hand.R", M["gold"]))
    parts.append(K.rounded_box("kb_tooth1", (0.112, 0, -0.482),
                               (0.016, 0.016, 0.048), 0.007, "hand.R", M["gold"]))
    parts.append(K.blob("kb_pommel", (0, 0, 0.112), (0.042, 0.042, 0.046),
                        "hand.R", M["gold"], seg=12, rings=8, squircle=2.4))

    # keychain token, because the silhouette needs one asymmetric dangle
    parts.append(K.blob("kb_chain", (0, 0, 0.156), (0.016, 0.016, 0.034),
                        "hand.R", M["metal"], seg=10, rings=7))
    parts.append(K.blob("kb_token", (0, 0.052, 0.196), (0.048, 0.019, 0.048),
                        "hand.R", M["trim"], seg=14, rings=9, squircle=2.2))

    # Rx(-18) then Ry(18) sends -Z to (-0.31, -0.29, -0.90): down, forward, and
    # out to the character's right so the blade clears the leg.
    grip = Vector((-0.360, -0.008, 0.800))
    for p in parts:
        K.transform(p, rotate=(-18.0, 18.0, 0.0), around=(0, 0, 0), translate=grip)
    return parts


# ---------------------------------------------------------------- animation
#
# The clips live in anim_lib so other characters can use them -- see
# tools/vesper_build.py, which drives an externally-authored mesh with this
# exact same set.

from anim_lib import (NEUTRAL, AIRBORNE, anim_idle, anim_run, anim_attack,
                      anim_attack2, anim_attack3, anim_jump, anim_land)  # noqa: E402


# ------------------------------------------------------------------ preview

def render_sheet(prefix, arm_obj, body):
    """Workbench turnaround.  Fast, deterministic, and shows form -- exactly what
    you need while dialling proportions, and nothing you don't."""
    scn = bpy.context.scene
    # EEVEE, not Workbench.  Workbench shades from material.diffuse_color and
    # cannot show an image texture at all, so the moment the face became a
    # texture the preview stopped being able to preview the thing being worked on.
    scn.render.engine = 'BLENDER_EEVEE'
    scn.render.resolution_x = 560
    scn.render.resolution_y = 900
    scn.render.film_transparent = False
    if scn.world is None:
        scn.world = bpy.data.worlds.new("W")
    scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.30, 0.36, 0.46, 1.0)
    bg.inputs[1].default_value = 1.0

    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN'))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(18)
    sun.rotation_euler = (math.radians(58), 0, math.radians(38))
    bpy.context.collection.objects.link(sun)

    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", 'AREA'))
    fill.data.energy = 90
    fill.data.size = 4.0
    fill.location = (-2.6, -2.2, 2.2)
    fill.rotation_euler = (math.radians(66), 0, math.radians(-52))
    bpy.context.collection.objects.link(fill)

    # a ground plane, so contact poses can be judged against a real floor
    ground = bpy.data.meshes.new("Ground")
    ground.from_pydata([(-6, -6, 0), (6, -6, 0), (6, 6, 0), (-6, 6, 0)], [],
                       [(0, 1, 2, 3)])
    ground.update()
    g_obj = bpy.data.objects.new("Ground", ground)
    ground.materials.append(K.material("ground", (0.42, 0.46, 0.44)))
    bpy.context.collection.objects.link(g_obj)

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 55
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scn.camera = cam

    # 55 mm at 3.9 m frames ~2.55 m of height on a 900 px portrait render, which
    # leaves the 1.74 m character comfortable margin head and foot.
    target = Vector((0, 0, 0.90))
    views = [("front", 0.0, 3.9), ("three-quarter", 38.0, 3.9),
             ("side", 90.0, 3.9), ("back", 180.0, 3.9),
             ("face", 30.0, 0.95), ("face_front", 0.0, 0.95)]
    os.makedirs(prefix, exist_ok=True)
    out = []
    for name, az, dist in views:
        a = math.radians(az)
        aim = Vector((0, -0.01, 1.556)) if name.startswith("face") else target
        cam.location = aim + Vector((math.sin(a) * dist,
                                     -math.cos(a) * dist,
                                     0.06 if name.startswith("face") else 0.20))
        cam.rotation_euler = (aim - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(prefix, f"hero_{name}.png")
        bpy.ops.render.render(write_still=True)
        out.append(scn.render.filepath)
    return out


def render_joint_probe(prefix, rig):
    """Isolate ONE joint rotation per frame and photograph it from the side.

    The module docstring claims "+X rotates forward" for every bone.  That claim
    is derived, not observed, and a sign error in it is invisible in a finished
    animation -- it just makes the character look subtly wrong.  This renders the
    claim so it can be checked instead of trusted.

    Camera sits on -X looking toward +X with +Z up, so the character's FORWARD
    (-Y) points to the RIGHT of frame.  A limb rotated +X should swing right.
    """
    scn = bpy.context.scene
    cam = scn.camera
    target = Vector((0, 0, 1.0))
    cam.location = target + Vector((-4.2, 0.0, 0.15))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()

    # (name, pose, view).  "front" looks along +Y at a character facing -Y, so
    # screen-RIGHT is the character's LEFT (+X).
    probes = [
        ("forearm_pos", {"forearm.L": (60, 0, 0), "forearm.R": (60, 0, 0)}, "side"),
        ("forearm_neg", {"forearm.L": (-60, 0, 0), "forearm.R": (-60, 0, 0)}, "side"),
        ("thigh_pos",   {"thigh.L": (45, 0, 0), "thigh.R": (45, 0, 0)}, "side"),
        ("upperarm_pos", {"upperarm.L": (45, 0, 0), "upperarm.R": (45, 0, 0)}, "side"),
        # which way does the SIDEWAYS swing go?  the jump's airborne pose
        # crossed the arms behind the back, so this needs observing, not guessing
        ("armZ_pos", {"upperarm.L": (0, 0, 45), "upperarm.R": (0, 0, 45)}, "front"),
        ("armZ_neg", {"upperarm.L": (0, 0, -45), "upperarm.R": (0, 0, -45)}, "front"),
    ]
    os.makedirs(prefix, exist_ok=True)
    out = []
    # Detach the action -- do NOT animation_data_clear().  Clearing removes the
    # armature's animation data entirely, and the glTF exporter's ACTIONS mode
    # then finds nothing to attach, so the character exports with ZERO clips.
    # That made the build depend on whether --render was passed, and shipped a
    # completely rigid character.
    prev_action = rig.animation_data.action if rig.animation_data else None
    if rig.animation_data:
        rig.animation_data.action = None
    for name, pose, view in probes:
        if view == "front":
            cam.location = target + Vector((0.0, -4.2, 0.15))
        else:
            cam.location = target + Vector((-4.2, 0.0, 0.15))
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        K.rest(rig)
        for bone, rot in pose.items():
            pb = rig.pose.bones.get(bone)
            pb.rotation_mode = 'XYZ'
            pb.rotation_euler = [math.radians(a) for a in rot]
        bpy.context.view_layer.update()
        scn.render.filepath = os.path.join(prefix, f"probe_{name}.png")
        bpy.ops.render.render(write_still=True)
        out.append(scn.render.filepath)
    K.rest(rig)
    if rig.animation_data:
        rig.animation_data.action = prev_action
    return out


def render_poses(prefix, rig):
    """One frame from each clip, side by side -- the fastest way to catch a limb
    that deforms wrong before it ever reaches the browser."""
    scn = bpy.context.scene
    cam = scn.camera
    # SIDE view: a run cycle is unjudgeable from three-quarter, where the whole
    # stride runs straight down the view axis and every pose looks like standing.
    target = Vector((0, 0, 0.90))
    a = math.radians(88.0)
    cam.location = target + Vector((math.sin(a) * 4.1, -math.cos(a) * 4.1, 0.22))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()

    os.makedirs(prefix, exist_ok=True)
    # one shot at each swing's CONTACT frame, so the three hits of the chain can
    # be compared as a set -- the whole point of authoring them separately
    shots = [("idle", 12), ("run", 0), ("run", 4), ("run", 8),
             ("attack", 5), ("attack2", 5), ("attack3", 8),
             ("attack3", 4), ("jump", 12)]
    out = []
    for act_name, frame in shots:
        act = bpy.data.actions.get(act_name)
        if act is None:
            continue
        rig.animation_data.action = act
        if hasattr(rig.animation_data, "action_slot") and act.slots:
            rig.animation_data.action_slot = act.slots[0]
        scn.frame_set(frame)
        scn.render.filepath = os.path.join(prefix, f"pose_{act_name}_{frame:02d}.png")
        bpy.ops.render.render(write_still=True)
        out.append(scn.render.filepath)
    return out


# --------------------------------------------------------------------- main

def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = "public/assets/hero.glb"
    render_dir = None
    for i, a in enumerate(argv):
        if a == "--out":
            out = argv[i + 1]
        elif a == "--render":
            render_dir = argv[i + 1]

    K.clear_scene()
    FACE_TEX[0] = face_tex.to_blender_image("hero_face", 768)
    for k, v in C.items():
        M[k] = K.material(k, v, roughness=0.55 if k in ("metal", "gold") else 0.7,
                          metallic=0.8 if k in ("metal", "gold") else 0.0)

    rig = build_rig()

    parts = []
    parts += build_torso()
    parts += build_head()
    parts += build_leg()
    parts += build_arm()
    for p in list(parts):
        if p.name.endswith(".L"):
            parts.append(K.mirror(p, p.name[:-2] + ".R"))
    parts += build_sword()

    body = K.bind(parts, rig, name="Hero")

    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    print(f"[hero] {len(body.data.vertices)} verts, {tris} tris, "
          f"{len(body.data.materials)} materials, "
          f"{len(body.vertex_groups)} vertex groups")

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    anim_idle(rig)
    anim_run(rig)
    anim_attack(rig)
    anim_attack2(rig)
    anim_attack3(rig)
    anim_jump(rig)
    anim_land(rig)
    print(f"[hero] actions: {[a.name for a in bpy.data.actions]}")

    if render_dir:
        K.rest(rig)
        rig.animation_data.action = None
        for f in render_sheet(render_dir, rig, body):
            print(f"[render] {f}")
        for f in render_poses(render_dir, rig):
            print(f"[render] {f}")
        for f in render_joint_probe(render_dir, rig):
            print(f"[render] {f}")

    K.rest(rig)
    path = K.export_glb(out, rig)
    info = K.verify_glb(path, animations=["idle", "run", "attack", "attack2", "attack3",
                                    "jump", "land"],
                        images=1)
    print(f"[hero] exported {path} ({os.path.getsize(path)/1024:.0f} KB)")
    print(f"[hero] verified: clips={info['animations']} images={info['images']}")


if __name__ == "__main__":
    main()
