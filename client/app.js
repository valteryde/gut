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
const typingText = document.createElement('span');
typingText.className = 'typing-text';
typingBody.append(typingDots, typingText);
typingEl.append(typingWho, typingBody);

// Ephemeral — never a transcript entry. The freshest activity/thought rides
// the typing row where the reply will land and echoes in the header's
// activity line; it's cleared when the run goes idle.
function setLiveStatus(text, kind) {
  liveStatus = text;
  liveKind = kind || '';
  activityEl.textContent = text;
  updateTyping();
}

function updateTyping() {
  const here = activeConvId && agentPhase !== 'idle' &&
    (!runningConvId || runningConvId === activeConvId);
  if (!here) { typingEl.remove(); return; }
  typingWho.textContent = agentName;
  typingEl.dataset.phase = agentPhase;
  typingEl.dataset.kind = liveKind;
  typingText.textContent = STATE_LABEL[agentPhase] || liveStatus ||
    (agentPhase === 'running' ? 'working…' : '');
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

const svgIcon = (inner) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  inner + '</svg>';

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
    tag.textContent = '⚡ sent to the agent';
  } else {
    tag.appendChild(document.createTextNode('queued'));
    if (seq != null && cid === runningConvId) {
      const now = document.createElement('button');
      now.type = 'button';
      now.textContent = '· send now';
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
      rm.textContent = '· drop';
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
    p.textContent = m.note;
    body.appendChild(p);
  }
  body.appendChild(fileCard(m));
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
    p.textContent = m.caption;
    body.appendChild(p);
  }
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
  share_plan:       () => 'posting a plan',
  update_todos:     () => 'updating the checklist',
  task_complete:    () => 'wrapping up',
};

function toolStatus(m) {
  const f = TOOL_STATUS[m.tool];
  return f ? f(m.args || {}) : `using ${m.tool}`;
}

// One renderer for live events and stored history alike. `live` adds the
// ephemeral side effects (activity line, pending-question state).
function renderEvent(m, live) {
  switch (m.type) {
    case 'user':
      addUserMsg(m);
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
      addVerbose('thought', `${m.agent ? m.agent + ' · ' : ''}${(m.text || '').trim()}`);
      // The agent's inner voice, live in the status line — a thought reads
      // like "checking the totals…", an action like "clicking".
      if (live) setLiveStatus(
        `${m.agent ? m.agent + ' · ' : ''}${clip(m.text, 140)}`, 'thought');
      break;
    case 'action':
      addVerbose('action', `▶ ${m.agent ? m.agent + '·' : ''}${m.tool} ${JSON.stringify(m.args)}`);
      if (live) setLiveStatus(
        `${m.agent ? m.agent + ' · ' : ''}${toolStatus(m)}`, 'action');
      break;
    case 'action_result':
      addVerbose('action', `✓ ${m.agent ? m.agent + '·' : ''}${m.tool}: ${(m.result || '').trim()}`);
      break;
    case 'subagent':
      addVerbose('action', `◈ ${m.name} ${m.state}` +
        (m.result ? ` — ${String(m.result).trim()}` : ''));
      if (live) setLiveStatus(`helper ${m.name} ${m.state}`, 'action');
      break;
    case 'cleanup':
      addVerbose('thought', m.text || '');
      break;
    case 'plan':
      addMsg('plan', m.text, `${agentName} · plan`);
      break;
    case 'compact':
      entry('compact').body.textContent = m.text || 'context compacted';
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

function setAgentState(s) {
  agentPhase = s;
  document.body.dataset.agent = s;
  stopBtn.hidden = !(s === 'running' || s === 'waiting_user' || s === 'paused');
  steerBtn.hidden = s === 'idle';
  if (s === 'idle') { activityEl.textContent = ''; liveStatus = ''; liveKind = ''; }
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
  convModel = null;
  awaitingAnswer = false;
  liveStatus = '';
  liveKind = '';
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
  'subagent', 'plan', 'compact',
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
            'thought');
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
    if (!activeConvId && modelSelect.value)
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
  if (settingsOpen()) refreshKeys();
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
      ([k, val]) => PROVIDERS.some(p => p.key === k) && String(val).trim()));
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

async function saveProviderKey(key, value) {
  const d = keyDev();
  if (keyMode === 'local') {
    try {
      localKeysSet = await gut.saveLocalKeys({ [key]: value });
      if (value) vaultSet(key, value);  // keep it for other devices too
      keyNote = null;
    } catch (e) {
      keyNote = `Could not save the key: ${e?.message || 'error'}`;
    }
    editingKey = null;
    renderProviderKeys();
    return;
  }
  const p = PROVIDERS.find(x => x.key === key);
  const name = d.name || d.host;
  // Keys leave this machine — say so plainly before they go.
  if (value && !confirm(
      `Upload your ${p.name} key to ${name} (${d.host})?\n\n` +
      'It is sent over plain HTTP and stored on that machine — its ' +
      'agent needs it to call the provider.')) {
    editingKey = null;
    renderProviderKeys();
    return;
  }
  keyNote = value ? `Uploading the ${p.name} key to ${name}…`
                  : `Removing the ${p.name} key from ${name}…`;
  renderProviderKeys();
  const ok = await pushKeysRemote(d, { [key]: value },
    value ? `${p.name} key is now on ${name} — its models show ` +
            'up in the picker within a few seconds.'
          : `${p.name} key removed from ${name}.`);
  if (ok && value) vaultSet(key, value);
  editingKey = null;
  renderProviderKeys();
}

// Push every key in the local store to the device the cards point at —
// one shot for a fresh VPS. Only adds/overwrites; the device's other
// keys are untouched.
keystorePush.onclick = async () => {
  const d = keyDev();
  const keys = {};
  for (const p of PROVIDERS) if (vault[p.key]) keys[p.key] = vault[p.key];
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
      chip.title = `Forget the saved ${p.name} key`;
      chip.onclick = () => {
        if (confirm(`Forget the ${p.name} key saved on this computer? ` +
                   'Devices that already have it keep their copy.')) {
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
    // The pill says where the key physically lives, not just "saved".
    c.state.textContent = source === 'env' ? 'Server env'
      : set ? (keyMode === 'local' ? 'In .env' : 'On device')
      : 'No key';
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
      const replace = provBtn(source === 'env' ? 'Override' : 'Replace');
      if (source === 'env') {
        replace.title = 'This key is set on the server itself — pushing ' +
          'your own overrides it';
      }
      replace.onclick = () => { editingKey = p.key; renderProviderKeys(); };
      c.actions.append(replace);
      if (source !== 'env') {
        const remove = provBtn('Remove', 'danger');
        remove.onclick = () => {
          const where = keyMode === 'local'
            ? 'Its models stop working the next time the local desktop starts.'
            : `Its models stop working on ${keyDev().name || 'the device'}.`;
          if (confirm(`Remove the ${p.name} key? ${where}`)) {
            saveProviderKey(p.key, '');
          }
        };
        c.actions.append(remove);
      }
    } else {
      const saved = vault[p.key];
      if (saved) {
        const use = provBtn('Use saved key');
        use.classList.add('grow');
        use.title = `Push the ${p.name} key saved on this computer ` +
          `to ${keyDev().name || keyDev().host}`;
        use.onclick = () => saveProviderKey(p.key, saved);
        c.actions.append(use);
      }
      const add = provBtn(saved ? 'Paste a key…' : `Add ${p.name} key`);
      add.classList.add(saved ? 'ghost' : 'grow');
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
}

function newDeviceForm() {
  editingDevId = null;
  devNameInput.value = '';
  hostInput.value = '';
  vncPassInput.value = '';
  renderDeviceList();
  keyNote = '';
  refreshKeys();
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
  if (wasActive) switchDevice(cfg.activeDevice);
}

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
    });
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
