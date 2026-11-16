// Gives the web app (the same one the Android TV runs) a few desktop abilities.
const { contextBridge, ipcRenderer } = require('electron');
const info = ipcRenderer.sendSync('strom-info');
contextBridge.exposeInMainWorld('stromDesktop', {
  host: info.host,
  play: (opts) => ipcRenderer.invoke('strom-play', opts),
  pickFolder: () => ipcRenderer.invoke('strom-pick-folder'),
  openSettings: () => ipcRenderer.send('strom-settings'),
  quit: () => ipcRenderer.send('strom-quit'),
  openExternal: (url) => ipcRenderer.send('strom-open-external', url),
});
