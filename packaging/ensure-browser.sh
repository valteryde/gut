#!/bin/sh
# ensure-browser — give the gut desktop a browser that actually launches.
#
# Debian's `chromium` deb is a normal binary, but Ubuntu's is a transitional
# stub that execs the snap — and snap-confined apps fail to exec on many
# VPSes (no squashfs/loop support). XFCE's exo-open then reports "Failed to
# execute default Web Browser / Input/output error" and the agent's
# browser_* tools can't start Chrome either.
#
# Provisioning order (first working browser wins):
#   amd64: official Google Chrome deb
#   all:   Chrome for Testing zip (Google's automation build — real CDP,
#          linux64 AND linux-arm64, needs no apt/snap)
#   all:   Firefox from Mozilla's apt repo (real deb on amd64+arm64 — no
#          CDP in Firefox 141+, but a working default browser for the GUI)
#
# It also pins the gut session's default browser to the
# /usr/local/bin/google-chrome wrapper, so exo-open/xdg-open, .desktop icons
# and the agent daemon all land on the same binary.
#
# Runs as root: from postinst (deb install/upgrade, incl. self-update), from
# start.sh via `sudo -n` on every service start, and from the agent daemon
# when a browser launch fails. Idempotent — a fast no-op once a real browser
# exists; provisioning retries at most every 30 min.
#
# Modes:
#   (no args)      provision if needed, then write session config
#   --deferred     wait for the dpkg lock to clear, then run the normal path.
#                  Spawned via systemd-run because postinst can't take the
#                  apt lock — it runs inside the transaction holding it.
set -u

GUT_HOME=/var/lib/gut
CHROME_URL="https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
CFT_META="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
STAMP_DIR="$GUT_HOME/.gut"
CHROME_DEB="$STAMP_DIR/.chrome-install.deb"
STAMP="$STAMP_DIR/browser-provision.try"
LOCK="$STAMP_DIR/.browser-provision.lock"
CFT_DIR=/opt/gut/browsers
CFT_BIN="$CFT_DIR/cft/chrome"
WRAP=/usr/local/bin/google-chrome

log()  { echo "[gut] ensure-browser: $*"; }
warn() { echo "[gut] ensure-browser: $*" >&2; }

is_snap() {
  [ -e "$1" ] || return 1
  case "$(readlink -f "$1" 2>/dev/null)" in
    /snap/*|/var/lib/snapd/*) return 0 ;;
  esac
  # Ubuntu's stub execs /snap/bin/chromium directly — it never spells out
  # "snap run", so look for any /snap/ or snapd reference in the wrapper.
  head -c 4096 "$1" 2>/dev/null | grep -qE 'snap run|/snap/|snapd|snap install'
}

# Actually run it — an extracted-but-dependency-broken browser must count as
# absent so the next provisioning attempt repairs it. The snap stub passes
# `--version` as root (snap-confine only refuses the gut service cgroup) and
# prints a version ending in "snap", so reject that output too.
runnable() {
  out="$(timeout 15 "$1" --version 2>/dev/null)" || return 1
  case "$out" in *[Ss]nap*) return 1 ;; esac
  return 0
}

# apt runs unattended here (postinst, start.sh, daemon kick) — a conffile
# prompt on a dead stdin would hang the provisioner while it holds the lock.
export DEBIAN_FRONTEND=noninteractive
apt_install() {
  apt-get install -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

find_cdp_browser() {
  for b in /usr/bin/google-chrome-stable /usr/bin/google-chrome \
           /opt/google/chrome/google-chrome "$CFT_BIN"; do
    [ -x "$b" ] && runnable "$b" && { echo "$b"; return 0; }
  done
  for c in /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -e "$c" ] && ! is_snap "$c" && runnable "$c" && { echo "$c"; return 0; }
  done
  return 1
}

find_any_browser() {
  find_cdp_browser && return 0
  for f in /usr/bin/firefox /usr/bin/firefox-esr; do
    [ -x "$f" ] && ! is_snap "$f" && runnable "$f" && { echo "$f"; return 0; }
  done
  return 1
}

# True while a dpkg/apt transaction is running — maintainer scripts set
# DPKG_MAINTSCRIPT_NAME; the lock check catches stragglers.
apt_busy() {
  [ -n "${DPKG_MAINTSCRIPT_NAME:-}${DPKG_MAINTSCRIPT_PACKAGE:-}" ] && return 0
  python3 - <<'PY' 2>/dev/null && return 1 || return 0
import fcntl
f = open("/var/lib/dpkg/lock-frontend", "w")
fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
PY
}

unzip() {  # python3 is guaranteed by the package deps; unzip may not be
  python3 -m zipfile -e "$1" "$2"
}

# Shared libs a chromium-family binary needs — the xfce stack covers most,
# but minimal/derived images can lack some. Names differ across releases
# (t64 transition), so install per-package and ignore misses.
chrome_deps() {
  apt_busy && return 1
  apt-get update -qq >/dev/null 2>&1 || true
  for p in libglib2.0-0t64 libglib2.0-0 libnss3 libnspr4 libatk1.0-0t64 \
           libatk1.0-0 libatk-bridge2.0-0t64 libatk-bridge2.0-0 libdbus-1-3 \
           libcups2t64 libcups2 libxcb1 libxkbcommon0 libasound2t64 libasound2 \
           libgbm1 libx11-6 libx11-xcb1 libxext6 libxcursor1 libxi6 libxtst6 \
           libxss1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
           libatspi2.0-0t64 libatspi2.0-0 libdrm2 libexpat1 libcairo2 \
           libpango-1.0-0 libpangocairo-1.0-0 fonts-liberation; do
    apt_install "$p" >/dev/null 2>&1
  done
}

try_chrome_deb() {  # amd64 only
  wget -q -T 30 -O "$CHROME_DEB" "$CHROME_URL" || { rm -f "$CHROME_DEB"; return 1; }
  if apt_install "$CHROME_DEB"; then
    rm -f "$CHROME_DEB"; return 0
  fi
  warn "apt install of chrome deb failed — extracting payload (no repo/deps)"
  dpkg-deb -x "$CHROME_DEB" / || { rm -f "$CHROME_DEB"; return 1; }
  rm -f "$CHROME_DEB"
  [ -e /usr/bin/google-chrome ] || \
    ln -sf /usr/bin/google-chrome-stable /usr/bin/google-chrome
  return 0
}

# Chrome for Testing — official Google build for automation, plain zip, both
# arches. No apt needed, so this works even inside a dpkg transaction.
try_chrome_for_testing() {
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    amd64)         plat=linux64 ;;
    arm64|aarch64) plat=linux-arm64 ;;
    *)             return 1 ;;
  esac
  url="$(wget -q -T 15 -O- "$CFT_META" | python3 -c \
    'import json,sys
dls = json.load(sys.stdin)["channels"]["Stable"]["downloads"]["chrome"]
print(next(d["url"] for d in dls if d["platform"] == sys.argv[1]))' \
    "$plat" 2>/dev/null)" || url=""
  [ -n "$url" ] || { warn "cft: could not resolve latest build"; return 1; }
  zip="$STAMP_DIR/.cft.zip"
  wget -q -T 60 -O "$zip" "$url" \
    || { rm -f "$zip"; warn "cft: download failed"; return 1; }
  rm -rf "$CFT_DIR/cft.tmp" "$CFT_DIR/cft"
  mkdir -p "$CFT_DIR/cft.tmp"
  unzip "$zip" "$CFT_DIR/cft.tmp" || { rm -rf "$CFT_DIR/cft.tmp" "$zip"; return 1; }
  rm -f "$zip"
  mv "$CFT_DIR/cft.tmp"/chrome-* "$CFT_DIR/cft" || { rm -rf "$CFT_DIR/cft.tmp"; return 1; }
  rm -rf "$CFT_DIR/cft.tmp"
  chmod -R a+rX "$CFT_DIR"
  [ -x "$CFT_BIN" ] || chmod +x "$CFT_BIN" 2>/dev/null || true
  runnable "$CFT_BIN" || chrome_deps   # apt is free on the direct path
  if runnable "$CFT_BIN"; then
    log "installed Chrome for Testing -> $CFT_BIN"
    return 0
  fi
  miss="$(ldd "$CFT_BIN" 2>/dev/null | awk '/not found/{print $1}' | paste -sd' ' -)"
  warn "cft chrome won't run — missing libraries: ${miss:-unknown}"
  return 1
}

# Firefox from Mozilla's own apt repo — real debs for amd64+arm64 (Ubuntu's
# repo only carries the snap stub). Pinned above the stub per Mozilla docs.
try_firefox() {
  apt_busy && return 1
  mkdir -p /etc/apt/keyrings
  wget -q -T 15 -O /etc/apt/keyrings/packages.mozilla.org.asc \
    https://packages.mozilla.org/apt/repo-signing-key.gpg || {
      warn "firefox: mozilla key download failed"; return 1; }
  echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" \
    > /etc/apt/sources.list.d/mozilla.list
  printf 'Package: firefox*\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' \
    > /etc/apt/preferences.d/mozilla
  apt-get update -qq >/dev/null 2>&1 || true
  apt_install firefox >/dev/null 2>&1 || { warn "firefox: install failed"; return 1; }
  log "installed firefox from packages.mozilla.org"
}

# ── worker mode: run the normal path once the apt lock is free ────────────
# Bounded wait — a wedged apt holder must not park this worker forever; on
# timeout the apt_busy check below simply defers again.
if [ "${1:-}" = "--deferred" ]; then
  timeout 900 python3 - <<'PY' 2>/dev/null || sleep 30
import fcntl
f = open("/var/lib/dpkg/lock-frontend", "w")
fcntl.lockf(f, fcntl.LOCK_EX)
PY
fi

mkdir -p "$STAMP_DIR"

# ── provision a CDP-capable browser ──────────────────────────────────────
# Firefox alone doesn't count: current firefox has no CDP, so the agent's
# browser_* tools need a chromium-family binary. Keep retrying until one
# exists (stamp-throttled).
if ! find_cdp_browser >/dev/null; then
  # A previously extracted-but-broken payload (deps missing): repair with
  # apt once it is free — cheaper than re-downloading.
  if [ -x "$CFT_BIN" ] && ! runnable "$CFT_BIN" && ! apt_busy; then
    chrome_deps
  fi
fi
if ! find_cdp_browser >/dev/null; then
  # one provisioner at a time — postinst, start.sh and the daemon can all
  # call us while a previous run is still downloading
  exec 9>"$LOCK"
  flock -n 9 || exit 0
  now="$(date +%s)"
  last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -ge 1800 ]; then
    arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
    if apt_busy; then
      # Inside the deb's own apt transaction: hand off to a transient unit
      # that waits for the lock; without systemd do the lock-free parts.
      # No stamp is written here — the deferred worker re-checks freshness
      # itself, and a fresh stamp would make it skip the install entirely.
      if [ -d /run/systemd/system ]; then
        log "inside apt transaction — deferring provisioning"
        systemd-run --unit=gut-browser-install \
          --description="gut: install a real browser" \
          /opt/gut/ensure-browser.sh --deferred \
          || warn "systemd-run failed — browser provisioning deferred to next start"
      else
        echo "$now" > "$STAMP"
        log "no systemd — lock-free provisioning only"
        try_chrome_for_testing || warn "cft fallback failed"
      fi
    else
      echo "$now" > "$STAMP"
      log "no usable browser — provisioning ($arch)"
      [ "$arch" = amd64 ] && { try_chrome_deb || warn "chrome deb failed"; }
      find_cdp_browser >/dev/null || try_chrome_for_testing || true
      find_any_browser  >/dev/null || try_firefox || true
      find_cdp_browser >/dev/null \
        || warn "still no CDP-capable browser — will retry in 30 min"
    fi
  fi
fi

# ── default-browser wiring for the gut desktop session ───────────────────
# System-wide XFCE helper pointing exo-open (and therefore xdg-open) at the
# wrapper; helpers.rc selects it; mimeapps.list covers gio/xdg-mime users.
mkdir -p /usr/share/xfce4/helpers \
         "$GUT_HOME/.config/xfce4" "$GUT_HOME/.local/share/applications"

cat > /usr/share/xfce4/helpers/gut-browser.desktop <<'EOF'
[Desktop Entry]
Version=1.0
Type=X-XFCE-Helper
X-XFCE-Category=WebBrowser
X-XFCE-Binaries=google-chrome;
X-XFCE-Commands=/usr/local/bin/google-chrome
X-XFCE-CommandsWithParameter=/usr/local/bin/google-chrome "%s"
Name=Gut Browser
NoDisplay=true
EOF

cat > "$GUT_HOME/.local/share/applications/gut-browser.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Gut Browser
Exec=/usr/local/bin/google-chrome %u
NoDisplay=true
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
EOF

HELPERS="$GUT_HOME/.config/xfce4/helpers.rc"
if grep -q '^WebBrowser=' "$HELPERS" 2>/dev/null; then
  sed -i 's|^WebBrowser=.*|WebBrowser=gut-browser|' "$HELPERS"
else
  printf 'WebBrowser=gut-browser\n' >> "$HELPERS"
fi

MIMEAPPS="$GUT_HOME/.config/mimeapps.list"
touch "$MIMEAPPS"
sed -i '/^x-scheme-handler\/https\?=/d' "$MIMEAPPS"
if grep -q '^\[Default Applications\]' "$MIMEAPPS"; then
  sed -i '/^\[Default Applications\]/a x-scheme-handler/http=gut-browser.desktop\nx-scheme-handler/https=gut-browser.desktop' "$MIMEAPPS"
else
  printf '[Default Applications]\nx-scheme-handler/http=gut-browser.desktop\nx-scheme-handler/https=gut-browser.desktop\n' >> "$MIMEAPPS"
fi

# Non-exo consumers that exec x-www-browser / sensible-browser.
if [ -e "$WRAP" ] && command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install /usr/bin/x-www-browser x-www-browser \
    "$WRAP" 200 >/dev/null 2>&1 || true
fi

chown -R gut:gut "$GUT_HOME/.config" "$GUT_HOME/.local" 2>/dev/null || true
exit 0
