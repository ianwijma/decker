# PR25: Tagged stable releases and linked PR notes

Implement only this feedback-plan item in repository `ianwijma/decker`. The coordinator will select Codex Cloud environment `decker`, GPT6.1 SOL (`gpt-6.1-sol`) and High reasoning in the launch UI. These settings are verified outside your session; inability to introspect the UI settings is not an implementation blocker.

This is wave two of the authorized plan: PR02 diagnostics, PR05 selectors and PR25 stable-release tooling run independently. Plan item numbers are not GitHub PR numbers. The coordinator verified that PR01 merged as GitHub #10 (097264ec9db788ac4160f4607312845b2a5c6c0d), PR04 as #9 (40604d49ff31e8a111b2247009ba923c693c1524), and PR24 as #8 (b15efbd20b1eceb0888618319e85a4ba14135d37). All are ancestors of current develop 40604d49ff31e8a111b2247009ba923c693c1524. No open develop PRs existed at dispatch preparation.

Read applicable AGENTS.md instructions, locate the repository, fetch current origin/develop and verify the relevant predecessor is present before branching. Use the specified codex/ branch from the latest origin/develop, not the potentially stale environment snapshot. Preserve unrelated setup changes. Check for a duplicate branch/PR. Open one focused PR against develop, attach it to your chat if supported, and return its link. Do not merge, start successor tasks, manually dispatch workflows, create live release tags, publish a release, or create/promote main during implementation.

You have no physical hardware access. Use fake transports, mocked desktop services, local fixtures and simulator/Electron tests. Physical device tests and any host permission changes belong to the coordinating host after all selected implementation PRs land. Report physical acceptance pending.

The plan and hardware evidence in docs/plans/2026-10-14-*.md may still be local-only. This brief includes the full relevant requirements, so their absence is not a blocker. The current develop CI run 38544835945 was in progress at preparation; predecessor PR checks passed. Recheck current CI when preparing your PR and address failures attributable to your work without weakening existing checks.

Run meaningful focused regression tests plus applicable npm run format:check, npm run typecheck, npm test and npm run build. UI work requires Electron E2E; use xvfb-run --auto-servernum npm run test:e2e where available. Packaging/release work requires package and packaged Electron/native smoke verification. Read current CI for exact commands. Resolve stale environment dependencies from the lockfile where permitted; accurately report blocked checks rather than treating missing Xvfb, denied loopback/subprocess access or missing setup packages as product failures. In your PR describe behavior, compatibility, test evidence, remaining gates and any environmental limitations. Use scoped new test files/modules to avoid other lanes. Rebase from develop and rerun affected tests before finalizing.

## Dependency, ownership and merged implementation

Dependency: PR24 / GitHub #8. Create codex/stable-release-workflow.

Own release workflows, focused release/build helper modules, scripts/nightly.ts refactoring only where needed for reuse, release notes configuration and metadata/history fixture tests. Application source, schema, renderer and runtime files belong to other lanes. Avoid package version/lockfile changes unless strictly necessary for reviewed tooling; version bumps are separate normal PRs to develop.

PR24 added scripts/nightly.ts, tests/nightly.test.ts and verify/publish jobs in .github/workflows/ci.yml. It generates temporary builder metadata, verifies exact tested .deb/AppImage bytes, SHA256SUMS and manifest.json, selects artifact by ID, checks provenance and keeps reruns immutable. Preserve all nightly branch/event/repository guards, never-latest semantics, independent push publications, source-version immutability and existing tests. Reuse/extract verified build and artifact validation mechanisms without rebuilding a different revision for publication. Stable packages must carry the requested stable version, not the nightly dev version. Keep PR verification read-only; isolate contents:write to deliberate publication.

Stable policy: after consolidated host acceptance, a maintainer promotes the tested develop revision to main and manually dispatches a versioned release for an immutable SHA on that branch. main did not exist at planning; inspect current refs and document the one-time bootstrap step, but do not create/push/promote main now. Keep workflow_dispatch available on default branch develop. Fail clearly if the release branch/version/SHA is invalid; do not silently fall back to develop. The tooling PR targets develop. No actual stable publication, tags or live release dispatch in this implementation task; use dry-run/fixture histories and mocked GitHub responses.

Require all build/format/type/unit/Electron/native/package gates for the exact source SHA before release finalization. A stable tag and draft may be created only by the validated workflow after verification; publish only when every artifact is uploaded and validated. Preserve safe resume semantics for the same version/SHA and reject conflicting tags. Guard against using nightly tags as the prior stable baseline and against unsafe interpolation of PR titles. The first real stable release remains gated on the host acceptance session.

## Full plan item

### PR25 Tagged stable release workflow and PR notes

**Outcome:** A maintainer dispatches a release with a version and an immutable tested source SHA; the workflow builds, tags and publishes binaries with linked PR titles.

Own the release workflow, release-note configuration and metadata tests. Use the stable-branch policy above. Validate that the selected SHA belongs to the chosen release branch and the requested version matches the reviewed package version; version bumps travel through normal PRs to `develop`. Bootstrap `main` from the final tested revision when adopting that policy. Keep the dispatch workflow on the default branch (`develop`) so it can be run.

Run/reuse the full build verification for that exact source, then create the version tag and a draft release, attach all artifacts/checksums, and publish only after every upload succeeds. Existing tag conflicts must fail safely; reruns resume only the same version/SHA. Call reusable build jobs directly rather than expecting a tag pushed with `GITHUB_TOKEN` to trigger another workflow.

Generate notes between the previous **stable** tag and the new SHA, including each merged PR's title, number and link. Verify merge, squash and rebase histories and promotion-PR deduplication; fall back to explicit associated-PR collection if generated notes miss underlying develop PRs. Handle the first release and direct commits. [GitHub generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes) can supply the basic merged-PR list and changelog.

**Acceptance:** Dry-run on fixture histories, missing/duplicate version, wrong branch/SHA, failed build/upload, first release, exclusion of nightly tags from the previous-release baseline and safe handling of PR titles. Actual stable publication occurs after consolidated host acceptance, not merely when this tooling PR merges.
