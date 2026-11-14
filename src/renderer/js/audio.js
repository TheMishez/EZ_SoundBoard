'use strict';
/* Worklet that captures the "they hear" mix as 10 ms blocks of interleaved stereo float32,
   which the app streams into the microphone plugin. Loaded from a Blob URL because
   AudioWorklet can't load modules from file:// pages. */
const TAP_WORKLET_SRC = `/* Captures the "they hear" sound mix as 10 ms blocks of interleaved stereo float32 and
   hands them to the app, which streams them into the microphone plugin. */
class EZSBTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = 480; // 10 ms @ 48 kHz
    this.buf = new Float32Array(this.block * 2);
    this.n = 0;
    this.active = false;
    this.silentBlocks = 0;
    this.port.onmessage = (e) => { this.active = !!e.data.active; this.n = 0; };
  }

  process(inputs) {
    if (!this.active) return true;
    const inp = inputs[0] || [];
    const L = inp[0];
    const R = inp[1] || inp[0];
    const frames = L ? L.length : 128;
    for (let i = 0; i < frames; i++) {
      this.buf[this.n * 2] = L ? L[i] : 0;
      this.buf[this.n * 2 + 1] = R ? R[i] : 0;
      if (++this.n === this.block) {
        // Nothing playing for a while? Stop streaming silence to the mic plugin (saves CPU).
        let peak = 0;
        for (let k = 0; k < this.buf.length; k++) { const a = Math.abs(this.buf[k]); if (a > peak) peak = a; }
        this.silentBlocks = peak < 1e-5 ? this.silentBlocks + 1 : 0;
        if (this.silentBlocks < 50) {
          const out = this.buf.slice(0);
          this.port.postMessage(out.buffer, [out.buffer]);
        }
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('ezsb-tap', EZSBTap);`;

/**
 * Audio engine.
 *
 * Two AudioContexts, each sent to its own output device with setSinkId():
 *   monitor  -> your headphones ("you hear")
 *   mic      -> virtual cable, e.g. VB-Audio "CABLE Input" ("they hear")
 * The mic context also mixes your real microphone (passthrough) so the game/Discord gets
 * your voice + sounds on one input ("CABLE Output").
 *
 *  sounds ─► monBus ─► monMaster ─► analyser ─► headphones
 *  sounds ─► micBus ─► soundsGate ─► limiter ─► micMaster ─► analyser ─► CABLE Input
 *  real mic ─► voiceGain ─► duck ───────────────┘
 */
class AudioEngine {
  constructor() {
    const opts = { latencyHint: 'interactive', sampleRate: 48000 };
    this.mon = new AudioContext(opts);
    this.mic = new AudioContext(opts);

    this.monBus = this.mon.createGain();
    this.monMaster = this.mon.createGain();
    this.monAnalyser = this._analyser(this.mon);
    this.monBus.connect(this.monMaster).connect(this.monAnalyser).connect(this.mon.destination);

    this.micBus = this.mic.createGain();
    this.soundsGate = this.mic.createGain();
    this.limiter = this.mic.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.micMaster = this.mic.createGain();
    this.micAnalyser = this._analyser(this.mic);
    this.voiceGain = this.mic.createGain();
    this.duck = this.mic.createGain();
    this.voiceAnalyser = this._analyser(this.mic);

    this.micBus.connect(this.soundsGate);
    this.micMaster.connect(this.micAnalyser).connect(this.mic.destination);
    this.voiceGain.connect(this.voiceAnalyser);
    this.voiceGain.connect(this.duck);
    this.voiceRouted = false;
    this.setVoiceRouted(true);
    this.tap = null;
    this.direct = false;

    this.limiterOn = true;
    this._wireLimiter();

    this.micStream = null;
    this.micSrc = null;
    this.duckEnabled = false;
    this.duckLevel = 0.35;

    this.cache = new Map();
    this.cacheBytes = 0;
    this.cacheLimit = 128 * 1024 * 1024;
    this.pinned = new Set();
    this.loading = new Map();
    this.voices = new Map();
    this.nextId = 1;
    this.onChange = () => {};
    this._buf = new Float32Array(1024);

    this.resume();
  }

  _analyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0;
    return a;
  }

  _wireLimiter() {
    try { this.soundsGate.disconnect(); } catch { /* noop */ }
    try { this.limiter.disconnect(); } catch { /* noop */ }
    if (this.limiterOn) {
      this.soundsGate.connect(this.limiter);
      this.limiter.connect(this.micMaster);
    } else {
      this.soundsGate.connect(this.micMaster);
    }
  }

  /** Cable mode: your voice is mixed into the cable output. Direct mode: Windows does that natively. */
  setVoiceRouted(on) {
    if (on === this.voiceRouted) return;
    this.voiceRouted = on;
    if (on) this.duck.connect(this.micMaster);
    else { try { this.duck.disconnect(this.micMaster); } catch { /* noop */ } }
  }

  /**
   * Direct-to-mic mode: the sound mix is streamed to the EZ Soundboard microphone plugin instead
   * of a playback device. onBlock receives 10 ms ArrayBuffers of interleaved stereo float32.
   */
  async setDirect(on, onBlock) {
    this.direct = on;
    if (on && !this.tap) {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET_SRC], { type: 'application/javascript' }));
      try { await this.mic.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      this.tap = new AudioWorkletNode(this.mic, 'ezsb-tap', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
      });
      this.micMaster.connect(this.tap);
      this.tap.connect(this.mic.destination); // outputs silence; keeps the node running
    }
    if (this.tap) {
      this.tap.port.onmessage = on && onBlock ? (e) => onBlock(e.data) : null;
      this.tap.port.postMessage({ active: on });
    }
    this.setVoiceRouted(!on);
    if (on) {
      this.voiceGain.gain.setTargetAtTime(1, this.mic.currentTime, 0.01); // meter only
      await this.setMicSink('');
    }
  }

  resume() {
    this.mon.resume().catch(() => {});
    this.mic.resume().catch(() => {});
  }

  /* ---------- routing ---------- */

  async setMonitorSink(deviceId) {
    try {
      await this.mon.setSinkId(deviceId || '');
      return true;
    } catch (e) {
      console.warn('monitor sink', e);
      try { await this.mon.setSinkId(''); } catch { /* noop */ }
      return false;
    }
  }

  async setMicSink(deviceId) {
    try {
      await this.mic.setSinkId(deviceId ? deviceId : { type: 'none' });
      return true;
    } catch (e) {
      console.warn('mic sink', e);
      try { await this.mic.setSinkId({ type: 'none' }); } catch { /* noop */ }
      return false;
    }
  }

  async setMicInput(deviceId, enabled, { noiseSuppression = false } = {}) {
    if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
    if (this.micSrc) { try { this.micSrc.disconnect(); } catch { /* noop */ } }
    this.micStream = null;
    this.micSrc = null;
    if (!enabled) return true;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: !!noiseSuppression,
          channelCount: { ideal: 2 },
          sampleRate: 48000,
          latency: 0
        }
      });
      this.micSrc = this.mic.createMediaStreamSource(this.micStream);
      this.micSrc.connect(this.voiceGain);
      return true;
    } catch (e) {
      console.warn('mic input', e);
      return false;
    }
  }

  setVolumes({ monitor, micOut, voice }) {
    const t = this.mon.currentTime;
    if (monitor != null) this.monMaster.gain.setTargetAtTime(monitor, t, 0.01);
    if (micOut != null) this.micMaster.gain.setTargetAtTime(micOut, this.mic.currentTime, 0.01);
    if (voice != null && !this.direct) this.voiceGain.gain.setTargetAtTime(voice, this.mic.currentTime, 0.01);
  }

  setSoundsToMic(on) { this.soundsGate.gain.setTargetAtTime(on ? 1 : 0, this.mic.currentTime, 0.01); }
  setLimiter(on) { if (on !== this.limiterOn) { this.limiterOn = on; this._wireLimiter(); } }
  setDuck(enabled, level) { this.duckEnabled = enabled; this.duckLevel = level; this.updateDuck(); }
  isDucking() { return this.duckEnabled && this.micVoiceCount() > 0; }
  updateDuck() {
    this.duck.gain.setTargetAtTime(this.isDucking() ? this.duckLevel : 1, this.mic.currentTime, 0.06);
  }

  /* ---------- buffers ---------- */

  /**
   * Decoded audio is big (48 kHz stereo float = ~23 MB per minute), so the cache has a byte
   * budget and drops the least-recently-used sounds first. Sounds that are playing, plus any
   * file in `pinned` (hotkeys / favorites), are never dropped.
   */
  static bytesOf(buf) { return buf.length * buf.numberOfChannels * 4; }

  async getBuffer(file) {
    if (this.cache.has(file)) {
      const buf = this.cache.get(file);
      this.cache.delete(file); // move to the "recently used" end
      this.cache.set(file, buf);
      return buf;
    }
    if (this.loading.has(file)) return this.loading.get(file);
    const p = (async () => {
      let u8 = await window.api.readSound(file);
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      u8 = null;
      const buf = await this.mon.decodeAudioData(ab);
      this.cache.set(file, buf);
      this.cacheBytes += AudioEngine.bytesOf(buf);
      this._evict(file);
      return buf;
    })();
    this.loading.set(file, p);
    try { return await p; } finally { this.loading.delete(file); }
  }

  isCached(file) { return this.cache.has(file); }

  _evict(keep) {
    if (this.cacheBytes <= this.cacheLimit) return;
    const playing = new Set([...this.voices.values()].map((v) => v.file));
    for (const [file, buf] of this.cache) {
      if (this.cacheBytes <= this.cacheLimit) break;
      if (file === keep || playing.has(file) || this.pinned.has(file)) continue;
      this.cache.delete(file);
      this.cacheBytes -= AudioEngine.bytesOf(buf);
    }
  }

  setCacheLimit(bytes) { this.cacheLimit = bytes; this._evict(null); }

  forget(file) {
    const buf = this.cache.get(file);
    if (buf) this.cacheBytes -= AudioEngine.bytesOf(buf);
    this.cache.delete(file);
  }

  /** Waveform peaks (0..1) + RMS for normalisation. */
  static analyse(buf, buckets = 96) {
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const len = buf.length;
    const peaks = new Array(buckets).fill(0);
    const per = Math.max(1, Math.floor(len / buckets));
    const step = Math.max(1, Math.floor(per / 400));
    let sum = 0;
    let n = 0;
    for (let b = 0; b < buckets; b++) {
      let mx = 0;
      const end = Math.min(len, (b + 1) * per);
      for (let i = b * per; i < end; i += step) {
        for (const ch of chans) {
          const v = Math.abs(ch[i]);
          if (v > mx) mx = v;
          sum += v * v;
          n++;
        }
      }
      peaks[b] = Math.round(Math.min(1, mx) * 1000) / 1000;
    }
    return { peaks, rms: n ? Math.sqrt(sum / n) : 0, duration: buf.duration };
  }

  /* ---------- playback ---------- */

  static normGain(rms) {
    if (!rms) return 1;
    return Math.min(4, Math.max(0.2, 0.16 / rms)); // target ≈ -16 dBFS RMS
  }

  async play(sound, { delay = 0, monitorOnly = false } = {}) {
    const buf = await this.getBuffer(sound.file);
    const dur = buf.duration;
    const ts = Math.min(Math.max(0, sound.trimStart || 0), Math.max(0, dur - 0.01));
    const te = sound.trimEnd != null ? Math.min(dur, Math.max(ts + 0.01, sound.trimEnd)) : dur;
    const rate = sound.speed || 1;
    const vol = (sound.volume ?? 1) * (sound.normalize ? AudioEngine.normGain(sound.rms) : 1);

    const id = this.nextId++;
    const voice = {
      id,
      soundId: sound.id,
      file: sound.file,
      name: sound.name,
      nodes: [],
      ended: 0,
      startPerf: performance.now() + delay * 1000,
      length: (te - ts) / rate,
      loop: !!sound.loop,
      toMic: !monitorOnly
    };
    const targets = [[this.mon, this.monBus]];
    if (!monitorOnly) targets.push([this.mic, this.micBus]);

    for (const [ctx, bus] of targets) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g).connect(bus);
      const when = ctx.currentTime + delay;
      if (voice.loop) {
        src.loop = true;
        src.loopStart = ts;
        src.loopEnd = te;
        src.start(when, ts);
      } else {
        src.start(when, ts, te - ts);
      }
      src.onended = () => {
        voice.ended++;
        if (voice.ended >= voice.nodes.length) this._remove(id);
      };
      voice.nodes.push({ ctx, src, g });
    }
    this.voices.set(id, voice);
    this.onChange();
    return voice;
  }

  setVoiceVolume(soundId, vol) {
    for (const v of this.voices.values()) {
      if (v.soundId !== soundId) continue;
      for (const n of v.nodes) n.g.gain.setTargetAtTime(vol, n.ctx.currentTime, 0.02);
    }
  }

  stop(id, fade = 0.03) {
    const v = this.voices.get(id);
    if (!v || v.stopping) return;
    v.stopping = true;
    for (const { ctx, src, g } of v.nodes) {
      const t = ctx.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + fade);
        src.stop(t + fade + 0.005);
      } catch {
        try { src.stop(); } catch { /* already stopped */ }
      }
    }
    // Make sure it disappears even if onended never fires (e.g. not yet started).
    setTimeout(() => this._remove(id), (fade + 0.1) * 1000);
  }

  stopSound(soundId) { for (const v of [...this.voices.values()]) if (v.soundId === soundId) this.stop(v.id); }
  stopAll() { for (const id of [...this.voices.keys()]) this.stop(id); }
  voicesFor(soundId) { return [...this.voices.values()].filter((v) => v.soundId === soundId && !v.stopping); }
  micVoiceCount() { let n = 0; for (const v of this.voices.values()) if (v.toMic && !v.stopping) n++; return n; }

  _remove(id) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    for (const { src, g } of v.nodes) {
      try { src.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    }
    this.onChange();
  }

  progress(v) {
    const el = (performance.now() - v.startPerf) / 1000;
    if (el <= 0 || !v.length) return 0;
    return v.loop ? (el % v.length) / v.length : Math.min(1, el / v.length);
  }

  level(analyser) {
    analyser.getFloatTimeDomainData(this._buf);
    let p = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const a = Math.abs(this._buf[i]);
      if (a > p) p = a;
    }
    return p;
  }
}
