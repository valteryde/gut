#!/usr/bin/env python3
"""Procedurally generate gut's desktop wallpaper.

backend/wallpaper.png is produced by this script — deterministic for a given
--seed, no external assets. Palette is anchored on the client design tokens
(styles.css): warm paper neutrals + mint/teal accent, mint = the agent.

    pip install numpy pillow
    python wallpaper.py --variant aurora          # writes wallpaper.png
    python wallpaper.py --variant all --outdir /tmp/walls
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageDraw

W, H = 1920, 1080
SS = 2  # supersample factor — render big, downscale for smooth edges

# design tokens (client/styles.css)
INK = (30, 29, 26)      # --text
BONE = (244, 240, 231)  # --bg, warm paper
MIST = (220, 245, 236)  # --mint-soft
MINT = (94, 227, 189)   # --mint
TEAL = (20, 107, 80)    # --mint-ink
DEEP = (15, 42, 34)     # --on-mint
CLAY = (221, 143, 107)  # --clay


# ── noise ────────────────────────────────────────────────────────────────

def _sample_grid(g, u, v):
    """Bilinear-sample lattice g at coords u,v — periodic, so warped
    coordinates can leave [0,1] and wrap seamlessly instead of clamping
    into edge streaks."""
    gh, gw = g.shape
    fx = u * gw
    fy = v * gh
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    dx = fx - x0
    dy = fy - y0
    dx = dx * dx * (3 - 2 * dx)
    dy = dy * dy * (3 - 2 * dy)
    x0 %= gw
    y0 %= gh
    x1 = (x0 + 1) % gw
    y1 = (y0 + 1) % gh
    top = g[y0, x0] * (1 - dx) + g[y0, x1] * dx
    bot = g[y1, x0] * (1 - dx) + g[y1, x1] * dx
    return top * (1 - dy) + bot * dy


def make_fbm(rng, base=4, octaves=5, gain=0.5):
    """Value-noise fbm evaluated at arbitrary coords: f(u, v) -> [0,1]."""
    lattices = []
    res, amp, total = base, 1.0, 0.0
    for _ in range(octaves):
        lattices.append((rng.random((res, res)).astype(np.float32), amp))
        total += amp
        amp *= gain
        res *= 2
    def f(u, v):
        out = np.zeros(u.shape, np.float32)
        for g, a in lattices:
            out += a * _sample_grid(g, u, v)
        return out / total
    return f


# ── shared helpers ───────────────────────────────────────────────────────

def palette(stops):
    """[(pos, rgb), ...] -> fn t[H,W] in [0,1] -> rgb float32 [H,W,3]."""
    pos = np.array([p for p, _ in stops], np.float32)
    col = np.array([c for _, c in stops], np.float32)
    def f(t):
        shape = t.shape
        tf = np.clip(t.ravel(), 0, 1)
        out = np.stack(
            [np.interp(tf, pos, col[:, ch]) for ch in range(3)], axis=-1
        )
        return out.reshape(*shape, 3)
    return f


def coords(w, h):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    return x / w, y / h


def stretch(t, lo=5, hi=95):
    """Percentile-normalize a field to [0,1]."""
    a, b = np.percentile(t, lo), np.percentile(t, hi)
    return np.clip((t - a) / max(b - a, 1e-6), 0, 1)


def finish(img, rng, grain_amt=2.8, vig=0.14, vig_pow=1.7):
    """Film grain (dithers away gradient banding) + gentle vignette."""
    h, w = img.shape[:2]
    img = img + rng.normal(0, grain_amt, (h, w, 1)).astype(np.float32)
    nx, ny = coords(w, h)
    d = np.sqrt(((nx - 0.5) * 2) ** 2 + ((ny - 0.5) * 2) ** 2) / np.sqrt(2)
    img *= (1 - vig * np.clip(d, 0, 1) ** vig_pow)[..., None]
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def downscale(img):
    if SS == 1:
        return img
    return img.resize((W, H), Image.LANCZOS)


# ── variants ─────────────────────────────────────────────────────────────

def aurora(seed):
    """Domain-warped gradient currents — macOS-style flowing color field."""
    rng = np.random.default_rng(seed)
    w, h = W * SS, H * SS
    u, v = coords(w, h)
    u *= w / h  # keep features isotropic

    f = make_fbm(rng, base=3, octaves=5)
    g = make_fbm(rng, base=4, octaves=4)
    n = make_fbm(rng, base=5, octaves=4)

    # two rounds of domain warping = flowing, marbled structure
    qu = u + 0.45 * (f(u, v) - 0.5) * 2
    qv = v + 0.45 * (f(u + 5.2, v + 1.3) - 0.5) * 2

    # gentle swirl around a focal point keeps the ribbons from looking
    # like plain horizontal waves
    cx, cy = 0.9, 0.30
    dx, dy = qu - cx, qv - cy
    r = np.hypot(dx, dy)
    tw = 0.55 * np.exp(-r * 1.4)
    ru = cx + dx * np.cos(tw) - dy * np.sin(tw)
    rv = cy + dx * np.sin(tw) + dy * np.cos(tw)

    su = ru + 0.25 * (g(ru, rv) - 0.5) * 2
    sv = rv + 0.25 * (g(ru + 3.1, rv + 7.7) - 0.5) * 2
    m = stretch(n(su, sv), 2, 98)

    # deep blue only in the upper tail of the field -> rivers and pools
    # with real negative space, not 50/50 marble
    t = np.clip((m - 0.52) / 0.48, 0, 1) ** 0.85

    pal = palette([
        (0.00, (251, 248, 242)),   # surface
        (0.35, (233, 237, 225)),   # paper drifting toward sage
        (0.62, (165, 214, 195)),   # mint mid
        (0.85, (62, 158, 128)),    # mint -> teal
        (0.96, TEAL),              # --mint-ink
        (1.00, DEEP),              # --on-mint
    ])
    img = pal(t)

    # faint clouding in the pale areas so they aren't dead flat
    img += ((m - 0.5) * 20 * (1 - t))[..., None]

    # soft highlight drifting across the field
    glow = np.exp(-(((u - 0.55) ** 2) / 0.18 + ((v - 0.30) ** 2) / 0.10))
    img += (glow[..., None] * np.array([10, 9, 6], np.float32))
    return downscale(finish(img, rng))


def flow(seed):
    """Silk streamlines advected through a curl-ish fbm flow field."""
    rng = np.random.default_rng(seed)
    w, h = W * SS, H * SS
    u, v = coords(w, h)

    angle_n = make_fbm(rng, base=3, octaves=4)
    col_n = make_fbm(rng, base=4, octaves=4)

    # base: quiet diagonal wash, paper -> mint mist -> sage
    t = np.clip(0.62 * v + 0.38 * u + 0.12, 0, 1)
    base_pal = palette([
        (0.0, (240, 236, 228)),
        (0.45, (222, 232, 226)),
        (1.0, (150, 190, 172)),
    ])
    img = base_pal(t)

    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    pal = palette([
        (0.0, MIST),
        (0.45, (110, 180, 155)),
        (0.8, TEAL),
        (1.0, DEEP),
    ])

    n_lines = 2200
    steps = 300
    dt = 2.4 * SS
    seeds = np.column_stack(
        [rng.random(n_lines) * w, rng.random(n_lines) * h]
    ).astype(np.float32)
    # darker ink where lines land lower in the frame
    depth = np.clip(seeds[:, 1] / h + 0.25 * (col_n(seeds[:, 0] / w, seeds[:, 1] / h) - 0.5), 0, 1)
    cols = pal(depth).astype(np.uint8)
    alphas = rng.integers(24, 80, n_lines)
    widths = rng.integers(1, 5, n_lines)
    # a few hero strokes — thicker, darker, higher alpha
    hero = rng.random(n_lines) < 0.06
    widths[hero] = rng.integers(4, 8, hero.sum())
    alphas[hero] = rng.integers(90, 150, hero.sum())

    for i in range(n_lines):
        p = seeds[i].copy()
        pts = [tuple(p)]
        for _ in range(steps):
            th = angle_n(p[0] / w * 1.4, p[1] / h * 1.4) * np.pi * 3.4
            p = p + dt * np.array([np.cos(th), np.sin(th)], np.float32)
            if p[0] < -8 or p[0] > w + 8 or p[1] < -8 or p[1] > h + 8:
                break
            pts.append(tuple(p))
        if len(pts) > 4:
            c = cols[i]
            draw.line(
                pts,
                fill=(int(c[0]), int(c[1]), int(c[2]), int(alphas[i])),
                width=int(widths[i]) * SS,
                joint="curve",
            )

    base_img = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    base_img = Image.alpha_composite(
        base_img.convert("RGBA"), overlay
    ).convert("RGB")
    base_img = downscale(base_img)
    arr = np.asarray(base_img).astype(np.float32)
    return finish(arr, rng)


def ridges(seed):
    """Layered dune horizons with atmospheric depth — calm and minimal."""
    rng = np.random.default_rng(seed)
    w, h = W * SS, H * SS
    u, v = coords(w, h)
    f = make_fbm(rng, base=3, octaves=5)

    sky = palette([(0.0, (249, 246, 240)), (1.0, (226, 236, 230))])
    img = sky(v)

    # hazy sun high in the frame — a soft pale disc bleeding into the sky
    sun_u, sun_v = 0.68, 0.24
    sd = np.sqrt((u - sun_u) ** 2 + ((v - sun_v) * h / w) ** 2)
    img += (np.exp(-sd * 9) * 26 + np.exp(-sd * 2.6) * 12)[..., None]

    layers = 8
    for i in range(layers):
        depth = i / (layers - 1)
        horizon = (
            0.30
            + 0.075 * i
            + 0.16 * (f(u * (0.8 + 0.25 * i), np.full_like(u, 0.13 * i + 0.05)) - 0.5)
            + 0.05 * (f(u * 3.1, np.full_like(u, 0.71 + 0.09 * i)) - 0.5)
        )
        mask = np.clip((v - horizon) * h / (2.5 * SS), 0, 1)  # ~2.5px soft edge
        col = np.array(
            np.array(BONE) * (1 - depth) + np.array(TEAL) * depth,
            np.float32,
        )
        # fade each layer slightly toward the sky behind it (haze)
        haze = np.array((228, 238, 231), np.float32)
        col = col * (1 - 0.35 * (1 - depth)) + haze * (0.35 * (1 - depth))
        img = img * (1 - mask[..., None]) + col * mask[..., None]
    return downscale(finish(img, rng))


VARIANTS = {"aurora": aurora, "flow": flow, "ridges": ridges}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--variant", choices=[*VARIANTS, "all"], default="aurora")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="wallpaper.png")
    ap.add_argument("--outdir", help="write one PNG per variant here")
    args = ap.parse_args()

    if args.variant == "all" or args.outdir:
        outdir = args.outdir or os.path.dirname(os.path.abspath(args.out))
        os.makedirs(outdir, exist_ok=True)
        for name, fn in VARIANTS.items():
            path = os.path.join(outdir, f"wallpaper-{name}.png")
            fn(args.seed).save(path)
            print(f"[gut] wrote {path}")
        return

    VARIANTS[args.variant](args.seed).save(args.out)
    print(f"[gut] wrote {args.out} ({args.variant}, seed {args.seed})")


if __name__ == "__main__":
    main()
