# Text file actions (PR17)

Schema v3 is unchanged. Both button and workflow palettes offer version-1
`file.readText` (Read text file), `file.writeText` (Write text file) and
`file.appendText` (Append text file). Execution uses the normal resolved-action
handler in the host runtime; there is no filesystem-command IPC API.

| Action            | Resolved configuration                                   | Typed output                                                        |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `file.readText`   | `path: string`                                           | `{text: string, bytes: integer, truncated: false}`                  |
| `file.writeText`  | `path: string, content: string, createParents?: boolean` | `{bytesWritten: integer, created: boolean, operation: "overwrite"}` |
| `file.appendText` | Same as Write                                            | `{bytesWritten: integer, created: boolean, operation: "append"}`    |

Paths must be absolute Linux host paths, at most 4096 characters and 4096 UTF-8
bytes, without NUL. Spaces and Unicode are preserved. URLs, relative paths and
implicit home/environment expansion are unsupported. Read offers the existing
native open chooser; Write/Append offer a native save destination chooser,
including a not-yet-existing file. Choosing a destination does not execute an
action. Manual paths and data bindings remain available. Cancellation preserves
the previous field; edits, action changes and navigation invalidate pending
chooser completions. Desktop IPC validates the narrow `pickFile` request with
`picker: "openFile" | "saveFile"` and accepts only the trusted main frame.
Paired web decks can invoke already-saved bindings but cannot request dialogs,
paths or arbitrary filesystem commands.

Path and content support the existing `$ref`, `$template` and `$literal` grammar.
Whole references must resolve to strings; objects/arrays/booleans are not
implicitly coerced. Mixed templates explicitly serialize native JSON segments.
Validation runs after resolution, before effects. Content supports multiline
literal editing. The upstream data picker exposes Read's text/byte fields and
mutation metadata using the unchanged graph availability rules.

Reads are capped at **65,536 source bytes**. A larger file fails explicitly,
returning no partial text. A fixed buffer and bounded 16 KiB reads with one-byte
lookahead also detect growth beyond the cap. Invalid UTF-8 fails; empty files,
complete multibyte characters and a leading BOM are preserved. `bytes` counts
source bytes. Every successful result is complete (`truncated: false`); mutation
outputs never duplicate file content. Even maximally escaped Read text remains
under the runtime's 1 MB serialized node-output ceiling.

Writes/Appends accept at most **262,144 UTF-8 bytes** per action and reject
unpaired Unicode surrogates. Neither adds a newline automatically. Write
replaces all destination content using an exclusive 0600 temporary file in the
same directory, bounded chunk writes, fsync, close, and rename. Existing regular
file permission bits (0777) are preserved; special mode bits, ownership and
extended attributes are not copied. New files are 0600 (subject to host umask).
Pre-commit failures/cancellation preserve the destination and clean temporary
files. A detected external target change aborts overwrite. Successful rename is
an external effect: cancellation cannot undo it, including cancellation arriving
while rename is in progress. Crash recovery/directory durability is outside this
contract; a host crash can leave a temporary file.

Append opens with append semantics and does not overwrite existing bytes. It can
create a new file, including for empty content. It is **non-idempotent**: node
retries default to zero and existing explicit `retrySafe` confirmation is required
to enable them. There is no automatic retry of an ambiguous append. Failure or
cancellation may leave a newly created file or a partial/complete append; inspect
the destination before retrying. Cancellation retains the runtime's cancellation
status and bypasses retries/error edges; it does not roll back bytes. Successful
writes are external effects for the same reason.

`createParents` defaults to **false**. Missing parents fail with an actionable
message. Opting in recursively creates parents with 0700 mode (subject to umask).
Created directories are external effects and remain on failure/cancellation.
Access-denied, missing, invalid-target and excessive-size errors do not echo
content. The operation still depends on actual host filesystem permissions.

All Read/Write/Append operations for one canonical destination serialize within
the process, across handler instances. Unrelated destinations remain concurrent.
Parent-directory symlinks are resolved before queueing, including the closest
existing ancestor of a new parent tree; lexical `.`/`..` normalization precedes
that resolution. Effects use this captured canonical path. Final symlinks
(including dangling links), hard-linked targets (`nlink != 1`), directories and
other non-regular objects are rejected. Nonblocking/no-follow open and fstat
checks prevent replacement FIFOs from hanging reads/appends or following final
links. These are process-local coordination and target checks, not a sandbox or
cross-process transaction: concurrent edits by other host programs, especially
ancestor-directory replacement, require host coordination.

A workflow can connect HTTP → Parse JSON (whole HTTP result) → Extract value →
Write text file (whole extracted text reference) → Read text file → Append text
file (mixed template containing Read text/bytes and parsed JSON values). Tests use
a loopback HTTP fixture and real temporary file contents, persist/reload v3,
verify both palettes/typed output discovery, and mock native chooser completion.
Unit tests cover byte/Unicode limits, alias serialization, unrelated concurrency,
permission preservation, deterministic injected EACCES, non-regular targets,
atomic cleanup, queued/pre-commit cancellation and irreversible partial appends.
Physical Stream Deck, real host permissions/dialogs and desktop acceptance remain
pending for the coordinator's consolidated hardware session.
