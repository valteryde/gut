// gut — Electron shell.
// Loads the static client UI and exposes a small IPC surface (window.gut)
// that manages a local Docker-based backend stack.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { certFp, tlsHandshake } = require('./tls');
const local = require('./localstack');
const updater = require('./updater');

let win = null;

// ── pinned TLS ──────────────────────────────────────────────────────────
// Backends serve a self-signed cert (see tls.js for the pairing protocol).
// Pins live in userData and the certificate-error hook below enforces them
// for every https/wss connection the renderer opens.
const PIN_FILE = path.join(app.getPath('userData'), 'tls-pins.json');
let tlsPins = {};
try { tlsPins = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')) || {}; }
catch (_) { /* first run or unreadable — start empty */ }
const savePins = () => {
  try { fs.writeFileSync(PIN_FILE, JSON.stringify(tlsPins)); } catch (_) {}
};

// ── updates ─────────────────────────────────────────────────────────────
let updateState = { status: 'idle', version: null, progress: null, error: null };
function pushUpdate(partial) {
  updateState = { ...updateState, ...partial };
  if (win && !win.isDestroyed()) win.webContents.send('update:state', updateState);
}

async function checkForUpdate() {
  if (!app.isPackaged) {
    pushUpdate({ status: 'none', error: null });
    return updateState;
  }
  pushUpdate({ status: 'checking', error: null });
  try {
    const rel = await updater.check();
    pushUpdate(rel
      ? { status: 'available', version: rel.version, notes: rel.notes }
      : { status: 'none', version: null });
  } catch (e) {
    pushUpdate({ status: 'error', error: e.message });
  }
  return updateState;
}

async function downloadUpdate() {
  pushUpdate({ status: 'downloading', progress: { percent: 0 }, error: null });
  try {
    const r = await updater.download((p) =>
      pushUpdate({ status: 'downloading', progress: p }));
    pushUpdate(r.manual
      ? { status: 'available', progress: null }
      : { status: 'downloaded', progress: null });
  } catch (e) {
    pushUpdate({ status: 'error', error: e.message });
  }
  return updateState;
}

function clientDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'client')
    : path.join(__dirname, '..', 'client');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'gut',
    // macOS: hide the native title bar; the in-page #topbar is the drag
    // region and sits under the inset traffic lights.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // The UI is a local file:// page that opens ws:// and http://
      // connections to user-configured backends; module scripts and mixed
      // content both require webSecurity off here.
      webSecurity: false,
    },
  });
  win.loadFile(path.join(clientDir(), 'index.html'));

  // Never navigate the shell away from the UI; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) e.preventDefault();
  });
}

app.whenReady().then(() => {
  ipcMain.handle('tls:handshake', async (_e, host, password) => {
    const r = await tlsHandshake(String(host || ''),
                                 String(password || ''), tlsPins);
    if (r.ok) savePins();
    return r;
  });
  ipcMain.handle('tls:forget', (_e, host) => {
    const prefix = `${String(host || '')}:`;
    for (const k of Object.keys(tlsPins)) {
      if (k.startsWith(prefix)) delete tlsPins[k];
    }
    savePins();
  });
  ipcMain.handle('local:status', () => local.status());
  ipcMain.handle('local:keys', () => local.keysSet());
  ipcMain.handle('local:key-values', () => local.keyValues());
  ipcMain.handle('local:save-keys', (_e, keys) => local.saveKeys(keys || {}));
  ipcMain.handle('local:install-runtime', (e) =>
    local.installRuntime((line) => e.sender.send('local:log', line)));
  ipcMain.handle('local:start', (e, keys) =>
    local.start(keys || {}, (line) => e.sender.send('local:log', line)));
  ipcMain.handle('local:stop', () => local.stop());
  ipcMain.handle('local:restart', (e) =>
    local.restart((line) => e.sender.send('local:log', line)));
  ipcMain.handle('local:update', (e) =>
    local.update((line) => e.sender.send('local:log', line)));
  ipcMain.handle('local:remove', (e) =>
    local.remove((line) => e.sender.send('local:log', line)));
  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
  });
  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:install', () => updater.applyAndRestart());

  // Self-signed backend certs always fail normal verification — accept
  // exactly the fingerprints pinned by tlsHandshake, reject everything else.
  app.on('certificate-error', (event, _wc, url, _error, certificate,
                               callback) => {
    event.preventDefault();
    let ok = false;
    try {
      const u = new URL(url);
      const fp = certFp(certificate);
      ok = !!fp &&
        tlsPins[`${u.hostname}:${u.port || '443'}`] === fp;
    } catch (_) { /* reject below */ }
    if (!ok) console.warn('[gut] rejected unpinned TLS cert for', url);
    callback(ok);
  });

  createWindow();
  // Background update check at launch, then every 6h.
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 3600 * 1000).unref();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
