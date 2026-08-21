"""weapon_lib -- weapons as parameters, not as models.

A weapon is close to the ideal procedural subject: a blade is a tapered tube, a
haft is a straight one, a guard is a bar and two blobs.  `props.sword` proved
that in about fifty lines.  What it could not do is be a DIFFERENT sword --
every character carried the same one, because the shape was the code.

Everything here is built in ONE canonical frame, the same one `props.sword`
uses and `props.place_in_hand` expects:

    grip at the ORIGIN, blade running down -Z, blade WIDTH along X.

So a weapon knows nothing about hands, characters or scale, and the single
piece of code that puts a prop into a fist stays the single piece of code that
puts a prop into a fist.

WHAT ACTUALLY DISTINGUISHES A WEAPON HERE IS SILHOUETTE.  These are drawn
through a toon ramp at four to six metres; surface detail is gone at that
distance and so is most of the colour.  Length, taper, guard span and pommel
mass survive.  So the parameters below are the ones that change the outline,
and the ones that would only change the shading are not parameters at all.
"""
import math

from mathutils import Vector

import geo_lib as K

# Bone every part is weighted to.  Standalone weapons are exported without an
# armature and the groups are stripped, but the primitives want a name.
BONE = "hand.R"


def palette():
    """Deliberately wider than props.palette(): three weapons that differ only
    in shape read as one weapon at play distance.  Metal COLOUR is the second
    silhouette."""
    return {
        # a plain, slightly warm grey -- village iron, not a hero's sword
        "iron":    K.material("iron", (0.62, 0.62, 0.60), roughness=0.55, metallic=0.6),
        "steel":   K.material("steel", (0.72, 0.76, 0.82), roughness=0.35, metallic=0.8),
        # cold and bright, and the only blade colour with any blue in it
        "bluesteel": K.material("bluesteel", (0.68, 0.79, 0.92), roughness=0.22,
                                metallic=0.9),
        "brass":   K.material("brass", (0.86, 0.68, 0.30), roughness=0.40, metallic=0.7),
        "darkiron": K.material("darkiron", (0.34, 0.34, 0.37), roughness=0.6,
                               metallic=0.5),
        "leather": K.material("leather", (0.32, 0.20, 0.14), roughness=0.85),
        "wrap":    K.material("wrap", (0.24, 0.28, 0.34), roughness=0.9),
        "wood":    K.material("wood", (0.44, 0.31, 0.19), roughness=0.9),
        "jewel":   K.material("jewel", (0.24, 0.55, 0.62), roughness=0.25,
                              emission=0.35),
    }


# --------------------------------------------------------------------- parts

def blade(name, length, width, thick, mat, taper=0.72, shoulder=0.10,
          point=0.09, squircle=3.0):
    """A tapered blade from `shoulder` to `length` down -Z.

    `taper` is the fraction of the starting width left at the point end before
    the tip is drawn, and it is the parameter that decides whether something
    reads as a sword or as a spike.
    """
    W = {BONE: 1.0}
    z0, z1 = -shoulder, -(length - point)
    sections = [
        {"p": Vector((0, 0, z0)), "r": (width, thick), "w": W, "n": squircle},
        {"p": Vector((0, 0, z0 - (z0 - z1) * 0.08)),
         "r": (width * 1.04, thick * 1.05), "w": W, "n": squircle},
        {"p": Vector((0, 0, z1)), "r": (width * taper, thick * taper), "w": W,
         "n": squircle},
        {"p": Vector((0, 0, -length)), "r": 0.0, "w": W, "n": squircle},
    ]
    return K.tube(name, sections, seg=10, mat=mat, squircle=squircle, up=(0, 1, 0))


def fuller(name, length, width, mat, start=0.18, squircle=2.4):
    """The groove down a blade, as a shallow inset strip.  Pure decoration at
    distance -- it is here because it is nearly free and it breaks up a broad
    blade in the near camera."""
    W = {BONE: 1.0}
    sections = [
        {"p": Vector((0, 0, -start)), "r": (width, width), "w": W, "n": squircle},
        {"p": Vector((0, 0, -length)), "r": (width * 0.82, width * 0.9), "w": W,
         "n": squircle},
    ]
    return K.tube(name, K.dome(sections, at="both", steps=2, height=width * 0.8),
                  seg=8, mat=mat, squircle=squircle, up=(0, 1, 0))


def guard(name, style, span, mat, z=-0.095, thick=0.018, sweep=0.0):
    """The crossbar.  `style` picks the outline; `span` is half-width.

    THE GUARD IS THE MOST LEGIBLE PART OF A SWORD at distance, because it is
    the only horizontal in an otherwise vertical object.  Changing it changes
    the weapon more than changing the blade does.
    """
    out = []
    if style == "none":
        return out
    if style == "disc":
        out.append(K.blob(f"{name}_disc", (0, 0, z), (span, span * 0.55, thick),
                          BONE, mat, seg=14, rings=8, squircle=2.6))
        return out
    if style == "swept":
        # A SWEPT GUARD IS A CURVE, and it has to be built as one.  The first
        # version was the straight bar below with blobs stuck on the ends and
        # halfway along, hoping they would read as a sweep; at rack distance
        # they read as a bar with lumps on it.  A tube whose sections arc
        # toward the blade is the same cost and is actually the shape.
        W = {BONE: 1.0}
        n = 9
        sections = []
        for i in range(n):
            t = -1.0 + 2.0 * i / (n - 1)
            r = thick * (1.35 - 0.55 * t * t)      # thick at the middle, fine at the tips
            sections.append({"p": Vector((t * span, 0.0, z - sweep * t * t)),
                             "r": (r, r * 0.85), "w": W, "n": 2.4})
        out.append(K.tube(f"{name}_sweep", K.dome(sections, at="both", steps=2,
                                                  height=thick * 0.9),
                          seg=8, mat=mat, squircle=2.4, up=(0, 0, 1)))
        return out

    # a bar across, for every style that has one
    out.append(K.rounded_box(f"{name}_bar", (0, 0, z),
                             (span, thick, thick * 0.9), thick * 0.45,
                             BONE, mat, segments=2))
    if style == "cross":
        return out
    if style == "quillon":
        for sx in (-1, 1):
            out.append(K.blob(f"{name}_tip", (sx * span, 0, z),
                              (thick * 1.3, thick * 1.4, thick * 1.4),
                              BONE, mat, seg=10, rings=8, squircle=2.4))
    return out


def grip(name, length, radius, mat, z0=-0.075, squircle=2.6):
    W = {BONE: 1.0}
    sections = [
        {"p": Vector((0, 0, z0)), "r": (radius, radius * 0.86), "w": W, "n": squircle},
        {"p": Vector((0, 0, z0 + length)), "r": (radius * 0.95, radius * 0.82),
         "w": W, "n": squircle},
    ]
    return K.tube(name, K.dome(sections, at="both", steps=2, height=radius * 0.7),
                  seg=10, mat=mat, squircle=squircle, up=(0, 1, 0))


def pommel(name, style, size, mat, z=0.075):
    if style == "none":
        return []
    if style == "disc":
        return [K.blob(f"{name}_pommel", (0, 0, z), (size * 1.5, size * 1.4, size * 0.6),
                       BONE, mat, seg=14, rings=8, squircle=2.4)]
    if style == "jewel":
        return [K.blob(f"{name}_pommel", (0, 0, z), (size, size, size),
                       BONE, mat, seg=12, rings=9, squircle=2.3)]
    # "round"
    return [K.blob(f"{name}_pommel", (0, 0, z), (size, size * 0.94, size * 0.88),
                   BONE, mat, seg=12, rings=9, squircle=2.3)]


# ------------------------------------------------------------------- classes

def sword(name="sword", *, length=0.76, width=0.030, thick=0.010, taper=0.72,
          guard_style="cross", guard_span=0.105, guard_sweep=0.0,
          grip_len=0.130, grip_radius=0.019, pommel_style="round",
          pommel_size=0.030, blade_mat="steel", metal_mat="brass",
          grip_mat="leather", fuller_mat=None, mats=None, scale=1.0):
    """One-handed straight sword, in the canonical grip-at-origin frame."""
    M = mats or palette()
    s = scale
    out = [blade(f"{name}_blade", length * s, width * s, thick * s,
                 M[blade_mat], taper=taper)]
    if fuller_mat:
        out.append(fuller(f"{name}_fuller", length * s * 0.79, width * s * 0.38,
                          M[fuller_mat]))
    out += guard(f"{name}_guard", guard_style, guard_span * s, M[metal_mat],
                 sweep=guard_sweep * s)
    out.append(grip(f"{name}_grip", grip_len * s, grip_radius * s, M[grip_mat]))
    out += pommel(f"{name}_pommel", pommel_style, pommel_size * s, M[metal_mat])
    return [o for o in out if o]


# The three weapons already in items.json, which until now were three stat
# blocks wearing the same model.  They escalate in LENGTH and in guard mass,
# because those are the two things still visible at play distance, and each
# one changes metal colour so the difference survives a toon ramp.
CATALOGUE = {
    "town-blade": dict(
        # short, blunt-shouldered, village iron.  The starter weapon should look
        # like something a town owns rather than something a hero was given.
        length=0.66, width=0.028, thick=0.010, taper=0.66,
        guard_style="cross", guard_span=0.086, grip_len=0.120,
        pommel_style="round", pommel_size=0.026,
        blade_mat="iron", metal_mat="darkiron", grip_mat="leather"),
    "smiths-edge": dict(
        # a working smith's sword: longer, a real fuller, quillons on the guard
        length=0.80, width=0.032, thick=0.011, taper=0.74,
        guard_style="quillon", guard_span=0.112, grip_len=0.132,
        pommel_style="disc", pommel_size=0.028,
        blade_mat="steel", metal_mat="brass", grip_mat="leather",
        fuller_mat="brass"),
    "river-steel": dict(
        # the expensive one, and the only cold-coloured blade in the game
        length=0.90, width=0.034, thick=0.010, taper=0.80,
        guard_style="swept", guard_span=0.125, guard_sweep=0.045,
        grip_len=0.140, grip_radius=0.018,
        pommel_style="jewel", pommel_size=0.030,
        blade_mat="bluesteel", metal_mat="brass", grip_mat="wrap",
        fuller_mat="bluesteel"),
}


def build(item_id, mats=None, scale=1.0):
    if item_id not in CATALOGUE:
        raise SystemExit(f"[weapon] unknown weapon {item_id!r}; "
                         f"know {sorted(CATALOGUE)}")
    return sword(item_id.replace("-", "_"), mats=mats, scale=scale,
                 **CATALOGUE[item_id])
