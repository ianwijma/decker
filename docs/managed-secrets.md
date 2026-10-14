# Managed secret contract (PR08 / PR09)

Document schema stays at v3. Connections and HTTP actions store only opaque
`credentialRef` strings. Existing workspace references, including shared legacy
references, load unchanged. No API returns stored values to the renderer.
`Credentials.all()` is exclusively the trusted main-to-runner delivery boundary.

The desktop-only, trusted-main-frame `credential` request has `owner`, `epoch`,
`operation` (`set` or `remove`), `value` (set only), and `persist`. Raw reference
writes and reads are rejected. `owner` is an opaque JSON address obtained by
`credentialOwners(document)`: connection ID, binding ID/event/action address, or
workflow ID/nested node address. Sequence and branch offsets are addresses only,
not permanent identities. A main-generated epoch changes after every document
edit or credential mutation, so an old address cannot target a replacement,
reordered sequence, deleted/recreated owner, or imported workspace. Competing
requests with the same epoch cannot both succeed. Binding generations and
workflow revisions advance when their credential config changes.

Desktop document mutations, background saves and runner navigation saves share
a serial queue. Cancellation and execution remain independent of storage.
Renderer entry waits for ordinary saves, clears the password/token immediately
on submission, and rejects ordinary edits while that credential request is
pending. Completion publishes a committed snapshot; it never calls an editor's
possibly stale action-change callback. Changing selection cannot attach a reply
to another action. A stale form is cleared when its owner/snapshot epoch changes.

`Snapshot.credentialState` contains the current epoch, whether persistent writes
are available, and a per-owner `configured`, `missing`, `locked`, or
`session-only` status. `secureStorage` is retained for compatibility. Missing
imported references are manageable at their connection/action. Settings also
lists HTTP owners, including nested graphs and all key phases. PR09 can use the
same OBS inline control and statuses without requesting stored passwords.

Every set/replacement allocates `managed:<UUID>`, including when the previous
reference was shared. Copying actions/profiles shares references; no values enter
JSON. Remove detaches only that owner. Owner deletion and replacement never
collect stored secrets: other copies, immutable in-flight definitions and
revision pins can still need them. Unreferenced encrypted entries are retained
conservatively; physical erasure/garbage collection is outside this contract.

Encrypted storage reads and preserves its ciphertext map even when the keyring
is unavailable. Individual decrypt failures remain locked; malformed/unreadable
files block persistent writes. Linux `basic_text` is insecure. Session-only entry
is explicitly offered and does not write, delete, or rewrite the encrypted file.
Session values disappear on restart. Unlock and restart to retry locked entries.

A persistent mutation serially encrypts into a fresh 0600 exclusive temporary
file and atomically renames it over the ciphertext store. It then saves history
and commits the owner document last, before changing the in-memory document or
reporting success. Encryption/write/rename failure preserves the previous map
and values. Document failure preserves the prior visible reference and may
retain a new unreferenced encrypted entry. A crash between these two commits
leaves either the old owner or the new owner, both backed by retained secrets.
No rollback deletes a possibly still-needed old secret. Retry failures normally;
inspect/restore a corrupt encrypted file offline rather than overwriting it.

Exports contain no values and consistently remap supported connection/HTTP
references to fresh `import:<UUID>` placeholders, preserving sharing within the
bundle. Import remaps again before review/activation to fresh missing managed
references. An import can never automatically bind its supplied reference to a
local secret, even on the exporting machine. Dynamically resolved credential
references become missing placeholders in bundles and require re-entry; local
workspace expressions remain unchanged. Local workspace persistence and
pre-existing v3 references are unaffected. Import assets, review/backup,
workflow aliases and action JSON are otherwise preserved.

HTTP retains Bearer authentication and rejects redirects whenever a secret is
attached. A dedicated boundary masks echoed tokens in successful results and
errors before expression data or run records can consume them; existing bounded
body/result handling and runtime diagnostic redaction remain intact.

Mock secure-backend, file failures, loopback HTTP and Electron simulator checks
use synthetic secrets. Actual OS keyring unlock/restart behavior, OBS integration
and physical hardware acceptance remain coordinator-host checks.
