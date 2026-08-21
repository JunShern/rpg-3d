"""pose_probe -- where does an angle actually PUT a limb?

`anim_lib` is written in euler degrees per bone, and the only way to know what
a number does is to know what it does.  The module docstring states the
convention -- +X is forward flexion, +Z opens the LEFT arm and closes the RIGHT
-- and `hero_build.render_joint_probe` photographs it rather than asserting it,
which is the right instinct.  This is the cheap numeric version of the same
instinct: no render, no eye, just the position the hand ends up in.

It exists because both spells in the first magic pass were wrong in ways the
numbers looked fine for.  The cast that was supposed to raise both arms
overhead closed them across the chest instead, and the one that was supposed to
sweep out to the side swept behind the back.

THE CONVENTION IS ONLY TRUE NEAR REST.  Rotations are XYZ euler, so Z is
applied in a frame X has already turned.  Measured on upperarm:

    X =    0   ->  +Z opens the LEFT arm out, closes the RIGHT   (docstring)
    X = -170   ->  the sign has FLIPPED: -Z opens LEFT, +Z opens RIGHT

Nothing is broken -- that is what euler order means -- but a pose written at
-150 using the convention learned at 0 gets exactly the opposite of what it
asks for, silently, and looks merely "a bit off" in the viewport.  Raising an
arm past about 120 degrees means re-measuring rather than reasoning.

    # what does the right upper arm do across a grid?
    python3 tools/pose_probe.py -- --bone upperarm --x -90,-120,-150 --z -40,0,40

    # find a pose: arm out to the side, level, not behind
    python3 tools/pose_probe.py -- --bone upperarm --want side

Reported per side, in metres from the shoulder, with elevation in degrees:

    elev   +90 is straight up, -90 straight down
    lat    + is AWAY from the body's centre line, on that side
    fwd    + is in front of the character
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy

CHAR = "public/assets/vesper.glb"

# Named targets, as (elevation, lateral, forward) in the units above.  These are
# what a pose is usually TRYING to be, so the tool can rank a grid against them
# instead of making you read forty rows.
TARGETS = {
    "overhead": (75.0, 0.15, 0.00),   # both arms up and open -- a cast, a cheer
    "side":     (5.0, 0.42, 0.05),    # straight out sideways -- a wide sweep
    "forward":  (0.0, 0.02, 0.46),    # punched down the centre line -- a thrust
    "back":     (-10.0, 0.10, -0.40),  # wound up behind -- the load of a swing
}


def load(path=CHAR):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=path)
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
    return rig


def measure(rig, bone, side, x, z, y=0.0, tip=None):
    """Put `bone.side` at (x, y, z) degrees and report where `tip` lands."""
    for pb in rig.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)
    rig.pose.bones[f"{bone}.{side}"].rotation_euler = (
        math.radians(x), math.radians(y), math.radians(z))
    bpy.context.view_layer.update()
    root = rig.pose.bones[f"{bone}.{side}"].head
    end = rig.pose.bones[f"{tip or bone}.{side}"].tail
    v = end - root
    elev = math.degrees(math.asin(max(-1.0, min(1.0, v.z / max(v.length, 1e-6)))))
    # -Y is forward in this rig; lateral is signed away from the centre line
    return elev, (v.x if side == "L" else -v.x), -v.y


def score(got, want):
    """How far a measured placement is from a named target."""
    de = (got[0] - want[0]) / 90.0
    return math.sqrt(de * de + (got[1] - want[1]) ** 2 + (got[2] - want[2]) ** 2)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    bone = opt("--bone", "upperarm")
    tip = opt("--tip", "hand")
    want = opt("--want")
    xs = [float(v) for v in opt("--x", "0,-45,-90,-120,-150,-170").split(",")]
    zs = [float(v) for v in opt("--z", "-60,-40,-20,0,20,40,60").split(",")]
    rig = load(opt("--char", CHAR))

    if want:
        if want not in TARGETS:
            raise SystemExit(f"[probe] --want must be one of {sorted(TARGETS)}")
        target = TARGETS[want]
        # a finer grid, since this is being asked for a number to actually use
        xs = [float(x) for x in range(-180, 41, 10)]
        zs = [float(z) for z in range(-70, 71, 10)]
        rows = []
        for x in xs:
            for z in zs:
                # mirrored Z, which is what a symmetrical pose needs
                l = measure(rig, bone, "L", x, -z, tip=tip)
                r = measure(rig, bone, "R", x, z, tip=tip)
                rows.append((max(score(l, target), score(r, target)),
                             abs(l[0] - r[0]), x, z, l, r))
        rows.sort(key=lambda t: (t[0], t[1]))
        print(f"[probe] best {bone} for {want!r} "
              f"(target elev {target[0]:.0f}, lat {target[1]:.2f}, fwd {target[2]:.2f})")
        for s, sym, x, z, l, r in rows[:6]:
            print(f"  X={x:>6.0f}  Z=L{-z:<+5.0f}/R{z:<+5.0f} | "
                  f"L elev {l[0]:>6.1f} lat {l[1]:>6.2f} fwd {l[2]:>6.2f} | "
                  f"R elev {r[0]:>6.1f} lat {r[1]:>6.2f} fwd {r[2]:>6.2f} | "
                  f"err {s:.3f} asym {sym:.1f}")
        return

    print(f"[probe] {bone} -> {tip}, on {os.path.basename(opt('--char', CHAR))}")
    print(f"{'X':>7} {'Z':>6} | {'L elev':>7} {'L lat':>6} {'L fwd':>6} | "
          f"{'R elev':>7} {'R lat':>6} {'R fwd':>6}")
    for x in xs:
        for z in zs:
            l = measure(rig, bone, "L", x, z, tip=tip)
            r = measure(rig, bone, "R", x, z, tip=tip)
            print(f"{x:>7.0f} {z:>6.0f} | {l[0]:>7.1f} {l[1]:>6.2f} {l[2]:>6.2f} | "
                  f"{r[0]:>7.1f} {r[1]:>6.2f} {r[2]:>6.2f}")


if __name__ == "__main__":
    main()
