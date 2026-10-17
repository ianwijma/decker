# PR14: Reliable workflow cancellation and button reset

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

## Branch, dependency and observed baseline

Create codex/workflow-cancellation. PR14 has no original semantic predecessor, but dispatch was deliberately held until PR06 / GitHub #16 merged to avoid simultaneous runtime lookup changes.

src/shared/workflow-identity.ts exports resolveWorkflowId(id, aliases = {}) and findWorkflow(workflows, id, aliases = {}). Mapping is validated, own-property, one-hop legacy ID to UUID; unknown IDs pass through and deleted mappings are tombstones. Reuse these helpers at matching/lookup boundaries. Engine snapshots validated aliases with definitions at start; retain that snapshot semantics for active invocations. No rewriting historical run records or generating new IDs during cancellation.

Current worker workflow.cancel resolves the selected UUID but matches only top-level RunRecord.workflowId via coordinator.cancel and standalone handles. A direct Run workflow action is wrapped in a synthetic "direct" parent; child execution happens inside Engine.runGraph without separate root tracking. This explains why choosing the child workflow fails to cancel the owning direct run. Coordinator queues currently store bare launch closures, and main/renderer feedback tracks a single recent run; both need careful matching and aggregation rather than an optimistic reset.

## Full outcome and semantics

Cancel workflow interrupts an active delay and prevents subsequent actions regardless of how it was started, and the originating button leaves its running state when its relevant runs settle. Track active workflow invocation identity independently of synthetic direct parents.

Cancel workflow means cancel all currently active root executions containing an active invocation of the selected workflow, including descendant work, and remove matching queued starts. If nothing matches it is a no-op. Match currently active invocations, not only workflows that were called earlier and already completed. Root invocations remain active for the life of their root run. Parallel/nested calls to the same workflow need identity or reference counts, not a boolean that one completed call can clear. Preserve explicit run-ID cancellation used by history/toolbar; keep it distinguishable from workflow-ID matching.

Queued records need enough provenance to clear matching work without wiping unrelated workflows on the same binding/phase. Preserve ignore/restart/queue/concurrent policies and limits. Test cancellation during restart and while a replacement launch is queued. Do not execute side effects or data probes simply to identify queued work.

Keep cooperative abort for delay, HTTP, subprocess/process groups and resource-lock waits. Once cancellation is observed, no retries/error edges or later graph actions should cause new effects. Abort cannot undo already completed external effects; explain that practical limit. A workflow cancelling itself must settle without deadlock or orphaned parents. A standalone run and a button-bound run should obey the same invocation matching.

Use internal RunHandle/runtime metadata for invocation identity; no persisted schema bump is required. If any optional runtime diagnostic field is truly necessary, isolate it rather than taking ownership of PR10's request union.

Compute button activity from all matching active runs using binding identity, generation and deck identity. Completing/cancelling one concurrent run must not clear a still-running sibling. Stale completion after a binding is replaced must not recolor the replacement. Cancellation, interruption and terminal timers restore the underlying authored/observed appearance and preserve existing legacy deck.appearance overrides. Do not create a persistent toggle; later toggle/display work reuses this activity contract. Keep desktop, web view and captured hardware-frame intent consistent.

## Verification

Add tests for direct workflow assignment, one Run workflow action, action sequences, nested subflows, nested/parallel duplicate invocations, dynamic legacy aliases, revision-pinned children, long delay, queued starts, ignore/restart/concurrent policy, no-match no-op, explicit run ID, self-cancellation, runtime interruption/restart and two independent decks. Test that completed historical child invocations are not treated as active.

Provide an end-to-end Run button -> Cancel button test: a long delay is aborted, no later notification/command fixture occurs, history reaches cancelled and originating activity resets. Verify a still-active concurrent sibling retains busy feedback, deletion/replacement invalidates stale updates, and existing appearance overrides survive. Use simulator/Electron and shared web/device-output fixtures; do not claim physical testing. Preserve PR06 alias and canvas/selector regressions. Include a concise invocation/queue/activity contract in the PR for future PR15/18/20/21 work.
