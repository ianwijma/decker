# Toggle runtime (PR18 / schema v4)

PR18 owns v4. PR17 file actions, scheduling, the full toggle editor, two-state
appearance, dynamic images and physical hardware acceptance are separate work.
Ordinary Run workflow bindings retain activity-only behavior and observed media
feedback is unchanged.

## Document contract for PR19

A binding optionally has `toggle`. Its existing identity is `id` + `generation`;
its runtime scope is `JSON.stringify([deckId, id, generation])`.

```json
{
  "toggle": {
    "on": {
      "kind": "action",
      "action": {
        "type": "command.run",
        "version": 1,
        "config": { "executable": "/path/to/enable", "args": [], "cwd": "" }
      }
    },
    "off": { "kind": "workflow", "workflowId": "existing-workflow-uuid" },
    "source": { "kind": "app", "initial": "off" }
  }
}
```

Both targets use existing action/sequence/workflow targets. External source is
`{kind:"external", probe:Target, timeoutMs:10000}` (10–60000 ms). The probe's
purpose is to **observe state without effects**. Prefer a command or a workflow
that returns the documented result below. Commands/workflows are user-authored;
the application cannot enforce that they are read-only. PR19 must label this
purpose and must never execute a probe while rendering/editing a draft.

Toggle mode owns input. Combining toggle with ordinary `press`, `release` or
`longPress` is a validation error; no saved assignment is silently removed. PR19
must ask the user to resolve these conflicts explicitly. Press-down emits exactly
one toggle request, release does not toggle, and repeated down from a held source
is ignored. Desktop test, simulator, physical input and approved web input reach
the same runner service. The runner resolves the **configured** binding identity;
a detached renderer/import binding cannot supply toggle targets for execution.

`bindingTargets` visits ordinary phases and `toggle.on`, `toggle.off`,
`toggle.probe`. Profile navigation copying, import validation and credential owner
addresses use it. Workflow targets keep UUIDs/legacy aliases; nested workflows
use existing pinned immutable definitions and invocation-aware cancellation.
Workflow credential owners continue to be visited through their graph/body/branch
addresses. Toggle action owners use opaque paths such as
`["binding",bindingId,"toggle.on","action"]` and sequence offsets. Existing
owner+epoch mutation and import/export rekeying apply without exposing values.

The explicit v3 decoder uses pre-toggle bindings. Migration is ordered
v1→v2→workflow UUID v3→v4, or v2→v3→v4, or v3→v4. Existing documents gain no
toggles and keep their assignments. Local v4 saves use the current schema;
unsupported future versions are backed up and block writes rather than being
parsed through a stripping decoder. Exports contain configuration/assets and
credential placeholders, **no runtime state**. Import allocates fresh toggle
binding IDs/generation zero, and profile copying allocates fresh binding IDs
while retaining valid workflow/credential sharing and remapping navigation.

## Runtime API and state

`runtime/toggles.ts` exposes `Toggles.configure(document, activate?)`,
`press(deckId,{id,generation})`, `reconcile(deckId,bindingId)`,
`recover(deckId,bindingId,confirmed)`, `snapshot()`, `settled()` (initialization)
and `stop()`. It delegates execution to the same Engine used by Coordinator;
ordinary Coordinator policies and ResourceLocks are unchanged. Each toggle owns
one serialization slot spanning prepare, target, commit and reconciliation.
Busy presses and overlapping reconciliation requests are ignored, irrespective
of the binding's ordinary queue/concurrent policy. Other bindings/decks proceed
independently, subject to the shared 64-active-run cap, including private probes.

`shared/toggle-contract.ts` defines the PR19 public `ToggleState`, surfaced as
`Snapshot.toggles` (optional for snapshot compatibility, up to 4096 entries):

- `deckId`, `bindingId`, `generation` identify the configured owner.
- `confirmed`: `on`, `off` or `unknown`, separate from workflow activity/history.
- `transitioning`, `reconciling`: target/probe work, not confirmed-state guesses.
- `fresh`: last observation is usable now; `blocked`: uncertain durable commit.
- `error`: fixed bounded code, never raw command output or exception text.

App-managed bindings start from authored `initial` unless a matching local durable
record exists. An accepted press chooses the opposite **confirmed** state.
Success plus durable commit advances state; failure/cancellation/timeout retain
confirmed state and expose an error. Cancellation never runs the opposite target
or takes cancellation retry/error edges. It releases the slot when the existing
bounded adapter cleanup settles. Invocation-aware workflow cancellation reaches
nested toggle roots as well as ordinary/standalone runs; normal activity clears
independently. History eviction cannot lose the live toggle state.

External bindings are unknown until a valid authorized observation. Stored last
confirmed external state is retained as **stale**, never used for ambiguous
presses before reconciliation. A failed/invalid probe retains that last state,
sets `fresh:false`, and disables presses. An authorized target success does not
advance external state by itself. After success, failure or timeout, a new probe
observes the result: disagreement publishes the actual observation with
`probe-disagreed`; probe failure retains the previous confirmation as stale.
Cancellation does not launch an additional probe: explicit reconciliation or
activation can recover freshness later. External truth remains authoritative.

## Probe result and private Engine result contract

`RunHandle.done` still resolves a redacted RunRecord. New trusted-only
`RunHandle.result` resolves a discriminated `ExecutionResult`:

- `{status:"success",output:{status:"available",value:Json}}`, or output status
  `unavailable`, `oversized`, `invalid`.
- `{status:"failure"|"cancelled"|"timeout"}` without raw exception/output data.

Result copies are bounded to 65536 UTF-8 JSON bytes, depth 16 and 4096 visits.
They are not sourced from redacted history. Existing workflow declarations,
output schemas, nested return semantics and data grammar remain in force. Missing
or oversized output is explicit, not an empty-string fallback.

A valid probe result is a native boolean, the exact string `on`/`off`, or a
workflow return object containing **only** `{on:boolean}`. A command envelope
`{stdout,stderr,exitCode}` with `exitCode:0` accepts stdout (at most 1024 characters)
trimmed to exactly `on`, `off`, `true`, or `false`. Case, numbers, empty text,
malformed JSON-like text, nonzero exit, timeout and oversized output are invalid;
there is no general truthiness or silent default to off. Workflow outputs must
still match their declarations (e.g. declare output `on` for `{on:boolean}`).

Engine `privateResult` executions suppress publishing records and suppress
input/output trace data. All probe execution, including nested workflows, uses
this path. Raw probe results never enter snapshots, web IPC, history, logs or
button activity. Only fixed state/error codes leave the runner. Web clients
continue receiving display views and scoped input capability, not toggle store
records or arbitrary execution APIs. Normal execution history remains bounded
and redacted as before.

## Durable state and uncertain effects

Main owns `toggles.json`, separate from config/history and renderer save payloads.
Format: `{version:1, entries:[{key,stamp,confirmed?,pending?}]}`. `stamp` is SHA-256
of toggle configuration; `key` includes deck/binding/generation. No output or
credential value is stored. At most 4096 live records are retained; obsolete
identities are pruned on writes. Invalid/oversized files block writes and are
preserved for repair.

Before a target can run, main atomically commits the previous confirmation and a
fresh pending transition token. After settlement it commits confirmation and
removes that token. Files use exclusive 0600 temporary creation, file fsync,
atomic rename and directory fsync. State operations use the existing serialized
main document mutation queue and recheck the live binding/stamp there. Ordinary
cancellation remains outside that queue; a delayed main navigation/brightness
request still rejects a settled run. Credential, OBS, brightness and navigation
save semantics are preserved.

If prepare fails, no target runs. If a target succeeds but its final commit fails,
confirmation does not advance in the service, `blocked:true`/`storage` is exposed,
and subsequent presses are refused. On crash/restart a pending token means
`interrupted`, never automatic replay. App-managed recovery requires the explicit
trusted desktop `recoverToggle` request with a user-verified `on`/`off`; this
acknowledges state without executing a target. Storage faults must be repaired
and the application restarted before recovery. External bindings can recover
through a valid read-only observation. A final rename whose fsync outcome is
uncertain may survive restart; the service still blocks during the failing
session and never automatically repeats an effect.

Replacement/removal/generation/config changes invalidate old entry objects and
cancel their handles. Every asynchronous completion rechecks validity; main
rejects queued storage commits for stale identities. Relevant captured workflow
revisions, aliases and connection configuration are fingerprinted, so a changed
definition invalidates in-flight work. Unrelated workflow edits/background saves
do not trigger probes. The configuration snapshot is immutable and shared by
entries, not multiplied per key. New generations initialize from their own state;
old generation records never update new bindings.

## Activation and later scheduling

Startup and runner restart authorize probes for the saved workspace. System
resume explicitly activates reconciliation. Successful **confirmed import** is
workspace activation under the existing review/backup dialog policy; parsing,
review, export, copying profiles, editor rendering and ordinary saves never
execute probes. Newly saved/reconfigured external bindings remain stale/unknown
until explicit activation, explicit reconciliation, or next startup. Existing
unchanged entries keep freshness through unrelated saves.

Trusted desktop requests are `activateToggles`,
`reconcileToggle {deckId,bindingId}`, and
`recoverToggle {deckId,bindingId,confirmed}`. These are runtime seams for PR19 and
later scheduling; no periodic refresh timer is added. Busy activation or
reconciliation can be retried after the active operation settles. Existing
OBS/media diagnostic timers are unchanged. Stop cancels target/probe handles,
invalidates entries and settles outstanding storage RPC waits; runner restart
reads pending tokens without replaying effects.

Tests cover fixture commands/targets, migration/persistence/credentials, durable
failure, identity replacement, concurrent inputs, private results, cancellation,
external drift and Electron simulator/paired-web routing. CI retains source and
packaged Electron interaction, native smoke, notices and Linux installer checks.
Physical Stream Deck, real OBS/MPRIS/keyring and host desktop acceptance remain
pending for the coordinator's consolidated hardware session.
