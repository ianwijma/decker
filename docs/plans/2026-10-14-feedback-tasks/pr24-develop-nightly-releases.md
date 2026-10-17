# PR24: Development prereleases after develop builds

Implement this task in the published Codex Cloud environment `decker`, repository `ianwijma/decker`, using GPT6.1 SOL (`gpt-6.1-sol`) with High reasoning. Those are launch settings, not settings a prompt can enforce. If the selected environment/model differs, report the mismatch before implementation.

The user authorized starting the feedback implementation plan. This is one of three independent tasks in the first batch (PR01, PR04 and PR24). These labels identify plan items, not existing GitHub PR numbers. Do not start dependent tasks or combine other plan items into this PR.

Locate the repository, read its applicable AGENTS.md instructions, inspect the current state, fetch origin, and create the specified `codex/` branch from the latest `origin/develop`. Preserve any environment setup changes instead of resetting them blindly. Open one focused GitHub PR with base `develop`, and attach it to this chat if the app tool is available. Do not merge the PR or manually publish a release. Check for an existing branch/PR for this exact plan item before creating duplicates.

You have no physical Stream Deck access. Use fake transports, simulator/browser tests and captured evidence. Do not probe devices, ask for hardware access, or claim physical verification. The coordinating host will run the consolidated hardware session after all implementation PRs merge to develop. Report hardware acceptance as pending.

The source plan is `docs/plans/2026-10-14-feedback-plan.md`, with companion `docs/plans/2026-10-14-hardware-evidence.md`. These documents may not yet exist on origin/develop. This prompt includes the complete task requirements and relevant evidence; their absence is not a blocker. Baseline research used develop SHA `b57bd05d09119c4bb746b77909393791afc1b942`; recheck the current source rather than assuming it is unchanged.

Add meaningful regression tests for the specified behavior. Run applicable checks from package.json: `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`; UI changes also require Electron E2E tests (`xvfb-run --auto-servernum npm run test:e2e` in Linux CI). Native/asset/release changes require package and packaged-app smoke verification where supported. Read the current workflow for the exact packaged test command. Identify environment restrictions accurately rather than weakening assertions or treating blocked networking/subprocesses as product failures.

In the PR and final response, explain the resulting behavior, compatibility, regression evidence, exact commands/results, any blocked checks, and remaining host acceptance gates. Return the PR link and branch. Keep changes within the ownership boundaries below; report a necessary cross-lane conflict before editing another lane's files.

Create branch `codex/develop-nightly-releases`. This task has no predecessor PRs.

## Ownership and scope

You own `.github/workflows/ci.yml`, focused reusable build/publish workflow files, release metadata/version/checksum scripts and tests, and package metadata changes only when needed for build-version injection. Preserve the existing development version in the repository unless there is a clear reviewed reason to change it. Coordinate package-lock changes with the other lanes if unexpectedly necessary. Do not edit application device, renderer or runtime code. PR01 owns device health; PR04 owns flow canvas.

"Nightly" means every successful push to develop, including each PR merge; a nightly cron is insufficient. Deliver `.deb` and AppImage, not Docker images. Existing CI runs formatting, type checks, tests, build, Electron E2E, packaging and packaged Electron/native smoke checks, then uploads artifacts; preserve these checks. No existing release was found during baseline research. Keep stable version releases, stable-branch setup and PR-title release notes for PR25. This task implements the automatic prerelease workflow but must not manually dispatch or publish test releases. Its expected publication side effect starts only when the reviewed PR is merged into develop.

## Full plan item

### PR24 Development prereleases after develop builds

**Outcome:** Every successful `develop` build produces a downloadable development prerelease with `.deb`, AppImage, checksums and its exact commit.

Own reusable build/test packaging workflow pieces and a tightly scoped publish job. Trigger on `push` to `develop`; PR verification remains read-only and never publishes. Reuse tested artifacts from the same workflow execution instead of rebuilding different code for publication. Give every build a unique prerelease version/tag containing date, run identity and short SHA. Validate both npm/SemVer and Debian prerelease ordering; do not assume one version string orders correctly in both formats.

Mark nightlies as prereleases and never as the latest stable release. Isolate `contents: write` to publication. Attach a manifest with source SHA, version, architecture and checksums. Keep the current native-module and packaged-app smoke checks. Queue publication as needed without silently cancelling a requested build for an earlier merge; an optional latest-nightly pointer must not replace immutable per-build artifacts.

**Acceptance:** Validation/dry-run of metadata and artifact selection, branch/event guards, failed tests producing no release, rerun idempotency and two close develop pushes producing distinct results. A successful automated nightly is not a hardware certification. [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) provide the push and reusable workflow mechanisms.
