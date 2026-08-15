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
import kh_lib as K
import arch_lib as A


# Plaza interior is roughly X -13..13, Y -10..11.  Buildings ring it just
# outside those bounds; the cobble slab runs wider so nothing floats.
PLAZA = dict(x0=-13.0, x1=13.0, y0=-10.0, y1=11.0)


def build_ground(t):
    M = t.M
    t.walk(A.box("floor_plaza", (0, -1.0, -0.25), (22.0, 20.0, 0.25),
                 M["cobble"], bevel=0.12, seg=1))

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
    t.walk(A.box("floor_terrace", (10.0, 4.0, 0.55), (3.5, 5.0, 0.55),
                 M["stone"], bevel=0.07, seg=2))
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
    plan = [
        (-11.5, -14.0, 9.0, 8.0, 3, 180, "plaster_a", "roof_a", True,  0),
        ( -1.0, -15.0, 8.5, 7.0, 2, 180, "plaster_b", "roof_b", False, 1),
        (  9.0, -14.0, 8.5, 8.0, 3, 180, "plaster_c", "roof_c", True,  2),

        (-17.0,  -2.0, 9.0, 8.0, 2,  90, "plaster_b", "roof_b", True,  3),
        (-17.0,   8.5, 9.0, 8.0, 3,  90, "plaster_d", "roof_a", False, 4),

        ( 17.0,  -2.0, 9.0, 8.0, 3, -90, "plaster_a", "roof_b", False, 5),
        ( 17.0,   8.5, 9.0, 8.0, 2, -90, "plaster_c", "roof_c", True,  6),

        ( -9.0,  15.0, 10.0, 8.0, 2,   0, "plaster_d", "roof_a", False, 7),
        (  7.0,  15.0, 10.0, 8.0, 2,   0, "plaster_a", "roof_c", True,  8),
    ]
    for cx, cy, w, d, st, yaw, pl, rf, shop, seed in plan:
        A.building(t, cx, cy, w, d, storeys=st, yaw=yaw, plaster=pl, roof=rf,
                   shop=shop, seed=seed)

    # the south gateway, in the gap between the two south buildings
    A.arch(t, -1.0, 11.0, span=4.4, height=5.6, depth=1.7, thick=0.46)


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
    t = A.Town(M)

    build_ground(t)
    build_buildings(t)
    lights = build_props(t)

    town, floor = A.finish(t)

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
        export_materials='EXPORT', export_texcoords=False, export_normals=True)
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
