"""arch_lib -- a modular architecture kit for the vinyl-toon town.

Same philosophy as geo_lib: every piece is generated from parameters, and the
COLLISION DATA IS EMITTED BY THE CODE THAT PLACES THE GEOMETRY.  A wall and the
box that blocks you are two outputs of one call, so they cannot drift apart --
which is the failure mode that makes hand-authored collision miserable.

Conventions (Blender, Z-up), shared with geo_lib:
    +Z  up
    -Y  the direction a facade FACES; buildings are assembled front-to--Y and
        then yawed into place, so every piece is authored in one orientation
    +X  to the right of that facade

Sizes are SEMI-axes everywhere, matching geo_lib.  Bevels are small and always
present: a chamfer that catches the rim light is most of what makes a plain box
read as a vinyl-toy building rather than as a programmer's cube.

glTF export turns Blender (x, y, z) into three.js (x, z, -y); `Town.manifest`
does the same conversion for the collision boxes.
"""
import bpy
import math
from mathutils import Vector

import geo_lib as K

FLOOR_H = 3.05          # storey height
GROUND_H = 3.45         # ground floor is taller -- shopfronts need the room


# ------------------------------------------------------------------ palette

def palette():
    """Warm plaster and terracotta against a cool sky.  Values are the toon
    ramp's MIDTONE, so they run brighter and more saturated than a PBR albedo
    would: the ramp darkens the shadow band hard and mud is unrecoverable."""
    spec = {
        "plaster_a": (0.95, 0.87, 0.73),
        "plaster_b": (0.93, 0.75, 0.58),
        "plaster_c": (0.80, 0.84, 0.86),
        "plaster_d": (0.88, 0.70, 0.66),
        "timber":    (0.40, 0.26, 0.18),
        "roof_a":    (0.80, 0.36, 0.26),
        "roof_b":    (0.36, 0.44, 0.58),
        "roof_c":    (0.72, 0.44, 0.30),
        "stone":     (0.78, 0.75, 0.70),
        # paving runs DARKER than instinct suggests: it fills most of the frame,
        # and a light grey ground under a strong key blows to white and drags
        # every facade toward pastel with it
        "cobble":    (0.52, 0.50, 0.53),
        "cobble_b":  (0.60, 0.57, 0.55),
        "door":      (0.20, 0.44, 0.46),
        "glass":     (0.52, 0.74, 0.86),
        "lamp":      (1.00, 0.86, 0.52),
        "brass":     (0.86, 0.68, 0.30),
        "awning":    (0.84, 0.30, 0.28),
        "leaf":      (0.42, 0.64, 0.34),
        # DARKER THAN THE GROUND IT SITS IN. At 0.38/0.72/0.84 the toon ramp
        # pushed the lit band to near-white and a stream across a green meadow
        # read as a drift of snow. Water is the one surface here that should
        # be the darkest thing in frame.
        # 0.10/0.30/0.40, not 0.20/0.44/0.52. Through the sRGB transfer the
        # lighter value came out at 48/70/75% and, once the toon ramp put the
        # whole surface in its lit band, the stream was almost exactly as
        # bright as the grass it ran through -- so it read as pale plastic
        # rather than as water. Water is DARK, and gets read as water
        # because it is darker and bluer than everything around it.
        "water":     (0.10, 0.30, 0.40),
        # AERATED water is nearly white. The jets first used the pool colour
        # and read as six grey pipes holding the bowl up -- falling water is
        # full of air and is the brightest thing in a fountain, not the
        # darkest.
        "foam":      (0.86, 0.94, 0.96),
        "cloth":     (0.90, 0.88, 0.80),
    }
    mats = {}
    for name, color in spec.items():
        mats[name] = K.material(
            name, color,
            roughness=0.35 if name in ("glass", "water", "brass") else 0.75,
            metallic=0.7 if name == "brass" else 0.0,
            emission=2.2 if name == "lamp" else 0.0)
    return mats


# --------------------------------------------------------------- collector

class Town:
    """Visual parts, walkable surfaces, and collision boxes, gathered as built."""

    def __init__(self, mats):
        self.M = mats
        self.parts = []
        self.floors = []
        self.solids = []
        self.platforms = []

    def add(self, *objs):
        for o in objs:
            if o is not None:
                self.parts.append(o)
        return objs[0] if objs else None

    def walk(self, *objs):
        """A surface the player can stand on: it is visual AND raycast target."""
        for o in objs:
            if o is not None:
                self.parts.append(o)
                self.floors.append(o)
        return objs[0] if objs else None

    def solid(self, cx, cy, hx, hy, yaw=0.0, top=3.0):
        """`top` is how tall the box is.  The camera collision needs it: without
        a height every prop is an infinite pillar and the camera refuses to rise
        over a barrel."""
        self.solids.append((cx, cy, hx, hy, math.radians(yaw), top))

    def platform(self, cx, cy, hx, hy, top):
        """A surface ABOVE the analytic ground that the player can stand on.

        The meadow answers "where is the floor" from a closed-form terrain
        function rather than by raycasting, which is what made it playable -- but
        that function only knows about terrain. Anything standing on top of it
        has to be declared, or it is scenery you walk straight through.
        """
        self.platforms.append((cx, cy, hx, hy, top))

    def manifest(self):
        """Collision boxes in THREE.JS space (Blender x,y -> three x,-y).

        A yaw about Blender +Z maps to the same yaw about three +Y, and the
        half-extent along Blender Y becomes the half-extent along three Z."""
        return {
            "solids": [
                {"x": round(cx, 4), "z": round(-cy, 4),
                 "hx": round(hx, 4), "hz": round(hy, 4),
                 "yaw": round(yaw, 5), "top": round(top, 3)}
                for cx, cy, hx, hy, yaw, top in self.solids],
            "platforms": [
                {"x": round(cx, 4), "z": round(-cy, 4),
                 "hx": round(hx, 4), "hz": round(hy, 4), "top": round(top, 3)}
                for cx, cy, hx, hy, top in self.platforms],
        }


# ------------------------------------------------------------------ pieces

def box(name, center, size, mat, bevel=0.035, seg=2, smooth=True):
    """Bevelled box; `size` is semi-axes."""
    b = min(bevel, min(size) * 0.6)
    return K.rounded_box(name, center, size, b, None, mat, segments=seg,
                         smooth=smooth)


def prism(name, center, w, d, h, mat, over_y=0.0, over_x=0.0):
    """A gable roof: triangular section in Y-Z, ridge running along X.

    Flat-shaded on purpose -- a roof wants crisp planes, and smoothing a
    six-vertex prism just rounds the ridge into mush."""
    hw, hd = w / 2 + over_x, d / 2 + over_y
    cx, cy, cz = center
    v = [(-hw, -hd, 0), (hw, -hd, 0), (hw, hd, 0), (-hw, hd, 0),
         (-hw, 0.0, h), (hw, 0.0, h)]
    verts = [(cx + a, cy + b, cz + c) for a, b, c in v]
    faces = [(0, 1, 5, 4),        # front slope
             (2, 3, 4, 5),        # back slope
             (0, 4, 3),           # left gable
             (1, 2, 5),           # right gable
             (0, 3, 2, 1)]        # underside
    return K._new_obj(name, [Vector(p) for p in verts], faces, mat=mat,
                      smooth=False)


def window(t, x, y0, z, w=0.62, h=0.92, shutters=True, sill=True,
           glass="glass", frame="timber"):
    """A recessed window on a facade whose outer face is the plane y = y0.

    Built from the outside in: shutters proud of the wall, frame on the wall
    plane, glass set back.  The depth is what sells it -- a window painted flat
    on a wall reads as a sticker under a toon ramp."""
    M, out = t.M, []
    yg = y0 + 0.13                                  # glass, set back
    yf = y0 + 0.02                                  # frame, on the plane
    out.append(box("win_glass", (x, yg, z), (w / 2, 0.02, h / 2), M[glass],
                   bevel=0.01, seg=1))
    out.append(box("win_rev", (x, y0 + 0.08, z), (w / 2 + 0.05, 0.08, h / 2 + 0.05),
                   M["stone"], bevel=0.02, seg=1))
    bar = 0.045
    out.append(box("win_mullion_v", (x, yf, z), (bar, 0.035, h / 2), M[frame],
                   bevel=0.012, seg=1))
    out.append(box("win_mullion_h", (x, yf, z), (w / 2, 0.035, bar), M[frame],
                   bevel=0.012, seg=1))
    for sx, sz, sw, sh in ((0, h / 2, w / 2 + 0.05, bar),
                           (0, -h / 2, w / 2 + 0.05, bar),
                           (w / 2, 0, bar, h / 2 + 0.05),
                           (-w / 2, 0, bar, h / 2 + 0.05)):
        out.append(box("win_frame", (x + sx, yf, z + sz), (sw, 0.04, sh),
                       M[frame], bevel=0.012, seg=1))
    if sill:
        out.append(box("win_sill", (x, y0 - 0.03, z - h / 2 - 0.08),
                       (w / 2 + 0.14, 0.11, 0.05), M["stone"], bevel=0.02, seg=1))
    if shutters:
        for s in (-1, 1):
            out.append(box("win_shutter", (x + s * (w / 2 + 0.20), y0 - 0.06, z),
                           (0.15, 0.035, h / 2 + 0.02), M["door"],
                           bevel=0.018, seg=1))
    return t.add(*out) and out


def shopfront(t, x, y0, z, w=1.9, h=1.45, kind=0):
    """A glazed shopfront: wide, mullioned, with a counter and goods behind it.

    Every ground floor in this town was the same door and the same small
    shuttered window, so nothing was a shop you could look INTO -- an awning and
    a hanging sign told you a trade happened there and the wall said otherwise.

    Built outside-in like `window`, but the glass runs nearly the full bay and
    the goods sit behind it on a counter. The goods are three primitives per
    shop: at the distance a facade is ever seen they only have to read as
    "something is displayed here", and the sign carries the rest.
    """
    M, out = t.M, []
    yg = y0 + 0.16
    yf = y0 + 0.02

    # stall board under the glass -- a shopfront sits on something
    out.append(box("shop_stall", (x, y0 - 0.06, z - h / 2 - 0.22),
                   (w / 2 + 0.10, 0.17, 0.22), M["timber"], bevel=0.03, seg=1))
    out.append(box("shop_glass", (x, yg, z), (w / 2, 0.02, h / 2), M["glass"],
                   bevel=0.01, seg=1))
    out.append(box("shop_reveal", (x, y0 + 0.10, z),
                   (w / 2 + 0.06, 0.10, h / 2 + 0.06), M["stone"],
                   bevel=0.02, seg=1))

    # a counter behind the glass, and goods on it
    out.append(box("shop_counter", (x, yg + 0.22, z - h / 2 + 0.22),
                   (w / 2 - 0.05, 0.20, 0.06), M["timber"], bevel=0.02, seg=1))
    gz = z - h / 2 + 0.34
    for i, gx in enumerate((-w * 0.28, 0.0, w * 0.28)):
        pick = (kind + i) % 3
        if pick == 0:
            out.append(K.blob(f"shop_good{i}", (x + gx, yg + 0.22, gz + 0.05),
                              (0.10, 0.09, 0.10), None, M["awning"],
                              seg=10, rings=7, squircle=2.2))
        elif pick == 1:
            out.append(box(f"shop_good{i}", (x + gx, yg + 0.22, gz + 0.08),
                           (0.08, 0.07, 0.11), M["brass"], bevel=0.02, seg=1))
        else:
            out.append(box(f"shop_good{i}", (x + gx, yg + 0.22, gz + 0.04),
                           (0.11, 0.08, 0.06), M["door"], bevel=0.02, seg=1))

    # frame: two vertical mullions and a transom, so it reads as shop joinery
    bar = 0.05
    for mx in (-w / 6, w / 6):
        out.append(box("shop_mull", (x + mx, yf, z), (bar, 0.04, h / 2),
                       M["timber"], bevel=0.012, seg=1))
    out.append(box("shop_transom", (x, yf, z + h / 2 - 0.30),
                   (w / 2, 0.04, bar), M["timber"], bevel=0.012, seg=1))
    for sx, sz, sw, sh in ((0, h / 2, w / 2 + 0.06, bar),
                           (0, -h / 2, w / 2 + 0.06, bar),
                           (w / 2, 0, bar, h / 2 + 0.06),
                           (-w / 2, 0, bar, h / 2 + 0.06)):
        out.append(box("shop_frame", (x + sx, yf, z + sz), (sw, 0.05, sh),
                       M["timber"], bevel=0.012, seg=1))
    return t.add(*out) and out


def doorway(t, x, y0, z0, w=0.70, h=1.95, mat="door"):
    """A door on the facade plane y = y0, sitting on the floor at z0."""
    M, out = t.M, []
    out.append(box("door_rev", (x, y0 + 0.10, z0 + h / 2), (w / 2 + 0.07, 0.10, h / 2 + 0.05),
                   M["stone"], bevel=0.02, seg=1))
    out.append(box("door_slab", (x, y0 + 0.02, z0 + h / 2), (w / 2, 0.05, h / 2),
                   M[mat], bevel=0.02, seg=1))
    out.append(box("door_lintel", (x, y0 - 0.04, z0 + h + 0.11),
                   (w / 2 + 0.22, 0.11, 0.09), M["stone"], bevel=0.025, seg=1))
    out.append(K.blob("door_knob", (x + w / 2 - 0.13, y0 - 0.04, z0 + h * 0.52),
                      (0.045, 0.045, 0.045), None, M["brass"], seg=10, rings=7))
    out.append(box("door_step", (x, y0 - 0.16, z0 + 0.05), (w / 2 + 0.18, 0.20, 0.05),
                   M["stone"], bevel=0.02, seg=1))
    return t.add(*out) and out


def awning(t, x, y0, z, w=1.5, drop=0.55, reach=0.85):
    """A shop awning: a tilted slab plus a scalloped valance."""
    M, out = t.M, []
    cy = y0 - reach / 2
    slab = box("awning", (x, cy, z), (w / 2, reach / 2, 0.05), M["awning"],
               bevel=0.03, seg=1)
    K.transform(slab, rotate=(-22, 0, 0), around=(x, y0, z + 0.12))
    out.append(slab)
    n = max(3, int(w / 0.34))
    for i in range(n):
        px = x - w / 2 + w * (i + 0.5) / n
        out.append(K.blob("awning_scallop", (px, y0 - reach + 0.02, z - drop * 0.52),
                          (w / n * 0.5, 0.05, 0.13), None, M["awning"],
                          seg=10, rings=7, squircle=2.2))
    for s in (-1, 1):
        out.append(box("awning_arm", (x + s * (w / 2 - 0.04), cy, z - 0.16),
                       (0.03, reach / 2, 0.03), M["timber"], bevel=0.01, seg=1))
    return t.add(*out) and out


def lantern(t, x, y, z0=0.0, h=3.1, wall=False):
    """A post lantern, or a bracket lamp when `wall` is set.  Emissive material;
    the runtime turns each of these into an actual point light."""
    M, out = t.M, []
    if not wall:
        out.append(box("lamp_base", (x, y, z0 + 0.09), (0.17, 0.17, 0.09),
                       M["stone"], bevel=0.03, seg=1))
        out.append(K.tube("lamp_post", K.dome([
            {"p": Vector((x, y, z0 + 0.12)), "r": (0.065, 0.065), "n": 2.6},
            {"p": Vector((x, y, z0 + h * 0.62)), "r": (0.052, 0.052), "n": 2.6},
            {"p": Vector((x, y, z0 + h - 0.30)), "r": (0.048, 0.048), "n": 2.6},
        ], at="both", steps=2, height=0.04), seg=10, mat=M["timber"], squircle=2.6))
    zz = z0 + h
    out.append(box("lamp_cage", (x, y, zz - 0.12), (0.135, 0.135, 0.155),
                   M["lamp"], bevel=0.035, seg=1))
    out.append(box("lamp_cap", (x, y, zz + 0.07), (0.175, 0.175, 0.045),
                   M["brass"], bevel=0.025, seg=1))
    out.append(K.blob("lamp_finial", (x, y, zz + 0.15), (0.055, 0.055, 0.075),
                      None, M["brass"], seg=10, rings=7))
    t.add(*out)
    return (x, y, zz - 0.12)          # where the runtime should hang a light


def arch(t, cx, cy, span=3.2, height=4.2, depth=1.4, thick=0.42, yaw=0.0):
    """A gateway arch over an alley mouth: two piers and a swept semicircle.

    The curve is a tube swept along the arc, which is the one shape a bevelled
    box genuinely cannot fake."""
    M, out = t.M, []
    r = span / 2
    straight = height - r
    for s in (-1, 1):
        out.append(box("arch_pier", (cx + s * (r + thick / 2), cy, straight / 2),
                       (thick / 2, depth / 2, straight / 2), M["stone"],
                       bevel=0.05, seg=2))
        out.append(box("arch_plinth", (cx + s * (r + thick / 2), cy, 0.14),
                       (thick / 2 + 0.07, depth / 2 + 0.07, 0.14), M["stone"],
                       bevel=0.04, seg=1))
    sec = []
    steps = 14
    for i in range(steps + 1):
        a = math.pi * i / steps
        sec.append({"p": Vector((cx - (r + thick / 2) * math.cos(a), cy,
                                 straight + (r + thick / 2) * math.sin(a))),
                    "r": (thick / 2, depth / 2), "n": 3.0})
    # up=+Y so `ry` is the arch's DEPTH and `rx` its radial thickness; the
    # unseeded frame put them the other way round and the gate came out a fat
    # donut half a metre deep.
    out.append(K.tube("arch_curve", sec, seg=12, mat=M["stone"], squircle=3.0,
                      up=(0, 1, 0)))
    out.append(box("arch_key", (cx, cy, straight + r + thick / 2),
                   (0.16, depth / 2 + 0.05, 0.20), M["stone"], bevel=0.03, seg=1))

    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*out)
    for s in (-1, 1):
        px, py = cx + s * (r + thick / 2), cy
        if yaw:
            a = math.radians(yaw)
            dx, dy = px - cx, py - cy
            px, py = cx + dx * math.cos(a) - dy * math.sin(a), \
                     cy + dx * math.sin(a) + dy * math.cos(a)
        t.solid(px, py, thick / 2, depth / 2, yaw, top=height)
    return out


def stairs(t, cx, cy, w, rise, run, steps, yaw=0.0, mat="stone"):
    """A flight of steps, registered as WALKABLE so the runtime's ground
    raycast finds each tread."""
    M, out = t.M, []
    for i in range(steps):
        h = rise * (i + 1)
        y = cy + run * (i + 0.5)
        out.append(box(f"floor_step{i}", (cx, y, h / 2),
                       (w / 2, run / 2 + 0.01, h / 2), M[mat], bevel=0.03, seg=1))
    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.walk(*out)
    return out


def planter(t, x, y, r=0.55, h=0.5):
    M, out = t.M, []
    out.append(K.tube("planter", [
        {"p": Vector((x, y, 0.02)), "r": (r * 0.86, r * 0.86), "n": 3.0},
        {"p": Vector((x, y, h)), "r": (r, r), "n": 3.0},
        {"p": Vector((x, y, h + 0.07)), "r": (r * 1.06, r * 1.06), "n": 3.0},
    ], seg=14, mat=M["stone"], squircle=3.0))
    out.append(K.blob("planter_soil", (x, y, h - 0.02), (r * 0.9, r * 0.9, 0.06),
                      None, M["timber"], seg=14, rings=8))
    for dx, dy, dz, rr in ((0, 0, 0.34, 0.42), (0.22, 0.12, 0.24, 0.30),
                           (-0.20, -0.14, 0.26, 0.28)):
        out.append(K.blob("planter_bush", (x + dx, y + dy, h + dz),
                          (rr, rr, rr * 0.85), None, M["leaf"], seg=12, rings=8,
                          squircle=2.2))
    t.add(*out)
    t.solid(x, y, r, r, top=h + 0.6)
    return out


def barrel(t, x, y, r=0.34, h=0.82):
    M = t.M
    # capped at both ends: an uncapped tube reads as an open bucket
    o = K.tube("barrel", K.dome([
        {"p": Vector((x, y, 0.02)), "r": (r * 0.88, r * 0.88), "n": 2.6},
        {"p": Vector((x, y, h * 0.5)), "r": (r, r), "n": 2.6},
        {"p": Vector((x, y, h)), "r": (r * 0.88, r * 0.88), "n": 2.6},
    ], at="both", steps=2, height=0.05), seg=12, mat=M["timber"], squircle=2.6)
    # a swept ring, not a box -- a square plate through a round barrel reads as
    # a plank nailed to it
    band = K.tube("barrel_band", [
        {"p": Vector((x, y, h * 0.5 - 0.05)), "r": (r * 1.04, r * 1.04), "n": 2.6},
        {"p": Vector((x, y, h * 0.5 + 0.05)), "r": (r * 1.04, r * 1.04), "n": 2.6},
    ], seg=12, mat=M["brass"], squircle=2.6)
    t.add(o, band)
    t.solid(x, y, r, r, top=h)
    return [o, band]


def crate(t, x, y, s=0.42, yaw=0.0):
    M = t.M
    o = box("crate", (x, y, s), (s, s, s), M["timber"], bevel=0.05, seg=2)
    if yaw:
        K.transform(o, rotate=(0, 0, yaw), around=(x, y, 0))
    t.add(o)
    t.solid(x, y, s * 1.25, s * 1.25, yaw, top=s * 2)
    return [o]


def fountain(t, cx, cy, r=2.6):
    """The plaza landmark.  A swept ring for the basin wall, a disc of water,
    and a tiered centre -- the one place in town worth a silhouette."""
    M, out = t.M, []
    ring = []
    steps = 40
    for i in range(steps + 1):
        a = 2 * math.pi * i / steps
        ring.append({"p": Vector((cx + r * math.cos(a), cy + r * math.sin(a), 0.44)),
                     "r": (0.20, 0.45), "n": 3.0})
    # up=+Z so `rx` is the wall's radial thickness and `ry` its height
    out.append(K.tube("fount_wall", ring, seg=12, mat=M["stone"], squircle=3.0,
                      up=(0, 0, 1)))
    out.append(K.tube("fount_water", K.dome([
        {"p": Vector((cx, cy, 0.28)), "r": (r - 0.32, r - 0.32), "n": 2.0},
        {"p": Vector((cx, cy, 0.60)), "r": (r - 0.32, r - 0.32), "n": 2.0},
    ], at="end", steps=2, height=0.04), seg=40, mat=M["water"], squircle=2.0))
    out.append(K.tube("fount_pedestal", K.dome([
        {"p": Vector((cx, cy, 0.30)), "r": (0.60, 0.60), "n": 3.0},
        {"p": Vector((cx, cy, 1.05)), "r": (0.34, 0.34), "n": 3.0},
    ], at="both", steps=2, height=0.05), seg=16, mat=M["stone"], squircle=3.0))

    # THE BOWL MUST BE A CLOSED SOLID.
    #
    # It was first authored as a single flaring surface -- geometrically a dish,
    # but with no underside and no top.  Viewed from above you look straight
    # through the missing surface, and what is behind it is the INSIDE of its own
    # inverted-hull outline shell, which paints a solid dark blob over half the
    # plaza.  An open surface and an outline shell are a bad pair: cap anything
    # the camera can get behind.
    out.append(K.tube("fount_bowl", K.dome([
        {"p": Vector((cx, cy, 1.05)), "r": (0.34, 0.34), "n": 2.6},
        {"p": Vector((cx, cy, 1.34)), "r": (0.96, 0.96), "n": 2.6},
        {"p": Vector((cx, cy, 1.50)), "r": (1.04, 1.04), "n": 2.6},
    ], at="both", steps=2, height=0.07), seg=20, mat=M["stone"], squircle=2.6))
    out.append(K.tube("fount_dish", K.dome([
        {"p": Vector((cx, cy, 1.52)), "r": (0.92, 0.92), "n": 2.2},
        {"p": Vector((cx, cy, 1.58)), "r": (0.92, 0.92), "n": 2.2},
    ], at="end", steps=2, height=0.03), seg=20, mat=M["water"], squircle=2.2))
    out.append(K.tube("fount_spout", K.dome([
        {"p": Vector((cx, cy, 1.50)), "r": (0.16, 0.16), "n": 2.4},
        {"p": Vector((cx, cy, 2.35)), "r": (0.12, 0.12), "n": 2.4},
    ], at="both", steps=2, height=0.04), seg=12, mat=M["stone"], squircle=2.4))
    # A BALL ON A STICK IS A LOLLIPOP. A reviewer's word for this, and fair: the
    # spout ended in a brass sphere, which is the silhouette of a lollipop and
    # not of anything that water comes out of. A small stepped cap with a lip
    # reads as a nozzle, and the water tells you the rest.
    out.append(K.tube("fount_cap", K.dome([
        {"p": Vector((cx, cy, 2.34)), "r": (0.20, 0.20), "n": 3.0},
        {"p": Vector((cx, cy, 2.46)), "r": (0.26, 0.26), "n": 3.0},
        {"p": Vector((cx, cy, 2.52)), "r": (0.15, 0.15), "n": 3.0},
    ], at="both", steps=2, height=0.05), seg=14, mat=M["brass"], squircle=3.0,
        up=(0, 0, 1)))

    # WATER THAT FALLS. This is the whole difference between a fountain and a
    # stone ornament: six arcs from the upper dish out over the rim and down
    # into the basin, each a swept tube tapering as it goes, so the eye reads
    # motion from a shape that never moves.
    for k in range(6):
        a_ = 2 * math.pi * k / 6 + 0.26
        dx, dy = math.cos(a_), math.sin(a_)
        arc = []
        n = 9
        for i in range(n + 1):
            u = i / n
            # out and over, then down: a quadratic in height, linear in radius
            rad = 0.86 + 0.92 * u
            z = 1.56 + 0.16 * u - 1.16 * u * u
            # taper HARD -- a jet of even thickness is a pipe, and the thing
            # that says 'water' is a stream that thins as it stretches
            w = 0.105 * (1.0 - 0.78 * u)
            arc.append({"p": Vector((cx + dx * rad, cy + dy * rad, z)),
                        "r": (w, w), "n": 2.2})
        out.append(K.tube(f"fount_jet{k}", arc, seg=7, mat=M["foam"],
                          squircle=2.2))

    # ripple rings on the basin, barely proud -- enough to catch the ramp's edge
    for rr, zz in ((r * 0.52, 0.605), (r * 0.78, 0.601)):
        ring2 = []
        for i in range(33):
            a2 = 2 * math.pi * i / 32
            ring2.append({"p": Vector((cx + rr * math.cos(a2),
                                       cy + rr * math.sin(a2), zz)),
                          "r": (0.075, 0.012), "n": 3.0})
        out.append(K.tube(f"fount_ripple{int(rr * 10)}", ring2, seg=6,
                          mat=M["foam"], squircle=3.0, up=(0, 0, 1)))

    t.add(*out)
    # A SQUARE BOX ROUND A ROUND BASIN leaves 1.3 m of invisible wall at each
    # corner -- and this thing sits on the line from the respawn point to the
    # gate, so holding forward from spawn walked you into nothing and stopped
    # dead. Inscribed rather than circumscribed: you can clip the rim visually,
    # which is far better than being stopped by air.
    t.solid(cx, cy, r * 0.76, r * 0.76, top=0.9)
    return out


def banner(t, x, y0, z, w=0.55, h=1.5, mat="awning"):
    M, out = t.M, []
    out.append(box("banner_pole", (x, y0 - 0.30, z + h * 0.5 + 0.10),
                   (0.035, 0.32, 0.035), M["timber"], bevel=0.012, seg=1))
    out.append(box("banner_cloth", (x, y0 - 0.55, z), (w / 2, 0.02, h / 2),
                   M[mat], bevel=0.015, seg=1))
    return t.add(*out) and out


# ---------------------------------------------------------------- building

def shopsign(t, x, y0, z, kind=0):
    """A trade sign hung off the facade on a bracket.

    Nothing in this town said what any building was -- nine buildings, one
    recipe, and the only shop cue was an awning that five of them shared. A sign
    is the cheapest possible answer and it is also the one that reads from
    across a square: a shape on a board, in a colour, at first-floor height.

    The emblems are primitives rather than lettering on purpose. Painted words
    at this scale are three unreadable pixels; a boot, a loaf, a tankard and a
    key are legible as silhouettes at any distance you can see the building.
    """
    M, out = t.M, []
    arm = 0.62
    out.append(box("sign_bracket", (x, y0 - arm / 2, z + 0.34),
                   (0.035, arm / 2, 0.035), M["timber"], bevel=0.015, seg=1))
    out.append(box("sign_stay", (x, y0 - arm * 0.62, z + 0.16),
                   (0.03, 0.20, 0.14), M["timber"], bevel=0.015, seg=1))
    out.append(box("sign_board", (x, y0 - arm, z - 0.02),
                   (0.34, 0.035, 0.30), M["timber"], bevel=0.03, seg=1))

    emblem = ["awning", "brass", "door", "lamp"][kind % 4]
    ey = y0 - arm - 0.045
    if kind % 4 == 0:            # a loaf
        out.append(K.blob("sign_em", (x, ey, z - 0.02), (0.17, 0.03, 0.10),
                          None, M[emblem], seg=12, rings=8, squircle=2.2))
    elif kind % 4 == 1:          # a tankard
        out.append(box("sign_em", (x - 0.02, ey, z - 0.02), (0.11, 0.03, 0.13),
                       M[emblem], bevel=0.02, seg=1))
        out.append(box("sign_em2", (x + 0.13, ey, z - 0.02), (0.04, 0.028, 0.07),
                       M[emblem], bevel=0.02, seg=1))
    elif kind % 4 == 2:          # a boot
        out.append(box("sign_em", (x - 0.04, ey, z + 0.03), (0.07, 0.03, 0.12),
                       M[emblem], bevel=0.02, seg=1))
        out.append(box("sign_em2", (x + 0.02, ey, z - 0.10), (0.13, 0.03, 0.05),
                       M[emblem], bevel=0.02, seg=1))
    else:                        # a key
        out.append(box("sign_em", (x, ey, z + 0.04), (0.028, 0.03, 0.13),
                       M[emblem], bevel=0.015, seg=1))
        out.append(K.blob("sign_em2", (x, ey, z - 0.11), (0.08, 0.03, 0.07),
                          None, M[emblem], seg=10, rings=7, squircle=2.2))
        out.append(box("sign_em3", (x + 0.07, ey, z + 0.09), (0.05, 0.028, 0.028),
                       M[emblem], bevel=0.012, seg=1))
    t.add(*out)
    return out


def building(t, cx, cy, w, d, storeys=2, yaw=0.0, plaster="plaster_a",
             roof="roof_a", shop=False, bays=None, roof_h=1.5, seed=0,
             gable_front=False):
    """Assemble one building, front facing -Y, then yaw it into place.

    Everything is authored in ONE orientation and rotated at the end.  Trying to
    place windows in world space for eight differently-angled buildings is how
    facades end up subtly wrong, and it is unnecessary: the rotation is free.
    """
    M, out = t.M, []
    h = GROUND_H + FLOOR_H * (storeys - 1)
    y0 = -d / 2                                  # the facade plane
    bays = bays if bays is not None else max(1, int(w / 2.1))

    out.append(box("bld_plinth", (0, 0, 0.16), (w / 2 + 0.10, d / 2 + 0.10, 0.16),
                   M["stone"], bevel=0.05, seg=2))
    out.append(box("bld_body", (0, 0, h / 2 + 0.16), (w / 2, d / 2, h / 2),
                   M[plaster], bevel=0.06, seg=2))

    # storey bands: a shadow line every floor keeps a tall facade from reading
    # as one undifferentiated slab under flat toon shading
    for f in range(1, storeys):
        z = 0.16 + GROUND_H + FLOOR_H * (f - 1)
        out.append(box("bld_band", (0, 0, z), (w / 2 + 0.06, d / 2 + 0.06, 0.075),
                       M["timber"], bevel=0.025, seg=1))

    # cornice + roof
    out.append(box("bld_cornice", (0, 0, h + 0.16), (w / 2 + 0.16, d / 2 + 0.16, 0.11),
                   M["stone"], bevel=0.04, seg=1))
    # GABLE TO THE STREET on some of them. A reviewer counted one building
    # recipe used nine times, and the roof ridge running the same way every time
    # is most of why: turn the prism a quarter and the same building has a
    # completely different silhouette from the square.
    if gable_front:
        out.append(prism("bld_roof", (0, 0, h + 0.27), d, w, roof_h * 1.25,
                         M[roof], over_y=0.26, over_x=0.30))
        K.transform(out[-1], rotate=(0, 0, 90), around=(0, 0, 0))
    else:
        out.append(prism("bld_roof", (0, 0, h + 0.27), w, d, roof_h, M[roof],
                         over_y=0.30, over_x=0.26))

    # chimney, offset so the roofline is never symmetrical
    chx = (0.22 if seed % 2 else -0.28) * w
    out.append(box("bld_chimney", (chx, 0.10 * d, h + 0.30 + roof_h * 0.72),
                   (0.24, 0.24, roof_h * 0.62), M["stone"], bevel=0.04, seg=1))

    # ground floor: a door, or a shopfront with an awning
    door_bay = bays // 2
    for b in range(bays):
        bx = -w / 2 + w * (b + 0.5) / bays
        if b == door_bay:
            out += doorway(t, bx, y0, 0.16)
            if shop:
                out += awning(t, bx, y0, 0.16 + 2.35, w=min(1.9, w / bays * 0.95))
                out += shopsign(t, bx + min(1.5, w / bays * 0.8), y0,
                                0.16 + 3.05, kind=seed)
        elif shop:
            out += shopfront(t, bx, y0, 0.16 + 1.55,
                             w=min(2.0, w / bays * 0.86), kind=seed)
            continue
        elif False:
            out += window(t, bx, y0, 0.16 + 1.65, w=min(1.15, w / bays * 0.7),
                          h=1.35, shutters=False)
        else:
            out += window(t, bx, y0, 0.16 + 1.75)

    # upper storeys, front and back
    for f in range(1, storeys):
        z = 0.16 + GROUND_H + FLOOR_H * (f - 1) + FLOOR_H * 0.52
        for b in range(bays):
            bx = -w / 2 + w * (b + 0.5) / bays
            out += window(t, bx, y0, z)
            out += window(t, bx, d / 2, z)          # rear elevation
        # side elevations get one window per storey so alleys are not blank
        for s in (-1, 1):
            wob = window(t, 0, -d * 0, z, w=0.5, h=0.8, shutters=False)
            for o in wob:
                K.transform(o, rotate=(0, 0, 90 * s), around=(0, 0, 0),
                            translate=(s * (w / 2), 0, 0))
            out += wob

    if storeys >= 2:
        out += banner(t, w * 0.30, y0, 0.16 + GROUND_H + 0.55,
                      mat="awning" if seed % 2 else "roof_b")

    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(0, 0, 0))
        K.transform(o, translate=(cx, cy, 0))

    t.add(*out)
    t.solid(cx, cy, w / 2 + 0.10, d / 2 + 0.10, yaw, top=h + 0.27 + roof_h)
    return out


# ------------------------------------------------------------------ output

def finish(t, name_town="TOWN", name_floor="FLOOR"):
    """Join into two objects: everything, and the walkable subset.

    Two objects instead of ~600 keeps the draw call count sane (each keeps its
    own material slots, so the runtime still gets one primitive per material),
    and it gives the ground raycast a single cheap target."""
    # Kit pieces register themselves as they are built AND get re-added by the
    # assembly that used them, so the parts list carries duplicates.  Dedupe by
    # identity before joining.
    walkable = {id(o) for o in t.floors}
    floors, others, seen = [], [], set()
    for o in t.parts:
        if id(o) in seen:
            continue
        seen.add(id(o))
        (floors if id(o) in walkable else others).append(o)

    floor_obj = K.join(floors, name_floor)
    town_obj = K.join(others, name_town)
    return town_obj, floor_obj


def belltower(t, cx, cy, base=2.35, storeys=4, yaw=0.0):
    """THE LANDMARK.

    The town had none.  Every building tops out between 6.5 and 9.5 m and the
    gameplay camera sits about 1.7 m off the ground looking slightly down, so
    the roofs -- which exist, with pitches and chimneys -- are simply never in
    frame.  A player walking the plaza sees walls and sky and nothing that says
    where they are.  Adding a skyline meant adding something tall enough to be
    ABOVE the walls at eye level, not fixing the walls.

    It is also the thing you look back at.  From the meadow the town is a gap
    between two rooftops; now there is a silhouette in that gap, and the
    landmark hill and this tower bracket the walk from either end.

    Deliberately a BELL and not a clock.  A clocktower over a European-ish plaza
    is the single most recognisable thing the reference game has, and the point
    is to hit its quality without borrowing its furniture.  A bell in an open
    belfry under a hipped cap, with a weathervane, is the same silhouette job
    done with different parts.
    """
    M, out = t.M, []
    shaft_h = 3.9 * storeys

    out.append(box("tower_plinth", (cx, cy, 0.22), (base + 0.34, base + 0.34, 0.22),
                   M["stone"], bevel=0.06, seg=2))

    # the shaft TAPERS, which is most of why a tall box reads as a tower rather
    # than as a chimney: each stage is a little narrower than the one under it
    for i in range(storeys):
        z0 = 0.44 + 3.9 * i
        w = base * (1.0 - 0.055 * i)
        out.append(box(f"tower_stage{i}", (cx, cy, z0 + 1.95), (w, w, 1.95),
                       M["plaster_c"], bevel=0.07, seg=2))
        # string course: the shadow line that separates the stages
        out.append(box(f"tower_course{i}", (cx, cy, z0 + 3.90),
                       (w + 0.13, w + 0.13, 0.10), M["stone"], bevel=0.03, seg=1))
        # a narrow slit window per stage, alternating faces so it reads as lived-in
        for s in (-1, 1):
            if (i + (s > 0)) % 2:
                continue
            out.append(box(f"tower_slit{i}", (cx + s * (w + 0.02), cy, z0 + 2.15),
                           (0.05, 0.16, 0.62), M["door"], bevel=0.02, seg=1))

    # the belfry: four corner piers with the sky showing between them, which is
    # what makes the top read as open rather than as one more solid stage
    top = 0.44 + 3.9 * storeys
    bw = base * (1.0 - 0.055 * (storeys - 1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            out.append(box("tower_pier", (cx + sx * (bw - 0.22), cy + sy * (bw - 0.22),
                                          top + 1.15),
                           (0.22, 0.22, 1.15), M["stone"], bevel=0.04, seg=2))
    out.append(box("tower_belfry_floor", (cx, cy, top + 0.08), (bw, bw, 0.13),
                   M["stone"], bevel=0.04, seg=1))
    out.append(box("tower_belfry_lintel", (cx, cy, top + 2.38), (bw + 0.10, bw + 0.10, 0.16),
                   M["stone"], bevel=0.04, seg=1))

    # the bell itself, hung on a beam
    out.append(box("tower_beam", (cx, cy, top + 2.10), (bw - 0.30, 0.09, 0.09),
                   M["timber"], bevel=0.02, seg=1))
    out.append(K.tube("tower_bell", [
        {"p": Vector((cx, cy, top + 2.02)), "r": (0.10, 0.10), "n": 2.4},
        {"p": Vector((cx, cy, top + 1.72)), "r": (0.30, 0.30), "n": 2.6},
        {"p": Vector((cx, cy, top + 1.52)), "r": (0.44, 0.44), "n": 3.0},
        {"p": Vector((cx, cy, top + 1.46)), "r": (0.45, 0.45), "n": 3.0},
        {"p": Vector((cx, cy, top + 1.44)), "r": 0.0, "n": 3.0},
    ], seg=16, mat=M["brass"], squircle=2.6, up=(0, 1, 0)))

    # hipped cap: a pyramid, not a gable, so the tower reads the same from every
    # approach -- a ridge would give it a "front" it does not have
    capz = top + 2.54
    hw = bw + 0.34
    v = [(-hw, -hw, 0), (hw, -hw, 0), (hw, hw, 0), (-hw, hw, 0), (0, 0, 2.5)]
    out.append(K._new_obj("tower_cap",
                          [Vector((cx + a, cy + b, capz + c)) for a, b, c in v],
                          [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (0, 3, 2, 1)],
                          mat=M["roof_b"], smooth=False))
    out.append(box("tower_finial", (cx, cy, capz + 2.72), (0.055, 0.055, 0.34),
                   M["brass"], bevel=0.02, seg=1))
    # weathervane: a flat arrow, the one asymmetric detail on the whole silhouette
    out.append(box("tower_vane", (cx + 0.30, cy, capz + 3.00), (0.30, 0.02, 0.13),
                   M["brass"], bevel=0.015, seg=1))

    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*out)
    t.solid(cx, cy, base + 0.34, base + 0.34, yaw, top=shaft_h)
    return out


def gallery(t, cx, cy, w=7.0, d=2.2, deck=3.55, yaw=0.0, stair_side=1):
    """An exterior stair to a first-floor gallery: the town's upper level.

    The plaza had one raised terrace and nothing else, so an audit's line about
    the entire vertical vocabulary being a 1.1 m step was fair. This is somewhere
    ABOVE the square that you can stand on and look down from, reached by a
    stair you can see from the ground -- which is the part that matters. A
    balcony you cannot obviously get to is set dressing.

    Everything is authored facing -Y and yawed into place, like `building`.
    """
    M, out = t.M, []
    half = w / 2

    # deck, with a fascia so it has a thickness from below
    out.append(box("gal_deck", (0, 0, deck), (half, d / 2, 0.09),
                   M["timber"], bevel=0.03, seg=1))
    out.append(box("gal_fascia", (0, -d / 2, deck - 0.13), (half, 0.07, 0.13),
                   M["timber"], bevel=0.03, seg=1))

    # posts down to the ground, so it is held up by something
    for s in (-1, 1):
        out.append(box("gal_post", (s * (half - 0.20), -d / 2 + 0.16, deck / 2),
                       (0.11, 0.11, deck / 2), M["timber"], bevel=0.03, seg=1))
    # brackets, the detail that makes it read as carpentry
    for s in (-1, 1):
        out.append(box("gal_brace", (s * (half - 0.20), -d / 2 + 0.55, deck - 0.55),
                       (0.07, 0.42, 0.07), M["timber"], bevel=0.02, seg=1))

    # railing along the open edge and the two returns
    rail_h = 0.95
    for x in [-half + 0.22 + i * ((w - 0.44) / 7) for i in range(8)]:
        out.append(box("gal_baluster", (x, -d / 2 + 0.10, deck + rail_h / 2),
                       (0.045, 0.045, rail_h / 2), M["timber"], bevel=0.02, seg=1))
    out.append(box("gal_rail", (0, -d / 2 + 0.10, deck + rail_h),
                   (half, 0.075, 0.05), M["timber"], bevel=0.025, seg=1))

    # the stair, running along the facade rather than out into the square --
    # a flight sticking into a plaza is an obstacle in the middle of the fight
    steps = 9
    rise = deck / steps
    run = 0.34
    sx = stair_side
    for i in range(steps):
        z = rise * (i + 0.5)
        x = sx * (half + 0.30 + run * (steps - i - 0.5))
        out.append(box(f"gal_step{i}", (x, 0.0, z / 2),
                       (run / 2, d / 2 * 0.80, z / 2), M["stone"],
                       bevel=0.02, seg=1))
    # stair rail
    for i in range(0, steps, 2):
        z = rise * (i + 0.5)
        x = sx * (half + 0.30 + run * (steps - i - 0.5))
        out.append(box(f"gal_srail{i}", (x, -d / 2 * 0.80, z + 0.48),
                       (0.04, 0.04, 0.48), M["timber"], bevel=0.02, seg=1))

    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(0, 0, 0))
        K.transform(o, translate=(cx, cy, 0))

    # the deck and the treads are WALKABLE; the posts and rails are not
    for o in out:
        if o.name.startswith(("gal_deck", "gal_step")):
            t.walk(o)
        else:
            t.add(o)

    # a solid under the railing so you cannot walk off the open edge, and one
    # per post so the camera does not slide through them
    a = math.radians(yaw)
    def place(lx, ly):
        return (cx + lx * math.cos(a) - ly * math.sin(a),
                cy + lx * math.sin(a) + ly * math.cos(a))
    rx, ry = place(0.0, -d / 2 + 0.10)
    t.solid(rx, ry, half, 0.10, yaw, top=deck + rail_h)
    return out
