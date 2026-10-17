# OBS drafts and read-only tests (PR09)

OBS 28 and newer include WebSocket. Settings → General → Add OBS opens a local
connection draft with a display name, `ws://`/`wss://` address (including port),
and password choice. In OBS, use Tools → obs-websocket Settings to enable its
server and find its password. `ws://127.0.0.1:4455` is the installed
obs-websocket-js package's default; match the port configured in OBS. The help
link opens the official [remote control guide](https://obsproject.com/kb/remote-control-guide)
through a desktop-only request with a fixed destination. Modern OBS does not
need an additional plugin. Keep authentication enabled.

A draft does not enter the document until Save connection. Cancel or leaving
Settings discards it. Test connection is available first and never saves,
subscribes, invokes an action, or marks a runtime connection connected. Results
identify the tested draft/connection, are point-in-time, and disappear when
inputs or the credential epoch change. Closing/reloading the editor, cancelling
or application shutdown cancels temporary clients. At most two tests run at once.

Desktop/main-frame-only `obsTest` requests identify a bounded draft, or a saved
owner address and current credential epoch. Every request explicitly selects a
supplied transient password, the saved owner's password, or no authentication.
There is no arbitrary credential-reference lookup or stored-plaintext API.
Changing an endpoint switches the editor to password entry; using the saved
password at the changed address requires explicitly selecting that choice.
No authentication is an explicit choice for servers already configured that way.

Each probe uses an independent OBS WebSocket JSON client, RPC 1, zero event
subscriptions and only `GetVersion`. Connection/authentication and the read-only
request share a five-second deadline. Disconnect has a bounded close-handshake
window and forces socket/listener cleanup when necessary. Outcomes distinguish
success, reachability, timeout, authentication, missing/locked passwords, protocol,
invalid input, cancellation and unclassified failures. Unclassified transport
failures remain honest about ambiguous causes. TLS certificate checks remain on.
Results contain only the request ID, status and fixed remediation text; server
payloads, URLs, passwords and low-level errors never enter results, snapshots,
observations or run history. Supplied passwords stay in transient request/form
memory and are discarded on dismissal/submission. OBS password entry reuses the
managed-secret presentational controls; committed owners retain InlineSecret's
owner+epoch protections.

`obsSave` shares the existing main mutation queue and renderer credential lock.
A new or replacement password uses `Credentials.create` to allocate a fresh
managed UUID and commit encrypted storage (or explicitly session-only storage)
before committing the connection document. Storage failure preserves the previous
owner. A document failure can retain an unreferenced secret, following the merged
conservative retention contract. Keep/remove choices affect only the selected
owner; copies, revision pins and immutable runs keep their existing references.
This feature originally shipped on v3; current workspace schema is **v7**.
Existing connection IDs/refs and dynamic field bindings retain their contracts.
New action fields use searchable display names, duplicate-name disambiguation and
missing-choice feedback while storing stable IDs.

Runtime clients use session identity and generation guards for callbacks and
initial observation. Reconfiguration invalidates and disconnects pending as well
as established clients before allowing replacement initialization. Late callbacks
and failures cannot evict/recolour a replacement. Endpoint/password changes are
independent across instances. Tests never reuse this runtime client map.

Coverage uses synthetic secrets, mock client seams, local WebSocket servers and
Electron with a virtual display. Real OBS authentication/TLS and reconnect checks,
OS keyring unlock/restart, host-desktop browser integration and physical Stream
Deck acceptance remain pending for the coordinator's consolidated session.
