# PR11: Separate media actions and observed feedback

Implement only this plan item in repository ianwijma/decker. The coordinator selects Codex Cloud environment decker, GPT6.1 SOL (gpt-6.1-sol), and High reasoning in the launch controls. These settings are verified outside your session; inability to introspect them is not a blocker.

Wave five runs PR08 managed credentials, PR11 media actions, and PR15 workflow data/templates. Plan numbers differ from GitHub PR numbers. The coordinator verified successful PR CI and merges of PR14 cancellation as GitHub #18 (84344c8380859b06f51c7d3403ee2619433f99f2), PR10 URL/file as #17 (3ee46bf607185822a1cfe7bb9cbab8c550d09d44), and PR13 icons as #19 (294560fcb751fdb32c2369d3893f4f901f13f49a). All are in origin/develop at 294560fcb751fdb32c2369d3893f4f901f13f49a. No develop PRs were open at preparation. Develop CI run 38564971651 was still in progress; recheck before finalizing.

Read applicable AGENTS.md instructions, fetch latest origin/develop, verify predecessors, check for duplicate branches/PRs and create your specified codex/ branch from current develop. Preserve unrelated setup changes. Raise one focused PR against develop, attach it to your chat if supported and return its link. Do not merge, launch successor tasks, dispatch release workflows, create live release tags, publish releases, or create/promote main. These local planning files may not exist in your checkout; this complete attachment is the handoff.

You have no physical hardware access. Use mocked services, local fixtures, Electron/simulator/web tests and generated frame checks. Physical hardware and real desktop integration acceptance belongs to the coordinator's consolidated session after selected PRs land. Clearly mark those checks pending.

Preserve document schema v3, workflowAliases and workflow-identity.ts helpers, canvas stability/minimap, searchable selectors, truthful device health/Home/discovery, peer Settings sections, native URL/file picker safeguards, pack icons and release tooling. Keep node JSON configuration and switch semantics. No document schema version is allocated in this wave: existing JSON action configs and credentialRef strings accommodate the work; any unexpected migration is a separate coordination dependency.

Run meaningful focused regressions and applicable npm run format:check, npm run typecheck, npm test, npm run build and Electron E2E (xvfb-run --auto-servernum npm run test:e2e where available). Retain CI packaging/native smoke/icon-notice gates. Use current CI for exact commands. Distinguish missing environment prerequisites or restricted loopback/subprocess access from product regressions; do not weaken assertions. Rebase from latest develop and rerun affected checks before finalizing. Describe behavior, compatibility, tests, blocked checks and remaining host gates in the PR.

## Coordinator-approved integration ownership

Use focused new modules/styles/tests and minimal integration patches. No broad reformatting or shared-file refactors.

- PR08 owns main/credentials.ts, new credential modules, credential request/status additions in shared/schema.ts, credential persistence/export/import and main/index.ts credential/snapshot/save integration only. It owns renderer/src/Settings.tsx credential/connection fields and renderer/src/components.tsx secret-control branch, plus new inline secret components. In shared/catalog.ts it owns only HTTP credentialRef field metadata, reusing the existing secret field type. In actions/handlers.ts it owns HTTP secret lookup/auth headers/missing-secret errors and OBS secret handoff if necessary. It does not own response reading, data expression resolution, media dispatch, file picker or activity composition.
- PR11 owns media definitions in shared/catalog.ts, media dispatch cases in actions/handlers.ts, the media/players/observedMedia portions of adapters/linux/system.ts (or extracted media modules), the media branch of shared/feedback.ts, and the media observation portion of runtime/worker.ts if needed. It owns no other runtime, schema, main, settings, credential, catalog-schema-generation or generic field code.
- PR15 owns runtime/data.ts expression/path resolution and runtime/validate.ts expression/availability checks; preserve credential redaction. It owns new pure data modules, data definitions and output metadata/schema-generation/argument-array schemas in shared/catalog.ts. In actions/handlers.ts it owns pure data dispatch, command argument decoding, and HTTP bounded body reading/result construction only. It may minimally integrate resolved-config validation in runtime/engine.ts without changing cancellation/invocations/coordinator/activity. In renderer/src/components.tsx it owns only literal JSON field rendering if essential for newly typed fields; this must be a small branch isolated from PR08 secret controls. Rich data-picker/template UI is PR16, not this task.

Imports can require routine conflict resolution; preserve other lanes. No region is co-owned. PR08 should use dedicated credential redaction helpers if required rather than rewriting runtime/data.ts. PR15 must preserve the HTTP credentialRef field and authentication/redirect policy, PR11 media declarations and PR10 file/workflow field metadata while changing schema generation. Any change crossing these regions queues behind its owner's merge; describe the dependency while progressing independent work. Rebase and rerun cross-feature checks after another wave PR merges.

## Merged contracts to preserve

PR10 adds paletteVisible and paletteCatalog: hiding affects new assignments only; actionById must still resolve legacy actions for editing, imports and execution. desktop.openUrl and desktop.openFile coexist with hidden legacy desktop.open. The file picker uses a validated desktop-only request and stale-editor guards. Do not weaken its trusted-sender boundary or path/URL schemas.

PR13 stores versioned pack tokens such as pack:lucide:v1:camera in appearance.icon. shared/icons.ts is the renderer-neutral registry; KeyIcon and device/web renderers share it. Custom strings/emoji and uploaded assets remain supported; unknown pack tokens have a fallback. Reuse existing registry names and notices.

PR14 now tracks reference-counted live workflow invocations per root, queued start provenance and immutable definition/alias snapshots. Cooperative cancellation bypasses retries/error edges, cancels lock waiters, and settles direct/nested/queued work. ButtonActivity and observed.buttonFeedback aggregate runs by deck, binding ID and generation independently of bounded history. Cancellation restores underlying observed/authored appearance; concurrent siblings stay busy. Preserve these contracts, workflow UUID lookup/aliases, revision-pinned subflows, explicit run-ID cancellation, and legacy appearance overrides.

## Branch and outcome

Create codex/media-actions. PR10 / GitHub #17 is merged. Add a Media category with individual Play, Pause, Play/Pause, Next, Previous and Stop actions in both button and workflow libraries. Each shares the existing selected-player configuration and MPRIS adapter. Keep legacy media.control editable/importable/executable but hidden from new assignments with paletteVisible:false.

## Implementation requirements

Use stable action IDs, explicit defaults and one shared mapping to the six MPRIS operations. New actions should not require an Operation dropdown. Preserve legacy operation/player values and avoid document migration. Verify the catalog's runtime schemas match each action; PR15 owns the generic schema-generation section, so define media field/config needs locally and communicate any dependency instead of rewriting that section.

The current adapters/linux/system.ts players() enumerates org.mpris.MediaPlayer2.* names in sorted order. media(operation, player, signal) chooses the explicit bus name or the first player, verifies presence, allows PlayPause/Play/Pause/Next/Previous/Stop, invokes the method and reads PlaybackStatus. Preserve explicit-player isolation: if that player disappears, do not silently control another. The default selection should have one consistent rule for execution and observed feedback.

Current observedMedia returns {defaultPlayer, [busName]: PlaybackStatus}; worker publishes this periodically. Keep this shape compatible or provide additive state metadata for availability/capabilities. Do not let one player's failed status query make other healthy players unavailable. Preserve bounded D-Bus calls, disconnect/cleanup, abort checks and useful errors. Read the primary MPRIS specification for capability semantics if changing capability checks; do not invent universal requirements for methods. Make unsupported operations and unavailable players explicit. Use fixture-backed adapter injection rather than requiring a real player in CI.

Play/Pause's icon and state must follow observed playback, including externally initiated play/pause and disappearance. A click counter or successful dispatch is not truth. Distinguish Playing, Paused, Stopped, unknown and unavailable; never show a confirmed playing/paused state without evidence. Reuse available stable pack tokens from shared/icons.ts where useful; preserve custom/uploaded appearance and clearly define the precedence of authored assets versus the dynamic default icon. Do not add a new icon pack or change registry licensing.

shared/feedback.ts currently handles only a single press action of type media.control; for media it reads state.media, selects config.player || state.defaultPlayer, and accents when Playing. Extend this branch through a reusable media-action descriptor to new IDs, retaining legacy behavior. Keep the existing scope clear: do not infer a single media state for arbitrary sequences/workflows with multiple effects. Explain any intentional limits in the PR.

Preserve PR14 activity overlays exactly: observed appearance is the base, running/success/failure feedback composes over it, and cancellation restores the latest observed state. Do not change activity keys, concurrency handling or terminal timers. Desktop, web deck and generated device-frame appearance must use the same resolved media state. If state becomes unknown/disconnected, clear stale confirmed feedback rather than freezing a misleading icon.

No brightness work, generic toggles, keyboard changes, credentials/OBS work, refresh scheduling or general UI redesign in this task. Audio/microphone behavior and diagnostics remain unchanged except a focused media-status compatibility adjustment if required.

## Verification and handoff

Mock MPRIS tests cover all six commands, explicit/default player, no player, explicit disappearance without fallback, unsupported capability/method, a failed player query alongside a healthy one, D-Bus timeout/error, cancellation and cleanup. Assert observed Play/Pause changes from external events or polls, unknown/stopped/disconnected handling, no optimistic toggle, and recovery on a later valid observation.

Add catalog/library tests for all six tiles in Media, hidden legacy tile, legacy editing/import/export/reload, shared workflow execution and selected-player config. Exercise shared feedback while a media button is running and when cancelled/finished; retain concurrent activity. Verify representative desktop/web/generated-frame output without claiming actual hardware or real desktop playback testing.

Include a concise action-ID, default-player, observed-state and appearance-precedence contract for PR12/19 and the host acceptance session.
