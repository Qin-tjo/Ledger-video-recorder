#!/usr/bin/env python3
"""Generate the Ledger Video Recorder app icon (.icns + .ico) from code — no external assets.

Design: an indigo squircle with a soft diagonal gradient, a white recording ring,
and a play triangle at its center (screen + video recording motif).
Run:  python3 build/make-icons.py
"""
import math
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build_master():
    # Diagonal gradient background (accent indigo -> deep violet)
    c1 = (0x81, 0x8c, 0xf8)  # accent-hover
    c2 = (0x4f, 0x46, 0xe5)  # indigo-600
    c3 = (0x31, 0x2e, 0x81)  # indigo-900

    bg = Image.new("RGB", (S, S), c2)
    px = bg.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * (S - 1))
            if t < 0.5:
                px[x, y] = lerp(c1, c2, t * 2)
            else:
                px[x, y] = lerp(c2, c3, (t - 0.5) * 2)

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # macOS-style squircle: inset margin + generous radius
    margin = int(S * 0.08)
    inner = S - margin * 2
    radius = int(inner * 0.235)
    mask = rounded_mask(inner, radius)

    # Add a soft top-down gloss to the gradient, then paste through the mask so it
    # never bleeds outside the squircle (no gray halo).
    gloss = Image.new("L", (inner, inner), 0)
    gd = ImageDraw.Draw(gloss)
    gd.ellipse([-inner * 0.2, -inner * 0.55, inner * 1.2, inner * 0.5], fill=60)
    gloss = gloss.filter(ImageFilter.GaussianBlur(inner * 0.06))
    bg_cropped = bg.resize((inner, inner)).convert("RGBA")
    white_inner = Image.new("RGBA", (inner, inner), (255, 255, 255, 255))
    bg_cropped = Image.composite(white_inner, bg_cropped, gloss)
    icon.paste(bg_cropped, (margin, margin), mask)

    draw = ImageDraw.Draw(icon)
    cx = cy = S // 2

    # Recording ring
    ring_r = int(S * 0.235)
    ring_w = int(S * 0.055)
    draw.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
                 outline=(255, 255, 255, 235), width=ring_w)

    # Play triangle (centered, slight optical offset right)
    tri = int(S * 0.135)
    offset = int(tri * 0.18)
    p1 = (cx - tri * 0.72 + offset, cy - tri)
    p2 = (cx - tri * 0.72 + offset, cy + tri)
    p3 = (cx + tri + offset, cy)
    draw.polygon([p1, p2, p3], fill=(255, 255, 255, 245))

    return icon


def make_icns(master):
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for s in sizes:
            img = master.resize((s, s), Image.LANCZOS)
            img.save(os.path.join(iconset, f"icon_{s}x{s}.png"))
            if s <= 512:
                img2 = master.resize((s * 2, s * 2), Image.LANCZOS)
                img2.save(os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
        out = os.path.join(HERE, "icon.icns")
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out], check=True)
        print("wrote", out)


def make_ico(master):
    out = os.path.join(HERE, "icon.ico")
    master.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64),
                            (128, 128), (256, 256)])
    print("wrote", out)


def make_png(master):
    out = os.path.join(HERE, "icon.png")
    master.resize((512, 512), Image.LANCZOS).save(out)
    print("wrote", out)


if __name__ == "__main__":
    master = build_master()
    make_png(master)
    make_icns(master)
    make_ico(master)
