# Gut: Self-Hosted AI Desktop Agent

An open-source, vendor-neutral AI desktop environment governed by a vision-enabled autonomous agent. Gut runs a containerized (or natively packaged) Linux desktop with Google Chrome/Chromium and LibreOffice, streaming low-latency video via noVNC/WebSockets into a desktop app with a unified chat interface, real-time cost tracking and instant human-in-the-loop takeover.

---

## Features

- **Full Productivity Desktop:** Runs XFCE4, LibreOffice (Writer, Calc, Impress), and Chrome/Chromium with persistent user data directories.
- **Native Desktop App:** The UI is an Electron app — it can run a local backend for you (it installs a container runtime itself), and/or connect to remote `gut-bot` servers.
- **Client/Server Decoupling:** Run the backend on your workstation or host it on an unmanaged VPS. Point the app at any target IP/domain.
- **Multi-Device Switching:** Keep a list of Gut backends in the app and hop between them — each device runs its own agent, so several can work in parallel. One agent per desktop environment.
- **Backend Management:** Settings → Devices shows each backend's version and flags newer releases. gut-bot servers self-update in place from the app; the local stack pulls the matching desktop image.
- **Persistent Conversations:** Every device stores its conversations — transcript plus model context — so you can revisit a thread and keep talking where the agent left off.
- **Model Agnostic (BYOK):** Integrated with LiteLLM. Use Claude, GPT, Gemini, DeepSeek, OpenRouter (one key for hundreds of models), or local Ollama/vLLM weights.
- **Live Dollar & Token Cost Tracking:** Transparent spend tracking per session and lifetime via LiteLLM metrics.
- **Dual-Control Human Takeover:** The agent acts autonomously via mouse and keyboard simulation, but you can click into the live desktop screen at any second to handle 2FA, logins, or CAPTCHAs.
- **Teammate-Style Chat:** Quiet by default — the agent messages you when it has something worth saying: milestone updates (`send_message`), clarifying questions (`ask_user`), file deliverables (`send_file`), inline screenshots (`send_image`), and a wrap-up summary when done (`task_complete`). Flip the **verbose** toggle to watch the full working log (thoughts, tool calls, results) live. The app raises a native notification when the agent finishes or needs you.

---

## Install

### The app (macOS / Windows / Linux)

Download `Gut-<version>` for your platform from
[Releases](https://github.com/valteryde/gut/releases) (or
`brew install --cask gut` once the tap exists).

On first launch the app offers to run a **local desktop**: it installs a
container runtime if needed (Colima via Homebrew on macOS, Docker Desktop
otherwise), pulls `ghcr.io/valteryde/gut-desktop`, generates a password,
starts the stack and adds `127.0.0.1` as a device. Paste at least one model
provider key (Anthropic / OpenAI / Gemini / OpenRouter) in Settings → Local
desktop and you're running.

**Updates:** the app checks GitHub Releases on launch (and every 6h) and
offers new versions in Settings → App. On macOS it self-updates: downloads
the release zip, swaps the `.app` bundle via a detached script and strips
the quarantine bit — no Apple developer account or code signing needed.
On Windows/Linux the button opens the release page instead.

### The backend on a server (`gut-bot`)

On a Debian/Ubuntu machine or VPS — no Docker, no compose:

```bash
V=$(curl -fsSL https://api.github.com/repos/valteryde/gut/releases/latest | grep -oP '"tag_name":\s*"v\K[^"]+')
wget "https://github.com/valteryde/gut/releases/latest/download/gut-bot_${V}_amd64.deb"
sudo apt install "./gut-bot_${V}_amd64.deb"
```

The installer prints the address and a generated password:

```
  gut-bot is up.
    agent api : http://203.0.113.10:8000
    desktop   : http://203.0.113.10:6080
    password  : xK9…
```

Then add the machine as a device in the app (host = its IP, password = the
printed one) and paste at least one provider key in Settings → Provider
keys — keys upload to and are stored on the server, so nothing needs
editing on the host and no services restart. Keys can alternatively be set
in `/etc/gut/gut-bot.env` (`sudo systemctl restart gut-bot` to apply).
Re-print credentials anytime with `gut-bot info`; manage with
`gut-bot status|logs|restart`.
The app shows the backend's version on its device row and can push a
release update to it (`POST /api/update` installs the new deb and restarts
the services).

### Develop

```bash
cp .env.example .env
# edit .env: set LITELLM_MASTER_KEY (must start with sk-) and at least one
# provider key, e.g. ANTHROPIC_API_KEY
docker compose up --build
```

Then run the app against it: `cd electron && npm install && npm start`, and
point a device at `127.0.0.1` with the `.env` `GUT_PASSWORD`.

---

## Repository Structure

```text
├── docker-compose.yml          # dev stack (db + litellm + desktop, built from source)
├── litellm_config.yaml         # shared LiteLLM model config (compose + gut-bot)
├── .env.example
├── backend/
│   ├── Dockerfile              # builds the gut-desktop image (context: repo root)
│   ├── start.sh                # Xvfb + XFCE + x11vnc + noVNC + daemon launcher
│   ├── agent_daemon.py         # FastAPI: WS chat, desktop control, LiteLLM, cost
│   ├── requirements.txt
│   ├── wallpaper.png/.py       # base desktop art + procedural generator
│   └── device_wallpaper.py     # hue-rotates the base per DEVICE_NAME at boot
├── client/                     # the UI — static HTML/JS, loaded by Electron
│   ├── index.html, app.js, styles.css
│   └── vendor/                 # vendored noVNC + fonts (no CDN)
├── electron/                   # the desktop app
│   ├── main.js                 # window + IPC
│   ├── preload.js              # window.gut bridge
│   └── localstack.js           # docker/colima install + local compose stack
├── packaging/
│   ├── apt-deps.txt            # single source of truth: system deps for image AND deb
│   ├── build-deb.sh            # builds gut-bot_<v>_<arch>.deb (run in debian:trixie)
│   ├── debian/                 # control, postinst (secrets + postgres + services), prerm/postrm
│   ├── systemd/                # gut-bot.service, gut-litellm.service
│   ├── gut-bot                 # CLI: info/status/logs/restart/version
│   └── chromium-gut.conf       # /etc/chromium.d flags (CDP, no-sandbox, scale)
└── .github/workflows/
    ├── ci.yml                  # build image + deb + electron, smoke-test daemon
    └── release.yml             # tag → GHCR images + debs + dmg/exe/AppImage → GitHub Release
```

One version per release tag drives everything: the image tag, the deb
version and the app version all come from the same `v*` tag, and the daemon
reports it via `GET /api/version`.

| Port | Service |
|---|---|
| 8000 | Agent daemon (REST + WebSocket `/ws/chat`) — requires the device password |
| 6080 | noVNC / websockify desktop stream — requires the device password |
| 4000 | LiteLLM proxy (admin UI at `/ui`) — localhost-only in gut-bot |

---

## Notes

- **Vision models required.** Screenshot perception needs a vision-capable
  model (claude-*, gpt-4o/5, gemini-*, qwen-vl, …). `DEFAULT_MODEL` sets the
  agent's starting model.
- **Model picker annotations.** Each option shows the model's price per 1M
  tokens (input/output, from LiteLLM's pricing map); the line under the
  composer adds a quality note, vision support and context size for the
  selected model. Models missing from the pricing map show no price.
- **Browser tools via CDP.** Chrome always launches with DevTools on
  localhost:9222 (profile at `~/.gut-chrome`), so the agent reads the DOM and
  clicks elements by `#ref` instead of guessing pixels. **Never publish port
  9222** — CDP is unauthenticated full browser control.
- **Cost controls.** Only the last `SCREENSHOT_HISTORY` frames stay in context
  (older ones become text placeholders), one screenshot is attached per turn
  and skipped when the frame is unchanged, Anthropic-style prompt caching is
  enabled for `claude`/`anthropic` models, and repeated/no-op actions trigger
  warnings then a user check-in instead of silently burning steps.
- **UI scale.** `UI_SCALE` (default 1.25) raises Xft DPI and Chrome's device
  scale factor so downscaled screenshots stay legible.
- **Conversations & devices.** The app keeps a device list (name, host,
  password) in `localStorage` — add backends in Settings. Each device stores
  its own conversations under `$HOME/.gut/conversations/` on the
  `desktop-home` volume (`/var/lib/gut/.gut` under gut-bot): transcript events
  plus the LLM message context, so a revisited conversation continues with
  full memory of the earlier run. A device runs one agent at a time — sending
  to a busy device tells you which conversation occupies it. `DEVICE_NAME`
  labels the backend in the UI and sets the desktop wallpaper's hue — every
  device is a different color, so you can tell which machine a stream shows
  at a glance (`WALLPAPER_HUE` pins the hue, `local` keeps the mint).
- **Cost tracking.** The daemon mints a `gut-agent` LiteLLM virtual key on
  first boot and reads spend from LiteLLM's `/key/info` API. Per-request cost
  comes from the `x-litellm-response-cost` header. Models missing from
  LiteLLM's pricing map (e.g. local Ollama) report $0 but still track tokens.
- **Provider keys.** Managed per device from Settings → Provider keys —
  click a device row to see and edit its keys. Pasted keys upload to that
  machine, are stored in the daemon's data dir
  (`provider_keys.json`, mode 600) and synced into LiteLLM's DB model store
  (`store_model_in_db`), so they apply live with no restarts and survive
  reboots. Keys set in the backend's own env (`.env` / `gut-bot.env`) still
  work — the daemon registers them the same way at boot — and a pushed key
  overrides an env key for that provider. The app's own local stack is the
  exception: its keys go into the stack's `.env` on this machine.
- **Architecture**: the Docker image ships Google Chrome on amd64 and Debian's
  `chromium` on arm64; gut-bot always uses `chromium` (Google doesn't publish
  an apt repo the deb can depend on). `google-chrome` is aliased either way.
- **Browser sandbox**: the browser always launches with `--no-sandbox` —
  restricted kernels (containers, some VPSes) block the user namespaces its
  sandbox needs; the dedicated desktop is the isolation boundary.
- **Chrome profile**: lives at `~/.gut-chrome` (a dedicated dir — Chrome 136+
  refuses `--remote-debugging-port` on the default profile).
- **UI fonts**: DM Sans and JetBrains Mono (both OFL-licensed) are vendored in
  `client/vendor/fonts/`, so the app never contacts a font CDN. In the UI,
  **mint** always means the agent (working, done, resume) and **clay** always
  means you (take over, needs-you questions, paused).

## Security

The desktop stream is **full remote control** — anyone who reaches port 6080
owns the machine, and port 8000 drives the agent itself. That's why every
install generates one password (`VNC_PASSWORD`/`GUT_API_TOKEN`, same value)
that protects both; the app sends it as a Bearer token / `?token=`.
`GET /api/version` stays open for health checks and exposes only the version
and device name. For remote backends, additionally firewall ports to your IP
or front them with a TLS reverse proxy. Keep `LITELLM_MASTER_KEY` secret — it
administers the proxy.

Provider keys entered in the app are uploaded to the device they belong to
and stored there (the daemon's data dir plus LiteLLM's internal DB) — the
agent needs them to call model providers, and anyone with the device
password can read that store. They travel over plain HTTP like everything
else on :8000, so push keys only on networks you trust or put a TLS proxy
in front.

## Human-in-the-loop

The screen is always interactive. Clicking or typing into it pauses the
agent and hands you control between steps — do what only a human can
(logins, 2FA, CAPTCHAs), then hit **Resume agent** in the chat. The agent
can also pause itself by calling `ask_user`, which surfaces a question in
the chat (and a desktop notification when the app isn't focused).

## Agent-to-user messaging

The chat is not a live transcript. The agent chooses when to speak:

| Tool | What the user sees |
|---|---|
| `send_message` | A chat bubble — milestones, blockers, heads-ups |
| `ask_user` | A highlighted question; your reply resumes the agent |
| `send_file` | A download attachment (max `SEND_FILE_MAX_BYTES`, default 9 MB) |
| `send_image` | An inline image, or a fresh screenshot when no path is given |
| `task_complete` | The wrap-up summary, marked *done* |

Everything else — model narration, tool calls, tool results — is streamed as
verbose events and shown only when the **verbose** toggle is on (persisted in
`localStorage`, per machine).

## Releasing

Tag a commit and push:

```bash
git tag v0.4.0 && git push --tags
```

`release.yml` builds and pushes `ghcr.io/valteryde/gut-desktop` (amd64 +
arm64), builds `gut-bot` debs for both architectures inside `debian:trixie`
containers, builds the Electron app for macOS/Windows/Linux, and attaches
everything plus checksums to a GitHub Release.
