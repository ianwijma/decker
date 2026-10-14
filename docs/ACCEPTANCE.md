# Acceptance coverage

`REQUIREMENTS.md` is the original product/architecture plan. Its physical acceptance gates cannot be established in a hardware-free cloud workspace. This implementation provides the complete local product surfaces and the software verification listed below; it does not claim physical hardware or desktop certification.

| Requirement area | Implementation | Automated evidence | Remaining host verification |
| --- | --- | --- | --- |
| Electron lifecycle and isolation | Main owns config and secrets; sandboxed preload; supervised device/runner utility processes; tray and single-instance app | Electron IPC boundary test; execute flow with editor closed | Pop!_OS tray extension behaviour; session logout |
| XL/device adapter | Library discovery/open, serial identity, discovered geometry, key down/up, brightness, cached RGB images, coalesced serialized writes, hotplug poll, resume refresh | Simulated press/hold/release tests; image renderer/native module tests; packaged device worker | Open XL without root, key image encoding, unplug/replug, suspend/resume, HID permissions |
| Useful deck | 32-key simulator; profiles/pages/folders; direct/workflow/multi-action bindings; label/image/background; copy/paste/duplicate/clear/test | Electron key editing and persistence test | Physical button action feedback and correct device geometry |
| Shared action catalog | Executable, explicit shell, URL/path, HTTP, notification/clipboard, keyboard, MPRIS, audio, OBS, deck and workflow controls | Action configuration validation; clipboard through real Electron; command/HTTP adapter tests | Actual keyboard focus; media players; audio target disappearance; OBS instance |
| Basic flows | React Flow canvas, shared action nodes, explicit edges, variable mapping, branches/switches/delay, validation, run inspector | Sequence/branch/data-reference/error-routing and editor tests | Real service latency |
| Advanced flows | Structured parallel with join; fail-fast/collect; bounded sequential/concurrent loops; pinned subflows; scope isolation; input/output declarations | Nested groups/skipped paths/iteration isolation/recursion/snapshot tests | Complex user-authored workflows on target machine |
| Execution policies | Ignore/queue/restart/concurrent; resource locks; retries; timeout/cancel; process-group cleanup; immutable revision snapshots | Focused runtime and command cleanup fixtures | Shell commands that intentionally daemonize/escape process groups cannot be undone |
| Persistence/import/export | Versioned JSON; serialized atomic writes; recovery/migration backups; content-hashed images; reviewed imports; credential references | Restart, interrupted-run, asset checksum and document validation tests | Existing OS keyring; data backup/restore on target machine |
| Credentials | safeStorage only with secure backend; session-only fallback; no secrets in renderer/export; bounded redacted history | Redaction and IPC tests | GNOME Keyring/KWallet integration |
| Design | Discord-inspired dark navigation/sidebar/editor/inspector; selectable preset/custom accent; consistent focus and active states | Electron accent persistence and UI screenshots | User preference and visual review on target display |
| Linux distribution | Locked dependencies; ABI-stable Node-API prebuilds; ASAR native unpack; Debian and AppImage targets | CI packages both formats and launches unpacked packaged Electron | Install .deb; launch AppImage with FUSE; actual Pop!_OS 22.04 and one selected Wayland desktop |
| Performance | Bounded node/trace/history/image queues and serialized device writes | Coalescing and bounds tests | Measure input dispatch p95 <50 ms and sustained releases on XL; benchmark full-page refresh |

## Manual hardware checklist

1. Ensure only Decker controls the deck. Check logged-in user permissions; run without root.
2. Connect XL. Disable simulator if desired. Check geometry, all labels/images and brightness at 0/50/100.
3. Configure short/hold/release actions; change profile while holding. The original release binding must execute.
4. Unplug while holding and reconnect. No stale release/press should run; page and brightness should restore.
5. Suspend and resume. Recheck display, device status, every release and reconnect.
6. Run a slow command alongside page redraw; input should remain responsive. Measure dispatch and service latency independently.
7. Run a workflow and close the editor. Observe completion; reopen and inspect the exact revision and node timings.
8. Test OBS unavailable, wrong credentials, reconnect, scene/mute changes from OBS itself, and shared status feeds. Test recording/streaming only in an appropriate OBS workspace.
9. Remove/change an audio device while an action runs. Confirm a useful failure; no silent success. Test multiple MPRIS players and player disappearance.
10. Quit during a command spawning children. Confirm process-group cleanup. Kill the runner/application and restart; active runs must be interrupted and never replayed.
11. Test secure keyring persistence, locked keyring and basic_text fallback. Export a workspace and check it contains no stored credentials. Import it and review commands before activation.
12. On Wayland, confirm keyboard injection is unavailable with a useful explanation; test display-server-independent actions. No universal Wayland automation claim is made.

## Scope boundaries retained from the plan

No marketplace plugin compatibility, arbitrary plugin installation, cloud sync, automatic active-window profiles, global shared workflow variables, durable side-effect replay, animation/video backgrounds, or universal Wayland automation. Other Stream Deck models are adapter-compatible candidates, not verified hardware. Distribution licensing and the first supported Wayland compositor remain owner decisions.
