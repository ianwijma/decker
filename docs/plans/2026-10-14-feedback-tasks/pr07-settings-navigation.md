# PR07: Settings navigation cleanup

Implement only this feedback-plan item in repository ianwijma/decker. The coordinator selects Codex Cloud environment decker, GPT6.1 SOL (gpt-6.1-sol), and High reasoning in the launch controls. These settings are verified outside your session; inability to introspect them is not a blocker.

This is wave three: PR03 Home/discovery, PR06 workflow UUIDs/selectors, and PR07 Settings navigation. Plan item numbers are not GitHub PR numbers. The coordinator verified PR02 merged as GitHub #13 (2b2d6d5260184405e1f4e558b0654a758ccbd7c5), PR05 as #11 (7d92d046725b465b11ceca6e2522a2766800b8b6), and PR25 as #12 (87b215c1a12540ccd5a1cfa70ad5dfef19cae847). All are ancestors of origin/develop at 2b2d6d5260184405e1f4e558b0654a758ccbd7c5. Their PR CI passed. The latest develop CI run 38550080864 was in progress at preparation; recheck before finalizing. No open develop PRs existed at dispatch preparation.

Read applicable AGENTS.md instructions, locate the repository, fetch current origin/develop, and verify your predecessors before branching. Start the specified codex/ branch from latest origin/develop, not a stale environment snapshot. Preserve unrelated setup changes and check for duplicate branches/PRs. Open one focused PR with base develop, attach it to your chat if supported, and return the link. Do not merge, start successor tasks, publish releases, create live release tags, dispatch release workflows, or create/promote main.

You have no physical hardware access. Use fixtures, mocks and Electron/simulator/web tests. The host coordinator will perform one consolidated hardware session after the selected implementation PRs merge. Report physical acceptance pending; do not modify host permissions or claim real-device verification.

The plan/evidence files under docs/plans may be local-only. This attachment is the full relevant handoff, so their absence is not a blocker. Keep the JSON node configuration editor, switch behavior/ports, existing actions and saved documents compatible. Preserve both previous waves' fixes. No unrelated refactor, README rewrite, icon pack, toggle, scheduling, credentials redesign or release work.

Run meaningful focused tests and applicable npm run format:check, npm run typecheck, npm test, npm run build, and Electron E2E (xvfb-run --auto-servernum npm run test:e2e where available). Use current CI for exact commands and retain packaging/native smoke gates. Distinguish missing environment prerequisites or restricted loopback/subprocess access from product failures; use the permitted environment rather than weakening checks. Restore dependencies from the lockfile as needed. Rebase onto current develop and rerun affected tests before finalizing. Describe behavior, compatibility, validation, any blocked checks and remaining host gates in the PR.

## Wave ownership

PR03 owns renderer main.tsx, store.ts routing, DeckManager.tsx add-flow integration, new Home/discovery components and scoped styles. PR06 exclusively owns persisted schema/version migration, workflow field metadata, reusable dropdown changes, components.tsx action/target fields, Flows.tsx, workflow defaults/persistence/runtime alias resolution and history filtering. PR07 owns Settings.tsx and a focused settings-navigation stylesheet. Avoid global styles.css changes: use new scoped stylesheets. Each task owns new focused test files; minimize changes to existing shared tests and preserve their assertions.

PR14 cancellation is deliberately queued behind PR06's merge because both touch runtime workflow lookup. PR06 should document its alias resolution API for that follow-up, but must not implement cancellation fixes. No other agent may allocate a schema version during this wave. PR03 and PR07 do not edit shared/schema.ts or backend integration files. If shared code outside your allocation truly needs work, keep the feature's independent implementation progressing and report the exact required integration patch; do not take over another lane.

## Dependency, branch and exact ownership

No predecessor is required by the plan, but start from the latest develop containing PR02 / GitHub #13 so its extracted Diagnostics component remains intact. Create codex/settings-navigation.

Own only src/renderer/src/Settings.tsx, a new focused settings-navigation stylesheet imported there, and new settings-navigation E2E coverage. PR03 owns the main rail, Home route, store routing and DeckManager.tsx; PR06 owns reusable components, workflows, persisted schema and runtime lookups. Use existing store APIs and existing section names general/web/diagnostics/runs. Do not edit store.ts, main.tsx, DeckManager.tsx, Diagnostics.tsx, Runs.tsx or shared components for routine changes. Global style rules can be overridden narrowly in your scoped stylesheet; do not remove styles that might have other consumers.

## Full plan item

General, Web decks, Diagnostics and Run history become peer settings sections. General no longer repeats the Devices card/list; device management stays in the rail and deck settings. Remove the special Diagnostics-parent styling when Run history is selected. Exactly the selected peer must appear active, including accessible current/selected semantics.

Preserve accent controls/custom color, startup/close behavior, run retention, import/export, connections and credential editing, web sharing/pairing approvals and current section content. Do not hide or redesign Connections/Credentials: PR08 and PR09 handle that separately. Preserve PR02's structured diagnostics and raw redacted observed state. Diagnostics' existing Open run history action should still open Run history, now as its own peer.

## Verification

Add focused Electron coverage for clicking and keyboard-navigating all four peers, only one active state, opening Run history via the existing Diagnostics button, and removing the redundant General Devices card while keeping deck navigation and settings usable. Smoke the retained preferences, import/export entry points and web pairing controls without executing destructive imports or modifying real credentials. Keep tests independent of hardcoded workflow IDs so PR06 can merge cleanly.

Perform a visual check at normal and narrow desktop widths: peers have equal hierarchy, selected state is clear, content and focus rings remain visible, and no unwanted horizontal overflow occurs. This is a small reversible UI change: don't add tests that mirror implementation details or broaden into an unrelated settings redesign. Run the applicable checks and existing diagnostics E2E regressions.
