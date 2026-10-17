# Bounded remote image assets (PR22)

The workflow palette's **Fetch image** action is `image.fetch` version 1. Its
literal or bound HTTP(S) `url` resolves and validates before effects. The result
contains `asset` (a lowercase local SHA-256 hash), `width:256`, `height:256`,
`format:"png"`, normalized `bytes`, and `sourceWidth`, `sourceHeight`,
`sourceFormat` (`png`, `jpeg` or `webp`). No buffers, paths or URL strings enter
the result. Bind **Update triggering button → Local image** to
`outputs.image.asset`. Fetching works in manual/unbound runs; updating still
requires PR21's saved-key authority. Workspace schema stays v5.

## Bounds and normalization

| Setting | Default and hard maximum | Allowed override |
| --- | --- | --- |
| `maxBytes` | 4,194,304 bytes (4 MiB) | Integer 1–4,194,304 |
| `maxPixels` | 16,000,000 decoded pixels | Integer 1–16,000,000 |
| `timeoutMs` | 15,000 milliseconds | Integer 100–15,000 |
| Redirects | 4 hops | Fixed |
| Normalized output | 1,048,576 bytes (1 MiB) | Fixed |
| Concurrent operations / waiting queue | 2 / 16 | Fixed |

Omitted settings use defaults. Zero, false, non-finite or excessive values never
disable a bound. One deadline starts before queue admission and includes
redirects, streaming, decoding and ingestion. The reader counts actual
decompressed bytes, including chunked or dishonest Content-Length responses;
excess advertised lengths fail early. Bodies are cancelled/released on every
exit. HTTP errors record only the numeric status, never response bodies.

Installed sharp/libvips checks actual bytes with `failOn:"warning"` and positive
`limitInputPixels`, inspects format/dimensions/pages, and fully decodes pixels
before producing a hash. A PNG chunk scan rejects APNG even when decoder metadata
exposes only its first frame. WebP animation flags/chunks and decoder frame
metadata are rejected. GIF, SVG, video and malformed/truncated pixels fail.
MIME and filename extensions confer no trust. EXIF orientation is applied, a
256×256 cover crop matches existing uploads, alpha is preserved, and source
metadata is stripped. Sharp's supported `timeout({seconds})` bounds native
processing. A cancelled native operation retains its concurrency slot until
settlement; its result cannot be published.

## Credentials, cancellation and privacy

URLs are HTTP(S) only, up to 4096 characters, without embedded credentials at
every hop. Local/LAN HTTP remains supported for trusted saved automation. Loops,
excess redirects and HTTPS→HTTP redirects fail. No renderer/device fetches remote
URLs, and paired web clients gain no host-fetch IPC.

Public images need no token. Optional `credentialRef` uses existing opaque
owner+epoch entry, rekey/import/export and missing/locked status contracts. The
worker captures the value once per in-flight request. It crosses only the trusted
worker/main bridge and is protected through `protectSecret`. Tokens are never
inherited from earlier HTTP actions. Same-origin redirects retain this action's
token; a cross-origin hop drops it permanently, including on a return to the
first origin. Cookies are neither stored nor forwarded. Plaintext token/header
fields are rejected by the strict configuration schema.

Errors are fixed bounded messages without signed URL queries, headers, response
bodies or source bytes. Cache identity is the content hash. The existing
workflow expression/history rules continue to govern upstream HTTP/Extract
outputs; explicit literal URLs remain authored configuration.

The main RPC registry binds request, action and run IDs to the originating worker
instance. Node/run cancellation sends an abort message, including for manual,
unbound and scheduled calls. Cancellation, settlement, worker exit, confirmed
import and shutdown abort host operations. Replies go only to the originating
live worker. Ingestion rechecks its signal after awaits and before atomic
publication. Display writes still use PR21's exact origin/generation/ownership,
action/invocation authority and `DisplayState.commit`. Fetching an asset alone
grants no display permission. Scheduling schemas/routing remain unchanged.

## Ownership, pins and recovery

`generated-assets.json` is a separate strict version-1 write-ahead manifest,
limited to 256 entries, 64 MiB of owned normalized assets and 64 KiB of JSON.
Entries contain only hash, byte size and local inode identity. No migration or
dependency change is required. Exclusive 0600 temporary files, fsync and atomic
no-replace hard links publish at validated hash filenames. Existing bytes are
checked before a hit; equal concurrent requests converge. Corrupt existing
content fails without overwriting it.

Only manifest-owned files with matching content/inode can be deleted. Unknown,
pre-existing, uploaded and imported files are never swept, even if their bytes
match generated content. Authored saves and equal uploads/imports permanently
promote hashes out of generated ownership before the authored commit. Authored
assets retain their existing independent storage policy.

`authoredAssetReferences(document)` conservatively collects authored asset fields,
including deck/key/toggle art and literal workflow assets in nested bodies,
branches, sequences and targets. Export uses this collector: adopted art
round-trips, while dynamic-only display state/assets stay local.
`DisplayState.assetReferences()` pins every live last-good dynamic image,
including hidden buttons. Each producing root leases at most 256 unique hashes;
at most 64 roots hold leases. These pins bridge Fetch image to updates through
delays/subflows. Each run's settlement releases only its leases; worker/import/
shutdown invalidation releases all affected work. A one-hour plus 15-second
absolute fallback (above the engine root timeout) also bounds private probe
leases, whose runs deliberately publish no history. Cleanup expires these
leases without adding a periodic timer. Display commit pins the new
image before cleanup can release old last-good art.

Cleanup on settlement, successful display updates and document/asset lifecycle
reconciliation removes only unpinned owned assets. A pinned-full entry/byte
budget rejects new images usefully. Network/decode never hold the document queue;
final ingestion/pin/GC serialize with display/document changes. Generated storage
also serializes uploads' ownership promotion. Disk failures preserve previous
art and block generation/collection after uncertain I/O until restart/repair.

Startup loads workspace and **display cache first**, then reconciles manifest,
disk and live pins before collection. It removes only exclusive generated temp
namespaces. Missing planned files and suspect inode/checksum entries lose
ownership conservatively. A corrupt/oversized/unsupported manifest blocks
generation/GC and preserves its bytes and existing art for offline repair.
Unknown hash files never become inferred orphan generated assets.

## Last-good/error interface for PR23

Fetch/validation/storage errors preserve the prior image and fail the node/run
with a concise message. Host fetch failures for a valid originating button also
set transient `imageStatus:"stale"` in its per-identity `buttonDisplay` snapshot.
Desktop, authorized per-deck web views and device frames show **Image stale**.
Configuration validation errors use the existing run failure indication. Image
status remains independent of confirmed toggle state and temporary activity.
`DisplayState.beginImage(context)` / `imageResult(context,ticket,stale)` check live
authority and latest request order; cancelled/superseded/older requests cannot
mark newer success stale. Successful fetching or asset commit/reset clears the
applicable status. Status is transient; last-good art persists in PR21's cache.
PR23 can reuse these ticket/status and pinning APIs. No periodic fetch, render
effect or refresh timer is introduced.

Web clients receive only their authorized deck's composed keys/status. Asset
serving still requires a hash in that paired deck's current view; another deck
cannot guess a generated hash to retrieve it. Paths, manifests, private context,
credentials and graph outputs stay out of those views.

## Local example and acceptance

Serve `{"name":"Local avatar","avatar":"http://127.0.0.1:PORT/avatar"}` at
`/api`, with static PNG/JPEG/WebP at `/avatar`. Assign this workflow to a key:

1. HTTP request (`http`) GET `/api`.
2. Parse JSON (`parse`) input `{"$ref":"outputs.http"}`.
3. Extract value (`extract`) input `{"$ref":"outputs.parse.value"}`, path `avatar`.
4. Fetch image (`image`) URL `{"$ref":"outputs.extract.value"}`.
5. Update triggering button: `asset:{"$ref":"outputs.image.asset"}` and
   `label:{"$ref":"outputs.parse.value.name"}`.

Changing `/avatar` to a 500 response fails the next run while retaining the last
good art with a stale indication. Manual execution fetches but cannot update a
key. Tests use local HTTP/image fixtures, temporary stores, generated RGB frames
and source/packaged Electron. Physical Stream Deck, actual keyring and real
desktop/account integration acceptance remain coordinator-host checks. No
physical verification is claimed.
