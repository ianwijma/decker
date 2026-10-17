# PR13: First icon pack and consistent rendering

Implement only this plan item in repository ianwijma/decker. The coordinator selects Codex Cloud environment decker, GPT6.1 SOL (gpt-6.1-sol), and High reasoning in the launch controls. These settings are verified outside your session; inability to introspect them is not a blocker.

Wave four runs PR14 cancellation, PR10 separate URL/file actions, and PR13 the first icon pack. Plan item numbers differ from GitHub PR numbers. The coordinator verified PR07 merged as GitHub #14 (88c2cc86bf46a2dc2e68aa66a5b4d02919ca3626), PR06 as #16 (d2d667c34a173160567fab98266fc50714a2b8cb), and PR03 as #15 (2ce728cabf250d2581e3b4c534dcd38bb1cbb897). All three PR CI checks passed and all three merges are ancestors of origin/develop at 2ce728cabf250d2581e3b4c534dcd38bb1cbb897. Latest develop CI run 38559922219 was in progress at preparation; recheck before finalizing. No develop PRs were open at preparation.

Read applicable AGENTS.md instructions, fetch current origin/develop, verify predecessors and create the specified codex/ branch from the latest develop, not a stale cloud snapshot. Check for duplicate branches/PRs and preserve unrelated setup changes. Raise one focused PR against develop, attach it to your chat if supported, and return its link. Do not merge, launch successor tasks, dispatch release workflows, create live release tags, publish releases, or create/promote main.

You have no physical hardware access. Use mocked transports/services, local fixtures and Electron/simulator/web tests. Physical input, display and host permission work belongs to the coordinator's consolidated acceptance session after the selected PRs land. Clearly mark physical acceptance pending. The plan files may be local-only; this attachment includes the complete relevant handoff, so their absence is not a blocker.

Preserve schema v3, workflowAliases and the migration safeguards from PR06, PR04 canvas stability/minimap, PR05/06 searchable selectors, PR01/02 truthful device diagnostics, PR03 Home/discovery, PR07 peer settings and the release tooling. Keep node JSON configuration and switch ports/behavior. Do not implement credentials, media/brightness variants, toggles, schedules, workflow data nodes, dynamic buttons or a plugin marketplace in this task.

Run meaningful focused regression tests and applicable npm run format:check, npm run typecheck, npm test, npm run build and Electron E2E (xvfb-run --auto-servernum npm run test:e2e where available). Keep CI packaging/native smoke gates; PR13 must verify its resources in the packaged app. Use current CI for exact commands. Distinguish missing environment prerequisites or restricted loopback/subprocess access from product regressions; use permitted setup instead of weakening assertions. Rebase from current develop and rerun affected tests before finalizing. Report behavior, compatibility, test evidence, blocked checks and remaining host gates in the PR.

## Coordinator-approved file and integration ownership

Prefer focused new modules and new test files; no broad reformat or refactor of integration files. No document schema version is allocated in this wave.

- PR14 owns runtime/engine.ts, coordinator.ts, cancellation.ts and worker.ts, new runtime invocation/activity modules, and shared/feedback.ts. In main/index.ts it owns run-message handling, transient activity storage, interruption cleanup and activity composition in deckAppearance. In Deck.tsx it owns only run/activity selection and busy/status presentation, preserving icon JSX and editor fields. Avoid catalog, ActionFields, file-dialog requests, icon assets/renderers and workflow-identity migration changes.
- PR10 owns shared/catalog.ts action definitions/field metadata/palette visibility, renderer/components.tsx action fields, any minimal Flows action-library filter, new desktop-open/picker modules and the desktop file-picker request variant in shared/schema.ts. In main/index.ts it owns only desktop.open/new URL/file action cases and the new picker request case/imports. Preserve run-message/activity sections. Existing generic preload transport may need no changes; validate at the trusted boundary.
- PR13 owns new shared icon registry/render helpers, new icon-picker components/styles, device/images.ts icon rendering, renderer/web/client.ts icon rendering and scoped web icon styles. In Deck.tsx it owns only icon/asset JSX, preview and icon editor. It owns a packaging notice/resource inclusion patch if needed. Keep appearance.icon a backward-compatible string with a stable pack token; do not change persisted schema, main/index.ts, catalog, components.tsx or activity logic.

The main/index.ts and Deck.tsx integration regions are explicitly divided above so all three can produce reviewable PRs. Imports may require routine conflict resolution; preserve the other lane's imports and behavior. No integration region is co-owned. If a change would cross those region boundaries, queue that overlapping patch behind its owner's merge and describe the required patch while progressing independent work. Rebase and rerun cross-feature checks after any other wave PR merges. Do not overwrite another task's work or silently expand ownership.

## Branch and dependency

Requires PR05 / GitHub #11 (already included in latest develop). Create codex/lucide-icon-pack. Also preserve the subsequently merged PR06 workflow identities and PR03 Home routing.

The project already uses lucide-react. appearance.icon is a string up to 100 characters, and WebKey.icon is also a string. Main-process deckAppearance already forwards that value to web and hardware. Keep this contract and use a stable, versioned reserved token such as "pack:lucide:v1:camera" for selected pack icons. All selection, decoding and rendering must share one helper and preserve emoji/text icon strings. No persisted schema migration or main-process changes are needed.

Current device/images.ts truncates ordinary text icons to four characters before embedding in SVG. Recognize and render valid pack tokens before this fallback path. Unknown/malformed pack tokens must get a useful fallback without throwing or displaying a truncated opaque identifier. Do not treat icon strings as remote URLs, file paths or arbitrary SVG.

## Full outcome

Add a searchable Lucide icon pack to the button icon picker. Keep label, background, emoji/text icons and uploaded images supported. Persist stable pack/version/icon names; expose human-readable names in the picker. Provide accessible keyboard navigation, clear selection and empty search feedback. Pack selection, custom text and uploaded image precedence must be deliberate: selecting a pack icon should visibly select it rather than leave an old uploaded image covering it. Never discard an image asset from storage merely because an editor selection changes.

Own a small versioned registry and shared non-React icon data/render helper. Bundle a useful curated selection with stable names and search keywords instead of every icon module. Desktop preview, selected-key preview, web deck and generated hardware frame must use the same icon geometry, sizing and foreground treatment. Hardware code must not import React components or rely on platform emoji fonts for pack icons. A trusted registry of local SVG path data or normalized deterministic assets is appropriate; do not permit imported documents to supply arbitrary executable SVG or resource references.

Use the existing appearance.icon transport and local bundled resources. Web clients should render bundled pack geometry without gaining new filesystem access or bypassing existing scoped image-asset routes. Preserve upload asset authorization. Both initial web render and incremental update paths must use the same icon helper so changing a key updates correctly. Leave run/activity selection and busy indicators to PR14.

Preserve Lucide's applicable ISC and Feather-derived MIT notices in distributed artifacts. Verify the exact installed package/source notices and consult the official license page if needed: https://lucide.dev/license . Check the current packaging inclusion (out/**/* and package.json) so notices/resources are actually shipped, not only added to an excluded repository folder. No license change for Decker itself and no plugin marketplace, remote pack download, remote SVG or animation.

## Verification

Cover search/selection/keyboard, clear/custom text/upload transitions, save/reload/copy/export/import, unknown pack/version/icon fallback, and existing emoji/text behavior. Verify size, color/background and label placement in generated frames (including 96 px XL intent) against desktop/web previews with deterministic registry fixtures. Include icon change during activity and confirm neither run feedback nor uploaded-asset precedence is accidentally altered.

Exercise both initial web page and same-page icon updates with an authenticated web client; confirm asset scoping remains intact. Verify registry assets and notices in build and both Linux package artifacts, and run packaged Electron/native smoke checks. Use visual observations of the picker and representative previews/96 px frames; software evidence does not establish real-device appearance. Physical XL comparison remains in the final host acceptance session.
