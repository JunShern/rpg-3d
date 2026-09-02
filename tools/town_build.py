"""town_build -- the ENVIRONMENT PROBE: a walkable town plaza.

The question this answers is not "can we model a building" -- it is whether a
scripted kit can produce a space that a FREE CAMERA survives.  Emberbrook could
compose one good shot per scene; here the player owns the camera, so every
facade has to hold up from any angle, alleys have to be enterable without the
view collapsing, and the ground has to have real height under it.

So the layout is deliberately awkward in the useful ways:
  - two 1.75 m alleys off the north side (the camera's worst case)
  - a raised terrace reachable only by stairs (tests ground height + step-up)
  - a gateway arch (tests a curved form the box kit cannot fake)
  - buildings tall enough to put the camera against a wall constantly

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/town_build.py -- \
      --out public/assets/town.glb --render docs/qa/town
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
import numpy as np
import surface_tex


# Plaza interior is roughly X -13..13, Y -10..11.  Buildings ring it just
# outside those bounds; the cobble slab runs wider so nothing floats.
PLAZA = dict(x0=-13.0, x1=13.0, y0=-10.0, y1=11.0)

# The stairwell opening in the plaza paving, in Blender x/y. Sited on the west
# side beside the market, off the line from the spawn point to the gate -- a
# secret you walk past, not one you fall into on your way out of town.
CELLAR_HOLE = (-10.4, -7.0, 0.2, 3.8)


TEX_DIR = "public/assets/tex"


def paved(obj, tile=2.6):
    """Planar UVs from world X/Y, so `tile` metres of ground is one tile.

    APPLIED AFTER THE JOIN, on the merged floor. Planar UVs are a pure function
    of world position, so every vertex gets the right one no matter which source
    mesh it came from -- and setting them before the join loses them, because
    joining objects where only some carry a UV layer does not reliably carry it
    through. The floor is flat, so planar projection is correct here rather than
    a compromise: nothing stretches and there is no seam to hide.
    """
    if obj is None:
        return obj
    uvs = [(v.co.x / tile, v.co.y / tile) for v in obj.data.vertices]
    K.set_uvs(obj, uvs)
    return obj


def ground_material(name, img_fn, tile_preview):
    """Generate the texture, write it next to the assets, load it as a material."""
    os.makedirs(TEX_DIR, exist_ok=True)
    path = os.path.abspath(os.path.join(TEX_DIR, f"{name}.png"))
    surface_tex.write_png(path, img_fn())
    image = bpy.data.images.load(path, check_existing=True)
    return K.image_material(name, image, roughness=0.85, preview=tile_preview)


def texture_walls(M):
    """Swap the flat plaster and roof materials for textured ones.

    One greyscale generator per surface kind, TINTED per material, rather than
    one image with a colour factor -- glTF can multiply a base colour by a base
    colour texture, but Blender's exporter only writes that pairing reliably
    when the node graph is the exact shape it expects, and four small tinted
    images are cheaper to be sure of than one clever graph.

    256 px, not 512: a facade is seen at a distance across a plaza, and the
    detail on it is deliberately almost nothing.
    """
    os.makedirs(TEX_DIR, exist_ok=True)
    out = {}
    plan = ([(k, surface_tex.plaster) for k in
             ("plaster_a", "plaster_b", "plaster_c", "plaster_d")]
            + [(k, surface_tex.rooftile) for k in ("roof_a", "roof_b", "roof_c")]
            # dressed stone and sawn wood: the structural pieces and the beams.
            # Ashlar is REGULAR, unlike the paving's Voronoi, because dressed
            # stone is the one thing in a town that is genuinely laid out on a
            # grid -- and the contrast between the two is what separates "built"
            # from "surfaced".
            + [("stone", surface_tex.ashlar), ("timber", surface_tex.timber)])
    for key, fn in plan:
        tint = M[key].diffuse_color[:3]
        img = (fn(res=256, tone=tint) if fn is surface_tex.plaster
               else fn(res=256) * np.array(tint, np.float32))
        path = os.path.abspath(os.path.join(TEX_DIR, f"{key}.png"))
        surface_tex.write_png(path, np.clip(img, 0, 1))
        out[key] = K.image_material(
            f"{key}_tex", bpy.data.images.load(path, check_existing=True),
            roughness=0.85, preview=tint)
    return out


def build_ground(t):
    M = t.M
    # THE GROUND FILLS MOST OF EVERY FRAME, so it is the surface where "no
    # textures anywhere" hurt most -- the plaza read as one uniform grey no
    # matter how much detail the facades carried.
    # NOTE the `_tex` suffix: `image_material` returns any existing material
    # with that name, and the palette already owns a flat one called "cobble" --
    # so naming this "cobble" silently handed back the untextured original and
    # the generated paving never reached the export.
    cob = ground_material("cobble_tex", surface_tex.cobble, (0.52, 0.50, 0.53))
    # REGISTER IT, for the same reason the flagstone had to be: the kit builds
    # floors of its own now (the yard, the alley) and a local variable is not
    # something `arch_lib` can reach.
    M["cobble_tex"] = cob
    # FOUR SLABS ROUND A HOLE, not one slab.
    #
    # The cellar needs a stairwell, and a stairwell needs an actual opening: a
    # single box has a top face across its whole extent, so a stair cut through
    # it descends into paving you can see and -- worse -- `groundAt` raycasts
    # that same top face and puts you back on the square. Splitting the slab is
    # three extra draws for the one thing that makes an interior possible.
    x0, x1, y0, y1 = -22.0, 22.0, -21.0, 19.0
    hx0, hx1, hy0, hy1 = CELLAR_HOLE
    for nm, (ax, bx, ay, by) in (
            ("floor_plaza_w", (x0, hx0, y0, y1)),
            ("floor_plaza_e", (hx1, x1, y0, y1)),
            ("floor_plaza_s", (hx0, hx1, y0, hy0)),
            ("floor_plaza_n", (hx0, hx1, hy1, y1))):
        t.walk(A.box(nm, ((ax + bx) / 2, (ay + by) / 2, -0.25),
                     ((bx - ax) / 2, (by - ay) / 2, 0.25), cob, bevel=0.12, seg=1))

    # A paved ring around the fountain: a surface change is the cheapest way to
    # tell the player where the centre of a space is.
    #
    # IT WAS A BLEACHED HALO. The first version was 1.7 m wide, untextured, and
    # about 30% LIGHTER than the cobble it sat in, which at a third-person
    # camera height covered a quarter of the frame -- so the plaza read as
    # having a bad lightmap rather than as having a paved centre. Hiding this
    # one mesh and re-rendering was what proved it; nothing about the shading
    # was wrong. It is now narrower, DARKER than its surround, and carries the
    # flagstone texture, so it reads as bigger slabs laid in a circle.
    ring = []
    for i in range(41):
        a = 2 * math.pi * i / 40
        ring.append({"p": Vector((5.2 * math.cos(a), 0.5 + 5.2 * math.sin(a), 0.005)),
                     "r": (0.55, 0.05), "n": 3.0})
    ringmat = ground_material("ring_tex", surface_tex.flagstone, (0.44, 0.42, 0.44))
    t.add(K.tube("plaza_ring", ring, seg=8, mat=ringmat, squircle=3.0,
                 up=(0, 0, 1)))          # 0.55 wide, 0.05 proud -- not the reverse

    # raised terrace on the east side, reachable only by the stairs
    # coarser slabs on the terrace, so two paved areas beside each other do not
    # read as one surface
    flag = ground_material("flagstone_tex", surface_tex.flagstone, (0.62, 0.60, 0.58))
    # REGISTER IT. It was a local, so the cellar -- built later, from the kit --
    # asked for `M["flagstone_tex"]` and got a KeyError. Anything the kit might
    # want has to be in the palette dict, not a variable in one function.
    M["flagstone_tex"] = flag
    t.walk(A.box("floor_terrace", (10.0, 4.0, 0.55), (3.5, 5.0, 0.55),
                 flag, bevel=0.07, seg=2))
    A.stairs(t, 5.05, 4.0, w=4.2, rise=0.275, run=0.42, steps=4, yaw=-90)

    # balustrade along the terrace edges the player can fall off
    for y in (-1.0, 9.0):
        for i in range(7):
            x = 6.6 + i * 1.15
            t.add(A.box("rail_post", (x, y, 1.42), (0.09, 0.09, 0.32),
                        M["stone"], bevel=0.03, seg=1))
        t.add(A.box("rail_top", (10.0, y, 1.78), (3.45, 0.13, 0.075),
                    M["stone"], bevel=0.03, seg=1))
    for i in range(8):
        y = -0.9 + i * 1.4
        t.add(A.box("rail_post", (13.4, y, 1.42), (0.09, 0.09, 0.32),
                    M["stone"], bevel=0.03, seg=1))


def build_buildings(t):
    #   cx     cy     w    d   storeys yaw   plaster      roof      shop
    #                                                          gable to street ↴
    plan = [
        # THE MIDDLE OF THE NORTH RANGE IS THE TOWER, not a house. See below.
        (-11.5, -14.0, 9.0, 8.0, 3, 180, "plaster_a", "roof_a", True,  0, False),
        (  9.0, -14.0, 8.5, 8.0, 3, 180, "plaster_c", "roof_c", True,  2, False),

        (-17.0,  -2.0, 9.0, 8.0, 2,  90, "plaster_b", "roof_b", True,  3, True),
        (-17.0,   8.5, 9.0, 8.0, 3,  90, "plaster_d", "roof_a", False, 4, False),

        ( 17.0,  -2.0, 9.0, 8.0, 3, -90, "plaster_a", "roof_b", False, 5, True),
        ( 17.0,   8.5, 9.0, 8.0, 2, -90, "plaster_c", "roof_c", True,  6, False),

        ( -9.0,  15.0, 10.0, 8.0, 2,   0, "plaster_d", "roof_a", False, 7, False),
        (  7.0,  15.0, 10.0, 8.0, 2,   0, "plaster_a", "roof_c", True,  8, True),
    ]
    # THE ONE YOU CAN GO INTO. Its ground storey is hollow -- see `building`'s
    # `room` -- and it is this one because it already has a shopfront, faces the
    # plaza, and stands beside the gate, so the door is on the path everybody
    # already walks. The other eight are unchanged.
    SHOP = (7.0, 15.0)
    # AND THE SMITHY, on the east range facing the plaza. A second interior has
    # to be a different KIND of room or opening it says nothing -- two shops is
    # one shop twice. This one has no shopfront, which is right: a smithy shows
    # you a door and a chimney, not a window full of goods.
    SMITHY = (17.0, -2.0)
    # roof height varies with the seed too: nine identical pitches is most of
    # what made nine buildings read as one building
    for cx, cy, w, d, st, yaw, pl, rf, shop, seed, gf in plan:
        A.building(t, cx, cy, w, d, storeys=st, yaw=yaw, plaster=pl, roof=rf,
                   shop=shop, seed=seed, gable_front=gf,
                   roof_h=1.25 + 0.16 * (seed % 4),
                   room=(cx, cy) in (SHOP, SMITHY))
        if (cx, cy) == SHOP:
            A.shop_fit(t, cx, cy, w, d, yaw=yaw, seed=seed)
        elif (cx, cy) == SMITHY:
            A.smithy_fit(t, cx, cy, w, d, yaw=yaw, seed=seed)

    # the south gateway, in the gap between the two south buildings
    A.arch(t, -1.0, 11.0, span=4.4, height=5.6, depth=1.7, thick=0.46)

    # THE ELEVATION THE TOWN SHOWS THE COUNTRY. The two south buildings present
    # their backs to the meadow, and that is the wall you walk toward every time
    # you come home -- framed by the arch, so it is unavoidable. It was four
    # metres of flat plaster per building under a band of windows.
    A.outer_face(t, -14.0, -4.0, 19.0, seed=1, shed_at=-11.4)
    A.outer_face(t, 2.0, 12.0, 19.0, seed=2)

    # THE LANDMARK, and it stands IN the north range rather than behind it.
    #
    # It used to sit at y=-22.5, seven metres back, with a two-storey house on
    # the same axis in front of it -- and the claim written here was that it was
    # "centred in the arch from the meadow and centred over the fountain from
    # inside the plaza". The first half was true. The second was not, and could
    # not be: that house's ridge is 9.9 m at 15.5 m from the fountain, so
    # ANYTHING visible past it is more than 28 degrees above the horizontal,
    # and the gameplay camera's whole vertical field is 52. Captures from the
    # fountain, from z=8 and from z=13 all show no tower. The plaza is simply
    # too small to look over its own north side.
    #
    # So the tower takes that building's place. From the fountain its shaft now
    # rises out of the roofline you are already looking at, at eye level; from
    # the meadow it is still dead centre in the arch.
    # base 3.3, not 2.6: see the note on TOWER_INNER. The north range leaves an
    # 11.75 m gap between its two houses, so a 6.6 m tower still clears each
    # neighbour by 2.7 m.
    A.belltower(t, -1.0, -15.5, base=3.3, storeys=5)

    # THE UPPER LEVEL. On the east range, facing the plaza, so from the fountain
    # you can see both the stair and the deck it leads to -- a balcony you
    # cannot obviously get to is set dressing rather than verticality.
    A.gallery(t, 12.6, 8.5, w=7.0, d=2.2, deck=3.55, yaw=-90, stair_side=-1)


def build_props(t):
    A.fountain(t, 0.0, 0.5, r=2.6)

    # NOT ON THE TOWER'S AXIS. The lamp at (-1.0, -8.6) stood dead centre in
    # front of the belltower door, so the one approach to the one interior in
    # the town was framed by a post -- visible the moment the door existed to
    # walk toward, and invisible for as long as the tower was solid.
    for x, y in ((-8.5, -6.0), (8.5, -6.0), (-8.5, 7.5), (5.0, 9.0),
                 (-4.6, -8.6), (12.0, 0.2)):
        A.lantern(t, x, y, h=3.2)
    # BUNTING between the lamps, across the two long sides of the square. The
    # rope hangs from just under each lantern's head, so the posts already
    # there are what holds it up.
    A.bunting(t, (-8.5, -6.0, 3.05), (8.5, -6.0, 3.05), sag=0.9, seed=0)
    A.bunting(t, (-8.5, 7.5, 3.05), (5.0, 9.0, 3.05), sag=0.8, seed=1)
    A.bunting(t, (8.5, -6.0, 3.05), (12.0, 0.2, 3.05), sag=0.5, seed=2)

    # THE YARD, east of the square, behind the east range.
    #
    # The two east buildings sit at y = -2 and y = 8.5 and each is 9 m across,
    # so they leave a 1.5 m slot between them at y = 3.25. From the plaza that
    # slot reads as a shadow between two facades; it is in fact an alley, and
    # it goes somewhere.
    A.yard(t, 26.0, 3.25, 9.0, 9.0, gate_y=3.25, gate_w=1.9)

    # THE CELLAR. Its lamp is the only light source down there, so unlike the
    # square's lanterns -- which are an accent on a sunlit facade -- this one
    # has to actually light a room.
    A.cellar(t, *CELLAR_HOLE)

    for x, y, r in ((-12.4, -8.6, 0.55), (-4.0, -9.2, 0.5), (4.6, -9.2, 0.5),
                    (12.4, -8.6, 0.55), (-12.6, 9.4, 0.6), (2.0, 10.2, 0.5)):
        A.planter(t, x, y, r=r)

    # A MARKET, off the fountain's axis so it does not block the gate view.
    # Three stalls in a loose row on the west side: enough to read as a market
    # and few enough that the square is still a square.
    # CLEAR OF THE WELLHOLE. The first siting put a stall straddling the
    # stairwell -- the opening is at x -10.4..-7.0, y 0.2..3.8 -- so the one
    # thing in the square that is a secret had a trestle standing over it.
    for cx, cy, yaw, kind in ((-5.2, 1.4, 8, 0), (-5.6, 4.8, -6, 1),
                              (-5.0, -2.2, 14, 3)):
        A.stall(t, cx, cy, yaw=yaw, kind=kind)

    # A CART BEHIND THE MARKET, shafts down. The square says people live here in
    # a dozen ways and never once said that anything ARRIVES; a cart is the only
    # prop in the kit that belongs to the road as much as to the town.
    A.cart(t, -9.6, 2.6, yaw=104)

    # Lines strung across the two alleys, which were vertical surfaces and empty
    # air. The cloth is `awning`, so it moves with the wind.
    A.washing(t, -13.0, 5.0, -13.0, 11.0, 5.4, n=4)
    A.washing(t, 12.6, -3.0, 12.6, 3.2, 5.7, n=5)
    A.washing(t, 3.2, 12.4, 9.0, 12.4, 5.1, n=4)

    # ------------------------------------------------------------- the roofs
    #
    # A SECOND STOREY OF PLACE, INSIDE THE SAME FOOTPRINT. The town is nine
    # buildings round one square: however much furniture goes into it, it is
    # one room, and the only way to make it feel like more was to make it
    # bigger. Roofs are the opposite trade -- the same ground seen from above
    # is a different space, and getting up there is a route rather than a
    # teleport.
    #
    # The gallery stair already lifts you to 3.55 and led nowhere, which was
    # its own open fault. A ladder off the deck now continues it.
    #
    # EVERY LEAD IS AT 8.40, deliberately, rather than each on its own ridge.
    # The two-storey ridges here run 8.18 to 8.66, and stepping between them
    # would be a 0.48 m rise against the runtime's 0.45 m limit -- so the route
    # would silently stop working on one building. Twenty centimetres of
    # discrepancy against a pitched roof is invisible; a lead you cannot step
    # onto is not.
    ROOF_Z = 8.40
    # x = 12.5, NOT 13.35. The east range's collision box starts at x = 13, so
    # a ladder against the wall is a ladder INSIDE the wall: every rung was at
    # the right height and unreachable, because the solid stopped you 40 cm
    # short of the first one. Probed by walking at it for seven seconds and
    # never leaving 3.64 m.
    A.ladder(t, 12.5, 8.5, 3.62, ROOF_Z + 0.10, yaw=90)
    # A LANDING AT THE TOP OF THE LADDER, and it is the whole reason the route
    # did not work. The ladder had to move to x = 12.5 to clear the east
    # range's collision box, and the ridge lead starts at x = 16.15 -- so the
    # climb ended in three and a half metres of nothing. My own check said
    # "reached 8.33 m" and passed, because it measured the LADDER rather than
    # whether there was anywhere to step off it.
    A.rooftop(t, 14.75, 8.5, 5.4, 2.0, ROOF_Z, rail=False, name="roof_land")
    A.rooftop(t, 17.6, 8.5, 2.4, 7.0, ROOF_Z, name="roof_e")
    A.plank(t, 16.6, 12.0, 11.4, 14.6, ROOF_Z, w=1.25)
    A.rooftop(t, 7.0, 15.0, 8.4, 2.4, ROOF_Z, name="roof_s")
    # ENDS AT -5.4, NOT -3.8. The south-west lead starts at x = -4.8, so a
    # plank stopping at -3.8 left a metre of sky between them -- the traverse
    # got seven waypoints in and dropped to the square. Boards overlap the leads
    # they land on; a bridge that merely reaches is a bridge you fall off.
    A.plank(t, 2.4, 15.0, -5.4, 15.0, ROOF_Z, w=1.25)
    A.rooftop(t, -9.0, 15.0, 8.4, 2.4, ROOF_Z, name="roof_sw")
    # what the climb is FOR: the only place you can look down into the square,
    # and a find that is not visible from the ground at all
    # THE CHEST AT THE END OF THE LEAD -- the "something good" Nell talks
    # about, which until now was an embercap like any other. The cap moves a
    # metre along so the count stays what the HUD says it is.
    A.chest(t, -11.4, 15.0, z0=ROOF_Z, yaw=90.0)
    A.embercap(t, -10.2, 15.9, z=ROOF_Z + 0.06)
    A.embercap(t, 17.0, 5.6, z=ROOF_Z + 0.06)

    # EMBERCAPS: four in the town, none of them on the walk from the spawn
    # point to the gate. Behind the market, up on the gallery deck, and one in
    # each alley -- the deck one is the only thing the stairs have ever led to.
    A.embercap(t, -10.6, 2.4)
    A.embercap(t, 12.6, 7.2, z=3.55)          # the gallery deck
    A.embercap(t, -14.2, 8.0)
    A.embercap(t, 15.4, -6.4)

    for x, y in ((-6.6, -8.8), (-7.3, -8.2), (6.2, -8.9)):
        A.barrel(t, x, y)
    for x, y, s, yaw in ((7.2, -8.4, 0.40, 18), (7.9, -8.9, 0.34, -25),
                         (-12.0, 1.8, 0.42, 8), (-12.3, 2.8, 0.36, 40)):
        A.crate(t, x, y, s=s, yaw=yaw)




def render_sheet(prefix, floor_obj):
    """Views chosen to answer the probe's questions, not to flatter the town:
    a plaza wide, the alley mouth, the terrace, and a street-level eye-line."""
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_WORKBENCH'
    scn.display.shading.light = 'STUDIO'
    scn.display.shading.color_type = 'MATERIAL'
    scn.display.shading.show_shadows = True
    scn.display.shading.show_cavity = True
    scn.render.resolution_x = 1100
    scn.render.resolution_y = 660
    scn.render.filter_size = 1.2
    if scn.world is None:
        scn.world = bpy.data.worlds.new("W")
    scn.world.use_nodes = False
    scn.world.color = (0.55, 0.66, 0.80)

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 32
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scn.camera = cam

    #        name          eye                     look-at
    views = [
        ("wide",     (26.0,  34.0, 26.0), (0.0,  0.5, 2.0)),
        ("plaza",    (-2.0,   8.5,  3.0), (0.0, -6.0, 2.4)),
        ("alley",    (-6.1,  -4.0,  1.7), (-6.1, -14.0, 2.2)),
        ("terrace",  (-1.0,   9.5,  3.2), (10.0,  4.0, 1.6)),
        ("eyeline",  (-3.0,   6.0,  1.7), (-1.0, -9.0, 2.0)),
        ("gateway",  (-1.0,  17.5,  2.2), (-1.0,  4.0, 2.6)),
    ]
    os.makedirs(prefix, exist_ok=True)
    out = []
    for name, eye, look in views:
        cam.location = Vector(eye)
        cam.rotation_euler = (Vector(look) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(prefix, f"town_{name}.png")
        bpy.ops.render.render(write_still=True)
        out.append(scn.render.filepath)
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = "public/assets/town.glb"
    render_dir = None
    for i, a in enumerate(argv):
        if a == "--out":
            out = argv[i + 1]
        elif a == "--render":
            render_dir = argv[i + 1]

    K.clear_scene()
    M = A.palette()
    # BEFORE anything is built, not partway through. It was swapped inside
    # build_buildings, which runs after build_ground -- so the terrace, the
    # stairs and the balustrade kept the flat stone while everything else got
    # the textured one, and the plaza had two kinds of stone in it.
    M.update(texture_walls(M))
    t = A.Town(M)

    build_ground(t)
    build_buildings(t)
    build_props(t)

    town, floor = A.finish(t)
    paved(floor, tile=3.2)
    # walls and roofs: per-face projection, at a coarser tile than the ground
    K.box_uvs(town, tile=2.4)     # one UV set for the whole walkable mesh

    tris = 0
    for o in (town, floor):
        if o:
            tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
    print(f"[town] {len(t.parts)} placed parts -> "
          f"{len(town.data.materials) if town else 0} town materials, "
          f"{len(floor.data.materials) if floor else 0} floor materials, "
          f"{tris} tris, {len(t.solids)} collision boxes")

    if render_dir:
        for f in render_sheet(render_dir, floor):
            print(f"[render] {f}")

    # visuals
    bpy.ops.object.select_all(action='DESELECT')
    for o in (town, floor, *t.props):
        if o:
            o.select_set(True)
    bpy.context.view_layer.objects.active = town or floor
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True,
        export_apply=True, export_animations=False, export_yup=True,
        # texcoords ON: this was False, left over from when nothing in the
        # town used a texture, and it silently dropped every UV -- the paving
        # arrived in the file with no way to sample it
        export_materials='EXPORT', export_texcoords=True, export_normals=True)
    print(f"[town] exported {out} ({os.path.getsize(out)/1024:.0f} KB)")

    # collision + lights, in three.js space, from the same run that built them
    man = t.manifest()
    # `k` is the lamp's JOB -- 'accent' on a sunlit street, 'interior' where it
    # is the only source in the room. The runtime used to infer that from the
    # lamp being below the paving, which described the cellar and nothing else.
    man["lights"] = [{"x": round(x, 3), "y": round(z, 3), "z": round(-y, 3), "k": k}
                     for x, y, z, k in t.lights]
    man["shafts"] = [{"x": round(x, 3), "z": round(-y, 3),
                      "hx": round(hx, 3), "hz": round(hy, 3),
                      "y0": round(z0, 3), "y1": round(z1, 3),
                      "pad": round(pad, 3)}
                     for x, y, hx, hy, z0, z1, pad in t.shafts]
    man["bounds"] = PLAZA
    mpath = os.path.splitext(out)[0] + ".manifest.json"
    with open(mpath, "w") as fh:
        json.dump(man, fh, indent=1)
    print(f"[town] wrote {mpath} "
          f"({len(man['solids'])} solids, {len(man['lights'])} lights)")


if __name__ == "__main__":
    main()
