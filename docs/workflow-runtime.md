# Workflow runtime contract

Actions on keys and graph nodes share the same versioned definitions and configuration schemas. The runtime uses XState promise actors for run lifecycles, a validated structured graph for control flow, and AbortSignals for cancellation. No arbitrary JavaScript is evaluated in field bindings.

```json
{"$ref":"outputs.node-id.body","fallback":"not available","transform":"uppercase"}
```

References can read `inputs`, `outputs`, `vars`, `item`, `index`, routed `error`, and read-only trusted `context`. Transformations: `string`, `number`, `lowercase`, `uppercase`, `length`. An output reference must be available on every path, or have an explicit fallback. Referencing data never executes a node again.

Condition operators are `equals`, `notEquals`, `greater`, `less`, `contains`, and `truthy`. Connect the `true`/`false` ports, or a switch's named/default ports. An unconnected selected port ends that branch. Connect an `error` port to recover from a failed node. Otherwise failures end the run.

Parallel defaults to fail-fast with cooperative sibling cancellation; `mode: "collect"` returns a result per branch. Repeat and For Each require `maxIterations` (1–1000). For Each supports bounded concurrency (1–16, default 1); each branch/iteration has isolated variables and ordered outputs. Each run has a timeout and a 10,000-node budget. Retries are bounded; non-idempotent actions require explicit opt-in. Subflow references pin revisions, reject recursive cycles, and snapshot all definitions at run start. Parent cancellation propagates.

Repeated key presses default to **ignore while running**. Queue, restart-after-cancellation and bounded concurrent policies are available in key properties. Keyboard/audio/OBS/conflicting command resources are serialized across flows. Press/release/hold trigger activity is coordinated separately so release handling can proceed during a press action. Cancellation cannot reverse external side effects already completed; app launches intentionally outlive their launching action.

See [data and templates](workflow-data.md), [binding UI](data-binding-ui.md),
[trigger context/display](trigger-context-display.md) and the [user guide](USER-GUIDE.md).
