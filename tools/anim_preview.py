"""anim_preview -- look at a clip without launching the game.

Authoring in `anim_lib` means typing euler degrees and imagining the result.
That is fine for a pose and hopeless for a motion: the difference between a
swing that lands and one that floats is spacing between frames, which no column
of numbers shows you.  This renders a clip as a CONTACT SHEET -- one row of
frames across the whole clip -- so the arc can be judged the way an animator
judges it, by looking at it.

Two things it deliberately does NOT do:

*   It does not hardcode a frame list.  `hero_build.render_poses` names a frame
    per clip, and those numbers went stale the moment a clip's timing changed.
    The range here is read off the action's own keyframes (rule (e): derive the
    offset from the constraint).
*   It does not require the Tripo sources.  A character can be loaded straight
    from a built `.glb`, which is the only way to preview a clip on Vesper on a
    machine that cannot run `char_build`.

    # every clip on the shipped hero, sampled 8 frames wide
    python3 tools/anim_preview.py -- --char public/assets/vesper.glb --clip all

    # one clip, from the side, straight off the library (no .glb needed)
    python3 tools/anim_preview.py -- --clip attack2 --view side --frames 10

The `--view` matters more than it looks.  A run cycle read from three-quarter
runs straight down the view axis and every frame looks like standing; a cast
read from the side hides the hands behind the body.  Pick the plane the motion
actually happens in.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Vector

import geo_lib as K
import surface_tex

# Camera azimuths, in degrees around the character.  0 looks at the front.
VIEWS = {"front": 0.0, "three-quarter": 38.0, "side": 90.0, "back": 180.0}


# ------------------------------------------------------------------- staging

def stage(bg=(0.30, 0.36, 0.46), res=(360, 520), ground=True, samples=8):
    """Scene, lights and a floor.  Same key/fill as `hero_build.render_sheet`,
    because a clip previewed under different light than the turnaround is a
    second opinion nobody asked for.

    SAMPLES ARE THE WHOLE BUDGET.  This box has no GPU, so EEVEE runs on
    llvmpipe and cost is very close to linear in `taa_render_samples`.  At the
    default 64 a single frame took 61 s, which makes an eight-frame sheet an
    eight-minute wait and kills the iteration loop this tool exists to provide.
    Eight samples is grainy in the shadows and identical in silhouette, and
    silhouette is what a clip is judged on.
    """
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_EEVEE'
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.film_transparent = False
    scn.render.image_settings.file_format = 'PNG'
    scn.eevee.taa_render_samples = samples
    scn.eevee.use_raytracing = False       # nothing here is reflective
    scn.eevee.shadow_ray_count = 1

    if scn.world is None:
        scn.world = bpy.data.worlds.new("W")
    scn.world.use_nodes = True
    node = scn.world.node_tree.nodes.get("Background")
    node.inputs[0].default_value = (*bg, 1.0)
    node.inputs[1].default_value = 1.0

    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN'))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(18)
    sun.rotation_euler = (math.radians(58), 0, math.radians(38))
    bpy.context.collection.objects.link(sun)

    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", 'AREA'))
    fill.data.energy = 90
    fill.data.size = 4.0
    fill.location = (-2.6, -2.2, 2.2)
    fill.rotation_euler = (math.radians(66), 0, math.radians(-52))
    bpy.context.collection.objects.link(fill)

    if ground:
        # A FLOOR, always.  Airborne frames are the ones most worth previewing
        # and the only cue that a character has left the ground is the ground.
        me = bpy.data.meshes.new("Ground")
        me.from_pydata([(-6, -6, 0), (6, -6, 0), (6, 6, 0), (-6, 6, 0)], [],
                       [(0, 1, 2, 3)])
        me.update()
        obj = bpy.data.objects.new("Ground", me)
        me.materials.append(K.material("preview_ground", (0.42, 0.46, 0.44)))
        bpy.context.collection.objects.link(obj)

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 55
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scn.camera = cam
    return cam


def frame_camera(cam, rig, azimuth, pad=1.30):
    """Aim at the character and back off far enough to hold it.

    The distance is DERIVED from the rig's own height rather than written down.
    A preview that assumes 1.74 m crops the head off anything taller, and the
    whole point of this tool is to look at characters whose proportions differ.
    """
    zs = [(rig.matrix_world @ b.head_local).z for b in rig.data.bones]
    zs += [(rig.matrix_world @ b.tail_local).z for b in rig.data.bones]
    height = max(zs) - min(0.0, min(zs))
    target = Vector((0.0, 0.0, height * 0.52))

    # 55 mm on the sensor's short side; add margin for limbs leaving the body
    sensor_fit = 2.0 * math.atan(bpy.context.scene.render.resolution_y
                                 / bpy.context.scene.render.resolution_x
                                 * 18.0 / cam.data.lens)
    dist = (height * pad) / (2.0 * math.tan(sensor_fit / 2.0)) + height * 0.35

    a = math.radians(azimuth)
    cam.location = target + Vector((math.sin(a) * dist, -math.cos(a) * dist,
                                    height * 0.12))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    return height, dist


# ------------------------------------------------------------------ loading

def load_glb(path):
    """Import a built character.  Returns its armature.

    This is the path that makes the tool usable without `assets/source/`: the
    rig, the mesh and the weights are all already inside the .glb, and
    `anim_lib` clips are pose data keyed by bone name, so they bind to it.
    """
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=path)
    rigs = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not rigs:
        raise SystemExit(f"[preview] {path} has no armature")
    return rigs[0]


def bind_action(rig, act):
    """Bind `act` AND set each bone's rotation mode to match what it animates.

    This is the joint (rule (a)), and it cost a full sheet of eight identical
    frames to find.  `anim_lib` authors euler XYZ; the glTF importer brings
    clips back as QUATERNIONS.  A bone whose mode disagrees with its own
    F-curves does not error -- Blender simply reads the channel the mode names
    and ignores the other, so the rig renders at rest while the clip plays
    perfectly.  `hips.location` still animated, which is exactly why the sheet
    looked plausible instead of empty.
    """
    if rig.animation_data is None:
        rig.animation_data_create()
    modes = {}
    for fc in K.fcurves(act):
        path = fc.data_path
        if 'pose.bones[' not in path:
            continue
        bone = path.split('"')[1]
        if path.endswith("rotation_quaternion"):
            modes[bone] = 'QUATERNION'
        elif path.endswith("rotation_euler"):
            modes[bone] = 'XYZ'
    for bone, mode in modes.items():
        pb = rig.pose.bones.get(bone)
        if pb is not None:
            pb.rotation_mode = mode

    rig.animation_data.action = act
    if hasattr(rig.animation_data, "action_slot") and act.slots:
        rig.animation_data.action_slot = act.slots[0]
    return modes


def key_range(act):
    """The clip's real extent, read off its own F-curves."""
    lo, hi = None, None
    for fc in K.fcurves(act):
        for kp in fc.keyframe_points:
            f = kp.co[0]
            lo = f if lo is None else min(lo, f)
            hi = f if hi is None else max(hi, f)
    return (0.0, 1.0) if lo is None else (lo, hi)


# ------------------------------------------------------------- contact sheet

def _read_png(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return px[::-1, :, :3]           # bpy pixels are bottom-up


def contact_sheet(rig, act, out, frames=8, view="side", at_keys=False,
                  gutter=2):
    """Render `frames` samples of `act` and tile them left to right."""
    scn = bpy.context.scene
    cam = scn.camera
    frame_camera(cam, rig, VIEWS[view])

    bind_action(rig, act)

    lo, hi = key_range(act)
    if at_keys:
        seen = sorted({kp.co[0] for fc in K.fcurves(act)
                       for kp in fc.keyframe_points})
        picks = seen[:frames] if len(seen) <= frames else [
            seen[round(i * (len(seen) - 1) / (frames - 1))] for i in range(frames)]
    else:
        # EVENLY SPACED, because spacing is the thing being judged.  Sampling
        # only the keys shows the poses and hides the timing between them.
        picks = [lo + (hi - lo) * i / max(1, frames - 1) for i in range(frames)]

    tmp = os.path.join(os.path.dirname(out) or ".", ".preview_tmp")
    os.makedirs(tmp, exist_ok=True)
    tiles = []
    for i, f in enumerate(picks):
        scn.frame_set(int(round(f)), subframe=float(f - int(f)))
        scn.render.filepath = os.path.join(tmp, f"f{i:02d}.png")
        bpy.ops.render.render(write_still=True)
        tiles.append(_read_png(scn.render.filepath))

    h, w, _ = tiles[0].shape
    sheet = np.full((h, len(tiles) * w + (len(tiles) - 1) * gutter, 3),
                    0.10, dtype=np.float32)
    for i, t in enumerate(tiles):
        x = i * (w + gutter)
        sheet[:, x:x + w] = t
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    surface_tex.write_png(out, sheet)

    for f in os.listdir(tmp):
        os.remove(os.path.join(tmp, f))
    os.rmdir(tmp)
    return picks, (lo, hi)


# --------------------------------------------------------------------- main

def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    char = opt("--char", "public/assets/vesper.glb")
    want = opt("--clip", "all")
    view = opt("--view", "side")
    frames = int(opt("--frames", 8))
    out_dir = opt("--out", "docs/anim")
    author = opt("--author")
    samples = int(opt("--samples", 8))
    at_keys = "--at-keys" in argv
    weapon = "--unarmed" not in argv

    if view not in VIEWS:
        raise SystemExit(f"[preview] --view must be one of {sorted(VIEWS)}")

    rig = load_glb(char)
    label = os.path.splitext(os.path.basename(char))[0]

    # THE ITERATION LOOP.  `--author` re-runs the library functions against the
    # imported rig, so a clip edited in `anim_lib` can be looked at without
    # rebuilding the character it is being previewed on.  Clips authored here
    # REPLACE any same-named clip that shipped inside the .glb.
    if author:
        import anim_lib
        names = ([n for n in dir(anim_lib) if n.startswith("anim_")]
                 if author == "all" else author.split(","))
        for fn_name in names:
            fn = getattr(anim_lib, fn_name, None)
            if fn is None:
                raise SystemExit(f"[preview] anim_lib has no {fn_name!r}")
            old = bpy.data.actions.get(fn_name.removeprefix("anim_"))
            if old is not None:
                bpy.data.actions.remove(old)
            act = fn(rig, weapon=weapon)
            print(f"[preview] authored {act.name} from {fn_name}"
                  f"{'' if weapon else ' (unarmed)'}")

    stage(samples=samples)

    names = ([a.name for a in bpy.data.actions] if want == "all"
             else [w for w in want.split(",")])
    made = []
    for name in names:
        act = bpy.data.actions.get(name)
        if act is None:
            print(f"[preview] no clip named {name!r}")
            continue
        out = os.path.join(out_dir, f"{label}_{name}_{view}.png")
        picks, (lo, hi) = contact_sheet(rig, act, out, frames=frames,
                                        view=view, at_keys=at_keys)
        # REPORT THE BREAKDOWN (rule (f)): which frames were sampled, out of what
        # range.  A sheet of eight identical poses means the clip is 2 frames
        # long, and that is only visible if the range is printed.
        print(f"[preview] {name:10} range {lo:.0f}-{hi:.0f}  "
              f"sampled {[round(p, 1) for p in picks]}  -> {out}")
        made.append(out)
    print(f"[preview] {len(made)} sheet(s) in {out_dir}")
    return made


if __name__ == "__main__":
    main()
