"""surface_tex -- generated surface detail, drawn rather than photographed.

WHY.  A reviewer put it plainly: there is not one texture in this project, and
the material named `cobble` has no cobble in it.  The plaza floor is the single
largest surface a player ever looks at and it was one uniform grey, so the whole
town read as untextured regardless of how much detail the facades carried.

WHY NOT GEOMETRY.  Cobbles as actual bevelled boxes would be tens of thousands
of parts for one square.  This is a flat surface with a repeating pattern on it,
which is exactly what a texture is for -- and the floor is FLAT, so planar UVs
are correct rather than a compromise.

WHY IT IS DRAWN AND NOT NOISE.  A noise-based stone texture reads as dirt under
a toon ramp, because the ramp crushes everything into two bands and a smooth
gradient has nothing left after that.  These are drawn the same way the face is:
explicit shapes with hard edges, high enough in value that the shadow band still
has somewhere to go.

Run standalone to preview:
  python3 tools/surface_tex.py /tmp/cobble.png
"""
import math

import numpy as np

RES = 512


def _rng(seed):
    return np.random.default_rng(seed)


def _cell_centres(rows, cols, jitter, rng):
    """A jittered grid of stone centres, in 0-1 UV space, wrapping at the edges."""
    pts = []
    for r in range(rows):
        # every other row offsets by half a cell, which is what stops a paved
        # square reading as graph paper
        off = 0.5 if r % 2 else 0.0
        for c in range(cols):
            u = (c + off + rng.uniform(-jitter, jitter)) / cols
            v = (r + 0.5 + rng.uniform(-jitter, jitter)) / rows
            pts.append((u % 1.0, v % 1.0))
    return np.array(pts)


def cobble(res=RES, rows=9, cols=9, seed=7,
           stone=(0.60, 0.585, 0.60), mortar=(0.40, 0.395, 0.425),
           spread=0.060):
    """Irregular paving: a jittered Voronoi, tinted per cell, dark at the seams.

    Voronoi rather than a brick grid because a hand-laid square is not on a
    grid, and the cell boundaries give the mortar lines for free -- the distance
    between the nearest and second-nearest centre IS the seam.
    """
    rng = _rng(seed)
    pts = _cell_centres(rows, cols, 0.30, rng)

    # tile the point set into the 8 neighbours so the pattern wraps seamlessly
    tiled = np.concatenate([pts + (dx, dy)
                            for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    tone = rng.normal(0.0, spread, len(pts))
    tone = np.concatenate([tone] * 9)

    u = (np.arange(res) + 0.5) / res
    uu, vv = np.meshgrid(u, u, indexing='xy')
    px = np.stack([uu.ravel(), vv.ravel()], axis=1)

    # nearest and second-nearest, in chunks so the distance matrix stays small
    best = np.full(len(px), 1e9)
    second = np.full(len(px), 1e9)
    owner = np.zeros(len(px), dtype=np.int32)
    for i in range(0, len(tiled), 64):
        blk = tiled[i:i + 64]
        d = np.linalg.norm(px[:, None, :] - blk[None, :, :], axis=2)
        j = np.argmin(d, axis=1)
        dm = d[np.arange(len(px)), j]
        closer = dm < best
        second = np.where(closer, best, np.minimum(second, dm))
        owner = np.where(closer, i + j, owner)
        best = np.where(closer, dm, best)
        # anything in this block that is not the new best may still be second
        d2 = np.where(d == dm[:, None], 1e9, d)
        second = np.minimum(second, d2.min(axis=1))

    seam = (second - best)
    img = np.empty((res, res, 3), np.float32)
    base = np.array(stone, np.float32) + tone[owner][:, None] * np.array([1, 1, 1])
    img[:] = base.reshape(res, res, 3)

    # the mortar line: a HARD edge, because a soft one disappears under the ramp
    line = (seam < 0.012).reshape(res, res)
    img[line] = np.array(mortar, np.float32)
    # and a half-strength inner line, so stones read as slightly domed
    inner = ((seam >= 0.012) & (seam < 0.026)).reshape(res, res)
    img[inner] *= 0.94

    return np.clip(img, 0, 1)


def flagstone(res=RES, seed=3, stone=(0.66, 0.63, 0.60), mortar=(0.44, 0.42, 0.42)):
    """Bigger, squarer slabs for the terrace: the same idea at a coarser scale,
    so two paved areas next to each other do not read as one surface."""
    return cobble(res=res, rows=5, cols=5, seed=seed, stone=stone, mortar=mortar,
                  spread=0.055)


def write_png(path, img):
    """Write RGB float 0-1 to an 8-bit PNG without pulling in an image library."""
    import struct
    import zlib
    h, w, _ = img.shape
    data = (np.clip(img, 0, 1) * 255).astype(np.uint8)
    raw = b''.join(b'\x00' + data[y].tobytes() for y in range(h))

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 6))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    return path


if __name__ == '__main__':
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/cobble.png'
    write_png(out, cobble())
    print(out)


def _fbm(res, seed, octaves=4, base=6):
    """Cheap value noise, summed. Used only where a HARD-edged pattern would be
    wrong -- grass and dirt are made of thousands of tiny things, not of shapes
    you can name, so this is the one place a gradient is the honest answer."""
    rng = _rng(seed)
    out = np.zeros((res, res), np.float32)
    amp, n = 1.0, base
    for _ in range(octaves):
        g = rng.random((n, n)).astype(np.float32)
        g = np.concatenate([g, g[:1]], 0)
        g = np.concatenate([g, g[:, :1]], 1)          # wrap
        u = np.linspace(0, n, res, endpoint=False)
        i0 = np.floor(u).astype(int)
        f = (u - i0)[:, None]
        f = f * f * (3 - 2 * f)
        row = g[i0] * (1 - f) + g[i0 + 1] * f
        f2 = (u - np.floor(u))[None, :]
        f2 = f2 * f2 * (3 - 2 * f2)
        j0 = np.floor(u).astype(int)
        out += amp * (row[:, j0] * (1 - f2) + row[:, j0 + 1] * f2)
        amp *= 0.5
        n *= 2
    return out / out.max()


def grass(res=RES, seed=11, a=(0.52, 0.68, 0.40), b=(0.62, 0.75, 0.47)):
    """Meadow. Two greens, banded rather than blended, plus sparse darker
    clumps -- under a toon ramp a smooth blend collapses to one flat colour, so
    the variation has to survive quantisation to be worth having."""
    n = _fbm(res, seed, octaves=4, base=5)
    k = np.where(n > 0.52, 1.0, 0.0) * 0.7 + np.where(n > 0.68, 1.0, 0.0) * 0.3
    img = (np.array(a, np.float32)[None, None, :] * (1 - k[..., None])
           + np.array(b, np.float32)[None, None, :] * k[..., None])
    clump = _fbm(res, seed + 5, octaves=3, base=11)
    img *= np.where(clump > 0.74, 0.90, 1.0)[..., None]
    return np.clip(img, 0, 1)


def dirt(res=RES, seed=17, a=(0.70, 0.61, 0.49), b=(0.76, 0.68, 0.56)):
    """The worn path: the same treatment a shade warmer, with grit."""
    n = _fbm(res, seed, octaves=4, base=7)
    k = np.where(n > 0.50, 1.0, 0.0)
    img = (np.array(a, np.float32)[None, None, :] * (1 - k[..., None])
           + np.array(b, np.float32)[None, None, :] * k[..., None])
    grit = _fbm(res, seed + 3, octaves=2, base=27)
    img *= np.where(grit > 0.80, 0.88, 1.0)[..., None]
    return np.clip(img, 0, 1)


def plaster(res=RES, seed=23, tone=(1.0, 1.0, 1.0), strength=0.05):
    """Rendered wall.

    DELIBERATELY ALMOST NOTHING.  A facade is the backdrop a fight happens in
    front of, and a wall with as much going on as the ground would compete with
    every silhouette in the frame.  This is low-contrast mottling plus a faint
    horizontal trowel drift, multiplied over whatever colour the material
    already carries -- so one greyscale texture serves all four plaster tints
    instead of four separate images.
    """
    n = _fbm(res, seed, octaves=4, base=4)
    drift = _fbm(res, seed + 9, octaves=2, base=3)
    k = 1.0 + (n - 0.5) * strength + (drift - 0.5) * strength * 0.6
    # a few sparse darker patches: damp, age, a repair
    patch = _fbm(res, seed + 31, octaves=3, base=6)
    # sparse and gentle: at full strength these read as camouflage, not as a
    # wall that has been rained on
    k *= np.where(patch > 0.90, 0.965, 1.0)
    img = np.repeat(k[..., None], 3, axis=2) * np.array(tone, np.float32)
    return np.clip(img, 0, 1)


def rooftile(res=RES, rows=11, seed=29, light=1.14, dark=0.68):
    """Pantiles: staggered courses of round-ended tiles.

    Drawn, not noised -- a roof is made of a thing you can name, and from the
    ridge at the far end of the meadow the roofs are most of the town's
    silhouette. Greyscale and multiplied, like the plaster, so the three roof
    colours stay three colours.
    """
    cols = rows
    u = (np.arange(res) + 0.5) / res
    uu, vv = np.meshgrid(u, u, indexing='xy')

    row = vv * rows
    ri = np.floor(row)
    rf = row - ri
    # every other course offsets by half a tile
    off = np.where(ri % 2 > 0, 0.5, 0.0)
    col = uu * cols + off
    cf = col - np.floor(col)

    k = np.ones((res, res), np.float32)
    # the rounded barrel of each tile, brightest along its crown
    bulge = np.cos((cf - 0.5) * np.pi) ** 0.7
    k = 1.0 + (light - 1.0) * bulge - (1.0 - dark) * (1.0 - bulge) * 0.55
    # the shadowed lap where the next course overlaps this one
    k = np.where(rf < 0.20, dark * (0.92 + 0.30 * rf / 0.20), k)
    # the vertical joint between tiles: a hard dark line, the thing that makes
    # a roof read as MANY tiles rather than as a striped surface
    k = np.where((cf < 0.06) | (cf > 0.94), dark * 0.92, k)

    rng = _rng(seed)
    tone = rng.normal(0.0, 0.045, (rows, cols)).astype(np.float32)
    ci = np.clip(np.floor(col).astype(int) % cols, 0, cols - 1)
    k = k + tone[np.clip(ri.astype(int) % rows, 0, rows - 1), ci]

    return np.clip(np.repeat(k[..., None], 3, axis=2), 0, 1)


def ashlar(res=RES, rows=6, seed=41, mortar=0.80, spread=0.035):
    """Cut stone: regular courses with a broken vertical joint.

    Used for the structural pieces -- plinths, cornices, the arch, the fountain,
    stair treads. Regular, unlike the paving's Voronoi, because dressed stone is
    the one thing in a town that IS laid out on a grid, and the contrast between
    the two is what separates "built" from "surfaced".
    """
    cols = rows * 2
    u = (np.arange(res) + 0.5) / res
    uu, vv = np.meshgrid(u, u, indexing='xy')

    row = vv * rows
    ri = np.floor(row)
    rf = row - ri
    # break the vertical joint by a third every course, not a half: a half looks
    # like brickwork, a third looks like stone
    off = (ri % 3) / 3.0
    col = uu * cols + off
    cf = col - np.floor(col)

    rng = _rng(seed)
    tone = rng.normal(0.0, spread, (rows, cols)).astype(np.float32)
    k = 1.0 + tone[np.clip(ri.astype(int) % rows, 0, rows - 1),
                   np.clip(np.floor(col).astype(int) % cols, 0, cols - 1)]
    joint = (rf < 0.045) | (cf < 0.030) | (cf > 0.970)
    k = np.where(joint, mortar, k)
    # a lighter chamfer just inside each joint, so blocks read as blocks
    inner = (~joint) & ((rf < 0.085) | (cf < 0.065) | (cf > 0.935))
    k = np.where(inner, k * 1.035, k)
    return np.clip(np.repeat(k[..., None], 3, axis=2), 0, 1)


def timber(res=RES, seed=53, spread=0.10):
    """Sawn wood: grain along one axis, a few darker rings.

    Beams, bands and posts. Directional on purpose -- it is the only texture
    here with an axis, which is what makes a horizontal band read as a beam
    rather than as a painted stripe.
    """
    n = _fbm(res, seed, octaves=3, base=3)
    # LONG FIBRES ALONG ONE AXIS. The first pass mixed the noise into itself and
    # produced soft blobs with no direction at all -- which is the one thing
    # wood is not. This is a high-frequency sine down V, wobbled by the noise so
    # the lines wander the way grain does.
    v = (np.arange(res) + 0.5)[:, None] / res
    grain = np.sin((v * 34.0 + n * 2.6) * np.pi * 2.0)
    k = 1.0 + grain * spread * 0.5
    k *= np.where(_fbm(res, seed + 7, octaves=2, base=9) > 0.78, 0.90, 1.0)
    return np.clip(np.repeat(k[..., None], 3, axis=2), 0, 1)
