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
const updater = require('./updater');
const tts = require('./tts');
const remote = require('./remote');
const { importFromLink, LinkError } = require('./linkimport');

// Audio must keep running (and start without a click) even when the window is hidden in the tray.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setAppUserModelId('com.ezggco.ezsoundboard');

// Serve the UI from app:// (a real origin) instead of file:// - AudioWorklet needs it.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const USER_DIR = app.getPath('userData');

// Small settings that must be known before the app starts (read synchronously).
const CONFIG_FILE = path.join(USER_DIR, 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
const config = readConfig();
function writeConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)); } catch (e) { console.warn('config save failed', e); }
}
if (config.hardwareAcceleration === false) app.disableHardwareAcceleration();
// Keep the JS heap modest - the app holds no large JS data (audio lives in the audio engine).
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
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

// One-time move of the library from the app's old name ("Mishez Pad") to "EZ Soundboard".
async function migrateFromOldName() {
  try {
    await fsp.access(LIB_FILE);
    return; // already have a library
  } catch { /* none yet */ }
  const oldDir = path.join(app.getPath('appData'), 'Mishez Pad');
  try {
    await fsp.access(path.join(oldDir, 'library.json'));
  } catch {
    return;
  }
  await fsp.mkdir(SOUND_DIR, { recursive: true });
  await fsp.copyFile(path.join(oldDir, 'library.json'), LIB_FILE);
  try {
    for (const f of await fsp.readdir(path.join(oldDir, 'sounds'))) {
      await fsp.copyFile(path.join(oldDir, 'sounds', f), path.join(SOUND_DIR, f));
    }
  } catch { /* no sounds */ }
}

async function init() {
  await fsp.mkdir(SOUND_DIR, { recursive: true });
  try { await migrateFromOldName(); } catch (e) { console.warn('migration failed', e); }
  await tts.cleanup(SOUND_DIR);
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
  updater.init({
    enabled: config.checkUpdates !== false,
    onState: (st) => { toWindow('update:state', st); updateTrayMenu(); },
    beforeInstall: () => { quitting = true; }
  });
  remote.init({
    enabled: config.remoteControl !== false,
    version: app.getVersion(),
    send: (cmd) => toWindow('remote:cmd', cmd),
    onStatus: (st) => toWindow('remote:status', st)
  });
}

function toWindow(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
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
    tray.setToolTip('EZ Soundboard');
    updateTrayMenu();
    tray.on('click', showWindow);
  } catch (e) {
    console.warn('Tray unavailable', e);
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const up = updater.state();
  const items = [
    { label: 'Open EZ Soundboard', click: showWindow },
    { label: 'Stop all sounds', click: () => toWindow('hotkey', 'stopAll') },
    { type: 'separator' }
  ];
  if (up.phase === 'ready') items.push({ label: `Restart to update to ${up.version}`, click: () => updater.install() });
  else if (up.phase === 'available') items.push({ label: `Update to ${up.version}…`, click: () => { showWindow(); updater.download(); } });
  else if (up.phase === 'downloading') items.push({ label: `Downloading update… ${up.percent}%`, enabled: false });
  else items.push({ label: 'Check for updates', click: () => updater.check(true) });
  items.push({ type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  tts.cleanupSync(SOUND_DIR);
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

// Starter pack: assets/starter-sounds/<Board name>/<sound files>. Files directly in the folder go
// to no board. Shipped inside the installer and imported on first launch.
ipcMain.handle('sounds:starter', async () => {
  const root = path.join(ASSETS, 'starter-sounds');
  const files = await walk(root);
  return files.map((p) => {
    const rel = path.relative(root, p).split(path.sep);
    return { path: p, board: rel.length > 1 ? rel[0] : '' };
  });
});

ipcMain.handle('sounds:importUrl', async (_e, url) => {
  try {
    return { ok: true, sound: await importFromLink(SOUND_DIR, url) };
  } catch (e) {
    console.warn('link import failed', url, e);
    return { ok: false, error: e instanceof LinkError ? e.message : "Couldn't download that link" };
  }
});

ipcMain.handle('sounds:read', async (_e, file) => fsp.readFile(safeFile(file)));
ipcMain.handle('sounds:delete', async (_e, file) => {
  try { await fsp.unlink(safeFile(file)); } catch { /* already gone */ }
});
ipcMain.handle('sounds:reveal', (_e, file) => shell.showItemInFolder(safeFile(file)));

/* ---------------- Text-to-speech ---------------- */

ipcMain.handle('tts:voices', (_e, refresh) => tts.voices(!!refresh));
ipcMain.handle('tts:speak', async (_e, opts) => {
  try {
    return { ok: true, ...(await tts.speak(SOUND_DIR, opts || {})) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
// Keeps a spoken clip as a normal sound: renames tts-xxxx.wav so the clean-up leaves it alone.
ipcMain.handle('tts:keep', async (_e, file) => {
  const name = path.basename(String(file));
  if (!/^tts-[0-9a-f]{12}\.wav$/.test(name)) return null;
  const id = crypto.randomBytes(6).toString('hex');
  await fsp.rename(path.join(SOUND_DIR, name), path.join(SOUND_DIR, id + '.wav'));
  return { id, file: id + '.wav' };
});

/* ---------------- Updates ---------------- */

ipcMain.handle('update:state', () => updater.state());
ipcMain.handle('update:check', () => updater.check(true));
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('update:open', () => updater.openPage());
ipcMain.handle('update:setEnabled', (_e, on) => {
  config.checkUpdates = !!on;
  writeConfig();
  updater.setEnabled(!!on);
  return updater.state();
});
ipcMain.handle('app:version', () => app.getVersion());

/* ---------------- Stream Deck / local control ---------------- */

const streamDeckFile = () => app.isPackaged
  ? path.join(process.resourcesPath, 'streamdeck', 'EZ-Soundboard.streamDeckPlugin')
  : path.join(__dirname, '..', '..', 'build', 'streamdeck', 'EZ-Soundboard.streamDeckPlugin');

ipcMain.handle('remote:status', () => ({ ...remote.status(), enabled: config.remoteControl !== false, pluginAvailable: fs.existsSync(streamDeckFile()) }));
ipcMain.handle('remote:setEnabled', (_e, on) => {
  config.remoteControl = !!on;
  writeConfig();
  remote.setEnabled(!!on);
  return { ...remote.status(), enabled: !!on };
});
ipcMain.on('remote:library', (_e, data) => remote.setLibrary(data));
ipcMain.on('remote:playing', (_e, data) => remote.setPlaying(data));
// Opening the .streamDeckPlugin file makes the Stream Deck app install it.
ipcMain.handle('remote:installPlugin', async () => {
  const f = streamDeckFile();
  if (!fs.existsSync(f)) return { ok: false, error: 'The Stream Deck plugin is not included in this build' };
  const err = await shell.openPath(f);
  return err ? { ok: false, error: 'Install the Stream Deck app first (elgato.com/downloads), then try again' } : { ok: true };
});

/* ---------------- Hotkeys + push-to-talk ---------------- */

ipcMain.handle('hotkeys:set', async (_e, bindings) => { await hotkeys.ready(); return hotkeys.set(bindings); });
ipcMain.handle('hotkeys:backend', async () => { await hotkeys.ready(); return hotkeys.backend(); });
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
ipcMain.handle('app:getHwAccel', () => config.hardwareAcceleration !== false);
ipcMain.handle('app:setHwAccel', (_e, on) => {
  config.hardwareAcceleration = !!on;
  writeConfig();
  return true;
});
ipcMain.on('app:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
