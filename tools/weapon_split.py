"""weapon_split -- take the sword out of a character that was already built.

`char_build` now leaves the weapon as its own object riding hand.R, but that
only helps characters that can be REBUILT, and rebuilding needs `assets/source/`
-- the ~40 MB of Tripo meshes that are gitignored and absent from a fresh
clone.  Every character currently in `public/assets/` was built the old way,
with the blade welded into the skinned mesh.

This migrates them in place instead.  It works because glTF splits a mesh into
one primitive per material, so the sword arrives back from the importer as its
own polygons wearing `steel`, `brass` and `leather` -- separable without
guessing, without the source, and without touching the body's weights.

    python3 tools/weapon_split.py -- --char public/assets/vesper.glb
    python3 tools/weapon_split.py -- --char public/assets/lake.glb --out /tmp/x.glb

WHAT IT WILL NOT DO IS GUESS.  A material list that matches nothing, or that
matches part of the body, is a silent disaster -- you would only find out when a
character's boots flew off with the sword.  So it prints exactly which materials
matched and how many vertices moved, and refuses to write anything if the split
would take the whole mesh or none of it.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy

import geo_lib as K
import props

# The sword `props.sword` builds, by material.  These are the names
# `props.palette()` gives it, and on a char_build character nothing else wears
# them -- the body is a single material named after the character.
WEAPON_MATS = ("steel", "brass", "leather")


def base_name(mat):
    """Blender uniquifies duplicate material names with a .001 suffix."""
    return mat.name.split('.')[0] if mat else ""


def split(path, out=None, mats=WEAPON_MATS, bone="hand.R"):
    out = out or path
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)

    bpy.ops.import_scene.gltf(filepath=path)
    rig = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    if rig is None:
        raise SystemExit(f"[split] {path} has no armature")
    body = next((o for o in bpy.data.objects
                 if o.type == 'MESH' and o.parent is rig), None)
    if body is None:
        raise SystemExit(f"[split] {path} has no mesh parented to the rig")

    clips_before = sorted(a.name for a in bpy.data.actions)
    verts_before = len(body.data.vertices)
    want = {m.lower() for m in mats}
    slots = [i for i, m in enumerate(body.data.materials)
             if base_name(m).lower() in want]
    matched = [base_name(body.data.materials[i]) for i in slots]
    if not slots:
        raise SystemExit(f"[split] no material of {sorted(want)} on {path}; "
                         f"has {[base_name(m) for m in body.data.materials]}")

    # select the weapon's polygons by material slot
    bpy.context.view_layer.objects.active = body
    for o in bpy.data.objects:
        o.select_set(False)
    body.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    moving = set()
    for poly in body.data.polygons:
        if poly.material_index in slots:
            poly.select = True
            moving.update(poly.vertices)
    if not moving:
        raise SystemExit(f"[split] {matched} matched no polygons on {path}")
    if len(moving) >= verts_before:
        raise SystemExit(f"[split] {matched} would take the WHOLE mesh "
                         f"({len(moving)}/{verts_before} verts) on {path}")

    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')

    new = [o for o in bpy.context.selected_objects if o is not body]
    if len(new) != 1:
        raise SystemExit(f"[split] expected one new object, got {len(new)}")
    weapon = new[0]

    # It came out of a skinned mesh, so it is still skinned.  attach_to_bone
    # drops the modifier and the groups and rides the bone instead -- and its
    # parent-inverse puts it back exactly where the skin had it at rest.
    label = os.path.splitext(os.path.basename(path))[0].capitalize()
    props.attach_to_bone([weapon], rig, bone, name=f"{label}_Weapon")

    tris = sum(len(p.vertices) - 2 for p in weapon.data.polygons)
    print(f"[split] {os.path.basename(path)}: {matched} -> {label}_Weapon "
          f"({len(weapon.data.vertices)} verts, {tris} tris) on {bone}; "
          f"body {verts_before} -> {len(body.data.vertices)} verts")

    K.export_glb(out, rig)
    clips_after = sorted(a.name for a in bpy.data.actions)
    if clips_after != clips_before:
        raise SystemExit(f"[split] clips changed! {clips_before} -> {clips_after}")
    print(f"[split] wrote {out} ({os.path.getsize(out)/1024:.0f} KB), "
          f"{len(clips_after)} clips intact")
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    char = opt("--char")
    if not char:
        raise SystemExit("[split] --char <path.glb> is required")
    mats = tuple(opt("--mats", ",".join(WEAPON_MATS)).split(","))
    split(char, out=opt("--out"), mats=mats, bone=opt("--bone", "hand.R"))


if __name__ == "__main__":
    main()
