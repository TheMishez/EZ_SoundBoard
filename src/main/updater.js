'use strict';
/**
 * In-app updates from GitHub Releases.
 *
 * Installed builds use electron-updater: it reads latest.yml from the newest release, downloads the
 * installer when you click Update and installs it on restart (one UAC prompt, because EZ Soundboard
 * installs for all users). Running from source, or when a release has no latest.yml, it falls back
 * to asking the GitHub API and linking to the release page.
 */
const { app, net, shell } = require('electron');

const OWNER = 'TheMishez';
const REPO = 'EZ_SoundBoard';
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let onState = () => {};
let beforeInstall = () => {};
let enabled = true;
let timer = null;

// What the UI shows. phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
const state = {
  current: app.getVersion(),
  phase: 'idle',
  version: '',
  notes: '',
  url: RELEASES_PAGE,
  canInstall: false,   // false = we can only open the release page
  percent: 0,
  error: '',
  checkedAt: 0
};

const publicState = () => ({ ...state, enabled });
function set(patch) {
  Object.assign(state, patch);
  try { onState(publicState()); } catch { /* window gone */ }
}

function versionParts(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
const cleanNotes = (n) => {
  if (Array.isArray(n)) n = n.map((x) => x && x.note).filter(Boolean).join('\n\n');
  return String(n || '').replace(/<[^>]+>/g, '').trim().slice(0, 4000);
};

function initAutoUpdater() {
  if (autoUpdater || !app.isPackaged) return autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.warn('electron-updater unavailable', e);
    return null;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', () => set({ phase: 'ready', percent: 100 }));
  autoUpdater.on('error', (e) => {
    console.warn('updater error', e);
    if (state.phase === 'downloading') set({ phase: 'error', error: 'Download failed. Try again, or get it from the releases page.' });
  });
  return autoUpdater;
}

async function checkWithUpdater() {
  const u = initAutoUpdater();
  if (!u) return false;
  try {
    const r = await u.checkForUpdates();
    const info = r && r.updateInfo;
    const latest = versionParts(info && info.version);
    const mine = versionParts(app.getVersion());
    if (latest && mine && isNewer(latest, mine)) {
      set({ phase: 'available', version: latest.join('.'), notes: cleanNotes(info.releaseNotes), canInstall: true, url: RELEASES_PAGE, error: '' });
    } else {
      set({ phase: 'none', version: '', notes: '', canInstall: false, error: '' });
    }
    return true;
  } catch (e) {
    return false; // e.g. this release has no latest.yml: try the plain check
  }
}

async function checkWithApi() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await net.fetch(RELEASES_API, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'EZ-Soundboard/' + app.getVersion(), Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) { set({ phase: 'none', version: '', canInstall: false, error: '' }); return; }
    if (!res.ok) throw new Error('GitHub answered ' + res.status);
    const j = await res.json();
    const latest = versionParts(j.tag_name) || versionParts(j.name);
    const mine = versionParts(app.getVersion());
    if (latest && mine && isNewer(latest, mine) && !j.draft && !j.prerelease) {
      const url = typeof j.html_url === 'string' && /^https:\/\/github\.com\//.test(j.html_url) ? j.html_url : RELEASES_PAGE;
      set({ phase: 'available', version: latest.join('.'), notes: cleanNotes(j.body), url, canInstall: false, error: '' });
    } else {
      set({ phase: 'none', version: '', notes: '', canInstall: false, error: '' });
    }
  } catch (e) {
    set({ phase: 'error', error: "Couldn't reach GitHub. Check your connection and try again." });
  } finally {
    clearTimeout(t);
  }
}

/** manual = the user pressed "Check now" (runs even when automatic checks are off). */
async function check(manual = false) {
  if (!enabled && !manual) return publicState();
  if (state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'checking') return publicState();
  set({ phase: 'checking', error: '' });
  if (!(await checkWithUpdater())) await checkWithApi();
  state.checkedAt = Date.now();
  set({});
  return publicState();
}

function download() {
  if (state.phase === 'ready') return install();
  if (state.phase === 'downloading') return true;
  if (!state.canInstall || !autoUpdater) { shell.openExternal(state.url || RELEASES_PAGE); return false; }
  set({ phase: 'downloading', percent: 0, error: '' });
  autoUpdater.downloadUpdate().catch((e) => {
    console.warn('download failed', e);
    set({ phase: 'error', error: 'Download failed. Try again, or get it from the releases page.' });
  });
  return true;
}

function install() {
  if (!autoUpdater || state.phase !== 'ready') return false;
  beforeInstall();
  // Silent install, then start EZ Soundboard again. The installer stops Windows Audio briefly so it
  // can replace the mic plugin, then turns it back on.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

function setEnabled(on) {
  enabled = !!on;
  set({});
  if (enabled && state.phase === 'idle') check(false);
}

function openPage() { shell.openExternal(state.url || RELEASES_PAGE); }

/** opts: { enabled, onState(state), beforeInstall() } */
function init(opts = {}) {
  enabled = opts.enabled !== false;
  if (opts.onState) onState = opts.onState;
  if (opts.beforeInstall) beforeInstall = opts.beforeInstall;
  setTimeout(() => check(false), 8000);
  clearInterval(timer);
  timer = setInterval(() => check(false), CHECK_EVERY_MS);
}

module.exports = { init, check, download, install, setEnabled, openPage, state: publicState, versionParts, isNewer };
