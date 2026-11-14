// Shared-memory contract between the Mishez Pad app (via mishez-bridge.exe) and the
// MishezPadApo.dll plugin that Windows loads into the microphone's audio pipeline.
//
// The app writes its finished sound mix (48 kHz, stereo, float) into a ring buffer as a
// timeline: writePos only ever grows. Every plugin instance (one per app recording the mic,
// e.g. CS2 + Discord at the same time) keeps its OWN read cursor, so every app gets the full
// sound - unlike Soundpad, overlapping sounds and multiple voice apps are no problem.
#pragma once
#include <windows.h>
#include <stdint.h>
#include <string.h>

#define MP_MAP_NAME      L"Global\\MishezPadMicMix_v1"
#define MP_MAGIC         0x4D504144u   // 'MPAD'
#define MP_VERSION       1u
#define MP_RATE          48000
#define MP_RING_FRAMES   (MP_RATE * 2)  // 2 seconds of stereo audio

// {6EDE81E0-9BA8-41F6-A8BD-6E21436D8999}
static const GUID CLSID_MishezPadApo =
    { 0x6ede81e0, 0x9ba8, 0x41f6, { 0xa8, 0xbd, 0x6e, 0x21, 0x43, 0x6d, 0x89, 0x99 } };
#define MP_CLSID_STR L"{6EDE81E0-9BA8-41F6-A8BD-6E21436D8999}"

#pragma pack(push, 8)
struct MPShared {
    uint32_t magic;
    uint32_t version;
    volatile LONG64 writePos;      // absolute frames written by the app (monotonic)
    volatile LONG64 writerTick;    // GetTickCount64() of the app's last write
    volatile LONG64 apoTick;       // GetTickCount64() of the plugin's last process call
    volatile LONG   voiceGainBits; // float bits: gain applied to the real mic (1 = normal)
    volatile LONG   apoRate;       // info: sample rate the mic runs at
    volatile LONG   apoChannels;   // info: mic channel count
    volatile LONG   apoInstances;  // info: plugin instances currently processing
    uint32_t reserved[16];
    float ring[MP_RING_FRAMES * 2];
};
#pragma pack(pop)

static inline LONG64 mpLoad64(volatile LONG64* p) { return InterlockedCompareExchange64(p, 0, 0); }
static inline float mpBitsToFloat(LONG b) { float f; memcpy(&f, &b, 4); return f; }
static inline LONG mpFloatToBits(float f) { LONG b; memcpy(&b, &f, 4); return b; }
