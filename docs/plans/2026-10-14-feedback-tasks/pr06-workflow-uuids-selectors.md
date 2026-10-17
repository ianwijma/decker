# PR06: Hidden workflow UUIDs and consistent selectors

Implement only this feedback-plan item in repository ianwijma/decker. The coordinator selects Codex Cloud environment decker, GPT6.1 SOL (gpt-6.1-sol), and High reasoning in the launch controls. These settings are verified outside your session; inability to introspect them is not a blocker.

This is wave three: PR03 Home/discovery, PR06 workflow UUIDs/selectors, and PR07 Settings navigation. Plan item numbers are not GitHub PR numbers. The coordinator verified PR02 merged as GitHub #13 (2b2d6d5260184405e1f4e558b0654a758ccbd7c5), PR05 as #11 (7d92d046725b465b11ceca6e2522a2766800b8b6), and PR25 as #12 (87b215c1a12540ccd5a1cfa70ad5dfef19cae847). All are ancestors of origin/develop at 2b2d6d5260184405e1f4e558b0654a758ccbd7c5. Their PR CI passed. The latest develop CI run 38550080864 was in progress at preparation; recheck before finalizing. No open develop PRs existed at dispatch preparation.

Read applicable AGENTS.md instructions, locate the repository, fetch current origin/develop, and verify your predecessors before branching. Start the specified codex/ branch from latest origin/develop, not a stale environment snapshot. Preserve unrelated setup changes and check for duplicate branches/PRs. Open one focused PR with base develop, attach it to your chat if supported, and return the link. Do not merge, start successor tasks, publish releases, create live release tags, dispatch release workflows, or create/promote main.

You have no physical hardware access. Use fixtures, mocks and Electron/simulator/web tests. The host coordinator will perform one consolidated hardware session after the selected implementation PRs merge. Report physical acceptance pending; do not modify host permissions or claim real-device verification.

The plan/evidence files under docs/plans may be local-only. This attachment is the full relevant handoff, so their absence is not a blocker. Keep the JSON node configuration editor, switch behavior/ports, existing actions and saved documents compatible. Preserve both previous waves' fixes. No unrelated refactor, README rewrite, icon pack, toggle, scheduling, credentials redesign or release work.

Run meaningful focused tests and applicable npm run format:check, npm run typecheck, npm test, npm run build, and Electron E2E (xvfb-run --auto-servernum npm run test:e2e where available). Use current CI for exact commands and retain packaging/native smoke gates. Distinguish missing environment prerequisites or restricted loopback/subprocess access from product failures; use the permitted environment rather than weakening checks. Restore dependencies from the lockfile as needed. Rebase onto current develop and rerun affected tests before finalizing. Describe behavior, compatibility, validation, any blocked checks and remaining host gates in the PR.

## Wave ownership

PR03 owns renderer main.tsx, store.ts routing, DeckManager.tsx add-flow integration, new Home/discovery components and scoped styles. PR06 exclusively owns persisted schema/version migration, workflow field metadata, reusable dropdown changes, components.tsx action/target fields, Flows.tsx, workflow defaults/persistence/runtime alias resolution and history filtering. PR07 owns Settings.tsx and a focused settings-navigation stylesheet. Avoid global styles.css changes: use new scoped stylesheets. Each task owns new focused test files; minimize changes to existing shared tests and preserve their assertions.

PR14 cancellation is deliberately queued behind PR06's merge because both touch runtime workflow lookup. PR06 should document its alias resolution API for that follow-up, but must not implement cancellation fixes. No other agent may allocate a schema version during this wave. PR03 and PR07 do not edit shared/schema.ts or backend integration files. If shared code outside your allocation truly needs work, keep the feature's independent implementation progressing and report the exact required integration patch; do not take over another lane.

## Dependency, branch and merged contracts

Requires PR05 / GitHub #11, merged. Create codex/workflow-uuids-selectors.

Reuse src/renderer/src/SearchableDropdown.tsx: options have id/name/optional description and the component takes label, searchLabel, options, value and onSelect. It currently exposes IDs to disambiguate duplicate names. This item must hide workflow UUIDs in ordinary UI, including duplicate-name choices and the workflow footer; use a human-readable disambiguator (for example ordinal/revision/context) while retaining accessible unique choices. Preserve profile behavior, keyboard/focus handling and 50+ item performance. Missing/deleted workflow values need an explicit useful state, never an apparently valid first option selected silently.

Current defaults() in shared/defaults.ts creates schemaVersion 2 and workflow "welcome"; uid() already uses crypto.randomUUID(). documentSchema in shared/schema.ts accepts v2, and shared/decks.ts contains the existing v1-to-v2 migration. main/persistence.ts backs up non-v2 loads and validates imports, so all load/save/import/export paths must be updated together. Introduce the next ordered migration after v2 (v3 if still available after fetching) and be its sole owner. Preserve v1-to-v2 migration semantics. An unsupported future document version must fail clearly with backup and must not overwrite the original workspace with defaults.

ActionFields and TargetEditor live in components.tsx. workflow.run and workflow.cancel catalog fields currently ask for "Workflow ID"; subflow selection and the visible workflow-ID footer are in Flows.tsx. Workflows can occur in press/release/longPress assignments, action sequences, workflow.run/workflow.cancel actions, subflow configs and recursively nested branch/body graphs. Preserve explicit subflow revision selection and existing dynamic data references.

## Full outcome

All newly generated persisted workflow IDs, including defaults, are UUIDs. Users select by workflow name in direct assignments, Run workflow, Cancel workflow and subflow nodes; add workflow field metadata rather than scattering action-ID special cases. The closed dropdown shows the current name and search is inside the opened dropdown. Rename never breaks a binding. Keep ordinary workflow IDs hidden, while diagnostic/export data can still identify records.

Migrate known legacy workflow identities with one old-to-new map applied consistently across all actual typed references and nested graphs. Preserve node IDs, graph layouts, revisions, declarations, binding identity/generation and unrelated data. Existing UUID identities remain stable. Do not replace arbitrary user text, shell scripts, HTTP bodies, labels or string literals merely because they match an old workflow ID. Dynamic references cannot all be statically rewritten: maintain a validated persistent legacy-alias strategy, resolve it at execution/validation boundaries, and cover dynamically computed Run/Cancel/subflow references. Avoid alias collisions, cycles or ambiguous imported mappings. Export/import and repeated reloads preserve the mapping without repeatedly generating new UUIDs.

Retain historical run records as originally recorded. Filtering/current-flow history can resolve aliases for association, but must not rewrite run identity, timestamps or pretend legacy runs were executed using new IDs. Add a focused alias helper shared by required lookup sites, and explain its API in the PR for PR14's cancellation work. Do not turn synthetic direct wrappers into user-selectable workflows.

Back up before migration, validate the migrated result, then persist atomically using the existing persistence discipline. Malformed/colliding/unsupported data must leave a recoverable original and a clear error. No importing a workspace may execute commands or workflows as a migration side effect.

## Verification

Cover fresh defaults, the welcome workflow, arbitrary legacy IDs, existing UUIDs, v1 and v2 imports, nested references including run/cancel action sequences and subflows, dynamic legacy references, duplicate names, renaming, missing/deleted workflows, export/reimport, idempotent reload, migration failure/backup, unsupported future versions and old run filtering. Check that only reference-bearing fields change.

Use Electron E2E to select workflows in every UI surface (including actions inside sequences), rename them, create new ones and reload. Verify no UUID appears in routine flow dropdowns/details, including duplicate-name cases. Preserve JSON config editing and binding objects, PR04's canvas state/minimap/layout/nested scopes, PR05's focus-on-name behavior and deck-scoped profile dropdowns.

Adapt existing tests that hardcode welcome only where the requirement intentionally changes it; use returned/generated IDs in new tests. Preserve assertions on real behavior and all canvas/selector regressions. Document the resulting schema version and alias contract in the PR. Cancellation semantics themselves remain PR14.
