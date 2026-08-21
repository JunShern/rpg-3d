"""props -- hand-held gear, generated the same way everything else is.

A prop is built in its OWN frame -- grip at the origin, blade running down -Z --
and then rotated into the hand as a finished assembly.  Building it already
tilted is the mistake the sword made first: bevelled boxes are axis-aligned,
so a guard built directly on an angled blade comes out skewed and its loop never
closes.

Everything returned is weighted 100% to one bone, which is the right call for a
held object: rigid binding to the hand is not a compromise, it is what holding
something IS.
"""
import math

from mathutils import Matrix, Vector

import geo_lib as K


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


def place_in_hand(objs, rig, bone="hand.R", along=0.48, tweak=(0.0, 0.0, 0.0)):
    """Place a grip-at-origin prop into the LOCAL FRAME OF THE HAND BONE.

    This has to be done in bone space, not world space.  The first version aimed
    the blade by blending world-space directions at bind time, which bakes one
    pose's answer into a rigidly-parented object: the sword then sat at a
    plausible angle while standing and a strange one through every swing,
    because it was never actually oriented BY the hand.

    It also used `rotation_difference`, which returns the minimal rotation and
    therefore leaves the ROLL about the blade unspecified -- so which way the
    edge faced was arbitrary, and the flat of the blade could lead the swing.

    Bone space (geo_lib convention): +Y runs along the bone, +Z is forward.
    So the mapping is chosen deliberately:

        canonical -Z (the blade)  ->  bone +Y   blade continues the hand
        canonical +X (blade WIDTH) ->  bone +Z   width lies in the swing plane,
                                                 so the EDGE leads, not the flat

    `along` slides the grip up the bone into the fist; `tweak` is euler degrees
    in bone space for dialling the wrist angle by eye.
    """
    b = rig.data.bones[bone]

    # columns are the images of the canonical axes, expressed in bone space
    basis = Matrix(((0.0, -1.0, 0.0),
                    (0.0, 0.0, -1.0),
                    (1.0, 0.0, 0.0))).to_4x4()

    adjust = (Matrix.Rotation(math.radians(tweak[0]), 4, 'X')
              @ Matrix.Rotation(math.radians(tweak[1]), 4, 'Y')
              @ Matrix.Rotation(math.radians(tweak[2]), 4, 'Z'))

    m = (b.matrix_local
         @ Matrix.Translation((0.0, b.length * along, 0.0))
         @ adjust
         @ basis)
    for o in objs:
        K.transform(o, matrix=m)
    return objs


# The weapons a character can be built holding.  One entry today, and it is a
# registry rather than an `if` because "not everyone is a sword wielder" is the
# whole point of taking the blade out of the body: adding a staff or an axe
# should be a row here and a builder beside `sword`, not a change to char_build.
WEAPONS = {"sword": sword}


def attach_to_bone(objs, rig, bone="hand.R", name="weapon"):
    """Join prop parts into ONE object that RIDES a bone instead of being part
    of the body.

    Why this exists.  The sword used to be joined into the skinned mesh and the
    comment said the runtime then "treats the sword as just another material on
    the character".  That is true and it is also the end of the road: geometry
    welded into a body can only ever go where the body's skin goes.  It cannot
    be thrown, dropped, sheathed, swapped for an axe, or left off a character
    who should not be armed -- and the last of those is not a hypothetical,
    because every townsperson built armed was standing in the square gripping a
    sword.

    Parented to the bone rather than SKINNED to it, deliberately.  A one-bone
    skin follows the hand and is rigid in every way that matters, but it is
    welded to the skeleton, and detaching it mid-animation means unbinding a
    SkinnedMesh.  A plain mesh under the bone node is a scene-graph child: in
    three.js `scene.attach(weapon)` takes it off the hand keeping its world
    transform, and `bone.attach(weapon)` puts it back.  That is the difference
    between a weapon you can throw and one you can only hide.

    THE PARENT INVERSE IS THE WHOLE TRICK.  `K.transform` bakes placement into
    mesh data and leaves the object transform identity, so the vertices already
    sit in the right place in armature space.  Parenting alone would then apply
    the bone's matrix a SECOND time.  `matrix_parent_inverse` cancels the bone's
    rest matrix, so rest stays exactly where `place_in_hand` put it and motion
    follows the bone.  Blender parents to the bone's TAIL, hence the extra
    length translation -- parenting to the head puts the grip one bone-length
    out of the fist, which looks like a near miss rather than a bug.
    """
    obj = K.join(objs, name)
    if obj is None:
        return None
    b = rig.data.bones[bone]
    parent_m = (rig.matrix_world @ b.matrix_local
                @ Matrix.Translation((0.0, b.length, 0.0)))
    obj.parent = rig
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    obj.matrix_parent_inverse = parent_m.inverted()
    # the prop is its own object now, so it must not also be skinned
    obj.modifiers.clear()
    obj.vertex_groups.clear()
    return obj
