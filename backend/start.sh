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
    -n -t string -s /opt/gut/wallpaper.png >/dev/null 2>&1
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

echo "[gut] starting websockify/noVNC on :6080"
websockify --web /usr/share/novnc 6080 localhost:5900 &

echo "[gut] waiting for LiteLLM at ${LITELLM_URL}"
for _ in $(seq 1 120); do
    curl -sf "${LITELLM_URL}/health/liveliness" >/dev/null 2>&1 && break
    sleep 1
done

echo "[gut] starting agent daemon on :8000"
cd /opt/gut
exec uvicorn agent_daemon:app --host 0.0.0.0 --port 8000
