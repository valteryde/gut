#!/usr/bin/env bash
# Render electron/resources/icon.svg into the icon set electron-builder and
# the dev-branding script consume: icon.icns (mac), icon.png (linux/win),
# icon.ico is produced by electron-builder from the png.
# Requires macOS (iconutil) + rsvg-convert (`brew install librsvg`).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=resources/icon.svg
ICONSET=/tmp/gut.iconset

command -v rsvg-convert >/dev/null || {
  echo "rsvg-convert not found — brew install librsvg" >&2; exit 1; }

rm -rf "$ICONSET" && mkdir -p "$ICONSET"
rsvg-convert -w 1024 -h 1024 "$SRC" -o resources/icon.png

for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" "$SRC" \
    -o "$ICONSET/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) "$SRC" \
    -o "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o resources/icon.icns
rm -rf "$ICONSET"
echo "wrote resources/icon.png + resources/icon.icns"
