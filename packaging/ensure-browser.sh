#!/bin/sh
# ensure-browser — give the gut desktop a browser that actually launches.
#
# Debian's `chromium` deb is a normal binary, but Ubuntu's is a transitional
# stub that execs the snap — and snap-confined apps fail to exec on many
# VPSes (no squashfs/loop support). XFCE's exo-open then reports "Failed to
# execute default Web Browser / Input/output error" and the agent's
# browser_* tools can't start Chrome either. On amd64 we install the
# official Google Chrome deb instead, matching the Docker image; arm64
# Ubuntu has no real chromium build, so snap chromium is kept there.
#
# It also pins the gut session's default browser to the
# /usr/local/bin/google-chrome wrapper, so exo-open/xdg-open, .desktop icons
# and the agent daemon all land on the same binary.
#
# Runs as root: from postinst (deb install/upgrade, incl. self-update) and
# from start.sh via `sudo -n` on every service start. Idempotent — a fast
# no-op once a real browser exists; provisioning retries at most every 6h.
#
# Modes:
#   (no args)        provision if needed, then write session config
#   --install-deb F  worker: wait for the dpkg lock to clear, then install F.
#                    Spawned via systemd-run because postinst can't take the
#                    apt lock — it runs inside the transaction holding it.
set -u

GUT_HOME=/var/lib/gut
CHROME_URL="https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
STAMP_DIR="$GUT_HOME/.gut"
CHROME_DEB="$STAMP_DIR/.chrome-install.deb"
STAMP="$STAMP_DIR/browser-provision.try"
WRAP=/usr/local/bin/google-chrome

log()  { echo "[gut] ensure-browser: $*"; }
warn() { echo "[gut] ensure-browser: $*" >&2; }

is_snap() {
  [ -e "$1" ] || return 1
  case "$(readlink -f "$1" 2>/dev/null)" in
    /snap/*|/var/lib/snapd/*) return 0 ;;
  esac
  head -c 4096 "$1" 2>/dev/null | grep -q 'snap run'
}

have_real_browser() {
  for b in /usr/bin/google-chrome-stable /opt/google/chrome/google-chrome; do
    [ -x "$b" ] && return 0
  done
  for c in /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -e "$c" ] && ! is_snap "$c" && return 0
  done
  return 1
}

# ── worker mode: install a downloaded deb once apt's lock is free ────────
if [ "${1:-}" = "--install-deb" ]; then
  deb="${2:-}"
  [ -s "$deb" ] || exit 1
  # apt holds an fcntl lock for the whole transaction that spawned us.
  # python's lockf is the same lock domain (flock(2) is not).
  python3 - <<'PY' 2>/dev/null || sleep 30
import fcntl
f = open("/var/lib/dpkg/lock-frontend", "w")
fcntl.lockf(f, fcntl.LOCK_EX)
PY
  if apt-get install -y "$deb"; then
    log "installed $(basename "$deb")"
  else
    warn "apt install failed — extracting payload instead (no repo/deps)"
    dpkg-deb -x "$deb" /
    [ -e /usr/bin/google-chrome ] || \
      ln -sf /usr/bin/google-chrome-stable /usr/bin/google-chrome
    miss="$(ldd /opt/google/chrome/chrome 2>/dev/null \
             | awk '/not found/{print $1}' | paste -sd' ' -)"
    [ -n "$miss" ] && warn "chrome is missing libraries: $miss"
  fi
  rm -f "$deb"
  exit 0
fi

# ── provision a real browser ─────────────────────────────────────────────
if have_real_browser; then
  :
else
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in
    amd64)
      now="$(date +%s)"
      last="$(cat "$STAMP" 2>/dev/null || echo 0)"
      case "$last" in ''|*[!0-9]*) last=0 ;; esac
      if [ $((now - last)) -ge 21600 ]; then
        mkdir -p "$STAMP_DIR"
        echo "$now" > "$STAMP"
        log "no real browser found — fetching Google Chrome"
        if wget -q -T 30 -O "$CHROME_DEB" "$CHROME_URL"; then
          if [ -d /run/systemd/system ]; then
            # postinst can't take the apt lock itself — hand the install to
            # a transient unit that waits it out.
            systemd-run --unit=gut-chrome-install \
              --description="gut: install google-chrome" \
              /opt/gut/ensure-browser.sh --install-deb "$CHROME_DEB" \
              || warn "systemd-run failed — chrome install skipped"
          elif apt-get install -y "$CHROME_DEB"; then
            rm -f "$CHROME_DEB"
          else
            # no systemd and the lock is held (postinst in a container):
            # dpkg-deb -x is lock-free and needs no maintainer scripts.
            warn "apt unavailable — extracting chrome payload"
            dpkg-deb -x "$CHROME_DEB" / && rm -f "$CHROME_DEB"
            [ -e /usr/bin/google-chrome ] || \
              ln -sf /usr/bin/google-chrome-stable /usr/bin/google-chrome
          fi
        else
          rm -f "$CHROME_DEB"
          warn "chrome download failed — will retry"
        fi
      fi
      ;;
    *)
      warn "no real browser on $arch (snap chromium kept) — if snaps can't" \
           "run on this host, deploy the Docker image instead"
      ;;
  esac
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
