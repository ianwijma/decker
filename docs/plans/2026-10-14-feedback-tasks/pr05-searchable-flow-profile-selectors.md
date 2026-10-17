# PR05: Searchable flow/profile selectors and flow naming

Implement only this feedback-plan item in repository `ianwijma/decker`. The coordinator will select Codex Cloud environment `decker`, GPT6.1 SOL (`gpt-6.1-sol`) and High reasoning in the launch UI. These settings are verified outside your session; inability to introspect the UI settings is not an implementation blocker.

This is wave two of the authorized plan: PR02 diagnostics, PR05 selectors and PR25 stable-release tooling run independently. Plan item numbers are not GitHub PR numbers. The coordinator verified that PR01 merged as GitHub #10 (097264ec9db788ac4160f4607312845b2a5c6c0d), PR04 as #9 (40604d49ff31e8a111b2247009ba923c693c1524), and PR24 as #8 (b15efbd20b1eceb0888618319e85a4ba14135d37). All are ancestors of current develop 40604d49ff31e8a111b2247009ba923c693c1524. No open develop PRs existed at dispatch preparation.

Read applicable AGENTS.md instructions, locate the repository, fetch current origin/develop and verify the relevant predecessor is present before branching. Use the specified codex/ branch from the latest origin/develop, not the potentially stale environment snapshot. Preserve unrelated setup changes. Check for a duplicate branch/PR. Open one focused PR against develop, attach it to your chat if supported, and return its link. Do not merge, start successor tasks, manually dispatch workflows, create live release tags, publish a release, or create/promote main during implementation.

You have no physical hardware access. Use fake transports, mocked desktop services, local fixtures and simulator/Electron tests. Physical device tests and any host permission changes belong to the coordinating host after all selected implementation PRs land. Report physical acceptance pending.

The plan and hardware evidence in docs/plans/2026-10-14-*.md may still be local-only. This brief includes the full relevant requirements, so their absence is not a blocker. The current develop CI run 38544835945 was in progress at preparation; predecessor PR checks passed. Recheck current CI when preparing your PR and address failures attributable to your work without weakening existing checks.

Run meaningful focused regression tests plus applicable npm run format:check, npm run typecheck, npm test and npm run build. UI work requires Electron E2E; use xvfb-run --auto-servernum npm run test:e2e where available. Packaging/release work requires package and packaged Electron/native smoke verification. Read current CI for exact commands. Resolve stale environment dependencies from the lockfile where permitted; accurately report blocked checks rather than treating missing Xvfb, denied loopback/subprocess access or missing setup packages as product failures. In your PR describe behavior, compatibility, test evidence, remaining gates and any environmental limitations. Use scoped new test files/modules to avoid other lanes. Rebase from develop and rerun affected tests before finalizing.

## Dependency, ownership and merged implementation

Dependency: PR04 / GitHub #9. Create codex/searchable-flow-profile-selectors.

Own src/renderer/src/Flows.tsx, Deck.tsx, a focused reusable accessible searchable-dropdown component and stylesheet, minimal components.tsx integration if necessary, and editor tests. Avoid shared/schema.ts, main/index.ts, runtime adapters, Settings.tsx, CI/release files and broad global styles. PR02 owns health/diagnostics and shared observed contracts; PR25 owns delivery tooling. No persisted schema migration, UUID migration or action workflow-ID dropdowns in this PR; those are PR06. Make the dropdown reusable for that follow-up.

Preserve PR04's FlowCanvas scoped state, dimensions/drag reconciliation, layout-save filtering, stable selectors in flow-selectors.ts, minimap and nested graph/viewport behavior. Flow creation currently selects first.id; this item intentionally changes it to no node selected and focus/selection on the top name input. Adapt the existing new-workflow selection assertion to the new requirement without disabling the rest of tests/e2e/flow-canvas.spec.ts. Keep source state updates stable under device/observed snapshots. Preserve PR01's truthful device badges in Deck.tsx.

Keep the JSON config editor and switch semantics/ports, runtime timeout, input/output declarations, test inputs and node/action libraries. A searchable dropdown means a compact closed selected value, then search and options inside the opened dropdown, not a permanently filtered list. Creating a profile must activate it on the current deck using the normal navigation path. Verify switching decks never leaks another deck's profiles.

## Full plan item

### PR05 Searchable flow and profile selectors and flow naming

**Outcome:** Many flows/profiles no longer push their libraries down the page. Creating a workflow selects it and focuses its name at the top.

Own a reusable accessible searchable dropdown, flow/profile selector integration and flow toolbar. Keep search inside the open dropdown; show the selected value when closed. Support keyboard arrows, Enter, Escape, focus return, no results, duplicate names and enough rows to exercise 50+ items. Profile options must belong to the selected deck.

Move flow-name editing to the toolbar and remove the duplicate inspector name field. New flows still contain Deck press, but start with no node selected and the name selected for editing. Preserve runtime timeout, declarations, test inputs and the node library. Newly created profiles select immediately.

**Acceptance:** E2E tests with 50 flows and 50 profiles, create/rename/switch/reload, dropdown focus behavior and deck-scoped profile selection. Existing navigation commands still update the selected value.
