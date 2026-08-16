"""flitter_build -- the Flitter: a small bird that scatters and settles.

WHY.  The Woolt makes the meadow inhabited; the Flitter makes it REACT.  A
grazer that startles is a thing you happen to notice, but a dozen birds going up
at once is the field telling you that you have arrived somewhere.  It is the
cheapest possible sense of consequence and it costs one 0.2 m mesh.

IT IS NOT A COMBATANT and it does not pretend to be.  It has the shared clip
vocabulary so the runtime never has to ask what species it is holding, but its
`attack` clip is a flight loop and its `telegraph` is a crouch before take-off.

WING AXIS.  Every other bone in this project is rolled so local +X is forward
flexion, which is right for limbs that swing fore-and-aft.  A wing does not; it
beats up and down.  Both wing bones are therefore rolled to WORLD UP, which puts
the beat on local X for both of them -- mirrored in sign, because the left wing's
local X ends up along world -Y and the right wing's along +Y.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/flitter_build.py -- \
      --out public/assets/flitter.glb --render docs/qa/flitter
"""
import bpy
import math
import os
import sys

from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_lib as K
import creature_lib as C

NAME = "flitter"

# Three materials for the same reason the Woolt has three: every extra one is
# another skinned submesh, outline shell and shadow draw on something that is
# six pixels tall. The wings used to be a darker tone than the body.
C_SPEC = {
    "coat": ((0.26, 0.29, 0.37), 0.70),
    "trim": ((0.86, 0.62, 0.30), 0.55),      # throat and beak: the only warm note
    "eye":  ((0.06, 0.06, 0.08), 0.30),
}

BODY_Z = 0.115
UP = Vector((0, 0, 1))


def build_rig():
    spec = [
        ("root", Vector((0, 0, 0)), Vector((0, 0, 0.05)), None, False),
        ("body", Vector((0, 0.05, BODY_Z)), Vector((0, -0.05, BODY_Z)), "root", False),
        ("head", Vector((0, -0.05, BODY_Z + 0.01)), Vector((0, -0.11, BODY_Z + 0.05)),
         "body", True),
        ("tail", Vector((0, 0.055, BODY_Z)), Vector((0, 0.145, BODY_Z + 0.015)),
         "body", True),
    ]
    for sx, nm in ((1, "wingL"), (-1, "wingR")):
        sh = Vector((sx * 0.022, -0.005, BODY_Z + 0.020))
        spec.append((nm, sh, sh + Vector((sx * 0.115, 0, 0.010)), "body", False, UP))
    for i, sx in enumerate((1, -1)):
        hip = Vector((sx * 0.020, 0.005, BODY_Z - 0.030))
        spec.append((f"leg{i}", hip, hip + Vector((0, 0, -0.055)), "body", False))
    return K.build_armature("Flitter_Rig", spec)


def build_mesh(M):
    parts = [
        K.blob("flitter_body", (0, 0.005, BODY_Z), (0.040, 0.062, 0.044),
               "body", M["coat"], seg=16, rings=11, squircle=2.2),
        K.blob("flitter_throat", (0, -0.030, BODY_Z - 0.018), (0.030, 0.036, 0.026),
               "body", M["trim"], seg=14, rings=10, squircle=2.2),
        K.blob("flitter_head", (0, -0.068, BODY_Z + 0.030), (0.031, 0.031, 0.030),
               "head", M["coat"], seg=14, rings=10, squircle=2.3),
    ]
    parts += C.eyes("flitter_eye", (0, -0.088, BODY_Z + 0.038), 0.019,
                    (0.010, 0.009, 0.011), "head", M["eye"])

    # beak
    parts.append(K.tube("flitter_beak", [
        {"p": Vector((0, -0.090, BODY_Z + 0.026)), "r": (0.013, 0.011),
         "w": {"head": 1.0}, "n": 2.4},
        {"p": Vector((0, -0.118, BODY_Z + 0.020)), "r": (0.006, 0.005),
         "w": {"head": 1.0}, "n": 2.4},
        {"p": Vector((0, -0.132, BODY_Z + 0.017)), "r": 0.0,
         "w": {"head": 1.0}, "n": 2.4},
    ], seg=8, mat=M["trim"], squircle=2.4, up=(0, 0, 1)))

    # wings: flat, swept back, and wide enough to be the whole silhouette in
    # flight -- a bird reads as wings, not as a body
    for sx, nm in ((1, "wingL"), (-1, "wingR")):
        sh = Vector((sx * 0.022, -0.005, BODY_Z + 0.020))
        parts.append(K.tube(f"flitter_{nm}", K.dome([
            {"p": sh, "r": (0.030, 0.013), "w": {nm: 1.0}, "n": 3.0},
            {"p": sh + Vector((sx * 0.062, 0.012, 0.006)), "r": (0.044, 0.009),
             "w": {nm: 1.0}, "n": 3.0},
            {"p": sh + Vector((sx * 0.112, 0.034, 0.008)), "r": (0.030, 0.006),
             "w": {nm: 1.0}, "n": 3.0},
            {"p": sh + Vector((sx * 0.146, 0.058, 0.006)), "r": (0.012, 0.004),
             "w": {nm: 1.0}, "n": 3.0},
        ], at="both", steps=2, height=0.008),
            seg=10, mat=M["coat"], squircle=3.0, up=(0, 0, 1)))

    # tail: a flat fan
    parts.append(K.tube("flitter_tail", K.dome([
        {"p": Vector((0, 0.058, BODY_Z + 0.004)), "r": (0.026, 0.010),
         "w": {"tail": 1.0}, "n": 3.0},
        {"p": Vector((0, 0.110, BODY_Z + 0.012)), "r": (0.034, 0.007),
         "w": {"tail": 1.0}, "n": 3.0},
        {"p": Vector((0, 0.150, BODY_Z + 0.018)), "r": (0.022, 0.005),
         "w": {"tail": 1.0}, "n": 3.0},
    ], at="both", steps=2, height=0.007),
        seg=10, mat=M["coat"], squircle=3.0, up=(0, 0, 1)))

    for i, sx in enumerate((1, -1)):
        hip = Vector((sx * 0.020, 0.005, BODY_Z - 0.030))
        parts.append(C.leg(f"flitter_leg{i}", hip, hip + Vector((0, 0, -0.050)),
                           f"leg{i}", M["trim"], r=0.008, seg=6))
    return parts


# -------------------------------------------------------------------- clips
#
# `beat` is positive-up on both wings: the left wing's local X came out along
# world -Y and the right's along +Y, so the sign is flipped here once and never
# thought about again.

def wings(beat, sweep=0.0):
    return {"wingL": (beat, sweep, 0.0), "wingR": (-beat, -sweep, 0.0)}


FOLDED = {**wings(-16.0, 0.0), "head": (0, 0, 0), "tail": (0, 0, 0),
          "leg0": (0, 0, 0), "leg1": (0, 0, 0)}


def anim_idle(rig):
    """Perched. Birds are never still for a whole second -- the head snaps."""
    act = K.action(rig, "idle")
    K.key(rig, 0, FOLDED, loc={"body": (0, 0, 0)})
    K.key(rig, 9, {**FOLDED, "head": (0, 0, 22.0)}, loc={"body": (0, 0, 0)})
    K.key(rig, 13, {**FOLDED, "head": (0, 0, 20.0)}, loc={"body": (0, 0, 0)})
    K.key(rig, 26, {**FOLDED, "head": (-8.0, 0, -6.0), "tail": (-9.0, 0, 0)},
          loc={"body": (0.0, 0.0, 0.004)})
    K.key(rig, 38, {**FOLDED, "head": (0, 0, -24.0)}, loc={"body": (0, 0, 0)})
    K.key(rig, 52, FOLDED, loc={"body": (0, 0, 0)})
    K.interp(act)
    return act


def anim_move(rig):
    """Hopping, not walking. It is the only ground gait a small bird has."""
    act = K.action(rig, "move")
    for f, k in [(0, 0.0), (4, 1.0), (8, 0.0), (12, 0.0)]:
        K.key(rig, f, {**FOLDED, **wings(-16.0 + 22.0 * k),
                       "head": (-10.0 * k, 0, 0), "tail": (-14.0 * k, 0, 0),
                       "leg0": (-30.0 * k, 0, 0), "leg1": (-30.0 * k, 0, 0)},
              loc={"body": (0.0, -0.010 * k, 0.030 * k)})
    K.interp(act)
    return act


def anim_telegraph(rig):
    """The crouch before take-off. Two frames of compression is the whole thing;
    without it the bird teleports into the air."""
    act = K.action(rig, "telegraph")
    K.key(rig, 0, FOLDED, loc={"body": (0, 0, 0)})
    K.key(rig, 4, {**FOLDED, **wings(-30.0), "head": (14.0, 0, 0),
                   "leg0": (34.0, 0, 0), "leg1": (34.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.022)})
    K.key(rig, 7, {**FOLDED, **wings(-34.0), "head": (16.0, 0, 0),
                   "leg0": (38.0, 0, 0), "leg1": (38.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.026)})
    K.interp(act)
    return act


def anim_attack(rig):
    """The flight loop. Fast, deep, and asymmetric in timing -- the downbeat is
    the short half, which is what makes a flap look like effort."""
    act = K.action(rig, "attack")
    K.key(rig, 0, {**FOLDED, **wings(64.0, -10.0), "head": (-6.0, 0, 0),
                   "tail": (-16.0, 0, 0), "leg0": (52.0, 0, 0), "leg1": (52.0, 0, 0)},
          loc={"body": (0.0, 0.0, 0.008)})
    K.key(rig, 3, {**FOLDED, **wings(-40.0, 14.0), "head": (4.0, 0, 0),
                   "tail": (-6.0, 0, 0), "leg0": (52.0, 0, 0), "leg1": (52.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.006)})
    K.key(rig, 8, {**FOLDED, **wings(64.0, -10.0), "head": (-6.0, 0, 0),
                   "tail": (-16.0, 0, 0), "leg0": (52.0, 0, 0), "leg1": (52.0, 0, 0)},
          loc={"body": (0.0, 0.0, 0.008)})
    K.interp(act)
    return act


def anim_recover(rig):
    """Landing: wings up and open to brake, then folded."""
    act = K.action(rig, "recover")
    K.key(rig, 0, {**FOLDED, **wings(70.0, -16.0), "tail": (-30.0, 0, 0),
                   "leg0": (26.0, 0, 0), "leg1": (26.0, 0, 0)},
          loc={"body": (0.0, 0.0, 0.014)})
    K.key(rig, 8, {**FOLDED, **wings(24.0, -6.0), "tail": (-12.0, 0, 0),
                   "leg0": (10.0, 0, 0), "leg1": (10.0, 0, 0)},
          loc={"body": (0.0, 0.0, 0.004)})
    K.key(rig, 20, FOLDED, loc={"body": (0, 0, 0)})
    K.interp(act)
    return act


def anim_hurt(rig):
    act = K.action(rig, "hurt")
    K.key(rig, 0, FOLDED, loc={"body": (0, 0, 0)})
    K.key(rig, 3, {**FOLDED, **wings(46.0, 12.0), "head": (18.0, 0, 14.0),
                   "tail": (-20.0, 0, 0)}, loc={"body": (0.0, 0.020, 0.010)})
    K.key(rig, 11, FOLDED, loc={"body": (0, 0, 0)})
    K.interp(act)
    return act


def anim_die(rig):
    act = K.action(rig, "die")
    K.key(rig, 0, FOLDED, loc={"body": (0, 0, 0)}, scale={"body": 1.0})
    K.key(rig, 5, {**FOLDED, **wings(52.0, 16.0), "head": (22.0, 0, 18.0)},
          loc={"body": (0.0, 0.010, 0.020)}, scale={"body": 1.0})
    K.key(rig, 18, {**FOLDED, **wings(-6.0, 30.0), "head": (-30.0, 0, 26.0),
                    "tail": (26.0, 0, 0), "leg0": (60.0, 0, 0), "leg1": (60.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.055)}, scale={"body": (1.0, 1.0, 0.45)})
    K.key(rig, 26, {**FOLDED, **wings(-6.0, 32.0), "head": (-32.0, 0, 28.0),
                    "tail": (28.0, 0, 0), "leg0": (62.0, 0, 0), "leg1": (62.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.062)}, scale={"body": (0.5, 0.5, 0.16)})
    K.interp(act)
    return act


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    out = opt("--out", f"public/assets/{NAME}.glb")
    render_dir = opt("--render")

    K.clear_scene()
    M = C.palette(C_SPEC)
    rig = build_rig()
    C.finish(build_mesh(M), rig, "Flitter")

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    for fn in (anim_idle, anim_move, anim_telegraph, anim_attack,
               anim_recover, anim_hurt, anim_die):
        fn(rig)

    if render_dir:
        import creature_render
        K.rest(rig)
        rig.animation_data.action = None
        for f in creature_render.sheet(render_dir, NAME, rig, height=0.20,
                                       clips=["idle", "telegraph", "attack"]):
            print(f"[render] {f}")

    K.rest(rig)
    path = K.export_glb(out, rig)
    info = K.verify_glb(path, animations=["idle", "move", "telegraph", "attack",
                                          "recover", "hurt", "die"])
    print(f"[{NAME}] exported {path} ({os.path.getsize(path)/1024:.0f} KB)")
    print(f"[{NAME}] verified: clips={info['animations']}")


if __name__ == "__main__":
    main()
