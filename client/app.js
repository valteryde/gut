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
const takeoverBanner = $('takeoverBanner');
const convTitleEl = $('convTitle');
const chatInput = $('chatInput');
const screenStatusEl = $('screenStatus');
const deviceSelect = $('deviceSelect');
const modelSelect = $('modelSelect');
const modelInfoEl = $('modelInfo');
const settingsPage = $('settingsPage');
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
  document.body.classList.toggle('takeover', on);
  if (!silent) send({ type: 'control', action: on ? 'pause' : 'resume' });
}

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
// The composer grows with the draft up to a cap, then scrolls.
const CHAT_INPUT_MAX_H = 160;
function autosizeChatInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height =
    Math.min(chatInput.scrollHeight, CHAT_INPUT_MAX_H) + 'px';
}
chatInput.addEventListener('input', autosizeChatInput);
// Enter sends, Shift+Enter inserts a newline.
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('chatForm').requestSubmit();
  }
});

// Every message runs on the selected device with the conversation's model.
// One agent per device: a busy device rejects (or the client short-circuits).
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (awaitingAnswer) {
    chatInput.value = '';
    autosizeChatInput();
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
  autosizeChatInput();
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
if (gut) {
  document.body.classList.add('is-electron');
  if (gut.platform === 'darwin') document.body.classList.add('is-mac');
}
const localBox = $('localBox');
const localStatusEl = $('localStatus');
const localActionBtn = $('localAction');
const localRestartBtn = $('localRestart');
const localStopBtn = $('localStop');
const localLogEl = $('localLog');
let localState = null;
let localKeysSet = {};
// Sticky status line — refreshLocal() keeps showing it until the next
// action, so failures aren't wiped by the refresh that follows them.
let localNote = null;

// Provider keys for the local stack — one card per vendor (mirrors
// PROVIDER_KEYS in electron/localstack.js; logos are the simple-icons
// marks). Each card leads with the vendor's logo and the models its key
// unlocks; "Add key" expands an inline paste field that writes straight
// into the stack's .env via IPC — no desktop start required.
const PROVIDERS = [
  { key: 'ANTHROPIC_API_KEY', name: 'Anthropic',
    models: 'Claude Sonnet 4.5 · Haiku 4.5',
    icon: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z' },
  { key: 'OPENAI_API_KEY', name: 'OpenAI',
    models: 'GPT-5 · GPT-4o',
    icon: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z' },
  { key: 'GEMINI_API_KEY', name: 'Gemini',
    models: 'Gemini 2.5 Pro · Flash',
    icon: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81' },
  { key: 'DEEPSEEK_API_KEY', name: 'DeepSeek',
    models: 'DeepSeek Chat — text only',
    icon: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45' },
  { key: 'OPENROUTER_API_KEY', name: 'OpenRouter',
    models: 'Claude · GPT · Qwen via one key',
    icon: 'M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z' },
];

const keysBox = $('keysBox');
const providerGrid = $('providerGrid');
const providerCards = {};
let editingKey = null;

function provBtn(text, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = text;
  return b;
}

async function saveProviderKey(key, value) {
  try {
    localKeysSet = await gut.saveLocalKeys({ [key]: value });
  } catch (e) {
    localNote = `Could not save the key: ${e?.message || 'error'}`;
    refreshLocal();
  }
  editingKey = null;
  renderProviderKeys();
}

function renderProviderKeys() {
  for (const p of PROVIDERS) {
    const c = providerCards[p.key];
    const set = !!localKeysSet[p.key];
    const editing = editingKey === p.key;
    c.state.textContent = set ? 'Key saved' : 'No key';
    c.state.classList.toggle('set', set);
    // A refresh mid-edit must not wipe the paste field.
    if (editing && c.actions.querySelector('.prov-key-input')) continue;
    c.actions.innerHTML = '';
    if (editing) {
      const input = document.createElement('input');
      input.className = 'prov-key-input';
      input.dataset.envKey = p.key;
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = `Paste your ${p.name} key…`;
      const save = provBtn('Save', 'primary');
      const cancel = provBtn('Cancel', 'ghost');
      const commit = () => {
        const v = input.value.trim();
        if (v) saveProviderKey(p.key, v);
        else { editingKey = null; renderProviderKeys(); }
      };
      save.onclick = commit;
      cancel.onclick = () => { editingKey = null; renderProviderKeys(); };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') {
          e.stopPropagation();  // don't close the page too
          editingKey = null;
          renderProviderKeys();
        }
      };
      c.actions.append(input, save, cancel);
      input.focus();
    } else if (set) {
      const replace = provBtn('Replace');
      replace.onclick = () => { editingKey = p.key; renderProviderKeys(); };
      const remove = provBtn('Remove', 'danger');
      remove.onclick = () => {
        if (confirm(`Remove the ${p.name} key? Its models stop working ` +
                   'the next time the local desktop starts.')) {
          saveProviderKey(p.key, '');
        }
      };
      c.actions.append(replace, remove);
    } else {
      const add = provBtn(`Add ${p.name} key`);
      add.classList.add('grow');
      add.onclick = () => { editingKey = p.key; renderProviderKeys(); };
      c.actions.append(add);
    }
  }
}

for (const p of PROVIDERS) {
  const card = document.createElement('div');
  card.className = 'prov-card';
  card.innerHTML =
    `<div class="prov-head">` +
    `<svg class="prov-logo" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="${p.icon}"/></svg>` +
    `<div class="prov-id"><div class="prov-name">${p.name}</div>` +
    `<div class="prov-models">${p.models}</div></div>` +
    `<span class="prov-state"></span></div>` +
    `<div class="prov-actions"></div>`;
  providerGrid.appendChild(card);
  providerCards[p.key] = {
    state: card.querySelector('.prov-state'),
    actions: card.querySelector('.prov-actions'),
  };
}

function notify(title, text) {
  if (!gut || !document.hidden || typeof Notification === 'undefined') return;
  try { new Notification(title, { body: String(text).slice(0, 200) }); }
  catch (_) { /* notification permission or platform unavailable */ }
}

async function refreshLocal() {
  if (!gut) return;
  localBox.hidden = false;
  keysBox.hidden = false;
  localState = await gut.localStatus();
  localKeysSet = await gut.localKeys();
  renderProviderKeys();
  if (localState.runtime === 'missing') {
    localStatusEl.textContent = localNote ||
      'Docker not found — needed to run a desktop on this machine.';
    localActionBtn.textContent = 'Install container runtime';
    localStopBtn.hidden = true;
    localRestartBtn.hidden = true;
  } else if (localState.stack === 'running') {
    localStatusEl.textContent = localNote ||
      `Local desktop is running (${localState.image})` +
      (localState.agent === false ? ' — agent not answering on :8000' : '') +
      '.';
    localActionBtn.textContent = 'Reconnect';
    localStopBtn.hidden = false;
    localRestartBtn.hidden = false;
  } else {
    localStatusEl.textContent = localNote ||
      'Docker is ready — start the local desktop.';
    localActionBtn.textContent = 'Start local desktop';
    localStopBtn.hidden = true;
    localRestartBtn.hidden = true;
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

// ── electron: app updates ───────────────────────────────────────────────
// Custom updater (electron/updater.js): downloads the release zip, swaps
// the .app, relaunches — no Apple developer account needed.
const updateBox = $('updateBox');
const updateStatusEl = $('updateStatus');
const updateActionBtn = $('updateAction');
const updateBar = $('updateBar');
const updateFill = $('updateFill');
const settingsDot = $('settingsDot');
let lastUpdateState = null;

function renderUpdateState(s) {
  if (!gut || !s) return;
  lastUpdateState = s;
  updateBox.hidden = false;
  updateBar.hidden = s.status !== 'downloading';
  updateActionBtn.disabled = s.status === 'checking' || s.status === 'downloading';
  settingsDot.hidden = !(s.status === 'available' || s.status === 'downloaded');
  switch (s.status) {
    case 'checking':
      updateStatusEl.textContent = 'Checking for updates…';
      break;
    case 'none':
      updateStatusEl.textContent = 'gut is up to date.';
      updateActionBtn.textContent = 'Check again';
      break;
    case 'available':
      updateStatusEl.textContent = `gut v${s.version} is available.`;
      updateActionBtn.textContent = 'Download update';
      break;
    case 'downloading': {
      const p = s.progress || {};
      updateFill.style.width = `${p.percent || 0}%`;
      const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;
      updateStatusEl.textContent = p.total
        ? `Downloading update — ${mb(p.transferred)} / ${mb(p.total)}`
        : 'Downloading update…';
      updateActionBtn.textContent = 'Downloading…';
      break;
    }
    case 'downloaded':
      updateStatusEl.textContent = `gut v${s.version || ''} downloaded — restart to apply.`;
      updateActionBtn.textContent = 'Restart & update';
      break;
    case 'error':
      updateStatusEl.textContent = `Update failed: ${s.error}`;
      updateActionBtn.textContent = 'Retry';
      break;
    default:
      updateStatusEl.textContent = 'Updates are checked in released builds.';
      updateActionBtn.textContent = 'Check for updates';
  }
}

if (gut) {
  gut.onUpdateState(renderUpdateState);
  gut.updateState().then(renderUpdateState);
  updateActionBtn.onclick = () => {
    const s = lastUpdateState?.status;
    if (s === 'downloaded') gut.installUpdate();
    else if (s === 'available') gut.downloadUpdate();
    else gut.checkUpdate();
  };
  gut.onLocalLog((line) => {
    localLogEl.hidden = false;
    localLogEl.textContent += `${line}\n`;
    localLogEl.scrollTop = localLogEl.scrollHeight;
  });

  localActionBtn.onclick = async () => {
    if (!localState) return;
    localActionBtn.disabled = true;
    localNote = null;
    localLogEl.hidden = false;
    localLogEl.textContent = '';
    try {
      if (localState.runtime === 'missing') {
        const r = await gut.installRuntime();
        if (r.needsManual) {
          localNote =
            'Docker install docs opened — install it, then click again.';
        } else if (!r.ok) {
          localNote = `Install failed: ${r.error}`;
        }
      } else if (localState.stack === 'running') {
        switchDevice('local');
      } else {
        // Any key still sitting in an open paste field goes along too —
        // start() writes it into .env before bringing the stack up.
        const keys = {};
        for (const input of providerGrid.querySelectorAll('.prov-key-input')) {
          const v = input.value.trim();
          if (v) keys[input.dataset.envKey] = v;
        }
        localStatusEl.textContent = 'Starting local desktop…';
        const r = await gut.startLocal(keys);
        if (r.ok) {
          upsertLocalDevice(r.host, r.password);
          editingKey = null;
        } else {
          localNote = `Start failed: ${r.error || 'see log'}`;
        }
      }
    } finally {
      localActionBtn.disabled = false;
      refreshLocal();
    }
  };

  localStopBtn.onclick = async () => {
    localNote = null;
    localStatusEl.textContent = 'Stopping…';
    await gut.stopLocal();
    refreshLocal();
  };

  localRestartBtn.onclick = async () => {
    localRestartBtn.disabled = true;
    localNote = null;
    localStatusEl.textContent = 'Restarting the local stack…';
    localLogEl.hidden = false;
    localLogEl.textContent = '';
    try {
      const r = await gut.restartLocal();
      if (!r?.ok) {
        localNote = `Restart failed: ${r?.error || 'see log'}`;
      }
    } finally {
      localRestartBtn.disabled = false;
      refreshLocal();
    }
  };
}

// ── backend versions & updates ──────────────────────────────────────────
// Each device row is probed against the backend's public /api/version and
// compared with the latest GitHub release (one tag drives the app, the
// docker image and the deb). Where the install kind allows it the row gets
// an update button: deb backends self-update via POST /api/update, the
// Electron-managed local stack pulls a new image.
const devInfo = {};        // id -> {version, install, offline, updating, …}
let latestRelease = null;  // {version, url}

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function devFetch(d, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (d.vncPassword) headers.Authorization = `Bearer ${d.vncPassword}`;
  return fetch(`${httpScheme}://${d.host}:${AGENT_PORT}${path}`,
               { ...opts, headers });
}

async function probeDevice(d) {
  // Mutate in place — a row may carry UI state (updating, updateError) that
  // a probe must not wipe.
  const cur = devInfo[d.id] || (devInfo[d.id] = {});
  cur.pending = true;
  try {
    const r = await devFetch(d, '/api/version');
    if (r.ok) {
      const j = await r.json();
      Object.assign(cur, { version: j.version, install: j.install,
                           device: j.device, offline: false });
      delete cur.legacy;
    } else {
      // Any HTTP answer means the backend is alive — daemons older than
      // this route just report "online", no version.
      Object.assign(cur, { offline: false, legacy: true });
      delete cur.version;
    }
  } catch (_) {
    cur.offline = true;
  }
  cur.pending = false;
}

async function checkLatestRelease() {
  try {
    const r = await fetch(
      'https://api.github.com/repos/valteryde/gut/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (version) latestRelease = { version, url: rel.html_url };
  } catch (_) { /* offline or rate-limited */ }
}

function refreshDeviceInfo() {
  Promise.all([checkLatestRelease(), ...cfg.devices.map(probeDevice)])
    .then(() => { if (settingsOpen()) renderDeviceList(); });
}

// The update affordance for a device row, or null when nothing applies.
function deviceUpdate(d, info) {
  if (!info || info.offline || !info.version) return null;
  if (info.updating) {
    return { label: `${info.updateState || 'updating'}…`, enabled: false };
  }
  const isLocalDocker = gut && d.id === 'local' && info.install === 'docker';
  if (isLocalDocker) {
    const tag = (localState?.image || '').split(':').pop();
    if (tag && tag !== 'latest' && semverGt(tag, info.version)) {
      return { label: `↑ v${tag}`, enabled: true,
        title: `Pull the v${tag} desktop image and restart the local stack` };
    }
    return null;
  }
  if (!latestRelease || !semverGt(latestRelease.version, info.version)) {
    return null;
  }
  if (info.install === 'deb') {
    return { label: `↑ v${latestRelease.version}`, enabled: true,
      title: `Install gut-bot v${latestRelease.version} on ${d.host} — ` +
             'the device disconnects for a moment while services restart' };
  }
  return { label: `v${latestRelease.version} out`, enabled: false,
    title: 'Update the image or package on the host — this install kind ' +
           'cannot self-update' };
}

async function updateDevice(d) {
  const info = devInfo[d.id];
  if (!info || info.updating) return;
  const isLocalDocker = gut && d.id === 'local' && info.install === 'docker';
  const target = isLocalDocker
    ? (localState?.image || '').split(':').pop()
    : latestRelease?.version;
  if (!target) return;
  info.updating = true;
  delete info.updateError;
  renderDeviceList();
  try {
    if (isLocalDocker) {
      const r = await gut.updateLocal();
      if (!r?.ok) throw new Error(r?.error || 'update failed');
    } else {
      const r = await devFetch(d, '/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: target }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${r.status}`);
      }
    }
    await waitForVersion(d, target, info);
  } catch (e) {
    info.updateError = e.message || 'update failed';
  } finally {
    info.updating = false;
    delete info.updateState;
    await probeDevice(d);
    if (settingsOpen()) renderDeviceList();
  }
}

// The daemon drops mid-update while its services restart — poll the public
// version endpoint until it answers on the target (or give up).
async function waitForVersion(d, target, info) {
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    let failed = null;
    try {
      const r = await devFetch(d, '/api/update');
      if (r.ok) {
        const s = await r.json();
        if (s.state && s.state !== 'idle') info.updateState = s.state;
        if (s.state === 'failed') failed = s.error || 'update failed';
      }
      await probeDevice(d);
    } catch (_) { /* device down mid-restart — keep polling */ }
    if (settingsOpen()) renderDeviceList();
    if (failed) throw new Error(failed);
    if (devInfo[d.id]?.version === target) return;
  }
  throw new Error('timed out — the device may still be updating');
}

// ── settings / device manager ───────────────────────────────────────────
// Settings is a page, not a modal: it swaps in for the chat/desktop panes
// so the sections (keys, local stack, devices) get the full window width.
const settingsOpen = () => !settingsPage.hidden;

function openSettings() {
  settingsPage.hidden = false;
  document.body.classList.add('settings-open');
}

function closeSettings() {
  settingsPage.hidden = true;
  document.body.classList.remove('settings-open');
}

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
    const info = devInfo[d.id];
    if (!info) {
      // Lazily probe rows rendered before the settings-open refresh lands.
      probeDevice(d).then(() => {
        if (settingsOpen()) renderDeviceList();
      });
    }
    const ver = document.createElement('span');
    ver.className = 'dev-ver';
    ver.textContent = info?.offline ? '· offline'
      : info?.version ? `· v${info.version}`
      : info?.legacy ? '· online' : '';
    label.appendChild(ver);
    if (d.id === activeDev().id) {
      const tag = document.createElement('span');
      tag.className = 'dev-active';
      tag.textContent = 'in use';
      label.appendChild(tag);
    }
    label.onclick = () => fillDeviceForm(d);
    row.appendChild(label);
    const upd = deviceUpdate(d, info);
    if (upd) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'dev-update';
      up.textContent = upd.label;
      up.title = upd.title || '';
      up.disabled = !upd.enabled;
      if (info?.updateError) {
        up.title = `last attempt failed: ${info.updateError}`;
        up.classList.add('failed');
      }
      up.onclick = (e) => { e.stopPropagation(); updateDevice(d); };
      row.appendChild(up);
    }
    if (gut && d.id === 'local') {
      const rst = document.createElement('button');
      rst.type = 'button';
      rst.className = 'dev-update';
      rst.textContent = info?.restarting ? 'restarting…' : 'restart';
      rst.disabled = !!info?.restarting;
      rst.title = 'Restart the local backend stack';
      if (info?.restartError) {
        rst.title = `last attempt failed: ${info.restartError}`;
        rst.classList.add('failed');
      }
      rst.onclick = (e) => { e.stopPropagation(); restartLocalBackend(); };
      row.appendChild(rst);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dev-del';
    del.textContent = '×';
    del.title = 'Remove device';
    del.onclick = () => removeDevice(d.id);
    row.appendChild(del);
    deviceListEl.appendChild(row);
  }
}

// The Local row's restart button bounces whichever compose stack owns the
// desktop container — the repo's dev `gut` or the generated `gut-local`.
async function restartLocalBackend() {
  const info = devInfo.local = devInfo.local || {};
  if (info.restarting) return;
  info.restarting = true;
  delete info.restartError;
  renderDeviceList();
  try {
    const r = await gut.restartLocal();
    if (!r?.ok) info.restartError = r?.error || 'restart failed';
  } catch (e) {
    info.restartError = e?.message || 'restart failed';
  } finally {
    info.restarting = false;
    const d = cfg.devices.find(x => x.id === 'local');
    if (d) await probeDevice(d);
    if (settingsOpen()) renderDeviceList();
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
  if (settingsOpen()) { closeSettings(); return; }
  fillDeviceForm(activeDev());
  refreshLocal();
  refreshDeviceInfo();
  openSettings();
};

$('settingsBack').onclick = closeSettings;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsOpen() && !editingKey) closeSettings();
});

document.querySelectorAll('.preset[data-host]').forEach(btn => {
  btn.onclick = () => {
    hostInput.value = btn.dataset.host || '';
    if (!btn.dataset.host) hostInput.focus();
  };
});

newDevBtn.onclick = newDeviceForm;

$('devForm').addEventListener('submit', (e) => {
  e.preventDefault();
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
    newDeviceForm();  // the page stays open — reset for the next add
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
  renderDeviceList();
});

// ── chat pane width ─────────────────────────────────────────────────────
// The pane is widened with the CSS `resize` handle, which fires no events —
// observe its box instead and persist the result across reloads.
const savedChatW = +localStorage.getItem('gut.chatWidth') || 0;
if (savedChatW) chatPane.style.width = savedChatW + 'px';
let chatWTimer;
new ResizeObserver(() => {
  clearTimeout(chatWTimer);
  chatWTimer = setTimeout(() => {
    // The pane reports 0 while the settings page hides it — don't persist that.
    if (chatPane.offsetWidth)
      localStorage.setItem('gut.chatWidth', chatPane.offsetWidth);
  }, 200);
}).observe(chatPane);

// ── boot ────────────────────────────────────────────────────────────────
activeConvId = localStorage.getItem(convKey(activeDev().id)) || null;
populateDeviceSelect();
connectDesktop();
connectChat();
loadConversations();
setInterval(loadModels, 30000);
setTimeout(loadModels, 1500);

// Electron first-run: nothing configured yet → drop straight into the local
// desktop setup panel. "Configured" = a provider key was saved or the device
// list was touched — without that, a stopped stack pops this on every launch.
if (gut) {
  refreshLocal().then(() => {
    const fresh = !localStorage.getItem('gut.devices') &&
      !Object.values(localKeysSet).some(Boolean);
    if (fresh && localState && localState.stack !== 'running') {
      fillDeviceForm(activeDev());
      openSettings();
    }
  });
}
