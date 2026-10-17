# FU02: Patch the D-Bus XML parser with compatibility coverage

Implement one focused follow-up in `ianwijma/decker`. The coordinator selects Codex Cloud environment `decker`, GPT6.1 SOL (`gpt-6.1-sol`), High reasoning in the launch controls. You do not need to introspect those settings. The original 26 feedback items and FU01 are merged. This attached brief is self-contained because the local planning files may not exist in your checkout.

Read applicable AGENTS.md, fetch fresh origin/develop, check for duplicate work and create `codex/patch-dbus-xml-parser` from it. Open one PR against develop and attach it to your chat when supported. Do not merge, publish/tag, dispatch releases, promote main or launch successor agents. You have no physical hardware or access to the user's desktop/session services. Real media, OBS and Stream Deck checks belong to the coordinator.

## Baseline and verified finding

Develop at preparation is `299449d98c9a3ffbd0d24581c1b7b016951a7eee`. CI split #36 merged at `dd16ca66a4492648ba60ff635461908e4d09b10f`; its final head `c03cb330d9d68da442c6999261f0ecd7a91bab6f` passed https://github.com/ianwijma/decker/actions/runs/39028559478. FU01 / #37 merged the patched Sharp stack; its final head `d0e6206cd1256a576331967eae06fbaa0bbfae5b` passed https://github.com/ianwijma/decker/actions/runs/39028689754. The combined develop run https://github.com/ianwijma/decker/actions/runs/39029957466 is still running at preparation; recheck its final result. No develop PRs were open when checked. Preserve Sharp 0.35.5 and the parallel CI component jobs plus aggregate gate.

FU01's clean install and actual app.asar inspection confirmed runtime `dbus-next@0.10.2 -> xml2js@0.4.23`. The coordinator independently inspected the installed library and Decker adapter. `src/adapters/linux/media.ts` calls `getProxyObject` for org.freedesktop.DBus and MPRIS players; `dbus-next/lib/client/proxy-object.js` creates `new xml2js.Parser()` and parses the Introspect reply. The library also uses `xml2js.Builder({ headless: true })` in lib/bus.js. This is a shipped parser used on D-Bus peer data, not merely a development dependency. No demonstrated Decker exploit or compromise is claimed.

Primary sources checked 17 October 2026:

- Advisory https://github.com/advisories/GHSA-776f-qx25-q3cc (CVE-2023-0842) identifies xml2js below 0.5.0 as affected and 0.5.0 as patched for prototype pollution.
- Maintainer release https://github.com/Leonidas-from-XIV/node-xml2js/releases/tag/0.6.2.
- Maintainer repository https://github.com/Leonidas-from-XIV/node-xml2js; consult its fix and current release/package information before selecting the version.
- https://github.com/dbusjs/node-dbus-next/blob/master/package.json still declares xml2js ^0.4.17; simply reinstalling dbus-next 0.10.2 does not fix this. Repository master and published npm contents can differ.

## Implementation scope

Resolve the installed and packaged D-Bus parser to a verified patched stable release with the smallest compatible dependency change. First check whether an official dbus-next release fixes its dependency; otherwise a narrowly scoped npm override for dbus-next's xml2js is acceptable **after compatibility is demonstrated**, with the rationale and removal condition documented. Do not apply a global collection of transitive overrides or assume pre-1.0 versions are API-compatible. Prefer this bounded parser repair over migrating the entire media backend or adopting an unreviewed fork. No workspace schema change, action/UI redesign, scheduling change or image-stack change is allocated.

Preserve the existing adapter contract: sorted/default and explicit MPRIS player selection, all media operations, PlaybackStatus/Variant decoding, missing/disappeared players, capability errors, timeout/abort behavior, late-error handling, disconnection cleanup and diagnostics/observed state. Keep normal introspection attributes, arrays, nested nodes, method argument directions/signatures, properties, annotations and signals working. Do not disable introspection, hard-code a single player, suppress errors or weaken existing tests to make the upgrade pass.

Current `tests/media-adapter.test.ts` injects a fake getProxyObject, so it does not exercise the real XML parser/proxy construction. Add meaningful isolated compatibility coverage that executes the actual dbus-next/parser path with representative bus and MPRIS introspection XML and stubbed message transport (or a private test-only D-Bus service). It must not connect to a user's actual session bus or control real players. Verify parser-sensitive structures/method calls/properties and malformed responses reject without unhandled failures. Include a small synthetic regression for the upstream dangerous-key behavior if useful; do not fetch exploit kits or claim global Object.prototype pollution when the test only demonstrates an individual parsed object's prototype. Exercise Builder round-tripping where the dependency change affects it. Avoid tests that only assert version strings.

FU01 reports 18 remaining npm-audit entries: 14 moderate, 1 high, 3 critical. Record before/after audit results and exact installed/shipped versions. This task's required remediation is the xml2js advisory. Additional unchanged findings must remain honestly classified:

- Optional `dbus-next -> usocket@0.3.0 -> node-gyp@7.1.2 -> request/tar` chains exist in the lockfile. They were absent from FU01's clean Linux install and app.asar; that is not proof they are absent on every host. The library uses usocket for abstract sockets and optional FD-capable connections, with a net fallback for filesystem sockets. Do not remove this support or blindly force node-gyp/tar majors in a parser repair.
- The `electron-builder -> app-builder-lib -> @electron/get -> global-agent -> roarr -> sprintf-js` finding is build-only in the inspected artifact. Do not downgrade electron-builder to satisfy an audit suggestion.

Do not use npm audit fix --force, delete the lockfile, disable optional dependencies globally (Sharp/HID have platform packages), suppress audit results or claim zero vulnerabilities if others remain. Only change related dependency/lockfile entries, compatibility tests, minimal adaptations and relevant documentation. If a broader migration is actually required, present concrete evidence and a separately scoped recommendation rather than silently replacing integrations.

## Validation and completion

Use Node 24, a clean npm ci and real source/packaged Electron paths. Verify the parser resolved from dbus-next itself, not an unrelated hoisted copy, and inspect the actual app.asar dependency. Run the new parser/proxy tests and existing media-adapter/media-actions/UI/observed-state coverage. Preserve native packaging, Sharp/HID, icon/license-notice and installer validation.

The user requires GREEN CI on the FINAL pushed head. Run applicable formatting, types, unit, build, source Electron and Linux packaging checks; push; inspect and fix failures; wait for all required checks to pass on that exact final head. With #36 merged this includes Static checks and unit tests, Source Electron tests, Package and test Linux installers and the aggregate Test and package Linux. Every subsequent push needs fresh CI evidence. Queued checks or an earlier green commit do not satisfy this. Publication skipped on a PR event is expected. Do not skip assertions or weaken gates.

Return the PR URL, final pushed SHA, successful check/run URLs, dependency strategy and compatibility evidence, installed and packaged parser versions, residual audit classifications and remaining physical media acceptance. Recheck the merged baseline's CI. Cloud fixture success does not certify the user's session bus, real media player or Stream Deck hardware.
