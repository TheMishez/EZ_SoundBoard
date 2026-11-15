// ezsb-hotkeys.exe - EZ Soundboard's global hotkeys.
//
// Watches the keyboard (and the mouse side buttons, only when one is bound) with Windows low-level
// hooks, and tells the app when a bound key is pressed. Keys are never blocked: the game still gets
// every press.
//
// Built to stay out of the way of your game's input:
//  - No bindings → no hooks installed at all.
//  - The mouse hook is only installed while Mouse 4 / Mouse 5 is bound, and mouse movement is
//    passed straight on with a single comparison (it never leaves this process).
//  - The hook callbacks do a table lookup and return. Writing to the app happens on another
//    thread, so a busy app can never slow a key press down.
//  - The hook thread runs at high priority so Windows never waits on it under load.
//
// Talks to the app over stdin / stdout, one line per message:
//   in : "clear" | "bind <id> <vk> <ext> <mods> <mouse>" | "apply" | "quit"
//          ext:   0 = only non-extended, 1 = only extended, 2 = either (Enter vs Num Enter etc.)
//          mods:  bit 1 Ctrl, 2 Alt, 4 Shift, 8 Win - must match exactly
//          mouse: 0 = keyboard binding, 4 = Mouse 4 (back), 5 = Mouse 5 (forward)
//   out: "ready" | "hooks <keyboard 0/1> <mouse 0/1>" | "fire <id>"
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr UINT WM_APP_APPLY = WM_APP + 1;   // hook thread: lParam = Table* to switch to
constexpr UINT WM_APP_FIRE = WM_APP + 2;    // writer thread: wParam = binding id
constexpr UINT WM_APP_HOOKS = WM_APP + 3;   // writer thread: wParam = kb, lParam = mouse

struct Binding {
    int id;
    BYTE vk;
    BYTE ext;
    BYTE mods;
    BYTE mouse;
};

struct Table {
    std::vector<Binding> list;
    bool keyBound[256] = {};
    bool mouseBound = false;
    bool keyboardNeeded = false;
};

// Only touched on the hook thread.
Table* g_table = nullptr;
bool g_held[256] = {};
HHOOK g_kbHook = nullptr;
HHOOK g_mouseHook = nullptr;
DWORD g_hookTid = 0;
DWORD g_writerTid = 0;
HANDLE g_writerReady = nullptr;

BYTE CurrentMods() {
    BYTE m = 0;
    if (GetAsyncKeyState(VK_CONTROL) & 0x8000) m |= 1;
    if (GetAsyncKeyState(VK_MENU) & 0x8000) m |= 2;
    if (GetAsyncKeyState(VK_SHIFT) & 0x8000) m |= 4;
    if ((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) m |= 8;
    return m;
}

void Fire(int id) { PostThreadMessageW(g_writerTid, WM_APP_FIRE, (WPARAM)id, 0); }

LRESULT CALLBACK KeyboardProc(int code, WPARAM wParam, LPARAM lParam) {
    if (code == HC_ACTION && g_table) {
        const auto* k = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
        const BYTE vk = (BYTE)k->vkCode;
        if (g_table->keyBound[vk]) {   // everything else: straight through
            const bool down = wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN;
            if (!down) {
                g_held[vk] = false;
            } else if (!g_held[vk]) {   // ignore auto-repeat
                g_held[vk] = true;
                const BYTE ext = (k->flags & LLKHF_EXTENDED) ? 1 : 0;
                const BYTE mods = CurrentMods();
                for (const Binding& b : g_table->list) {
                    if (b.mouse || b.vk != vk) continue;
                    if (b.ext != 2 && b.ext != ext) continue;
                    if (b.mods != mods) continue;
                    Fire(b.id);
                }
            }
        }
    }
    return CallNextHookEx(nullptr, code, wParam, lParam);
}

LRESULT CALLBACK MouseProc(int code, WPARAM wParam, LPARAM lParam) {
    // Movement and every other button: one comparison and on to the game.
    if (code == HC_ACTION && wParam == WM_XBUTTONDOWN && g_table) {
        const auto* m = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
        const WORD xb = HIWORD(m->mouseData);
        const BYTE button = xb == XBUTTON1 ? 4 : xb == XBUTTON2 ? 5 : 0;
        if (button) {
            const BYTE mods = CurrentMods();
            for (const Binding& b : g_table->list) {
                if (b.mouse == button && b.mods == mods) Fire(b.id);
            }
        }
    }
    return CallNextHookEx(nullptr, code, wParam, lParam);
}

void ApplyTable(Table* t) {
    delete g_table;
    g_table = t;
    memset(g_held, 0, sizeof(g_held));
    const HINSTANCE inst = GetModuleHandleW(nullptr);

    if (t->keyboardNeeded && !g_kbHook) g_kbHook = SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardProc, inst, 0);
    if (!t->keyboardNeeded && g_kbHook) { UnhookWindowsHookEx(g_kbHook); g_kbHook = nullptr; }
    if (t->mouseBound && !g_mouseHook) g_mouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseProc, inst, 0);
    if (!t->mouseBound && g_mouseHook) { UnhookWindowsHookEx(g_mouseHook); g_mouseHook = nullptr; }

    PostThreadMessageW(g_writerTid, WM_APP_HOOKS, g_kbHook ? 1 : 0, g_mouseHook ? 1 : 0);
}

DWORD WINAPI WriterThread(LPVOID) {
    MSG msg;
    PeekMessageW(&msg, nullptr, 0, 0, PM_NOREMOVE);   // create the message queue
    SetEvent(g_writerReady);
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        if (msg.message == WM_APP_FIRE) printf("fire %d\n", (int)msg.wParam);
        else if (msg.message == WM_APP_HOOKS) printf("hooks %d %d\n", (int)msg.wParam, (int)msg.lParam);
        else continue;
        fflush(stdout);
    }
    return 0;
}

// Reads commands from the app. When the app closes (stdin ends), everything shuts down.
DWORD WINAPI InputThread(LPVOID) {
    Table* pending = new Table();
    char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        if (!strncmp(line, "clear", 5)) {
            delete pending;
            pending = new Table();
        } else if (!strncmp(line, "bind ", 5)) {
            int id = 0, vk = 0, ext = 2, mods = 0, mouse = 0;
            if (sscanf_s(line + 5, "%d %d %d %d %d", &id, &vk, &ext, &mods, &mouse) == 5 &&
                vk >= 0 && vk < 256 && ext >= 0 && ext <= 2 && mods >= 0 && mods <= 15 &&
                (mouse == 0 || mouse == 4 || mouse == 5) && pending->list.size() < 2000) {
                pending->list.push_back({ id, (BYTE)vk, (BYTE)ext, (BYTE)mods, (BYTE)mouse });
                if (mouse) pending->mouseBound = true;
                else { pending->keyBound[vk] = true; pending->keyboardNeeded = true; }
            }
        } else if (!strncmp(line, "apply", 5)) {
            Table* t = pending;
            pending = new Table();
            // The hook thread owns the table; if it's gone, just clean up.
            if (!PostThreadMessageW(g_hookTid, WM_APP_APPLY, 0, (LPARAM)t)) delete t;
        } else if (!strncmp(line, "quit", 4)) {
            break;
        }
    }
    delete pending;
    PostThreadMessageW(g_hookTid, WM_QUIT, 0, 0);
    return 0;
}

}  // namespace

int main() {
    setvbuf(stdout, nullptr, _IOFBF, 4096);
    g_hookTid = GetCurrentThreadId();
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);

    MSG msg;
    PeekMessageW(&msg, nullptr, 0, 0, PM_NOREMOVE);   // message queue for the hooks

    g_writerReady = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE writer = CreateThread(nullptr, 0, WriterThread, nullptr, 0, &g_writerTid);
    if (!writer) return 1;
    WaitForSingleObject(g_writerReady, 5000);

    printf("ready\n");
    fflush(stdout);

    HANDLE input = CreateThread(nullptr, 0, InputThread, nullptr, 0, nullptr);
    if (!input) return 1;

    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        if (msg.message == WM_APP_APPLY) ApplyTable(reinterpret_cast<Table*>(msg.lParam));
    }

    if (g_kbHook) UnhookWindowsHookEx(g_kbHook);
    if (g_mouseHook) UnhookWindowsHookEx(g_mouseHook);
    delete g_table;
    PostThreadMessageW(g_writerTid, WM_QUIT, 0, 0);
    WaitForSingleObject(writer, 1000);
    return 0;
}
