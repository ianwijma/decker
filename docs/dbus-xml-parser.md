# D-Bus XML parser dependency repair (FU02)

Checked 17 October 2026 against develop `299449d98c9a3ffbd0d24581c1b7b016951a7eee`, including CI split #36 and Sharp repair #37. Workspace schema remains v7; media production code, Sharp 0.35.5, native packaging and CI gates are unchanged.

## Dependency decision

`src/adapters/linux/media.ts` calls `getProxyObject` for the bus daemon and MPRIS players. The shipped `dbus-next/lib/client/proxy-object.js` constructs `new xml2js.Parser()` and parses the peer's Introspect reply. `dbus-next/lib/bus.js` also constructs a headless `xml2js.Builder` for service introspection. The old parser was a runtime dependency, not just build tooling. No Decker exploit or compromise has been demonstrated.

The [CVE-2023-0842 advisory](https://github.com/advisories/GHSA-776f-qx25-q3cc) identifies xml2js below 0.5.0 as affected. npm still publishes `dbus-next@0.10.2` as latest with `xml2js: ^0.4.17`; upgrading/reinstalling that package alone does not repair the parser. npm's latest stable xml2js is [0.6.2](https://github.com/Leonidas-from-XIV/node-xml2js/releases/tag/0.6.2), requiring Node >=4. Its [tagged parser](https://github.com/Leonidas-from-XIV/node-xml2js/blob/0.6.2/lib/parser.js) includes the safe property-definition implementation and the [writable-property correction](https://github.com/Leonidas-from-XIV/node-xml2js/commit/cb2f77e25c1999fdce952e127d9bed6d87786bb8). The [original upstream prototype replacement repair](https://github.com/Leonidas-from-XIV/node-xml2js/commit/581b19a62d88f8a3c068b5a45f4542c2d6a495a5) and [subsequent defineProperty implementation](https://github.com/Leonidas-from-XIV/node-xml2js/commit/30f9d61d6fcf42a4361539a81037a3b5bbf2373c) were reviewed.

The override is limited to `dbus-next -> xml2js: 0.6.2`, pinned exactly for reproducibility. Only xml2js's version, tarball and integrity change in the lockfile. Its existing sax and xmlbuilder dependency ranges are unchanged. Compatibility across these pre-1.0 versions is established by executable coverage, not assumed from version numbering.

Remove the override when an official dbus-next release declares a patched parser, after checking the installed and packaged resolution and rerunning this compatibility suite. Do not replace it with a broad transitive override set. Upstream master also contains later [own-property lookup work (#719)](https://github.com/Leonidas-from-XIV/node-xml2js/commit/1271db4befc80ac58631866606511dba99256433), absent from published 0.6.2. This repair addresses the named advisory; it does not claim to resolve every upstream parser issue or introduce an unreleased fork.

## Compatibility evidence

`tests/fixtures/dbus-xml.cjs` substitutes only message transport with an in-memory EventEmitter. It instantiates the installed dbus-next MessageBus and sends asynchronous Message replies through its actual reply dispatcher, `getProxyObject`, parser and generated ProxyInterface methods. It never calls `sessionBus`, opens a D-Bus socket or controls real players.

`tests/dbus-xml.test.ts` checks:

- Bus ListNames and representative MPRIS XML with attributes, interface/method/property arrays, nested child nodes, annotations and escaped text.
- All six media operations, destinations, interfaces, paths, empty signatures, argument directions, object-path/int64 arguments, property Get/Set/GetAll and nested Variants.
- Signal signature construction and delivery, match installation, local listener removal and disconnect cleanup.
- Actual MessageBus Builder parsing/round-tripping and service `_introspect` output, including methods, properties and signals.
- Malformed, truncated, empty and wrong-root Introspect replies reject through the asynchronous proxy path without unhandled failures.
- A synthetic `__proto__` regression: 0.4.23 replaces an individual parsed object's prototype; 0.6.2 retains the ordinary prototype and creates an own data property. Global Object.prototype is unchanged in both. No exploit kit or global pollution claim is involved.
- The unchanged Decker media adapter using XML-generated proxies: sorted/default and explicit player selection, all operations, PlaybackStatus/Variant decoding, observations and capability refusals.

The existing fake-transport media tests remain intact for missing/disappeared players, capability failures, timeout/abort, late proxy results and bus errors. Existing media action, UI, diagnostics and observed-state coverage remains in the normal test gates.

`tests/e2e/dbus-xml.spec.ts` reruns the four parser/proxy scenarios inside the actual Electron main process. It resolves dbus-next relative to `app.getAppPath()`, then resolves xml2js from dbus-next itself. In packaged mode it asserts the application is `app.asar` and that the parser path belongs to that archive. A version assertion supplements these behavioral checks. The existing source and packaged CI jobs both discover this test automatically; no gate is removed or skipped.

## Installed, shipped and audit results

Node 24.19.0 clean `npm ci` on Linux x64 resolves:

| Dependency | Before | After install | Actual app.asar |
| --- | --- | --- | --- |
| dbus-next | 0.10.2 | 0.10.2 | 0.10.2 |
| xml2js resolved from dbus-next | 0.4.23 | 0.6.2 | 0.6.2 |
| sax resolved from xml2js | 1.6.1 | 1.6.1 | 1.6.1 |
| xmlbuilder resolved from xml2js | 11.0.1 | 11.0.1 | 11.0.1 |
| Sharp | 0.35.5 | 0.35.5 | 0.35.5 |

The after artifact was built with the normal Debian/AppImage packaging path and inspected with `@electron/asar`. Installation has a nested xmlbuilder 11.0.1 beneath xml2js; the packager flattens it into app.asar. Merely resolving an unrelated hoisted xmlbuilder would report the wrong dependency.

`npm audit --json`, using the original and repaired lockfiles against the same registry:

| Findings | Before | After |
| --- | --- | --- |
| Moderate | 14 | 13 |
| High | 1 | 1 |
| Critical | 3 | 3 |
| Total | 18 | 17 |

The xml2js advisory is absent after the repair. dbus-next still appears in the audit because of its separate optional dependency chain. Remaining findings are retained and classified as follows:

- **Optional runtime chain:** `dbus-next -> usocket@0.3.0 -> node-gyp@7.1.2`, including request/form-data/qs/tough-cookie/uuid and tar findings. usocket and that node-gyp/request/tar chain were absent from this clean Linux installation and app.asar, but remain in the lockfile. This does not establish absence on other hosts. usocket supports abstract sockets and optional FD-capable connections; filesystem sockets can use the net fallback. No support is removed and no transitive node-gyp/tar major is forced.
- **Build-only chain in this artifact:** electron-builder 26.15.3, app-builder-lib and related builder packages, `@electron/get@3.1.0 -> global-agent@3.0.0 -> roarr@2.15.4 -> sprintf-js@1.1.3`. These audit entries remain; the chain is absent from app.asar. The separate installed build-tool node-gyp 12.4.0 is not the optional vulnerable node-gyp 7.1.2 chain. No electron-builder downgrade is applied.

No forced audit fix, deleted lockfile, globally disabled optional dependencies or zero-vulnerability claim is made.

## Validation and remaining acceptance

Run `npm ci`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, source Electron tests, normal Linux packaging, `scripts/check-icon-packages.ts`, packaged Electron tests and installer bundle/verification. The PR must pass all three parallel verification jobs and aggregate **Test and package Linux** on its final pushed HEAD. Publication is expected to skip for a PR. The PR records the exact SHA and check URLs.

The merged baseline run [39029957466](https://github.com/ianwijma/decker/actions/runs/39029957466) failed its source Electron home-discovery test while static/unit and packaging checks passed. That intermittent fixture/snapshot-ordering issue is owned by a separate repair; FU02 does not change home-discovery or snapshot plumbing. Rebase onto reviewed develop if that fix merges before completion.

Physical host acceptance remains with the coordinator: actual session bus and media players, multiple-player selection and disappearance, real playback/status changes, desktop behavior and Stream Deck hardware. Cloud fixtures do not certify those services or devices.
