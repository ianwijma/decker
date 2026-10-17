# Download, verify and launch on Linux x64

## Choose a tested build

Use the [Releases listing](https://github.com/ianwijma/decker/releases), not
`/releases/latest` for nightly discovery. As checked on **17 October 2026**, published
development prereleases exist and no non-draft stable release exists. A develop
push publishes an immutable prerelease only after its CI verification succeeds.
Choose a non-draft release, read its notes, and follow its linked CI run to confirm
the source SHA and successful test/package job. Newer builds may appear; check the
manifest rather than assuming a screenshot or an old example is the latest binary.

For one build, download its Linux amd64 `.deb` and/or x86_64 `.AppImage`, plus
**manifest.json** and **SHA256SUMS** from that same release into a fresh directory.
The manifest records repository, source SHA, run ID, version, architecture, file
sizes and SHA-256 hashes. Confirm those match the release and CI. Downloading all
four assets lets you run `sha256sum -c SHA256SUMS`; every file must report `OK`.
If you downloaded only one installer, hash that exact filename and compare with
its line in SHA256SUMS and manifest.json. A missing second file is not a checksum
match. These hashes detect corruption/mismatched files; they are not an independent
signature proving publisher identity.

Immutable example, **not a latest-build link**:
[v0.1.0-dev.20261017.97.39015087308.shabefad249b920](https://github.com/ianwijma/decker/releases/tag/v0.1.0-dev.20261017.97.39015087308.shabefad249b920),
[tested develop CI](https://github.com/ianwijma/decker/actions/runs/39015087308).
This predates visible refresh; use source develop or a tested later build including
`f1a0432` for that feature. For this example only, the Debian checksum is:

```sh
sha256sum decker-0.1.0-dev.20261017.97.39015087308.shabefad249b920-amd64.deb
# 6eb599e6488f0ead66df88925f4e31292cd270134f98de5d7cf8dc12d24e931c
```

## Debian installation

From the directory containing the verified download, install **one exact selected
file**. Replace this example filename with your downloaded version:

```sh
sudo apt install ./decker-0.1.0-dev.20261017.97.39015087308.shabefad249b920-amd64.deb
```

Open **Decker** from the application menu, or run `decker` as your desktop user.
The inspected package installs `/opt/Decker/decker`, the `decker` launcher and
`decker.desktop` (Name=Decker). Do not run the application as root.

## AppImage launch

Choose the x86_64 AppImage on a compatible Linux x64 desktop. Replace both example
filenames with your single verified download:

```sh
chmod u+x ./decker-0.1.0-dev.20261017.97.39015087308.shabefad249b920-x86_64.AppImage
./decker-0.1.0-dev.20261017.97.39015087308.shabefad249b920-x86_64.AppImage
```

AppImage execution needs working FUSE support and the host Electron runtime
libraries. Follow the official [AppImage FUSE guidance](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
for your distribution/version; package names differ across releases. Do not use
root execution or disable Electron's sandbox as normal installation advice.
Actual FUSE launch and system package installation on Pop!_OS remain host checks.

## Runtime prerequisites

The Debian package declares `libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`,
`libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libuuid1`, `libsecret-1-0` and
`libusb-1.0-0`. This list comes from the inspected installer and
[packaging metadata](../package.json), not a cross-distribution install recipe.
Node/npm are for source development, not required to run the installer.

[CI's Ubuntu 24.04 setup](../.github/workflows/ci.yml) additionally names its actual
Electron/test packages (`libgtk-3-0t64`, `libasound2t64`, `libgbm1`, `xvfb`, `xauth`,
plus USB/NSS/XSS). Follow your distribution's package guidance instead of copying
Ubuntu t64 package names to Pop!_OS 22.04. Use
[Home/Diagnostics and Linux setup](linux-setup.md) for optional input/audio/OBS
services, model-specific USB access and current readiness. A secure keyring is
required for persistent secrets; see [security](security.md).

Stable publication is a separate, maintainer-triggered path with physical
acceptance requirements: [STABLE-RELEASES](STABLE-RELEASES.md). Documentation work
and local packaging do not authorize it.
