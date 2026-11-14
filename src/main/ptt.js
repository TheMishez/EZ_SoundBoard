'use strict';
/**
 * Auto push-to-talk: holds your in-game / Discord voice key while a sound is playing into the mic.
 * Uses a small persistent PowerShell helper that calls user32 keybd_event / mouse_event, so no
 * native Node module is needed. Sends both the virtual-key and the hardware scan code, which is
 * what games using raw input (CS2, Valorant, etc.) read.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MPKB {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  public static void Key(byte vk, bool up, bool ext) {
    byte sc = (byte)MapVirtualKey(vk, 0);
    uint f = 0;
    if (ext) f |= 1;
    if (up) f |= 2;
    keybd_event(vk, sc, f, UIntPtr.Zero);
  }
  public static void XButton(uint which, bool up) {
    mouse_event(up ? 0x0100u : 0x0080u, 0, 0, which, UIntPtr.Zero);
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  switch ($p[0]) {
    'down'  { [MPKB]::Key([byte]$p[1], $false, $p[2] -eq '1') }
    'up'    { [MPKB]::Key([byte]$p[1], $true,  $p[2] -eq '1') }
    'mdown' { [MPKB]::XButton([uint32]$p[1], $false) }
    'mup'   { [MPKB]::XButton([uint32]$p[1], $true) }
  }
}
`;

// KeyboardEvent.code -> [virtual key, extended?]
const VK = {
  Space: [0x20], Enter: [0x0d], NumpadEnter: [0x0d, 1], Tab: [0x09], Backspace: [0x08], Escape: [0x1b],
  CapsLock: [0x14], ShiftLeft: [0xa0], ShiftRight: [0xa1], ControlLeft: [0xa2], ControlRight: [0xa3, 1],
  AltLeft: [0xa4], AltRight: [0xa5, 1], Backquote: [0xc0], Minus: [0xbd], Equal: [0xbb],
  BracketLeft: [0xdb], BracketRight: [0xdd], Backslash: [0xdc], Semicolon: [0xba], Quote: [0xde],
  Comma: [0xbc], Period: [0xbe], Slash: [0xbf], Insert: [0x2d, 1], Delete: [0x2e, 1], Home: [0x24, 1],
  End: [0x23, 1], PageUp: [0x21, 1], PageDown: [0x22, 1], ArrowUp: [0x26, 1], ArrowDown: [0x28, 1],
  ArrowLeft: [0x25, 1], ArrowRight: [0x27, 1], NumpadMultiply: [0x6a], NumpadAdd: [0x6b],
  NumpadSubtract: [0x6d], NumpadDecimal: [0x6e], NumpadDivide: [0x6f, 1], NumLock: [0x90, 1],
  ScrollLock: [0x91], Pause: [0x13], PrintScreen: [0x2c, 1]
};

function resolve(code) {
  let m;
  if ((m = /^Mouse([45])$/.exec(code))) return { mouse: Number(m[1]) - 3 }; // XBUTTON1 / XBUTTON2
  if ((m = /^Key([A-Z])$/.exec(code))) return { vk: m[1].charCodeAt(0), ext: 0 };
  if ((m = /^Digit(\d)$/.exec(code))) return { vk: 0x30 + Number(m[1]), ext: 0 };
  if ((m = /^Numpad(\d)$/.exec(code))) return { vk: 0x60 + Number(m[1]), ext: 0 };
  if ((m = /^F(\d{1,2})$/.exec(code)) && Number(m[1]) >= 1 && Number(m[1]) <= 24) return { vk: 0x6f + Number(m[1]), ext: 0 };
  if (VK[code]) return { vk: VK[code][0], ext: VK[code][1] ? 1 : 0 };
  return null;
}

let proc = null;
let held = null;

function ensure() {
  if (process.platform !== 'win32') return null;
  if (proc && !proc.killed && proc.exitCode === null) return proc;
  const file = path.join(os.tmpdir(), 'ezsoundboard-ptt.ps1');
  fs.writeFileSync(file, SCRIPT, 'utf8');
  proc = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.on('exit', () => { proc = null; });
  proc.on('error', (e) => { console.warn('PTT helper failed', e); proc = null; });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => console.warn('[ptt]', String(d)));
  return proc;
}

function send(line) {
  const p = ensure();
  if (p && p.stdin.writable) p.stdin.write(line + '\n');
}

function down(code) {
  const spec = resolve(code);
  if (!spec) return;
  if (held) up();
  held = spec;
  send(spec.mouse ? `mdown ${spec.mouse}` : `down ${spec.vk} ${spec.ext}`);
}

function up() {
  if (!held) return;
  const spec = held;
  held = null;
  send(spec.mouse ? `mup ${spec.mouse}` : `up ${spec.vk} ${spec.ext}`);
}

// Start the helper early: compiling the C# snippet takes ~1s, we don't want that on the first sound.
function warmup() { try { ensure(); } catch (e) { console.warn(e); } }
function dispose() {
  try { up(); } catch { /* noop */ }
  try { if (proc) proc.stdin.end(); } catch { /* noop */ }
  setTimeout(() => { try { if (proc) proc.kill(); } catch { /* noop */ } }, 200);
}

module.exports = { down, up, warmup, dispose };
