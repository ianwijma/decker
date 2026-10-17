# Storage, credentials and trusted actions

The desktop renderer is sandboxed with context isolation, no Node integration, a restricted preload API, sender checks, validated requests and a Content Security Policy. HID, execution and the local web service run in supervised Electron utility processes. This is crash isolation, not a sandbox for user-authored commands.

Configuration and history are stored under Electron's Linux user-data directory (normally `~/.config/decker`). Saves are serialized and atomically replaced. Unsupported schema versions and unreadable configurations are backed up. Images are stored separately by SHA-256. Imports validate the document, graphs and image checksums; review imported commands before activation. Imports back up the current workspace.

Credentials stay outside configuration, exported workspaces and the renderer. OS-backed `safeStorage` is used only when the selected backend is secure. `basic_text` or an unavailable keyring requires session-only credentials. Run traces redact sensitive field names and known credential values, truncate output, and bound retained history. Active runs are marked interrupted after a crash/restart; side effects never resume automatically.

Configure OBS passwords inline under **Settings → General → Add OBS** and HTTP
secrets on their saved action owners. Users do not manage raw credential IDs or a
standalone Credentials tab. Imported placeholders need re-entry; session-only
credentials are lost on restart. See [OBS setup](obs-setup-testing.md) and
[managed-secret internals](managed-secrets.md).

Simulator and paired-browser actions execute on the Decker host, including file
writes, commands and custom toggle probes. Review imported actions before confirming
import; import replaces the workspace, backs it up, resets browser pairings, pauses
sharing and disables imported schedules/refresh. Export your workspace first.

Web controls use HTTP/WebSocket on a trusted LAN with desktop-approved browser
pairing and no public relay; pairing does not encrypt traffic. See the
[network setup and authorization guide](web-decks.md) before enabling sharing.
Decker must stay running; closing to tray can keep runs, hardware/web controls and
schedules active. Quit stops them. Interrupted runs and missed schedule ticks are
not replayed automatically.
