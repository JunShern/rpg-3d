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
import numpy as np
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

# THE DELL: a bowl of ground with a wood round its rim.
#
# The outdoor half is one open field, so "explore the meadow" means walking
# across the same space for ninety metres. A hollow is the cheapest enclosure
# available in a height field -- you cannot see into it until you are at the
# lip, the trees round the rim close the sky, and standing in the bottom the
# horizon is four metres of grass in every direction. That is a different
# SPACE, in the same square footage, made out of terrain the map already has.
#
# Sited in the emptiest stretch of the walk, which an audit timed as the first
# of two sags.
# (-22, 31), not (20, 44). The first siting put the hollow straight across the
# stream at y=47 AND the field wall at y=40 -- so the bowl cut the channel, the
# water plane ran through the clearing at an angle, and a dry-stone wall came
# over the rim. A hollow has to be somewhere the map is otherwise empty, which
# is the whole reason it is worth digging.
DELL = (-22.0, 31.0, 8.0, 2.6)     # x, y, radius, depth


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

    # the hollow, cut before the road and the water so both can still override it
    dx_, dy_, dr_, dd_ = DELL
    dd = math.hypot(x - dx_, y - dy_) / dr_
    if dd < 1.0:
        h -= dd_ * (math.cos(dd * math.pi) * 0.5 + 0.5) ** 1.25

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

# THE RAVINE. A stretch of the same watercourse cut three times as deep.
#
# The stream is a two-metre channel you step across, which is a nice event and
# not a place. Deepening one section turns the SAME feature into a second one:
# from the rim you look down into it, from the bed you are enclosed with four
# metres of rock either side and a strip of sky, and the crossing you already
# know is thirty metres away and still shallow. One number, two spaces.
#
# West of the ford, which sits at x = 7.7 -- a gorge across the crossing would
# make the road impassable, which is the one thing the stream must not do.
RAVINE_X, RAVINE_HALF, RAVINE_K = -14.0, 7.0, 2.6


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
    # ...and deeper still where the ravine is. Scaling the DEPTH and not the
    # width is what makes it a gorge: the banks climb the same 2.9 m of
    # horizontal, so at 2.6x they go from a shore you stroll down to a wall.
    deep = STREAM_DEPTH * (1.0 + (RAVINE_K - 1.0)
                           * (1.0 - _ramp(abs(x - RAVINE_X),
                                          RAVINE_HALF * 0.35, RAVINE_HALF)))
    cut = deep * (1.0 - _ramp(d, 1.1, STREAM_HALF + 0.8))
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
    # 1.8 / 4.8, NOT 2.6 / 6.4. At the old figures bare earth reached 3.6 m
    # either side of the centreline and the worn band nearly twelve metres --
    # which is a highway across a meadow, and once the ground blend became
    # smooth it was obvious that most of every outdoor frame was road. A track
    # a shepherd uses is about four metres wide including its verge.
    #
    # This also narrows the FLATTENING, since the same weight blends the road's
    # height into the terrain: the land now rolls closer to the path.
    d = abs(x - _path_x(y))
    return 1.0 - _ramp(d, 1.8, 4.8)


def on_path(x, y, margin=0.0):
    return abs(x - _path_x(y)) < 2.6 + margin


# ------------------------------------------------------------------- terrain

TERRAIN_STEP = 1.6


def build_terrain(M, step=TERRAIN_STEP):
    """The meadow floor: ONE material, coloured per vertex.

    IT USED TO BE THREE MATERIALS ASSIGNED PER FACE, and that is what made the
    grass/path boundary a staircase of 1.6 m rectangles -- an audit's phrase was
    "large axis-aligned quads of different tint in effectively every outdoor
    frame", verified against `__shadows(false)` so it was definitely the ground
    and not the shadow map. Noise on the threshold could only move the
    staircase, never remove it: the threshold is evaluated once per face, so the
    finest possible detail IS a face.

    A vertex colour interpolates across the face. The blend is now continuous,
    the noise can be sampled per vertex at whatever frequency suits, and the
    floor went from three materials to one -- so it is also two fewer draw
    calls and one fewer texture.
    """
    x0, x1 = MEADOW["x0"], MEADOW["x1"]
    y0, y1 = MEADOW["y0"] - 2.0, MEADOW["y1"]   # tuck under the plaza edge
    nx = int((x1 - x0) / step) + 1
    ny = int((y1 - y0) / step) + 1

    # The three tones the vertex colours interpolate between. They are the same
    # values the three textures used to carry, so the meadow reads as it did --
    # it is the transition between them that changed, not the palette.
    # DEEPER THAN THE TEXTURES WERE. The old grass image ran 0.52-0.62 in the
    # green and looked right; the same values as a vertex colour came out a
    # washed lime, because the texture is now neutral mottle centred near 1.0
    # and the toon ramp's lit band is 255 -- so the vertex colour is carrying
    # the whole of the hue with nothing pulling it down.
    GRASS = (0.36, 0.55, 0.25)
    VERGE = (0.47, 0.53, 0.32)
    DIRT = (0.58, 0.49, 0.37)
    # GRASS DOES NOT GROW ON A CLIFF. The ravine was cut four metres deep into
    # the same green as the field it runs through, so from the rim it read as a
    # crease in a lawn rather than as rock -- and the same was true of the
    # landmark hill's steep flank and of anything else the height function cut
    # hard. Slope is already known at every vertex; this just believes it.
    ROCK = (0.46, 0.43, 0.39)

    def mix(a, b, k):
        return tuple(a[i] + (b[i] - a[i]) * k for i in range(3))

    verts, faces, cols = [], [], []
    for j in range(ny):
        for i in range(nx):
            x = x0 + i * step
            y = y0 + j * step
            verts.append(Vector((x, y, height(x, y))))
            # PER VERTEX, and at a frequency finer than the grid. Three octaves
            # so the edge has both large bays and small fingers; the wavelengths
            # are chosen to beat against the 1.6 m spacing rather than line up
            # with it, which is what stops the result looking gridded again.
            n = (0.052 * math.sin(x * 2.10 + y * 1.70)
                 + 0.038 * math.sin(x * 4.37 - y * 3.91 + 1.9)
                 + 0.026 * math.sin(x * 7.73 + y * 6.11 + 0.4)
                 + 0.018 * math.sin(x * 13.1 - y * 11.7 + 2.7))
            # THE ROAD IS A TRACK, NOT A BEACH. The first vertex-coloured pass
            # put `dirt` at w >= 0.72 and `verge` from 0.20 -- and since
            # `_path_weight` only falls to zero at 6.4 m, that made the worn
            # band about nine metres of dirt inside thirteen of verge, which
            # swallowed most of every frame. Bare earth now needs 0.86, which
            # is inside 2.9 m of the centreline, and grass holds out to 0.34.
            w = _path_weight(x, y) + n
            if w <= 0.34:
                c = mix(GRASS, VERGE, max(0.0, w / 0.34) * 0.45)
            elif w >= 0.86:
                c = DIRT
            else:
                c = mix(mix(GRASS, VERGE, 0.45), DIRT, (w - 0.34) / 0.52)
            # ...then rock wherever it is too steep to hold soil. Sampled at
            # half the grid spacing so the reading is the slope of the SURFACE
            # rather than of the triangle, which matters right at the lip of a
            # cut where one is near zero and the other is near vertical.
            e = step * 0.5
            gx = (height(x + e, y) - height(x - e, y)) / (2 * e)
            gy = (height(x, y + e) - height(x, y - e)) / (2 * e)
            # 0.80 is 39 degrees and 1.45 is 55. The meadow's flanking hills run
            # about 0.58, so the horizon stays green; a ravine wall is over 2.
            rk = _ramp(math.hypot(gx, gy), 0.80, 1.45)
            if rk > 0:
                c = mix(c, ROCK, rk * (0.55 + 0.45 * rk))
            cols.append(c)
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            faces.append((a, a + 1, a + nx + 1, a + nx))

    # recalc=False: the winding above is (i,j) -> (i+1,j) -> (i+1,j+1) -> (i,j+1),
    # whose normal is X x Y = +Z, i.e. up. A heightfield is an OPEN surface, so
    # bmesh's normal repair has no volume to infer from and guesses -- here it
    # guessed down, and the whole meadow rendered black.
    obj = K._new_obj("floor_meadow", verts, faces, mat=M["ground_tex"], smooth=True,
                     recalc=False)
    K.set_vertex_colors(obj, cols)

    # PLANAR UVs FROM WORLD X/Y. The heightfield is gentle enough that projecting
    # straight down costs nothing visible, and the detail map is neutral mottle
    # rather than colour, so one continuous UV set over the whole floor is all
    # it needs.
    tile = 5.0
    K.set_uvs(obj, [(v.co.x / tile, v.co.y / tile) for v in obj.data.vertices])
    return obj


# --------------------------------------------------------------------- props

def copse(M, t, rnd):
    """A close wood round the dell's rim, and a clearing inside it.

    THE TREES ARE THE WALLS. Scattered trees are scenery you walk past; trees
    at two-metre spacing are a room you walk into, and the difference is
    entirely the spacing. Two rings -- an outer of tall broadleaves whose
    canopies close overhead, an inner of conifers at the lip -- with the middle
    left empty, because a clearing is the point and a wood with no clearing is
    just dense scenery.
    """
    dx_, dy_, dr_, _ = DELL
    # 18, not 26. At 26 the ring was 1.9 m between trunks, which is a palisade
    # rather than a wood -- and the camera boom has nowhere to go in it, so
    # standing in the clearing pulled the view inside a tree. Wider spacing with
    # more radial jitter reads as denser, not thinner, because the trunks stop
    # lining up.
    outer = 18
    for i in range(outer):
        a = 2 * math.pi * i / outer + 0.11
        r = dr_ * (0.88 + 0.26 * rnd())
        x, y = dx_ + math.cos(a) * r, dy_ + math.sin(a) * r
        if on_path(x, y, 3.0) or not _inside(x, y):
            continue
        tree(M, t, x, y, 1.15 + rnd() * 0.55, kind="broadleaf")
    inner = 8
    for i in range(inner):
        a = 2 * math.pi * i / inner + 0.7
        r = dr_ * (0.55 + 0.22 * rnd())
        x, y = dx_ + math.cos(a) * r, dy_ + math.sin(a) * r
        if on_path(x, y, 3.0) or not _inside(x, y):
            continue
        tree(M, t, x, y, 0.85 + rnd() * 0.45, kind="conifer")

    # WHAT IS IN THE CLEARING. A fallen trunk to break the floor, a ring of
    # stones that is not a fire (this one is nobody's camp), and a find -- the
    # dell is a detour and a detour has to pay.
    z0 = height(dx_, dy_)
    a = 0.9
    t.add(K.tube("dell_log", K.dome([
        {"p": Vector((dx_ - math.cos(a) * 2.2, dy_ - math.sin(a) * 2.2, z0 + 0.34)),
         "r": (0.34, 0.34), "n": 2.8},
        {"p": Vector((dx_ + math.cos(a) * 2.4, dy_ + math.sin(a) * 2.4, z0 + 0.26)),
         "r": (0.24, 0.24), "n": 2.8},
    ], at="both", steps=2, height=0.1), seg=8, mat=M["bark_dead"], squircle=2.8))
    t.solid(dx_, dy_, 2.4, 1.0, top=z0 + 0.6)
    for k in range(7):
        aa = 2 * math.pi * k / 7 + 0.3
        px, py = dx_ + math.cos(aa) * 3.4, dy_ + math.sin(aa) * 3.4
        sc = 0.22 + rnd() * 0.16
        t.add(K.blob(f"dell_stone{k}", (px, py, height(px, py) + sc * 0.3),
                     (sc, sc * 0.85, sc * 0.6), None, M["rock"], seg=8, rings=6,
                     squircle=2.6))
    A.embercap(t, dx_ + 1.4, dy_ - 2.6, z=height(dx_ + 1.4, dy_ - 2.6), scale=1.2)


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
    # the dell plants its own wood, at its own spacing; a stray scattered tree
    # inside the clearing is the one thing that would stop it reading as one
    if math.hypot(x - DELL[0], y - DELL[1]) < DELL[2] + 1.5 + pad:
        return False
    # THE SPINE'S CORRIDOR. The copse centred at (-14, 86) has an 11 m radius
    # and reaches the ridge's southern end, so without this a tree grows out of
    # the middle of the route -- and a tree standing on rock it does not know
    # about is a tree standing in mid-air.
    if SPINE["y0"] - 3.0 < y < SPINE["y1"] + 3.0 \
       and abs(x - _spine_x(y)) < 4.4 + pad:
        return False
    # THE ORCHARD IS PLANTED, so nothing may seed itself inside it -- one
    # scattered wild tree in the middle of a grid destroys the only thing the
    # grid is there to say.
    ocx, ocy, osp, on = ORCHARD
    if (abs(x - ocx) < (on - 1) / 2 * osp + 3.4 + pad
            and abs(y - ocy) < (on - 1) / 2 * osp + 3.4 + pad):
        return False
    return True


def scatter(M, t):
    """Density that VARIES. Trees cluster in copses and thin out between them;
    an even scatter reads as a spreadsheet however good the tree is."""
    rnd = _lcg(20260816)

    # (22, 30) IS THE ORCHARD NOW -- see `orchard`. A wild copse ten metres
    # from a planted one makes neither of them read.
    copses = [(-26, 34, 9), (-34, 62, 10), (30, 58, 9),
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
        # STRATA ON THE BIG ONES. Every rock in the meadow was one squashed
        # blob, so sixty of them were the same pebble at sixty sizes. A boulder
        # big enough to read as a boulder gets two or three offset slabs
        # instead -- bedding planes are what makes stone look like stone, and
        # they cost one extra primitive on the few that are actually large.
        if s > 0.42:
            # ANCHOR TO THE LOWEST CORNER OF ITS OWN FOOTPRINT, not to the
            # centre. Sinking the stack by a fixed fraction of the radius was
            # the wrong shape of fix: it is enough on gentle ground and not
            # enough on a steep flank, so boulders kept floating on exactly the
            # slopes where they are most visible against the sky. Sampling the
            # terrain at the slab's own corners and starting from the minimum
            # makes the bedding depend on the slope, which is what it always
            # depended on.
            zmin = min(height(x + dx * s, y + dy * s)
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            z = zmin
            layers = 2 + int(rnd() * 2)
            # BEDDED, not balanced on top. The layers are flat -- half-height
            # 0.26s against a radius of s -- and a flat slab on a slope floats
            # where the old round blob (half-height 0.62s) sank into it. On the
            # hillsides these read as rocks hanging in mid-air with their own
            # shadows underneath. The stack starts BELOW the surface so the
            # lowest bedding plane is buried on both sides.
            for k in range(layers):
                u = k / max(1, layers - 1)
                # -0.42, not -0.20. Deep enough that a flat slab stays bedded
                # on the steep flanks too -- the shallower value worked on the
                # gentle middle of the map and left boulders hanging off the
                # hillsides with their own shadows under them.
                lz = z + s * (-0.18 + 0.78 * u)
                lr = s * (1.0 - 0.30 * u) * (0.86 + 0.22 * rnd())
                # 0.34, not 0.26: at the thinner value a two-layer boulder was
                # a pair of discs lying on the grass, and sixty of them read as
                # paving slabs scattered across a field rather than as stone.
                t.add(K.blob(f"rock{len(t.parts)}",
                             (x + (rnd() - 0.5) * s * 0.32,
                              y + (rnd() - 0.5) * s * 0.32, lz),
                             (lr, lr * 0.84, s * 0.34), None, M["rock"],
                             seg=9, rings=5, squircle=3.2))
            t.solid(x, y, s * 0.9, s * 0.8, top=z + s)
        else:
            t.add(K.blob(f"rock{len(t.parts)}", (x, y, z + s * 0.35),
                         (s, s * 0.86, s * 0.62), None, M["rock"],
                         seg=9, rings=6, squircle=2.7))

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


def _tree_broadleaf(M, t, x, y, scale, rnd):
    """The round one: four overlapping canopy blobs on a tapering trunk."""
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
        t.camblock(cx, cy, cz, r * scale * 1.05)
    t.solid(x, y, 0.42 * scale, 0.42 * scale, top=z + h)


def _tree_conifer(M, t, x, y, scale, rnd):
    """The pointed one, and the reason the roster needed a second recipe.

    A meadow of nothing but round canopies has ONE silhouette repeated sixty
    times, and silhouette is the only thing a tree contributes at the distance
    most of them are seen. A cone against the sky is a different word in the
    same sentence. Four stacked skirts rather than a single cone, because a
    smooth cone reads as a traffic bollard.
    """
    z = height(x, y)
    h = 4.4 * scale
    t.add(K.tube(f"trunk{len(t.parts)}", K.dome([
        {"p": Vector((x, y, z - 0.15)), "r": (0.20 * scale, 0.20 * scale), "n": 2.6},
        {"p": Vector((x, y, z + h * 0.92)), "r": (0.07 * scale, 0.07 * scale), "n": 2.6},
    ], at="end", steps=2, height=0.08), seg=8, mat=M["bark"], squircle=2.6))
    tiers = 4
    for i in range(tiers):
        u = i / tiers
        cz = z + h * (0.24 + 0.66 * u)
        r = (1.32 - 0.86 * u) * scale
        t.add(K.tube(f"needle{len(t.parts)}", [
            {"p": Vector((x, y, cz)), "r": (r, r), "n": 2.4},
            {"p": Vector((x, y, cz + h * 0.055)), "r": (r * 0.90, r * 0.90), "n": 2.4},
            {"p": Vector((x, y, cz + h * 0.235)), "r": (r * 0.18, r * 0.18), "n": 2.4},
        ], seg=10, mat=M["leaf_lo"] if i % 2 else M["conifer"],
            squircle=2.4, up=(0, 0, 1)))
        t.camblock(x, y, cz + h * 0.10, r * 1.05)
    t.solid(x, y, 0.34 * scale, 0.34 * scale, top=z + h)


def _tree_snag(M, t, x, y, scale, rnd):
    """A dead one: bare, leaning, with two broken limbs.

    Every tree in the meadow was alive and vertical. One dead trunk per copse
    is the cheapest way to make the wood look like it has a history, and it is
    the only tree here with a readable BRANCH -- the living ones are trunk plus
    a cloud, so the shape of a tree is never actually drawn.
    """
    z = height(x, y)
    h = 3.1 * scale
    lean = (rnd() - 0.5) * 0.5
    la = rnd() * math.tau
    tipx, tipy = x + math.cos(la) * lean, y + math.sin(la) * lean
    t.add(K.tube(f"snag{len(t.parts)}", K.dome([
        {"p": Vector((x, y, z - 0.2)), "r": (0.30 * scale, 0.30 * scale), "n": 2.8},
        {"p": Vector((x + math.cos(la) * lean * 0.4, y + math.sin(la) * lean * 0.4,
                      z + h * 0.5)), "r": (0.18 * scale, 0.18 * scale), "n": 2.8},
        {"p": Vector((tipx, tipy, z + h)), "r": (0.07 * scale, 0.07 * scale), "n": 2.8},
    ], at="end", steps=2, height=0.1), seg=7, mat=M["bark_dead"], squircle=2.8))
    # THICKER AND LONGER THAN INSTINCT SAYS. The first pass tapered from 0.10
    # to 0.02 of scale over a metre, which at any distance is a hair -- so the
    # snag read as a bare pole and the one tree in the meadow with a drawn
    # BRANCH had no visible branches. A dead limb is a structural member.
    for k in range(3):
        a = la + 1.9 + k * 2.2
        bz = z + h * (0.46 + 0.19 * k)
        reach = (1.35 - 0.18 * k) * scale
        t.add(K.tube(f"limb{len(t.parts)}", K.dome([
            {"p": Vector((x, y, bz)), "r": (0.15 * scale, 0.15 * scale), "n": 2.6},
            {"p": Vector((x + math.cos(a) * reach * 0.55,
                          y + math.sin(a) * reach * 0.55, bz + 0.46 * scale)),
             "r": (0.095 * scale, 0.095 * scale), "n": 2.6},
            {"p": Vector((x + math.cos(a) * reach,
                          y + math.sin(a) * reach, bz + 0.62 * scale)),
             "r": (0.05 * scale, 0.05 * scale), "n": 2.6},
        ], at="end", steps=2, height=0.05), seg=6, mat=M["bark_dead"], squircle=2.6))
    t.solid(x, y, 0.34 * scale, 0.34 * scale, top=z + h)


def tree(M, t, x, y, scale, kind=None, rnd=None):
    """Place one tree. `kind` picks the silhouette; None means "by position".

    Deterministic from the coordinates rather than from a running counter, so
    adding a tree somewhere does not reshuffle every tree after it.
    """
    if rnd is None:
        rnd = _lcg(int(abs(x * 977 + y * 613)) + 3)
    if kind is None:
        k = (int(abs(x * 13.7 + y * 7.3)) % 10)
        kind = "conifer" if k < 3 else ("snag" if k == 3 else "broadleaf")
    ({"conifer": _tree_conifer, "snag": _tree_snag}.get(kind, _tree_broadleaf))(
        M, t, x, y, scale, rnd)


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

    # the altar: low, broad, and the only flat thing up here.
    #
    # `add`, not `walk`, and CAPPED -- the same two faults the outcrop's shelves
    # had. `walk` joins it into the FLOOR, whose grass blend is entirely vertex
    # colour, so it inherits (0,0,0) and the toon material multiplies by it;
    # and an uncapped tube is an open pipe you look down the unlit inside of
    # from the one place you are meant to stand. It has always been a black
    # slab with a hole in it at the centre of the monument.
    t.add(K.tube("stone_altar", K.dome([
        {"p": Vector((hx, hy, z + 0.02)), "r": (1.30, 0.95), "n": 3.4},
        {"p": Vector((hx, hy, z + 0.40)), "r": (1.18, 0.86), "n": 3.4},
    ], at="end", steps=2, height=0.06), seg=14, mat=M["rock"],
        squircle=3.4, up=(0, 0, 1)))
    t.platform(hx, hy, 1.05, 0.78, z + 0.46)


def drywall(M, t, x0, y0, x1, y1, gap_at=None, gap_w=4.2, h=0.92, on_road=False):
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
    # DERIVE THE GAP FROM THE ROAD, do not type it in twice. The first version
    # had both numbers written by hand, and the second wall's gap was at x=16
    # while `_path_x` puts the road at x=12 -- so the road ran straight into a
    # wall, which the walk check found by walking into it at 63 m. The lintel
    # up on the hill was the same mistake with different geometry.
    if on_road:
        gap_at = _path_x(y0) - x0
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

    # THE RAVINE'S FURNITURE. Boulders on the lip, so the drop is announced
    # before you are in it, and a find on the bed -- which is the only reason
    # to climb down rather than look.
    rr = _lcg(9151)
    for i in range(14):
        side = 1.0 if i % 2 else -1.0
        rx = RAVINE_X - RAVINE_HALF * 0.8 + RAVINE_HALF * 1.6 * (i / 14.0)
        ry = _stream_y(rx) + side * (STREAM_HALF + 1.2 + rr() * 0.9)
        sc = 0.42 + rr() * 0.5
        zmin = min(height(rx + dx * sc, ry + dy * sc)
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1))
        t.add(K.blob(f"ravine_rock{i}", (rx, ry, zmin + sc * 0.26),
                     (sc, sc * 0.8, sc * 0.55), None, M["rock"],
                     seg=9, rings=6, squircle=2.9))
        t.solid(rx, ry, sc * 0.9, sc * 0.75, top=zmin + sc * 0.8)
    bedx = RAVINE_X + 1.6
    bedy = _stream_y(bedx) + STREAM_HALF * 0.95
    A.embercap(t, bedx, bedy, z=height(bedx, bedy), scale=1.25)

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
        # EACH SHELF REACHES ITS OWN GROUND. `z0` is the hill's CENTRE height
        # and the hill falls away under every one of these, so a slab authored
        # 1.6 m deep from `top` hung between 1.7 and 3.7 m in the air -- five
        # tables in the sky, with correct collision, for as long as they existed.
        # It is the same fault `landmark` fixed for the standing stones, and it
        # went unnoticed here only because a degenerate sweep frame was drawing
        # these as nothing at all. Two bugs, each hiding the other.
        g = min(height(cx + dx * rx, cy + dy * ry)
                for dx in (-1, 0, 1) for dy in (-1, 0, 1))
        base = min(g - 0.35, top - 1.6)
        # a slab with a slightly smaller base, so it reads as stacked rock
        # rather than as a stack of boxes
        # `add`, NOT `walk`. `walk` puts a mesh in the FLOOR object, and the
        # floor carries the grass/path blend as a per-vertex colour -- so
        # joining a shelf into it gave the shelf's vertices no COLOR_0, which
        # Blender fills with (0,0,0), which the toon material multiplies by.
        # Five rock shelves rendered pure black. They do not need to be in the
        # floor at all: the ground raycast never runs here, because the meadow
        # answers "where is the floor" from the terrain function and the
        # PLATFORM these already declare.
        # CAPPED. A `tube` only closes an end where a ring has radius 0, so an
        # uncapped one is an open pipe -- and standing on top of it you look
        # straight down its inside, which is backfaces, which are unlit, which
        # is a black hole where the rock should be. A shallow dome reads as a
        # weathered top and closes the mesh.
        t.add(K.tube(f"shelf{i}", K.dome([
            {"p": Vector((cx, cy, base)), "r": (rx * 0.70, ry * 0.70), "n": 3.2},
            {"p": Vector((cx, cy, top - 1.05)), "r": (rx * 0.88, ry * 0.88), "n": 3.4},
            {"p": Vector((cx, cy, top - 0.40)), "r": (rx, ry), "n": 3.6},
            {"p": Vector((cx, cy, top - 0.10)), "r": (rx * 0.97, ry * 0.97), "n": 3.8},
        ], at="end", steps=2, height=0.10),
            seg=12, mat=M["rock"], squircle=3.6, up=(0, 0, 1)))
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


# THE SPINE: a rock ridge you walk over, west of the road.
#
# The meadow's verticality is all one surface -- the land rolls, the road
# climbs, and at no point are you ABOVE anything. The outcrop is the exception
# and it is five shelves at the very end of the walk. This is a second one,
# sited in the western half where the map is otherwise a field: twenty-two
# metres of rock rising three and a half above the grass, with faces too steep
# to climb on both flanks, so the only way across is over the ends.
#
# It EMERGES AND SUBMERGES rather than ending in a cliff at each end. A ridge
# that stops dead is a wall with a 3.8 m drop off the back, and walking off a
# drop in this engine is an instant snap to the ground below rather than a fall
# -- so the one exit would look broken. Ramping the lift in over the first
# eight metres and out over the last seven makes it a route: you walk up onto
# it, along it, and down off it, and the drops are the SIDES, which is where
# they belong.
#
# It is 22 m west of the road, in the same westward country as the ruin, so the
# two read as one detour rather than two -- a hut in the lee of a rock.
# half 1.45, not 1.9: at 3.8 m tall and 3.8 m wide the thing is as broad as it
# is high, which is a barrow. Narrower than it is tall is what makes a rock
# spine read as one.
SPINE = dict(x=-10.0, y0=60.0, y1=82.0, h=3.8, half=1.45)


def _spine_x(y):
    """The crest wanders, so it is a landform and not an extruded rectangle."""
    return (SPINE["x"] + 1.6 * math.sin((y - SPINE["y0"]) * 0.090)
            + 0.6 * math.sin((y - SPINE["y0"]) * 0.230))


def _spine_lift(y):
    # RAMPED OVER TWELVE METRES, NOT EIGHT, and the segments are 0.6 m rather
    # than 1.5. Both numbers are set by the runtime's 45 cm step limit and
    # nothing else: the crest is a row of flat-topped platforms, so the height
    # difference between two ADJACENT ones is a step the player has to take.
    # At the first figures that step reached 1.3 m and the ridge was scenery.
    return (SPINE["h"] * _ramp(y, SPINE["y0"], SPINE["y0"] + 14.0)
            * (1.0 - _ramp(y, SPINE["y1"] - 10.0, SPINE["y1"])))


def spine(M, t):
    rnd = _lcg(5531)
    step = 0.5
    n = int((SPINE["y1"] - SPINE["y0"]) / step) + 1
    peak_y, peak_z = 0.0, -99.0
    sections = []
    for i in range(n):
        y = SPINE["y0"] + i * step
        cx = _spine_x(y)
        top = height(cx, y) + _spine_lift(y)
        base = height(cx, y) - 1.5
        # JITTERED HARD. Swept from a smooth profile the ridge came out as a
        # perfect lens -- a whale, or a long barrow, but not rock. What makes
        # stone read as stone here is facets at varying angles, so the width
        # wanders on three frequencies and the crest is knocked about with it.
        hw = (SPINE["half"] + 0.38 * math.sin(y * 0.31)
              + 0.30 * math.sin(y * 0.87 + 1.3) + 0.22 * math.sin(y * 1.9 + 0.4)
              + 0.16 * (rnd() - 0.5))
        # WIDER THAN THE PLATFORM, AND STOPPING 30 CM SHORT OF THE CREST.
        # `pushOut` ignores a box once you are more than 0.2 m above its top, so
        # a solid flush with the crest would shove you off your own footing;
        # one that stops below it still fences the faces, which is the job.
        t.platform(cx, y, hw * 0.70, step * 0.62, top)
        # ONLY WHERE THERE IS A FLANK TO FENCE. `pushOut` ignores a box once you
        # are more than 0.2 m above its top, so a solid 0.30 m under the crest
        # is transparent to someone standing ON the crest and solid to someone
        # beside it -- which is exactly right in the middle of the ridge and
        # impossible at its ends, where the crest IS the ground. Emitting them
        # the whole length fenced off the toe, and the toe is the only way up:
        # measured, she reached one waypoint of eight and stopped 2.7 m short of
        # the second, at 3.08 m against a crest that peaks at 9.29.
        if _spine_lift(y) >= SPINE_SINK + 0.38:
            # STRICTLY INSIDE THE PLATFORM, and this is the whole trick. It was
            # 0.94 against the platform's 0.70 -- deliberately wider, so the
            # rock would fence you off before you reached the edge -- and that
            # leaves a 0.4 m annulus where you are blocked by the solid and NOT
            # supported by the platform. Walk into it and you wedge, which is
            # exactly what happened: she got two waypoints of eight and stopped
            # dead at 5.16 m on the west flank.
            #
            # Narrower is safe because the platform already does the blocking:
            # `tryMove` refuses any step over 0.45 m, so the crest fences itself
            # from below. The solid is only here for the camera and for not
            # walking through the rock at head height.
            t.solid(cx, y, hw * 0.62, step * 0.62, top=top - SPINE_SINK)
        if top > peak_z:
            peak_y, peak_z = y, top

    # FLAT SHADED, and this is the difference between rock and a dune. The toon
    # ramp is a hard two-step, so on a large SMOOTH surface the unlit band comes
    # out as one continuous black shape the size of the whole hillside. Faceting
    # gives every plane its own band, which is both what low-poly rock is
    # supposed to look like and the only thing that breaks that black up.
    # THE SHAPE IS CHUNKS; THE COLLISION IS A CURVE. Swept as one smooth tube
    # this came out a perfect lens -- a whale, or a long barrow -- and jittering
    # the profile did not save it, because the fault was the continuity and not
    # the noise. Rock in this world is made of blobs: the boulders are, the dell
    # stones are, and they read correctly. So the ridge is fourteen overlapping
    # masses, and the 45 fine platforms underneath are free to stay on the clean
    # curve because nothing requires the two to be the same object.
    rk = _lcg(8823)
    for k in range(14):
        y = SPINE["y0"] + 0.6 + k * (SPINE["y1"] - SPINE["y0"] - 1.2) / 13.0
        cx = _spine_x(y) + (rk() - 0.5) * 0.55
        top = height(_spine_x(y), y) + _spine_lift(y)
        base = height(_spine_x(y), y) - 1.5
        w = SPINE["half"] * (1.02 + 0.30 * rk())
        t.add(K.blob(f"spine{k}",
                     (cx, y + (rk() - 0.5) * 0.5, (top + base) / 2 + (rk() - 0.5) * 0.22),
                     (w, 1.15 + 0.5 * rk(), (top - base) / 2 * (1.0 + 0.10 * rk())),
                     None, M["rock"], seg=8, rings=6, squircle=2.5 + 0.9 * rk()))

    # A DEAD TREE OUT OF THE ROCK at the high point, because a bare rock spine
    # has no silhouette against the sky -- and this is the thing you see from
    # the road that tells you the ridge is there at all.
    sx = _spine_x(peak_y - 1.2)
    _tree_snag(M, t, sx + 0.9, peak_y - 1.2, 0.85, _lcg(991))
    # and the reason to walk it
    A.embercap(t, _spine_x(peak_y) - 0.5, peak_y, z=peak_z, scale=1.15)
    # loose stones along the crest, the same lip the outcrop's top shelf has
    for k in range(9):
        yy = SPINE["y0"] + 2.0 + k * 2.3
        px = _spine_x(yy) + (0.9 if k % 2 else -0.9)
        pz = height(_spine_x(yy), yy) + _spine_lift(yy)
        sc = 0.20 + rnd() * 0.15
        t.add(K.blob(f"spine_lip{k}", (px, yy, pz + sc * 0.25),
                     (sc, sc * 0.9, sc * 0.6), None, M["rock"], seg=8, rings=6,
                     squircle=2.6))


# THE ORCHARD: cultivated ground, in a map that is otherwise wild or built.
#
# Every tree in the meadow is scattered -- clustered into copses, jittered,
# deliberately irregular, and correctly so, because that is what a wood looks
# like. The consequence is that the whole outdoors reads as ONE kind of place:
# nature, at varying density. A grid of small trees behind a wall says
# something no amount of scatter can, which is that people live here and this
# ground belongs to somebody. It is the same job the field walls do and it does
# it with the asset the map is already made of.
#
# It takes the place of the wild copse that used to sit here rather than being
# added beside it: the point is a contrast between kinds of wood, and two woods
# ten metres apart would just be more trees.
# SPACING IS SET BY THE CAMERA, not by horticulture. At 3.4 m with a two-metre
# canopy the gaps are 1.4 m and the boom is inside a tree from anywhere except
# straight down a row -- the capture from inside the rows was the interior of a
# trunk. The dell learned this the same way and was thinned for it. 4.2 m with
# a smaller crown leaves 2.3 m of air, which is also just what an orchard is.
ORCHARD = (19.0, 30.5, 4.2, 5)      # cx, cy, spacing, rows/cols
ORCHARD_YAW = math.radians(9.0)     # off-axis, because nothing else here is

# HOW FAR THE SPINE'S FLANK SOLIDS SIT BELOW ITS CREST, and the number is
# forced, not chosen. `pushOut` ignores a box only once you are more than 0.2 m
# ABOVE its top -- so walking uphill along the crest you arrive at each segment
# from the one before it, one step lower, and that step has to fit inside the
# sink with the 0.2 m tolerance to spare:
#
#     sink  >  (largest step between adjacent crest platforms) + 0.2
#
# The largest step is 0.30 by construction (see `_spine_lift`), so anything at
# or under 0.50 fences the ridge off from itself. It was 0.42, and she stopped
# dead at 5.16 m on a crest that peaks at 9.29 -- with the solid whose top was
# 5.03 refusing her at 5.16 because 5.16 is not more than 5.23.
#
# The other side of the constraint: a flank is only blocked while the ground
# beside it is at or below sink + 0.2 under the crest, which is why the solids
# start where the lift passes SPINE_SINK + 0.38 rather than at the toe.
SPINE_SINK = 0.72


def _orchard_xy(i, j, jitter=None):
    cx, cy, sp, n = ORCHARD
    u, v = (i - (n - 1) / 2) * sp, (j - (n - 1) / 2) * sp
    if jitter:
        u += jitter[0]
        v += jitter[1]
    c, s_ = math.cos(ORCHARD_YAW), math.sin(ORCHARD_YAW)
    return cx + u * c - v * s_, cy + u * s_ + v * c


def orchard(M, t):
    cx, cy, sp, n = ORCHARD
    rnd = _lcg(31771)
    for j in range(n):
        for i in range(n):
            # REGULAR, BUT NOT PERFECT. A dead-exact grid reads as a texture
            # rather than as planting; a quarter of a metre of wander is what
            # makes it look like somebody walked out with a line and a spade.
            x, y = _orchard_xy(i, j, ((rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5))
            sc = 0.60 + rnd() * 0.10
            tree(M, t, x, y, sc, kind="broadleaf", rnd=_lcg(int(x * 91 + y * 57) + 5))
            # fruit, which is the whole reason this reads as an orchard and not
            # as a suspiciously tidy wood
            # ON THE OUTSIDE OF THE CANOPY, which is the only place it can be
            # seen. The first pass put the fruit 0.4-0.7 m from the trunk at the
            # crown's lower edge -- entirely inside the canopy blobs, whose main
            # sphere is 1.45 scale units across. Twenty-five trees of invisible
            # fruit, and the capture showed a suspiciously tidy wood.
            z = height(x, y) + 2.6 * sc
            for k in range(6):
                a = 6.2831 * (k / 6) + rnd() * 0.7
                r = (1.16 + rnd() * 0.26) * sc
                t.add(K.blob(f"fruit{len(t.parts)}",
                             (x + math.cos(a) * r, y + math.sin(a) * r,
                              z + (0.92 + rnd() * 0.34) * sc),
                             (0.13 * sc, 0.13 * sc, 0.125 * sc),
                             None, M["fruit"], seg=6, rings=5, squircle=2.1))

    # WALLED ON THE TWO SIDES YOU APPROACH FROM. The y=40 field wall already
    # closes the far side, so two more make an enclosure rather than a fence.
    half = (n - 1) / 2 * sp + 2.2
    drywall(M, t, cx - half, cy - half, cx - half, cy + half,
            gap_at=half * 0.86, gap_w=3.0)
    drywall(M, t, cx - half, cy - half, cx + half, cy - half)

    # the harvest, stacked by the gate -- and the meadow's first breakables,
    # which until now were a town-only idea for no reason anyone chose
    gx, gy = cx - half + 1.5, cy - half * 0.10
    A.crate(t, gx, gy, s=0.40, yaw=14, z0=height(gx, gy))
    A.crate(t, gx + 0.95, gy - 0.35, s=0.34, yaw=-8, z0=height(gx + 0.95, gy - 0.35))
    A.barrel(t, gx + 0.35, gy + 1.05, r=0.33, h=0.80, z0=height(gx + 0.35, gy + 1.05))
    # and the reason to walk in past them
    ox, oy = _orchard_xy(n - 1, 1)
    A.embercap(t, ox + 1.5, oy, z=height(ox + 1.5, oy), scale=1.05)


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


def approach(M, t):
    """The first twenty metres of road outside the gate.

    This is the most-looked-at ground in the demo and it had nothing on it. You
    cross it leaving town, you cross it coming back, and coming back it is
    framed dead centre by the gateway arch -- so it is the foreground of the one
    composition the player sees more than any other, and it was bare grass with
    two bollards.

    A milestone, a fingerpost and a pair of mounting blocks. None of it is a
    route or a reward; it is the furniture that says a road is a ROAD and not a
    worn line across a field, and it gives that foreground something to be.
    """
    M_, out = t.M, []
    rnd = _lcg(5507)

    # THE MILESTONE, on the verge where the paving ends
    mx, my = _path_x(GATE_Y + 3.2) + 3.1, GATE_Y + 3.2
    mz = height(mx, my)
    out.append(K.tube("milestone", K.dome([
        {"p": Vector((mx, my, mz - 0.20)), "r": (0.30, 0.22), "n": 3.0},
        {"p": Vector((mx, my, mz + 0.62)), "r": (0.26, 0.19), "n": 3.2},
        {"p": Vector((mx, my, mz + 0.86)), "r": (0.24, 0.17), "n": 3.4},
    ], at="end", steps=2, height=0.16), seg=10, mat=M_["stone"], squircle=3.2,
        up=(0, 0, 1)))
    t.solid(mx, my, 0.34, 0.26, top=mz + 1.0)

    # THE FINGERPOST, on the other side so the two frame the road
    fx, fy = _path_x(GATE_Y + 6.0) - 3.3, GATE_Y + 6.0
    fz = height(fx, fy)
    out.append(K.tube("signpost", K.dome([
        {"p": Vector((fx, fy, fz - 0.15)), "r": (0.085, 0.085), "n": 2.6},
        {"p": Vector((fx, fy, fz + 2.05)), "r": (0.068, 0.068), "n": 2.6},
    ], at="end", steps=2, height=0.08), seg=8, mat=M_["bark"], squircle=2.6,
        up=(0, 0, 1)))
    # two arms, pointing opposite ways, at different heights -- a fingerpost
    # with one arm reads as a broken post
    for k, (sgn, hz, ln) in enumerate(((1, 1.86, 0.62), (-1, 1.52, 0.52))):
        ax = fx + sgn * (ln / 2 + 0.07)
        o = A.box(f"signarm{k}", (ax, fy, fz + hz), (ln / 2, 0.035, 0.11),
                  M_["timber"], bevel=0.02, seg=1)
        K.transform(o, rotate=(0, 0, 11 * sgn), around=(fx, fy, 0))
        out.append(o)
    t.solid(fx, fy, 0.16, 0.16, top=fz + 2.1)

    # MOUNTING BLOCKS flanking the road at the paving edge: two steps of cut
    # stone, the thing you would actually find at a town gate
    for sgn in (-1, 1):
        bx = _path_x(GATE_Y + 1.4) + sgn * 4.4
        by = GATE_Y + 1.4
        bz = height(bx, by)
        for k, (w, h) in enumerate(((0.62, 0.24), (0.44, 0.46))):
            out.append(A.box(f"block{sgn}_{k}", (bx, by, bz + h / 2),
                             (w, 0.46 - 0.10 * k, h / 2), M_["stone"],
                             bevel=0.04, seg=1))
        t.solid(bx, by, 0.66, 0.50, top=bz + 0.50)

    # and a scatter of blooms along the verge, which is the one place the eye
    # rests on the ground for any length of time
    for k in range(26):
        yy = GATE_Y + 1.5 + rnd() * 17.0
        side = 1.0 if k % 2 else -1.0
        xx = _path_x(yy) + side * (2.9 + rnd() * 3.4)
        if not _inside(xx, yy):
            continue
        tuft(M, t, xx, yy, rnd)

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
    for nm, fn in (("ground", surface_tex.ground_detail),):
        path = os.path.abspath(f"public/assets/tex/{nm}.png")
        surface_tex.write_png(path, fn())
        M[f"{nm}_tex"] = K.image_material(
            f"{nm}_tex", bpy.data.images.load(path, check_existing=True),
            roughness=0.92, preview=(0.98, 0.98, 0.98), vertex_color="Col")
    M.update({
        "grass":    K.material("grass", (0.44, 0.62, 0.30), roughness=0.9),
        "grass_hi": K.material("grass_hi", (0.58, 0.74, 0.34), roughness=0.9),
        "dirt":     K.material("dirt", (0.56, 0.46, 0.34), roughness=0.95),
        "bark":     K.material("bark", (0.34, 0.25, 0.19), roughness=0.9),
        "leaf":     K.material("leaf", (0.32, 0.55, 0.28), roughness=0.85),
        "leaf_lo":  K.material("leaf_lo", (0.24, 0.44, 0.24), roughness=0.85),
        # A COLDER, DEEPER GREEN for the conifers, so the second silhouette is
        # also a second colour -- two shapes in one hue still read as one kind
        # of tree at the distance most of them are seen.
        "conifer":  K.material("conifer", (0.20, 0.36, 0.30), roughness=0.9),
        # dead wood is GREY, not brown: a bare trunk in bark colour reads as a
        # living tree whose leaves failed to load
        "bark_dead": K.material("bark_dead", (0.44, 0.41, 0.36), roughness=0.95),
        "rock":     K.material("rock", (0.52, 0.50, 0.48), roughness=0.9),
        "bloom_a":  K.material("bloom_a", (0.94, 0.86, 0.42), roughness=0.7),
        # ORCHARD FRUIT: warm red-orange, which is the only warm accent in the
        # whole outdoor palette and therefore the thing that will read from the
        # road at thirty metres.
        "fruit":    K.material("fruit", (0.86, 0.38, 0.24), roughness=0.72),
        "bloom_b":  K.material("bloom_b", (0.86, 0.52, 0.72), roughness=0.7),
        # THE BACKDROP IS PAINTED, NOT LIT. Aerial perspective is most of what
        # says "far away", so these are authored already hazed toward the sky
        # rather than left to a fog the runtime would have to reach 250 m to
        # apply. The far ring is bluer and lighter than the near one by about
        # the amount another sixty metres of air is worth.
        "ridge_a":  K.material("ridge_a", (0.40, 0.53, 0.52), roughness=1.0),
        "ridge_b":  K.material("ridge_b", (0.60, 0.71, 0.79), roughness=1.0),
    })

    # TEXTURE THE STONE AND THE BARK. The town runs a texture pass and the
    # meadow never did, so its boulders, walls, standing stones, ruin and tree
    # trunks were flat palette colours -- which is most of what you look at out
    # here, and it read as a clear step down from the plaza. One greyscale
    # generator per surface kind, TINTED per material, the same arrangement the
    # town uses. `stone`, not ashlar: coursed masonry is right for a dressed
    # wall and wrong for a boulder.
    #
    # This has to happen BEFORE `A.Town(M)`, or the pieces built during
    # assembly capture the old flat materials -- the same ordering trap the
    # town's ground textures hit.
    for key, fn, tint in (("rock", surface_tex.stone_rough, (0.52, 0.50, 0.48)),
                          ("stone", surface_tex.stone_rough, (0.74, 0.72, 0.68)),
                          ("bark", surface_tex.bark_rough, (0.44, 0.34, 0.25)),
                          ("bark_dead", surface_tex.bark_rough, (0.44, 0.41, 0.36))):
        path = os.path.abspath(f"public/assets/tex/m_{key}.png")
        surface_tex.write_png(path, np.clip(fn() * np.array(tint, np.float32), 0, 1))
        M[key] = K.image_material(
            f"m_{key}_tex", bpy.data.images.load(path, check_existing=True),
            roughness=0.95, preview=tint)

    t = A.Town(M)
    t.walk(build_terrain(M))
    landmark(M, t)
    outcrop(M, t)
    spine(M, t)

    # FIELDS, so the meadow is country rather than ground. Two boundaries the
    # road passes through -- each one is a small event on the walk, and they
    # give the eye a line to follow all the way to the flanking hills.
    drywall(M, t, -22.0, 40.0, 30.0, 40.0, on_road=True)
    # this one starts AT the rock spine rather than three metres short of
    # it, so the boundary reads as running up to the outcrop and stopping,
    # which is what a field wall does when it meets one
    drywall(M, t, -9.0, 68.0, 34.0, 68.0, on_road=True)
    # a pen on the east side, which is where a herd of Woolts already grazes
    drywall(M, t, 14.0, 52.0, 30.0, 52.0)
    drywall(M, t, 30.0, 52.0, 30.0, 64.0)

    # SOMEWHERE TO GO that is not on the road. Visible from the path, twenty
    # metres west of it, at the point where the walk would otherwise be its
    # emptiest.
    ruin(M, t, RUIN[0], RUIN[1], yaw=18)
    orchard(M, t)
    copse(M, t, _lcg(60413))

    # EMBERCAPS, at the places the road does not take you. Each one is the
    # payoff for a detour that until now paid nothing: inside the ruin, at the
    # centre of the stone ring, on the outcrop's top shelf, in the far copse,
    # and one under the ford's bank where you would only look if you went down
    # to the water.
    hx, hy, _, _ = HILL
    A.embercap(t, RUIN[0] + 0.9, RUIN[1] + 0.6, z=height(RUIN[0] + 0.9, RUIN[1] + 0.6))
    A.embercap(t, hx - 0.4, hy - 0.6, z=height(hx, hy) + 0.48, scale=1.15)
    A.embercap(t, hx + 2.9, hy + 3.1, z=height(hx, hy) + 2.10, scale=1.1)
    A.embercap(t, -33.0, 62.0, z=height(-33.0, 62.0))
    A.embercap(t, -9.0, STREAM_Y - 3.1, z=height(-9.0, STREAM_Y - 3.1))
    stream(M, t)
    approach(M, t)
    waymarks(M, t)
    backdrop(M, t)
    scatter(M, t)

    town, floor = A.finish(t, name_town="MEADOW", name_floor="FLOOR_MEADOW")
    # Per-face planar projection for everything that is not the ground -- the
    # floor carries its own world-planar UVs from `build_terrain`.
    K.box_uvs(town, tile=1.6)
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
        export_materials='EXPORT', export_texcoords=True, export_normals=True,
        # COLOR_0 OR THE GROUND IS ONE FLAT TONE. The meadow floor is a single
        # material whose grass/path blend lives entirely in a vertex colour
        # layer, so an export that drops attributes ships a beige field.
        export_vertex_color='MATERIAL', export_all_vertex_colors=True)
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
        "gateY": GATE_Y, "pathX": PATH_X, "hill": list(HILL), "dell": list(DELL),
        "x0": MEADOW["x0"], "x1": MEADOW["x1"], "y1": MEADOW["y1"],
        "streamY": STREAM_Y, "streamDepth": STREAM_DEPTH, "streamHalf": STREAM_HALF,
        "streamX0": STREAM_X0, "streamX1": STREAM_X1,
        "ravine": [RAVINE_X, RAVINE_HALF, RAVINE_K],
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
