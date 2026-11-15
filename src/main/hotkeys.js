'use strict';
/**
 * Global hotkeys.
 *
 * Preferred backend: ezsb-hotkeys.exe (native/hotkeys). A tiny low-level keyboard hook that never
 * blocks keys, so you can bind a sound to a key you also use in-game. The mouse is only hooked
 * while Mouse 4/5 is bound, and mouse movement never leaves the helper, so it adds nothing
 * noticeable to your game's input, even with 4-8 kHz mice.
 * Fallbacks: uiohook-napi (if the helper can't start), then Electron globalShortcut (keys are
 * consumed by the app, no mouse buttons).
 *
 * Combos are stored as strings like "Ctrl+Shift+KeyA", "Numpad1", "Mouse4"
 * (modifiers + a KeyboardEvent.code, or a mouse button).
 */
const { app, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let onFire = () => {};
let suspended = false;
let mode = 'none';            // 'native' | 'uiohook' | 'globalShortcut'
let lastBindings = [];

/* ---------------- shared ---------------- */

function parse(combo) {
  const parts = String(combo || '').split('+').filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const mods = new Set(parts);
  return { key, ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), meta: mods.has('Win') };
}

function fire(action) {
  if (!suspended) onFire(action);
}

/* ---------------- native helper ---------------- */

// KeyboardEvent.code -> [Windows virtual key, extended: 0 no / 1 yes / 2 either]
const VK = {
  Space: [0x20, 2], Enter: [0x0d, 0], NumpadEnter: [0x0d, 1], Tab: [0x09, 2], Backspace: [0x08, 2], Escape: [0x1b, 2],
  CapsLock: [0x14, 2], ShiftLeft: [0xa0, 2], ShiftRight: [0xa1, 2], ControlLeft: [0xa2, 2], ControlRight: [0xa3, 2],
  AltLeft: [0xa4, 2], AltRight: [0xa5, 2], MetaLeft: [0x5b, 2], MetaRight: [0x5c, 2], ContextMenu: [0x5d, 2],
  Backquote: [0xc0, 2], Minus: [0xbd, 2], Equal: [0xbb, 2], BracketLeft: [0xdb, 2], BracketRight: [0xdd, 2],
  Backslash: [0xdc, 2], IntlBackslash: [0xe2, 2], Semicolon: [0xba, 2], Quote: [0xde, 2], Comma: [0xbc, 2],
  Period: [0xbe, 2], Slash: [0xbf, 2],
  // Extended only, so the numpad (with Num Lock off) doesn't trigger them.
  Insert: [0x2d, 1], Delete: [0x2e, 1], Home: [0x24, 1], End: [0x23, 1], PageUp: [0x21, 1], PageDown: [0x22, 1],
  ArrowUp: [0x26, 1], ArrowDown: [0x28, 1], ArrowLeft: [0x25, 1], ArrowRight: [0x27, 1],
  NumpadMultiply: [0x6a, 2], NumpadAdd: [0x6b, 2], NumpadSubtract: [0x6d, 2], NumpadDecimal: [0x6e, 2],
  NumpadDivide: [0x6f, 2], NumLock: [0x90, 2], ScrollLock: [0x91, 2], Pause: [0x13, 2], PrintScreen: [0x2c, 2],
  MediaPlayPause: [0xb3, 2], MediaTrackNext: [0xb0, 2], MediaTrackPrevious: [0xb1, 2], MediaStop: [0xb2, 2]
};
function vkOf(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return [m[1].charCodeAt(0), 2];
  if ((m = /^Digit(\d)$/.exec(code))) return [0x30 + Number(m[1]), 2];
  if ((m = /^Numpad(\d)$/.exec(code))) return [0x60 + Number(m[1]), 2];
  if ((m = /^F([1-9]|1\d|2[0-4])$/.exec(code))) return [0x6f + Number(m[1]), 2];
  return VK[code] || null;
}
const modBits = (p) => (p.ctrl ? 1 : 0) | (p.alt ? 2 : 0) | (p.shift ? 4 : 0) | (p.meta ? 8 : 0);

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'driver', 'ezsb-hotkeys.exe')
    : path.join(__dirname, '..', '..', 'native', 'bin', 'ezsb-hotkeys.exe');
}

let proc = null;
let actions = [];        // binding id -> action
let restarts = 0;
let hookState = { keyboard: false, mouse: false };

function sendNative(bindings) {
  const failed = [];
  const lines = ['clear'];
  actions = [];
  for (const { combo, action } of bindings) {
    const p = parse(combo);
    if (!p) continue;
    const mouse = /^Mouse([45])$/.exec(p.key);
    const vk = mouse ? null : vkOf(p.key);
    if (!mouse && !vk) { failed.push(combo); continue; }
    const id = actions.push(action) - 1;
    lines.push(`bind ${id} ${vk ? vk[0] : 0} ${vk ? vk[1] : 2} ${modBits(p)} ${mouse ? mouse[1] : 0}`);
  }
  lines.push('apply');
  if (proc && proc.stdin.writable) proc.stdin.write(lines.join('\n') + '\n');
  return failed;
}

function startNative() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(helperPath())) return resolve(false);
    let ready = false;
    let buf = '';
    let p;
    try {
      p = spawn(helperPath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => { if (!ready) { try { p.kill(); } catch { /* gone */ } resolve(false); } }, 4000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          proc = p;
          resolve(true);
        } else if (line.startsWith('fire ')) {
          const a = actions[Number(line.slice(5))];
          if (a) fire(a);
        } else if (line.startsWith('hooks ')) {
          const [, kb, ms] = line.split(' ');
          hookState = { keyboard: kb === '1', mouse: ms === '1' };
        }
      }
    });
    p.stdin.on('error', () => { /* helper gone; handled on exit */ });
    p.on('error', () => { clearTimeout(timer); if (!ready) resolve(false); });
    p.on('exit', () => {
      clearTimeout(timer);
      if (!ready) { resolve(false); return; }
      if (proc !== p) return; // we stopped it on purpose
      proc = null;
      // Crashed: restart it a few times, then fall back so hotkeys keep working.
      if (restarts++ < 3) {
        startNative().then((ok) => { if (ok) sendNative(lastBindings); else useFallback(); });
      } else {
        useFallback();
      }
    });
  });
}

/* ---------------- fallbacks ---------------- */

let uio = null;
let UK = null;
let uioStarted = false;
let parsedUio = [];
const held = new Set();

function startUiohook() {
  try {
    const m = require('uiohook-napi');
    uio = m.uIOhook;
    UK = m.UiohookKey;
  } catch {
    return false;
  }
  try {
    uio.on('keydown', (e) => {
      if (held.has(e.keycode)) return;
      held.add(e.keycode);
      for (const b of parsedUio) {
        if (b.mouse || b.kc !== e.keycode) continue;
        if (b.ctrl === !!e.ctrlKey && b.alt === !!e.altKey && b.shift === !!e.shiftKey && b.meta === !!e.metaKey) fire(b.action);
      }
    });
    uio.on('keyup', (e) => held.delete(e.keycode));
    uio.on('mousedown', (e) => {
      for (const b of parsedUio) {
        if (!b.mouse || b.mouse !== e.button) continue;
        if (b.ctrl === !!e.ctrlKey && b.alt === !!e.altKey && b.shift === !!e.shiftKey && b.meta === !!e.metaKey) fire(b.action);
      }
    });
    uio.start();
    uioStarted = true;
    return true;
  } catch (e) {
    console.warn('uiohook failed', e);
    uio = null;
    return false;
  }
}

function uioKey(code) {
  let m;
  let name = code;
  if ((m = /^Key([A-Z])$/.exec(code))) name = m[1];
  else if ((m = /^Digit(\d)$/.exec(code))) name = m[1];
  else if (code === 'NumpadEnter') name = 'Enter';
  return UK && UK[name] !== undefined ? UK[name] : null;
}

const ACCEL = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Escape: 'Esc',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`', CapsLock: 'Capslock', NumLock: 'Numlock',
  ScrollLock: 'Scrolllock', PrintScreen: 'PrintScreen', Pause: 'MediaPlayPause',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
};
function accelKey(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return 'num' + m[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return ACCEL[code] || null;
}

function applyFallback(bindings) {
  const failed = [];
  if (mode === 'uiohook') {
    parsedUio = [];
    for (const { combo, action } of bindings) {
      const p = parse(combo);
      if (!p) continue;
      const mm = /^Mouse(\d)$/.exec(p.key);
      if (mm) parsedUio.push({ ...p, mouse: Number(mm[1]), action });
      else {
        const kc = uioKey(p.key);
        if (kc == null) failed.push(combo);
        else parsedUio.push({ ...p, kc, action });
      }
    }
    return failed;
  }
  globalShortcut.unregisterAll();
  for (const { combo, action } of bindings) {
    const p = parse(combo);
    if (!p) continue;
    const k = /^Mouse\d$/.test(p.key) ? null : accelKey(p.key);
    if (!k) { failed.push(combo); continue; }
    const accel = [p.ctrl && 'CommandOrControl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Super', k].filter(Boolean).join('+');
    try {
      if (!globalShortcut.register(accel, () => fire(action))) failed.push(combo);
    } catch {
      failed.push(combo);
    }
  }
  return failed;
}

function useFallback() {
  if (mode === 'uiohook' || mode === 'globalShortcut') return;
  mode = startUiohook() ? 'uiohook' : 'globalShortcut';
  console.warn('hotkeys: using fallback', mode);
  applyFallback(lastBindings);
}

/* ---------------- public ---------------- */

let starting = null;

function init(cb) {
  onFire = cb;
  mode = 'native';
  starting = startNative().then((ok) => {
    starting = null;
    if (ok) sendNative(lastBindings);
    else useFallback();
  });
}

function set(bindings) {
  lastBindings = (bindings || []).slice(0, 2000);
  if (mode === 'native') {
    // Still starting: the bindings go out as soon as it's ready.
    const failed = sendNative(lastBindings);
    return { backend: backend(), failed };
  }
  return { backend: backend(), failed: applyFallback(lastBindings) };
}

function backend() { return mode === 'native' ? 'native' : mode; }
function status() { return { backend: backend(), hooks: hookState }; }
function suspend(on) { suspended = !!on; held.clear(); }
function dispose() {
  try { globalShortcut.unregisterAll(); } catch { /* noop */ }
  try { if (uio && uioStarted) uio.stop(); } catch { /* noop */ }
  const p = proc;
  proc = null;
  if (p) {
    try { p.stdin.end('quit\n'); } catch { /* gone */ }
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 500).unref();
  }
}
const ready = () => starting || Promise.resolve();

module.exports = { init, set, backend, status, suspend, dispose, ready, _vkOf: vkOf };
