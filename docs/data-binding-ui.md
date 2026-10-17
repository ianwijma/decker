# Data binding UI and node audit (PR16)

Current workspace schema is **v7**; the binding UI originally shipped on v3.
Try the [working local data example](data-example.md). Names are presentation only: pickers emit segment-array
references containing the existing node IDs, so renaming never rewrites data
identity. Duplicate names receive local choice ordinals; advanced JSON and node
identity remain accessible.

## Binding context

The inspector uses `outputAvailability` extracted from the existing validator.
The dominator algorithm and validator fallback semantics are unchanged. The
picker additionally filters unreachable/downstream producers and respects graph
ancestry. Loop bodies and parallel branches inherit only data available at their
owner; sibling branches and body-local variables never leak into the parent.
Item/index appear only in a loop body. Set/map variables, inherited errors and
conditional outputs explicitly describe uncertainty and require fallback.

Presence is different from successful shape. A dominating HTTP producer can
return structured error data on its error edge. Its complete result remains
available, but its success fields are conditional wherever that error edge can
reach the consumer. Unknown dynamic fields are never invented as static schema.
Refining a path requires safe JSON segments and an explicit fallback; observed
preview paths are examples only.

Presentation metadata lives in `shared/data-presentation.ts`, separate from
catalog palette/brightness and OBS metadata. HTTP status/body/truncated, command
stdout/stderr/exitCode, app pid and Parse/Extract value fields have known types.
Other action outputs remain JSON with unknown shape. Resolved action schemas
remain the authority before effects. Text/path fields, native string arrays and
legacy encoded argv keep their existing contracts.

## Editing and the example

Create a workflow, then add HTTP request, Parse JSON, Extract value and
Notification from the node library. In Parse JSON choose **Whole value
reference**, search by the HTTP node's name, and insert **Complete result**.
This retains HTTP truncation provenance. In Extract choose Parse's **value**,
then enter a dot path or segment array in **Data path JSON**.

In Notification enter a literal prefix, select **Mixed text template**, add a
reference segment and choose Extract's **value**, then add literal suffix text.
The Electron acceptance test constructs this chain entirely in the UI, saves,
relaunches, and verifies mocked notifications for zero, false and null.

Modes are explicit. String-to-template preserves the literal string; other new
modes retain the original config until the user enters/inserts a value. Previous
valid mode drafts survive switching during the selected editor session. There
is no object/array-to-text conversion in whole references. Use a mixed template
or an explicit transform. Literal reserved objects are wrapped in `$literal`.
Advanced JSON preserves complex values, nested templates, transforms and
fallbacks. Native file picking stays available beside bound fields; its original
trust and stale-editor guards remain in force. Secret fields still return early
to ActionSecret.

Control nodes keep **Configuration JSON**, including switch cases/ports. The
configuration helper replaces only the explicitly selected field addressed by
JSON path segments, e.g. `["left"]`, `["items"]`, `["inputs","message"]` or
`["result"]`. It supports the same expression modes. Workflow declarations
remain editable as JSON; subflows retain the named selector and revision pin.

Future File Read/Write/Append actions can use generic text/path or JSON field
metadata and this same reference/template editor to pass fetched/extracted data
as file content. No file actions are added in PR16.

## Historical preview contract

The preview reads only existing sanitized Snapshot run records. It never queries
raw engine scopes or starts execution. It chooses the latest completed run for
the selected workflow (including UUID aliases), then matches both node ID and
the entire graph path. Runtime loop iterations and nested branch paths match the
editor ancestry; other workflows, sibling graphs and subflow paths are excluded.
Up to 50 matching records retain repetition/attempt identity in a searchable
execution selector. Stale revisions and missing records/data are explicit.

The display adds limits of depth 5, 120 visits, 20 children per object, 512
characters per string and 8,000 final characters. Upstream redaction/size/depth
markers and HTTP truncation are indicated. Run history may already have been
bounded even when no marker survives. Getter properties are never read.
Sensitive property names are masked again defensively. JSX text rendering
escapes HTML; there is no HTML interpreter or unbounded expandable value tree.
Observed path examples have independent depth/visit/count bounds and never
copy sample values into references. Preview selection does not touch canvas
status, live activity or cancellation.

## Node audit matrix

All nodes retain node timeout, bounded retries and cancellation checks. The
action validator still requires explicit retry-safe confirmation for
non-idempotent effects. Every kind retains Configuration/action serialization
and schema v3 reload. Existing engine/data/cancellation and all-node canvas
regressions provide runtime/ports evidence; PR16 adds context, mode, preview and
selected-field tests.

| Kind      | Config / resolved types and output                                                                                              | Ports / errors                            | Scope and execution evidence                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| trigger   | Returns native workflow inputs; declarations checked at invocation                                                              | next/error                                | Fresh root inputs/vars/outputs; declaration and UUID regressions                                            |
| action    | Resolved input schema before effect; known output metadata checked against each action output schema; unknown outputs stay JSON | next/error; recovery output is error data | Every catalog field audited, native/encoded argv preserved; credential, HTTP, media and desktop regressions |
| delay     | ms resolves with existing numeric duration semantics, 0–3600000; returns ms                                                     | next/error                                | Cancellable wait; run/node deadline and cancellation tests                                                  |
| condition | Native left/right; existing equals/notEquals/greater/less/contains/truthy semantics; returns boolean                            | true/false/error                          | Exactly one path; conditional availability/fallback tested                                                  |
| switch    | Native value; existing string port selection and configured cases; output is value                                              | named cases/default/error                 | Configuration JSON and dynamic handles preserved; all-node ports/save tests                                 |
| set       | Resolved config merges named values into vars; output is resolved config                                                        | next/error                                | Named typed variables; branch/iteration isolation and conditional overwrite uncertainty                     |
| parallel  | Existing fail-fast/collect config; indexed status/value/error results                                                           | next/error                                | Clone outer scope per branch; joins owned branches, cancels siblings on failure; sibling data excluded      |
| repeat    | Nonnegative count, static maxIterations 1–1000; array of body results                                                           | next/error                                | Bounded loop in one execution, not schedule; isolated item/index; cancellation/budget tests                 |
| foreach   | Native items array; static bounds and existing concurrency 1–16; array of results                                               | next/error                                | Isolated concurrent iterations, inherited outer availability; no body data leakage                          |
| subflow   | workflowId, pinned revision, mapped native inputs; returns child JSON matching declarations                                     | next/error                                | Immutable revision/alias snapshot; fresh child scope; recursion, declaration and cancellation tests         |
| return    | Resolved Configuration object; keys match declared workflow outputs                                                             | none                                      | Ends graph and returns native data; helper edits selected return fields without replacing config            |

Demonstrated editor defects fixed: all-other-node UUID dropdown offered unavailable
data; missing named typed fields; silent literal reset; bound native picker
compatibility; no template authoring controls; no scope/path/attempt-aware
historical inspector preview. The runtime scheduler and switch behavior are not
redesigned.

Follow-up: control-node validation intentionally retains existing coercions
(e.g. delay's numeric conversion) and static maxIterations/concurrency checks.
General resolved control-config schemas would be separate runtime work.
Ordinal duplicate-name labels can change on reorder; reference identity remains
stable. History cannot promise complete data or a dynamic output schema.

Host acceptance remains pending for physical Stream Deck, actual OBS,
OS keyring and real desktop notifications. The combined Electron regressions
cover the named OBS selector with binding modes and button/workflow palettes
after the PR09/PR12 merges. PR16 preserves those owners' regions and the
packaging/release gates. CI regression fixes wait for the committed uploaded
asset and the runner readiness handshake; existing assertions remain intact.
