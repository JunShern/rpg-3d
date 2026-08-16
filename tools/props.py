"""props -- hand-held gear, generated the same way everything else is.

A prop is built in its OWN frame -- grip at the origin, blade running down -Z --
and then rotated into the hand as a finished assembly.  Building it already
tilted is the mistake the keyblade made first: bevelled boxes are axis-aligned,
so a guard built directly on an angled blade comes out skewed and its loop never
closes.

Everything returned is weighted 100% to one bone, which is the right call for a
held object: rigid binding to the hand is not a compromise, it is what holding
something IS.
"""
import math

from mathutils import Vector

import kh_lib as K


def palette():
    return {
        "steel":   K.material("steel", (0.72, 0.76, 0.82), roughness=0.35, metallic=0.8),
        "brass":   K.material("brass", (0.86, 0.68, 0.30), roughness=0.40, metallic=0.7),
        "leather": K.material("leather", (0.32, 0.20, 0.14), roughness=0.85),
    }


def sword(bone="hand.R", scale=1.0, mats=None, name="sword"):
    """A plain arming sword, built grip-at-origin with the blade along -Z.

    Proportions are chosen to read at play distance rather than to be accurate:
    a slightly wide blade and a heavy guard survive a toon ramp, which flattens
    form and leaves the silhouette to do the work.
    """
    M = mats or palette()
    W = {bone: 1.0}
    s = scale
    out = []

    # blade: a flattened tapered tube ending in a point
    blade = [
        {"p": Vector((0, 0, -0.10 * s)), "r": (0.030 * s, 0.010 * s), "w": W, "n": 3.0},
        {"p": Vector((0, 0, -0.16 * s)), "r": (0.032 * s, 0.011 * s), "w": W, "n": 3.0},
        {"p": Vector((0, 0, -0.58 * s)), "r": (0.028 * s, 0.010 * s), "w": W, "n": 3.0},
        {"p": Vector((0, 0, -0.70 * s)), "r": (0.020 * s, 0.008 * s), "w": W, "n": 3.0},
        {"p": Vector((0, 0, -0.76 * s)), "r": 0.0, "w": W, "n": 3.0},
    ]
    out.append(K.tube(f"{name}_blade", blade, seg=10, mat=M["steel"],
                      squircle=3.0, up=(0, 1, 0)))

    # fuller: a shallow groove down the blade, as a darker inset strip
    fuller = [
        {"p": Vector((0, 0, -0.17 * s)), "r": (0.012 * s, 0.012 * s), "w": W, "n": 2.4},
        {"p": Vector((0, 0, -0.60 * s)), "r": (0.010 * s, 0.011 * s), "w": W, "n": 2.4},
    ]
    out.append(K.tube(f"{name}_fuller", K.dome(fuller, at="both", steps=2,
                                               height=0.010 * s),
                      seg=8, mat=M["brass"], squircle=2.4, up=(0, 1, 0)))

    # guard: a crossbar with slight forward-swept tips
    out.append(K.rounded_box(f"{name}_guard", (0, 0, -0.095 * s),
                             (0.105 * s, 0.018 * s, 0.016 * s), 0.008 * s,
                             bone, M["brass"], segments=2))
    for sx in (-1, 1):
        out.append(K.blob(f"{name}_quillon", (sx * 0.105 * s, 0, -0.095 * s),
                          (0.022 * s, 0.024 * s, 0.024 * s), bone, M["brass"],
                          seg=10, rings=8, squircle=2.4))

    # grip and pommel
    grip = [
        {"p": Vector((0, 0, -0.075 * s)), "r": (0.019 * s, 0.016 * s), "w": W, "n": 2.6},
        {"p": Vector((0, 0, 0.055 * s)), "r": (0.018 * s, 0.015 * s), "w": W, "n": 2.6},
    ]
    out.append(K.tube(f"{name}_grip", K.dome(grip, at="both", steps=2, height=0.012 * s),
                      seg=10, mat=M["leather"], squircle=2.6, up=(0, 1, 0)))
    out.append(K.blob(f"{name}_pommel", (0, 0, 0.075 * s),
                      (0.030 * s, 0.028 * s, 0.026 * s), bone, M["brass"],
                      seg=12, rings=9, squircle=2.3))
    return out


def place_in_hand(objs, wrist, handtip, forward=Vector((0, -1, 0))):
    """Rotate a grip-at-origin prop into a hand and move it there.

    The blade continues the line of the hand, tipped a little forward so it
    hangs clear of the thigh rather than along it.  Derived from the character's
    own wrist and hand-tip landmarks, so it lands correctly whatever the
    proportions.
    """
    hand_dir = (handtip - wrist).normalized()
    aim = (hand_dir * 0.65 + Vector((0, -0.22, -1.0)).normalized() * 0.35).normalized()
    quat = Vector((0, 0, -1)).rotation_difference(aim)

    grip = wrist + hand_dir * (handtip - wrist).length * 0.55
    for o in objs:
        K.transform(o, quat=quat, around=(0, 0, 0), translate=grip)
    return objs
