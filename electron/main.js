// gut — Electron shell.
// Loads the static client UI and exposes a small IPC surface (window.gut)
// that manages a local Docker-based backend stack.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const local = require('./localstack');

function clientDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'client')
    : path.join(__dirname, '..', 'client');
}

function createWindow() {
  const win = new BrowserWindow({
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

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
