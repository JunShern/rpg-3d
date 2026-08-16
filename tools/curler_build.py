"""curler_build -- the Curler: an armoured charger that curls to roll.

ROLE.  Where the Nettle punishes standing still, the Curler punishes standing in
a LINE.  It commits to a straight charge and cannot correct mid-roll, so the
answer is to step aside -- and it is helpless for a beat when it unfurls, which
is the window the combo is for.

THE TELL IS THE SILHOUETTE.  Five armour plates lie flat along its back at rest
and it reads as a long, low, ridged thing.  To charge, the plates wrap forward
and it becomes a BALL -- a completely different shape, at a completely different
height, unmistakable across a field.  Then it rolls.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/curler_build.py -- \
      --out public/assets/curler.glb --render docs/qa/curler
"""
import bpy
import math
import os
import sys

from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_lib as K
import creature_lib as C

NAME = "curler"

# VALUE IS THE WHOLE GAME HERE.  The meadow is a pale, desaturated green, so a
# mid-value creature standing on it has no silhouette at all -- the first pass
# read as a smudge from four metres away.  The armour is therefore the DARKEST
# thing in frame and the soft parts are a warm clay that reads as "not armoured",
# which is also the honest tell: what you can see is what you can hit.
# ROLE IS A COLOUR. All three hostiles are dark so they separate from the pale
# meadow -- but "dark" alone told you a shape was a threat and nothing about
# WHICH threat, and the three of them ask completely different questions. So
# each one owns an accent: bone for the swarmer, CYAN for the charger, ember for
# the brute. The charger is the cold one, blue-slate rather than violet, with
# eyes you can pick out across a field.
C_SPEC = {
    "shell": ((0.15, 0.20, 0.28), 0.55),
    "plate": ((0.24, 0.34, 0.46), 0.35),
    "flesh": ((0.46, 0.33, 0.32), 0.80),
    "eye":   ((0.32, 0.94, 1.00), 0.30, 3.6),
}

N_PLATES = 5
N_LEGS = 6
BODY_Z = 0.200


def _plate_y(i):
    """Plates run front to back along the spine."""
    return 0.235 - i * 0.115


def build_rig():
    spec = [
        ("root", Vector((0, 0, 0)), Vector((0, 0, 0.10)), None, False),
        ("body", Vector((0, 0.10, BODY_Z)), Vector((0, -0.12, BODY_Z)), "root", False),
        ("head", Vector((0, -0.12, BODY_Z)), Vector((0, -0.30, 0.15)), "body", True),
    ]
    # one bone per plate: the curl is five rotations and nothing else
    for i in range(N_PLATES):
        y = _plate_y(i)
        spec.append((f"plate{i}", Vector((0, y, BODY_Z + 0.06)),
                     Vector((0, y - 0.06, BODY_Z + 0.19)), "body", False))
    for i in range(N_LEGS):
        sx = -1 if i % 2 else 1
        y = 0.16 - (i // 2) * 0.16
        hip = Vector((sx * 0.115, y, BODY_Z - 0.03))
        spec.append((f"leg{i}", hip, hip + Vector((sx * 0.06, 0, -0.155)),
                     "body", False))
    return K.build_armature("Curler_Rig", spec)


def build_mesh(M):
    parts = [
        # not a pancake: the first pass was 0.25 m tall over a 0.57 m length and
        # read as a floor tile. Shorter and deeper gives it a profile.
        K.blob("curler_body", (0, 0.0, BODY_Z), (0.170, 0.250, 0.168),
               "body", M["flesh"], seg=20, rings=13, squircle=2.5),
        K.blob("curler_head", (0, -0.235, 0.180), (0.115, 0.105, 0.100),
               "head", M["shell"], seg=18, rings=12, squircle=2.4),
    ]
    parts += C.eyes("curler_eye", (0, -0.310, 0.200), 0.052,
                    (0.030, 0.026, 0.024), "head", M["eye"])

    for i in range(N_PLATES):
        y = _plate_y(i)
        w = 0.196 - abs(i - 2) * 0.018          # widest in the middle
        parts.append(K.tube(f"curler_plate{i}", K.dome([
            {"p": Vector((0, y + 0.054, BODY_Z + 0.066)), "r": (w, 0.062),
             "w": {f"plate{i}": 1.0}, "n": 3.0},
            {"p": Vector((0, y - 0.010, BODY_Z + 0.108)), "r": (w * 1.02, 0.058),
             "w": {f"plate{i}": 1.0}, "n": 3.0},
            {"p": Vector((0, y - 0.064, BODY_Z + 0.074)), "r": (w * 0.9, 0.048),
             "w": {f"plate{i}": 1.0}, "n": 3.0},
        ], at="both", steps=2, height=0.034),
            seg=14, mat=M["plate"], squircle=3.0, up=(0, 1, 0)))

    for i in range(N_LEGS):
        sx = -1 if i % 2 else 1
        y = 0.16 - (i // 2) * 0.16
        hip = Vector((sx * 0.115, y, BODY_Z - 0.03))
        parts.append(C.leg(f"curler_leg{i}", hip,
                           hip + Vector((sx * 0.06, 0, -0.155)),
                           f"leg{i}", M["flesh"], r=0.028))
    return parts


# -------------------------------------------------------------------- clips

def plates(pitch, prog=0.0):
    """`prog` ramps the rotation along the body so the shell WRAPS rather than
    hinging as one slab -- that progression is what makes it read as curling."""
    return {f"plate{i}": (pitch + prog * i, 0.0, 0.0) for i in range(N_PLATES)}


def legs(swing, splay=0.0, tuck=0.0):
    out = {}
    for i in range(N_LEGS):
        s = 1 if i % 2 else -1
        row = i // 2 - 1
        out[f"leg{i}"] = (swing * row + tuck, 0.0, splay * s)
    return out


FLAT = {**plates(0.0), **legs(0.0)}
BALL = {**plates(-74.0, -17.0), **legs(0.0, 0.0, 86.0), "head": (94.0, 0, 0)}


def anim_idle(rig):
    act = K.action(rig, "idle")
    for f, k in [(0, 0.0), (16, 1.0), (32, 0.0), (48, -0.8), (64, 0.0)]:
        K.key(rig, f, {**FLAT, **plates(2.5 * k), "body": (1.5 * k, 0, 0),
                       "head": (-3.0 * k, 0, 0)},
              loc={"body": (0.0, 0.0, 0.010 * k)})
    K.interp(act)
    return act


def anim_move(rig):
    """Six legs in two alternating tripods -- the gait that reads as 'insect'."""
    act = K.action(rig, "move")
    for f, ph in [(0, 1), (5, 0), (10, -1), (15, 0), (20, 1)]:
        pose = {**plates(3.0), "body": (4.0, 0.0, 2.0 * ph)}
        for i in range(N_LEGS):
            tri = 1 if (i % 2) == ((i // 2) % 2) else -1
            pose[f"leg{i}"] = (30.0 * ph * tri, 0.0, 8.0 * (1 if i % 2 else -1))
        K.key(rig, f, pose, loc={"body": (0.0, 0.0, 0.012 * abs(ph))})
    K.interp(act)
    return act


def anim_telegraph(rig):
    """Rear up, then WRAP into a ball. Held at the end so the runtime can hold
    the wound-up shape for exactly as long as the tell should last."""
    act = K.action(rig, "telegraph")
    K.key(rig, 0, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)})
    K.key(rig, 6, {**plates(-30.0, -4.0), **legs(-18.0, 14.0),
                   "body": (-24.0, 0, 0), "head": (26.0, 0, 0)},
          loc={"body": (0.0, 0.045, 0.030)})
    K.key(rig, 12, {**BALL, "body": (-6.0, 0, 0)},
          loc={"body": (0.0, 0.010, -0.020)}, scale={"body": (1.12, 0.72, 1.30)})
    K.interp(act)
    return act


def anim_attack(rig):
    """Stays balled: the ROLL is runtime translation and spin, not a clip. A
    rolling ball that also cycles a walk animation looks like two ideas."""
    act = K.action(rig, "attack")
    for f in (0, 6, 14):
        K.key(rig, f, {**BALL, "body": (-6.0, 0, 0)},
              loc={"body": (0.0, 0.010, -0.020)}, scale={"body": (1.12, 0.72, 1.30)})
    K.interp(act)
    return act


def anim_recover(rig):
    """UNFURL: the punish window, and it is deliberately slow and floppy."""
    act = K.action(rig, "recover")
    K.key(rig, 0, {**BALL, "body": (-6.0, 0, 0)},
          loc={"body": (0.0, 0.010, -0.020)}, scale={"body": (1.12, 0.72, 1.30)})
    K.key(rig, 7, {**plates(24.0, 6.0), **legs(-14.0, 26.0, -20.0),
                   "body": (22.0, 0, 0), "head": (-30.0, 0, 0)},
          loc={"body": (0.0, -0.020, -0.055)}, scale={"body": (1.06, 1.06, 0.88)})
    K.key(rig, 16, {**plates(10.0, 2.0), **legs(0.0, 16.0),
                    "body": (10.0, 0, 0), "head": (-14.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.020)}, scale={"body": 1.0})
    K.key(rig, 30, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)},
          scale={"body": 1.0})
    K.interp(act)
    return act


def anim_hurt(rig):
    act = K.action(rig, "hurt")
    K.key(rig, 0, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)})
    K.key(rig, 3, {**plates(-18.0, -5.0), **legs(-22.0, 22.0),
                   "body": (-20.0, 0, 0), "head": (22.0, 0, 0)},
          loc={"body": (0.0, 0.050, 0.014)})
    K.key(rig, 12, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)})
    K.interp(act)
    return act


def anim_die(rig):
    act = K.action(rig, "die")
    K.key(rig, 0, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)},
          scale={"body": 1.0})
    K.key(rig, 5, {**plates(-34.0, -8.0), **legs(-30.0, 30.0),
                   "body": (-32.0, 0, 0), "head": (28.0, 0, 0)},
          loc={"body": (0.0, 0.040, 0.060)}, scale={"body": (1.12, 1.12, 0.92)})
    K.key(rig, 20, {**plates(46.0, 10.0), **legs(52.0, 34.0),
                    "body": (18.0, 0, 0), "head": (-34.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.10)}, scale={"body": (1.20, 1.20, 0.30)})
    K.key(rig, 30, {**plates(50.0, 10.0), **legs(56.0, 36.0), "body": (20.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.12)}, scale={"body": (0.34, 0.34, 0.10)})
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
    C.finish(build_mesh(M), rig, "Curler")

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    for fn in (anim_idle, anim_move, anim_telegraph, anim_attack,
               anim_recover, anim_hurt, anim_die):
        fn(rig)

    if render_dir:
        import creature_render
        K.rest(rig)
        rig.animation_data.action = None
        for f in creature_render.sheet(render_dir, NAME, rig, height=0.52,
                                       clips=["idle", "telegraph", "recover", "die"]):
            print(f"[render] {f}")

    K.rest(rig)
    path = K.export_glb(out, rig)
    info = K.verify_glb(path, animations=["idle", "move", "telegraph", "attack",
                                          "recover", "hurt", "die"])
    print(f"[{NAME}] exported {path} ({os.path.getsize(path)/1024:.0f} KB)")
    print(f"[{NAME}] verified: clips={info['animations']}")


if __name__ == "__main__":
    main()
