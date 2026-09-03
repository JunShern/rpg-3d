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
           spread=0.095):
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
    # EACH STONE ITS OWN VALUE AND A HINT OF ITS OWN HUE: a paving that is one
    # grey with a mortar grid is a diagram of paving. Warm stones lean ochre,
    # cool ones lean slate, most sit between.
    hue = rng.normal(0.0, 1.0, len(pts))
    hue = np.concatenate([hue] * 9)
    warm = np.array([0.016, 0.006, -0.016], np.float32)
    base = (np.array(stone, np.float32) + tone[owner][:, None] * np.array([1, 1, 1])
            + hue[owner][:, None] * warm)
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


def stone_rough(res=RES, seed=131):
    """Undressed stone: mottle, grain and a few dark pits.

    The town textures its `stone` into coursed ashlar, which is right for
    dressed masonry and wrong for everything outdoors -- and the meadow ran no
    texture pass at all, so its boulders, dry-stone walls, standing stones and
    ruin were flat palette colours. An audit called that 80% of what you look
    at outdoors and a clear fidelity step down from the town, which it was.

    Greyscale and centred near 1.0 so one image serves rock, stone and the
    ruin, each tinted by its own material.
    """
    n = _fbm(res, seed, octaves=5, base=6)
    v = 0.90 + 0.20 * n
    grain = _fbm(res, seed + 7, octaves=3, base=23)
    v = v * (0.965 + 0.070 * grain)
    # pits: sparse and dark, the thing that says "this was never cut"
    pit = _fbm(res, seed + 19, octaves=2, base=13)
    v = v * np.where(pit > 0.80, 0.86, 1.0)
    return np.clip(np.repeat(v[..., None], 3, axis=2), 0, 1)


def rock_strata(res=RES, seed=173):
    """Bedded rock: the mottle of `stone_rough` with the bedding drawn in.

    The pass walls and the ravine are the largest rock surfaces in the game
    and the biggest thing in the frame at the top of the north road, and at
    that size a mottle is a flat grey. Rock reads as rock by its BEDDING --
    near-horizontal bands, each a shade off its neighbour, broken by a few
    dark joints running across them. Bands wander so the tile does not read
    as a barcode; still greyscale, still centred near 1.0, so the same tint
    works on it.
    """
    rng = _rng(seed)
    v = stone_rough(res, seed)[..., 0].copy()
    yy, xx = np.mgrid[0:res, 0:res].astype(np.float32) / res
    # bedding: a slowly wandering set of bands, 9 per tile, each with its own
    # tone step, wrapping at the tile edge
    # NOISE, NOT SINES. A sine wander made the beds a corrugated sheet; a
    # bed's wander is irregular, and fbm along the tile gives it that.
    w = _fbm(res, seed + 3, octaves=3, base=3)
    wander = (w - w.mean()) * 0.09
    band = ((yy + wander) * 9.0) % 1.0
    idx = np.floor((yy + wander) * 9.0).astype(int) % 9
    tones = 0.88 + 0.17 * rng.random(9).astype(np.float32)
    v = v * tones[idx]
    # a dark line at the bottom of each band: the joint between beds
    v = v * np.where(band < 0.04, 0.74, 1.0)
    # cross joints: a handful of near-vertical dark cracks, each a short run
    for _ in range(14):
        x0 = rng.random(); y0 = rng.random(); h = 0.10 + rng.random() * 0.22
        tilt = (rng.random() - 0.5) * 0.25
        for k in range(int(h * res)):
            y = (int(y0 * res) + k) % res
            x = (int((x0 + tilt * k / res) * res)) % res
            v[y, x] *= 0.78
            v[y, (x + 1) % res] *= 0.88
    return np.clip(np.repeat(v[..., None], 3, axis=2), 0, 1)


def bark_rough(res=RES, seed=149):
    """Bark: coarse vertical-ish fibre with deep splits.

    Projected per face by `box_uvs`, so the direction is only right on about a
    third of a trunk -- which at the size a trunk is seen is a trade worth
    making for having any surface at all instead of a flat brown cylinder.
    """
    yy = np.linspace(0, 1, res, dtype=np.float32)[:, None]
    xx = np.linspace(0, 1, res, dtype=np.float32)[None, :]
    fibre = 0.5 + 0.5 * np.sin(xx * 62.0 + _fbm(res, seed, octaves=3, base=4) * 9.0)
    v = 0.90 + 0.18 * fibre
    split = _fbm(res, seed + 5, octaves=3, base=9)
    v = v * np.where(split > 0.72, 0.80, 1.0)
    v = v * (0.97 + 0.06 * _fbm(res, seed + 11, octaves=2, base=17))
    return np.clip(np.repeat(v[..., None], 3, axis=2), 0, 1)


def ground_detail(res=RES, seed=91):
    """A NEUTRAL detail map for the meadow floor -- mottle, not colour.

    The ground used to be three tinted textures assigned per face, which is what
    made the grass/path boundary a staircase of 1.6 m rectangles. It is one
    material now, coloured by a vertex attribute that interpolates across every
    face, so the texture's only remaining job is to stop the surface reading as
    a flat fill. Centred on 1.0 so it MODULATES whatever colour the vertices
    carry rather than imposing one of its own -- the same image has to work
    under green, under tan and under the band between them.
    """
    n = _fbm(res, seed, octaves=4, base=5)
    k = np.where(n > 0.52, 1.0, 0.0) * 0.055 + np.where(n > 0.68, 1.0, 0.0) * 0.045
    clump = _fbm(res, seed + 5, octaves=3, base=11)
    grit = _fbm(res, seed + 9, octaves=2, base=29)
    v = 0.955 + k
    v = v * np.where(clump > 0.74, 0.945, 1.0)
    v = v * np.where(grit > 0.82, 0.965, 1.0)
    return np.clip(np.repeat(v[..., None], 3, axis=2), 0, 1)


def grass_strokes(res=RES, seed=97):
    """The meadow floor's detail map, DRAWN: blade strokes over the mottle.

    `ground_detail` is mottle, and mottle at five metres is a flat fill with
    a faint stain on it. What a painted grass texture has that noise does not
    is DIRECTION -- thousands of short strokes, all roughly upright, a shade
    lighter than the ground at their tip and a shade darker at their foot --
    plus a scatter of tiny bright dots that read as clover from any distance.
    Still centred on 1.0, so it modulates the vertex colour like the mottle
    did and the same image works under green, tan and the band between.
    """
    rng = _rng(seed)
    base = ground_detail(res, seed)[..., 0]
    v = base.copy()
    yy, xx = np.mgrid[0:res, 0:res].astype(np.float32)
    # STROKES: a few thousand short tapered lines, near-vertical, drawn as a
    # distance field per stroke on a coarse tile then stamped. Wrapping
    # coordinates so the tile seams do not show.
    n = int(res * res / 55)
    px = rng.random(n) * res
    py = rng.random(n) * res
    length = res * (0.012 + rng.random(n) * 0.020)
    tilt = (rng.random(n) - 0.5) * 0.9
    tone = np.where(rng.random(n) < 0.45, 1.0, -1.0) * (0.04 + rng.random(n) * 0.05)
    # rasterise: for each stroke, a small window
    for i in range(n):
        L = length[i]
        r = int(L) + 2
        x0, y0 = int(px[i]), int(py[i])
        xs = (np.arange(x0 - r, x0 + r + 1)) % res
        ys = (np.arange(y0 - r, y0 + r + 1)) % res
        gx = xs[None, :].astype(np.float32) - px[i]
        gy = ys[:, None].astype(np.float32) - py[i]
        # unwrap the window relative to the centre
        gx = (gx + res / 2) % res - res / 2
        gy = (gy + res / 2) % res - res / 2
        # coordinate along the stroke (up = -y) and across
        along = -gy * math.cos(tilt[i]) + gx * math.sin(tilt[i])
        across = gx * math.cos(tilt[i]) + gy * math.sin(tilt[i])
        u = along / L
        w = 1.1 * (1.0 - np.clip(u, 0, 1)) + 0.4        # tapers to the tip
        mask = (u > 0) & (u < 1) & (np.abs(across) < w)
        sub = v[np.ix_(ys, xs)]
        sub[mask] += tone[i] * (0.5 + 0.5 * np.clip(u, 0, 1)[mask])
        v[np.ix_(ys, xs)] = sub
    # CLOVER: sparse bright dots, two pixels across
    m = int(res * res / 2600)
    cx = (rng.random(m) * res).astype(int)
    cy = (rng.random(m) * res).astype(int)
    for dx in (0, 1):
        for dy in (0, 1):
            v[(cy + dy) % res, (cx + dx) % res] += 0.10
    v = np.clip(v, 0.80, 1.12)
    return np.clip(np.repeat(v[..., None], 3, axis=2), 0, 1)


def plaster(res=RES, seed=23, tone=(1.0, 1.0, 1.0), strength=0.09):
    """Rendered wall: mottle, a trowel drift, a few damp patches, hairline
    cracks and rain streaks.

    It used to be deliberately almost nothing, on the argument that a facade
    is a backdrop. That was true when the walls were the only thing with a
    texture on them; now the ground, the roofs and the rock all carry marks
    and the plaster reads as the one surface nobody painted. Still greyscale
    and multiplied, so one image serves every tint -- and still nothing here
    is strong enough to fight a silhouette in front of it.
    """
    rng = _rng(seed)
    n = _fbm(res, seed, octaves=4, base=4)
    drift = _fbm(res, seed + 9, octaves=2, base=3)
    k = 1.0 + (n - 0.5) * strength + (drift - 0.5) * strength * 0.6
    patch = _fbm(res, seed + 31, octaves=3, base=6)
    k *= np.where(patch > 0.86, 0.94, 1.0)
    k *= np.where(patch < 0.16, 1.035, 1.0)          # a lighter repair
    # RAIN STREAKS: faint vertical runs, denser lower down each tile so they
    # read as weather coming off a sill somewhere above
    v = (np.arange(res) + 0.5) / res
    streak = _fbm(res, seed + 47, octaves=3, base=40)          # fine across
    streak = np.repeat(streak.mean(axis=0, keepdims=True), res, axis=0)  # smear down
    streak = (streak - streak.mean()) * 1.4
    fall = np.clip((v[:, None] - 0.35) / 0.65, 0, 1)
    k *= 1.0 - 0.06 * np.clip(streak, 0, 1) * fall
    # HAIRLINE CRACKS: a handful of random walks, one pixel wide, slightly dark
    crack = np.zeros((res, res), np.float32)
    for _ in range(4):
        x, y = rng.integers(0, res), rng.integers(0, res)
        dx, dy = rng.normal(0, 1), rng.normal(0, 1)
        for _s in range(rng.integers(60, 180)):
            crack[y % res, x % res] = 1.0
            dx += rng.normal(0, 0.35); dy += rng.normal(0, 0.35)
            nrm = max(1e-3, (dx * dx + dy * dy) ** 0.5)
            x = int(round(x + dx / nrm)); y = int(round(y + dy / nrm))
    k *= 1.0 - 0.10 * crack
    img = np.repeat(k[..., None], 3, axis=2) * np.array(tone, np.float32)
    return np.clip(img, 0, 1)


def rooftile(res=RES, rows=11, seed=29, light=1.14, dark=0.66):
    """Pantiles: staggered courses of round-barrelled tiles, with lichen.

    Drawn, not noised -- a roof is made of a thing you can name, and from the
    ridge at the far end of the meadow the roofs are most of the town's
    silhouette. The first version was a grid of flat rectangles and read as
    brick from any distance: what makes a pantile a pantile is the S-curve
    across it, so the barrel is a full cosine, the lap is a soft shadow with
    a bright lip, and every fourth tile is a shade off the rest. Lichen sits
    in the laps as a cool tint, so this one is RGB rather than grey.
    """
    cols = rows
    u = (np.arange(res) + 0.5) / res
    uu, vv = np.meshgrid(u, u, indexing='xy')
    row = vv * rows
    ri = np.floor(row)
    rf = row - ri
    off = np.where(ri % 2 > 0, 0.5, 0.0)
    col = uu * cols + off
    cf = col - np.floor(col)
    # the S-curve: a full cosine across the tile, bright crown, dark trough
    bulge = 0.5 + 0.5 * np.cos((cf - 0.5) * 2 * np.pi)
    k = dark + (light - dark) * (0.15 + 0.85 * bulge)
    # the lap: a soft shadow under the course above and a bright lip at its edge
    lap = np.clip((0.22 - rf) / 0.22, 0, 1)
    k *= 1.0 - 0.34 * lap ** 1.4
    k = np.where((rf > 0.22) & (rf < 0.26), k * 1.10, k)
    # the joint between tiles, softer than a hard line
    joint = np.clip(1 - np.abs(cf - 0.0) / 0.05, 0, 1) + np.clip(1 - np.abs(cf - 1.0) / 0.05, 0, 1)
    k *= 1.0 - 0.18 * joint
    rng = _rng(seed)
    tone = rng.normal(0.0, 0.07, (rows, cols)).astype(np.float32)
    ci = np.clip(np.floor(col).astype(int) % cols, 0, cols - 1)
    rr = np.clip(ri.astype(int) % rows, 0, rows - 1)
    k = k + tone[rr, ci]
    # a few replaced tiles, paler
    swap = (rng.random((rows, cols)) < 0.06).astype(np.float32)
    k = k + 0.16 * swap[rr, ci]
    img = np.repeat(k[..., None], 3, axis=2).astype(np.float32)
    # LICHEN: cool patches that sit in the laps and the troughs
    moss = _fbm(res, seed + 71, octaves=3, base=5)
    m = np.clip((moss - 0.62) / 0.25, 0, 1) * (0.4 + 0.6 * (1 - bulge)) * (0.5 + 0.5 * lap)
    tint = np.array([0.72, 0.92, 0.70], np.float32)
    img = img * (1 - m[..., None]) + img * tint * m[..., None] * 1.05
    return np.clip(img, 0, 1)


def stripes(res=RES, n=7, seed=83, a=(1.0, 1.0, 1.0), b=(0.90, 0.42, 0.40)):
    """Awning canvas: vertical stripes with a little weave. Multiplied over a
    cream base, so `a` is the cream and `b` is the colour of the stripe. A
    plain pink slab over every stall and shopfront was the loudest flat
    surface in the square."""
    u = (np.arange(res) + 0.5) / res
    uu, vv = np.meshgrid(u, u, indexing='xy')
    k = np.floor(uu * n) % 2
    # soften the stripe edge by a pixel or two and add the weave
    edge = np.abs(((uu * n) % 1.0) - 0.5) * 2.0
    k = k * np.clip(edge * 14.0, 0, 1) + (1 - k) * (1 - np.clip(edge * 14.0, 0, 1)) * 0.0 + k * 0.0 + np.where(k > 0.5, 1.0, 0.0) * 0.0
    stripe = np.where(np.floor(uu * n) % 2 > 0, 1.0, 0.0)
    weave = _fbm(res, seed, octaves=3, base=48)
    img = (np.array(a, np.float32)[None, None] * (1 - stripe[..., None])
           + np.array(b, np.float32)[None, None] * stripe[..., None])
    img = img * (0.96 + 0.08 * weave[..., None])
    return np.clip(img, 0, 1).astype(np.float32)


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


def verge(res=RES, seed=61):
    """The band where the worn path meets the grass.

    A road and a field met along a hard binary boundary on a 1.6 m grid, which
    reads as discoloured patches rather than as an edge something has walked
    over. This is the middle step: dirt showing through thinning grass, so the
    transition is two soft steps instead of one hard one.
    """
    g = grass(res, seed=seed)
    d = dirt(res, seed=seed + 4)
    n = _fbm(res, seed + 11, octaves=4, base=6)
    k = np.clip((n - 0.38) * 2.4, 0.0, 1.0)[..., None]
    return np.clip(g * (1 - k) + d * k, 0, 1)
