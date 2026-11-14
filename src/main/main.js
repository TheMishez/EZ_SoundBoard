'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const hotkeys = require('./hotkeys');
const ptt = require('./ptt');
const apo = require('./apo');

// Audio must keep running (and start without a click) even when the window is hidden in the tray.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setAppUserModelId('com.ezggco.mishezpad');

// Serve the UI from app:// (a real origin) instead of file:// - AudioWorklet needs it.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const USER_DIR = app.getPath('userData');
const SOUND_DIR = path.join(USER_DIR, 'sounds');
const LIB_FILE = path.join(USER_DIR, 'library.json');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.webm', '.opus', '.mp4']);
const MAX_FILE = 300 * 1024 * 1024;

let win = null;
let tray = null;
let quitting = false;
let closeToTray = true;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
}

async function init() {
  await fsp.mkdir(SOUND_DIR, { recursive: true });
  protocol.handle('app', (req) => {
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  createTray();
  hotkeys.init((action) => {
    if (win && !win.isDestroyed()) win.webContents.send('hotkey', action);
  });
  ptt.warmup();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#08090c',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  win.loadURL('app://pad/index.html');
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting && closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  // Never navigate away from the app (e.g. dropping a file outside the drop zone).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
    tray = new Tray(img);
    tray.setToolTip('Mishez Pad');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Mishez Pad', click: showWindow },
      { label: 'Stop all sounds', click: () => win && win.webContents.send('hotkey', 'stopAll') },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWindow);
  } catch (e) {
    console.warn('Tray unavailable', e);
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  apo.stopBridge();
  hotkeys.dispose();
  ptt.dispose();
});
app.on('window-all-closed', () => app.quit());

/* ---------------- Library persistence ---------------- */

let saveChain = Promise.resolve();
ipcMain.handle('lib:load', async () => {
  try {
    return JSON.parse(await fsp.readFile(LIB_FILE, 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('lib:save', (_e, data) => {
  // Serialize writes and write atomically so a crash never corrupts the library.
  saveChain = saveChain.then(async () => {
    const tmp = LIB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, LIB_FILE);
  }).catch((e) => console.error('save failed', e));
  return saveChain;
});

/* ---------------- Sound files ---------------- */

const safeFile = (f) => path.join(SOUND_DIR, path.basename(String(f)));

ipcMain.handle('sounds:pickFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add sounds',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXT].map((e) => e.slice(1)) }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('sounds:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import a folder of sounds', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return [];
  return walk(r.filePaths[0]);
});

async function walk(dir, out = [], depth = 0) {
  if (depth > 6 || out.length > 3000) return out;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out, depth + 1);
    else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

ipcMain.handle('sounds:import', async (_e, paths) => {
  const out = [];
  const expanded = [];
  for (const p of paths || []) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) expanded.push(...(await walk(p)));
      else expanded.push(p);
    } catch { /* skip */ }
  }
  for (const src of expanded) {
    const ext = path.extname(src).toLowerCase();
    if (!AUDIO_EXT.has(ext)) continue;
    try {
      const st = await fsp.stat(src);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const id = crypto.randomBytes(6).toString('hex');
      const file = id + ext;
      await fsp.copyFile(src, path.join(SOUND_DIR, file));
      out.push({ id, file, name: path.basename(src, path.extname(src)) });
    } catch (e) {
      console.warn('import failed', src, e);
    }
  }
  return out;
});

ipcMain.handle('sounds:read', async (_e, file) => fsp.readFile(safeFile(file)));
ipcMain.handle('sounds:delete', async (_e, file) => {
  try { await fsp.unlink(safeFile(file)); } catch { /* already gone */ }
});
ipcMain.handle('sounds:reveal', (_e, file) => shell.showItemInFolder(safeFile(file)));

/* ---------------- Hotkeys + push-to-talk ---------------- */

ipcMain.handle('hotkeys:set', (_e, bindings) => hotkeys.set(bindings));
ipcMain.handle('hotkeys:backend', () => hotkeys.backend());
ipcMain.on('hotkeys:suspend', (_e, on) => hotkeys.suspend(!!on));
ipcMain.on('ptt:down', (_e, key) => ptt.down(key));
ipcMain.on('ptt:up', () => ptt.up());

/* ---------------- Direct-to-mic plugin ---------------- */

ipcMain.handle('apo:available', () => apo.available());
ipcMain.handle('apo:list', () => apo.list());
ipcMain.handle('apo:apply', (_e, enable, disable) => apo.apply(enable, disable));
ipcMain.handle('apo:start', () => apo.startBridge((st) => {
  if (win && !win.isDestroyed()) win.webContents.send('apo:status', st);
}));
ipcMain.on('apo:stop', () => apo.stopBridge());
ipcMain.on('apo:push', (_e, pcm) => apo.push(pcm));
ipcMain.on('apo:voice', (_e, g) => apo.setVoiceGain(g));

/* ---------------- Window ---------------- */

ipcMain.on('win:min', () => win && win.minimize());
ipcMain.on('win:max', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win && win.close());
ipcMain.on('win:closeToTray', (_e, v) => { closeToTray = !!v; });
ipcMain.on('app:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
