# Decker

A local Linux Stream Deck studio: configure keys, connect your desktop tools, and build visual workflows. The Discord-inspired interface has a configurable accent colour shared by navigation, controls, the deck editor and workflow canvas.

## Run

Requires Linux x64, Node.js 22+, and a desktop session. No hardware is needed to use the XL simulator.

```sh
npm ci
npm run dev
```

The initial profile includes a folder, clipboard, URL, microphone, media and OBS examples. Configure your actual applications and connections before testing actions. The simulator exercises the real runtime; configured commands and network actions execute on your computer.

- **Deck:** select a key, pick or drag an action, change its appearance and save. Add several actions for a sequence, or select a named workflow. Copy, paste, duplicate and clear keys. Add profiles, pages and nested folders. Test a saved binding with **Test key**, a double-click, or **Hold to simulate press / release**.
- **Flows:** add nodes, connect their output ports and configure their properties. Validation reports broken references, cycles, unsafe retries and malformed structured groups. Save before running. Select a node for input/output field bindings and custom ports.
- **Runs:** inspect statuses, node timing, redacted inputs/outputs, errors and revision numbers. Stop an active run without closing the editor.
- **Settings:** choose an accent, brightness, devices, credentials, OBS connections, startup preferences and history retention. Import/export includes key images. Imported bindings remain disabled until reviewed and enabled individually.

Closing the window hides it. The tray reopens it; **Quit Decker** cancels runs, releases devices and flushes storage. Login startup uses a per-user XDG desktop entry. Configuration lives in Electron's user-data directory, with atomic writes and a rolling backup. Unsupported or invalid documents receive a separate backup and a visible diagnostic. Active history records become interrupted after an unexpected shutdown; side effects are never replayed automatically.

## Linux integrations

| Integration                 | Requirement                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| USB deck                    | Desktop-user udev access; one controlling application per deck                 |
| Keyboard shortcuts / typing | X11 and `xdotool`; general Wayland injection is unsupported                    |
| Audio                       | A working PipeWire `wpctl` service, or PulseAudio-compatible `pactl`           |
| Media                       | A running MPRIS player, a session D-Bus, and GLib `gdbus`                      |
| Application launch          | Executable plus argument array, or `gtk-launch` desktop-entry ID               |
| OBS                         | OBS WebSocket 5 server enabled; add its URL and password reference in Settings |
| HTTP                        | HTTP(S) URL; optional bearer credential reference                              |

MPRIS uses the system GLib D-Bus client rather than adding an unmaintained Node D-Bus implementation. No `playerctl` is required. Audio state is polled and OBS state is subscribed to, so key feedback reflects the observed integration state. Unavailable services appear in diagnostics and action errors.

For USB setup, follow the library's [Linux instructions and desktop-user udev rule](https://github.com/Julusian/node-elgato-stream-deck/tree/main/packages/node#linux). Do not run Decker as root. Device identity uses the serial number; a HID path is only a temporary discovery handle. Reconnect restores brightness and the current page without replaying missed presses.

Credentials use Electron safeStorage only when an OS-backed backend is available. The insecure Linux `basic_text` fallback is rejected for persistence; use session-only storage instead. Store sensitive HTTP authentication with a credential reference rather than a literal header or URL. Export removes credentials, credential references on connections, and sensitive literal authentication fields. Imported shell commands should be read before their bindings are enabled.

## Workflows

See [workflow semantics and examples](docs/workflows.md). Direct keys and canvas actions use the same versioned registry, configuration validation and handlers. XState invoked promise actors own run lifecycle; a structured graph adapter defines the actual execution semantics.

## Build and verify

```sh
npm run check
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron scripts/native-smoke.cjs
npm run package
ELECTRON_RUN_AS_NODE=1 dist/linux-unpacked/decker scripts/native-smoke.cjs dist/linux-unpacked/resources/app.asar/package.json
DECKER_EXECUTABLE=./dist/linux-unpacked/decker xvfb-run -a npm run test:e2e
```

Outputs are `.deb` and AppImage packages in `dist/`. Native `node-hid` and `sharp` dependencies use their shipped Node-API binaries; ASAR unpacking and Electron-runtime loading are checked explicitly. `npmRebuild` is disabled because these dependencies do not require an Electron ABI rebuild.

CI checks types, deterministic runtime and integration fixtures, native modules, both Linux package targets and the packaged desktop app. Screenshots, traces and packages are uploaded as Actions artifacts. `--no-sandbox` is used only by the headless test launcher for container compatibility; the production renderer retains sandboxing, context isolation, strict CSP and a narrow preload API.

[Verification coverage and hardware acceptance](docs/verification.md) records the boundaries that require the real Pop!_OS/X11 machine and a selected Wayland desktop. Simulator and CI success do not establish HID permissions, physical latency, suspend behaviour or compositor compatibility.

The original product scope remains in [REQUIREMENTS.md](REQUIREMENTS.md). Marketplace plugin compatibility, cloud sync, arbitrary plugin loading and universal Wayland automation remain outside this release.
