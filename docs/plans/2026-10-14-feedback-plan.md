# Decker feedback implementation plan

Status and reading guide: [implementation and acceptance records](README.md). The design and baseline findings below are preserved from planning; all 26 original items have since merged. Consult the dated closing updates for remaining acceptance work.

Turn the 14 October 2026 exploration feedback into 26 bounded PRs against `develop`. Deliver reliability and navigation improvements first, then workflow data, toggles, schedules and dynamic buttons. All implementation agents use **GPT6.1 SOL with HIGH reasoning** and assume **no physical hardware access**. After all selected changes land on `develop`, run one consolidated host acceptance session, followed by focused retests of any fixes it uncovers.

The planning pass started no implementation agents or PRs. The user subsequently authorized implementation as separate tasks in the ChatGPT desktop app, each using Codex Cloud's published `decker` environment and GPT6.1 SOL/HIGH. Release publication remains governed by the gates below. Track actual task creation and PR links in the [launch record](2026-10-14-feedback-launch.md); prepared briefs are not evidence that agents have started. The [hardware evidence](2026-10-14-hardware-evidence.md) is ready for agents to use without needing the device.

## Scope decisions

- Keep the left rail and use its top button for a new **Home** health overview. This supersedes the earlier suggestion to remove the button.
- Keep the existing flow configuration JSON editor. Add focused data-reference tools where required; do not redesign every node inspector.
- Keep the switch node's behavior and ports. Include it in regression coverage, without a switch redesign.
- Use real searchable dropdowns for flows and profiles: search lives inside an opened dropdown, with a selected item visible when closed.
- Keep Web decks as a separate settings section. Promote Run history to a peer of General, Web decks and Diagnostics. Preserve accent controls, startup/history preferences and import/export.
- Remove **Change key appearance** from the ordinary button action palette. Preserve compatibility with saved actions and expose **Update triggering button** as a workflow action for the later dynamic-button feature. This reconciles the two appearance requests.
- Offer explicit media actions and Increase/Decrease brightness. Retain support for existing combined media and absolute-brightness actions in saved workspaces.
- Start icon packs with Lucide, already used by the app. Allow a later pack registry without requiring a plugin marketplace.
- Treat toggles as an optional button mode. Workflow running/success/cancel feedback remains temporary activity feedback, not an on/off value.
- Build data-driven buttons with the existing local workflow engine. A new plugin execution system is unnecessary for the requested examples.
- Interpret “nightly” as a development prerelease for every successful push to `develop`, including PR merges. A once-per-night cron build would not satisfy “as soon as a PR is merged.”
- Interpret “CR workflow” as a CI release workflow and “image” as the existing AppImage, alongside the Debian binary. Docker images are outside this request.
- Planning default for stable releases: promote the tested `develop` revision to `main`, then manually dispatch a versioned release. The repository currently uses `develop` as its default branch and has no `main` branch in the inspected refs; stable-branch setup is an explicit adoption step. A user preference for releasing a selected `develop` SHA can replace this policy without changing the implementation PR base.

## Existing implementation and confirmed findings — 14 October baseline

Baseline: `develop` at `b57bd05d09119c4bb746b77909393791afc1b942`. Local HEAD and the cached `origin/develop` match. The latest [CI run](https://github.com/ianwijma/decker/actions/runs/38518676962) succeeded on this SHA. All **47 tests across six files** passed when run on the host. The sandbox run failed because networking/interface enumeration and subprocess behavior were restricted; do not treat those sandbox failures as product regressions.

| Finding | Evidence and consequence |
| --- | --- |
| Hardware exists and matches the saved configuration | XL `0fd9:006c`, 32 keys, 96 px images; configured serial identity matches. Read/write open fails with errno 13. See hardware evidence. |
| Hardware readiness is reported too early | `src/device/worker.ts` sets `connected: true` during enumeration, before open. Fix status semantics and test failed opens. |
| Rendering infrastructure is already implemented | `src/main/index.ts`, `src/device/worker.ts`, `src/device/images.ts` already produce and write key frames. Repair permission guidance, readiness and recovery before considering a new driver. |
| Flow dragging has a concrete investigation target | `Flows.tsx` recreates controlled node arrays and ignores `dimensions` changes. It also receives frequent whole snapshots through `store.ts`. These are source-based suspects for flicker and missing minimap nodes, not yet a reproduced root cause. |
| UUID generation mostly exists | `uid()` uses `crypto.randomUUID()`. The bundled workflow uses `welcome`, and schemas/imports accept legacy identifiers. Fix defaults and migration rather than replacing every identifier system. |
| Workflow selection is inconsistent | `TargetEditor` has a workflow selector, while `workflow.run` and `workflow.cancel` action fields request raw IDs. Unify them. |
| Cancellation can miss embedded workflows | A key's Run workflow action becomes a root workflow named `direct`; the requested workflow executes inside that root. Cancellation matches root record IDs only. A direct workflow assignment follows a different path. Add regression coverage for both. |
| Data references already exist | `runtime/data.ts` resolves typed `$ref` values; set/map, conditions, loops, parallel branches and subflows exist. HTTP currently returns a bounded text body, not parsed JSON. Output metadata is largely `unknown`. |
| External state is already observed | MPRIS, audio and OBS feed `shared/feedback.ts`. Extend observed-state behavior instead of pretending each press reveals actual playback or mute state. |
| Appearance overrides already exist | `deck.appearance` changes label/background using triggering binding context, but uses transient feedback and lacks image updates and complete persistent display-state semantics. |
| Release building already exists | CI tests and packages `.deb` and AppImage and uploads workflow artifacts. It does not publish GitHub releases; no releases were listed during research. |
| README contains stale facts | GitHub reports this repository as public, while README says private. No repository license file was found; public visibility alone does not establish an open-source license. Correct facts without inventing licensing terms. |

## Parallel execution and PR rules

Each numbered item below is one implementation PR, with a `codex/<short-topic>` branch created from the latest `origin/develop`. Every PR targets `develop`, including release tooling. Required predecessors must merge before dependent PRs are finalized; do not base PRs on another agent's unmerged branch. Agents may prepare independent new modules against an agreed contract while a predecessor is reviewed.

Use up to three implementation agents plus a coordinating reviewer in this environment. All use GPT6.1 SOL/HIGH. Keep the hardware accessible only to the coordinating host agent. Start with **PR01 hardware**, **PR04 canvas**, and **PR24 nightly pipeline** in parallel. Next take **PR02 diagnostics**, **PR05 flow/profile selectors**, and **PR25 release pipeline**. Fill later slots from the dependency table, respecting shared-file ownership.

| Work lane | Items | Primary ownership |
| --- | --- | --- |
| Hardware and health | 01 → 02 → 03 | Device transport, health models, Home and discovery |
| Editing and actions | 04 → 05 → 06; 07; 10 → 11 → 12; 13 | Flow/deck editors, fields, catalog presentation |
| Connections | 08 → 09 | Credentials, OBS connection UI and tests |
| Runtime and data | 14 → 15 → 16; 17; 18 → 19 | Cancellation, data, file operations, toggle state |
| Scheduled displays | 20; 21 → 22 → 23 | Scheduling, origin context, appearance and refresh lifecycle |
| Delivery and documentation | 24 → 25; 26 | CI, artifacts, releases, quick start |

The repository has several large shared files. Parallel readiness does not mean concurrent edits to the same integration point are safe. Before dispatch, assign temporary ownership of `shared/schema.ts`, `shared/catalog.ts`, `main/index.ts`, `runtime/worker.ts`, `renderer/src/components.tsx`, `Flows.tsx`, `Deck.tsx`, and `styles.css`. Prefer new focused modules and stylesheets, with small integration patches. Queue the shared-file patch behind the current owner's merge; rebase and rerun affected tests. Do not combine unrelated feature work into one large refactor to avoid conflicts.

Wave-eight integration ordering: PR19 owns schema v5 and the shared appearance composition contract after PR18/v4. PR20 scheduling waits for that migration; PR21 waits for PR19’s composition contract before changing the same display path. A separate focused repair PR addresses the three Electron regressions exposed by the wave-seven merged develop build; it owns the affected regression fixtures, not feature/schema work.

Wave-nine integration ordering: PR19 / GitHub #30 and the focused CI repair / #29 are merged, with successful PR checks. Launch PR21 alone to establish the trusted execution-source/trigger-context and dynamic display-cache interfaces. PR20 shares engine/worker launch plumbing and waits for this merge; PR22 needs the display/asset reference contract. This preserves independent tasks without competing runtime changes. After PR21 merges, evaluate PR20 and PR22 for parallel ownership against their concrete interfaces. PR21 should keep workspace schema v5 and use a separately versioned runtime cache; allocate a new workspace migration only if a justified authored field requires one. PR23 and PR26 retain their downstream prerequisites.

Wave-ten integration ordering: PR21 / GitHub #31 is merged with successful required CI and retains workspace schema v5. Launch PR20 scheduling and PR22 remote images independently against this baseline. PR20 exclusively owns schema v6, scheduling lifecycle/run-source metadata and cron dependency changes. PR22 owns image download/decode/ingestion, generated-asset retention, main-RPC abort transport and asset-specific persistence paths without a workspace migration. Shared main/worker/persistence files are divided by region in both briefs. PR20 reuses unbound `DisplayState.accept("scheduled")`; PR22 reuses `DisplayState.assetReferences()` and existing display authority. Both can build and merge without an unmerged sibling. PR23 waits for both; PR26 follows remaining user-facing work.

Wave-eleven integration ordering: PR20 / GitHub #32 and PR22 / GitHub #33 are merged, with successful required PR checks. Launch PR23 alone against the combined schema-v6 baseline. It exclusively owns schema v7, refresh configuration, surface visibility leases, refresh launch/settlement, lifecycle integration and focused editor/status UI. Reuse PR20's injected-clock and acknowledged-launch patterns without treating button refresh as a persisted unbound schedule; reuse PR21's trusted refresh origin and PR22's cancellation/pinning contract. Hardware readiness must identify the applied page, and web visibility needs an authenticated current-view acknowledgement with bounded freshness. Preserve independent press/toggle execution and confirmed state when refresh settings change. PR26 remains queued until this final user-facing feature merges, preserving the user's independent-task preference. Required CI must pass on the final pushed PR head; physical acceptance stays in the consolidated host session.

Wave-twelve integration ordering: PR23 / GitHub #34 is merged with successful required CI on its final head. Launch PR26 alone from the current schema-v7 develop baseline. It owns the quick start, linked current guides, real-app screenshots, verified examples/download links and acceptance checklist reconciliation; no source feature or migration is allocated. Published development installers exist, while no stable release exists at preparation. The repository is public but has no granted open-source license; npm's private flag does not describe repository visibility. Required CI must be green on PR26's final pushed head. After its reviewed merge, the next stage is consolidated coordinator-host acceptance, not another planned feature wave or automatic stable publication.

Persisted schema changes use ordered migrations. PR06 introduces the next migration after v2; later toggle/schedule/display changes append migrations in merge order as needed. No two agents may independently claim the same schema version. Old unknown feature documents must produce a clear version error and backup rather than silently discarding data. Each migration covers load, import, export, reload and older supported schemas.

Before dispatch, commit this plan/evidence to a shared repository revision or include their full relevant contents in each task. Do not assume another checkout can see local uncommitted documentation.

## PR dependency index

Dependencies describe required behavior/contracts. Shared-file ownership can impose additional merge ordering.

| PR | Deliverable | Depends on | Priority |
| --- | --- | --- | --- |
| 01 | Truthful hardware status and display recovery | — | P0 |
| 02 | Structured diagnostics and repair guidance | 01 | P0 |
| 03 | Home health dashboard and discovery prompt | 01, 02 | P1 |
| 04 | Stable flow canvas and working minimap | — | P0 |
| 05 | Searchable flow/profile selectors and flow naming | 04 | P1 |
| 06 | Hidden workflow UUIDs and consistent selectors | 05 | P1 |
| 07 | Settings navigation cleanup | — | P1 |
| 08 | Managed secrets with inline entry | 06 | P1 |
| 09 | OBS setup guidance and Test connection | 08 | P1 |
| 10 | Separate Open URL and Open file actions | 06 | P1 |
| 11 | Separate media actions and observed feedback | 10 | P1 |
| 12 | Relative brightness and appearance palette scope | 11 | P1 |
| 13 | First icon pack and consistent rendering | 05 | P1 |
| 14 | Reliable workflow cancellation and button reset | — | P0 |
| 15 | JSON data operations and text templates | 06, 14 | P1 |
| 16 | Data binding UI and workflow node audit | 04, 06, 15 | P1 |
| 17 | Read, write and append text files | 10, 15 | P1 |
| 18 | Toggle runtime and state reconciliation | 14, 15 | P2 |
| 19 | Toggle button editor and observed-state UI | 11, 13, 18 | P2 |
| 20 | Explicit workflow schedules | 06, 14, 15 | P2 |
| 21 | Trigger context and workflow button appearance | 12, 13, 14, 15, 18, 19 | P2 |
| 22 | Bounded remote image assets | 13, 21 | P2 |
| 23 | Refresh workflows while buttons are visible | 19, 20, 21, 22 | P2 |
| 24 | Development prereleases after develop builds | — | P1 |
| 25 | Tagged stable release workflow and PR notes | 24 | P1 |
| 26 | Quick start and current user documentation | All user-facing items and 24–25 | P1 |

## Hardware and health work

### PR01 Truthful hardware status and display recovery

**Outcome:** A discovered XL that cannot open says Permission required. A ready deck receives the configured page and brightness, and recovers after reconnect or a recoverable write failure.

Own `src/device/worker.ts`, `src/device/images.ts`, a new testable device-session module, the device status contract, and minimal main-process plumbing. Separate physical presence from configured/open/ready/error state. Use states such as discovered, opening, ready, permission-denied, busy, I/O-error and disconnected, with device-specific error details and timestamps. Native-driver readiness must not imply that a particular device works.

Mark ready only after opening and completing the initial frame/brightness writes. Track last successful write without claiming physical pixel readback. Retry transient failures with bounded backoff; reset cached desired images on a fresh connection. Preserve serial identity when hidraw paths change, serialize/coalesce writes, clear held keys on loss, and never write unconfigured devices. Publish disconnect/error transitions promptly.

**Acceptance:** Fake transport tests reproduce the exact discovery-success/open-EACCES incident, open success/write failure, reconnect, changed path, page changes, brightness changes and two independent decks. Software can prove intended frames and events; mark physical image/input acceptance pending.

### PR02 Structured diagnostics and repair guidance

**Outcome:** Every actionable fault has a clear cause, affected feature, suggested remedy and Retry; unrelated errors do not overwrite each other.

Own a shared health model and remediation registry, Linux probes and the Diagnostics renderer. Model healthy, idle, unconfigured, degraded and unavailable separately. Distinguish missing binaries from an installed service that is stopped, unsupported Wayland input, no MPRIS player and OBS not configured. Keep the raw observed-state disclosure, with secret redaction and bounded repeated errors.

For hardware, use PR01's per-device faults and the evidence document. Show permissions and detected ownership/rule hints, with model-scoped desktop udev guidance. For missing tools, show distribution-appropriate commands or documentation and copy/open controls. Installing from the UI is technically possible but requires an authenticated privileged helper and distribution handling; this scope provides guided repair and rechecks. Never present starting OBS or a media player as installing a missing dependency.

**Acceptance:** Fixtures cover each remedy category, simultaneous faults, recovery clearing stale errors and unknown distributions. Suggested text cannot be executed as arbitrary shell content. Diagnostics remain useful without hardware or an active desktop bus.

### PR03 Home health dashboard and discovery prompt

**Outcome:** The top rail button opens Home with deck readiness, relevant tools/integrations, current errors and repair links. Unknown hardware appears immediately above Add deck.

Own new Home/health components, the rail and small store routing changes. Reuse PR02's health data and remedies. Show all configured decks with honest states, including web sharing and browser presence as separate facts. Use a warning summary for broken configured features; optional unconfigured integrations should not make the whole app appear broken.

Add an accent-colored “New Stream Deck detected — Add” prompt for unconfigured discovered hardware. Use restrained pulsation only when reduced-motion preferences permit. Selecting it opens the existing add flow prefilled for that device. Deduplicate by serial identity and handle multiple new devices, unplugging before addition, and devices already configured. Do not automatically add hardware.

**Acceptance:** Renderer fixtures cover empty, healthy, permission-blocked and mixed states. Keyboard navigation works. Adding a device removes only its prompt; selecting a deck still opens that deck. Home and Diagnostics agree on status and remedies.

## Editing and action work

### PR04 Stable flow canvas and working minimap

**Outcome:** Dragging nodes is visually stable, positions persist, and minimap nodes appear at the right positions.

Own `Flows.tsx`, focused flow styles, canvas/store selectors and editor tests. Reproduce dragging under incoming device/observed-state snapshots. Investigate ignored dimension changes, controlled-node reconstruction, local position lifetime and unnecessary snapshot subscriptions. Preserve React Flow measurement/state updates; persist only actual layout changes, without feeding a save loop into every drag event. Keep viewport state stable and reset graph-specific position state when switching workflows or nested scopes.

Audit each existing node kind for regression behavior: trigger, delay, condition, switch, set, parallel, repeat, foreach, subflow, return and shared action nodes. This PR owns canvas/ports, not new node semantics. In particular preserve dynamic switch case handles, default/error ports and nested canvases.

**Acceptance:** E2E drag tests under synthetic snapshot updates, visible minimap rectangles, reload position preservation, nested graph navigation, multi-select/delete and zoom/pan. Include visual observation or a recording for flicker; a final-position assertion alone does not prove it is fixed.

### PR05 Searchable flow and profile selectors and flow naming

**Outcome:** Many flows/profiles no longer push their libraries down the page. Creating a workflow selects it and focuses its name at the top.

Own a reusable accessible searchable dropdown, flow/profile selector integration and flow toolbar. Keep search inside the open dropdown; show the selected value when closed. Support keyboard arrows, Enter, Escape, focus return, no results, duplicate names and enough rows to exercise 50+ items. Profile options must belong to the selected deck.

Move flow-name editing to the toolbar and remove the duplicate inspector name field. New flows still contain Deck press, but start with no node selected and the name selected for editing. Preserve runtime timeout, declarations, test inputs and the node library. Newly created profiles select immediately.

**Acceptance:** E2E tests with 50 flows and 50 profiles, create/rename/switch/reload, dropdown focus behavior and deck-scoped profile selection. Existing navigation commands still update the selected value.

### PR06 Hidden workflow UUIDs and consistent selectors

**Outcome:** Users choose workflows by name everywhere; all newly generated workflow IDs, including defaults, are UUIDs.

Own workflow field metadata, reuse PR05's dropdown in direct assignments, Run workflow, Cancel workflow and subflow selection, and own the ordered UUID migration. Store IDs internally; show helpful missing/deleted-workflow states instead of a blank valid-looking selection. Rename must not break references. Subflow revision selection remains explicit.

Migrate known legacy IDs with one old-to-new map across press/release/hold assignments, sequences, workflow actions and recursively nested graphs. Preserve node IDs and layouts. Keep a legacy alias resolution strategy for dynamically computed workflow references and historical run filtering; do not rewrite arbitrary user strings or pretend old run records were newly executed. Back up before migration and make reloading idempotent.

**Acceptance:** Fresh defaults, existing `welcome`, legacy imports, nested references, renames, duplicate names, missing references and exported/reimported workspaces. UUIDs are hidden from routine editing, while diagnostic exports can still identify records.

### PR07 Settings navigation cleanup

**Outcome:** General, Web decks, Diagnostics and Run history are peers. General no longer repeats the list of devices.

Own `Settings.tsx` and focused settings navigation styles. Remove the redundant Devices card. Keep actual deck management in deck settings and the rail. Remove the special Diagnostics-parent styling applied when Run history is selected. Keep accent, startup, retention, import/export and web pairing controls intact.

**Acceptance:** Navigation and selected-state tests, direct opening of Run history, and a visual check at a narrow desktop width. This is a small UI PR; do not reorganize OBS or secrets until their dedicated items land.

### PR10 Separate Open URL and Open file actions

**Outcome:** Users see two clear actions; Open file has a native picker.

Own catalog entries/field metadata, file-dialog request/preload validation, and desktop-open dispatch. URL accepts supported URLs; file accepts a host file path, offers a native selection dialog and keeps manual entry for advanced or variable-driven values. Cancelling a picker preserves the previous value. File paths with spaces and Unicode work.

Keep existing `desktop.open` assignments executable/importable through a compatibility definition. Prefer distinct new action IDs to changing the meaning of saved configurations. Reuse the field/picker mechanism for PR17's destination picker. Do not let a paired browser gain arbitrary file-dialog or filesystem IPC access.

**Acceptance:** Picker result/cancel tests, protocol/path validation, mocked shell opening, compatibility imports, and bound values passed through the normal workflow resolver.

### PR11 Separate media actions and observed feedback

**Outcome:** A Media category exposes Play, Pause, Play/Pause, Next, Previous and Stop as individual actions.

Own media catalog definitions, shared media dispatch and feedback matching. Reuse the MPRIS adapter and selected-player configuration. Give Play/Pause an icon/state derived from observed playback, including external changes. Handle missing players and unsupported operations explicitly. Keep legacy `media.control` configurations working without displaying a redundant combined tile for new assignments.

**Acceptance:** Mock MPRIS tests cover all six operations, selected/default players, external play/pause, disappearance and unknown state. No optimistic per-click counter is used as playback truth. Shared definitions work in both button and workflow libraries.

### PR12 Relative brightness and appearance palette scope

**Outcome:** Increase brightness and Decrease brightness accept a configurable positive step and clamp to 0–100 on the originating deck.

Own brightness action variants, main-process atomic updates and palette visibility metadata. Keep absolute brightness available for existing documents and advanced workflows; show the two requested relative actions as the normal choices. Serialize concurrent adjustments so presses cannot overwrite one another.

Hide `deck.appearance` from the ordinary button palette while preserving its decoder/handler and workflow visibility. PR21 will evolve the workflow-facing feature into Update triggering button. Do not delete stored bindings or make imports fail merely because an action is hidden from new assignments.

**Acceptance:** Boundary, repeated/concurrent press and independent-deck tests; hidden-action round-trip; a saved appearance action remains editable or clearly identified as legacy.

### PR13 First icon pack and consistent rendering

**Outcome:** The icon picker includes a searchable Lucide pack; the same selected icon appears in the editor, web deck and physical frame.

Own a small versioned icon registry, picker and shared render/asset path. Persist stable pack/icon names, preserve emoji/text icons and uploaded images, and provide a fallback for unknown icons. Bundle a useful initial selection rather than every icon module. Render deterministic local SVG/raster assets for hardware; the worker must not depend on React components or platform emoji fonts for pack icons.

Use Lucide's applicable ISC and Feather-derived MIT notices in the distributed assets. The [Lucide license](https://lucide.dev/license) permits redistribution with the required notices. Leave custom marketplace downloads and arbitrary executable packs for later.

**Acceptance:** Selection/search/reload, import/export, missing pack fallback, render size/color/label tests and web asset scoping. Compare desktop/web previews with generated 96 px XL frames; physical appearance remains a final host check.

## Connections work

### PR08 Managed secrets with inline entry

**Outcome:** Users enter a password/token alongside its connection or HTTP action, while the app manages the credential reference.

Own the credential service, validated set/replace/remove requests, generic password/token controls and the HTTP credential-field integration. Store only generated references in the document; keep values outside snapshots, exports, logs and run traces. A secret is write-only after submission; the UI gets configured/missing/session-only status. Use secure OS storage when available and make session-only fallback explicit.

Preserve existing references, including shared credentials. Copying an action should not accidentally duplicate a secret into exported JSON. Deleting one owner must not remove a secret still referenced by another; define cleanup/replacement ownership and atomically persist changes. Hide the standalone Credentials section only once all existing references remain usable and editable through their owners.

**Acceptance:** Secure/unavailable/locked storage, restart, replace/remove, two connections sharing a legacy reference, HTTP bearer use, action copy and export/import without secret values. Typed secrets may exist transiently in the entry form, but the app must never return stored plaintext to it.

### PR09 OBS setup guidance and Test connection

**Outcome:** Add OBS explains where to find settings and allows a connection test with useful results.

Own extracted connection settings UI, the OBS test request and connection-specific status. Explain the OBS Tools WebSocket settings, enabling the server, address/port and authentication; the [official OBS guide](https://obsproject.com/kb/remote-control-guide) confirms the built-in server and settings path. Use PR08 for password entry.

Allow Test connection before committing a new draft. Distinguish refused connection, timeout, authentication failure, incompatible protocol and success. A test must not alter scenes, recording or streaming. Preserve multiple named OBS instances and show a named connection dropdown in OBS action fields. Close temporary test connections and preserve normal observed subscriptions.

**Acceptance:** Mock WebSocket server tests for those outcomes, distinct passwords per instance, reconnect after editing and no secret leakage. Real OBS validation joins the final host session.

## Runtime and workflow data work

### PR14 Reliable workflow cancellation and button reset

**Outcome:** Cancel workflow stops a running delay and prevents later actions, regardless of how the workflow was launched, and the originating button leaves its running state.

Own cancellation routing, runtime run tracking and shared activity feedback. Track active workflow invocation identity independently from a synthetic `direct` parent. Define Cancel workflow as cancelling all active root executions containing the selected active workflow invocation, including its descendant work, and clearing matching queued starts. It is a no-op if nothing matches. Keep explicit run-ID cancellation available for the history/toolbar.

Preserve cooperative abort for delays, requests and process groups. A cancelled embedded workflow must settle its owning button's activity; avoid orphaned `direct` parents. Concurrent remaining work must keep its button busy until all relevant executions finish. Cancellation must not overwrite persistent appearance or confirmed toggle state. It cannot undo already completed external side effects.

**Acceptance:** Tests for direct assignment, single Run workflow action, sequence, nested subflow, long delay, queue, restart and concurrent runs. End-to-end Run button → Cancel button → no later notification, terminal cancelled record and restored idle appearance on desktop/web and captured hardware frames.

### PR15 JSON data operations and text templates

**Outcome:** HTTP request → Parse JSON → Extract value → Notification works with a sentence containing the result.

Extend the existing resolver/validator and action output metadata. Add small pure operations for Parse JSON and Extract value; keep Set/map for naming values. Provide text templates that combine literal segments with references, while preserving the native type for a whole-field `$ref`. Use a declarative representation, for example `{ "$template": ["Subscribers: ", { "$ref": "outputs.extract.value" }] }`, with no JavaScript evaluation.

Preserve HTTP's existing `{status, body, truncated}` contract and document limits. Reject parsing truncated/invalid JSON with a useful error; preserve arrays, booleans, zero and null. Extend field schemas deliberately where typed values are needed, including command argument arrays alongside legacy JSON strings. References resolve before field validation; retain path-availability and prototype-access protections.

**Acceptance:** Local HTTP fixtures, nested properties/array indexes, escaped property-path design, missing-field fallback, template escaping, malformed/truncated JSON, type mismatch, unsafe property names and no execution of embedded code. Existing saved references continue working.

### PR16 Data binding UI and workflow node audit

**Outcome:** Users can discover prior outputs and insert variables into relevant action fields without copying node UUIDs.

Own data-picker components, action field integration and flow inspector improvements. Show node names and typed output fields, inputs, variables and loop scope, with a clearly labelled bounded/redacted last-run preview. Preserve stable node IDs internally. Support literal, whole-value binding and mixed text template modes. Do not advertise outputs unavailable on the current control path without a fallback.

Audit every existing node using a compact behavior matrix: inputs/configuration, outputs, ports, error routes, timeout/cancel, nested scope and reload. Verify declaration and subflow revision behavior. Repeat is a bounded loop inside one run, not a clock trigger; label this clearly. Keep configuration JSON and switch semantics unchanged. Fix demonstrated data/editor defects here; assign unrelated major runtime defects a separate item instead of expanding this PR.

**Acceptance:** Build the HTTP → Parse JSON → Extract value → templated Notification example through the UI, save/reload and run against a local fixture. Exercise bindings in URLs, request bodies, command args, conditions, notifications and file content using their proper types.

### PR17 Read write and append text files

**Outcome:** A workflow can write fetched subscriber counts or other text to a chosen host file.

Add separate Read text file, Write text file and Append text file actions with file/destination pickers and variable-capable paths/content. Use absolute paths in the initial version. Explicitly distinguish overwrite from append and optional parent-directory creation. Provide bounded UTF-8 content and typed outputs; binary file pipelines and globbing are deferred.

Use temporary-file plus rename for overwrite, per-path serialization for conflicting writes, and cancellation checks before the final commit. Preserve permissions where appropriate and report missing directories, access denial and invalid targets. Default automatic retries off for append. Explain that successful writes are external side effects and cannot be undone by cancellation.

**Acceptance:** Temporary-directory tests for read/write/append, Unicode/spaces, overwrite atomicity, concurrent operations, failure cleanup, cancellation before commit and a HTTP-data-to-file workflow. Paired browsers cannot submit arbitrary paths or file operations outside saved actions.

### PR18 Toggle runtime and state reconciliation

**Outcome:** An optional two-state binding can run an action, sequence or workflow when turning on and a different target when turning off.

Own the toggle schema/migration, runtime state service and coordinator integration. Key state is scoped to deck/binding/generation and is distinct from run activity. Advance confirmed state only after successful completion; failure/cancel keeps the last confirmed state. Serialize transitions and default to ignore presses while transitioning. Do not activate either target merely because the editor renders.

Support app-managed state, persisted as last confirmed state, and externally observed state. A configured read-only probe can be a command or workflow returning a bounded boolean/defined on/off result. Probe on activation/startup and after transitions, with optional refresh via the scheduler later. Until a valid result exists, show unknown and disable ambiguous toggling; probe errors must not silently mean off. Expose a bounded execution result for internal consumers, rather than parsing redacted run history as truth.

**Acceptance:** Two commands enable/disable a fixture; workflow targets, failed transitions, cancellation, simultaneous desktop/web input, restart reconciliation, binding replacement and external drift all behave predictably. Importing a toggle must not run probes or side effects before the workspace is activated under the import policy.

### PR19 Toggle button editor and observed state UI

**Outcome:** Users configure off/on targets and appearances with an optional state probe, without turning every action into a toggle.

Own the toggle editor and shared appearance composition with desktop/web consumers. Show confirmed on/off, unknown, transitioning and failed status accessibly. Offer two-state labels, icons and backgrounds and a safe probe-test control. Preserve existing press/release/long-press assignments; initial toggle mode owns the press target and must explain conflicts rather than silently dropping bindings.

For media, audio and OBS, prefer their existing observed-state providers. Externally changing playback or mute updates appearance. A normal Run workflow binding shows activity until its run settles; it does not become a persistent toggle automatically.

**Acceptance:** On/off command demonstration, workflow target selection, empty probe result, external playback/mute changes, restart, cancel, editing while a transition runs and consistent web/desktop render fixtures. PR21 must reuse this appearance precedence contract.

## Scheduling and dynamic button work

### PR20 Explicit workflow schedules

**Outcome:** Workflows can start on an interval or cron schedule while Decker is running, independently of a key press.

Own a process-level scheduler service, persisted schedule definitions/migration, validated controls and schedule UI next to workflow properties. Keep the graph's trigger node as the entry point; a schedule is a source of runs, not an infinite Repeat node. Offer interval and five-field cron, an explicit IANA timezone and next-run preview. Use a maintained cron parser after checking its current API; don't implement timezone arithmetic by hand.

Schedules are disabled by default and on import. Start only after explicit activation, continue while the editor is closed to tray, and stop on Quit. Default to one active run per schedule and skip overlapping/missed ticks. On resume calculate the next future occurrence rather than replaying accumulated effects. Document DST policy: skip nonexistent wall-clock times; run a repeated local occurrence once. A scheduled workflow has no implicit triggering button.

**Acceptance:** Fake-clock tests for interval, timezone/DST, invalid cron, overlap, sleep/resume, worker restart, disable/delete, import and app shutdown. History records the schedule source. The UI explains that Decker must remain running; no OS background daemon is promised.

### PR21 Trigger context and workflow button appearance

**Outcome:** A workflow can update the exact button that started it, even through nested subflows.

Own read-only execution context, a display-state service and the workflow-only Update triggering button action. Expose source kind, deck/profile/page/binding IDs, binding generation and invocation identity under a reserved `context` namespace. Keep it separate from caller-editable inputs. Propagate it through subflows; manual/scheduled executions without a bound source show a useful “no triggering button” error or require an explicitly configured target.

Update label, background, icon-pack reference or existing asset by stable binding identity. Do not target whichever key happens to occupy the old slot after navigation or editing. Store dynamic display overrides separately from authored configuration and transient run feedback, with a bounded last-good cache. Reject stale generations and superseded refresh results. Use one composition order everywhere: authored base, confirmed toggle/observed state, dynamic overrides, temporary activity indication. Temporary activity must restore the underlying display when it ends.

**Acceptance:** Trigger-context bindings, subflow propagation, page/profile navigation mid-request, deleted/replaced/copied keys, simultaneous runs, unrelated decks, cancellation and consistent desktop/web/hardware frame outputs. Keep legacy `deck.appearance` documents compatible.

### PR22 Bounded remote image assets

**Outcome:** A workflow can fetch an avatar image and assign it to a dynamic button without loading remote URLs directly in every renderer.

Own a Fetch image action and shared content-hashed asset ingestion/cache. Fetch in a trusted host process with timeout/cancellation, controlled redirects and explicit HTTP(S) validation. Never forward API credentials to a different image host. Validate actual decoded raster format, byte limit and dimensions, then normalize to a local asset. Initial formats: PNG, JPEG and WebP; defer remote SVG and animation.

Use concrete configurable limits with conservative defaults, such as 4 MiB downloaded and 16 megapixels decoded. Bound generated asset storage, retain only required last-good images and references, and avoid deleting authored/uploads through dynamic-cache cleanup. Expose assets only to authorized decks under existing web rules. Image failure retains the last good display and records a stale/error state.

**Acceptance:** Fixture image server for valid/oversized/invalid/redirecting/slow responses, cache reuse, cancellation, old-generation rejection, disk cleanup and unauthorized web asset requests. No real streaming account is required in CI.

### PR23 Refresh workflows while buttons are visible

**Outcome:** A button can have a separate refresh workflow that runs on appearance and every configured interval, while its press action remains independent.

Own binding refresh configuration, visibility leases and scheduler integration. Provide a discoverable Dynamic workflow button preset in the action library, plus refresh controls in the editor. Reuse PR20 scheduling, PR21 context/state and PR22 assets. Default to one refresh at activation and a 60-second interval; support the requested five-minute interval and enforce a minimum interval and bounded concurrency.

Define visibility by the actual surface: a ready hardware deck's current page even with the editor closed; the active simulator page; or at least one authenticated, foreground web client showing the deck page. Deduplicate multiple clients and React rerenders. Stop future ticks and invalidate/cancel refresh work when the binding is hidden, replaced, disconnected or disabled. Preserve last-good appearance, avoid overlapping refresh runs and back off after repeated/rate-limit errors. Imports remain inactive until enabled.

**Acceptance:** Fake clock plus simulated hardware/web visibility tests, two clients sharing one timer, navigation, reconnect, startup restore, stale completions and a last-subscriber fixture updating name/avatar. Show last refreshed and stale status. Real YouTube/Twitch data is an optional final demo requiring separately configured API permissions; the feature is not blocked on a full OAuth/plugin system.

## Delivery and documentation work

### PR24 Development prereleases after develop builds

**Outcome:** Every successful `develop` build produces a downloadable development prerelease with `.deb`, AppImage, checksums and its exact commit.

Own reusable build/test packaging workflow pieces and a tightly scoped publish job. Trigger on `push` to `develop`; PR verification remains read-only and never publishes. Reuse tested artifacts from the same workflow execution instead of rebuilding different code for publication. Give every build a unique prerelease version/tag containing date, run identity and short SHA. Validate both npm/SemVer and Debian prerelease ordering; do not assume one version string orders correctly in both formats.

Mark nightlies as prereleases and never as the latest stable release. Isolate `contents: write` to publication. Attach a manifest with source SHA, version, architecture and checksums. Keep the current native-module and packaged-app smoke checks. Queue publication as needed without silently cancelling a requested build for an earlier merge; an optional latest-nightly pointer must not replace immutable per-build artifacts.

**Acceptance:** Validation/dry-run of metadata and artifact selection, branch/event guards, failed tests producing no release, rerun idempotency and two close develop pushes producing distinct results. A successful automated nightly is not a hardware certification. [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) provide the push and reusable workflow mechanisms.

### PR25 Tagged stable release workflow and PR notes

**Outcome:** A maintainer dispatches a release with a version and an immutable tested source SHA; the workflow builds, tags and publishes binaries with linked PR titles.

Own the release workflow, release-note configuration and metadata tests. Use the stable-branch policy above. Validate that the selected SHA belongs to the chosen release branch and the requested version matches the reviewed package version; version bumps travel through normal PRs to `develop`. Bootstrap `main` from the final tested revision when adopting that policy. Keep the dispatch workflow on the default branch (`develop`) so it can be run.

Run/reuse the full build verification for that exact source, then create the version tag and a draft release, attach all artifacts/checksums, and publish only after every upload succeeds. Existing tag conflicts must fail safely; reruns resume only the same version/SHA. Call reusable build jobs directly rather than expecting a tag pushed with `GITHUB_TOKEN` to trigger another workflow.

Generate notes between the previous **stable** tag and the new SHA, including each merged PR's title, number and link. Verify merge, squash and rebase histories and promotion-PR deduplication; fall back to explicit associated-PR collection if generated notes miss underlying develop PRs. Handle the first release and direct commits. [GitHub generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes) can supply the basic merged-PR list and changelog.

**Acceptance:** Dry-run on fixture histories, missing/duplicate version, wrong branch/SHA, failed build/upload, first release, exclusion of nightly tags from the previous-release baseline and safe handling of PR titles. Actual stable publication occurs after consolidated host acceptance, not merely when this tooling PR merges.

### PR26 Quick start and current user documentation

**Outcome:** README gets a user from download or checkout to a working deck quickly, with detailed material linked separately.

Lead with what Decker does, supported platform, stable/nightly downloads when they actually exist, installation, starting the app, Stream Deck permissions, adding a deck and a first working button. Keep a short development path using the verified `npm ci`/`npm run dev` setup. Move deep architecture/workflow/security material to dedicated docs without discarding it.

Update navigation screenshots and descriptions, OBS inline credentials, UUID selection, schedules/toggles/dynamic examples, and the final hardware support statement. Fix the public/private claim, preserve accurate license wording and do not add a license without the owner's decision. Explain trusted-LAN web transport, session-only credentials where needed, supported input/session limitations and that schedules require the running app.

**Acceptance:** Walk through install/first-use instructions from a clean test environment using real artifact links; check documentation links and commands. Before final hardware testing, explicitly mark hardware acceptance pending. After the host session, add the measured results in the acceptance record, not a speculative support claim.

## Action research and feature boundaries

The requested new actions have a coherent initial scope: split URL/file and media actions, relative brightness, parse/extract/template data, read/write/append text, toggles, schedules, image fetching and workflow-driven display updates. Keep current launch, shell, HTTP, notification, clipboard, shortcut, typing, audio and OBS actions and improve their shared data/configuration controls.

[Elgato's app overview](https://www.elgato.com/ww/en/s/stream-deck-app) highlights actions, profiles, folders, pages, multi-actions and integrations; Decker already has several of those foundations. Its [key SDK guide](https://docs.elgato.com/streamdeck/sdk/guides/keys/) demonstrates two-state keys and programmatically updated titles/images. These support the requested product direction, without implying compatibility with Elgato plugins.

[n8n's data guidance](https://docs.n8n.io/build/work-with-data/expressions-versus-data-nodes.md) shows output references and focused transformation nodes. Decker should retain its declarative, non-evaluating resolver and the user's preference for small single-purpose nodes. [n8n's file actions](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.readwritefile/) and [Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/) are useful UX references for file destinations and explicit timezone-aware scheduling.

[Streamer.bot actions](https://docs.streamer.bot/guide/core/actions) pass variables between sub-actions, and its [Write To File action](https://docs.streamer.bot/api/sub-actions/core/file-io/write-to-file) accepts variable-driven text. [Bitfocus Companion feedbacks](https://companion.free/user-guide/v4.1/config/buttons/feedbacks/) change button appearance using device state or variable conditions. The useful pattern for Decker is to separate action execution, observed state and display composition; this directly informs PR15, PR17 and PR18–23.

Defer service-specific YouTube/Twitch OAuth onboarding, a plugin marketplace, Elgato plugin compatibility, arbitrary code nodes, OS-level scheduling while Decker is closed, automatic active-window profiles, general Wayland input injection, and animation/video backgrounds. Subscriber count/avatar examples work against a generic authorized API or local fixture first. Broader action additions such as soundboard playback or application volume controls need their own requirements and supported-backend decision; do not silently expand these 26 PRs.

## Agent handoff template

> Use GPT6.1 SOL with HIGH reasoning (`gpt-6.1-sol`, `high`). Implement PRNN from `docs/plans/2026-10-14-feedback-plan.md` and read the companion hardware evidence when relevant. You have no physical hardware access. Confirm predecessor PRs are merged, create `codex/<topic>` from current `origin/develop`, and open one focused PR with base `develop`. Preserve the scope decisions and migration rules. Coordinate shared-file ownership before editing integration files. Add the specified regression fixtures and run applicable checks. Use mocked HID/OBS/MPRIS, local HTTP fixtures, fake clocks, simulator and web tests; never claim physical verification. Summarize behavior, compatibility, test evidence and remaining host gates in the PR. Attach the created PR to the chat. Do not merge your own PR or publish a release as part of implementation.

Each PR should include focused tests for actual behavior, applicable type/build/format checks, and the existing CI verification. From wave seven onward, the user explicitly requires each agent to fix failures and wait for all required CI to pass on its final pushed head before handing off, with the head SHA and CI links. The user also chose only fully independent tasks for wave seven: PR17 and PR18 run in parallel, while PR20 scheduling waits for the toggle schema migration to land. Run affected Electron E2E tests for UI changes and packaged smoke tests for native/asset/release changes. Maintain a single coordinator-owned integration checklist. If the environment blocks local networking, identify that condition and use an appropriate permitted test environment rather than weakening assertions.

## Consolidated acceptance on develop

17 October completion audit: all 26 original plan items are merged, ending with PR26 / GitHub #35 at `11220016455f541eb4768b301f06c9c639f4476d`. Its final-head PR checks and merged build passed. Additional CI-parallelization #36 and Sharp repair FU01 / #37 are now merged, with green final-head PR checks, at current develop `299449d98c9a3ffbd0d24581c1b7b016951a7eee`. The combined develop run has a source-Electron discovery-test failure; do not certify this baseline green. Current host access to the XL succeeds via a named user ACL/uaccess; the earlier permission-denied state is historical. See [host preparation and findings](2026-10-17-host-acceptance.md).

Acceptance preparation found the installed Sharp 0.34.5 image dependency affected by maintainer advisories. [FU01](2026-10-14-feedback-tasks/fu01-patched-image-dependency.md) is merged with Sharp 0.35.5; the coordinator's clean host install/native check, build and 88 selected image/persistence tests passed on that baseline. A preliminary physical XL pass on `299449d` subsequently verified all 32 keys, brightness, holds/navigation, profile changes, workflow cancellation, a toggle, reconnect/worker recovery and dynamic images including refresh, failure retention and recovery. See the [17–18 October evidence](2026-10-17-host-acceptance.md) for exact coverage and limits. Suspend/resume was deferred by the user; final acceptance is not complete.

18 October closing update: CI02 / GitHub #39 merged at `9b43716c01654ac936aeac449b9c5bd340a22fa9`, and combined [develop CI 39038333866](https://github.com/ianwijma/decker/actions/runs/39038333866) passed. FU02 / #38 remains open with green required checks. The physical session stayed on its original `299449d` build; later CI success does not retroactively certify physical behavior on another SHA.

Two independent corrective lanes follow: [FU02 D-Bus XML parser](2026-10-14-feedback-tasks/fu02-dbus-xml-parser.md) owns the shipped vulnerable xml2js resolution and actual parser/media compatibility coverage; [CI02 discovery snapshot race](2026-10-14-feedback-tasks/ci02-discovery-snapshot-race.md) owns the recurring source/packaged discovery test ordering failure. Both use Cloud/decker, GPT-6.1 Sol High, fresh develop branches and final-head green CI. CI02 stays out of dependencies/media; FU02 stays out of home/discovery snapshot plumbing. Preserve schema v7 and all package/native/aggregate gates. Optional install-only and build-only audit paths remain classified separately. These are evidence-backed acceptance repairs, not new product features. Refresh the host baseline after reviewed merges, then complete the consolidated physical checklist.

Once all implementation PRs are merged, record a specific `develop` SHA and its complete automated CI results. Build both packages from that SHA and use a backed-up test workspace. The host coordinator performs the following session; implementation agents only consume findings and prepare follow-up PRs against `develop`.

| Area | Host test and required result |
| --- | --- |
| Permission failure first | Reproduce the current XL failure: Home, rail, deck and Diagnostics agree on Permission required; discovery does not claim ready. Suggested remedy matches the host. |
| Permission repair | Apply the narrowly scoped desktop rule using normal administrator authorization, reconnect, verify the user's ACL and open access, then use Retry. No root app launch. |
| Physical rendering | Configure all 32 keys with labels, pack icons, uploaded images and backgrounds; verify orientation, key mapping, clear/replace, page/profile/folder changes and brightness at 0/50/100 plus relative steps. |
| Physical input | Test press, release, hold, rapid presses, navigation while held, run workflow and cancel during a long delay. Confirm no downstream side effect after cancellation and correct button restoration. |
| Lifecycle | Unplug while held and while writing, reconnect, suspend/resume, worker restart, close editor to tray and reopen. No replayed input; latest page/display/brightness returns. |
| Hardware contention | With another controller deliberately owning the device, report the actual observed fault when one occurs; do not invent a busy diagnosis from enumeration alone. Recover after it closes. |
| Independent surfaces | Hardware, simulator and web deck retain independent profiles/state. Test multiple browsers, disconnect/background/reconnect, and no duplicate refresh timers. |
| Workflow editor | Drag under live hardware/status updates with no flicker, check minimap, searchable selectors and immediate name focus. Test all existing node kinds, preserving switch behavior. |
| Workflow data | Local API → JSON parse → extract → notification and file output. Then optionally use a real authorized API. Confirm failure paths, limits and readable history. |
| Toggle behavior | On/off command or workflow, initialization probe, external state changes, failed command, cancellation and restart. Appearance reflects confirmed state. |
| Dynamic buttons | Initial render and recurring refresh update label/avatar on physical XL and web. Navigate away, hide/disconnect clients, fail the endpoint and replace the binding; no stale update targets a different key. |
| Schedules | Enabled/disabled schedules, timezone preview, overlap, close to tray and suspend/resume; no missed-run replay storm or execution after Quit. |
| Desktop integrations | Real MPRIS external playback changes; audio/microphone state and device loss; OBS setup, test, wrong password, reconnect and external scene changes. Use a test OBS workspace for recording/streaming controls. |
| Settings and secrets | Peer Run history navigation, no redundant device list, preserved preferences, secure-keyring and session-only cases, export/import with no secret values and automation activation rules. |
| Installation | Install `.deb`, launch AppImage on this Pop!_OS host, verify native modules/assets and follow the rewritten quick start. Check stable/nightly version labels and metadata. |
| Performance | Record physical input dispatch p95 and page refresh timing under load against REQUIREMENTS.md's targets; automated queue tests alone do not establish latency. |

Record expected/actual result, build SHA, device model, desktop session and evidence for every case. Classify failures into software fixes versus host setup. Send software failures back as small follow-up PRs using captured fixtures; merge and rerun affected cases plus the cross-surface smoke flow. Only then record the tested XL as verified and permit the selected SHA to enter the stable release flow. Other hardware models and untested Wayland sessions remain explicitly unverified.
