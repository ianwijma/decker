# Explicit workflow schedules (PR20, schema v6)

Current workspace schema is **v7**. [Visible button refresh](visible-button-refresh.md)
documents the implemented PR23 visibility, activation and lifecycle extension.
The original feature-specific schema/version notes below describe its baseline.

Open **Flows**, select a workflow and clear the node selection to find **Schedules**
next to its properties. Add an interval or cron schedule, provide its declared
inputs as ordinary JSON, preview and save. **Enable schedule** is a separate,
persisted action. Rendering, editing, previewing, saving a new definition and
reviewing an import never launch a workflow. Closing the window to tray keeps
schedules active; **Quit** stops them. Decker is not a system daemon.

A definition is:

```ts
{
  id: string; // stable UUID
  name: string; // 1–80 characters
  workflowId: string; // existing workflow UUID, never a name/legacy alias
  enabled: boolean;
  inputs: Record<string, Json>;
  timing:
    | { kind: "interval"; seconds: number }
    | { kind: "cron"; expression: string; timezone: string };
}
```

There are at most 200 schedules. Intervals are integer **60–31,536,000 seconds**.
Cron expressions contain exactly five numeric fields, at most 120 characters:
minute, hour, day of month, month, day of week. Lists, ranges, steps and `*` work;
seconds, names, macros, aliases, `?`, random hashes and nonstandard day modifiers
are rejected before parsing. When both day fields are restricted they use standard
**OR** semantics. All declared inputs are required, extra names are rejected;
input JSON is at most 16,384 characters, depth 12, 2,048 values and 8,192 characters
per string. No expressions in inputs create execution metadata or permissions.
Missing workflows/inputs block enabling with an explanation.

Cron stores an explicit IANA timezone (at most 100 characters). The initial
suggestion is the detected system zone and remains editable. Previews return
1–5 future occurrences with zone and UTC offset. Intervals are elapsed-time
cadence, anchored when enabled, replaced, started after runner readiness or
resumed after suspend/worker replacement. Ordinary unchanged saves and window
renders retain that anchor. Completion never shifts the cadence. A delayed tick
more than 1.5 seconds late is skipped; small timer latency does not change its
next due time. Forward/backward wall-clock jumps detected against the monotonic
clock reanchor future ticks. No missed interval/cron backlog is replayed.

## DST and parser policy

Dependencies are pinned to patched `cron-parser` **5.10.2** and Luxon **3.7.2**.
The [upstream parser API](https://github.com/harrisiirak/cron-parser#readme)
supports `CronExpressionParser.parse` and `next`; its six-field strict mode is
not the application's five-field contract. We validate the bounded numeric
five-field subset, prepend fixed zero seconds and deliberately use standard
DOM/DOW OR behavior.
[GHSA-r9w7-75q6-r884](https://github.com/harrisiirak/cron-parser/security/advisories/GHSA-r9w7-75q6-r884)
lists <=5.10.0 affected and 5.10.1 patched; 5.10.2 is the registry's current
compatible patched release checked during implementation.

The application's DST policy is **skip nonexistent local times; execute a
repeated local occurrence once**. It does not rely on the parser's default DST
normalization. The parser enumerates authored wall times in UTC, and Luxon's
zone-aware `fromObject` and `getPossibleOffsets` resolve them in the authored zone.
A normalized gap candidate is rejected by comparing its authored components;
only the earliest possible overlap instant qualifies. This also skips the second
instance if Decker starts/resumes halfway through a repeated hour. No handwritten
offset or transition arithmetic is used. A search is bounded to 512 candidates.

Concrete tests cover New York's missing `02:30` on 8 March 2026, its repeated
`01:30` on 1 November, Lord Howe's missing `02:15` on 4 October and repeated
`01:45` on 5 April (30-minute changes), Kolkata, leap days and distinct later
calendar dates. A daily New York preview spans `-04:00` to `-05:00` without
running the repeated local time twice.

## Execution, cancellation and local state

`main/scheduler.ts` exposes a reusable bounded `Scheduler` with injected wall
clock, monotonic clock, timer, occurrence claim/watermark, launch and publication
dependencies. `configure(document)` reconciles immutable definitions;
`ready(boolean)` gates launches until the current document is acknowledged;
`pause()` invalidates uncertain work on suspend/runner exit; `stop()` is terminal;
`snapshot()` returns at most 200 public status entries. The process creates one
instance and at most one timer (a <=1 second heartbeat, independent of the editor,
active deck/page and tray visibility). Standalone schedules remain separate from the implemented
[visible button refresh](visible-button-refresh.md); they have no button authority
and do not schedule toggle probing.

A schedule owns one pending/active launch. Overlapping ticks skip instead of
queueing; distinct schedules can overlap. Pending schedule launches are capped at
64 and the Engine's shared 64-root cap remains authoritative across every launch
source. Launch rejection clears busy status and exposes a fixed bounded reason.
Acceptance and settlement messages are independent of history batching/eviction.
Acceptance waits time out after ten seconds; late acceptance is explicitly
cancelled. Worker exit settles outstanding waits and pauses the scheduler.

Editing/replacing, disabling, deleting, confirmed import and shutdown invalidate
owned callbacks and cancel owned handles. Executable workflow/alias/connection
changes conservatively invalidate captured schedule definitions (including nested
calls). Obsolete acceptance/completion cannot change replacement state. Effects
already committed are retained. Resume/restart computes future occurrences only;
startup resumes only saved enabled schedules after the worker accepts the current
document. An unchanged whole-document editor save cannot re-enable a definition
that a newer explicit action disabled. Enable requests compare the expected saved
definition inside the shared mutation queue.

Local `schedule-watermarks.json` is separate from authored definitions and never
exported. Before launching, an atomic 0600 write, file fsync, rename and directory
fsync commits a per-schedule UTC high-water mark. A crash can skip an uncertain
occurrence, never replay it. Cron marks survive restart and clock rollback and apply
across edits to the same schedule ID; elapsed intervals always reanchor to their
new cadence rather than waiting for an old UTC mark; a disabled copy/import receives a fresh ID.
Only live IDs are retained on writes (max 200). Corrupt, unsupported or oversized
watermark files block scheduled effects until repair/restart and remain intact.
Runtime busy/status/skipped counters are bounded, memory-only and not exported.

## Launch context, migration and preservation

Main uses PR21's `DisplayState.accept("scheduled")` with no origin, display token
or selected deck. Worker accepts only the current saved enabled definition.
`context.source` gains optional backward-compatible metadata:

```json
{ "kind": "scheduled", "schedule": { "id": "uuid", "name": "Morning" } }
```

Root/nested contexts preserve this metadata, root/invocation IDs, and
`origin:null`. `inputs.context` cannot replace trusted context. History labels
scheduled runs with their schedule name and actual outcome; a skipped tick is
scheduler status, never a fake successful run. The data picker offers conditional
schedule ID/name fields with fallback. Existing history redaction and size limits
apply. Unbound button/display and deck-navigation actions fail usefully; there is
no implicit key, deck or display authority.

V6 adds `schedules: []` to defaults. Explicit v1–v5 decoders/migrations retain
aliases, toggles/appearance, managed credentials, navigation/brightness protection,
and PR21's independent version-1 display cache. Older workspaces gain no schedules.
Unsupported future workspace versions are backed up and block writes. Export
contains definitions and existing assets/placeholders; import rekeys and disables
every schedule, even after confirmation. Workflow duplication copies its schedules
with fresh IDs and disabled activation; deletion removes them. Schedule definition
validation participates in normal load/save/import/export validation. Remote
images and main image RPC abort transport remain PR22's responsibility.

## Verification and host acceptance

Fake-clock/service tests exercise parser/input bounds, concrete DST policy,
preview purity, overlap/capacity, definition epochs, failed/late launches,
activation, pause/resume/restart, shutdown, watermarks and v1–v5 migrations.
Electron tests create/edit/enable/disable/copy/delete through the UI, check invalid
states, previews and labelled unbound history, reload enabled definitions, mock
suspend/resume and execute with the window closed to tray. Their wall/monotonic
clock injection exists only in the test's main-process evaluation, with no
production clock hook or renderer execution capability. Full source and packaged
Electron, native, icon-notice and installer gates remain required.

Physical Stream Deck, actual OS suspend/clock changes, tray/desktop integration,
real OBS/MPRIS and keyring acceptance remain pending for the coordinator after
landing. No hardware verification is claimed.
