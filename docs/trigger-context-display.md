# Trigger context and dynamic display (PR21)

Workspace schema remains **v5**. Runtime context, display authority and last-good
appearance are separate from authored configuration. Existing `deck.appearance`
actions remain version 1, with their label/background configuration unchanged.
Exact legacy label/background objects retain their previous 80-character label
truncation through a compatible decoder; partial/new field objects reject labels
beyond that bound. The workflow palette calls this action **Update triggering button**; it remains
absent from ordinary button palettes. Rendering never executes workflows, toggle
probes or action assignments.

## Read-only public scope

`context` is a reserved top-level workflow scope alongside `inputs`, `outputs`,
`vars`, `item`, `index` and `error`. Use the existing `$ref` dot/segment paths,
`$template` and fallback grammar. `inputs.context`, `vars.context`, Set/map values,
and action configuration cannot replace it. Scope budgets include it. The engine
copies launch metadata and freezes context, source and origin in every graph;
references return bounded copies, never mutable pointers into metadata.

```json
{
  "source": { "kind": "button" },
  "origin": {
    "deckId": "simulator-xl",
    "profileId": "default",
    "pageId": "home",
    "bindingId": "saved-binding-uuid",
    "generation": 0
  },
  "rootRunId": "run-uuid",
  "invocationId": "accepted-event-uuid",
  "rootWorkflowId": "root-workflow-uuid",
  "workflowId": "current-workflow-uuid",
  "workflowInvocationId": "current-call-uuid"
}
```

`rootRunId`, `invocationId`, origin and root workflow remain fixed through direct
sequences, nested `workflow.run`, subflows, loop iterations and parallel branches.
Each child workflow call receives a fresh `workflowInvocationId` and current
`workflowId`; loop/branch graphs in that call share its identity. Each accepted
queued/restarted/concurrent event has its own invocation ID. The ordinary phase
policy remains independently keyed by press/release/longPress.

Main captures origin at key-down, before delayed phases or navigation. Display
resolution never uses the selected deck, page, slot occupant or caller-supplied
IDs. Manual workflows may have a deck for navigation/brightness but have
`origin:null`. Detached editor tests are unbound and do not get binding activity
identity; an exactly matching saved-key test may be bound after main validates
its full saved configuration. Unsaved toggle tests require saving first.
Private probes always receive `source.kind:"probe"`, `origin:null` and no display
authority, including nested calls; their results/traces remain private.

The data picker offers **Trigger context**, including origin fields marked as
conditional. Origin leaf references require a fallback because manual, detached
and scheduled invocations lack a key. For example:
`{"$ref":["context","origin","bindingId"],"fallback":"unbound"}`.
Validation rejects unknown context paths. Historical previews show only this
bounded public shape from sanitized run records, and say when no key/context is
available. They never fabricate IDs or read live scopes.

## Trusted launch and authority extension interfaces

`shared/trigger-context.ts` defines:

```ts
type LaunchSource = {
  kind: "button" | "test" | "manual" | "scheduled" | "refresh" | "probe";
  invocationId: string;
  origin?: ButtonOrigin;
};
type TrustedLaunch = { source: LaunchSource; authority?: string };
```

Only main/runtime callers pass `TrustedLaunch` to `Engine.start` via
`RunBinding.launch`, `Engine.prepare`, `Coordinator.trigger` or `Toggles.press`.
Renderer request schemas have no launch/authority field. Main's
`DisplayState.accept(kind, origin?)` issues metadata and a separate private token
for a saved origin; **public IDs confer no permission**. Unbound launches and
probes receive no token. The engine validates a queued origin against the current
worker document before starting. Main checks saved ownership, exact page/binding
and generation again at lifecycle begin and commit. Executable binding and
relevant workflow/alias/connection fingerprints invalidate outstanding authority;
toggle artwork retains PR19's identity rules. Moving between slots in the same
page retains identity; moving to another page invalidates the old origin.

For **PR20 scheduling**, main may use `displayState.accept("scheduled")` and
pass that launch to the worker's trusted run path. This labels public context
and history while granting no binding/display authority, irrespective of the
active deck. No scheduling request or timer is implemented here.

For **PR23 visibility refresh**, main may validate/capture a saved origin, call
`accept("refresh", origin)` and retain its private authority token as the lease
handle. `displayState.end(token)` invalidates that invocation when the lease
ends; cancel its Engine handle too. Never reuse an ended token or supply only
public origin IDs. A new refresh accepts a new invocation. No visibility watcher,
periodic timer or automatic refresh is implemented here.

Engine lifecycle begin/end messages are sent synchronously before effects and
on abort/settlement, separately from batched history. Each main RPC additionally
sends an action begin/end with a unique action ID and its node AbortSignal. Thus
a cancelled/timed-out hanging action cannot commit merely because its root is
still running. Main removes authority immediately for desktop cancellation,
runner exit, shutdown and confirmed document import. Ignored events, discarded
queues and rejected toggle presses release unused tokens. Storage work shares
the document mutation queue, but lifecycle invalidation does not wait for it.
Every commit rechecks authority after asset reads and after temporary-file
write/fsync, immediately before a synchronous atomic rename. Cancellation after
that commit point retains the already successful update.

Conflict policy: the **latest accepted invocation that has begun execution** owns
display writes for that exact origin. A pending/ignored event does not displace
an executing owner. Beginning a newer invocation supersedes older writes; its
completion/failure does not restore an older writer while that writer is still
live. Sequential updates within the current owner remain allowed. Parallel
branches of the same owner serialize in main's mutation-arrival order and merge
partial fields. Last-good values survive run failure, cancellation and worker
restart; no automatic rollback or replay occurs.

## Updates, clearing and composition

Configuration is a partial object with optional `label`, `background`, `icon`,
`asset` and `reset`. The UI enables fields explicitly and uses existing binding
modes, Lucide selection and local upload controls. Workflow image choosers use
workflow/node identity and the document epoch, so unchanged snapshot clones do
not discard results while edits, replacement or navigation invalidate them.
At dispatch and commit, labels
are bounded to 80 characters, icons to 100, colors to six-digit hex, and assets to
existing SHA-256 local PNG/JPEG/WebP content hashes. UTF-8 remains intact. No URL, filesystem
path or SVG document is accepted as an asset. Icon tokens use the existing bundled
Lucide registry and unavailable-icon fallback; custom text is rendered escaped.

- Omitted fields retain the previous dynamic override; absent overrides inherit
  the authored/observed/toggle layer.
- `label:""` and `icon:""` explicitly clear those values; `asset:null` clears
  the resolved image.
- An explicit icon without an asset sets dynamic `asset:null`, replacing an
  earlier dynamic image and clearing inherited images. A same-update asset takes
  precedence over the icon.
- `reset:["label","background","icon","asset"]` removes those dynamic fields.
  Reset is applied before values in the same update. Reset both icon and asset to
  restore full image/icon inheritance.

A missing, stale, cancelled or unbound origin fails with an actionable error;
the action never silently succeeds against whichever deck is selected. It never
changes authored appearance, action assignments or confirmed toggle state.

Shared `buttonAppearance` composition remains:

1. Authored base.
2. Confirmed toggle appearance or observed integration appearance.
3. Last-good dynamic appearance, plus the legacy activity override compatibility
   helper (new `deck.appearance` calls use the persistent service). The main
   `buttonFeedback` compatibility projection exposes current label/background
   from that service alongside activity, so existing consumers keep their fields.
4. Temporary running/success/failure background.

The bounded toggle `stateLabel` remains independent of stage 3. Activity expiry
recomposes the latest underlying values, including updates committed while the
activity was visible. Main uses this helper for authorized web views and device
frames; desktop keys use the same snapshot/helper. Validated display maps keep their complete bounded
identities instead of passing through diagnostic object truncation; text fields
are scrubbed individually. Authored editor previews stay
separate. Existing native frame deduplication and stable flow selectors remain.
Web clients receive only their deck's composed display/status, without cache,
authority, history or private outputs. Existing asset serving authorizes only
hashes in that paired deck's current resolved view, so a dynamic image does not
grant another deck access.

## Last-good cache and asset retention seam

Main stores `display-cache.json`, independently of workspace/history/toggle
files, with format:

```json
{ "version": 1, "entries": [{ "origin": { "deckId": "...", "profileId": "...", "pageId": "...", "bindingId": "...", "generation": 0 }, "fields": { "label": "Count: 0" } }] }
```

Identity is JSON `[deckId,profileId,pageId,bindingId,generation]`, never the slot.
Main validates the deck still owns that profile and finds the binding anywhere
on the captured page, including when it is not currently visible. The cache is
bounded to **4096 entries and 1,000,000 UTF-8 bytes**. Least-recently-committed
entries are evicted first; reads/renders never change recency or write disk.
Private authority metadata is separately bounded to 4096 invocations with at most
10,000 main-action tickets per active root (the engine step budget); fingerprints
are fixed-size SHA-256 strings. The engine still caps active roots at 64.

Startup uses strict format/field bounds and live identity validation. Duplicate,
malformed/truncated, unsupported or oversized cache files are quarantined as
`display-cache.corrupt.json`; the workspace is untouched and rendering starts
from inheritance. If quarantine fails, subsequent cache writes are blocked.
Missing/invalid local asset references are dropped during load. Runtime orphan
entries/references disappear during reconciliation; the next commit atomically
compacts their on-disk remnants, and startup also prunes them. Copy/export/import
contains no live cache or authority. Imported/copied binding IDs cannot acquire
old state; confirmed import invalidates in-flight work.

A successful update writes a 0600 exclusive temporary file, fsyncs it, rechecks
authority, renames atomically and fsyncs the directory before publishing or
reporting success. Storage failures preserve the session's prior last-good state
and block further writes until restart/repair. A rename followed by directory
fsync failure is uncertain on disk and is reported as failure; no durable success
is claimed. Stale-authority rejection does not poison future storage. Known managed-secret values are masked from label/icon updates before storage. No raw
network response, outputs, credentials or private tokens are persisted.

`DisplayState.assetReferences(): Set<string>` is the **PR22 pinning seam**. It
returns validated live dynamic image hashes after orphan reconciliation. Combine
these with authored upload references for any future bounded generated-asset GC.
Reset/eviction releases only dynamic references; this service never deletes an
uploaded file. PR22 still owns remote downloading, authoritative raster ingestion
and generated-asset retention budgets.

## Working local example and verification

Connect HTTP request → Parse JSON → Extract → Update triggering button. For an
HTTP result `{"stats":{"count":0}}`, use Parse input `{"$ref":"outputs.http"}`
to preserve truncation provenance, Extract input
`{"$ref":"outputs.parse.value"}` and path `"stats.count"`, then:

```json
{
  "type": "deck.appearance",
  "version": 1,
  "config": {
    "label": { "$template": ["Count: ", { "$ref": "outputs.extract.value" }, " · ", { "$ref": "context.source.kind" }] },
    "background": "#123456",
    "icon": "pack:lucide:v1:user"
  }
}
```

Assign the workflow to a saved key. Its label becomes `Count: 0 · button`, even
if navigation happens during HTTP, and remains after restart. The authored label
is unchanged. Use a local uploaded hash in `asset` for images; remote avatars
are deferred to PR22. Running manually fails at the update with no triggering key.

Unit tests cover propagation/spoofing, private probes, policies and lifecycle
ordering, cancellation after waits, exact ownership, replacement/movement,
shared-deck isolation, cache bounds/reload/corruption/storage errors, asset pins,
composition and generated RGB frame comparisons. Electron fixtures cover the
local HTTP chain, navigation mid-request, saved versus detached tests, honest
manual errors, context UI/preview and restart persistence. Existing cancellation,
toggle/observed integration, file/media/OBS/icon/brightness and paired-web guards
remain in the full regression suite. Source and packaged CI gates are required.
Physical Stream Deck, desktop MPRIS/audio/OBS and actual keyring acceptance remain
pending for the coordinator's consolidated host session; no physical verification
is claimed.
