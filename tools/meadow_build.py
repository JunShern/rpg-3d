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


# WHERE THE ROAD STOPS FOLLOWING THE HILL, AND HOW STEEPLY IT IS ALLOWED TO
# CLIMB AFTER THAT. Both are mirrored in terrain.js -- `check()` compares the
# two implementations at 56 probes and will say so if they drift.
GRADE_Y, GRADE = 86.0, 0.40


def _smooth_z(y):
    """The natural ground along the road's own centreline, low-passed over
    about twenty metres."""
    s = 0.0
    n = 0.0
    for k in range(-4, 5):
        yy = y + k * 2.6
        w = 1.0 - abs(k) / 5.0
        s += w * _natural(_path_x(yy), yy)
        n += w
    return s / n


def _road_z(y):
    """The road's height. Smoothed ground, and above y=86 a GRADED climb.

    The docstring here used to say "a road grades a hill -- it cuts the crests
    and fills the hollows", and the code did no such thing: it low-passed the
    ground over twenty metres, which smooths bumps and preserves slope exactly.
    Where the ground is steep the road was equally steep, and north of the
    landmark the boundary hill runs at 0.6 to 0.8.

    That is a 35-to-40-degree ramp, and it made the last third of the journey
    unplayable in a way no capture had ever been pointed at. The camera sits at
    polar 1.22 and looks 20.1 degrees DOWN, so the top of the frame is 5.9
    degrees ABOVE horizontal -- and measured along the road, the ground crossed
    that line 2.5 metres ahead at every single point of the climb. You walked
    thirty metres uphill looking at nothing but dirt. Raising the camera cannot
    fix it: even jammed against the polar clamp at 1.48 the frame top only
    reaches 20.8 degrees, against a slope of 35.

    So the road now does what it always claimed to. Above GRADE_Y it leaves the
    ground and climbs at a fixed 0.40, which puts the ground clear of the frame
    at 5.6 m instead of 2.5 -- and by the top it is running 4.8 m BELOW the
    ridge it used to sit on top of. That is a cutting, and it is the good kind
    of consequence: the pass's rock walls stopped being decoration standing
    beside a road and became the faces the road was cut through.
    """
    s = _smooth_z(y)
    if y <= GRADE_Y:
        return s
    # eased in over six metres so the join is a curve, not a kink -- the road
    # is one continuous surface and a discontinuity in its slope would read as
    # a crease straight across it
    w = _ramp(y - GRADE_Y, 0.0, 6.0)
    return s * (1 - w) + (_smooth_z(GRADE_Y) + GRADE * (y - GRADE_Y)) * w


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
# How far the floor is built PAST the playable bounds. See build_terrain.
SKIRT = 12.0


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
    # THE SKIRT. The mesh used to stop exactly on the playable bounds, and the
    # camera does not: the boom reaches dist * sin(polar) = 5.07 m past the
    # player, and the player can stand hard against the clamp. At the top of
    # the north road -- the best view in the game, the whole valley and the
    # town hazed behind it -- turning to look back puts the camera at blender
    # y = 115.6 with the world ending at 110, so the bottom of that frame is
    # SKY: you are looking under the edge of the ground you are standing on.
    #
    # `owns()` still uses MEADOW, so the playable region and the clamp are
    # unchanged; only the mesh grows. 12 m covers the 5.07 m boom, the near
    # clip and enough ground beyond the camera that the cut edge is never the
    # nearest thing in frame. It costs about 3,700 triangles on a 6,120
    # triangle floor and buys back all four edges of the map, not just this one.
    x0, x1 = MEADOW["x0"] - SKIRT, MEADOW["x1"] + SKIRT
    y0, y1 = MEADOW["y0"] - 2.0, MEADOW["y1"] + SKIRT   # tuck under the plaza
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
    GRASS_DARK = (0.29, 0.48, 0.24)
    GRASS_WARM = (0.46, 0.58, 0.25)
    VERGE = (0.45, 0.51, 0.30)
    # DIRT AT 0.50, NOT 0.58. The key is 2.8 and the toon ramp's lit band is
    # 0.97 of it, so a sun-facing slope in earth colour lands at 1.6 before
    # the tone map and comes out cream. The pass cutting -- a third of the
    # frame at the top of the north road, facing the sun -- was one pale mass
    # through four attempts on the texture, the tint and the rim. It was the
    # albedo all along: earth is darker than that.
    DIRT = (0.50, 0.41, 0.30)
    # GRASS DOES NOT GROW ON A CLIFF. The ravine was cut four metres deep into
    # the same green as the field it runs through, so from the rim it read as a
    # crease in a lawn rather than as rock -- and the same was true of the
    # landmark hill's steep flank and of anything else the height function cut
    # hard. Slope is already known at every vertex; this just believes it.
    ROCK = (0.40, 0.37, 0.33)

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
            # THE FIELD IS NOT ONE GREEN. A meadow has drier ground and wetter
            # ground, and it reads as one at the scale of a whole slope: a
            # slow mottle between a darker, bluer green and a warmer, drier one,
            # twelve to twenty metres across, under everything the path does.
            mot = (0.5 + 0.5 * math.sin(x * 0.31 + y * 0.17 + 0.8)
                   + 0.5 * math.sin(x * 0.13 - y * 0.29 + 2.1)
                   + 0.25 * math.sin(x * 0.53 + y * 0.47 + 4.0)) / 1.75
            grass = (mix(GRASS, GRASS_DARK, max(0.0, 0.5 - mot) * 1.6) if mot < 0.5
                     else mix(GRASS, GRASS_WARM, (mot - 0.5) * 1.6))
            w = _path_weight(x, y) + n
            if w <= 0.34:
                c = mix(grass, VERGE, max(0.0, w / 0.34) * 0.45)
            elif w >= 0.86:
                c = DIRT
            else:
                c = mix(mix(grass, VERGE, 0.45), DIRT, (w - 0.34) / 0.52)
            # ...then rock wherever it is too steep to hold soil. Sampled at
            # half the grid spacing so the reading is the slope of the SURFACE
            # rather than of the triangle, which matters right at the lip of a
            # cut where one is near zero and the other is near vertical.
            e = step * 0.5
            gx = (height(x + e, y) - height(x - e, y)) / (2 * e)
            gy = (height(x, y + e) - height(x, y - e)) / (2 * e)
            # 0.55 is 29 degrees and 0.95 is 44. The meadow's flanking hills run
            # about 0.58, so the horizon stays green (2% rock); a ravine wall
            # is over 2. The PASS CUTTING is the case that set these: six
            # metres deep over eight of run is 0.75, and at the old 0.80 floor
            # its walls -- a third of the frame at the top of the north road --
            # were painted as dirt and rendered as one pale sandy mass.
            rk = _ramp(math.hypot(gx, gy), 0.55, 0.95)
            if rk > 0:
                # STRATA IN THE VERTICES. A cut wall lives on the shadow side
                # of the valley and shows only the fill light, so the detail
                # map cannot draw its bedding; the vertex colour can. Bands
                # of 3.3 m -- two grid rows -- so the mesh can actually hold
                # them, each a shade off the last.
                # 0.68-1.0, not 0.84-1.0: a shaded flank shows only the fill,
                # and a 16% band under a flat fill measured as nothing
                strata = 0.68 + 0.32 * (0.5 + 0.5 * math.sin(verts[-1].z * 1.9 + x * 0.05))
                c = mix(c, tuple(v * strata for v in ROCK), min(1.0, rk * 1.3))
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
    # 3.5 m, not 5: the strokes in `grass_strokes` are 6-16 px on a 512 tile,
    # and at 5 m a blade would be 15 cm wide. At 3.5 it is a blade.
    tile = 3.5
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
    # THE PASS. Its rock walls stand on this ground and a tree seeding between
    # them would be a tree growing out of a cliff.
    if y > PASS_Y0 - 2.0 and abs(x - _path_x(y)) < 8.0 + pad:
        return False
    # THE FOLD'S YARD AND THE CAIRN'S MOUND are built ground, not wild. The
    # copse at (-34, 62) has an 11 m radius and reaches y=73, which is halfway
    # up the fold's west wall.
    if -36.5 < x < -26.0 and 69.0 < y < 81.5:
        return False
    if math.hypot(x + 34.0, y - 79.0) < 4.5 + pad:
        return False
    # THE ORCHARD IS PLANTED, so nothing may seed itself inside it -- one
    # scattered wild tree in the middle of a grid destroys the only thing the
    # grid is there to say.
    ocx, ocy, osp, on = ORCHARD
    if (abs(x - ocx) < (on - 1) / 2 * osp + 3.4 + pad
            and abs(y - ocy) < (on - 1) / 2 * osp + 3.4 + pad):
        return False
    return True


def _plant_cards(M, t, x, y, z, kind, n, size, rnd, lean=0.35):
    """A small plant as a fan of crossed cards standing on the ground."""
    mat = M[f"leafcard_{kind}"]
    for k in range(n):
        yaw = k * (math.pi / n) + rnd() * 0.5
        tilt = (rnd() - 0.5) * lean
        right = Vector((math.cos(yaw), math.sin(yaw), 0.0))
        upv = Vector((-math.sin(yaw) * math.sin(tilt), math.cos(yaw) * math.sin(tilt), math.cos(tilt)))
        w = size[0] * (0.85 + rnd() * 0.3)
        h = size[1] * (0.85 + rnd() * 0.3)
        c = Vector((x + (rnd() - 0.5) * 0.15, y + (rnd() - 0.5) * 0.15, z + h * 0.45))
        # standing plants shade with an upward-and-outward normal
        nrm = Vector((math.cos(yaw + 1.57) * 0.5, math.sin(yaw + 1.57) * 0.5, 1.0)).normalized()
        t.add(K.card(f"pc{len(t.parts)}", c, right, upv, w, h, mat, normal=nrm))


def bushes(M, t, rnd):
    """Bushes as clumps of leaf cards: a low mass with a ragged edge, not a
    green boulder. Three to five cards crossed at the centre and two or
    three more leaning out, on a short dark heart so the middle is not air."""
    spots = []
    for _ in range(70):
        x = MEADOW["x0"] + 4 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 8)
        y = GATE_Y + 3 + rnd() * (MEADOW["y1"] - GATE_Y - 8)
        if on_path(x, y, 3.2) or not _inside(x, y) or not _clear_of_landmarks(x, y, 1.2):
            continue
        spots.append((x, y))
    for i, (x, y) in enumerate(spots[:36]):
        z = height(x, y)
        s = 0.7 + rnd() * 0.6
        t.add(K.blob(f"bushheart{i}", (x, y, z + 0.28 * s), (0.34 * s, 0.34 * s, 0.26 * s), None,
                     M["leaf_lo"], seg=7, rings=5, squircle=2.3))
        _plant_cards(M, t, x, y, z, "bush", 4, (1.05 * s, 0.85 * s), rnd, lean=0.5)
        for k in range(3):
            a = rnd() * math.tau
            _plant_cards(M, t, x + math.cos(a) * 0.35 * s, y + math.sin(a) * 0.35 * s, z,
                         "bush", 2, (0.7 * s, 0.6 * s), rnd, lean=0.9)


def ferns(M, t, rnd, spots):
    """Ferns in the shade: a ring of fronds under every tree, where the grass
    thins and a real wood has its understory."""
    for (x, y, r) in spots:
        n = 3 + int(rnd() * 3)
        for k in range(n):
            a = rnd() * math.tau
            d = r * (0.55 + rnd() * 0.55)
            px, py = x + math.cos(a) * d, y + math.sin(a) * d
            if on_path(px, py, 2.4) or not _inside(px, py):
                continue
            z = height(px, py)
            for j in range(4):
                yaw = a + j * 1.5 + rnd() * 0.5
                tilt = 0.55 + rnd() * 0.35          # fronds lean outward
                right = Vector((math.cos(yaw), math.sin(yaw), 0.0))
                # the frond stands in the plane through `right`, leaning away from the centre
                out = Vector((-math.sin(yaw), math.cos(yaw), 0.0))
                upv = (Vector((0, 0, 1)) * math.cos(tilt) + out * math.sin(tilt)).normalized()
                w, h = 0.30 + rnd() * 0.12, 0.62 + rnd() * 0.25
                c = Vector((px, py, z)) + upv * (h * 0.48)
                t.add(K.card(f"fern{len(t.parts)}", c, right, upv, w, h, M["leafcard_fern"],
                             normal=(out * 0.4 + Vector((0, 0, 1))).normalized()))


def flowers(M, t, rnd):
    """Flower patches as crossed cards: a spray of blooms over leaves, in
    clumps, where the eye lands first in any screenshot of a meadow."""
    k = 0
    for _ in range(40):
        x = MEADOW["x0"] + 6 + rnd() * (MEADOW["x1"] - MEADOW["x0"] - 12)
        y = GATE_Y + 4 + rnd() * (MEADOW["y1"] - GATE_Y - 10)
        if on_path(x, y, 4.0) or not _inside(x, y) or not _clear_of_landmarks(x, y, 1.0):
            continue
        if height(x, y) > 5.5:
            continue
        for _h in range(7 + int(rnd() * 5)):
            a = rnd() * math.tau
            r = 2.0 * math.sqrt(rnd())
            px, py = x + math.cos(a) * r, y + math.sin(a) * r
            if on_path(px, py, 2.6):
                continue
            _plant_cards(M, t, px, py, height(px, py), "flower", 2,
                         (0.50, 0.42), rnd, lean=0.4)
        k += 1
        if k >= 14:
            break


def logs(M, t):
    """Fallen logs: three trunks lying where a copse would drop them, and a
    stump beside each. The one horizontal in a valley of vertical trees."""
    out = []
    for i, (x, y, ang, ln) in enumerate(((-22.0, 30.0, 0.5, 3.4), (33.0, 61.0, 2.2, 2.8), (-11.0, 84.0, 1.1, 3.0))):
        if not _inside(x, y):
            continue
        z = height(x, y)
        dx, dy = math.cos(ang), math.sin(ang)
        out.append(K.tube(f"log{i}", K.dome([
            {"p": Vector((x - dx * ln / 2, y - dy * ln / 2, z + 0.22)), "r": (0.26, 0.26), "n": 2.5},
            {"p": Vector((x, y, z + 0.24)), "r": (0.24, 0.24), "n": 2.5},
            {"p": Vector((x + dx * ln / 2, y + dy * ln / 2, z + 0.20)), "r": (0.20, 0.20), "n": 2.5},
        ], at="both", steps=1, height=0.05), seg=9, mat=M["bark"], squircle=2.5))
        sx, sy = x - dy * 1.6, y + dx * 1.6
        out.append(K.tube(f"stump{i}", K.dome([
            {"p": Vector((sx, sy, height(sx, sy) - 0.1)), "r": (0.34, 0.34), "n": 2.6},
            {"p": Vector((sx, sy, height(sx, sy) + 0.45)), "r": (0.30, 0.30), "n": 2.6},
        ], at="end", steps=1, height=0.04), seg=9, mat=M["bark"], squircle=2.6))
        t.solid(sx, sy, 0.34, 0.34, top=height(sx, sy) + 0.5)
    t.add(*out)


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


def _branch(M, t, p0, d, length, r0, r1, depth, scale, rnd, tips, bark):
    """One branch of the grammar, recursively. Grows from `p0` along unit
    direction `d` for `length`, tapering r0 -> r1, bending a little upward and
    wandering, then forks into two or three children that are shorter, thinner
    and spread apart. Every tip is recorded so the canopy can be hung there."""
    up = Vector((0, 0, 1))
    # the branch curves: three sections, each bent toward up and wandered
    pts = [Vector(p0)]
    dd = Vector(d)
    seg_len = length / 3
    for k in range(3):
        wander = Vector(((rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.3))
        dd = (dd + up * 0.18 + wander * 0.5).normalized()
        pts.append(pts[-1] + dd * seg_len)
    sections = []
    for k, pt in enumerate(pts):
        u = k / 3
        rr = r0 + (r1 - r0) * u
        sections.append({"p": pt, "r": (rr, rr), "n": 2.5})
    t.add(K.tube(f"br{len(t.parts)}", K.dome(sections, at="end", steps=1, height=0.02),
                 seg=6 if depth < 2 else 5, mat=M[bark], squircle=2.5))
    tip = pts[-1]
    if depth >= 2 or length < 0.55 * scale:
        tips.append((tip, dd))
        return
    n = 2 if rnd() < 0.6 else 3
    # children fan out from the tip's direction
    side = dd.cross(up)
    if side.length < 1e-3:
        side = Vector((1, 0, 0))
    side.normalize()
    a0 = rnd() * math.tau
    for k in range(n):
        a = a0 + k * (math.tau / n)
        spread = 0.55 + rnd() * 0.35
        cd = (dd + (side * math.cos(a) + up.cross(side) * math.sin(a)) * spread
              + up * 0.25).normalized()
        _branch(M, t, tip, cd, length * (0.62 + rnd() * 0.16), r1, r1 * 0.55,
                depth + 1, scale, rnd, tips, bark)
    # and a tip on the parent too, so there are leaves along the branch
    tips.append((tip, dd))


def _canopy_cards(M, t, tips, centre, crown_r, scale, rnd, kind="broad", n_per_tip=2,
                  size=(1.15, 0.95), camblock=True):
    """Hang leaf cards at the branch tips. Each card faces a random direction
    but SHADES with the crown's outward normal, so the mass lights as one
    round thing under the ramp while its edge is forty ragged cuts."""
    mat = M[f"leafcard_{kind}"]
    cx, cy, cz = centre
    for (tip, d) in tips:
        for k in range(n_per_tip):
            off = Vector(((rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.35)) * scale
            c = Vector(tip) + off + Vector((0, 0, 0.18 * scale))
            # facing: random yaw, mostly upright, with some tilted like a spread of leaves
            yaw = rnd() * math.tau
            tilt = (rnd() - 0.5) * 1.1
            right = Vector((math.cos(yaw), math.sin(yaw), 0.0))
            upv = Vector((-math.sin(yaw) * math.sin(tilt), math.cos(yaw) * math.sin(tilt), math.cos(tilt)))
            w = size[0] * scale * (0.85 + rnd() * 0.35)
            h = size[1] * scale * (0.85 + rnd() * 0.35)
            nrm = (c - Vector((cx, cy, cz - crown_r * 0.35)))
            if nrm.length < 1e-3:
                nrm = Vector((0, 0, 1))
            t.add(K.card(f"lc{len(t.parts)}", c, right, upv, w, h, mat, normal=nrm.normalized()))
    if camblock:
        t.camblock(cx, cy, cz, crown_r * 0.95)


def _tree_broadleaf(M, t, x, y, scale, rnd):
    """A broadleaf tree grown from a grammar and dressed in cards.

    The old recipe was a trunk, four branches and a dozen blobs; at five metres
    it read as exactly that. This one grows: a trunk that forks into two or
    three limbs, each limb into two or three branches, each branch into twigs,
    curving up and wandering as it goes, every tree its own shape from its own
    seed. The leaves are painted clusters on cards hung at every twig, shaded
    with the crown's normal -- the technique every stylised game with trees
    worth looking at uses, and the one thing that was never going to come out
    of a sphere.
    """
    z = height(x, y)
    h = 2.9 * scale
    lean_a = rnd() * math.tau
    lean = 0.10 * scale * (0.4 + rnd())
    lx, ly = math.cos(lean_a) * lean, math.sin(lean_a) * lean
    fork_z = z + h * (0.42 + rnd() * 0.12)
    fork = Vector((x + lx, y + ly, fork_z))
    t.add(K.tube(f"trunk{len(t.parts)}", K.dome([
        {"p": Vector((x, y, z - 0.20)), "r": (0.34 * scale, 0.34 * scale), "n": 2.6},
        {"p": Vector((x, y, z + 0.18 * scale)), "r": (0.24 * scale, 0.24 * scale), "n": 2.6},
        {"p": Vector((x + lx * 0.5, y + ly * 0.5, z + h * 0.25)),
         "r": (0.19 * scale, 0.19 * scale), "n": 2.6},
        {"p": fork, "r": (0.15 * scale, 0.15 * scale), "n": 2.6},
    ], at="end", steps=1, height=0.05), seg=9, mat=M["bark"], squircle=2.6))
    for k in range(3):
        a = lean_a + 1.1 + k * 2.05 + (rnd() - 0.5) * 0.6
        reach = (0.42 + rnd() * 0.2) * scale
        t.add(K.tube(f"root{len(t.parts)}", K.dome([
            {"p": Vector((x, y, z + 0.16 * scale)), "r": (0.13 * scale, 0.10 * scale), "n": 2.4},
            {"p": Vector((x + math.cos(a) * reach * 0.6, y + math.sin(a) * reach * 0.6,
                          z - 0.02)), "r": (0.09 * scale, 0.07 * scale), "n": 2.4},
            {"p": Vector((x + math.cos(a) * reach, y + math.sin(a) * reach, z - 0.16)),
             "r": (0.05 * scale, 0.04 * scale), "n": 2.4},
        ], at="end", steps=1, height=0.03), seg=6, mat=M["bark"], squircle=2.4))
    # THE GRAMMAR: two or three limbs off the fork, each a branch that forks twice
    tips = []
    n_limbs = 2 if rnd() < 0.45 else 3
    a0 = rnd() * math.tau
    for k in range(n_limbs):
        a = a0 + k * (math.tau / n_limbs) + (rnd() - 0.5) * 0.6
        d = Vector((math.cos(a) * 0.75, math.sin(a) * 0.75, 0.9 + rnd() * 0.4)).normalized()
        _branch(M, t, fork, d, (1.35 + rnd() * 0.45) * scale, 0.13 * scale, 0.07 * scale,
                0, scale, rnd, tips, "bark")
    # crown centre and radius from where the tips landed
    if tips:
        cx = sum(p.x for p, _ in tips) / len(tips)
        cy = sum(p.y for p, _ in tips) / len(tips)
        cz = sum(p.z for p, _ in tips) / len(tips) + 0.2 * scale
        cr = max(0.9 * scale, max((Vector((p.x - cx, p.y - cy, p.z - cz)).length for p, _ in tips)) * 0.9)
    else:
        cx, cy, cz, cr = x, y, z + h, 1.2 * scale
    _canopy_cards(M, t, tips, (cx, cy, cz), cr, scale, rnd, kind="broad", n_per_tip=2)
    t.solid(x, y, 0.42 * scale, 0.42 * scale, top=z + h)


def _tree_conifer(M, t, x, y, scale, rnd):
    """A conifer as a spire of needle sprays. The trunk is one tapering pole;
    whorls of short branches leave it every half metre, shorter toward the
    top, and each carries two needle cards -- so the silhouette is a ragged
    cone of sprays, not four stacked skirts."""
    z = height(x, y)
    h = 4.6 * scale
    t.add(K.tube(f"trunk{len(t.parts)}", K.dome([
        {"p": Vector((x, y, z - 0.15)), "r": (0.20 * scale, 0.20 * scale), "n": 2.6},
        {"p": Vector((x, y, z + h * 0.55)), "r": (0.11 * scale, 0.11 * scale), "n": 2.6},
        {"p": Vector((x, y, z + h * 1.02)), "r": (0.03 * scale, 0.03 * scale), "n": 2.6},
    ], at="end", steps=1, height=0.06), seg=8, mat=M["bark"], squircle=2.6))
    tips = []
    zz = z + h * 0.18
    ring = 0
    while zz < z + h * 0.95:
        u = (zz - z) / h
        reach = (1.25 - 1.05 * u) * scale * (0.85 + rnd() * 0.3)
        n = 5 if u < 0.6 else 4
        a0 = rnd() * math.tau
        for k in range(n):
            a = a0 + k * (math.tau / n) + (rnd() - 0.5) * 0.4
            d = Vector((math.cos(a), math.sin(a), -0.18 + 0.1 * rnd())).normalized()
            p0 = Vector((x, y, zz))
            p1 = p0 + d * reach
            t.add(K.tube(f"cb{len(t.parts)}", [
                {"p": p0, "r": (0.045 * scale, 0.045 * scale), "n": 2.4},
                {"p": p1 + Vector((0, 0, 0.08 * scale)), "r": (0.015 * scale, 0.015 * scale), "n": 2.4},
            ], seg=5, mat=M["bark"], squircle=2.4))
            tips.append((p1 + Vector((0, 0, 0.06 * scale)), d))
        zz += (0.42 + rnd() * 0.12) * scale
        ring += 1
    tips.append((Vector((x, y, z + h * 1.0)), Vector((0, 0, 1))))
    _canopy_cards(M, t, tips, (x, y, z + h * 0.55), 1.1 * scale, scale, rnd,
                  kind="needle", n_per_tip=2, size=(0.95, 0.85))
    t.solid(x, y, 0.30 * scale, 0.30 * scale, top=z + h)


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


TREE_SPOTS = []     # (x, y, crown radius) of every tree placed, for the understory


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
    if kind != "snag":
        TREE_SPOTS.append((x, y, 1.6 * scale))
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

    THE SLABS ARE LAID ALONG THE WALL, which they were not until the sheepfold
    was built. Each stone was an AXIS-ALIGNED box, 0.68 m across in world x and
    0.40 m in world y, dropped every 0.62 m: a wall running east-west overlaps
    by 0.06 m and looks like masonry, and a wall running north-south leaves a
    0.22 m gap between every stone and looks like a row of gravestones. Every
    wall in the world happened to run east-west, so the bug was invisible until
    a fold needed two walls that did not -- and the capture from the spine is
    unmistakable, a picket of headstones on a green field. `along` is the
    stone's long axis and it now follows the wall whatever bearing it is on.
    """
    rnd = _lcg(int(abs(x0 * 71 + y0 * 131)) + 5)
    span = math.hypot(x1 - x0, y1 - y0)
    bearing = math.degrees(math.atan2(y1 - y0, x1 - x0))
    # DERIVE THE GAP FROM THE ROAD, do not type it in twice. The first version
    # had both numbers written by hand, and the second wall's gap was at x=16
    # while `_path_x` puts the road at x=12 -- so the road ran straight into a
    # wall, which the walk check found by walking into it at 63 m. The lintel
    # up on the hill was the same mistake with different geometry.
    if on_road:
        gap_at = _path_x(y0) - x0
    n = max(2, int(span / 0.58))
    for i in range(n):
        u = (i + 0.5) / n
        px, py = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
        if gap_at is not None and abs(u * span - gap_at) < gap_w / 2:
            continue
        hh = h * (0.82 + 0.30 * rnd())
        z = height(px, py)
        # 0.40-0.47 SEMI-AXIS, not 0.34-0.40. At the old size a stone was 0.68
        # to 0.80 m long against a 0.63 m spacing, so the smallest ones overlap
        # their neighbour by 0.048 m -- and `bevel=0.05` insets the flat face
        # by more than that, which leaves a V-groove between them. Every wall in
        # the world has had a faint dotted line running along it for that
        # reason. Rule (a): the fault is in the joint, and here it literally
        # was. 0.80-0.94 against 0.58 leaves 0.22-0.36 m of overlap, which no
        # bevel can eat.
        along = 0.40 + 0.07 * rnd()      # the long axis, laid down the wall
        stone = A.box(f"wall{i}",
                      (px, py, z + hh / 2 - 0.06),
                      (along, 0.20 + 0.05 * rnd(), hh / 2),
                      M["rock"], bevel=0.05, seg=1)
        K.transform(stone, rotate=(0, 0, bearing), around=(px, py, 0))
        t.add(stone)
        # the collision box stays axis-aligned and takes the LARGER extent on
        # both axes, so a diagonal wall is never thinner to walk through than
        # it is to look at
        t.solid(px, py, 0.36, 0.36 if abs(math.sin(math.radians(bearing))) > 0.3
                                   else 0.24, top=z + hh)
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
# ROCK, ONE NUMBER. It was written twice -- once as the flat material and
# once as the tint the texture is multiplied by -- which is the same trap the
# terrain port and the wall gap both fell into, two copies of one constant
# waiting to disagree.
#
# 0.62, not 0.52. The palette's own docstring says these values are the toon
# ramp's MIDTONE and that "the ramp darkens the shadow band hard and mud is
# unrecoverable", and rock at 0.52 against stone at 0.78 was exactly that: lit
# it is a warm tan and it looks right, but every face turned away from the sun
# collapses to charcoal. In `10-town-from-meadow` the rockwork by the gate sits
# next to `stone` bollards and reads as a different, blacker material -- and it
# has done since long before the walls were fixed.
# 0.52, NOT 0.62. At 0.62 the pass walls -- the biggest rock surfaces in the
# game, a third of the frame at the top of the north road -- sat in the toon
# ramp's lit band as one blown-out pale mass and the bedding drawn into the
# texture had nothing left to be drawn on. Rock reads as rock when it is a
# shade darker than the road it stands over.
ROCK_COL = (0.52, 0.49, 0.46)

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
    # THREE RINGS, AND SNOW ON THE FAR TWO. Two rings read as depth; the third,
    # taller and paler, is what turns hills into mountains -- and a mountain
    # is a mountain because of where the snow stops. The snow is a second
    # curtain on the same vertices, from the snowline up, so the line follows
    # every peak. The far ring's top is jaggier: distance flattens everything.
    for ring, (rad, base, lo, hi, mat, seed, ph, jag, snowline) in enumerate((
            (175.0, -40.0, 16.0, 52.0, M["ridge_a"], 8821, 0.0, 0.16, None),
            (245.0, -40.0, 34.0, 80.0, M["ridge_b"], 3307, 2.3, 0.24, 66.0),
            (330.0, -40.0, 60.0, 128.0, M["ridge_c"], 5171, 4.1, 0.34, 96.0))):
        rnd = _lcg(seed)
        n = 160
        verts, faces, tops = [], [], []
        for i in range(n):
            a = 2 * math.pi * i / n
            k = (0.52 * (0.5 + 0.5 * math.sin(a * 2.0 + ph))
                 + 0.32 * (0.5 + 0.5 * math.sin(a * 5.0 + ph * 1.7 + 0.9))
                 + jag * (0.5 + 0.5 * math.sin(a * 13.0 + ph * 0.6 + 2.2))
                 + jag * 0.5 * (0.5 + 0.5 * math.sin(a * 29.0 + ph * 1.3)))
            tops.append(lo + (hi - lo) * (0.80 * k + 0.20 * rnd()))
        tops = [(tops[i - 1] + 2.0 * tops[i] + tops[(i + 1) % n]) / 4.0
                for i in range(n)]
        for i in range(n):
            a = 2 * math.pi * i / n
            px, py = cx + rad * math.cos(a), cy + rad * math.sin(a)
            verts.append(Vector((px, py, base)))
            verts.append(Vector((px, py, tops[i])))
        for i in range(n):
            j = (i + 1) % n
            faces.append((i * 2, i * 2 + 1, j * 2 + 1, j * 2))
        obj = K._new_obj(f"ridge{ring}", verts, faces, mat,
                         smooth=False, recalc=False)
        out.append(obj)
        if snowline is not None:
            sv, sf = [], []
            for i in range(n):
                a = 2 * math.pi * i / n
                px, py = cx + rad * math.cos(a), cy + rad * math.sin(a)
                # the snowline wanders a little so it is not a ruler
                sl = snowline + 6.0 * math.sin(a * 7.0 + ph) + 3.0 * math.sin(a * 19.0)
                lo_z = min(tops[i] - 0.5, sl)
                sv.append(Vector((px - 0.05 * math.cos(a), py - 0.05 * math.sin(a), lo_z)))
                sv.append(Vector((px - 0.05 * math.cos(a), py - 0.05 * math.sin(a), tops[i] + 0.3)))
            for i in range(n):
                j = (i + 1) % n
                sf.append((i * 2, i * 2 + 1, j * 2 + 1, j * 2))
            out.append(K._new_obj(f"snow{ring}", sv, sf, M["snow"], smooth=False, recalc=False))
    t.add(*out)


def clouds(M, t):
    """PAINTED CLOUDS, on the same terms as the painted ridges.

    The sky dome is a gradient, and a gradient is a studio backdrop. Nine
    clusters of flattened blobs sit above the far ring, unlit and out of the
    fog like the ridges, so from anywhere with a view -- the outcrop, the
    roofs, the top of the north road -- the horizon has weather in it. Low,
    because the camera the player is given looks up only 6 degrees: a cloud at
    the zenith is a cloud nobody sees.
    """
    rnd = _lcg(4471)
    cx, cy = 0.0, 65.0
    for i in range(9):
        a = 2 * math.pi * i / 9 + rnd() * 0.5
        rad = 215.0 + rnd() * 30.0
        base = 62.0 + rnd() * 22.0
        px, py = cx + rad * math.cos(a), cy + rad * math.sin(a)
        span = 14.0 + rnd() * 16.0
        n = 3 + int(rnd() * 3)
        # a flat base line and a lumpy top: the cumulus silhouette
        for k in range(n):
            u = (k + 0.5) / n
            dx = (u - 0.5) * span
            r = span * (0.16 + 0.10 * math.sin(u * math.pi)) * (0.85 + rnd() * 0.3)
            t.add(K.blob(f"cloud{len(t.parts)}",
                         (px - math.sin(a) * dx, py + math.cos(a) * dx, base + r * 0.55),
                         (r, r * 0.8, r * 0.62), None, M["cloud"],
                         seg=8, rings=5, squircle=2.2))


def fold(M, t):
    """A hillside sheepfold and a cairn above it, on the western rise.

    THE WEST EDGE WAS THE LAST PLAIN GROUND. Everything the walk passes has
    something on it now, and the far south-west had one copse and forty metres
    of grass climbing into the boundary hills.

    It is sited to be SEEN rather than merely visited, because the reward for
    climbing the rock spine was a view of nothing. From the crest -- eye at
    10.94 m -- the fold's yard sits 2 to 3.9 m BELOW you nineteen metres west,
    so you look down into it and can see what is standing in it, and the cairn
    sits 2.1 m ABOVE you at 26 m, further up the same slope. They are the only
    built things on that side of the map. Every sightline clears the ground
    between by over 1.2 m, measured against the terrain function rather than
    eyeballed: the spine's 9.29 m crest is BUILT ROCK sitting on 5.65 m of
    ground, and reading the crest height off `heightXY` gives an eye three and
    a half metres too low and a completely different composition.

    The cairn is NOT on the skyline from the crest -- the boundary hills behind
    it rise to 19 m, so it reads as a stone marker against green. It is against
    sky only from close up, walking the last of the slope, which is the shot
    `09n-cairn` frames and the reason to go the rest of the way.

    Four walls, not the D-shape a hill fold usually has, because the bank runs
    the wrong way to be one: see the siting note below.
    """
    # ALONG THE CONTOUR, not across it. The first siting ran the yard east-west
    # and would have enclosed a 4.9 m drop over 6.5 m -- that is a cliff, not a
    # pen. The ground here falls about 0.55 m per metre in x and is nearly flat
    # in y, so the fold is long north-south and only 3.5 m across the fall,
    # which is both how one is actually built and the only shape that leaves a
    # yard an animal can stand in.
    x0, x1 = -30.0, -26.5      # x0 uphill, x1 the downhill wall with the gate
    y0, y1 = 70.0, 80.0
    drywall(M, t, x0, y0, x1, y0)
    drywall(M, t, x1, y0, x1, y1, gap_at=5.0, gap_w=2.4)     # the gate, downhill
    drywall(M, t, x0, y0, x0, y1)                            # the uphill back
    drywall(M, t, x0, y1, x1, y1)

    rnd = _lcg(8891)
    # A TROUGH, set along the uphill wall where the ground is level in y. An
    # empty pen is a rectangle; one thing an animal would use is what says the
    # rectangle is FOR something.
    tx, ty = x0 + 0.85, y0 + 3.2
    tz = height(tx, ty)
    t.add(A.box("foldtrough", (tx, ty, tz + 0.24), (0.42, 1.15, 0.26),
                M["stone"], bevel=0.06, seg=1))
    t.add(A.box("foldtroughin", (tx, ty, tz + 0.44), (0.30, 1.02, 0.10),
                M["rock"], bevel=0.04, seg=1))
    t.solid(tx, ty, 0.44, 1.17, top=tz + 0.50)

    # THE GATEPOSTS, ON THE GAP EDGES, derived from the same 5.0/2.4 the wall's gap is cut
    # with. At +-1.5 they sat 0.3 m INSIDE the stonework -- two posts buried in
    # a wall rather than two posts framing a gateway.
    for sgn in (-1, 1):
        px, py = x1, y0 + 5.0 + sgn * 1.2
        pz = height(px, py)
        # 1.62 m, NOT the 1.05 they were built at. The wall runs 0.75-1.03 m
        # high, so a 1.05 m post is level with the stonework it is meant to
        # frame -- the capture showed a gap in a wall rather than a gateway. A
        # gatepost has to read as a POST, which means clearing the wall by more
        # than the wall's own height jitter.
        t.add(K.tube(f"foldpost{sgn}", K.dome([
            {"p": Vector((px, py, pz - 0.2)), "r": (0.24, 0.22), "n": 3.0},
            {"p": Vector((px, py, pz + 1.62)), "r": (0.19, 0.17), "n": 3.2},
        ], at="end", steps=2, height=0.12), seg=9, mat=M["stone"], squircle=3.0,
            up=(0, 0, 1)))
        t.solid(px, py, 0.28, 0.26, top=pz + 1.74)

    # THE CAIRN, on the rise behind it and deliberately on the skyline. Flat
    # stones, biggest at the bottom, leaning in -- the only shape in the kit
    # that reads as STACKED BY SOMEBODY at two hundred metres.
    # A HEAP, NOT A ZIGGURAT. The first build stacked nine concentric discs on
    # a smooth linear taper with 0.16 m of jitter, and the capture is a stepped
    # stone pyramid -- a wedding cake, not something a shepherd piled up. The
    # REGULARITY was the whole fault: a cairn is only ever read by its
    # silhouette, and a silhouette of even steps reads as built by a mason. So
    # every stone now gets its own radius scatter, its own lean off the axis
    # (and NOT one that tapers to nothing at the top), its own aspect and its
    # own yaw. Same nine stones, same height.
    # SITED BY THE DEFAULT CAMERA, not by the capture. At (-36.5, 82) the cairn
    # stood 3.6 m above the crest eye at 29.5 m, which is 7 degrees up -- and
    # the game's camera sits polar 1.22 / 5.4 m behind, so it looks 20.1 degrees
    # DOWN and a 52-degree vertical FOV leaves only 5.9 degrees above
    # horizontal. The top of the cairn was outside the frame the player
    # actually gets, and the only reason the capture looked right is that I had
    # dialled the shot to polar 1.42 to make my own composition work. Rule (b),
    # one turn of the screw further on: it is not enough to check that you can
    # SEE it, you have to check the camera the player is given.
    #
    # 26.3 m out and 10.70 m up allows 2.96 m of stones against the 2.30 built.
    ccx, ccy = -34.0, 79.0
    cz = height(ccx, ccy)
    n, top = 9, 0.0
    for k in range(n):
        u = k / (n - 1)
        # non-monotonic on purpose: the taper is the trend and the scatter is
        # what breaks the step pattern. One stone wider than the one beneath it
        # is exactly what a heap of rocks does and what a staircase never does.
        # CHUNKS, NOT DISCS. At h = 0.13-0.22 against r = 0.5-0.86 these were
        # flat pancakes, and rule (i) does the rest: a thin object is mostly
        # outline, so wherever the lean opened a sliver between two of them the
        # inverted-hull shell filled it and the cairn had a black band across
        # its middle. Filling the axis with a core did not help, because the
        # gaps are at the PERIPHERY where no core reaches. Taller stones with
        # more vertical overlap leave no sliver to fill in the first place.
        r = 0.74 * (1.0 - 0.62 * u) * (0.78 + 0.42 * rnd())
        h = 0.20 + 0.10 * rnd()
        zz = cz + 0.10 + k * 0.245
        # LEAN IN PROPORTION TO THE STONE, not a flat 0.34 m. A fixed offset
        # is a third of the base stone's width and most of the top one's, so
        # the small stones walked clear of the stack and the capture had a
        # BLACK HOLE through the middle of the cairn -- you were seeing the
        # inverted-hull outline shell of the stone behind, from inside it.
        # Rule (i): a very thin object is mostly outline, and the inside of an
        # outline is black by construction.
        lean = r * 0.30 * (0.35 + 0.65 * rnd())
        a = rnd() * 6.283
        sx, sy = ccx + math.cos(a) * lean, ccy + math.sin(a) * lean
        st = K.blob(f"cairn{k}", (sx, sy, zz),
                    (r, r * (0.66 + 0.34 * rnd()), h), None, M["rock"],
                    seg=8, rings=5, squircle=2.9)
        K.transform(st, rotate=(0, 0, rnd() * 360.0), around=(sx, sy, 0))
        t.add(st)
        top = zz + h
    # A CORE up the middle, narrower than every stone in the stack and so never
    # part of the silhouette. Its only job is that there is something opaque
    # behind the gaps, which is cheaper and more robust than tuning the lean
    # until no two stones happen to part company.
    t.add(K.blob("cairncore", (ccx, ccy, cz + 0.10 + n * 0.245 * 0.46),
                 (0.32, 0.28, n * 0.245 * 0.52), None, M["rock"],
                 seg=8, rings=6, squircle=2.4))
    # two shed at the foot, because a cairn that has stood a while has lost a
    # couple -- and it breaks the base line, which is the other half of a
    # silhouette that reads as piled rather than laid
    for k in range(2):
        a = rnd() * 6.283
        fx, fy = ccx + math.cos(a) * 1.25, ccy + math.sin(a) * 1.25
        t.add(K.blob(f"cairnfall{k}", (fx, fy, height(fx, fy) + 0.11),
                     (0.34, 0.26, 0.13), None, M["rock"], seg=8, rings=5,
                     squircle=2.7))
    t.solid(ccx, ccy, 0.9, 0.8, top=top)
    A.embercap(t, ccx + 1.5, ccy - 1.1, z=height(ccx + 1.5, ccy - 1.1), scale=1.05)


def reedbed(M, t):
    """A reed bed along the stream's eastern reach.

    Two jobs, and the second one is the reason it is reeds and not another
    copse. The first is a place: the channel east of the ford is a two-metre
    cut through open field that you cross and forget, and standing in a reed bed
    the horizon is a metre of stems in every direction -- the same enclosure the
    dell gets from terrain, got here from planting, on ground that already dips.

    The second is THE WIND. Everything in the meadow sways, and almost nothing
    shows it: the tufts are three-centimetre blades at one per fifteen square
    metres, and a canopy forty metres off moves too little to read. A reed is
    1.5 m of nearly vertical line with a heavy head on it, which is the shape
    wind is most visible on -- and there are three hundred of them in one place.
    """
    M_, out = t.M, []
    rnd = _lcg(6613)
    for i in range(34):
        u = i / 33.0
        x = 11.0 + 14.0 * u + (rnd() - 0.5) * 1.1
        side = 1.0 if i % 2 else -1.0
        y = _stream_y(x) + side * (1.7 + rnd() * 2.6)
        if on_path(x, y, 2.2) or not _inside(x, y):
            continue
        z = height(x, y)
        for k in range(7 + int(rnd() * 5)):
            a = rnd() * math.tau
            r = (0.10 + rnd() * 0.34)
            px, py = x + math.cos(a) * r, y + math.sin(a) * r
            hh = 1.05 + rnd() * 0.85
            lean = (rnd() - 0.5) * 0.30
            la = rnd() * math.tau
            tipx, tipy = px + math.cos(la) * lean, py + math.sin(la) * lean
            out.append(K.tube(f"reed{len(t.parts)}_{k}", [
                {"p": Vector((px, py, z - 0.05)), "r": (0.023, 0.012), "n": 2.2},
                {"p": Vector((px + (tipx - px) * 0.45, py + (tipy - py) * 0.45,
                              z + hh * 0.58)), "r": (0.015, 0.008), "n": 2.2},
                {"p": Vector((tipx, tipy, z + hh)), "r": 0.0, "n": 2.2},
            ], seg=4, mat=M_["reed"], squircle=2.2, up=(0, 0, 1)))
            # a seed head on the taller ones: the heavy tip is what makes the
            # sway read as sway rather than as a shimmer
            if hh > 1.45:
                out.append(K.blob(f"reedhead{len(t.parts)}_{k}",
                                  (tipx, tipy, z + hh - 0.13),
                                  (0.030, 0.030, 0.115), None, M_["reed_head"],
                                  seg=6, rings=5, squircle=2.2))

    # TUSSOCKS: something to stand on, so the bed is walkable rather than a
    # thicket you skirt. Low, broad, and each one bedded on its own ground.
    for k in range(5):
        x = 12.5 + k * 2.9 + (rnd() - 0.5) * 1.2
        y = _stream_y(x) + (1.0 if k % 2 else -1.0) * (2.0 + rnd() * 1.2)
        if not _inside(x, y):
            continue
        z = height(x, y)
        # `leaf_lo`, not `grass_hi`. The pale highlight green is right for a
        # 3 cm blade catching the sun and reads as bleached foam on a
        # half-metre mound -- five of them sat in the channel looking like
        # spilled milk.
        out.append(K.blob(f"tussock{k}", (x, y, z + 0.10),
                          (0.62 + rnd() * 0.3, 0.54 + rnd() * 0.3, 0.22),
                          None, M_["leaf_lo"], seg=9, rings=6, squircle=2.8))
        t.platform(x, y, 0.42, 0.36, z + 0.28)

    t.add(*out)
    # the find, deep in the stems where you would only go if you went in
    ex, ey = 18.4, _stream_y(18.4) + 3.0
    A.embercap(t, ex, ey, z=height(ex, ey), scale=1.05)


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

    # a cart drawn up on the verge, which is the object that says the track is
    # a road that things travel on rather than a worn line across a field
    cx0 = _path_x(GATE_Y + 10.5) - 4.2
    A.cart(t, cx0, GATE_Y + 10.5, yaw=-72, z0=height(cx0, GATE_Y + 10.5))

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


PASS_Y0, PASS_Y1 = 101.0, 113.0   # the cutting; runs INTO the skirt on purpose
# HALF THE CLEAR WIDTH between the cutting's rock faces. Wide enough that the
# 5.4 m camera boom stays in the corridor when you turn to look back down the
# valley, which is the view the whole climb exists for. WIDE, AND OVERLAPPING:
# at a narrow corridor with tall rocks each one is a tapered column and the wall
# reads as a row of organ pipes -- a cut face is a face, and its pieces have to
# be wider in section than they are tall and merge into each other.
PASS_CLEAR = 3.4


def pass_top(M, t):
    """The top of the north road: a rock cutting, a beacon, and the view back.

    THE ROAD CLIMBS SIXTEEN METRES AND ENDED IN NOTHING. It runs from 4.3 m at
    y=80 to 20.4 m at the world edge, it is walkable the whole way -- a probe
    took her up it leg by leg and she got to y=109.9 before the clamp stopped
    her -- and there was not one object on any of it. The last thing the
    journey did was walk a player up a bald hillside into an invisible wall
    under an empty sky. That is the single worst frame in the build and it is
    the LAST one.

    What was already there and worth keeping is the view BACK. From the top you
    see the whole valley at once: the stone circle, the field walls, the
    orchard, the stream, and the town hazed out behind them by the aerial
    perspective baked into the backdrop. Nothing here should get in the way of
    that, which is the one rule the geometry follows.

    So the rock walls are on the FLANKS ONLY and never across the road. The
    camera boom is 5.4 m at polar 1.22, so turning to look south puts it 5.07 m
    north of the player -- straight up the corridor. Anything across the road
    would shorten the boom exactly at the moment the vista opens, and the vista
    is the reason to come up here. The walls close the sky to either side,
    which is what makes it read as a pass, and leave the axis clear.

    They run to y=113, past the playable bound at 110 and into the skirt, so
    the ground the player cannot reach is behind rock rather than behind an
    apology.
    """
    rnd = _lcg(6607)
    i = 0
    y = PASS_Y0
    while y <= PASS_Y1:
        # THE WALLS ARE THE CUT FACE, so their height is READ OFF THE CUTTING
        # rather than chosen. Grading the road dropped it 6 m below the ridge at
        # the top and left it untouched at y=90, and the first version of these
        # rocks had their heights written as "road + 3 to 5" -- which, once the
        # road moved, put their tops a metre BELOW the ground they stood on.
        # Rule (e): derive the offset from the constraint. `rim` is the natural
        # ground 8 m out, which is what the road was cut through, so the wall
        # rises exactly as much as the cutting is deep and dies out on its own
        # where the cutting does.
        rz = _road_z(y)
        for side in (-1, 1):
            r = 1.55 + 1.25 * rnd()
            # PLACE THE FACE, NOT THE CENTRE. Fixing the centre at 3.7-4.6 m and
            # letting the radius run 1.55-2.8 means the inner face lands
            # anywhere from 0.9 m to 3.0 m off the centreline -- so the corridor
            # was 1.8 m wide in places, and the beacon standing 2.0 m off the
            # road was inside the rock. The clear width is the thing that has to
            # be constant, so it is the thing that gets written down.
            bx = _path_x(y) + side * (PASS_CLEAR + r * 0.85)
            rim = _natural(_path_x(y) + side * 8.0, y)
            if rim - rz < 0.9:          # too shallow here to be a wall at all
                continue
            base = rz - 0.6
            top = rim + 0.35 * rnd()
            b = K.blob(f"passrock{i}", (bx, y, (base + top) / 2 - 0.3),
                       (r, r * (0.62 + 0.55 * rnd()), (top - base) / 2 + 0.3),
                       None, M["rock"], seg=8, rings=6, squircle=2.4 + 0.9 * rnd())
            # EVERY ROCK ITS OWN YAW. Without it the blobs are all squircles on
            # the same axes at the same spacing, and the wall reads as one
            # extrusion notched at regular intervals -- a row of teeth. It is
            # the cairn's lesson again: what makes stone read as stone is that
            # no two pieces agree about anything.
            K.transform(b, rotate=(0, 0, rnd() * 360.0), around=(bx, y, 0))
            t.add(b)
            t.solid(bx, y, r * 0.92, r * 0.82, top=top)
            i += 1
            # a smaller block fallen to the toe of the wall, in toward the road,
            # so the bottom line is rubble rather than a clean skirting
            if rnd() < 0.55:
                fx = bx - side * (r * 0.75 + 0.4 * rnd())
                fr = 0.34 + 0.30 * rnd()
                fb = K.blob(f"passtoe{i}", (fx, y + (rnd() - 0.5) * 1.2,
                                            _road_z(y) + fr * 0.45),
                            (fr, fr * 0.82, fr * 0.72), None, M["rock"],
                            seg=8, rings=5, squircle=2.6)
                K.transform(fb, rotate=(0, 0, rnd() * 360.0), around=(fx, y, 0))
                t.add(fb)
        y += 1.15 + 0.65 * rnd()

    # THE BEACON, on the road's shoulder at the summit of the cutting.
    #
    # It was on the open slope east of the road, on the theory that high ground
    # makes it visible from far below. It does not: measured along the road, the
    # ground crosses the top of the frame 6 m ahead even after grading, so
    # NOTHING up here is visible from down there and no amount of height fixes
    # it -- rule (p), an effect you cannot see from where it matters is not one.
    # What is actually true is that you meet it at the top, in the defile, where
    # it is the only warm thing in a corridor of grey rock.
    by = 106.0
    # +2.0: the walls start at 3.7, and at +2.6 the beacon stood 0.6 m off the
    # rock with its basket inside it
    bx = _path_x(by) + 2.0          # on the road's shoulder, inside the cutting
    bz = height(bx, by)
    t.add(A.box("beacon_plinth", (bx, by, bz + 0.62), (0.62, 0.62, 0.68),
                M["stone"], bevel=0.06, seg=1))
    t.add(A.box("beacon_step", (bx, by, bz + 0.14), (0.86, 0.86, 0.20),
                M["stone"], bevel=0.05, seg=1))
    # the post and the basket
    t.add(K.tube("beacon_post", K.dome([
        {"p": Vector((bx, by, bz + 1.20)), "r": (0.13, 0.13), "n": 3.0},
        {"p": Vector((bx, by, bz + 2.60)), "r": (0.10, 0.10), "n": 3.0},
    ], at="none", steps=1), seg=8, mat=M["iron"], squircle=3.0, up=(0, 0, 1)))
    for k in range(9):
        a = k / 9 * 6.283
        t.add(K.tube(f"beacon_rib{k}", K.dome([
            {"p": Vector((bx + math.cos(a) * 0.20, by + math.sin(a) * 0.20,
                          bz + 2.55)), "r": (0.035, 0.035), "n": 2.6},
            {"p": Vector((bx + math.cos(a) * 0.42, by + math.sin(a) * 0.42,
                          bz + 3.25)), "r": (0.030, 0.030), "n": 2.6},
        ], at="none", steps=1), seg=6, mat=M["iron"], squircle=2.6, up=(0, 0, 1)))
    # THE COALS. `forge` is already in the runtime's TOWN_FLAT set, so it is
    # drawn flat at its own colour instead of taking the toon shadow band --
    # which is the only reason a fire reads as a fire here. No new material, no
    # new mesh in any budget, and rule (j) is sidestepped rather than fought:
    # a point light would do nothing at all until it crossed the ramp threshold.
    # A MOVER, NOT A JOIN. Every line of dialogue about this beacon says it has
    # gone out, and the coals were rendered lit and welded into the meadow mesh
    # where nothing could ever touch them. As a mover they are their own node
    # the runtime can find by name: it starts them cold, and the player lights
    # them -- which is the one thing the whole walk up here was missing.
    # `hit` is the plinth, because you light it from the road, not from the
    # basket three metres up.
    coals = K.blob("beacon_coals", (bx, by, bz + 2.86), (0.30, 0.30, 0.16),
                   None, M["forge"], seg=9, rings=6, squircle=2.4)
    t.moving("beacon", [coals], pivot=(bx, by, bz + 2.86), hit=(bx, by, bz),
             hit_r=1.6)
    t.solid(bx, by, 0.90, 0.90, top=bz + 0.34)

    # THE ROAD ENDS IN A ROCKFALL, because it has to end in SOMETHING. The
    # playable bound stops the player at y=110 and there is no way to argue with
    # that -- but an invisible wall on an open road is the one piece of pure
    # game-machinery left in the walk. Blocking it with fallen rock costs eleven
    # blobs and answers the question the wall raises.
    #
    # y=112.5, NOT 111.5. The BLOB is bigger than the solid: a boulder centred
    # at 111.5 with r=2.2 has mesh down to 109.3, which is inside the corridor
    # the camera swings through. Looking back down the valley from y=107 put the
    # boom at y=112.1 and the entire frame was the inside of a rock -- the one
    # view this whole feature exists to deliver, eaten by the thing meant to
    # explain the wall behind it. Sited off the MESH extent now, not the solid:
    # at 112.5 the rock reaches 110.3, which is past the clamp at 110.
    for k in range(11):
        fx = _path_x(112.0) + (rnd() - 0.5) * 9.0
        fy = 112.5 + rnd() * 2.6
        fr = 0.85 + 1.35 * rnd()
        fz = _road_z(fy) if abs(fx - _path_x(fy)) < 4.5 else height(fx, fy)
        fb = K.blob(f"passfall{k}", (fx, fy, fz + fr * 0.55),
                    (fr, fr * (0.7 + 0.5 * rnd()), fr * (0.62 + 0.35 * rnd())),
                    None, M["rock"], seg=8, rings=6, squircle=2.5 + 0.7 * rnd())
        K.transform(fb, rotate=(0, 0, rnd() * 360.0), around=(fx, fy, 0))
        t.add(fb)
        t.solid(fx, fy, fr * 0.9, fr * 0.8, top=fz + fr * 1.1)

    # THE REWARD IS THE ONE ALREADY IN THE GAME. Embercaps are what the map
    # teaches you to look for, so the far end of the longest walk in it pays
    # out in embercaps rather than in something invented for the occasion.
    for dx, dy in ((-1.9, -1.1), (1.5, -1.7), (-0.6, 1.9)):
        A.embercap(t, bx + dx, by + dy, z=height(bx + dx, by + dy), scale=1.05)


def waymarks(M, t):
    """Posts along the path. They do the job a corridor wall does in a town --
    tell you where the road goes -- without enclosing anything."""
    y = GATE_Y + 5
    i = 0
    # UP TO THE CUTTING, and no further. This stopped at y=90, 20 m short of the
    # world edge, which left the steepest and least legible stretch of the whole
    # road unmarked. But it should not run INTO the pass either: once the road
    # is between two rock faces the rock is telling you where the road goes far
    # better than a post can, and a row of posts down a defile is just clutter
    # in the one frame this map ends on.
    while y < PASS_Y0 - 2.0:
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


def materials(M):
    """The meadow's palette on top of the town's: flat colours for foliage,
    tinted greyscale textures for stone and bark, the vertex-coloured ground.
    A function rather than the top of `main()` so `tree_rack.py` can build a
    tree with the materials it will actually wear."""
    os.makedirs("public/assets/tex", exist_ok=True)
    for nm, fn in (("ground", surface_tex.grass_strokes),):
        path = os.path.abspath(f"public/assets/tex/{nm}.png")
        surface_tex.write_png(path, fn())
        M[f"{nm}_tex"] = K.image_material(
            f"{nm}_tex", bpy.data.images.load(path, check_existing=True),
            roughness=0.92, preview=(0.98, 0.98, 0.98), vertex_color="Col")
    # LEAF CARDS: painted clusters with a transparent cut, one image per
    # kind. `leafcard_` is the prefix the runtime keys alpha testing, double
    # siding, the shadow cut and the missing ink hull off.
    for kind in ("broad", "needle", "bush", "fern", "flower"):
        path = os.path.abspath(f"public/assets/tex/leafcard_{kind}.png")
        surface_tex.write_png(path, surface_tex.leafcard(kind, res=256))
        img = bpy.data.images.load(path, check_existing=True)
        img.alpha_mode = 'STRAIGHT'
        M[f"leafcard_{kind}"] = K.image_material(
            f"leafcard_{kind}", img, roughness=0.85, preview=(0.35, 0.55, 0.28), alpha=True)
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
        "rock":     K.material("rock", ROCK_COL, roughness=0.9),
        # REEDS: straw-olive, deliberately yellower than any grass here, so a
        # bed of them reads as a different plant and not as tall lawn.
        "reed":     K.material("reed", (0.60, 0.64, 0.31), roughness=0.9),
        "reed_head": K.material("reed_head", (0.50, 0.40, 0.24), roughness=0.9),
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
        "ridge_c":  K.material("ridge_c", (0.70, 0.78, 0.86), roughness=1.0),
        "snow":     K.material("snow", (0.95, 0.96, 0.98), roughness=1.0),
        "flower_a": K.material("flower_a", (0.95, 0.55, 0.65), roughness=0.8),
        "flower_b": K.material("flower_b", (0.97, 0.95, 0.85), roughness=0.8),
        "flower_c": K.material("flower_c", (0.98, 0.80, 0.30), roughness=0.8),
        # clouds: warm white, a shade under the sky's horizon so they sit IN
        # the haze rather than cut out of it
        "cloud":    K.material("cloud", (0.93, 0.92, 0.90), roughness=1.0),
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
    for key, fn, tint in (("rock", surface_tex.rock_strata, ROCK_COL),
                          ("stone", surface_tex.stone_rough, (0.74, 0.72, 0.68)),
                          ("bark", surface_tex.bark_rough, (0.44, 0.34, 0.25)),
                          ("bark_dead", surface_tex.bark_rough, (0.44, 0.41, 0.36))):
        path = os.path.abspath(f"public/assets/tex/m_{key}.png")
        surface_tex.write_png(path, np.clip(fn() * np.array(tint, np.float32), 0, 1))
        M[key] = K.image_material(
            f"m_{key}_tex", bpy.data.images.load(path, check_existing=True),
            roughness=0.95, preview=tint)

    return M


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    out = opt("--out", "public/assets/meadow.glb")
    render_dir = opt("--render")

    K.clear_scene()
    M = A.palette()
    materials(M)
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
    pass_top(M, t)
    fold(M, t)
    reedbed(M, t)
    approach(M, t)
    waymarks(M, t)
    backdrop(M, t)
    clouds(M, t)
    scatter(M, t)
    bushes(M, t, _lcg(70211))
    flowers(M, t, _lcg(70223))
    ferns(M, t, _lcg(70241), TREE_SPOTS)
    logs(M, t)

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
        # MUST MATCH build_terrain's grid origin, skirt included -- `heightMesh`
        # indexes the triangle list from it, and an origin off by the skirt puts
        # the player 12 m of terrain away from the ground she is standing on.
        "gridX0": MEADOW["x0"] - SKIRT, "gridY0": MEADOW["y0"] - 2.0,
        "step": TERRAIN_STEP,
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
