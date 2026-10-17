# PR03: Home health dashboard and discovery prompt

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

Requires PR01 / GitHub #10 and PR02 / GitHub #13, both merged. Create codex/home-health-discovery.

PR02 provides Snapshot.health (with buildHealth(snapshot) fallback), HealthRecord and remedyFor in src/shared/health.ts. States are healthy, idle, unconfigured, degraded and unavailable. Diagnostics.tsx already uses these with diagnose, diagnosticRemedy {healthId, action: copy|open}, and device retry requests. Reuse the exact same causes and remedies; don't create another probe or privilege/install mechanism. Navigate to the existing Diagnostics section for detail if useful, without editing Settings.tsx or Diagnostics.tsx during this wave.

PR01 provides per-device presence/configuration/readiness, deviceStatusLabel and error details. Ready follows successful open and initial writes; enumeration alone is not readiness. Historical host evidence was an Elgato Stream Deck XL with discovery succeeding but HID open failing EACCES on /dev/hidraw. This motivated PR01/02 and remains a final physical acceptance fixture, not evidence that their newly merged code is still broken. The app must continue to run as the normal user.

The current top rail button in renderer/src/main.tsx calls setTab("deck"); store.ts supports deck/flows/settings and starts on deck. Add a real home route, correct title and selected-state semantics. Make Home the initial overview if this fits existing navigation, while retaining independent active deck/profile/page state. Existing tests that need the deck may explicitly navigate to it; do not remove functional assertions.

AddDeck in DeckManager.tsx currently takes only onClose and lists unconfigured devices. Extend it with a focused device-prefill prop so a discovery prompt opens the existing modal with the chosen device identified and requires an explicit Add confirmation. Keep generic Add deck and simulator/web creation intact. Use live availability when confirming, not a stale captured device.

## Full outcome and acceptance

The top rail button opens Home with all configured decks, honest readiness, relevant tool/integration health, current faults and repair links. Web sharing/server availability and paired browser presence are separate facts; a running server does not prove a client is connected. Simulator availability is distinct from hardware readiness. Show warning summaries for broken configured features; optional unconfigured OBS/media integrations should not make the workspace appear broken. Missing optional tools can remain visible as informational setup guidance.

Show an accent-colored "New Stream Deck detected — Add" prompt immediately above Add deck for unconfigured, present physical hardware. Use restrained pulsation only when prefers-reduced-motion permits. Deduplicate by stable serial-derived identity, handle multiple devices and re-enumeration/path changes, remove only the configured prompt after addition, and withdraw prompts on unplug. Never add hardware automatically. A session-only identity cannot be silently persisted as a stable hardware ID; preserve the existing explanation if a serial is unavailable.

Home, rail, deck and Diagnostics must agree on permission/open/I/O errors. Preserve raw observed-state details and secret-redaction by linking to the existing diagnostics, not by dumping unfiltered state into Home. Retry/recheck must use existing validated requests and display recovery. Preserve accent colors, flow/profile selection and pairing banner routes.

Use new focused Home/discovery tests. Cover empty workspace, healthy devices, configured disconnected hardware, permission denied, mixed faults, unconfigured integrations, web server without clients, live recovery, keyboard navigation, reduced motion, duplicate discovery, multiple new devices, disappearance while modal open, and addition removing only its own prompt. Verify clicking each deck still opens it and does not change another deck's selection. Include visual observation at normal and narrow desktop widths. Keep CI and existing flow/diagnostics tests passing. Physical appearance/input acceptance remains pending.
