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
- **Queue & steer mid-run:** Keep typing while the agent works — messages queue and are picked up when the run finishes (a follow-up to the same conversation lands before the end-of-run cleanup, so the desktop is still as the agent left it). Hit ⚡ or ⌘/Ctrl+Enter to steer instead: the message is injected into the run at the agent's next step. Queued messages can be sent-now or dropped from the tag under them; whatever is still queued when a run ends — even a stopped one — starts the next task automatically.
- **File attachments:** Attach files from the composer (paperclip, drag-and-drop onto the chat, or paste an image). They're saved under `~/uploads` on the device and the agent reads them from there; attached images are also shown to the model inline.
- **Parallel subagents:** The agent can spawn background helpers (`spawn_agent`) for headless work — web research, file and shell jobs — while it keeps driving the desktop. Helpers get `web_search`, `fetch_url`, `send_file` and a `run_command` with `DISPLAY` stripped, so nothing hijacks the screen or the browser; reports arrive as messages mid-run, or the agent blocks on `collect_agent`. Each helper can run a different (cheaper) model (`SUBAGENT_MODEL` or a per-spawn override).
- **Long-horizon tasks:** On big multi-phase jobs the agent posts a plan (`share_plan` — a card in chat) and keeps a live checklist (`update_todos` — pinned above the transcript, restored when you revisit the conversation). When a run nears the model's context window, older history is automatically compacted into a handoff summary and work continues — a context-overflow 400 triggers the same path instead of killing the run. Tunable via `AGENT_COMPACT_RATIO`, `AGENT_CONTEXT_LIMIT` and `AGENT_COMPACT_KEEP`.

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
    agent api : https://203.0.113.10:8443
    desktop   : https://203.0.113.10:6443
    password  : xK9…
```

Then add the machine as a device in the app (host = its IP, password = the
printed one) and paste at least one provider key in Settings → Provider
keys — keys upload to and are stored on the server, so nothing needs
editing on the host and no services restart. Non-secret settings (model,
cost caps, screenshot limits…) live in `config.json` next to the keys and
are managed the same way via `POST /api/config`.
Re-print credentials anytime with `gut-bot info`; manage with
`gut-bot status|logs|restart`.
The app shows the backend's version on its device row and can push a
release update to it (`POST /api/update` installs the new deb and restarts
the services).

### Develop

```bash
cp .env.example .env
# edit .env — only the three secrets live there: LITELLM_MASTER_KEY
# (must start with sk-), POSTGRES_PASSWORD, GUT_PASSWORD
docker compose up --build
```

Then run the app against it: `cd electron && npm install && npm start`,
point a device at `127.0.0.1` with the `.env` `GUT_PASSWORD`, and paste a
provider key in Settings → Provider keys.

---

## Repository Structure

```text
├── docker-compose.yml          # dev stack (db + litellm + openserp + desktop, built from source)
├── litellm_config.yaml         # shared LiteLLM model config (compose + gut-bot)
├── .env.example
├── backend/
│   ├── Dockerfile              # builds the gut-desktop image (context: repo root)
│   ├── start.sh                # Xvfb + XFCE + x11vnc + noVNC + daemon launcher
│   ├── agent_daemon.py         # FastAPI: WS chat, desktop control, LiteLLM, cost
│   ├── atspi.py                # AT-SPI bridge — desktop_tree/desktop_act for native apps
│   ├── uno_eval.py             # UNO bridge — office_eval on the live LibreOffice doc
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
│   ├── systemd/                # gut-bot.service, gut-litellm.service, gut-openserp.service
│   ├── openserp-browser        # Chrome launcher for OpenSERP (no-sandbox only, non-snap)
│   ├── gut-office              # soffice/libreoffice wrapper — UNO listener on GUI launches, isolated profile for batch converts
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
| 8000 | Agent daemon — plain HTTP **and** TLS multiplexed on one port (ClientHello sniff), so pinned TLS works wherever :8000 already reaches |
| 6080 | noVNC desktop stream — plain **and** TLS multiplexed the same way |
| 8443 | Agent daemon over TLS, dedicated listener — kept for older clients |
| 6443 | noVNC / websockify desktop stream over TLS — kept for older clients |
| 4000 | LiteLLM proxy (admin UI at `/ui`) — localhost-only in gut-bot |

---

## Notes

- **Vision models required.** Screenshot perception needs a vision-capable
  model (claude-*, gpt-4o/5, gemini-*, qwen-vl, …). `DEFAULT_MODEL` sets the
  agent's starting model.
- **Model picker annotations.** Each option shows the model's price per 1M
  tokens (input/output, from LiteLLM's pricing map); the composer bar adds a
  quality note, vision support and context size for the selected model.
  Models missing from the pricing map show no price.
- **Browser tools via CDP.** Chrome always launches with DevTools on
  localhost:9222 (profile at `~/.gut-chrome`), so the agent reads the DOM and
  clicks elements by `#ref` instead of guessing pixels. **Never publish port
  9222** — CDP is unauthenticated full browser control.
- **Text-first web tools.** `web_search` (OpenSERP on the internal compose
  network — `OPENSERP_URL`, internal-only, never published; bundled into
  gut-bot as `gut-openserp.service` — with a DuckDuckGo HTML fallback when
  unset) and `fetch_url` (plain-HTTP page
  text + links) let the agent research without opening Chrome: no
  screenshots, no CAPTCHA walls, one turn instead of five. `SEARCH_LANG` /
  `SEARCH_REGION` (or per-call `lang`/`region` args) localize search —
  unset follows the container IP's locale, which is wrong for non-English
  or location-specific queries. When a plain GET returns a thin JS-shell
  page, `fetch_url` re-renders it through openserp's bundled Chrome
  (`/extract`), so JS-heavy sites still read as text. The `browser_*`
  tools stay for what needs a real browser — logins, forms, interactive
  pages.
- **Cost controls.** Only the last `SCREENSHOT_HISTORY` frames stay in context
  (older ones become text placeholders), one screenshot is attached per turn
  and skipped when the frame is unchanged, Anthropic-style prompt caching is
  enabled for `claude`/`anthropic` models, and repeated/no-op actions trigger
  warnings then a user check-in instead of silently burning steps. Stale
  tool results — DOM dumps, page text, command output — are truncated to
  `TOOL_RESULT_STUB_CHARS` once older than the newest `TOOL_RESULT_HISTORY`
  results (the largest recurring re-bill in a long run), auto-attached
  frames can be downscaled via `SCREENSHOT_AUTO_PIXELS`, and `AGENT_MAX_USD`
  caps a single run's spend. Compaction and the cleanup janitor can run on
  cheaper models (`COMPACT_MODEL`, `JANITOR_MODEL`).
- **Cost tiering.** Run a cheap `DEFAULT_MODEL` with a premium
  `ESCALATION_MODEL`: a run that gets stuck (`ESCALATION_RESCUES` unstick
  attempts, default 2) or hits provider-side request failures switches
  mid-run to the stronger model — including the coordinate convention baked
  into its system prompt — and the conversation keeps it on resume.
- **UI scale.** `UI_SCALE` (default 1.25) raises Xft DPI and Chrome's device
  scale factor so downscaled screenshots stay legible. Bigger widgets are
  also easier click targets — the model's aim error is in screenshot pixels,
  so 1.25–1.5 noticeably improves pixel-click reliability.
- **Click grounding & settle.** Pixel clicks are looked up in the AT-SPI
  tree (`CLICK_A11Y`, default on): the tool result names the element under
  the point, and a click that lands on dead space within `CLICK_SNAP_PX`
  (default 24) of an actionable widget snaps to its center. After screen
  actions the daemon polls up to `ACTION_SETTLE_SECS` (default 1.5) for a
  repainted frame before reporting the screen unchanged, and batched screen
  actions are spaced by `INTER_ACTION_DELAY` — so a fast screenshot can't
  trick the model into re-clicking a UI that just hadn't rendered yet.
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
  overrides an env key for that provider. The app's own local stack works
  the same way: pasted keys are pushed to the local daemon's
  `provider_keys.json` — its generated `.env` only ever holds bootstrap
  secrets.
- **Local key store.** Keys you paste are also remembered by the app itself
  (localStorage, next to the device passwords) — so a key used on one
  backend can be pushed to another without re-pasting. The "Saved on this computer"
  bar in Settings → Provider keys lists what's stored: push all to the
  selected device, push one via a card's "Use saved key", or forget one.
  Remote daemons never return key values, so only the app holds a copy.
- **Device config.** Non-secret settings — model tiering, cost caps,
  screenshot/step limits, cleanup behavior, click tuning — live in
  `config.json` on the data volume, not in `.env`. The common ones are
  editable per device in Settings → Device settings (the app reads and
  writes them through `GET`/`POST /api/config`); most apply live,
  the few that feed `start.sh` (`RESOLUTION`, `UI_SCALE`, `DEVICE_NAME`,
  ports) persist and apply on the next container start. A value in
  `config.json` overrides the same-named env var, so env remains a
  deploy-time default and `.env` only ever needs the bootstrap secrets
  (`LITELLM_MASTER_KEY`, `POSTGRES_PASSWORD`, `GUT_PASSWORD`). The full
  knob list is the reference block in `.env.example`.
- **Architecture**: the Docker image ships Google Chrome on amd64 and Debian's
  `chromium` on arm64; gut-bot depends on `chromium | google-chrome-stable`
  and self-provisions a working browser where `chromium` is only a snap stub
  (Ubuntu — snaps can't exec on many VPSes): real Chrome on amd64, Google's
  Chrome-for-Testing zip on either arch (lock-free, works mid-transaction),
  and Mozilla-repo Firefox as a GUI fallback (no CDP in Firefox ≥141, so it
  serves the desktop but not the agent's `browser_*` tools). Candidates are
  exec-verified — a browser that can't run `--version` doesn't count, and a
  broken leftover payload gets dep-repaired on the next run. Either way
  `google-chrome` resolves to a wrapper that forces the CDP/no-sandbox flags
  and is wired as the session's default browser, and the daemon re-triggers
  provisioning itself when a browser launch fails.
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
`GET /api/version` and `GET /api/hello` stay open for health checks and TLS
pairing and expose only the version, device name and cert fingerprint. Keep
`LITELLM_MASTER_KEY` secret — it administers the proxy.

**Transport encryption.** Every backend generates a persistent self-signed
cert at boot and serves the agent API + desktop stream over TLS. The public
`:8000`/`:6080` ports carry **both** transports — the daemon peeks at the
first byte (a TLS ClientHello starts with `0x16`, HTTP/WS with ASCII) and
routes accordingly — so encryption works wherever the plain ports already
reach, no extra firewall rules or forwards needed. Dedicated `:8443`/`:6443`
listeners stay up for older clients. There is
no CA and nothing to provision: on first connect the app fetches the
unauthenticated `/api/hello` — the cert fingerprint plus
`HMAC(device password, fingerprint + nonce)` — opens a provisional TLS
connection, and pins the presented cert only when the fingerprint matches
and the MAC verifies. A MITM can't forge the MAC without the password, and
a relay can only forward the real cert, so pairing has no trust gap. Pins
live in the app's userData dir; a regenerated cert re-pairs automatically
(still password-checked). Once a device has encrypted, the app refuses to
send its password over plaintext without your explicit OK — a stripped
hello can't silently downgrade you.

Provider keys entered in the app are uploaded to the device they belong to
and stored there (the daemon's data dir plus LiteLLM's internal DB) — the
agent needs them to call model providers, and anyone with the device
password can read that store. The app also keeps a copy locally so keys
can be pushed to other devices (the "Saved on this computer" store in
Settings → Provider keys). On current backends the upload travels over the
pinned TLS channel; pre-TLS backends still send it over plain HTTP, so push
keys only on networks you trust until the device is updated.

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

**macOS signing:** the app is self-signed — no Apple developer account.
Run `packaging/make-signing-cert.sh` once and set the `MAC_CSC_LINK` /
`MAC_CSC_PASSWORD` secrets it prints; `release.yml` then signs every mac
build with the same cert. This matters beyond cosmetics: macOS ties
privacy grants (Local Network, …) to the code signature, and adhoc builds
get a new identity each release — so every update silently revokes the
grant and the app loses its backends. A stable cert keeps the grant alive
across updates. Without the secrets the build still works, just stays
adhoc-signed.
