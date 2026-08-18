"""char_build -- drive externally-authored meshes with this project's rig.

Vesper, Lake and Maren were authored for the Emberbrook project as Tripo
image-to-3D generations -- ~95k triangles each, skinned to the same 41-joint
auto-rig.  This takes the MODEL and nothing else: not that project's skeleton,
not its retargeted donor clips, not its conventions.  Each gets the rig built by
`geo_lib.build_armature` and the clips from `anim_lib` -- the same ones the
scripted hero uses.

Because all three share one source rig, the intake is entirely data-driven:
adding a character is a row in CHARACTERS, not new code.

The point of the exercise is that the animation library is character-agnostic.
Clips are bone-name-keyed pose data, so a skeleton fitted to a completely
different body plays them without a retarget step.

THREE THINGS MAKE THIS WORK:

1.  HER JOINTS ARE MEASURED, NOT GUESSED.  The source rig's joint positions are
    facts about where her elbows and knees actually are inside her mesh, so the
    new skeleton is fitted to those landmarks rather than to a template.

2.  HER SKIN WEIGHTS ARE REUSED, NOT RESOLVED.  66k vertices already carry good
    weights; they are re-bucketed onto the simpler skeleton by summing each
    source group into the bone that replaces it (three twist bones collapse into
    one forearm, and so on).  This beats re-running automatic weights, which
    would throw away per-vertex work that is part of the model.

3.  SHE ALREADY FACES -Y.  The source rig's toes sit forward of its ankles along
    -Y, which is this project's convention, so no reorientation is needed.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/char_build.py -- \
      --name vesper [--render docs/qa/vesper] [--decimate 0.45]
"""
import bpy
import math
import os
import sys

from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_lib as K
import anim_lib
import props

NAME = ["char"]        # set by main(); used only for log prefixes


# Heights are a CASTING decision, not a measurement: the source meshes are all
# normalised to roughly the same size, so scale is where the cast gets its
# range.  Maren is seventeen and wiry, Lake a grown man, Vesper between them.
CHARACTERS = {
    "vesper": {"src": "assets/source/vesper-src.glb", "height": 1.70,
               "tint": (0.55, 0.62, 0.60)},
    "lake":   {"src": "assets/source/lake-src.glb",   "height": 1.80,
               "tint": (0.45, 0.45, 0.48)},
    "maren":  {"src": "assets/source/maren-src.glb",  "height": 1.62,
               "tint": (0.52, 0.48, 0.42)},
    # THE TOWNSPEOPLE. Same intake, same argument: these are Emberbrook Tripo
    # generations on the identical source rig, so they cost a row here and
    # nothing else. Three more bodies is what turns "the player and two
    # travellers" into a town with people in it -- and every one of them
    # already has painted cut-in art in that project, which is the half of a
    # conversation this engine cannot generate.
    "finn":   {"src": "assets/source/finn-src.glb",   "height": 1.74,
               "tint": (0.58, 0.52, 0.44)},
    "mara":   {"src": "assets/source/mara-src.glb",   "height": 1.66,
               "tint": (0.50, 0.52, 0.55)},
    "pip":    {"src": "assets/source/pip-src.glb",    "height": 1.58,
               "tint": (0.50, 0.56, 0.46)},
}
# euler degrees in the hand bone's frame -- dialled by eye against renders
SWORD_TWEAK = (0.0, 0.0, 0.0)
TARGET_HEIGHT = 1.70

# Source joint -> this project's bone.  Several source joints collapse into one:
# the twist bones exist to spread a forearm rotation across the skin, which this
# rig does not have, so their weights fold into the parent they belong to.
JOINT_MAP = {
    "Hip": "hips", "Pelvis": "hips", "Waist": "hips", "Root": "root",
    "Spine01": "spine", "Spine02": "chest",
    "NeckTwist01": "neck", "NeckTwist02": "neck", "Head": "head",
}
for S, side in (("L", "L"), ("R", "R")):
    JOINT_MAP.update({
        f"{S}_Clavicle": f"shoulder.{side}",
        f"{S}_Upperarm": f"upperarm.{side}",
        f"{S}_UpperarmTwist01": f"upperarm.{side}",
        f"{S}_UpperarmTwist02": f"upperarm.{side}",
        f"{S}_Forearm": f"forearm.{side}",
        f"{S}_ForearmTwist01": f"forearm.{side}",
        f"{S}_ForearmTwist02": f"forearm.{side}",
        f"{S}_Hand": f"hand.{side}",
        f"{S}_Thigh": f"thigh.{side}",
        f"{S}_ThighTwist01": f"thigh.{side}",
        f"{S}_ThighTwist02": f"thigh.{side}",
        f"{S}_Calf": f"shin.{side}",
        f"{S}_CalfTwist01": f"shin.{side}",
        f"{S}_CalfTwist02": f"shin.{side}",
        f"{S}_Foot": f"foot.{side}",
        f"{S}_ToeBase": f"foot.{side}",
    })


def base_colour_only(body, tint=(0.6, 0.6, 0.6)):
    """Replace the imported PBR material with a base-colour-only one.

    The delivery ships a normal map and a 7 MB metallic-roughness PNG.  A toon
    ramp reads neither -- lighting is quantised by the ramp and rim, not by
    measured microsurface -- so they are pure download weight.  Dropping them
    takes the character from 13 MB to about 4 MB and changes nothing on screen.
    """
    me = body.data
    img = None
    for mat in me.materials:
        if not mat or not mat.use_nodes:
            continue
        bsdf = next((n for n in mat.node_tree.nodes
                     if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        link = next((l for l in mat.node_tree.links
                     if l.to_node is bsdf and l.to_socket.name == "Base Color"), None)
        if link and link.from_node.type == 'TEX_IMAGE':
            img = link.from_node.image
            break
    if img is None:                       # fall back to the largest JPEG
        cands = [i for i in bpy.data.images if i.size[0]]
        img = max(cands, key=lambda i: i.size[0] * i.size[1]) if cands else None
    if img is None:
        raise RuntimeError("no base colour texture found on the source mesh")

    me.materials.clear()
    me.materials.append(K.image_material(NAME[0], img, preview=tint))
    print(f"[{NAME[0]}] material: base colour only "
          f"({img.name}, {img.size[0]}x{img.size[1]})")


def load_source(path):
    """Import the GLB and return (mesh object, {source bone: world head})."""
    K.clear_scene()
    bpy.ops.import_scene.gltf(filepath=path)

    # The delivery carries its own retargeted clips.  They belong to a skeleton
    # this build is about to delete, and they are not ours to inherit.
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)

    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if not arms or not meshes:
        raise RuntimeError(f"{path}: expected an armature and a mesh")
    # the delivery carries a stray 42-vertex icosphere alongside the body
    body = max(meshes, key=lambda m: len(m.data.vertices))
    for m in meshes:
        if m is not body:
            bpy.data.objects.remove(m, do_unlink=True)

    src_arm = arms[0]
    landmarks = {b.name: (src_arm.matrix_world @ b.head_local).copy()
                 for b in src_arm.data.bones}
    return body, src_arm, landmarks


def read_weights(body, src_arm):
    """Per-vertex weights re-bucketed from the source groups onto our bones."""
    names = {vg.index: vg.name for vg in body.vertex_groups}
    unmapped = set()
    out = []
    for v in body.data.vertices:
        acc = {}
        for g in v.groups:
            src = names.get(g.group)
            tgt = JOINT_MAP.get(src)
            if tgt is None:
                if src:
                    unmapped.add(src)
                continue
            acc[tgt] = acc.get(tgt, 0.0) + g.weight
        total = sum(acc.values())
        if total > 1e-6:
            acc = {k: w / total for k, w in acc.items()}
        out.append(acc)
    if unmapped:
        print(f"[{NAME[0]}] WARNING unmapped source joints: {sorted(unmapped)}")
    return out


def fit_skeleton(L, scale):
    """Build this project's bone spec at her measured landmarks.

    Every position comes from the source rig, so the skeleton lands inside her
    body rather than inside a template's idea of a body.  Only two bones are
    invented: `root` (a floor anchor the source rig puts at the hips) and the
    head tip, which is placed from the mesh top.
    """
    def P(name):
        return L[name] * scale

    hips = P("Hip")
    spec = [
        ("root",  Vector((hips.x, hips.y, 0.0)), Vector((hips.x, hips.y, 0.18)),
         None, False),
        ("hips",  hips, P("Spine01"), "root", False),
        ("spine", P("Spine01"), P("Spine02"), "hips", True),
        ("chest", P("Spine02"), P("NeckTwist01"), "spine", True),
        ("neck",  P("NeckTwist01"), P("Head"), "chest", True),
        ("head",  P("Head"), P("Head") + Vector((0, 0, 0.24)), "neck", True),
    ]
    for s in ("L", "R"):
        # the hand bone needs a tip; the source rig ends at the wrist, so extend
        # along the forearm direction by a hand's length
        wrist = P(f"{s}_Hand")
        elbow = P(f"{s}_Forearm")
        tip = wrist + (wrist - elbow).normalized() * 0.10
        ankle = P(f"{s}_Foot")
        toe = P(f"{s}_ToeBase")
        # her toe landmark sits almost under the ankle; push it forward so the
        # foot bone has a real direction to rotate about
        toe = Vector((toe.x, min(toe.y, ankle.y - 0.10), max(toe.z - 0.02, 0.01)))
        spec += [
            (f"shoulder.{s}", P(f"{s}_Clavicle"), P(f"{s}_Upperarm"), "chest", False),
            (f"upperarm.{s}", P(f"{s}_Upperarm"), P(f"{s}_Forearm"), f"shoulder.{s}", True),
            (f"forearm.{s}",  P(f"{s}_Forearm"),  wrist, f"upperarm.{s}", True),
            (f"hand.{s}",     wrist, tip, f"forearm.{s}", True),
            (f"thigh.{s}",    P(f"{s}_Thigh"), P(f"{s}_Calf"), "hips", False),
            (f"shin.{s}",     P(f"{s}_Calf"),  ankle, f"thigh.{s}", True),
            (f"foot.{s}",     ankle, toe, f"shin.{s}", True),
        ]
    return spec


def build(src, decimate=None, target_height=TARGET_HEIGHT,
          tint=(0.6, 0.6, 0.6), with_sword=True):
    body, src_arm, L = load_source(src)

    raw_h = max(v.co.z for v in body.data.vertices)
    scale = target_height / raw_h
    print(f"[{NAME[0]}] source height {raw_h:.4f} -> {target_height:.2f} m "
          f"(scale {scale:.4f}), {len(body.data.vertices)} verts")

    if decimate:
        mod = body.modifiers.new("Decimate", 'DECIMATE')
        mod.ratio = decimate
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.modifier_apply(modifier=mod.name)
        print(f"[{NAME[0]}] decimated to {len(body.data.vertices)} verts "
              f"({len(body.data.polygons)} faces)")

    base_colour_only(body, tint)
    weights = read_weights(body, src_arm)

    # scale mesh data in place, so the object transform stays identity
    for v in body.data.vertices:
        v.co *= scale

    # the source armature has done its job
    bpy.data.objects.remove(src_arm, do_unlink=True)
    body.modifiers.clear()
    body.vertex_groups.clear()
    body.parent = None
    body.matrix_world.identity()

    spec = fit_skeleton(L, scale)
    rig = K.build_armature(NAME[0].capitalize() + "_Rig", spec)
    K._apply_weights(body, weights)

    # give them something to swing.  The prop is generated, weighted to hand.R,
    # and JOINED into the body so the character stays one skinned mesh -- the
    # runtime then treats the sword as just another material on the character.
    if with_sword:
        blade = props.sword(bone="hand.R", scale=scale * 0.54, mats=props.palette())
        props.place_in_hand(blade, rig, "hand.R", along=0.48, tweak=SWORD_TWEAK)
        body = K.join([body] + blade, NAME[0].capitalize())
        print(f"[{NAME[0]}] sword: {len(blade)} parts joined into the body")

    body.name = NAME[0].capitalize()
    K.check_weights(body)

    mod = body.modifiers.new("Armature", 'ARMATURE')
    mod.object = rig
    body.parent = rig

    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    print(f"[{NAME[0]}] rigged: {tris} tris, {len(body.vertex_groups)} groups, "
          f"{len(rig.data.bones)} bones")
    return body, rig


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(flag, default=None):
        return argv[argv.index(flag) + 1] if flag in argv else default

    name = opt("--name", "vesper")
    if name not in CHARACTERS:
        raise SystemExit(f"unknown character {name!r}; know {sorted(CHARACTERS)}")
    cfg = CHARACTERS[name]
    NAME[0] = name
    src = opt("--src", cfg["src"])
    out = opt("--out", f"public/assets/{name}.glb")
    render_dir = opt("--render")
    decimate = float(opt("--decimate", 0.45)) or None

    body, rig = build(src, decimate=decimate, target_height=cfg["height"],
                      tint=cfg["tint"])

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    for fn in (anim_lib.anim_idle, anim_lib.anim_run, anim_lib.anim_attack,
               anim_lib.anim_attack2, anim_lib.anim_attack3,
               anim_lib.anim_airattack, anim_lib.anim_dodge, anim_lib.anim_hurt,
               anim_lib.anim_jump, anim_lib.anim_land):
        fn(rig, weapon=True)           # they carry a sword
    print(f"[{NAME[0]}] actions: {sorted(a.name for a in bpy.data.actions)}")

    if render_dir:
        import hero_build
        K.rest(rig)
        rig.animation_data.action = None
        for f in hero_build.render_sheet(render_dir, rig, body):
            print(f"[render] {f}")
        for f in hero_build.render_poses(render_dir, rig):
            print(f"[render] {f}")

    K.rest(rig)
    path = K.export_glb(out, rig)
    info = K.verify_glb(path, animations=["idle", "run", "attack", "attack2", "attack3",
                                          "airattack", "dodge", "hurt",
                                    "jump", "land"])
    print(f"[{NAME[0]}] exported {path} ({os.path.getsize(path)/1024:.0f} KB)")
    print(f"[{NAME[0]}] verified: clips={info['animations']} images={info['images']}")


if __name__ == "__main__":
    main()
