# EZ Soundboard

A modern Windows soundboard that plays sounds **through your microphone**, with a fresh UI.

![main](docs/screenshot-main.png)

## Features
- **Plays straight into your real mic**: nothing else to install. Your voice keeps working in every game and in Discord. A VB-CABLE mode is still available as a fallback.
- **Voice control**: mute, boost or duck your real voice while sounds play (set the duck level to 0% to block your voice, like Soundpad's "Block voice").
- **Auto push-to-talk**: holds your in-game voice key (keyboard or Mouse 4/5) while a sound plays, with adjustable pre-press and release timing.
- **Global hotkeys that pass through to the game**: the keys still reach the game, and Mouse 4/5 can be bound. This uses `uiohook-napi`, and the app falls back to Electron's built-in shortcuts if that isn't available.
- **Per-sound settings**: trim with draggable handles on the waveform, volume up to 300%, speed/pitch, loop, loudness normalization, color and board.
- **Play modes**: Overlap, Restart, Toggle (press again to stop) and Solo.
- **Limiter** on the mic output, so loud sounds don't clip into distortion.
- **Boards (categories)**: drag pads onto a board in the sidebar to move them. There are also Favorites, a Recent list, search, sorting and three pad sizes.
- **Live view**: progress on every playing pad, a now-playing bar, and level meters for what you hear, what others hear, and your voice.
- **Import**: drag and drop files or whole folders. Supported formats: mp3, wav, ogg, flac, m4a, aac, opus and webm.
- **Background mode**: the app keeps running in the system tray. Hotkeys work while it's hidden, and Shift+click previews a sound so only you hear it.
- **Auto-detects VB-CABLE** on first launch and shows a setup guide if it isn't installed.

## How sounds reach your mic (no VB-CABLE)
EZ Soundboard installs a small audio plugin (a Windows **APO**, the same technique Soundpad uses) into your real microphone. Windows runs it inside its own audio engine and it adds EZ Soundboard's sounds on top of your voice. Every app that records that mic hears your voice **and** the sounds: CS2, Discord, OBS, anything. You don't change any game settings.

It improves on Soundpad in two ways:
- **Overlapping sounds work.** EZ Soundboard mixes the sounds itself, then streams the finished mix to the plugin.
- **Several voice apps at once work.** Each app recording the mic (for example CS2 and Discord) gets its own full copy of the sounds.

## For players: install
1. Run `EZ-Soundboard-Setup-x.y.z.exe`.
2. Click **Yes** on the single Windows permission prompt.

That's it. The installer turns EZ Soundboard on for your default microphone. To use other mics, go to Settings → Microphone, tick them and click **Apply**. If you later change your default mic, the app offers to enable the new one when it starts. Uninstalling restores your mics exactly as they were.

**Discord:** if sounds get cut off, turn off Krisp / noise suppression in Voice & Video.

## For you: building the installer
Option A (easiest): push the repo to GitHub. The included workflow (`.github/workflows/build.yml`) builds everything on GitHub's Windows machines. Download the installer from the run's **Artifacts**.

Option B (on your PC):
1. Install **Node.js 20+** and **Visual Studio 2022 Build Tools** with the *Desktop development with C++* workload (includes CMake and the Windows SDK).
2. Run:
   ```
   npm install
   npm run dist        # builds the C++ plugin, then the installer in dist/
   ```
3. For development: run `npm run build:native` once, then `npm start`. Enable your mic in Settings → Microphone.

### Native parts (`native/`)
| File | Does |
|---|---|
| `EZSoundboardApo.dll` | The mic plugin. Passes your voice through and adds the sound mix from shared memory. |
| `ezsb-bridge.exe` | Started by the app. Streams the app's sound mix into shared memory. |
| `ezsb-mic-setup.exe` | Enables or disables the plugin on mics (`list`, `install default`, `uninstall all`). It backs up the original mic settings first and restarts Windows Audio. Logs: `%ProgramData%\EZSoundboard\` (setup.log, apo.log, bridge.log) |

### Troubleshooting direct mode
- **Settings → Microphone shows "Ready" but never "Good":** no app is recording that mic. Open Discord's mic test, or check that the right mic is the Windows default.
- **A specific mic driver ignores the plugin:** run `ezsb-mic-setup.exe install <guid> --sfx` (stream slot) or `--legacy` (older slot) as admin, or switch that PC to **Virtual cable** mode in Settings.
- **Mic has no sound at all after enabling:** run `ezsb-mic-setup.exe uninstall all` as admin (or uninstall the app). Every change is reversible from the backup.
- **Windows warns about the installer:** the installer isn't code-signed yet, so Windows SmartScreen shows a warning. Before releasing publicly, sign it with a code-signing certificate.

## Starter sounds (pre-installed)
Put audio files in `assets/starter-sounds/`. Each subfolder becomes a board (`Memes/`, `Callouts/`, `Music/`...). They ship inside the installer and are added to every new user's library on first launch, and users can re-add them from **Add sounds → Add starter sounds**. Only ship sounds you have the rights to distribute.

## Push-to-talk games
Go to Settings → Push-to-talk, turn it on and bind the same key you use for voice in the game (for example `V` or `Mouse 4`). If the start of sounds gets cut off, raise **Press before sound** to 120–150 ms.

## Notes
- `uiohook-napi` makes hotkeys work without blocking the key in your game. If it fails to install, the app falls back to Electron's built-in shortcuts, which take the key away from the game.
- The sound library is stored in `%APPDATA%/EZ Soundboard/`.
- Some anti-cheat systems (FACEIT, Vanguard) may ignore the key presses that auto push-to-talk sends. Sounds still go into the mic.

## Project layout
```
src/main/main.js       window, tray, library storage, file import
src/main/hotkeys.js    global hotkeys (uiohook pass-through / globalShortcut fallback)
src/main/ptt.js        auto push-to-talk (keybd_event / mouse_event via a PowerShell helper)
src/main/apo.js        direct-to-mic: runs the setup tool (elevated) and the audio bridge
native/                C++ mic plugin, bridge and setup tool (CMake)
build/installer.nsh    one-click installer hooks (enable on install, restore on uninstall)
src/main/preload.js    safe IPC bridge
src/renderer/js/audio.js  dual-output audio engine (headphones + virtual mic, passthrough, limiter, ducking)
src/renderer/js/app.js    UI
src/renderer/styles.css   look & feel
```
