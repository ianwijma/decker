# Workflow contract

A workflow is a versioned document with one Trigger, a DAG of execution edges, declared inputs/outputs and a run budget. Node configuration uses literal JSON or field bindings, not evaluated JavaScript. Canvas positions are separate from semantic configuration. Side effects run only through execution edges, once per visited node; reading an output does not invoke its producer.

| Node            | Configuration                                                  | Output ports / result                                                        |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Trigger         | Declared workflow inputs supplied at run time                  | `next`                                                                       |
| Action          | Shared catalog action and its fields                           | `next`, `error`; action result                                               |
| Delay           | `{"ms":1000}`                                                  | `next`, `error`                                                              |
| Set / Map       | `{"values":{"name":"value"}}`                                  | Updates this scope's variables; returns the mapped values                    |
| Condition       | `{"left":"{{inputs.ready}}","operator":"equals","right":true}` | Exactly one of `true` / `false`; `error` for failed evaluation               |
| Switch          | `{"value":"{{inputs.choice}}"}`                                | `case:<value>`, falling back to `default`                                    |
| Parallel / Join | `{"mode":"fail-fast"}` or `{"mode":"collect"}`                 | Each `branch:<name>` runs independently; `next` runs after the explicit join |
| Repeat          | `{"count":3,"maxIterations":100,"concurrency":1}`              | `body` runs with `item` / `index`; `next` after all iterations               |
| For Each        | `{"items":[1,2,3],"maxIterations":100,"concurrency":1}`        | Same structured body contract; concurrency can be 1–16                       |
| Call Subflow    | `{"workflowId":"...","revision":1,"input":{}}`                 | Pinned revision, isolated input/output scope; parent cancellation propagates |
| Return          | `{"value":"{{vars}}"}`                                         | Ends the current branch, iteration or subflow and returns JSON               |

A Parallel node is an explicit fork and all-join group. Each branch uses separate nodes and ends without linking into the continuation. Connect `next` directly from Parallel to the next step. Nested Parallel nodes create independent joins. Results are keyed by branch name with `status` and `output` / `error`. A skipped condition path has a defined result without executing the unselected path. Fail-fast aborts siblings and waits for cooperative cleanup with a bound; collect mode retains failures as data.

Loops use the same structure: connect `body` to a separate body graph, and connect `next` to the continuation. Bodies must not connect to the continuation. Each iteration has isolated variables and node outputs, with `item` and `index` supplied. Results are ordered by iteration, even when bounded concurrency is enabled. Maximum iterations is 1–1000 and each run's trace is limited to 1000 node executions. Arbitrary canvas backedges are rejected.

Subflow inputs and outputs are checked against declared fields. Recursive call cycles are rejected. All workflow definitions and referenced revisions are cloned when a run starts, including queued requests. Editing a child requires repinning its callers to the new revision before saving; old runs retain their existing snapshots. Child and parent timeouts apply together.

## Data bindings

- `{{inputs.name}}`, `{{vars.name}}`, `{{nodes.node-id.field}}`, `{{item}}`, `{{index}}`
- `{{nodes.maybe-skipped.field|fallback}}` uses an explicit literal fallback. The fallback can be JSON, such as `false` or `0`.
- Strings may interpolate bindings; an entire field consisting of one binding preserves its JSON type.
- Built-in mapping: `{"$transform":"upper","value":"{{inputs.name}}"}`. Supported transforms are `upper`, `lower`, `length`, `number`, and `string`.
- Errors routed through `error` expose `{{error.message}}` and `{{error.nodeId}}`.

A producer must dominate the consumer on all selected execution paths, or the reference requires a fallback. Isolated branches cannot directly reference another branch's output. Read a joined group's keyed result after its `next` edge instead.

## Execution and concurrency

Each key selects ignore while running (default), bounded FIFO, cancel-and-restart, or bounded concurrent runs. Queue/concurrency limits are 1–16. Press and release are separate event groups so a long-running press does not swallow a configured release action. Long press takes precedence over short press; when both exist, short press is resolved at release if the threshold was not reached. The binding and page generation are captured at down time. Disconnect clears held state and timers.

Keyboard operations serialize globally. Command/script actions serialize by their configured resource name; audio writes serialize on the audio resource. Up to 64 runs can be active. Node timeouts, run timeouts, explicit cancellation and bounded retries propagate abort signals to delays, HTTP requests, processes, sibling work and subflows. A shell subprocess runs in its own POSIX process group so cancellation can terminate descendants. Launched applications are separate completed side effects and remain open.

Retries default to zero. Enabling them requires an explicit acknowledgement that the operation is safe to retry. Completed external side effects cannot be reversed. Cancellation bounds cleanup for an integration that fails to cooperate and stops future nodes. Run IDs and captured configuration generations keep obsolete executions from repainting reassigned keys; concurrent feedback follows the latest run on that binding.

## Action examples

- Command: executable `echo`, args `["Hello"]`. Arguments are passed as an array. Shell syntax belongs only in the explicit Shell script action.
- Shortcut: `ctrl+alt+t` (xdotool key syntax).
- Microphone mute: operation `mute`, target `source`, value `true`.
- Volume: operation `volume`, target `sink`, value `50` (percent).
- Audio device: operation `device`, target `sink`, device containing a wpctl node ID or pactl name.
- OBS scene: request `SetCurrentProgramScene`, data `{"sceneName":"Main"}`.
- OBS source: `SetSceneItemEnabled`, data `{"sceneName":"Main","sceneItemId":1,"sceneItemEnabled":true}`.
- OBS input: `SetInputMute`, data `{"inputName":"Mic","inputMuted":true}`.
- OBS output: `StartRecord`, `StopRecord`, `StartStream`, `StopStream`, with empty data.
- HTTP health check: request → Condition on `{{nodes.health.ok}}` → success/failure Appearance action.
