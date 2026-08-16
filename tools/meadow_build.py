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
RUIN = (-14.0, 55.0)               # the roofless hut, twenty metres off the road


def _natural(x, y):
    """The ground BEFORE the road and the water touch it.

    Split out of `height` so the road can ask what the land is doing along its
    own centreline. See `_road_z` for why that matters.
    """
    h = (1.55 * math.sin(x * 0.055) * math.cos(y * 0.043)
         + 0.95 * math.sin(x * 0.101 + 1.7) * math.sin(y * 0.088 + 0.4)
         + 0.40 * math.sin(x * 0.223 + 0.9) * math.cos(y * 0.197 + 2.2))

    # the landmark hill
    hx, hy, hh, hr = HILL
    d = math.hypot(x - hx, y - hy) / hr
    if d < 1.0:
        h += hh * (math.cos(d * math.pi) * 0.5 + 0.5) ** 1.5

    # hills closing the far edge and the sides, so the world ends in landscape
    h += _ramp(y, MEADOW["y1"] - 26.0, MEADOW["y1"]) * 15.0
    h += _ramp(-x, -MEADOW["x0"] - 22.0, -MEADOW["x0"]) * 12.0
    h += _ramp(x, MEADOW["x1"] - 22.0, MEADOW["x1"]) * 12.0

    # THE WHOLE MEADOW CLIMBS, not just the road across it. The rise used to
    # belong to `_path_height`, an absolute height the road was blended to
    # regardless of what the ground beside it was doing -- so by the far end the
    # road stood on a four-metre levee with 50-degree sides, a causeway laid
    # across a field. A transect at y=62 read -0.70 at x=4, 3.46 at x=10 and
    # -0.92 at x=18. Putting the climb in the LAND means the walk still rises,
    # the town still drops away behind you, and the road is a graded track on it
    # rather than an embankment over it.
    h += _ramp(y, GATE_Y, 104.0) * 6.3
    return h


def _road_z(y):
    """The road's height: the natural ground along its own centreline, smoothed
    over about twenty metres.

    A road grades a hill -- it cuts the crests and fills the hollows and stays
    within a metre or so of the land -- which is exactly what a low-pass filter
    along the centreline gives, and it cannot run away from the terrain the way
    an absolute height can.
    """
    s = 0.0
    n = 0.0
    for k in range(-4, 5):
        yy = y + k * 2.6
        w = 1.0 - abs(k) / 5.0
        s += w * _natural(_path_x(yy), yy)
        n += w
    return s / n


def height(x, y):
    """THE terrain function.  Sampled by the mesh, the props and the collision
    manifest alike, so nothing can disagree about where the ground is."""
    if y < GATE_Y:
        return -0.05                                 # tucked under the paving

    t = min(1.0, (y - GATE_Y) / 9.0)                 # ease out of the town
    h = _natural(x, y)

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
    # the path is cut flat-ish, and it climbs because the land does
    pw = _path_weight(x, y)
    h = h * (1.0 - pw) + _road_z(y) * pw

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
STREAM_DEPTH = 1.60
STREAM_HALF = 3.2          # half width of the cut at full depth
# IT MUST STAY ON THE FLAT. The cut was swept the full width of the meadow, and
# the flanking hills rise twelve metres inside the last twenty-two -- so the
# water surface climbed with the ground and ran over both crests, at up to an
# 84% grade, reading as a cyan pipe laid across a hillside. These bounds sit
# inside where `_ramp` starts lifting the edges.
STREAM_X0, STREAM_X1 = -23.0, 23.0


def _stream_y(x):
    """The bank line. It meanders, because a straight watercourse reads as a
    drainage ditch and the one thing a stream should not look like is civil
    engineering."""
    return STREAM_Y + 3.4 * math.sin(x * 0.055) + 1.5 * math.sin(x * 0.128 + 1.1)


def _stream_cut(x, y):
    """How far the ground drops here. Zero outside the banks, full in the middle,
    and SHALLOWED where the path crosses so the crossing is a ford you walk
    through rather than a hole you fall into.

    Fades out at both ends rather than stopping dead, so the channel runs into
    the rising ground instead of being sliced off in mid-air."""
    if x < STREAM_X0 - 4.0 or x > STREAM_X1 + 4.0:
        return 0.0
    ends = min(_ramp(x, STREAM_X0 - 4.0, STREAM_X0),
               _ramp(-x, -STREAM_X1 - 4.0, -STREAM_X1))
    d = abs(y - _stream_y(x))
    if d > STREAM_HALF + 0.8:
        return 0.0
    # A CHANNEL, NOT A DISH. The profile used to hold full depth only within 45%
    # of STREAM_HALF and then taper for another three metres, so the cut was
    # twelve metres wide and a metre deep -- a saucer, in which a three-metre
    # ribbon of water read as blue tape stuck to a lawn. Flat bottom out to
    # 1.1 m, then banks that climb 1.6 m over 2.9 m, which is a shore you can
    # walk down and still see as a bank from across the field.
    cut = STREAM_DEPTH * (1.0 - _ramp(d, 1.1, STREAM_HALF + 0.8))
    # the ford: the path crosses on a shelf two thirds of the way up the bank
    ford = 1.0 - _ramp(abs(x - _path_x(y)), 2.2, 5.6)
    # 0.55, not 0.72: the ford still has to sit BELOW the road either side of
    # it, or the water surface spills over the crossing
    return cut * (1.0 - 0.55 * ford) * ends


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
            # ...AND THE BAND EDGE IS RAGGED, not a contour line.
            #
            # Three bands off a smooth field still put every boundary on an
            # exact iso-line of that field, which on a regular 1.6 m grid is a
            # clean diagonal staircase -- an audit called it a knife edge and
            # was right, in seven separate captures, after this was written
            # down as fixed. A dirt track's edge is not a curve; it is where the
            # grass happens to have given up. Two octaves of cheap noise on the
            # weight before the threshold breaks each boundary into interlocking
            # fingers of grass and verge, which is the same three materials and
            # no extra triangles.
            # The frequencies matter as much as the amplitude: the grid is
            # 1.6 m, so a five-metre wavelength makes three-face blobs and the
            # verge reads as a checkerboard spreading into the field. These
            # periods are 2-3 m, which is one to two faces -- fingers, not
            # patches -- and the total amplitude is 0.165, enough to break the
            # contour and not enough to widen the road.
            n = (0.075 * math.sin(x * 2.10 + y * 1.70)
                 + 0.055 * math.sin(x * 4.30 - y * 3.90 + 1.9)
                 + 0.035 * math.sin(x * 7.70 + y * 6.10 + 0.4))
            w = _path_weight(x, y) + n
            (dirt if w > 0.76 else verge if w > 0.16 else grass) \
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

def _clear_of_landmarks(x, y, pad=0.0):
    """True where scenery is allowed to grow.

    KEEP THE MONUMENT CLEAR. `scatter` knew about the path and the world edge
    and nothing else, so a copse grew straight through the stone circle: the
    capture that was supposed to show a ring of standing stones showed a tree,
    with the lintel hanging in the air behind it because both uprights holding
    it up were hidden. A landmark you cannot see is not one.
    """
    hx, hy, _, _ = HILL
    if math.hypot(x - hx, y - hy) < 11.0 + pad:
        return False
    if math.hypot(x - RUIN[0], y - RUIN[1]) < 6.5 + pad:
        return False
    return True


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
            if not _clear_of_landmarks(x, y, 1.5):
                continue
            tree(M, t, x, y, 0.75 + rnd() * 0.7)

    # lone trees, for silhouettes against the sky
    for _ in range(14):
        x = MEADOW["x0"] + 8 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 16)
        y = GATE_Y + 12 + rnd() * (MEADOW["y1"] - GATE_Y - 26)
        if on_path(x, y, 5.0) or not _inside(x, y):
            continue
        if not _clear_of_landmarks(x, y, 1.5):
            continue
        tree(M, t, x, y, 0.9 + rnd() * 0.8)

    # rocks, thicker as the ground rises
    for _ in range(60):
        x = MEADOW["x0"] + 4 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 8)
        y = GATE_Y + 4 + rnd() * (MEADOW["y1"] - GATE_Y - 8)
        if on_path(x, y, 2.2) or not _inside(x, y):
            continue
        if not _clear_of_landmarks(x, y):
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
        cx, cy, cz = x + dx * scale, y + dy * scale, z + h * dz
        t.add(K.blob(f"canopy{len(t.parts)}", (cx, cy, cz),
                     (r * scale, r * scale, r * scale * 0.82), None,
                     M["leaf"] if (len(t.parts) % 3) else M["leaf_lo"],
                     seg=11, rings=7, squircle=2.2))
        # the camera must not end up inside this; walking under it is fine
        t.camblock(cx, cy, cz, r * scale * 1.05)
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
        # BOTH TUFT TONES MUST BE OUTLINE-EXEMPT. Half of them used `leaf`,
        # which tree canopies also use -- and canopies SHOULD be outlined. So
        # the exclusion list could not name `leaf` without flattening the trees,
        # and 33k triangles of grass got inverted-hull shells whose width is
        # constant in screen space: on a 3 cm blade that is nearly all outline,
        # which is the black scribble across the meadow floor.
        ], seg=4, mat=M["grass_hi"] if rnd() < 0.5 else M["leaf_lo"],
            squircle=2.2, up=(0, 0, 1)))


def landmark(M, t):
    """THE THING YOU WALK TOWARDS.

    It was three stones on a plinth, and an audit's word for it was that the
    frame named after it contained neither a landmark nor a standing stone --
    from 28 m aimed straight at it, it was not in the picture. Three stones on a
    seven-metre hill is not a monument, it is some rocks.

    A RING reads. It reads from the gate as a notched silhouette on the skyline,
    it reads from the path as something arranged rather than scattered, and it
    reads from inside as a place, because a ring is the one arrangement that
    makes the space in the middle mean something. Eight uprights at varying
    height with a lintel across the tallest pair, one fallen and one leaning,
    and a low altar stone at the centre so there is a reason to walk in.
    """
    hx, hy, hh, _ = HILL
    z = height(hx, hy)
    rnd = _lcg(7714)
    R = 4.6

    # EACH STONE STANDS ON ITS OWN GROUND, not on the hill's centre height.
    #
    # The first version planted all eight at `height(hx, hy)`. Measured, the
    # ground under a 4.6 m ring on this hill runs from 7.99 m to 11.83 m -- so
    # three of them floated over two metres in the air and one was buried a
    # metre deep. The tall pair happened to be on the low side, which is why
    # the lintel they are supposed to carry was hanging in the sky on its own.
    def upright(name, px, py, ht, r, lean=0.0, la=0.0, top_abs=None):
        base = height(px, py)
        tz = top_abs if top_abs is not None else base + ht
        obj = K.tube(name, K.dome([
            {"p": Vector((px, py, base - 0.25)), "r": (r, r * 0.66), "n": 3.2},
            {"p": Vector((px + math.cos(la) * lean * 0.5,
                          py + math.sin(la) * lean * 0.5, base + (tz - base) * 0.62)),
             "r": (r * 0.90, r * 0.60), "n": 3.2},
            {"p": Vector((px + math.cos(la) * lean, py + math.sin(la) * lean, tz)),
             "r": (r * 0.70, r * 0.46), "n": 3.2},
        ], at="end", steps=2, height=r * 0.45), seg=9, mat=M["stone"],
            squircle=3.2, up=(0, 0, 1))
        t.add(obj)
        t.solid(px, py, r * 1.1, r * 0.9, top=tz)
        return obj

    # eight round the ring. The two flanking the approach are the tall pair and
    # carry a lintel, so the circle has a FRONT -- a ring of equal stones has no
    # way to tell you where to walk in.
    # A LINTEL MEANS THE PAIR ARE CUT TO LEVEL. Both uprights under it are
    # given an absolute top rather than a height, so they reach the same line
    # however far apart their footings are -- which is what a builder would do
    # and what makes the horizontal read as deliberate.
    LINTEL_Z = z + 4.5
    pair = {}
    for i in range(8):
        a = 2 * math.pi * i / 8 + 0.22
        px, py = hx + math.cos(a) * R, hy + math.sin(a) * R
        top_abs = None
        if i in (2, 3):
            ht, r, top_abs = 4.5, 0.50, LINTEL_Z
        elif i == 6:
            ht, r = 1.1, 0.46          # the fallen one is a stump plus a slab
        else:
            ht, r = 2.4 + rnd() * 1.3, 0.34 + rnd() * 0.12
        lean = 0.0 if i in (2, 3) else (rnd() - 0.5) * 0.34
        upright(f"stone{i}", px, py, ht, r, lean, a, top_abs)
        # CAPTURED FROM THE LOOP, not recomputed afterwards. Recomputing the
        # same expression in two places is how the lintel ended up spanning a
        # pair of stones that were not the pair holding it up.
        if i in (2, 3):
            pair[i] = (px, py)
        if i == 6:
            # the toppled upright, lying where it fell, pointing out of the ring
            fx, fy = hx + math.cos(a) * (R + 1.6), hy + math.sin(a) * (R + 1.6)
            slab = K.tube("stone_fallen", K.dome([
                {"p": Vector((px, py, height(px, py) + 0.42)), "r": (0.46, 0.30), "n": 3.2},
                {"p": Vector((fx, fy, height(fx, fy) + 0.30)), "r": (0.34, 0.24), "n": 3.2},
            ], at="both", steps=2, height=0.14), seg=9, mat=M["stone"],
                squircle=3.2, up=(0, 0, 1))
            t.add(slab)
            t.solid((px + fx) / 2, (py + fy) / 2, 1.0, 1.0,
                    top=height((px + fx) / 2, (py + fy) / 2) + 0.7)

    # THE LINTEL. One horizontal in a field of verticals, and the whole reason
    # the ring reads as built rather than as geology.
    p2, p3 = pair[2], pair[3]
    # CAPPED AT BOTH ENDS. A swept tube is an open sleeve, and an open sleeve
    # four metres up is a black hole in the sky -- which is exactly what the
    # first version rendered as.
    t.add(K.tube("stone_lintel", K.dome([
        {"p": Vector((p2[0], p2[1], LINTEL_Z + 0.12)), "r": (0.52, 0.34), "n": 3.4},
        {"p": Vector((p3[0], p3[1], LINTEL_Z + 0.12)), "r": (0.52, 0.34), "n": 3.4},
    ], at="both", steps=2, height=0.16), seg=9, mat=M["stone"],
        squircle=3.4, up=(0, 0, 1)))

    # the altar: low, broad, and the only flat thing up here
    t.walk(K.tube("stone_altar", [
        {"p": Vector((hx, hy, z + 0.02)), "r": (1.30, 0.95), "n": 3.4},
        {"p": Vector((hx, hy, z + 0.46)), "r": (1.18, 0.86), "n": 3.4},
    ], seg=14, mat=M["rock"], squircle=3.4, up=(0, 0, 1)))
    t.platform(hx, hy, 1.05, 0.78, z + 0.46)


def drywall(M, t, x0, y0, x1, y1, gap_at=None, gap_w=3.4, h=0.92):
    """A field boundary, with an optional gap for the road to pass through.

    THE MEADOW HAD NO FIELDS, only ground. Ninety metres of undivided green
    reads as terrain rather than as country, and an audit counted 70-90% of
    several frames as mottled green with nothing in it. A wall does three
    things a tree cannot: it says somebody owns this, it gives the eye a line
    to follow to the horizon, and it turns "open field" into "this field and
    that one".

    Built as overlapping slabs at jittered heights, because a dry-stone wall is
    a heap of stones that agree to be a wall, and a smooth extrusion reads as
    concrete.
    """
    rnd = _lcg(int(abs(x0 * 71 + y0 * 131)) + 5)
    span = math.hypot(x1 - x0, y1 - y0)
    n = max(2, int(span / 0.62))
    for i in range(n):
        u = (i + 0.5) / n
        px, py = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
        if gap_at is not None and abs(u * span - gap_at) < gap_w / 2:
            continue
        hh = h * (0.82 + 0.30 * rnd())
        z = height(px, py)
        t.add(A.box(f"wall{i}",
                    (px, py, z + hh / 2 - 0.06),
                    (0.34 + 0.06 * rnd(), 0.20 + 0.05 * rnd(), hh / 2),
                    M["rock"], bevel=0.05, seg=1))
        t.solid(px, py, 0.36, 0.24, top=z + hh)
    # a couple of cap stones sitting proud, so the top line is not level
    for k in range(max(1, n // 7)):
        u = (k + 0.5) / max(1, n // 7)
        px, py = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
        if gap_at is not None and abs(u * span - gap_at) < gap_w / 2:
            continue
        t.add(K.blob(f"wallcap{k}", (px, py, height(px, py) + h * 1.02),
                     (0.26, 0.20, 0.13), None, M["rock"], seg=9, rings=6,
                     squircle=2.6))


def ruin(M, t, cx, cy, yaw=0.0):
    """A shepherd's hut with its roof gone: somewhere to GO.

    The meadow's incident was all ON the path -- the ford, the encounters, the
    hill at the end -- so the entire middle of the map was scenery you crossed.
    A ruin thirty metres off the route is the cheapest possible reason to leave
    it: you can see it from the road, it resolves into something when you get
    there, and it has a doorway, a hearth and a fallen lintel to look at when
    you do.

    Deliberately roofless. A roof would make it an interior, and there are no
    interiors in this build -- an enterable box with nothing in it is worse than
    a ruin with sky in it.
    """
    parts = []
    z = height(cx, cy)
    w, d = 4.2, 3.2
    rnd = _lcg(int(abs(cx * 37 + cy * 53)) + 11)

    # four runs of wall at varying survival: the north wall is nearly whole,
    # the west has collapsed to knee height, and the south has the doorway
    # `rock`, NOT `stone`. The town textures its `stone` into ashlar; the meadow
    # never runs that pass, so out here `stone` is the raw palette entry at
    # 0.78/0.75/0.70 -- and eleven untextured slabs of it read as a row of
    # white cardboard boxes standing in a field. `rock` is the mid grey the dry
    # stone walls use, and those read as masonry.
    #
    # The blocks are also jittered in width, depth and yaw. Same width and same
    # depth with only the height varying is a bar chart, which is exactly what
    # the first version looked like.
    def run(name, ax, ay, bx, by, hi, lo, skip=None):
        span = math.hypot(bx - ax, by - ay)
        n = max(2, int(span / 0.46))
        for i in range(n):
            u = (i + 0.5) / n
            if skip and skip[0] <= u <= skip[1]:
                continue
            px, py = ax + (bx - ax) * u, ay + (by - ay) * u
            hh = (lo + (hi - lo) * (0.5 + 0.5 * math.sin(u * 5.1 + rnd()))) * (0.9 + 0.2 * rnd())
            bw = 0.22 + 0.12 * rnd()
            bd = 0.18 + 0.09 * rnd()
            blk = A.box(f"{name}{i}", (px, py, z + hh / 2), (bw, bd, hh / 2),
                        M["rock"], bevel=0.045, seg=1)
            K.transform(blk, rotate=(0, 0, (rnd() - 0.5) * 14), around=(px, py, 0))
            parts.append(blk)
            t.solid(px, py, bw + 0.06, bd + 0.06, top=z + hh)

    run("ruin_n", cx - w / 2, cy + d / 2, cx + w / 2, cy + d / 2, 2.3, 1.5)
    run("ruin_e", cx + w / 2, cy - d / 2, cx + w / 2, cy + d / 2, 2.0, 0.7)
    run("ruin_w", cx - w / 2, cy - d / 2, cx - w / 2, cy + d / 2, 1.1, 0.45)
    run("ruin_s", cx - w / 2, cy - d / 2, cx + w / 2, cy - d / 2, 1.8, 1.2,
        skip=(0.36, 0.64))            # the doorway

    # the door lintel, fallen across the threshold rather than sitting on it
    parts.append(K.tube("ruin_lintel", [
        {"p": Vector((cx - 0.55, cy - d / 2 - 0.55, z + 0.16)), "r": (0.17, 0.13), "n": 3.2},
        {"p": Vector((cx + 0.62, cy - d / 2 - 0.30, z + 0.13)), "r": (0.15, 0.12), "n": 3.2},
    ], seg=8, mat=M["rock"], squircle=3.2, up=(0, 0, 1)))

    # a hearth in the corner, which is what says somebody lived here
    parts.append(K.tube("ruin_hearth", [
        {"p": Vector((cx - w / 2 + 0.7, cy + d / 2 - 0.55, z)), "r": (0.52, 0.52), "n": 3.0},
        {"p": Vector((cx - w / 2 + 0.7, cy + d / 2 - 0.55, z + 0.22)), "r": (0.46, 0.46), "n": 3.0},
    ], seg=12, mat=M["rock"], squircle=3.0, up=(0, 0, 1)))
    parts.append(K.blob("ruin_ash", (cx - w / 2 + 0.7, cy + d / 2 - 0.55, z + 0.20),
                        (0.34, 0.34, 0.05), None, M["dirt"], seg=10, rings=6))

    # rubble where the roof went
    for k in range(9):
        rx = cx + (rnd() - 0.5) * (w + 1.4)
        ry = cy + (rnd() - 0.5) * (d + 1.4)
        sc = 0.16 + rnd() * 0.20
        parts.append(K.blob(f"ruin_rubble{k}", (rx, ry, height(rx, ry) + sc * 0.4),
                            (sc, sc * 0.85, sc * 0.55), None, M["rock"],
                            seg=8, rings=6, squircle=2.6))
    for o in parts:
        if yaw:
            K.transform(o, rotate=(0, 0, yaw), around=(cx, cy, 0))
    t.add(*parts)


def stream(M, t):
    """The water itself: a ribbon following the channel, plus banks.

    It sits at a constant depth below the LOCAL bed rather than at one flat
    level, because the channel crosses ground that rises three metres across the
    meadow and a truly level surface would be underground at one end and floating
    at the other. A stylised stream that follows its bed reads correctly and a
    physically level one does not -- this is the same trade the path makes.
    """
    x0, x1 = STREAM_X0, STREAM_X1
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
        # THE RIBBON IS WIDER THAN THE WATERLINE, ON PURPOSE.
        #
        # A narrow ribbon ends in mid-air: its edge sat 30 cm above the bank
        # under it, so the stream read as a strip of blue vinyl laid on grass,
        # with its own underside showing as a dark line. A water plane should be
        # BURIED in both banks and let the shoreline be wherever the plane and
        # the ground happen to meet -- which is also the only way the shore gets
        # to follow the bank's own wobble instead of being a swept curve.
        #
        # At bed+0.30 in a channel that climbs 1.6 m between d=1.1 and d=4.0,
        # the water meets the bank at about d=1.9, so 2.1 m of half-width puts
        # the edge safely inside the ground.
        sec.append({"p": Vector((x, y, min(bed + 0.30, bank - 0.14))),
                    "r": (STREAM_HALF * 0.66, 0.04), "n": 3.6})
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


def backdrop(M, t):
    """THE WORLD HAS TO END IN LANDSCAPE, NOT IN SKY.

    The meadow's own hills close it off at ground level, and from anywhere with
    a bit of elevation -- the outcrop, the far end of the path -- that stopped
    being true: the town read as four buildings with nothing under or beside
    them, and every horizon was a terrain silhouette against flat blue. There
    was nothing at all past the fog.

    So: two rings of ridges, far outside anywhere you can walk. They are a
    BACKDROP, and they are honest about it -- no collision, no shadow, no
    outline, and the runtime takes them out of the fog, because a painted
    distance that fogs is a painted distance that disappears. Two rings rather
    than one because a single silhouette reads as a wall, and the overlap
    between two is what makes it read as depth.

    Built as a curtain -- a strip between a base circle well below the horizon
    and a jagged top -- since only the part above the skyline is ever visible
    and a solid dome would be several thousand triangles of nothing.
    """
    cx, cy = 0.0, 65.0
    out = []
    for ring, (rad, base, lo, hi, mat, seed, ph) in enumerate((
            (175.0, -40.0, 16.0, 52.0, M["ridge_a"], 8821, 0.0),
            (245.0, -40.0, 34.0, 74.0, M["ridge_b"], 3307, 2.3))):
        rnd = _lcg(seed)
        n = 160
        verts, faces, tops = [], [], []
        for i in range(n):
            a = 2 * math.pi * i / n
            # THREE OCTAVES. The first pass used one slow sine plus a little
            # noise and then smoothed it, which left a nearly straight line
            # across the sky -- a wall, not a range. The lowest frequency is
            # the massif, the middle one the individual hills, the top one the
            # notches between them.
            k = (0.52 * (0.5 + 0.5 * math.sin(a * 2.0 + ph))
                 + 0.32 * (0.5 + 0.5 * math.sin(a * 5.0 + ph * 1.7 + 0.9))
                 + 0.16 * (0.5 + 0.5 * math.sin(a * 13.0 + ph * 0.6 + 2.2)))
            tops.append(lo + (hi - lo) * (0.86 * k + 0.14 * rnd()))
        # ONE light pass, only to take the per-column jitter off the peaks --
        # smoothing more than this is what flattened the first attempt
        tops = [(tops[i - 1] + 4.0 * tops[i] + tops[(i + 1) % n]) / 6.0
                for i in range(n)]
        for i in range(n):
            a = 2 * math.pi * i / n
            px, py = cx + rad * math.cos(a), cy + rad * math.sin(a)
            verts.append(Vector((px, py, base)))
            verts.append(Vector((px, py, tops[i])))
        for i in range(n):
            j = (i + 1) % n
            # WOUND INWARD, toward the play space. The obvious order --
            # base_i, base_j, top_j, top_i -- gives an OUTWARD normal, and
            # since the backdrop is a single-sided basic material that means a
            # ring of hills nobody can see from inside it. This order is the
            # reverse of the intuitive one for exactly that reason.
            faces.append((i * 2, i * 2 + 1, j * 2 + 1, j * 2))
        obj = K._new_obj(f"ridge{ring}", verts, faces, mat,
                         smooth=False, recalc=False)
        out.append(obj)
    t.add(*out)


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
        # THE BACKDROP IS PAINTED, NOT LIT. Aerial perspective is most of what
        # says "far away", so these are authored already hazed toward the sky
        # rather than left to a fog the runtime would have to reach 250 m to
        # apply. The far ring is bluer and lighter than the near one by about
        # the amount another sixty metres of air is worth.
        "ridge_a":  K.material("ridge_a", (0.40, 0.53, 0.52), roughness=1.0),
        "ridge_b":  K.material("ridge_b", (0.60, 0.71, 0.79), roughness=1.0),
    })

    t = A.Town(M)
    t.walk(build_terrain(M))
    landmark(M, t)
    outcrop(M, t)

    # FIELDS, so the meadow is country rather than ground. Two boundaries the
    # road passes through -- each one is a small event on the walk, and they
    # give the eye a line to follow all the way to the flanking hills.
    drywall(M, t, -22.0, 40.0, 30.0, 40.0, gap_at=27.7)      # path crosses at x~5.7
    drywall(M, t, -6.0, 68.0, 34.0, 68.0, gap_at=22.0)       # path crosses at x~16
    # a pen on the east side, which is where a herd of Woolts already grazes
    drywall(M, t, 14.0, 52.0, 30.0, 52.0)
    drywall(M, t, 30.0, 52.0, 30.0, 64.0)

    # SOMEWHERE TO GO that is not on the road. Visible from the path, twenty
    # metres west of it, at the point where the walk would otherwise be its
    # emptiest.
    ruin(M, t, RUIN[0], RUIN[1], yaw=18)
    stream(M, t)
    waymarks(M, t)
    backdrop(M, t)
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
    for o in (town, floor, *t.props):
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
        "streamX0": STREAM_X0, "streamX1": STREAM_X1,
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
