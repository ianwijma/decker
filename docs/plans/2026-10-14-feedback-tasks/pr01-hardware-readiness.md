# PR01: Truthful hardware status and display recovery

Implement this task in the published Codex Cloud environment `decker`, repository `ianwijma/decker`, using GPT6.1 SOL (`gpt-6.1-sol`) with High reasoning. Those are launch settings, not settings a prompt can enforce. If the selected environment/model differs, report the mismatch before implementation.

The user authorized starting the feedback implementation plan. This is one of three independent tasks in the first batch (PR01, PR04 and PR24). These labels identify plan items, not existing GitHub PR numbers. Do not start dependent tasks or combine other plan items into this PR.

Locate the repository, read its applicable AGENTS.md instructions, inspect the current state, fetch origin, and create the specified `codex/` branch from the latest `origin/develop`. Preserve any environment setup changes instead of resetting them blindly. Open one focused GitHub PR with base `develop`, and attach it to this chat if the app tool is available. Do not merge the PR or manually publish a release. Check for an existing branch/PR for this exact plan item before creating duplicates.

You have no physical Stream Deck access. Use fake transports, simulator/browser tests and captured evidence. Do not probe devices, ask for hardware access, or claim physical verification. The coordinating host will run the consolidated hardware session after all implementation PRs merge to develop. Report hardware acceptance as pending.

The source plan is `docs/plans/2026-10-14-feedback-plan.md`, with companion `docs/plans/2026-10-14-hardware-evidence.md`. These documents may not yet exist on origin/develop. This prompt includes the complete task requirements and relevant evidence; their absence is not a blocker. Baseline research used develop SHA `b57bd05d09119c4bb746b77909393791afc1b942`; recheck the current source rather than assuming it is unchanged.

Add meaningful regression tests for the specified behavior. Run applicable checks from package.json: `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`; UI changes also require Electron E2E tests (`xvfb-run --auto-servernum npm run test:e2e` in Linux CI). Native/asset/release changes require package and packaged-app smoke verification where supported. Read the current workflow for the exact packaged test command. Identify environment restrictions accurately rather than weakening assertions or treating blocked networking/subprocesses as product failures.

In the PR and final response, explain the resulting behavior, compatibility, regression evidence, exact commands/results, any blocked checks, and remaining host acceptance gates. Return the PR link and branch. Keep changes within the ownership boundaries below; report a necessary cross-lane conflict before editing another lane's files.

Create branch `codex/hardware-readiness`. This task has no predecessor PRs.

## Ownership and scope

You own `src/device/worker.ts`, `src/device/images.ts`, new device-session/test modules, the device status contract, and minimal `src/main/index.ts` plumbing. You may update direct status consumers in `src/renderer/src/main.tsx` and `src/renderer/src/Deck.tsx` to avoid misleading badges. Keep shared type/schema edits narrowly scoped to device status; do not introduce persisted schema migrations. Do not edit `Flows.tsx`, general flow store behavior, global styles, workflow/release files or packaging metadata. PR04 owns the canvas and its store selectors; PR24 owns CI and release packaging. Implement health semantics and recovery now; the structured diagnostic registry, Home page and guided remediation belong to later PR02/03.

Rendering and HID support already exist. The confirmed immediate failure is open permission, so preserve the existing driver and rendering architecture. Native-driver availability and USB enumeration do not establish device readiness. Preserve per-device error transitions and compatibility for existing saved decks.

## Full plan item

### PR01 Truthful hardware status and display recovery

**Outcome:** A discovered XL that cannot open says Permission required. A ready deck receives the configured page and brightness, and recovers after reconnect or a recoverable write failure.

Own `src/device/worker.ts`, `src/device/images.ts`, a new testable device-session module, the device status contract, and minimal main-process plumbing. Separate physical presence from configured/open/ready/error state. Use states such as discovered, opening, ready, permission-denied, busy, I/O-error and disconnected, with device-specific error details and timestamps. Native-driver readiness must not imply that a particular device works.

Mark ready only after opening and completing the initial frame/brightness writes. Track last successful write without claiming physical pixel readback. Retry transient failures with bounded backoff; reset cached desired images on a fresh connection. Preserve serial identity when hidraw paths change, serialize/coalesce writes, clear held keys on loss, and never write unconfigured devices. Publish disconnect/error transitions promptly.

**Acceptance:** Fake transport tests reproduce the exact discovery-success/open-EACCES incident, open success/write failure, reconnect, changed path, page changes, brightness changes and two independent decks. Software can prove intended frames and events; mark physical image/input acceptance pending.

## Captured host evidence (read-only reference)

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
