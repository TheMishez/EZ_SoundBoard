// mishez-bridge.exe - started by the Mishez Pad app (no admin needed).
// Reads framed packets from stdin and writes the sound mix into the shared ring buffer
// that the microphone plugin (MishezPadApo.dll) reads from.
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

static bool TryOpen() {
    if (g_sh) return true;
    HANDLE m = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, MP_MAP_NAME);
    if (!m) return false;
    auto* sh = static_cast<MPShared*>(MapViewOfFile(m, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(MPShared)));
    if (!sh) {
        CloseHandle(m);
        return false;
    }
    g_map = m;
    g_sh = sh;
    if (g_voiceBits) InterlockedExchange(&sh->voiceGainBits, g_voiceBits);
    return true;
}

// The mapping only exists once Windows has loaded the plugin (i.e. some app is using the mic),
// so keep retrying in the background. Also prints status for the app.
static DWORD WINAPI StatusThread(LPVOID) {
    while (g_running) {
        TryOpen();
        MPShared* s = g_sh;
        long long apoAge = -1;
        long rate = 0, chans = 0, inst = 0;
        if (s && s->magic == MP_MAGIC) {
            LONG64 t = mpLoad64(&s->apoTick);
            ULONGLONG now = GetTickCount64();
            if (t) apoAge = (long long)(now - (ULONGLONG)t);
            rate = s->apoRate;
            chans = s->apoChannels;
            inst = s->apoInstances;
        }
        printf("{\"mapped\":%s,\"apoAgeMs\":%lld,\"rate\":%ld,\"channels\":%ld,\"instances\":%ld,\"framesIn\":%lld}\n",
               s ? "true" : "false", apoAge, rate, chans, inst, (long long)g_framesIn);
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
    if (g_sh) UnmapViewOfFile(g_sh);
    if (g_map) CloseHandle(g_map);
    return 0;
}
