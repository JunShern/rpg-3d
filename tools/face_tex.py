"""face_tex -- the hero's face, drawn as an image instead of built as geometry.

WHY A TEXTURE.  The first two faces were geometry: a white ellipsoid per eye
with an iris ellipsoid on top, a bar for a brow, a blob for a mouth.  Every one
of them sat PROUD of the skull, so the face read as parts glued to a ball --
googly eyes and a caterpillar brow.  That is not a tuning problem, it is what
sub-centimetre features made of separate closed solids look like.

Stylised 3D solves this by painting the face, and it suits this project
particularly well: the style call was vinyl-toy, and a vinyl toy's face is
printed.  It also buys expressions almost free later -- swap the image, keep the
mesh.

The image is drawn in the UV space of a face DECAL that conforms to the skull
(see `build_face_plate` in hero_build), so coordinates here are the decal's
bounding box in world units:

    u = (x + 0.150) / 0.300        x from -0.150 to 0.150
    v = (z - 1.416) / 0.284        z from  1.416 to 1.700

Anti-aliasing is by supersampling: everything is drawn at SS times resolution
and box-filtered down. Nothing here needs a drawing library.
"""
import numpy as np

# the decal's world-space bounding box
X0, X1 = -0.150, 0.150
Z0, Z1 = 1.416, 1.700


def _u(x):
    return (x - X0) / (X1 - X0)


def _v(z):
    return (z - Z0) / (Z1 - Z0)


SKIN = np.array([0.98, 0.76, 0.62])
SCLERA = np.array([0.99, 0.99, 0.99])
SCLERA_SHADE = np.array([0.80, 0.84, 0.90])
IRIS_HI = np.array([0.30, 0.70, 0.95])
IRIS_LO = np.array([0.06, 0.30, 0.62])
PUPIL = np.array([0.06, 0.05, 0.09])
LASH = np.array([0.13, 0.09, 0.13])
BROW = np.array([0.26, 0.13, 0.07])
MOUTH = np.array([0.44, 0.20, 0.20])
BLUSH = np.array([0.97, 0.60, 0.52])


def _over(dst, mask, color):
    """Alpha-composite a flat colour using `mask` (0..1) as coverage."""
    m = mask[..., None]
    return dst * (1.0 - m) + np.asarray(color) * m


def _soft(d, w):
    """Coverage from a signed distance: >0 inside. `w` is the softening width."""
    return np.clip(d / w + 0.5, 0.0, 1.0)


def _ellipse(U, V, cx, cy, rx, ry, w=0.004):
    return _soft(1.0 - np.sqrt(((U - cx) / rx) ** 2 + ((V - cy) / ry) ** 2), w / rx)


def _eye(rgb, U, V, cx, cy, rx, ry, flip, w):
    """One anime eye: almond sclera, graded iris, pupil, catchlight, lash.

    The almond is built from two different curves -- a tall, softly-powered
    upper lid and a shallow, sharply-powered lower lid -- which is what puts the
    points in the corners.  A plain ellipse reads as a frog.
    """
    t = (U - cx) / rx                       # -1..1 across the eye
    s = np.sqrt(np.clip(1.0 - t * t, 0.0, None))
    upper = ry * s ** 0.62                  # tall, round
    lower = ry * 0.72 * s ** 1.45           # shallow, pointed
    dy = V - cy

    inside = np.minimum(_soft(upper - dy, w), _soft(dy + lower, w))
    inside = np.minimum(inside, _soft(1.0 - np.abs(t), w / rx))

    # sclera, with the upper part shaded: an eyeball is in shadow under the lid
    shade = np.clip((dy / (ry * 0.9)) * 0.5 + 0.5, 0, 1)[..., None]
    rgb = _over(rgb, inside, SCLERA)
    rgb = rgb * (1 - inside[..., None] * shade * 0.45) \
        + SCLERA_SHADE * (inside[..., None] * shade * 0.45)

    # iris: sits slightly low and toward the nose, graded dark-at-top
    ix = cx - flip * rx * 0.06
    iy = cy - ry * 0.10
    ir = ry * 0.78
    iris = np.minimum(_ellipse(U, V, ix, iy, ir, ir, 0.003), inside)
    g = np.clip((V - (iy - ir)) / (2 * ir), 0, 1)[..., None]
    rgb = _over(rgb, iris, 1.0)             # clear first, so grading is clean
    rgb = rgb * (1 - iris[..., None]) + (IRIS_LO * (1 - g) + IRIS_HI * g) * iris[..., None]
    rgb = _over(rgb, np.minimum(_ellipse(U, V, ix, iy, ir, ir, 0.003)
                                - _ellipse(U, V, ix, iy, ir * 0.80, ir * 0.80, 0.003),
                                inside).clip(0, 1) * 0.75, IRIS_LO * 0.5)
    rgb = _over(rgb, np.minimum(_ellipse(U, V, ix, iy, ir * 0.40, ir * 0.46, 0.003),
                                inside), PUPIL)

    # THE CATCHLIGHT.  One small off-centre dot; the eye is dead without it.
    rgb = _over(rgb, _ellipse(U, V, ix + flip * ir * 0.34, iy + ir * 0.40,
                              ir * 0.26, ir * 0.24, 0.002), SCLERA)
    rgb = _over(rgb, _ellipse(U, V, ix - flip * ir * 0.30, iy - ir * 0.42,
                              ir * 0.14, ir * 0.12, 0.002) * 0.5, SCLERA)

    # upper lash: a thick band on the top lid that thickens toward the outer
    # corner and overshoots it slightly -- that overshoot is the whole look
    lash_t = ry * (0.26 + 0.16 * np.clip(flip * t, 0, 1)) * s ** 0.35
    band = np.minimum(_soft(upper + lash_t - dy, w),
                      _soft(dy - (upper - lash_t * 0.25), w))
    band = np.minimum(band, _soft(1.0 - np.abs(t), w / rx))
    rgb = _over(rgb, band, LASH)

    # a light lower lid line, for the eye to sit on
    low_band = np.minimum(_soft(w * 2.2 - np.abs(dy + lower), w),
                          _soft(0.86 - np.abs(t), w / rx))
    rgb = _over(rgb, low_band * 0.5, LASH)
    return rgb


def _brow(rgb, U, V, cx, cy, flip, w):
    """A tapered, angled stroke. The inner end sits lower than the outer."""
    hw, th = 0.092, 0.017
    t = (U - cx) / hw
    tilt = -flip * 0.055 * t                        # inner end drops
    arch = -0.020 * (t * t)                         # gentle arch
    d = V - (cy + tilt + arch)
    taper = th * np.clip(1.0 - 0.85 * np.abs(t) ** 2.2, 0, 1)
    m = np.minimum(_soft(taper - np.abs(d), w), _soft(1.0 - np.abs(t), w / hw))
    return _over(rgb, m, BROW)


def build(size=768, ss=2):
    """Return an (size, size, 3) float RGB image of the face, v increasing up."""
    n = size * ss
    ax = (np.arange(n) + 0.5) / n
    U, V = np.meshgrid(ax, ax)                      # V[0] is v=0 (bottom)
    w = 1.6 / n                                     # ~2 px of softening

    rgb = np.repeat(np.repeat(SKIN[None, None, :], n, 0), n, 1).copy()

    # a little warmth on the cheeks keeps a flat skin fill from looking plastic
    for sx in (-1, 1):
        rgb = _over(rgb, _ellipse(U, V, _u(sx * 0.088), _v(1.498), 0.115, 0.075,
                                  0.05) * 0.20, BLUSH)

    eye_rx = 0.045 / (X1 - X0)
    eye_ry = 0.036 / (Z1 - Z0)
    for sx in (-1, 1):
        cx, cy = _u(sx * 0.072), _v(1.556)
        rgb = _eye(rgb, U, V, cx, cy, eye_rx, eye_ry, float(sx), w)
        rgb = _brow(rgb, U, V, _u(sx * 0.076), _v(1.614), float(sx), w)

    # mouth: a short curved stroke with a slight upturn, and a shadow under it
    t = (U - _u(0.0)) / 0.085
    curve = _v(1.470) + 0.013 * (t * t)
    m = np.minimum(_soft(0.011 * np.clip(1 - 0.7 * np.abs(t) ** 2, 0, 1)
                         - np.abs(V - curve), w),
                   _soft(1.0 - np.abs(t), w / 0.085))
    rgb = _over(rgb, m, MOUTH)

    # box-filter the supersampled buffer down
    rgb = rgb.reshape(size, ss, size, ss, 3).mean(axis=(1, 3))
    return np.clip(rgb, 0.0, 1.0)


def to_blender_image(name="hero_face", size=768):
    """Create a bpy image from `build()`.  Blender pixels are bottom-up RGBA."""
    import bpy
    rgb = build(size)
    img = bpy.data.images.get(name)
    if img is None:
        img = bpy.data.images.new(name, width=size, height=size, alpha=False)
    rgba = np.ones((size, size, 4), dtype=np.float32)
    rgba[..., :3] = rgb
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


if __name__ == "__main__":
    # standalone preview:  Blender -b -P tools/face_tex.py -- --out face.png
    import sys
    import bpy
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = argv[argv.index("--out") + 1] if "--out" in argv else "docs/qa/hero/face_tex.png"
    img = to_blender_image()
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    print(f"[face] wrote {out}")
