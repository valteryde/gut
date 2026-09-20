const { contextBridge, ipcRenderer } = require('electron');

// Exposed to the UI as window.gut — absent in a plain browser, which is how
// app.js detects it is running inside Electron.
contextBridge.exposeInMainWorld('gut', {
  isElectron: true,
  platform: process.platform,
  localStatus: () => ipcRenderer.invoke('local:status'),
  localKeys: () => ipcRenderer.invoke('local:keys'),
  localKeyValues: () => ipcRenderer.invoke('local:key-values'),
  saveLocalKeys: (keys) => ipcRenderer.invoke('local:save-keys', keys),
  installRuntime: () => ipcRenderer.invoke('local:install-runtime'),
  startLocal: (keys) => ipcRenderer.invoke('local:start', keys),
  stopLocal: () => ipcRenderer.invoke('local:stop'),
  restartLocal: () => ipcRenderer.invoke('local:restart'),
  updateLocal: () => ipcRenderer.invoke('local:update'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  onLocalLog: (cb) => ipcRenderer.on('local:log', (_e, line) => cb(line)),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) =>
    ipcRenderer.on('update:state', (_e, s) => cb(s)),
  // Pinned-TLS pairing against a backend's self-signed cert (see main.js).
  tlsHandshake: (host, password) =>
    ipcRenderer.invoke('tls:handshake', host, password),
  tlsForget: (host) => ipcRenderer.invoke('tls:forget', host),
});
