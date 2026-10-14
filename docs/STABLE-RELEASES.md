# Stable releases

Stable releases are deliberate maintainer operations after consolidated physical
host acceptance. This tooling does not promote branches or dispatch releases when
it merges. Version changes remain normal reviewed PRs to `develop`; the requested
`X.Y.Z` must exactly match `package.json` at the selected full 40-character SHA.

## Adopt the main branch policy

At PR25 implementation, `develop` is the default branch and `main` does not exist.
After all selected implementation PRs land and the coordinator completes physical
acceptance, a maintainer must create `main` from that final tested `develop`
revision. Future promotions move the accepted develop revision onto `main` through
the normal reviewed promotion process. Bootstrap and promotion are separate from
this tooling PR. The release workflow never creates, pushes or falls back from
`main` to another branch.

Keep `stable-release.yml` on default branch `develop`. A maintainer dispatches it
on `develop`, selects release branch `main`, enters the reviewed version and exact
accepted SHA, and confirms `host_accepted`. This confirmation defaults to false;
verification/publication remain disabled until it is true. Automation does not
substitute for the coordinating host's physical acceptance session.

## Verification and finalization

The dispatch calls `verify-stable.yml` directly; it does not rely on a token-created
tag starting another workflow. Read-only verification checks out the requested
source SHA with full history and tags, requires main ancestry and the package
version, then runs lockfile installation, formatting, TypeScript, unit tests,
build, Electron interaction tests, Debian/AppImage packaging, and packaged
Electron/native smoke tests. Release tooling is pinned to the dispatch workflow
SHA in `work/tooling`; the application commands execute in the exact selected
source checkout. `allowImportingTsExtensions` enables the Node 24 release tooling
imports while retaining TypeScript's existing `noEmit` mode.

The bundle checks Debian version/architecture and embedded application version,
then records only the tested Debian and AppImage bytes in `manifest.json` and
`SHA256SUMS`. Packages carry the reviewed stable version, with no edits to source
package metadata or the lockfile. A same-run immutable Actions artifact ID passes
this bundle to publication. The publication job does not install dependencies or
rebuild the application. It rechecks the bundle, source checkout, main ancestry,
event, default-branch dispatch, repository, acceptance flag, successful verification
and run provenance before any tag/release write. Only this job has `contents: write`.

Finalization creates a lightweight immutable `vX.Y.Z` tag for that SHA and a draft
stable release. Every asset is uploaded and downloaded again for byte validation.
Only then is the draft published and marked latest. Nightly releases retain their
independent develop-push guards, development versions and never-latest behavior.

## Notes and recovery

Notes use the highest reachable stable `vX.Y.Z` tag before the requested version;
nightly/prerelease tags and unrelated histories are excluded. The first release
uses all reachable history. Explicit associated-PR collection traverses every
commit in the range and paginates responses, covering merge, squash and rebase
histories. Already released PRs are excluded, repeated associations are deduplicated
by number, and develop-to-main promotion PRs are excluded because their underlying
history is collected. Notes include titles, numbers and canonical links, plus
unassociated direct commits and a stable comparison link. Titles are escaped as
Markdown text and are never substituted into shell commands. `.github/release.yml`
also supplies a basic category if a maintainer uses GitHub's generated notes.

A failure before verification completes creates no tag or release. Upload failures
leave the release draft. Retry the failed publication job to reuse the original
Actions artifact ID and exact bytes. It verifies existing matching assets and
uploads only missing ones; it never deletes or replaces assets. A full rerun that
rebuilds different bytes for an interrupted draft fails safely rather than replacing
the original assets. Preserve the original Actions artifact while recovery is needed.

An already published same-version/SHA rerun is read-only: it validates the original
published manifest and checksums, even when a new verified run produced different
archive bytes. Conflicting tags, source revisions, release kinds, unexpected assets,
corruption and API failures fail closed. No automatic tag movement, rollback or
asset replacement is provided.

## Implementation acceptance

Fixture tests run in temporary Git repositories and use mocked GitHub responses;
there are no live tag, release or workflow-dispatch tests. CI remains the required
full verification gate. Physical acceptance and the first actual stable publication
remain pending the coordinating host session.
