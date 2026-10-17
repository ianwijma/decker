# Documentation validation and screenshot provenance

PR26 is based on merged develop `f1a04320ddf26af40fcb0210067ab2865e67b804`
(PR23 / GitHub #34), using current schema v7. Verification used disposable Cloud
workspaces, synthetic local data and virtual-display Electron, with no hardware,
real user workspace, account or secrets. No application behavior was changed.

## Downloads and source startup

On 17 October 2026 the release API reported a public repository, develop default
branch and published development prereleases, with no published stable release.
The [immutable inspected example](install.md#choose-a-tested-build) is
`0.1.0-dev.20261017.97.39015087308.shabefad249b920`. Both its amd64 Debian installer
and x86_64 AppImage were downloaded with manifest.json/SHA256SUMS; both reported
`OK` with `sha256sum -c SHA256SUMS`. Debian architecture, dependencies, application
menu name, `/opt/Decker/decker` and post-install `decker` launcher creation were
inspected without installing the package. Five existing Electron app smoke tests
passed against the **extracted Debian app**, including native readiness, real
clipboard, hidden-editor execution and paired-browser controls. This was not an
OS package installation or FUSE/AppImage launch.

A fresh `git clone --branch develop`, Node 24.19.0/npm 11.9.0 and `npm ci` succeeded.
This managed environment needed proxy-aware Node downloads and writable cache/config
directories. Unmodified `npm run dev` built and started its renderer server, then
hit the Cloud host's unconfigured Electron sandbox helper. Development startup
was also exercised using the existing isolated test sandbox convention. That
Cloud-only test configuration is not a recommended desktop installation flag.
Normal sandboxed launch, distro package/FUSE setup and Pop!_OS remain host checks.

## Reader walkthroughs and screenshots

- Copy text: selected an empty simulator key, set Label/Text, used **Test action**
  and double-clicked the saved key; verified the actual Electron clipboard.
- [Local data workspace](data-example.md): imported through the normal main import
  path with synthetic file/confirmation dialog responses, validated, ran and
  checked `Name: Local avatar 1` then `Name: Local avatar 2` in the destination.
  HTTP/Parse/Extract/template/Write nodes used real runtime handlers.
- [Local avatar](visible-button-refresh.md#working-local-avatar-example): used the
  existing loopback JSON/PNG server and normal import, with refresh initially
  disabled. Corrected the example's omitted Fetch image `credentialRef` to `""`
  so import does not create an unintended credential placeholder. Explicitly
  enabled refresh and checked the real cadence, independent Copy text press,
  changed avatar, failure/last-good artwork and recovery.

The two PNGs are actual source-app captures from this merged app on a virtual
X display, each 1540×1012 pixels and under 200 KiB. **quick-start.png** shows the
included simulator after the Copy text walkthrough; **current-flow.png** shows
the four-node data example after success. Screenshots were visually inspected for
legibility, cropping and consistent labels. They show no synthetic hardware health,
serial numbers or secrets. Four old screenshots had no remaining inbound references
and were removed. Source-only documentation and example corrections do not alter
the captured production renderer.

## Verification boundaries

Format, typecheck, 572 unit tests and production build passed locally. Existing
Electron suites cover the linked features, including two foreground web clients,
clock-driven refresh/backoff, toggle drift, schedules/DST and secure IPC. A first
source pass had a transient Home fixture assertion failure; all five Home discovery
tests passed on focused rerun. No tests or application code were weakened.
Relative Markdown links, anchors, image paths and import examples were checked.

The [CI workflow](../.github/workflows/ci.yml) retains source and packaged Electron,
native, icon geometry/notices, installer build/manifest/checksum gates. The PR's
final-head check links and SHA belong in its handoff; a skipped PR publication job
is expected. The merged develop [combined CI](https://github.com/ianwijma/decker/actions/runs/39022691244)
was rechecked successful, including packaging and development publication.

Every physical/desktop/network item in [ACCEPTANCE](ACCEPTANCE.md) stays pending:
USB permission repair, real XL images/keys/brightness/reconnect/suspend, actual
OBS/audio/MPRIS/keyring, phone/Wi-Fi behavior, tray/autostart/logout, .deb installation,
AppImage/FUSE launch and measured latency. The coordinator performs one consolidated
host session after merge. Stable publication remains a separate maintainer action.
