'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  loadLib: () => ipcRenderer.invoke('lib:load'),
  saveLib: (data) => ipcRenderer.invoke('lib:save', data),

  pickFiles: () => ipcRenderer.invoke('sounds:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('sounds:pickFolder'),
  importPaths: (paths) => ipcRenderer.invoke('sounds:import', paths),
  starterSounds: () => ipcRenderer.invoke('sounds:starter'),
  readSound: (file) => ipcRenderer.invoke('sounds:read', file),
  deleteSound: (file) => ipcRenderer.invoke('sounds:delete', file),
  revealSound: (file) => ipcRenderer.invoke('sounds:reveal', file),
  getPathForFile: (f) => {
    try { return webUtils ? webUtils.getPathForFile(f) : f.path; } catch { return f.path || ''; }
  },

  setHotkeys: (bindings) => ipcRenderer.invoke('hotkeys:set', bindings),
  hotkeyBackend: () => ipcRenderer.invoke('hotkeys:backend'),
  suspendHotkeys: (on) => ipcRenderer.send('hotkeys:suspend', on),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),

  apo: {
    available: () => ipcRenderer.invoke('apo:available'),
    list: () => ipcRenderer.invoke('apo:list'),
    apply: (enable, disable) => ipcRenderer.invoke('apo:apply', enable, disable),
    start: () => ipcRenderer.invoke('apo:start'),
    stop: () => ipcRenderer.send('apo:stop'),
    push: (pcm) => ipcRenderer.send('apo:push', pcm),
    setVoice: (g) => ipcRenderer.send('apo:voice', g),
    onStatus: (cb) => ipcRenderer.on('apo:status', (_e, st) => cb(st))
  },

  pttDown: (key) => ipcRenderer.send('ptt:down', key),
  pttUp: () => ipcRenderer.send('ptt:up'),

  win: {
    min: () => ipcRenderer.send('win:min'),
    max: () => ipcRenderer.send('win:max'),
    close: () => ipcRenderer.send('win:close'),
    setCloseToTray: (v) => ipcRenderer.send('win:closeToTray', v),
    onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v))
  },
  openExternal: (url) => ipcRenderer.send('app:openExternal', url),
  getHardwareAcceleration: () => ipcRenderer.invoke('app:getHwAccel'),
  setHardwareAcceleration: (on) => ipcRenderer.invoke('app:setHwAccel', on)
});
