// Strøm for Windows: the movie server, the shelf UI and mpv playback in one program.
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const os = require('os');

app.setName('Strom');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // lets the start-up intro play its sound
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null, settingsWin = null, srv = null, player = null, tray = null;
const origin = () => `http://127.0.0.1:${srv.port}`;

function secure(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin())) e.preventDefault(); });
}

function createMainWindow() {
  win = new BrowserWindow({
    fullscreen: process.env.STROM_WINDOWED !== '1', width: 1280, height: 720, backgroundColor: '#0c0918', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  secure(win);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(origin() + '/');
}

function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 1000, height: 820, parent: win || undefined, backgroundColor: '#0c0918', autoHideMenuBar: true, title: 'Strøm settings',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  secure(settingsWin);
  settingsWin.on('closed', async () => {
    settingsWin = null;
    try { await fetch(origin() + '/api/tv/refresh', { method: 'POST' }); } catch { /* ignore */ }
    if (win) win.webContents.reloadIgnoringCache();
  });
  // apply shelf-look changes right away when Save is pressed (no need to close the settings window)
  settingsWin.webContents.session.webRequest.onCompleted({ urls: ['*://*/api/tv/settings'] }, (d) => {
    if (d.method === 'POST' && win) win.webContents.reloadIgnoringCache();
  });
  settingsWin.loadURL(origin() + '/setup');
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return `${i.address}:${srv.port}`;
  return `127.0.0.1:${srv.port}`;
}

// Server-only mode: no window, just a tray icon (bottom right, near the clock) with a small menu.
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('Strøm server – TV address ' + lanAddress());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'TV address: ' + lanAddress(), enabled: false },
    { type: 'separator' },
    { label: 'Open shelf on this PC', click: () => { if (win) { win.show(); win.focus(); } else createMainWindow(); } },
    { label: 'Settings', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit Strøm', click: () => app.quit() },
  ]));
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } else createMainWindow(); });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData');
  try {
    srv = await require('./server/strom-server.cjs').start({ dataDir, webDir: path.join(__dirname, 'web'), portFallback: true, port: Number(process.env.STROM_PORT) || 5000 });
  } catch (e) {
    dialog.showErrorBox('Strøm', 'Could not start the server: ' + e.message);
    app.quit(); return;
  }
  player = require('./mpv.cjs').createPlayer({
    getConfig: srv.getConfig, dataDir,
    searchDirs: [path.dirname(process.execPath), process.resourcesPath || __dirname, __dirname],
  });

  ipcMain.on('strom-info', (e) => { e.returnValue = { host: `127.0.0.1:${srv.port}` }; });
  ipcMain.handle('strom-play', async (e, opts) => {
    try {
      const r = await player.play(opts);
      if (win) { win.show(); win.focus(); }
      return r;
    } catch (err) {
      if (win) { win.show(); win.focus(); }
      if (err && err.message === 'mpv-not-found') {
        dialog.showErrorBox('mpv not found', 'Strøm plays films with mpv, but mpv.exe was not found.\n\nPut mpv.exe in a folder named "mpv" next to Strom.exe, or set its location in Settings.');
      } else {
        dialog.showErrorBox('Could not play the film', String(err && err.message || err));
      }
      throw err;
    }
  });
  ipcMain.handle('strom-pick-folder', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const r = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] });
    return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
  });
  ipcMain.on('strom-settings', () => openSettings());
  ipcMain.on('strom-quit', () => app.quit());
  ipcMain.on('strom-open-external', (e, url) => { if (/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{6,20}$/.test(String(url))) shell.openExternal(url); });   // trailers only

  const noFolders = !((srv.getConfig().libraryPaths || []).length);
  if (srv.getConfig().serverOnly && !noFolders) createTray();
  else createMainWindow();
  if (noFolders) openSettings(); // first start: set up the folders
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } else if (tray && srv) createMainWindow(); });
app.on('window-all-closed', () => { if (!tray) app.quit(); }); // in server-only mode the tray keeps Strøm running
let closing = false;
app.on('before-quit', (e) => {
  if (closing || !srv) return;
  closing = true; e.preventDefault();
  srv.close().finally(() => app.exit(0));
});
