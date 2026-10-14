# Session diagnostics

`src/shared/health.ts` is the shared health/remediation contract for Diagnostics and future health views. `Snapshot.health` contains transient `HealthRecord` values; older snapshot fixtures can call `buildHealth(snapshot)`. No workspace schema migration is required. The compatibility `Capability.available` field and PR01's ready-only `DeviceStatus.connected` remain available.

| State        | Meaning                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| healthy      | The relevant service or driver operation reports readiness. This does not prove physical display or input acceptance. |
| idle         | A usable bus has no media player, or a configured device is opening.                                                  |
| unconfigured | OBS has no saved connection or a discovered device has no hardware assignment.                                        |
| degraded     | A previously usable path failed, such as a device write or application storage.                                       |
| unavailable  | A tool, desktop session, service, connection or configured device cannot currently be used.                           |

Health is derived from the latest capability checks, configured OBS observations and PR01 device statuses. OBS errors are keyed by connection; successful observations clear their old error field, and removed connections are pruned. Device failures stay in PR01's per-device status rather than a second diagnostic history. A discovery/native failure has one driver diagnosis with affected device names. General failures use bounded source keys in `observed.diagnostics` (32 sources; repeated counts saturate at 999). Successful storage writes and worker recovery clear the matching source.

The Linux probes distinguish executable presence from a responding X11/audio service, no MPRIS player from an unavailable session bus, and unsupported Wayland input. Distribution identifiers are parsed as data from os-release; they are never sourced as shell code. Unsupported distributions receive documentation instead of an invented package command.

Device access evidence is read-only: mode, ownership, process read/write access, supplementary group membership, sysfs USB identity, matching installed rule hints and udev tags. It does not open HID or establish the logged-in desktop user's seat/ACL state. The XL guidance preserves third-party rules and uses model-scoped uaccess before seat ACL rules. A known detected product receives its exact rule; without product evidence both supported XL USB revisions are shown. Other models receive the driver's setup documentation.

`diagnosticRemedy` accepts a current health ID and either `copy` or `open`. Main resolves the current record through a fixed registry. Renderer-supplied commands or URLs cannot be executed; the copy path only writes clipboard text, and the open path only opens a registry documentation URL. `retryDevice` and `diagnose` retain PR01's retry/discovery semantics. Diagnose also rechecks web configuration. Guided repairs require review and application outside Decker; this feature has no privileged installer.

Credential values, sensitive keys, URL credentials and common authorization/query fragments are redacted in summaries and raw feature details. Repeated and oversized data is bounded. Ownership/rule observations are hints, not a claim that a permission repair or physical display/input verification succeeded.

The focused unit fixtures cover desktop/tool/service categories, unknown distributions, concurrent OBS/device failures, selective recovery, native failure deduplication, bounded records, secret redaction and the historical root:plugdev 0660 XL incident. PR01's fake transport regressions cover generic open classification, write failure, serial identity across changed paths, successful retry and reconnect with held input. Electron coverage checks live registry clipboard IPC and injected multi-fault renderer states without physical devices.
