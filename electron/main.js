// gut — Electron shell.
// Loads the static client UI and exposes a small IPC surface (window.gut)
// that manages a local Docker-based backend stack.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const local = require('./localstack');
const updater = require('./updater');

let win = null;

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
  ipcMain.handle('local:status', () => local.status());
  ipcMain.handle('local:keys', () => local.keysSet());
  ipcMain.handle('local:install-runtime', (e) =>
    local.installRuntime((line) => e.sender.send('local:log', line)));
  ipcMain.handle('local:start', (e, keys) =>
    local.start(keys || {}, (line) => e.sender.send('local:log', line)));
  ipcMain.handle('local:stop', () => local.stop());
  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
  });
  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:install', () => updater.applyAndRestart());

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
