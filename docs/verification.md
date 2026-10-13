# Verification and remaining hardware acceptance

The user story crosses renderer editing → validated preload IPC → single-writer configuration → independent workflow utility process → action adapter → run updates and deck feedback. CI verifies this story using the packaged Electron application and a simulated XL, including operation while the window is hidden.

| Boundary           | Automated evidence                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and settings    | 32-key preview, persisted key labels and custom accent after reload, workflow canvas, run traces, folder navigation                                                                                                  |
| Runner supervision | Real utility-process termination marks its run interrupted; a replacement runner accepts a new clipboard action                                                                                                      |
| Key assets         | Hash-addressed PNG renders in the sandbox and survives export/import                                                                                                                                                 |
| IPC isolation      | Sandboxed renderer has a narrow preload API and no Node `require`                                                                                                                                                    |
| Configuration      | Schema and semantic graph validation, atomic writes, rolling backup, invalid-version/malformed-JSON backups, damaged-history recovery, interrupted history, disabled imported bindings                               |
| Runtime            | Sequence, exclusive branch/switch, nested explicit joins, skipped paths, isolated iterations, bounded loops, immutable subflows, failures/recovery, retries, run/node timeout, cancellation, repeated-press policies |
| Adapters           | HTTP structured response, response-size cap and cancellation; POSIX shell-grandchild cancellation; external-state feedback mapping                                                                                   |
| Device mechanics   | Captured down/up bindings, long/short resolution, disconnect clearing, image coalescing, globally serialized resources                                                                                               |
| Distribution       | `.deb` and AppImage build; native HID and sharp loaded using Electron's embedded runtime, including ASAR package; packaged interaction tests                                                                         |

The headless tests disable Chromium's process sandbox in their launcher for container compatibility. Production code does not disable it. The preload remains CommonJS because sandboxed Electron renderers cannot execute an ESM preload. Production CSP excludes inline scripts; development adds the inline permission required by Vite's React refresh preamble.

## Manual acceptance on target machines

These gates cannot be completed without the hardware, desktop session and configured external services. They are recorded as unverified, not as passed.

1. On Pop!_OS/X11, install a generated package as the desktop user. Ensure the upstream udev rule permits opening the XL without root. Read physical down/up, write all 32 key images and measure page-refresh throughput. Confirm that native modules load in the installed package.
2. Unplug/replug and suspend/resume. Verify brightness/current-page restoration, stable serial identity, cleared held state, no replayed presses, and no missed releases during sustained input. Test another deck model before advertising it as verified.
3. Configure commands, URLs, shortcuts, MPRIS, audio and OBS with real targets. Change microphone mute and OBS scenes externally and verify observed key feedback. Stop the audio player/service and OBS server; errors must be visible and recovery should work after reconnection.
4. Close the editor during a run; input and runtime must continue. Reopen through the tray. Kill the runner; active runs must become interrupted and the replacement runner must accept new presses. Quit during a shell command and confirm process-tree cleanup.
5. On a selected Wayland desktop, check UI, HID, media, audio and OBS. Confirm keyboard injection remains reported unavailable. No claim of universal Wayland automation is made.
6. Measure input-to-dispatch p95 against the proposed 50 ms target and external action latency separately. These are acceptance measurements, not currently verified performance claims.

There is no license declaration yet: the product plan left distribution/license intent undecided. Packaging is implemented for review and testing; choosing a distribution license remains a repository-owner decision.
