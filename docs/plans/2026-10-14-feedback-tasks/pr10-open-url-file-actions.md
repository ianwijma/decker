# PR10: Separate Open URL and Open file actions

Implement only this plan item in repository ianwijma/decker. The coordinator selects Codex Cloud environment decker, GPT6.1 SOL (gpt-6.1-sol), and High reasoning in the launch controls. These settings are verified outside your session; inability to introspect them is not a blocker.

Wave four runs PR14 cancellation, PR10 separate URL/file actions, and PR13 the first icon pack. Plan item numbers differ from GitHub PR numbers. The coordinator verified PR07 merged as GitHub #14 (88c2cc86bf46a2dc2e68aa66a5b4d02919ca3626), PR06 as #16 (d2d667c34a173160567fab98266fc50714a2b8cb), and PR03 as #15 (2ce728cabf250d2581e3b4c534dcd38bb1cbb897). All three PR CI checks passed and all three merges are ancestors of origin/develop at 2ce728cabf250d2581e3b4c534dcd38bb1cbb897. Latest develop CI run 38559922219 was in progress at preparation; recheck before finalizing. No develop PRs were open at preparation.

Read applicable AGENTS.md instructions, fetch current origin/develop, verify predecessors and create the specified codex/ branch from the latest develop, not a stale cloud snapshot. Check for duplicate branches/PRs and preserve unrelated setup changes. Raise one focused PR against develop, attach it to your chat if supported, and return its link. Do not merge, launch successor tasks, dispatch release workflows, create live release tags, publish releases, or create/promote main.

You have no physical hardware access. Use mocked transports/services, local fixtures and Electron/simulator/web tests. Physical input, display and host permission work belongs to the coordinator's consolidated acceptance session after the selected PRs land. Clearly mark physical acceptance pending. The plan files may be local-only; this attachment includes the complete relevant handoff, so their absence is not a blocker.

Preserve schema v3, workflowAliases and the migration safeguards from PR06, PR04 canvas stability/minimap, PR05/06 searchable selectors, PR01/02 truthful device diagnostics, PR03 Home/discovery, PR07 peer settings and the release tooling. Keep node JSON configuration and switch ports/behavior. Do not implement credentials, media/brightness variants, toggles, schedules, workflow data nodes, dynamic buttons or a plugin marketplace in this task.

Run meaningful focused regression tests and applicable npm run format:check, npm run typecheck, npm test, npm run build and Electron E2E (xvfb-run --auto-servernum npm run test:e2e where available). Keep CI packaging/native smoke gates; PR13 must verify its resources in the packaged app. Use current CI for exact commands. Distinguish missing environment prerequisites or restricted loopback/subprocess access from product regressions; use permitted setup instead of weakening assertions. Rebase from current develop and rerun affected tests before finalizing. Report behavior, compatibility, test evidence, blocked checks and remaining host gates in the PR.

## Coordinator-approved file and integration ownership

Prefer focused new modules and new test files; no broad reformat or refactor of integration files. No document schema version is allocated in this wave.

- PR14 owns runtime/engine.ts, coordinator.ts, cancellation.ts and worker.ts, new runtime invocation/activity modules, and shared/feedback.ts. In main/index.ts it owns run-message handling, transient activity storage, interruption cleanup and activity composition in deckAppearance. In Deck.tsx it owns only run/activity selection and busy/status presentation, preserving icon JSX and editor fields. Avoid catalog, ActionFields, file-dialog requests, icon assets/renderers and workflow-identity migration changes.
- PR10 owns shared/catalog.ts action definitions/field metadata/palette visibility, renderer/components.tsx action fields, any minimal Flows action-library filter, new desktop-open/picker modules and the desktop file-picker request variant in shared/schema.ts. In main/index.ts it owns only desktop.open/new URL/file action cases and the new picker request case/imports. Preserve run-message/activity sections. Existing generic preload transport may need no changes; validate at the trusted boundary.
- PR13 owns new shared icon registry/render helpers, new icon-picker components/styles, device/images.ts icon rendering, renderer/web/client.ts icon rendering and scoped web icon styles. In Deck.tsx it owns only icon/asset JSX, preview and icon editor. It owns a packaging notice/resource inclusion patch if needed. Keep appearance.icon a backward-compatible string with a stable pack token; do not change persisted schema, main/index.ts, catalog, components.tsx or activity logic.

The main/index.ts and Deck.tsx integration regions are explicitly divided above so all three can produce reviewable PRs. Imports may require routine conflict resolution; preserve the other lane's imports and behavior. No integration region is co-owned. If a change would cross those region boundaries, queue that overlapping patch behind its owner's merge and describe the required patch while progressing independent work. Rebase and rerun cross-feature checks after any other wave PR merges. Do not overwrite another task's work or silently expand ownership.

## Branch and dependency

Requires PR06 / GitHub #16, merged. Create codex/open-url-file-actions.

Current catalog desktop.open is "Open URL or file" with target field. mainAction in main/index.ts accepts HTTP(S) without embedded credentials or resolves a local path through shell.openPath; other schemes are rejected. Current image upload request "asset" selects images and imports them, so it is not the file-path picker for this feature. Preload exposes a generic request that the main process validates. The paired web protocol only accepts down/up/reset/heartbeat and must retain that limited surface.

## Full outcome

Expose separate Open URL and Open file actions in both button and workflow libraries. Add distinct action IDs so saved desktop.open behavior never silently changes. Keep legacy desktop.open executable, importable and editable, while avoiding a redundant combined tile for new assignments; a small reusable palette visibility contract may be introduced for PR11/12 to reuse. actionById and import decoding must still find legacy definitions even if palette filtering hides them.

Open URL accepts supported URLs with clear validation. Preserve the current HTTP(S)-only boundary unless an explicit supported-protocol design is justified in the PR; reject credentials and unsafe schemes. Open file accepts a host path, provides a native file selector, and retains manual entry for advanced/variable-driven values. Preserve spaces and Unicode and surface shell.openPath failures. Make relative-path behavior explicit and consistent; never interpret a URL as a local path by accident.

Use generic file field/picker metadata and a validated desktop request so PR17 can reuse it for file destinations later. This PR only needs opening an existing file; do not implement writing/appending or a broad filesystem IPC API. Cancelled selection must leave the prior value untouched, including bound data objects. The selected path is a string, not an uploaded image hash. A delayed picker result must not overwrite a different binding/field after navigation or action replacement.

Preserve the existing $ref binding UI. The workflow resolver resolves data before action validation; dynamic values must not be stringified into "[object Object]" or blocked by a literal-only form. The native picker is an explicit desktop-editor interaction. A paired browser may invoke an authorized button action through the existing input protocol, but must not gain the ability to open arbitrary dialogs, choose host files, enumerate paths or send desktop IPC.

Keep paths/URLs as data. Do not build shell command strings for opening or pickers. Validate trusted caller/request handling at the existing boundary. Retain the image asset picker and export/import dialogs.

## Verification

Test visible distinct palette entries and hidden-but-editable/executable legacy desktop.open imports. Test URL validation (HTTP/HTTPS, credential-bearing and unsafe schemes), file path spaces/Unicode, relative/absolute behavior, missing path/open failure, picker success/cancel and stale picker completion. Mock shell/dialog side effects rather than launching user applications.

Exercise direct action, sequence action and workflow-node configuration in Electron, including bound paths/URLs through normal resolution. Verify legacy/current documents save/export/import/reload under schema v3 and workflow dropdowns still work. Add a web-boundary test proving browser input cannot request the native picker or filesystem access. Keep existing Home, settings, canvas and workflow UUID checks. Document the reusable file-field/picker and palette visibility APIs for PR11/12/17.
