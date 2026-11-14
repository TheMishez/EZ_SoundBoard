'use strict';
/**
 * Global hotkeys.
 *
 * Preferred backend: uiohook-napi (low-level hook). Keys are NOT swallowed, so you can bind a
 * sound to a key you also use in-game, and mouse side buttons (Mouse4/Mouse5) work.
 * Fallback backend: Electron globalShortcut (keys are consumed by the app, no mouse buttons).
 *
 * Combos are stored as strings like "Ctrl+Shift+KeyA", "Numpad1", "Mouse4"
 * (modifiers + a KeyboardEvent.code, or a mouse button).
 */
const { globalShortcut } = require('electron');

let uio = null;
let UK = null;
try {
  const m = require('uiohook-napi');
  uio = m.uIOhook;
  UK = m.UiohookKey;
} catch {
  uio = null;
}

let onFire = () => {};
let started = false;
let suspended = false;
let parsed = [];
const held = new Set();

function parse(combo) {
  const parts = String(combo || '').split('+').filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const mods = new Set(parts);
  return { key, ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), meta: mods.has('Win') };
}

function uioKey(code) {
  if (!UK) return null;
  let m;
  let name = code;
  if ((m = /^Key([A-Z])$/.exec(code))) name = m[1];
  else if ((m = /^Digit(\d)$/.exec(code))) name = m[1];
  else if (code === 'NumpadEnter') name = 'Enter';
  return UK[name] !== undefined ? UK[name] : null;
}

function startHook() {
  if (!uio || started) return;
  try {
    uio.on('keydown', (e) => {
      if (held.has(e.keycode)) return; // ignore auto-repeat
      held.add(e.keycode);
      if (suspended) return;
      for (const b of parsed) {
        if (b.mouse || b.kc !== e.keycode) continue;
        if (b.ctrl === !!e.ctrlKey && b.alt === !!e.altKey && b.shift === !!e.shiftKey && b.meta === !!e.metaKey) {
          onFire(b.action);
        }
      }
    });
    uio.on('keyup', (e) => held.delete(e.keycode));
    uio.on('mousedown', (e) => {
      if (suspended) return;
      for (const b of parsed) {
        if (!b.mouse || b.mouse !== e.button) continue;
        if (b.ctrl === !!e.ctrlKey && b.alt === !!e.altKey && b.shift === !!e.shiftKey && b.meta === !!e.metaKey) {
          onFire(b.action);
        }
      }
    });
    uio.start();
    started = true;
  } catch (e) {
    console.warn('uiohook failed, falling back to globalShortcut', e);
    uio = null;
  }
}

/* ---- globalShortcut fallback ---- */
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

function set(bindings) {
  const failed = [];
  parsed = [];
  if (!uio) globalShortcut.unregisterAll();

  for (const { combo, action } of bindings || []) {
    const p = parse(combo);
    if (!p) continue;
    const mouseMatch = /^Mouse(\d)$/.exec(p.key);
    if (uio) {
      if (mouseMatch) parsed.push({ ...p, mouse: Number(mouseMatch[1]), action });
      else {
        const kc = uioKey(p.key);
        if (kc == null) failed.push(combo);
        else parsed.push({ ...p, kc, action });
      }
    } else {
      const k = mouseMatch ? null : accelKey(p.key);
      if (!k) { failed.push(combo); continue; }
      const accel = [p.ctrl && 'CommandOrControl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Super', k]
        .filter(Boolean).join('+');
      try {
        const ok = globalShortcut.register(accel, () => { if (!suspended) onFire(action); });
        if (!ok) failed.push(combo);
      } catch {
        failed.push(combo);
      }
    }
  }
  return { backend: backend(), failed };
}

function init(cb) {
  onFire = cb;
  startHook();
}
function backend() { return uio ? 'uiohook' : 'globalShortcut'; }
function suspend(on) { suspended = on; held.clear(); }
function dispose() {
  try { globalShortcut.unregisterAll(); } catch { /* noop */ }
  try { if (uio && started) uio.stop(); } catch { /* noop */ }
}

module.exports = { init, set, backend, suspend, dispose };
