'use strict';
/**
 * Text-to-speech using the voices already on Windows - nothing to install.
 *  - "winrt:" voices: the modern Windows voices (Settings → Time & language → Speech)
 *  - "sapi:"  voices: the classic desktop voices (System.Speech)
 * Speech is written to a .wav in the sound library folder, then played by the normal audio engine,
 * so it goes into the mic exactly like any other sound.
 *
 * Text and settings reach PowerShell through environment variables, never through the command
 * line, so nothing typed can be run as code.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const MAX_CHARS = 1000;

const LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = @()
try {
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
  $def = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice
  foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
    $out += [pscustomobject]@{ id = 'winrt:' + $v.Id; name = $v.DisplayName; lang = $v.Language; gender = [string]$v.Gender; isDefault = ($def -ne $null -and $def.Id -eq $v.Id) }
  }
} catch {}
try {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  foreach ($v in $s.GetInstalledVoices()) {
    if ($v.Enabled) {
      $i = $v.VoiceInfo
      $out += [pscustomobject]@{ id = 'sapi:' + $i.Name; name = $i.Name; lang = $i.Culture.Name; gender = [string]$i.Gender; isDefault = $false }
    }
  }
  $s.Dispose()
} catch {}
ConvertTo-Json -Compress -InputObject @($out)
`;

const SPEAK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$text = $env:EZSB_TTS_TEXT
$voice = [string]$env:EZSB_TTS_VOICE
$rate = [double]::Parse($env:EZSB_TTS_RATE, [Globalization.CultureInfo]::InvariantCulture)
$outFile = $env:EZSB_TTS_OUT
if ($voice.StartsWith('sapi:') -or $voice -eq '') {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($voice.StartsWith('sapi:')) { $s.SelectVoice($voice.Substring(5)) }
  # SAPI rate is -10..10 (about 1/3x..3x speed)
  $s.Rate = [int][Math]::Round([Math]::Max(-10, [Math]::Min(10, 10 * [Math]::Log($rate, 3))))
  $s.SetOutputToWaveFile($outFile)
  $s.Speak($text)
  $s.SetOutputToNull()
  $s.Dispose()
} else {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1'
  } | Select-Object -First 1
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(-1)
    $task.Result
  }
  $s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  $id = $voice.Substring(6)
  $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Id -eq $id } | Select-Object -First 1
  if ($v -ne $null) { $s.Voice = $v }
  try { $s.Options.SpeakingRate = [Math]::Max(0.5, [Math]::Min(6.0, $rate)) } catch {}
  $stream = Await ($s.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [IO.File]::WriteAllBytes($outFile, $bytes)
  $reader.Dispose()
  $stream.Dispose()
  $s.Dispose()
}
'ok'
`;

function runPs(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Text-to-speech needs Windows'));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error('Text-to-speech took too long')); }, timeoutMs);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { if (out.length < 1e6) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error((err.split(/\r?\n/).find((l) => l.trim()) || `PowerShell exited with ${code}`).trim()));
    });
  });
}

let voicesCache = null;
/** [{ id, name, lang, gender, isDefault }] - modern voices first, duplicates of the same voice removed. */
async function voices(refresh = false) {
  if (voicesCache && !refresh) return voicesCache;
  let list = [];
  try {
    const raw = (await runPs(LIST_SCRIPT, {}, 20000)).trim();
    const j = JSON.parse(raw || '[]');
    list = (Array.isArray(j) ? j : [j]).filter((v) => v && v.id && v.name);
  } catch (e) {
    console.warn('tts voices failed', e);
    return [];
  }
  // The same voice can show up in both lists ("Microsoft Zira" and "Microsoft Zira Desktop").
  const seen = new Set();
  const outList = [];
  for (const v of list) {
    const key = String(v.name).replace(/\s+Desktop$/i, '').replace(/\s+-\s+.*$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    outList.push({ id: String(v.id), name: String(v.name), lang: String(v.lang || ''), gender: String(v.gender || ''), isDefault: !!v.isDefault });
  }
  voicesCache = outList;
  return voicesCache;
}

/**
 * Speaks `text` into a new .wav in `dir`. Returns { file } (the file name, not a full path).
 * rate: 0.5..3 (1 = normal speed).
 */
async function speak(dir, { text, voice = '', rate = 1 } = {}) {
  text = String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, MAX_CHARS);
  if (!text) throw new Error('Type something to say');
  voice = String(voice || '');
  if (voice && !/^(winrt|sapi):[^\r\n]{1,300}$/.test(voice)) voice = '';
  rate = Math.min(3, Math.max(0.5, Number(rate) || 1));
  const file = 'tts-' + crypto.randomBytes(6).toString('hex') + '.wav';
  const full = path.join(dir, file);
  const run = (v) => runPs(SPEAK_SCRIPT, {
    EZSB_TTS_TEXT: text,
    EZSB_TTS_VOICE: v,
    EZSB_TTS_RATE: String(rate),
    EZSB_TTS_OUT: full
  }, 30000);
  try {
    await run(voice);
  } catch (e) {
    if (!voice) throw e;
    console.warn('tts with', voice, 'failed, using the default voice', e);
    await run(''); // that voice is gone or broken: use the Windows default
  }
  const st = await fsp.stat(full).catch(() => null);
  if (!st || st.size < 100) throw new Error("Windows didn't produce any speech");
  return { file };
}

/** Speech files that were never saved to the board are deleted at start-up and quit. */
async function cleanup(dir) {
  try {
    for (const f of await fsp.readdir(dir)) {
      if (/^tts-[0-9a-f]{12}\.wav$/.test(f)) await fsp.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch { /* no folder */ }
}
function cleanupSync(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^tts-[0-9a-f]{12}\.wav$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use */ } }
    }
  } catch { /* no folder */ }
}

module.exports = { voices, speak, cleanup, cleanupSync, MAX_CHARS };
