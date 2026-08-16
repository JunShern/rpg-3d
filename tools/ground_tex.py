"""ground_tex -- generated paving, because the ground fills most of every frame.

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
  python3 tools/ground_tex.py /tmp/cobble.png
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
