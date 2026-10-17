# PR02: Structured diagnostics and repair guidance

Implement only this feedback-plan item in repository `ianwijma/decker`. The coordinator will select Codex Cloud environment `decker`, GPT6.1 SOL (`gpt-6.1-sol`) and High reasoning in the launch UI. These settings are verified outside your session; inability to introspect the UI settings is not an implementation blocker.

This is wave two of the authorized plan: PR02 diagnostics, PR05 selectors and PR25 stable-release tooling run independently. Plan item numbers are not GitHub PR numbers. The coordinator verified that PR01 merged as GitHub #10 (097264ec9db788ac4160f4607312845b2a5c6c0d), PR04 as #9 (40604d49ff31e8a111b2247009ba923c693c1524), and PR24 as #8 (b15efbd20b1eceb0888618319e85a4ba14135d37). All are ancestors of current develop 40604d49ff31e8a111b2247009ba923c693c1524. No open develop PRs existed at dispatch preparation.

Read applicable AGENTS.md instructions, locate the repository, fetch current origin/develop and verify the relevant predecessor is present before branching. Use the specified codex/ branch from the latest origin/develop, not the potentially stale environment snapshot. Preserve unrelated setup changes. Check for a duplicate branch/PR. Open one focused PR against develop, attach it to your chat if supported, and return its link. Do not merge, start successor tasks, manually dispatch workflows, create live release tags, publish a release, or create/promote main during implementation.

You have no physical hardware access. Use fake transports, mocked desktop services, local fixtures and simulator/Electron tests. Physical device tests and any host permission changes belong to the coordinating host after all selected implementation PRs land. Report physical acceptance pending.

The plan and hardware evidence in docs/plans/2026-10-14-*.md may still be local-only. This brief includes the full relevant requirements, so their absence is not a blocker. The current develop CI run 38544835945 was in progress at preparation; predecessor PR checks passed. Recheck current CI when preparing your PR and address failures attributable to your work without weakening existing checks.

Run meaningful focused regression tests plus applicable npm run format:check, npm run typecheck, npm test and npm run build. UI work requires Electron E2E; use xvfb-run --auto-servernum npm run test:e2e where available. Packaging/release work requires package and packaged Electron/native smoke verification. Read current CI for exact commands. Resolve stale environment dependencies from the lockfile where permitted; accurately report blocked checks rather than treating missing Xvfb, denied loopback/subprocess access or missing setup packages as product failures. In your PR describe behavior, compatibility, test evidence, remaining gates and any environmental limitations. Use scoped new test files/modules to avoid other lanes. Rebase from develop and rerun affected tests before finalizing.

## Dependency, ownership and merged implementation

Dependency: PR01 / GitHub #10. Create codex/structured-diagnostics.

Own the shared health/remediation model, Linux capability probes, diagnostics-specific backend aggregation and minimal src/main/index.ts / src/shared/schema.ts integration, the Diagnostics portion of src/renderer/src/Settings.tsx (prefer extracting a focused component), and new focused styles/tests. Runtime/adapter changes are limited to capability reporting/rechecks. Do not change Deck.tsx, Flows.tsx, components.tsx, general editor store behavior, global styles or CI/release files. PR05 owns flow/profile editors and reusable dropdowns; PR25 owns delivery tooling. Keep the settings navigation and General/OBS/credentials UI unchanged: those are later plan items. Do not implement Home or automatic tool installation.

The merged hardware contract is DeviceStatus in src/shared/schema.ts with present, configured, state, updatedAt, lastSuccessfulWriteAt and per-device errorDetails {stage, message, code?, errno?, at}. States: discovered, opening, ready, permission-denied, busy, open-error, io-error, disconnected. connected is a ready-only compatibility alias. src/shared/device-status.ts supplies labels. The existing request {type: retryDevice, hardwareId} retries a configured device; diagnose rechecks runtime and device discovery. Reuse these, preserving truthful readiness and session retry semantics. Do not redesign src/device/session.ts. Use a reusable health model so PR03 can consume the same diagnoses/remedies; do not create a persisted schema migration just for observed status.

General diagnostics still use one observed.diagnostic string in main; fix keyed multi-fault retention without duplicating stale per-device errors. Keep raw state available but redact secrets both in human summaries and raw details. Tests must show simultaneous device/integration errors independently and recovery clearing the appropriate record.

Captured hardware evidence below is historical. Its old source-behavior observations predate PR01 and must not be treated as current defects. The physical permission incident remains the fixture and the host has not repaired permissions or performed display/input acceptance yet.

## Full plan item

### PR02 Structured diagnostics and repair guidance

**Outcome:** Every actionable fault has a clear cause, affected feature, suggested remedy and Retry; unrelated errors do not overwrite each other.

Own a shared health model and remediation registry, Linux probes and the Diagnostics renderer. Model healthy, idle, unconfigured, degraded and unavailable separately. Distinguish missing binaries from an installed service that is stopped, unsupported Wayland input, no MPRIS player and OBS not configured. Keep the raw observed-state disclosure, with secret redaction and bounded repeated errors.

For hardware, use PR01's per-device faults and the evidence document. Show permissions and detected ownership/rule hints, with model-scoped desktop udev guidance. For missing tools, show distribution-appropriate commands or documentation and copy/open controls. Installing from the UI is technically possible but requires an authenticated privileged helper and distribution handling; this scope provides guided repair and rechecks. Never present starting OBS or a media player as installing a missing dependency.

**Acceptance:** Fixtures cover each remedy category, simultaneous faults, recovery clearing stale errors and unknown distributions. Suggested text cannot be executed as arbitrary shell content. Diagnostics remain useful without hardware or an active desktop bus.

## Captured hardware evidence

# Decker Stream Deck hardware evidence

Recorded on 14 October 2026 in Australia/Sydney for the feedback implementation plan. This is the handoff for implementation agents that have no physical hardware access.

## Confirmed host observations

| Observation | Result |
| --- | --- |
| Host | Pop!_OS 22.04 LTS, Linux x86_64 |
| Device | Elgato Stream Deck XL, USB `0fd9:006c` |
| Current HID path | `/dev/hidraw2`; ephemeral, never use as persisted identity |
| Installed Decker driver enumeration | Model `xl`, 32 buttons, 96 × 96 LCD pixels per button |
| Serial identity | Present; omitted from this document |
| Saved hardware assignment | Driver identity matches the configured hardware deck |
| Saved deck geometry and brightness | 4 rows × 8 columns, brightness 100 |
| Device ownership and mode | `root:plugdev`, `0660` |
| Current user access | Neither readable nor writable; current user is not a member of `plugdev` |
| Access control list | Owner `rw-`, group `rw-`, others `---`; no user ACL entry |
| Read/write open without I/O | Fails with `PermissionError`, errno 13, `Permission denied` |
| Matching installed rule | `/etc/udev/rules.d/50-elgato-stream-deck-headless.rules` |
| Current udev properties | No `TAGS` or `CURRENT_TAGS` entry reported for this device |
| Saved configuration | Schema v2; one hardware deck, one web deck, four workflows |

The existing rule for this model is:

```udev
KERNEL=="hidraw*", ATTRS{idVendor}=="0fd9", ATTRS{idProduct}=="006c", MODE:="660", GROUP="plugdev"
```

This explains the immediate access failure: discovery can see the XL, but the process cannot open its HID interface. The configured device identity and profile association are present. Successful discovery is not evidence that image writes or button reads work.

The planning investigation did not change udev rules, user groups, configuration, profiles, device images or brightness. No key actions were invoked. The permission repair and physical display/input verification remain part of the final host acceptance session.

## App behavior visible in the source

- `src/device/worker.ts` appends a device with `connected: true` before attempting `openStreamDeck`. An open failure emits a generic diagnostic without updating this status.
- `src/main/index.ts`, `src/renderer/src/main.tsx` and `src/renderer/src/Deck.tsx` consume that optimistic boolean. This accounts for the misleading connected badge even when opening fails.
- Hardware rendering already exists: main produces deck frames; the device worker renders appearances through Sharp and calls the driver to write key images and brightness. Replace neither the HID protocol nor the driver as a first response to this incident.
- Failed writes disconnect the connection, while status reporting and recovery are less explicit. Device worker tests need a fake discovery/open/read/write boundary, beyond the existing image/queue tests.
- Only one global diagnostic string is retained in observed state. Multiple simultaneous device or integration failures can overwrite one another.

## Fixture for agents without hardware

Use a synthetic serial and binding in tests. Do not copy a real serial or workspace into fixtures.

```json
{
  "model": "xl",
  "vendorId": "0fd9",
  "productId": "006c",
  "hardwareId": "xl:TEST-SERIAL",
  "path": "/dev/hidraw-test",
  "configured": true,
  "rows": 4,
  "columns": 8,
  "iconSize": 96,
  "discoverySucceeds": true,
  "openFailure": {
    "code": "EACCES",
    "errno": 13,
    "message": "Permission denied"
  }
}
```

The expected app result is **Permission required**, with a device-specific explanation and a retry action. It must not claim ready, connected and working, or successful rendering. Also test a node-hid-style generic open error without an errno: supplementary permission checks may classify it, otherwise report an unknown open failure honestly.

Add related fixtures for missing device, unconfigured device, already owned/busy device, open success followed by image-write failure, successful retry, changed hidraw path with the same serial, native driver unavailable, and reconnect after held input. A fake open must never accidentally fall through to real HID access in CI.

## Proposed host repair

For a desktop app, prefer a model-scoped `TAG+="uaccess"` rule applied before the system seat ACL rule. The installed driver distinguishes desktop-user rules from headless `plugdev` rules in its [Linux setup documentation](https://github.com/Julusian/node-elgato-stream-deck/blob/master/packages/node/README.md). The locally installed copy is `node_modules/@elgato-stream-deck/node/README.md`.

Before applying a repair, inspect the logged-in desktop session and existing rule ordering. The agent process itself is not attached to a loginctl session, so its session lookup did not establish the desktop seat state. A minimal candidate for this XL is:

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", ATTRS{idProduct}=="006c", TAG+="uaccess"
```

Install a narrowly scoped Decker rule, reload rules, reconnect the deck, and verify the actual desktop user's ACL and open access. Preserve the existing third-party rule. The existing mode allows named ACL access once seat assignment works. Do not solve this by running Decker as root or granting all users access to every HID device. A headless deployment may instead intentionally use a dedicated group, but that is a different operating mode.

The initial product should show the detected rule/access problem, exact repair instructions, a copy-command control and Retry. An in-app privileged installer is a separate feature; a generic shell runner that executes diagnostic text is not part of this plan.

## Verification boundaries

Confirmed: physical USB presence, driver enumeration and geometry, saved identity match, permissions and failure to open without I/O.

Not yet verified: image transfer, physical key events, brightness response, hardware performance, unplug/replug recovery or suspend/resume. The permission failure prevents a meaningful success claim for these paths. All must be checked after the implementation PRs merge to `develop`.

The initial sandbox could not enumerate USB or expose `/dev/hidraw*`. Those sandbox results are not host hardware failures; the observations above came from host-level read-only checks.
