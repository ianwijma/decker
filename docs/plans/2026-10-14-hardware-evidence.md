# Decker Stream Deck hardware evidence

Recorded on 14 October 2026 in Australia/Sydney for the [feedback implementation plan](2026-10-14-feedback-plan.md). This is the handoff for implementation agents that have no physical hardware access.

This is historical evidence. At the later [17–18 October host session](2026-10-17-host-acceptance.md), user ACL access worked and the covered physical tests passed. No permission repair was applied during that session.

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
