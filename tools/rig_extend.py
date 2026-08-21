"""rig_extend -- give a built character a second spine segment.

The skeleton has twenty bones and exactly one joint between the hips and the
chest, so the torso HINGES.  Every big combat pose in `anim_lib` -- the
finisher's chop, the backhand's counter-rotation, the overhead cast -- is
asking the torso to curve, and a one-joint torso answers with a bend at one
height and two straight runs either side of it.  A second segment is the
cheapest thing that turns that hinge into a curve.

    python3 tools/rig_extend.py -- --char public/assets/vesper.glb --out /tmp/x.glb

WHY IT IS A MIGRATION AND NOT A BUILDER CHANGE.  Adding a bone to
`char_build.fit_skeleton` gives it to characters that can be rebuilt, and none
of the eleven in `public/assets` can be -- that needs `assets/source/`.  A
skeleton that exists in the builder and not in the shipped assets is the worst
of both: `anim_lib` would have to target both shapes at once.

THE WEIGHTS ARE THE RISK, and they are the reason this reports what it did.
The vertices the old `spine` moved have to be divided between the two new
segments, and there is no source of truth for that division -- it is derived
from where each vertex sits along the bone, smoothed so the seam is not a
crease.  Nothing about that is exact.  What makes it checkable is that the
character must not MOVE at rest: same skeleton, same skin, same silhouette,
with the bend simply distributed.  `--verify` measures exactly that.

The clips need no edit.  `anim_lib.SPREAD` shares a pose's `spine` rotation
across both segments when the rig has both, so the total bend is preserved and
every existing clip gains the curve for free.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Vector

import anim_lib
import geo_lib as K

SPLIT = 0.5      # where along the old spine the new joint goes
BLEND = 0.30     # how much of the bone length the weight handover spans


def smoothstep(a, b, t):
    if b <= a:
        return 0.0 if t < a else 1.0
    x = max(0.0, min(1.0, (t - a) / (b - a)))
    return x * x * (3.0 - 2.0 * x)


def split_spine(rig, body, parent="spine", new="spine2"):
    """Halve `parent` and give the upper half to a new bone, weights included."""
    arm = rig.data
    if new in arm.bones:
        raise SystemExit(f"[extend] {rig.name} already has {new}")

    head = Vector(arm.bones[parent].head_local)
    tail = Vector(arm.bones[parent].tail_local)
    axis = tail - head
    length = axis.length
    mid = head + axis * SPLIT
    roll_of = {}

    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    src = eb[parent]
    roll_of[parent] = src.roll
    kids = [b for b in eb if b.parent is src]

    src.tail = mid
    seg = eb.new(new)
    seg.head = mid
    seg.tail = tail
    # SAME ROLL, or the +X-is-forward convention every clip depends on stops
    # being true for this one bone -- and a rolled spine segment twists the
    # torso a few degrees in every pose in the library.
    seg.roll = roll_of[parent]
    seg.parent = src
    seg.use_connect = True
    for k in kids:
        k.parent = seg
    bpy.ops.object.mode_set(mode='OBJECT')

    # ---- weights: hand the upper half of `parent`'s influence to `new`
    grp = body.vertex_groups.get(parent)
    if grp is None:
        raise SystemExit(f"[extend] {body.name} has no {parent!r} vertex group")
    dst = body.vertex_groups.get(new) or body.vertex_groups.new(name=new)
    lo, hi = SPLIT - BLEND / 2.0, SPLIT + BLEND / 2.0

    moved = 0
    total = 0.0
    for v in body.data.vertices:
        w = next((g.weight for g in v.groups if g.group == grp.index), 0.0)
        if w <= 0.0:
            continue
        t = (Vector(v.co) - head).dot(axis) / max(length * length, 1e-9)
        s = smoothstep(lo, hi, t)
        if s <= 0.0:
            continue
        dst.add([v.index], w * s, 'REPLACE')
        grp.add([v.index], w * (1.0 - s), 'REPLACE')
        moved += 1
        total += w * s
    print(f"[extend] {parent} -> {parent} + {new}: {moved} vertices share "
          f"weight, {total:.1f} total moved up")
    return seg


def rest_shape(path):
    """Every vertex of the character in its REST pose, for comparison."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    bpy.ops.import_scene.gltf(filepath=path)
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    if rig.animation_data:
        rig.animation_data.action = None
    K.rest(rig)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        pts += [ev.matrix_world @ v.co for v in me.vertices]
        ev.to_mesh_clear()
    return pts


def extend(path, out=None, weapon=True):
    out = out or path
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)

    bpy.ops.import_scene.gltf(filepath=path)
    rig = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    body = next((o for o in bpy.data.objects
                 if o.type == 'MESH' and o.parent is rig
                 and o.vertex_groups), None)
    if rig is None or body is None:
        raise SystemExit(f"[extend] {path} has no rig+skinned body")
    before = len(rig.data.bones)

    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    split_spine(rig, body)

    # re-author, so the clips arrive knowing about the new segment
    bpy.context.scene.render.fps = 24
    K.rest(rig)
    made = [fn(rig, weapon=weapon).name for _, fn in anim_lib.library()]
    K.rest(rig)
    K.export_glb(out, rig)
    print(f"[extend] {os.path.basename(path)}: {before} -> "
          f"{len(rig.data.bones)} bones, {len(made)} clips re-authored")
    print(f"[extend] wrote {out} ({os.path.getsize(out)/1024:.0f} KB)")
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    char = opt("--char")
    if not char:
        raise SystemExit("[extend] --char <path.glb> is required")
    out = opt("--out") or char
    before = rest_shape(char) if "--verify" in argv else None
    extend(char, out=out, weapon="--unarmed" not in argv)
    if before is not None:
        after = rest_shape(out)
        if len(before) != len(after):
            print(f"[extend] VERTEX COUNT CHANGED {len(before)} -> {len(after)}")
            return
        d = [(a - b).length for a, b in zip(before, after)]
        d.sort()
        print(f"[extend] rest pose moved: max {d[-1]*1000:.3f} mm, "
              f"median {d[len(d)//2]*1000:.3f} mm over {len(d)} verts")


if __name__ == "__main__":
    main()
