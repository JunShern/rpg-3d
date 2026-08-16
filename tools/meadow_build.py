"""meadow_build -- the outdoor area, and the path that leads to it.

The plaza is enclosed, flat and made of right angles.  The meadow has to be its
opposite or the walk out of town is pointless: open, rolling, and organised by
sight lines rather than by walls.

WHAT MAKES AN OUTDOOR AREA READ AS A PLACE, in the order it matters:

1.  SOMEWHERE TO LOOK.  A field of grass is a texture; a field with a landmark
    on a rise is a place.  There is one hill you can see from the gate and stand
    on top of, and a standing stone on it, so the space has a destination.
2.  ELEVATION THAT CHANGES WHAT YOU SEE.  The terrain is a real heightfield, and
    the path climbs, so the meadow reveals itself as you walk rather than being
    visible all at once from the gate.
3.  A FRAME.  Hills close the far edge, so the world ends in landscape instead
    of in a boundary you can see the end of.
4.  DENSITY THAT VARIES.  Trees cluster and thin. Even spacing reads as a
    spreadsheet no matter how good the tree is.

The terrain is generated from summed sine octaves rather than true noise: it is
deterministic without seeding a PRNG, it is cheap to sample from BOTH the mesh
builder and the collision manifest (so they cannot disagree), and at this scale
nobody can tell.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/meadow_build.py -- \
      --out public/assets/meadow.glb --render docs/qa/meadow
"""
import bpy
import json
import math
import os
import sys

from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_lib as K
import arch_lib as A
import surface_tex

# The meadow lies SOUTH of the plaza in Blender terms (+Y), beyond the gateway
# arch at y = 11.  The plaza's own paving stops around y = 20.
# The plaza's paving slab runs to y = 19, so the meadow starts just past it.
# The two must not be coplanar anywhere or they z-fight along the seam.
GATE_Y = 19.5
MEADOW = dict(x0=-46.0, x1=46.0, y0=GATE_Y, y1=110.0)
PATH_X = -1.0                      # the path runs out of the gate on this line

# THE HILL HAS TO BE OFF THE PATH.
#
# It was at x=14 with the path running through x=13.1 -- 0.9 m from its centre.
# The path is cut flat and blended at full weight within 2.6 m, so the road
# simply overwrote the summit: a transect at y=80 read 3.40, 3.40, 3.44 across
# the middle of a "7.2 m" hill. The meadow's whole organising idea was being
# flattened by its own road.
#
# At x=27 the path climbs its western flank -- which is what makes the walk
# rise -- and the summit stands clear of it, so there is something to go TO
# rather than something you cross without noticing.
HILL = (27.0, 82.0, 7.2, 16.0)     # x, y, height, radius -- the destination


def height(x, y):
    """THE terrain function.  Sampled by the mesh, the props and the collision
    manifest alike, so nothing can disagree about where the ground is."""
    if y < GATE_Y:
        return -0.05                                 # tucked under the paving

    t = min(1.0, (y - GATE_Y) / 9.0)                 # ease out of the town
    h = (1.55 * math.sin(x * 0.055) * math.cos(y * 0.043)
         + 0.95 * math.sin(x * 0.101 + 1.7) * math.sin(y * 0.088 + 0.4)
         + 0.40 * math.sin(x * 0.223 + 0.9) * math.cos(y * 0.197 + 2.2))

    # the landmark hill
    hx, hy, hh, hr = HILL
    d = math.hypot(x - hx, y - hy) / hr
    if d < 1.0:
        h += hh * (math.cos(d * math.pi) * 0.5 + 0.5) ** 1.5

    # hills closing the far edge and the sides, so the world ends in landscape
    edge = 0.0
    edge += _ramp(y, MEADOW["y1"] - 26.0, MEADOW["y1"]) * 15.0
    edge += _ramp(-x, -MEADOW["x0"] - 22.0, -MEADOW["x0"]) * 12.0
    edge += _ramp(x, MEADOW["x1"] - 22.0, MEADOW["x1"]) * 12.0
    h += edge

    # A STREAM, cut into whatever the ground is doing.
    #
    # The meadow was one biome and, in a lot of frames, two values -- green and
    # the beige of the path. Water is the cheapest third: a different colour, a
    # different material, and a horizontal plane in a landscape made entirely of
    # slopes. It also gives the walk an EVENT: the route crosses it, so there is
    # a place partway out that is somewhere rather than more of the same.
    #
    # Carved into the height function rather than modelled, so the collision,
    # the mesh and the runtime's analytic ground cannot disagree about where the
    # bank is.
    # the path is cut flat-ish, and it climbs
    pw = _path_weight(x, y)
    road = _path_height(y)
    h = h * (1.0 - pw) + road * pw

    # THE STREAM IS CUT AFTER THE PATH, not before. Cutting first meant the path
    # blend overwrote it completely at the crossing, so the road ran dead flat
    # through the channel and the water sat half a metre above the road.
    h -= _stream_cut(x, y)
    # step DOWN off the paving rather than meeting it exactly: coplanar
    # surfaces z-fight, and a 5 cm lip is invisible and well under the
    # runtime's 45 cm step-up limit
    seam = 0.05 * (1.0 - min(1.0, (y - GATE_Y) / 3.0))
    return h * t - seam


STREAM_Y = 47.0            # where it crosses, roughly half way out
STREAM_DEPTH = 1.05
STREAM_HALF = 3.2          # half width of the cut at full depth


def _stream_y(x):
    """The bank line. It meanders, because a straight watercourse reads as a
    drainage ditch and the one thing a stream should not look like is civil
    engineering."""
    return STREAM_Y + 3.4 * math.sin(x * 0.055) + 1.5 * math.sin(x * 0.128 + 1.1)


def _stream_cut(x, y):
    """How far the ground drops here. Zero outside the banks, full in the middle,
    and SHALLOWED where the path crosses so the crossing is a ford you walk
    through rather than a hole you fall into."""
    d = abs(y - _stream_y(x))
    if d > STREAM_HALF + 3.0:
        return 0.0
    cut = STREAM_DEPTH * (1.0 - _ramp(d, STREAM_HALF * 0.45, STREAM_HALF + 3.0))
    # the ford: the path crosses on a shelf two thirds of the way up the bank
    ford = 1.0 - _ramp(abs(x - _path_x(y)), 2.2, 5.6)
    # 0.55, not 0.72: the ford still has to sit BELOW the road either side of
    # it, or the water surface spills over the crossing
    return cut * (1.0 - 0.55 * ford)


def _ramp(v, a, b):
    if v <= a:
        return 0.0
    k = min(1.0, (v - a) / (b - a))
    return k * k * (3 - 2 * k)


def _path_x(y):
    """The path does not run straight -- a straight road across a field reads as
    a corridor.  It bends, so the hill comes into view partway along."""
    return PATH_X + 11.0 * math.sin((y - GATE_Y) * 0.026) + 5.0 * math.sin((y - GATE_Y) * 0.011)


def _path_weight(x, y):
    d = abs(x - _path_x(y))
    return 1.0 - _ramp(d, 2.6, 6.4)


def _path_height(y):
    """THE ROAD CLIMBS THE WHOLE WAY.

    It used to saturate at y=62 and run dead level at 3.40 m for the last forty
    metres -- so "elevation that reveals the space as you walk" stopped halfway
    and the entire back half of the meadow, including the landmark and the last
    encounter, was a table. Two stages: a brisk climb out of town and a longer,
    gentler one past the halfway point.
    """
    return _ramp(y, GATE_Y, 62.0) * 3.4 + _ramp(y, 58.0, 104.0) * 2.9


def on_path(x, y, margin=0.0):
    return abs(x - _path_x(y)) < 2.6 + margin


# ------------------------------------------------------------------- terrain

TERRAIN_STEP = 1.6


def build_terrain(M, step=TERRAIN_STEP):
    x0, x1 = MEADOW["x0"], MEADOW["x1"]
    y0, y1 = MEADOW["y0"] - 2.0, MEADOW["y1"]   # tuck under the plaza edge
    nx = int((x1 - x0) / step) + 1
    ny = int((y1 - y0) / step) + 1

    verts, faces, grass, dirt, verge = [], [], [], [], []
    for j in range(ny):
        for i in range(nx):
            x = x0 + i * step
            y = y0 + j * step
            verts.append(Vector((x, y, height(x, y))))
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            faces.append((a, a + 1, a + nx + 1, a + nx))
            x = x0 + (i + 0.5) * step
            y = y0 + (j + 0.5) * step
            # A VERGE BETWEEN THEM. This was a binary `on_path` test on a 1.6 m
            # grid, so the road met the grass along a hard jagged staircase that
            # read as discoloured patches rather than as a worn edge. The smooth
            # `_path_weight` field that describes the transition already existed
            # and was being used only for height -- it is what picks the band
            # now, and a third material fills the middle of it.
            w = _path_weight(x, y)
            (dirt if w > 0.72 else verge if w > 0.18 else grass) \
                .append(len(faces) - 1)

    # recalc=False: the winding above is (i,j) -> (i+1,j) -> (i+1,j+1) -> (i,j+1),
    # whose normal is X x Y = +Z, i.e. up. A heightfield is an OPEN surface, so
    # bmesh's normal repair has no volume to infer from and guesses -- here it
    # guessed down, and the whole meadow rendered black.
    obj = K._new_obj("floor_meadow", verts, faces, mat=M["grass_tex"], smooth=True,
                     recalc=False)
    obj.data.materials.append(M["dirt_tex"])
    obj.data.materials.append(M["verge_tex"])
    for fi in dirt:
        obj.data.polygons[fi].material_index = 1
    for fi in verge:
        obj.data.polygons[fi].material_index = 2

    # PLANAR UVs FROM WORLD X/Y. The heightfield is gentle enough that projecting
    # straight down costs nothing visible, and it means grass and path share one
    # continuous UV set -- so the material boundary is a change of texture rather
    # than a change from one flat colour to another, which is what made the
    # per-face assignment read as discoloured patches.
    tile = 5.0
    K.set_uvs(obj, [(v.co.x / tile, v.co.y / tile) for v in obj.data.vertices])
    return obj


# --------------------------------------------------------------------- props

def scatter(M, t):
    """Density that VARIES. Trees cluster in copses and thin out between them;
    an even scatter reads as a spreadsheet however good the tree is."""
    rnd = _lcg(20260816)

    copses = [(-26, 34, 9), (22, 30, 8), (-34, 62, 10), (30, 58, 9),
              (-14, 86, 11), (34, 88, 9), (2, 46, 6), (-40, 46, 7)]
    for cx, cy, cr in copses:
        n = 4 + int(rnd() * 5)
        for _ in range(n):
            a = rnd() * math.tau
            r = cr * math.sqrt(rnd())
            x, y = cx + math.cos(a) * r, cy + math.sin(a) * r
            if on_path(x, y, 3.0) or not _inside(x, y):
                continue
            tree(M, t, x, y, 0.75 + rnd() * 0.7)

    # lone trees, for silhouettes against the sky
    for _ in range(14):
        x = MEADOW["x0"] + 8 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 16)
        y = GATE_Y + 12 + rnd() * (MEADOW["y1"] - GATE_Y - 26)
        if on_path(x, y, 5.0) or not _inside(x, y):
            continue
        tree(M, t, x, y, 0.9 + rnd() * 0.8)

    # rocks, thicker as the ground rises
    for _ in range(60):
        x = MEADOW["x0"] + 4 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 8)
        y = GATE_Y + 4 + rnd() * (MEADOW["y1"] - GATE_Y - 8)
        if on_path(x, y, 2.2) or not _inside(x, y):
            continue
        z = height(x, y)
        s = 0.22 + rnd() * (0.55 if z > 4 else 0.28)
        t.add(K.blob(f"rock{len(t.parts)}", (x, y, z + s * 0.35),
                     (s, s * 0.86, s * 0.62), None, M["rock"],
                     seg=9, rings=6, squircle=2.7))
        if s > 0.5:
            t.solid(x, y, s * 0.9, s * 0.8, top=z + s)

    # grass tufts: cheap, and they are what stops the ground reading as a sheet
    for _ in range(520):
        x = MEADOW["x0"] + 3 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 6)
        y = GATE_Y + 2 + rnd() * (MEADOW["y1"] - GATE_Y - 4)
        if on_path(x, y, 1.4) or not _inside(x, y):
            continue
        tuft(M, t, x, y, rnd)

    # flowers, clustered
    for _ in range(11):
        cx = MEADOW["x0"] + 8 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 16)
        cy = GATE_Y + 10 + rnd() * (MEADOW["y1"] - GATE_Y - 20)
        col = M["bloom_a"] if rnd() < 0.5 else M["bloom_b"]
        for _ in range(9 + int(rnd() * 10)):
            x, y = cx + (rnd() - 0.5) * 6.5, cy + (rnd() - 0.5) * 6.5
            if on_path(x, y, 1.2) or not _inside(x, y):
                continue
            z = height(x, y)
            t.add(K.blob(f"bloom{len(t.parts)}", (x, y, z + 0.20),
                         (0.075, 0.075, 0.075), None, col, seg=7, rings=5))
            t.add(K.tube(f"stem{len(t.parts)}", [
                {"p": Vector((x, y, z)), "r": (0.014, 0.014)},
                {"p": Vector((x, y, z + 0.19)), "r": (0.011, 0.011)},
            ], seg=5, mat=M["leaf_lo"]))


def _inside(x, y):
    return (MEADOW["x0"] + 2 < x < MEADOW["x1"] - 2
            and GATE_Y + 1 < y < MEADOW["y1"] - 3)


def _lcg(seed):
    s = [seed]

    def rnd():
        s[0] = (s[0] * 1103515245 + 12345) & 0x7fffffff
        return s[0] / 0x7fffffff
    return rnd


def tree(M, t, x, y, scale):
    z = height(x, y)
    h = 2.6 * scale
    t.add(K.tube(f"trunk{len(t.parts)}", K.dome([
        {"p": Vector((x, y, z - 0.15)), "r": (0.26 * scale, 0.26 * scale), "n": 2.6},
        {"p": Vector((x, y, z + h * 0.42)), "r": (0.17 * scale, 0.17 * scale), "n": 2.6},
        {"p": Vector((x, y, z + h * 0.78)), "r": (0.12 * scale, 0.12 * scale), "n": 2.6},
    ], at="end", steps=2, height=0.1), seg=8, mat=M["bark"], squircle=2.6))
    for dx, dy, dz, r in ((0, 0, 1.00, 1.45), (0.52, 0.20, 1.32, 1.02),
                          (-0.46, -0.26, 1.26, 0.94), (0.10, -0.50, 1.44, 0.80)):
        t.add(K.blob(f"canopy{len(t.parts)}",
                     (x + dx * scale, y + dy * scale, z + h * dz),
                     (r * scale, r * scale, r * scale * 0.82), None,
                     M["leaf"] if (len(t.parts) % 3) else M["leaf_lo"],
                     seg=11, rings=7, squircle=2.2))
    t.solid(x, y, 0.42 * scale, 0.42 * scale, top=z + h)


def tuft(M, t, x, y, rnd):
    z = height(x, y)
    n = 3 + int(rnd() * 3)
    for _ in range(n):
        a = rnd() * math.tau
        r = rnd() * 0.22
        px, py = x + math.cos(a) * r, y + math.sin(a) * r
        hh = 0.20 + rnd() * 0.26
        lean = (rnd() - 0.5) * 0.16
        t.add(K.tube(f"blade{len(t.parts)}", [
            {"p": Vector((px, py, z - 0.03)), "r": (0.030, 0.012), "n": 2.2},
            {"p": Vector((px + lean, py + lean * 0.4, z + hh * 0.6)),
             "r": (0.020, 0.008), "n": 2.2},
            {"p": Vector((px + lean * 2.0, py + lean, z + hh)), "r": 0.0, "n": 2.2},
        ], seg=4, mat=M["grass_hi"] if rnd() < 0.5 else M["leaf"],
            squircle=2.2, up=(0, 0, 1)))


def landmark(M, t):
    """The thing you can see from the gate and stand next to when you arrive."""
    hx, hy, hh, _ = HILL
    z = height(hx, hy)
    t.add(K.tube("stone_base", [
        {"p": Vector((hx, hy, z - 0.3)), "r": (1.35, 1.20), "n": 3.0},
        {"p": Vector((hx, hy, z + 0.28)), "r": (1.20, 1.05), "n": 3.0},
    ], seg=14, mat=M["rock"], squircle=3.0, up=(0, 0, 1)))
    for i, (dx, dy, ht, r) in enumerate(((0, 0, 4.6, 0.52), (1.5, 0.7, 2.9, 0.34),
                                         (-1.4, -0.8, 2.2, 0.30))):
        t.add(K.tube(f"stone{i}", K.dome([
            {"p": Vector((hx + dx, hy + dy, z)), "r": (r, r * 0.72), "n": 3.2},
            {"p": Vector((hx + dx * 1.1, hy + dy * 1.1, z + ht * 0.7)),
             "r": (r * 0.86, r * 0.62), "n": 3.2},
            {"p": Vector((hx + dx * 1.2, hy + dy * 1.2, z + ht)),
             "r": (r * 0.62, r * 0.44), "n": 3.2},
        ], at="end", steps=2, height=r * 0.5), seg=9, mat=M["stone"],
            squircle=3.2, up=(0, 0, 1)))
        t.solid(hx + dx, hy + dy, r, r * 0.8, top=z + ht)


def stream(M, t):
    """The water itself: a ribbon following the channel, plus banks.

    It sits at a constant depth below the LOCAL bed rather than at one flat
    level, because the channel crosses ground that rises three metres across the
    meadow and a truly level surface would be underground at one end and floating
    at the other. A stylised stream that follows its bed reads correctly and a
    physically level one does not -- this is the same trade the path makes.
    """
    x0, x1 = MEADOW["x0"] + 2.0, MEADOW["x1"] - 2.0
    sec = []
    n = 40
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        y = _stream_y(x)
        bed = height(x, y)
        # NEVER ABOVE ITS OWN BANKS. The surface used to be a fixed lift off the
        # bed, and where the channel runs shallow that put it proud of the
        # ground either side -- a blue sheet lying across a field with its
        # underside showing. Clamp to just under whatever the bank is doing.
        bank = min(height(x, y - STREAM_HALF * 1.45),
                   height(x, y + STREAM_HALF * 1.45))
        # rx is ACROSS the channel and ry is its thickness. Swept along +X with
        # up=+Z, the frame puts rx on Y and ry on Z -- the other way round gave a
        # five-metre vertical sheet of water standing in a field. This is the
        # same rx/ry trap the fountain wall and the gate arch both hit.
        sec.append({"p": Vector((x, y, min(bed + 0.42, bank - 0.14))),
                    # 0.52, not 0.86: the cut only reaches full depth within 45% of
                    # STREAM_HALF, so a wider ribbon rode up the banks and left a
                    # straight edge of water lying across sloping ground
                    "r": (STREAM_HALF * 0.52, 0.04), "n": 3.6})
    t.add(K.tube("water", sec, seg=4, mat=M["water"], squircle=3.6, up=(0, 0, 1)))

    # WET STONES ALONG THE BANKS. A cut in a heightfield has no edge treatment,
    # so without something sitting on the lip the bank is just where the green
    # starts sloping -- which reads as a fold in the ground, not as a shore.
    r = _lcg(4409)
    for i in range(46):
        x = x0 + (x1 - x0) * (i + r() * 0.6) / 46
        side = 1.0 if i % 2 else -1.0
        y = _stream_y(x) + side * (STREAM_HALF * 0.72 + r() * 1.1)
        if on_path(x, y, margin=1.6):
            continue                       # keep the ford clear
        sc = 0.24 + r() * 0.34
        t.add(K.blob(f"bankstone{i}", (x, y, height(x, y) + sc * 0.35),
                     (sc, sc * 0.82, sc * 0.55), None, M["rock"],
                     seg=8, rings=6, squircle=2.5))

    # stepping stones at the ford, so the crossing reads as a crossing
    fy = _stream_y(_path_x(STREAM_Y))
    for k, off in enumerate((-2.0, -0.7, 0.7, 2.0)):
        px = _path_x(fy) + off * 0.55
        py = fy + off
        t.add(K.blob(f"ford_stone{k}", (px, py, height(px, py) + 0.10),
                     (0.62, 0.52, 0.16), None, M["rock"],
                     seg=10, rings=6, squircle=3.0))


def outcrop(M, t):
    """A CLIMB, and the one place in the demo that stacks levels.

    The meadow already has elevation -- the path climbs and the hill rises --
    but that is a slope, not verticality: you are always on the one surface. An
    audit put it plainly, that the entire vertical vocabulary was a jump that
    clears a 1.1 m terrace.

    So: five rock shelves staggered around the standing stones, each rising
    0.42 m -- under the runtime's 0.45 m step, so it is a walk rather than a
    platforming test -- ending on a plateau a little over two metres above the
    hilltop. From up there the town, the path and the far hills are all in one
    frame, which is the only view in the build that shows you the whole walk you
    just made.

    Each shelf is emitted as a PLATFORM in the manifest. The meadow's ground is
    an analytic function for speed, and that function only knows about terrain --
    so anything standing above it has to be told to the runtime separately or it
    is scenery you walk through.
    """
    hx, hy, _, _ = HILL
    z0 = height(hx, hy)
    # spiralling out from the stones, so climbing it walks you around the
    # landmark rather than straight at it
    shelves = [
        (hx - 3.4, hy - 2.6, 2.2, 1.8, 0.42),
        (hx - 4.6, hy + 0.6, 2.0, 2.0, 0.84),
        (hx - 3.2, hy + 3.4, 2.1, 1.9, 1.26),
        (hx - 0.2, hy + 4.4, 2.3, 2.0, 1.68),
        (hx + 2.9, hy + 3.1, 2.6, 2.4, 2.10),
    ]
    for i, (cx, cy, rx, ry, rise) in enumerate(shelves):
        top = z0 + rise
        # a slab with a slightly smaller base, so it reads as stacked rock
        # rather than as a stack of boxes
        t.walk(K.tube(f"shelf{i}", [
            {"p": Vector((cx, cy, top - 1.6)), "r": (rx * 0.86, ry * 0.86), "n": 3.4},
            {"p": Vector((cx, cy, top - 0.30)), "r": (rx, ry), "n": 3.6},
            {"p": Vector((cx, cy, top)), "r": (rx * 0.97, ry * 0.97), "n": 3.8},
        ], seg=12, mat=M["rock"], squircle=3.6, up=(0, 0, 1)))
        t.platform(cx, cy, rx * 0.94, ry * 0.94, top)

    # a lip of loose stones round the top shelf: something to read the edge by
    cx, cy, rx, ry, rise = shelves[-1]
    for k in range(7):
        a = 6.2831 * k / 7 + 0.4
        t.add(K.blob(f"shelf_lip{k}",
                     (cx + math.cos(a) * rx * 0.86, cy + math.sin(a) * ry * 0.86,
                      z0 + rise + 0.16),
                     (0.30, 0.30, 0.22), None, M["rock"], seg=9, rings=7,
                     squircle=2.4))


def waymarks(M, t):
    """Posts along the path. They do the job a corridor wall does in a town --
    tell you where the road goes -- without enclosing anything."""
    y = GATE_Y + 5
    i = 0
    while y < MEADOW["y1"] - 20:
        for side in (-1, 1):
            x = _path_x(y) + side * 3.6
            z = height(x, y)
            t.add(A.box(f"post{i}", (x, y, z + 0.52), (0.10, 0.10, 0.52),
                        M["bark"], bevel=0.03, seg=1))
            if i % 3 == 0:
                t.add(K.blob(f"cap{i}", (x, y, z + 1.10), (0.14, 0.14, 0.12),
                             None, M["stone"], seg=8, rings=6))
            i += 1
        y += 9.5


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    out = opt("--out", "public/assets/meadow.glb")
    render_dir = opt("--render")

    K.clear_scene()
    M = A.palette()
    # generated ground, written next to the assets and packed into the GLB
    os.makedirs("public/assets/tex", exist_ok=True)
    for nm, fn in (("grass", surface_tex.grass), ("dirt", surface_tex.dirt),
                   ("verge", surface_tex.verge)):
        path = os.path.abspath(f"public/assets/tex/{nm}.png")
        surface_tex.write_png(path, fn())
        M[f"{nm}_tex"] = K.image_material(
            f"{nm}_tex", bpy.data.images.load(path, check_existing=True),
            roughness=0.92,
            preview=({"grass": (0.50, 0.66, 0.38), "dirt": (0.68, 0.59, 0.47),
                      "verge": (0.60, 0.63, 0.43)})[nm])
    M.update({
        "grass":    K.material("grass", (0.44, 0.62, 0.30), roughness=0.9),
        "grass_hi": K.material("grass_hi", (0.58, 0.74, 0.34), roughness=0.9),
        "dirt":     K.material("dirt", (0.56, 0.46, 0.34), roughness=0.95),
        "bark":     K.material("bark", (0.34, 0.25, 0.19), roughness=0.9),
        "leaf":     K.material("leaf", (0.32, 0.55, 0.28), roughness=0.85),
        "leaf_lo":  K.material("leaf_lo", (0.24, 0.44, 0.24), roughness=0.85),
        "rock":     K.material("rock", (0.52, 0.50, 0.48), roughness=0.9),
        "bloom_a":  K.material("bloom_a", (0.94, 0.86, 0.42), roughness=0.7),
        "bloom_b":  K.material("bloom_b", (0.86, 0.52, 0.72), roughness=0.7),
    })

    t = A.Town(M)
    t.walk(build_terrain(M))
    landmark(M, t)
    outcrop(M, t)
    stream(M, t)
    waymarks(M, t)
    scatter(M, t)

    town, floor = A.finish(t, name_town="MEADOW", name_floor="FLOOR_MEADOW")
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons)
               for o in (town, floor) if o)
    print(f"[meadow] {len(t.parts)} parts -> {tris} tris, {len(t.solids)} solids")

    if render_dir:
        import town_build
        os.makedirs(render_dir, exist_ok=True)
        views = [
            ("fromgate", (PATH_X, GATE_Y - 4.0, 2.4), (_path_x(38), 38.0, 4.0)),
            ("path", (_path_x(30) - 5, 30.0, 4.5), (_path_x(52), 52.0, 5.0)),
            ("hill", (HILL[0] - 20, HILL[1] - 24, 12.0), (HILL[0], HILL[1], HILL[2])),
            ("wide", (-34.0, 6.0, 26.0), (6.0, 58.0, 4.0)),
        ]
        for f in _render(render_dir, views):
            print(f"[render] {f}")

    bpy.ops.object.select_all(action='DESELECT')
    for o in (town, floor):
        if o:
            o.select_set(True)
    bpy.context.view_layer.objects.active = town or floor
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True,
        export_apply=True, export_animations=False, export_yup=True,
        export_materials='EXPORT', export_texcoords=True, export_normals=True)
    print(f"[meadow] exported {out} ({os.path.getsize(out)/1024:.0f} KB)")

    man = t.manifest()
    man["bounds"] = MEADOW
    man["gateY"] = GATE_Y
    # THE TERRAIN FUNCTION TRAVELS WITH THE MESH.
    #
    # The runtime must not raycast this heightfield: it is 6,120 triangles and
    # the ground is queried ~10 times a frame (player, both feet, camera, every
    # enemy), which cost more than everything else in the frame put together.
    # The analytic function is O(1) and exact, so the runtime evaluates it
    # instead -- and the probes below let it PROVE the port still agrees with
    # the mesh it is standing on, rather than assuming.
    man["terrain"] = {
        "gateY": GATE_Y, "pathX": PATH_X, "hill": list(HILL),
        "x0": MEADOW["x0"], "x1": MEADOW["x1"], "y1": MEADOW["y1"],
        "streamY": STREAM_Y, "streamDepth": STREAM_DEPTH, "streamHalf": STREAM_HALF,
        # the GRID the mesh was built on. The runtime interpolates the same
        # triangles the player is looking at rather than the smooth function --
        # a 1.6 m quad chords up to 21 cm below the true surface on the hill,
        # which is the difference between standing on the ground and hovering.
        "gridX0": MEADOW["x0"], "gridY0": MEADOW["y0"] - 2.0, "step": TERRAIN_STEP,
    }
    probes = []
    for px in (-40, -18, -1, 6, 14, 30, 44):
        for py in (18, 24, 36, 52, 68, 80, 96, 108):
            probes.append([px, py, round(height(px, py), 5)])
    man["terrainProbes"] = probes
    mpath = os.path.splitext(out)[0] + ".manifest.json"
    with open(mpath, "w") as fh:
        json.dump(man, fh, indent=1)
    print(f"[meadow] wrote {mpath} ({len(man['solids'])} solids)")


def _render(prefix, views):
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_EEVEE'
    scn.render.resolution_x = 1100
    scn.render.resolution_y = 620
    if scn.world is None:
        scn.world = bpy.data.worlds.new("W")
    scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.42, 0.60, 0.82, 1.0)
    bg.inputs[1].default_value = 1.1

    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN'))
    sun.data.energy = 3.6
    sun.data.angle = math.radians(12)
    sun.rotation_euler = (math.radians(52), 0, math.radians(34))
    bpy.context.collection.objects.link(sun)

    cd = bpy.data.cameras.new("Cam")
    cd.lens = 34
    cam = bpy.data.objects.new("Cam", cd)
    bpy.context.collection.objects.link(cam)
    scn.camera = cam

    out = []
    for name, eye, look in views:
        cam.location = Vector(eye)
        cam.rotation_euler = (Vector(look) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(prefix, f"meadow_{name}.png")
        bpy.ops.render.render(write_still=True)
        out.append(scn.render.filepath)
    return out


if __name__ == "__main__":
    main()
