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

# ── wheel bundle — postinst builds the venv on the target ────────────────
# A venv built here only works when the target's python3 matches this
# container's exactly (bin/python symlinks /usr/bin/python3 and deps ship
# per-version wheels), so the deb carries wheels and postinst creates
# /opt/gut/venv against the target interpreter.
apt-get update -qq
apt-get install -y -qq python3-pip ca-certificates curl >/dev/null
PYVERS="${WHEEL_PYVERS:-3.12 3.13 3.14}"
case "$ARCH" in
  amd64) MARCH=x86_64 ;;
  arm64) MARCH=aarch64 ;;
esac
WHEELS="$STAGE/opt/gut/wheels"
mkdir -p "$WHEELS"
# pyautogui's whole dependency family ships sdist-only on PyPI — all pure
# python, so wheel the full closure here and exclude pyautogui from the
# binary-only download.
DLREQS="$(mktemp)"
trap 'rm -rf "$(dirname "$STAGE")" "$DLREQS"' EXIT
grep -v '^pyautogui' "$ROOT/backend/requirements.txt" > "$DLREQS"
PYAUTO_VER="$(grep '^pyautogui' "$ROOT/backend/requirements.txt" | cut -d= -f3)"
python3 -m pip wheel --quiet -w "$WHEELS" "pyautogui==${PYAUTO_VER}"
for pv in $PYVERS; do
    python3 -m pip download --quiet --dest "$WHEELS" \
        --only-binary=:all: \
        --platform "manylinux_2_17_$MARCH" --platform "manylinux_2_28_$MARCH" \
        --platform "manylinux_2_34_$MARCH" --platform "manylinux_2_39_$MARCH" \
        --python-version "$pv" --implementation cp \
        --abi "cp${pv//./}" --abi abi3 --abi none \
        -r "$DLREQS" \
        -r "$ROOT/packaging/litellm-requirements.txt"
done
rm -f "$DLREQS"

# ── payload ───────────────────────────────────────────────────────────────
install -m755 "$ROOT/backend/start.sh" "$STAGE/opt/gut/start.sh"
install -m644 "$ROOT/backend/agent_daemon.py" "$STAGE/opt/gut/agent_daemon.py"
install -m644 "$ROOT/backend/tcpmux.py" "$STAGE/opt/gut/tcpmux.py"
install -m644 "$ROOT/backend/requirements.txt" "$STAGE/opt/gut/requirements.txt"
install -m644 "$ROOT/packaging/litellm-requirements.txt" \
            "$STAGE/opt/gut/litellm-requirements.txt"
install -m644 "$ROOT/backend/wallpaper.png" "$STAGE/opt/gut/wallpaper.png"
install -m644 "$ROOT/backend/device_wallpaper.py" \
            "$STAGE/opt/gut/device_wallpaper.py"
install -m644 "$ROOT/backend/atspi.py" "$STAGE/opt/gut/atspi.py"
install -m644 "$ROOT/backend/uno_eval.py" "$STAGE/opt/gut/uno_eval.py"
# soffice/libreoffice wrappers inject the UNO listener (see gut-office).
install -m755 "$ROOT/packaging/gut-office" "$STAGE/usr/local/bin/soffice"
install -m755 "$ROOT/packaging/gut-office" "$STAGE/usr/local/bin/libreoffice"
echo "$VERSION" > "$STAGE/opt/gut/VERSION"

install -m644 "$ROOT/litellm_config.yaml" "$STAGE/etc/gut/litellm.yaml"
install -m644 "$ROOT/packaging/chromium-gut.conf" "$STAGE/etc/chromium.d/gut"
printf 'gut ALL=(ALL) NOPASSWD:ALL\n' > "$STAGE/etc/sudoers.d/gut"
chmod 440 "$STAGE/etc/sudoers.d/gut"
# Browser launcher: not a plain symlink — it skips snap stubs (Ubuntu's
# `chromium` deb execs the snap, which can't run on many VPSes) and forces
# the CDP/no-sandbox flags whatever binary it picks.
install -m755 "$ROOT/packaging/gut-browser" "$STAGE/usr/local/bin/google-chrome"
# Provisions a real browser (Chrome on amd64) and the session's default-
# browser config; runs from postinst and every start.sh boot.
install -m755 "$ROOT/packaging/ensure-browser.sh" "$STAGE/opt/gut/ensure-browser.sh"

# ── openserp — the agent's web_search backend ────────────────────────────
# Static Go binary from a pinned upstream release; serves a multi-engine
# SERP API on 127.0.0.1:7070 via gut-openserp.service. Asset arch names
# match the deb's (amd64|arm64).
OPENSERP_VERSION="${OPENSERP_VERSION:-0.8.12}"
curl -fsSL "https://github.com/karust/openserp/releases/download/v${OPENSERP_VERSION}/openserp-linux-${ARCH}-${OPENSERP_VERSION}.tgz" \
    | tar xz -C "$STAGE/opt/gut"   # the tarball contains ./openserp
chmod 755 "$STAGE/opt/gut/openserp"
# Browser launcher: resolves a real (non-snap) Chrome/Chromium and adds
# --no-sandbox only — openserp's go-rod supplies its own CDP port/profile.
install -m755 "$ROOT/packaging/openserp-browser" \
              "$STAGE/opt/gut/openserp-browser"

install -m644 "$ROOT/packaging/systemd/gut-bot.service" \
              "$ROOT/packaging/systemd/gut-litellm.service" \
              "$ROOT/packaging/systemd/gut-openserp.service" \
              "$STAGE/usr/lib/systemd/system/"
install -m755 "$ROOT/packaging/gut-bot" "$STAGE/usr/bin/gut-bot"

# ── DEBIAN metadata ───────────────────────────────────────────────────────
DEPS=$(grep -v '^\s*#' "$ROOT/packaging/apt-deps.txt" | grep -v '^\s*$' \
       | paste -sd, -)
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" \
    -e "s/@DEPS@/$DEPS,chromium | google-chrome-stable,postgresql/" \
    "$ROOT/packaging/debian/control" > "$STAGE/DEBIAN/control"
for s in postinst prerm postrm; do
    install -m755 "$ROOT/packaging/debian/$s" "$STAGE/DEBIAN/$s"
done
install -m644 "$ROOT/packaging/debian/conffiles" "$STAGE/DEBIAN/conffiles"

OUT="$OUTDIR/gut-bot_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT"
echo "built $OUT"
