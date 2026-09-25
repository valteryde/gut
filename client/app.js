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

// The installer prints full URLs (http://host:8000) and users paste them —
// keep only the hostname. Ports are fixed by AGENT_PORT/NOVNC_PORT below.
function normalizeHost(h) {
  return String(h || '').trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
}

function loadDevices() {
  try {
    const devs = JSON.parse(localStorage.getItem('gut.devices') || 'null');
    if (Array.isArray(devs) && devs.length) {
      for (const d of devs) d.host = normalizeHost(d.host);
      return devs;
    }
  } catch (_) { /* fall through to migration */ }
  // Migrate the legacy single-host settings into a first device.
  return [{
    id: 'local',
    name: 'Local',
    host: normalizeHost(localStorage.getItem('gut.host'))
      || location.hostname || '127.0.0.1',
    vncPassword: localStorage.getItem('gut.vncPassword') || '',
  }];
}

function saveDevices() {
  // _-prefixed fields (_hsPending, _tlsRefused) are session state — a
  // persisted _hsPending would block TLS re-pairing forever after reload.
  localStorage.setItem('gut.devices', JSON.stringify(cfg.devices,
    (k, v) => (k.startsWith('_') ? undefined : v)));
  localStorage.setItem('gut.activeDevice', cfg.activeDevice);
}

function activeDev() {
  const d = cfg.devices.find(d => d.id === cfg.activeDevice) || cfg.devices[0];
  cfg.activeDevice = d.id;
  return d;
}

const AGENT_PORT = 8000;
const NOVNC_PORT = 6080;
const AGENT_TLS_PORT = 8443;
const NOVNC_TLS_PORT = 6443;

// Transport is per-device: d.secure (set by ensureSecure, which pairs and
// pins the backend's self-signed cert via the Electron bridge) flips every
// endpoint to https/wss on the TLS ports. Plain HTTP remains only for
// pre-TLS backends and non-Electron dev mode.
const devAgentBase = (d) => (d.secure
  ? `https://${d.host}:${d.tlsPort || AGENT_TLS_PORT}`
  : `http://${d.host}:${AGENT_PORT}`);
const agentBase = () => devAgentBase(activeDev());
// The device password doubles as the agent API token — one secret per
// backend, set by gut-bot/Electron at install time.
const wsUrl = () => {
  const d = activeDev();
  const t = d.vncPassword;
  return `${d.secure ? 'wss' : 'ws'}://${d.host}:` +
    `${d.secure ? (d.tlsPort || AGENT_TLS_PORT) : AGENT_PORT}/ws/chat` +
    (t ? `?token=${encodeURIComponent(t)}` : '');
};
const novncUrl = (d) => `${d.secure ? 'wss' : 'ws'}://${d.host}:` +
  `${d.secure ? (d.tlsVncPort || NOVNC_TLS_PORT) : NOVNC_PORT}/websockify`;

// ── transport security ──────────────────────────────────────────────────
// Once a device proves it can do TLS (tlsSeen), its password never crosses
// plaintext again — a network attacker can strip the /api/hello bootstrap
// to force a downgrade, so falling back silently would leak it. insecureOk
// is the user's explicit per-device consent to that fallback.
function maySendSecret(d) {
  return d.secure || !d.tlsSeen || !!d.insecureOk;
}

// Pair + pin the backend's cert. Returns true when TLS is usable; also
// heals cert rotation automatically (the handshake is password-checked,
// so a re-pin is safe without user confirmation).
async function ensureSecure(d) {
  if (!gut?.tlsHandshake) return false;
  // Concurrent callers (probe timer, connect paths) share one handshake.
  if (d._hsPending) return d._hsPending;
  d._hsPending = (async () => {
    let r = null;
    try { r = await gut.tlsHandshake(d.host, d.vncPassword || ''); }
    catch (_) { /* bridge missing */ }
    if (r?.ok) {
      Object.assign(d, { secure: true, tlsSeen: true,
                         tlsPort: r.port, tlsVncPort: r.vncPort });
      delete d.insecureOk;
      delete d.tlsError;
      saveDevices();
      return true;
    }
    d.secure = false;
    d.tlsError = (r && (r.error || (r.unsupported && 'backend predates TLS')))
      || 'no answer';
    saveDevices();
    return false;
  })();
  try {
    return await d._hsPending;
  } finally {
    delete d._hsPending;
  }
}

// Connect-time gate for user-driven switches: pair TLS, and if the device
// *previously* encrypted but can't now, ask before going plaintext.
async function gateConnection(d) {
  if (!gut?.tlsHandshake) return true;   // browser dev: plain by design
  await ensureSecure(d);
  if (maySendSecret(d)) return true;
  if (d._tlsRefused) return false;
  if (confirm(`“${d.name || d.host}” used an encrypted connection but its ` +
      `secure endpoint isn't answering now (${d.tlsError || 'unreachable'}). ` +
      'A network attacker can cause this.\n\n' +
      'Connect over unencrypted HTTP anyway?')) {
    d.insecureOk = true;
    saveDevices();
    return true;
  }
  d._tlsRefused = true;
  addMsg('error', `Not connecting to ${d.name || d.host}: the encrypted ` +
    'endpoint is unavailable and unencrypted fallback was declined. ' +
    'Re-save the device in Settings to try again.', 'Error');
  return false;
}

function apiFetch(path, opts = {}) {
  const d = activeDev();
  const headers = { ...(opts.headers || {}) };
  if (d.vncPassword && maySendSecret(d)) {
    headers.Authorization = `Bearer ${d.vncPassword}`;
  }
  return fetch(`${devAgentBase(d)}${path}`, { ...opts, headers });
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
  [/^compat\//i, 'self-hosted — quality varies'],
  [/ollama|local/i, 'free + self-hosted, weakest'],
];

const TASK_PLACEHOLDER = 'Describe a task…';
const QUEUE_PLACEHOLDER =
  'Queue a message — ⌘/Ctrl+Enter sends it to the agent now…';

function syncPlaceholder() {
  chatInput.placeholder = awaitingAnswer
    ? `Reply to ${agentName}…`
    : agentPhase === 'idle' ? TASK_PLACEHOLDER : QUEUE_PLACEHOLDER;
}

function setAgentName(model) {
  const m = String(model || '');
  const match = AGENT_NAMES.find(([re]) => re.test(m));
  agentName = match ? match[1] : DEFAULT_NAME;
  syncPlaceholder();
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
const ctxPill = $('ctxPill');
const ctxPct = $('ctxPct');
const ctxHead = $('ctxHead');
const ctxBarSegs = document.querySelectorAll('#ctxBar .seg');
const ctxMark = $('ctxMark');
const cxEls = { system: $('cxSys'), shots: $('cxShot'),
                tools: $('cxTool'), chat: $('cxChat') };
const ctxNoteRow = $('ctxNoteRow');
const ctxNote = $('ctxNote');
const takeoverBanner = $('takeoverBanner');
const convTitleEl = $('convTitle');
const chatInput = $('chatInput');
const screenStatusEl = $('screenStatus');
const screenLogoEl = $('screenLogo');
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
const steerBtn = $('steerBtn');
const sendBtn = $('sendBtn');
const attachBtn = $('attachBtn');
const attachTray = $('attachTray');
const filePicker = $('filePicker');
const dropVeil = $('dropVeil');
const verboseToggle = $('verboseToggle');
const activityEl = $('activityLine');
const convDrawer = $('convDrawer');
const convList = $('convList');
const drawerDevice = $('drawerDevice');
const chatPane = $('chatPane');
const todoCard = $('todoCard');
const todoHead = $('todoHead');
const todoList = $('todoList');
const todoCount = $('todoCount');

let rfb = null;
let chatWs = null;
let awaitingAnswer = false;
let takenOver = false;
let agentPhase = 'idle';
let lastEntryKey = null;
let liveStatus = '';   // freshest thing the agent is doing or thinking
let liveKind = '';     // 'thought' | 'action' — styles the typing text
let liveIcon = 'spark';
let runStartedAt = 0;  // when the current run began — drives the elapsed ticker

// ── conversation state ──────────────────────────────────────────────────
let conversations = [];          // metas for the active device
let activeConvId = null;         // conversation being viewed
let activeConvDevId = null;      // device that conversation lives on
let convModel = null;            // model bound to the viewed conversation
let runningConvId = null;        // conversation the device is working on
let lastSeq = 0;                 // highest seq rendered in the transcript

// Messages sent while the agent works queue on the device — the echoed
// transcript event carries `queued`, and the badge clears on `dequeue`.
const queuedSeqs = new Map();    // "conv:seq" -> mode, mirrors the daemon
const queuedEls = new Map();     // "conv:seq" -> badge element
const helperCards = new Map();   // helper name -> lifecycle card refs
// Delivered files (send_file/send_image payloads, b64 included) by
// lowercase basename — a filename the agent writes in prose resolves
// against this into a clickable chip. Cleared with the transcript.
const sentFiles = new Map();
let planBody = null;             // the live plan card's body — plan
                                 // updates rewrite it instead of reposting
let verifyEl = null;             // the open wrap-up check's card refs —
                                 // the verdict resolves it in place
const qkey = (conv, seq) => `${conv}:${seq}`;
let convFetchId = null;          // conversation currently being refetched
let pendingLive = [];            // live events arrived during a refetch
let convListTimer = 0;
let todoCollapsed = localStorage.getItem('gut.todos.collapsed') === '1';

const convKey = (devId) => `gut.conv.${devId}`;

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
const typingIcon = document.createElement('span');
typingIcon.className = 'ticon';
const typingText = document.createElement('span');
typingText.className = 'typing-text';
const typingTime = document.createElement('span');
typingTime.className = 'ttime';
typingBody.append(typingDots, typingIcon, typingText, typingTime);
typingEl.append(typingWho, typingBody);

const fmtElapsed = (t0) => {
  const s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// The clock covers the whole run — including the end-of-run cleanup sweep.
const runClockOn = () => !!runStartedAt &&
  (agentPhase === 'running' || agentPhase === 'cleanup');

// Elapsed-time ticker — the proof-of-life bit that keeps counting even when
// the status text hasn't moved for a while.
setInterval(() => {
  typingTime.textContent = runClockOn() ? fmtElapsed(runStartedAt) : '';
}, 1000);

// Ephemeral — never a transcript entry. The freshest activity/thought rides
// the typing row where the reply will land and echoes in the header's
// activity line; it's cleared when the run goes idle.
function setLiveStatus(text, kind, icon) {
  liveStatus = text;
  liveKind = kind || '';
  liveIcon = icon || 'spark';
  activityEl.textContent = text;
  // Re-trigger the fade so a status swap reads as a change, not a flicker.
  typingText.classList.remove('swap');
  void typingText.offsetWidth;
  typingText.classList.add('swap');
  updateTyping();
}

function updateTyping() {
  const here = activeConvId && agentPhase !== 'idle' &&
    (!runningConvId || runningConvId === activeConvId);
  if (!here) { typingEl.remove(); return; }
  typingWho.textContent = agentName;
  typingEl.dataset.phase = agentPhase;
  typingEl.dataset.kind = liveKind;
  typingIcon.innerHTML = svgIcon(TICONS[liveIcon] || TICONS.spark);
  typingText.textContent = STATE_LABEL[agentPhase] || liveStatus ||
    (agentPhase === 'running' ? 'working…' : '');
  typingTime.textContent = runClockOn() ? fmtElapsed(runStartedAt) : '';
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

// Agent-authored prose — send_message, task_complete, ask_user, helper
// reports — arrives as markdown; render the same safe subset as the plan
// card. (Daemon errors stay textContent: they're log lines, not prose.)
// Returns the body so the caller can append extras (the run-stats footer).
function addAgentMsg(cls, text, who = '') {
  const { body } = entry(cls, who);
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = mdRender(text);
  resolveFileRefs(md);
  body.appendChild(md);
  return body;
}

// The done footer's "straight donut": one line — output tok/s over
// model-generating seconds, then a segmented bar of where the run's wall
// clock went (model / search / helpers / other) with the same buckets as
// text. Bar segments without a legend label are still exact: hover it.
const RS_PARTS = [['model', 'agent'], ['helper', 'helpers'],
                  ['search', 'search'], ['other', 'other']];

function fmtDur(s) {
  s = Math.max(0, s || 0);
  return s >= 60
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    : `${s.toFixed(s < 10 ? 1 : 0)}s`;
}

function runStatsEl(s) {
  const el = document.createElement('div');
  el.className = 'runstats';
  const tok = document.createElement('span');
  tok.className = 'rs-tok';
  tok.textContent = `${s.tok_s || 0} tok/s`;
  tok.title = `${fmtTok(s.tokens_out || 0)} output tokens over ` +
    `${fmtDur(s.model_s)} of model time`;
  el.appendChild(tok);
  const total = Math.max(0.001, s.total_s ||
    (s.model_s + s.search_s + s.helper_s + s.other_s) || 0);
  const bar = document.createElement('span');
  bar.className = 'rs-bar';
  const legend = document.createElement('span');
  legend.className = 'rs-parts';
  for (const [key, label] of RS_PARTS) {
    const v = s[`${key}_s`] || 0;
    if (v <= 0) continue;
    const seg = document.createElement('i');
    seg.className = `rs-seg ${key}`;
    seg.style.width = `${(v / total * 100).toFixed(1)}%`;
    seg.title = `${label} ${fmtDur(v)}`;
    bar.appendChild(seg);
    if (key !== 'other') {
      const p = document.createElement('span');
      p.className = 'rs-part';
      p.innerHTML = `<i class="rs-dot ${key}"></i>${label} ${fmtDur(v)}`;
      legend.appendChild(p);
    }
  }
  el.append(bar, legend);
  el.title = `run ${fmtDur(total)} — agent ${fmtDur(s.model_s)} · ` +
    `helpers ${fmtDur(s.helper_s)} · search ${fmtDur(s.search_s)} · ` +
    `other ${fmtDur(s.other_s)}`;
  return el;
}

// Working-log entries (thoughts, tool calls, results) — only rendered when
// the verbose toggle is on.
function addVerbose(cls, text) {
  entry(`${cls} verbose-only`).body.textContent = text;
}

// A spawn_agent's lifecycle as one in-place card: the spawn shows the
// delegated task, the finish event lands the report on the same card.
// Keyed by helper name so parallel helpers keep one card each; replaying
// history rebuilds the same states from the stored running/done events.
function helperCard(m) {
  let c = helperCards.get(m.name);
  if (!c) {
    const { div, body } = entry('helper', m.name);
    const head = document.createElement('div');
    head.className = 'helper-head';
    const icon = document.createElement('span');
    icon.className = 'helper-icon';
    icon.innerHTML = svgIcon(TICONS.helper);
    const name = document.createElement('span');
    name.className = 'helper-name';
    name.textContent = m.name;
    const status = document.createElement('span');
    status.className = 'helper-status';
    head.append(icon, name, status);
    const task = document.createElement('div');
    task.className = 'helper-task md';
    const report = document.createElement('div');
    report.className = 'helper-report md';
    body.append(head, task, report);
    c = { div, status, task, report };
    helperCards.set(m.name, c);
  }
  c.div.dataset.state = m.state;
  if (m.task) { c.task.innerHTML = mdRender(m.task); resolveFileRefs(c.task); }
  if (m.state === 'running') c.report.textContent = '';  // reused name, new run
  if (m.result) {
    c.report.innerHTML = mdRender(String(m.result).trim());
    resolveFileRefs(c.report);
  }
  const bits = [m.state === 'running' ? 'working' : m.state];
  if (m.state === 'running' && m.model) bits.push(m.model);
  if (m.steps != null) bits.push(`${m.steps} steps`);
  if (m.usd) bits.push(`$${Number(m.usd).toFixed(4)}`);
  c.status.textContent = bits.join(' · ');
}

// The wrap-up audit as one card per check: "checking" lands it, the
// verdict resolves it in place. A resolution with no open check (the
// waived paths never opened one) still gets a card so the transcript
// shows the audit happened — replaying history rebuilds the same end
// state from the stored checking/verdict pairs.
const VERIFY_STATUS = {
  checking: 'auditing claims',
  pass: 'passed',
  fail: 'rejected',
  waived: 'skipped',
};

function verifyCard(m) {
  if (m.state === 'checking' || !verifyEl) {
    const { div, body } = entry('verify', agentName);
    const head = document.createElement('div');
    head.className = 'vhead';
    head.innerHTML =
      `<span class="vico">${svgIcon(TICONS.shield)}</span>` +
      '<span class="vlab">wrap-up check</span>' +
      '<span class="vstatus"></span>';
    const det = document.createElement('div');
    det.className = 'vdet md';
    body.append(head, det);
    verifyEl = { div, status: head.querySelector('.vstatus'), det };
  }
  const c = verifyEl;
  c.div.dataset.state = m.state;
  c.status.textContent = VERIFY_STATUS[m.state] || m.state;
  if (m.text) { c.det.innerHTML = mdRender(m.text); resolveFileRefs(c.det); }
  if (m.state !== 'checking') verifyEl = null;
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

const svgIcon = (inner) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  inner + '</svg>';

// ── tiny markdown subset for the plan card ────────────────────────────
// plan.summary arrives as markdown; we render a safe subset — headings,
// lists, tables, fenced code, quotes, hr — plus inline **bold**,
// *italic*, `code` and [links]. The source is escaped before anything is
// parsed, so agent text can never inject markup.
const mdEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mdInline(s) {
  let t = mdEsc(s);
  const codes = [], links = [];
  // stash code spans first so `*` or `_` inside them never parses
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\x00${codes.length - 1}\x00`;
  });
  // links go into the same stash — emphasis inside link text still
  // resolves, and a bare URL inside the text can't nest a second <a>
  const em = (x) => x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/(^|\W)_([^_\n]+)_/g, '$1<em>$2</em>');
  const stash = (html) => `\x01${links.push(html) - 1}\x01`;
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) =>
    /^(https?:|mailto:)/i.test(href)
      ? stash(`<a href="${href}" target="_blank" rel="noopener">` +
              `${em(txt)}</a>`)
      : txt);
  // bare URLs — a report's "pages fetched: https://…" list — linkify too
  t = t.replace(/https?:\/\/[^\s<>'"]+/g, (u) => {
    const clean = u.replace(/[.,;:!?)\]]+$/, '');
    return stash(`<a href="${clean}" target="_blank" rel="noopener">` +
                 `${clean}</a>`) + u.slice(clean.length);
  });
  t = em(t);
  return t.replace(/\x00(\d+)\x00/g, (_, i) => `<code>${codes[i]}</code>`)
          .replace(/\x01(\d+)\x01/g, (_, i) => links[i]);
}

const MD_NUMISH = /^[-–—]?\s*[\d.,]+(?:\s*[a-zA-Z%$€£/]+)?$/;

function mdRender(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const trim = line.trim();
    if (/^```/.test(trim)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim()))
        buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${mdEsc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // table: a | header | row immediately followed by a --- separator row
    if (trim.startsWith('|') && i + 1 < lines.length &&
        /^\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
        lines[i + 1].includes('-')) {
      flushPara();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|'))
        rows.push(lines[i++].trim());
      const cells = (r) =>
        r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const bodyRows = rows.slice(2);
      // a column right-aligns when every data cell looks like a number
      const numCol = head.map((_, c) => bodyRows.length > 0 &&
        bodyRows.every((r) => {
          const v = (cells(r)[c] || '').replace(/\*\*/g, '');
          return v === '' || /^[-–—]+$/.test(v) || MD_NUMISH.test(v);
        }));
      const tag = (t2, c) =>
        `<${t2}${numCol[c] ? ' class="num"' : ''}>`;
      out.push('<table><tr>' +
        head.map((h, c) => `${tag('th', c)}${mdInline(h)}</th>`).join('') +
        '</tr>' +
        bodyRows.map((r) => '<tr>' + head.map((_, c) =>
          `${tag('td', c)}${mdInline(cells(r)[c] || '')}</td>`).join('') +
          '</tr>').join('') +
        '</table>');
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      flushPara();
      out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (i < lines.length && re.test(lines[i]))
        items.push(lines[i++].replace(re, ''));
      const t2 = ordered ? 'ol' : 'ul';
      out.push(`<${t2}>` +
        items.map((it) => `<li>${mdInline(it)}</li>`).join('') +
        `</${t2}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]))
        buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${buf.map(mdInline).join('<br>')}</blockquote>`);
      continue;
    }
    if (trim === '') {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}

const FILE_PAGE = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 ' +
  '0 0 2-2V8z"/><path d="M14 2v6h6"/>';
const FILE_ICON = svgIcon(FILE_PAGE);

// File-card iconography: each delivery gets a tinted tile whose glyph and
// color say what kind of file it is. Kinds match on extension first, then
// mime; CSS tints the tile via the `k-<kind>` class.
const FILE_KINDS = {
  image:   { exts: 'png jpg jpeg gif webp svg bmp ico tif tiff avif heic',
             glyph: '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
                    '<circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>' },
  pdf:     { exts: 'pdf',
             glyph: FILE_PAGE + '<path d="M8 13h8M8 16.5h5"/>' },
  audio:   { exts: 'mp3 wav ogg flac m4a aac opus mid midi',
             glyph: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/>' +
                    '<circle cx="18" cy="16" r="3"/>' },
  video:   { exts: 'mp4 mov webm mkv avi m4v',
             glyph: '<rect x="2.5" y="5" width="19" height="14" rx="2"/>' +
                    '<path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none"/>' },
  archive: { exts: 'zip tar gz tgz bz2 xz 7z rar zst dmg iso jar',
             glyph: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/>' +
                    '<path d="M10 12h4"/>' },
  code:    { exts: 'js mjs cjs ts mts cts jsx tsx py rb go rs java c h cc ' +
                   'cpp hpp cs php sh bash zsh swift kt kts scala lua pl r ' +
                   'html css scss json yml yaml toml xml sql vue svelte env lock',
             glyph: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>' },
  sheet:   { exts: 'csv tsv xls xlsx ods numbers',
             glyph: '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
                    '<path d="M3 10h18M3 15h18M10 4v16"/>' },
  slides:  { exts: 'ppt pptx odp key',
             glyph: '<rect x="3" y="4" width="18" height="12" rx="1.5"/>' +
                    '<path d="M12 16v4M8 20h8"/>' },
  doc:     { exts: 'txt md markdown log rtf doc docx odt pages tex epub',
             glyph: FILE_PAGE + '<path d="M8 13h8M8 16.5h8"/>' },
};
const KIND_BY_EXT = {};
for (const [k, v] of Object.entries(FILE_KINDS))
  for (const e of v.exts.split(' ')) KIND_BY_EXT[e] = k;
const KIND_BY_MIME = {
  'application/pdf': 'pdf',
  'application/json': 'code',
  'application/javascript': 'code', 'text/javascript': 'code',
  'application/xml': 'code', 'text/xml': 'code',
  'application/zip': 'archive', 'application/gzip': 'archive',
  'application/x-tar': 'archive', 'application/x-7z-compressed': 'archive',
  'application/x-rar-compressed': 'archive',
  'text/csv': 'sheet',
  'application/vnd.ms-excel': 'sheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc',
  'application/vnd.ms-powerpoint': 'slides',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'slides',
};

function fileKind(name, mime) {
  const nm = String(name || '').toLowerCase();
  const ext = nm.includes('.') ? nm.split('.').pop() : '';
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  const m = String(mime || '').toLowerCase();
  if (KIND_BY_MIME[m]) return KIND_BY_MIME[m];
  if (FILE_KINDS[m.split('/')[0]]) return m.split('/')[0];
  if (m.startsWith('text/')) return 'doc';
  return 'file';
}

const fileGlyph = (kind) => svgIcon((FILE_KINDS[kind] || {}).glyph || FILE_PAGE);

// An attachment chip: file icon + name (+ size when known). `removable`
// adds the × used by the composer's staging tray.
function attachChip(f, removable, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'att';
  chip.insertAdjacentHTML('beforeend', fileGlyph(fileKind(f.name, f.mime)));
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = f.name;
  chip.appendChild(nm);
  if (f.size != null) {
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = fmtSize(f.size);
    chip.appendChild(sz);
  }
  if (removable) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.title = 'Remove';
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
      '<path d="M18 6L6 18M6 6l12 12"/></svg>';
    rm.onclick = onRemove;
    chip.appendChild(rm);
  }
  return chip;
}

// Tag under a mid-run message: "sent to the agent" once steered into the
// run, "queued" while it waits for the run to finish — with send-now and
// drop controls on the queued state.
function queueTag(mode, cid, seq) {
  const tag = document.createElement('span');
  tag.className = 'qtag';
  if (mode === 'steer') {
    tag.classList.add('steer');
    tag.textContent = '⚡ sent to the agent';
  } else {
    tag.appendChild(document.createTextNode('queued'));
    if (seq != null && cid === runningConvId) {
      const now = document.createElement('button');
      now.type = 'button';
      now.textContent = 'send now';
      now.title = "Push it into the run at the agent's next step";
      now.onclick = () => {
        send({ type: 'control', action: 'deliver', seq });
        now.disabled = true;
      };
      tag.appendChild(now);
    }
    if (seq != null) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'drop';
      rm.title = 'Remove from the queue';
      rm.onclick = () => send({ type: 'control', action: 'dequeue', seq });
      tag.appendChild(rm);
    }
  }
  if (seq != null) queuedEls.set(qkey(cid, seq), tag);
  return tag;
}

// Your own message: clay bubble with the text plus a chip per attachment.
function addUserMsg(m) {
  const { body } = entry('user', 'You');
  if (m.text) body.appendChild(document.createTextNode(m.text));
  if (m.files && m.files.length) {
    const tray = document.createElement('div');
    tray.className = 'atts';
    for (const f of m.files) tray.appendChild(attachChip(f, false));
    body.appendChild(tray);
  }
  const cid = m.conversation_id || activeConvId;
  const mode = m.queued ||
    (m.seq != null ? queuedSeqs.get(qkey(cid, m.seq)) : null);
  if (mode) body.appendChild(queueTag(mode, cid, m.seq));
}

const ICON_DOWNLOAD = svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 ' +
  '1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>');
const ICON_FOLDER = svgIcon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 ' +
  '1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>');

const finderLabel = () =>
  gut?.platform === 'darwin' ? 'Show in Finder'
    : gut?.platform === 'win32' ? 'Show in Explorer' : 'Show in folder';

// "saved to ~/Downloads/x — Show in Finder" line appended once a delivery
// has been written to disk.
function savedNote(r) {
  const s = document.createElement('span');
  s.className = 'saved-note';
  s.append(`saved to ${r.display} — `);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'linkish';
  b.textContent = finderLabel();
  b.onclick = () => gut.revealFile(r.path);
  s.appendChild(b);
  return s;
}

// Save a delivered file: inside Electron it goes straight to ~/Downloads
// via IPC (returns the real path); in a plain browser we trigger a blob
// download and can only point at the Downloads folder.
async function saveDelivery(m) {
  if (gut?.saveFile) return gut.saveFile(m.name || 'file', m.data);
  const a = document.createElement('a');
  a.href = b64ToBlobUrl(m.data, m.mime);
  a.download = m.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10e3);
  return { ok: true };
}

// A delivered file: tinted type tile, name + "TYPE · size", and a download
// button that turns into "Show in Finder" once the file is on disk.
function fileCard(m) {
  const kind = fileKind(m.name, m.mime);
  const card = document.createElement('div');
  card.className = `fcard k-${kind}`;

  const tile = document.createElement('span');
  tile.className = 'ftile';
  tile.innerHTML = fileGlyph(kind);

  const nm = String(m.name || 'file');
  const ext = nm.includes('.') ? nm.split('.').pop().toUpperCase() : '';
  const sub0 = `${ext || kind} · ${fmtSize(m.size || 0)}`;
  const meta = document.createElement('span');
  meta.className = 'fmeta';
  const name = document.createElement('span');
  name.className = 'fname';
  name.textContent = nm;
  name.title = nm;
  const sub = document.createElement('span');
  sub.className = 'fsub';
  sub.textContent = sub0;
  meta.append(name, sub);

  const acts = document.createElement('span');
  acts.className = 'facts';
  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'fbtn';
  dl.innerHTML = `${ICON_DOWNLOAD}<span>Download</span>`;
  dl.onclick = async () => {
    dl.disabled = true;
    dl.querySelector('span').textContent = 'Saving…';
    const r = await saveDelivery(m);
    if (r?.ok && r.path) {
      sub.textContent = `${sub0} · ${r.display}`;
      acts.innerHTML = '';
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'fbtn';
      reveal.innerHTML = `${ICON_FOLDER}<span>${finderLabel()}</span>`;
      reveal.onclick = () => gut.revealFile(r.path);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'fbtn ghost';
      open.innerHTML = '<span>Open</span>';
      open.onclick = () => gut.openFile(r.path);
      acts.append(reveal, open);
      card.classList.add('saved');
    } else if (r?.ok) {
      sub.textContent = `${sub0} · saved to your Downloads folder`;
      dl.querySelector('span').textContent = 'Download';
      dl.disabled = false;
    } else {
      sub.textContent = `save failed — ${r?.error || 'unknown error'}`;
      dl.querySelector('span').textContent = 'Download';
      dl.disabled = false;
    }
  };
  if (!m.data) dl.disabled = true;
  acts.appendChild(dl);
  card.append(tile, meta, acts);
  return card;
}

function addFileMsg(m) {
  const { body } = entry('file', agentName);
  if (m.note) {
    const p = document.createElement('p');
    p.className = 'file-note';
    p.innerHTML = mdInline(m.note);
    body.appendChild(p);
  }
  body.appendChild(fileCard(m));
  registerSentFile(m);
}

function addImageMsg(m) {
  const { body } = entry('image', agentName);
  const url = b64ToBlobUrl(m.data, m.mime);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.download = m.name || 'image';
  let note = null;
  // In the shell a click saves to ~/Downloads instead of popping a dialog;
  // the blob URL is only a fallback preview target in a plain browser.
  if (gut?.saveFile) {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const r = await saveDelivery(m);
      if (!r?.ok || !r.path) return;
      const n = savedNote(r);
      if (note) note.replaceWith(n);
      else body.appendChild(n);
      note = n;
    });
  }
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = url;
  img.alt = m.caption || m.name || 'image from agent';
  a.appendChild(img);
  body.appendChild(a);
  if (m.caption) {
    const p = document.createElement('p');
    p.className = 'img-caption';
    p.innerHTML = mdInline(m.caption);
    body.appendChild(p);
  }
  registerSentFile(m);
}

// ── file references in agent prose ─────────────────────────────────────
// A delivered file mentioned by name — "attached as `report.pdf`", or a
// bare report.pdf — resolves into a chip that saves the file on click,
// like the file card's download button. registerSentFile re-scans the
// transcript so a mention that arrived *before* its file upgrades too.
function fileRefPill(f) {
  const chip = attachChip(f, false);
  chip.classList.add('ref');
  chip.setAttribute('role', 'button');
  chip.tabIndex = 0;
  chip.title = `Save ${f.name} to Downloads`;
  const activate = async () => {
    const r = await saveDelivery(sentFiles.get(refBase(f.name)) || f);
    if (r?.ok) {
      chip.classList.add('got');
      chip.title = r.path ? `saved to ${r.display}` : 'saved to Downloads';
    }
  };
  chip.onclick = activate;
  chip.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
  return chip;
}

const refBase = (s) => String(s || '').split(/[\\/]/).pop().toLowerCase();
// Elements a filename mention never upgrades inside — the file card's own
// name, fenced code, existing pills/links. REF_SKIP_CODE drops `code`
// itself (closest() self-matches); a code span's ancestors matter, not it.
const REF_SKIP = 'a,button,pre,code,.att,.fcard,.who';
const REF_SKIP_CODE = 'a,button,pre,.att,.fcard,.who';

function resolveFileRefs(root) {
  if (!root || !sentFiles.size) return;
  for (const code of root.querySelectorAll('code')) {
    if (code.closest(REF_SKIP_CODE)) continue;
    const t = code.textContent.trim();
    const f = !/\s/.test(t) && sentFiles.get(refBase(t));
    if (f) code.replaceWith(fileRefPill(f));
  }
  const names = [...sentFiles.keys()]
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const inText = new RegExp(`\\b(?:${names.join('|')})\\b`, 'i');
  const re = new RegExp(inText.source, 'gi');
  const hits = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.parentElement?.closest(REF_SKIP) || !inText.test(n.nodeValue))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  while (walker.nextNode()) hits.push(walker.currentNode);
  for (const node of hits) {
    const frag = document.createDocumentFragment();
    const text = node.nodeValue;
    let last = 0, m, hit = false;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const f = sentFiles.get(m[0].toLowerCase());
      if (!f) continue;
      frag.append(text.slice(last, m.index), fileRefPill(f));
      last = m.index + m[0].length;
      hit = true;
    }
    if (hit) {
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
}

function registerSentFile(m) {
  const key = refBase(m.name);
  if (key && m.data) sentFiles.set(key, m);
  resolveFileRefs(messagesEl);
}

// Human-readable one-liner for a tool call — lands in the activity line and
// the typing row. Args are clipped to a short hint where they help; typed
// text is never echoed (it can carry secrets).
const clip = (s, n = 48) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const hostOf = (u) => {
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); }
  catch (_) { return ''; }
};
const fileBase = (p) => String(p || '').split('/').pop() || 'a file';

const TOOL_STATUS = {
  screenshot:       () => 'looking at the screen',
  wait:             (a) => a.seconds ? `waiting ${a.seconds}s` : 'waiting',
  click:            (a) => a.count >= 2 ? 'double-clicking'
                           : a.button === 'right' ? 'right-clicking'
                           : a.button === 'middle' ? 'middle-clicking'
                           : 'clicking',
  left_click:       () => 'clicking',
  middle_click:     () => 'middle-clicking',
  right_click:      () => 'right-clicking',
  double_click:     () => 'double-clicking',
  mouse_move:       () => 'moving the pointer',
  scroll:           (a) => `scrolling ${a.direction || ''}`.trim(),
  type_text:        () => 'typing',
  key:              (a) => a.keys ? `pressing ${clip(a.keys, 20)}`
                                  : 'pressing keys',
  run_command:      (a) => a.command ? `running “${clip(a.command, 40)}”`
                                     : 'running a command',
  web_search:       (a) => a.query ? `searching the web — “${clip(a.query, 40)}”`
                                   : 'searching the web',
  fetch_url:        (a) => `reading ${hostOf(a.url) || 'a page'}`,
  browser_navigate: (a) => `opening ${hostOf(a.url) || 'a page'}`,
  open_url:         (a) => `opening ${hostOf(a.url) || 'a page'}`,
  browser_dom:      () => 'scanning the page',
  browser_text:     () => 'reading the page',
  browser_click:    () => 'clicking in the page',
  browser_type:     () => 'typing in the page',
  browser_eval:     () => 'running a script in the page',
  list_windows:     () => 'listing windows',
  focus_window:     (a) => `focusing ${clip(a.match, 30) || 'a window'}`,
  desktop_tree:     () => 'reading the window',
  desktop_act:      () => 'using the interface',
  desktop_click:    () => 'clicking',
  desktop_type:     () => 'typing',
  office_eval:      () => 'editing the document',
  send_message:     () => 'writing you a note',
  send_file:        (a) => `sending ${clip(fileBase(a.path), 30)}`,
  send_image:       () => 'sending an image',
  ask_user:         () => 'asking you',
  spawn_agent:      (a) => `delegating to ${clip(a.name, 20) || 'a helper'}`,
  collect_agent:    () => 'collecting a helper report',
  plan:             (a) => a.summary ? 'posting a plan'
                                     : 'updating the checklist',
  share_plan:       () => 'posting a plan',
  update_todos:     () => 'updating the checklist',
  task_complete:    () => 'wrapping up',
};

function toolStatus(m) {
  const f = TOOL_STATUS[m.tool];
  return f ? f(m.args || {}) : `using ${m.tool}`;
}

// Small glyph per activity, drawn in the typing row next to the dots —
// mint for actions, clay for thoughts (styled in css via data-kind).
const TICONS = {
  spark:  '<path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9z"/>',
  eye:    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  clock:  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  cursor: '<path d="M3 3l7.1 17 2.5-7.4 7.4-2.5z"/><path d="M13 13l6 6"/>',
  kbd:    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h2m2 0h2m2 0h2m2 0h.01M7 14h10"/>',
  term:   '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6.5 9l3 3-3 3M12 15h5.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
  page:   '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-2.7 2.6-4 5.7-4 9s1.3 6.4 4 9c2.7-2.6 4-5.7 4-9s-1.3-6.4-4-9z"/>',
  grid:   '<rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/><rect x="3" y="15" width="8" height="6" rx="1"/>',
  doc:    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  image:  '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  chat:   '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 21l2-5.3A8.5 8.5 0 1 1 21 11.5z"/>',
  helper: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  plan:   '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  check:  '<path d="M4 12.5l5 5L20 6.5"/>',
  shield: '<path d="M12 3l7 2.6V11c0 4.6-3 8.3-7 9.8-4-1.5-7-5.2-7-9.8V5.6z"/><path d="M9 11.8l2.2 2.2 4-4.4"/>',
  dot:    '<circle cx="12" cy="12" r="4"/>',
};

const TOOL_ICON = {
  screenshot: 'eye', wait: 'clock',
  click: 'cursor',
  left_click: 'cursor', middle_click: 'cursor', right_click: 'cursor',
  double_click: 'cursor', mouse_move: 'cursor', scroll: 'cursor',
  desktop_act: 'cursor', desktop_click: 'cursor', browser_click: 'cursor',
  type_text: 'kbd', key: 'kbd', desktop_type: 'kbd', browser_type: 'kbd',
  run_command: 'term', browser_eval: 'term', office_eval: 'doc',
  web_search: 'search', fetch_url: 'page', browser_navigate: 'page',
  open_url: 'page', browser_dom: 'page', browser_text: 'page',
  list_windows: 'grid', focus_window: 'grid', desktop_tree: 'grid',
  send_message: 'chat', ask_user: 'chat', send_file: 'doc',
  send_image: 'image', spawn_agent: 'helper', collect_agent: 'helper',
  plan: 'plan',
  share_plan: 'plan', update_todos: 'plan', task_complete: 'check',
};

// One renderer for live events and stored history alike. `live` adds the
// ephemeral side effects (activity line, pending-question state).
function renderEvent(m, live) {
  switch (m.type) {
    case 'user':
      planBody = null;  // a new task starts a new plan card
      verifyEl = null;  // …and a stale open check belongs to the last run
      addUserMsg(m);
      break;
    case 'agent_msg':
      addAgentMsg('agent', m.text, agentName);
      break;
    case 'done': {
      const body = addAgentMsg('agent', m.text, agentName);
      if (m.stats) body.appendChild(runStatsEl(m.stats));
      if (live) notify(`${agentName} finished`, m.text || '');
      break;
    }
    case 'file':
      addFileMsg(m);
      break;
    case 'image':
      addImageMsg(m);
      break;
    case 'thought':
      addVerbose('thought', `${m.agent ? m.agent + ' · ' : ''}${(m.text || '').trim()}`);
      // The agent's inner voice, live in the status line — a thought reads
      // like "checking the totals…", an action like "clicking".
      if (live) setLiveStatus(
        `${m.agent ? m.agent + ' · ' : ''}${clip(m.text, 140)}`,
        'thought', 'spark');
      break;
    case 'action':
      addVerbose('action', `▶ ${m.agent ? m.agent + '·' : ''}${m.tool} ${JSON.stringify(m.args)}`);
      if (live) setLiveStatus(
        `${m.agent ? m.agent + ' · ' : ''}${toolStatus(m)}`,
        'action', TOOL_ICON[m.tool] || 'dot');
      break;
    case 'action_result':
      addVerbose('action', `✓ ${m.agent ? m.agent + '·' : ''}${m.tool}: ${(m.result || '').trim()}`);
      break;
    case 'subagent':
      helperCard(m);
      if (live) setLiveStatus(`helper ${m.name} ${m.state}`,
        'action', 'helper');
      break;
    case 'cleanup':
      addVerbose('thought', m.text || '');
      break;
    case 'plan': {
      // A posted artifact that updates in place — a later `plan` call
      // rewrites the existing card (and replays the ring) instead of
      // reposting the whole plan as another message. `.arrive` plays the
      // landing ceremony — live events only, replayed history appears
      // already settled.
      const text = (m.text || '').trim();
      if (planBody && planBody.isConnected) {
        const pb = planBody.querySelector('.pbody');
        if (pb) {
          pb.innerHTML = mdRender(text);
          resolveFileRefs(pb);
          pb.hidden = !text;
        }
        const meta = planBody.querySelector('.pmeta');
        if (meta) meta.textContent = 'updated';
        if (live) {
          planBody.classList.remove('updated');
          void planBody.offsetWidth;
          planBody.classList.add('updated');
        }
        break;
      }
      const { body } = entry('plan', agentName);
      const head = document.createElement('div');
      head.className = 'phead';
      head.innerHTML = `<span class="pico">${svgIcon(TICONS.plan)}</span>` +
        '<span class="plab">Plan</span>' +
        '<span class="pmeta">shared to chat</span>';
      body.appendChild(head);
      if (text) {
        const pb = document.createElement('div');
        pb.className = 'pbody md';
        pb.innerHTML = mdRender(text);
        resolveFileRefs(pb);
        body.appendChild(pb);
      }
      planBody = body;
      if (live) body.classList.add('arrive');
      break;
    }
    case 'compact':
      entry('compact').body.textContent = m.text || 'context compacted';
      break;
    case 'verify':
      verifyCard(m);
      if (live && m.state === 'checking')
        setLiveStatus('auditing the wrap-up', 'action', 'shield');
      break;
    case 'question':
      addAgentMsg('question', m.text, agentName);
      if (live) {
        notify(`${agentName} needs you`, m.text || '');
        awaitingAnswer = true;
        chatInput.placeholder = `Reply to ${agentName}…`;
        activityEl.textContent = '· waiting for your reply';
      }
      break;
    case 'error':
      addMsg('error', m.text, 'Error');
      if (live) notify(`${agentName} failed`, m.text || '');
      break;
  }
}

// Text shown in place of the dots for the non-running active phases.
const STATE_LABEL = {
  waiting_user: 'needs you',
  paused: 'paused',
  cleanup: 'tidying up',
};

function setAgentState(s, runStarted) {
  const was = agentPhase;
  agentPhase = s;
  document.body.dataset.agent = s;
  stopBtn.hidden = !(s === 'running' || s === 'waiting_user' || s === 'paused');
  steerBtn.hidden = s === 'idle';
  // The daemon's run_started is the truth — it survives reconnects and
  // pauses; the local stamp is a fallback for older daemons. A cleanup→
  // running transition is the next queued task, so it starts a new clock.
  if (s === 'running' || s === 'cleanup') {
    if (runStarted) runStartedAt = runStarted * 1000;
    else if (!runStartedAt || was === 'cleanup') runStartedAt = Date.now();
  }
  if (s === 'idle') {
    activityEl.textContent = '';
    liveStatus = '';
    liveKind = '';
    runStartedAt = 0;
  }
  syncPlaceholder();
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
  // Live context occupancy rides the cost push — apply it only when it's
  // the conversation being viewed (a push for another running conv must
  // not repaint this one's meter).
  if (c.conversation_id === activeConvId && c.ctx_tokens) {
    ctxInfo = {
      tokens: c.ctx_tokens,
      limit: c.ctx_limit || (modelMeta[convModel] || {}).ctx || 0,
      parts: c.ctx_parts || null,
      compactAt: c.ctx_compact_at || 0,
      estimated: false,
    };
    renderCtx();
  }
}

// ── context meter ───────────────────────────────────────────────────────
// The pill shows what share of the model's context window the viewed
// conversation occupies; hovering opens a stacked breakdown (system /
// screenshots / tool results / chat) and the point where the daemon
// auto-compacts history.
let ctxInfo = { tokens: 0, limit: 0, parts: null, compactAt: 0,
                estimated: true };

const CTX_CATS = ['system', 'shots', 'tools', 'chat'];  // seg order in #ctxBar

function renderCtx() {
  const { tokens, parts, compactAt, estimated } = ctxInfo;
  // The window comes from the push, else the viewed model's metadata —
  // which can arrive after the conversation fetch seeded ctxInfo.
  const limit = ctxInfo.limit || (modelMeta[convModel] || {}).ctx || 0;
  const show = !!(activeConvId && tokens > 0);
  ctxPill.hidden = !show;
  if (!show) return;
  const pct = limit ? tokens / limit : 0;
  ctxPct.textContent =
    limit ? `${Math.round(pct * 100)}%` : `${fmtTok(tokens)} tok`;
  ctxHead.textContent =
    limit ? `${fmtTok(tokens)} / ${fmtTok(limit)}` : fmtTok(tokens);
  // The bar is the whole window: segments cover tokens/limit of it, the
  // rest reads as free space — so the compact mark lands where it fires.
  const span = limit || (parts ? Object.values(parts).reduce((a, b) => a + b, 0) : tokens);
  ctxBarSegs.forEach((seg, i) => {
    // Without a split, one flat chat-colored fill still shows the total.
    const v = parts ? (parts[CTX_CATS[i]] || 0) : (i === 3 ? tokens : 0);
    const w = span ? v / span * 100 : 0;
    seg.style.display = w > 0 ? '' : 'none';
    seg.style.width = `${w}%`;
  });
  for (const k of CTX_CATS) {
    cxEls[k].textContent = parts && parts[k] ? fmtTok(parts[k]) : '–';
  }
  ctxMark.hidden = !(limit && compactAt);
  if (limit && compactAt) {
    ctxMark.style.left = `${(compactAt / limit * 100).toFixed(1)}%`;
  }
  ctxNoteRow.hidden = !(estimated || compactAt);
  ctxNote.textContent = estimated
    ? 'estimated — updates after the next step'
    : (compactAt
        ? `auto-compacts at ~${Math.round(compactAt / limit * 100)}%`
        : '');
  ctxPill.classList.toggle('ctx-warm', pct >= 0.6 && pct < 0.85);
  ctxPill.classList.toggle('ctx-hot', pct >= 0.85);
}

// ── desktop stream (noVNC RFB) ──────────────────────────────────────────
// The screen mirrors the device the open conversation runs on — not the
// composer picker. With no open conversation there is nothing to watch:
// the stream stays down and the pane shows the gut mark instead.
let screenDevId = null;   // device the stream is bound to

// The device the open chat lives on — what the screen should show.
function chatDev() {
  if (!activeConvId) return null;
  return cfg.devices.find(d => d.id === activeConvDevId) || activeDev();
}

function disconnectDesktop() {
  screenDevId = null;
  if (rfb) { try { rfb.disconnect(); } catch (_) {} rfb = null; }
  // Sweep orphaned noVNC divs — a replaced RFB whose disconnect event fired
  // late can leave a still-streaming canvas behind.
  screenEl.querySelectorAll(':scope > div').forEach(el => el.remove());
  backdropCtx.clearRect(0, 0, backdrop.width, backdrop.height);
}

function setScreenStatus(msg, bad = false) {
  screenStatusEl.textContent = msg;
  screenStatusEl.classList.toggle('bad', bad);
}

function connectDesktop(d) {
  disconnectDesktop();
  screenDevId = d.id;
  screenEl.hidden = false;
  screenLogoEl.hidden = true;
  if (!maySendSecret(d)) {
    // Downgrade guard — never stream the VNC password over plaintext.
    // Re-pair periodically; a healed TLS endpoint reconnects by itself.
    setScreenStatus('encrypted endpoint unavailable — refusing ' +
                    'unencrypted fallback (see Settings → Devices)', true);
    setTimeout(async () => {
      if (screenDevId === d.id && await ensureSecure(d)) syncScreen();
    }, 15000);
    return;
  }
  setScreenStatus('connecting…');
  const conn = new RFB(screenEl, novncUrl(d), {
    credentials: { password: d.vncPassword },
  });
  rfb = conn;
  // Fit the desktop to the pane both ways — the whole desktop is always
  // visible; the ambient backdrop fills whatever gutter remains.
  conn.scaleViewport = true;
  conn.clipViewport = true;
  conn.background = 'transparent';  // let the ambient backdrop show through
  conn.addEventListener('connect', () => {
    if (rfb !== conn) return;  // superseded before it connected
    setScreenStatus('');
  });
  conn.addEventListener('disconnect', (e) => {
    // A stale RFB's disconnect event can arrive after a newer stream was
    // already assigned to rfb — only the pane's owner may react.
    if (rfb !== conn) return;
    rfb = null;
    if (!screenDevId) return;  // we closed it — the logo is up
    setScreenStatus(
      e.detail.clean ? 'disconnected' : 'connection lost — retrying…',
      !e.detail.clean);
    setTimeout(syncScreen, 3000);
  });
  conn.addEventListener('credentialsrequired', () => {
    conn.sendCredentials({ password: d.vncPassword });
  });
}

// Point the stream at the open chat's device — or drop to the logo when
// no conversation is open.
function syncScreen() {
  const d = chatDev();
  if (!d) {
    disconnectDesktop();
    screenEl.hidden = true;
    screenLogoEl.hidden = false;
    setScreenStatus('');
    return;
  }
  if (screenDevId !== d.id || !rfb) connectDesktop(d);
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

// The agent's update_todos checklist, pinned above the transcript. State
// lives on the device (per conversation) — it arrives live as `todos`
// socket events and is restored from GET /api/conversations on open.
const TODO_MARK = { pending: '○', in_progress: '◐', done: '●' };

function renderTodoCard(items) {
  const list = Array.isArray(items) ? items : [];
  todoCard.hidden = !list.length;
  todoCard.classList.toggle('collapsed', todoCollapsed);
  todoList.innerHTML = '';
  let done = 0;
  for (const it of list) {
    if (it.status === 'done') done++;
    const li = document.createElement('li');
    li.className = `todo-item ${it.status || 'pending'}`;
    const mark = document.createElement('span');
    mark.className = 'todo-mark';
    mark.textContent = TODO_MARK[it.status] || TODO_MARK.pending;
    const txt = document.createElement('span');
    txt.className = 'todo-text';
    txt.textContent = it.content || '';
    li.append(mark, txt);
    if (it.kind) {
      const kind = document.createElement('span');
      kind.className = 'todo-kind';
      kind.textContent = it.kind;
      li.appendChild(kind);
    }
    todoList.appendChild(li);
  }
  todoCount.textContent = list.length ? `${done}/${list.length}` : '';
}

todoHead.onclick = () => {
  todoCollapsed = !todoCollapsed;
  localStorage.setItem('gut.todos.collapsed', todoCollapsed ? '1' : '0');
  todoCard.classList.toggle('collapsed', todoCollapsed);
};

function clearTranscript(title) {
  messagesEl.innerHTML = '';
  lastEntryKey = null;
  lastSeq = 0;
  helperCards.clear();
  sentFiles.clear();
  planBody = null;
  verifyEl = null;
  convModel = null;
  ctxInfo = { tokens: 0, limit: 0, parts: null, compactAt: 0,
              estimated: true };
  renderCtx();
  awaitingAnswer = false;
  liveStatus = '';
  liveKind = '';
  liveIcon = 'spark';
  syncPlaceholder();
  convTitleEl.textContent = title || 'New conversation';
  renderTodoCard([]);
  updateTyping();
}

async function openConversation(id) {
  activeConvId = id;
  activeConvDevId = activeDev().id;
  localStorage.setItem(convKey(activeDev().id), id);
  convFetchId = id;
  pendingLive = [];
  syncScreen();
  try {
    const r = await apiFetch(`/api/conversations/${id}`);
    if (!r.ok) throw new Error(String(r.status));
    const c = await r.json();
    if (id !== activeConvId) return;  // user switched again mid-fetch
    clearTranscript(c.meta.title);
    convModel = c.meta.model || null;
    if (convModel) syncModel(convModel);
    // c.ctx: daemon-side context occupancy — live values for a running
    // conversation, a stored-context estimate (anchored to its last billed
    // prompt) for an idle one. Live `cost` pushes overwrite it per step.
    if (c.ctx && c.ctx.tokens) {
      ctxInfo = {
        tokens: c.ctx.tokens,
        limit: c.ctx.limit || (modelMeta[convModel] || {}).ctx || 0,
        parts: c.ctx.parts || null,
        compactAt: c.ctx.compact_at || 0,
        estimated: !!c.ctx.estimated,
      };
    }
    renderCtx();
    renderTodoCard(c.todos);
    for (const ev of c.events) {
      if (ev.seq) lastSeq = Math.max(lastSeq, ev.seq);
      renderEvent(ev, false);
    }
    const last = c.events[c.events.length - 1];
    if (c.meta.running) {
      if (!runningConvId) runningConvId = id;
      setLiveStatus('working…');
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
    activeConvDevId = activeDev().id;
    localStorage.setItem(convKey(activeDev().id), meta.id);
    syncScreen();
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
      activeConvDevId = null;
      localStorage.removeItem(convKey(activeDev().id));
      clearTranscript();
      syncScreen();
    }
    loadConversations();
  } catch (_) { /* device unreachable */ }
}

// Event types the daemon persists into a conversation (mirrors the backend).
// Status/cost also carry conversation_id but are channel noise, not history.
const TRANSCRIPT_TYPES = new Set([
  'user', 'agent_msg', 'done', 'file', 'image',
  'thought', 'action', 'action_result', 'question', 'error', 'cleanup',
  'subagent', 'plan', 'compact', 'verify',
]);

// A transcript event arrives tagged with (conversation_id, seq). Render it
// when viewing that conversation — deduped against replayed history — or
// nudge the drawer when it belongs to another conversation.
function handleTranscriptEvent(m) {
  // Queue tracking runs before the conversation filter — a message queued
  // on another conversation still needs its badge when it's opened later.
  if (m.queued && m.seq != null) {
    queuedSeqs.set(qkey(m.conversation_id, m.seq), m.queued);
  }
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

/* ── research pane ─────────────────────────────────────────────────
   While the agent works API-side (searches, page reads, workers) the
   desktop stream is dead air, so #desktopPane swaps in a night field:
   aurora curtains overhead, one glowing orb per agent, a spark rising
   for every call, and a constellation of source-stars accumulating
   below. A visible-screen action swaps the desktop back in. */
const researchPaneEl = document.getElementById('researchPane');
// Mirror of the daemon's VISUAL_TOOLS — a call here means the desktop
// is live again, so the field gives the stream back.
const VISUAL_ACTION_TOOLS = new Set([
  'click', 'mouse_move', 'scroll', 'type_text', 'key',
  'browser_click', 'browser_type', 'open_url', 'focus_window',
  'desktop_act', 'desktop_click', 'desktop_type',
]);
const WORKER_HUES = ['blue', 'violet', 'rose'];
// Fallback chip colors when a site has no reachable favicon.
const FAV_HUES = ['#2d2560', '#4a3d7a', '#21574c', '#6b3a5e',
                  '#274b63', '#5e4a2d'];
const KIND_ICON = { search: '⌕', fetch: '⌁', spawn: '⟶',
                    collect: '◌', send: '↑' };
const RESULT_URL_RE = /https?:\/\/[^\s)\]'"]+/g;

const research = {
  conv: null,          // the conversation this field is tracking
  usd: 0,
  workers: 0,          // worker orbs ever spawned
  queries: 0,          // search/fetch calls seen
  sites: new Set(),    // domains already in the constellation
  lanes: new Map(),    // agent → { el, orbEl, linesEl, pend[] }
  shown: false,
  hideTimer: null,
  headEl: null, orbsEl: null, countEl: null, statsEl: null,
};

function rel(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function researchChrome() {
  if (research.headEl) return;
  // SVG turbulence gives the pigment its ink-in-water edges; animating
  // baseFrequency makes the veining writhe slowly on its own.
  const defs = rel('div');
  defs.innerHTML =
    '<svg width="0" height="0" style="position:absolute"><defs>' +
    '<filter id="inkA"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="3" seed="3" result="n"><animate attributeName="baseFrequency" dur="22s" values="0.012 0.02;0.017 0.013;0.012 0.02" repeatCount="indefinite"/></feTurbulence><feDisplacementMap in="SourceGraphic" in2="n" scale="46"/></filter>' +
    '<filter id="inkB"><feTurbulence type="fractalNoise" baseFrequency="0.015 0.018" numOctaves="3" seed="7" result="n"><animate attributeName="baseFrequency" dur="27s" values="0.015 0.018;0.011 0.023;0.015 0.018" repeatCount="indefinite"/></feTurbulence><feDisplacementMap in="SourceGraphic" in2="n" scale="38"/></filter>' +
    '<filter id="inkC"><feTurbulence type="fractalNoise" baseFrequency="0.02 0.014" numOctaves="2" seed="11" result="n"><animate attributeName="baseFrequency" dur="19s" values="0.02 0.014;0.014 0.021;0.02 0.014" repeatCount="indefinite"/></feTurbulence><feDisplacementMap in="SourceGraphic" in2="n" scale="30"/></filter>' +
    '</defs></svg>';
  const head = rel('div', 'rhead');
  research.labelEl = rel('span', 'rlabel live', 'research');
  research.countEl = rel('span', 'rcount', '0 workers · 0 queries');
  const eq = rel('span', 'eq');
  for (let i = 0; i < 4; i++) eq.appendChild(rel('i'));
  research.statsEl = rel('span', 'rstats', '0 sites');
  head.append(research.labelEl, research.countEl, eq, research.statsEl);
  research.boardEl = rel('div', 'rboard');
  research.orbsEl = rel('div', 'orbs');
  research.boardEl.appendChild(research.orbsEl);
  const thumb = rel('div', 'vthumb');
  thumb.setAttribute('role', 'button');
  thumb.tabIndex = 0;
  thumb.title = 'back to the desktop';
  thumb.append(rel('span', 'vback', '‹'),
               rel('span', 'vdot'),
               document.createTextNode('desktop · idle'));
  thumb.addEventListener('click', researchHide);
  thumb.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      researchHide();
    }
  });
  researchPaneEl.append(defs, rel('div', 'halo'), head,
                        research.boardEl, thumb);
  research.headEl = head;
}

function researchStats() {
  if (!research.statsEl) return;
  const cost = research.usd ? `$${Number(research.usd).toFixed(2)} · ` : '';
  research.statsEl.textContent = `${cost}${research.sites.size} sites`;
}

function researchCounts() {
  if (!research.countEl) return;
  research.countEl.textContent =
    `${research.workers} workers · ${research.queries} queries`;
  research.countEl.classList.add('hot');
  setTimeout(() => research.countEl &&
             research.countEl.classList.remove('hot'), 500);
}

function researchReset() {
  research.conv = null;
  research.usd = 0;
  research.workers = 0;
  research.queries = 0;
  research.sites.clear();
  research.lanes.clear();
  researchPaneEl.innerHTML = '';
  research.headEl = research.orbsEl =
    research.countEl = research.statsEl = null;
}

function researchShow() {
  clearTimeout(research.hideTimer);
  research.shown = true;
  researchPaneEl.hidden = false;
  requestAnimationFrame(() =>
    researchPaneEl.classList.add('in', 'live'));
}

function researchHide() {  // fade out; the DOM stays for a later re-show
  research.shown = false;
  researchPaneEl.classList.remove('in', 'live');
  clearTimeout(research.hideTimer);
  research.hideTimer = setTimeout(() => {
    if (!research.shown) researchPaneEl.hidden = true;
  }, 400);
}

function researchLane(agent, task) {
  let l = research.lanes.get(agent);
  if (l) return l;
  researchChrome();
  const workerIx = [...research.lanes.keys()]
    .filter(a => a !== 'main').length;
  const hue = agent === 'main'
    ? 'mint' : WORKER_HUES[workerIx % WORKER_HUES.length];
  const wrap = rel('div', `orbwrap ${hue}`);
  const orb = rel('div', 'orb');
  orb.style.animationDelay = `-${(((workerIx + 1) * 1.7) % 7).toFixed(1)}s`;
  const favs = rel('div', 'favs');
  const lines = rel('div', 'olines');
  wrap.append(orb, rel('div', 'oname', agent), favs, lines);
  research.orbsEl.appendChild(wrap);
  l = { el: wrap, orbEl: orb, favsEl: favs, linesEl: lines,
        pend: [], sites: new Set(), moreEl: null };
  research.lanes.set(agent, l);
  if (task) researchLine(l, clip(task, 60), true);
  return l;
}

// The last few things an agent touched, newest on top — presence, not
// a ledger: they dim as they age and slide off entirely.
function researchLine(l, text, thought) {
  const line = rel('div', `wline${thought ? ' thought' : ''}`, text);
  l.linesEl.prepend(line);
  while (l.linesEl.children.length > 3)
    l.linesEl.lastElementChild.remove();
}

// A spark lifts off the orb — the field moves because the agent moved.
function researchMote(l) {
  const mote = rel('i', 'mote');
  mote.style.setProperty('--mx', `${Math.round(Math.random() * 44 - 22)}px`);
  l.orbEl.appendChild(mote);
  setTimeout(() => mote.remove(), 1900);
}

// tracked calls keep the orb bright until their result lands — one
// group per call, one line per query (a batched search is one call)
function researchAct(agent, kind, texts, tracked) {
  const l = researchLane(agent);
  for (const t of texts)
    researchLine(l, `${KIND_ICON[kind]} ${clip(t, 42)}`);
  researchMote(l);
  if (tracked) {
    l.pend.push({ kind, done: false });
    l.el.classList.add('act');
  }
  if (kind === 'search' || kind === 'fetch') {
    research.queries += texts.length;
    researchCounts();
  }
  return l;
}

// A source lands under its agent's name as a favicon — real icon when
// reachable, hashed-letter chip when not. Deduped per lane; past a
// dozen the row folds into a "+n" chip.
function researchSource(l, dom) {
  if (!dom) return;
  research.sites.add(dom);
  if (l.sites.has(dom)) return;
  l.sites.add(dom);
  if (l.sites.size > 13) {
    if (!l.moreEl) {
      l.moreEl = rel('span', 'fav more');
      l.favsEl.appendChild(l.moreEl);
    }
    l.moreEl.textContent = `+${l.sites.size - 13}`;
    researchFavFit(l);
    return;
  }
  const f = rel('span', 'fav');
  f.title = dom;
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = 'https://www.google.com/s2/favicons?sz=32&domain=' +
            encodeURIComponent(dom);
  img.onerror = () => {
    img.remove();
    f.textContent = (dom[0] || '·').toUpperCase();
    let h = 0;
    for (const c of dom) h = (h * 31 + c.charCodeAt(0)) % 997;
    f.style.background = FAV_HUES[h % FAV_HUES.length];
  };
  f.appendChild(img);
  l.favsEl.appendChild(f);
  researchFavFit(l);
}

// Past ~9 chips the stack would overflow the lane and clip off the end;
// deepen the overlap instead so every fav and the "+n" stay visible.
function researchFavFit(l) {
  const n = l.favsEl.children.length;
  const w = l.favsEl.clientWidth;
  if (n < 2 || !w) return;
  const step = Math.max(6, Math.min(13, Math.floor((w - 18) / (n - 1))));
  l.favsEl.style.setProperty('--fav-ov', `${18 - step}px`);
}

// A result lands: the call's spark goes out, the bloom settles unless
// more calls are still in flight, and its sources favicon in under
// the agent's name.
function researchResolve(agent, kind, doms) {
  const l = research.lanes.get(agent);
  if (!l) return;
  const g = l.pend.find(x => x.kind === kind && !x.done);
  if (g) g.done = true;
  if (!l.pend.some(x => !x.done)) l.el.classList.remove('act');
  researchMote(l);
  (doms || []).forEach(d => researchSource(l, d));
  researchStats();
}

function researchFeed(m) {
  if (m.type === 'hello') {
    researchHide();
    researchReset();
    research.conv = m.running_conversation || null;
    return;
  }
  if (m.type === 'status') {
    if (m.state === 'idle') { researchHide(); researchReset(); }
    return;
  }
  if (m.type === 'cost') {
    if (m.conversation_id === research.conv) {
      research.usd = m.conversation_usd || m.session_usd || 0;
      researchStats();
    }
    return;
  }
  // The field mirrors the live run only — history lives in the transcript.
  if (!m.conversation_id || m.conversation_id !== runningConvId) return;
  if (research.conv !== m.conversation_id) {
    researchReset();
    research.conv = m.conversation_id;
  }
  const agent = m.agent || 'main';
  switch (m.type) {
    case 'action': {
      const tool = m.tool, a = m.args || {};
      if (VISUAL_ACTION_TOOLS.has(tool)) { researchHide(); return; }
      if (tool === 'web_search') {
        const qs = Array.isArray(a.queries) && a.queries.length
          ? a.queries : [a.query || 'search'];
        researchAct(agent, 'search', qs, true);
        researchShow();
      } else if (tool === 'fetch_url') {
        researchAct(agent, 'fetch', [hostOf(a.url) || a.url], true);
        researchShow();
      } else if (tool === 'spawn_agent' || tool === 'collect_agent') {
        const kind = tool === 'spawn_agent' ? 'spawn' : 'collect';
        researchAct(agent, kind, [`${kind} ${a.name || 'worker'}`], true);
        researchShow();
      } else if (tool === 'send_file') {
        researchAct(agent, 'send', [fileBase(a.path)]);
        researchShow();
      }
      return;
    }
    case 'action_result': {
      const res = String(m.result || '');
      const doms = [...new Set(
        ((m.urls && m.urls.length ? m.urls
                                  : res.match(RESULT_URL_RE) || [])
        ).map(hostOf).filter(Boolean))];
      const kind = m.tool === 'web_search' ? 'search'
                 : m.tool === 'fetch_url' ? 'fetch'
                 : m.tool === 'spawn_agent' ? 'spawn'
                 : m.tool === 'collect_agent' ? 'collect' : null;
      if (kind) researchResolve(agent, kind, doms);
      return;
    }
    case 'subagent': {
      const l = researchLane(m.name, m.state === 'running' ? m.task : '');
      if (m.state === 'running') {
        research.workers++;
        researchCounts();
        researchShow();
      } else {
        l.el.classList.remove('act');
        l.el.classList.add('done');
        const bits = [m.state];
        if (m.steps != null) bits.push(`${m.steps} steps`);
        researchLine(l, bits.join(' · '));
      }
      return;
    }
    case 'thought':
    case 'thinking': {
      const l = research.lanes.get(agent);
      if (l && m.text) researchLine(l, clip(m.text, 60), true);
      return;
    }
    case 'done':
      researchHide();
      researchReset();
      return;
  }
}

// ── agent websocket ─────────────────────────────────────────────────────
function connectChat() {
  const d = activeDev();
  if (!maySendSecret(d)) {
    if (chatWs) { try { chatWs.close(); } catch (_) {} chatWs = null; }
    // Same self-heal retry as the desktop stream.
    setTimeout(async () => {
      if (activeDev() === d && await ensureSecure(d)) connectChat();
    }, 15000);
    return;
  }
  if (chatWs) { try { chatWs.close(); } catch (_) {} }
  chatWs = new WebSocket(wsUrl());

  chatWs.onclose = () => setTimeout(connectChat, 3000);
  chatWs.onerror = () => chatWs.close();

  chatWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    researchFeed(m);
    if (m.conversation_id && TRANSCRIPT_TYPES.has(m.type)) {
      handleTranscriptEvent(m);
      return;
    }
    switch (m.type) {
      case 'hello':
        runningConvId = m.running_conversation || null;
        // The daemon's queue is the truth — a reconnect re-syncs it.
        queuedSeqs.clear();
        queuedEls.clear();
        for (const q of m.queue || []) {
          if (q.seq != null) queuedSeqs.set(qkey(q.conv, q.seq), q.mode);
        }
        setAgentState(m.state, m.run_started);
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
        setAgentState(m.state, m.run_started);
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
      case 'todos':
        // Live checklist state — not a transcript event; the fetched
        // conversation already carries the latest list during a refetch.
        if (m.conversation_id === activeConvId && convFetchId !== activeConvId) {
          renderTodoCard(m.items);
        }
        break;
      case 'thinking':
        // Model reasoning, broadcast live and never persisted — the
        // freshest bit of "what it's thinking" rides the typing row.
        if (runningConvId && runningConvId === activeConvId) {
          setLiveStatus(
            `${m.agent ? m.agent + ' · ' : ''}${clip(m.text, 140)}`,
            'thought', 'spark');
        }
        break;
      case 'cost':
        setCost(m);
        break;
      case 'dequeue':
        // A queued message was delivered into context (or dropped) — its
        // badge comes off the transcript bubble.
        for (const it of m.items || []) {
          const k = qkey(it.conv || activeConvId, it.seq);
          queuedSeqs.delete(k);
          const tag = queuedEls.get(k);
          queuedEls.delete(k);
          if (tag) {
            if (m.dropped) {
              tag.textContent = 'dropped';
              tag.classList.add('dropped');
            } else {
              tag.remove();
            }
          }
        }
        break;
      case 'error':
        addMsg('error', m.text, 'Error');
        notify(`${agentName} failed`, m.text || '');
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
  renderCtx();  // a late-arriving modelMeta may supply the window size
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
    // A device with no provider keys serves no models — point at Settings.
    if (!models.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'no models — add keys in Settings';
      o.disabled = true;
      modelSelect.appendChild(o);
      modelSelect.value = '';
    }
    // The select mirrors the viewed conversation's model; without an open
    // conversation it carries the preferred default for new ones.
    if (convModel) syncModel(convModel);
    else if (cfg.model && models.some(m => m.id === cfg.model))
      modelSelect.value = cfg.model;
    // Don't push the default mid-run — a cid-less set_model would only add
    // noise (the daemon ignores it for the live agent since the fix).
    if (!activeConvId && agentPhase === 'idle' && modelSelect.value)
      send({ type: 'set_model', model: modelSelect.value });
    setAgentName(modelSelect.value);
    updateModelInfo();
    if (!models.length) {
      modelInfoEl.textContent = 'this device has no models yet — ' +
        'add a provider key in Settings';
    }
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
  clearStaged();  // staged files target the old device's backend
  activeConvId = localStorage.getItem(convKey(dev.id)) || null;
  activeConvDevId = activeConvId ? dev.id : null;
  clearTranscript();
  takenOver = false;
  takeoverBanner.hidden = true;
  document.body.classList.remove('takeover');
  costHist.length = 0;
  drawSpark();
  setAgentState('idle');
  populateDeviceSelect();
  // Gate first: pair TLS (and ask before a plaintext downgrade) before any
  // channel that would carry the device password is opened.
  gateConnection(dev).finally(() => {
    syncScreen();
    connectChat();
    loadModels();
    loadConversations();
  });
  keyNote = null;  // key status describes the old device — drop it
  editingKey = null;
  if (settingsOpen()) { refreshKeys(); refreshDeviceCfg(); }
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
chatInput.addEventListener('input', () => {
  autosizeChatInput();
  syncSendBtn();
});
// Enter sends, Shift+Enter inserts a newline; while the agent works,
// ⌘/Ctrl+Enter steers the message into the run instead of queueing it.
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && agentPhase !== 'idle') submitChat(true);
    else $('chatForm').requestSubmit();
  }
});

// ── attachments ─────────────────────────────────────────────────────────
// Files stage as chips/thumbnails in the composer, then ride along on the
// task/answer ws message as base64. The daemon saves them under ~/uploads
// on the device (see save_attachments in agent_daemon.py).
const ATTACH_MAX_BYTES = 9 * 1024 * 1024;    // mirrors SEND_FILE_MAX_BYTES
const ATTACH_TOTAL_BYTES = 12 * 1024 * 1024; // ws frames cap at 16 MB incl. b64
const MAX_ATTACHMENTS = 8;                   // mirrors the daemon
let stagedFiles = [];  // {name, size, mime, file, url?}

function syncSendBtn() {
  sendBtn.disabled = !chatInput.value.trim() && !stagedFiles.length;
}

function renderAttachTray() {
  attachTray.innerHTML = '';
  stagedFiles.forEach((f, i) => {
    const isImg = f.mime.startsWith('image/');
    const chip = attachChip(f, true, () => {
      const [gone] = stagedFiles.splice(i, 1);
      if (gone.url) URL.revokeObjectURL(gone.url);
      renderAttachTray();
    });
    if (isImg) {
      chip.classList.add('img');
      chip.querySelector('svg').remove();
      const img = document.createElement('img');
      img.src = f.url;
      img.alt = f.name;
      chip.prepend(img);
    }
    attachTray.appendChild(chip);
  });
  syncSendBtn();
}

function stageFiles(list) {
  let rejected = 0;
  let total = stagedFiles.reduce((s, f) => s + f.size, 0);
  for (const f of list) {
    if (stagedFiles.length >= MAX_ATTACHMENTS) {
      addMsg('error', `at most ${MAX_ATTACHMENTS} files per message`, 'Error');
      break;
    }
    if (f.size > ATTACH_MAX_BYTES || total + f.size > ATTACH_TOTAL_BYTES) {
      rejected++;
      continue;
    }
    total += f.size;
    stagedFiles.push({
      name: f.name || 'file', size: f.size,
      mime: f.type || 'application/octet-stream', file: f,
      url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
    });
  }
  if (rejected) {
    addMsg('error',
      `${rejected} file${rejected > 1 ? 's' : ''} skipped — ` +
      `${ATTACH_MAX_BYTES / 1e6} MB each, ` +
      `${ATTACH_TOTAL_BYTES / 1e6} MB total per message`, 'Error');
  }
  renderAttachTray();
}

function clearStaged() {
  for (const f of stagedFiles) if (f.url) URL.revokeObjectURL(f.url);
  stagedFiles = [];
  renderAttachTray();
}

const fileToB64 = (f) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});

async function encodeStaged() {
  const out = [];
  for (const f of stagedFiles) {
    out.push({ name: f.name, mime: f.mime, data: await fileToB64(f.file) });
  }
  return out;
}

attachBtn.onclick = () => filePicker.click();
filePicker.onchange = () => {
  stageFiles([...filePicker.files]);
  filePicker.value = '';
};

// Pasted screenshots/files go straight into the draft.
chatInput.addEventListener('paste', (e) => {
  if (e.clipboardData && e.clipboardData.files.length) {
    e.preventDefault();
    stageFiles([...e.clipboardData.files]);
  }
});

// Drag anywhere over the chat pane; the veil marks the drop target.
let dragDepth = 0;
chatPane.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) dropVeil.hidden = false;
});
chatPane.addEventListener('dragover', (e) => e.preventDefault());
chatPane.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropVeil.hidden = true; }
});
chatPane.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropVeil.hidden = true;
  stageFiles([...e.dataTransfer.files]);
  chatInput.focus();
});

// Every message runs on the selected device with the conversation's model.
// One agent per device: while it works, sends queue behind the run (the
// agent picks them up when it finishes, before cleanup) — or `steer`
// pushes the message into the running context at the next step.
async function submitChat(steer) {
  const text = chatInput.value.trim();
  if (!text && !stagedFiles.length) return;
  let files;
  try {
    files = await encodeStaged();
  } catch (_) {
    addMsg('error', 'could not read an attachment — remove it and retry',
      'Error');
    return;
  }
  if (awaitingAnswer) {
    chatInput.value = '';
    autosizeChatInput();
    awaitingAnswer = false;
    syncPlaceholder();
    send({ type: 'answer', text, files });
    clearStaged();
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
  send({ type: 'task', conversation_id: activeConvId, text, files, steer });
  clearStaged();
}
$('chatForm').onsubmit = (e) => { e.preventDefault(); submitChat(false); };
steerBtn.onclick = () => submitChat(true);
syncSendBtn();

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
const localRemoveBtn = $('localRemove');
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
const SEARCH_ICON = 'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28' +
  'v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 ' +
  '1 9.5 14z';
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
  // url: the "key" is a server address, not a secret — the card gets a
  // plain-text field, a Test probe, and a live status line.
  { key: 'OLLAMA_API_BASE', name: 'Ollama', url: true,
    models: 'Any model your server has pulled',
    icon: 'M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z' },
  // optKey: a companion env key — an optional API key stored next to the
  // server address; a blank field keeps whatever the device already has.
  { key: 'OPENAI_COMPAT_BASE', name: 'OpenAI-compatible', url: true,
    optKey: 'OPENAI_COMPAT_API_KEY',
    models: 'vLLM · LM Studio · llama.cpp · LocalAI',
    icon: 'M4.5 4h15A1.5 1.5 0 0 1 21 5.5v3A1.5 1.5 0 0 1 19.5 10h-15A1.5 1.5 0 0 1 3 8.5v-3A1.5 1.5 0 0 1 4.5 4zM4.5 14h15a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-3A1.5 1.5 0 0 1 4.5 14z' },
  // Search providers — no models, they feed the agent's web_search. Only
  // one is used at a time: Tavily, else Brave, else Serper. `note`
  // replaces the generic "models show up in the picker" success line.
  { key: 'TAVILY_API_KEY', name: 'Tavily',
    models: 'web_search for agents — free tier at tavily.com',
    note: 'the agent’s web_search starts using it right away.',
    icon: SEARCH_ICON },
  { key: 'BRAVE_API_KEY', name: 'Brave Search',
    models: 'web_search — free tier at brave.com/search/api',
    note: 'the agent’s web_search starts using it right away.',
    icon: SEARCH_ICON },
  { key: 'SERPER_API_KEY', name: 'Serper',
    models: 'web_search via Google — free credits at serper.dev',
    note: 'the agent’s web_search starts using it right away.',
    icon: SEARCH_ICON },
];

const keysBox = $('keysBox');
const keysTargetEl = $('keysTarget');
const keysHintEl = $('keysHint');
const keyStatusEl = $('keyStatus');
const providerGrid = $('providerGrid');
const providerCards = {};
const keystoreBar = $('keystoreBar');
const keystoreList = $('keystoreList');
const keystorePush = $('keystorePush');
let editingKey = null;

// ── local key store ─────────────────────────────────────────────────────
// Keys entered in the app are also kept on this computer (localStorage,
// next to the device passwords) so a key used on one backend can be pushed
// to another without re-pasting it. Nothing leaves the machine until an
// explicit push; remote daemons never hand key values back.
let vault = loadVault();

function loadVault() {
  try {
    const v = JSON.parse(localStorage.getItem('gut.keystore') || '{}');
    return Object.fromEntries(Object.entries(v).filter(
      ([k, val]) => PROVIDERS.some(p => p.key === k || p.optKey === k)
                    && String(val).trim()));
  } catch (_) { return {}; }
}

function saveVault() {
  localStorage.setItem('gut.keystore', JSON.stringify(vault));
}

function vaultSet(key, value) {
  value = String(value || '').trim();
  if (value) vault[key] = value;
  else delete vault[key];
  saveVault();
}
// Where the cards are pointing and what the device reported. 'local' mode:
// Electron writes the local stack's .env via IPC. 'remote': the daemon's
// /api/keys endpoint — keys are uploaded to and stored on that machine.
// The other modes explain why the cards are read-only right now.
let keyMode = 'checking';  // local | remote | offline | auth | old | checking
let remoteKeys = {};       // env key -> {set, source}
let keyNote = null;        // sticky status line, like localNote

function provBtn(text, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = text;
  return b;
}

function keyStateFor(k) {
  if (keyMode === 'local') return { set: !!localKeysSet[k], source: 'local' };
  if (keyMode === 'remote') {
    const s = remoteKeys[k] || {};
    return { set: !!s.set, source: s.source || null };
  }
  return { set: false, source: null };
}

function updateKeysHeader() {
  const d = keyDev();
  const name = d.name || d.host;
  keysTargetEl.textContent = `— ${name}`;
  let hint;
  switch (keyMode) {
    case 'local':
      hint = 'Keys are stored on this computer only, in the local ' +
        'stack\u2019s .env — they never leave the machine. At least one is ' +
        'required to start the local desktop; changes apply on its next ' +
        'start.';
      break;
    case 'remote':
      hint = `Keys are stored on ${name} (${d.host}) — they upload over ` +
        'plain HTTP and are saved on that machine, so the agent there ' +
        'can call model providers. Anyone with the device password can ' +
        'change them. Keys you paste are also remembered on this ' +
        'computer, ready to push to other devices.';
      break;
    case 'auth':
      hint = `${name} requires its device password before the app can ` +
        'see or change its keys — set it on the device below.';
      break;
    case 'old':
      hint = `${name} runs an older backend that can\u2019t take keys ` +
        'from the app. Update it (the ↑ button on its row in Devices ' +
        'below) or set keys in its env on the server itself.';
      break;
    case 'offline':
      hint = `${name} isn\u2019t answering` +
        (devInfo[d.id]?.offlineReason
          ? ` — ${devInfo[d.id].offlineReason}`
          : ` on :${d.secure ? (d.tlsPort || AGENT_TLS_PORT) : AGENT_PORT}`) +
        '. The app can\u2019t see or change its keys until it\u2019s back.';
      break;
    default:
      hint = `Checking which keys ${name} has…`;
  }
  keysHintEl.textContent = hint;
  keyStatusEl.hidden = !keyNote;
  keyStatusEl.textContent = keyNote || '';
}

// Which device the provider cards manage — follows the row clicked in the
// device list below (editingDevId), falling back to the active device, so
// the keys you see always belong to the device you're looking at.
function keyDev() {
  return cfg.devices.find(d => d.id === editingDevId) || activeDev();
}

// Refresh the cards for the key-target device — called on settings open,
// device switch and row select. For the Electron local device this is the
// .env key map; for everything else it asks the daemon which providers it
// can serve.
async function refreshKeys() {
  const d = keyDev();
  if (gut && d.id === 'local') {
    keyMode = 'local';
    try { localKeysSet = await gut.localKeys(); } catch (_) {}
    // The local stack's .env is readable from here — fold its keys into
    // the app's own store so they can be pushed to other devices.
    try {
      const vals = gut.localKeyValues ? await gut.localKeyValues() : {};
      let changed = false;
      for (const p of PROVIDERS) {
        const v = String(vals[p.key] || '').trim();
        if (v && vault[p.key] !== v) { vault[p.key] = v; changed = true; }
      }
      if (changed) saveVault();
    } catch (_) { /* older shell without the bridge */ }
    renderProviderKeys();
    return;
  }
  keyMode = 'checking';
  renderProviderKeys();
  try {
    const r = await devFetch(d, '/api/keys', { signal: probeSignal() });
    if (d.id !== keyDev().id) return;  // target switched mid-fetch
    if (r.ok) {
      remoteKeys = await r.json();
      keyMode = 'remote';
    } else if (r.status === 401 || r.status === 403) {
      keyMode = 'auth';
    } else if (r.status === 404 || r.status === 405) {
      keyMode = 'old';  // daemon predates /api/keys
    } else {
      keyMode = 'offline';
    }
  } catch (_) {
    if (d.id !== keyDev().id) return;
    keyMode = 'offline';
  }
  renderProviderKeys();
}

// POST a {ENV_KEY: value} map to a remote device's /api/keys and fold the
// response back into the UI (remoteKeys, the row's key badge, the model
// picker). Sets keyNote; returns true when the device stored the keys.
async function pushKeysRemote(d, keys, okNote) {
  const name = d.name || d.host;
  let r;
  try {
    r = await devFetch(d, '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
  } catch (_) {
    keyNote = `Could not reach ${name} — nothing was changed.`;
    return false;
  }
  if (r.status === 404 || r.status === 405) {
    keyMode = 'old';  // daemon predates /api/keys
    keyNote = null;
    return false;
  }
  if (!r.ok) {
    keyNote = `Save failed (HTTP ${r.status}) — nothing was changed.`;
    return false;
  }
  const j = await r.json();
  remoteKeys = j.keys || remoteKeys;
  serverCache.key = null;  // a pushed server base may have changed
  keyNote = j.applied === false
    ? `Saved on ${name}, but the model router rejected it — the ` +
      `device keeps retrying (${j.error || 'unknown error'}).`
    : okNote;
  // LiteLLM applies DB models on a short poll — refresh the picker
  // now and once more after the change has landed.
  loadModels();
  setTimeout(loadModels, 8000);
  const info = devInfo[d.id];
  if (info) {
    info.keys =
      Object.values(remoteKeys).filter(k => k && k.set).length;
    if (settingsOpen()) renderDeviceList();
  }
  return true;
}

// Store one or more provider values — `updates` is an env-key map: a server
// card commits its base plus, for compat, an optional API key. All-empty
// values = a removal.
async function saveProviderKeys(p, updates) {
  const d = keyDev();
  const removing = !Object.values(updates).some(v => String(v).trim());
  const noun = p.url ? 'server' : 'key';
  if (p.url) serverCache.key = null;  // base changed — probe fresh
  if (keyMode === 'local') {
    try {
      localKeysSet = await gut.saveLocalKeys(updates);
      for (const [k, v] of Object.entries(updates))
        if (String(v).trim()) vaultSet(k, v);  // keep it for other devices
      keyNote = null;
    } catch (e) {
      keyNote = `Could not save the ${noun}: ${e?.message || 'error'}`;
    }
    editingKey = null;
    renderProviderKeys();
    return;
  }
  const name = d.name || d.host;
  // Keys leave this machine — say so plainly before they go.
  if (!removing && !confirm(
      `Upload your ${p.name} ${noun} to ${name} (${d.host})?\n\n` +
      'It is sent over plain HTTP and stored on that machine — its ' +
      `agent needs it to call ${p.url ? 'the server' : 'the provider'}.`)) {
    editingKey = null;
    renderProviderKeys();
    return;
  }
  keyNote = removing ? `Removing the ${p.name} ${noun} from ${name}…`
                     : `Uploading the ${p.name} ${noun} to ${name}…`;
  renderProviderKeys();
  const ok = await pushKeysRemote(d, updates,
    removing ? `${p.name} ${noun} removed from ${name}.`
             : `${p.name} ${noun} is now on ${name} — ` +
               (p.note || 'its models show up in the picker within a ' +
                'few seconds.'));
  if (ok && !removing)
    for (const [k, v] of Object.entries(updates))
      if (String(v).trim()) vaultSet(k, v);
  editingKey = null;
  renderProviderKeys();
}

// Push every key in the local store to the device the cards point at —
// one shot for a fresh VPS. Only adds/overwrites; the device's other
// keys are untouched.
keystorePush.onclick = async () => {
  const d = keyDev();
  const keys = {};
  for (const p of PROVIDERS) {
    if (vault[p.key]) keys[p.key] = vault[p.key];
    if (p.optKey && keys[p.key] && vault[p.optKey])
      keys[p.optKey] = vault[p.optKey];  // a server key rides with its base
  }
  if (!Object.keys(keys).length) return;
  const name = d.name || d.host;
  if (keyMode === 'local') {
    try {
      localKeysSet = await gut.saveLocalKeys(keys);
      keyNote = 'Saved keys written to the local stack’s .env — ' +
        'they apply on its next start.';
    } catch (e) {
      keyNote = `Could not save the keys: ${e?.message || 'error'}`;
    }
    renderProviderKeys();
    return;
  }
  if (keyMode !== 'remote') return;
  const names = PROVIDERS.filter(p => keys[p.key])
    .map(p => p.name).join(', ');
  if (!confirm(
      `Push your saved keys (${names}) to ${name} (${d.host})?\n\n` +
      'They are sent over plain HTTP and stored on that machine, ' +
      'replacing keys already set for these providers.')) return;
  keyNote = `Pushing saved keys to ${name}…`;
  renderProviderKeys();
  await pushKeysRemote(d, keys,
    `Saved keys are now on ${name} — its models show up in the ` +
    'picker within a few seconds.');
  editingKey = null;
  renderProviderKeys();
};

// ── LAN server probing ──────────────────────────────────────────────────
// "Does this AI work?" for server providers — the device probes via its own
// endpoint (its network is the one the agent runs on); when it can't answer
// — stack stopped, old backend — the app tries the address itself: a LAN
// server answers this machine just as well.
const LOCAL_VISION =
  /llava|moondream|minicpm-v|qwen[\d.]*-?vl|vision|gemma[ -]?[3-9](?![ -]?1b)|mistral-small|granite|bakllava/i;
let serverCache = { key: null, at: 0, res: null };

const sigTimeout = (ms) =>
  AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;

// '192.168.1.5' → 'http://192.168.1.5:11434' — mirrors the daemon's
// normalize_ollama_base, keep them in step.
function normOllamaBase(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!b.includes('://')) b = `http://${b}`;
  try {
    const u = new URL(b);
    if (!u.hostname || u.username || u.password) return '';
    if (!u.port && u.protocol === 'http:') u.port = '11434';
    return `${u.protocol}//${u.host}`;
  } catch (_) { return ''; }
}

// '192.168.1.5:8000' → 'http://192.168.1.5:8000/v1' — OpenAI-compatible
// servers mount at /v1; a pasted path wins. Mirrors normalize_compat_base.
function normCompatBase(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!b.includes('://')) b = `http://${b}`;
  try {
    const u = new URL(b);
    if (!u.hostname || u.username || u.password) return '';
    const path = u.pathname.replace(/\/+$/, '') || '/v1';
    return `${u.protocol}//${u.host}${path}`;
  } catch (_) { return ''; }
}

// Per-server-provider probe spec: how to normalize an address, ask the
// device to check it, and read its model listing directly.
const SERVER_PROVIDERS = {
  OLLAMA_API_BASE: {
    normBase: normOllamaBase,
    example: '192.168.1.5 or http://192.168.1.5:11434',
    // Longer than probeSignal — the daemon's own probe waits up to 8s on a
    // dead host, and we want its error message, not our timeout.
    deviceProbe: (d, base) => devFetch(d,
      `/api/ollama${base ? `?base=${encodeURIComponent(base)}` : ''}`,
      { signal: sigTimeout(12000) }),
    directPath: '/api/tags',
    models: (j) => (j.models || []).filter(m => m.name).map(m => ({
      name: m.name,
      vision: (m.details?.families || []).includes('clip')
              || LOCAL_VISION.test(m.name) })),
  },
  OPENAI_COMPAT_BASE: {
    normBase: normCompatBase,
    example: '192.168.1.5:8000 or http://host:1234/v1',
    // key absent → the device uses its stored key; '' → anonymous probe.
    deviceProbe: (d, base, key) => devFetch(d, '/api/compat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(key === undefined ? { base } : { base, key }),
      signal: sigTimeout(12000) }),
    directPath: '/models',
    models: (j) => (j.data || []).filter(m => m.id).map(m => ({
      name: m.id, vision: LOCAL_VISION.test(m.id) })),
  },
};
const serverSpec = (p) => SERVER_PROVIDERS[p.key];

async function probeServerViaDevice(p, d, base, key) {
  try {
    const r = await serverSpec(p).deviceProbe(d, base, key);
    if (r.ok) return { ...await r.json(), via: 'device' };
    if (r.status === 404 || r.status === 405) return { via: 'old' };
    if (r.status === 401 || r.status === 403) return { via: 'auth' };
  } catch (_) { /* device unreachable */ }
  return null;
}

async function probeServerDirect(p, base, key) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  try {
    const r = await fetch(`${base}${serverSpec(p).directPath}`,
                          { headers, signal: probeSignal() });
    if (!r.ok)
      return { reachable: false, base, error: `HTTP ${r.status}`, via: 'app' };
    return { reachable: true, base, via: 'app',
             models: serverSpec(p).models(await r.json()) };
  } catch (e) {
    return { reachable: false, base, via: 'app',
             error: (e?.name === 'TimeoutError' || e?.name === 'AbortError')
               ? 'timed out' : 'no answer' };
  }
}

function paintServerStatus(p, el, res, d) {
  el.hidden = false;
  el.title = '';
  if (!res || res.via === 'old') {
    el.className = 'prov-status err';
    el.textContent = `Can’t test it — ${d.name || d.host} isn’t answering` +
      (res?.via === 'old' ? ' (backend too old).' : '.');
    return;
  }
  if (res.via === 'auth') {
    el.className = 'prov-status';
    el.textContent = 'Set the device password below to test the server.';
    return;
  }
  if (!res.reachable) {
    el.className = 'prov-status err';
    el.textContent = `✗ no ${p.name} server at ${res.base || 'that address'}` +
      (res.error ? ` — ${res.error}` : '');
    return;
  }
  const ms = res.models || [];
  const vis = ms.filter(m => m.vision).length;
  el.className = vis ? 'prov-status ok' : 'prov-status warn';
  el.textContent = !ms.length
    ? '✓ server answers — but it serves no models'
    : `✓ works — ${ms.length} model${ms.length === 1 ? '' : 's'}` +
      (vis ? `, ${vis} can see`
           : ' — none can see; the agent needs a vision model ' +
             '(llava, qwen-vl, gemma3…)');
  el.title = `${res.base}\n` +
    ms.map(m => `${m.name}${m.vision ? ' (vision)' : ''}`).join(', ');
  // A direct probe that hit 'localhost' reached the server on THIS machine —
  // inside the desktop container that name resolves to the container
  // itself, so the agent still wouldn't see it.
  try {
    if (res.via === 'app' &&
        /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(
          new URL(res.base).hostname)) {
      el.className = 'prov-status warn';
      el.textContent += ' — note: “localhost” won’t work from the ' +
        'desktop container; use host.docker.internal or the LAN IP';
    }
  } catch (_) { /* unparseable base — the status line already says enough */ }
}

// Probes the saved (or, with opts.base, a typed-but-unsaved) server and
// paints the result into the card's status line. opts.key rides along for
// providers with an optKey — undefined = the device's stored key, '' = none.
// 30s cache so settings re-renders don't re-poke the server.
async function refreshServerStatus(p, c,
                                   { force = false, base = '', key } = {}) {
  const d = keyDev();
  const el = c.status;
  const spec = serverSpec(p);
  const cacheKey = `${d.id}|${p.key}|${base}|${key ?? ''}`;
  if (!force && serverCache.key === cacheKey &&
      Date.now() - serverCache.at < 30000) {
    paintServerStatus(p, el, serverCache.res, d);
    return;
  }
  el.hidden = false;
  el.className = 'prov-status';
  el.textContent = `Checking the ${p.name} server…`;
  el.title = '';
  let res = await probeServerViaDevice(p, d, base, key);
  if ((!res || res.via === 'old' || res.via === 'auth')
      && (base || vault[p.key])) {
    const direct = spec.normBase(base || vault[p.key]);
    const dk = key !== undefined ? key : (p.optKey && vault[p.optKey]) || '';
    res = direct ? await probeServerDirect(p, direct, dk) : res;
  }
  if (d.id !== keyDev().id) return;  // target switched mid-probe
  serverCache = { key: cacheKey, at: Date.now(), res };
  paintServerStatus(p, el, res, d);
}

function renderProviderKeys() {
  updateKeysHeader();
  // The app's own key store — visible even when the target device can't
  // be managed right now, since the copy lives on this computer.
  const saved = PROVIDERS.filter(p => vault[p.key]);
  keystoreBar.hidden = !saved.length;
  if (saved.length) {
    keystoreList.innerHTML = '';
    keystoreList.append('Saved on this computer:');
    for (const p of saved) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'keystore-chip';
      chip.textContent = `${p.name} ×`;
      chip.title = `Forget the saved ${p.name} ${p.url ? 'address' : 'key'}`;
      chip.onclick = () => {
        if (confirm(`Forget the ${p.name} ${p.url ? 'address' : 'key'} ` +
                   'saved on this computer? Devices that already have ' +
                   'it keep their copy.')) {
          vaultSet(p.key, '');
          renderProviderKeys();
        }
      };
      keystoreList.appendChild(chip);
    }
    const d = keyDev();
    keystorePush.textContent = `Push all to ${d.name || d.host}`;
    keystorePush.disabled = keyMode !== 'local' && keyMode !== 'remote';
  }
  const manageable = keyMode === 'local' || keyMode === 'remote';
  // When keys can't be managed right now the five identical dead cards are
  // just noise — collapse to the single status line in the header.
  providerGrid.hidden = !manageable;
  if (!manageable) return;
  for (const p of PROVIDERS) {
    const c = providerCards[p.key];
    const { set, source } = keyStateFor(p.key);
    const editing = editingKey === p.key;
    const noun = p.url ? 'server' : 'key';
    // The pill says where the key physically lives, not just "saved".
    c.state.textContent = source === 'env' ? 'Server env'
      : set ? (keyMode === 'local' ? 'In .env' : 'On device')
      : (p.url ? 'No server' : 'No key');
    c.state.classList.toggle('set', set);
    // A refresh mid-edit must not wipe the paste field.
    if (editing && c.actions.querySelector('.prov-key-input')) continue;
    c.actions.innerHTML = '';
    if (editing) {
      const spec = p.url ? serverSpec(p) : null;
      const input = document.createElement('input');
      input.className = 'prov-key-input';
      input.dataset.envKey = p.key;
      input.type = p.url ? 'text' : 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = p.url ? spec.example
                              : `Paste your ${p.name} key…`;
      let keyInput = null;
      if (p.optKey) {
        keyInput = document.createElement('input');
        keyInput.className = 'prov-key-input';
        keyInput.dataset.envKey = p.optKey;
        keyInput.type = 'password';
        keyInput.autocomplete = 'off';
        keyInput.spellcheck = false;
        keyInput.placeholder = 'API key — only if the server needs one';
        keyInput.title = keyStateFor(p.optKey).set
          ? 'A key is already on the device — blank keeps it'
          : 'Most LAN servers need no key — blank means none';
      }
      const save = provBtn('Save', 'primary');
      const cancel = provBtn('Cancel', 'ghost');
      const badAddr = () => {
        c.status.hidden = false;
        c.status.className = 'prov-status err';
        c.status.title = '';
        c.status.textContent = 'That doesn’t look like an address — ' +
          `try ${spec.example}`;
      };
      const commit = () => {
        const v = input.value.trim();
        if (!v) { editingKey = null; renderProviderKeys(); return; }
        if (p.url) {
          const b = spec.normBase(v);
          if (!b) { badAddr(); return; }
          const updates = { [p.key]: b };
          if (keyInput?.value.trim()) updates[p.optKey] = keyInput.value.trim();
          saveProviderKeys(p, updates);
          return;
        }
        saveProviderKeys(p, { [p.key]: v });
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
      if (keyInput) keyInput.onkeydown = input.onkeydown;
      if (p.url) {
        // Test before saving — probes the typed address.
        const test = provBtn('Test', 'ghost');
        test.title = 'Check the server answers before saving';
        test.onclick = () => {
          const b = spec.normBase(input.value);
          if (!b) { badAddr(); return; }
          // A blank key field means "what the device has" — same as Save.
          refreshServerStatus(p, c, { force: true, base: b,
            key: keyInput ? keyInput.value.trim() || undefined : undefined });
        };
        c.actions.append(input);
        if (keyInput) {
          input.classList.add('wide');
          keyInput.classList.add('wide');
          c.actions.append(keyInput);
        }
        c.actions.append(test, save, cancel);
      } else {
        c.actions.append(input, save, cancel);
      }
      input.focus();
    } else if (set) {
      const replace = provBtn(source === 'env' ? 'Override' : 'Replace');
      if (source === 'env') {
        replace.title = `This ${noun} is set on the server itself — ` +
          'pushing your own overrides it';
      }
      replace.onclick = () => { editingKey = p.key; renderProviderKeys(); };
      c.actions.append(replace);
      if (p.url) {
        const test = provBtn('Test', 'ghost');
        test.title = 'Re-check the server now';
        test.onclick = () => refreshServerStatus(p, c, { force: true });
        c.actions.append(test);
      }
      if (source !== 'env') {
        const remove = provBtn('Remove', 'danger');
        remove.onclick = () => {
          const where = keyMode === 'local'
            ? 'Its models stop working the next time the local desktop starts.'
            : `Its models stop working on ${keyDev().name || 'the device'}.`;
          if (confirm(`Remove the ${p.name} ${noun}? ${where}`)) {
            saveProviderKeys(p, { [p.key]: '',
              ...(p.optKey ? { [p.optKey]: '' } : {}) });
          }
        };
        c.actions.append(remove);
      }
    } else {
      const saved = vault[p.key];
      if (saved) {
        const use = provBtn(p.url ? 'Use saved address' : 'Use saved key');
        use.classList.add('grow');
        use.title = `Push the ${p.name} ${noun} saved on this computer ` +
          `to ${keyDev().name || keyDev().host}`;
        use.onclick = () => saveProviderKeys(p, { [p.key]: saved,
          ...(p.optKey && vault[p.optKey] ? { [p.optKey]: vault[p.optKey] }
                                        : {}) });
        c.actions.append(use);
      }
      const add = provBtn(saved ? (p.url ? 'Another address…' : 'Paste a key…')
                              : `Add ${p.name} ${noun}`);
      add.classList.add(saved ? 'ghost' : 'grow');
      add.onclick = () => { editingKey = p.key; renderProviderKeys(); };
      c.actions.append(add);
    }
    // Server cards carry a live "does it work" line once a server is set —
    // probed from the device when possible.
    if (p.url) {
      if (set && !editing) refreshServerStatus(p, c);
      else if (!editing) c.status.hidden = true;
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
    `<div class="prov-actions"></div>` +
    `<div class="prov-status" hidden></div>`;
  providerGrid.appendChild(card);
  providerCards[p.key] = {
    state: card.querySelector('.prov-state'),
    actions: card.querySelector('.prov-actions'),
    status: card.querySelector('.prov-status'),
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
  localState = await gut.localStatus();
  // Remove applies to any existing stack, running or stopped — never to a
  // bare Docker install where nothing was created yet.
  localRemoveBtn.hidden = !localState.exists;
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
        if (keyMode === 'local') {
          for (const input of
               providerGrid.querySelectorAll('.prov-key-input')) {
            const v = input.value.trim();
            if (v) keys[input.dataset.envKey] = v;
          }
        }
        localStatusEl.textContent = 'Starting local desktop…';
        const r = await gut.startLocal(keys);
        if (r.ok) {
          for (const [k, v] of Object.entries(keys)) vaultSet(k, v);
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

  localRemoveBtn.onclick = async () => {
    if (!confirm('Remove the local desktop entirely? Its containers, ' +
        'volumes, the desktop image and the generated config are deleted — ' +
        'Start local desktop can recreate it later.')) return;
    localRemoveBtn.disabled = true;
    localNote = null;
    localLogEl.hidden = false;
    localLogEl.textContent = '';
    localStatusEl.textContent = 'Removing the local desktop…';
    try {
      const r = await gut.removeLocal();
      if (!r?.ok) {
        localNote = `Remove failed: ${r?.error || 'see log'}`;
      } else if (cfg.devices.some(d => d.id === 'local')) {
        // The local row now points at a backend that no longer exists.
        removeDevice('local');
      }
    } finally {
      localRemoveBtn.disabled = false;
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
  if (d.vncPassword && maySendSecret(d)) {
    headers.Authorization = `Bearer ${d.vncPassword}`;
  }
  return fetch(`${devAgentBase(d)}${path}`, { ...opts, headers });
}

// Dead hosts hang fetch() until the OS TCP timeout (~75s) — cap probes.
const probeSignal = () =>
  AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;

async function probeDevice(d) {
  // Mutate in place — a row may carry UI state (updating, updateError) that
  // a probe must not wipe.
  const cur = devInfo[d.id] || (devInfo[d.id] = {});
  cur.pending = true;
  // Pair TLS when the device isn't already pinned — picks up encryption
  // after a backend update, and re-pins a rotated cert after an outage.
  if (gut?.tlsHandshake && (!d.secure || cur.offline)) {
    await ensureSecure(d);
  }
  try {
    const r = await devFetch(d, '/api/version', { signal: probeSignal() });
    if (r.ok) {
      const j = await r.json();
      Object.assign(cur, { version: j.version, install: j.install,
                           device: j.device, offline: false });
      delete cur.offlineReason;
      delete cur.legacy;
      // How many provider keys the device can serve — the row's key badge.
      try {
        const kr = await devFetch(d, '/api/keys');
        if (kr.ok) {
          const kj = await kr.json();
          cur.keys =
            Object.values(kj).filter(k => k && k.set).length;
        } else if (kr.status !== 401) {
          cur.keys = null;  // daemon predates /api/keys — nothing to show
        }
      } catch (_) { /* keep the last known count */ }
    } else {
      // Any HTTP answer means the backend is alive — daemons older than
      // this route just report "online", no version.
      Object.assign(cur, { offline: false, legacy: true });
      delete cur.offlineReason;
      delete cur.version;
    }
  } catch (e) {
    cur.offline = true;
    cur.offlineReason = await offlineReason(d, e);
  }
  cur.pending = false;
}

// fetch() collapses refused/DNS/reset into one opaque TypeError — poke the
// noVNC port too so the row can say whether the host or the agent is down.
async function offlineReason(d, err) {
  if (err?.name === 'SyntaxError') {
    return `answered on :${AGENT_PORT} but isn't a gut agent`;
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `no answer on :${AGENT_PORT} (timed out)`;
  }
  try {
    const vncBase = d.secure
      ? `https://${d.host}:${d.tlsVncPort || NOVNC_TLS_PORT}`
      : `http://${d.host}:${NOVNC_PORT}`;
    await fetch(`${vncBase}/`, { signal: probeSignal() });
    return `host is up but the agent isn't answering on ` +
           `:${d.secure ? (d.tlsPort || AGENT_TLS_PORT) : AGENT_PORT}`;
  } catch (_) {
    return `${d.host} isn't responding — powered off, wrong network, ` +
           'or firewalled?';
  }
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
  if (aboutOpen()) closeAbout();
  settingsPage.hidden = false;
  document.body.classList.add('settings-open');
}

function closeSettings() {
  settingsPage.hidden = true;
  document.body.classList.remove('settings-open');
  clearInterval(devProbeTimer);
  devProbeTimer = null;
  // While settings hid the pane (display:none) noVNC's observer scaled the
  // canvas to 0 — and its expected-size check then skips the restore on
  // unhide, leaving a dark pane. Re-setting scaleViewport forces a rescale.
  requestAnimationFrame(() => { if (rfb) rfb.scaleViewport = true; });
}

// Devices re-probe on a timer while the page is open — an "offline" label
// is a live status, not a snapshot from whenever the page was last opened.
let devProbeTimer = null;

function startDeviceProbe() {
  clearInterval(devProbeTimer);
  devProbeTimer = setInterval(() => {
    Promise.all(cfg.devices.map(probeDevice))
      .then(() => { if (settingsOpen()) renderDeviceList(); });
  }, 5000);
}

// editingDevId === null means the form is in "new device" mode.
let editingDevId = null;

function fillDeviceForm(d) {
  editingDevId = d.id;
  devNameInput.value = d.name;
  hostInput.value = d.host;
  vncPassInput.value = d.vncPassword;
  renderDeviceList();
  keyNote = '';
  refreshKeys();  // cards follow the device being looked at
  refreshDeviceCfg();
}

function newDeviceForm() {
  editingDevId = null;
  devNameInput.value = '';
  hostInput.value = '';
  vncPassInput.value = '';
  renderDeviceList();
  keyNote = '';
  refreshKeys();
  refreshDeviceCfg();
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
    ver.textContent = info?.offline
      ? `· offline${info.offlineReason ? ` — ${info.offlineReason}` : ''}`
      : info?.version ? `· v${info.version}`
      : info?.legacy ? '· online'
      : info?.pending ? '· checking…' : '';
    ver.title = info?.offline ? (info.offlineReason || '') : '';
    ver.classList.toggle('bad', !!info?.offline);
    // Transport state: 'unencrypted' marks pre-TLS backends; it turns bad
    // when the device encrypted before — silence now means downgrade risk.
    if (!info?.offline && gut?.tlsHandshake && !d.secure) {
      ver.textContent += ' · unencrypted';
      if (d.tlsSeen || d.tlsError) {
        ver.classList.add('bad');
        ver.title = d.tlsSeen
          ? `previously encrypted — now refusing plaintext ` +
            `fallback (${d.tlsError || 'secure endpoint down'})`
          : `unencrypted connection (${d.tlsError})`;
      }
    }
    // Provider-key count: the API when the daemon answers, the local
    // stack's .env for the Electron local device.
    let keyCount = info?.keys;
    if (keyCount == null && gut && d.id === 'local') {
      keyCount = Object.values(localKeysSet).filter(Boolean).length;
    }
    if (!info?.offline && keyCount != null) {
      ver.textContent += keyCount
        ? ` · ${keyCount} key${keyCount > 1 ? 's' : ''}` : ' · no keys';
    }
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
  const removed = cfg.devices.find(d => d.id === id);
  if (removed && gut?.tlsForget) gut.tlsForget(removed.host);
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
  refreshKeys();  // the removed row may have been the keys target
  refreshDeviceCfg();
  if (wasActive) switchDevice(cfg.activeDevice);
}

// ── device settings (per-device config via /api/config) ────────────────
// Same target rule as the provider cards: the device selected in the list
// (editingDevId), else the active one. An empty field removes the override
// — the device falls back to its deploy default.
const CFG_FIELDS = [
  ['cfgEscModel', 'ESCALATION_MODEL'],
  ['cfgSubModel', 'SUBAGENT_MODEL'],
  ['cfgMaxUsd', 'AGENT_MAX_USD'],
  ['cfgMaxSteps', 'AGENT_MAX_STEPS'],
  ['cfgCtxLimits', 'MODEL_CONTEXT_LIMITS'],
  ['cfgSearchLang', 'SEARCH_LANG'],
  ['cfgSearchRegion', 'SEARCH_REGION'],
];
const devCfgHint = $('devCfgHint'), devCfgForm = $('devCfgForm'),
      devCfgNote = $('devCfgNote'), devCfgTarget = $('devCfgTarget'),
      cfgModelList = $('cfgModelList'), cfgCleanup = $('cfgCleanup'),
      devCfgSave = $('devCfgSave');
let devCfgState = 'idle';  // idle|checking|ready|old|auth|offline

function renderDevCfg() {
  const d = keyDev();
  devCfgTarget.textContent = `· ${d.name || d.host}`;
  const hints = {
    checking: 'loading…',
    old: 'This backend is too old for remote settings — ' +
         'update it from the device row above.',
    auth: 'The device rejected the saved password — re-save it above.',
    offline: 'Device is offline — its settings can’t be read.',
  };
  devCfgHint.textContent = devCfgState === 'ready'
    ? 'Changes apply live. An empty field falls back to the device default.'
    : (hints[devCfgState] || '');
  devCfgForm.hidden = devCfgState !== 'ready';
  if (devCfgState !== 'ready') devCfgNote.hidden = true;
}

async function refreshDeviceCfg() {
  const d = keyDev();
  devCfgState = 'checking';
  renderDevCfg();
  try {
    const r = await devFetch(d, '/api/config', { signal: probeSignal() });
    if (d.id !== keyDev().id) return;  // target switched mid-fetch
    if (r.status === 404 || r.status === 405) devCfgState = 'old';
    else if (r.status === 401 || r.status === 403) devCfgState = 'auth';
    else if (!r.ok) devCfgState = 'offline';
    else {
      const eff = (await r.json()).effective || {};
      for (const [id, key] of CFG_FIELDS)
        $(id).value = eff[key] == null ? '' : String(eff[key]);
      // effective returns the coerced global — a bool for GUT_CLEANUP.
      const off = v => v === false ||
        ['off', '0', 'false', 'no'].includes(String(v).toLowerCase());
      cfgCleanup.checked = !off(eff.GUT_CLEANUP ?? 'on');
      devCfgState = 'ready';
      // Deployed-model suggestions for the two model fields — best effort.
      devFetch(d, '/api/models', { signal: probeSignal() })
        .then(mr => mr.ok ? mr.json() : [])
        .then(ms => {
          cfgModelList.innerHTML = '';
          for (const m of ms || []) {
            const o = document.createElement('option');
            o.value = m.id;
            cfgModelList.appendChild(o);
          }
        }).catch(() => {});
    }
  } catch (_) {
    if (d.id !== keyDev().id) return;
    devCfgState = 'offline';
  }
  renderDevCfg();
}

devCfgSave.onclick = async () => {
  const d = keyDev();
  const name = d.name || d.host;
  const updates = {};
  for (const [id, key] of CFG_FIELDS) {
    const el = $(id), v = el.value.trim();
    if (el.type === 'number' && v && isNaN(+v)) {
      devCfgNote.hidden = false;
      devCfgNote.textContent = `${key} must be a number — nothing was changed.`;
      return;
    }
    if (key === 'MODEL_CONTEXT_LIMITS' && v &&
        !v.split(',').every(p => /^[^=,]+=\d+[kKmM]?$/.test(p.trim()))) {
      devCfgNote.hidden = false;
      devCfgNote.textContent = `${key} wants name=tokens entries ` +
        '(e.g. *=128000 or ollama/qwen=32k) — nothing was changed.';
      return;
    }
    updates[key] = v;
  }
  updates.GUT_CLEANUP = cfgCleanup.checked ? 'on' : 'off';
  devCfgNote.hidden = false;
  devCfgNote.textContent = `Saving on ${name}…`;
  let r;
  try {
    r = await devFetch(d, '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: updates }),
    });
  } catch (_) {
    devCfgNote.textContent = `Could not reach ${name} — nothing was changed.`;
    return;
  }
  if (!r.ok) {
    devCfgNote.textContent =
      `Save failed (HTTP ${r.status}) — nothing was changed.`;
    return;
  }
  const j = await r.json();
  const pending = (j.restart_required || []).filter(k => updates[k]);
  devCfgNote.textContent = pending.length
    ? `Saved on ${name} — ${pending.join(', ')} apply after ` +
      'the backend restarts.'
    : `Saved on ${name} — changes apply live.`;
};

$('settingsBtn').onclick = () => {
  if (settingsOpen()) { closeSettings(); return; }
  fillDeviceForm(activeDev());  // refreshes the keys cards for it too
  refreshLocal();
  refreshDeviceInfo();
  startDeviceProbe();
  openSettings();
};

$('settingsBack').onclick = closeSettings;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (settingsOpen() && !editingKey) closeSettings();
  else if (aboutOpen()) backToSettings();  // about is a sub-page of Settings
});

// ── about page ("What gut can do") ─────────────────────────────────────
// A sub-page of Settings: the entry row lives at the bottom of the
// settings page and Back/Esc return there rather than to the main view.
const aboutPage = $('aboutPage');
const aboutOpen = () => !aboutPage.hidden;

function openAbout() {
  if (settingsOpen()) closeSettings();
  aboutPage.hidden = false;
  document.body.classList.add('about-open');
}

function closeAbout() {
  aboutPage.hidden = true;
  document.body.classList.remove('about-open');
  // Same rescale fix as closeSettings — the stream canvas was 0-sized while
  // the pane was hidden.
  requestAnimationFrame(() => { if (rfb) rfb.scaleViewport = true; });
}

function backToSettings() {
  openSettings();       // closes this page
  startDeviceProbe();   // resume live status probing
}

$('aboutBtn').onclick = openAbout;
$('aboutBack').onclick = backToSettings;

// Example prompts load into the composer, ready to send.
document.querySelectorAll('#aboutPage .try').forEach(btn => {
  btn.onclick = () => {
    closeAbout();
    chatInput.value = btn.textContent.trim();
    chatInput.dispatchEvent(new Event('input'));  // autosize + send button
    chatInput.focus();
  };
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
    host: normalizeHost(hostInput.value) || '127.0.0.1',
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
  // Host/password changed — prior TLS state no longer applies; re-pair.
  delete d.insecureOk;
  delete d._tlsRefused;
  saveDevices();
  populateDeviceSelect();
  if (wasActive) {
    if (screenDevId === d.id) disconnectDesktop();  // pick up new host/password
    gateConnection(d).finally(() => {
      syncScreen();
      connectChat();
      loadModels();
      loadConversations();
      refreshKeys();  // host/password may have changed — re-check key state
      refreshDeviceCfg();
    });
  }
  renderDeviceList();
});

// ── chat pane width ─────────────────────────────────────────────────────
// The pane is widened with the CSS `resize` handle, which fires no events —
// observe its box instead and persist the result across reloads.
const savedChatW = +localStorage.getItem('gut.chatWidth') || 0;
if (savedChatW) chatPane.style.width = savedChatW + 'px';
const narrowMq = matchMedia('(max-width: 760px)');
let chatWTimer;
new ResizeObserver(() => {
  clearTimeout(chatWTimer);
  chatWTimer = setTimeout(() => {
    // The pane reports 0 while the settings page hides it — don't persist
    // that, nor the forced full width of the narrow chat-only layout.
    if (chatPane.offsetWidth && !narrowMq.matches)
      localStorage.setItem('gut.chatWidth', chatPane.offsetWidth);
  }, 200);
}).observe(chatPane);

// ── boot ────────────────────────────────────────────────────────────────
activeConvId = localStorage.getItem(convKey(activeDev().id)) || null;
activeConvDevId = activeConvId ? activeDev().id : null;
populateDeviceSelect();
// Pair/pin TLS before any channel that carries the device password opens.
gateConnection(activeDev()).finally(() => {
  syncScreen();
  connectChat();
  loadConversations();
  refreshKeys();
});
setInterval(loadModels, 30000);
setTimeout(loadModels, 1500);

// Electron first-run: nothing configured yet → drop straight into the local
// desktop setup panel. "Configured" = a provider key was saved or the device
// list was touched — without that, a stopped stack pops this on every launch.
if (gut) {
  Promise.all([refreshLocal(), refreshKeys()]).then(() => {
    const fresh = !localStorage.getItem('gut.devices') &&
      !Object.values(localKeysSet).some(Boolean);
    if (fresh && localState && localState.stack !== 'running') {
      fillDeviceForm(activeDev());
      openSettings();
    }
  });
}
