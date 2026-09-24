"""facade_lib -- facades with DEPTH, and roofs made of tiles.

WHY THIS EXISTS. The first kit built a building as one solid box with windows
stuck to its face -- and the window glass was set 13 cm INTO that box, so it
was hidden and every window read as a frame drawn on plaster. Under a cel ramp
that passed. Under real light it is the single most fake thing in the town:
real walls are thick, openings are cut through them, and the shadow inside the
reveal is most of what tells the eye a window is a window.

So a facade here is a SKIN with holes in it:

    - the building's core box is inset by FT (the wall thickness) on every side
    - each face is rebuilt as plaster panels that tile the face around the
      openings -- so the openings are real holes, the panel edges are real
      reveals, and the core's face behind them is the back of the recess
    - glass, frames and doors sit IN the recess; stone surrounds, sills,
      lintels and quoins sit PROUD of the plaster; shutters hang open against it

and a roof is a timber deck under courses of barrel tiles, each course a
corrugated strip that overlaps the one below it with a stepped lip, a ridge of
half-round capping tiles, plaster gable ends and verge boards.

Everything is authored for a face that looks down -Y at y = -hd, spanning
x in [-hw, hw], and rotated to the other three faces -- the same one-orientation
convention as arch_lib.
"""
import math
from mathutils import Vector

import geo_lib as K

FT = 0.26            # wall thickness: how deep every reveal is


def slab(name, x0, x1, y0, y1, z0, z1, mat):
    """An axis-aligned, unbevelled box from its extents.

    NO BEVEL, on purpose: facade panels butt against each other, and a bevel
    on each would draw a groove at every seam across what should be one wall.
    """
    x0, x1 = min(x0, x1), max(x0, x1)
    y0, y1 = min(y0, y1), max(y0, y1)
    z0, z1 = min(z0, z1), max(z0, z1)
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return K._new_obj(name, [Vector(p) for p in v], f, mat=mat, smooth=False)


def bbox(name, center, half, mat, bevel=0.015):
    """A small bevelled box for trim (surrounds, sills, frames)."""
    b = min(bevel, min(half) * 0.6)
    return K.rounded_box(name, center, half, b, None, mat, segments=1, smooth=True)


# ---------------------------------------------------------------- the skin

def skin(out, hw, hd, z0, z1, openings, mat, name="wall"):
    """Plaster panels covering the face y = -hd, x in [-hw, hw], z in [z0, z1],
    everywhere EXCEPT the openings [(x0, x1, zb, zt), ...].

    Horizontal slabs between every opening's top and bottom, each split round
    whatever openings cross it -- so a face with nine windows is a few dozen
    boxes and the holes are exact.
    """
    ys, yi = -hd, -hd + FT
    cuts = sorted({z0, z1} | {min(max(o[2], z0), z1) for o in openings}
                  | {min(max(o[3], z0), z1) for o in openings})
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-4:
            continue
        mid = (a + b) / 2
        holes = sorted((o[0], o[1]) for o in openings if o[2] < mid < o[3])
        x = -hw
        for hx0, hx1 in holes + [(hw, hw)]:
            if hx0 - x > 1e-4:
                out.append(slab(name, x, hx0, ys, yi, a, b, mat))
            x = max(x, hx1)


def quoins(out, M, hw, hd, z0, z1, step=0.30):
    """Dressed stones up a corner, alternating long and short -- the detail
    that makes a rendered corner read as a load-bearing one. Both corners of
    the face; the side faces add theirs, so each corner gets a full set."""
    k = 0
    z = z0
    while z + step <= z1 + 1e-3:
        long_ = k % 2 == 0
        L = 0.46 if long_ else 0.28
        for s in (-1, 1):
            x0 = s * hw
            out.append(bbox("quoin", (x0 - s * L / 2, -hd - 0.025, z + step / 2 - 0.012),
                            (L / 2, 0.03, step / 2 - 0.018), M["stone"], bevel=0.012))
        z += step
        k += 1


def surround(out, M, x0, x1, zb, zt, hd, keystone=False, sill=True, head=0.16):
    """Stone jambs, a lintel and a sill round an opening, proud of the plaster."""
    y = -hd - 0.035
    jw = 0.085
    out.append(bbox("jamb", (x0 - jw / 2, y, (zb + zt) / 2), (jw / 2, 0.04, (zt - zb) / 2), M["stone"]))
    out.append(bbox("jamb", (x1 + jw / 2, y, (zb + zt) / 2), (jw / 2, 0.04, (zt - zb) / 2), M["stone"]))
    out.append(bbox("lintel", ((x0 + x1) / 2, y - 0.005, zt + head / 2),
                    ((x1 - x0) / 2 + jw + 0.03, 0.045, head / 2), M["stone"]))
    if keystone:
        out.append(bbox("keystone", ((x0 + x1) / 2, y - 0.03, zt + head * 0.55),
                        (0.075, 0.05, head * 0.62), M["stone"]))
    if sill:
        out.append(bbox("sill", ((x0 + x1) / 2, -hd - 0.07, zb - 0.045),
                        ((x1 - x0) / 2 + jw + 0.06, 0.09, 0.045), M["stone"]))


def glazing(out, M, x0, x1, zb, zt, hd, cols=2, rows=2, frame="timber"):
    """Glass set deep in the reveal, a frame round it and glazing bars.
    The glass sits 5 cm in front of the core face, so it is IN the hole,
    shadowed by the reveal above it, and catches the sky."""
    yg = -hd + FT - 0.05
    out.append(slab("glass", x0, x1, yg, yg + 0.02, zb, zt, M["glass"]))
    # CURTAINS behind about half the windows: a room behind the glass is most
    # of what stops a window reading as a dark panel. Drawn half across, in
    # cloth, just in front of the core.
    k = int(abs(x0 * 7.3 + zb * 3.1)) % 3
    if k != 0:
        cw = (x1 - x0) * (0.32 if k == 1 else 0.5)
        yc = -hd + FT - 0.02
        out.append(slab("curtain", x0 + 0.03, x0 + 0.03 + cw, yc, yc + 0.012, zb + 0.05, zt - 0.03,
                        M["curtain"]))
        if k == 2:
            out.append(slab("curtain", x1 - 0.03 - cw * 0.6, x1 - 0.03, yc, yc + 0.012, zb + 0.05, zt - 0.03,
                            M["curtain"]))
    fy = yg - 0.025
    b = 0.045
    for (a0, a1, c0, c1) in ((x0, x1, zb, zb + b), (x0, x1, zt - b, zt),
                             (x0, x0 + b, zb, zt), (x1 - b, x1, zb, zt)):
        out.append(slab("wframe", a0, a1, fy - 0.02, fy + 0.02, c0, c1, M[frame]))
    for i in range(1, cols):
        x = x0 + (x1 - x0) * i / cols
        out.append(slab("wbar", x - 0.018, x + 0.018, fy - 0.012, fy + 0.012, zb, zt, M[frame]))
    for j in range(1, rows):
        z = zb + (zt - zb) * j / rows
        out.append(slab("wbar", x0, x1, fy - 0.012, fy + 0.012, z - 0.018, z + 0.018, M[frame]))


def shutters(out, M, x0, x1, zb, zt, hd, mat):
    """A pair of louvred shutters folded back flat against the wall."""
    w = (x1 - x0) / 2
    for s, xe in ((-1, x0), (1, x1)):
        cx = xe + s * (w / 2 + 0.10)
        out.append(bbox("shutter", (cx, -hd - 0.04, (zb + zt) / 2), (w / 2, 0.022, (zt - zb) / 2 + 0.01),
                        mat, bevel=0.008))
        # louvres: shallow slats down the panel
        n = max(5, int((zt - zb) / 0.11))
        for i in range(n):
            z = zb + 0.06 + (zt - zb - 0.12) * (i + 0.5) / n
            out.append(slab("louvre", cx - w / 2 + 0.05, cx + w / 2 - 0.05,
                            -hd - 0.074, -hd - 0.060, z - 0.018, z + 0.012, mat))


def door_leaf(out, M, x0, x1, zb, zt, hd, mat, arched=False):
    """A plank door set in the reveal, with a panel frame and iron fittings."""
    yd = -hd + FT - 0.10
    out.append(slab("door", x0, x1, yd, yd + 0.06, zb, zt, mat))
    n = max(3, int((x1 - x0) / 0.16))
    for i in range(1, n):
        x = x0 + (x1 - x0) * i / n
        out.append(slab("door_groove", x - 0.008, x + 0.008, yd - 0.012, yd, zb + 0.05, zt - 0.05,
                        M["timber"]))
    for z in (zb + 0.45, zt - 0.45):
        out.append(slab("door_strap", x0 + 0.06, x1 - 0.06, yd - 0.022, yd, z - 0.03, z + 0.03, M["iron"]))
    out.append(K.blob("door_ring", (x1 - 0.14, yd - 0.04, (zb + zt) * 0.5), (0.05, 0.02, 0.05),
                      None, M["iron"], seg=10, rings=6))


# ---------------------------------------------------------------- a building

def facade_plan(face, w, storeys, ground_h, floor_h, bays, seed, shop, room,
                door_bay):
    """Where the openings go on one face, and what each is.
    face: 'front' | 'back' | 'side'.  Returns a list of dicts."""
    ops = []
    base = 0.16
    if face == 'side':
        n = max(1, int(w / 3.2))
        for f in range(storeys):
            if f == 0 and room:
                continue
            fz = base + (0 if f == 0 else ground_h + floor_h * (f - 1))
            fh = ground_h if f == 0 else floor_h
            for b in range(n):
                cx = -w / 2 + w * (b + 0.5) / n
                if f == 0 and (b + seed) % 2:
                    continue
                ww, wh = 0.72, 1.25
                zb = fz + fh * 0.36
                ops.append(dict(kind='win', x0=cx - ww / 2, x1=cx + ww / 2, zb=zb, zt=zb + wh,
                                shutters=False, keystone=False))
        return ops
    for f in range(storeys):
        fz = base + (0 if f == 0 else ground_h + floor_h * (f - 1))
        fh = ground_h if f == 0 else floor_h
        top = f == storeys - 1 and storeys >= 3
        for b in range(bays):
            cx = -w / 2 + w * (b + 0.5) / bays
            bw = w / bays
            if f == 0:
                if face == 'front' and b == door_bay:
                    if room:
                        continue        # the hollow ground storey cuts its own door
                    dw = 1.12
                    ops.append(dict(kind='door', x0=cx - dw / 2, x1=cx + dw / 2, zb=0.32,
                                    zt=0.32 + 2.30, keystone=True))
                elif face == 'front' and shop and not room:
                    sw = min(2.2, bw * 0.82)
                    ops.append(dict(kind='shop', x0=cx - sw / 2, x1=cx + sw / 2, zb=0.95,
                                    zt=2.75))
                elif room and face == 'front':
                    continue
                else:
                    ww = min(1.0, bw * 0.46)
                    ops.append(dict(kind='win', x0=cx - ww / 2, x1=cx + ww / 2, zb=1.25,
                                    zt=2.75, shutters=face == 'front', keystone=(b + seed) % 2 == 0,
                                    bars=True))
            else:
                ww = min(1.02, bw * 0.46) if not top else min(0.78, bw * 0.36)
                balcony = face == 'front' and f == 1 and b == (seed + 1) % bays
                wh = (2.30 if balcony else 1.62) if not top else 1.05
                zb = fz + (0.12 if balcony else 0.82) if not top else fz + 0.95
                ops.append(dict(kind='win', x0=cx - ww / 2, x1=cx + ww / 2, zb=zb, zt=zb + wh,
                                shutters=face == 'front' and not top,
                                keystone=face == 'front' and not top and (b + f + seed) % 2 == 0,
                                balcony=balcony,
                                flowers=face == 'front' and not balcony and not top
                                and (b + seed + f) % 3 == 1))
    return ops


def build_face(out, M, face, hw, hd, z_lo, z_hi, plaster, ops, shutter_mat, base_top=0.95):
    """One face: the base course, the plaster skin, and everything round each
    opening. Authored at y = -hd facing -Y."""
    holes = [(o['x0'], o['x1'], o['zb'], o['zt']) for o in ops]
    # the base course: rough stone to knee height, a little proud of the wall
    skin(out, hw + 0.05, hd + 0.05, z_lo, max(z_lo, min(base_top, z_hi)),
         [h for h in holes if h[2] < base_top], M["stone"], name="base")
    if z_hi > base_top:
        skin(out, hw, hd, max(z_lo, base_top), z_hi, holes, M[plaster])
    out.append(bbox("base_cap", (0, -hd - 0.07, base_top), (hw + 0.07, 0.035, 0.03), M["stone"]))
    for o in ops:
        x0, x1, zb, zt = o['x0'], o['x1'], o['zb'], o['zt']
        if o['kind'] == 'win':
            surround(out, M, x0, x1, zb, zt, hd, keystone=o.get('keystone', False))
            glazing(out, M, x0, x1, zb, zt, hd, cols=2, rows=3 if zt - zb > 1.4 else 2)
            if o.get('shutters'):
                shutters(out, M, x0, x1, zb, zt, hd, shutter_mat)
        elif o['kind'] == 'door':
            surround(out, M, x0, x1, zb, zt, hd, keystone=True, sill=False, head=0.22)
            door_leaf(out, M, x0, x1, zb, zt, hd, shutter_mat)
            out.append(bbox("door_step", ((x0 + x1) / 2, -hd - 0.22, 0.24),
                            ((x1 - x0) / 2 + 0.22, 0.22, 0.08), M["stone"]))
        elif o['kind'] == 'shop':
            # joinery, not stone: a painted timber front with a fascia board
            y = -hd - 0.03
            out.append(slab("shop_frame", x0 - 0.12, x0, y - 0.03, -hd + 0.02, zb - 0.62, zt + 0.1, M["timber"]))
            out.append(slab("shop_frame", x1, x1 + 0.12, y - 0.03, -hd + 0.02, zb - 0.62, zt + 0.1, M["timber"]))
            out.append(slab("shop_fascia", x0 - 0.18, x1 + 0.18, y - 0.06, -hd + 0.02, zt + 0.1, zt + 0.48,
                            M["timber"]))
            out.append(slab("shop_riser", x0, x1, -hd, -hd + FT - 0.02, 0.32, zb, M["timber"]))
            glazing(out, M, x0, x1, zb, zt, hd, cols=4, rows=2)


def rotate_face(objs, face, cx=0.0, cy=0.0):
    """Take pieces authored for the front face to the given face."""
    ang = {'front': 0, 'back': 180, 'left': -90, 'right': 90}[face]
    if ang:
        for o in objs:
            K.transform(o, rotate=(0, 0, ang), around=(0, 0, 0))


# ------------------------------------------------------------------ the roof

def corrugated(name, x0, x1, s0, s1, mat, hd, h, side, lip=0.035, amp=0.045, period=0.24,
               res=4):
    """One course of barrel tiles on the slope `side` (-1 front, +1 back) of a
    gable whose eave is at y = side*hd, z = 0 and ridge at y = 0, z = h.

    s is distance up the slope (0 at the eave). The course is a strip across x
    whose surface humps once per `period` (the barrel), and it is lifted by
    `lip` at its lower edge so it overlaps the course below with a shadow.
    """
    L = math.hypot(hd, h)
    uy, uz = -side * hd / L, h / L                   # up the slope
    ny, nz = side * h / L, hd / L                    # outward normal
    cols = max(2, int((x1 - x0) / period * res))
    verts, faces = [], []
    for j, s in enumerate((s0, s1)):
        rise = lip if j == 0 else 0.0
        for i in range(cols + 1):
            x = x0 + (x1 - x0) * i / cols
            hump = amp * abs(math.sin(math.pi * (x - x0) / period))
            off = hump + rise
            y = side * hd + uy * s + ny * off
            z = uz * s + nz * off
            verts.append(Vector((x, y, z)))
    n = cols + 1
    for i in range(cols):
        a, b = i, i + 1
        if side < 0:
            faces.append((a, b, n + b, n + a))
        else:
            faces.append((a, n + a, n + b, b))
    # the lip's face: a strip dropping from the lower edge to the course below
    base = len(verts)
    for i in range(cols + 1):
        v = verts[i]
        verts.append(Vector((v.x, v.y - ny * lip, v.z - nz * lip)))
    for i in range(cols):
        a, b = i, i + 1
        if side < 0:
            faces.append((base + a, base + b, b, a))
        else:
            faces.append((base + a, a, b, base + b))
    return K._new_obj(name, verts, faces, mat=mat, smooth=True, recalc=False)


def tiled_roof(t, cz, w, d, h, over_x, over_y, roof_mat, plaster_mat, slate=False):
    """A gable roof, ridge along X, eaves over +/-Y, sitting at z = cz.
    Returns the pieces (not yet added to t)."""
    M, out = t.M, []
    hw, hd = w / 2 + over_x, d / 2 + over_y
    # the deck: a dark timber underlay, seen only from below the eaves
    deck = [(-hw, -hd, 0), (hw, -hd, 0), (hw, 0, h), (-hw, 0, h), (-hw, hd, 0), (hw, hd, 0)]
    dv = [Vector((x, y, z + cz - 0.02)) for x, y, z in deck]
    # (no gable faces: those are plaster, below, and a timber triangle in
    # front of them read as a dark wooden gable on every street-facing roof)
    out.append(K._new_obj("roof_deck", dv, [(0, 1, 2, 3), (4, 3, 2, 5), (0, 4, 5, 1)],
                          mat=M["timber"], smooth=False, recalc=False))
    L = math.hypot(hd, h)
    step = 0.24 if slate else 0.30
    n = max(3, int(L / step))
    for side in (-1, 1):
        for k in range(n):
            s0 = k * L / n
            s1 = min(L, s0 + L / n + 0.05)
            c = corrugated("roof_course", -hw, hw, s0, s1, roof_mat, hd, h, side,
                           lip=0.028 if slate else 0.04,
                           amp=0.008 if slate else 0.05,
                           period=0.34 if slate else 0.23)
            K.transform(c, translate=(0, 0, cz))
            out.append(c)
    # ridge: half-round capping tiles along the top
    ridge = []
    for i in range(2):
        x = -hw - 0.02 if i == 0 else hw + 0.02
        ridge.append({"p": Vector((x, 0, cz + h + 0.04)), "r": (0.09, 0.07), "n": 2.0})
    out.append(K.tube("roof_ridge", ridge, seg=10, mat=roof_mat, squircle=2.0, up=(0, 0, 1)))
    # plaster gable ends, just inside the verge, and verge boards on the slope edges
    for s in (-1, 1):
        x = s * (w / 2)
        gv = [Vector((x, -d / 2, cz)), Vector((x, d / 2, cz)), Vector((x, 0, cz + h * (d / 2) / hd))]
        out.append(K._new_obj("gable", gv, [(0, 1, 2) if s > 0 else (0, 2, 1)], mat=plaster_mat,
                              smooth=False, recalc=False))
        for side in (-1, 1):
            a = Vector((s * (hw + 0.01), side * hd, cz - 0.02))
            b = Vector((s * (hw + 0.01), 0, cz + h))
            mid = (a + b) / 2
            L2 = (b - a).length
            vb = bbox("verge", (0, 0, 0), (0.03, L2 / 2, 0.09), M["timber"], bevel=0.01)
            ang = math.degrees(math.atan2(h, hd)) * (-side)
            K.transform(vb, rotate=(ang, 0, 0), around=(0, 0, 0), translate=tuple(mid))
            out.append(vb)
    # rafter tails under the eaves: the one detail that says "wooden roof"
    for side in (-1, 1):
        nr = max(4, int(w / 0.62))
        for i in range(nr + 1):
            x = -w / 2 + w * i / nr
            out.append(bbox("rafter", (x, side * (d / 2 + over_y * 0.5), cz - 0.07),
                            (0.045, over_y * 0.5, 0.055), M["timber"], bevel=0.01))
    return out


def chimney(t, x, y, z0, h):
    """A stone stack with a capping slab and two pots."""
    M, out = t.M, []
    out.append(bbox("chim", (x, y, z0 + h / 2), (0.30, 0.26, h / 2), M["stone"], bevel=0.03))
    out.append(bbox("chim_cap", (x, y, z0 + h + 0.05), (0.36, 0.32, 0.05), M["stone"], bevel=0.02))
    for s in (-1, 1):
        out.append(K.tube("chim_pot", [{"p": Vector((x + s * 0.11, y, z0 + h + 0.08)), "r": (0.07, 0.07), "n": 2.0},
                                       {"p": Vector((x + s * 0.11, y, z0 + h + 0.30)), "r": (0.055, 0.055), "n": 2.0}],
                          seg=10, mat=M["roof_a"], up=(0, 0, 1)))
    return out


# ------------------------------------------------------------------ arches

def arch_plate(name, span, height, depth, mat, rise=None, seg=20):
    """The solid above an arch: a plate spanning x in [-span/2, span/2], from
    z = 0 up to z = height, with an arch cut out of its bottom edge. `rise` is
    the arch's height at the crown (a semicircle if None). Depth runs along Y,
    centred on y = 0.  Built as columns from the intrados up to the top edge,
    so the non-convex front face triangulates without a fan across the hole.
    """
    hs = span / 2
    r = hs if rise is None else rise
    R = (hs * hs + r * r) / (2 * r)             # the circle through springings and crown
    zc = r - R                                   # its centre, below the crown by R
    pts = []
    for i in range(seg + 1):
        x = -hs + span * i / seg
        z = zc + math.sqrt(max(0.0, R * R - x * x))
        pts.append((x, max(0.0, z)))
    verts, faces = [], []
    hd = depth / 2
    for yy in (-hd, hd):
        for x, z in pts:
            verts.append(Vector((x, yy, z)))
        for x, z in pts:
            verts.append(Vector((x, yy, height)))
    n = seg + 1
    F0, F1 = 0, 2 * n                  # front block, back block
    for i in range(seg):
        a, b = i, i + 1
        # front face (y = -hd, facing -Y): intrados row a,b and top row n+a,n+b
        faces.append((F0 + a, F0 + n + a, F0 + n + b, F0 + b))
        faces.append((F1 + a, F1 + b, F1 + n + b, F1 + n + a))
        # intrados: the soffit of the arch, facing down
        faces.append((F0 + a, F0 + b, F1 + b, F1 + a))
        # top
        faces.append((F0 + n + a, F1 + n + a, F1 + n + b, F0 + n + b))
    # the two ends
    faces.append((F0, F1, F1 + n, F0 + n))
    faces.append((F0 + seg, F0 + n + seg, F1 + n + seg, F1 + seg))
    return K._new_obj(name, verts, faces, mat=mat, smooth=False)


def voussoirs(out, M, span, rise, depth, z_spring, x_c, y_c, n=11, mat="stone"):
    """Wedge stones round an arch's face -- the ring that makes it read as
    built rather than cut."""
    hs = span / 2
    R = (hs * hs + rise * rise) / (2 * rise)
    zc = rise - R
    a0 = math.atan2(0 - zc, -hs)
    a1 = math.atan2(0 - zc, hs)
    for i in range(n):
        t0 = a0 + (a1 - a0) * (i + 0.08) / n
        t1 = a0 + (a1 - a0) * (i + 0.92) / n
        tm = (t0 + t1) / 2
        rr = R + 0.14
        cxp = math.cos(tm) * rr
        czp = zc + math.sin(tm) * rr
        L = abs(t1 - t0) * rr
        b = bbox("voussoir", (0, 0, 0), (L / 2, depth / 2, 0.15), M[mat], bevel=0.02)
        K.transform(b, rotate=(0, -math.degrees(tm) + 90, 0), around=(0, 0, 0),
                    translate=(x_c + cxp, y_c, z_spring + czp))
        out.append(b)


def hip_roof(t, cx, cy, cz, hw, h, mat, out):
    """A square pyramid laid in courses, with capped hips -- for the tower."""
    M = t.M
    L = math.hypot(hw, h)
    n = max(4, int(L / 0.22))
    for face in range(4):
        pieces = []
        for k in range(n):
            s0 = k * L / n
            s1 = min(L, s0 + L / n + 0.04)
            half = hw * (1 - (s0 + s1) / 2 / L) + 0.02
            c = corrugated("tower_tile", -half, half, s0, s1, mat, hw, h, -1,
                           lip=0.028, amp=0.010, period=0.30)
            pieces.append(c)
        for c in pieces:
            K.transform(c, rotate=(0, 0, 90 * face), around=(0, 0, 0), translate=(cx, cy, cz))
        out += pieces
    for sx in (-1, 1):
        for sy in (-1, 1):
            out.append(K.tube("tower_hip", [
                {"p": Vector((cx + sx * hw, cy + sy * hw, cz + 0.04)), "r": (0.07, 0.06), "n": 2.0},
                {"p": Vector((cx, cy, cz + h + 0.06)), "r": (0.07, 0.06), "n": 2.0}],
                seg=8, mat=mat, up=(0, 0, 1)))


def clock(out, M, x, y, z, facing_x, r=0.82):
    """A clock face on a tower, set at twenty to six -- the hour the bell is
    late for."""
    s = 1 if facing_x > 0 else -1
    disc = K.tube("clock_face", [
        {"p": Vector((x - s * 0.06, y, z)), "r": (r, r), "n": 2.0},
        {"p": Vector((x + s * 0.05, y, z)), "r": (r, r), "n": 2.0}],
        seg=40, mat=M["cloth"], up=(0, 0, 1))
    out.append(disc)
    out.append(K.tube("clock_ring", [
        {"p": Vector((x + s * 0.04, y, z)), "r": (r + 0.10, r + 0.10), "n": 2.0},
        {"p": Vector((x + s * 0.09, y, z)), "r": (r + 0.10, r + 0.10), "n": 2.0}],
        seg=40, mat=M["stone"], up=(0, 0, 1)))
    for k in range(12):
        a = k * math.pi / 6
        L = 0.16 if k % 3 == 0 else 0.09
        tk = bbox("clock_tick", (0, 0, 0), (0.012, 0.03, L / 2), M["iron"], bevel=0.004)
        K.transform(tk, rotate=(math.degrees(a), 0, 0), around=(0, 0, 0),
                    translate=(x + s * 0.075, y + math.sin(a) * (r - 0.12), z + math.cos(a) * (r - 0.12)))
        out.append(tk)
    for ang, L, wdt in ((-(5 + 40 / 60) * 30, r * 0.52, 0.035), (-40 * 6, r * 0.78, 0.022)):
        hand = bbox("clock_hand", (0, 0, 0), (0.012, wdt, L / 2), M["iron"], bevel=0.004)
        K.transform(hand, translate=(0, 0, L / 2 - 0.05))
        K.transform(hand, rotate=(ang * s, 0, 0), around=(0, 0, 0), translate=(x + s * 0.10, y, z))
        out.append(hand)


def tower_dress(t, cx, cy, base, storeys, inner, taper, belfry_h):
    """Everything on the tower that is not structure: pilasters, a rusticated
    base, arched heads in the plaza arcade, clock faces, an arcaded belfry and
    a slate pyramid. Nothing here is collision; the tower's walls and stair
    are untouched."""
    M, out = t.M, []
    for i in range(storeys):
        z0 = 0.44 + 3.9 * i
        w = base * (1.0 - taper * i)
        th = w - inner
        # corner pilasters, proud of both faces
        for sx in (-1, 1):
            for sy in (-1, 1):
                out.append(bbox("tower_pilaster", (cx + sx * (w - 0.14), cy + sy * (w - 0.14), z0 + 1.95),
                                (0.22, 0.22, 1.95), M["stone"], bevel=0.02))
        if i == 0:
            # rustication: deep horizontal channels on the ground storey
            for k in range(1, 8):
                z = z0 + k * 0.48
                for sx in (-1, 1):
                    out.append(slab("tower_rustic", cx + sx * (w + 0.005), cx + sx * (w + 0.035),
                                    cy - w + 0.35, cy + w - 0.35, z - 0.035, z + 0.035, M["stone"]))
                out.append(slab("tower_rustic", cx - w + 0.35, cx + w - 0.35, cy - w - 0.035, cy - w - 0.005,
                                z - 0.035, z + 0.035, M["stone"]))
        else:
            # ARCHED HEADS in the plaza arcade: the tops of both openings fill
            # with a round arch and its voussoirs. The openings keep their
            # full width and most of their height -- the camera needs them.
            span = inner - 0.26
            rise = span / 2
            yc = cy + (inner + w) / 2
            for sgn in (-1, 1):
                xc = cx + sgn * (0.26 + span / 2)
                ap = arch_plate("tower_arch", span, rise, th * 2 - 0.02, M["stone"], rise=rise)
                K.transform(ap, translate=(xc, yc, z0 + 3.40 - rise))
                out.append(ap)
                voussoirs(out, M, span, rise, 0.10, z0 + 3.40 - rise, xc, cy + w + 0.03)
            # BLIND ARCADES on the other three faces: a frame of stone with
            # two round-headed arches, proud of the wall, so the faces the
            # valley sees carry the same rhythm as the open one
            for face in range(3):
                pieces = []
                fspan = inner - 0.30
                frise = fspan / 2
                zsp = z0 + 3.30 - frise
                for sgn in (-1, 1):
                    xo = sgn * (0.28 + fspan / 2)
                    ap = arch_plate("tower_blind", fspan, frise + 0.02, 0.10, M["stone"], rise=frise)
                    K.transform(ap, translate=(xo, -(w + 0.05), zsp))
                    pieces.append(ap)
                    voussoirs(pieces, M, fspan, frise, 0.08, zsp, xo, -(w + 0.09), n=9)
                    # the jambs down to a sill
                    for jx in (xo - fspan / 2 - 0.06, xo + fspan / 2 + 0.06):
                        pieces.append(bbox("tower_bjamb", (jx, -(w + 0.05), (z0 + 0.45 + zsp) / 2),
                                           (0.07, 0.06, (zsp - z0 - 0.45) / 2), M["stone"], bevel=0.01))
                    pieces.append(bbox("tower_bsill", (xo, -(w + 0.08), z0 + 0.42),
                                       (fspan / 2 + 0.16, 0.08, 0.05), M["stone"], bevel=0.01))
                    # a narrow lancet window in each arch
                    pieces.append(slab("tower_lancet", xo - 0.16, xo + 0.16, -(w + 0.005), -(w - 0.02),
                                       z0 + 1.1, zsp + frise * 0.55, M["timber"]))
                ang = (90, 180, -90)[face]
                for pc in pieces:
                    K.transform(pc, rotate=(0, 0, ang), around=(0, 0, 0), translate=(cx, cy, 0))
                out += pieces
            # a clock on the two side faces of the top shaft stage
            if i == storeys - 1:
                for sx in (-1, 1):
                    clock(out, M, cx + sx * (w + 0.02), cy, z0 + 2.15, sx)
    # the belfry: arches between the corner piers on all four sides
    top = 0.44 + 3.9 * storeys
    bw = base * (1.0 - taper * (storeys - 1))
    span = 2 * (bw - 0.44)
    zt = top + 2 * belfry_h
    for face in range(4):
        pieces = []
        rise = 0.95
        ap = arch_plate("belfry_arch", span, rise + 0.02, 0.36, M["stone"], rise=rise)
        K.transform(ap, translate=(0, -(bw - 0.20), zt - rise - 0.02))
        pieces.append(ap)
        # dentils under the lintel
        nd = int(2 * bw / 0.26)
        for k in range(nd):
            x = -bw + (k + 0.5) * 2 * bw / nd
            pieces.append(bbox("dentil", (x, -(bw + 0.08), zt + 0.03), (0.06, 0.06, 0.07), M["stone"], bevel=0.01))
        for p in pieces:
            K.transform(p, rotate=(0, 0, 90 * face), around=(0, 0, 0), translate=(cx, cy, 0))
        out += pieces
    # a slate pyramid laid in courses over the flat cap
    capz = top + 2 * belfry_h + 0.24
    hip_roof(t, cx, cy, capz + 0.01, bw + 0.34, 2.5, M["roof_b"], out)
    t.add(*out)
    return out
