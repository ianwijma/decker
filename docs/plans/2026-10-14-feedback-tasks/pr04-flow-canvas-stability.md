# PR04: Stable flow canvas and working minimap

Implement this task in the published Codex Cloud environment `decker`, repository `ianwijma/decker`, using GPT6.1 SOL (`gpt-6.1-sol`) with High reasoning. Those are launch settings, not settings a prompt can enforce. If the selected environment/model differs, report the mismatch before implementation.

The user authorized starting the feedback implementation plan. This is one of three independent tasks in the first batch (PR01, PR04 and PR24). These labels identify plan items, not existing GitHub PR numbers. Do not start dependent tasks or combine other plan items into this PR.

Locate the repository, read its applicable AGENTS.md instructions, inspect the current state, fetch origin, and create the specified `codex/` branch from the latest `origin/develop`. Preserve any environment setup changes instead of resetting them blindly. Open one focused GitHub PR with base `develop`, and attach it to this chat if the app tool is available. Do not merge the PR or manually publish a release. Check for an existing branch/PR for this exact plan item before creating duplicates.

You have no physical Stream Deck access. Use fake transports, simulator/browser tests and captured evidence. Do not probe devices, ask for hardware access, or claim physical verification. The coordinating host will run the consolidated hardware session after all implementation PRs merge to develop. Report hardware acceptance as pending.

The source plan is `docs/plans/2026-10-14-feedback-plan.md`, with companion `docs/plans/2026-10-14-hardware-evidence.md`. These documents may not yet exist on origin/develop. This prompt includes the complete task requirements and relevant evidence; their absence is not a blocker. Baseline research used develop SHA `b57bd05d09119c4bb746b77909393791afc1b942`; recheck the current source rather than assuming it is unchanged.

Add meaningful regression tests for the specified behavior. Run applicable checks from package.json: `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`; UI changes also require Electron E2E tests (`xvfb-run --auto-servernum npm run test:e2e` in Linux CI). Native/asset/release changes require package and packaged-app smoke verification where supported. Read the current workflow for the exact packaged test command. Identify environment restrictions accurately rather than weakening assertions or treating blocked networking/subprocesses as product failures.

In the PR and final response, explain the resulting behavior, compatibility, regression evidence, exact commands/results, any blocked checks, and remaining host acceptance gates. Return the PR link and branch. Keep changes within the ownership boundaries below; report a necessary cross-lane conflict before editing another lane's files.

Create branch `codex/flow-canvas-stability`. This task has no predecessor PRs.

## Ownership and scope

You own `src/renderer/src/Flows.tsx`, focused flow styles, canvas-specific store selectors, and editor tests. Keep store changes compatible with current snapshot consumers and avoid modifying the hardware status contract. Use a focused stylesheet rather than broad global CSS changes where practical. PR01 owns device code, shared device status, minimal main-process plumbing and direct deck status badges. PR24 owns CI and packaging. Do not change `Deck.tsx`, catalog semantics, schema versions or release workflow files.

Keep the JSON configuration editor and existing node semantics. Preserve switch case/default/error handles and nested graphs. Searchable workflow/profile dropdowns and moving flow-name editing are later PR05, not this task. Source-based suspects: controlled nodes are reconstructed, dimensions changes are ignored, and frequent whole snapshots arrive through the store. These are investigation leads, not a proven root cause. Reproduce and measure the actual problem before selecting a fix.

## Full plan item

### PR04 Stable flow canvas and working minimap

**Outcome:** Dragging nodes is visually stable, positions persist, and minimap nodes appear at the right positions.

Own `Flows.tsx`, focused flow styles, canvas/store selectors and editor tests. Reproduce dragging under incoming device/observed-state snapshots. Investigate ignored dimension changes, controlled-node reconstruction, local position lifetime and unnecessary snapshot subscriptions. Preserve React Flow measurement/state updates; persist only actual layout changes, without feeding a save loop into every drag event. Keep viewport state stable and reset graph-specific position state when switching workflows or nested scopes.

Audit each existing node kind for regression behavior: trigger, delay, condition, switch, set, parallel, repeat, foreach, subflow, return and shared action nodes. This PR owns canvas/ports, not new node semantics. In particular preserve dynamic switch case handles, default/error ports and nested canvases.

**Acceptance:** E2E drag tests under synthetic snapshot updates, visible minimap rectangles, reload position preservation, nested graph navigation, multi-select/delete and zoom/pan. Include visual observation or a recording for flicker; a final-position assertion alone does not prove it is fixed.
