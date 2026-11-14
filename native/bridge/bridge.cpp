// ezsb-bridge.exe - started by the EZ Soundboard app (no admin needed).
// Reads framed packets from stdin and writes the sound mix into the shared ring buffer
// that the microphone plugin (EZSoundboardApo.dll) reads from.
//
// stdin packet:  uint32 type, uint32 byteLength, payload
//   type 1 = PCM: float32 interleaved stereo @ 48 kHz
//   type 2 = voice gain: one float32 (1 = normal, 0 = mute your real mic)
// stdout: one JSON status line every 500 ms.

#include <windows.h>
#include <stdio.h>
#include <vector>
#include "../common/shared.h"

static HANDLE g_map = nullptr;
static MPShared* volatile g_sh = nullptr;
static volatile LONG g_voiceBits = 0;
static volatile LONG g_running = 1;
static volatile LONG64 g_framesIn = 0;

static HANDLE g_file = nullptr;
static DWORD g_openErr = 0;
static bool TryOpen() {
    if (g_sh) return true;
    HANDLE f = nullptr, m = nullptr;
    DWORD err = 0;
    MPShared* sh = mpOpenShared(&f, &m, &err);
    if (!sh) {
        if (err != g_openErr) mpLog(L"bridge", L"could not open shared buffer, error", (long long)err);
        g_openErr = err;
        return false;
    }
    g_file = f;
    g_map = m;
    g_sh = sh;
    if (g_voiceBits) InterlockedExchange(&sh->voiceGainBits, g_voiceBits);
    mpLog(L"bridge", L"shared buffer open", 0);
    return true;
}

// Keeps retrying to open the buffer in the background and prints status for the app.
static DWORD WINAPI StatusThread(LPVOID) {
    while (g_running) {
        TryOpen();
        MPShared* s = g_sh;
        long long apoAge = -1, loadAge = -1;
        long rate = 0, chans = 0, inst = 0, locks = 0, lastHr = 0;
        if (s && s->magic == MP_MAGIC) {
            const ULONGLONG now = GetTickCount64();
            const LONG64 t = mpLoad64(&s->apoTick);
            const LONG64 l = mpLoad64(&s->apoLoadTick);
            if (t > 0 && (ULONGLONG)t <= now) apoAge = (long long)(now - (ULONGLONG)t);
            if (l > 0 && (ULONGLONG)l <= now) loadAge = (long long)(now - (ULONGLONG)l);
            rate = s->apoRate;
            chans = s->apoChannels;
            inst = s->apoInstances;
            locks = s->apoLocks;
            lastHr = s->apoLastHr;
        }
        printf("{\"mapped\":%s,\"openErr\":%lu,\"apoAgeMs\":%lld,\"loadAgeMs\":%lld,\"rate\":%ld,\"channels\":%ld,"
               "\"instances\":%ld,\"locks\":%ld,\"lastHr\":%ld,\"framesIn\":%lld}\n",
               s ? "true" : "false", g_openErr, apoAge, loadAge, rate, chans, inst, locks, lastHr, (long long)g_framesIn);
        fflush(stdout);
        Sleep(500);
    }
    return 0;
}

static bool ReadExact(HANDLE h, void* buf, DWORD n) {
    BYTE* p = static_cast<BYTE*>(buf);
    while (n) {
        DWORD got = 0;
        if (!ReadFile(h, p, n, &got, nullptr) || got == 0) return false;
        p += got;
        n -= got;
    }
    return true;
}

static void WritePcm(const float* data, size_t frames) {
    MPShared* s = g_sh;
    InterlockedAdd64(&g_framesIn, (LONG64)frames);
    if (!s || s->magic != MP_MAGIC) return;
    LONG64 pos = mpLoad64(&s->writePos);
    for (size_t f = 0; f < frames; ++f) {
        const size_t i = (size_t)((pos + (LONG64)f) % MP_RING_FRAMES);
        s->ring[i * 2] = data[f * 2];
        s->ring[i * 2 + 1] = data[f * 2 + 1];
    }
    MemoryBarrier();
    InterlockedExchange64(&s->writePos, pos + (LONG64)frames);
    InterlockedExchange64(&s->writerTick, (LONG64)GetTickCount64());
}

int main() {
    g_voiceBits = mpFloatToBits(1.0f);
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE th = CreateThread(nullptr, 0, StatusThread, nullptr, 0, nullptr);
    std::vector<BYTE> buf;
    for (;;) {
        UINT32 hdr[2];
        if (!ReadExact(in, hdr, sizeof(hdr))) break;
        const UINT32 type = hdr[0], len = hdr[1];
        if (len > 8 * 1024 * 1024) break; // corrupt stream
        buf.resize(len ? len : 1);
        if (len && !ReadExact(in, buf.data(), len)) break;
        if (type == 1) {
            WritePcm(reinterpret_cast<const float*>(buf.data()), len / (sizeof(float) * 2));
        } else if (type == 2 && len >= 4) {
            float g;
            memcpy(&g, buf.data(), 4);
            if (!(g >= 0.0f && g <= 4.0f)) g = 1.0f;
            g_voiceBits = mpFloatToBits(g);
            if (g_sh) InterlockedExchange(&g_sh->voiceGainBits, g_voiceBits);
        }
    }
    // App closed: restore the real mic to normal immediately.
    if (g_sh) InterlockedExchange(&g_sh->voiceGainBits, mpFloatToBits(1.0f));
    InterlockedExchange(&g_running, 0);
    if (th) WaitForSingleObject(th, 1000);
    mpCloseShared(g_sh, g_file, g_map);
    return 0;
}
