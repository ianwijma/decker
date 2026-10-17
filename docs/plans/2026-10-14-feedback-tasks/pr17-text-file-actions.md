# PR17: Read, write and append text files

Implement only this item in ianwijma/decker. The coordinator selects Codex Cloud environment decker, GPT6.1 SOL (gpt-6.1-sol), High reasoning in launch controls. These settings are verified outside your session; inability to introspect them is not a blocker. Plan item numbers are not GitHub PR numbers. This attachment is complete; local planning files may not be in your checkout.

## Launch and delivery contract

Read applicable AGENTS.md, fetch latest develop, check predecessor merges and duplicate branches/PRs, and create codex/text-file-actions from current origin/develop. Open one focused PR with base develop and attach it to your chat if supported. Do not merge, launch successor tasks, dispatch release workflows, tag or publish releases, or promote main. Preserve unrelated environment setup changes.

The coordinator verified wave-six merges and successful PR CI: PR09 OBS as GitHub #24 (e158f91bd2df38f6bba9d96109778c87827874b8), PR12 brightness as #23 (d76762a256665e5daddfe7ead01c6eca0868ca4a), and PR16 data UI as #25 (6026bc1995ae4aa8814423390875dce614b498cd, current develop at preparation). PR10 file picker and PR15 data runtime are merged predecessors. No develop PRs were open at preparation. Develop CI https://github.com/ianwijma/decker/actions/runs/38639173692 was in progress, with format/typecheck/unit/build/source Electron passed and packaging underway; verify its final result rather than assuming success.

The user explicitly requires green CI. Do not stop after creating the PR or while required checks are queued/running. Run appropriate local checks, push, inspect all required GitHub checks on the FINAL pushed head, fix failures within this task, and wait for success. If develop advances, rebase and rerun affected verification; a newer push invalidates previous CI evidence. Preserve CI, packaging/native tests and assertions; do not disable or weaken checks. Deliberate publication-job skips for PRs are expected, not permission to skip test jobs. Report PR URL, final head SHA, check/run links, test summary and any genuine external blocker. A blocked check must be reported honestly, never as green. Poll with reasonable backoff.

You have no physical hardware access. Use temporary directories, mocked dialogs, local fixtures, simulator/web/Electron tests and virtual display. Physical Stream Deck, real host permissions and desktop acceptance remain pending for the coordinator's final consolidated session. Do not claim those checks passed.

## Wave ownership and independence

Only PR17 file actions and PR18 toggle runtime run this wave. Scheduling is deferred at the user's request. Both PRs must be independently mergeable against existing develop, with no dependency on the other's unmerged code.

PR17 owns new file-operation modules/tests, its catalog definitions and action-handler dispatch, file output/type metadata in shared/data-presentation.ts, and generic file-picker destination support. In shared/schema.ts you may extend ONLY the desktop pickFile request variant; PR18 owns binding/document schema and version/migration. In main/index.ts you own ONLY native file-dialog request handling/imports. In renderer/src/components.tsx you own ONLY generic file field/picker wiring and any file-content textarea metadata. No document migration/version bump, engine/coordinator/worker rewrite, toggle configuration, credential owner traversal or scheduler work in this PR.

PR18 owns toggle schema/migration, runtime engine/coordinator/worker, trigger routing, state persistence/snapshot integration and target walkers. Reuse the existing ResourceLocks API without changing coordinator.ts; if file locking needs more, use a dedicated module. Preserve other lanes on rebase. Avoid broad shared-file formatting/refactors. No changes need to wait for PR18.

## Required behavior

Add separate Read text file, Write text file and Append text file actions in both relevant action palettes. Use distinct stable action IDs and catalog schemas. Absolute host paths only in this initial version; no binary pipelines, globs, implicit home/environment expansion or broad filesystem browser. Path and content accept the existing declarative variable/reference/template grammar and are validated after resolution, before effects.

Read is bounded UTF-8 text with documented byte limits and typed output. Never silently present truncated text as complete: expose a truncation flag or fail explicitly, and expose text/byte fields in the data picker. Write replaces content through a same-directory temporary file plus rename; Append adds text without overwriting existing bytes. Both return bounded useful typed metadata, not a duplicate of arbitrarily large content. Explicitly distinguish overwrite and append, and an optional create-parent-directories setting with a conservative default. Explain that successful writes are external effects and cancellation cannot undo them.

Use a native open-file chooser for Read and destination/save chooser for Write/Append, including a new file destination. Keep manual absolute paths and variable-driven paths available. Dialog cancellation leaves previous values intact. Reuse stale-completion guards so a result cannot update a different field/action after navigation or edits. Extend the validated request union and main-frame-only desktop IPC; paired browsers must never obtain arbitrary file dialogs, paths or filesystem commands beyond invoking already-saved bindings.

Serialize conflicting operations by canonical destination within the process. Define alias/symlink handling so simple alternate paths cannot bypass serialization or unexpectedly overwrite a link; reject unsupported targets clearly. Handle non-regular files safely (directories, device nodes/FIFOs must not hang the worker). Keep unrelated files concurrent. Preserve existing file permissions where appropriate on overwrite; choose a conservative new-file mode. Clean up temp files on errors/cancellation; check abort while queued, during bounded work and immediately before rename. No partially replaced destination on failed pre-commit writes. Append is not atomic rollback: default retries off, mark non-idempotent using existing retry metadata, and report partial-side-effect limitations without claiming cancellation reverses data. Do not retry an ambiguous append automatically.

Report missing parent directories, access denied, invalid targets, excessive size and malformed path/content clearly. Tests for EACCES should be deterministic under a root-capable cloud runner (inject controlled failures as appropriate). Bound memory and file reads by bytes, including multibyte UTF-8 boundaries; avoid an unbounded read followed by truncation.

## Existing contracts to preserve

Read docs/workflow-data.md, docs/data-binding-ui.md, docs/managed-secrets.md and docs/relative-brightness.md. Data grammar: whole-field $ref preserves native JSON; $template joins literal/reference segments; $literal escapes an entire literal. Paths can be segment arrays for dotted/empty keys; fallback only applies to missing values. shared/data-contract.ts guards own-property paths and unsafe keys/getters. Do not evaluate expressions or silently coerce arrays/objects into text.

HTTP returns {status,body,truncated}; Parse JSON accepts the complete envelope or raw text, and Extract returns {value:JSON}. Use output schema metadata/data-presentation.ts so File outputs are discoverable through the merged picker. Existing ActionFields wraps literals with ExpressionEditor; preserve its secret early-return, named OBS/workflow selectors, typed args, explicit modes and scoped async guards. Shared data availability uses graph dominators; do not offer downstream outputs as available.

main/desktop-file-picker.ts currently wraps showOpenDialog; renderer/src/file-picker.tsx tracks scope/action/field revision and uses request {type:pickFile,picker:openFile}. Extend this narrowly for save destinations, preserving existing Open file behavior. Keep URL/file protocol validation and strict IPC senders. File effects belong in the normal runtime action handler after schema/resolver validation, not generic renderer IPC.

Preserve schema v3 documents and UUID aliases, cancellation that bypasses retries/error edges, run activity separate from observed state, immutable definitions and secret redaction, managed credential owner+epoch mutations, media feedback, Lucide tokens/assets, canvas/minimap, brightness mutation serialization and paletteContexts. No credential values in logs/history. Do not alter switch semantics, node JSON editor, release workflows or final README overhaul.

## Acceptance and handoff

Use temporary-directory tests for all operations, Unicode/spaces, empty/multibyte content, bounded reads/outputs, invalid/non-regular targets, parent-directory option, permission preservation, controlled EACCES, overwrite atomicity and cleanup, same-path concurrency/alias policy, unrelated-path concurrency, queued cancellation and cancellation just before commit. Cover append retry policy and irreversibility. Test native chooser selection/cancel/stale completion and paired-browser rejection of filesystem IPC.

Add an end-to-end workflow using a local HTTP fixture -> Parse JSON -> Extract value -> Write text file, then Read and Append; verify typed/mixed templates and real resulting temporary file contents, save/reload and visible file action discovery. Do not depend on PR18. Preserve native picker, secret/binding UI and cancellation regressions. Run applicable npm run format:check, npm run typecheck, npm test, npm run build and Electron tests using current CI commands/virtual display. Existing CI must still exercise packaging, notices and native smoke.

Document action IDs/config/output/limits, path and overwrite/append semantics, cancellation/retry behavior and deferred host acceptance. Finish only after the final head's required CI is green, with one focused develop PR and evidence links; report genuine blockers explicitly.
