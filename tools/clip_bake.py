"""clip_bake -- put the animation library into a character that already exists.

`char_build` authors every clip from `anim_lib` and exports the result, which is
the right design and unavailable on a machine without `assets/source/`.  This
does the same job to a character that has already been built: import the .glb,
author the library onto the rig it already carries, export.

    python3 tools/clip_bake.py -- --char public/assets/vesper.glb
    python3 tools/clip_bake.py -- --char public/assets/npc/pip.glb --unarmed

IT RE-AUTHORS THE WHOLE SET, and does not add to what is already inside.  That
is not tidiness, it is the only correct option, and the reason is a trap worth
writing down.

Rotation mode in Blender is a property of the BONE, not of the action.  The
glTF importer brings clips back as quaternions; `anim_lib` authors euler XYZ;
`K.action` sets every pose bone to XYZ as it starts.  So the moment one new
clip is authored onto an imported rig, every imported clip on that rig is being
read through the wrong channel -- and nothing errors.  The exporter samples the
rest pose and writes ten perfectly valid, perfectly motionless animations.
Adding a spell would have silently flattened the combo.

Re-authoring sidesteps it: one source, one representation, and `anim_lib` is
where those ten clips came from in the first place.  The verify step at the end
is not decoration -- it checks that a bone actually MOVES in every clip written.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy

import anim_lib
import geo_lib as K


def bake(path, out=None, weapon=True, only=None):
    out = out or path
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)

    bpy.ops.import_scene.gltf(filepath=path)
    rig = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    if rig is None:
        raise SystemExit(f"[bake] {path} has no armature")
    had = sorted(a.name for a in bpy.data.actions)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    made = []
    for name, fn in anim_lib.library(only):
        made.append(fn(rig, weapon=weapon).name)

    # A CLIP THAT DOES NOT MOVE IS THE FAILURE MODE HERE, so look for motion
    # rather than for a clip list.  Both are cheap; only one of them would have
    # caught the rotation-mode trap this file exists to avoid.
    still = []
    for name in made:
        act = bpy.data.actions.get(name)
        spans = []
        for fc in K.fcurves(act):
            vals = [kp.co[1] for kp in fc.keyframe_points]
            if vals:
                spans.append(max(vals) - min(vals))
        if not spans or max(spans) < 1e-6:
            still.append(name)
    if still:
        raise SystemExit(f"[bake] {still} have no motion in them")

    K.rest(rig)
    K.export_glb(out, rig)
    gained = sorted(set(made) - set(had))
    lost = sorted(set(had) - set(made))
    print(f"[bake] {os.path.basename(path)}: {len(made)} clips "
          f"({'armed' if weapon else 'unarmed'}), "
          f"+{gained if gained else 'none'}"
          f"{f', LOST {lost}' if lost else ''}")
    print(f"[bake] wrote {out} ({os.path.getsize(out)/1024:.0f} KB)")
    return made


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    char = opt("--char")
    if not char:
        raise SystemExit("[bake] --char <path.glb> is required")
    only = opt("--clips")
    bake(char, out=opt("--out"), weapon="--unarmed" not in argv,
         only=only.split(",") if only else None)


if __name__ == "__main__":
    main()
