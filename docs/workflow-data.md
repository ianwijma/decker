# Workflow JSON data and templates (PR15)

Current workspace schema is **v7**. This data grammar shipped on v3 and remains
compatible. Use action nodes and Set/map nodes to name values. Rich output pickers
and template controls are implemented in the [binding UI](data-binding-ui.md).
Try the [working local data example](data-example.md).

## Expressions

An expression is an entire JSON object with one reserved key:

- `{"$ref":"outputs.extract.value"}` resolves to the native JSON value. Arrays,
  objects, `false`, `0`, `""` and `null` keep their type. Only an absent path uses
  optional `fallback`, which is itself an expression or JSON value. Without a
  fallback, an absent path fails with `Missing data`.
- `{"$template":["Subscribers: ",{"$ref":"outputs.extract.value"},"."]}`
  concatenates resolved segments. Strings are used verbatim; other JSON values use
  compact JSON serialization (`null` → `"null"`, objects → `'{"key":1}'`, arrays →
  `'[1,false]'`). An empty segment array gives `""`. Nested templates work.
- `{"$literal":{"$ref":"this is literal JSON"}}` returns the enclosed JSON
  without interpreting any expressions inside it. This is the escape for literal
  objects containing `$ref`, `$template` or `$literal` keys.

Strings are always literal: `${value}`, `{{value}}`, backslashes, quotes,
JavaScript source and `$(command)` have no special meaning. No code, functions or
shell snippets are evaluated by this interpreter. The separate, explicitly
trusted Shell script action retains its existing shell semantics.

`$ref` allows only `$ref`, `fallback`, and `transform` keys. Existing transforms
`string`, `number`, `lowercase`, `uppercase`, and `length` retain their behavior.
`number` uses finite JavaScript numeric conversion; case transforms use string
conversion; `length` counts strings/arrays and returns zero for other JSON types.
`$template` and `$literal` allow only their own reserved key. Multiple reserved
keys, unknown extra keys, invalid paths/transforms and non-array templates are
errors, including in an unused fallback. Ordinary JSON objects and arrays are
recursively resolved. Reference results are data and are not reinterpreted as
expressions.

## Paths and validation

Legacy dot paths are unchanged: `outputs.parse.value.rows.0.count` traverses
nested own properties, including array indexes. Dots split segments; empty dot
segments continue to mean an empty property name. There is no new dot-path escape
syntax. For literal dots, backslashes, empty names or node IDs containing dots,
use a segment array:

```json
{ "$ref": ["outputs", "node.with.dots", "value", "rows", 0, "count.total"] }
```

Each segment is a string or non-negative safe integer index. A numeric segment
and its decimal string select the same property. All paths reject `__proto__`,
`prototype`, and `constructor`, even when a fallback exists. Traversal reads only
own data properties and rejects getters. Parsed/literal JSON also rejects those
three property names, getters and non-JSON values.

Validation and execution share the same grammar and path parser. Validation
walks references in templates and fallbacks, checks output availability using the
existing control-flow rules, and requires a fallback for a conditionally
available output. `$literal` contents do not declare dependencies. Literal
structured action fields are schema-checked; dynamic fields are checked after
resolution and before dispatching an effect. A boolean/object is not silently
accepted as notification text, a URL or an HTTP body: use a template or an explicit
`string` transform. Conditions, Set/map and loop data keep native JSON values.

Bounds are 32 levels of data depth, 10,000 traversal steps and a conservative
1,000,000-character budget per data/config/result operation, subject to the existing
1 MB node-output and 4 MB scope ceilings. Path strings and individual segments
are limited to 4,096 characters and paths to 64 segments. Templates allow at most
256 segments and share the data budget, including expanded references. Oversized
or excessively nested JSON is rejected rather than partially parsed. Existing
bounded/redacted run history is unchanged.

## Actions and output metadata

| Action                         | Resolved configuration                                                        | Output                                                |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| `http.request`                 | Existing URL, method, body, credentialRef strings                             | `{status: integer, body: string, truncated: boolean}` |
| `data.parseJson`               | `input`: JSON text string **or the complete HTTP envelope**                   | `{value: JSON}`                                       |
| `data.extract`                 | `input`: JSON; `path`: dot string or segment array; optional `fallback`: JSON | `{value: JSON}`                                       |
| `command.run`, `command.shell` | Existing fields; see argv below                                               | `{stdout: string, stderr: string, exitCode: integer}` |
| `app.launch`                   | Executable string and arguments                                               | `{pid: integer}`                                      |

`inputSchema` describes resolved action configuration. Data outputs intentionally
expose a dynamic JSON `value`, not a guessed static object shape. Extract uses
fallback only for absence; an existing `null`, `false`, zero or empty string is a
successful extraction. For root JSON, use Parse JSON's `value` directly.

Parse JSON rejects malformed text with a bounded message that does not echo the
response or secrets. Passing the HTTP envelope preserves truncation provenance:
`truncated: true` fails before parsing, even if the prefix happens to be valid
JSON. Passing a raw string, including just `outputs.http.body`, discards that
provenance; arbitrary truncation cannot be detected reliably from a raw string.

HTTP retains at most **16,384 source bytes**, decodes UTF-8 across chunk boundaries,
and uses lookahead to distinguish exact-boundary EOF from additional data.
`truncated` is true whenever bytes beyond the cap are observed. An incomplete
trailing UTF-8 codepoint is omitted on truncation. Readers are cancelled and their
locks released on every exit. Status/error behavior, AbortSignal cancellation,
credential authentication and secret-bearing redirect rejection stay intact.
HTTP never silently parses or replaces `body` with JSON.

Both `app.launch.args` and `command.run.args` accept a native `string[]` or the
legacy JSON-encoded string. Arrays must contain at most 256 strings. Native and
legacy forms are passed directly as argv without joining, shell expansion or
implicit coercion. `command.shell` retains its explicit `/bin/sh -c` behavior.

## HTTP → Parse JSON → Extract → Notification

Connect four action nodes with `next` edges. For a response such as
`{"stats":{"subscribers":0}}`, use these existing action configs:

```json
[
  {
    "type": "http.request",
    "version": 1,
    "config": {
      "url": "https://example.com/stats",
      "method": "GET",
      "body": "",
      "credentialRef": ""
    }
  },
  {
    "type": "data.parseJson",
    "version": 1,
    "config": { "input": { "$ref": "outputs.http" } }
  },
  {
    "type": "data.extract",
    "version": 1,
    "config": {
      "input": { "$ref": "outputs.parse.value" },
      "path": ["stats", "subscribers"]
    }
  },
  {
    "type": "desktop.notify",
    "version": 1,
    "config": {
      "title": "Stats",
      "body": {
        "$template": ["Subscribers: ", { "$ref": "outputs.extract.value" }, "."]
      }
    }
  }
]
```

The node IDs in this example are `http`, `parse`, `extract` and `notify`.
The notification body is `Subscribers: 0.`. Use Set/map for reusable names, e.g.
`{"subscribers":{"$ref":"outputs.extract.value"}}`, then reference
`vars.subscribers`. The binding UI and text-file actions use this contract without new node kinds.

The regressions use local HTTP fixtures, mocked notifications and a virtual
Electron display. Physical Stream Deck and real desktop notification acceptance
remain pending for the coordinator's consolidated host session.

Trigger context provides the read-only `context` namespace and workflow-only **Update triggering
button** action without changing the expression grammar. The original display contract shipped on v5.
See [Trigger context and dynamic display](trigger-context-display.md) for origin,
invocation/authority, clearing, cache and later scheduling/refresh contracts.
