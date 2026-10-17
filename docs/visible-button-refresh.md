# Visible button refresh (PR23, schema v7)

Choose **Dynamic workflow button** in the Deck action library, or **Add refresh
workflow** in a saved key's **Refresh while visible** section. The preset opens
that editor and preserves existing press/release/hold and toggle assignments. A
key with only a refresh workflow is valid. Choose a workflow with the searchable
selector, fill its declared inputs as JSON, choose a cadence, **Save refresh**,
then **Enable refresh**. Refresh workflows can have effects; choose workflows
that fetch or prepare display data. Refresh is independent of pressing a key.

Defaults are an initial attempt when visible and an interval of 60 seconds. The
five-minute choice is 300 seconds. Custom intervals are integer 60–86,400 seconds
(one day). There are at most 64 authored refresh bindings. Each configuration has
a fresh UUID, workflow UUID, ordinary JSON inputs, seconds, initial and enabled.
Inputs share schedule bounds: 16,384 characters, depth 12, 2,048 values, 8,192
characters per string and 100 per key. Missing workflows, invalid flows and
missing/extra declared inputs prevent enabling. Incomplete inputs can be saved
as an inactive draft. Rendering, choosing a workflow and editing a draft execute
nothing. Saving changes to a refresh definition disables it until enabled again.

Enable/disable compares the exact committed configuration in main. New/copied/
imported refresh definitions are disabled; general import confirmation does not
enable them. Copies/imports rekey refresh identity. Whole-document saves cannot
resurrect an explicitly disabled configuration. Old v1–v6 workspaces migrate to
v7 without refresh. V6 schedules, aliases, credentials, toggle appearances and
asset references retain their contracts. Future schema versions still receive a
backup and block writes. Export carries definitions, never leases, runtime status,
success times, display authority or local last-good cache.

## Which surfaces count

Main owns leases for exact deck/profile/page/binding/generation and a separate
refresh definition/dependency fingerprint. A binding becomes visible when its
first eligible surface arrives, and stays visible until its last lease ends.
Additional clients and repeated snapshots do not cause additional initial runs.
The same authored binding shown by distinct decks does not share runtime state.

- **Hardware:** its configured current page must have completed driver frame
  writes, with ready status and the exact current applied view version. Discovery,
  native-driver readiness, presence, permission/busy/open/I/O errors do not count.
  Main rejects delayed ready reports for other pages. Appearance/status updates
  keep the same view version and native writes still deduplicate. Hardware keeps
  refreshing with the editor closed to tray. Disconnect and worker exit drop its
  leases immediately. A main heartbeat renews only still-ready matching views.
- **Simulator:** only the selected simulator actually shown by the desktop Deck
  route. Main checks the trusted sender/main frame, committed deck and page view,
  window visibility and minimized state. Route/deck/page departure, hide/minimize/
  close, renderer navigation/crash and missing heartbeat remove the lease. Focus
  changes alone do not. Hardware/web editor previews do not qualify.
- **Web:** authenticated paired foreground sockets acknowledge the current view
  after rendering and every four seconds. Server derives the deck from pairing;
  clients never choose a binding/workflow or supply display authority. Pairing,
  an online socket, pong or heartbeat alone do not qualify. Current-view changes,
  hidden reports, closed sockets, expiry, revoke/reset, server disable/restart and
  worker exit remove leases. Existing sequence, size, rate, origin/host, held-key
  reset and per-deck image authorization checks remain. Browser foreground reports
  are cooperative telemetry, bounded by the same authority and execution limits.

At most 130 surface leases and 4,096 exact binding states are retained (valid
workspaces currently allow only 64 authored bindings). Leases expire after 15
seconds without acknowledgement, checked by one <=1-second main heartbeat. The
server also clears missing current-view acknowledgement at its existing socket
health tick. Desired-page epochs change even on A → B → A navigation, so an older A report
cannot revive its lease while the new A is being applied. Dynamic art/status
changes never change that epoch.

## Cadence, failures and lifecycle

One main-owned refresh clock admits at most **four pending/active refresh roots**,
within Engine's shared 64-root cap. Round-robin admission leaves capacity for
manual work. Each exact binding has at most one job or bounded waiting opportunity;
no tick backlog is queued. Interval cadence anchors to the attempt, not its
completion. Overlapping ticks skip. Large timer/sleep gaps and wall-clock changes
reanchor future cadence, rather than replaying missed work. A new visible epoch
gets one initial attempt, subject to its retained cooldown. If initial is off,
visibility starts the interval wait.

All failures, including HTTP 429, use generic exponential cooldown: 60 seconds,
120, 240, 480, 960, 1,920, then 3,600 maximum, measured after settlement. The next
attempt is no earlier than both interval due time and cooldown. The existing
HTTP/image result transport does **not propagate typed Retry-After metadata**;
headers/redacted error strings are not parsed as runtime truth. This version
therefore uses this generic policy rather than claiming server-specified retry
support. Success or a deliberate definition change resets failure backoff.
Brief hide/show, reconnect and second-client churn retain cooldown. Within a process session, any two
attempts of an unchanged binding are at least 60 seconds apart.

Last lease loss, disable/removal/replacement, executable workflow/nested dependency
change, ownership/generation change, import, suspend, runner exit or quit cancels
owned work and immediately ends only its display token. Main RPC/fetch abort and
producing-root asset leases are released independently of the document/storage
queue. Late acceptance is cancelled; late settlement cannot update replacement
state. Pending acceptance has a ten-second deadline. Runner recovery requires an
acknowledgement of the current committed document, then reevaluates current
leases. Effects with uncertain completion are never replayed. Ordinary schedules
keep their separate durable watermarks and origin-null semantics.

Refresh changes have separate identity from ordinary press/toggle execution.
Interval/input/enable changes never reset confirmed toggle state or run probes.
Trusted launches use `source.kind:refresh` and the immutable exact saved origin
through child workflows. Engine handles and root IDs come from explicit worker
acceptance/settlement, independent of history batching. Public IDs grant no
permission. Refresh cannot cancel a press or toggle merely because it is due.

## Display and status

Composition remains authored base → confirmed toggle/observed appearance →
last-good dynamic override → temporary **press** activity. Refresh status is a
separate text line, consistent on desktop, paired web and generated device frames;
periodic refresh does not hold a key green/running. The latest begun invocation
owns display writes; completing it never restores an older press/refresh writer.
Post-await authority checks still prevent updating a replaced/page-moved key.

The editor shows **idle** when disabled, **waiting** when enabled and awaiting
visibility/cadence/capacity, **running** during owned launch/work, **error** after a
failure without a session success, and **stale** after a failure with a prior
session success. It shows the next eligible attempt where applicable. Last
successful refresh time is memory-only, reset to **unknown this session** on
restart or definition replacement. Cache hits and rendering never invent success.
Retained artwork is not evidence of fresh data. Image stale remains a separate
PR22 indication, independent of refresh failure, toggle confirmation and press
activity. Status contains no raw outputs, URLs, headers or secrets.

PR22's one remote-image pipeline supplies local hashes; refresh does not add a
second downloader. Existing root transient pins and `DisplayState.assetReferences`
retain all live last-good images, including hidden keys. Display commits pin new
art before collection; cancellation/failure leaves prior art. Only affected
root transient leases are released. Uploaded/adopted assets and other roots are
untouched. Startup still loads workspace/display cache before generated-asset GC.

## Working local avatar example

From the repository, run `node docs/examples/visible-avatar.mjs`. Import
[visible-avatar.json](examples/visible-avatar.json), review it and confirm import.
Select the **Local avatar** simulator and its key, then explicitly **Enable
refresh**. The fixture serves HTTP JSON and a generated PNG on 127.0.0.1:8743.
The independent press copies a greeting; refresh performs HTTP → Parse JSON →
Fetch image → Update triggering button using `outputs.parse.value.avatar`,
`outputs.image.asset` and `outputs.parse.value.name`.

`curl http://127.0.0.1:8743/next` changes its name and avatar. The next minute
updates the key. `curl http://127.0.0.1:8743/fail` returns HTTP 429 for data fetches;
the last-good avatar remains, refresh becomes stale and cooldown grows. `/reset`
restores success. Leave the Deck route to stop simulator work; return to resume
under cooldown. Edit the interval to **Every five minutes**, save, then enable to
use that cadence. No account or physical hardware is required.

## Verification boundaries

Fake-clock tests cover schema/activation/import/copy, 60-second/five-minute
cadence, multiple surfaces, expiry/churn, backoff, overlap, fairness, cancellation,
late callbacks, clock/suspend gaps and unchanged/cosmetic saves. Mocked device
transport covers applied-view changes/errors and native frame deduplication.
Paired socket tests cover authentication-derived visibility, current versions,
monotonic sequence, hidden reports, expiry and revoke. Electron fixtures exercise
activation, independent press, local avatar changes/failure/last-good art, route
and mocked window visibility, saved-config guards and paired foreground clients.
Existing schedule DST/watermark, source/packaged Electron, native/icon notice and
installer gates remain required.

Physical Stream Deck display/readback, real OS suspend/resume and clock changes,
actual tray/window manager behavior, OBS/MPRIS/audio and keyring acceptance remain
pending for the coordinator's consolidated host session. No physical verification
is claimed.
