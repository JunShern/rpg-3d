"""creature_render -- EEVEE preview sheets for creatures.

Separate from the character sheets because a creature is judged on different
things: not proportion and face, but whether its SILHOUETTE reads, and whether
the telegraph pose is distinguishable from the resting one at a glance.  So the
sheet puts rest and telegraph side by side, and shoots low -- roughly at the
height a player's camera actually sees a knee-high enemy from.
"""
import math
import os

import bpy
from mathutils import Vector

import kh_lib as K


def _scene(bg=(0.30, 0.36, 0.46)):
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_EEVEE'
    scn.render.resolution_x = 720
    scn.render.resolution_y = 600
    scn.render.film_transparent = False
    if scn.world is None:
        scn.world = bpy.data.worlds.new("W")
    scn.world.use_nodes = True
    b = scn.world.node_tree.nodes.get("Background")
    b.inputs[0].default_value = (*bg, 1.0)
    b.inputs[1].default_value = 1.0

    if "Sun" not in bpy.data.objects:
        sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN'))
        sun.data.energy = 3.4
        sun.data.angle = math.radians(16)
        sun.rotation_euler = (math.radians(54), 0, math.radians(40))
        bpy.context.collection.objects.link(sun)
        fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", 'AREA'))
        fill.data.energy = 60
        fill.data.size = 3.0
        fill.location = (-2.0, -1.8, 1.4)
        fill.rotation_euler = (math.radians(68), 0, math.radians(-50))
        bpy.context.collection.objects.link(fill)

        g = bpy.data.meshes.new("Ground")
        g.from_pydata([(-4, -4, 0), (4, -4, 0), (4, 4, 0), (-4, 4, 0)], [],
                      [(0, 1, 2, 3)])
        g.update()
        go = bpy.data.objects.new("Ground", g)
        g.materials.append(K.material("ground", (0.40, 0.44, 0.42)))
        bpy.context.collection.objects.link(go)

    cam = scn.camera
    if cam is None:
        cd = bpy.data.cameras.new("Cam")
        cd.lens = 58
        cam = bpy.data.objects.new("Cam", cd)
        bpy.context.collection.objects.link(cam)
        scn.camera = cam
    return scn, cam


def sheet(prefix, name, rig, height=0.5, clips=()):
    """Turnaround plus one frame from each interesting clip."""
    scn, cam = _scene()
    os.makedirs(prefix, exist_ok=True)
    out = []

    # framed so the creature fills most of the frame: these sheets exist to
    # judge a silhouette, and a silhouette cannot be judged at postage size
    aim = Vector((0, 0, height * 0.45))
    dist = max(0.30, height * 0.80)

    for label, az, elev in (("front", 0.0, 0.30), ("three-quarter", 40.0, 0.34),
                            ("side", 90.0, 0.30), ("low", 25.0, 0.14)):
        a = math.radians(az)
        cam.location = aim + Vector((math.sin(a) * dist, -math.cos(a) * dist,
                                     height * elev * 1.6))
        cam.rotation_euler = (aim - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(prefix, f"{name}_{label}.png")
        bpy.ops.render.render(write_still=True)
        out.append(scn.render.filepath)

    # pose sheet: the telegraph has to be obviously different from the rest pose
    a = math.radians(35.0)
    cam.location = aim + Vector((math.sin(a) * dist, -math.cos(a) * dist,
                                 height * 0.55))
    cam.rotation_euler = (aim - cam.location).to_track_quat('-Z', 'Y').to_euler()
    for clip in clips:
        act = bpy.data.actions.get(clip)
        if act is None:
            continue
        rig.animation_data_create() if rig.animation_data is None else None
        rig.animation_data.action = act
        if hasattr(rig.animation_data, "action_slot") and act.slots:
            rig.animation_data.action_slot = act.slots[0]
        end = int(act.frame_range[1])
        scn.frame_set(end)
        scn.render.filepath = os.path.join(prefix, f"{name}_pose_{clip}.png")
        bpy.ops.render.render(write_still=True)
        out.append(scn.render.filepath)

    rig.animation_data.action = None
    K.rest(rig)
    return out
