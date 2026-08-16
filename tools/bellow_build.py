"""bellow_build -- the Bellow: a slow brute that inflates before it slams.

ROLE.  The Nettle punishes standing still and the Curler punishes standing in a
line; the Bellow punishes GREED.  Its wind-up is long enough to walk out of, and
its damage is high enough that trading with it is never worth it.  It is the one
enemy the finisher is for -- it has the health to survive a full chain, so you
have to commit to the whole thing rather than poking.

THE TELL IS THE SILHOUETTE, and here it is literally volume: the body SWELLS,
half again its resting size, over the whole wind-up.  That is a bone-scale key
and nothing else, and it is legible from any angle, at any distance, even when
the creature is entirely in shadow.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/bellow_build.py -- \
      --out public/assets/bellow.glb --render docs/qa/bellow
"""
import bpy
import math
import os
import sys

from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kh_lib as K
import creature_lib as C

NAME = "bellow"

C_SPEC = {
    "hide":  ((0.30, 0.26, 0.34), 0.80),
    "sack":  ((0.52, 0.34, 0.40), 0.70),
    "horn":  ((0.80, 0.74, 0.60), 0.50),
    "eye":   ((1.00, 0.44, 0.26), 0.30, 3.2),
}

BODY_Z = 0.62


def build_rig():
    spec = [
        ("root", Vector((0, 0, 0)), Vector((0, 0, 0.18)), None, False),
        ("body", Vector((0, 0.04, 0.30)), Vector((0, 0.0, BODY_Z)), "root", False),
        ("head", Vector((0, -0.06, BODY_Z + 0.24)),
         Vector((0, -0.26, BODY_Z + 0.30)), "body", False),
    ]
    for s, sx in (("L", 1), ("R", -1)):
        sh = Vector((sx * 0.30, 0.0, BODY_Z + 0.14))
        el = Vector((sx * 0.46, -0.05, BODY_Z - 0.20))
        wr = Vector((sx * 0.52, -0.10, BODY_Z - 0.54))
        spec += [
            (f"arm.{s}", sh, el, "body", False),
            (f"fore.{s}", el, wr, f"arm.{s}", True),
        ]
        hip = Vector((sx * 0.19, 0.0, 0.30))
        spec.append((f"leg.{s}", hip, hip + Vector((sx * 0.05, 0, -0.30)),
                     "root", False))
    return K.build_armature("Bellow_Rig", spec)


def build_mesh(M):
    parts = [
        # the sack: this is the part that inflates, so it is most of the mass
        K.blob("bellow_sack", (0, 0.02, BODY_Z), (0.40, 0.36, 0.36),
               "body", M["sack"], seg=24, rings=15, squircle=2.3),
        K.blob("bellow_yoke", (0, 0.0, BODY_Z + 0.20), (0.30, 0.26, 0.16),
               "body", M["hide"], seg=20, rings=12, squircle=2.5),
        K.blob("bellow_head", (0, -0.20, BODY_Z + 0.28), (0.19, 0.20, 0.16),
               "head", M["hide"], seg=18, rings=12, squircle=2.4),
    ]
    parts += C.eyes("bellow_eye", (0, -0.345, BODY_Z + 0.30), 0.082,
                    (0.045, 0.038, 0.036), "head", M["eye"])
    for sx in (-1, 1):
        parts.append(C.spine(f"bellow_horn{sx}",
                             (sx * 0.115, -0.14, BODY_Z + 0.38),
                             (sx * 0.42, -0.30, 0.86), 0.24, 0.048,
                             "head", M["horn"], curve=0.10))

    for s, sx in (("L", 1), ("R", -1)):
        sh = Vector((sx * 0.30, 0.0, BODY_Z + 0.14))
        el = Vector((sx * 0.46, -0.05, BODY_Z - 0.20))
        wr = Vector((sx * 0.52, -0.10, BODY_Z - 0.54))
        parts.append(K.tube(f"bellow_arm{s}", K.dome([
            {"p": sh, "r": (0.115, 0.115), "w": {f"arm.{s}": 1.0}, "n": 2.5},
            {"p": sh.lerp(el, 0.55), "r": (0.098, 0.098),
             "w": {f"arm.{s}": 1.0}, "n": 2.5},
            {"p": el, "r": (0.088, 0.088), "w": {f"arm.{s}": 0.5, f"fore.{s}": 0.5},
             "n": 2.5},
            {"p": el.lerp(wr, 0.55), "r": (0.100, 0.100),
             "w": {f"fore.{s}": 1.0}, "n": 2.5},
            {"p": wr, "r": (0.125, 0.125), "w": {f"fore.{s}": 1.0}, "n": 2.5},
        ], at="both", steps=3, height=0.10), seg=14, mat=M["hide"], squircle=2.5))

        hip = Vector((sx * 0.19, 0.0, 0.30))
        parts.append(C.leg(f"bellow_leg{s}", hip,
                           hip + Vector((sx * 0.05, 0, -0.30)),
                           f"leg.{s}", M["hide"], r=0.105, seg=12))
    return parts


# -------------------------------------------------------------------- clips

def arms(up, out_=0.0, bend=0.0):
    p = {}
    for s, sgn in (("L", 1), ("R", -1)):
        p[f"arm.{s}"] = (up, 0.0, sgn * out_)
        p[f"fore.{s}"] = (bend, 0.0, 0.0)
    return p


REST = {**arms(6.0, 8.0, 18.0), "body": (2.0, 0, 0), "head": (0.0, 0, 0),
        "leg.L": (0, 0, 2.0), "leg.R": (0, 0, -2.0)}


def anim_idle(rig):
    """It BREATHES, visibly. A creature whose whole identity is inflating should
    never be completely still, or the wind-up has nothing to be a change from."""
    act = K.action(rig, "idle")
    for f, k in [(0, 0.0), (18, 1.0), (36, 0.0), (54, 0.6), (72, 0.0)]:
        K.key(rig, f, {**REST, "body": (2.0 - 2.0 * k, 0, 0),
                       **arms(6.0 - 4.0 * k, 8.0 + 3.0 * k, 18.0 - 4.0 * k),
                       "head": (-2.0 * k, 0, 0)},
              loc={"body": (0.0, 0.0, 0.020 * k)},
              scale={"body": (1.0 + 0.045 * k, 1.0 + 0.045 * k, 1.0 + 0.03 * k)})
    K.interp(act)
    return act


def anim_move(rig):
    act = K.action(rig, "move")
    for f, ph in [(0, 1), (8, 0), (16, -1), (24, 0), (32, 1)]:
        K.key(rig, f, {**REST, "body": (4.0, 3.0 * ph, 0.0),
                       **arms(4.0, 10.0, 22.0),
                       "leg.L": (26.0 * ph, 0, 3.0), "leg.R": (-26.0 * ph, 0, -3.0),
                       "head": (2.0, -4.0 * ph, 0)},
              loc={"body": (0.0, 0.0, 0.030 * abs(ph))},
              scale={"body": 1.0})
    K.interp(act)
    return act


def anim_telegraph(rig):
    """INFLATE. The whole tell is one scale curve, and it is slow on purpose --
    long enough to walk out of, which is the entire point of this enemy."""
    act = K.action(rig, "telegraph")
    K.key(rig, 0, {**REST}, loc={"body": (0, 0, 0)}, scale={"body": 1.0})
    K.key(rig, 8, {**REST, **arms(-40.0, 20.0, 26.0), "body": (-10.0, 0, 0),
                   "head": (-14.0, 0, 0)},
          loc={"body": (0.0, 0.02, 0.03)}, scale={"body": 1.16})
    K.key(rig, 18, {**REST, **arms(-104.0, 26.0, 30.0), "body": (-18.0, 0, 0),
                    "head": (-24.0, 0, 0), "leg.L": (-8.0, 0, 6.0),
                    "leg.R": (-8.0, 0, -6.0)},
           loc={"body": (0.0, 0.03, 0.05)}, scale={"body": (1.36, 1.36, 1.30)})
    K.interp(act)
    return act


def anim_attack(rig):
    """SLAM. Everything the wind-up stored comes out in three frames, and the
    body deflates as it lands -- the volume is the payload."""
    act = K.action(rig, "attack")
    K.key(rig, 0, {**REST, **arms(-104.0, 26.0, 30.0), "body": (-18.0, 0, 0),
                   "head": (-24.0, 0, 0)},
          loc={"body": (0.0, 0.03, 0.05)}, scale={"body": (1.36, 1.36, 1.30)})
    K.key(rig, 3, {**REST, **arms(84.0, 4.0, 6.0), "body": (30.0, 0, 0),
                   "head": (26.0, 0, 0), "leg.L": (14.0, 0, 3.0),
                   "leg.R": (14.0, 0, -3.0)},
          loc={"body": (0.0, -0.06, -0.10)}, scale={"body": (1.06, 1.06, 0.86)})
    K.key(rig, 9, {**REST, **arms(52.0, 6.0, 24.0), "body": (18.0, 0, 0),
                   "head": (10.0, 0, 0)},
          loc={"body": (0.0, -0.02, -0.04)}, scale={"body": (0.94, 0.94, 0.96)})
    K.interp(act)
    return act


def anim_recover(rig):
    act = K.action(rig, "recover")
    K.key(rig, 0, {**REST, **arms(52.0, 6.0, 24.0), "body": (18.0, 0, 0)},
          loc={"body": (0.0, -0.02, -0.04)}, scale={"body": (0.94, 0.94, 0.96)})
    K.key(rig, 14, {**REST, **arms(20.0, 10.0, 34.0), "body": (14.0, 0, 0),
                    "head": (-6.0, 0, 0)},
           loc={"body": (0.0, 0.0, -0.07)}, scale={"body": (0.90, 0.90, 0.94)})
    K.key(rig, 34, {**REST}, loc={"body": (0, 0, 0)}, scale={"body": 1.0})
    K.interp(act)
    return act


def anim_hurt(rig):
    act = K.action(rig, "hurt")
    K.key(rig, 0, {**REST}, loc={"body": (0, 0, 0)}, scale={"body": 1.0})
    K.key(rig, 3, {**REST, **arms(-16.0, 22.0, 30.0), "body": (-14.0, 0, 0),
                   "head": (16.0, 0, 0)},
          loc={"body": (0.0, 0.05, 0.0)}, scale={"body": (0.92, 0.92, 1.06)})
    K.key(rig, 14, {**REST}, loc={"body": (0, 0, 0)}, scale={"body": 1.0})
    K.interp(act)
    return act


def anim_die(rig):
    """It DEFLATES. For a creature made of held air there is only one right
    death, and a fade-out is not it."""
    act = K.action(rig, "die")
    K.key(rig, 0, {**REST}, loc={"body": (0, 0, 0)}, scale={"body": 1.0})
    K.key(rig, 4, {**REST, **arms(-30.0, 26.0, 20.0), "body": (-20.0, 0, 0),
                   "head": (-18.0, 0, 0)},
          loc={"body": (0.0, 0.02, 0.06)}, scale={"body": (1.22, 1.22, 1.18)})
    K.key(rig, 16, {**REST, **arms(60.0, 30.0, 40.0), "body": (26.0, 0, 0),
                    "head": (30.0, 0, 0), "leg.L": (40.0, 0, 12.0),
                    "leg.R": (40.0, 0, -12.0)},
           loc={"body": (0.0, 0.0, -0.24)}, scale={"body": (0.72, 0.72, 0.34)})
    K.key(rig, 32, {**REST, **arms(66.0, 34.0, 44.0), "body": (28.0, 0, 0),
                    "leg.L": (44.0, 0, 14.0), "leg.R": (44.0, 0, -14.0)},
           loc={"body": (0.0, 0.0, -0.30)}, scale={"body": (0.26, 0.26, 0.10)})
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
    C.finish(build_mesh(M), rig, "Bellow")

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    for fn in (anim_idle, anim_move, anim_telegraph, anim_attack,
               anim_recover, anim_hurt, anim_die):
        fn(rig)

    if render_dir:
        import creature_render
        K.rest(rig)
        rig.animation_data.action = None
        for f in creature_render.sheet(render_dir, NAME, rig, height=1.35,
                                       clips=["idle", "telegraph", "attack", "die"]):
            print(f"[render] {f}")

    K.rest(rig)
    path = K.export_glb(out, rig)
    info = K.verify_glb(path, animations=["idle", "move", "telegraph", "attack",
                                          "recover", "hurt", "die"])
    print(f"[{NAME}] exported {path} ({os.path.getsize(path)/1024:.0f} KB)")
    print(f"[{NAME}] verified: clips={info['animations']}")


if __name__ == "__main__":
    main()
