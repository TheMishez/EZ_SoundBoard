#!/usr/bin/env python3
"""
Generates Mishez Pad's starter pack: original, synthesized versions of classic meme / gaming
sound effects. Every sound is made from scratch here (no samples), so EZGGco owns them and
can ship them freely.

Usage:  python tools/make_starter_sounds.py   (needs numpy, scipy and ffmpeg on PATH)
Output: assets/starter-sounds/<Board>/<Name>.mp3
"""
import os
import subprocess
import tempfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'starter-sounds')
rng = np.random.default_rng(7)


# ---------------------------------------------------------------- building blocks
def t_(dur):
    return np.arange(int(dur * SR)) / SR


def env(n, a=0.005, d=0.1, s=0.7, r=0.2, total=None):
    """ADSR envelope of length n samples (times in seconds)."""
    a, d, r = int(a * SR), int(d * SR), int(r * SR)
    sus = max(0, n - a - d - r)
    e = np.concatenate([
        np.linspace(0, 1, max(a, 1)),
        np.linspace(1, s, max(d, 1)),
        np.full(sus, s),
        np.linspace(s, 0, max(r, 1)),
    ])
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def expdecay(n, tau):
    return np.exp(-np.arange(n) / (tau * SR))


def lp(x, f, order=4):
    return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)


def hp(x, f, order=4):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi, order=4):
    return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)


def saw(freq_t):
    ph = np.cumsum(freq_t) / SR
    return 2 * (ph % 1.0) - 1


def square(freq_t, duty=0.5):
    ph = np.cumsum(freq_t) / SR
    return np.where((ph % 1.0) < duty, 1.0, -1.0)


def sine(freq_t):
    return np.sin(2 * np.pi * np.cumsum(freq_t) / SR)


def noise(n):
    return rng.standard_normal(n)


def const(f, n):
    return np.full(n, float(f))


def reverb(x, size=1.2, mix=0.25, damp=6000):
    x = np.array(x, dtype=np.float64)
    f = min(len(x), int(0.03 * SR))
    x[-f:] *= np.linspace(1, 0, f)  # no click where the dry signal ends
    n = int(size * SR)
    ir = noise(n) * expdecay(n, size / 5)
    ir = lp(ir, damp, 2)
    ir /= np.max(np.abs(ir)) + 1e-9
    dry = np.pad(x, (0, n))
    wet = fftconvolve(x, ir)[: len(dry)]
    wet = np.pad(wet, (0, len(dry) - len(wet)))
    wet /= np.max(np.abs(wet)) + 1e-9
    return dry * (1 - mix) + wet * mix * np.max(np.abs(x))


def soft_clip(x, drive=1.5):
    return np.tanh(x * drive) / np.tanh(drive)


def place(dst, src, at):
    i = int(at * SR)
    end = min(len(dst), i + len(src))
    dst[i:end] += src[: end - i]
    return dst


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def stereo(x, width=0.003):
    """Tiny Haas widening so mono synths feel big in headphones."""
    d = int(width * SR)
    left = x
    right = np.pad(x, (d, 0))[: len(x)]
    return np.stack([left, right], axis=1)


def save(board, name, x, width=0.0):
    x = np.asarray(x, dtype=np.float64)
    x = x - np.mean(x)
    if x.ndim == 1:
        x = stereo(x, width) if width else np.stack([x, x], axis=1)
    peak = np.max(np.abs(x)) + 1e-9
    x = x / peak * 0.89  # -1 dBFS
    # trim the silent end of reverb tails (below -55 dB), keep 50 ms after
    loud = np.where(np.max(np.abs(x), axis=1) > 10 ** (-55 / 20))[0]
    if len(loud):
        x = x[: min(len(x), loud[-1] + int(0.05 * SR))]
    assert np.all(np.isfinite(x)), name
    # 5 ms fade in / 20 ms fade out to avoid clicks
    fi, fo = int(0.005 * SR), int(0.02 * SR)
    x[:fi] *= np.linspace(0, 1, fi)[:, None]
    x[-fo:] *= np.linspace(1, 0, fo)[:, None]
    folder = os.path.join(OUT, board)
    os.makedirs(folder, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        wavfile.write(tmp.name, SR, (x * 32767).astype(np.int16))
        dst = os.path.join(folder, name + '.mp3')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp.name,
                        '-codec:a', 'libmp3lame', '-b:a', '192k', dst], check=True)
    os.unlink(tmp.name)
    print(f'{board}/{name}.mp3  {len(x) / SR:.1f}s')


# ---------------------------------------------------------------- sounds
def deep_boom():
    n = int(2.2 * SR)
    f = 38 + 150 * np.exp(-t_(2.2) / 0.06)
    body = sine(f) * expdecay(n, 0.45)
    sub = sine(const(32, n)) * expdecay(n, 0.7) * 0.6
    click = hp(noise(n), 2000) * expdecay(n, 0.006) * 0.6
    x = soft_clip(body + sub + click, 2.5)
    return reverb(x, 1.8, 0.35, 3000)


def air_horn():
    total = np.zeros(int(2.4 * SR))
    for at, dur in [(0, 0.28), (0.36, 0.28), (0.72, 1.3)]:
        n = int(dur * SR)
        vib = 1 + 0.006 * np.sin(2 * np.pi * 6 * t_(dur))
        chord = sum(saw(const(f, n) * vib) for f in (466.16, 587.33, 698.46, 932.33))
        chord = bp(chord, 400, 4500)
        total = place(total, soft_clip(chord * env(n, 0.01, 0.05, 0.9, 0.06), 3), at)
    return reverb(total, 0.9, 0.2)


def sad_trombone():
    notes = [(midi(58), 0.45), (midi(57), 0.45), (midi(56), 0.45), (midi(55), 1.5)]
    out = np.zeros(int(3.3 * SR))
    at = 0
    for i, (f, d) in enumerate(notes):
        n = int(d * SR)
        wob = 1 + (0.03 * np.sin(2 * np.pi * 5.5 * t_(d)) if i == 3 else 0.004 * np.sin(2 * np.pi * 5 * t_(d)))
        bend = 1 - (0.02 * t_(d) / d if i == 3 else 0)
        tone = saw(const(f, n) * wob * bend) * 0.7 + square(const(f, n) * wob * bend) * 0.3
        # "wah": sweep the filter open then closed
        tone = lp(tone, 1200 + 800 * np.sin(np.pi * np.minimum(t_(d) / 0.25, 1)).mean())
        out = place(out, tone * env(n, 0.03, 0.1, 0.8, 0.15 if i < 3 else 0.6), at)
        at += d
    return reverb(lp(out, 2500), 1.0, 0.2)


def bonk():
    n = int(0.6 * SR)
    f = 520 * (1 + 0.8 * np.exp(-t_(0.6) / 0.01))
    knock = sine(f) * expdecay(n, 0.06) + sine(f * 2.7) * expdecay(n, 0.02) * 0.4
    thump = sine(const(95, n)) * expdecay(n, 0.08)
    click = bp(noise(n), 1500, 6000) * expdecay(n, 0.004)
    return reverb(soft_clip(knock + thump + click * 0.8, 1.8), 0.4, 0.15)


def record_scratch():
    n = int(0.9 * SR)
    t = t_(0.9)
    x = noise(n)
    out = np.zeros(n)
    # back-and-forth scratch: band center moves fast
    center = 900 + 700 * np.sin(2 * np.pi * 3.2 * t)
    for i in range(0, n, 480):
        seg = x[i:i + 480]
        c = center[min(i, n - 1)]
        out[i:i + len(seg)] = bp(seg, max(c * 0.6, 100), c * 1.6, 2)
    out *= (0.5 + 0.5 * np.abs(np.sin(2 * np.pi * 3.2 * t))) * env(n, 0.005, 0.1, 0.9, 0.2)
    return soft_clip(out * 2, 2)


def crickets():
    dur = 4.0
    out = np.zeros(int(dur * SR))
    for k in range(3):
        f = 4300 + k * 260
        at = 0.1 + k * 0.17
        while at < dur - 0.3:
            for p in range(3):
                n = int(0.018 * SR)
                chirp = sine(const(f, n)) * np.hanning(n)
                place(out, chirp * (0.6 - 0.15 * k), at + p * 0.03)
            at += 0.55 + rng.uniform(-0.05, 0.08)
    amb = lp(noise(len(out)), 500) * 0.01
    return reverb(out + amb, 1.5, 0.3)


def fail_buzzer():
    n = int(1.1 * SR)
    x = square(const(98, n)) + square(const(103.5, n)) * 0.8 + saw(const(196, n)) * 0.3
    return soft_clip(lp(x, 2200) * env(n, 0.005, 0.05, 0.9, 0.08), 2)


def correct_ding():
    n = int(2.0 * SR)
    out = np.zeros(n)
    for ratio, amp, tau in [(1, 1, 0.9), (2.76, 0.5, 0.4), (5.4, 0.25, 0.2), (8.93, 0.12, 0.1)]:
        out += sine(const(1318.5 * ratio, n)) * amp * expdecay(n, tau)
    out2 = np.zeros(n)
    for ratio, amp, tau in [(1, 1, 0.9), (2.76, 0.5, 0.4), (5.4, 0.25, 0.2)]:
        out2 += sine(const(1760 * ratio, n)) * amp * expdecay(n, tau)
    full = np.zeros(int(2.3 * SR))
    place(full, out, 0)
    place(full, out2, 0.12)
    return reverb(full, 1.2, 0.25)


def drum_hit(n, f0=180, tau=0.12, snap=0.5):
    f = f0 * (1 + 1.5 * np.exp(-t_(n / SR) / 0.015))
    return sine(f) * expdecay(n, tau) + bp(noise(n), 1500, 8000) * expdecay(n, 0.05) * snap


def cymbal(n, tau=0.5):
    x = hp(noise(n), 5000)
    for f in (3150, 4870, 6230, 7710):
        x += square(const(f, n)) * 0.08
    return hp(x, 4000) * expdecay(n, tau)


def rimshot():
    out = np.zeros(int(2.0 * SR))
    place(out, drum_hit(int(0.3 * SR), 210, 0.08, 0.7), 0.0)
    place(out, drum_hit(int(0.3 * SR), 150, 0.12, 0.3), 0.18)
    place(out, drum_hit(int(0.3 * SR), 230, 0.06, 0.9) * 0.9 + 0, 0.45)
    place(out, cymbal(int(1.4 * SR), 0.45) * 0.7, 0.45)
    return reverb(out, 0.8, 0.15)


def brass_chord(notes, dur):
    n = int(dur * SR)
    x = sum(saw(const(midi(m), n) * (1 + 0.003 * np.sin(2 * np.pi * 5 * t_(dur) + i))) for i, m in enumerate(notes))
    x = lp(x, 1800) * env(n, 0.03, 0.15, 0.8, 0.3)
    return x


def dramatic_sting():
    out = np.zeros(int(4.0 * SR))
    place(out, brass_chord([38, 50, 53, 57], 0.35), 0.0)
    place(out, brass_chord([37, 49, 52, 56], 0.35), 0.45)
    place(out, brass_chord([36, 48, 51, 55, 60], 2.2), 0.9)
    place(out, drum_hit(int(1.5 * SR), 60, 0.6, 0.2) * 1.5, 0.9)
    return reverb(soft_clip(out, 1.3), 2.0, 0.35, 4000)


def drumroll():
    dur = 3.2
    out = np.zeros(int((dur + 2) * SR))
    t = 0.0
    while t < dur:
        amp = 0.25 + 0.75 * (t / dur) ** 1.5
        place(out, bp(noise(int(0.08 * SR)), 1200, 7000) * expdecay(int(0.08 * SR), 0.03) * amp
              + drum_hit(int(0.08 * SR), 220, 0.03, 0) * 0.3 * amp, t)
        t += 0.042 + rng.uniform(-0.004, 0.004)
    place(out, cymbal(int(2.0 * SR), 0.8) * 1.2 + 0, dur)
    place(out, drum_hit(int(0.6 * SR), 70, 0.25, 0.4) * 1.5, dur)
    return reverb(out, 1.2, 0.2)


def slide_whistle(up=True):
    dur = 1.0
    n = int(dur * SR)
    tt = t_(dur) / dur
    f = (700 + 1500 * tt) if up else (2200 - 1500 * tt)
    f = f * (1 + 0.01 * np.sin(2 * np.pi * 7 * t_(dur)))
    x = sine(f) + 0.15 * sine(f * 2) + lp(noise(n), 3000) * 0.04
    return reverb(x * env(n, 0.03, 0.05, 0.9, 0.12), 0.6, 0.2)


def boing():
    dur = 1.0
    n = int(dur * SR)
    t = t_(dur)
    f = 180 + 320 * np.exp(-t / 0.25) * (1 + 0.5 * np.sin(2 * np.pi * 14 * t) * np.exp(-t / 0.3))
    x = sine(f) * 0.8 + saw(f) * 0.2
    return lp(x, 2500) * expdecay(n, 0.35)


def laser():
    dur = 0.35
    n = int(dur * SR)
    f = 3200 * np.exp(-t_(dur) / 0.07) + 200
    return reverb(square(f, 0.3) * expdecay(n, 0.12) * 0.7 + sine(f) * expdecay(n, 0.12), 0.5, 0.2)


def whoosh():
    dur = 1.0
    n = int(dur * SR)
    x = noise(n)
    out = np.zeros(n)
    for i in range(0, n, 512):
        c = 300 + 3000 * np.sin(np.pi * i / n) ** 2
        seg = x[i:i + 512]
        out[i:i + len(seg)] = bp(seg, c * 0.5, c * 1.5, 2)
    return out * np.sin(np.pi * np.linspace(0, 1, n)) ** 2


def fanfare():
    seq = [(67, 0.14), (67, 0.14), (67, 0.14), (72, 0.6), (70, 0.2), (72, 0.2), (76, 1.1)]
    out = np.zeros(int(3.4 * SR))
    at = 0
    for m, d in seq:
        n = int(d * SR)
        tone = saw(const(midi(m), n)) * 0.6 + square(const(midi(m), n), 0.25) * 0.4
        tone = lp(tone, 3000) * env(n, 0.01, 0.06, 0.8, min(0.08, d / 3))
        place(out, tone, at)
        place(out, brass_chord([m - 12, m - 5], d) * 0.4, at)
        at += d
    return reverb(out, 1.4, 0.25)


def error_beeps():
    out = np.zeros(int(1.2 * SR))
    for k in range(3):
        n = int(0.16 * SR)
        place(out, square(const(880, n), 0.5) * env(n, 0.002, 0.01, 0.9, 0.01) * 0.6, k * 0.22)
    place(out, square(const(440, int(0.4 * SR))) * env(int(0.4 * SR), 0.002, 0.02, 0.9, 0.05) * 0.6, 0.7)
    return lp(out, 6000)


def applause():
    dur = 4.0
    out = np.zeros(int(dur * SR))
    for _ in range(900):
        at = rng.uniform(0, dur - 0.05)
        n = int(0.012 * SR)
        clap = bp(noise(n), 800, 5000, 2) * expdecay(n, 0.004)
        place(out, clap * rng.uniform(0.3, 1), at)
    shape = np.minimum(1, t_(dur) / 0.3) * np.minimum(1, (dur - t_(dur)) / 1.2)
    return reverb(out * shape, 1.5, 0.3)


def explosion():
    dur = 3.0
    n = int(dur * SR)
    rumble = lp(noise(n), 180, 2) * expdecay(n, 0.9) * 3
    blast = lp(noise(n), 2500, 2) * expdecay(n, 0.25)
    thump = sine(40 + 60 * np.exp(-t_(dur) / 0.1)) * expdecay(n, 0.4) * 1.5
    return reverb(soft_clip(rumble + blast + thump, 2.2), 2.0, 0.3, 2500)


def siren():
    dur = 3.0
    n = int(dur * SR)
    f = 700 + 500 * (0.5 + 0.5 * np.sin(2 * np.pi * 0.7 * t_(dur) - np.pi / 2))
    x = saw(f) * 0.5 + square(f, 0.5) * 0.3
    return reverb(lp(x, 3500) * env(n, 0.05, 0.1, 0.9, 0.3), 1.0, 0.2)


def countdown():
    out = np.zeros(int(4.2 * SR))
    for k in range(3):
        n = int(0.15 * SR)
        place(out, sine(const(880, n)) * env(n, 0.003, 0.02, 0.9, 0.05), k * 1.0)
    n = int(0.9 * SR)
    place(out, (sine(const(1760, n)) + 0.3 * sine(const(3520, n))) * env(n, 0.003, 0.05, 0.8, 0.4), 3.0)
    return reverb(out, 0.8, 0.15)


def headshot():
    n = int(1.4 * SR)
    ping = sum(sine(const(2093 * r, n)) * a * expdecay(n, tau) for r, a, tau in [(1, 1, 0.5), (2.4, 0.4, 0.2), (3.9, 0.2, 0.1)])
    hit = drum_hit(int(0.2 * SR), 300, 0.04, 0.8)
    out = np.zeros(int(1.6 * SR))
    place(out, hit, 0)
    place(out, ping, 0.01)
    return reverb(out, 0.9, 0.2)


def squeak():
    dur = 0.45
    n = int(dur * SR)
    f = 1400 + 900 * np.sin(np.pi * t_(dur) / dur)
    return lp(square(f, 0.35) * 0.5 + sine(f), 5000) * env(n, 0.01, 0.05, 0.9, 0.1)


# ---------------------------------------------------------------- music loops (original)
def keys(m, dur, vel=0.5):
    n = int(dur * SR)
    f = midi(m)
    x = sum(sine(const(f * k, n)) * a for k, a in [(1, 1), (2, 0.35), (3, 0.12), (4, 0.06)])
    x *= 1 + 0.1 * np.sin(2 * np.pi * 4.5 * t_(dur))
    return x * expdecay(n, 1.2) * env(n, 0.005, 0.2, 0.9, 0.1) * vel


def elevator_loop():
    bpm = 92
    beat = 60 / bpm
    prog = [[62, 65, 69, 72], [59, 62, 65, 69], [64, 67, 71, 74], [57, 61, 64, 67]]  # Dm9 G7 Cmaj7-ish A7
    bass = [38, 43, 36, 45]
    bars = 4 * 2
    out = np.zeros(int((bars * 4 * beat + 2) * SR))
    melody = [77, 76, 74, 72, 74, 76, 79, 77, 76, 74, 72, 71, 72, 74, 76, 72]
    for b in range(bars):
        chord = prog[b % 4]
        t0 = b * 4 * beat
        for k, m in enumerate(chord):
            place(out, keys(m, 3.6 * beat, 0.25), t0 + k * 0.012)
        for q in range(4):
            place(out, keys(bass[b % 4] + (7 if q % 2 else 0), beat * 0.9, 0.5) * 0.9, t0 + q * beat)
            place(out, cymbal(int(0.15 * SR), 0.05) * 0.06, t0 + q * beat + beat / 2)
        mb = melody[(b * 2) % 16], melody[(b * 2 + 1) % 16]
        place(out, keys(mb[0], 1.5 * beat, 0.35), t0 + beat * 0.5)
        place(out, keys(mb[1], 1.5 * beat, 0.3), t0 + beat * 2.5)
    return reverb(lp(out, 6000), 1.5, 0.25)


def chip(m, dur, duty=0.25):
    n = int(dur * SR)
    return square(const(midi(m), n), duty) * env(n, 0.002, 0.03, 0.7, 0.02)


def chiptune_victory():
    bpm = 150
    s = 60 / bpm / 2
    mel = [72, 76, 79, 84, 79, 76, 72, 76, 79, 83, 79, 74, 76, 79, 84, 88, 86, 84, 83, 84]
    out = np.zeros(int((len(mel) * s + 2) * SR))
    for i, m in enumerate(mel):
        place(out, chip(m, s * 0.9) * 0.5, i * s)
        if i % 2 == 0:
            place(out, chip(m - 24, s * 1.8, 0.5) * 0.35, i * s)
        if i % 4 == 0:
            place(out, bp(noise(int(0.05 * SR)), 2000, 9000) * expdecay(int(0.05 * SR), 0.01) * 0.3, i * s)
    place(out, chip(84, 1.2) * 0.5, len(mel) * s)
    return reverb(out, 0.6, 0.12)


def tension_loop():
    bpm = 120
    beat = 60 / bpm
    out = np.zeros(int((16 * beat + 1.5) * SR))
    for q in range(16):
        place(out, drum_hit(int(0.4 * SR), 55, 0.18, 0.1) * (1.2 if q % 4 == 0 else 0.7), q * beat)
        place(out, saw(const(midi(38), int(beat * 0.45 * SR))) * 0.25 * env(int(beat * 0.45 * SR), 0.005, 0.05, 0.7, 0.05), q * beat + beat / 2)
    n = int(16 * beat * SR)
    pad = sum(saw(const(midi(m), n)) for m in (50, 53, 57, 58))
    pad = lp(pad, 900) * np.linspace(0.2, 0.6, n) * 0.25
    place(out, pad, 0)
    return reverb(out, 1.8, 0.3, 4000)


def main():
    memes = {
        'Deep Boom': deep_boom, 'Air Horn': air_horn, 'Sad Trombone': sad_trombone, 'Bonk': bonk,
        'Record Scratch': record_scratch, 'Awkward Crickets': crickets, 'Fail Buzzer': fail_buzzer,
        'Correct Ding': correct_ding, 'Ba Dum Tss': rimshot, 'Dramatic Sting': dramatic_sting,
        'Drumroll': drumroll, 'Slide Whistle Up': lambda: slide_whistle(True),
        'Slide Whistle Down': lambda: slide_whistle(False), 'Boing': boing, 'Squeak': squeak,
        'Applause': applause, 'Error Beeps': error_beeps, 'Whoosh': whoosh,
    }
    game = {
        'Headshot Ping': headshot, 'Laser Pew': laser, 'Explosion': explosion, 'Alert Siren': siren,
        'Round Countdown': countdown, 'Victory Fanfare': fanfare,
    }
    music = {
        'Elevator Lounge (loop)': elevator_loop, 'Chiptune Victory': chiptune_victory,
        'Tension Build (loop)': tension_loop,
    }
    for board, sounds in (('Memes', memes), ('Game', game), ('Music', music)):
        for name, fn in sounds.items():
            save(board, name, fn(), width=0.004)


if __name__ == '__main__':
    main()
