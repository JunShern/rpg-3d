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
ROOM_WALL = 0.34        # wall thickness where a building is hollow
ROOM_DOOR = 0.85        # half-width of an interior doorway
ROOM_DOOR_H = 2.45      # its head height above the ground-floor level
ROOM_FLOOR = 0.32       # interior floor level: the top of the plinth course
ROOM_PAD = 0.75         # how far outside a room's CAMERA box the player may be
                        # and still be treated as fully indoors. The box is
                        # inset from the walls so the camera never touches one,
                        # which leaves a band where she is in the room and the
                        # camera is only half-confined -- measured, that band
                        # cost 1.11 m of single-frame lurch in a shop corner
                        # while the middle of the same room managed 0.42.
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
        # EMBERCAP: the thing worth going to look at. Warm gold so it reads
        # against both the grey plaza and the green meadow -- the two grounds
        # it has to be spotted on -- and emissive so it carries at the range you
        # would notice it from, which is the whole job.
        "pod":       (1.00, 0.82, 0.34),
    }
    mats = {}
    for name, color in spec.items():
        mats[name] = K.material(
            name, color,
            roughness=0.35 if name in ("glass", "water", "brass") else 0.75,
            metallic=0.7 if name == "brass" else 0.0,
            emission=2.2 if name in ("lamp", "pod") else 0.0)
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
        self.camblocks = []
        # Objects deliberately NOT joined, because the runtime has to be able to
        # address them one at a time. `loose` is the flat set to exclude from
        # the big join; `loose_groups` is one list per PROP, because a barrel is
        # a body plus two bands and the runtime wants to remove the barrel.
        self.loose = []
        self.loose_groups = []
        self.props = []
        # LANTERNS REGISTER THEMSELVES. The region builder used to thread a
        # `lights` list by hand through every function that made one, which
        # worked until the belltower grew an interior: its lamps are made in
        # `build_buildings`, where no such list is in scope, and the failure
        # mode is a pitch-black stair with nothing else wrong.
        self.lights = []
        # OPEN VOLUMES THE CAMERA MAY ALWAYS OCCUPY. A stairwell is the one
        # shape a third-person camera cannot solve: every flight has a wall
        # directly behind the player, so the boom collapses onto her back no
        # matter how wide the room is. The well down the middle is guaranteed
        # empty for the shaft's whole height -- that is what a well IS -- so the
        # runtime confines the camera to it rather than trying to find air.
        self.shafts = []

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

    def solid(self, cx, cy, hx, hy, yaw=0.0, top=3.0, base=-0.5):
        """`top` is how tall the box is.  The camera collision needs it: without
        a height every prop is an infinite pillar and the camera refuses to rise
        over a barrel.

        `base` is where it STARTS, and it exists because the cellar could not be
        expressed without it. Every solid used to run from a hard-coded -0.5
        upward, on the assumption that everything stands on the square -- so an
        underground wall with a top of -0.32 spanned 18 cm of sliver and the
        player walked straight through it into the earth.
        """
        self.solids.append((cx, cy, hx, hy, math.radians(yaw), top, base))

    def shaft(self, cx, cy, hx, hy, z0, z1, pad=0.0):
        """A volume the camera may be placed inside. See the note on
        `self.shafts`.

        `pad` is how far OUTSIDE the box the player may be and still count as
        being in this space. A stairwell needs it: the camera belongs in the
        well down the middle and the player is always on the stair around it.
        A room does not -- the box IS where the player is.
        """
        self.shafts.append((cx, cy, hx, hy, z0, z1, pad))

    def platform(self, cx, cy, hx, hy, top):
        """A surface ABOVE the analytic ground that the player can stand on.

        The meadow answers "where is the floor" from a closed-form terrain
        function rather than by raycasting, which is what made it playable -- but
        that function only knows about terrain. Anything standing on top of it
        has to be declared, or it is scenery you walk straight through.
        """
        self.platforms.append((cx, cy, hx, hy, top))

    def breakable(self, *objs):
        """A prop the player can smash, kept OUT of the join.

        Everything else is joined into two meshes so the draw count stays sane,
        and that is exactly why a barrel could not be broken: there is no way to
        hide one barrel inside a mesh containing all of them. These stay as
        their own objects -- a few extra draw calls each, spent on the only
        things in the town that respond to being hit.
        """
        group = [o for o in objs if o is not None]
        if not group:
            return None
        self.loose.extend(group)
        self.loose_groups.append(group)
        return group[0]

    def camblock(self, cx, cy, cz, r):
        """A sphere the CAMERA must not enter, and nothing else cares about.

        A tree's collision is a trunk-width box up to the trunk top, which is
        right for walking -- you should be able to stand under a canopy -- and
        leaves the camera nothing to stop on. Standing at the stream ford and
        looking down the path put the boom inside a canopy, and since the shell
        is an inverted hull the entire frame became flat dark green with the
        player nowhere in it. Reproduced byte-identical from a cold load.

        Widening the trunk's solid would fix the camera by making it impossible
        to walk under a tree, so the camera gets its own list.
        """
        self.camblocks.append((cx, cy, cz, r))

    def manifest(self):
        """Collision boxes in THREE.JS space (Blender x,y -> three x,-y).

        A yaw about Blender +Z maps to the same yaw about three +Y, and the
        half-extent along Blender Y becomes the half-extent along three Z."""
        return {
            "solids": [
                {"x": round(cx, 4), "z": round(-cy, 4),
                 "hx": round(hx, 4), "hz": round(hy, 4),
                 "yaw": round(yaw, 5), "top": round(top, 3),
                 "base": round(base, 3)}
                for cx, cy, hx, hy, yaw, top, base in self.solids],
            "platforms": [
                {"x": round(cx, 4), "z": round(-cy, 4),
                 "hx": round(hx, 4), "hz": round(hy, 4), "top": round(top, 3)}
                for cx, cy, hx, hy, top in self.platforms],
            "camBlockers": [
                {"x": round(cx, 3), "y": round(cz, 3), "z": round(-cy, 3),
                 "r": round(r, 3)}
                for cx, cy, cz, r in self.camblocks],
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


def yard(t, cx, cy, w, d, gate_y, gate_w=1.8, wall_h=2.9):
    """A walled working yard, reached down an alley you have to notice.

    THE FOURTH ROOM. The square, the roofs and the cellar are three; this is
    the one you find by looking at a gap between two buildings and wondering
    whether it goes anywhere. It is deliberately NOT visible from the plaza --
    the alley is 1.5 m wide and reads as a shadow between facades -- so the
    yard is a discovery rather than an extension of the square.

    A working yard rather than a garden: a well, a trough, a notice board, a
    woodpile. The plaza is where the town sells things; this is where it does
    them, which gives the two spaces different jobs rather than different
    furniture.

    `gate_y` is where the alley meets the west wall.
    """
    M, out = t.M, []
    x0, x1 = cx - w / 2, cx + w / 2
    y0, y1 = cy - d / 2, cy + d / 2
    W = 0.42

    # the ground. The plaza slab stops at x = 22, so this brings its own.
    t.walk(box("floor_yard", (cx, cy, -0.25), (w / 2 + 0.3, d / 2 + 0.3, 0.25),
               M["cobble_tex"], bevel=0.10, seg=1))

    def wall(nm, ax, ay, bx, by):
        mx, my = (ax + bx) / 2, (ay + by) / 2
        ex, ey = abs(bx - ax) / 2 + W / 2, abs(by - ay) / 2 + W / 2
        out.append(box(nm, (mx, my, wall_h / 2), (ex, ey, wall_h / 2),
                       M["stone"], bevel=0.05, seg=1))
        t.solid(mx, my, ex, ey, top=wall_h)
        # a coping course, so the top is a line and not a cut
        out.append(box(nm + "_cap", (mx, my, wall_h + 0.07),
                       (ex + 0.06, ey + 0.06, 0.07), M["stone"], bevel=0.03, seg=1))

    wall("yard_n", x0, y1, x1, y1)
    wall("yard_s", x0, y0, x1, y0)
    wall("yard_e", x1, y0, x1, y1)
    # the west wall is in two pieces, with the alley between them
    wall("yard_w1", x0, y0, x0, gate_y - gate_w / 2)
    wall("yard_w2", x0, gate_y + gate_w / 2, x0, y1)

    # THE ALLEY FLOOR, running west to meet the plaza between the two buildings
    t.walk(box("floor_alley", ((x0 - 1.6) / 1.0 * 0 + (x0 + 20.6) / 2, gate_y, -0.25),
               (abs(x0 - 20.6) / 2 + 0.3, gate_w / 2 + 0.4, 0.25),
               M["cobble_tex"], bevel=0.08, seg=1))

    well(t, cx + 1.4, cy + 1.2)
    trough(t, cx - 2.2, cy - 2.4, yaw=8)
    noticeboard(t, cx - 2.6, cy + 2.4, yaw=-24)
    # a woodpile: split logs stacked against the east wall, which is the one
    # thing in the build that says somebody here does work with their hands
    rnd = _lcg_local(4231)
    for row in range(4):
        for k in range(7):
            lx = x1 - 0.9 + (rnd() - 0.5) * 0.10
            ly = y0 + 1.4 + k * 0.30
            lz = 0.14 + row * 0.26
            o = K.tube(f"logpile{row}_{k}", K.dome([
                {"p": Vector((lx - 0.42, ly, lz)), "r": (0.125, 0.125), "n": 2.6},
                {"p": Vector((lx + 0.42, ly, lz)), "r": (0.115, 0.115), "n": 2.6},
            ], at="both", steps=2, height=0.04), seg=7, mat=M["timber"], squircle=2.6)
            out.append(o)
    t.solid(x1 - 0.9, y0 + 2.4, 0.55, 1.2, top=1.25)
    embercap(t, cx + 2.4, cy - 2.6)
    t.add(*out)


def _lcg_local(seed):
    """A tiny deterministic RNG, so the kit does not depend on a region's."""
    st = [seed & 0x7fffffff]

    def nxt():
        st[0] = (st[0] * 1103515245 + 12345) & 0x7fffffff
        return st[0] / 0x7fffffff
    return nxt


def cellar(t, hx0, hx1, hy0, hy1, floor_z=-3.0, ceil_z=-0.62):
    """A vaulted room under the square, reached by a stair down a wellhole.

    THE ONLY INTERIOR IN THE BUILD. Everything else is a facade with a painted
    door: nine buildings you can walk round and never into, so the town is one
    outdoor room however much furniture goes in it. An interior is the cheapest
    genuinely different SPACE available -- enclosed on six sides, lit by one
    lamp instead of the sun, quiet where the square is not -- and putting it
    underground costs no exterior footprint at all, which is the whole point
    when the brief is more places in the same square footage.

    It is also the best hiding place the town has. You cannot see it from
    anywhere; you find the hole.

    Returns the lamp position, so the runtime can hang a light there.
    """
    M, out = t.M, []
    # the room runs SOUTH from the stairwell, under the paving
    rx0, rx1 = hx0 - 1.6, hx1 + 1.6
    ry0, ry1 = hy0 - 6.4, hy1
    W = 0.45                                    # wall thickness

    t.walk(box("cellar_floor", ((rx0 + rx1) / 2, (ry0 + ry1) / 2, floor_z - 0.14),
               ((rx1 - rx0) / 2, (ry1 - ry0) / 2, 0.14), M["flagstone_tex"],
               bevel=0.03, seg=1))
    out.append(box("cellar_ceil", ((rx0 + rx1) / 2, (ry0 + ry1) / 2 - 0.6,
                                   ceil_z + 0.10),
                   ((rx1 - rx0) / 2, (ry1 - ry0) / 2 - 0.6, 0.10),
                   M["stone"], bevel=0.03, seg=1))

    # walls: three sides plus the two cheeks of the stairwell
    mid = (floor_z + ceil_z) / 2
    hh = (ceil_z - floor_z) / 2 + 0.1
    for nm, (cx, cy, ex, ey) in (
            ("cellar_w", (rx0 - W / 2, (ry0 + ry1) / 2, W / 2, (ry1 - ry0) / 2 + W)),
            ("cellar_e", (rx1 + W / 2, (ry0 + ry1) / 2, W / 2, (ry1 - ry0) / 2 + W)),
            ("cellar_s", ((rx0 + rx1) / 2, ry0 - W / 2, (rx1 - rx0) / 2 + W, W / 2)),
            ("cellar_nw", ((rx0 + hx0) / 2, ry1 + W / 2, (hx0 - rx0) / 2 + W, W / 2)),
            ("cellar_ne", ((hx1 + rx1) / 2, ry1 + W / 2, (rx1 - hx1) / 2 + W, W / 2))):
        out.append(box(nm, (cx, cy, mid), (ex, ey, hh), M["stone"], bevel=0.04, seg=1))
        t.solid(cx, cy, ex, ey, top=ceil_z + 0.3, base=floor_z - 0.4)

    # THE STAIR. Straight down the wellhole, treads as platforms so the runtime
    # can walk them -- the same trick the ladder uses, and for the same reason:
    # a step the collision cannot find is scenery.
    steps = 9
    for i in range(steps):
        u = (i + 0.5) / steps
        sz = -0.05 + (floor_z + 0.16) * u
        sy = hy1 - 0.35 - (hy1 - hy0 - 0.5) * u
        out.append(box(f"cellar_step{i}", ((hx0 + hx1) / 2, sy, sz - 0.09),
                       ((hx1 - hx0) / 2 - 0.28, (hy1 - hy0) / (2.2 * steps), 0.09),
                       M["stone"], bevel=0.02, seg=1))
        t.platform((hx0 + hx1) / 2, sy, (hx1 - hx0) / 2 - 0.28,
                   (hy1 - hy0) / (2.0 * steps), sz)

    # A PARAPET ON THREE SIDES, not a kerb.
    #
    # The first version was a 10 cm lip, which reads as an edging stone and
    # stops nothing: walking at the hole from the wrong side stepped over it and
    # dropped three metres onto the flagstones. A wellhole in a market square
    # would be walled, and a wall does the two jobs at once -- it says "hole"
    # from across the plaza, and it leaves exactly one way in, which is the
    # stair. The open side is the one the stair starts from.
    for nm, (cx, cy, ex, ey) in (
            ("kerb_w", (hx0 - 0.16, (hy0 + hy1) / 2, 0.16, (hy1 - hy0) / 2 + 0.32)),
            ("kerb_e", (hx1 + 0.16, (hy0 + hy1) / 2, 0.16, (hy1 - hy0) / 2 + 0.32)),
            ("kerb_s", ((hx0 + hx1) / 2, hy0 - 0.16, (hx1 - hx0) / 2 + 0.32, 0.16))):
        out.append(box(nm, (cx, cy, 0.26), (ex, ey, 0.30), M["stone"],
                       bevel=0.04, seg=1))
        t.solid(cx, cy, ex, ey, top=0.56)

    # the room is the camera's too: without this the boom snapped 2.24 m in a
    # single frame as you turned, because the only thing stopping it was a wall
    t.shaft((rx0 + rx1) / 2, (ry0 + ry1) / 2,
            (rx1 - rx0) / 2 - 0.5, (ry1 - ry0) / 2 - 0.5,
            floor_z - 0.2, ceil_z - 0.25, pad=ROOM_PAD)

    # what is down here: stores, a lamp, and something worth the trip
    for bx, by in ((rx0 + 0.9, ry0 + 0.9), (rx0 + 1.7, ry0 + 1.0),
                   (rx1 - 0.9, ry0 + 1.2)):
        barrel(t, bx, by, r=0.34, h=0.82, z0=floor_z)
    crate(t, rx1 - 1.0, ry0 + 2.3, s=0.40, yaw=12, z0=floor_z)
    lamp = lantern(t, (rx0 + rx1) / 2, ry0 + 1.4, z0=floor_z, h=2.05,
                   kind='interior')
    embercap(t, rx0 + 1.0, ry0 + 2.6, z=floor_z, scale=1.1)
    t.add(*out)
    return lamp


def rooftop(t, cx, cy, w, d, z, yaw=0.0, rail=True, name="roof"):
    """A flat walkable lead laid along a roof, with a low parapet.

    THE TOWN WAS ONE STOREY OF SPACE STACKED ON NOTHING. It has nine buildings,
    a gallery deck that leads nowhere, and a jump that clears a 1.1 m terrace --
    so the entire square is one room, and the only way to make it feel like more
    was to make it bigger. Roofs are the opposite trade: a second storey of
    PLACE inside exactly the same footprint, with a completely different read of
    the same square from above.

    A duckboard rather than a walkable pitch. Real slates are not a floor, and a
    plank run laid along the ridge is both how you would actually cross a roof
    and a shape the eye immediately understands as a route.
    """
    M, out = t.M, []
    out.append(box(f"{name}_lead", (cx, cy, z), (w / 2, d / 2, 0.055),
                   M["timber"], bevel=0.02, seg=1))
    # cross battens, so it reads as boards and not as a slab
    n = max(2, int(w / 0.75))
    for i in range(n):
        bx = cx - w / 2 + w * (i + 0.5) / n
        out.append(box(f"{name}_batten", (bx, cy, z - 0.05),
                       (0.05, d / 2 + 0.04, 0.035), M["timber"], bevel=0.01, seg=1))
    if rail:
        for sy in (-1, 1):
            out.append(box(f"{name}_rail", (cx, cy + sy * (d / 2 + 0.02), z + 0.34),
                           (w / 2, 0.035, 0.035), M["brass"], bevel=0.012, seg=1))
            m = max(2, int(w / 1.1))
            for i in range(m + 1):
                px = cx - w / 2 + w * i / m
                out.append(box(f"{name}_post", (px, cy + sy * (d / 2 + 0.02), z + 0.17),
                               (0.028, 0.028, 0.17), M["brass"], bevel=0.008, seg=1))
    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*out)
    # WALKABLE, not solid. `platform` is how anything above the analytic ground
    # tells the runtime it can be stood on.
    if yaw % 180 == 0:
        t.platform(cx, cy, w / 2, d / 2, z + 0.06)
    else:
        t.platform(cx, cy, d / 2, w / 2, z + 0.06)
    return out


def ladder(t, x, y, z0, z1, yaw=0.0, name="ladder"):
    """A way up. Rails and rungs, and a stack of `platform` steps behind them so
    the runtime's 45 cm step limit can actually climb it."""
    M, out = t.M, []
    h = z1 - z0
    for sx in (-1, 1):
        out.append(box(f"{name}_rail", (x + sx * 0.22, y, z0 + h / 2),
                       (0.045, 0.045, h / 2), M["timber"], bevel=0.015, seg=1))
    # THE PLATFORMS ARE MUCH BIGGER THAN THE RUNGS, and centred on the ladder.
    #
    # The first version put a 0.6 x 0.4 m platform behind each rung, which is a
    # foothold you slip off: walking into the ladder from the gallery deck got
    # about two thirds of the way up and then dropped. You climb this by walking
    # INTO it, so the standable area has to be forgiving enough that a player
    # who is also turning the camera stays on it -- the rung is the picture, the
    # platform is the promise.
    n = max(2, int(h / 0.30))
    for i in range(n):
        rz = z0 + h * (i + 0.5) / n
        out.append(box(f"{name}_rung", (x, y, rz), (0.22, 0.035, 0.025),
                       M["timber"], bevel=0.01, seg=1))
        t.platform(x, y, 0.60, 0.55, rz)
    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(x, y, 0))
    t.add(*out)
    return out


def plank(t, x0, y0, x1, y1, z, w=0.72, name="plank"):
    """A board bridging two roofs. The gap between buildings is the thing that
    makes a roof route read as a route rather than as a balcony."""
    M = t.M
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    span = math.hypot(x1 - x0, y1 - y0)
    a = math.degrees(math.atan2(y1 - y0, x1 - x0))
    o = box(name, (mx, my, z), (span / 2, w / 2, 0.05), M["timber"],
            bevel=0.02, seg=1)
    K.transform(o, rotate=(0, 0, a), around=(mx, my, 0))
    t.add(o)
    # the platform is axis-aligned and a little generous, because a plank you
    # fall off because the collision is a rotated box you cannot see is a plank
    # nobody crosses twice
    # 0.45 of margin, not 0.12. The platform is axis-aligned and the plank is
    # rotated, so a diagonal board's walkable box is inscribed rather than
    # matching -- and a bridge you fall off because the collision is a shape you
    # cannot see is a bridge nobody crosses twice.
    t.platform(mx, my, max(abs(x1 - x0) / 2, w / 2) + 0.45,
               max(abs(y1 - y0) / 2, w / 2) + 0.45, z + 0.05)
    return [o]


def well(t, cx, cy, r=0.86):
    """A wellhead: a drum of coursed stone, two posts, a beam and a bucket.

    A square with a fountain in it has ONE water feature and one silhouette in
    the middle distance. A well is the other thing a square has, it is small
    enough not to compete with the fountain, and its posts-and-beam is a
    vertical the plaza does not otherwise own below roof height.
    """
    M, out = t.M, []
    out.append(K.tube("well_drum", [
        {"p": Vector((cx, cy, 0.02)), "r": (r, r), "n": 3.0},
        {"p": Vector((cx, cy, 0.62)), "r": (r * 0.98, r * 0.98), "n": 3.0},
        {"p": Vector((cx, cy, 0.70)), "r": (r * 1.08, r * 1.08), "n": 3.0},
    ], seg=16, mat=M["stone"], squircle=3.0))
    # the shaft: a dark disc, because a well you can see the bottom of is a tub
    out.append(K.blob("well_dark", (cx, cy, 0.66), (r * 0.74, r * 0.74, 0.03),
                      None, M["timber"], seg=14, rings=6))
    for s_ in (-1, 1):
        out.append(box("well_post", (cx + s_ * r * 0.82, cy, 1.16),
                       (0.065, 0.065, 1.16), M["timber"], bevel=0.02, seg=1))
    out.append(box("well_beam", (cx, cy, 2.36), (r * 0.95, 0.075, 0.075),
                   M["timber"], bevel=0.02, seg=1))
    # a little pitched roof over the beam, which is what makes it read as a
    # well and not as gallows
    out.append(prism("well_roof", (cx, cy, 2.44), r * 2.1, 0.9, 0.34, M["roof_b"],
                     over_y=0.10, over_x=0.10))
    out.append(K.tube("well_rope", [
        {"p": Vector((cx, cy, 2.30)), "r": (0.014, 0.014), "n": 2.4},
        {"p": Vector((cx, cy, 1.42)), "r": (0.014, 0.014), "n": 2.4},
    ], seg=5, mat=M["timber"], squircle=2.4))
    out.append(K.tube("well_bucket", K.dome([
        {"p": Vector((cx, cy, 1.10)), "r": (0.17, 0.17), "n": 2.8},
        {"p": Vector((cx, cy, 1.38)), "r": (0.20, 0.20), "n": 2.8},
    ], at="start", steps=2, height=0.05), seg=10, mat=M["timber"], squircle=2.8))
    t.add(*out)
    t.solid(cx, cy, r * 1.1, r * 1.1, top=0.75)
    return out


def trough(t, cx, cy, yaw=0.0, w=1.9, d=0.62):
    """A horse trough with water in it. Long, low, and horizontal -- the plaza
    is full of uprights and round things and has almost nothing that lies
    along the ground."""
    M, out = t.M, []
    out.append(box("trough_body", (cx, cy, 0.30), (w / 2, d / 2, 0.30),
                   M["stone"], bevel=0.05, seg=1))
    out.append(box("trough_water", (cx, cy, 0.52),
                   (w / 2 - 0.09, d / 2 - 0.09, 0.03), M["water"], bevel=0.01, seg=1))
    for s_ in (-1, 1):
        out.append(box("trough_foot", (cx + s_ * (w / 2 - 0.22), cy, 0.05),
                       (0.16, d / 2 + 0.04, 0.05), M["stone"], bevel=0.02, seg=1))
    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*out)
    t.solid(cx, cy, w / 2 + 0.06, d / 2 + 0.06, yaw, top=0.62)
    return out


def noticeboard(t, x, y, yaw=0.0):
    """Posts, a board, a little roof and four pinned sheets.

    There is no text in this game, so this is not readable and is not meant to
    be: four pale rectangles at slight angles say "people leave messages here",
    which is a thing a town does, and the shape is unlike anything else in the
    square.
    """
    M, out = t.M, []
    for s_ in (-1, 1):
        out.append(box("notice_post", (x + s_ * 0.52, y, 0.86),
                       (0.055, 0.055, 0.86), M["timber"], bevel=0.02, seg=1))
    out.append(box("notice_board", (x, y, 1.34), (0.62, 0.045, 0.46),
                   M["timber"], bevel=0.02, seg=1))
    out.append(prism("notice_roof", (x, y, 1.82), 1.44, 0.34, 0.20, M["roof_a"],
                     over_y=0.08, over_x=0.08))
    for k, (dx, dz, a) in enumerate(((-0.30, 0.12, 3), (0.02, 0.16, -5),
                                     (0.31, 0.05, 7), (-0.14, -0.20, -2))):
        sheet = box(f"notice_sheet{k}", (x + dx, y - 0.05, 1.34 + dz),
                    (0.115, 0.006, 0.145), M["cloth"], bevel=0.004, seg=1)
        K.transform(sheet, rotate=(0, a, 0), around=(x + dx, y, 1.34 + dz))
        out.append(sheet)
    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(x, y, 0))
    t.add(*out)
    t.solid(x, y, 0.60, 0.16, yaw, top=1.9)
    return out


def stile(t, x, y, z, yaw=0.0):
    """Three steps up one side of a wall and three down the other.

    THE WALLS HAD ONE WAY THROUGH EACH and it was the road. That is correct for
    a road and wrong for a field: a boundary you can only cross where the map
    says makes the walls read as level geometry rather than as fences. A stile
    is the countryside's answer and it costs six boxes.
    """
    M, out = t.M, []
    for i, (dy, h) in enumerate(((-0.62, 0.30), (-0.26, 0.62), (0.0, 0.86),
                                 (0.26, 0.62), (0.62, 0.30))):
        out.append(box(f"stile{i}", (x, y + dy, z + h / 2),
                       (0.34, 0.13, h / 2), M["rock"], bevel=0.04, seg=1))
    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(x, y, 0))
    t.add(*out)
    # walkable, not solid: the point is to get OVER the wall
    for i, (dy, h) in enumerate(((-0.62, 0.30), (-0.26, 0.62), (0.0, 0.86),
                                 (0.26, 0.62), (0.62, 0.30))):
        t.platform(x, y + dy, 0.34, 0.13, z + h)
    return out


def camp(t, cx, cy, z, yaw=0.0):
    """A shepherd's fire ring, a lean-to and a crook. Nobody is home.

    Signs of use are cheaper than people and read at any distance: a ring of
    blackened stones says somebody sat here last night, which is a different
    statement from a ruin (somebody lived here once) and from a wall (somebody
    owns this).
    """
    M, out = t.M, []
    for i in range(9):
        a = 2 * math.pi * i / 9
        out.append(K.blob(f"camp_stone{i}",
                          (cx + math.cos(a) * 0.52, cy + math.sin(a) * 0.52, z + 0.07),
                          (0.15, 0.13, 0.10), None, M["rock"], seg=8, rings=5,
                          squircle=2.6))
    out.append(K.blob("camp_ash", (cx, cy, z + 0.03), (0.40, 0.40, 0.04),
                      None, M["timber"], seg=12, rings=5))
    # two charred logs across the ash, at an angle to each other
    for k, a in ((0, 0.4), (1, 1.9)):
        out.append(K.tube(f"camp_log{k}", K.dome([
            {"p": Vector((cx - math.cos(a) * 0.34, cy - math.sin(a) * 0.34, z + 0.10)),
             "r": (0.055, 0.055), "n": 2.6},
            {"p": Vector((cx + math.cos(a) * 0.34, cy + math.sin(a) * 0.34, z + 0.10)),
             "r": (0.045, 0.045), "n": 2.6},
        ], at="both", steps=2, height=0.03), seg=7, mat=M["timber"], squircle=2.6))
    # a lean-to: two poles, a ridge and a cloth pitched off it
    px, py = cx + 1.5, cy + 0.2
    for s_ in (-1, 1):
        out.append(K.tube(f"camp_pole{s_}", [
            {"p": Vector((px, py + s_ * 0.85, z)), "r": (0.05, 0.05), "n": 2.6},
            {"p": Vector((px, py + s_ * 0.85, z + 1.15)), "r": (0.04, 0.04), "n": 2.6},
        ], seg=7, mat=M["timber"], squircle=2.6))
    out.append(K.tube("camp_ridge", [
        {"p": Vector((px, py - 0.9, z + 1.15)), "r": (0.04, 0.04), "n": 2.6},
        {"p": Vector((px, py + 0.9, z + 1.15)), "r": (0.04, 0.04), "n": 2.6},
    ], seg=7, mat=M["timber"], squircle=2.6))
    out.append(prism("camp_cloth", (px + 0.34, py, z + 0.60), 1.5, 1.9, 0.55,
                     M["cloth"], over_y=0.05, over_x=0.05))
    out.append(K.tube("camp_crook", K.dome([
        {"p": Vector((px - 0.5, py - 0.7, z)), "r": (0.032, 0.032), "n": 2.6},
        {"p": Vector((px - 0.42, py - 0.7, z + 1.35)), "r": (0.026, 0.026), "n": 2.6},
    ], at="both", steps=2, height=0.03), seg=6, mat=M["timber"], squircle=2.6))
    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*out)
    t.solid(px + 0.3, py, 0.9, 1.0, yaw, top=z + 1.2)
    return out


def embercap(t, x, y, z=None, n=3, scale=1.0):
    """A cluster of glowing caps on a stalk. Break them for the only reward
    this demo has.

    WHY IT EXISTS. There was nothing to find. The ruin, the stone circle and
    the outcrop are all places worth walking to and all of them paid out
    exactly nothing when you arrived, so leaving the road was a thing you did
    once out of curiosity and never again. These are sited where the walk does
    NOT take you -- inside the ruin, in the middle of the ring, on the top
    shelf of the climb, behind the market -- and they are the only reason to go
    there other than looking.

    They reuse the breakables path rather than adding a pickup system: you hit
    them with the sword you already have, and they burst like the barrels do.
    A counter in the HUD is the whole of the UI.
    """
    M, out = t.M, []
    zz = 0.0 if z is None else z
    for i in range(n):
        a = 2.399 * i                      # golden angle: never a neat row
        r = (0.16 + 0.09 * (i % 2)) * scale
        px, py = x + math.cos(a) * r, y + math.sin(a) * r
        h = (0.30 + 0.10 * ((i * 7) % 3)) * scale
        out.append(K.tube(f"pod_stalk{i}", [
            {"p": Vector((px, py, zz)), "r": (0.026 * scale, 0.026 * scale), "n": 2.4},
            {"p": Vector((px, py, zz + h)), "r": (0.020 * scale, 0.020 * scale), "n": 2.4},
        ], seg=6, mat=M["timber"], squircle=2.4))
        out.append(K.blob(f"pod_cap{i}", (px, py, zz + h + 0.07 * scale),
                          (0.105 * scale, 0.105 * scale, 0.13 * scale), None,
                          M["pod"], seg=10, rings=7, squircle=2.2))
    # NAMED `pod`, because the runtime tells a treasure from a barrel by name
    t.breakable(*out)
    return out


def stall(t, cx, cy, yaw=0.0, kind=0, w=2.4, d=1.5):
    """A market stall: four poles, a striped canopy, a trestle and goods on it.

    THE SQUARE NEEDED A REASON TO EXIST. It has a fountain, nine facades and,
    since the hostiles were moved out of the town, nothing happening in it at
    all -- and a plaza is defined by what it is FOR. Stalls put activity at the
    centre instead of round the edges, they break the empty middle distance that
    made the paving read as a car park, and they give the player something to
    walk between rather than across.

    The canopy is `awning` material so it catches the wind with everything else.
    """
    M, out = t.M, []
    post_h = 2.05
    for sx in (-1, 1):
        for sy in (-1, 1):
            out.append(box("stall_post", (cx + sx * w / 2, cy + sy * d / 2, post_h / 2),
                           (0.045, 0.045, post_h / 2), M["timber"], bevel=0.015, seg=1))
    # a canopy with a ridge, not a flat sheet -- a flat sheet reads as a table
    # seen from above and the whole point is the silhouette from the side
    out.append(prism("stall_canopy", (cx, cy, post_h + 0.02), w + 0.42, d + 0.34, 0.34,
                     M["awning"], over_y=0.06, over_x=0.06))
    # scallops along the front edge, the same trick the shop awnings use
    n = max(3, int(w / 0.34))
    for i in range(n):
        sx = cx - (w + 0.3) / 2 + (w + 0.3) * (i + 0.5) / n
        out.append(K.blob("stall_scallop", (sx, cy - (d + 0.34) / 2, post_h + 0.02),
                          (0.17, 0.05, 0.13), None, M["awning"], seg=9, rings=6,
                          squircle=2.4))
    # trestle: a top and two cross-legs
    top_h = 0.86
    out.append(box("stall_board", (cx, cy, top_h), (w / 2 - 0.06, d / 2 - 0.16, 0.035),
                   M["timber"], bevel=0.015, seg=1))
    for sx in (-1, 1):
        out.append(box("stall_leg", (cx + sx * (w / 2 - 0.3), cy, top_h / 2),
                       (0.05, d / 2 - 0.2, top_h / 2), M["timber"], bevel=0.02, seg=1))
    # THE GOODS ARE THE SIGN. There is no text in this game, so what a stall
    # sells has to be readable as shape and colour from across the square.
    goods = [
        # (material, radius, rows) -- fruit, bread, cloth bolts, pots
        ("awning", 0.115, 3), ("timber", 0.135, 2),
        ("door", 0.125, 2), ("stone", 0.130, 3),
    ][kind % 4]
    mat, rr, rows = goods
    # ...AND THE GOODS COME APART. The town's only interactive things were four
    # barrels and a crate, all of them tucked against walls, so the square you
    # spend the most time in was the least responsive place in the build. A
    # stall you can knock the fruit off is the same swing you already have,
    # aimed at the one object in the plaza that is obviously loose.
    #
    # ONE breakable per stall, not one per item: `breakable` keeps a prop out of
    # the big join so the runtime can remove it, and nine loose blobs a stall
    # would be twenty-seven extra draw calls in the heaviest view in the game.
    # Hitting the display scatters the display, which is what you would expect
    # anyway.
    gd = []
    for i in range(rows * 3):
        gx = cx - w / 2 + 0.34 + (w - 0.68) * ((i % 3) + 0.5) / 3
        gy = cy - d / 2 + 0.42 + (d - 0.84) * ((i // 3) + 0.5) / max(1, rows)
        gd.append(K.blob("stall_goods", (gx, gy, top_h + rr * 0.8),
                         (rr, rr, rr * 0.85), None, M[mat], seg=10, rings=7,
                         squircle=2.4))
    for o in out + gd:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*out)
    t.breakable(*gd)
    # walk AROUND it, not through it -- the trestle is the obstacle, not the canopy
    t.solid(cx, cy, w / 2 - 0.1, d / 2 - 0.1, yaw, top=top_h + 0.1)
    return out


def washing(t, x0, y0, x1, y1, z, n=5, sag=0.34):
    """A line strung between two upper windows, with washing on it.

    Alleys and courtyards are vertical surfaces and empty air. A line across
    that air is the cheapest way to give the space a ceiling, and because the
    cloth is `awning` material it moves with the wind that everything else
    moves with -- which is most of why it is here rather than another planter.
    """
    M, out = t.M, []
    seg = 14
    rope = []
    for i in range(seg + 1):
        u = i / seg
        rope.append({"p": Vector((x0 + (x1 - x0) * u, y0 + (y1 - y0) * u,
                                  z - sag * math.sin(math.pi * u))),
                     "r": (0.014, 0.014), "n": 2.4})
    out.append(K.tube("wash_line", rope, seg=5, mat=M["timber"], squircle=2.4))
    tones = ["plaster_c", "door", "plaster_b", "awning", "plaster_a"]
    for k in range(n):
        u = (k + 0.7) / (n + 0.4)
        px = x0 + (x1 - x0) * u
        py = y0 + (y1 - y0) * u
        pz = z - sag * math.sin(math.pi * u)
        hh = 0.32 + 0.16 * ((k * 5) % 3)
        ww = 0.20 + 0.05 * ((k * 3) % 3)
        out.append(box("wash_cloth", (px, py, pz - hh / 2 - 0.02),
                       (ww, 0.012, hh / 2), M[tones[k % len(tones)]],
                       bevel=0.01, seg=1))
    t.add(*out)
    return out


def balcony(t, x, y0, z, w=1.05, reach=0.42):
    """A ledge and a railing off an upper window.

    UPPER FLOORS WERE ONE WINDOW REPEATED -- the same shuttered pane at the same
    spacing on every storey of every building, which is the thing that makes a
    town read as one recipe run nine times no matter how much the ground floors
    differ. A facade needs something that PROJECTS: the ground floor already has
    awnings and signs breaking its plane, and above the string course nothing
    did.

    `z` is the sill height of the window it belongs to.
    """
    M, out = t.M, []
    yb = y0 - reach / 2
    out.append(box("balc_slab", (x, yb, z - 0.06), (w / 2, reach / 2, 0.055),
                   M["stone"], bevel=0.02, seg=1))
    # two brackets under it, because a slab growing out of plaster is a shelf
    for s in (-1, 1):
        out.append(box("balc_bracket", (x + s * (w / 2 - 0.10), y0 - 0.13, z - 0.18),
                       (0.045, 0.13, 0.10), M["stone"], bevel=0.02, seg=1))
    rail_z = z + 0.28
    out.append(box("balc_rail", (x, y0 - reach + 0.03, rail_z),
                   (w / 2, 0.035, 0.035), M["brass"], bevel=0.012, seg=1))
    for s in (-1, 1):
        out.append(box("balc_rail_side", (x + s * w / 2, yb, rail_z),
                       (0.035, reach / 2, 0.035), M["brass"], bevel=0.012, seg=1))
    n = max(3, int(w / 0.19))
    for i in range(n):
        bx = x - w / 2 + w * (i + 0.5) / n
        out.append(box("balc_baluster", (bx, y0 - reach + 0.03, z + 0.11),
                       (0.018, 0.018, 0.20), M["brass"], bevel=0.006, seg=1))
    return t.add(*out) and out


def flowerbox(t, x, y0, z, w=0.70):
    """A planted box on a window sill.  `z` is the sill height.

    Three blooms and a trough. At the distance a second storey is ever seen this
    is four pixels of colour, which is the point: it is the only warm accent
    above the string course and it is what stops the upper facade being plaster
    and shutters and nothing else.
    """
    M, out = t.M, []
    yb = y0 - 0.11
    out.append(box("box_trough", (x, yb, z - 0.09), (w / 2, 0.09, 0.075),
                   M["timber"], bevel=0.02, seg=1))
    for i, (dx, dz, rr, mat) in enumerate((
            (-0.20, 0.05, 0.085, "leaf"), (0.02, 0.08, 0.095, "bloom"),
            (0.21, 0.04, 0.080, "leaf"))):
        out.append(K.blob(f"box_bloom{i}", (x + dx * (w / 0.70), yb, z + dz),
                          (rr, rr * 0.8, rr * 0.9), None,
                          M["awning"] if mat == "bloom" else M["leaf"],
                          seg=9, rings=6, squircle=2.2))
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


def lantern(t, x, y, z0=0.0, h=3.1, wall=False, kind='accent'):
    """A post lantern, or a bracket lamp when `wall` is set.  Emissive material;
    the runtime turns each of these into an actual point light.

    `kind` is 'accent' for a lamp on a sunlit street -- which should be almost
    nothing at midday -- or 'interior' for one the sun cannot reach, which has
    to actually light the room it is in.
    """
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
    # THE HEAD IS A CAGE, NOT A CARTON. It was a single bevelled box of the
    # unlit `lamp` material: at any distance a plain cream cube on a stick, and
    # up close a blown-out white slab with an outline round it. Four brass
    # uprights and a sill turn the same box into four glazed panes, which is
    # what makes it read as a lantern rather than as a missing texture -- and
    # they cost eight small boxes in a mesh that is joined by material anyway.
    out.append(box("lamp_glass", (x, y, zz - 0.12), (0.125, 0.125, 0.150),
                   M["lamp"], bevel=0.02, seg=1))
    out.append(box("lamp_sill", (x, y, zz - 0.28), (0.155, 0.155, 0.032),
                   M["brass"], bevel=0.02, seg=1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            out.append(box("lamp_mullion",
                           (x + sx * 0.128, y + sy * 0.128, zz - 0.12),
                           (0.022, 0.022, 0.152), M["brass"], bevel=0.006, seg=1))
    out.append(box("lamp_cap", (x, y, zz + 0.07), (0.175, 0.175, 0.045),
                   M["brass"], bevel=0.025, seg=1))
    out.append(K.blob("lamp_finial", (x, y, zz + 0.15), (0.055, 0.055, 0.075),
                      None, M["brass"], seg=10, rings=7))
    t.add(*out)
    # WHERE the light hangs, and WHAT JOB IT DOES. The runtime used to tell an
    # accent lamp from a room's only light source by testing whether it was
    # below the paving, which was true of the cellar and of nothing else. A
    # lamp twelve metres up a windowless shaft is just as much the only light
    # in the room, and no test on its height could say so.
    t.lights.append((x, y, zz - 0.12, kind))
    return (x, y, zz - 0.12, kind)


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


def barrel(t, x, y, r=0.34, h=0.82, z0=0.0):
    M = t.M
    # capped at both ends: an uncapped tube reads as an open bucket
    o = K.tube("barrel", K.dome([
        {"p": Vector((x, y, z0 + 0.02)), "r": (r * 0.88, r * 0.88), "n": 2.6},
        {"p": Vector((x, y, z0 + h * 0.5)), "r": (r, r), "n": 2.6},
        {"p": Vector((x, y, z0 + h)), "r": (r * 0.88, r * 0.88), "n": 2.6},
    ], at="both", steps=2, height=0.05), seg=12, mat=M["timber"], squircle=2.6)
    # a swept ring, not a box -- a square plate through a round barrel reads as
    # a plank nailed to it
    band = K.tube("barrel_band", [
        {"p": Vector((x, y, z0 + h * 0.5 - 0.05)), "r": (r * 1.04, r * 1.04), "n": 2.6},
        {"p": Vector((x, y, z0 + h * 0.5 + 0.05)), "r": (r * 1.04, r * 1.04), "n": 2.6},
    ], seg=12, mat=M["brass"], squircle=2.6)
    t.breakable(o, band)
    t.solid(x, y, r, r, top=z0 + h)
    return [o, band]


def crate(t, x, y, s=0.42, yaw=0.0, z0=0.0):
    M = t.M
    o = box("crate", (x, y, z0 + s), (s, s, s), M["timber"], bevel=0.05, seg=2)
    if yaw:
        K.transform(o, rotate=(0, 0, yaw), around=(x, y, 0))
    t.breakable(o)
    t.solid(x, y, s * 1.25, s * 1.25, yaw, top=z0 + s * 2)
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
             gable_front=False, room=False):
    """Assemble one building, front facing -Y, then yaw it into place.

    Everything is authored in ONE orientation and rotated at the end.  Trying to
    place windows in world space for eight differently-angled buildings is how
    facades end up subtly wrong, and it is unnecessary: the rotation is free.
    """
    M, out = t.M, []
    h = GROUND_H + FLOOR_H * (storeys - 1)
    y0 = -d / 2                                  # the facade plane
    bays = bays if bays is not None else max(1, int(w / 2.1))
    # WHERE THE FACADE ALREADY PUTS ITS DOOR. The ground-floor loop below sets
    # this from `bays // 2`, and when the ground storey is hollow the opening
    # has to be cut at exactly that x -- the first version cut it at the centre
    # of the wall instead, which for a four-bay building is 1.25 m off, so the
    # building came out with a real hole nobody had drawn a door round and a
    # painted door leaf standing in the wall beside it.
    door_x = -w / 2 + w * (bays // 2 + 0.5) / bays

    out.append(box("bld_plinth", (0, 0, 0.16), (w / 2 + 0.10, d / 2 + 0.10, 0.16),
                   M["stone"], bevel=0.05, seg=2))
    if not room:
        out.append(box("bld_body", (0, 0, h / 2 + 0.16), (w / 2, d / 2, h / 2),
                       M[plaster], bevel=0.06, seg=2))
    else:
        # THE GROUND STOREY IS HOLLOW, and only the ground storey. Everything
        # above it stays one solid block, which is most of the mass and all of
        # the silhouette -- nine facades do not change because one of them has
        # a room behind its door.
        #
        # The belltower is the template for all of this: four walls with a gap
        # in one of them, a floor declared as a platform, wall solids instead of
        # one footprint box, and a lamp near enough to matter. What is different
        # here is the size. The tower's shaft is 4.9 m across and the camera had
        # to be confined to a well; this room is 9.4 x 7.4, which is wider than
        # the boom is long, so the ordinary solve works.
        gz0, gz1 = 0.16, 0.16 + GROUND_H
        th = ROOM_WALL
        ix, iy = w / 2 - th, d / 2 - th          # the interior, in local space
        out.append(box("bld_body", (0, 0, (gz1 + h + 0.16) / 2),
                       (w / 2, d / 2, (h + 0.16 - gz1) / 2),
                       M[plaster], bevel=0.06, seg=2))
        for sx in (-1, 1):                        # the two side walls
            out.append(box("bld_wall_x", (sx * (ix + w / 2) / 2, 0, (gz0 + gz1) / 2),
                           (th / 2, d / 2, (gz1 - gz0) / 2), M[plaster],
                           bevel=0.05, seg=2))
        out.append(box("bld_wall_back", (0, (iy + d / 2) / 2, (gz0 + gz1) / 2),
                       (ix, th / 2, (gz1 - gz0) / 2), M[plaster], bevel=0.05, seg=2))
        # the front wall, split around the doorway
        for sgn in (-1, 1):
            edge = sgn * ix                      # the wall's own end
            near = door_x + sgn * ROOM_DOOR      # the near side of the opening
            out.append(box("bld_wall_front", ((edge + near) / 2, -(iy + d / 2) / 2,
                                              (gz0 + gz1) / 2),
                           (abs(edge - near) / 2, th / 2, (gz1 - gz0) / 2),
                           M[plaster], bevel=0.05, seg=2))
        lz = ROOM_FLOOR + ROOM_DOOR_H
        out.append(box("bld_lintel", (door_x, -(iy + d / 2) / 2, (lz + gz1) / 2),
                       (ROOM_DOOR, th / 2, (gz1 - lz) / 2), M[plaster],
                       bevel=0.05, seg=2))
        for sxx in (-1, 1):                       # a cut-stone surround
            out.append(box("bld_jamb", (door_x + sxx * (ROOM_DOOR + 0.09),
                                        -d / 2 + 0.02, (ROOM_FLOOR + lz) / 2),
                           (0.09, 0.07, (lz - ROOM_FLOOR) / 2), M["stone"],
                           bevel=0.03, seg=1))
        out.append(box("bld_jamb", (door_x, -d / 2 + 0.02, lz + 0.11),
                       (ROOM_DOOR + 0.18, 0.07, 0.14), M["stone"], bevel=0.03, seg=1))
        # THE FLOOR SITS ON THE PLINTH, at 0.32, not at the wall foot at 0.16 --
        # the plinth is a solid course 32 cm deep under the whole footprint, so
        # a floor at 0.16 would be buried in it. One step outside brings the
        # plaza up in two 16 cm rises instead of one 32 cm one, which the
        # runtime would allow and nobody would have authored.
        out.append(box("bld_floor", (0, 0, ROOM_FLOOR - 0.035), (ix, iy, 0.035),
                       M["flagstone_tex"] if "flagstone_tex" in M else M["stone"],
                       bevel=0.02, seg=1))
        out.append(box("bld_step", (door_x, -(d / 2 + 0.34), 0.08),
                       (ROOM_DOOR + 0.22, 0.24, 0.08), M["stone"], bevel=0.03, seg=1))

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
            # a hollow building has a real opening here, not a painted leaf
            if not room:
                out += doorway(t, bx, y0, 0.16)
            if shop:
                out += awning(t, bx, y0, 0.16 + 2.35, w=min(1.9, w / bays * 0.95))
                out += shopsign(t, bx + min(1.5, w / bays * 0.8), y0,
                                0.16 + 3.05, kind=seed)
        elif shop:
            out += shopfront(t, bx, y0, 0.16 + 1.55,
                             w=min(2.0, w / bays * 0.86), kind=seed)
            continue
        else:
            out += window(t, bx, y0, 0.16 + 1.75)

    # UPPER STOREYS. Every one of these used to be `window(t, bx, y0, z)` --
    # the same pane at the same spacing on every floor of all nine buildings,
    # which is the single thing that makes a town read as one recipe run nine
    # times no matter how much the ground floors differ. Three rules, all keyed
    # off the building's seed and the bay index so they are stable per building
    # and different between buildings:
    #
    #   * ONE BAY PER BUILDING gets a balcony, on the first floor only. It is
    #     the only thing above the string course that PROJECTS, and a facade
    #     needs something breaking its plane or the storey bands are doing all
    #     the work alone.
    #   * a couple of bays get a flower box -- four pixels of warm colour, and
    #     the only warm accent above the ground floor.
    #   * the TOP storey of a tall building gets short attic panes with no
    #     shutters, because the floor under a roof is a loft and lofts have
    #     smaller windows. This is what actually breaks the vertical repeat.
    for f in range(1, storeys):
        z = 0.16 + GROUND_H + FLOOR_H * (f - 1) + FLOOR_H * 0.52
        attic = (f == storeys - 1) and storeys >= 3
        wh = 0.66 if attic else 0.92
        balc_bay = (seed + 1) % bays
        for b in range(bays):
            bx = -w / 2 + w * (b + 0.5) / bays
            out += window(t, bx, y0, z, h=wh, shutters=not attic)
            if not attic and b == balc_bay and f == 1:
                out += balcony(t, bx, y0, z - wh / 2 - 0.10,
                               w=min(1.15, w / bays * 0.82))
            elif not attic and (b + seed) % 3 == 1:
                out += flowerbox(t, bx, y0, z - wh / 2 - 0.08,
                                 w=min(0.72, w / bays * 0.5))
            # the rear elevation is an alley: plainer, and no balcony over it
            out += window(t, bx, d / 2, z, h=wh, shutters=False)
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
    # THE BOX STOPS AT THE EAVES, NOT AT THE RIDGE.
    #
    # It used to run all the way to `h + 0.27 + roof_h`, which is the top of the
    # roof prism -- so the roof route was fenced off by the very buildings it
    # runs across: the player reached the landing at 8.46 m and could not walk
    # a step further, because a solid whose top is 8.50 blocks you at 8.46.
    # A collision box's job is to stop you walking INTO a building; the roof
    # above it is a separate surface with its own platforms, and it should be
    # possible to stand on one.
    if not room:
        t.solid(cx, cy, w / 2 + 0.10, d / 2 + 0.10, yaw, top=h + 0.20)
    else:
        # the block above the shop is solid from the ceiling up; the ground
        # storey gets four wall boxes with a gap where the door is
        gz1 = 0.16 + GROUND_H
        th, ix, iy = ROOM_WALL, w / 2 - ROOM_WALL, d / 2 - ROOM_WALL
        c_, s_ = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))

        def put(dx, dy, hx, hy, top, base):
            t.solid(cx + dx * c_ - dy * s_, cy + dx * s_ + dy * c_,
                    hx, hy, yaw, top=top, base=base)

        put(0, 0, w / 2 + 0.10, d / 2 + 0.10, h + 0.20, gz1)
        for sx in (-1, 1):
            put(sx * (ix + w / 2) / 2, 0, th / 2 + 0.06, d / 2, gz1, -0.5)
        put(0, (iy + d / 2) / 2, ix, th / 2 + 0.06, gz1, -0.5)
        for sgn in (-1, 1):
            edge, near = sgn * ix, door_x + sgn * ROOM_DOOR
            put((edge + near) / 2, -(iy + d / 2) / 2,
                abs(edge - near) / 2, th / 2 + 0.06, gz1, -0.5)
        # closed again above the lintel, so the doorway is a doorway
        put(door_x, -(iy + d / 2) / 2, ROOM_DOOR, th / 2 + 0.06, gz1,
            ROOM_FLOOR + ROOM_DOOR_H)
        t.platform(cx, cy, ix - 0.05, iy - 0.05, ROOM_FLOOR)
        # and the room is where the camera lives while you are in it: 3.53 m of
        # single-frame lurch without this, because rotating toward the doorway
        # let the boom out into the square and rotating back snapped it home
        t.shaft(cx, cy, ix - 0.55, iy - 0.55, ROOM_FLOOR - 0.2, gz1 - 0.30,
                pad=ROOM_PAD)
        t.platform(cx + door_x * c_ + (d / 2 + 0.34) * s_,
                   cy + door_x * s_ - (d / 2 + 0.34) * c_,
                   ROOM_DOOR + 0.22, 0.24, 0.16)
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
    loose = {id(o) for o in t.loose}
    floors, others, seen = [], [], set()
    for o in t.parts:
        if id(o) in seen or id(o) in loose:
            continue
        seen.add(id(o))
        (floors if id(o) in walkable else others).append(o)

    floor_obj = K.join(floors, name_floor)
    town_obj = K.join(others, name_town)
    # Breakables are joined PER PROP -- a barrel is one object made of a body
    # and two bands, and the runtime wants to remove the barrel, not the bands.
    # They are left on the Town as `props` rather than returned, because both
    # region builders already unpack exactly two values here, and because the
    # thing the caller has to remember is to SELECT them for export: the export
    # is scoped to a selection, so an unselected prop is silently absent from
    # the GLB and the runtime reports "0 breakable" with nothing else wrong.
    t.props = [K.join(group, f"BREAK_{group[0].name}_{i}")
               for i, group in enumerate(t.loose_groups)]
    return town_obj, floor_obj


# THE TOWER IS SIZED BY THE CAMERA, and that is the whole reason these numbers
# are what they are.
#
# The first hollow version used the tower's existing 5.2 m footprint, which
# leaves a 3.6 m room inside. That is a perfectly good stairwell and a
# completely unusable one: the boom collapsed to 0.5-0.75 m against the walls,
# which is inside the character, and every capture of the climb was a
# full-frame close-up of plaster. A third-person camera needs about three
# metres of clearance behind the player, so an interior it has to work in
# cannot be much narrower than five.
#
# So the shaft was sized outward from that, and the tower around the shaft --
# 6.6 m across the base for a 4.9 m room. It reads as a stouter tower than it
# was, which the silhouette can afford at 20 m tall, and it is the right trade:
# a landmark you can climb beats a slimmer one you can only look at.
TOWER_INNER  = 2.45     # half-width of the shaft's interior, constant all the
                        # way up while the OUTSIDE tapers -- which is how real
                        # towers are built, and which means the stair does not
                        # have to get narrower as you climb
TOWER_FLIGHT = 1.28     # width of a flight. 0.85 looked ample on paper and was
                        # not: the balustrade stands on the tread's inner 10 cm
                        # and the character is 0.64 m across, so what was left
                        # between the rail and the wall was an ELEVEN CENTIMETRE
                        # corridor for her centre -- a stair you would scrape
                        # your way up. Walking the geometry said so; looking at
                        # the number 0.85 next to the number 0.64 did not.
TOWER_TAPER  = 0.040    # per storey. It was 0.055, which over five storeys
                        # takes 22% off the width -- fine on a solid shaft, and
                        # on a hollow one it thins the top storey's wall to
                        # three centimetres, because the inside does not taper.
TOWER_TREADS = 5        # treads per flight, four flights to a storey


def _sill(t, out, cx, cy, inner, px, py, hx, ztop, k, j):
    """A waist-high parapet where the stair runs along the OPEN face.

    An arcade you can walk out of is a hole. The rail on the well side is
    generated per tread because the stair is stepped; this is the same thing on
    the other side, and only where the wall it would lean against is missing --
    which is the +y face, above the ground storey.
    """
    c = inner - TOWER_FLIGHT / 2
    if abs(py - c) > 1e-6 or ztop < 4.39:
        return                  # not against the open face, or still inside it
    y = cy + inner - 0.13       # at the outer lip of the tread
    out.append(box(f"tower_sill{k}_{j}", (cx + px, y, ztop + 0.48),
                   (hx, 0.10, 0.48), t.M["stone"], bevel=0.02, seg=1))
    t.solid(cx + px, y, hx, 0.10, 0.0, top=ztop + 0.96, base=ztop - 0.3)


def belltower(t, cx, cy, base=2.35, storeys=4, yaw=0.0, hollow=True):
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

    AND YOU CAN GO IN IT.  It was a twenty-metre landmark you could only ever
    look at, which is close to the complaint an audit made about the whole
    town: that its vertical vocabulary was something to see rather than
    somewhere to be.  `hollow` opens the shaft, puts a door on the plaza face
    and runs a square-spiral stair up the inside to the belfry, so the tallest
    thing in the level is also the one place you can stand and see the whole of
    it -- the square below, the roof route across it, the road out, the ford,
    and the stone circle at the far end of the meadow.

    The climb is deliberately its own KIND of space rather than more of the
    town.  Everything else in the demo is wide, sunlit and horizontal; this is
    narrow, dark, and the only way through it is up.  It costs a lamp at every
    landing and an open well down the middle that you can see the whole way
    down.
    """
    M, out = t.M, []
    shaft_h = 3.9 * storeys

    out.append(box("tower_plinth", (cx, cy, 0.22), (base + 0.34, base + 0.34, 0.22),
                   M["stone"], bevel=0.06, seg=2))

    floor_z = 0.44                      # the interior floor is the plinth top
    inner = TOWER_INNER

    # A STOOP, because the plinth is 44 cm and the step limit is 45. That
    # clears it by a centimetre, which is not a doorway -- it is a bug that
    # happens to pass. Two authored steps and it is a threshold instead.
    if hollow:
        for si, sz in enumerate((0.15, 0.30)):
            sd = 0.62 - 0.24 * si
            out.append(box(f"tower_stoop{si}", (cx, cy + base + sd / 2, sz / 2 + 0.001),
                           (1.05, sd / 2, sz / 2), M["stone"], bevel=0.03, seg=1))
            t.platform(cx, cy + base + sd / 2, 1.05, sd / 2, sz)
        t.platform(cx, cy, inner, inner, floor_z)          # the ground room

    # the shaft TAPERS, which is most of why a tall box reads as a tower rather
    # than as a chimney: each stage is a little narrower than the one under it
    for i in range(storeys):
        z0 = 0.44 + 3.9 * i
        w = base * (1.0 - TOWER_TAPER * i)
        if not hollow:
            out.append(box(f"tower_stage{i}", (cx, cy, z0 + 1.95), (w, w, 1.95),
                           M["plaster_c"], bevel=0.07, seg=2))
        else:
            # FOUR WALLS. The x pair spans the full depth and the y pair only
            # the inner span, so they meet at the corners without overlapping.
            th = (w - inner) / 2
            # ASHLAR, NOT PLASTER. The shaft used to be `plaster_c`, which is
            # also the house immediately east of it -- so the town's one
            # landmark was the same colour and the same surface as its
            # neighbour, and an audit called it an untextured grey box. It is
            # dressed stone now: regular coursed blocks against the plastered
            # ranges, which is how a civic building has always been told apart
            # from the houses around it.
            for sx in (-1, 1):
                out.append(box(f"tower_wx{i}", (cx + sx * (inner + w) / 2, cy, z0 + 1.95),
                               (th, w, 1.95), M["stone"], bevel=0.05, seg=2))
            # THE PLAZA FACE IS AN ARCADE ABOVE THE DOOR, and this is the single
            # change that made the interior work at all.
            #
            # A closed 4.9 m shaft is still narrower than a third-person camera
            # needs. Widening got the boom from 0.7 m to 1.9, which is better
            # and still a full-frame close-up of the player's back -- and in a
            # CORNER, which a spiral stair puts you in every few seconds, no
            # width helps, because the camera is jammed into two walls at once.
            # The boom has to be able to leave the building.
            #
            # So the face you see from the square is open from the first floor
            # up: two tall openings either side of a central pier. It pays for
            # itself four times over. The camera swings out into open air. The
            # stair is lit by daylight instead of by five point lights doing an
            # impression of it. The climb is VISIBLE from the plaza, so the
            # tower advertises what it is without a marker or a line of dialogue.
            # And the elevation stops being a grey box, which is what an audit
            # called it.
            #
            # The ground storey stays solid -- the base reads as a base, and the
            # first flight is behind it.
            for sy in (-1, 1):
                if sy > 0 and i == 0:
                    continue            # the +y wall of the ground storey is the doorway
                if sy > 0 and hollow:
                    # central pier, and a header across the top so the openings
                    # read as arcaded rather than as a missing wall
                    out.append(box(f"tower_pier{i}", (cx, cy + (inner + w) / 2, z0 + 1.70),
                                   (0.26, th, 1.70), M["stone"], bevel=0.04, seg=2))
                    t.solid(cx, cy + (inner + w) / 2, 0.26, th, yaw, top=z0 + 3.40, base=z0)
                    out.append(box(f"tower_head{i}", (cx, cy + (inner + w) / 2, z0 + 3.65),
                                   (inner, th, 0.25), M["stone"], bevel=0.04, seg=2))
                    t.solid(cx, cy + (inner + w) / 2, inner, th, yaw,
                            top=z0 + 3.90, base=z0 + 3.40)
                    continue
                out.append(box(f"tower_wy{i}", (cx, cy + sy * (inner + w) / 2, z0 + 1.95),
                               (inner, th, 1.95), M["stone"], bevel=0.05, seg=2))
            if i == 0:
                door_h, dh = 2.45, 0.95         # dh = half-width of the opening
                for sxx in (-1, 1):
                    out.append(box("tower_wy0", (cx + sxx * (inner + dh) / 2,
                                                 cy + (inner + w) / 2, z0 + 1.95),
                                   ((inner - dh) / 2, th, 1.95), M["stone"],
                                   bevel=0.05, seg=2))
                lz0 = floor_z + door_h
                out.append(box("tower_dlintel", (cx, cy + (inner + w) / 2,
                                                 (lz0 + z0 + 3.9) / 2),
                               (dh, th, (z0 + 3.9 - lz0) / 2), M["stone"],
                               bevel=0.05, seg=2))
                # a cut-stone surround, so the opening reads as a door and not
                # as a hole where the plaster stopped
                out.append(box("tower_djamb", (cx, cy + w - 0.02, lz0 + 0.11),
                               (dh + 0.18, 0.07, 0.15), M["stone"], bevel=0.03, seg=1))
                for sxx in (-1, 1):
                    out.append(box("tower_djamb", (cx + sxx * (dh + 0.09), cy + w - 0.02,
                                                   floor_z + door_h / 2),
                                   (0.09, 0.07, door_h / 2), M["stone"], bevel=0.03, seg=1))
        # string course: the shadow line that separates the stages
        # ON A STONE SHAFT THE COURSE HAS TO BE THE THING THAT IS NOT STONE.
        # It was stone on plaster, where it read as a shadow line dividing the
        # storeys; stone on stone is invisible, and the taper alone is too
        # gradual to say where one stage ends.
        out.append(box(f"tower_course{i}", (cx, cy, z0 + 3.90),
                       (w + 0.15, w + 0.15, 0.12),
                       M["plaster_c"] if hollow else M["stone"], bevel=0.03, seg=1))
        # a narrow slit window per stage, alternating faces so it reads as lived-in
        for s in (-1, 1):
            if (i + (s > 0)) % 2:
                continue
            out.append(box(f"tower_slit{i}", (cx + s * (w + 0.02), cy, z0 + 2.15),
                           (0.05, 0.16, 0.62), M["door"], bevel=0.02, seg=1))

    # the belfry: four corner piers with the sky showing between them, which is
    # what makes the top read as open rather than as one more solid stage
    top = 0.44 + 3.9 * storeys
    bw = base * (1.0 - TOWER_TAPER * (storeys - 1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            out.append(box("tower_pier", (cx + sx * (bw - 0.22), cy + sy * (bw - 0.22),
                                          top + 1.15),
                           (0.22, 0.22, 1.15), M["stone"], bevel=0.04, seg=2))
    # THE BELFRY FLOOR HAS A HOLE IN IT, because the stair arrives through it.
    # Four slabs around the opening, the same way the plaza is four slabs around
    # the cellar mouth -- a floor you cannot come up through is a floor that
    # makes the whole climb end in a ceiling.
    belfry_top = top + 0.21
    if hollow:
        # The opening is the LAST FLIGHT'S CORRIDOR -- the strip of floor the
        # stair comes up through -- so you emerge onto the belfry by stepping
        # off the flight to either side of it. Cutting a square out of a corner
        # instead leaves centimetre slivers of open floor at the top of a
        # twenty-metre drop, which is a trap authored by arithmetic.
        cc = TOWER_INNER - TOWER_FLIGHT / 2
        hy0, hy1 = cy + cc - TOWER_FLIGHT / 2 - 0.02, cy + cc + TOWER_FLIGHT / 2 + 0.02
        hx1 = cx + cc - TOWER_FLIGHT / 2
        for nm, (ax0, ax1, ay0, ay1) in {
            "n": (cx - bw, cx + bw, cy - bw, hy0),
            "s": (cx - bw, cx + bw, hy1, cy + bw),
            "e": (hx1, cx + bw, hy0, hy1),
        }.items():
            if ax1 - ax0 < 1e-3 or ay1 - ay0 < 1e-3:
                continue
            out.append(box(f"tower_belfry_floor_{nm}",
                           ((ax0 + ax1) / 2, (ay0 + ay1) / 2, top + 0.08),
                           ((ax1 - ax0) / 2, (ay1 - ay0) / 2, 0.13),
                           M["stone"], bevel=0.03, seg=1))
            t.platform((ax0 + ax1) / 2, (ay0 + ay1) / 2,
                       (ax1 - ax0) / 2, (ay1 - ay0) / 2, belfry_top)
    else:
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

    lamps = []
    if hollow:
        fw = TOWER_FLIGHT
        # A PARAPET ROUND THE BELFRY, at 0.92 m -- high enough that you cannot
        # walk off a twenty-metre drop, low enough to see the whole level over.
        # The kerb round the cellar mouth taught this one: a lip you can step
        # over is not a railing, it is a trip hazard with the same geometry.
        for sx, sy, ex, ey in ((0, -1, bw, 0.10), (0, 1, bw, 0.10),
                               (-1, 0, 0.10, bw), (1, 0, 0.10, bw)):
            px, py = cx + sx * bw, cy + sy * bw
            out.append(box("tower_belfry_rail", (px, py, belfry_top + 0.46),
                           (ex, ey, 0.46), M["stone"], bevel=0.04, seg=1))
            t.solid(px, py, ex, ey, yaw, top=belfry_top + 0.92, base=belfry_top - 0.2)

        # THE WELL, declared to the runtime as camera space. Inset from the
        # stair's inner edge so the near plane never touches a balustrade.
        # It starts ABOVE the ground room and ends BELOW the belfry floor,
        # because both of those are rooms rather than shaft: the room has a door
        # for the boom to go out of and the belfry is open sky, and confining
        # the camera in either one takes a working 4.8 m shot down to 1.6.
        t.shaft(cx, cy, inner - fw - 0.14, inner - fw - 0.14,
                floor_z + 0.5, belfry_top - 1.0, pad=2.6)
        # THE GROUND ROOM AND THE BELFRY ARE ROOMS, not shaft, and they were
        # getting no help at all. Measured by dragging the camera through one
        # revolution: the worst single-frame move was 1.21 m in the ground room
        # and 6.30 m in the belfry, where turning past a pier hands the boom
        # open sky and it teleports out to full extension. The stair, which has
        # had a volume all along, was the best indoor spot in the build at 0.43.
        t.shaft(cx, cy, inner - 0.45, inner - 0.45, floor_z - 0.2, floor_z + 3.3,
                pad=ROOM_PAD)
        # THE BELFRY'S CLEAR VOLUME IS SMALLER THAN IT LOOKS, in both axes, and
        # I got it wrong twice by eye before measuring. Horizontally it stops
        # inside the corner PIERS (bw - 0.22, half-width 0.22), not at the
        # parapet. Vertically it stops under the LINTEL that rings the pier
        # tops at top + 2.38 with a 0.16 half-height -- so the ceiling is
        # top + 2.22, not the cap at top + 2.54. A camera pinned at the old
        # y1 sat inside that beam and every frame came back flat outline colour.
        t.shaft(cx, cy, bw - 0.78, bw - 0.78,
                belfry_top - 0.3, top + 2.10, pad=ROOM_PAD)

        # THE BELL ROPE, and it is the best thing in the tower for its cost.
        #
        # A twenty-metre shaft needs something that expresses twenty metres. The
        # stair does not: you only ever see one flight of it. A rope hanging the
        # whole height does, and it is visible from the ground room, from every
        # landing, and from the belfry looking down -- one object that ties the
        # space together and tells you what the building is FOR.
        #
        # It hangs from the underside of the belfry floor rather than from the
        # bell, which is both how a guided rope looks from below and the reason
        # no hole has to be cut in a floor that is four slabs around a stair.
        #
        # Sited at 1.10 from the axis, which is inside the well and OUTSIDE the
        # box the camera is clamped to (1.03). A rope the camera can sit on is a
        # brown wall across the frame once per revolution.
        rx, ry = cx - 1.10, cy - 1.10
        out.append(K.tube("tower_rope", [
            {"p": Vector((rx, ry, belfry_top - 0.16)), "r": (0.028, 0.028), "n": 2.2},
            {"p": Vector((rx, ry, floor_z + 3.10)), "r": (0.028, 0.028), "n": 2.2},
            # the sally: the woolly grip a ringer actually holds, and the one
            # part of a bell rope anybody recognises
            {"p": Vector((rx, ry, floor_z + 2.55)), "r": (0.062, 0.062), "n": 2.4},
            {"p": Vector((rx, ry, floor_z + 1.60)), "r": (0.062, 0.062), "n": 2.4},
            {"p": Vector((rx, ry, floor_z + 1.42)), "r": (0.026, 0.026), "n": 2.2},
        ], seg=6, mat=M["timber"], squircle=2.3, up=(0, 1, 0)))
        out.append(box("tower_ropeeye", (rx, ry, belfry_top - 0.10),
                       (0.07, 0.07, 0.06), M["brass"], bevel=0.02, seg=1))

        # THE GROUND ROOM IS A ROOM. It was 4.9 m of empty floor you crossed on
        # the way to the stair -- the first interior in the demo and the least
        # furnished thing in it.
        # A LAMP IN THE ROOM ITSELF. The stair's lanterns start at the first
        # landing three metres up, so the ground floor was lit by whatever came
        # through the door -- and the toon ramp has one dark band, so every
        # timber thing in here (bench, crate, two barrels) came out as a black
        # silhouette with brass hoops floating on it. Stone reads in shadow
        # because stone is pale; timber does not.
        # AMONG THE STORES, not across the room from them. The toon ramp is a
        # hard step, so a point light does nothing at all until it crosses the
        # threshold -- at 3 m and decay 2 it did not, and the bench, crate and
        # both barrels stayed exactly as black as they were unlit. Half the
        # distance is four times the light.
        lantern(t, cx + 0.05, cy - inner + 0.40, z0=floor_z, h=2.15,
                kind='interior')

        bench_x = cx - inner + 0.30
        out.append(box("tower_bench", (bench_x, cy - 0.35, floor_z + 0.21),
                       (0.26, 0.85, 0.21), M["timber"], bevel=0.03, seg=1))
        t.solid(bench_x, cy - 0.35, 0.26, 0.85, yaw, top=floor_z + 0.42, base=floor_z)
        for bx, by, br in ((cx - 1.45, cy - 1.55, 0.33), (cx - 0.78, cy - 1.90, 0.29)):
            barrel(t, bx, by, r=br, h=0.78, z0=floor_z)
        crate(t, cx + 0.35, cy - 1.85, s=0.36, yaw=-11, z0=floor_z)

        # ---------------------------------------------------------- the stair
        #
        # A SQUARE SPIRAL, four flights and four corner landings to a storey.
        # Round would be more picturesque and would also be the wrong shape: the
        # runtime stands you on axis-aligned rectangles, so a square spiral is
        # the form where what you see and what you can stand on are the same
        # object rather than an approximation of each other.
        c = inner - fw / 2                          # landing centre offset
        # Visited in this order, which turns AWAY from the door -- the ground
        # room is entered from +y and the stair starts on the +x side, so you
        # step in, and the way up is immediately on your right.
        corners = [(c, c), (c, -c), (-c, -c), (-c, c)]
        flights = 4 * storeys
        per = (belfry_top - floor_z) / flights      # rise per flight
        rise = per / TOWER_TREADS
        assert rise < 0.44, f"tower riser {rise:.3f} m is over the step limit"
        # `flights + 1` landings for `flights` flights, because the last flight
        # has to ARRIVE somewhere. Without the closing one the top tread ended
        # five centimetres short of the belfry floor -- a sliver of open air at
        # the top of a twenty-metre drop, which is the exact trap the comment
        # above this says the corridor-shaped opening exists to avoid. Walking
        # the geometry found it; reading it did not.
        for k in range(flights + 1):
            a, b = corners[k % 4], corners[(k + 1) % 4]
            za = floor_z + k * per
            # the landing
            out.append(box(f"tower_land{k}", (cx + a[0], cy + a[1], za - 0.09),
                           (fw / 2, fw / 2, 0.09), M["stone"], bevel=0.02, seg=1))
            t.platform(cx + a[0], cy + a[1], fw / 2 + 0.03, fw / 2 + 0.03, za)
            _sill(t, out, cx, cy, inner, a[0], a[1], fw / 2, za, k, 'L')
            # THE LANDINGS GET NO RAIL OF THEIR OWN, and the reason is worth
            # writing down because the obvious move is wrong. A corner landing
            # looks open on two sides, so I railed both -- and fenced every
            # landing off from the two flights that meet there, because those
            # two sides ARE the flights. The well is one 1.7 m square in the
            # middle, and the four flights' rails already run its whole
            # perimeter; the corners where they meet are guarded twice over.
            if k == flights:
                break                       # the arrival landing has no flight
            # A LAMP EVERY FULL TURN, tucked into the corner of the landing --
            # in the middle it is a post you walk through, which is worse than
            # no post at all. These are the only light in the shaft: the slit
            # windows are surface detail on the outside face, and a stair lit
            # only by what leaks past the door is a black rectangle.
            if k % 4 == 1:
                lamps.append(lantern(t, cx + a[0] * 1.16, cy + a[1] * 1.16,
                                     z0=za, h=1.75, kind='interior'))
            ax = 0 if abs(b[0] - a[0]) > 1e-6 else 1
            sgn = 1.0 if b[ax] > a[ax] else -1.0
            going = (abs(b[ax] - a[ax]) - fw) / TOWER_TREADS
            u0 = a[ax] + sgn * fw / 2
            # which side of the flight is the open well: the wall is on the side
            # the flight runs along, so the drop is on the other one
            other = 1 - ax
            wellside = -1.0 if a[other] > 0 else 1.0
            for j in range(TOWER_TREADS):
                zt = za + rise * (j + 1)
                u = u0 + sgn * going * (j + 0.5)
                px = cx + (u if ax == 0 else a[0])
                py = cy + (u if ax == 1 else a[1])
                hx = going / 2 if ax == 0 else fw / 2
                hy = going / 2 if ax == 1 else fw / 2
                out.append(box(f"tower_tread{k}_{j}", (px, py, zt - 0.10),
                               (hx, hy, 0.10), M["stone"], bevel=0.02, seg=1))
                # THE PLATFORM IS WIDER THAN THE TREAD, by three centimetres a
                # side. Same promise the ladder rungs make: the tread is the
                # picture and the platform is what you actually stand on, and a
                # player turning the camera on a spiral stair over a twenty
                # metre well should not be punished for a rounding error.
                t.platform(px, py, hx + 0.03, hy + 0.03, zt)
                # a stepped balustrade on the well side -- solid, so the well is
                # something you look down rather than something you fall down
                bpx = px + (wellside * (fw / 2 - 0.05) if other == 0 else 0.0)
                bpy = py + (wellside * (fw / 2 - 0.05) if other == 1 else 0.0)
                bhx = going / 2 if ax == 0 else 0.05
                bhy = going / 2 if ax == 1 else 0.05
                out.append(box(f"tower_bal{k}_{j}", (bpx, bpy, zt + 0.28),
                               (bhx, bhy, 0.28), M["stone"], bevel=0.02, seg=1))
                t.solid(bpx, bpy, bhx, bhy, yaw, top=zt + 0.56, base=zt - 0.3)
                _sill(t, out, cx, cy, inner, px - cx, py - cy, hx, zt, k, j)

    if hollow:
        # WHAT THE CLIMB IS FOR. Every other detour in the demo pays an
        # embercap -- the ruin, the stone ring, the outcrop, the far copse, the
        # ford bank, the cellar, the roof route -- and the tallest one in it
        # paid nothing.
        embercap(t, cx + bw - 0.85, cy - bw + 0.75, z=belfry_top, scale=1.1)

    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*out)
    if hollow:
        # FOUR WALL SOLIDS, NOT ONE BLOCK. The tower used to declare its whole
        # footprint solid to the full height of the shaft, which is exactly the
        # bug that fenced the buildings off from their own roofs: a collider
        # authored from the outside, describing a thing that has an inside.
        # PER STOREY, so the collision follows the taper. One shell sized to the
        # widest course would stand up to 0.6 m proud of the wall you can see at
        # the top of the tower, which is nothing to walk into but is something
        # for the camera to hit in mid-air.
        dh = 0.95
        for i in range(storeys):
            z0, z1 = 0.44 + 3.9 * i, 0.44 + 3.9 * (i + 1)
            w = base * (1.0 - TOWER_TAPER * i)
            th = (w - inner) / 2
            for sx in (-1, 1):
                t.solid(cx + sx * (inner + w) / 2, cy, th, w, yaw, top=z1, base=z0)
            t.solid(cx, cy - (inner + w) / 2, inner, th, yaw, top=z1, base=z0)
            if i:
                pass            # the plaza face is an arcade; its pier and head
                                # declare their own solids where they are built
            else:
                # the ground storey's +y wall is split around the doorway, and
                # closed again above the lintel so the first flight cannot walk
                # out through the top of the door into open air
                for sx in (-1, 1):
                    t.solid(cx + sx * (inner + dh) / 2, cy + (inner + w) / 2,
                            (inner - dh) / 2, th, yaw, top=z1, base=z0)
                t.solid(cx, cy + (inner + w) / 2, dh, th, yaw,
                        top=z1, base=floor_z + 2.45)
    else:
        t.solid(cx, cy, base + 0.34, base + 0.34, yaw, top=shaft_h)
    return [L for L in lamps if L]


def shop_fit(t, cx, cy, w, d, yaw=0.0, seed=0):
    """Furnish a hollowed ground storey: counter, shelves, stock, a lamp.

    An empty room is worse than no room -- it reads as a modelling error rather
    than as a place, and the belltower's ground floor proved that twice over.
    What makes this one a SHOP and not a box is the counter: it divides the
    space into where the customer stands and where they do not, which is the
    only thing in here that says what the room is for.
    """
    M, out = t.M, []
    rnd = _lcg_local(3300 + seed)
    z = ROOM_FLOOR
    ix, iy = w / 2 - ROOM_WALL, d / 2 - ROOM_WALL
    c_, s_ = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))

    def world(dx, dy):
        return cx + dx * c_ - dy * s_, cy + dx * s_ + dy * c_

    # THE COUNTER, across the room a third of the way back, with a gap at one
    # end so the shopkeeper's side is reachable and the room is not two rooms.
    cy_local = -iy + d * 0.34
    # two segments with a gap between them: the long run and a short return
    for bx, hw in ((-(ix - ix * 0.62), ix * 0.62), (ix - ix * 0.20, ix * 0.20)):
        out.append(box("shop_counter", (bx, cy_local, z + 0.47),
                       (hw, 0.30, 0.47), M["timber"], bevel=0.03, seg=1))
        out.append(box("shop_countertop", (bx, cy_local, z + 0.96),
                       (hw + 0.05, 0.36, 0.035), M["door"], bevel=0.02, seg=1))
        wx, wy = world(bx, cy_local)
        t.solid(wx, wy, hw + 0.05, 0.36, yaw, top=z + 1.0, base=z - 0.1)

    # SHELVES on the back wall, stocked. Three boards and their brackets.
    for k in range(3):
        sz = z + 0.72 + k * 0.62
        out.append(box("shop_shelf", (0, iy - 0.22, sz), (ix * 0.86, 0.20, 0.035),
                       M["timber"], bevel=0.015, seg=1))
        for b in range(4):
            bx = -ix * 0.72 + ix * 1.44 * b / 3
            out.append(box("shop_bracket", (bx, iy - 0.12, sz - 0.10),
                           (0.03, 0.10, 0.09), M["timber"], bevel=0.01, seg=1))
        # the stock: jars and bolts, in the four materials the stalls use, so a
        # shop reads as the indoor version of the market rather than a new idea
        for j in range(5):
            gx = -ix * 0.74 + ix * 1.48 * (j + 0.5) / 5 + (rnd() - 0.5) * 0.12
            r = 0.085 + rnd() * 0.05
            out.append(K.blob("shop_stock", (gx, iy - 0.22, sz + 0.035 + r),
                              (r, r * 0.9, r * 1.25), None,
                              M[("awning", "door", "stone", "brass")[(j + k) % 4]],
                              seg=8, rings=6, squircle=2.3))

    # A LAMP ON THE COUNTER, which is where the light is wanted and -- more to
    # the point -- within a metre of every timber surface in the room. The toon
    # ramp is a hard step: the belltower's stores stayed pure black under a lamp
    # three metres away, and moving it to 1.5 m fixed them entirely.
    lx, ly = world(-ix * 0.45, cy_local)
    lamps = [lantern(t, lx, ly, z0=z + 0.96, h=0.72, wall=True, kind='interior')]

    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(0, 0, 0))
        K.transform(o, translate=(cx, cy, 0))
    t.add(*out)

    # stock on the customer's side, and it comes apart
    bxw, byw = world(ix * 0.55, -iy + 0.85)
    barrel(t, bxw, byw, r=0.32, h=0.78, z0=z)
    cxw, cyw = world(-ix * 0.62, -iy + 0.72)
    crate(t, cxw, cyw, s=0.34, yaw=yaw + 12, z0=z)
    exw, eyw = world(ix * 0.30, iy - 0.75)
    embercap(t, exw, eyw, z=z, scale=1.0)
    return lamps


def cart(t, x, y, yaw=0.0, load=True, z0=0.0):
    """A two-wheeled cart, tipped forward onto its shafts.

    THE TOWN HAS NO TRAFFIC. It has stalls, washing, a woodstack and a market,
    all of which say people are here, and not one thing that says anything ever
    ARRIVES. A cart is the object that implies the road -- it is the only prop in
    the kit that belongs to both places, and standing on the gate approach it
    tells you the track you are about to walk is used for something.

    Parked with the shafts down, which is how a cart without a horse in it
    actually sits, and which is also the reading that does not require a horse.
    """
    M, out = t.M, []
    R = 0.52                      # wheel radius
    bed_z = z0 + R + 0.28

    for sy in (-1, 1):
        # felloe: a swept ring, so the rim has thickness from every angle
        out.append(K.tube(f"cart_rim{sy}", [
            {"p": Vector((x, y + sy * 0.62, bed_z - 0.30)), "r": (R, R), "n": 2.0},
            {"p": Vector((x, y + sy * 0.70, bed_z - 0.30)), "r": (R, R), "n": 2.0},
        ], seg=16, mat=M["timber"], squircle=2.0, up=(0, 0, 1)))
        out.append(K.tube(f"cart_tyre{sy}", [
            {"p": Vector((x, y + sy * 0.63, bed_z - 0.30)), "r": (R * 1.06, R * 1.06), "n": 2.0},
            {"p": Vector((x, y + sy * 0.69, bed_z - 0.30)), "r": (R * 1.06, R * 1.06), "n": 2.0},
        ], seg=16, mat=M["brass"], squircle=2.0, up=(0, 0, 1)))
        # six spokes: a bar along x, rotated about the wheel's own axis (y)
        for k in range(6):
            a = math.pi * k / 6
            out.append(box(f"cart_spoke{sy}_{k}", (x, y + sy * 0.66, bed_z - 0.30),
                           (R * 0.94, 0.030, 0.030), M["timber"], bevel=0.01, seg=1))
            K.transform(out[-1], rotate=(0, math.degrees(a), 0),
                        around=(x, y + sy * 0.66, bed_z - 0.30))
        out.append(box(f"cart_hub{sy}", (x, y + sy * 0.66, bed_z - 0.30),
                       (0.10, 0.075, 0.10), M["timber"], bevel=0.03, seg=1))

    # the bed, tipped nose-down onto the shafts
    out.append(box("cart_bed", (x, y, bed_z), (0.86, 0.62, 0.055),
                   M["timber"], bevel=0.02, seg=1))
    for sy in (-1, 1):
        out.append(box("cart_side", (x, y + sy * 0.60, bed_z + 0.20),
                       (0.86, 0.045, 0.20), M["timber"], bevel=0.02, seg=1))
    out.append(box("cart_head", (x - 0.82, y, bed_z + 0.20),
                   (0.045, 0.60, 0.20), M["timber"], bevel=0.02, seg=1))
    # shafts, running forward and down to the ground
    for sy in (-1, 1):
        out.append(K.tube(f"cart_shaft{sy}", [
            {"p": Vector((x + 0.80, y + sy * 0.48, bed_z - 0.02)), "r": (0.05, 0.05), "n": 2.4},
            {"p": Vector((x + 2.05, y + sy * 0.40, z0 + 0.06)), "r": (0.042, 0.042), "n": 2.4},
        ], seg=7, mat=M["timber"], squircle=2.4))

    for o in out:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(x, y, 0))
    t.add(*out)
    t.solid(x, y, 1.0, 0.78, yaw, top=bed_z + 0.42)

    # THE LOAD IS THE BREAKABLE, not the cart. A cart you can destroy is a cart
    # that leaves a hole in the street; sacks you can burst are the same swing
    # with none of that.
    if load:
        sacks = []
        for k, (dx, dy, r) in enumerate(((-0.34, -0.20, 0.27), (0.10, 0.16, 0.30),
                                         (0.46, -0.14, 0.25))):
            sacks.append(K.blob(f"cart_sack{k}",
                                (x + dx, y + dy, bed_z + 0.055 + r * 0.82),
                                (r, r * 0.86, r * 0.80), None, M["awning"],
                                seg=9, rings=6, squircle=2.3))
        for o in sacks:
            if yaw:
                K.transform(o, rotate=(0, 0, yaw), around=(x, y, 0))
        t.breakable(*sacks)
    return out


def outer_face(t, x0, x1, y, seed=0, shed_at=None):
    """Dress the BACK of a range -- the elevation the town shows the country.

    An audit called the town's meadow side "two blank walls", and it is the view
    the player sees more than any other after the plaza: it is what you walk
    back to, every time, framed by the gateway arch. Windows and a string course
    have since gone on, and what is still wrong is the bottom four metres, which
    is one flat slab of plaster per building.

    Nothing here is a room or a route. It is a plinth, buttresses, a lean-to and
    a woodstack -- the things that accumulate against the back of a building
    that faces a field, and enough of a silhouette that the wall stops reading
    as a plane.
    """
    M, out = t.M, []
    rnd = _lcg_local(9100 + seed)
    span = x1 - x0

    # a stone plinth: the one horizontal that ties the range to the ground
    out.append(box("face_plinth", ((x0 + x1) / 2, y + 0.11, 0.30),
                   (span / 2, 0.13, 0.30), M["stone"], bevel=0.04, seg=1))
    out.append(box("face_plinthcap", ((x0 + x1) / 2, y + 0.15, 0.62),
                   (span / 2, 0.17, 0.05), M["stone"], bevel=0.02, seg=1))

    # buttresses, battered so they read as structure and not as pilasters
    n = max(2, int(span / 4.2))
    for i in range(n):
        bx = x0 + span * (i + 0.5) / n + (rnd() - 0.5) * 0.4
        for k, (hz, hy, w2) in enumerate(((1.15, 0.46, 0.42), (1.05, 0.34, 0.36))):
            out.append(box(f"face_butt{i}_{k}", (bx, y + hy / 2, 0.30 + hz * (0.5 + k)),
                           (w2, hy / 2, hz / 2), M["stone"], bevel=0.05, seg=1))
        t.solid(bx, y + 0.24, 0.42, 0.26, top=2.6)

    # a lean-to against one bay: a roof on two posts, and the reason for the
    # woodstack under it
    if shed_at is not None:
        sx = shed_at
        for sgn in (-1, 1):
            out.append(box("shed_post", (sx + sgn * 1.35, y + 1.42, 1.05),
                           (0.075, 0.075, 1.05), M["timber"], bevel=0.02, seg=1))
        # the roof slopes AWAY from the wall, which is the only thing that makes
        # a lean-to read as one rather than as an awning
        v = [(-1.6, 0.06, 2.55), (1.6, 0.06, 2.55), (1.6, 1.75, 1.95), (-1.6, 1.75, 1.95)]
        out.append(K._new_obj("shed_roof",
                              [Vector((sx + a, y + b, c)) for a, b, c in v],
                              [(0, 1, 2, 3)], mat=M["roof_c"], smooth=False))
        out.append(box("shed_fascia", (sx, y + 1.75, 1.90),
                       (1.62, 0.06, 0.09), M["timber"], bevel=0.02, seg=1))
        t.solid(sx, y + 0.95, 1.6, 0.95, top=2.4)
        # split logs stacked under it, the same stack the yard has
        for row in range(3):
            for k in range(6):
                lx = sx - 1.1 + k * 0.36 + (rnd() - 0.5) * 0.06
                lz = 0.16 + row * 0.26
                out.append(K.tube(f"face_log{row}_{k}", K.dome([
                    {"p": Vector((lx, y + 0.42, lz)), "r": (0.115, 0.115), "n": 2.6},
                    {"p": Vector((lx, y + 1.24, lz)), "r": (0.105, 0.105), "n": 2.6},
                ], at="both", steps=2, height=0.04), seg=7, mat=M["timber"], squircle=2.6))
        barrel(t, sx + 1.9, y + 0.62, r=0.32, h=0.78)
        crate(t, sx - 1.95, y + 0.55, s=0.34, yaw=13)

    t.add(*out)
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
