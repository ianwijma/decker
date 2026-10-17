# FU01: Patch the image-processing dependency

Implement this focused follow-up in ianwijma/decker. Launch settings: Codex Cloud environment `decker`, GPT6.1 SOL (`gpt-6.1-sol`), High reasoning, selected by the coordinator. The original 26 plan items are merged; this repair comes from a concrete finding during acceptance preparation. This attached brief is self-contained.

Read applicable AGENTS.md, fetch fresh origin/develop, check for duplicate work and create `codex/patch-sharp-image-stack` from it. Open one PR against develop and attach it to your chat when supported. Do not merge, publish/tag, dispatch releases, promote main or launch successor agents. You have no physical hardware. All hardware validation belongs to the coordinator after this repair lands.

Baseline: develop `11220016455f541eb4768b301f06c9c639f4476d`, documentation PR26 / GitHub #35 merged. Its final head `d9a2caafd00c11f0968e85e7df0182a001d80245` passed https://github.com/ianwijma/decker/actions/runs/39023948647. The merged build https://github.com/ianwijma/decker/actions/runs/39027840686 was running at preparation; recheck. Extra PR #36 `codex/split-linux-ci` remains open, with successful CI at `257c8224e1fdaead0048f336813745a5f1e184c8`. It owns the CI job split and does not block this independently buildable repair. Do not modify its workflow regions; preserve its gates if it merges before your rebase.

## Verified finding and scope

A clean npm ci in a separate checkout on the coordinator's Pop!_OS 22.04 x64 host installed Sharp 0.34.5 with `@img/sharp-linux-x64` 0.34.5 and `@img/sharp-libvips-linux-x64` 1.2.4. npm audit reports Sharp high severity. The host build passed, which does not resolve the dependency advisory.

Primary sources checked 17 October 2026:

- https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w: affected below 0.35.5; patched >=0.35.5 for the librsvg vulnerability.
- https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c: libheif advisories, patched at 0.35.4.
- https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj: libvips vulnerabilities, patched at 0.35.0.
- https://github.com/lovell/sharp/releases/tag/v0.35.5.

Recheck primary release/security information and Node/Electron/Linux compatibility before choosing the patched version. Update the declared dependency and lockfile to a verified fixed stable release (0.35.5 or newer if justified). Include only necessary transitive changes and minimal compatibility adaptations. You exclusively own the package manifest/lockfile in this follow-up. No workspace schema migration or feature redesign is required; retain v7.

Review all actual Sharp entry points: `src/device/images.ts` (asset and generated SVG rendering), `src/main/index.ts` (uploaded-image normalization and generated tray SVG), `src/main/persistence.ts` (import validation), `src/main/display-state.ts` (cache validation) and `src/main/remote-images.ts` (download/decode). The remote image path calls metadata before validating PNG/JPEG/WebP format; an allowlist alone is not proof that an unpatched decoder is unreachable. Do not claim a demonstrated exploit or compromise of Decker. The repair is warranted by the vulnerable shipped dependency and image-processing surface.

Do not globally block SVG as a shortcut: Decker intentionally renders trusted generated SVG for icons/labels/tray. Preserve these paths, escaped text, curated icon rules, authored upload compatibility and the remote static-raster policy. Do not broaden accepted remote formats. Preserve byte/pixel limits, full decode, animation rejection, EXIF orientation, alpha handling, native timeout, cancellation, queue limits, last-good cache/pins and authored-asset retention. Update stale version-specific comments/docs only where relevant.

The full audit reported 19 findings (14 moderate, 2 high, 3 critical). Other entries include optional `dbus-next -> usocket -> old node-gyp/request/tar` lockfile paths and electron-builder transitive dependencies; installed-tree output differs from the complete lockfile. Do not use `npm audit fix --force`, remove the lockfile, suppress audit output, blindly force incompatible transitive majors or bundle an unrelated D-Bus/build-tool migration. Record residual findings with exact dependency paths and distinguish installed/shipped runtime, optional install-only and build-only exposure based on evidence. This PR's required security outcome is removal of the Sharp advisories in the resolved and packaged image stack; zero overall findings must not be claimed if others remain. Report follow-up recommendations separately.

## Verification and handoff

Use Node 24 and a clean lockfile install. Verify exact Sharp and bundled native library versions, including packaged Electron; do not rely solely on package.json or a globally installed libvips. Preserve npmRebuild/ASAR native-unpack semantics and Linux x64 compatibility (CI Ubuntu 24.04; host Pop!_OS 22.04/glibc). Use the existing package/native smoke checks; report any higher platform floor rather than silently dropping host support.

Run meaningful existing image/device/icon tests, remote-images/generated-assets/display-state tests, upload/import/export coverage and toggle/visible-refresh regressions, then required full CI. Check generated labels/icons/tray, ordinary uploaded images, alpha/orientation, invalid/truncated/oversized/disallowed/animated remote images, cancellation and last-good art. Add focused regressions only for changed behavior or a compatibility issue; avoid tests that merely assert a version string. Do not fetch exploit payloads or test real users' remote images. Do not alter the upstream-notice gates or replace expected images to hide unexplained rendering changes.

The user requires GREEN CI on the FINAL pushed head. Run applicable format/type/unit/build/source Electron/package/native/icon-notice/installer checks, push, inspect required checks, fix failures and wait for all required checks to pass. Every further push requires new CI evidence. If #36 lands, preserve and pass the aggregate `Test and package Linux` gate and all component jobs. Do not weaken assertions, skip gates or call queued/old-head results green. Publication skipped on PR events is normal. Include PR URL, final SHA, CI/check URLs, before/after Sharp/native versions, audit evidence with residual findings, test results and remaining hardware checks. No physical verification or stable publication is implied.
