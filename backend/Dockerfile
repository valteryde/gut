FROM debian:trixie

ENV DEBIAN_FRONTEND=noninteractive
ARG GUT_VERSION=dev
ENV GUT_VERSION=${GUT_VERSION}

# Desktop stack + agent dependencies. The list is shared with the gut-bot
# deb package — edit packaging/apt-deps.txt, not this file.
COPY packaging/apt-deps.txt /tmp/apt-deps.txt
RUN apt-get update && \
    grep -v '^#' /tmp/apt-deps.txt | xargs apt-get install -y --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Browser: official Google Chrome where Google ships it (amd64);
# Debian's chromium everywhere else (e.g. arm64 hosts/VPSes).
RUN ARCH="$(dpkg --print-architecture)" && \
    if [ "$ARCH" = "amd64" ]; then \
        wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
        apt-get update && apt-get install -y /tmp/chrome.deb && \
        rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/* ; \
    else \
        apt-get update && apt-get install -y --no-install-recommends chromium && \
        rm -rf /var/lib/apt/lists/* && \
        ln -sf /usr/bin/chromium /usr/local/bin/google-chrome ; \
    fi

# Python environment for the agent daemon.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# X socket dirs must exist (root-owned, sticky) before Xvfb starts — a
# non-root Xvfb cannot create them, and without /tmp/.X11-unix/X0 python-xlib
# (pyautogui/mouseinfo) cannot connect to the display.
RUN mkdir -p /tmp/.X11-unix /tmp/.ICE-unix && \
    chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix

# Unprivileged user that owns the desktop session.
RUN useradd -m -s /bin/bash -u 1000 agent && \
    mkdir -p /home/agent/Desktop /home/agent/Documents \
             /home/agent/.gut-chrome && \
    echo 'agent ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    chown -R agent:agent /home/agent

# Chromium can't build its sandbox under Docker's default seccomp profile
# (no unprivileged user namespaces, no setuid helper) — the container is the
# isolation boundary here, so always launch it with --no-sandbox.
# Every launch also gets: a localhost-only DevTools port (the agent's
# browser_* tools drive the DOM through CDP instead of pixel hunting), a
# dedicated profile dir (Chrome 136+ ignores --remote-debugging-port on the
# default profile), and a device-scale-factor bump so page text stays legible
# after screenshots are downscaled for the vision API.
# arm64: Debian's /usr/bin/chromium sources /etc/chromium.d/*, which covers
# every launch path (CLI, .desktop icons, xdg-open). amd64: Google's launcher
# doesn't, so wrap it in place — /usr/bin/google-chrome* and the .desktop
# Exec all resolve to it.
RUN ARCH="$(dpkg --print-architecture)" && \
    if [ "$ARCH" = "amd64" ]; then \
        L=/opt/google/chrome/google-chrome && \
        mv "$L" "$L.real" && \
        printf '%s\n' \
            '#!/bin/sh' \
            'exec '"$L"'.real --no-sandbox --disable-setuid-sandbox \' \
            '    --remote-debugging-address=127.0.0.1 \' \
            '    --remote-allow-origins=* \' \
            '    --remote-debugging-port="${CDP_PORT:-9222}" \' \
            '    --user-data-dir="${HOME}/.gut-chrome" \' \
            '    --force-device-scale-factor="${UI_SCALE:-1.25}" \' \
            '    "$@"' \
            > "$L" && \
        chmod +x "$L" ; \
    else \
        printf 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-setuid-sandbox --remote-debugging-address=127.0.0.1 --remote-allow-origins=* --remote-debugging-port=${CDP_PORT:-9222} --user-data-dir=${HOME}/.gut-chrome --force-device-scale-factor=${UI_SCALE:-1.25}"\n' \
            > /etc/chromium.d/no-sandbox ; \
    fi

COPY backend/start.sh /opt/gut/start.sh
COPY backend/agent_daemon.py /opt/gut/agent_daemon.py
COPY backend/wallpaper.png /opt/gut/wallpaper.png
COPY backend/device_wallpaper.py /opt/gut/device_wallpaper.py
RUN echo "${GUT_VERSION}" > /opt/gut/VERSION && chmod +x /opt/gut/start.sh

USER agent
ENV HOME=/home/agent DISPLAY=:0
WORKDIR /home/agent

CMD ["/opt/gut/start.sh"]
