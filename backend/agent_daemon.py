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
import io
import json
import mimetypes
import os
import re
import shlex
import socket
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
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
# Files the user attaches in the composer land on the desktop itself, where
# the agent's file/shell tools can read them (paths are relative to home).
UPLOAD_DIR = Path(os.environ.get("GUT_UPLOAD_DIR") or HOME_DIR / "uploads")
MAX_ATTACHMENTS = 8
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
- Google Chrome is installed with DevTools on localhost:{cdp}. For anything on
  a web page prefer the browser_* tools (DOM refs, not pixels): open_url or
  browser_navigate to get somewhere, browser_text to read the page's text,
  browser_dom to list interactive elements as #refs, then browser_click /
  browser_type by ref; browser_eval runs arbitrary JS. Fall back to pixel
  tools for anything outside the page.
- LibreOffice Writer, Calc and Impress are installed
  (`libreoffice --writer/--calc/--impress`).
- run_command gives you a bash shell (cwd {home}, DISPLAY already set).
  Launch GUI apps in the background so the command returns, e.g. `google-chrome &`.
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
  chat attachment. Paths are relative to {home}.
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

Guidelines:
- A fresh screenshot is attached automatically after each turn's actions; only
  call screenshot when nothing changed or you need an extra look.
- Batch predictable sequences into one response — emit several tool calls at
  once (e.g. click field → type → press enter). Split only when the next step
  depends on what the screen shows after the previous one.
- Prefer keyboard shortcuts, direct typing and run_command over pixel hunting.
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
    return {"meta": meta, "events": events}


def conv_delete(cid: str) -> bool:
    if _read_meta(cid) is None:
        return False
    for p in _conv_paths(cid):
        p.unlink(missing_ok=True)
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
    "thought", "action", "action_result", "question", "error"})


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


def run_command(command: str) -> str:
    # Redirect via a real file, not pipes: a backgrounded child (`foo &`)
    # inherits stdout/stderr, and communicate() would block on pipe EOF until
    # that child exits — a false "still running" timeout for every GUI launch.
    fd, out_path = tempfile.mkstemp(prefix="gut-cmd-", suffix=".out")
    try:
        with os.fdopen(fd, "w") as f:
            p = subprocess.run(
                ["bash", "-lc", command],
                stdout=f, stderr=subprocess.STDOUT,
                timeout=COMMAND_TIMEOUT, cwd=str(HOME_DIR),
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
    raise CDPError(f"chrome did not expose CDP on :{CDP_PORT}")


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
        "name": "task_complete",
        "description": "End the task. `summary` is sent to the user as your "
                       "wrap-up message — cover what was done, where results "
                       "live, and anything they should check.",
        "parameters": {"type": "object", "properties": {
            "summary": {"type": "string"}}, "required": ["summary"]}}},
]


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


async def execute_tool(name: str, args: dict) -> tuple[list | str, bool]:
    """Return (tool_result_content, task_done)."""
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
            result = run_command(str(args.get("command", "")))
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
        elif name == "ask_user":
            return await ask_user(str(args.get("question", ""))), False
        elif name == "task_complete":
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


def cache_friendly() -> bool:
    """Only Anthropic-family models understand cache_control — for everyone
    else LiteLLM may forward it and the provider may reject the request."""
    m = state.model.lower()
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


async def llm_request(http: httpx.AsyncClient, messages: list) -> httpx.Response:
    """One chat-completion call with retry on transient failures.

    A single 429/5xx mid-task used to kill the run and waste all prior spend.
    Retries with backoff; non-retryable 4xx propagates immediately.
    """
    payload = {"model": state.model, "messages": messages, "tools": TOOLS}
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


async def agent_loop(conv_id: str, task_text: str,
                     attachments: list[dict] | None = None) -> None:
    state.stop = False
    state.paused = False
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
            res=res, cdp=CDP_PORT, coords=coords, home=HOME_DIR)}]
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
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=30)) as http:
            for _ in range(MAX_STEPS):
                while state.paused and not state.stop:
                    await asyncio.sleep(0.4)
                if state.stop or done:
                    break

                prune_images(messages)
                if cache_friendly():
                    apply_cache_control(messages)
                try:
                    r = await llm_request(http, messages)
                except httpx.HTTPError as e:
                    body = getattr(e.response, "text", "") if hasattr(e, "response") else ""
                    await broadcast({"type": "error",
                                     "text": f"LiteLLM request failed: {e} {body[:300]}"})
                    break

                usd, tin, tout = track_cost(r)
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


# ── HTTP API ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        CONV_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"[gut] conversation dir {CONV_DIR} unavailable: {e}")
    state.litellm_key = await provision_key()
    sync_task = asyncio.create_task(model_sync_loop())
    print(f"[gut] agent ready, model={state.model}")
    try:
        yield
    finally:
        sync_task.cancel()


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


def _token_ok(token: str) -> bool:
    return bool(GUT_API_TOKEN) and token == GUT_API_TOKEN


@app.middleware("http")
async def require_token(request: Request, call_next):
    # /api/version stays open — the Electron app probes it to detect a Gut
    # backend before it has credentials. OPTIONS is a CORS preflight.
    if (not GUT_API_TOKEN or request.method == "OPTIONS"
            or request.url.path == "/api/version"):
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
