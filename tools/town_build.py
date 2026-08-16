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
    t.walk(A.box("floor_plaza", (0, -1.0, -0.25), (22.0, 20.0, 0.25),
                 cob, bevel=0.12, seg=1))

    # a paved ring around the fountain: a colour change is the cheapest way to
    # tell the player where the centre of a space is
    ring = []
    for i in range(41):
        a = 2 * math.pi * i / 40
        ring.append({"p": Vector((5.2 * math.cos(a), 0.5 + 5.2 * math.sin(a), 0.005)),
                     "r": (0.85, 0.06), "n": 3.0})
    t.add(K.tube("plaza_ring", ring, seg=8, mat=M["cobble_b"], squircle=3.0,
                 up=(0, 0, 1)))          # 0.85 wide, 0.06 proud -- not the reverse

    # raised terrace on the east side, reachable only by the stairs
    # coarser slabs on the terrace, so two paved areas beside each other do not
    # read as one surface
    flag = ground_material("flagstone_tex", surface_tex.flagstone, (0.62, 0.60, 0.58))
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
        (-11.5, -14.0, 9.0, 8.0, 3, 180, "plaster_a", "roof_a", True,  0, False),
        ( -1.0, -15.0, 8.5, 7.0, 2, 180, "plaster_b", "roof_b", False, 1, True),
        (  9.0, -14.0, 8.5, 8.0, 3, 180, "plaster_c", "roof_c", True,  2, False),

        (-17.0,  -2.0, 9.0, 8.0, 2,  90, "plaster_b", "roof_b", True,  3, True),
        (-17.0,   8.5, 9.0, 8.0, 3,  90, "plaster_d", "roof_a", False, 4, False),

        ( 17.0,  -2.0, 9.0, 8.0, 3, -90, "plaster_a", "roof_b", False, 5, True),
        ( 17.0,   8.5, 9.0, 8.0, 2, -90, "plaster_c", "roof_c", True,  6, False),

        ( -9.0,  15.0, 10.0, 8.0, 2,   0, "plaster_d", "roof_a", False, 7, False),
        (  7.0,  15.0, 10.0, 8.0, 2,   0, "plaster_a", "roof_c", True,  8, True),
    ]
    # roof height varies with the seed too: nine identical pitches is most of
    # what made nine buildings read as one building
    for cx, cy, w, d, st, yaw, pl, rf, shop, seed, gf in plan:
        A.building(t, cx, cy, w, d, storeys=st, yaw=yaw, plaster=pl, roof=rf,
                   shop=shop, seed=seed, gable_front=gf,
                   roof_h=1.25 + 0.16 * (seed % 4))

    # the south gateway, in the gap between the two south buildings
    A.arch(t, -1.0, 11.0, span=4.4, height=5.6, depth=1.7, thick=0.46)

    # THE LANDMARK, on the gate's axis and well behind the far side of the
    # plaza. Siting matters more than the model here: put it off to one side and
    # it is scenery you can walk past, but on the axis it is centred in the arch
    # from the meadow and centred over the fountain from inside the plaza. Five
    # storeys because it has to clear a 9.5 m roofline from a camera 1.7 m off
    # the ground -- at four it was hidden by the buildings in front of it.
    A.belltower(t, -1.0, -22.5, base=2.5, storeys=5)

    # THE UPPER LEVEL. On the east range, facing the plaza, so from the fountain
    # you can see both the stair and the deck it leads to -- a balcony you
    # cannot obviously get to is set dressing rather than verticality.
    A.gallery(t, 12.6, 8.5, w=7.0, d=2.2, deck=3.55, yaw=-90, stair_side=-1)


def build_props(t):
    lights = []
    A.fountain(t, 0.0, 0.5, r=2.6)

    for x, y in ((-8.5, -6.0), (8.5, -6.0), (-8.5, 7.5), (5.0, 9.0),
                 (-1.0, -8.6), (12.0, 0.2)):
        lights.append(A.lantern(t, x, y, h=3.2))

    for x, y, r in ((-12.4, -8.6, 0.55), (-4.0, -9.2, 0.5), (4.6, -9.2, 0.5),
                    (12.4, -8.6, 0.55), (-12.6, 9.4, 0.6), (2.0, 10.2, 0.5)):
        A.planter(t, x, y, r=r)

    for x, y in ((-6.6, -8.8), (-7.3, -8.2), (6.2, -8.9)):
        A.barrel(t, x, y)
    for x, y, s, yaw in ((7.2, -8.4, 0.40, 18), (7.9, -8.9, 0.34, -25),
                         (-12.0, 1.8, 0.42, 8), (-12.3, 2.8, 0.36, 40)):
        A.crate(t, x, y, s=s, yaw=yaw)

    return lights


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
    lights = build_props(t)

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
    for o in (town, floor):
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
    man["lights"] = [{"x": round(x, 3), "y": round(z, 3), "z": round(-y, 3)}
                     for x, y, z in lights]
    man["bounds"] = PLAZA
    mpath = os.path.splitext(out)[0] + ".manifest.json"
    with open(mpath, "w") as fh:
        json.dump(man, fh, indent=1)
    print(f"[town] wrote {mpath} "
          f"({len(man['solids'])} solids, {len(man['lights'])} lights)")


if __name__ == "__main__":
    main()
