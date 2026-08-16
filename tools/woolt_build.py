"""woolt_build -- the Woolt: a round grazer that lives in the meadow.

WHY AN ANIMAL THAT DOES NOT FIGHT.  A field containing nothing but things that
want to kill you is a shooting gallery, not a place.  The Woolt exists so that
the meadow is inhabited before it is dangerous: it grazes, it looks up when you
get close, and it bolts if you get closer.  Nothing about it is a threat, and
that is the point -- it makes the things that ARE threats mean something.

IT IS ALSO THE READABILITY CONTROL.  Every hostile in this demo is dark-valued
so it separates from the pale meadow.  The Woolt is deliberately the opposite:
pale cream fleece, warm face, no hard silhouette.  If you can tell at a glance
which shapes want to hurt you, the palette is doing its job.

THE SHAPE-TELL IS FEAR, NOT AGGRESSION.  Its fleece puffs when startled -- the
same trick the Bellow uses to threaten, read as panic instead, because it goes
with a flinch backwards rather than a step forwards.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/woolt_build.py -- \
      --out public/assets/woolt.glb --render docs/qa/woolt
"""
import bpy
import math
import os
import sys

from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_lib as K
import creature_lib as C

TAU = math.tau

NAME = "woolt"

# THREE materials, not four. glTF splits a mesh per material and each split is
# its own skinned submesh, its own outline shell and its own shadow draw -- so a
# material on an animal you see at twenty metres costs about three draw calls
# every frame for a detail nobody can resolve. The hooves used to be their own
# darker tone; they are now just the legs.
C_SPEC = {
    "fleece": ((0.90, 0.87, 0.79), 0.90),
    "face":   ((0.38, 0.31, 0.29), 0.70),
    "eye":    ((0.10, 0.09, 0.11), 0.30),
}

BODY_Z = 0.400
N_TUFT = 12
BODY_S = (0.185, 0.245, 0.180)


def build_rig():
    spec = [
        ("root", Vector((0, 0, 0)), Vector((0, 0, 0.14)), None, False),
        ("body", Vector((0, 0.16, BODY_Z)), Vector((0, -0.16, BODY_Z)), "root", False),
        ("neck", Vector((0, -0.16, BODY_Z)), Vector((0, -0.26, BODY_Z + 0.10)),
         "body", True),
        ("head", Vector((0, -0.26, BODY_Z + 0.10)), Vector((0, -0.40, BODY_Z + 0.06)),
         "neck", True),
        ("tail", Vector((0, 0.20, BODY_Z + 0.02)), Vector((0, 0.30, BODY_Z - 0.04)),
         "body", True),
    ]
    for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (1, -1), (-1, -1)]):
        hip = Vector((sx * 0.120, sy * 0.140, BODY_Z - 0.10))
        spec.append((f"leg{i}", hip, hip + Vector((0, 0, -0.19)), "body", False))
    # the fleece rides on its own bone so "puff" is one scale key, not a reshape
    spec.append(("fleece", Vector((0, 0, BODY_Z)), Vector((0, -0.10, BODY_Z)),
                 "body", False))
    return K.build_armature("Woolt_Rig", spec)


def build_mesh(M):
    parts = [
        K.blob("woolt_body", (0, 0, BODY_Z), BODY_S,
               "fleece", M["fleece"], seg=22, rings=14, squircle=2.1),
        K.blob("woolt_neck", (0, -0.215, BODY_Z + 0.055), (0.078, 0.085, 0.080),
               "neck", M["fleece"], seg=16, rings=11, squircle=2.2),
        K.blob("woolt_head", (0, -0.320, BODY_Z + 0.085), (0.082, 0.098, 0.079),
               "head", M["face"], seg=18, rings=12, squircle=2.5),
        # a cap of fleece over the crown, so the face reads as a face and not a mask
        K.blob("woolt_crown", (0, -0.280, BODY_Z + 0.135), (0.086, 0.078, 0.055),
               "head", M["fleece"], seg=16, rings=10, squircle=2.4),
    ]
    parts += C.eyes("woolt_eye", (0, -0.386, BODY_Z + 0.098), 0.044,
                    (0.019, 0.017, 0.021), "head", M["eye"])

    # ears: flat lobes that droop. They are the only asymmetric-reading feature
    # at distance, which is what stops a round pale animal being a rock.
    for sx in (-1, 1):
        base = Vector((sx * 0.078, -0.286, BODY_Z + 0.118))
        parts.append(K.tube(f"woolt_ear{sx}", K.dome([
            {"p": base, "r": (0.020, 0.014), "w": {"head": 1.0}, "n": 2.6},
            {"p": base + Vector((sx * 0.052, -0.008, -0.020)), "r": (0.034, 0.013),
             "w": {"head": 1.0}, "n": 2.6},
            {"p": base + Vector((sx * 0.088, -0.014, -0.062)), "r": (0.020, 0.009),
             "w": {"head": 1.0}, "n": 2.6},
        ], at="both", steps=2, height=0.012),
            seg=10, mat=M["face"], squircle=2.6, up=(0, 0, 1)))

    # tufts: the fleece is a smooth blob, which reads as a pebble at any
    # distance. These break the outline into something woolly.
    #
    # They have to sit ON THE BODY, which means parametrising the ellipsoid --
    # the first pass placed them on a flat horizontal ring and they came out as
    # a halo of discs floating beside the animal. Two staggered latitudes, sunk
    # to 88% of the radius so each one is a bump rather than a stuck-on ball.
    rx, ry, rz = BODY_S
    for i in range(N_TUFT):
        th = TAU * i / N_TUFT + 0.35
        phi = 0.22 if i % 2 else 0.78          # staggered rows
        k = 0.88
        c = Vector((rx * k * math.cos(phi) * math.sin(th),
                    ry * k * math.cos(phi) * math.cos(th),
                    BODY_Z + rz * k * math.sin(phi)))
        parts.append(K.blob(f"woolt_tuft{i}", c, (0.070, 0.070, 0.062),
                            "fleece", M["fleece"], seg=10, rings=8, squircle=2.0))

    parts.append(K.blob("woolt_tail", (0, 0.255, BODY_Z - 0.010),
                        (0.058, 0.064, 0.058), "tail", M["fleece"],
                        seg=12, rings=9, squircle=2.1))

    for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (1, -1), (-1, -1)]):
        hip = Vector((sx * 0.120, sy * 0.140, BODY_Z - 0.10))
        parts.append(C.leg(f"woolt_leg{i}", hip, hip + Vector((0, 0, -0.175)),
                           f"leg{i}", M["face"], r=0.044))
        parts.append(K.blob(f"woolt_hoof{i}", hip + Vector((0, 0, -0.185)),
                            (0.048, 0.052, 0.032), f"leg{i}", M["face"],
                            seg=10, rings=8, squircle=2.6))
    return parts


# -------------------------------------------------------------------- clips

def legs(swing, splay=0.0):
    """Diagonal pairs, the way a four-legged trot actually works."""
    out = {}
    for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (1, -1), (-1, -1)]):
        diag = 1 if sx * sy > 0 else -1
        out[f"leg{i}"] = (swing * diag, 0.0, splay * sx)
    return out


REST = {**legs(0.0), "neck": (0, 0, 0), "head": (0, 0, 0), "tail": (0, 0, 0)}


def anim_idle(rig):
    """Breathing, an ear-flick's worth of head motion, and a tail that moves.
    A stationary animal that is perfectly still reads as a prop."""
    act = K.action(rig, "idle")
    for f, k in [(0, 0.0), (22, 1.0), (44, 0.0), (66, -1.0), (88, 0.0)]:
        K.key(rig, f, {**REST,
                       "neck": (-3.0 * k, 0, 1.5 * k),
                       "head": (2.0 * k, 0, -4.0 * k),
                       "tail": (0, 0, 16.0 * k)},
              loc={"body": (0.0, 0.0, 0.008 * k)},
              scale={"fleece": 1.0 + 0.020 * k})
    K.interp(act)
    return act


def anim_move(rig):
    """A slow amble -- it is walking between mouthfuls, not going anywhere."""
    act = K.action(rig, "move")
    for f, ph in [(0, 1), (9, 0), (18, -1), (27, 0), (36, 1)]:
        K.key(rig, f, {**legs(26.0 * ph, 3.0),
                       "neck": (4.0, 0, 2.0 * ph),
                       "head": (-2.0, 0, -3.0 * ph),
                       "tail": (0, 0, 10.0 * ph)},
              loc={"body": (0.0, 0.0, 0.014 * abs(ph))},
              scale={"fleece": 1.0})
    K.interp(act)
    return act


def anim_graze(rig):
    """Head down, chew, glance up. This is what it does most of the time, so it
    is the clip that decides whether the meadow feels inhabited."""
    act = K.action(rig, "graze")
    down = {**REST, "neck": (58.0, 0, 0), "head": (28.0, 0, 0)}
    K.key(rig, 0, down, loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    for i, f in enumerate((10, 18, 26, 34)):          # chewing
        s = 1 if i % 2 else -1
        K.key(rig, f, {**down, "head": (28.0 + 5.0 * s, 0, 3.0 * s)},
              loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.key(rig, 46, down, loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    # the look-up: brief, and the reason a grazing herd never feels like statues
    K.key(rig, 58, {**REST, "neck": (-14.0, 0, 6.0), "head": (6.0, 0, -8.0)},
          loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.key(rig, 70, {**REST, "neck": (-12.0, 0, -4.0), "head": (4.0, 0, 6.0)},
          loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.key(rig, 84, down, loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.interp(act)
    return act


def anim_telegraph(rig):
    """STARTLE. The same fleece-puff the Bellow uses to threaten, read as panic:
    it goes with a flinch BACKWARDS and a head thrown up, not a step in."""
    act = K.action(rig, "telegraph")
    K.key(rig, 0, REST, loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.key(rig, 4, {**legs(-16.0, 9.0), "neck": (-34.0, 0, 0), "head": (16.0, 0, 0),
                   "tail": (-22.0, 0, 0)},
          loc={"body": (0.0, 0.075, 0.030)}, scale={"fleece": 1.30})
    K.key(rig, 12, {**legs(-8.0, 12.0), "neck": (-26.0, 0, 4.0), "head": (12.0, 0, 0),
                    "tail": (-16.0, 0, 0)},
          loc={"body": (0.0, 0.050, 0.014)}, scale={"fleece": 1.24})
    K.interp(act)
    return act


def anim_attack(rig):
    """It has no attack. It runs. The clip exists so the runtime never has to
    ask which species it is holding -- the vocabulary is the same for everyone."""
    act = K.action(rig, "attack")
    for f, ph in [(0, 1), (5, -1), (10, 1)]:
        K.key(rig, f, {**legs(46.0 * ph, 6.0), "neck": (-18.0, 0, 0),
                       "head": (10.0, 0, 0), "tail": (-24.0, 0, 0)},
              loc={"body": (0.0, 0.0, 0.030)}, scale={"fleece": 1.14})
    K.interp(act)
    return act


def anim_recover(rig):
    """Slowing down and settling: fleece deflates, head comes back to level."""
    act = K.action(rig, "recover")
    K.key(rig, 0, {**legs(30.0, 5.0), "neck": (-18.0, 0, 0), "head": (10.0, 0, 0)},
          loc={"body": (0.0, 0.0, 0.024)}, scale={"fleece": 1.14})
    K.key(rig, 14, {**legs(-6.0, 4.0), "neck": (-8.0, 0, 5.0), "head": (4.0, 0, -6.0)},
          loc={"body": (0.0, 0.010, 0.0)}, scale={"fleece": 1.05})
    K.key(rig, 30, REST, loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.interp(act)
    return act


def anim_hurt(rig):
    act = K.action(rig, "hurt")
    K.key(rig, 0, REST, loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.key(rig, 3, {**legs(-20.0, 12.0), "neck": (-30.0, 0, 10.0),
                   "head": (18.0, 0, -8.0)},
          loc={"body": (0.0, 0.060, 0.018)}, scale={"fleece": 1.28})
    K.key(rig, 13, REST, loc={"body": (0, 0, 0)}, scale={"fleece": 1.06})
    K.interp(act)
    return act


def anim_die(rig):
    act = K.action(rig, "die")
    K.key(rig, 0, REST, loc={"body": (0, 0, 0)}, scale={"fleece": 1.0})
    K.key(rig, 6, {**legs(-24.0, 20.0), "neck": (-36.0, 0, 14.0),
                   "head": (20.0, 0, -10.0)},
          loc={"body": (0.0, 0.030, 0.055)}, scale={"fleece": 1.22})
    K.key(rig, 22, {**legs(48.0, 34.0), "neck": (40.0, 0, 20.0),
                    "head": (-24.0, 0, -14.0), "tail": (30.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.16)}, scale={"fleece": (1.10, 1.10, 0.34)})
    K.key(rig, 32, {**legs(52.0, 36.0), "neck": (44.0, 0, 22.0),
                    "head": (-26.0, 0, -16.0), "tail": (32.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.20)}, scale={"fleece": (0.40, 0.40, 0.12)})
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
    C.finish(build_mesh(M), rig, "Woolt")

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    for fn in (anim_idle, anim_move, anim_graze, anim_telegraph, anim_attack,
               anim_recover, anim_hurt, anim_die):
        fn(rig)

    if render_dir:
        import creature_render
        K.rest(rig)
        rig.animation_data.action = None
        for f in creature_render.sheet(render_dir, NAME, rig, height=0.72,
                                       clips=["idle", "graze", "telegraph", "die"]):
            print(f"[render] {f}")

    K.rest(rig)
    path = K.export_glb(out, rig)
    info = K.verify_glb(path, animations=["idle", "move", "graze", "telegraph",
                                          "attack", "recover", "hurt", "die"])
    print(f"[{NAME}] exported {path} ({os.path.getsize(path)/1024:.0f} KB)")
    print(f"[{NAME}] verified: clips={info['animations']}")


if __name__ == "__main__":
    main()
