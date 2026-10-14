// Inspect the actual installers, so a builder filter cannot silently omit
// icon geometry or either upstream notice. No release or hardware operations.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractFile, listPackage } from "@electron/asar";

async function archives(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? archives(path)
        : entry.name === "app.asar"
          ? [path]
          : [];
    }),
  );
  return paths.flat();
}
const registry = JSON.parse(
  await readFile("src/shared/lucide-v1.json", "utf8"),
) as Array<{ name: string; geometry: string }>;
const notices = await readFile("src/shared/icon-notices.txt");
assert.match(notices.toString(), /ISC License/);
assert.match(notices.toString(), /The MIT License \(MIT\)/);
assert.match(notices.toString(), /Copyright \(c\) 2013-2023 Cole Bemis/);
const packages = (await readdir("release")).filter(
  (name) => name.endsWith(".deb") || name.endsWith(".AppImage"),
);
assert(
  packages.some((name) => name.endsWith(".deb")),
  "Debian installer missing",
);
assert(
  packages.some((name) => name.endsWith(".AppImage")),
  "AppImage installer missing",
);
await mkdir("work", { recursive: true });
for (const name of packages) {
  const directory = await mkdtemp(resolve("work/icon-package-"));
  try {
    const artifact = resolve("release", name);
    if (name.endsWith(".deb"))
      execFileSync("dpkg-deb", ["-x", artifact, directory]);
    else
      execFileSync(artifact, ["--appimage-extract"], {
        cwd: directory,
        stdio: "ignore",
      });
    const found = await archives(directory);
    assert.equal(found.length, 1, `${name}: expected one packaged app`);
    const archive = found[0];
    assert.deepEqual(
      extractFile(archive, "src/shared/icon-notices.txt"),
      notices,
      `${name}: upstream notices missing or changed`,
    );
    const files = listPackage(archive, { isPack: false }).map((path) =>
      path.replace(/^\//, ""),
    );
    const device = extractFile(archive, "out/main/device.js")
      .toString()
      .replaceAll("\\", "");
    const renderer = files
      .filter((path) => /^out\/renderer\/assets\/.*\.js$/.test(path))
      .map((path) => extractFile(archive, path).toString())
      .join("\n")
      .replaceAll("\\", "");
    for (const [target, code] of [
      ["hardware", device],
      ["desktop/web", renderer],
    ]) {
      assert(
        code.includes("pack:lucide:v1:"),
        `${name}: ${target} token helper missing`,
      );
      for (const icon of registry)
        assert(
          code.includes(icon.geometry),
          `${name}: ${target} ${icon.name} geometry missing`,
        );
    }
    console.log(
      `${name}: all ${registry.length} icons and ISC/MIT notices verified`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
