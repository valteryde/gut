#!/usr/bin/env bash
# Build gut-bot_<version>_<arch>.deb
#
# Must run on a Debian/Ubuntu host (or debian:trixie container) matching the
# target architecture — the package embeds a prebuilt Python venv whose
# binaries and console-script shebangs are arch- and path-sensitive.
# CI runs this inside docker (`docker run --platform=linux/arm64 debian:trixie`).
#
# usage: packaging/build-deb.sh <version> <amd64|arm64> [outdir]
set -euo pipefail

VERSION="${1:?missing version}"
ARCH="${2:?missing arch (amd64|arm64)}"
OUTDIR="${3:-dist}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v dpkg-deb >/dev/null || {
    echo "dpkg-deb not found — run this on Debian/Ubuntu or in debian:trixie" >&2
    exit 1
}

STAGE="$(mktemp -d)/gut-bot_${VERSION}_${ARCH}"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT
mkdir -p "$STAGE/DEBIAN" "$STAGE/opt/gut" "$STAGE/etc/gut" \
         "$STAGE/etc/chromium.d" "$STAGE/etc/sudoers.d" \
         "$STAGE/usr/bin" "$STAGE/usr/local/bin" \
         "$STAGE/usr/lib/systemd/system" "$OUTDIR"

# ── Python venv, built at its final install path ──────────────────────────
# Console scripts (litellm, uvicorn) embed the interpreter path, so the venv
# must be created at /opt/gut/venv and then copied into the staging tree.
VENV=/opt/gut/venv
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip >/dev/null
rm -rf "$VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --no-cache-dir \
    -r "$ROOT/backend/requirements.txt" 'litellm[proxy]'
cp -a "$VENV" "$STAGE/opt/gut/venv"
find "$STAGE/opt/gut/venv" -name __pycache__ -type d -prune -exec rm -rf {} +

# ── payload ───────────────────────────────────────────────────────────────
install -m755 "$ROOT/backend/start.sh" "$STAGE/opt/gut/start.sh"
install -m644 "$ROOT/backend/agent_daemon.py" "$STAGE/opt/gut/agent_daemon.py"
install -m644 "$ROOT/backend/wallpaper.png" "$STAGE/opt/gut/wallpaper.png"
echo "$VERSION" > "$STAGE/opt/gut/VERSION"

install -m644 "$ROOT/litellm_config.yaml" "$STAGE/etc/gut/litellm.yaml"
install -m644 "$ROOT/packaging/chromium-gut.conf" "$STAGE/etc/chromium.d/gut"
printf 'gut ALL=(ALL) NOPASSWD:ALL\n' > "$STAGE/etc/sudoers.d/gut"
chmod 440 "$STAGE/etc/sudoers.d/gut"
ln -sf /usr/bin/chromium "$STAGE/usr/local/bin/google-chrome"

install -m644 "$ROOT/packaging/systemd/gut-bot.service" \
              "$ROOT/packaging/systemd/gut-litellm.service" \
              "$STAGE/usr/lib/systemd/system/"
install -m755 "$ROOT/packaging/gut-bot" "$STAGE/usr/bin/gut-bot"

# ── DEBIAN metadata ───────────────────────────────────────────────────────
DEPS=$(grep -v '^\s*#' "$ROOT/packaging/apt-deps.txt" | grep -v '^\s*$' \
       | paste -sd, -)
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" \
    -e "s/@DEPS@/$DEPS,chromium,postgresql/" \
    "$ROOT/packaging/debian/control" > "$STAGE/DEBIAN/control"
for s in postinst prerm postrm; do
    install -m755 "$ROOT/packaging/debian/$s" "$STAGE/DEBIAN/$s"
done
install -m644 "$ROOT/packaging/debian/conffiles" "$STAGE/DEBIAN/conffiles"

OUT="$OUTDIR/gut-bot_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT"
echo "built $OUT"
