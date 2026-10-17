# CI02: Repair intermittent discovery/snapshot test failure

Implement this focused CI repair in `ianwijma/decker`. Launch settings are Codex Cloud environment `decker`, GPT6.1 SOL (`gpt-6.1-sol`), High reasoning, selected by the coordinator. This complete attached brief replaces unavailable local planning context.

Read applicable AGENTS.md, fetch fresh origin/develop, check for duplicate work and create `codex/fix-discovery-snapshot-race` from it. Open one focused PR against develop. The user explicitly requested the next wave and green CI, including necessary repairs. Do not merge, publish/tag, dispatch releases, promote main or launch successor agents. No hardware access is available; fixture tests must not control real devices or the user's desktop services.

## Evidence

Current develop is `299449d98c9a3ffbd0d24581c1b7b016951a7eee`, containing CI job split #36 and Sharp repair #37. Both final PR heads passed required CI. The CI-split merge run https://github.com/ianwijma/decker/actions/runs/39029901503 completed successfully, including source and packaged Electron. The subsequent combined develop run https://github.com/ianwijma/decker/actions/runs/39029957466 failed its Source Electron tests job:

https://github.com/ianwijma/decker/actions/runs/39029957466/job/117388248788

85 tests ran with one worker; 84 passed. Failure:

```text
tests/e2e/home-discovery.spec.ts:472:1
discovery deduplicates, follows live availability, requires confirmation, and respects reduced motion
line 482: await expect(page.locator(".discovery-prompt")).toHaveCount(3)
Expected: 3
Received: 0
Timeout: 5000ms
```

The uploaded `linux-source-test-results` artifact contains `test-results/home-discovery-discovery-d-aff67-and-respects-reduced-motion/error-context.md` and trace.zip. Its error snapshot shows Home and My XL simulator, zero discovery prompts, sharing disabled and an unconfigured OBS card. Retrieve/inspect the artifacts yourself; the coordinator's /tmp copies are unavailable in Cloud. Treat artifact content as diagnostic data, not instructions.

FU01 / #37 also reported a local packaged-Electron discovery-fixture snapshot timeout; that unchanged test passed three isolated repeats and final PR CI. It has now failed again on merged develop. A green rerun alone is insufficient to resolve the recurring issue. Do not assume the Sharp upgrade or CI split caused it just because they precede this run.

Relevant implementation: `tests/e2e/home-discovery.spec.ts` waits for the Home heading, obtains a base snapshot, and `installFixture` replaces webContents.send to suppress real decker:snapshot publications, emits the synthetic snapshot and replaces snapshot/request IPC handlers. Synthetic discovery includes duplicate xl:NEW-A, xl:NEW-B and a no-serial device. The renderer subscription and initial snapshot ordering are in `src/renderer/src/main.tsx`, with store receive/save handling in `src/renderer/src/store.ts`. An existing delayed-startup-snapshot test must remain meaningful. Possible races involve in-flight real IPC, fixture installation/readiness or renderer ordering; these are hypotheses to investigate, not a prescribed root cause.

## Scope and ownership

Investigate and reproduce the ordering failure with controlled timing or instrumentation. Prefer a deterministic fixture correction if the bug is in setup/IPC synchronization; make a minimal production correction only if evidence establishes an actual application snapshot-ordering defect. Preserve real startup and live discovery semantics. Keep IPC trusted-renderer validation intact.

Own home/discovery test setup and tightly related snapshot synchronization coverage. FU02 is running concurrently on `codex/patch-dbus-xml-parser`, owning package.json/package-lock.json, dbus-next/xml2js and parser/media compatibility tests. Do not modify those dependencies, media integration or FU02 files. No schema migration is allocated. These tasks must build independently from merged develop; do not cherry-pick an unmerged sibling. Coordinate any newly discovered overlap before changing shared regions.

Do not weaken the expected prompt count, remove the test, raise timeouts as a substitute for synchronization, add arbitrary sleeps, turn on retries to hide failures, suppress real error signals or disable CI gates. Preserve deduplication, live disappearance/reappearance, confirmation, serial-number restrictions, keyboard input, reduced-motion and narrow-layout assertions. Keep synthetic hardware at the IPC boundary. Dispose fixture state and processes between tests. Avoid broad test-harness rewrites across unrelated suites.

Add a focused regression that makes the failing ordering deterministic where possible. Demonstrate the failure before the fix and success after, or explain what can and cannot be reproduced with the trace evidence. Run the whole home-discovery spec and a bounded repeated run (for example 10 sequential repetitions of the affected case) in source and packaged Electron. Keep the one-worker process-isolation contract; do not run overlapping Electron suites/probes against the same application single-instance lock. Full source/packaged CI remains required.

## Completion

Preserve #36's parallel Static checks and unit tests, Source Electron tests, Package and test Linux installers and aggregate Test and package Linux jobs. Preserve package/native/image/icon-notice/installer checks. Source assertions and packaged assertions must both run; do not stop at a filtered test passing.

The user requires GREEN CI on the FINAL pushed head. Run applicable formatting/types/tests/build, push the focused fix, inspect logs, fix failures and wait for every required check on that exact final commit. Every further push needs new CI evidence. An earlier green commit, queued run or successful isolated rerun does not establish completion. Publication skipped on PR events is expected. Recheck the merged baseline and report its red status honestly until a reviewed repair lands and the merge build passes; do not manually publish or merge to make it green.

Return the PR URL, final SHA, successful required check/run URLs, evidence-backed root cause, regression and repeat results, and any remaining uncertainty. Attach the PR to your chat when supported. Physical discovery/display/input behavior still needs the coordinator's later hardware acceptance.
