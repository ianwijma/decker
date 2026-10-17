# Working HTTP → Parse JSON → Extract → Write text example

Use a fresh [temporary workspace](development.md) for this walkthrough. Import
**replaces the current workspace**; export/back up your existing workspace before
trying it there. Review imports and the file destination before confirming.

1. From a source checkout with dependencies installed, start the existing local
   fixture: `node docs/examples/visible-avatar.mjs`. It listens only on
   `http://127.0.0.1:8743`. No account or hardware is required.
2. In **Settings → General → Import**, choose
   [http-name-to-file.json](examples/http-name-to-file.json), review its actions and
   confirm **Import workspace**. It performs one local GET and writes
   `/tmp/decker-data-example.txt`. Change the **Write text file → Path** first if
   that file already matters to you; this action overwrites it.
3. Open **Flows**, choose **Fetch local name to file**, inspect the four connected
   nodes and click **Run workflow**. Alternatively select the **Data example**
   simulator and double-click its first key.
4. Check **Settings → Run history** for success and inspect the output file. With
   a newly started fixture it contains `Name: Local avatar 1` and a newline.
   `curl http://127.0.0.1:8743/next` changes the name; run again and verify the change.
5. Stop the fixture when finished. Running against a stopped server must fail,
   leaving the previous file intact; it must not invent fresh data.

Each node has one purpose:

| Node ID | Action and configuration | Output used by the next node |
| --- | --- | --- |
| `http` | HTTP request: GET `http://127.0.0.1:8743/api`, empty body, no credential | Complete `{status, body, truncated}` envelope |
| `parse` | Parse JSON: `{"input":{"$ref":"outputs.http"}}` | `outputs.parse.value` |
| `extract` | Extract value: `{"input":{"$ref":"outputs.parse.value"},"path":["name"]}` | `outputs.extract.value` |
| `write` | Write text file with a mixed template | `{"$template":["Name: ",{"$ref":"outputs.extract.value"},"\n"]}` |

Passing the complete HTTP result preserves truncation checking. Strings are literal;
JavaScript and `{{expressions}}` are not evaluated. Outputs must precede the consumer
on every path or have an explicit fallback. Use the UI's **Whole value reference**
and **Mixed text template** controls or advanced JSON. See the exact bounded
[data grammar](workflow-data.md) and [binding UI](data-binding-ui.md).
For a Notification variant, replace Write with Notification and use the same
mixed template as its body; real desktop notification delivery is a host check.
