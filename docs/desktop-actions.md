# Desktop actions and button appearance

Select a key, choose **Copy text** from the action library and edit **Text**.
**Test action** executes it on the host; double-clicking the simulator key also
executes its saved assignment. **Hold simulated key** tests press/release/hold.

Edit **Label** and **Background** in key properties. Under **Icon**, open
**Lucide · …**, search the bundled pack and choose an icon; **Custom text / emoji**
is also available. **Choose image…** uses a host image file. Bundled Lucide artwork
is covered by the retained [third-party notices](../src/shared/icon-notices.txt).

Use **Open URL** for HTTP(S) addresses without embedded credentials and **Open file** for host paths. The file selector chooses an existing file and stores its absolute path; manual entry and workflow data references remain available. Relative paths resolve from Decker's application working directory, which can depend on how it was launched. Paths preserve spaces and Unicode, URLs cannot be opened as files, and desktop opening failures appear in run history. Saved **Open URL or file** assignments remain editable and executable without changing their action ID or schema version.

For action authors, `Field.type: "file"` with `picker: "openFile"` adds a native selector beside the normal literal or `$ref` editor. The desktop open-file request `{ type: "pickFile", picker: "openFile" }` returns an absolute path string or `null` on cancel; it accepts no caller-supplied filesystem options. `FilePickerButton` invalidates pending results when its document location, field, action configuration or editor navigation changes. The image asset picker remains separate. Paired browsers have only their existing key input protocol and cannot request this dialog.

`ActionDefinition.paletteVisible` defaults to visible. Setting it to `false` excludes an action from `paletteCatalog` and new assignment choices while retaining its definition in `catalog` / `actionById`, import validation and execution. Existing assignments include their hidden action in the editor selector. Future actions can reuse these field and visibility contracts without adding a migration to the current v7 workspace (the original feature shipped on v3).

Use the separate [media actions](media-actions.md),
[Increase / Decrease brightness](relative-brightness.md), and
[Read / Write / Append text file](text-file-actions.md) guides for their exact
fields and prerequisites. Hidden legacy combined actions remain editable and
executable in older saved workspaces; choose the separate actions for new keys.
