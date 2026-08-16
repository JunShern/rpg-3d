"""creature_lib -- generated enemies whose TELEGRAPH IS THEIR SILHOUETTE.

The design constraint here is also the opportunity.  Because the geometry is
generated rather than sculpted, a creature's tell can be a shape change: spines
that flare, a body that inflates, a shell that curls.  Those read clear across a
field at a glance, cost nothing to author when the mesh is parametric, and are
not how the reference game telegraphs (which is almost entirely wind-up poses).

Every creature is built the same way as the cast: analytic geometry, weights
authored with the mesh, one bone per moving part, and clips that are bone-keyed
pose data.  Shared conventions from kh_lib apply -- +Z up, -Y is the direction
the creature FACES, and every bone rolls so +X is forward flexion.

Clip vocabulary, identical across every creature so the runtime never
special-cases a species:

    idle       resting loop
    move       locomotion loop
    telegraph  the shape change, held at the end (clamped)
    attack     the commitment
    recover    the punish window after a whiffed or landed attack
    hurt       reaction
    die        collapse
"""
import math

from mathutils import Vector

import kh_lib as K

TAU = math.tau


def palette(spec):
    return {k: K.material(k, v[0], roughness=v[1] if len(v) > 1 else 0.7,
                          emission=v[2] if len(v) > 2 else 0.0)
            for k, v in spec.items()}


def radial(n, start=0.0):
    """n evenly spaced azimuths, in radians."""
    return [start + TAU * i / n for i in range(n)]


def spine(name, base, direction, length, base_r, bone, mat, curve=0.0,
          seg=8, up=(0, 0, 1)):
    """A tapered spike from `base` along `direction`, sagging by `curve`."""
    d = Vector(direction).normalized()
    sag = Vector((0, 0, -1)) * curve * length

    def at(t):
        return Vector(base) + d * (length * t) + sag * (t * t)

    sec = [
        {"p": at(0.00), "r": (base_r, base_r * 0.9), "w": {bone: 1.0}, "n": 2.6},
        {"p": at(0.45), "r": (base_r * 0.62, base_r * 0.55), "w": {bone: 1.0}, "n": 2.6},
        {"p": at(0.78), "r": (base_r * 0.30, base_r * 0.26), "w": {bone: 1.0}, "n": 2.6},
        {"p": at(1.00), "r": 0.0, "w": {bone: 1.0}, "n": 2.6},
    ]
    return K.tube(name, sec, seg=seg, mat=mat, squircle=2.6, up=up)


def leg(name, hip, foot, bone, mat, r=0.030, seg=8):
    """A stubby limb: one bone, hip to foot, with a rounded end."""
    sec = K.dome([
        {"p": Vector(hip), "r": (r, r), "w": {bone: 1.0}, "n": 2.4},
        {"p": Vector(hip).lerp(Vector(foot), 0.55), "r": (r * 0.88, r * 0.88),
         "w": {bone: 1.0}, "n": 2.4},
        {"p": Vector(foot), "r": (r * 0.95, r * 0.95), "w": {bone: 1.0}, "n": 2.4},
    ], at="both", steps=2, height=r * 0.9)
    return K.tube(name, sec, seg=seg, mat=mat, squircle=2.4)


def eyes(name, centre, offset, size, bone, mat, glow=None):
    """A symmetric pair.  Enemy eyes are UNLIT in the runtime, so they stay
    legible when the body falls into the shadow band -- an enemy you cannot
    read the facing of is an enemy you cannot fight."""
    out = []
    for sx in (-1, 1):
        c = (centre[0] + sx * offset, centre[1], centre[2])
        out.append(K.blob(f"{name}{'L' if sx > 0 else 'R'}", c, size, bone,
                          glow or mat, seg=12, rings=9, squircle=2.1))
    return out


def finish(parts, rig, name):
    """Join, bind, and refuse to ship an unweighted vertex."""
    body = K.bind(parts, rig, name=name)
    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    print(f"[{name}] {len(body.data.vertices)} verts, {tris} tris, "
          f"{len(rig.data.bones)} bones, {len(body.data.materials)} materials")
    return body
