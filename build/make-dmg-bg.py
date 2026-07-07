#!/usr/bin/env python3
"""Generate the .dmg installer background (drag-to-Applications) from code.
Run:  python3 build/make-dmg-bg.py
Outputs build/dmg-background.png (540x380) and @2x (1080x760).
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 540, 380

# icon centers must match electron-builder.yml dmg.contents positions
APP_XY = (140, 205)
APPS_XY = (400, 205)


def load_font(size, bold=False):
    for path in [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(scale):
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h), (11, 12, 16))
    px = img.load()
    c1, c2 = (0x16, 0x18, 0x22), (0x0b, 0x0c, 0x10)
    for y in range(h):
        row = lerp(c1, c2, y / h)
        for x in range(w):
            px[x, y] = row
    d = ImageDraw.Draw(img)

    title = load_font(26 * scale)
    sub = load_font(13 * scale)

    def center_text(text, cx, cy, font, fill):
        bbox = d.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text((cx - tw / 2, cy - th / 2), text, font=font, fill=fill)

    center_text("Ledger Video Recorder", (W / 2) * scale, 58 * scale, title, (236, 238, 246))
    center_text(
        "Drag the app onto the Applications folder to install",
        (W / 2) * scale,
        330 * scale,
        sub,
        (150, 154, 168),
    )

    # arrow between the two icon slots
    ax0 = (APP_XY[0] + 78) * scale
    ax1 = (APPS_XY[0] - 78) * scale
    ay = APP_XY[1] * scale
    accent = (0x81, 0x8c, 0xf8)
    d.line([(ax0, ay), (ax1, ay)], fill=accent, width=max(2, 3 * scale))
    head = 9 * scale
    d.polygon(
        [(ax1, ay), (ax1 - head, ay - head * 0.7), (ax1 - head, ay + head * 0.7)],
        fill=accent,
    )
    return img


for scale, name in [(1, "dmg-background.png"), (2, "dmg-background@2x.png")]:
    out = os.path.join(HERE, name)
    render(scale).save(out)
    print("wrote", out)
