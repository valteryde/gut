import RFB from './vendor/novnc/core/rfb.js';

// ── config ──────────────────────────────────────────────────────────────
// Devices are the backends (desktop environments) this UI can drive — the
// local container, a VPS, … Each device has its own daemon, screen and
// conversation store, and runs at most one agent at a time.
const cfg = {
  devices: loadDevices(),
  activeDevice: localStorage.getItem('gut.activeDevice') || '',
  model: localStorage.getItem('gut.model') || '',
  verbose: localStorage.getItem('gut.verbose') === '1',
};

function loadDevices() {
  try {
    const devs = JSON.parse(localStorage.getItem('gut.devices') || 'null');
    if (Array.isArray(devs) && devs.length) return devs;
  } catch (_) { /* fall through to migration */ }
  // Migrate the legacy single-host settings into a first device.
  return [{
    id: 'local',
    name: 'Local',
    host: localStorage.getItem('gut.host') || location.hostname || '127.0.0.1',
    vncPassword: localStorage.getItem('gut.vncPassword') || '',
  }];
}

function saveDevices() {
  localStorage.setItem('gut.devices', JSON.stringify(cfg.devices));
  localStorage.setItem('gut.activeDevice', cfg.activeDevice);
}

function activeDev() {
  const d = cfg.devices.find(d => d.id === cfg.activeDevice) || cfg.devices[0];
  cfg.activeDevice = d.id;
  return d;
}

const AGENT_PORT = 8000;
const NOVNC_PORT = 6080;
const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
const httpScheme = location.protocol === 'https:' ? 'https' : 'http';

const agentBase = () => `${httpScheme}://${activeDev().host}:${AGENT_PORT}`;
// The device password doubles as the agent API token — one secret per
// backend, set by gut-bot/Electron at install time.
const wsUrl = () => {
  const t = activeDev().vncPassword;
  return `${wsScheme}://${activeDev().host}:${AGENT_PORT}/ws/chat` +
    (t ? `?token=${encodeURIComponent(t)}` : '');
};
const novncUrl = () => `${wsScheme}://${activeDev().host}:${NOVNC_PORT}/websockify`;

function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = activeDev().vncPassword;
  if (t) headers.Authorization = `Bearer ${t}`;
  return fetch(`${agentBase()}${path}`, { ...opts, headers });
}

// ── agent display name ──────────────────────────────────────────────────
// Short label for the transcript, derived from the model id. Order matters:
// first matching pattern wins.
const AGENT_NAMES = [
  [/claude/i, 'Claude'],
  [/deepseek/i, 'DeepSeek'],
  [/gemini/i, 'Gemini'],
  [/gpt|openai|\bo[1-9]/i, 'GPT'],
  [/qwen|qwq/i, 'Qwen'],
  [/mistral|mixtral/i, 'Mistral'],
  [/llama|codellama|meta-/i, 'Llama'],
  [/grok/i, 'Grok'],
  [/kimi|moonshot/i, 'Kimi'],
  [/ollama|llava|local/i, 'Ollama'],
];
const DEFAULT_NAME = 'Gut';
let agentName = DEFAULT_NAME;

// ── model quality notes ─────────────────────────────────────────────────
// LiteLLM reports price/context/vision per model; "is it good" is judgement,
// so short notes live here. First matching pattern wins, like AGENT_NAMES.
const MODEL_NOTES = [
  [/opus/i, 'strongest, priciest'],
  [/sonnet/i, 'top pick for desktop control'],
  [/haiku/i, 'fast + cheap, decent'],
  [/gpt-5|\bo[34]\b/i, 'strong, careful, slower'],
  [/gpt-4o|gpt-4\.1|gpt-4/i, 'fast + cheap, mid quality'],
  [/gemini.*pro/i, 'strong, huge context'],
  [/gemini.*flash/i, 'cheap + fast, decent'],
  [/deepseek/i, 'cheap, text-only — blind agent'],
  [/qwen.*vl|llava/i, 'budget vision, weaker'],
  [/ollama|local/i, 'free + self-hosted, weakest'],
];

const TASK_PLACEHOLDER = 'Describe a task…';

function setAgentName(model) {
  const m = String(model || '');
  const match = AGENT_NAMES.find(([re]) => re.test(m));
  agentName = match ? match[1] : DEFAULT_NAME;
  chatInput.placeholder =
    awaitingAnswer ? `Reply to ${agentName}…` : TASK_PLACEHOLDER;
  updateTyping();
}

// ── DOM ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const costPill = $('costPill');
const costNum = $('costNum');
const costTok = $('costTok');
const costSpark = $('costSpark');
const sparkLine = $('costSparkLine');
const sparkFill = $('costSparkFill');
const cpSession = $('cpSession');
const cpIn = $('cpIn');
const cpOut = $('cpOut');
const cpConvRow = $('cpConvRow');
const cpConv = $('cpConv');
const cpLifeRow = $('cpLifeRow');
const cpLife = $('cpLife');
const takeoverBtn = $('takeoverBtn');
const takeoverLabel = $('takeoverLabel');
const takeoverBanner = $('takeoverBanner');
const convTitleEl = $('convTitle');
const chatInput = $('chatInput');
const screenStatusEl = $('screenStatus');
const deviceSelect = $('deviceSelect');
const modelSelect = $('modelSelect');
const modelInfoEl = $('modelInfo');
const settingsDialog = $('settingsDialog');
const deviceListEl = $('deviceList');
const devNameInput = $('devNameInput');
const hostInput = $('hostInput');
const vncPassInput = $('vncPassInput');
const devFormTitle = $('devFormTitle');
const newDevBtn = $('newDevBtn');
const saveSettingsBtn = $('saveSettings');
const stopBtn = $('stopBtn');
const verboseToggle = $('verboseToggle');
const activityEl = $('activityLine');
const convDrawer = $('convDrawer');
const convList = $('convList');
const drawerDevice = $('drawerDevice');
const chatPane = $('chatPane');

let rfb = null;
let chatWs = null;
let awaitingAnswer = false;
let takenOver = false;
let agentPhase = 'idle';
let lastEntryKey = null;

// ── conversation state ──────────────────────────────────────────────────
let conversations = [];          // metas for the active device
let activeConvId = null;         // conversation being viewed
let convModel = null;            // model bound to the viewed conversation
let runningConvId = null;        // conversation the device is working on
let lastSeq = 0;                 // highest seq rendered in the transcript
let convFetchId = null;          // conversation currently being refetched
let pendingLive = [];            // live events arrived during a refetch
let convListTimer = 0;

const convKey = (devId) => `gut.conv.${devId}`;

function convTitle(id) {
  const c = conversations.find(c => c.id === id);
  return (c && c.title) || 'another conversation';
}

// ── transcript ──────────────────────────────────────────────────────────
// Typing indicator — not a transcript entry but a live row pinned to the
// bottom of #messages while the agent works on the viewed conversation, so
// the "typing…" sits exactly where the reply will land.
const typingEl = document.createElement('div');
typingEl.className = 'msg agent typing';
const typingWho = document.createElement('span');
typingWho.className = 'who';
const typingBody = document.createElement('div');
typingBody.className = 'body';
const typingDots = document.createElement('span');
typingDots.className = 'dots';
const typingText = document.createElement('span');
typingText.className = 'typing-text';
typingBody.append(typingDots, typingText);
typingEl.append(typingWho, typingBody);

function updateTyping() {
  const here = activeConvId && agentPhase !== 'idle' &&
    (!runningConvId || runningConvId === activeConvId);
  if (!here) { typingEl.remove(); return; }
  typingWho.textContent = agentName;
  typingEl.dataset.phase = agentPhase;
  typingText.textContent = STATE_LABEL[agentPhase] || '';
  if (typingEl.parentNode !== messagesEl) messagesEl.appendChild(typingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Each entry is a label column + body. Consecutive entries of the same kind
// from the same sender drop the repeated label so runs read as one turn.
// (Your own messages hide the label entirely — see .msg.user in styles.css.)
function entry(cls, who = '') {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  const key = `${cls}|${who}`;
  const label = document.createElement('span');
  label.className = 'who';
  if (!who || key === lastEntryKey) div.classList.add('cont');
  else label.textContent = who;
  lastEntryKey = key;
  const body = document.createElement('div');
  body.className = 'body';
  div.append(label, body);
  // Keep the typing indicator pinned below the newest entry.
  messagesEl.insertBefore(div,
    typingEl.parentNode === messagesEl ? typingEl : null);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { div, body };
}

function addMsg(cls, text, who = '') {
  entry(cls, who).body.textContent = text;
}

// Working-log entries (thoughts, tool calls, results) — only rendered when
// the verbose toggle is on.
function addVerbose(cls, text) {
  entry(`${cls} verbose-only`).body.textContent = text;
}

function b64ToBlobUrl(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function fmtSize(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function addFileMsg(m) {
  const { body } = entry('file', agentName);
  if (m.note) {
    const p = document.createElement('p');
    p.className = 'file-note';
    p.textContent = m.note;
    body.appendChild(p);
  }
  const a = document.createElement('a');
  a.className = 'file-link';
  a.href = b64ToBlobUrl(m.data, m.mime);
  a.download = m.name;
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = m.name;
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = fmtSize(m.size || 0);
  a.append(name, size);
  body.appendChild(a);
}

function addImageMsg(m) {
  const { body } = entry('image', agentName);
  const url = b64ToBlobUrl(m.data, m.mime);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.download = m.name || 'image';
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = url;
  img.alt = m.caption || m.name || 'image from agent';
  a.appendChild(img);
  body.appendChild(a);
  if (m.caption) {
    const p = document.createElement('p');
    p.className = 'img-caption';
    p.textContent = m.caption;
    body.appendChild(p);
  }
}

// One renderer for live events and stored history alike. `live` adds the
// ephemeral side effects (activity line, pending-question state).
function renderEvent(m, live) {
  switch (m.type) {
    case 'user':
      addMsg('user', m.text, 'You');
      break;
    case 'agent_msg':
      addMsg('agent', m.text, agentName);
      break;
    case 'done':
      addMsg('agent', m.text, agentName);
      if (live) notify(`${agentName} finished`, m.text || '');
      break;
    case 'file':
      addFileMsg(m);
      break;
    case 'image':
      addImageMsg(m);
      break;
    case 'thought':
      addVerbose('thought', (m.text || '').trim());
      break;
    case 'action':
      addVerbose('action', `▶ ${m.tool} ${JSON.stringify(m.args)}`);
      if (live) activityEl.textContent = `${agentName} · ▶ ${m.tool}`;
      break;
    case 'action_result':
      addVerbose('action', `✓ ${m.tool}: ${(m.result || '').trim()}`);
      break;
    case 'question':
      addMsg('question', m.text, agentName);
      if (live) {
        notify(`${agentName} needs you`, m.text || '');
        awaitingAnswer = true;
        chatInput.placeholder = `Reply to ${agentName}…`;
        activityEl.textContent = '· waiting for your reply';
      }
      break;
    case 'error':
      addMsg('error', m.text, 'Error');
      break;
  }
}

// Text shown in place of the dots for the non-running active phases.
const STATE_LABEL = {
  waiting_user: 'needs you',
  paused: 'paused',
};

function setAgentState(s) {
  agentPhase = s;
  document.body.dataset.agent = s;
  stopBtn.hidden = !(s === 'running' || s === 'waiting_user' || s === 'paused');
  if (s === 'idle') activityEl.textContent = '';
  updateTyping();
}

// ── usage meter ─────────────────────────────────────────────────────────
// The pill shows session spend ticking up live (with a mint flash when it
// grows); hovering opens a breakdown card — spend sparkline, tokens in/out,
// the viewed conversation's share, and the key's all-time total.
const fmtUsd = (v) =>
  '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2));
const fmtTok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

let shownUsd = 0;
let prevSessionUsd = 0;
let costAnim = 0;
const costHist = [];

function drawSpark() {
  const w = 168, h = 36;
  costSpark.hidden = costHist.length < 2;
  if (costHist.length < 2) return;
  const lo = costHist[0];
  const span = Math.max(costHist[costHist.length - 1] - lo, 1e-9);
  const d = 'M' + costHist.map((v, i) =>
    `${(i / (costHist.length - 1) * w).toFixed(1)},` +
    `${(h - 3 - (v - lo) / span * (h - 8)).toFixed(1)}`).join('L');
  sparkLine.setAttribute('d', d);
  sparkFill.setAttribute('d', `${d}L${w},${h}L0,${h}Z`);
}

function updateConvCost() {
  const conv = conversations.find(c => c.id === activeConvId);
  const usd = (conv && conv.cost_usd) || 0;
  cpConvRow.hidden = !(activeConvId && usd > 0);
  cpConv.textContent = fmtUsd(usd);
}

function setCost(c) {
  const target = c.session_usd || 0;
  const rose = target > prevSessionUsd;
  prevSessionUsd = target;
  // Live spend for the running conversation, straight from its meta.
  if (c.conversation_id) {
    const conv = conversations.find(x => x.id === c.conversation_id);
    if (conv) conv.cost_usd = c.conversation_usd;
  }
  costHist.push(target);
  if (costHist.length > 60) costHist.shift();
  drawSpark();
  cpIn.textContent = fmtTok(c.tokens_in || 0);
  cpOut.textContent = fmtTok(c.tokens_out || 0);
  costTok.textContent =
    `${fmtTok((c.tokens_in || 0) + (c.tokens_out || 0))} tok`;
  cpLifeRow.hidden = c.lifetime_usd == null;
  if (c.lifetime_usd != null) cpLife.textContent = fmtUsd(c.lifetime_usd);
  updateConvCost();
  // Ease the session number up to the new total.
  cancelAnimationFrame(costAnim);
  const from = shownUsd, t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 700);
    const v = from + (target - from) * (1 - Math.pow(1 - k, 3));
    shownUsd = v;
    costNum.textContent = cpSession.textContent = fmtUsd(v);
    if (k < 1) costAnim = requestAnimationFrame(step);
  };
  costAnim = requestAnimationFrame(step);
  if (rose) {
    costPill.classList.remove('tick');
    void costPill.offsetWidth;  // restart the flash
    costPill.classList.add('tick');
  }
}

// ── desktop stream (noVNC RFB) ──────────────────────────────────────────
function connectDesktop() {
  if (rfb) { try { rfb.disconnect(); } catch (_) {} }
  screenStatusEl.textContent = 'connecting…';
  rfb = new RFB($('screen'), novncUrl(), {
    credentials: { password: activeDev().vncPassword },
  });
  // Fit the desktop to the pane both ways — the whole desktop is always
  // visible; the ambient backdrop fills whatever gutter remains.
  rfb.scaleViewport = true;
  rfb.clipViewport = true;
  rfb.background = 'transparent';  // let the ambient backdrop show through
  rfb.addEventListener('connect', () => {
    screenStatusEl.textContent = '';
  });
  rfb.addEventListener('disconnect', (e) => {
    screenStatusEl.textContent = e.detail.clean
      ? 'disconnected'
      : 'connection lost — retrying…';
    setTimeout(connectDesktop, 3000);
  });
  rfb.addEventListener('credentialsrequired', () => {
    rfb.sendCredentials({ password: activeDev().vncPassword });
  });
}

// ── ambient backdrop ────────────────────────────────────────────────────
// The remote desktop is fixed-size, so noVNC letterboxes it inside the
// pane. Fill the gutters with a blurred, cover-scaled echo of the stream —
// the pane reads as one continuous surface instead of dead black bars.
const screenEl = $('screen');
const backdrop = document.createElement('canvas');
backdrop.id = 'screenBackdrop';
screenEl.prepend(backdrop);
const backdropCtx = backdrop.getContext('2d');
setInterval(() => {
  const src = screenEl.querySelector('div canvas');  // noVNC's canvas
  if (!src || !src.width || !src.height) return;
  const w = screenEl.clientWidth, h = screenEl.clientHeight;
  if (!w || !h) return;
  if (backdrop.width !== w) backdrop.width = w;
  if (backdrop.height !== h) backdrop.height = h;
  const s = Math.max(w / src.width, h / src.height);
  backdropCtx.drawImage(src, (w - src.width * s) / 2,
                             (h - src.height * s) / 2,
                             src.width * s, src.height * s);
}, 250);

// ── conversations ───────────────────────────────────────────────────────
async function loadConversations() {
  try {
    const r = await apiFetch('/api/conversations');
    if (!r.ok) return;
    conversations = await r.json();
    renderConvList();
  } catch (_) { /* device unreachable */ }
}

function scheduleConvReload() {
  clearTimeout(convListTimer);
  convListTimer = setTimeout(loadConversations, 800);
}

function relTime(ts) {
  const s = Math.max(1, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderConvList() {
  drawerDevice.textContent = `on ${activeDev().name}`;
  convList.innerHTML = '';
  if (!conversations.length) {
    const p = document.createElement('p');
    p.className = 'conv-empty';
    p.textContent = 'No conversations on this device yet.';
    convList.appendChild(p);
  }
  for (const c of conversations) {
    const row = document.createElement('div');
    row.className = 'conv-row' + (c.id === activeConvId ? ' active' : '');
    row.title = c.title || 'New conversation';

    const text = document.createElement('div');
    text.className = 'conv-text';
    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = c.title || 'New conversation';
    const sub = document.createElement('span');
    sub.className = 'conv-sub';
    const cost = (c.cost_usd || 0) > 0 ? ` · ${fmtUsd(c.cost_usd)}` : '';
    sub.textContent =
      `${c.model || '?'} · ${relTime(c.updated_at || 0)} · ` +
      `${c.events || 0} events${cost}`;
    const toks = (c.tokens_in || 0) + (c.tokens_out || 0);
    row.title = `${c.title || 'New conversation'} — ` +
      `${fmtUsd(c.cost_usd || 0)} · ${fmtTok(toks)} tok`;
    text.append(title, sub);
    row.appendChild(text);

    if (c.running || c.id === runningConvId) {
      const dot = document.createElement('span');
      dot.className = 'run-dot';
      dot.title = 'agent is working on this conversation';
      row.appendChild(dot);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'conv-del';
    del.textContent = '×';
    del.title = 'Delete conversation';
    del.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Delete “${c.title || 'this conversation'}”?`)) {
        deleteConversation(c.id);
      }
    };
    row.appendChild(del);

    row.onclick = () => {
      openConversation(c.id);
      convDrawer.hidden = true;
    };
    convList.appendChild(row);
  }
  updateConvCost();
}

function clearTranscript(title) {
  messagesEl.innerHTML = '';
  lastEntryKey = null;
  lastSeq = 0;
  convModel = null;
  awaitingAnswer = false;
  chatInput.placeholder = TASK_PLACEHOLDER;
  convTitleEl.textContent = title || 'New conversation';
  updateTyping();
}

async function openConversation(id) {
  activeConvId = id;
  localStorage.setItem(convKey(activeDev().id), id);
  convFetchId = id;
  pendingLive = [];
  try {
    const r = await apiFetch(`/api/conversations/${id}`);
    if (!r.ok) throw new Error(String(r.status));
    const c = await r.json();
    if (id !== activeConvId) return;  // user switched again mid-fetch
    clearTranscript(c.meta.title);
    convModel = c.meta.model || null;
    if (convModel) syncModel(convModel);
    for (const ev of c.events) {
      if (ev.seq) lastSeq = Math.max(lastSeq, ev.seq);
      renderEvent(ev, false);
    }
    const last = c.events[c.events.length - 1];
    if (c.meta.running) {
      if (!runningConvId) runningConvId = id;
      activityEl.textContent = `${agentName} · working`;
      // A question still waiting on a reply restores the pending state.
      if (last && last.type === 'question' && agentPhase === 'waiting_user') {
        awaitingAnswer = true;
        chatInput.placeholder = `Reply to ${agentName}…`;
      }
    }
    updateTyping();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (_) {
    if (id === activeConvId) clearTranscript('Conversation unavailable');
  } finally {
    if (convFetchId === id) {
      convFetchId = null;
      // Flush events that arrived while the fetch was in flight.
      for (const m of pendingLive) handleTranscriptEvent(m);
      pendingLive = [];
    }
  }
  renderConvList();
}

async function createConversation() {
  try {
    const r = await apiFetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelSelect.value || cfg.model }),
    });
    if (!r.ok) return null;
    const meta = await r.json();
    activeConvId = meta.id;
    localStorage.setItem(convKey(activeDev().id), meta.id);
    clearTranscript(meta.title);
    convModel = meta.model || null;
    loadConversations();
    return meta;
  } catch (_) {
    return null;
  }
}

async function deleteConversation(id) {
  try {
    const r = await apiFetch(`/api/conversations/${id}`,
                             { method: 'DELETE' });
    if (r.status === 409) {
      addMsg('error', 'that conversation is running — stop it first', 'Error');
      return;
    }
    if (id === activeConvId) {
      activeConvId = null;
      localStorage.removeItem(convKey(activeDev().id));
      clearTranscript();
    }
    loadConversations();
  } catch (_) { /* device unreachable */ }
}

// Event types the daemon persists into a conversation (mirrors the backend).
// Status/cost also carry conversation_id but are channel noise, not history.
const TRANSCRIPT_TYPES = new Set([
  'user', 'agent_msg', 'done', 'file', 'image',
  'thought', 'action', 'action_result', 'question', 'error',
]);

// A transcript event arrives tagged with (conversation_id, seq). Render it
// when viewing that conversation — deduped against replayed history — or
// nudge the drawer when it belongs to another conversation.
function handleTranscriptEvent(m) {
  if (m.conversation_id !== activeConvId) {
    scheduleConvReload();
    return;
  }
  if (convFetchId === activeConvId) {
    pendingLive.push(m);  // refetch in progress — replay will sort it out
    return;
  }
  if (m.seq == null || m.seq > lastSeq) {
    if (m.seq != null) lastSeq = m.seq;
    renderEvent(m, true);
  }
  if (m.type === 'done') scheduleConvReload();
}

// ── agent websocket ─────────────────────────────────────────────────────
function connectChat() {
  if (chatWs) { try { chatWs.close(); } catch (_) {} }
  chatWs = new WebSocket(wsUrl());

  chatWs.onclose = () => setTimeout(connectChat, 3000);
  chatWs.onerror = () => chatWs.close();

  chatWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.conversation_id && TRANSCRIPT_TYPES.has(m.type)) {
      handleTranscriptEvent(m);
      return;
    }
    switch (m.type) {
      case 'hello':
        runningConvId = m.running_conversation || null;
        setAgentState(m.state);
        if (m.model && (!activeConvId || runningConvId === activeConvId)) {
          syncModel(m.model);
        }
        // Resync the viewed conversation — events may have been missed
        // while the socket was down. Default to the running one.
        if (!activeConvId && runningConvId) activeConvId = runningConvId;
        if (activeConvId) openConversation(activeConvId);
        loadConversations();
        break;
      case 'status':
        runningConvId = m.state === 'idle'
          ? null : (m.conversation_id || runningConvId);
        setAgentState(m.state);
        if (m.model && (!activeConvId || runningConvId === activeConvId)) {
          syncModel(m.model);
        }
        // 'waiting_user' can coincide with a paused backend — only clear the
        // takeover banner when the agent is truly free-running or done.
        if (m.state === 'running' || m.state === 'idle') setTakeover(false, true);
        if (m.state === 'idle') scheduleConvReload();
        break;
      case 'conversations':
        scheduleConvReload();
        break;
      case 'cost':
        setCost(m);
        break;
      case 'error':
        addMsg('error', m.text, 'Error');
        break;
    }
  };
}

function send(msg) {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify(msg));
  } else {
    addMsg('error', 'not connected to agent', 'Error');
  }
}

// ── models ──────────────────────────────────────────────────────────────
let modelMeta = {};   // id -> {cost_in, cost_out, ctx, vision}

// "$3" / "$0.40" — LiteLLM costs are per token, shown per 1M tokens.
const per1M = (v) => v == null ? null
  : '$' + (v * 1e6).toFixed(v * 1e6 >= 10 ? 0 : 2);

const priceTag = (m) => {
  const a = per1M(m?.cost_in), b = per1M(m?.cost_out);
  return a && b ? `${a}/${b}` : a || b;
};

const modelNote = (id) =>
  (MODEL_NOTES.find(([re]) => re.test(String(id))) || [])[1];

const ctxTag = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

// One-line summary of the selected model: quality note + live metadata.
// Shown under the composer and as the picker's hover tooltip.
function updateModelInfo() {
  const id = modelSelect.value;
  const m = modelMeta[id] || {};
  const bits = [];
  const note = modelNote(id);
  if (note) bits.push(note);
  if (m.vision === true) bits.push('vision ✓');
  else if (m.vision === false) bits.push('no vision — blind');
  if (m.ctx) bits.push(`${ctxTag(m.ctx)} ctx`);
  const price = priceTag(m);
  if (price) bits.push(`${price} per 1M tok`);
  modelInfoEl.textContent = bits.join(' · ');
  modelSelect.title = bits.join(' · ') || 'Agent model';
}

function syncModel(current) {
  if (![...modelSelect.options].some(o => o.value === current)) {
    const o = document.createElement('option');
    o.value = o.textContent = current;
    modelSelect.appendChild(o);
  }
  modelSelect.value = current;
  setAgentName(current);
  updateModelInfo();
}

async function loadModels() {
  try {
    const r = await apiFetch('/api/models');
    // Older daemons return bare id strings — normalize to objects.
    const models = (await r.json())
      .map(m => typeof m === 'string' ? { id: m } : m);
    modelMeta = {};
    modelSelect.innerHTML = '';
    for (const m of models) {
      modelMeta[m.id] = m;
      const o = document.createElement('option');
      o.value = m.id;
      const price = priceTag(m);
      o.textContent = price ? `${m.id} · ${price}` : m.id;
      o.title = [modelNote(m.id), price && `${price} per 1M tok`]
        .filter(Boolean).join(' · ');
      modelSelect.appendChild(o);
    }
    // The select mirrors the viewed conversation's model; without an open
    // conversation it carries the preferred default for new ones.
    if (convModel) syncModel(convModel);
    else if (cfg.model && models.some(m => m.id === cfg.model))
      modelSelect.value = cfg.model;
    if (!activeConvId) send({ type: 'set_model', model: modelSelect.value });
    setAgentName(modelSelect.value);
    updateModelInfo();
  } catch (_) { /* agent not up yet */ }
}

modelSelect.onchange = () => {
  cfg.model = modelSelect.value;
  localStorage.setItem('gut.model', cfg.model);
  if (activeConvId) convModel = cfg.model;
  setAgentName(cfg.model);
  updateModelInfo();
  send({ type: 'set_model', model: cfg.model,
         conversation_id: activeConvId });
};

// ── devices ─────────────────────────────────────────────────────────────
function populateDeviceSelect() {
  deviceSelect.innerHTML = '';
  for (const d of cfg.devices) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name || d.host;
    deviceSelect.appendChild(o);
  }
  deviceSelect.value = activeDev().id;
}

function switchDevice(id) {
  cfg.activeDevice = id;
  saveDevices();
  const dev = activeDev();
  awaitingAnswer = false;
  runningConvId = null;
  convFetchId = null;
  pendingLive = [];
  conversations = [];
  activeConvId = localStorage.getItem(convKey(dev.id)) || null;
  clearTranscript();
  takenOver = false;
  takeoverBanner.hidden = true;
  takeoverLabel.textContent = 'Take over';
  takeoverBtn.classList.remove('active');
  document.body.classList.remove('takeover');
  costHist.length = 0;
  drawSpark();
  setAgentState('idle');
  populateDeviceSelect();
  connectDesktop();
  connectChat();
  loadModels();
  loadConversations();
}

deviceSelect.onchange = () => switchDevice(deviceSelect.value);

// ── human-in-the-loop takeover ──────────────────────────────────────────
function setTakeover(on, silent = false) {
  takenOver = on;
  takeoverBanner.hidden = !on;
  takeoverLabel.textContent = on ? 'Resume agent' : 'Take over';
  takeoverBtn.classList.toggle('active', on);
  document.body.classList.toggle('takeover', on);
  if (!silent) send({ type: 'control', action: on ? 'pause' : 'resume' });
}

takeoverBtn.onclick = () => setTakeover(!takenOver);
$('resumeBtn').onclick = () => setTakeover(false);
stopBtn.onclick = () => send({ type: 'control', action: 'stop' });

// Clicking or typing into the live screen takes control from the agent, so
// your input never fights an in-flight mouse/keyboard action.
function maybeAutoTakeover() {
  if (!takenOver && (agentPhase === 'running' || agentPhase === 'waiting_user')) {
    setTakeover(true);
  }
}
$('screen').addEventListener('pointerdown', maybeAutoTakeover, true);
$('screen').addEventListener('keydown', maybeAutoTakeover, true);

// ── chat form ───────────────────────────────────────────────────────────
// Every message runs on the selected device with the conversation's model.
// One agent per device: a busy device rejects (or the client short-circuits).
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (awaitingAnswer) {
    chatInput.value = '';
    awaitingAnswer = false;
    chatInput.placeholder = TASK_PLACEHOLDER;
    send({ type: 'answer', text });
    return;
  }
  // Rejected sends keep the draft so it isn't lost.
  if (agentPhase !== 'idle') {
    addMsg('error',
      runningConvId && runningConvId !== activeConvId
        ? `${activeDev().name} is busy on “${convTitle(runningConvId)}” — ` +
          'stop it there or pick another device'
        : 'the agent is still working — stop it or wait',
      'Error');
    return;
  }
  if (!activeConvId) {
    const meta = await createConversation();
    if (!meta) {
      addMsg('error', `could not reach ${activeDev().name} — check the device`,
        'Error');
      return;
    }
  }
  chatInput.value = '';
  // Rendered when the daemon echoes the stored event back over the socket.
  send({ type: 'task', conversation_id: activeConvId, text });
};

// ── conversation drawer ─────────────────────────────────────────────────
$('convBtn').onclick = () => {
  convDrawer.hidden = !convDrawer.hidden;
  if (!convDrawer.hidden) loadConversations();
};

$('newConvBtn').onclick = async () => {
  const meta = await createConversation();
  if (meta) convDrawer.hidden = true;
  else addMsg('error', `could not reach ${activeDev().name}`, 'Error');
};

// ── verbose working log ─────────────────────────────────────────────────
// Quiet by default: the chat shows only what the agent deliberately sends.
// Verbose reveals the full working log (thoughts, tool calls, results).
verboseToggle.checked = cfg.verbose;
document.body.classList.toggle('verbose', cfg.verbose);
verboseToggle.onchange = () => {
  cfg.verbose = verboseToggle.checked;
  localStorage.setItem('gut.verbose', cfg.verbose ? '1' : '0');
  document.body.classList.toggle('verbose', cfg.verbose);
};

// ── electron: local desktop ─────────────────────────────────────────────
// window.gut exists only inside the Electron shell; it manages a local
// Docker stack on this machine (see electron/localstack.js).
const gut = window.gut || null;
const localBox = $('localBox');
const localStatusEl = $('localStatus');
const localActionBtn = $('localAction');
const localStopBtn = $('localStop');
const localLogEl = $('localLog');
let localState = null;

const KEY_INPUTS = {
  ANTHROPIC_API_KEY: $('keyAnthropic'),
  OPENAI_API_KEY: $('keyOpenai'),
  GEMINI_API_KEY: $('keyGemini'),
  OPENROUTER_API_KEY: $('keyOpenrouter'),
};

function notify(title, text) {
  if (!gut || !document.hidden || typeof Notification === 'undefined') return;
  try { new Notification(title, { body: String(text).slice(0, 200) }); }
  catch (_) { /* notification permission or platform unavailable */ }
}

async function refreshLocal() {
  if (!gut) return;
  localBox.hidden = false;
  localState = await gut.localStatus();
  const set = await gut.localKeys();
  for (const [k, input] of Object.entries(KEY_INPUTS)) {
    input.placeholder = set[k] ? '•••••• set' : 'not set';
  }
  if (localState.runtime === 'missing') {
    localStatusEl.textContent =
      'Docker not found — needed to run a desktop on this machine.';
    localActionBtn.textContent = 'Install container runtime';
    localStopBtn.hidden = true;
  } else if (localState.stack === 'running') {
    localStatusEl.textContent = `Local desktop is running (${localState.image}).`;
    localActionBtn.textContent = 'Reconnect';
    localStopBtn.hidden = false;
  } else {
    localStatusEl.textContent = 'Docker is ready — start the local desktop.';
    localActionBtn.textContent = 'Start local desktop';
    localStopBtn.hidden = true;
  }
}

function upsertLocalDevice(host, password) {
  let d = cfg.devices.find(d => d.id === 'local');
  if (!d) {
    d = { id: 'local' };
    cfg.devices.push(d);
  }
  Object.assign(d, { name: 'Local', host, vncPassword: password });
  saveDevices();
  populateDeviceSelect();
  switchDevice('local');
}

if (gut) {
  gut.onLocalLog((line) => {
    localLogEl.hidden = false;
    localLogEl.textContent += `${line}\n`;
    localLogEl.scrollTop = localLogEl.scrollHeight;
  });

  localActionBtn.onclick = async () => {
    if (!localState) return;
    localActionBtn.disabled = true;
    localLogEl.hidden = false;
    localLogEl.textContent = '';
    try {
      if (localState.runtime === 'missing') {
        const r = await gut.installRuntime();
        if (r.needsManual) {
          localStatusEl.textContent =
            'Docker install docs opened — install it, then click again.';
        } else if (!r.ok) {
          localStatusEl.textContent = `Install failed: ${r.error}`;
        }
      } else if (localState.stack === 'running') {
        switchDevice('local');
      } else {
        const keys = {};
        for (const [k, input] of Object.entries(KEY_INPUTS)) {
          if (input.value.trim()) keys[k] = input.value.trim();
        }
        localStatusEl.textContent = 'Starting local desktop…';
        const r = await gut.startLocal(keys);
        if (r.ok) {
          upsertLocalDevice(r.host, r.password);
          for (const input of Object.values(KEY_INPUTS)) input.value = '';
        } else {
          localStatusEl.textContent = `Start failed: ${r.error || 'see log'}`;
        }
      }
    } finally {
      localActionBtn.disabled = false;
      refreshLocal();
    }
  };

  localStopBtn.onclick = async () => {
    localStatusEl.textContent = 'Stopping…';
    await gut.stopLocal();
    refreshLocal();
  };
}

// ── settings / device manager ───────────────────────────────────────────
// editingDevId === null means the form is in "new device" mode.
let editingDevId = null;

function fillDeviceForm(d) {
  editingDevId = d.id;
  devNameInput.value = d.name;
  hostInput.value = d.host;
  vncPassInput.value = d.vncPassword;
  renderDeviceList();
}

function newDeviceForm() {
  editingDevId = null;
  devNameInput.value = '';
  hostInput.value = '';
  vncPassInput.value = '';
  renderDeviceList();
  devNameInput.focus();
}

function renderDeviceList() {
  const editing = cfg.devices.find(d => d.id === editingDevId);
  devFormTitle.textContent = editing
    ? `Editing ${editing.name}` : 'New device';
  saveSettingsBtn.textContent = !editing ? 'Add device'
    : editing.id === activeDev().id ? 'Save & reconnect' : 'Save changes';
  newDevBtn.classList.toggle('active', !editing);
  deviceListEl.innerHTML = '';
  for (const d of cfg.devices) {
    const row = document.createElement('div');
    row.className = 'dev-row' + (d.id === editingDevId ? ' editing' : '');
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'dev-label';
    label.textContent = `${d.name} — ${d.host}`;
    if (d.id === activeDev().id) {
      const tag = document.createElement('span');
      tag.className = 'dev-active';
      tag.textContent = 'in use';
      label.appendChild(tag);
    }
    label.onclick = () => fillDeviceForm(d);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dev-del';
    del.textContent = '×';
    del.title = 'Remove device';
    del.onclick = () => removeDevice(d.id);
    row.append(label, del);
    deviceListEl.appendChild(row);
  }
}

function removeDevice(id) {
  const wasActive = id === activeDev().id;
  cfg.devices = cfg.devices.filter(d => d.id !== id);
  if (!cfg.devices.length) {
    cfg.devices.push({ id: 'local', name: 'Local',
      host: location.hostname || '127.0.0.1', vncPassword: '' });
  }
  if (editingDevId === id) editingDevId = null;
  if (wasActive) cfg.activeDevice = cfg.devices[0].id;
  saveDevices();
  populateDeviceSelect();
  renderDeviceList();
  if (wasActive) switchDevice(cfg.activeDevice);
}

$('settingsBtn').onclick = () => {
  fillDeviceForm(activeDev());
  refreshLocal();
  settingsDialog.showModal();
};

document.querySelectorAll('.preset').forEach(btn => {
  btn.onclick = () => {
    hostInput.value = btn.dataset.host || '';
    if (!btn.dataset.host) hostInput.focus();
  };
});

newDevBtn.onclick = newDeviceForm;
$('cancelSettings').onclick = () => settingsDialog.close();

$('settingsForm').addEventListener('submit', () => {
  const fields = {
    name: devNameInput.value.trim() || hostInput.value.trim() || 'Device',
    host: hostInput.value.trim() || '127.0.0.1',
    vncPassword: vncPassInput.value,
  };
  if (!editingDevId) {
    // "New device" mode. randomUUID needs a secure context — plain-http
    // LAN UIs fall back.
    const id = crypto.randomUUID ? crypto.randomUUID()
      : `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const d = { id, ...fields };
    cfg.devices.push(d);
    saveDevices();
    populateDeviceSelect();
    switchDevice(d.id);
    return;
  }
  const d = cfg.devices.find(d => d.id === editingDevId);
  if (!d) return;
  const wasActive = d.id === activeDev().id;
  Object.assign(d, fields);
  saveDevices();
  populateDeviceSelect();
  if (wasActive) {
    connectDesktop();
    connectChat();
    loadModels();
    loadConversations();
  }
});

// ── chat pane width ─────────────────────────────────────────────────────
// The pane is widened with the CSS `resize` handle, which fires no events —
// observe its box instead and persist the result across reloads.
const savedChatW = +localStorage.getItem('gut.chatWidth') || 0;
if (savedChatW) chatPane.style.width = savedChatW + 'px';
let chatWTimer;
new ResizeObserver(() => {
  clearTimeout(chatWTimer);
  chatWTimer = setTimeout(
    () => localStorage.setItem('gut.chatWidth', chatPane.offsetWidth), 200);
}).observe(chatPane);

// ── boot ────────────────────────────────────────────────────────────────
activeConvId = localStorage.getItem(convKey(activeDev().id)) || null;
populateDeviceSelect();
connectDesktop();
connectChat();
loadConversations();
setInterval(loadModels, 30000);
setTimeout(loadModels, 1500);

// Electron first-run: nothing running yet → drop straight into the local
// desktop setup panel.
if (gut) {
  refreshLocal().then(() => {
    if (localState && localState.stack !== 'running' && cfg.devices.length <= 1) {
      fillDeviceForm(activeDev());
      settingsDialog.showModal();
    }
  });
}
