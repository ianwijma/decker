import registry from "./lucide-v1.json" with { type: "json" };
import type { KeyBinding } from "./schema";

// v1 names and geometry are persisted API: extend, never rename or replace.
// Only this bundled data supplies SVG. Documents supply opaque string tokens.
export type PackIcon = Readonly<(typeof registry)[number]>;
export const lucideIcons: readonly PackIcon[] = Object.freeze(
  registry.map((icon) => Object.freeze(icon)),
);
const prefix = "pack:lucide:v1:";
const byName = new Map(lucideIcons.map((icon) => [icon.name, icon]));
const unavailable = byName.get("circle-help")!;
export type ResolvedIcon =
  | { kind: "custom"; text: string }
  | { kind: "pack"; icon: PackIcon; available: boolean };

export function iconToken(icon: PackIcon): string {
  return `${prefix}${icon.name}`;
}
export function resolveIcon(value: string): ResolvedIcon {
  if (!value.startsWith("pack:")) return { kind: "custom", text: value };
  const icon = value.startsWith(prefix)
    ? byName.get(value.slice(prefix.length))
    : undefined;
  return { kind: "pack", icon: icon ?? unavailable, available: !!icon };
}
export function searchIcons(query: string): readonly PackIcon[] {
  const words = query.toLowerCase().trim().split(/\s+/);
  return lucideIcons.filter((icon) =>
    words.every((word) =>
      `${icon.label} ${icon.name} ${icon.keywords}`
        .toLowerCase()
        .includes(word),
    ),
  );
}
export const escapeSvg = (text: string): string =>
  text.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const geometry = (icon: PackIcon) =>
  `<g fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.geometry}</g>`;
export function iconSvg(value: string): string | undefined {
  const resolved = resolveIcon(value);
  return resolved.kind === "pack"
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${geometry(resolved.icon)}</svg>`
    : undefined;
}

// Shared 100-unit canvas: 40% icon at (30%,16%), white 12% label baseline 80%.
// Desktop, selected preview, web and RGB frames all use these exact positions.
export function packKeySvg(icon: string, label: string): string | undefined {
  const resolved = resolveIcon(icon);
  if (resolved.kind === "custom") return undefined;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><svg x="30" y="16" width="40" height="40" viewBox="0 0 24 24">${geometry(resolved.icon)}</svg><text x="50" y="80" text-anchor="middle" font-family="sans-serif" font-size="12" fill="white">${escapeSvg(label.slice(0, 24))}</text></svg>`;
}

// An explicit icon/text choice replaces the image reference, never its bytes.
export function selectIcon(appearance: KeyBinding["appearance"], icon: string) {
  appearance.icon = icon;
  delete appearance.asset;
}
