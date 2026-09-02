"""tree_rack -- the meadow's trees side by side, rendered, so a recipe can be
judged as a picture and not as a triangle count.

    python3 tools/tree_rack.py -- --out docs/trees/rack.png

Each column is one recipe at scale 1.0 on flat ground, lit by the same sun the
meadow's own preview uses.  A tree is the one object in every outdoor frame,
and the only honest way to change it is to look at the old one and the new one
at the same time.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Vector

import arch_lib as A
import geo_lib as K
import meadow_build as MB


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    out = opt("--out", "docs/trees/rack.png")
    kinds = opt("--kinds", "broadleaf,broadleaf,conifer,snag").split(",")
    seed = int(opt("--seed", "7"))

    os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
    K.clear_scene()
    M = A.palette()
    MB.materials(M)
    MB.height = lambda x, y: 0.0            # flat ground: the recipe, not the site
    t = A.Town(M)
    gap = 5.2
    for i, kind in enumerate(kinds):
        x = (i - (len(kinds) - 1) / 2) * gap
        MB.tree(M, t, x, 0.0, 1.0, kind=kind, rnd=MB._lcg(seed + i * 131))
    # a ground slab so the roots have something to meet
    t.add(A.box("ground", (0, 0, -0.10), (gap * len(kinds) / 2 + 2, 6, 0.10),
                M["grass"], bevel=0.02, seg=1))
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in t.parts)
    print(f"[rack] {len(kinds)} trees, {len(t.parts)} parts, {tris} tris "
          f"({tris // len(kinds)} per tree)")

    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_EEVEE'
    scn.eevee.taa_render_samples = 8
    scn.render.resolution_x = 1400
    scn.render.resolution_y = 640
    if scn.world is None:
        scn.world = bpy.data.worlds.new("W")
    scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.62, 0.74, 0.88, 1.0)
    bg.inputs[1].default_value = 1.0
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN'))
    sun.data.energy = 3.4
    sun.data.angle = math.radians(10)
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    bpy.context.collection.objects.link(sun)
    cd = bpy.data.cameras.new("Cam")
    cd.lens = 28
    cam = bpy.data.objects.new("Cam", cd)
    bpy.context.collection.objects.link(cam)
    scn.camera = cam
    eye = Vector((0.0, -gap * len(kinds) * 0.55 - 4.0, 3.0))
    look = Vector((0.0, 0.0, 2.2))
    cam.location = eye
    cam.rotation_euler = (look - eye).to_track_quat('-Z', 'Y').to_euler()
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    scn.render.filepath = os.path.abspath(out)
    bpy.ops.render.render(write_still=True)
    print(f"[rack] wrote {out}")


if __name__ == "__main__":
    main()
