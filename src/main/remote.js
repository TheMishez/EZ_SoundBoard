'use strict';
/**
 * Local control for the Stream Deck plugin (and anything else on this PC).
 * Listens on 127.0.0.1 only, so other computers can't reach it.
 *
 * Every request must carry the header "X-EZSB: 1". Browsers can't add that header to a request for
 * another site without asking first (a CORS preflight), and that preflight is only answered for
 * pages with no web origin (the Stream Deck plugin runs from local files). So a website you visit
 * can't play sounds on your mic.
 *
 *   GET  /v1/ping              → { ok, app, version }
 *   GET  /v1/sounds            → { sounds: [{ id, name, board, color, hotkey }], boards: [...] }
 *   GET  /v1/state             → { playing: [soundId…], soundsToMic }
 *   POST /v1/play   { id | name }
 *   POST /v1/stop   { id }      (no id = stop everything)
 *   POST /v1/stopall
 *   POST /v1/tts    { text, voice? }
 *   POST /v1/mic    { on?: boolean }   (toggles when "on" is missing)
 */
const http = require('http');

const PORT = 41720;
const MAX_BODY = 16 * 1024;

let server = null;
let status = { running: false, port: PORT, error: '' };
let send = () => {};          // forwards a command to the window
let version = '0.0.0';
let sounds = [];
let boards = [];
let playing = [];
let soundsToMic = true;
let onStatus = () => {};

const allowedOrigin = (o) => o === undefined || o === 'null' || /^file:\/\//i.test(o);

function reply(res, code, body, origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h.Vary = 'Origin';
  }
  res.writeHead(code, h);
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      body += d;
      if (body.length > MAX_BODY) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function findSound(q) {
  if (!q) return null;
  if (q.id) {
    const s = sounds.find((x) => x.id === String(q.id));
    if (s) return s;
  }
  if (q.name) {
    const n = String(q.name).trim().toLowerCase();
    return sounds.find((x) => x.name.toLowerCase() === n) || sounds.find((x) => x.name.toLowerCase().includes(n)) || null;
  }
  return null;
}

async function handle(req, res) {
  const origin = req.headers.origin;
  // Blocks DNS-rebinding tricks: the request must be addressed to this PC by name.
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''))) {
    return reply(res, 403, { ok: false, error: 'forbidden host' });
  }
  // Only pages without a web origin (the Stream Deck plugin) may call from a browser engine.
  if (!allowedOrigin(origin)) return reply(res, 403, { ok: false, error: 'forbidden origin' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-EZSB',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin'
    });
    return res.end();
  }
  if (req.headers['x-ezsb'] !== '1') return reply(res, 400, { ok: false, error: 'missing X-EZSB header' }, origin);
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = req.method + ' ' + url.pathname.replace(/\/+$/, '');

  if (route === 'GET /v1/ping') return reply(res, 200, { ok: true, app: 'EZ Soundboard', version }, origin);
  if (route === 'GET /v1/sounds') return reply(res, 200, { ok: true, sounds, boards }, origin);
  if (route === 'GET /v1/state') return reply(res, 200, { ok: true, playing, soundsToMic }, origin);
  if (req.method !== 'POST') return reply(res, 404, { ok: false, error: 'not found' }, origin);

  const body = await readJson(req);
  if (body === null) return reply(res, 400, { ok: false, error: 'bad JSON' }, origin);

  switch (url.pathname.replace(/\/+$/, '')) {
    case '/v1/play': {
      const s = findSound(body);
      if (!s) return reply(res, 404, { ok: false, error: 'sound not found' }, origin);
      send({ cmd: 'play', id: s.id });
      return reply(res, 200, { ok: true, id: s.id, name: s.name }, origin);
    }
    case '/v1/stop':
      send(body.id ? { cmd: 'stop', id: String(body.id) } : { cmd: 'stopAll' });
      return reply(res, 200, { ok: true }, origin);
    case '/v1/stopall':
      send({ cmd: 'stopAll' });
      return reply(res, 200, { ok: true }, origin);
    case '/v1/tts': {
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return reply(res, 400, { ok: false, error: 'no text' }, origin);
      send({ cmd: 'tts', text, voice: body.voice ? String(body.voice).slice(0, 300) : '' });
      return reply(res, 200, { ok: true }, origin);
    }
    case '/v1/mic':
      send({ cmd: 'mic', on: typeof body.on === 'boolean' ? body.on : null });
      return reply(res, 200, { ok: true }, origin);
    default:
      return reply(res, 404, { ok: false, error: 'not found' }, origin);
  }
}

function setStatus(patch) {
  status = { ...status, ...patch };
  try { onStatus(status); } catch { /* window gone */ }
}

function start() {
  if (server) return;
  server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.warn('remote request failed', e);
      try { reply(res, 500, { ok: false, error: 'internal error' }); } catch { /* closed */ }
    });
  });
  server.keepAliveTimeout = 5000;
  server.on('error', (e) => {
    setStatus({ running: false, error: e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use by another program` : String(e.message || e) });
    try { server.close(); } catch { /* not open */ }
    server = null;
  });
  server.listen(PORT, '127.0.0.1', () => setStatus({ running: true, error: '' }));
}

function stop() {
  if (!server) return;
  try { server.close(); } catch { /* not open */ }
  server = null;
  setStatus({ running: false, error: '' });
}

/** opts: { enabled, version, send(cmd), onStatus(status) } */
function init(opts = {}) {
  send = opts.send || send;
  onStatus = opts.onStatus || onStatus;
  version = opts.version || version;
  if (opts.enabled !== false) start();
}

function setEnabled(on) { if (on) start(); else stop(); }
function setLibrary(data) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data.sounds)) sounds = data.sounds.slice(0, 5000).map((s) => ({
    id: String(s.id), name: String(s.name || '').slice(0, 120), board: String(s.board || ''), color: String(s.color || ''), hotkey: String(s.hotkey || '')
  }));
  if (Array.isArray(data.boards)) boards = data.boards.slice(0, 500).map(String);
}
function setPlaying(data) {
  if (!data) return;
  if (Array.isArray(data.playing)) playing = [...new Set(data.playing.map(String))].slice(0, 200);
  if (typeof data.soundsToMic === 'boolean') soundsToMic = data.soundsToMic;
}

module.exports = { init, setEnabled, setLibrary, setPlaying, status: () => status, PORT, _handle: handle, _allowedOrigin: allowedOrigin };
