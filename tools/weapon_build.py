"""weapon_build -- build the weapons, and look at them.

    python3 tools/weapon_build.py -- --rack docs/weapons/rack.png
    python3 tools/weapon_build.py -- --out public/assets/weapons

The rack is not a nicety.  These are judged at four to six metres through a
toon ramp, where a weapon is a silhouette and a metal colour, so the only
question that matters about a new one is "can you tell it from the last one" --
and that is a question about a row of them side by side, not about any one.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Matrix, Vector

import geo_lib as K
import weapon_lib


def upright(objs, x):
    """Stand a canonical (blade down -Z) weapon up at `x`, blade in the air."""
    m = (Matrix.Translation((x, 0.0, 0.55))
         @ Matrix.Rotation(math.radians(180.0), 4, 'X'))
    for o in objs:
        K.transform(o, matrix=m)
    return objs


def rack(path, ids=None, mats=None):
    """Every weapon in a row, standing, front on."""
    import anim_preview
    K.clear_scene()
    M = mats or weapon_lib.palette()
    ids = ids or list(weapon_lib.CATALOGUE)

    made = []
    span = 0.34
    x0 = -span * (len(ids) - 1) / 2.0
    for i, wid in enumerate(ids):
        parts = weapon_lib.build(wid, mats=M)
        upright(parts, x0 + i * span)
        made.append(K.join(parts, wid.replace("-", "_")))

    cam = anim_preview.stage(res=(260 * len(ids), 760), ground=True, samples=8)
    # FRAME WHAT IS ACTUALLY THERE.  Written by hand first, and the blades left
    # the top of the picture -- the whole point of a rack is comparing lengths,
    # which is exactly the information a crop removes (rule (e)).
    pts = [o.matrix_world @ v.co for o in made for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), 0, min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), 0, max(p.z for p in pts)))
    mid = Vector((0.0, 0.0, (lo.z + hi.z) / 2.0))
    res_x, res_y = scn_res = (bpy.context.scene.render.resolution_x,
                              bpy.context.scene.render.resolution_y)
    half_v = math.atan(18.0 * res_y / res_x / cam.data.lens)
    half_h = math.atan(18.0 / cam.data.lens)
    need = max((hi.z - lo.z) * 0.5 / math.tan(half_v),
               (hi.x - lo.x) * 0.5 / math.tan(half_h)) * 1.12
    cam.location = mid + Vector((0.0, -need, 0.0))
    cam.rotation_euler = (mid - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scn = bpy.context.scene
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for wid, o in zip(ids, made):
        zs = [(o.matrix_world @ v.co).z for v in o.data.vertices]
        print(f"[weapon] {wid:13} {len(o.data.vertices):4} verts, "
              f"{max(zs) - min(zs):.3f} m tip to pommel")
    print(f"[weapon] rack -> {path}")
    return path


def export(out_dir, ids=None, mats=None):
    """One .glb per weapon, in the canonical grip-at-origin frame."""
    ids = ids or list(weapon_lib.CATALOGUE)
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for wid in ids:
        K.clear_scene()
        M = mats or weapon_lib.palette()
        obj = K.join(weapon_lib.build(wid, mats=M), wid.replace("-", "_"))
        obj.vertex_groups.clear()
        path = os.path.join(out_dir, f"{wid}.glb")
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.export_scene.gltf(
            filepath=path, export_format='GLB', use_selection=True,
            export_apply=True, export_animations=False, export_yup=True,
            export_materials='EXPORT', export_normals=True)
        print(f"[weapon] {wid:13} -> {path} "
              f"({os.path.getsize(path)/1024:.0f} KB, "
              f"{len(obj.data.vertices)} verts)")
        written.append(wid)
    return written


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    ids = opt("--only")
    ids = ids.split(",") if ids else None
    if opt("--rack"):
        rack(opt("--rack"), ids=ids)
    if opt("--out"):
        export(opt("--out"), ids=ids)
    if not opt("--rack") and not opt("--out"):
        raise SystemExit("[weapon] give --rack <png> or --out <dir>")


if __name__ == "__main__":
    main()
