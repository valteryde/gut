#!/usr/bin/env python3
"""Derive a per-device wallpaper from the shipped base art.

Every backend runs the same /opt/gut/wallpaper.png; this rotates its hue by
an amount derived from DEVICE_NAME, so each VPS's desktop is a visibly
different color and you can tell at a glance which machine a stream shows.

Deterministic: the same device name always produces the same hue, so the
background survives reboots and upgrades. `local` keeps the brand mint.

    python3 device_wallpaper.py --name my-vps \
        --base /opt/gut/wallpaper.png --out ~/.gut/wallpaper.png

Override the hue explicitly with WALLPAPER_HUE=<deg> or --hue when two
devices collide. Pillow-only — numpy is not installed on the targets.
"""

import argparse
import os
import shutil
import zlib

from PIL import Image

# Hue slots are spaced 45 deg apart for maximum separation between devices.
# Non-local devices skip slot 0 so no VPS lands on local's signature mint.
SLOT_DEG = 45
LOCAL_NAMES = {"", "local", "localhost", "127.0.0.1"}


def hue_for(name):
    if name.strip().lower() in LOCAL_NAMES:
        return 0
    return SLOT_DEG + zlib.crc32(name.strip().lower().encode()) % 7 * SLOT_DEG


def rotate(base, out, deg):
    if deg % 360 == 0:
        shutil.copyfile(base, out)
        return
    shift = round(deg * 256 / 360) % 256
    img = Image.open(base).convert("RGB")
    h, s, v = img.convert("HSV").split()
    table = [(i + shift) % 256 for i in range(256)]
    Image.merge("HSV", (h.point(table), s, v)).convert("RGB").save(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", default=os.environ.get("DEVICE_NAME", ""))
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--hue", type=int,
                    default=os.environ.get("WALLPAPER_HUE"))
    args = ap.parse_args()

    deg = int(args.hue) % 360 if args.hue is not None else hue_for(args.name)
    rotate(args.base, args.out, deg)
    print(f"[gut] wallpaper for '{args.name or 'local'}': hue +{deg}deg -> {args.out}")


if __name__ == "__main__":
    main()
