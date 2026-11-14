'use strict';
/**
 * Direct-to-mic mode (no virtual cable).
 *  - ezsb-mic-setup.exe enables/disables the EZ Soundboard plugin on microphones (elevated when changing)
 *  - ezsb-bridge.exe streams the app's sound mix into the plugin via shared memory
 */
const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function driverDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'driver')
    : path.join(__dirname, '..', '..', 'native', 'bin');
}
const setupExe = () => path.join(driverDir(), 'ezsb-mic-setup.exe');
const bridgeExe = () => path.join(driverDir(), 'ezsb-bridge.exe');

function available() {
  return process.platform === 'win32' &&
    fs.existsSync(setupExe()) && fs.existsSync(bridgeExe()) &&
    fs.existsSync(path.join(driverDir(), 'EZSoundboardApo.dll'));
}

function parseJson(out) {
  const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch { return { ok: false, error: line || 'no output' }; }
}

function list() {
  return new Promise((resolve) => {
    if (!available()) return resolve({ ok: false, error: 'unavailable' });
    execFile(setupExe(), ['list'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      resolve(err && !stdout ? { ok: false, error: String(err.message || err) } : parseJson(stdout));
    });
  });
}

/** Runs the setup tool elevated (one UAC prompt). enable/disable are arrays of mic GUIDs. */
function apply(enable = [], disable = []) {
  return new Promise((resolve) => {
    if (!available()) return resolve({ ok: false, error: 'unavailable' });
    const safe = (a) => a.filter((g) => /^\{[0-9a-fA-F-]{36}\}$/.test(g) || g === 'default');
    const args = ['apply'];
    if (safe(enable).length) args.push('--enable', safe(enable).join(','));
    if (safe(disable).length) args.push('--disable', safe(disable).join(','));
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const ps = `$p = Start-Process -FilePath ${q(setupExe())} -ArgumentList ${q(args.join(' '))} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 120000 },
      (err) => {
        if (!err) return resolve({ ok: true });
        // Exit code 1 from PowerShell itself usually means the UAC prompt was declined.
        resolve({ ok: false, error: err.code === 5 ? 'admin' : (String(err.message || '').includes('canceled') ? 'cancelled' : 'failed'), code: err.code });
      });
  });
}

/* ---------------- bridge ---------------- */
let bridge = null;
let onStatus = () => {};
let lastVoice = 1;
let blocked = false;

function startBridge(statusCb) {
  if (statusCb) onStatus = statusCb;
  if (bridge || !available()) return !!bridge;
  try {
    bridge = spawn(bridgeExe(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) {
    console.warn('bridge failed', e);
    bridge = null;
    return false;
  }
  let buf = '';
  bridge.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onStatus(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  bridge.stdin.on('error', () => {});
  bridge.stdin.on('drain', () => { blocked = false; });
  bridge.on('exit', () => {
    bridge = null;
    onStatus({ mapped: false, apoAgeMs: -1, bridge: false });
  });
  setVoiceGain(lastVoice);
  return true;
}

function stopBridge() {
  if (!bridge) return;
  try { bridge.stdin.end(); } catch { /* noop */ }
  const b = bridge;
  setTimeout(() => { try { b.kill(); } catch { /* noop */ } }, 500);
  bridge = null;
}

function packet(type, payload) {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(type, 0);
  h.writeUInt32LE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

/** pcm: ArrayBuffer of float32 interleaved stereo @ 48 kHz */
function push(pcm) {
  if (!bridge || blocked) return; // drop rather than build up latency
  const ok = bridge.stdin.write(packet(1, Buffer.from(pcm)));
  if (!ok) blocked = true;
}

function setVoiceGain(g) {
  lastVoice = Math.max(0, Math.min(4, Number(g) || 0));
  if (!bridge) return;
  const b = Buffer.alloc(4);
  b.writeFloatLE(lastVoice, 0);
  bridge.stdin.write(packet(2, b));
}

module.exports = { available, list, apply, startBridge, stopBridge, push, setVoiceGain };
