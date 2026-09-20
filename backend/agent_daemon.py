"""Gut agent daemon.

FastAPI service inside the desktop container that:
  * exposes a WebSocket chat/control channel to the client UI,
  * drives the local X desktop (PyAutoGUI / scrot / xdotool) from LLM tool calls,
  * routes all model traffic through LiteLLM (BYOK) and reports live cost.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
from collections import deque
import hmac
import io
import json
import mimetypes
import os
import re
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse
from uuid import uuid4

import httpx
import pyautogui
from fastapi import (Body, FastAPI, HTTPException, Request, WebSocket,
                     WebSocketDisconnect)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image

try:
    from websockets.asyncio.client import connect as ws_connect
except ImportError:  # websockets<13
    from websockets import connect as ws_connect

try:
    import tcpmux
except ImportError:  # running as a package (uvicorn backend.agent_daemon)
    tcpmux = None

LITELLM_URL = os.environ.get("LITELLM_URL", "http://localhost:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "claude-sonnet-4-5")
RESOLUTION = os.environ.get("RESOLUTION", "1920x1080")
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "150"))
# Consecutive text-only replies (no tool calls) before the run is ended with
# the model's last reply as the wrap-up. Weaker models answer in prose instead
# of calling task_complete; without a cap the "continue" nudge loops to
# MAX_STEPS paying full input cost every turn.
IDLE_REPLY_LIMIT = int(os.environ.get("AGENT_IDLE_REPLY_LIMIT", "3"))
ASK_USER_TIMEOUT = int(os.environ.get("ASK_USER_TIMEOUT", "600"))
COMMAND_TIMEOUT = int(os.environ.get("COMMAND_TIMEOUT", "60"))
# Background helper agents (spawn_agent): headless — web/text tools and a
# display-less shell, own step cap and optional cheaper model.
# SUBAGENT_MODEL empty = same model as the main agent.
SUBAGENT_MAX_STEPS = int(os.environ.get("SUBAGENT_MAX_STEPS", "40"))
SUBAGENT_MAX_CONCURRENT = int(os.environ.get("SUBAGENT_MAX_CONCURRENT", "4"))
SUBAGENT_MODEL = os.environ.get("SUBAGENT_MODEL", "")
# Long-horizon support. When a request's prompt_tokens exceed
# AGENT_COMPACT_RATIO of the model's context window (max_input_tokens from
# LiteLLM's /model/info; AGENT_CONTEXT_LIMIT is the fallback when it reports
# none — deliberately conservative: over-compacting wastes one call,
# under-compacting kills the run), history is summarized into a handoff
# note and the loop continues on summary + todos + the last
# AGENT_COMPACT_KEEP messages.
COMPACT_RATIO = float(os.environ.get("AGENT_COMPACT_RATIO", "0.75"))
COMPACT_CONTEXT_LIMIT = int(os.environ.get("AGENT_CONTEXT_LIMIT", "128000"))
COMPACT_KEEP = int(os.environ.get("AGENT_COMPACT_KEEP", "6"))
# Steps without an update_todos call before the checklist is nudged back
# into view on long tasks.
TODO_REMIND_STEPS = int(os.environ.get("TODO_REMIND_STEPS", "20"))
TODO_MAX_ITEMS = int(os.environ.get("TODO_MAX_ITEMS", "30"))
SCREENSHOT_MAX_EDGE = int(os.environ.get("SCREENSHOT_MAX_EDGE", "1568"))
SCREENSHOT_MAX_PIXELS = int(os.environ.get("SCREENSHOT_MAX_PIXELS", "1000000"))
SCREENSHOT_HISTORY = int(os.environ.get("SCREENSHOT_HISTORY", "3"))
# VLMs that emit coordinates on a normalized 0-1000 grid rather than
# screenshot pixels — Qwen3-VL standardised on this (its ViT rescales
# inputs internally, so its pixel space is unknowable from our side) and
# Gemini 2.5 does the same. Comma-separated substrings matched against the
# model id; set empty to disable.
NORMALIZED_COORD_MODELS = [
    p for p in os.environ.get(
        "NORMALIZED_COORD_MODELS", "qwen3-vl,gemini").lower().split(",")
    if p]
LLM_MAX_RETRIES = int(os.environ.get("LLM_MAX_RETRIES", "4"))
# Files/images sent to the user travel the chat WebSocket as base64 — uvicorn's
# default ws max message is 16 MB, so cap payloads comfortably under it.
SEND_FILE_MAX_BYTES = int(os.environ.get("SEND_FILE_MAX_BYTES", str(9 * 1024 * 1024)))
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
CDP_HTTP = f"http://localhost:{CDP_PORT}"
# SearXNG endpoint for web_search — the compose stacks run one on the
# internal network. Empty = fall back to DuckDuckGo's HTML endpoint.
SEARXNG_URL = os.environ.get("SEARXNG_URL", "").rstrip("/")
SHOT_PATH = Path("/tmp/gut_screen.png")
HOME_DIR = Path(os.environ.get("HOME") or Path.home())
KEY_FILE = Path(os.environ.get("GUT_KEY_FILE") or HOME_DIR / ".gut_litellm_key")
DEVICE_NAME = os.environ.get("DEVICE_NAME") or socket.gethostname()
# Shared secret the client must present (Bearer header or ?token=) on every
# API call and the chat socket. Empty = open (acceptable on localhost-only
# installs). The gut-bot package and the Electron local stack both generate
# one at install time and reuse it as the VNC password.
GUT_API_TOKEN = os.environ.get("GUT_API_TOKEN", "")


def _build_version() -> str:
    v = os.environ.get("GUT_VERSION")
    if v:
        return v
    try:
        return Path("/opt/gut/VERSION").read_text().strip() or "dev"
    except OSError:
        return "dev"


GUT_VERSION = _build_version()


def _install_kind() -> str:
    # docker = the gut-desktop image (GUT_VERSION is a baked-in ENV); deb =
    # the gut-bot package (/opt/gut payload, /etc/gut env); else dev.
    if os.environ.get("GUT_VERSION") or Path("/.dockerenv").exists():
        return "docker"
    if (Path("/etc/gut/gut-bot.env").exists()
            or Path("/opt/gut/VERSION").exists()):
        return "deb"
    return "dev"


INSTALL_KIND = _install_kind()
# Conversation transcripts + model context persist on the desktop-home
# volume (or ~/.gut outside docker) so they survive container rebuilds.
GUT_DATA_DIR = Path(os.environ.get("GUT_DATA_DIR") or Path.home() / ".gut")
CONV_DIR = GUT_DATA_DIR / "conversations"
# TLS: start.sh generates a self-signed cert into the data dir; a thin
# TLS->TCP proxy in this process terminates GUT_TLS_PORT and forwards to the
# plain uvicorn socket, so a second app instance (and a second lifespan) is
# never needed. Clients don't need a CA — they pin the cert fingerprint
# after the password-authenticated /api/hello handshake. GUT_NOVNC_TLS_PORT
# is only advertised to clients; the TLS websockify is spawned by start.sh.
TLS_CERT = Path(os.environ.get("GUT_TLS_CERT") or GUT_DATA_DIR / "tls" / "cert.pem")
TLS_KEY = Path(os.environ.get("GUT_TLS_KEY") or GUT_DATA_DIR / "tls" / "key.pem")
TLS_PORT = int(os.environ.get("GUT_TLS_PORT", "8443"))
NOVNC_TLS_PORT = int(os.environ.get("GUT_NOVNC_TLS_PORT", "6443"))
# Where the plain uvicorn socket lives — the TLS proxy forwards to it.
# start.sh passes the same var to uvicorn's --port so overrides stay in
# sync (AGENT_PORT in .env only moves the host-side compose mapping).
HTTP_PORT = int(os.environ.get("GUT_HTTP_PORT", "8000"))
# When start.sh parks uvicorn on a loopback-only port (GUT_UVICORN_PORT),
# this process multiplexes the public ports itself: TLS ClientHellos get
# routed to the :8443/:6443 terminators, everything else to the plain
# backends — so pinned TLS works wherever the plain ports already reach,
# no extra firewall holes or port forwards needed.
UVICORN_PORT = int(os.environ.get("GUT_UVICORN_PORT", "0"))
BACKEND_PORT = UVICORN_PORT or HTTP_PORT
MUX = bool(UVICORN_PORT)
NOVNC_PORT = int(os.environ.get("GUT_NOVNC_PORT", "6080"))
NOVNC_PLAIN_PORT = int(os.environ.get("GUT_NOVNC_PLAIN_PORT", "6081"))
TLS_FP = None  # sha256 of the cert the proxy actually presents
TLS_ERR = None  # why TLS is down, when it is — surfaced via /api/hello
# Files the user attaches in the composer land on the desktop itself, where
# the agent's file/shell tools can read them (paths are relative to home).
UPLOAD_DIR = Path(os.environ.get("GUT_UPLOAD_DIR") or HOME_DIR / "uploads")
MAX_ATTACHMENTS = 8
# Per-run cleanup: a deterministic sweep (close tabs/windows/processes the
# run created, wipe ~/scratch) followed by a short janitor LLM pass for
# residue the sweep can't see. GUT_CLEANUP=off disables both.
GUT_CLEANUP = os.environ.get("GUT_CLEANUP", "on").lower() not in (
    "off", "0", "false", "no")
JANITOR_MAX_STEPS = int(os.environ.get("JANITOR_MAX_STEPS", "10"))
SCRATCH_DIR = HOME_DIR / "scratch"
# Baseline of what was running when a task started, persisted so a daemon
# restart mid-run still lets the next boot sweep that run's leftovers.
RUN_STATE_FILE = GUT_DATA_DIR / "run_state.json"
# Base64 inflates ~33%; keep the ws message comfortably under uvicorn's
# 16 MB frame cap.
ATTACH_TOTAL_MAX_BYTES = int(
    os.environ.get("ATTACH_TOTAL_MAX_BYTES", str(12 * 1024 * 1024)))
# Self-update status file (deb installs) — written by the detached updater
# script, read by GET /api/update.
UPDATE_STATUS_FILE = GUT_DATA_DIR / "update.json"
GITHUB_REPO = os.environ.get("GUT_RELEASE_REPO", "valteryde/gut")

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.05

SYSTEM_PROMPT = """You are Gut, an autonomous operator of a Linux desktop (XFCE4, {res}).
You perceive the screen through screenshots and act with mouse/keyboard tools.

Environment:
- To find or read web content, start with the text tools — fast and cheap,
  no browser or screenshots needed: web_search finds pages, fetch_url reads
  a page's text and links (run_command + curl works for APIs and downloads).
- Google Chrome is installed with DevTools on localhost:{cdp}. Use the
  browser_* tools only when the text tools can't do the job — pages needing
  JS, logins/sessions, forms, or visual checks (DOM refs, not pixels):
  open_url or browser_navigate to get somewhere, browser_text to read the
  page's text, browser_dom to list interactive elements as #refs, then
  browser_click / browser_type by ref; browser_eval runs arbitrary JS.
  Fall back to pixel tools for anything outside the page.
- LibreOffice Writer, Calc and Impress are installed
  (`libreoffice --writer/--calc/--impress`).
- run_command gives you a bash shell (cwd {home}, DISPLAY already set).
  Launch GUI apps in the background so the command returns, e.g. `google-chrome &`.
- {home}/scratch is wiped when the task ends — use it for temp and
  intermediate files. Keep anything needed later elsewhere in {home}.
- {coords}
- Older screenshots are dropped from context — only recent frames are kept.
  The text log of your actions stays; call screenshot for a fresh look.

Talking to the user — act like a teammate, not a live feed:
- The user only sees what you deliberately send via the send_* tools,
  ask_user and task_complete. Your plain text replies and tool calls go to a
  verbose log the user can open, but normally doesn't watch — never rely on
  them to reach the user.
- send_message: a short chat update. Use sparingly — a milestone on a long
  task, a blocker, a finding worth flagging. Silence is fine while work is
  straightforward; do not narrate steps.
- send_file: deliver an artifact (report, spreadsheet, export, download) as a
  chat attachment. Paths are relative to {home}. The user can't browse this
  filesystem — before task_complete, send_file every file they'll want,
  including attached files you edited; a path in the summary is not delivery.
- send_image: show the user an image — a file, or a fresh screenshot when no
  path is given.
- Files the user attaches to a message are saved under {home}/uploads/ — the
  message text lists the exact paths; open them with run_command or the file
  tools. Attached images are also shown to you inline.
- ask_user: pause for input only when blocked on something only a human can
  provide — a decision, credential, 2FA or CAPTCHA. Never for information
  visible on screen, and never just because you're stuck — brainstorm more
  approaches instead.
- task_complete: ends the task and sends `summary` as your wrap-up message.
  Make it a good one: what was done, where results live, what to check.

Planning — match the effort to the task:
- Small tasks: just do them — no plan, no checklist.
- Big multi-phase tasks: call share_plan once with a concise plan (it posts
  to the user as a card — no approval needed, keep working), then
  update_todos with the step list. Pass the full list every call, keep
  exactly one item in_progress, mark steps done as you go. If the scope
  changes, share_plan again and rewrite the list.
- On very long runs your older context gets compacted into a handoff
  summary — the checklist always survives it. Anything else worth keeping
  (paths, URLs, decisions, findings) belongs in the todo text or in files
  under {home}.

Guidelines:
- A fresh screenshot is attached automatically after each turn's actions; only
  call screenshot when nothing changed or you need an extra look.
- Batch predictable sequences into one response — emit several tool calls at
  once (e.g. click field → type → press enter). Split only when the next step
  depends on what the screen shows after the previous one.
- Prefer keyboard shortcuts, direct typing and run_command over pixel hunting.
- For anything online, web_search/fetch_url first; browser_* only when they
  fail or the page genuinely needs a browser (JS, auth, interaction).
- If an action changes nothing after two tries, stop and brainstorm at least
  5 different approaches (keyboard navigation, menus, run_command, the
  browser_* tools, a different app entirely) and try the most promising
  untried one. Never keep repeating the same click, and never give up —
  there is almost always another way forward.
- type_text and key go to whatever window has focus — if keystrokes aren't
  landing, click the target field first (or use browser_type on web pages).
- Never click tel:/mailto: links; they're blocked and just pop a dead-end OS
  dialog. Read phone numbers and addresses with browser_text instead.
- If an OS dialog does appear ('Open xdg-open?', permission prompts, file
  pickers), press Escape to dismiss it rather than pixel-clicking buttons.
- If a login, 2FA, CAPTCHA or genuinely ambiguous decision blocks you, call
  ask_user — the human can click into the live screen to help, then resume you.
- When your task ends the system closes the apps, windows and browser tabs
  you opened and stops leftover processes. Logins and cookies persist across
  tasks — never log out or wipe browser data as "cleanup".

Delegating — spawn_agent runs a helper agent in the background:
- Give it self-contained headless subtasks: web research, reading or writing
  files, crunching data with run_command. It has no screen, no browser and
  no way to reach the user — anything needing eyes, clicks or logins is yours.
- Its final report arrives as a message mid-run; collect_agent(name) blocks
  until it (or any helper) reports. Share artifacts through files under {home}.
- Good use: "research these 5 companies" → spawn several and keep working.
  At most {subcap} helpers run at once.
"""

SUBAGENT_PROMPT = """You are '{name}', a background helper spawned by Gut on a Linux desktop.
The main agent works in parallel and only ever sees your final report.

Tools:
- web_search + fetch_url: find and read web content (text only).
- run_command: bash, cwd {home}. There is no display — GUI apps and anything
  needing a screen fail; stay headless (curl, scripts, files, packages).
- send_file: deliver a file to the user (paths relative to {home}).
- task_complete: finish; `summary` becomes your report to the main agent.

Rules:
- Your whole output is the final report — pack in findings, file paths,
  blockers. For substantial output, write files under {home} and return the
  paths instead of pasting everything.
- You cannot see the screen, drive the browser, or ask the user anything —
  put blockers in the report instead.
- A reply with no tool calls also ends your run, with the reply as the
  report — but prefer task_complete so the intent is clear.
"""

COORD_PROMPT_PIXEL = ("Tool coordinates refer to pixels in the screenshot "
                      "image you received.")
COORD_PROMPT_NORM = ("Tool coordinates use a normalized 0-1000 grid over the "
                     "screenshot — [500, 500] is the center of the screen, "
                     "[0, 0] the top-left corner.")


class AgentState:
    def __init__(self) -> None:
        self.model = DEFAULT_MODEL
        self.litellm_key: str = LITELLM_MASTER_KEY
        self.clients: set[WebSocket] = set()
        self.task: asyncio.Task | None = None
        self.paused = False
        self.stop = False
        self.pending_answer: asyncio.Future | None = None
        self.coord_scale = 1.0  # screenshot px -> real desktop px
        # Dimensions of the last image sent to the model (after downscale).
        try:
            w, h = RESOLUTION.lower().split("x")
            self.shot_size = (int(w), int(h))
        except ValueError:
            self.shot_size = (1024, 768)
        self.frame_hash: str | None = None  # last frame sent to the model
        self.browser_ws: str | None = None  # CDP ws url of the active page
        self.conversation_id: str | None = None  # conversation of the current/last run
        self.session_usd = 0.0
        self.tokens_in = 0
        self.tokens_out = 0
        self.models_synced = False  # provider keys pushed into LiteLLM
        # Background helpers: name -> {task, desc, conv, status, result,
        # model, usd, steps, delivered}. Finished entries queue on
        # subagent_inbox for injection into their conversation's context.
        self.subagents: dict[str, dict] = {}
        self.subagent_inbox = deque()
        # The running conversation's update_todos checklist (persisted at
        # <cid>.todos.json) and the long-horizon bookkeeping for reminders
        # and compaction.
        self.todos: list[dict] = []
        self.steps_since_todo = 0
        self.steps_since_compact = 99
        self.ctx_limit: dict[str, int] = {}  # model -> max_input_tokens
        # Delivery bookkeeping for the unsent-output nudge at task_complete:
        # run_start marks the current task's beginning; delivered maps an
        # attachment's resolved path -> mtime when the user sent it (cumulative
        # across runs); sent_files maps path -> mtime at send_file time, so a
        # post-send edit counts as unsent again.
        self.run_start = 0.0
        self.delivered: dict[str, float] = {}
        self.sent_files: dict[str, float] = {}
        self.output_nudge_done = False

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    @property
    def phase(self) -> str:
        if not self.running:
            return "idle"
        if self.pending_answer is not None and not self.pending_answer.done():
            return "waiting_user"
        return "paused" if self.paused else "running"


state = AgentState()


# ── Conversations ────────────────────────────────────────────────────────────
# A conversation lives on one device and carries its own model context, so a
# follow-up message continues where the agent left off. On disk:
#   <id>.meta.json     — {id, title, model, created_at, updated_at, events}
#   <id>.jsonl         — append-only transcript events, each {seq, ts, ...event}
#   <id>.context.json  — the LLM message array, rewritten after each step

_CID_RE = re.compile(r"[0-9a-zA-Z_-]{1,64}")


def _conv_paths(cid: str) -> tuple[Path, Path, Path]:
    if not _CID_RE.fullmatch(cid or ""):
        raise ValueError(f"bad conversation id: {cid!r}")
    return (CONV_DIR / f"{cid}.meta.json",
            CONV_DIR / f"{cid}.jsonl",
            CONV_DIR / f"{cid}.context.json")


def _read_meta(cid: str) -> dict | None:
    meta_path, _, _ = _conv_paths(cid)
    try:
        return json.loads(meta_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _write_meta(meta: dict) -> None:
    meta_path, _, _ = _conv_paths(meta["id"])
    tmp = meta_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta))
    tmp.replace(meta_path)


def conv_create(model: str, title: str = "") -> dict:
    CONV_DIR.mkdir(parents=True, exist_ok=True)
    cid = uuid4().hex[:12]
    now = time.time()
    meta = {"id": cid, "title": title, "model": model,
            "created_at": now, "updated_at": now, "events": 0,
            "cost_usd": 0.0, "tokens_in": 0, "tokens_out": 0}
    _write_meta(meta)
    _conv_paths(cid)[1].touch()
    return meta


def conv_list() -> list[dict]:
    metas = []
    try:
        paths = list(CONV_DIR.glob("*.meta.json"))
    except OSError:
        return []
    for p in paths:
        try:
            metas.append(json.loads(p.read_text()))
        except (OSError, json.JSONDecodeError):
            continue
    metas.sort(key=lambda m: m.get("updated_at") or 0, reverse=True)
    return metas


def conv_get(cid: str) -> dict | None:
    meta = _read_meta(cid)
    if meta is None:
        return None
    _, events_path, _ = _conv_paths(cid)
    events = []
    try:
        for line in events_path.read_text().splitlines():
            if line.strip():
                events.append(json.loads(line))
    except (OSError, json.JSONDecodeError):
        pass
    return {"meta": meta, "events": events, "todos": conv_load_todos(cid)}


def conv_delete(cid: str) -> bool:
    if _read_meta(cid) is None:
        return False
    for p in _conv_paths(cid):
        p.unlink(missing_ok=True)
    try:
        _todo_path(cid).unlink(missing_ok=True)
    except ValueError:
        pass
    return True


def conv_append_event(cid: str, event: dict) -> int | None:
    """Append a transcript event; returns its seq (1-based per conversation).

    The first user message also becomes the conversation title.
    """
    meta = _read_meta(cid)
    if meta is None:
        return None
    seq = int(meta.get("events") or 0) + 1
    meta["events"] = seq
    meta["updated_at"] = time.time()
    if not meta.get("title") and event.get("type") == "user":
        lines = str(event.get("text") or "").strip().splitlines()
        files = event.get("files") or []
        fallback = files[0]["name"] if files else "Conversation"
        meta["title"] = (lines[0][:80] if lines else "") or fallback
    rec = {"seq": seq, "ts": meta["updated_at"]}
    rec.update({k: v for k, v in event.items()
                if k not in ("seq", "conversation_id")})
    _, events_path, _ = _conv_paths(cid)
    try:
        with events_path.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        _write_meta(meta)
    except OSError:
        return None
    return seq


def conv_set_model(cid: str, model: str) -> None:
    meta = _read_meta(cid)
    if meta is not None:
        meta["model"] = model
        _write_meta(meta)


def conv_add_usage(cid: str, usd: float, tokens_in: int, tokens_out: int) -> None:
    """Accumulate spend into the conversation's meta file."""
    try:
        meta = _read_meta(cid)
    except ValueError:
        return
    if meta is None:
        return
    meta["cost_usd"] = round(float(meta.get("cost_usd") or 0) + usd, 6)
    meta["tokens_in"] = int(meta.get("tokens_in") or 0) + tokens_in
    meta["tokens_out"] = int(meta.get("tokens_out") or 0) + tokens_out
    try:
        _write_meta(meta)
    except OSError:
        pass


def conv_load_context(cid: str) -> list | None:
    _, _, ctx_path = _conv_paths(cid)
    try:
        messages = json.loads(ctx_path.read_text())
        return messages if isinstance(messages, list) and messages else None
    except (OSError, json.JSONDecodeError):
        return None


def conv_save_context(cid: str, messages: list) -> None:
    _, _, ctx_path = _conv_paths(cid)
    try:
        tmp = ctx_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(messages))
        tmp.replace(ctx_path)
    except OSError as e:
        print(f"[gut] context save failed for {cid}: {e}")


def _todo_path(cid: str) -> Path:
    if not _CID_RE.fullmatch(cid or ""):
        raise ValueError(f"bad conversation id: {cid!r}")
    return CONV_DIR / f"{cid}.todos.json"


def conv_load_todos(cid: str) -> list[dict]:
    try:
        items = json.loads(_todo_path(cid).read_text())
    except (OSError, json.JSONDecodeError, ValueError):
        return []
    if not isinstance(items, list):
        return []
    return [i for i in items
            if isinstance(i, dict) and str(i.get("content") or "").strip()]


def conv_save_todos(cid: str, items: list[dict]) -> None:
    try:
        p = _todo_path(cid)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(items))
        tmp.replace(p)
    except (OSError, ValueError) as e:
        print(f"[gut] todos save failed for {cid}: {e}")


def sanitize_context(messages: list) -> None:
    """Repair a stored context so the API accepts it on resume.

    A run stopped mid-turn can leave an assistant tool_call without its tool
    result (Anthropic rejects those) or an orphan tool result. Fill missing
    results with a placeholder and drop orphans, in place.
    """
    i = 0
    while i < len(messages):
        msg = messages[i]
        calls = (msg.get("tool_calls") or []) if msg.get("role") == "assistant" else []
        if not calls:
            i += 1
            continue
        want = {tc.get("id") for tc in calls}
        j = i + 1
        while j < len(messages) and messages[j].get("role") == "tool":
            if messages[j].get("tool_call_id") in want:
                want.discard(messages[j].get("tool_call_id"))
                j += 1
            else:
                del messages[j]  # orphan result for a call we no longer have
        for k, tid in enumerate(sorted(t for t in want if t)):
            messages.insert(j + k, {
                "role": "tool", "tool_call_id": tid,
                "content": "(interrupted before a result was produced)"})
        i = j + len(want)


# ── LiteLLM ─────────────────────────────────────────────────────────────────

async def provision_key() -> str:
    """Reuse or mint a 'gut-agent' virtual key so spend is attributed to it.

    The key is persisted on the desktop-home volume so lifetime spend survives
    container restarts. Falls back to the master key if LiteLLM is unreachable.
    """
    if not LITELLM_MASTER_KEY:
        return ""
    for attempt in range(30):
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                if KEY_FILE.exists():
                    saved = KEY_FILE.read_text().strip()
                    if saved:
                        r = await c.get(
                            f"{LITELLM_URL}/key/info",
                            params={"key": saved},
                            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
                        )
                        if r.status_code == 200:
                            print("[gut] reusing persisted virtual key")
                            return saved
                r = await c.post(
                    f"{LITELLM_URL}/key/generate",
                    headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
                    json={"key_alias": "gut-agent"},
                )
                r.raise_for_status()
                key = r.json()["key"]
                try:
                    KEY_FILE.write_text(key)
                except OSError:
                    pass
                return key
        except Exception as e:  # LiteLLM may still be migrating on first boot
            print(f"[gut] key generate attempt {attempt + 1} failed: {e}")
            await asyncio.sleep(5)
    print("[gut] falling back to master key")
    return LITELLM_MASTER_KEY


async def litellm_spend() -> float | None:
    """Lifetime spend for the agent key, from LiteLLM's spend tracking API."""
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{LITELLM_URL}/key/info",
                params={"key": state.litellm_key},
                headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
            )
            r.raise_for_status()
            info = r.json().get("info") or {}
            return float(info.get("spend") or 0)
    except Exception:
        return None


def track_cost(resp: httpx.Response) -> tuple[float, int, int]:
    """Add a response's spend to the session totals; returns the delta
    (usd, tokens_in, tokens_out) so the caller can attribute it."""
    usd = tin = tout = 0
    try:
        usd = float(resp.headers.get("x-litellm-response-cost") or 0)
        state.session_usd += usd
    except ValueError:
        pass
    try:
        usage = resp.json().get("usage") or {}
        tin = int(usage.get("prompt_tokens") or 0)
        tout = int(usage.get("completion_tokens") or 0)
        state.tokens_in += tin
        state.tokens_out += tout
    except Exception:
        pass
    return usd, tin, tout


async def push_cost() -> None:
    msg = {
        "type": "cost",
        "session_usd": round(state.session_usd, 6),
        "lifetime_usd": await litellm_spend(),
        "tokens_in": state.tokens_in,
        "tokens_out": state.tokens_out,
        "model": state.model,
    }
    # The running conversation's own spend, for clients showing per-chat usage.
    if state.running and state.conversation_id:
        try:
            meta = _read_meta(state.conversation_id) or {}
        except ValueError:
            meta = {}
        msg["conversation_id"] = state.conversation_id
        msg["conversation_usd"] = meta.get("cost_usd") or 0
    await broadcast(msg)


# ── Provider keys (BYOK) ─────────────────────────────────────────────────────
# Model provider keys reach the daemon two ways:
#   * env vars on this process — compose's shared .env, or the deb's
#     /etc/gut/gut-bot.env (source "env"), and
#   * pushed from the app via POST /api/keys — persisted in
#     PROVIDER_KEYS_FILE on the data volume (source "pushed").
# Pushed keys win over env ones for the same provider. For every effective
# key the daemon registers that provider's models in LiteLLM's DB-backed
# model store (store_model_in_db) under deployment ids prefixed "gut-", so
# keys take effect with no service restarts and the shipped config can stay
# keyless. A static config.yaml entry under the same model_name suppresses
# the managed deployment — hand-written config always wins.
PROVIDER_MODELS = {
    "ANTHROPIC_API_KEY": [
        ("claude-sonnet-4-5", "anthropic/claude-sonnet-4-5-20250929"),
        ("claude-haiku-4-5", "anthropic/claude-haiku-4-5-20251001"),
    ],
    "OPENAI_API_KEY": [
        ("gpt-5", "openai/gpt-5"),
        ("gpt-4o", "openai/gpt-4o"),
    ],
    "GEMINI_API_KEY": [
        ("gemini-2.5-pro", "gemini/gemini-2.5-pro"),
        ("gemini-2.5-flash", "gemini/gemini-2.5-flash"),
    ],
    "DEEPSEEK_API_KEY": [
        ("deepseek-chat", "deepseek/deepseek-chat"),
    ],
    "OPENROUTER_API_KEY": [
        ("openrouter/claude-sonnet-4.5",
         "openrouter/anthropic/claude-sonnet-4.5"),
        ("openrouter/gpt-5", "openrouter/openai/gpt-5"),
        ("openrouter/gemini-2.5-pro", "openrouter/google/gemini-2.5-pro"),
        ("openrouter/qwen3-vl", "openrouter/qwen/qwen3-vl-235b-a22b-instruct"),
    ],
}
PROVIDER_KEYS = tuple(PROVIDER_MODELS)
PROVIDER_KEYS_FILE = GUT_DATA_DIR / "provider_keys.json"
MANAGED_PREFIX = "gut-"


def load_provider_keys() -> dict:
    try:
        data = json.loads(PROVIDER_KEYS_FILE.read_text())
        return {k: str(v).strip() for k, v in data.items()
                if k in PROVIDER_KEYS and str(v).strip()}
    except (OSError, json.JSONDecodeError, AttributeError):
        return {}


def store_provider_keys(keys: dict) -> None:
    PROVIDER_KEYS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PROVIDER_KEYS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(keys))
    tmp.chmod(0o600)
    tmp.replace(PROVIDER_KEYS_FILE)


def effective_provider_keys() -> dict:
    """{env key: (value, "env"|"pushed")} — pushed keys override env."""
    eff = {k: (os.environ[k].strip(), "env") for k in PROVIDER_KEYS
           if os.environ.get(k, "").strip()}
    for k, v in load_provider_keys().items():
        eff[k] = (v, "pushed")
    return eff


async def litellm_admin(method: str, path: str, **kw) -> httpx.Response:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.request(
            method, f"{LITELLM_URL}{path}",
            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"}, **kw)
        r.raise_for_status()
        return r


def _managed_id(m: dict) -> str:
    """Deployment id when `m` is one of ours (DB-stored), else ''."""
    info = m.get("model_info") or {}
    mid = str(info.get("id") or "")
    if mid.startswith(MANAGED_PREFIX) or info.get("managed_by") == "gut":
        return mid
    return ""


def _deployment_id(model_name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", model_name).strip("-").lower()
    return f"{MANAGED_PREFIX}{slug}"


async def litellm_deployments() -> list[dict]:
    r = await litellm_admin("GET", "/model/info")
    data = r.json()
    items = data.get("data", []) if isinstance(data, dict) else data
    return [m for m in items if isinstance(m, dict)]


_reconcile_lock = asyncio.Lock()


async def reconcile_models() -> None:
    """Sync LiteLLM's deployments with the effective provider keys.

    Deletes every managed (gut-*) deployment then re-adds the desired set —
    cheap, idempotent, and self-healing when keys change or the LiteLLM DB
    was reset. A model_name already served by a static (unmanaged) config
    entry is left to it.
    """
    desired = {}
    for env_key, models in PROVIDER_MODELS.items():
        eff = effective_provider_keys().get(env_key)
        if not eff:
            continue
        for name, litellm_model in models:
            desired[name] = (litellm_model, eff[0])
    async with _reconcile_lock:
        current = await litellm_deployments()
        static_names = {m.get("model_name") for m in current
                        if m.get("model_name") and not _managed_id(m)}
        for m in current:
            mid = _managed_id(m)
            if mid:
                await litellm_admin("POST", "/model/delete",
                                    json={"id": mid})
        added = []
        for name, (litellm_model, key) in desired.items():
            if name in static_names:
                continue
            await litellm_admin("POST", "/model/new", json={
                "model_name": name,
                "litellm_params": {"model": litellm_model,
                                   "api_key": key,
                                   "max_tokens": 8192},
                "model_info": {"id": _deployment_id(name),
                               "managed_by": "gut"},
            })
            added.append(name)
        # If the configured default model doesn't exist (no key for it),
        # fall back to the first model that does — a task sent before the
        # user picks a model shouldn't hit a missing deployment.
        available = static_names | set(added)
        if available and state.model not in available:
            state.model = added[0] if added else sorted(available)[0]
            await push_status()


async def model_sync_loop() -> None:
    """Retry reconcile until LiteLLM accepts it, then stay quiet. Key pushes
    reset state.models_synced to trigger another pass."""
    while True:
        if not state.models_synced:
            try:
                await reconcile_models()
                state.models_synced = True
                print("[gut] litellm models synced")
            except Exception as e:
                print(f"[gut] model sync failed (retrying in 20s): {e}")
        await asyncio.sleep(20)


# ── WebSocket plumbing ───────────────────────────────────────────────────────

# Event types that make up the persisted transcript — status/cost/hello are
# ephemeral channel noise and are not recorded.
TRANSCRIPT_TYPES = frozenset({
    "user", "agent_msg", "done", "file", "image",
    "thought", "action", "action_result", "question", "error",
    "subagent", "cleanup", "plan", "compact"})


def record_event(msg: dict) -> None:
    """Persist a transcript event into the running conversation, then tag the
    outgoing message with (conversation_id, seq) so clients can dedupe live
    events against fetched history."""
    if msg.get("type") not in TRANSCRIPT_TYPES or "seq" in msg:
        return
    cid = state.conversation_id
    if not cid or not state.running:
        return
    seq = conv_append_event(cid, msg)
    if seq is not None:
        msg["conversation_id"] = cid
        msg["seq"] = seq


async def broadcast(msg: dict) -> None:
    record_event(msg)
    data = json.dumps(msg)
    dead = []
    for ws in list(state.clients):
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.clients.discard(ws)


async def push_status() -> None:
    await broadcast({"type": "status", "state": state.phase,
                     "model": state.model,
                     "conversation_id":
                         state.conversation_id if state.running else None})


# ── Desktop control ──────────────────────────────────────────────────────────

def capture_frame() -> tuple[str, str]:
    """Return (base64 JPEG, content hash) of the current screen."""
    subprocess.run(["scrot", "-o", str(SHOT_PATH)], check=True)
    img = Image.open(SHOT_PATH).convert("RGB")
    # Vision APIs silently rescale images past their limits (Anthropic: >1568px
    # long edge or >~1.15MP) and the model then emits coordinates in that
    # rescaled space — clicks land off-target. Stay under both limits.
    scale = min(
        SCREENSHOT_MAX_EDGE / max(img.size),
        (SCREENSHOT_MAX_PIXELS / (img.width * img.height)) ** 0.5,
        1.0,
    )
    if scale < 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    state.coord_scale = 1.0 / scale
    state.shot_size = img.size
    data = buf.getvalue()
    return base64.b64encode(data).decode(), hashlib.sha256(data).hexdigest()


def screenshot_block(force: bool = False) -> dict | None:
    """Fresh screenshot block, or None if the frame is byte-identical to the
    last one sent (dedup — no point re-billing the model for a static screen).
    """
    b64, h = capture_frame()
    if not force and h == state.frame_hash:
        return None
    state.frame_hash = h
    return {
        "type": "image_url",
        "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
    }


def coords_normalized() -> bool:
    """True when the active model emits 0-1000 normalized coordinates."""
    m = state.model.lower()
    return any(p in m for p in NORMALIZED_COORD_MODELS)


def to_real_xy(coord) -> tuple[int, int]:
    x, y = float(coord[0]), float(coord[1])
    if coords_normalized():
        # gemini-*-computer-use emits [y, x]; everything else is [x, y].
        if "computer-use" in state.model.lower():
            x, y = y, x
        w, h = state.shot_size
        x, y = x * w / 1000, y * h / 1000
    s = state.coord_scale
    return round(x * s), round(y * s)


def _pos(args) -> tuple[int, int, str]:
    """Resolve tool coords to desktop px. The label echoes the model's own
    screenshot coords — showing the rescaled desktop number reads as a
    'coordinate mismatch' and models start compensating for it."""
    x, y = to_real_xy(args["coordinate"])
    sx, sy = args["coordinate"][0], args["coordinate"][1]
    return x, y, f"{sx},{sy}"


_KEYMAP = {
    "ctrl": "ctrl", "control": "ctrl", "cmd": "win", "command": "win",
    "super": "win", "meta": "win", "option": "alt", "return": "enter",
    "escape": "esc", "del": "delete", "pgup": "pageup", "pgdn": "pagedown",
    " ": "space",
}


def press_keys(spec: str) -> str:
    if "+" in spec:
        keys = [_KEYMAP.get(k.strip().lower(), k.strip().lower()) for k in spec.split("+")]
        pyautogui.hotkey(*keys)
        return f"pressed {'+'.join(keys)}"
    keys = [_KEYMAP.get(k.lower(), k.lower()) for k in spec.split()]
    pyautogui.press(keys)
    return f"pressed {' '.join(keys)}"


def type_text(text: str) -> str:
    try:
        text.encode("ascii")
        short_ascii = len(text) <= 40
    except UnicodeEncodeError:
        short_ascii = False
    if not short_ascii:
        # Long or non-ASCII text goes through the clipboard: far faster than
        # synthetic keystrokes and immune to keyboard-layout quirks.
        try:
            subprocess.run(["xclip", "-selection", "clipboard"],
                           input=text.encode(), check=True)
            pyautogui.hotkey("ctrl", "v")
            return f"pasted {len(text)} chars via clipboard"
        except (OSError, subprocess.SubprocessError):
            pass  # fall through to synthetic typing
    try:
        text.encode("ascii")
        pyautogui.write(text, interval=0.01)
    except (UnicodeEncodeError, pyautogui.PyAutoGUIException):
        # xdotool handles unicode better than pyautogui's Xlib path
        subprocess.run(["xdotool", "type", "--delay", "12", "--", text], check=False)
    return f"typed {len(text)} chars"


def run_command(command: str, headless: bool = False) -> str:
    # Redirect via a real file, not pipes: a backgrounded child (`foo &`)
    # inherits stdout/stderr, and communicate() would block on pipe EOF until
    # that child exits — a false "still running" timeout for every GUI launch.
    env = None
    if headless:
        # Subagent shell: no display, so GUI launches fail fast instead of
        # silently hijacking the screen the main agent is using.
        env = {k: v for k, v in os.environ.items()
               if k not in ("DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY")}
    fd, out_path = tempfile.mkstemp(prefix="gut-cmd-", suffix=".out")
    try:
        with os.fdopen(fd, "w") as f:
            p = subprocess.run(
                ["bash", "-lc", command],
                stdout=f, stderr=subprocess.STDOUT,
                timeout=COMMAND_TIMEOUT, cwd=str(HOME_DIR), env=env,
            )
        out = Path(out_path).read_text(errors="replace").strip()
        return (out or f"(exit {p.returncode}, no output)")[:4000]
    except subprocess.TimeoutExpired:
        return "command still running after timeout — it may have been left in the foreground"
    finally:
        Path(out_path).unlink(missing_ok=True)


def list_windows() -> str:
    p = subprocess.run(["wmctrl", "-l"], capture_output=True, text=True)
    return p.stdout.strip() or "(no windows)"


def focus_window(match: str) -> str:
    p = subprocess.run(["wmctrl", "-a", match], capture_output=True, text=True)
    if p.returncode != 0:
        return f"no window matching '{match}' — try list_windows"
    return f"focused window matching '{match}'"


def _unfocused_warning() -> str | None:
    """type_text/key deliver keystrokes to whatever window holds X focus.
    When that's the desktop or panel — or nothing — the input goes nowhere,
    so warn instead of letting the model assume it landed."""
    try:
        p = subprocess.run(["xdotool", "getactivewindow", "getwindowname"],
                           capture_output=True, text=True, timeout=5)
        win = p.stdout.strip() if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        win = ""
    if not win:
        return ("NOTE: no application window has focus — keystrokes may have "
                "gone nowhere. focus_window or click a field first.")
    if win.lower() in ("desktop", "xfce4-panel"):
        return (f"NOTE: focus is on '{win}', not an app — keystrokes may "
                "have gone nowhere. focus_window or click a field first.")
    return None


# ── Chrome DevTools Protocol ──────────────────────────────────────────────────
# Chrome launches with --remote-debugging-port (see the wrapper in Dockerfile),
# so the agent can drive the page via DOM refs instead of pixel hunting.

class CDPError(RuntimeError):
    pass


async def cdp_up() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{CDP_HTTP}/json/version")
            return r.status_code == 200
    except httpx.HTTPError:
        return False


# Schemes this desktop can't handle — clicking them just spawns a modal
# 'Open xdg-open?' dialog that blocks the page until someone dismisses it.
BLOCKED_SCHEMES = ("tel", "mailto", "sms", "callto", "sip", "skype",
                   "facetime", "zoommtg", "msteams")


def block_external_schemes() -> None:
    """Keep tel:/mailto:/etc links from spawning 'Open xdg-open?' dialogs.

    Chrome consults protocol_handler.excluded_schemes in the profile's
    Preferences and silently ignores clicks on listed schemes — exactly what
    we want on a desktop with nothing to hand them to.
    """
    prefs = Path.home() / ".gut-chrome" / "Default" / "Preferences"
    try:
        data = json.loads(prefs.read_text()) if prefs.exists() else {}
        schemes = data.setdefault("protocol_handler", {}) \
                      .setdefault("excluded_schemes", {})
        for s in BLOCKED_SCHEMES:
            schemes[s] = True
        prefs.parent.mkdir(parents=True, exist_ok=True)
        tmp = prefs.with_name("Preferences.tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(prefs)
    except (OSError, json.JSONDecodeError):
        pass


_last_browser_heal = 0.0


def _kick_browser_provision() -> None:
    """Deb installs: hand the missing/broken browser to ensure-browser.sh so
    a failed launch self-heals instead of waiting for a service restart.
    The script is idempotent and self-throttling, so kicks are cheap."""
    global _last_browser_heal
    if not Path("/opt/gut/ensure-browser.sh").exists():
        return
    now = time.monotonic()
    if now - _last_browser_heal < 120:
        return
    _last_browser_heal = now
    try:
        subprocess.Popen(["sudo", "-n", "/opt/gut/ensure-browser.sh"])
    except OSError:
        pass


async def ensure_browser(url: str | None = None) -> str:
    """Guarantee Chrome is running with CDP; returns a status line."""
    if await cdp_up():
        return "chrome already running"
    running = subprocess.run(["pgrep", "-f", "chrome|chromium"],
                             capture_output=True).returncode == 0
    if running:
        # Chrome is up but without CDP (e.g. started before the wrapper flags
        # existed) — relaunch so the browser_* tools can work.
        subprocess.run(["pkill", "-f", "chrome|chromium"], check=False)
        await asyncio.sleep(1.5)
    block_external_schemes()  # Chrome must be stopped while we edit prefs
    target = f" {shlex.quote(url)}" if url else ""
    subprocess.Popen(["bash", "-lc",
                      f"nohup google-chrome{target} >/dev/null 2>&1 &"])
    for _ in range(50):
        if await cdp_up():
            return "chrome started"
        await asyncio.sleep(0.5)
    _kick_browser_provision()
    raise CDPError(
        f"chrome did not expose CDP on :{CDP_PORT} — provisioning a "
        "working browser in the background; retry in a minute")


async def cdp_send(ws, method: str, params: dict | None = None) -> dict:
    cdp_send.next_id += 1
    await ws.send(json.dumps({"id": cdp_send.next_id, "method": method,
                              "params": params or {}}))
    while True:  # skip CDP events until our response arrives
        msg = json.loads(await asyncio.wait_for(ws.recv(), 30))
        if msg.get("id") == cdp_send.next_id:
            if "error" in msg:
                raise CDPError(f"{method}: {msg['error'].get('message')}")
            return msg.get("result") or {}


cdp_send.next_id = 0


async def cdp_page_ws_url(new_tab_url: str | None = None) -> str:
    """WS URL of the page target to drive. `new_tab_url` opens a fresh tab."""
    async with httpx.AsyncClient(timeout=5) as c:
        if new_tab_url:
            ver = (await c.get(f"{CDP_HTTP}/json/version")).json()
            async with ws_connect(ver["webSocketDebuggerUrl"]) as bws:
                tid = (await cdp_send(bws, "Target.createTarget",
                                      {"url": new_tab_url}))["targetId"]
                try:  # make the tab visible so DOM and screenshot agree
                    await cdp_send(bws, "Target.activateTarget",
                                   {"targetId": tid})
                except CDPError:
                    pass
            state.browser_ws = f"ws://localhost:{CDP_PORT}/devtools/page/{tid}"
            return state.browser_ws
        targets = (await c.get(f"{CDP_HTTP}/json/list")).json()
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise CDPError("chrome has no open pages — call open_url first")
    urls = {t["webSocketDebuggerUrl"] for t in pages}
    if state.browser_ws in urls:
        return state.browser_ws
    state.browser_ws = pages[0]["webSocketDebuggerUrl"]
    return state.browser_ws


async def cdp_eval(ws, expression: str):
    res = await cdp_send(ws, "Runtime.evaluate", {
        "expression": expression, "returnByValue": True, "awaitPromise": True})
    if res.get("exceptionDetails"):
        raise CDPError("js exception: "
                       + json.dumps(res["exceptionDetails"])[:300])
    result = res.get("result") or {}
    return result.get("value") if result.get("value") is not None \
        else result.get("description")


# Numbered-ref DOM dump: every interactive element visible in the viewport gets
# a #ref stored in window.__gutRefs for browser_click / browser_type.
_DOM_JS = r"""
(() => {
  const sel = 'a,button,input,textarea,select,option,summary,label,' +
              '[role="button"],[role="link"],[role="checkbox"],[role="tab"],' +
              '[contenteditable="true"],[onclick]';
  const vw = innerWidth, vh = innerHeight;
  window.__gutRefs = {};
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    i++;
    window.__gutRefs[i] = el;
    const txt = (el.innerText || el.value || el.placeholder ||
                 el.getAttribute('aria-label') || el.title || el.name || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    out.push('#' + i + ' <' + el.tagName.toLowerCase() + '>' +
             (txt ? ' "' + txt + '"' : '') + ' @(' + cx + ',' + cy + ')');
    if (i >= 200) break;
  }
  return location.href + '\n' + document.title + '\n' + out.join('\n');
})()
"""

_REF_CENTER_JS = r"""
(() => {
  const el = (window.__gutRefs || {})[%d];
  if (!el) return null;
  el.scrollIntoView({block: 'center', inline: 'center'});
  const r = el.getBoundingClientRect();
  return {x: r.left + r.width / 2, y: r.top + r.height / 2,
          href: el.href || el.getAttribute('href') || ''};
})()
"""

# Page text, for reading content (contact info, listings, articles) without
# burning screenshots on scroll-and-squint.
_TEXT_JS = r"""
(() => {
  const t = ((document.body && document.body.innerText) || '')
    .replace(/\n{3,}/g, '\n\n').trim();
  return location.href + '\n' + document.title + '\n\n' + t;
})()
"""


async def _wait_for_load(ws, timeout: float = 8.0) -> None:
    """Best-effort settle wait after a navigation (or a click that may
    trigger one). Runtime.evaluate throws while the execution context is
    being swapped mid-load — we treat that as 'still loading'."""
    await asyncio.sleep(0.3)  # give a triggered navigation a chance to start
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            if await cdp_eval(ws, "document.readyState") == "complete":
                return
        except (CDPError, asyncio.TimeoutError):
            pass
        await asyncio.sleep(0.25)


async def browser_navigate(url: str) -> str:
    await ensure_browser()
    ws_url = await cdp_page_ws_url()
    async with ws_connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        await cdp_send(ws, "Page.enable")
        await cdp_send(ws, "Page.navigate", {"url": url})
        await _wait_for_load(ws)
    return f"navigated to {url}"


async def browser_dom() -> str:
    await ensure_browser()
    ws_url = await cdp_page_ws_url()
    async with ws_connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        out = await cdp_eval(ws, _DOM_JS)
    return str(out or "(no interactive elements)")[:12000]


async def browser_text() -> str:
    await ensure_browser()
    ws_url = await cdp_page_ws_url()
    async with ws_connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        out = await cdp_eval(ws, _TEXT_JS)
    return str(out or "(empty page)")[:12000]


async def browser_click(ref: int) -> str:
    await ensure_browser()
    ws_url = await cdp_page_ws_url()
    async with ws_connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        pt = await cdp_eval(ws, _REF_CENTER_JS % ref)
        if not pt:
            return (f"ref #{ref} not found — run browser_dom again "
                    "(the page has changed)")
        scheme = str(pt.get("href") or "").split(":", 1)[0].lower()
        if scheme in BLOCKED_SCHEMES:
            return (f"ref #{ref} is a {scheme}: link — no handler exists on "
                    "this desktop, it would just pop a dead-end dialog. "
                    "Read its target with browser_text instead.")
        await cdp_send(ws, "Input.dispatchMouseEvent",
                       {"type": "mouseMoved", "x": pt["x"], "y": pt["y"]})
        for evt in ("mousePressed", "mouseReleased"):
            await cdp_send(ws, "Input.dispatchMouseEvent", {
                "type": evt, "x": pt["x"], "y": pt["y"],
                "button": "left", "clickCount": 1})
        await _wait_for_load(ws, timeout=4.0)  # in case the click navigated
    return f"clicked #{ref}"


async def browser_type(ref: int, text: str) -> str:
    await ensure_browser()
    ws_url = await cdp_page_ws_url()
    async with ws_connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        ok = await cdp_eval(ws, (
            "(() => { const el = (window.__gutRefs || {})[%d];"
            " if (!el) return false; el.scrollIntoView({block: 'center'});"
            " el.focus(); try { el.select(); } catch (e) {}"
            " return true; })()") % ref)
        if not ok:
            return (f"ref #{ref} not found — run browser_dom again "
                    "(the page has changed)")
        await cdp_send(ws, "Input.insertText", {"text": text})
    return f"typed {len(text)} chars into #{ref}"


async def browser_eval(expression: str) -> str:
    await ensure_browser()
    ws_url = await cdp_page_ws_url()
    async with ws_connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        val = await cdp_eval(ws, expression)
    return str(val)[:4000]


async def open_url(url: str) -> str:
    if await cdp_up():
        await cdp_page_ws_url(new_tab_url=url)
        await asyncio.sleep(0.8)
        return f"opened new tab: {url}"
    status = await ensure_browser(url)  # launches chrome with the URL as arg
    state.browser_ws = None  # next browser_* call picks the first page target
    await asyncio.sleep(0.8)
    return f"{status}; opened {url}"


# ── Web search & fetch ─────────────────────────────────────────────────────
# Text-only alternatives to driving Chrome: the agent searches via SearXNG
# (SEARXNG_URL — the compose stacks run one on the internal network; unset or
# unreachable = DuckDuckGo's HTML endpoint) and reads pages over plain HTTP.
# Deliberately absent from SCREEN_TOOLS: these turns carry no screenshot.

WEB_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Content of _SKIP_TAGS is dropped entirely (boilerplate); _BLOCK_TAGS only
# force line breaks so text doesn't run together.
_SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "head",
              "nav", "header", "footer", "aside", "form"}
_BLOCK_TAGS = {
    "p", "div", "br", "hr", "li", "ul", "ol", "tr", "td", "th", "table",
    "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "main",
    "blockquote", "pre", "fieldset", "figure", "figcaption",
}


class _PageText(HTMLParser):
    """Minimal HTML -> text+links extractor (stdlib, no deps)."""

    def __init__(self, base: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base
        self.skip = 0
        self.parts: list[str] = []
        self.links: list[tuple[str, str]] = []
        self._a_href: str | None = None
        self._a_text: list[str] = []
        self.title = ""
        self._in_title = False

    def _break(self) -> None:
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_starttag(self, tag, attrs) -> None:
        if tag == "title":
            self._in_title = True
        if tag in _SKIP_TAGS:
            self.skip += 1
            return
        if self.skip:
            return
        if tag in _BLOCK_TAGS:
            self._break()
        if tag == "a":
            href = dict(attrs).get("href")
            self._a_href = urljoin(self.base, href) if href else None
            self._a_text = []

    def handle_endtag(self, tag) -> None:
        if tag == "title":
            self._in_title = False
        if tag in _SKIP_TAGS:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag in _BLOCK_TAGS:
            self._break()
        if tag == "a":
            txt = " ".join("".join(self._a_text).split())
            if self._a_href and txt and len(txt) <= 140:
                self.links.append((txt, self._a_href))
            self._a_href = None
            self._a_text = []

    def handle_data(self, data) -> None:
        if self._in_title:
            self.title += data
            return
        if self.skip:
            return
        self.parts.append(data)
        if self._a_href is not None:
            self._a_text.append(data)

    def result(self) -> tuple[str, str, list]:
        lines = [" ".join(l.split()) for l in "".join(self.parts).split("\n")]
        text = "\n".join(l for l in lines if l)
        links = [(t, u) for t, u in self.links
                 if urlparse(u).scheme in ("http", "https")]
        return text, " ".join(self.title.split()), links


class _DDGResults(HTMLParser):
    """Parser for html.duckduckgo.com result pages (the SEARXNG_URL fallback)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict] = []
        self._cls = ""
        self._href: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs) -> None:
        cls = dict(attrs).get("class", "").split()
        if "result__a" in cls:
            self._cls, self._href, self._buf = "a", dict(attrs).get("href"), []
        elif "result__snippet" in cls:
            self._cls, self._buf = "snippet", []

    def handle_data(self, data) -> None:
        if self._cls:
            self._buf.append(data)

    def handle_endtag(self, tag) -> None:
        # Both result__a and result__snippet are anchors — inner tags like
        # <b> must not finalize the element early (they'd truncate text).
        if tag != "a" or not self._cls:
            return
        text = " ".join("".join(self._buf).split())
        if self._cls == "a":
            url = self._href or ""
            if "uddg=" in url:  # unwrap the /l/?uddg= redirect
                url = parse_qs(urlparse(url).query).get("uddg", [url])[0]
            if urlparse(url).scheme in ("http", "https"):
                self.results.append({"title": text, "url": url, "snippet": ""})
        elif self._cls == "snippet" and self.results:
            self.results[-1]["snippet"] = text
        self._cls = ""


async def _ddg_search(query: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True,
                                 headers={"User-Agent": WEB_UA}) as c:
        r = await c.post("https://html.duckduckgo.com/html/",
                         data={"q": query})
        r.raise_for_status()
    p = _DDGResults()
    p.feed(r.text)
    return p.results


async def web_search(query: str, max_results: int = 8) -> str:
    query = query.strip()
    if not query:
        return "empty query"
    n = max(1, min(int(max_results or 8), 15))
    results, backend = [], ""
    if SEARXNG_URL:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get(f"{SEARXNG_URL}/search",
                                params={"q": query, "format": "json"})
            if r.status_code == 200:
                results = [{"title": str(it.get("title", "")),
                            "url": str(it.get("url", "")),
                            "snippet": str(it.get("content") or "")}
                           for it in r.json().get("results", [])]
                backend = "searxng"
        except Exception:
            pass  # fall through to the DDG fallback
    if not results:
        try:
            results, backend = await _ddg_search(query), "duckduckgo"
        except Exception as e:
            return (f"search failed ({e}) — use the browser tools instead")
    if not results:
        return "no results — try rephrasing, or use the browser tools"
    lines = [f"{i}. {r['title']}\n   {r['url']}"
             + (f"\n   {r['snippet']}" if r["snippet"] else "")
             for i, r in enumerate(results[:n], 1)]
    return f"results for '{query}' via {backend}:\n" + "\n".join(lines)


async def fetch_url(url: str, max_chars: int = 6000) -> str:
    url = url.strip()
    if not re.match(r"https?://", url):
        return "url must start with http:// or https://"
    cap = max(500, min(int(max_chars or 6000), 16000))
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                     headers={"User-Agent": WEB_UA}) as c:
            async with c.stream("GET", url) as r:
                ctype = (r.headers.get("content-type", "")
                         .split(";")[0].strip().lower())
                enc = r.encoding or "utf-8"
                final_url = str(r.url)
                raw = b""
                async for chunk in r.aiter_bytes(65536):
                    raw += chunk
                    if len(raw) > 2_000_000:
                        break
    except Exception as e:
        return (f"fetch failed: {e} — if the page needs JS or a login, "
                "use the browser tools")
    if ctype in ("", "text/html", "application/xhtml+xml"):
        p = _PageText(final_url)
        p.feed(raw.decode(enc, errors="replace"))
        text, title, links = p.result()
        out = [f"# {title or final_url}", final_url, "", text[:cap]]
        if len(text) > cap:
            out.append(f"\n[truncated — {len(text)} chars total; refetch with "
                       "a higher max_chars or grab a section with curl]")
        seen: set[str] = set()
        link_lines = []
        for txt, href in links:
            if href in seen or len(link_lines) >= 25:
                continue
            seen.add(href)
            link_lines.append(f"  {txt} — {href}")
        if link_lines:
            out.append("\nlinks:")
            out.extend(link_lines)
        return "\n".join(out)
    if ctype.startswith("text/") or ctype in ("application/json",
                                             "application/xml"):
        return f"{final_url}\n\n" + raw[:cap].decode(enc, errors="replace")
    return (f"{final_url} is {ctype or 'unknown type'} ({len(raw)} bytes) — "
            "not readable as text; download it with run_command/curl or "
            "open it in the browser")


# Screen-mutating tools trigger one fresh screenshot per turn, attached to the
# last tool result (skipped when the frame is unchanged). See agent_loop.
SCREEN_TOOLS = {
    "left_click", "right_click", "middle_click", "double_click", "mouse_move",
    "scroll", "type_text", "key", "run_command", "wait",
    "browser_navigate", "browser_click", "browser_type", "open_url",
    "focus_window",
}

TOOLS = [
    {"type": "function", "function": {
        "name": "screenshot", "description": "Capture the current screen.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "wait",
        "description": "Wait for the screen to change (page loads, app launches, "
                       "animations). Sleeps the given seconds, then returns a "
                       "fresh screenshot.",
        "parameters": {"type": "object", "properties": {
            "seconds": {"type": "number",
                        "description": "seconds to wait, 0.1–60"}},
            "required": ["seconds"]}}},
    {"type": "function", "function": {
        "name": "left_click", "description": "Left-click at [x, y].",
        "parameters": {"type": "object", "properties": {
            "coordinate": {"type": "array", "items": {"type": "integer"},
                           "minItems": 2, "maxItems": 2}},
            "required": ["coordinate"]}}},
    {"type": "function", "function": {
        "name": "middle_click", "description": "Middle-click at [x, y].",
        "parameters": {"type": "object", "properties": {
            "coordinate": {"type": "array", "items": {"type": "integer"},
                           "minItems": 2, "maxItems": 2}},
            "required": ["coordinate"]}}},
    {"type": "function", "function": {
        "name": "right_click", "description": "Right-click at [x, y].",
        "parameters": {"type": "object", "properties": {
            "coordinate": {"type": "array", "items": {"type": "integer"},
                           "minItems": 2, "maxItems": 2}},
            "required": ["coordinate"]}}},
    {"type": "function", "function": {
        "name": "double_click", "description": "Double-click at [x, y].",
        "parameters": {"type": "object", "properties": {
            "coordinate": {"type": "array", "items": {"type": "integer"},
                           "minItems": 2, "maxItems": 2}},
            "required": ["coordinate"]}}},
    {"type": "function", "function": {
        "name": "mouse_move", "description": "Move the pointer to [x, y] without clicking.",
        "parameters": {"type": "object", "properties": {
            "coordinate": {"type": "array", "items": {"type": "integer"},
                           "minItems": 2, "maxItems": 2}},
            "required": ["coordinate"]}}},
    {"type": "function", "function": {
        "name": "scroll", "description": "Scroll at [x, y] (or current position).",
        "parameters": {"type": "object", "properties": {
            "coordinate": {"type": "array", "items": {"type": "integer"},
                           "minItems": 2, "maxItems": 2},
            "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
            "amount": {"type": "integer", "description": "scroll clicks, ~3 default"}},
            "required": ["direction"]}}},
    {"type": "function", "function": {
        "name": "type_text", "description": "Type text at the current focus.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"}}, "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "key",
        "description": "Press a key, combo, or sequence, e.g. 'enter', "
                       "'ctrl+c', 'alt+tab', 'f5', 'tab tab tab'.",
        "parameters": {"type": "object", "properties": {
            "keys": {"type": "string"}}, "required": ["keys"]}}},
    {"type": "function", "function": {
        "name": "run_command",
        "description": f"Run a bash command in the desktop session (cwd {HOME_DIR}). "
                       "Append '&' when launching GUI apps so it returns immediately.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string"}}, "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "web_search",
        "description": "Search the web — returns numbered results with title, "
                       "URL and snippet. Fast and text-only (no browser, no "
                       "screenshots): always prefer this for finding pages or "
                       "answers online.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
            "max_results": {"type": "integer",
                            "description": "results to return, default 8"}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "fetch_url",
        "description": "Fetch a URL over HTTP and return the page's text plus "
                       "its links — no browser needed. Much cheaper than "
                       "browser_* for reading articles, docs, posts. Pages "
                       "that need JS or a login come back thin; use the "
                       "browser then.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"},
            "max_chars": {"type": "integer",
                          "description": "text cap, default 6000 (max 16000)"}},
            "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "browser_navigate",
        "description": "Navigate the current Chrome tab to a URL (starts Chrome "
                       "with DevTools if it isn't running).",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "browser_dom",
        "description": "List the current page's interactive elements (links, "
                       "buttons, inputs, ...) as numbered #refs with their "
                       "on-screen positions. Required before browser_click or "
                       "browser_type; re-run after navigation or DOM changes.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "browser_text",
        "description": "Read the current page as text (URL, title, body "
                       "text). Much cheaper than reading screenshots — use "
                       "it to extract info, listings, contact details, etc.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "browser_click",
        "description": "Click page element #ref from the last browser_dom. "
                       "Far more reliable than pixel clicks on web pages.",
        "parameters": {"type": "object", "properties": {
            "ref": {"type": "integer",
                    "description": "element # from browser_dom"}},
            "required": ["ref"]}}},
    {"type": "function", "function": {
        "name": "browser_type",
        "description": "Focus element #ref, select any existing text, and type "
                       "into it. For dropdowns, browser_click the option instead.",
        "parameters": {"type": "object", "properties": {
            "ref": {"type": "integer"}, "text": {"type": "string"}},
            "required": ["ref", "text"]}}},
    {"type": "function", "function": {
        "name": "browser_eval",
        "description": "Evaluate a JS expression in the current page and return "
                       "the result — page state, form values, fetch(), etc.",
        "parameters": {"type": "object", "properties": {
            "expression": {"type": "string"}}, "required": ["expression"]}}},
    {"type": "function", "function": {
        "name": "open_url",
        "description": "Open a URL in Chrome — new tab if already running, "
                       "launches Chrome otherwise. Prefer this over clicking "
                       "the Chrome icon and typing in the address bar.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "list_windows",
        "description": "List open windows (id, desktop, title) via wmctrl.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "focus_window",
        "description": "Raise/focus the window whose title contains `match`.",
        "parameters": {"type": "object", "properties": {
            "match": {"type": "string"}}, "required": ["match"]}}},
    {"type": "function", "function": {
        "name": "send_message",
        "description": "Send a chat message to the user. Like a teammate: "
                       "milestones, blockers, things worth interrupting for — "
                       "not step-by-step narration.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"}}, "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "send_file",
        "description": "Send a file from this machine to the user as a "
                       f"download in chat (reports, spreadsheets, exports, "
                       f"downloads). Paths are relative to {HOME_DIR}.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"},
            "note": {"type": "string",
                     "description": "short caption shown with the file"}},
            "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "send_image",
        "description": "Send an image to the user, shown inline in chat. "
                       "With no path, sends a fresh screenshot of the desktop.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string",
                     "description": "image file; omit for a live screenshot"},
            "caption": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "ask_user",
        "description": "Pause and ask the human a question (logins, 2FA, CAPTCHAs, "
                       "ambiguous decisions). Waits for their reply.",
        "parameters": {"type": "object", "properties": {
            "question": {"type": "string"}}, "required": ["question"]}}},
    {"type": "function", "function": {
        "name": "spawn_agent",
        "description": "Spawn a background helper agent on a self-contained "
                       "headless subtask — web research, file and data work. "
                       "It gets web_search, fetch_url, run_command and "
                       "send_file (no screen, no browser, no user contact) "
                       "and reports back as a message when done. You keep "
                       "working meanwhile; collect_agent waits for a report.",
        "parameters": {"type": "object", "properties": {
            "task": {"type": "string",
                     "description": "complete instructions — the helper sees "
                                    "only this, not your conversation"},
            "name": {"type": "string",
                     "description": "short label, e.g. 'visa-research'"},
            "model": {"type": "string",
                      "description": "override model (default: yours)"}},
            "required": ["task"]}}},
    {"type": "function", "function": {
        "name": "collect_agent",
        "description": "Wait for a spawned helper to finish and return its "
                       "report. With no name, waits for the next one done.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "share_plan",
        "description": "Post your plan to the user as a card in chat. On big "
                       "multi-phase tasks share the plan once before "
                       "starting, then track the steps with update_todos. "
                       "Small tasks need neither.",
        "parameters": {"type": "object", "properties": {
            "plan": {"type": "string",
                     "description": "concise plan, markdown ok"}},
            "required": ["plan"]}}},
    {"type": "function", "function": {
        "name": "update_todos",
        "description": "Replace your working checklist — the user watches it "
                       "as a live card. Pass the full list every call and "
                       "keep exactly one item in_progress. It survives "
                       "context compaction; keep it current on long tasks.",
        "parameters": {"type": "object", "properties": {
            "items": {"type": "array", "items": {"type": "object",
                "properties": {
                    "content": {"type": "string"},
                    "status": {"type": "string",
                               "enum": ["pending", "in_progress", "done"]}},
                "required": ["content", "status"]}}},
            "required": ["items"]}}},
    {"type": "function", "function": {
        "name": "task_complete",
        "description": "End the task. `summary` is sent to the user as your "
                       "wrap-up message — cover what was done, where results "
                       "live, and anything they should check. send_file any "
                       "files the user needs first.",
        "parameters": {"type": "object", "properties": {
            "summary": {"type": "string"}}, "required": ["summary"]}}},
]


# Background helpers (spawn_agent) get a headless subset — nothing that
# touches the screen, the browser, or the user. They also can't spawn, so
# delegation never nests deeper than one level.
SUBAGENT_TOOL_NAMES = {"web_search", "fetch_url", "run_command",
                       "send_file", "task_complete"}
SUBAGENT_TOOLS = [t for t in TOOLS
                  if t["function"]["name"] in SUBAGENT_TOOL_NAMES]


def _resolve_path(path_str: str) -> Path | str:
    """Resolve a model-supplied path against the desktop home dir."""
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = HOME_DIR / p
    try:
        p = p.resolve(strict=True)
    except OSError:
        return f"no such file: {path_str}"
    if not p.is_file():
        return f"not a regular file: {p}"
    return p


def save_attachments(files) -> tuple[list[dict], str | None]:
    """Decode client attachments and write them under ~/uploads.

    Returns (saved, error). Each saved entry: {name, size, mime, path, b64};
    on error nothing is delivered and the caller rejects the whole message so
    the client keeps its draft.
    """
    if not isinstance(files, list):
        return [], "bad attachments payload"
    if len(files) > MAX_ATTACHMENTS:
        return [], f"too many attachments — {MAX_ATTACHMENTS} max"
    try:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return [], f"upload dir unavailable: {e}"
    saved = []
    total = 0
    for f in files or []:
        if not isinstance(f, dict):
            return [], "bad attachments payload"
        name = Path(str(f.get("name") or "file")).name.lstrip(".") or "file"
        try:
            raw = base64.b64decode(str(f.get("data") or ""), validate=True)
        except Exception:
            return [], f"could not decode attachment “{name}”"
        total += len(raw)
        if len(raw) > SEND_FILE_MAX_BYTES:
            return [], (f"“{name}” is over the "
                        f"{SEND_FILE_MAX_BYTES // int(1e6)} MB limit")
        if total > ATTACH_TOTAL_MAX_BYTES:
            return [], ("attachments total over the "
                        f"{ATTACH_TOTAL_MAX_BYTES // int(1e6)} MB limit")
        p = UPLOAD_DIR / name
        stem, suffix = p.stem, p.suffix
        n = 1
        while p.exists():
            p = UPLOAD_DIR / f"{stem}-{n}{suffix}"
            n += 1
        try:
            p.write_bytes(raw)
        except OSError as e:
            return [], f"could not save “{name}”: {e}"
        state.delivered[str(p.resolve())] = p.stat().st_mtime
        saved.append({
            "name": p.name, "size": len(raw), "path": str(p),
            "mime": str(f.get("mime") or
                        mimetypes.guess_type(p.name)[0] or
                        "application/octet-stream"),
            "b64": base64.b64encode(raw).decode()})
    return saved, None


def attach_note(saved: list[dict]) -> str:
    """Tell the model where its attachments landed on the desktop."""
    listing = "\n".join(f"- {f['path']} ({f['size']} bytes)" for f in saved)
    return f"[attached files, saved on the desktop:\n{listing}]"


def event_files(saved: list[dict]) -> list[dict]:
    """File metadata for the transcript event (no payload — the file itself
    already lives on the device)."""
    return [{"name": f["name"], "size": f["size"], "mime": f["mime"]}
            for f in saved]


async def send_file(path_str: str, note: str = "") -> str:
    p = _resolve_path(path_str or "")
    if isinstance(p, str):
        return p
    size = p.stat().st_size
    if size > SEND_FILE_MAX_BYTES:
        return (f"file is {size / 1e6:.1f} MB — over the "
                f"{SEND_FILE_MAX_BYTES // int(1e6)} MB send limit; compress it "
                "or share a smaller artifact")
    await broadcast({
        "type": "file", "name": p.name, "size": size,
        "mime": mimetypes.guess_type(p.name)[0] or "application/octet-stream",
        "note": note, "data": base64.b64encode(p.read_bytes()).decode()})
    state.sent_files[str(p)] = p.stat().st_mtime
    return f"sent {p.name} ({size} bytes) to the user"


async def send_image(path_str: str | None, caption: str = "") -> str:
    if path_str:
        p = _resolve_path(path_str)
        if isinstance(p, str):
            return p
        mime = mimetypes.guess_type(p.name)[0] or ""
        if not mime.startswith("image/"):
            return f"{p.name} is not an image — use send_file instead"
        if p.stat().st_size > SEND_FILE_MAX_BYTES:
            return f"image over the {SEND_FILE_MAX_BYTES // int(1e6)} MB send limit"
        b64, name = base64.b64encode(p.read_bytes()).decode(), p.name
    else:
        b64, _ = capture_frame()
        mime, name = "image/jpeg", "screenshot.jpg"
    await broadcast({"type": "image", "name": name, "caption": caption,
                     "mime": mime, "data": b64})
    return "image sent to the user"


async def ask_user(question: str) -> str:
    loop = asyncio.get_running_loop()
    state.pending_answer = loop.create_future()
    await broadcast({"type": "question", "text": question})
    await push_status()
    try:
        return await asyncio.wait_for(state.pending_answer, ASK_USER_TIMEOUT)
    except asyncio.TimeoutError:
        return "(no reply from user — proceed with best judgment or end the task)"
    finally:
        state.pending_answer = None
        await push_status()


def unsent_outputs() -> list[Path]:
    """Files changed since the run started that were never sent back — the
    backstop for "agent saved a file but only told the user the path".
    Uploads are scanned recursively; home, Desktop and Downloads only
    shallowly so caches and app dirs don't count. Hidden names are skipped.
    """
    if not state.run_start:
        return []
    seen, out = set(), []
    for root, deep in ((UPLOAD_DIR, True), (HOME_DIR, False),
                     (HOME_DIR / "Desktop", False),
                     (HOME_DIR / "Downloads", False)):
        if not root.is_dir():
            continue
        try:
            paths = list(root.rglob("*")) if deep else list(root.iterdir())
        except OSError:
            continue
        for p in paths:
            if any(part.startswith(".")
                   for part in p.relative_to(root).parts):
                continue
            try:
                rp = p.resolve()
                if not rp.is_file():
                    continue
                mtime = rp.stat().st_mtime
            except OSError:
                continue
            key = str(rp)
            baseline = max(state.run_start, state.delivered.get(key, 0))
            if (key in seen or mtime <= baseline
                    or state.sent_files.get(key, 0) >= mtime):
                continue
            seen.add(key)
            out.append(rp)
    return sorted(out)


_TODO_MARKS = {"done": "☑", "in_progress": "◐", "pending": "☐"}


def render_todos(items: list[dict]) -> str:
    return "\n".join(f"{_TODO_MARKS.get(i['status'], '☐')} {i['content']}"
                     for i in items)


async def update_todos(raw_items) -> str:
    """Replace the running conversation's checklist — persisted next to the
    context and pushed to clients as a live card (not a transcript event:
    the card only ever shows latest state, and replayed updates would spam
    history)."""
    items = []
    for it in (raw_items if isinstance(raw_items, list) else []):
        if not isinstance(it, dict):
            continue
        content = str(it.get("content") or "").strip()
        if not content:
            continue
        status = str(it.get("status") or "pending").lower()
        if status == "completed":
            status = "done"
        if status not in _TODO_MARKS:
            status = "pending"
        items.append({"content": content[:200], "status": status})
    state.todos = items[:TODO_MAX_ITEMS]
    state.steps_since_todo = 0
    if state.conversation_id:
        conv_save_todos(state.conversation_id, state.todos)
    await broadcast({"type": "todos",
                     "conversation_id": state.conversation_id,
                     "items": state.todos})
    return ("checklist updated:\n"
            + (render_todos(state.todos) or "(empty — all steps done?)"))


async def execute_tool(name: str, args: dict,
                       agent: str | None = None) -> tuple[list | str, bool]:
    """Return (tool_result_content, task_done). `agent` set = the caller is a
    restricted agent — a background helper (headless SUBAGENT_TOOL_NAMES) or
    the cleanup janitor (desktop-only JANITOR_TOOL_NAMES)."""
    if agent is not None:
        allowed = (JANITOR_TOOL_NAMES if agent == JANITOR_NAME
                   else SUBAGENT_TOOL_NAMES)
        if name not in allowed:
            return f"{name} isn't available to the {agent} agent", False
    try:
        if name == "screenshot":
            return [{"type": "text", "text": "captured screenshot"},
                    screenshot_block(force=True)], False
        if name == "wait":
            secs = max(0.1, min(float(args.get("seconds") or 1), 60))
            slept = 0.0
            while slept < secs and not state.stop:
                step = min(0.25, secs - slept)
                await asyncio.sleep(step)
                slept += step
            result = f"waited {slept:.1f}s"
        elif name == "left_click":
            x, y, pos = _pos(args); pyautogui.click(x, y)
            result = f"left-clicked {pos}"
        elif name == "right_click":
            x, y, pos = _pos(args); pyautogui.click(x, y, button="right")
            result = f"right-clicked {pos}"
        elif name == "middle_click":
            x, y, pos = _pos(args); pyautogui.click(x, y, button="middle")
            result = f"middle-clicked {pos}"
        elif name == "double_click":
            x, y, pos = _pos(args); pyautogui.doubleClick(x, y)
            result = f"double-clicked {pos}"
        elif name == "mouse_move":
            x, y, pos = _pos(args); pyautogui.moveTo(x, y)
            result = f"moved to {pos}"
        elif name == "scroll":
            if args.get("coordinate"):
                x, y, _ = _pos(args); pyautogui.moveTo(x, y)
            clicks = int(args.get("amount") or 3)
            direction = args.get("direction", "down")
            if direction in ("up", "down"):
                pyautogui.scroll(clicks if direction == "up" else -clicks)
            else:
                pyautogui.hscroll(clicks if direction == "right" else -clicks)
            result = f"scrolled {direction} {clicks}"
        elif name == "type_text":
            result = type_text(str(args.get("text", "")))
            warn = _unfocused_warning()
            if warn:
                result = _note(result, warn)
        elif name == "key":
            result = press_keys(str(args.get("keys", "")))
            warn = _unfocused_warning()
            if warn:
                result = _note(result, warn)
        elif name == "run_command":
            # to_thread keeps a long command from freezing the event loop —
            # matters now that helper agents share it with the main loop.
            result = await asyncio.to_thread(
                run_command, str(args.get("command", "")),
                agent is not None)
        elif name == "web_search":
            result = await web_search(str(args.get("query", "")),
                                      int(args.get("max_results") or 8))
        elif name == "fetch_url":
            result = await fetch_url(str(args.get("url", "")),
                                     int(args.get("max_chars") or 6000))
        elif name == "browser_navigate":
            result = await browser_navigate(str(args.get("url", "")))
        elif name == "browser_dom":
            result = await browser_dom()
        elif name == "browser_text":
            result = await browser_text()
        elif name == "browser_click":
            result = await browser_click(int(args.get("ref", 0)))
        elif name == "browser_type":
            result = await browser_type(int(args.get("ref", 0)),
                                        str(args.get("text", "")))
        elif name == "browser_eval":
            result = await browser_eval(str(args.get("expression", "")))
        elif name == "open_url":
            result = await open_url(str(args.get("url", "")))
        elif name == "list_windows":
            result = list_windows()
        elif name == "focus_window":
            result = focus_window(str(args.get("match", "")))
        elif name == "send_message":
            text = str(args.get("text", "")).strip()
            if not text:
                return "empty message — nothing sent", False
            await broadcast({"type": "agent_msg", "text": text})
            result = "message sent to the user"
        elif name == "send_file":
            result = await send_file(str(args.get("path", "")),
                                     str(args.get("note", "")))
        elif name == "send_image":
            result = await send_image(args.get("path"),
                                      str(args.get("caption", "")))
        elif name == "spawn_agent":
            result = spawn_agent(str(args.get("task", "")),
                                 str(args.get("name", "")),
                                 str(args.get("model", "")))
        elif name == "collect_agent":
            result = await collect_agent(str(args.get("name", "")))
        elif name == "ask_user":
            return await ask_user(str(args.get("question", ""))), False
        elif name == "share_plan":
            plan = str(args.get("plan", "")).strip()
            if not plan:
                return "empty plan — nothing shared", False
            await broadcast({"type": "plan", "text": plan})
            result = ("plan shared with the user — now execute it; keep "
                      "progress current via update_todos")
        elif name == "update_todos":
            result = await update_todos(args.get("items"))
        elif name == "task_complete":
            unsent = unsent_outputs() if agent is None else []
            if unsent and not state.output_nudge_done:
                state.output_nudge_done = True
                listing = "\n".join(f"- {p}" for p in unsent[:10])
                return (f"files changed during this task but were never "
                        f"sent to the user:\n{listing}\nThe user can't "
                        f"browse this filesystem — send_file any they need, "
                        f"then call task_complete again; or call it again "
                        f"now if none of these are deliverables"), False
            return str(args.get("summary", "done")), True
        else:
            return f"unknown tool: {name}", False
    except Exception as e:
        return f"{name} failed: {e}", False

    # A fresh screenshot is attached once per turn by agent_loop (deduped on
    # unchanged frames) — not per tool call.
    return result, False


# ── Agent loop ───────────────────────────────────────────────────────────────

def assistant_to_dict(msg: dict) -> dict:
    out = {"role": "assistant", "content": msg.get("content")}
    if msg.get("tool_calls"):
        out["tool_calls"] = msg["tool_calls"]
    return out


def prune_images(messages: list, keep: int = SCREENSHOT_HISTORY) -> None:
    """Replace all but the newest `keep` screenshots with text placeholders.

    Without this the transcript carries every frame ever taken and each
    request re-pays for all of them — input cost grows quadratically with the
    step count, and stale frames actively confuse the model. The text action
    log stays intact, so the narrative is preserved; the model can call
    screenshot anytime for a fresh look.
    """
    seen = 0
    for msg in reversed(messages):
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in reversed(content):
            if block.get("type") != "image_url":
                continue
            seen += 1
            if seen > keep:
                block.clear()
                block.update({"type": "text",
                              "text": "[earlier image omitted]"})


def cache_friendly(model: str | None = None) -> bool:
    """Only Anthropic-family models understand cache_control — for everyone
    else LiteLLM may forward it and the provider may reject the request."""
    m = (model or state.model).lower()
    return "claude" in m or "anthropic" in m


def apply_cache_control(messages: list) -> None:
    """Mark the system prompt + the newest message as cache breakpoints.

    Anthropic bills cached prefixes at ~10%, so with the breakpoint riding the
    tail each step pays full input price only for the newest messages and the
    recent screenshots — the whole prior history comes back as cache reads.
    """
    sysmsg = messages[0]
    if isinstance(sysmsg.get("content"), str):
        sysmsg["content"] = [{"type": "text", "text": sysmsg["content"],
                              "cache_control": {"type": "ephemeral"}}]
    for msg in messages[1:]:
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                block.pop("cache_control", None)
    last = messages[-1]
    content = last.get("content")
    if isinstance(content, str):
        last["content"] = [{"type": "text", "text": content,
                            "cache_control": {"type": "ephemeral"}}]
    elif isinstance(content, list) and content:
        content[-1]["cache_control"] = {"type": "ephemeral"}


def _note(content, text: str):
    """Append a text note to tool-result content (str or block list)."""
    if isinstance(content, str):
        return content + "\n" + text
    for block in content:
        if block.get("type") == "text":
            block["text"] += "\n" + text
            return content
    content.append({"type": "text", "text": text})
    return content


def _unstick_note(reason: str) -> str:
    """Directive injected when the agent is looping without progress.

    Rather than asking the user, push the model to brainstorm alternatives
    and try a different approach. Only a human-only blocker (credentials,
    2FA, CAPTCHA, a decision) justifies ask_user.
    """
    return (f"STUCK: {reason}. Do not keep doing the same thing. Before your "
            "next tool call, brainstorm at least 5 fundamentally different "
            "ways to reach your goal — different tools, keyboard vs mouse, "
            "menus, run_command, browser_* tools, another app entirely, "
            "reading docs or --help output — then try the most promising one "
            "you haven't tried. Keep generating new approaches — never give "
            "up. Only call ask_user if you're blocked on something only a "
            "human can provide.")


STUCK_ASK_USER = ("I've brainstormed and tried several different approaches "
                  "and I'm still stuck. Any guidance?")


async def llm_request(http: httpx.AsyncClient, messages: list,
                      model: str | None = None,
                      tools: list | None = None) -> httpx.Response:
    """One chat-completion call with retry on transient failures.

    A single 429/5xx mid-task used to kill the run and waste all prior spend.
    Retries with backoff; non-retryable 4xx propagates immediately.
    """
    payload = {"model": model or state.model, "messages": messages,
               "tools": tools if tools is not None else TOOLS}
    if not payload["tools"]:
        del payload["tools"]  # no tools wanted (compaction) — an empty
                              # array is rejected by some providers
    delay, last_exc = 2.0, None
    for attempt in range(LLM_MAX_RETRIES):
        try:
            r = await http.post(
                f"{LITELLM_URL}/v1/chat/completions",
                headers={"Authorization": f"Bearer {state.litellm_key}"},
                json=payload)
            r.raise_for_status()
            return r
        except httpx.HTTPStatusError as e:
            last_exc = e
            code = e.response.status_code
            if code not in (408, 409, 429) and code < 500:
                raise
        except httpx.TransportError as e:
            last_exc = e
        if attempt + 1 < LLM_MAX_RETRIES:
            await broadcast({"type": "agent_msg",
                             "text": f"(model request failed, retrying in "
                                     f"{delay:.0f}s: {last_exc})"})
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("llm_request exhausted retries without a response")


# ── Context compaction ─────────────────────────────────────────────────────
# Long runs would otherwise grow the context array until the provider
# rejects the request. When the last response's prompt_tokens approach the
# model's window, one extra call summarizes the history into a handoff note
# and the loop continues on [system, handoff + checklist, recent tail].

COMPACT_PROMPT = """Summarize this conversation so far as a handoff note to yourself — the older messages are about to be dropped from context.

Cover, compactly:
1. Goal — the user's task, in one or two sentences.
2. Progress — what's done, what worked, what's left.
3. Key facts — file paths, URLs, names, values, decisions: anything the remaining steps still need.
4. Screen state — what's open / running right now.
5. Next — the immediate next action.

Be terse but complete: this note plus the last few messages are all you keep."""

# Summarizer input cap — the compact call itself must fit the window even
# when history is already past it, so the middle of a huge history is cut.
COMPACT_INPUT_MAX_CHARS = int(
    os.environ.get("AGENT_COMPACT_INPUT_CHARS", "400000"))


async def model_context_limit(http: httpx.AsyncClient) -> int:
    """max_input_tokens for the active model, cached per model name; falls
    back to AGENT_CONTEXT_LIMIT when LiteLLM reports nothing."""
    cached = state.ctx_limit.get(state.model)
    if cached:
        return cached
    try:
        r = await http.get(
            f"{LITELLM_URL}/model/info",
            headers={"Authorization": f"Bearer {state.litellm_key}"})
        data = r.json()
        items = data.get("data", []) if isinstance(data, dict) else data
        for m in items:
            if m.get("model_name") == state.model:
                info = m.get("model_info") or {}
                lim = info.get("max_input_tokens") or info.get("max_tokens")
                if lim:
                    state.ctx_limit[state.model] = int(lim)
                    return int(lim)
    except Exception:
        pass
    return COMPACT_CONTEXT_LIMIT


def _text_only(messages: list) -> list[dict]:
    """Copy of messages with image blocks replaced by markers — the
    summarizer call is text-only."""
    out = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            content = [{"type": "text",
                        "text": "[screenshot]"
                        if b.get("type") == "image_url"
                        else str(b.get("text", ""))}
                       for b in content]
        out.append({**msg, "content": content})
    return out


def _msg_size(msg: dict) -> int:
    return len(json.dumps(msg, default=str))


async def compact_context(http: httpx.AsyncClient, conv_id: str,
                          messages: list) -> bool:
    """Summarize older history into a handoff note and rebuild `messages`
    in place as [system, handoff + checklist, recent tail].

    Returns False with `messages` untouched when summarization fails — the
    run just continues on the full history.
    """
    view = _text_only(messages[1:])
    total = sum(_msg_size(m) for m in view)
    if total > COMPACT_INPUT_MAX_CHARS and len(view) > 4:
        tail, acc = [], 0
        for m in reversed(view[1:]):
            acc += _msg_size(m)
            if acc > COMPACT_INPUT_MAX_CHARS:
                break
            tail.insert(0, m)
        view = [view[0],
                {"role": "user",
                 "content": "[... middle of the history omitted ...]"},
                *tail]
    try:
        r = await llm_request(
            http, view + [{"role": "user", "content": COMPACT_PROMPT}],
            tools=[])
    except Exception as e:
        await broadcast({"type": "error",
                         "text": f"context compaction failed: {e}"})
        return False
    usd, tin, tout = track_cost(r)
    if usd or tin or tout:
        conv_add_usage(conv_id, usd, tin, tout)
    await push_cost()
    summary = r.json()["choices"][0]["message"].get("content") or ""
    if not isinstance(summary, str):
        summary = " ".join(str(b.get("text", "")) for b in summary
                           if isinstance(b, dict))
    summary = summary.strip()
    if not summary:
        return False
    # Keep the freshest few messages — never messages[0] (the system
    # prompt), drop leading tool orphans, then let sanitize_context repair
    # a tool-call pair cut at the boundary.
    tail = messages[max(1, len(messages) - COMPACT_KEEP):]
    while tail and tail[0].get("role") == "tool":
        tail = tail[1:]
    dropped = len(messages) - 1 - len(tail)
    handoff = ("[The earlier conversation was compacted into this handoff "
               "summary; the messages after it are the recent tail.]\n\n"
               + summary)
    if state.todos:
        handoff += "\n\nCurrent checklist:\n" + render_todos(state.todos)
    messages[1:] = [{"role": "user", "content": handoff}, *tail]
    sanitize_context(messages)
    state.steps_since_compact = 0
    await asyncio.to_thread(conv_save_context, conv_id, messages)
    await broadcast({"type": "compact",
                     "text": f"context compacted — {dropped} older messages "
                             "summarized into a handoff note"})
    return True


# Provider error bodies for a blown context window vary — match the usual
# phrasings so an overflow 400 triggers compaction instead of killing the
# run (the ratio trigger normally fires first; this catches unknown-window
# models and single huge tool results).
_OVERFLOW_RE = re.compile(
    r"context|too many tokens|maximum.{0,20}length|token.{0,12}limit|"
    r"prompt is too long|reduce the length", re.I)


def is_context_overflow(e: httpx.HTTPError) -> bool:
    resp = getattr(e, "response", None)
    if resp is None or resp.status_code not in (400, 413):
        return False
    return bool(_OVERFLOW_RE.search(resp.text or ""))


# ── Subagents ─────────────────────────────────────────────────────────────
# spawn_agent runs a helper loop in the background — headless tools only, so
# parallel helpers can't fight over the screen, the browser or the user.
# Reports reach the parent two ways: auto-injected as a user message at the
# top of the next agent_loop step (subagent_inbox), or pulled on demand via
# collect_agent. `delivered` dedupes the two paths; `conv` scopes injection
# to the conversation that spawned the helper.

def _subagent_name(name: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")[:24]


def agents_status() -> str:
    if not state.subagents:
        return "no helpers yet"
    return "helpers: " + ", ".join(
        f"{n} ({e['status']})" for n, e in state.subagents.items())


def subagent_report(name: str, e: dict) -> str:
    return (f"[subagent '{name}' {e['status']} — {e.get('steps', 0)} steps, "
            f"${e.get('usd', 0):.4f}]\n{e.get('result') or '(no report)'}")


def spawn_agent(task: str, name: str = "", model: str = "") -> str:
    task = task.strip()
    if not task:
        return "empty task — nothing spawned"
    # GC: drop finished entries whose report already reached the parent.
    for n in [n for n, e in state.subagents.items()
              if e["status"] != "running" and e.get("delivered")]:
        del state.subagents[n]
    running = [n for n, e in state.subagents.items()
               if e["status"] == "running"]
    if len(running) >= SUBAGENT_MAX_CONCURRENT:
        return (f"at the helper cap ({SUBAGENT_MAX_CONCURRENT}) — running: "
                + ", ".join(running)
                + ". collect_agent or keep working until one reports.")
    name = _subagent_name(name)
    if name and state.subagents.get(name, {}).get("status") == "running":
        return f"'{name}' is already running — pick another name"
    if not name:
        n = 1
        while f"agent-{n}" in state.subagents:
            n += 1
        name = f"agent-{n}"
    model = model.strip() or SUBAGENT_MODEL or state.model
    entry = {"name": name, "desc": task[:200], "conv": state.conversation_id,
             "status": "running", "result": None, "model": model,
             "usd": 0.0, "steps": 0, "delivered": False}
    entry["task"] = asyncio.create_task(
        subagent_loop(name, task, model, entry))
    state.subagents[name] = entry
    return (f"spawned '{name}' (model {model}) — it works in the background; "
            "its report arrives as a message. collect_agent(name) blocks "
            "for it. Share artifacts through files under ~.")


async def collect_agent(name: str = "") -> str:
    """Wait for a helper's report. No name = the next one to finish."""
    name = _subagent_name(name)
    if name:
        e = state.subagents.get(name)
        if e is None:
            return f"no helper '{name}' — {agents_status()}"
        while e["status"] == "running" and not state.stop:
            await asyncio.sleep(0.3)
        e["delivered"] = True
        return subagent_report(name, e)
    while not state.stop:
        done = [(n, e) for n, e in state.subagents.items()
                if e["status"] != "running" and not e.get("delivered")]
        if done:
            n, e = done[0]
            e["delivered"] = True
            return subagent_report(n, e)
        if not any(e["status"] == "running"
                   for e in state.subagents.values()):
            return f"nothing to collect — {agents_status()}"
        await asyncio.sleep(0.4)
    return "(stopped)"


async def subagent_loop(name: str, task_text: str, model: str,
                        entry: dict) -> None:
    """Headless helper loop: text tools only, own step cap and model. The
    final report queues for injection into the parent conversation."""
    conv_id = entry["conv"]
    usd0 = state.session_usd
    messages = [
        {"role": "system", "content": SUBAGENT_PROMPT.format(
            home=HOME_DIR, name=name)},
        {"role": "user", "content": task_text}]
    status, result = "done", "(ended without a report)"
    await broadcast({"type": "subagent", "name": name, "state": "running",
                     "model": model, "task": task_text[:300]})
    try:
        async with httpx.AsyncClient(
                timeout=httpx.Timeout(300, connect=30)) as http:
            for step in range(SUBAGENT_MAX_STEPS):
                if state.stop:
                    status, result = "stopped", "(stopped by user)"
                    break
                entry["steps"] = step + 1
                if cache_friendly(model):
                    apply_cache_control(messages)
                try:
                    r = await llm_request(http, messages, model=model,
                                          tools=SUBAGENT_TOOLS)
                except httpx.HTTPError as e:
                    body = getattr(e.response, "text", "") \
                        if hasattr(e, "response") else ""
                    status, result = "error", \
                        f"model request failed: {e} {body[:300]}"
                    break
                usd, tin, tout = track_cost(r)
                if conv_id and (usd or tin or tout):
                    conv_add_usage(conv_id, usd, tin, tout)
                await push_cost()

                msg = r.json()["choices"][0]["message"]
                messages.append(assistant_to_dict(msg))
                reply = msg.get("content") or ""
                if not isinstance(reply, str):
                    reply = " ".join(str(b.get("text", "")) for b in reply
                                     if isinstance(b, dict))
                reply = reply.strip()
                if reply:
                    await broadcast({"type": "thought", "text": reply,
                                     "agent": name})
                tool_calls = msg.get("tool_calls") or []
                if not tool_calls:
                    # A plain reply IS the report — no idle nudges here.
                    result = reply or result
                    break
                finished = False
                for tc in tool_calls:
                    if state.stop:
                        break
                    fn = tc.get("function") or {}
                    tname = fn.get("name", "")
                    try:
                        targs = json.loads(fn.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        targs = {}
                    await broadcast({"type": "action", "tool": tname,
                                     "args": targs, "agent": name})
                    res, fin = await execute_tool(tname, targs, agent=name)
                    messages.append({"role": "tool",
                                     "tool_call_id": tc.get("id"),
                                     "content": res})
                    prev = res if isinstance(res, str) else next(
                        (b.get("text", "") for b in res
                         if b.get("type") == "text"), "")
                    await broadcast({"type": "action_result", "tool": tname,
                                     "result": prev.strip()[:500],
                                     "agent": name})
                    if fin:  # task_complete — the summary is the report
                        result = res if isinstance(res, str) else prev
                        finished = True
                        break
                if finished:
                    break
            else:
                result = f"{result} (hit the {SUBAGENT_MAX_STEPS}-step cap)"
    except asyncio.CancelledError:
        status, result = "stopped", "(stopped)"
    except Exception as e:
        status, result = "error", f"helper error: {e}"
    entry["usd"] = round(state.session_usd - usd0, 6)
    entry.update(status=status, result=result)
    # Even a stopped helper's report is queued — if the run was stopped the
    # drained-on-resume message tells the parent the helper died with it.
    state.subagent_inbox.append(entry)
    await broadcast({"type": "subagent", "name": name, "state": status,
                     "result": str(result)[:600], "usd": entry["usd"]})


def drain_subagent_inbox(conv_id: str, messages: list) -> None:
    """Deliver finished helper reports into the run's context as user
    messages — scoped to the conversation that spawned them, so a helper of
    another conversation stays queued until that conv next runs."""
    kept = []
    while state.subagent_inbox:
        e = state.subagent_inbox.popleft()
        if e.get("delivered"):
            continue
        if e.get("conv") != conv_id:
            kept.append(e)
            continue
        e["delivered"] = True
        messages.append({"role": "user",
                         "content": subagent_report(e["name"], e)})
    state.subagent_inbox.extend(kept)


# ── Run cleanup ──────────────────────────────────────────────────────────────
# End-of-run teardown — daemon-driven, never model-invoked. First a
# deterministic sweep of whatever the run created: browser tabs (CDP target
# diff), windows (wmctrl id diff) and processes (pid+starttime diff), plus a
# wipe of ~/scratch. Then a bounded janitor LLM pass with a fresh context
# cleans up residue the sweep can't enumerate (modal dialogs, wedged apps).
# Cookies and logins persist — tabs are closed, the profile is never touched.
# The baseline is persisted at run start so a daemon restart mid-run still
# lets the next boot sweep that run's leftovers.

def _snapshot_procs() -> dict[str, str]:
    """pid -> starttime for every process. Starttime (jiffies since boot)
    disambiguates PID reuse: same pid + different starttime = new process."""
    out = {}
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return out  # no procfs (bare-metal dev) — nothing to diff
    for p in entries:
        if not p.name.isdigit():
            continue
        try:
            out[p.name] = \
                (p / "stat").read_text().rsplit(")", 1)[1].split()[19]
        except (OSError, IndexError):
            continue
    return out


def _snapshot_windows() -> list[str]:
    try:
        p = subprocess.run(["wmctrl", "-l"], capture_output=True, text=True,
                           timeout=10)
    except (OSError, subprocess.SubprocessError):
        return []
    return [ln.split(None, 1)[0] for ln in p.stdout.splitlines()
            if ln.strip()]


def _snapshot_tabs() -> list[str]:
    try:
        r = httpx.get(f"{CDP_HTTP}/json", timeout=5)
        return [t["id"] for t in r.json() if t.get("type") == "page"]
    except Exception:
        return []


def _boot_key() -> str:
    """Starttime of pid 1 — changes when the container/host reboots, so a
    persisted baseline can tell "the daemon restarted" (same boot: sweep the
    dead run's leftovers) from "the whole desktop restarted" (every process
    is new — the baseline is meaningless and sweeping it would kill Xvfb,
    websockify, the panels…)."""
    try:
        return Path("/proc/1/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return ""


def capture_baseline() -> dict:
    try:
        SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return {"started": time.time(), "boot": _boot_key(),
            "pids": _snapshot_procs(),
            "windows": _snapshot_windows(),
            "tabs": _snapshot_tabs()}


def _persist_baseline(b: dict | None) -> None:
    try:
        if b is None:
            RUN_STATE_FILE.unlink(missing_ok=True)
        else:
            RUN_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            RUN_STATE_FILE.write_text(json.dumps(b))
    except OSError:
        pass


def sweep_desktop(baseline: dict) -> dict:
    """Close tabs/windows and kill processes created since baseline — never
    anything that predates the run. Returns counts."""
    stats = {"tabs": 0, "windows": 0, "procs": 0, "scratch": 0}

    # Closing a tab never logs anyone out — cookies live in the profile.
    old_tabs = set(baseline.get("tabs") or [])
    try:
        cur = {t["id"] for t in
               httpx.get(f"{CDP_HTTP}/json", timeout=5).json()
               if t.get("type") == "page"}
        for tid in cur - old_tabs:
            try:
                httpx.get(f"{CDP_HTTP}/json/close/{tid}", timeout=5)
                stats["tabs"] += 1
            except httpx.HTTPError:
                pass
    except Exception:
        pass

    # Graceful close so apps shut down clean (no soffice recovery prompt).
    for wid in set(_snapshot_windows()) - set(baseline.get("windows") or []):
        subprocess.run(["wmctrl", "-i", "-c", wid],
                       check=False, capture_output=True)
        stats["windows"] += 1
    if stats["windows"]:
        time.sleep(1.5)  # let apps quit before the process sweep

    # Whatever's still alive that wasn't at baseline — backgrounded shells,
    # GUI apps, timed-out commands. TERM, then KILL the stubborn.
    old_pids = baseline.get("pids") or {}
    me = str(os.getpid())

    def new_procs() -> list[int]:
        return [int(p) for p, s in _snapshot_procs().items()
                if old_pids.get(p) != s and p != me]

    for pid in new_procs():
        try:
            os.kill(pid, signal.SIGTERM)
            stats["procs"] += 1
        except OSError:
            pass
    if stats["procs"]:
        time.sleep(1.0)
        for pid in new_procs():
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    if SCRATCH_DIR.is_dir():
        for child in SCRATCH_DIR.iterdir():
            try:
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
                stats["scratch"] += 1
            except OSError:
                pass
    return stats


# The janitor gets desktop tools only — no run_command (too broad for an
# unsupervised pass), no browser_* (tabs were just closed), no ask_user
# (cleanup must never block) and no send_* (the wrap-up already went out).
JANITOR_NAME = "janitor"
JANITOR_TOOL_NAMES = {
    "screenshot", "wait", "list_windows", "focus_window", "left_click",
    "right_click", "double_click", "mouse_move", "scroll", "type_text",
    "key", "task_complete",
}
JANITOR_TOOLS = [t for t in TOOLS
                 if t["function"]["name"] in JANITOR_TOOL_NAMES]

JANITOR_PROMPT = """You are the cleanup pass on a Gut Linux desktop ({res}). \
The task that was running just ended; an automatic sweep already closed the \
apps, windows and browser tabs it tracked. Look at the screen and the window \
list — if something the task left behind is still open (dialogs, save or \
discard prompts, stray windows), close it. Escape or alt-F4 for dialogs.

Rules:
- Discard unsaved work when asked — deliverables were already sent to the user.
- Never delete files, clear browser data, or log out of anything.
- Leave the panels, wallpaper and desktop icons alone.
- When nothing is left to close — or nothing needed closing — call \
task_complete with a one-line summary of what you closed.
"""


async def janitor_pass(conv_id: str) -> str:
    """Bounded post-sweep tidy with a fresh context — its chatter never
    touches the conversation's model context."""
    try:
        res = "%dx%d" % tuple(pyautogui.size())
    except Exception:
        res = RESOLUTION
    wins = await asyncio.to_thread(list_windows)
    content = [{"type": "text", "text":
                f"Open windows:\n{wins}\n\nClose whatever is left, then call "
                "task_complete."}]
    try:
        shot = screenshot_block(force=True)
    except Exception:
        shot = None
    if shot:
        content.append(shot)
    messages = [
        {"role": "system", "content": JANITOR_PROMPT.format(res=res)},
        {"role": "user", "content": content}]
    try:
        async with httpx.AsyncClient(
                timeout=httpx.Timeout(300, connect=30)) as http:
            for _ in range(JANITOR_MAX_STEPS):
                if state.stop:
                    return "(stopped)"
                prune_images(messages)
                if cache_friendly():
                    apply_cache_control(messages)
                try:
                    r = await llm_request(http, messages,
                                          tools=JANITOR_TOOLS)
                except httpx.HTTPError as e:
                    return f"model request failed: {e}"
                usd, tin, tout = track_cost(r)
                if conv_id and (usd or tin or tout):
                    conv_add_usage(conv_id, usd, tin, tout)
                await push_cost()

                msg = r.json()["choices"][0]["message"]
                messages.append(assistant_to_dict(msg))
                tool_calls = msg.get("tool_calls") or []
                if not tool_calls:
                    reply = msg.get("content") or ""
                    if not isinstance(reply, str):
                        reply = " ".join(
                            str(b.get("text", "")) for b in reply
                            if isinstance(b, dict))
                    return reply.strip()[:300] or "done"
                acted = False
                for tc in tool_calls:
                    if state.stop:
                        return "(stopped)"
                    fn = tc.get("function") or {}
                    tname = fn.get("name", "")
                    try:
                        targs = json.loads(fn.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        targs = {}
                    await broadcast({"type": "action", "tool": tname,
                                     "args": targs, "agent": JANITOR_NAME})
                    res2, fin = await execute_tool(tname, targs,
                                                   agent=JANITOR_NAME)
                    acted = acted or tname in SCREEN_TOOLS
                    messages.append({"role": "tool",
                                     "tool_call_id": tc.get("id"),
                                     "content": res2})
                    prev = res2 if isinstance(res2, str) else next(
                        (b.get("text", "") for b in res2
                         if b.get("type") == "text"), "")
                    await broadcast({"type": "action_result", "tool": tname,
                                     "result": prev.strip()[:500],
                                     "agent": JANITOR_NAME})
                    if fin:
                        return str(res2 if isinstance(res2, str)
                                   else prev)[:300]
                if acted:
                    shot = screenshot_block()
                    if shot is not None:
                        t = messages[-1]
                        c = t["content"]
                        if isinstance(c, str):
                            t["content"] = [{"type": "text", "text": c}, shot]
                        elif not any(b.get("type") == "image_url"
                                     for b in c):
                            c.append(shot)
    except Exception as e:
        return f"janitor error: {e}"
    return f"hit the {JANITOR_MAX_STEPS}-step cap"


async def cleanup_after_run(conv_id: str, baseline: dict | None,
                            janitor: bool = True) -> None:
    """Sweep what the run created, then let the janitor handle residue, then
    sweep once more for anything the janitor itself opened."""
    try:
        if not GUT_CLEANUP:
            return
        stats = (await asyncio.to_thread(sweep_desktop, baseline)
                 if baseline else
                 {"tabs": 0, "windows": 0, "procs": 0, "scratch": 0})
        parts = [f"{stats[k]} {label}" for k, label in (
            ("tabs", "tabs"), ("windows", "windows"),
            ("procs", "processes"), ("scratch", "scratch items"))
            if stats[k]]
        report = ""
        if janitor:
            await broadcast({"type": "status", "state": "cleanup",
                             "model": state.model,
                             "conversation_id": conv_id})
            report = await janitor_pass(conv_id)
            if baseline:
                await asyncio.to_thread(sweep_desktop, baseline)
        text = "tidy-up"
        if parts:
            text += ": closed " + ", ".join(parts)
        if report:
            text += f" — janitor: {report}"
        if parts or report:
            await broadcast({"type": "cleanup", "text": text})
    except Exception as e:
        print(f"[gut] cleanup failed: {e}")
    finally:
        _persist_baseline(None)


async def agent_loop(conv_id: str, task_text: str,
                     attachments: list[dict] | None = None) -> None:
    state.stop = False
    state.paused = False
    state.run_start = time.time()
    state.sent_files = {}
    state.output_nudge_done = False
    # Snapshot the desktop before the run touches it — the end-of-run sweep
    # only removes what appears after this point, so user-opened windows and
    # tabs survive. Persisted so a crash mid-run still cleans up at boot.
    baseline = await asyncio.to_thread(capture_baseline)
    if GUT_CLEANUP:
        await asyncio.to_thread(_persist_baseline, baseline)
    await broadcast({"type": "status", "state": "running",
                     "model": state.model, "conversation_id": conv_id})
    # A revisited conversation resumes its own stored context; a fresh one
    # starts from just the system prompt.
    # The client resizes the display to fit its pane, so RESOLUTION (the
    # Xvfb startup size / max) may be stale — report the live screen size.
    try:
        res = "%dx%d" % tuple(pyautogui.size())
    except Exception:
        res = RESOLUTION
    coords = COORD_PROMPT_NORM if coords_normalized() else COORD_PROMPT_PIXEL
    messages = conv_load_context(conv_id) or [
        {"role": "system", "content": SYSTEM_PROMPT.format(
            res=res, cdp=CDP_PORT, coords=coords, home=HOME_DIR,
            subcap=SUBAGENT_MAX_CONCURRENT)}]
    sanitize_context(messages)
    content = [{"type": "text", "text": task_text}]
    # Attached images go inline so the model sees them directly; other files
    # are referenced by path in the task text (attach_note).
    for f in attachments or []:
        if f["mime"].startswith("image/"):
            content.append({"type": "image_url", "image_url": {
                "url": f"data:{f['mime']};base64,{f['b64']}"}})
    content.append(screenshot_block(force=True))
    messages.append({"role": "user", "content": content})
    done = False
    recent_sigs, unchanged_streak, stuck_rescues = deque(maxlen=10), 0, 0
    idle_replies = 0
    state.todos = conv_load_todos(conv_id)
    state.steps_since_todo = 0
    state.steps_since_compact = 99
    last_tin = 0        # prompt_tokens of the last request — compaction signal
    overflow_retries = 0
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=30)) as http:
            for _ in range(MAX_STEPS):
                while state.paused and not state.stop:
                    await asyncio.sleep(0.4)
                if state.stop or done:
                    break

                drain_subagent_inbox(conv_id, messages)

                # Long-horizon: compact history once the last request's
                # billed input approaches the model's context window. The
                # >=3-step gap bounds compaction-call spend if the context
                # stays over the ratio (e.g. one huge tool result).
                state.steps_since_compact += 1
                if last_tin and state.steps_since_compact >= 3:
                    limit = await model_context_limit(http)
                    if last_tin > limit * COMPACT_RATIO:
                        await compact_context(http, conv_id, messages)

                # Stale-checklist nudge on long tasks: applied onto the last
                # tool result so it lands in the same request.
                if state.todos:
                    state.steps_since_todo += 1
                    if (state.steps_since_todo >= TODO_REMIND_STEPS
                            and messages
                            and messages[-1].get("role") == "tool"):
                        state.steps_since_todo = 0
                        messages[-1]["content"] = _note(
                            messages[-1]["content"],
                            f"your checklist hasn't changed in "
                            f"{TODO_REMIND_STEPS} steps — mark progress via "
                            "update_todos")

                prune_images(messages)
                if cache_friendly():
                    apply_cache_control(messages)
                try:
                    r = await llm_request(http, messages)
                except httpx.HTTPError as e:
                    body = getattr(e.response, "text", "") if hasattr(e, "response") else ""
                    # Context-window overflow: compact and retry rather than
                    # killing the run. The ratio check above normally fires
                    # first; this catches unknown-window models and single
                    # tool results big enough to overshoot between checks.
                    if (overflow_retries < 2 and is_context_overflow(e)
                            and await compact_context(http, conv_id,
                                                      messages)):
                        overflow_retries += 1
                        continue
                    await broadcast({"type": "error",
                                     "text": f"LiteLLM request failed: {e} {body[:300]}"})
                    break

                usd, tin, tout = track_cost(r)
                last_tin = tin
                if usd or tin or tout:
                    conv_add_usage(conv_id, usd, tin, tout)
                await push_cost()

                msg = r.json()["choices"][0]["message"]
                messages.append(assistant_to_dict(msg))
                reply_text = ""
                if msg.get("content"):
                    # Model narration goes to the verbose log, not the chat —
                    # the user only hears what the agent deliberately sends.
                    reply_text = msg["content"]
                    if not isinstance(reply_text, str):
                        reply_text = " ".join(
                            str(b.get("text", "")) for b in reply_text
                            if isinstance(b, dict))
                    reply_text = reply_text.strip()
                    if reply_text:
                        await broadcast({"type": "thought",
                                         "text": reply_text})

                tool_calls = msg.get("tool_calls") or []
                if not tool_calls:
                    idle_replies += 1
                    if idle_replies >= IDLE_REPLY_LIMIT:
                        # The model insists on prose instead of calling
                        # task_complete — end the run and deliver its last
                        # reply as the wrap-up so it reaches the user.
                        done = True
                        await broadcast({"type": "done",
                                         "text": (reply_text or "done")[:8000]})
                        break
                    nudge = ("Continue with tool calls, or call task_complete "
                             "when done.") if idle_replies == 1 else (
                        "Plain text doesn't reach the user and doesn't end "
                        "the task. If you're finished, call task_complete now "
                        "with your answer as `summary`; otherwise make your "
                        "next tool call.")
                    messages.append({"role": "user", "content": nudge})
                    continue
                idle_replies = 0

                acted_on_screen = False
                for tc in tool_calls:
                    # Honor takeover/stop between calls, not just between turns.
                    while state.paused and not state.stop:
                        await asyncio.sleep(0.4)
                    if state.stop:
                        break
                    fn = tc.get("function") or {}
                    name = fn.get("name", "")
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    await broadcast({"type": "action", "tool": name, "args": args})
                    result, finished = await execute_tool(name, args)
                    acted_on_screen = acted_on_screen or name in SCREEN_TOOLS

                    # Stall detector: identical tool+args seen several times
                    # in the recent window — catches loops that interleave
                    # other actions between repeats (a strictly-consecutive
                    # counter resets the moment the model does anything else).
                    if name not in ("ask_user", "task_complete"):
                        sig = name + " " + json.dumps(args, sort_keys=True,
                                                      default=str)
                        recent_sigs.append(sig)
                        seen = sum(1 for s in recent_sigs if s == sig)
                        if seen == 3:
                            result = _note(result,
                                "WARNING: you've done this exact action 3 "
                                f"times in your last {len(recent_sigs)} "
                                "steps with no progress — switch tactics now.")
                        elif seen >= 5:
                            result = _note(result, _unstick_note(
                                f"you've repeated this exact action {seen} "
                                "times with no progress"))
                            recent_sigs.clear()
                            stuck_rescues += 1
                            if stuck_rescues >= 3:
                                stuck_rescues = 0
                                answer = await ask_user(STUCK_ASK_USER)
                                result = _note(result,
                                               f"[user replied]: {answer}")

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id"),
                        "content": result,
                    })
                    preview = result if isinstance(result, str) else next(
                        (b.get("text", "") for b in result
                         if b.get("type") == "text"), "")
                    await broadcast({"type": "action_result", "tool": name,
                                     "result": preview.strip()[:500]})
                    if finished:
                        done = True
                        await broadcast({"type": "done",
                                         "text": str(result)[:8000]})
                        break

                # One fresh screenshot per turn on the last tool result —
                # skipped when the frame is byte-identical to the last sent.
                if acted_on_screen and not done and not state.stop:
                    shot = screenshot_block()
                    target = messages[-1]
                    if shot is None:
                        unchanged_streak += 1
                        target["content"] = _note(target["content"],
                                                  "(screen unchanged)")
                        if unchanged_streak == 3:
                            target["content"] = _note(target["content"],
                                "WARNING: the screen has not changed across "
                                "your last 3 actions — they are having no "
                                "effect. Switch tactics.")
                        elif unchanged_streak >= 6:
                            target["content"] = _note(
                                target["content"], _unstick_note(
                                    "the screen has not changed across your "
                                    f"last {unchanged_streak} actions — they "
                                    "are having no effect"))
                            unchanged_streak = 0
                            stuck_rescues += 1
                            if stuck_rescues >= 3:
                                stuck_rescues = 0
                                answer = await ask_user(STUCK_ASK_USER)
                                target["content"] = _note(
                                    target["content"],
                                    f"[user replied]: {answer}")
                    else:
                        unchanged_streak = 0
                        stuck_rescues = 0
                        content = target["content"]
                        if isinstance(content, str):
                            target["content"] = [
                                {"type": "text", "text": content}, shot]
                        elif not any(b.get("type") == "image_url"
                                     for b in content):
                            content.append(shot)
                        # else: last result already carries a frame (e.g. the
                        # turn ended on the screenshot tool) — don't double up.

                # Persist context each step so a follow-up message — or a
                # daemon restart — resumes mid-conversation.
                await asyncio.to_thread(conv_save_context, conv_id, messages)
            else:
                await broadcast({"type": "error",
                                 "text": f"hit step cap ({MAX_STEPS}); stopping"})
    finally:
        await asyncio.to_thread(conv_save_context, conv_id, messages)
        # The sweep runs on every exit path; the janitor only on natural
        # endings — an explicit stop hands the desktop back as-is.
        await cleanup_after_run(conv_id, baseline, janitor=not state.stop)
        await broadcast({"type": "status", "state": "idle",
                         "model": state.model, "conversation_id": None})
        await push_cost()


async def handle_client_msg(ws: WebSocket, msg: dict) -> None:
    mtype = msg.get("type")
    if mtype == "task":
        cid = str(msg.get("conversation_id") or "")
        try:
            meta = _read_meta(cid)
        except ValueError:
            meta = None
        if meta is None:
            await ws.send_text(json.dumps(
                {"type": "error",
                 "text": "no such conversation — create one first"}))
            return
        if state.running:
            # One agent per desktop environment: this device can only work
            # one conversation at a time.
            running = {}
            if state.conversation_id:
                try:
                    running = _read_meta(state.conversation_id) or {}
                except ValueError:
                    pass
            title = running.get("title") or "another conversation"
            await ws.send_text(json.dumps(
                {"type": "error",
                 "text": f"device is busy on “{title}” — stop it first"}))
            return
        text = str(msg.get("text", ""))
        saved, err = save_attachments(msg.get("files") or [])
        if err:
            await ws.send_text(json.dumps({"type": "error", "text": err}))
            return
        if not text.strip() and not saved:
            return
        state.conversation_id = cid
        state.model = str(meta.get("model") or state.model)
        event = {"type": "user", "text": text}
        if saved:
            event["files"] = event_files(saved)
        seq = conv_append_event(cid, event)
        await broadcast({**event, "conversation_id": cid, "seq": seq})
        if saved:
            text = f"{text}\n\n{attach_note(saved)}" if text \
                else attach_note(saved)
        state.task = asyncio.create_task(agent_loop(cid, text, saved))
    elif mtype == "answer":
        if state.pending_answer is not None and not state.pending_answer.done():
            text = str(msg.get("text", ""))
            saved, err = save_attachments(msg.get("files") or [])
            if err:
                await ws.send_text(json.dumps({"type": "error", "text": err}))
                return
            cid = state.conversation_id
            if cid and state.running:
                event = {"type": "user", "text": text}
                if saved:
                    event["files"] = event_files(saved)
                seq = conv_append_event(cid, event)
                await broadcast({**event, "conversation_id": cid, "seq": seq})
            if saved:
                paths = ", ".join(f["path"] for f in saved)
                text = f"{text}\n[attached files: {paths}]" if text \
                    else f"[attached files: {paths}]"
            state.pending_answer.set_result(text)
    elif mtype == "control":
        action = msg.get("action")
        if action == "pause":
            state.paused = True
        elif action == "resume":
            state.paused = False
        elif action == "stop":
            state.stop = True
            state.paused = False
            if state.pending_answer is not None and not state.pending_answer.done():
                state.pending_answer.set_result("(task stopped by user)")
            # Helpers honor state.stop at their next step; cancel hurries
            # ones blocked in an LLM request or a long run_command.
            for e in state.subagents.values():
                t = e.get("task")
                if t and e.get("status") == "running":
                    t.cancel()
        await push_status()
    elif mtype == "set_model":
        model = str(msg.get("model") or state.model)
        cid = str(msg.get("conversation_id") or "")
        if cid:
            try:
                conv_set_model(cid, model)
            except ValueError:
                pass
        # Apply live when it targets the running conversation, when the
        # device is idle, or when no conversation was given (legacy clients).
        if not cid or cid == state.conversation_id or not state.running:
            state.model = model
        await push_status()
    elif mtype == "ping":
        await ws.send_text(json.dumps({"type": "pong"}))


# Shell payload spawned by POST /api/update on gut-bot (deb) installs. It
# must run outside gut-bot.service — the deb's postinst restarts the service
# and its whole cgroup, so the updater goes through systemd-run (or setsid
# on non-systemd hosts). Args: <status-file> <version> <arch> <repo>.
SELF_UPDATE_SCRIPT = """#!/bin/sh
STATUS="$1"; TARGET="$2"; ARCH="$3"; REPO="${4:-valteryde/gut}"
say() {
  err=""
  [ $# -gt 1 ] && err=$(printf '%s' "$2" | tr -dc 'a-zA-Z0-9 ._-')
  printf '{"state":"%s","target":"%s","error":"%s","ts":%s}\\n' "$1" "$TARGET" "$err" "$(date +%s)" > "$STATUS"
}
say downloading
TMP=$(mktemp -d)
cd "$TMP" || { say failed "mktemp failed"; exit 1; }
BASE="https://github.com/$REPO/releases/download/v$TARGET"
DEB="gut-bot_${TARGET}_${ARCH}.deb"
curl -fsSL -o pkg.deb "$BASE/$DEB" || { say failed "download failed"; exit 1; }
if curl -fsSL -o sums.txt "$BASE/SHA256SUMS.txt"; then
  want=$(awk -v f="$DEB" '$2 == f {print $1}' sums.txt)
  if [ -n "$want" ]; then
    printf '%s  %s\\n' "$want" pkg.deb | sha256sum -c - >/dev/null 2>&1 || { say failed "checksum mismatch"; exit 1; }
  fi
fi
say installing
# Noninteractive: a changed conffile (e.g. litellm.yaml) otherwise makes
# dpkg prompt on a dead stdin and leaves the package half-configured with
# the services stopped. confdef/confold keep the installed config; the new
# template lands alongside as .dpkg-new.
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
  "$TMP/pkg.deb" >/dev/null 2>&1 || { say failed "install failed"; exit 1; }
say done
rm -rf "$TMP"
"""


# ── TLS termination ─────────────────────────────────────────────────────────

def _ensure_tls_cert() -> None:
    """Self-signed cert for the pinned-TLS listener. start.sh already does
    this for docker/gut-bot (websockify needs the files too); this fallback
    covers bare `uvicorn agent_daemon:app` dev runs."""
    global TLS_ERR
    if TLS_CERT.exists() and TLS_KEY.exists():
        return
    cn = re.sub(r"[^A-Za-z0-9._-]", "", DEVICE_NAME) or "device"
    try:
        TLS_CERT.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "ec",
             "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
             "-days", "3650", "-subj", f"/CN=gut-{cn}",
             "-keyout", str(TLS_KEY), "-out", str(TLS_CERT)],
            check=True, capture_output=True)
        TLS_KEY.chmod(0o600)
    except (OSError, subprocess.CalledProcessError) as e:
        TLS_ERR = f"cert generation failed ({e})"
        print(f"[gut] TLS cert generation failed ({e}) — TLS disabled")


async def _pipe(reader: asyncio.StreamReader,
                writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def _tls_bridge(client_r: asyncio.StreamReader,
                      client_w: asyncio.StreamWriter) -> None:
    try:
        local_r, local_w = await asyncio.open_connection(
            "127.0.0.1", BACKEND_PORT)
    except OSError:
        client_w.close()
        return
    await asyncio.gather(_pipe(client_r, local_w), _pipe(local_r, client_w))


async def _start_tls_proxy():
    """TLS-terminating forwarder onto the plain uvicorn socket."""
    global TLS_FP, TLS_ERR
    _ensure_tls_cert()
    try:
        der = ssl.PEM_cert_to_DER_cert(TLS_CERT.read_text())
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(TLS_CERT, TLS_KEY)
    except (OSError, ValueError, ssl.SSLError) as e:
        TLS_ERR = f"cert unusable ({e})"
        print(f"[gut] TLS unavailable ({e}) — plain HTTP only")
        return None
    TLS_FP = hashlib.sha256(der).hexdigest()
    try:
        srv = await asyncio.start_server(_tls_bridge, "0.0.0.0", TLS_PORT,
                                         ssl=ctx)
    except OSError as e:
        TLS_ERR = f"cannot bind :{TLS_PORT} ({e})"
        print(f"[gut] TLS listener failed ({e}) — plain HTTP only")
        return None
    print(f"[gut] TLS listener on :{TLS_PORT} (self-signed, pinned by the app)")
    return srv


# ── HTTP API ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        CONV_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"[gut] conversation dir {CONV_DIR} unavailable: {e}")
    # A leftover run-state file means the previous run died before its
    # end-of-run cleanup — sweep what it left before taking new work.
    try:
        stale = json.loads(RUN_STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        stale = None
    if stale:
        if stale.get("boot") and stale["boot"] != _boot_key():
            # Whole environment restarted since — nothing to sweep.
            print("[gut] stale run-state from before a restart — discarded")
        elif GUT_CLEANUP:
            try:
                stats = await asyncio.to_thread(sweep_desktop, stale)
                print(f"[gut] swept leftovers of interrupted run: {stats}")
            except Exception as e:
                print(f"[gut] startup sweep failed: {e}")
        _persist_baseline(None)
    tls_srv = await _start_tls_proxy()
    # Port multiplexers (see tcpmux): uvicorn and plain websockify sit on
    # loopback internals; the public ports carry plain AND TLS so encrypted
    # transport works wherever the plain ports already reach.
    mux_srvs = []
    if MUX:
        if tcpmux is None:
            # uvicorn is parked on loopback — without the mux nothing can
            # reach the API at all, so die loudly instead of limping.
            raise RuntimeError("tcpmux.py missing but GUT_UVICORN_PORT is "
                               "set — broken install")
        try:
            mux_srvs = [
                await tcpmux.start_mux(HTTP_PORT, TLS_PORT, BACKEND_PORT),
                await tcpmux.start_mux(NOVNC_PORT, NOVNC_TLS_PORT,
                                       NOVNC_PLAIN_PORT)]
        except OSError as e:
            print(f"[gut] port mux failed ({e}) — public ports unproxied")
            mux_srvs = []
    state.litellm_key = await provision_key()
    sync_task = asyncio.create_task(model_sync_loop())
    print(f"[gut] agent ready, model={state.model}")
    try:
        yield
    finally:
        sync_task.cancel()
        if tls_srv:
            tls_srv.close()
        for srv in mux_srvs:
            srv.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


def _token_ok(token: str) -> bool:
    return bool(GUT_API_TOKEN) and token == GUT_API_TOKEN


@app.middleware("http")
async def require_token(request: Request, call_next):
    # /api/version and /api/hello stay open — the Electron app probes them
    # to detect a Gut backend and to pair TLS before it has credentials.
    # OPTIONS is a CORS preflight.
    if (not GUT_API_TOKEN or request.method == "OPTIONS"
            or request.url.path in ("/api/version", "/api/hello")):
        return await call_next(request)
    auth = request.headers.get("authorization", "")
    if (auth == f"Bearer {GUT_API_TOKEN}"
            or _token_ok(request.query_params.get("token", ""))):
        return await call_next(request)
    return JSONResponse({"detail": "unauthorized"}, status_code=401)


@app.websocket("/ws/chat")
async def chat_ws(ws: WebSocket):
    if GUT_API_TOKEN:
        auth = ws.headers.get("authorization", "")
        tok = ws.query_params.get("token", "")
        if auth != f"Bearer {GUT_API_TOKEN}" and tok != GUT_API_TOKEN:
            await ws.close(code=4401)
            return
    await ws.accept()
    state.clients.add(ws)
    await ws.send_text(json.dumps({
        "type": "hello", "state": state.phase, "model": state.model,
        "device": DEVICE_NAME,
        "running_conversation":
            state.conversation_id if state.running else None,
    }))
    await push_cost()
    try:
        while True:
            await handle_client_msg(ws, json.loads(await ws.receive_text()))
    # Abrupt TCP drops (tab reload, network blip) surface as RuntimeError
    # ("WebSocket is not connected") rather than WebSocketDisconnect — the
    # peer is gone either way.
    except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
        pass
    finally:
        state.clients.discard(ws)


@app.get("/api/version")
async def api_version():
    """Unauthenticated handshake — the client probes this to detect a Gut
    backend and check compatibility before presenting credentials."""
    return {"version": GUT_VERSION, "device": DEVICE_NAME,
            "auth": bool(GUT_API_TOKEN), "install": INSTALL_KIND}


@app.get("/api/hello")
async def api_hello(n: str = ""):
    """Unauthenticated TLS pairing handshake, like /api/version.

    The app reads the pinned listener's cert fingerprint here (over plain
    HTTP is fine — it leaks nothing), opens a provisional TLS connection to
    see the cert actually presented, and pins it when the fingerprint
    matches and `mac` verifies: HMAC(device password, fp + client nonce).
    A MITM can't forge the MAC without the password, and a pure relay only
    ever forwards the real cert — so first connect has no trust gap. `n`
    makes every answer single-use so replays can't pin stale certs.
    """
    if not TLS_FP:
        raise HTTPException(
            404, TLS_ERR or "this backend has no TLS listener")
    mac = None
    if GUT_API_TOKEN:
        mac = hmac.new(GUT_API_TOKEN.encode(),
                       f"gut-tls-pin:{TLS_FP}:{n}".encode(),
                       hashlib.sha256).hexdigest()
    # With the mux running, TLS rides the same public ports as plain HTTP —
    # advertise those so pairing works wherever :8000/:6080 already reach.
    return {"cert_sha256": TLS_FP, "mac": mac,
            "port": HTTP_PORT if MUX else TLS_PORT,
            "vnc_port": NOVNC_PORT if MUX else NOVNC_TLS_PORT}


def _update_status() -> dict:
    try:
        s = json.loads(UPDATE_STATUS_FILE.read_text())
        if isinstance(s, dict):
            return s
    except (OSError, json.JSONDecodeError):
        pass
    return {"state": "idle"}


@app.get("/api/update")
async def api_update_status():
    return {"supported": INSTALL_KIND == "deb", "install": INSTALL_KIND,
            **_update_status()}


@app.post("/api/update")
async def api_update(body: dict = Body(default={})):
    """Self-update for gut-bot deb installs: download the release deb and
    install it detached — the package's postinst restarts this service, so
    the updater must live outside the service's cgroup."""
    if INSTALL_KIND != "deb":
        raise HTTPException(400, "self-update needs a gut-bot install "
                                 f"(this backend is '{INSTALL_KIND}')")
    target = str(body.get("version") or "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", target):
        raise HTTPException(400, "version must look like 1.2.3")
    if state.running:
        raise HTTPException(409, "agent is working — stop it first")
    if _update_status().get("state") in ("starting", "downloading",
                                         "installing"):
        raise HTTPException(409, "update already in progress")
    try:
        arch = subprocess.check_output(
            ["dpkg", "--print-architecture"], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        arch = ""
    if arch not in ("amd64", "arm64"):
        raise HTTPException(400, f"no gut-bot build for arch '{arch or '?'}'")

    script = GUT_DATA_DIR / "self-update.sh"
    script.write_text(SELF_UPDATE_SCRIPT)
    script.chmod(0o755)
    cmd = ["/bin/sh", str(script), str(UPDATE_STATUS_FILE), target,
           arch, GITHUB_REPO]
    UPDATE_STATUS_FILE.write_text(json.dumps(
        {"state": "starting", "target": target, "ts": int(time.time())}))
    launched = False
    if Path("/run/systemd/system").exists():
        launched = subprocess.run(
            ["sudo", "-n", "systemd-run", "-q", "--collect",
             "--unit=gut-self-update", *cmd],
            capture_output=True).returncode == 0
    if not launched:
        subprocess.Popen(["setsid", *cmd], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True, "target": target}


def _keys_state() -> dict:
    eff = effective_provider_keys()
    return {k: {"set": k in eff,
                "source": eff[k][1] if k in eff else None}
            for k in PROVIDER_KEYS}


@app.get("/api/keys")
async def api_keys():
    """Which provider keys this device can serve models for — set flags and
    where each came from, never the values."""
    return _keys_state()


@app.post("/api/keys")
async def api_keys_set(body: dict = Body(...)):
    """Upsert provider keys pushed from the app; an empty value removes.

    Keys are stored on this device (PROVIDER_KEYS_FILE, next to the
    conversation store) and synced into LiteLLM's model store — no restart
    needed. Unknown key names are rejected so this can't write arbitrary
    environment.
    """
    updates = body.get("keys")
    if not isinstance(updates, dict):
        raise HTTPException(400, 'expected {"keys": {NAME: value}}')
    bad = sorted(k for k in updates if k not in PROVIDER_KEYS)
    if bad:
        raise HTTPException(400, "unknown provider keys: " + ", ".join(bad))
    saved = load_provider_keys()
    for k, v in updates.items():
        v = str(v or "").strip()
        if v:
            saved[k] = v
        else:
            saved.pop(k, None)
    store_provider_keys(saved)
    state.models_synced = False  # the sync loop retries on failure
    try:
        await reconcile_models()
        state.models_synced = True
    except Exception as e:
        return {"keys": _keys_state(), "applied": False,
                "error": f"saved on device but LiteLLM rejected it "
                         f"(retrying): {e}"}
    return {"keys": _keys_state(), "applied": True}


@app.get("/api/device")
async def api_device():
    return {"name": DEVICE_NAME}


@app.get("/api/status")
async def api_status():
    return {"state": state.phase, "model": state.model,
            "device": DEVICE_NAME,
            "conversation_id": state.conversation_id if state.running else None,
            "session_usd": state.session_usd,
            "tokens_in": state.tokens_in, "tokens_out": state.tokens_out}


@app.get("/api/conversations")
async def api_conversations():
    metas = conv_list()
    for m in metas:
        m["running"] = bool(
            state.running and state.conversation_id == m.get("id"))
    return metas


@app.post("/api/conversations", status_code=201)
async def api_conversation_create(body: dict = Body(default={})):
    meta = conv_create(str(body.get("model") or state.model),
                       str(body.get("title") or ""))
    await broadcast({"type": "conversations"})
    return meta


@app.get("/api/conversations/{cid}")
async def api_conversation(cid: str):
    try:
        conv = conv_get(cid)
    except ValueError:
        conv = None
    if conv is None:
        raise HTTPException(404, "no such conversation")
    conv["meta"]["running"] = bool(
        state.running and state.conversation_id == cid)
    return conv


@app.delete("/api/conversations/{cid}")
async def api_conversation_delete(cid: str):
    if state.running and state.conversation_id == cid:
        raise HTTPException(409, "conversation is running — stop it first")
    try:
        ok = conv_delete(cid)
    except ValueError:
        ok = False
    if not ok:
        raise HTTPException(404, "no such conversation")
    if state.conversation_id == cid:
        state.conversation_id = None
    await broadcast({"type": "conversations"})
    return {"ok": True}


@app.get("/api/cost")
async def api_cost():
    return {"session_usd": state.session_usd,
            "lifetime_usd": await litellm_spend(),
            "tokens_in": state.tokens_in, "tokens_out": state.tokens_out,
            "model": state.model}


@app.get("/api/models")
async def api_models():
    """Model list enriched with LiteLLM's /model/info metadata (price per
    token, context size, vision support) so the client can annotate the
    picker. Falls back to bare ids when info is unavailable."""
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{LITELLM_URL}/model/info",
                            headers={"Authorization": f"Bearer {state.litellm_key}"})
            r.raise_for_status()
            data = r.json()
            items = data.get("data", []) if isinstance(data, dict) else data
            models = []
            for m in items:
                name = m.get("model_name")
                if not name:
                    continue
                info = m.get("model_info") or {}
                models.append({
                    "id": name,
                    "cost_in": info.get("input_cost_per_token"),
                    "cost_out": info.get("output_cost_per_token"),
                    "ctx": info.get("max_input_tokens") or info.get("max_tokens"),
                    "vision": info.get("supports_vision"),
                })
            if models:
                return models
    except Exception:
        pass
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{LITELLM_URL}/v1/models",
                            headers={"Authorization": f"Bearer {state.litellm_key}"})
            r.raise_for_status()
            return [{"id": m["id"]} for m in r.json().get("data", [])]
    except Exception:
        return [{"id": state.model}]


@app.post("/api/model")
async def api_model(body: dict = Body(...)):
    state.model = str(body.get("model", state.model))
    await push_status()
    return {"model": state.model}


@app.post("/api/pause")
async def api_pause():
    state.paused = True
    await push_status()
    return {"state": state.phase}


@app.post("/api/resume")
async def api_resume():
    state.paused = False
    await push_status()
    return {"state": state.phase}
