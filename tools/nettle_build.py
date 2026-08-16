"""nettle_build -- the Nettle: a fast swarmer that flares before it darts.

ROLE.  Weak, quick, fights in threes.  It is the reason lock-on exists: on its
own it is trivial, and three of them circling is a real problem.

THE TELL IS THE SILHOUETTE.  At rest its six spines lie flat along its back and
it reads as a low, rounded pebble.  Before it darts they snap upright and
outward and it nearly doubles in visual height.  That change is legible at any
distance and from any angle, which a wind-up pose is not -- and it costs one
rotation key per spine because the spines are generated with a bone each.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/nettle_build.py -- \
      --out public/assets/nettle.glb --render docs/qa/nettle
"""
import bpy
import math
import os
import sys

from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_lib as K
import creature_lib as C

NAME = "nettle"

# NOT A SHADOW.
#
# An external reviewer's sharpest line was that this creature -- small, dark,
# low-slung, spiky, with glowing yellow eyes, spawning in threes and swarming --
# reads as the reference game's single most recognisable enemy with quills
# added, and that it fills ninety per cent of every frame in the demo.
#
# The overlap was never the shape; the radial quills are its own. It was the
# COLOUR: a black-violet body with hot yellow glowing eyes is that creature's
# signature, and nothing else about a hedgehog needs to look like a void.
#
# So: a cold moss-slate body, which is still dark enough to separate from a pale
# meadow, and eyes that are a small bright BONE rather than glowing amber -- the
# same bone as the quills, so the creature reads as one animal made of one
# material rather than as a silhouette with lights in it.
C_SPEC = {
    "hide":  ((0.19, 0.26, 0.24), 0.75),
    "belly": ((0.33, 0.41, 0.36), 0.75),
    # THE QUILLS ARE THE SILHOUETTE, so their value is what the player reads
    # from across a field -- and at 0.88/0.83/0.62 with a 0.95 rim they rendered
    # at #faf8ea, BRIGHTER than the Woolt's fleece at #f3f0e6. `combat.js` states
    # the palette contract outright ("the Woolt is the one pale creature, so
    # 'dark shape' reliably means threat") and this broke it: an audit put a
    # Nettle and a Woolt side by side at the same distance in the same light and
    # could not tell which was which. The recolour that fixed "reads as
    # derivative" fixed the HIDE; the quills are what you actually see.
    #
    # Mid-value bone, not near-white. Still one material with the eyes, still
    # not a dark shape with lights in it, and now clearly darker than the one
    # animal in the game that is meant to be pale.
    "quill": ((0.58, 0.54, 0.42), 0.55),
    "eye":   ((0.96, 0.94, 0.82), 0.30, 1.6),
}

BODY_C = Vector((0.0, 0.0, 0.155))
BODY_S = (0.150, 0.200, 0.100)
N_SPINES = 6
N_LEGS = 4


def build_rig():
    spec = [
        ("root", Vector((0, 0, 0)), Vector((0, 0, 0.08)), None, False),
        ("body", Vector((0, 0.05, 0.10)), Vector((0, -0.10, 0.17)), "root", False),
        ("head", Vector((0, -0.10, 0.17)), Vector((0, -0.20, 0.16)), "body", True),
    ]
    # one bone per spine, so "flare" is six rotation keys and nothing else
    for i, a in enumerate(C.radial(N_SPINES, math.pi / N_SPINES)):
        base = Vector((math.sin(a) * 0.072, math.cos(a) * 0.090 + 0.02, 0.190))
        radial = Vector((math.sin(a), math.cos(a), 0.0))
        # roll each quill to its OWN radial, so +X rotation lays it flat
        # outward and -X stands it up: that is the entire tell
        spec.append((f"quill{i}", base, base + radial * 0.05 + Vector((0, 0, 0.10)),
                     "body", False, radial))
    for i in range(N_LEGS):
        sx = -1 if i % 2 else 1
        fy = 0.085 if i < 2 else -0.075
        hip = Vector((sx * 0.10, fy, 0.115))
        spec.append((f"leg{i}", hip, hip + Vector((sx * 0.055, 0, -0.115)),
                     "body", False))
    return K.build_armature("Nettle_Rig", spec)


def build_mesh(M):
    parts = []
    parts.append(K.blob("nettle_body", BODY_C, BODY_S, "body", M["hide"],
                        seg=22, rings=14, squircle=2.5))
    parts.append(K.blob("nettle_belly", BODY_C + Vector((0, 0.01, -0.048)),
                        (0.128, 0.172, 0.058), "body", M["belly"],
                        seg=20, rings=12, squircle=2.4))
    parts.append(K.blob("nettle_head", (0, -0.165, 0.135), (0.098, 0.085, 0.080),
                        "head", M["hide"], seg=18, rings=12, squircle=2.3))
    parts += C.eyes("nettle_eye", (0, -0.228, 0.150), 0.044,
                    (0.031, 0.028, 0.034), "head", M["eye"])

    for i, a in enumerate(C.radial(N_SPINES, math.pi / N_SPINES)):
        base = Vector((math.sin(a) * 0.072, math.cos(a) * 0.090 + 0.02, 0.190))
        d = Vector((math.sin(a) * 0.42, math.cos(a) * 0.42, 0.90))
        parts.append(C.spine(f"nettle_quill{i}", base, d,
                             0.30 if i % 2 == 0 else 0.245,
                             0.046, f"quill{i}", M["quill"], curve=0.14))

    for i in range(N_LEGS):
        sx = -1 if i % 2 else 1
        fy = 0.085 if i < 2 else -0.075
        hip = Vector((sx * 0.10, fy, 0.115))
        parts.append(C.leg(f"nettle_leg{i}", hip,
                           hip + Vector((sx * 0.055, 0, -0.115)),
                           f"leg{i}", M["hide"], r=0.026))
    return parts


# ------------------------------------------------------------------- clips
#
# `flat` and `flared` are the two silhouettes the whole design rests on.

def quills(pitch, spread=0.0):
    return {f"quill{i}": (pitch, 0.0, spread * (1 if i % 2 else -1))
            for i in range(N_SPINES)}


def legs(swing, splay=0.0):
    out = {}
    for i in range(N_LEGS):
        s = 1 if i % 2 else -1
        out[f"leg{i}"] = (swing * (1 if i < 2 else -1), 0.0, splay * s)
    return out


FLAT = {**quills(64.0), **legs(0.0)}          # laid flat, radially outward
FLARED = {**quills(-26.0, 8.0)}               # snapped bolt upright


def anim_idle(rig):
    act = K.action(rig, "idle")
    for f, (bob, q) in [(0, (0.0, 0.0)), (14, (0.012, 4.0)),
                        (28, (0.0, 0.0)), (42, (0.010, -3.0)), (56, (0.0, 0.0))]:
        K.key(rig, f, {**FLAT, **quills(62.0 + q), "body": (2.0 + q * 0.3, 0, 0)},
              loc={"body": (0.0, 0.0, bob)})
    K.interp(act)
    return act


def anim_move(rig):
    """A scuttle: legs in diagonal pairs, body rocking with them."""
    act = K.action(rig, "move")
    for f, phase in [(0, 1), (4, 0), (8, -1), (12, 0), (16, 1)]:
        pose = {**FLAT, "body": (7.0, 0.0, 2.5 * phase)}
        for i in range(N_LEGS):
            diag = 1 if i in (0, 3) else -1
            pose[f"leg{i}"] = (34.0 * phase * diag, 0.0, 6.0 * (1 if i % 2 else -1))
        K.key(rig, f, pose, loc={"body": (0.0, 0.0, 0.010 * abs(phase))})
    K.interp(act)
    return act


def anim_telegraph(rig):
    """Crouch back and FLARE.  Clamped at the end, so the runtime can hold the
    flared silhouette for exactly as long as the tell should last."""
    act = K.action(rig, "telegraph")
    K.key(rig, 0, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)})
    K.key(rig, 5, {**quills(20.0, 4.0), **legs(-16.0, 10.0),
                   "body": (-14.0, 0, 0), "head": (10.0, 0, 0)},
          loc={"body": (0.0, 0.030, -0.020)})
    K.key(rig, 9, {**FLARED, **legs(-24.0, 16.0),
                   "body": (-20.0, 0, 0), "head": (16.0, 0, 0)},
          loc={"body": (0.0, 0.045, -0.028)})
    K.interp(act)
    return act


def anim_attack(rig):
    act = K.action(rig, "attack")
    K.key(rig, 0, {**FLARED, **legs(-24.0, 16.0), "body": (-20.0, 0, 0)},
          loc={"body": (0.0, 0.045, -0.028)})
    K.key(rig, 3, {**quills(-30.0, 6.0), **legs(30.0, 6.0),
                   "body": (26.0, 0, 0), "head": (-18.0, 0, 0)},
          loc={"body": (0.0, -0.075, 0.020)})
    K.key(rig, 7, {**quills(10.0, 2.0), **legs(6.0), "body": (10.0, 0, 0)},
          loc={"body": (0.0, -0.030, 0.0)})
    K.interp(act)
    return act


def anim_recover(rig):
    """The punish window.  Spines fall flat and it is slow to gather itself."""
    act = K.action(rig, "recover")
    K.key(rig, 0, {**quills(10.0), "body": (10.0, 0, 0)}, loc={"body": (0, -0.03, 0)})
    K.key(rig, 8, {**quills(74.0), **legs(-6.0, 12.0), "body": (16.0, 0, 0),
                   "head": (-8.0, 0, 0)}, loc={"body": (0.0, 0.0, -0.030)})
    K.key(rig, 20, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)})
    K.interp(act)
    return act


def anim_hurt(rig):
    act = K.action(rig, "hurt")
    K.key(rig, 0, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)})
    K.key(rig, 2, {**quills(30.0, 14.0), **legs(-20.0, 20.0),
                   "body": (-26.0, 0, 0), "head": (18.0, 0, 0)},
          loc={"body": (0.0, 0.055, 0.010)})
    K.key(rig, 10, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)})
    K.interp(act)
    return act


def anim_die(rig):
    """Collapse: legs give, spines droop, body flattens.  Bone SCALE does the
    flattening -- a death that only fades out reads as an object being switched
    off rather than a thing dying."""
    act = K.action(rig, "die")
    K.key(rig, 0, {**FLAT, "body": (2.0, 0, 0)}, loc={"body": (0, 0, 0)},
          scale={"body": 1.0})
    K.key(rig, 4, {**quills(24.0, 18.0), **legs(-26.0, 24.0),
                   "body": (-30.0, 0, 0), "head": (20.0, 0, 0)},
          loc={"body": (0.0, 0.03, 0.045)}, scale={"body": (1.10, 1.10, 0.94)})
    K.key(rig, 16, {**quills(88.0, -6.0), **legs(46.0, 30.0),
                    "body": (16.0, 0, 0), "head": (-24.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.075)}, scale={"body": (1.18, 1.18, 0.34)})
    K.key(rig, 26, {**quills(92.0, -8.0), **legs(52.0, 32.0), "body": (18.0, 0, 0)},
          loc={"body": (0.0, 0.0, -0.090)}, scale={"body": (0.35, 0.35, 0.10)})
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
    body = C.finish(build_mesh(M), rig, "Nettle")

    bpy.context.scene.render.fps = 24
    K.rest(rig)
    for fn in (anim_idle, anim_move, anim_telegraph, anim_attack,
               anim_recover, anim_hurt, anim_die):
        fn(rig)
    print(f"[{NAME}] actions: {sorted(a.name for a in bpy.data.actions)}")

    if render_dir:
        import creature_render
        K.rest(rig)
        rig.animation_data.action = None
        for f in creature_render.sheet(render_dir, NAME, rig, height=0.42,
                                       clips=["idle", "telegraph", "attack",
                                              "recover", "die"]):
            print(f"[render] {f}")

    K.rest(rig)
    path = K.export_glb(out, rig)
    info = K.verify_glb(path, animations=["idle", "move", "telegraph", "attack",
                                          "recover", "hurt", "die"])
    print(f"[{NAME}] exported {path} ({os.path.getsize(path)/1024:.0f} KB)")
    print(f"[{NAME}] verified: clips={info['animations']}")


if __name__ == "__main__":
    main()
