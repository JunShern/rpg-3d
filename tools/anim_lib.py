"""anim_lib -- the shared animation library.

Clips here are POSE DATA, not baked transforms: each key is a bone name mapped
to euler degrees in that bone's local frame.  Nothing in this file knows a
character's proportions, so the same clip drives any skeleton built by
`geo_lib.build_armature` with the same bone names and the same roll convention.
That is the whole reason it is worth separating -- one authored animation set,
many characters, including ones whose mesh came from somewhere else entirely.

The convention every number below depends on (see geo_lib):

    rotate about local X  ->  forward/back flexion   (positive = forward)
    rotate about local Y  ->  twist along the limb
    rotate about local Z  ->  sideways swing

THE SIDEWAYS AXIS IS NOT MIRRORED.  Unlike X, whose sign means the same thing on
both sides, +Z swings the LEFT arm OUT and the RIGHT arm ACROSS THE BODY.  To
open both arms outward you need L:+Z together with R:-Z.  The airborne pose was
first written with both signs the same and the arms crossed behind the back
through every jump.  See `render_joint_probe` in hero_build.py, which
photographs this rather than asserting it.

`weapon=True` damps the right arm so a held prop hangs at the side instead of
being swung like a free limb; characters with empty hands want weapon=False.
"""
import math

from mathutils import Vector

import geo_lib as K


# ---------------------------------------------------------------- animation
#
# Reminder from geo_lib: EVERY bone rotates +X forward.  Left and right share the
# sign for flexion; only the sideways (Z) terms flip.

def anim_idle(rig, weapon=True):
    act = K.action(rig, "idle")
    base_arm = dict(
        upperarm_x=6.0, forearm_x=16.0,
    )

    def pose(t, breath, sway):
        """t in 0..1 around the loop; breath and sway are the two oscillators."""
        p = {
            "hips":  (-1.0 + 0.6 * breath, 0.0, 0.0),
            "spine": (1.5 - 1.2 * breath, 0.5 * sway, 0.0),
            "chest": (-1.0 - 2.0 * breath, -0.8 * sway, 0.0),
            "neck":  (1.0 + 0.8 * breath, 0.0, 0.0),
            "head":  (2.0 - 1.4 * breath, 1.6 * sway, 0.8 * sway),
        }
        for s, sgn in (("L", 1.0), ("R", -1.0)):
            p[f"shoulder.{s}"] = (0.0, 0.0, sgn * (-3.0 - 1.6 * breath))
            p[f"upperarm.{s}"] = (base_arm["upperarm_x"] + 3.0 * breath,
                                  0.0, sgn * (-4.0 - 1.5 * breath))
            p[f"forearm.{s}"] = (base_arm["forearm_x"] + 5.0 * breath, 0.0, 0.0)
            p[f"hand.{s}"] = (4.0 * breath, 0.0, 0.0)
            if s == "R" and weapon:
                # wrist held back so the sword hangs at the side instead of
                # being pointed forward like a torch
                p[f"hand.{s}"] = (-24.0 + 3.0 * breath, 0.0, 0.0)
            # SOFT KNEES.  This pose used to stand with the knees locked
            # (+2 deg is past straight), which nobody does -- and which parks a
            # two-bone IK solver exactly on its singularity, where the knee's
            # sideways position goes as sqrt(slack).  The idle breathing then
            # swung the knees tens of millimetres per frame.  A few degrees of
            # flexion is both anatomically right and numerically well-behaved.
            p[f"thigh.{s}"] = (5.0 - 0.8 * breath, 0.0, sgn * 2.0)
            p[f"shin.{s}"] = (-9.0 + 1.6 * breath, 0.0, 0.0)
            p[f"foot.{s}"] = (4.0 - 0.8 * breath, 0.0, 0.0)
        if weapon:
            # right arm carries the sword: hangs heavier and further out
            p["upperarm.R"] = (base_arm["upperarm_x"] - 4.0 + 2.0 * breath, 0.0, 8.0)
            p["forearm.R"] = (base_arm["forearm_x"] + 12.0 + 4.0 * breath, 0.0, 0.0)
        return p

    N = 48
    for f in range(0, N + 1, 6):
        t = f / N
        breath = math.sin(t * math.tau)
        sway = math.sin(t * math.tau - 0.9)
        _key(rig, f, pose(t, breath, sway),
              loc={"hips": (0.0, -0.008 + 0.008 * breath, 0.0)})
    K.interp(act)
    return act


def anim_run(rig, weapon=True):
    """A four-key run cycle: contact, passing, contact, passing.  Amplitudes are
    pushed well past life -- a toon ramp eats subtlety, and a JRPG run should
    read as enthusiasm."""
    act = K.action(rig, "run")

    def half(lead, trail, twist):
        """One contact pose: `lead` leg forward, `trail` leg driving back."""
        sl, st = lead, trail
        p = {
            "hips":  (3.0, twist * 7.0, 0.0),
            "spine": (5.0, twist * -3.0, 0.0),
            "chest": (7.0, twist * -9.0, 0.0),
            "neck":  (-5.0, 0.0, 0.0),
            "head":  (-7.0, twist * 3.0, 0.0),
            f"thigh.{sl}": (44.0, 0.0, 0.0),
            f"shin.{sl}":  (-20.0, 0.0, 0.0),
            f"foot.{sl}":  (6.0, 0.0, 0.0),
            f"thigh.{st}": (-38.0, 0.0, 0.0),
            f"shin.{st}":  (-46.0, 0.0, 0.0),
            f"foot.{st}":  (22.0, 0.0, 0.0),
            f"shoulder.{sl}": (-4.0, 0.0, 0.0),
            f"shoulder.{st}": (4.0, 0.0, 0.0),
            f"upperarm.{sl}": (-42.0, 0.0, 0.0),
            f"forearm.{sl}":  (62.0, 0.0, 0.0),
            f"upperarm.{st}": (44.0, 0.0, 0.0),
            f"forearm.{st}":  (70.0, 0.0, 0.0),
            "hand.L": (0.0, 0.0, 0.0),
        }
        if weapon:
            p.update(weapon_arm(twist))
        return p

    def weapon_arm(twist):
        """The right arm carries the sword and CANNOT swing like a free arm.

        Given a full counter-swing the blade -- rigid to hand.R -- whips out to
        horizontal and the character runs holding it like a rifle.  Real weapon
        runs in this genre damp the carrying arm and tuck the blade back and
        down, so that is what this does: a third of the swing, plus a fixed
        wrist break that keeps the blade angled at the ground."""
        # Elbow flexes FORWARD (+), wrist extends BACK (-), and the two roughly
        # cancel: the hand ends up forward of the elbow while the blade still
        # hangs down and trails.  These were originally tuned against an
        # inverted elbow, so the numbers only made sense while it was wrong.
        return {
            "shoulder.R": (0.0, 0.0, 7.0),
            # -Z holds the weapon arm slightly OUT, clear of the thigh
            "upperarm.R": (-6.0 + twist * 12.0, 0.0, -12.0),
            "forearm.R": (30.0, 0.0, 0.0),
            "hand.R": (-26.0, 0.0, 0.0),
        }

    def passing(support, swing, twist):
        p = {
            "hips":  (2.0, twist * 3.0, 0.0),
            "spine": (5.0, twist * -1.5, 0.0),
            "chest": (7.0, twist * -4.0, 0.0),
            "neck":  (-5.0, 0.0, 0.0),
            "head":  (-7.0, 0.0, 0.0),
            f"thigh.{support}": (-6.0, 0.0, 0.0),
            f"shin.{support}":  (-22.0, 0.0, 0.0),
            f"foot.{support}":  (16.0, 0.0, 0.0),
            f"thigh.{swing}":   (34.0, 0.0, 0.0),
            f"shin.{swing}":    (-82.0, 0.0, 0.0),
            f"foot.{swing}":    (2.0, 0.0, 0.0),
            f"shoulder.{support}": (0.0, 0.0, 0.0),
            f"shoulder.{swing}":   (0.0, 0.0, 0.0),
            f"upperarm.{support}": (-14.0, 0.0, 0.0),
            f"forearm.{support}":  (66.0, 0.0, 0.0),
            f"upperarm.{swing}":   (16.0, 0.0, 0.0),
            f"forearm.{swing}":    (72.0, 0.0, 0.0),
            "hand.L": (0.0, 0.0, 0.0),
        }
        if weapon:
            p.update(weapon_arm(twist))
        return p

    #    frame  pose                       hip height (bone-local +Y = world up)
    keys = [
        (0,  half("L", "R", +1.0), -0.055),   # L contact, lowest
        (4,  passing("L", "R", +0.4), 0.030),  # push off into flight
        (8,  half("R", "L", -1.0), -0.055),
        (12, passing("R", "L", -0.4), 0.030),
        (16, half("L", "R", +1.0), -0.055),
    ]
    for f, p, bob in keys:
        _key(rig, f, p, loc={"hips": (0.0, bob, 0.0)})
    K.interp(act)
    return act


NEUTRAL = {
    "hips": (-1.0, 0.0, 0.0), "spine": (1.5, 0.0, 0.0),
    "chest": (-1.0, 0.0, 0.0), "neck": (1.0, 0.0, 0.0), "head": (2.0, 0.0, 0.0),
    "shoulder.L": (0.0, 0.0, -3.0), "shoulder.R": (0.0, 0.0, 3.0),
    "upperarm.L": (6.0, 0.0, -4.0), "forearm.L": (16.0, 0.0, 0.0),
    "upperarm.R": (2.0, 0.0, 8.0), "forearm.R": (28.0, 0.0, 0.0),
    "hand.L": (0.0, 0.0, 0.0), "hand.R": (-24.0, 0.0, 0.0),
    # soft knees, for the same reason the idle has them
    "thigh.L": (5.0, 0.0, 2.0), "shin.L": (-9.0, 0.0, 0.0), "foot.L": (4.0, 0.0, 0.0),
    "thigh.R": (5.0, 0.0, -2.0), "shin.R": (-9.0, 0.0, 0.0), "foot.R": (4.0, 0.0, 0.0),
}

# The airborne pose is shared: `jump` ends on it and `land` starts from it, so
# the two clips meet exactly however long the character was actually in the air.
AIRBORNE = dict(NEUTRAL)
AIRBORNE.update({
    "hips": (4.0, 0.0, 0.0), "spine": (3.0, 0.0, 0.0), "chest": (4.0, 0.0, 0.0),
    "neck": (-4.0, 0.0, 0.0), "head": (-5.0, 0.0, 0.0),
    # arms OPEN outward for balance: L:+Z and R:-Z (see the module docstring)
    "upperarm.L": (-20.0, 0.0, 34.0), "forearm.L": (46.0, 0.0, 0.0),
    "upperarm.R": (-16.0, 0.0, -36.0), "forearm.R": (50.0, 0.0, 0.0),
    "hand.R": (-18.0, 0.0, 0.0),
    "thigh.L": (46.0, 0.0, 3.0), "shin.L": (-72.0, 0.0, 0.0), "foot.L": (14.0, 0.0, 0.0),
    "thigh.R": (10.0, 0.0, -3.0), "shin.R": (-46.0, 0.0, 0.0), "foot.R": (-14.0, 0.0, 0.0),
})


def _neutral(weapon):
    n = dict(NEUTRAL)
    if not weapon:
        n["hand.R"] = (0.0, 0.0, 0.0)
        n["upperarm.R"] = (6.0, 0.0, 4.0)
        n["forearm.R"] = (16.0, 0.0, 0.0)
    return n


# Bones whose rotation is SHARED with a segment further up the chain.  A pose
# names `spine` because "how far is the torso bent" is one idea; a rig that has
# been given a second spine segment splits that idea across both, which is what
# makes a torso curve instead of hinge.
#
# CONDITIONAL ON THE RIG, always.  Halving `spine` on a character that has no
# `spine2` to take the other half would quietly flatten every torso arc in the
# library to half depth -- and K.key skips bones a rig does not have, so it
# would do it without a word.
SPREAD = {"spine": ("spine", "spine2")}


def _spread(rig, pose):
    out = None
    for src, targets in SPREAD.items():
        if src not in pose:
            continue
        if any(t not in rig.pose.bones for t in targets):
            continue
        if out is None:
            out = dict(pose)
        share = tuple(a / len(targets) for a in pose[src])
        for t in targets:
            # an explicit key for a segment wins over its share of the parent
            if t == src or t not in pose:
                out[t] = share
    return out if out is not None else pose


def _key(rig, frame, pose, loc=None):
    """Every pose in this file goes through here, so the spread happens once."""
    K.key(rig, frame, _spread(rig, pose), loc=loc)


def clip(rig, name, keys):
    """The shape EVERY clip in this file has: key a series of poses, then set
    the interpolation.  `keys` is [(frame, pose, hips_offset), ...].

    Worth its own function only because it is the part that is always the same,
    and the part that is always the same is the part that drifts -- one clip
    forgetting `K.interp` is a clip that moves in straight lines between poses
    and looks mechanical for reasons nobody can see in the numbers.
    """
    act = K.action(rig, name)
    for f, pose, loc in keys:
        _key(rig, f, pose, loc={"hips": loc} if loc is not None else None)
    K.interp(act)
    return act


def swing(rig, name, *, draw, strike, settle=None, timing, travel,
          weapon=True, base=None, from_draw=False):
    """A sword swing, as four beats: load, hit, follow through, recover.

    THIS IS THE SHAPE ALL THREE HITS OF THE CHAIN ALREADY HAD.  Each was
    written out longhand -- same five keys, same neutral-draw-strike-settle-
    neutral structure, same hips travel -- which made a new swing forty lines
    of boilerplate around three interesting dictionaries.  A library the size
    this game wants cannot be built at forty lines a move, and the boilerplate
    is where the drift lives: `anim_attack` carried its own copy of NEUTRAL
    (rule (r)) and so quietly ignored `weapon=`.

    `draw`, `strike` and `settle` are DELTAS on the neutral pose, except that
    `settle` layers on `strike` -- a follow-through is a strike decaying, not a
    new pose, and writing it against neutral means restating the whole swing.

    `timing` is five frame numbers and `travel` five hip offsets, because the
    frames are set by combat.js's active window and not by taste: hit 1 opens
    at 0.10 s and closes at 0.21 s, which at 24 fps is frames 2.4 to 5.0.
    """
    n = base if base is not None else _neutral(weapon)
    p_draw = {**n, **draw}
    p_strike = {**n, **strike}
    p_settle = {**p_strike, **(settle or {})}
    # `from_draw` opens the clip ALREADY LOADED instead of at neutral.  A link
    # in the middle of a chain does not start from standing -- it starts where
    # the previous hit left the blade -- and a swing that returns to neutral
    # before winding up reads as a stutter between hits.
    poses = [p_draw if from_draw else n, p_draw, p_strike, p_settle, n]
    return clip(rig, name, list(zip(timing, poses, travel)))


def anim_jump(rig, weapon=True):
    """Crouch, launch, tuck -- and HOLD the tuck.

    Split from the landing on purpose.  Air time is decided by physics at
    runtime, so a single jump-to-land clip would only line up for one exact
    hang time; ending clamped on AIRBORNE lets the runtime hold that pose for
    as long as the character is actually off the ground.
    """
    act = K.action(rig, "jump")

    base = _neutral(weapon)
    crouch = dict(base)
    crouch.update({
        "hips": (10.0, 0.0, 0.0), "spine": (8.0, 0.0, 0.0), "chest": (10.0, 0.0, 0.0),
        "neck": (-8.0, 0.0, 0.0), "head": (-10.0, 0.0, 0.0),
        # arms swing BACK to load; the launch continues the same swing overhead
        "upperarm.L": (-46.0, 0.0, -6.0), "forearm.L": (30.0, 0.0, 0.0),
        "upperarm.R": (-40.0, 0.0, 10.0), "forearm.R": (36.0, 0.0, 0.0),
        "thigh.L": (48.0, 0.0, 2.0), "shin.L": (-78.0, 0.0, 0.0), "foot.L": (34.0, 0.0, 0.0),
        "thigh.R": (48.0, 0.0, -2.0), "shin.R": (-78.0, 0.0, 0.0), "foot.R": (34.0, 0.0, 0.0),
    })

    launch = dict(base)
    launch.update({
        "hips": (-6.0, 0.0, 0.0), "spine": (-4.0, 0.0, 0.0), "chest": (-6.0, 0.0, 0.0),
        "neck": (6.0, 0.0, 0.0), "head": (8.0, 0.0, 0.0),
        "upperarm.L": (-100.0, 0.0, -14.0), "forearm.L": (24.0, 0.0, 0.0),
        "upperarm.R": (-92.0, 0.0, 16.0), "forearm.R": (30.0, 0.0, 0.0),
        "hand.R": (-12.0, 0.0, 0.0),
        "thigh.L": (-16.0, 0.0, 2.0), "shin.L": (-6.0, 0.0, 0.0), "foot.L": (-26.0, 0.0, 0.0),
        "thigh.R": (-16.0, 0.0, -2.0), "shin.R": (-6.0, 0.0, 0.0), "foot.R": (-26.0, 0.0, 0.0),
    })

    for f, pose, up in [(0, base, -0.008), (3, crouch, -0.300),
                        (7, launch, 0.060), (12, AIRBORNE, -0.020)]:
        _key(rig, f, pose, loc={"hips": (0.0, up, 0.0)})
    K.interp(act)
    return act


def anim_land(rig, weapon=True):
    """Absorb and recover.  Starts from AIRBORNE so it cuts in cleanly."""
    act = K.action(rig, "land")

    base = _neutral(weapon)
    absorb = dict(base)
    absorb.update({
        "hips": (12.0, 0.0, 0.0), "spine": (9.0, 0.0, 0.0), "chest": (14.0, 0.0, 0.0),
        "neck": (-10.0, 0.0, 0.0), "head": (-12.0, 0.0, 0.0),
        "upperarm.L": (-34.0, 0.0, -18.0), "forearm.L": (34.0, 0.0, 0.0),
        "upperarm.R": (-26.0, 0.0, 20.0), "forearm.R": (38.0, 0.0, 0.0),
        "thigh.L": (54.0, 0.0, 3.0), "shin.L": (-86.0, 0.0, 0.0), "foot.L": (38.0, 0.0, 0.0),
        "thigh.R": (54.0, 0.0, -3.0), "shin.R": (-86.0, 0.0, 0.0), "foot.R": (38.0, 0.0, 0.0),
    })

    for f, pose, up in [(0, AIRBORNE, -0.020), (3, absorb, -0.340),
                        (9, base, -0.008)]:
        _key(rig, f, pose, loc={"hips": (0.0, up, 0.0)})
    K.interp(act)
    return act


def anim_attack(rig, weapon=True):
    """Overhead sword swing: anticipation, strike, follow-through, recover.
    The lunge is real translation on the hips, so the runtime gets forward
    motion out of the clip for free.

    Its neutral used to be an inline copy of NEUTRAL, which meant this clip --
    alone among the three -- ignored `weapon=` and cocked the wrist 24 degrees
    for a grip an unarmed character does not have.  Rule (r), and it only
    started to matter when characters stopped all being sword wielders.
    """
    return swing(
        rig, "attack", weapon=weapon,
        draw={
            "hips": (-6.0, -14.0, 0.0), "spine": (-4.0, -12.0, 0.0),
            "chest": (-8.0, -22.0, 0.0), "neck": (2.0, 8.0, 0.0),
            "head": (0.0, 14.0, 0.0),
            "shoulder.R": (-14.0, 0.0, 16.0),
            "upperarm.R": (-128.0, 0.0, 26.0), "forearm.R": (64.0, 0.0, 0.0),
            # wrist cocked hard, so a held blade points UP behind the head at
            # the top of the windup instead of trailing low
            "hand.R": (-70.0, 0.0, 0.0),
            "upperarm.L": (-22.0, 0.0, -18.0), "forearm.L": (52.0, 0.0, 0.0),
            "thigh.L": (-14.0, 0.0, 4.0), "shin.L": (18.0, 0.0, 0.0),
            "foot.L": (-6.0, 0.0, 0.0),
            "thigh.R": (10.0, 0.0, -6.0), "shin.R": (-14.0, 0.0, 0.0),
            "foot.R": (6.0, 0.0, 0.0),
        },
        strike={
            "hips": (10.0, 16.0, 0.0), "spine": (12.0, 14.0, 0.0),
            "chest": (16.0, 24.0, 0.0), "neck": (-6.0, -8.0, 0.0),
            "head": (-10.0, -12.0, 0.0),
            "shoulder.R": (10.0, 0.0, -6.0),
            "upperarm.R": (78.0, 0.0, -14.0), "forearm.R": (8.0, 0.0, 0.0),
            "hand.R": (14.0, 0.0, 0.0),
            "upperarm.L": (-46.0, 0.0, -26.0), "forearm.L": (72.0, 0.0, 0.0),
            "thigh.L": (36.0, 0.0, 4.0), "shin.L": (-30.0, 0.0, 0.0),
            "foot.L": (10.0, 0.0, 0.0),
            "thigh.R": (-24.0, 0.0, -6.0), "shin.R": (-24.0, 0.0, 0.0),
            "foot.R": (16.0, 0.0, 0.0),
        },
        settle={
            "hips": (6.0, 10.0, 0.0), "chest": (10.0, 16.0, 0.0),
            "upperarm.R": (56.0, 0.0, -6.0), "forearm.R": (26.0, 0.0, 0.0),
            "head": (-4.0, -6.0, 0.0),
        },
        # TIMED TO THE HITBOX.  combat.js opens hit 1's active window at 0.10 s
        # and closes it at 0.21 s; at 24 fps that is frames 2.4 to 5.0.  The
        # first version peaked the strike at frame 11, so damage landed less
        # than halfway through the wind-up and the hit registered before the
        # blade moved.
        timing=(0, 2, 5, 9, 22),
        #       hips (x=side, y=up, z=forward) in bone-local units
        travel=((0.0, -0.008, 0.000),
                (0.0, -0.030, -0.055),   # sink and load backwards
                (0.0, -0.045, 0.140),    # lunge through the swing
                (0.0, -0.030, 0.110),
                (0.0, -0.008, 0.000)),
    )


def anim_attack2(rig, weapon=True):
    """Hit 2: a RISING BACKHAND.

    Deliberately the mirror of hit 1 in every readable way -- it starts where
    hit 1 finished (blade low and across the body on the off side), sweeps the
    other way, and travels up instead of down.  A combo whose second swing looks
    like its first is not a combo, and that was this build's largest fault.
    """
    return swing(
        rig, "attack2", weapon=weapon, from_draw=True,
        # picks up from hit 1's follow-through: blade low, across to the off side
        draw={
            "hips": (4.0, 18.0, 0.0), "spine": (3.0, 16.0, 0.0),
            "chest": (6.0, 26.0, 0.0), "neck": (-3.0, -10.0, 0.0),
            "head": (-5.0, -14.0, 0.0),
            "shoulder.R": (4.0, 0.0, -6.0),
            # +Z on the RIGHT arm pulls it ACROSS the body (see the module
            # docstring)
            "upperarm.R": (42.0, 0.0, 36.0), "forearm.R": (56.0, 0.0, 0.0),
            "hand.R": (-42.0, 0.0, 0.0),
            "upperarm.L": (18.0, 0.0, 22.0), "forearm.L": (44.0, 0.0, 0.0),
            "thigh.L": (16.0, 0.0, 4.0), "shin.L": (-22.0, 0.0, 0.0),
            "thigh.R": (-8.0, 0.0, -6.0), "shin.R": (-16.0, 0.0, 0.0),
        },
        # and sweeps OUT and UP to the sword side
        strike={
            "hips": (-4.0, -20.0, 0.0), "spine": (-3.0, -18.0, 0.0),
            "chest": (-8.0, -30.0, 0.0), "neck": (4.0, 12.0, 0.0),
            "head": (6.0, 16.0, 0.0),
            "shoulder.R": (-10.0, 0.0, 10.0),
            "upperarm.R": (-34.0, 0.0, -48.0), "forearm.R": (16.0, 0.0, 0.0),
            "hand.R": (8.0, 0.0, 0.0),
            "upperarm.L": (-30.0, 0.0, -34.0), "forearm.L": (40.0, 0.0, 0.0),
            "thigh.L": (-14.0, 0.0, 4.0), "shin.L": (-6.0, 0.0, 0.0),
            "thigh.R": (26.0, 0.0, -6.0), "shin.R": (-34.0, 0.0, 0.0),
            "foot.R": (12.0, 0.0, 0.0),
        },
        settle={
            "chest": (-4.0, -20.0, 0.0), "hips": (-2.0, -12.0, 0.0),
            "upperarm.R": (-14.0, 0.0, -30.0), "forearm.R": (34.0, 0.0, 0.0),
        },
        # active window 0.09 s -> 0.20 s == frames 2.2 to 4.8
        timing=(0, 2, 5, 9, 22),
        travel=((0.0, -0.020, 0.020),
                (0.0, -0.030, -0.010),
                (0.0, -0.010, 0.115),
                (0.0, -0.020, 0.090),
                (0.0, -0.008, 0.000)),
    )


def anim_attack3(rig, weapon=True):
    """Hit 3: the FINISHER.

    Slower to start and bigger everywhere -- a longer load, a two-handed
    overhead chop straight down the centre line, a deep step-through, and a long
    recovery that makes the whole chain a commitment rather than a button to
    mash.  combat.js gives it more than double hit 1's damage and a launch, so
    the animation has to earn it.
    """
    return swing(
        rig, "attack3", weapon=weapon,
        draw={
            "hips": (-12.0, -16.0, 0.0), "spine": (-8.0, -14.0, 0.0),
            "chest": (-16.0, -20.0, 0.0), "neck": (6.0, 10.0, 0.0),
            "head": (4.0, 16.0, 0.0),
            "shoulder.R": (-18.0, 0.0, 14.0),
            "upperarm.R": (-152.0, 0.0, 18.0), "forearm.R": (58.0, 0.0, 0.0),
            "hand.R": (-64.0, 0.0, 0.0),
            # left hand comes up to meet the grip: this one is two-handed
            "upperarm.L": (-124.0, 0.0, 30.0), "forearm.L": (66.0, 0.0, 0.0),
            "hand.L": (-30.0, 0.0, 0.0),
            "thigh.L": (-22.0, 0.0, 4.0), "shin.L": (26.0, 0.0, 0.0),
            "foot.L": (-10.0, 0.0, 0.0),
            "thigh.R": (14.0, 0.0, -6.0), "shin.R": (-20.0, 0.0, 0.0),
            "foot.R": (10.0, 0.0, 0.0),
        },
        strike={
            "hips": (18.0, 4.0, 0.0), "spine": (18.0, 3.0, 0.0),
            "chest": (28.0, 6.0, 0.0), "neck": (-12.0, 0.0, 0.0),
            "head": (-18.0, 0.0, 0.0),
            "shoulder.R": (14.0, 0.0, -8.0),
            "upperarm.R": (104.0, 0.0, -8.0), "forearm.R": (4.0, 0.0, 0.0),
            "hand.R": (26.0, 0.0, 0.0),
            "upperarm.L": (86.0, 0.0, 12.0), "forearm.L": (16.0, 0.0, 0.0),
            "hand.L": (16.0, 0.0, 0.0),
            "thigh.L": (52.0, 0.0, 4.0), "shin.L": (-38.0, 0.0, 0.0),
            "foot.L": (14.0, 0.0, 0.0),
            "thigh.R": (-38.0, 0.0, -6.0), "shin.R": (-32.0, 0.0, 0.0),
            "foot.R": (22.0, 0.0, 0.0),
        },
        settle={
            "chest": (24.0, 5.0, 0.0), "head": (-12.0, 0.0, 0.0),
            "upperarm.R": (92.0, 0.0, -4.0), "forearm.R": (18.0, 0.0, 0.0),
            "upperarm.L": (70.0, 0.0, 14.0),
        },
        # active window 0.17 s -> 0.31 s == frames 4.1 to 7.4
        timing=(0, 4, 8, 13, 34),
        travel=((0.0, -0.008, 0.000),
                (0.0, -0.052, -0.085),   # sink deep and wind back
                (0.0, -0.070, 0.230),    # step THROUGH it
                (0.0, -0.060, 0.200),
                (0.0, -0.008, 0.000)),   # long recovery: this was a commitment
    )


def anim_airattack(rig, weapon=True):
    """The FALLING CUT -- the only attack that is not part of the ground chain.

    It exists to close a loop the game already half had: the finisher launches,
    so there needed to be something to do with an airborne enemy.  The shape is
    a stall and a drop.  The character curls up at the top -- knees in, blade
    cocked overhead, briefly smaller than usual so the hang reads as a held
    breath rather than a hitch -- and then unfolds straight down through the
    target, blade leading, and stays extended.

    IT DOES NOT RECOVER IN THE AIR.  The tail of this clip holds the extended
    pose, because the runtime is still falling when the clip runs out; the
    landing is what ends it.  A clip that settles back to neutral mid-fall makes
    the character look like they finished and then fell over.

    Connecting to the runtime: a hit pogos the player back up, so this clip has
    to look equally right played once or four times in a row.  That is why the
    stall is short and the recovery is a hold -- there is nothing in it that
    needs to finish before it can start again.
    """
    act = K.action(rig, "airattack")
    n = _neutral(weapon)

    # the tuck: everything gathers in, and the blade goes up and BACK
    tuck = dict(AIRBORNE)
    tuck.update({
        "hips": (16.0, 0.0, 0.0), "spine": (12.0, 0.0, 0.0),
        "chest": (10.0, -8.0, 0.0), "neck": (-6.0, 6.0, 0.0),
        "head": (-10.0, 8.0, 0.0),
        "shoulder.R": (-16.0, 0.0, 10.0),
        "upperarm.R": (-146.0, 0.0, 12.0), "forearm.R": (52.0, 0.0, 0.0),
        "hand.R": (-56.0, 0.0, 0.0),
        "upperarm.L": (-118.0, 0.0, 26.0), "forearm.L": (58.0, 0.0, 0.0),
        "hand.L": (-26.0, 0.0, 0.0),
        "thigh.L": (74.0, 0.0, 5.0), "shin.L": (-96.0, 0.0, 0.0),
        "foot.L": (26.0, 0.0, 0.0),
        "thigh.R": (66.0, 0.0, -5.0), "shin.R": (-90.0, 0.0, 0.0),
        "foot.R": (24.0, 0.0, 0.0),
    })

    # THE DRIVE: one straight line from the blade tip to the trailing foot.
    #
    # The torso pitch is doing most of the work and the first pass left it out.
    # With an upright chest the same arm angle puts the blade forward and UP --
    # a thrust, not a plunge -- because the sword extends from the hand along
    # the arm. `attack3` gets its downward chop from a 28-degree forward chest
    # as much as from the shoulder; this needs more, because it is falling.
    drive = dict(n)
    drive.update({
        "hips": (26.0, 0.0, 0.0), "spine": (20.0, 0.0, 0.0),
        "chest": (34.0, 2.0, 0.0), "neck": (-16.0, 0.0, 0.0),
        "head": (-22.0, 0.0, 0.0),
        "shoulder.R": (12.0, 0.0, -6.0),
        "upperarm.R": (134.0, 0.0, -6.0), "forearm.R": (0.0, 0.0, 0.0),
        "hand.R": (12.0, 0.0, 0.0),
        "upperarm.L": (78.0, 0.0, 18.0), "forearm.L": (20.0, 0.0, 0.0),
        "hand.L": (10.0, 0.0, 0.0),
        # legs trail up and back, so the whole body is one falling diagonal
        "thigh.L": (-46.0, 0.0, 4.0), "shin.L": (22.0, 0.0, 0.0),
        "foot.L": (-24.0, 0.0, 0.0),
        "thigh.R": (-58.0, 0.0, -4.0), "shin.R": (30.0, 0.0, 0.0),
        "foot.R": (-26.0, 0.0, 0.0),
    })

    # THE BLADE HAS TO ARRIVE WHEN THE HITBOX DOES.
    #
    # combat.js opens the active window at 0.19 s, which is clip frame 4.6 at
    # 24 fps, so the drive is keyed at frame 5. The first pass put it at frame 7
    # -- 0.29 s -- and the swing went live while the sword was still cocked
    # overhead, which is exactly the fault the ground combo had in iteration 2.
    # active window 0.19 s -> 0.39 s == frames 4.6 to 9.4
    for f, p, loc in [
        (0,  AIRBORNE, (0.0, 0.0, 0.000)),
        (2,  tuck,     (0.0, -0.020, -0.060)),   # gather, and hang
        (5,  drive,    (0.0, 0.030, 0.075)),     # unfold straight down
        (26, drive,    (0.0, 0.026, 0.070)),     # HOLD -- the landing ends this
    ]:
        _key(rig, f, p, loc={"hips": loc})
    K.interp(act)
    return act


def anim_dodge(rig, weapon=True):
    """THE SLIP -- the defensive option, and deliberately not a roll.

    Every action game reaches for a shoulder roll and it is the one move that
    would make this character look borrowed.  She is also wearing a long coat
    and boots, which is not what you roll in.  So: a fencer's retreat.  She
    drops her weight onto the trailing leg, drives, and skims -- torso turned
    away, blade held low and across the body, head still tracking whatever she
    is backing away from.

    THE HEAD IS THE WHOLE TRICK.  A retreat where the character looks where they
    are going reads as running away.  A retreat where they keep watching the
    thing they are avoiding reads as a decision.

    The runtime carries her sideways and gives i-frames over the middle of it,
    so the clip's job is to make 0.4 s of translation look like a choice rather
    than a slide.  It ends standing, because whatever comes next -- a swing, a
    second slip -- starts from there.
    """
    act = K.action(rig, "dodge")
    n = _neutral(weapon)

    # the load: weight drops, everything gathers to one side
    coil = dict(n)
    coil.update({
        "hips": (14.0, 0.0, -10.0), "spine": (8.0, -6.0, -6.0),
        "chest": (6.0, -12.0, -4.0), "neck": (-4.0, 14.0, 0.0),
        "head": (-6.0, 20.0, 0.0),          # already looking back
        "upperarm.R": (-24.0, 0.0, -18.0), "forearm.R": (74.0, 0.0, 0.0),
        "hand.R": (-16.0, 0.0, 0.0),
        "upperarm.L": (-14.0, 0.0, 26.0), "forearm.L": (52.0, 0.0, 0.0),
        "thigh.L": (34.0, 0.0, 10.0), "shin.L": (-52.0, 0.0, 0.0),
        "foot.L": (18.0, 0.0, 0.0),
        "thigh.R": (-12.0, 0.0, -14.0), "shin.R": (-18.0, 0.0, 0.0),
        "foot.R": (12.0, 0.0, 0.0),
    })

    # the skim: low, long, trailing leg extended behind the direction of travel
    skim = dict(n)
    skim.update({
        "hips": (20.0, 0.0, -16.0), "spine": (12.0, -10.0, -10.0),
        "chest": (8.0, -18.0, -8.0), "neck": (-6.0, 20.0, 0.0),
        "head": (-8.0, 28.0, 0.0),
        "upperarm.R": (-16.0, 0.0, -26.0), "forearm.R": (86.0, 0.0, 0.0),
        "hand.R": (-22.0, 0.0, 0.0),
        "upperarm.L": (-8.0, 0.0, 40.0), "forearm.L": (38.0, 0.0, 0.0),
        "thigh.L": (58.0, 0.0, 14.0), "shin.L": (-74.0, 0.0, 0.0),
        "foot.L": (24.0, 0.0, 0.0),
        "thigh.R": (-34.0, 0.0, -18.0), "shin.R": (10.0, 0.0, 0.0),
        "foot.R": (-18.0, 0.0, 0.0),
    })

    # the catch: the trailing leg comes under her and the coil unwinds
    catch = dict(n)
    catch.update({
        "hips": (10.0, 0.0, -6.0), "spine": (6.0, -4.0, -3.0),
        "chest": (4.0, -8.0, -2.0), "neck": (-2.0, 8.0, 0.0),
        "head": (-4.0, 12.0, 0.0),
        "upperarm.R": (-14.0, 0.0, -12.0), "forearm.R": (64.0, 0.0, 0.0),
        "upperarm.L": (-10.0, 0.0, 20.0), "forearm.L": (44.0, 0.0, 0.0),
        "thigh.L": (24.0, 0.0, 8.0), "shin.L": (-38.0, 0.0, 0.0),
        "foot.L": (12.0, 0.0, 0.0),
        "thigh.R": (-6.0, 0.0, -10.0), "shin.R": (-14.0, 0.0, 0.0),
        "foot.R": (8.0, 0.0, 0.0),
    })

    # i-frames run 0.05 s -> 0.28 s == frames 1.2 to 6.7, so the skim has to be
    # unmistakably the middle of the move and not its beginning
    for f, p, loc in [
        (0,  n,     (0.0, 0.000, 0.000)),
        (2,  coil,  (0.0, 0.030, -0.075)),
        (5,  skim,  (0.0, 0.010, -0.115)),
        (8,  skim,  (0.0, -0.010, -0.100)),
        (13, catch, (0.0, 0.000, -0.040)),
        (20, n,     (0.0, 0.000, 0.000)),
    ]:
        _key(rig, f, p, loc={"hips": loc})
    K.interp(act)
    return act


def anim_hurt(rig, weapon=True):
    """Taking one.

    Half of every exchange had no weight at all: an enemy could land a third of
    the player's health and the character would not visibly acknowledge it and
    would keep swinging.  This is the missing half.

    It is a SHORT clip on purpose -- 0.35 s, because a long stagger in a game
    with a swarm enemy is a death sentence you cannot answer.  The read has to
    come from the shape rather than from the duration: chest caves away from the
    hit, shoulders come up and in, head snaps back and down, weapon arm flies
    out and loses its guard, and the back foot skids to catch the weight.
    Then it recovers on its own, because being able to act again is the point.
    """
    act = K.action(rig, "hurt")
    n = _neutral(weapon)

    snap = dict(n)
    snap.update({
        "hips": (-14.0, 0.0, 8.0), "spine": (-16.0, 0.0, 6.0),
        "chest": (-22.0, -6.0, 4.0), "neck": (14.0, 0.0, -6.0),
        "head": (22.0, -8.0, -8.0),
        "shoulder.R": (-14.0, 0.0, -10.0),
        "upperarm.R": (-38.0, 0.0, -34.0), "forearm.R": (58.0, 0.0, 0.0),
        "hand.R": (-24.0, 0.0, 0.0),
        "upperarm.L": (-30.0, 0.0, 44.0), "forearm.L": (40.0, 0.0, 0.0),
        "thigh.L": (-26.0, 0.0, 6.0), "shin.L": (34.0, 0.0, 0.0),
        "foot.L": (-16.0, 0.0, 0.0),
        "thigh.R": (18.0, 0.0, -8.0), "shin.R": (-40.0, 0.0, 0.0),
        "foot.R": (20.0, 0.0, 0.0),
    })

    # the catch: weight goes onto the back foot and the guard starts to come back
    catch = dict(n)
    catch.update({
        "hips": (-6.0, 0.0, 4.0), "spine": (-7.0, 0.0, 3.0),
        "chest": (-10.0, -3.0, 2.0), "neck": (6.0, 0.0, -3.0),
        "head": (10.0, -4.0, -4.0),
        "upperarm.R": (-18.0, 0.0, -16.0), "forearm.R": (48.0, 0.0, 0.0),
        "upperarm.L": (-16.0, 0.0, 26.0), "forearm.L": (36.0, 0.0, 0.0),
        "thigh.L": (-12.0, 0.0, 4.0), "shin.L": (16.0, 0.0, 0.0),
        "thigh.R": (8.0, 0.0, -5.0), "shin.R": (-22.0, 0.0, 0.0),
    })

    for f, p, loc in [
        (0, n,     (0.0,  0.000, 0.000)),
        (2, snap,  (0.0,  0.075, -0.045)),   # thrown back and down
        (5, snap,  (0.0,  0.090, -0.040)),
        (9, catch, (0.0,  0.045, -0.015)),
        (17, n,    (0.0,  0.000, 0.000)),
    ]:
        _key(rig, f, p, loc={"hips": loc})
    K.interp(act)
    return act


# ------------------------------------------------------------------- magic
#
# A CAST IS NOT A SWING, and the difference is where the time goes.  A swing
# spends its frames travelling: the interesting part is the blade crossing the
# arc, and the pose either side of contact is just approach and decay.  A cast
# spends its frames HELD.  The spell is the effect, the character's job is to
# commit to a shape and stay in it long enough for the effect to read, and the
# whole clip is built around a pose that does not move.
#
# So the feet stay planted.  A swing lunges -- every attack in this file carries
# real hip translation and the runtime gets forward motion out of it for free.
# A caster who slides forward looks like they are being pushed, so `cast`
# defaults to travel that barely moves and spends its budget on the torso.

# Planted: a few centimetres of settle and recoil, no ground covered.
PLANTED = ((0.0, -0.008, 0.000),
           (0.0, -0.030, -0.020),
           (0.0, -0.014, 0.045),
           (0.0, -0.020, 0.030),
           (0.0, -0.008, 0.000))


def cast(rig, name, *, gather, release, hold=None, timing, travel=PLANTED,
         weapon=True, base=None):
    """A spell, as four beats: gather, release, HOLD, recover.

    Same five keys as `swing` and deliberately a separate function, because the
    THIRD key means something different.  In a swing it is a follow-through
    decaying towards neutral; here it is the pose the character is stuck in
    while the spell happens, and it is the longest beat in the clip.  Calling it
    `settle` and reusing `swing` would have hidden that -- and the timing is the
    part a spell gets wrong first.
    """
    n = base if base is not None else _neutral(weapon)
    p_gather = {**n, **gather}
    p_release = {**n, **release}
    p_hold = {**p_release, **(hold or {})}
    return clip(rig, name, list(zip(timing, [n, p_gather, p_release, p_hold, n],
                                    travel)))


def anim_cast_fire(rig, weapon=True):
    """FIRE: a straight thrust down the centre line.

    The most aggressive of the three and the shortest -- it is the spell you
    cast in someone's face.  The elbow folds to the ribs and snaps out, so the
    silhouette from the side is one hard horizontal line.

    +90 on the upper arm is horizontal FORWARD (measured: elev -1.4, fwd 0.69).
    Written -88 first, reasoning that the wind-up of anim_attack sits at -128
    and is "up behind the head" -- so negative must be up.  Negative is up and
    BEHIND: -90 reaches 0.48 m backwards.  The thrust pointed out of the back of
    the character, and from three-quarter it just looked like she was standing
    still.  tools/pose_probe.py exists because of this.
    """
    return cast(
        rig, "cast_fire", weapon=weapon,
        gather={
            "hips": (-4.0, -10.0, 0.0), "spine": (-2.0, -8.0, 0.0),
            "chest": (-6.0, -14.0, 0.0), "neck": (2.0, 6.0, 0.0),
            "head": (2.0, 8.0, 0.0),
            "shoulder.R": (-6.0, 0.0, 10.0),
            # cocked AT THE SHOULDER, elbow folded to the ribs, so the release
            # is a punch and not a swing -- a bent arm that straightens reads
            # as thrust
            "upperarm.R": (-15.0, 0.0, 16.0), "forearm.R": (86.0, 0.0, 0.0),
            "hand.R": (-30.0, 0.0, 0.0),
            "upperarm.L": (-10.0, 0.0, -14.0), "forearm.L": (46.0, 0.0, 0.0),
            "thigh.L": (-10.0, 0.0, 4.0), "shin.L": (14.0, 0.0, 0.0),
            "foot.L": (-4.0, 0.0, 0.0),
            "thigh.R": (12.0, 0.0, -6.0), "shin.R": (-16.0, 0.0, 0.0),
            "foot.R": (8.0, 0.0, 0.0),
        },
        release={
            "hips": (8.0, 12.0, 0.0), "spine": (8.0, 10.0, 0.0),
            # +Y twist brings the RIGHT shoulder forward -- the same sign
            # anim_attack's strike uses to follow a right-handed swing through
            "chest": (12.0, 20.0, 0.0), "neck": (-6.0, -8.0, 0.0),
            "head": (-8.0, -10.0, 0.0),
            "shoulder.R": (8.0, 0.0, -8.0),
            "upperarm.R": (90.0, 0.0, 0.0), "forearm.R": (6.0, 0.0, 0.0),
            "hand.R": (10.0, 0.0, 0.0),
            # left arm drives BACK as the right goes out, or the thrust has
            # nothing to push against
            "upperarm.L": (-30.0, 0.0, -20.0), "forearm.L": (58.0, 0.0, 0.0),
            "thigh.L": (30.0, 0.0, 4.0), "shin.L": (-26.0, 0.0, 0.0),
            "foot.L": (10.0, 0.0, 0.0),
            "thigh.R": (-20.0, 0.0, -6.0), "shin.R": (-20.0, 0.0, 0.0),
            "foot.R": (14.0, 0.0, 0.0),
        },
        hold={
            "chest": (10.0, 16.0, 0.0), "head": (-4.0, -6.0, 0.0),
            "upperarm.R": (84.0, 0.0, 0.0), "forearm.R": (14.0, 0.0, 0.0),
        },
        timing=(0, 5, 9, 20, 32),
    )


def anim_cast_ice(rig, weapon=True):
    """BLIZZARD: a wide sweep that ends with the arm straight out to the side.

    Where fire is a line down the centre, this is a line ACROSS -- it starts
    folded over the chest and opens all the way out, so the two spells cannot be
    confused at any distance.  Same argument as hit 2 against hit 1: two effects
    that share a silhouette are one effect.

    NEAR REST the module docstring holds and is what these numbers use: +Z
    carries the RIGHT arm across the body, -Z opens it out (measured at X=0,
    Z=-70: lat 0.67, elev 0.8).  That convention is only good near rest -- see
    anim_cast_cure, which is nowhere near it.
    """
    return cast(
        rig, "cast_ice", weapon=weapon,
        gather={
            "hips": (2.0, 16.0, 0.0), "spine": (2.0, 14.0, 0.0),
            "chest": (4.0, 24.0, 0.0), "neck": (-2.0, -10.0, 0.0),
            "head": (-4.0, -14.0, 0.0),
            "shoulder.R": (2.0, 0.0, -4.0),
            "upperarm.R": (15.0, 0.0, 45.0), "forearm.R": (60.0, 0.0, 0.0),
            "hand.R": (-36.0, 0.0, 0.0),
            "upperarm.L": (14.0, 0.0, 18.0), "forearm.L": (40.0, 0.0, 0.0),
            "thigh.L": (12.0, 0.0, 4.0), "shin.L": (-18.0, 0.0, 0.0),
            "thigh.R": (-6.0, 0.0, -6.0), "shin.R": (-14.0, 0.0, 0.0),
        },
        release={
            "hips": (-4.0, -18.0, 0.0), "spine": (-3.0, -16.0, 0.0),
            "chest": (-6.0, -28.0, 0.0), "neck": (3.0, 10.0, 0.0),
            "head": (5.0, 14.0, 0.0),
            "shoulder.R": (-8.0, 0.0, 8.0),
            "upperarm.R": (5.0, 0.0, -66.0), "forearm.R": (14.0, 0.0, 0.0),
            "hand.R": (4.0, 0.0, 0.0),
            "upperarm.L": (-16.0, 0.0, -26.0), "forearm.L": (38.0, 0.0, 0.0),
            "thigh.L": (-12.0, 0.0, 4.0), "shin.L": (-6.0, 0.0, 0.0),
            "thigh.R": (22.0, 0.0, -6.0), "shin.R": (-30.0, 0.0, 0.0),
            "foot.R": (10.0, 0.0, 0.0),
        },
        hold={
            "chest": (-4.0, -22.0, 0.0),
            "upperarm.R": (0.0, 0.0, -58.0), "forearm.R": (20.0, 0.0, 0.0),
        },
        timing=(0, 6, 11, 24, 38),
    )


def anim_cast_cure(rig, weapon=True):
    """CURE: both arms open overhead, and the only one of the three not aimed at
    anybody.

    Support magic has to read as support from behind, at a glance, while the
    player is looking at something else -- so it is the one cast that is
    symmetrical, that opens the chest instead of closing it, and that looks UP.
    It is also the slowest: nothing about being healed should feel like a jab.

    THE ARMS GO UP THE FRONT, and both halves of that matter.

    +180 and -180 are the same pose, and -180 measures marginally better, but
    the number here is not a pose -- it is the END of an interpolation that
    starts near zero.  Going negative takes the arms up BEHIND the back through
    -90 and lands the same place having done a backward windmill.  Positive
    passes through +90, which is a person raising their arms.

    The Z signs are the ones the module docstring warns about, INVERTED, and
    that is not a mistake: rotations are XYZ euler, so Z is applied in a frame X
    has already turned most of the way over.  Measured at X=+180, the left arm
    opens outward on -30 and the right on +30 -- the exact opposite of the rule
    at rest.  Written the other way the arms cross overhead.
    """
    return cast(
        rig, "cast_cure", weapon=weapon,
        gather={
            "hips": (8.0, 0.0, 0.0), "spine": (6.0, 0.0, 0.0),
            "chest": (8.0, 0.0, 0.0), "neck": (-6.0, 0.0, 0.0),
            "head": (10.0, 0.0, 0.0),
            # drawn down and IN across the body: near rest, -Z closes the left
            # arm and +Z closes the right
            "shoulder.L": (0.0, 0.0, -8.0), "shoulder.R": (0.0, 0.0, 8.0),
            "upperarm.L": (20.0, 0.0, -16.0), "forearm.L": (50.0, 0.0, 0.0),
            "upperarm.R": (20.0, 0.0, 16.0), "forearm.R": (50.0, 0.0, 0.0),
            "hand.L": (-14.0, 0.0, 0.0), "hand.R": (-14.0, 0.0, 0.0),
            "thigh.L": (22.0, 0.0, 3.0), "shin.L": (-34.0, 0.0, 0.0),
            "foot.L": (14.0, 0.0, 0.0),
            "thigh.R": (22.0, 0.0, -3.0), "shin.R": (-34.0, 0.0, 0.0),
            "foot.R": (14.0, 0.0, 0.0),
        },
        release={
            "hips": (-6.0, 0.0, 0.0), "spine": (-6.0, 0.0, 0.0),
            "chest": (-12.0, 0.0, 0.0), "neck": (8.0, 0.0, 0.0),
            "head": (12.0, 0.0, 0.0),
            "shoulder.L": (0.0, 0.0, -14.0), "shoulder.R": (0.0, 0.0, 14.0),
            # measured: elev 77.4 / 77.5, lateral 0.15 both sides, symmetric to
            # a tenth of a degree
            "upperarm.L": (180.0, 0.0, -30.0), "forearm.L": (16.0, 0.0, 0.0),
            "upperarm.R": (180.0, 0.0, 30.0), "forearm.R": (16.0, 0.0, 0.0),
            "hand.L": (10.0, 0.0, 0.0), "hand.R": (10.0, 0.0, 0.0),
            "thigh.L": (-6.0, 0.0, 3.0), "shin.L": (-4.0, 0.0, 0.0),
            "foot.L": (2.0, 0.0, 0.0),
            "thigh.R": (-6.0, 0.0, -3.0), "shin.R": (-4.0, 0.0, 0.0),
            "foot.R": (2.0, 0.0, 0.0),
        },
        hold={
            "chest": (-10.0, 0.0, 0.0), "head": (10.0, 0.0, 0.0),
            "upperarm.L": (168.0, 0.0, -28.0),
            "upperarm.R": (168.0, 0.0, 28.0),
        },
        # the slowest of the three, and the longest hold
        timing=(0, 8, 14, 32, 48),
        travel=((0.0, -0.008, 0.000),
                (0.0, -0.055, -0.010),   # sink to gather
                (0.0, 0.020, 0.005),     # rise onto the open pose
                (0.0, 0.014, 0.000),
                (0.0, -0.008, 0.000)),
    )


# ------------------------------------------------------------------ the set
#
# WHAT "THE LIBRARY" IS, in one place.  char_build listed the clips to author
# and then listed them AGAIN to verify the export, which is rule (r) with the
# two copies four lines apart -- and it meant adding a spell to this file did
# not add it to any character, silently, because the list that decides what
# gets built lived somewhere else entirely.

def library(only=None):
    """Every clip in this module, as [(function name, function), ...].

    `only` names a subset, by function name, for previewing or for a character
    that should not have the whole set.
    """
    names = ([n for n in globals() if n.startswith("anim_")]
             if not only else list(only))
    out = []
    for n in sorted(names):
        fn = globals().get(n)
        if not callable(fn):
            raise SystemExit(f"anim_lib has no clip {n!r}")
        out.append((n, fn))
    return out


def clip_names(only=None):
    """The names the CLIPS get, which is the function name without `anim_`."""
    return [n.removeprefix("anim_") for n, _ in library(only)]
