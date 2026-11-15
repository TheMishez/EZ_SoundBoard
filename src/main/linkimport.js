'use strict';
/**
 * "Add from link": downloads an audio file from a URL into the sound library folder.
 *
 * Works with direct links (…/sound.mp3, Discord attachments), share links that need rewriting
 * (Dropbox, Google Drive, GitHub) and web pages that contain one sound,
 * like myinstants.com - the page is read and the audio file it plays is downloaded instead.
 */
const { net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_PAGE = 3 * 1024 * 1024;
const TIMEOUT_MS = 45000;

const TYPE_EXT = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mpeg3': '.mp3', 'audio/x-mpeg-3': '.mp3',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav',
  'audio/ogg': '.ogg', 'application/ogg': '.ogg', 'audio/vorbis': '.ogg',
  'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.aac', 'audio/x-aac': '.aac',
  'audio/opus': '.opus', 'audio/webm': '.webm', 'video/webm': '.webm', 'video/mp4': '.mp4'
};

const STREAMING = /(^|\.)(youtube\.com|youtu\.be|twitch\.tv|tiktok\.com|instagram\.com|soundcloud\.com|spotify\.com|music\.apple\.com|x\.com|twitter\.com)$/i;

class LinkError extends Error {}

/** Turns common share links into direct download links. Returns a URL object. */
function normalizeUrl(input) {
  let s = String(input || '').trim().replace(/^<|>$/g, '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new LinkError("That doesn't look like a link"); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new LinkError('Only http and https links work');
  const host = u.hostname.toLowerCase();
  if (STREAMING.test(host)) {
    throw new LinkError("Streaming sites (YouTube, TikTok, Spotify…) can't be downloaded from. Use a direct link to an audio file.");
  }
  if (/(^|\.)dropbox\.com$/.test(host)) {
    u.searchParams.delete('dl');
    u.searchParams.set('raw', '1');
  } else if (host === 'drive.google.com') {
    const m = /\/file\/d\/([\w-]+)/.exec(u.pathname);
    const id = m ? m[1] : u.searchParams.get('id');
    if (id) u = new URL(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`);
  } else if (host === 'github.com' && /\/blob\//.test(u.pathname)) {
    u = new URL('https://raw.githubusercontent.com' + u.pathname.replace('/blob/', '/'));
  }
  return u;
}

const AUDIO_EXTS = new Set(Object.values(TYPE_EXT).concat(['.oga']));
const extOf = (p) => {
  const e = path.extname(String(p || '').split(/[?#]/)[0]).toLowerCase();
  return AUDIO_EXTS.has(e) ? e : '';
};

/** Recognises the format from the first bytes. */
function sniff(b) {
  if (!b || b.length < 12) return '';
  const s4 = b.toString('latin1', 0, 4);
  if (s4 === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return '.wav';
  if (s4 === 'OggS') return '.ogg';
  if (s4 === 'fLaC') return '.flac';
  if (b.toString('latin1', 0, 3) === 'ID3') return '.mp3';
  if (b.toString('latin1', 4, 8) === 'ftyp') return '.m4a';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return '.webm';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return '.aac';       // ADTS AAC
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return '.mp3';       // MPEG audio frame
  return '';
}

function looksLikeHtml(b) {
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<?xml');
}

function filenameFromDisposition(cd) {
  if (!cd) return '';
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(cd);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return m ? m[1].trim() : '';
}

function niceName(raw, fallbackHost) {
  let n = String(raw || '');
  try { n = decodeURIComponent(n); } catch { /* keep */ }
  n = path.basename(n.split(/[?#]/)[0]).replace(/\.[a-z0-9]{2,5}$/i, '');
  n = n.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n || /^(uc|download|file|raw|index|media|audio)$/i.test(n) || /^[0-9a-f-]{20,}$/i.test(n)) n = 'Sound from ' + fallbackHost;
  return n.slice(0, 80);
}

/** Finds the sound a web page plays (og:audio, <audio>/<source>, or a link to an audio file). */
function findAudioInPage(html, pageUrl) {
  const found = [];
  const add = (v) => {
    if (!v) return;
    v = v.replace(/&amp;/g, '&').replace(/\\\//g, '/').trim();
    try {
      const u = new URL(v, pageUrl);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && AUDIO_EXTS.has(path.extname(u.pathname).toLowerCase())) found.push(u.toString());
    } catch { /* bad URL */ }
  };
  let m;
  const og = /<meta[^>]+(?:property|name)=["'](?:og:audio(?::secure_url|:url)?|twitter:player:stream)["'][^>]*>/gi;
  while ((m = og.exec(html))) add((/content=["']([^"']+)["']/i.exec(m[0]) || [])[1]);
  const tags = /<(?:audio|source)\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = tags.exec(html))) add(m[1]);
  // myinstants and similar: play('/media/sounds/x.mp3') or data-url="…mp3"
  const any = /["'(]((?:https?:)?\/?\/?[^"'()\s<>]+?\.(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|webm))(?:\?[^"'()\s<>]*)?["')]/gi;
  while ((m = any.exec(html)) && found.length < 50) add(m[1]);
  return [...new Set(found)];
}

async function readBody(res, limit, signal) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    if (signal.aborted) throw new LinkError('The download took too long');
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { try { await reader.cancel(); } catch { /* ignore */ } return { tooBig: true }; }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return { buf: Buffer.concat(chunks, size) };
}

async function fetchOnce(url, signal) {
  let res;
  try {
    res = await net.fetch(url, {
      signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EZSoundboard', Accept: 'audio/*,video/*;q=0.8,*/*;q=0.5' }
    });
  } catch (e) {
    if (signal.aborted) throw new LinkError('The download took too long');
    throw new LinkError("Couldn't reach that link. Check the address and your connection.");
  }
  if (res.status === 401 || res.status === 403) throw new LinkError("That link needs a login or isn't shared publicly");
  if (res.status === 404) throw new LinkError('Nothing was found at that link (404)');
  if (!res.ok) throw new LinkError(`The site answered with an error (${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new LinkError('That file is too big (over 100 MB)');
  return res;
}

/**
 * Downloads the sound at `input` into `dir`. Returns { id, file, name } like a normal import.
 */
async function importFromLink(dir, input) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let url = normalizeUrl(input);
    let res = await fetchOnce(url.toString(), ctl.signal);
    let type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

    // A web page: look for the sound it plays and download that instead.
    if (type === 'text/html' || type === 'application/xhtml+xml') {
      const page = await readBody(res, MAX_PAGE, ctl.signal);
      const html = page.buf ? page.buf.toString('utf8') : '';
      const candidates = findAudioInPage(html, res.url || url.toString());
      if (!candidates.length) {
        throw new LinkError("That link opens a web page, not a sound. Right-click the sound's download button and copy the link to the file.");
      }
      url = new URL(candidates[0]);
      res = await fetchOnce(url.toString(), ctl.signal);
      type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    }

    const finalUrl = res.url || url.toString();
    const dispName = filenameFromDisposition(res.headers.get('content-disposition'));
    const body = await readBody(res, MAX_BYTES, ctl.signal);
    if (body.tooBig) throw new LinkError('That file is too big (over 100 MB)');
    const buf = body.buf;
    if (!buf || buf.length < 64) throw new LinkError('The link returned an empty file');
    if (looksLikeHtml(buf)) {
      throw new LinkError("That link opens a web page, not a sound. Use a direct link to the audio file.");
    }

    const ext = sniff(buf) || TYPE_EXT[type] || extOf(dispName) || extOf(finalUrl) || extOf(url.pathname);
    if (!ext) throw new LinkError("That link isn't an audio file EZ Soundboard can play (mp3, wav, ogg, flac, m4a, opus, webm)");

    const id = crypto.randomBytes(6).toString('hex');
    const file = id + ext;
    await fsp.writeFile(path.join(dir, file), buf);
    const name = niceName(dispName || new URL(finalUrl).pathname || url.pathname, url.hostname.replace(/^www\./, ''));
    return { id, file, name, source: url.toString() };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { importFromLink, normalizeUrl, findAudioInPage, sniff, niceName, LinkError };
