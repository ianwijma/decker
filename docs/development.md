# Development and packaging

Use the [source quick start](../README.md#run-from-source). CI uses Node 24 and
`npm ci`; installation downloads Electron before checking node-hid/sharp native
modules. `npm run dev` runs predev's Electron installer, builds all bundles, then
starts electron-vite. Browser-controller edits need a rebuild.

For a disposable workspace, choose an unused absolute directory and set
`DECKER_DATA_DIR` on the launch command, for example:

```sh
DECKER_DATA_DIR="$(mktemp -d /tmp/decker-demo.XXXXXX)" npm run dev
```

Never point a fixture/import test at a real workspace. This isolates workspace
storage; simulator/fixture actions still execute on the host. Review commands and
file destinations. Export from **Settings → General → Export workspace** before
replacing a workspace through **Import**.

## Verification

```sh
npm run format:check
npm run check
xvfb-run --auto-servernum npm run test:e2e
npm run package
node scripts/check-icon-packages.ts
DECKER_EXECUTABLE=release/linux-unpacked/decker xvfb-run --auto-servernum npm run test:e2e
```

`check` runs typecheck, unit tests and build. Tests create temporary data directories;
the existing Electron harness uses a virtual display and its isolated CI sandbox
configuration. Those test flags are not normal desktop setup instructions.
Local `package` produces `.deb` and AppImage under `release/` using **--publish never**;
`package:dir` also disables publication. CI separately verifies source and packaged
Electron, native modules, icon notices and installer manifests/checksums, then
publishes immutable development prereleases on successful **develop pushes**.
Publication is skipped on PR events. See the [CI workflow](../.github/workflows/ci.yml).

Pull-request and branch CI runs static checks/unit tests, source Electron tests,
and Linux packaging/packaged Electron tests in parallel jobs. Source and packaged
test reports are uploaded separately. The `Test and package Linux` check requires
all three jobs to pass before the same-run installer artifact can be published on
a develop push.

The lockfile pins dependency resolutions. node-hid and sharp ship ABI-stable
Node-API prebuilds; native binaries are unpacked from ASAR and loaded from packaged
workers. [Acceptance](ACCEPTANCE.md) distinguishes software evidence from pending
physical/desktop gates. [STABLE-RELEASES](STABLE-RELEASES.md) describes the separate
maintainer release procedure; do not run it for a documentation PR.

## Source contracts

- [Workflow runtime](workflow-runtime.md), [data/templates](workflow-data.md),
  [binding UI](data-binding-ui.md), [trigger context/display](trigger-context-display.md).
- [Toggles](toggle-runtime.md), [schedules](workflow-schedules.md),
  [remote images](remote-image-assets.md), [visible refresh](visible-button-refresh.md).
- [Storage/security](security.md), [managed secrets](managed-secrets.md),
  [health/remediation](diagnostics.md), [desktop file IPC/palette contract](desktop-actions.md).

Current workspace schema is **v7**. Preserve explicit older migration examples:
v2 introduced independent decks; v3 workflow identities; v4/v5 toggle contracts;
v6 schedules; v7 visible refresh. Unsupported future versions are backed up and
block writes. Do not reinterpret historical version notes as the current schema.
