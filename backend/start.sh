#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY:-:0}"
RESOLUTION="${RESOLUTION:-1920x1080}"
LITELLM_URL="${LITELLM_URL:-http://litellm:4000}"

# Clean stale X locks left by a previous container run (container fs persists
# /tmp across restarts, and a leftover lock makes Xvfb refuse to start).
N="${DISPLAY_NUM#:}"
rm -f "/tmp/.X${N}-lock" "/tmp/.X11-unix/X${N}"

echo "[gut] starting Xvfb ${DISPLAY_NUM} @ ${RESOLUTION}x24"
Xvfb "${DISPLAY_NUM}" -screen 0 "${RESOLUTION}x24" &

# First boot can take a while (font cache build); wait up to 60s, then bail.
X_UP=0
for _ in $(seq 1 300); do
    if xdpyinfo -display "${DISPLAY_NUM}" >/dev/null 2>&1; then X_UP=1; break; fi
    sleep 0.2
done
if [ "${X_UP}" != "1" ]; then
    echo "[gut] FATAL: Xvfb did not come up on ${DISPLAY_NUM}" >&2
    exit 1
fi

echo "[gut] starting XFCE4 session"

# Per-device wallpaper: same art, hue rotated from DEVICE_NAME so each
# backend's desktop is a different color at a glance (WALLPAPER_HUE pins a
# specific hue). Regenerated every boot; falls back to the shipped PNG.
WALLPAPER_PATH="${GUT_DATA_DIR:-$HOME/.gut}/wallpaper.png"
mkdir -p "$(dirname "$WALLPAPER_PATH")"
python3 /opt/gut/device_wallpaper.py \
    --name "${DEVICE_NAME:-$(hostname 2>/dev/null || echo local)}" \
    --base /opt/gut/wallpaper.png --out "$WALLPAPER_PATH" \
    || { echo "[gut] wallpaper gen failed — using shipped PNG" >&2
         WALLPAPER_PATH=/opt/gut/wallpaper.png; }

# Bigger UI = text stays legible in downscaled screenshots = more reliable
# clicks at the same image-token cost. Xresources covers non-GTK apps; the
# xfconf write must run inside the session bus, hence the wrapper script.
UI_SCALE="${UI_SCALE:-1.25}"
DPI="$(awk -v s="$UI_SCALE" 'BEGIN{printf "%d", s * 96}')"
printf 'Xft.dpi: %s\n' "$DPI" > "$HOME/.Xresources"
cat > /tmp/gut-session.sh <<EOF
#!/bin/bash
startxfce4 &
xfce_pid=\$!
for _ in \$(seq 1 60); do
  xfconf-query -c xsettings -p /Xft/DPI -s ${DPI} >/dev/null 2>&1 && break
  xfconf-query -c xsettings -p /Xft/DPI -n -t int -s ${DPI} >/dev/null 2>&1 && break
  sleep 1
done
# Flat wallpaper on every workspace. The xfdesktop property path embeds the
# monitor's RandR name — Xvfb exposes a single monitor called "screen".
MON=\$(xrandr --listmonitors 2>/dev/null | awk 'NR==2 {print \$NF}')
MON=\${MON:-screen}
WSCOUNT=\$(xfconf-query -c xfwm4 -p /general/workspace_count 2>/dev/null || echo 4)
for ws in \$(seq 0 \$((WSCOUNT - 1))); do
  xfconf-query -c xfce4-desktop \
    -p /backdrop/screen0/monitor\${MON}/workspace\${ws}/last-image \
    -n -t string -s ${WALLPAPER_PATH} >/dev/null 2>&1
  xfconf-query -c xfce4-desktop \
    -p /backdrop/screen0/monitor\${MON}/workspace\${ws}/image-style \
    -n -t int -s 5 >/dev/null 2>&1
  xfconf-query -c xfce4-desktop \
    -p /backdrop/screen0/monitor\${MON}/workspace\${ws}/color-style \
    -n -t int -s 0 >/dev/null 2>&1
done
wait "\$xfce_pid"
EOF
chmod +x /tmp/gut-session.sh
dbus-run-session -- /tmp/gut-session.sh &

echo "[gut] starting x11vnc on :5900"
VNC_ARGS=(-display "${DISPLAY_NUM}" -forever -shared -rfbport 5900 -noxdamage -localhost)
if [ -n "${VNC_PASSWORD:-}" ]; then
    VNC_ARGS+=(-passwd "${VNC_PASSWORD}")
    echo "[gut] VNC auth enabled"
else
    VNC_ARGS+=(-nopw)
    echo "[gut] WARNING: VNC running WITHOUT a password (localhost use only)"
fi
x11vnc "${VNC_ARGS[@]}" &

# Self-signed TLS cert shared by the agent daemon (:8443) and the desktop
# stream (:6443). Persisted in the data dir so the fingerprint the app pins
# stays stable across restarts. The app pins it after a password-checked
# handshake, so no CA or user-provided cert is needed.
TLS_DIR="${GUT_DATA_DIR:-$HOME/.gut}/tls"
TLS_CERT="$TLS_DIR/cert.pem"
TLS_KEY="$TLS_DIR/key.pem"
if [ ! -s "$TLS_CERT" ] || [ ! -s "$TLS_KEY" ]; then
  mkdir -p "$TLS_DIR"
  CN="gut-$(printf '%s' "${DEVICE_NAME:-$(hostname 2>/dev/null || echo device)}" | tr -cd 'a-zA-Z0-9._-')"
  if openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
       -nodes -days 3650 -subj "/CN=${CN}" \
       -keyout "$TLS_KEY" -out "$TLS_CERT" 2>/dev/null; then
    chmod 600 "$TLS_KEY"
    echo "[gut] generated self-signed TLS cert in ${TLS_DIR}"
  else
    rm -f "$TLS_CERT" "$TLS_KEY"
    echo "[gut] WARNING: TLS cert generation failed — plain HTTP only" >&2
  fi
fi
export GUT_TLS_CERT="$TLS_CERT" GUT_TLS_KEY="$TLS_KEY"

echo "[gut] starting websockify/noVNC on :6080 (+ TLS on :6443)"
websockify --web /usr/share/novnc 6080 localhost:5900 &
if [ -s "$TLS_CERT" ] && [ -s "$TLS_KEY" ]; then
  websockify --web /usr/share/novnc --cert "$TLS_CERT" --key "$TLS_KEY" \
    "${GUT_NOVNC_TLS_PORT:-6443}" localhost:5900 &
fi

echo "[gut] waiting for LiteLLM at ${LITELLM_URL}"
for _ in $(seq 1 120); do
    # /health/liveliness exists on newer litellm; 1.9.x only has /health.
    curl -sf "${LITELLM_URL}/health/liveliness" >/dev/null 2>&1 && break
    curl -sf "${LITELLM_URL}/health" >/dev/null 2>&1 && break
    sleep 1
done

echo "[gut] starting agent daemon on :${GUT_HTTP_PORT:-8000} (+ TLS on :${GUT_TLS_PORT:-8443})"
cd /opt/gut
exec uvicorn agent_daemon:app --host 0.0.0.0 --port "${GUT_HTTP_PORT:-8000}"
