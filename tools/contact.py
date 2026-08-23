"""contact -- tile PNGs into one labelled strip.

A choice between four poses is not four pictures, it is one picture. Flipping
between files compares each shot against your memory of the last one, which is
exactly the comparison that cannot be made accurately -- and it is the reason
`anim_preview` builds a contact sheet rather than writing eight frames.

    python3 tools/contact.py -- --out sheet.png --label A,B,C,D a.png b.png c.png

No font is available here, so the labels are drawn from a 5x7 bitmap. That
covers A-Z and 0-9, which is all a variant label ever needs to be.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy

import surface_tex

# 5x7, one string of five bits per row.
GLYPHS = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00111", "00010", "00010", "00010", "00010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00110", "01000", "10000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    "-": ("00000", "00000", "00000", "01110", "00000", "00000", "00000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    " ": ("00000",) * 7,
}


def stamp(img, text, x, y, scale=4, colour=(1.0, 0.92, 0.55)):
    """Draw `text` into `img` (H,W,3 float) with its top-left at (x, y)."""
    for ch in text.upper():
        g = GLYPHS.get(ch)
        if g is None:
            x += 6 * scale
            continue
        for r, row in enumerate(g):
            for c, bit in enumerate(row):
                if bit != "1":
                    continue
                y0, x0 = y + r * scale, x + c * scale
                img[y0:y0 + scale, x0:x0 + scale] = colour
        x += 6 * scale
    return x


def read(path):
    im = bpy.data.images.load(os.path.abspath(path))
    w, h = im.size
    px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(im)
    return px[::-1, :, :3]          # bpy pixels are bottom-up


def sheet(paths, out, labels=None, gutter=6, bg=0.08):
    tiles = [read(p) for p in paths]
    h = min(t.shape[0] for t in tiles)
    tiles = [t[:h] for t in tiles]
    w = sum(t.shape[1] for t in tiles) + gutter * (len(tiles) - 1)
    img = np.full((h, w, 3), bg, dtype=np.float32)
    x = 0
    for i, t in enumerate(tiles):
        img[:, x:x + t.shape[1]] = t
        if labels and i < len(labels):
            # a dark plate under the label, so it survives a pale background
            lw = 6 * 4 * len(labels[i]) + 12
            img[8:8 + 7 * 4 + 12, x + 8:x + 8 + lw] = 0.05
            stamp(img, labels[i], x + 14, 14)
        x += t.shape[1] + gutter
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    surface_tex.write_png(out, img)
    print(f"[contact] {len(tiles)} tiles -> {out} ({w}x{h})")
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(f, d=None):
        return argv[argv.index(f) + 1] if f in argv else d

    out = opt("--out", "sheet.png")
    labels = opt("--label")
    skip = {"--out", "--label", out, labels}
    paths = [a for a in argv if a not in skip and a.endswith(".png")]
    if not paths:
        raise SystemExit("[contact] give some .png paths")
    sheet(paths, out, labels.split(",") if labels else None)


if __name__ == "__main__":
    main()
