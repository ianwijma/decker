import { it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Persistence, validateDocument } from "../src/main/persistence";
import { defaults } from "../src/shared/defaults";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "decker-test-"));
  directories.push(dir);
  return new Persistence(dir);
}
it("persists assignments and marks active runs interrupted without replay", async () => {
  const s = await store(),
    { document } = await s.load();
  document.settings.accent = "#eb459e";
  await s.save(document, [
    {
      id: "run",
      workflowId: "welcome",
      workflowName: "Welcome",
      revision: 1,
      startedAt: 1,
      status: "running",
      nodes: [],
    },
  ]);
  const loaded = await s.load();
  expect(loaded.document.settings.accent).toBe("#eb459e");
  expect(loaded.runs[0].status).toBe("interrupted");
});
it("serializes writes, bounds history, and exports assets without credentials", async () => {
  const s = await store();
  await s.load();
  const doc = defaults();
  doc.settings.historyLimit = 10;
  doc.connections = [
    {
      id: "obs",
      name: "OBS",
      url: "ws://localhost:4455",
      credentialRef: "secret",
    },
  ];
  const asset = await s.storeAsset(Buffer.from("image"));
  doc.profiles[0].pages[0].keys[0].appearance.asset = asset;
  await Promise.all([
    s.save(doc, []),
    s.save({ ...doc, settings: { ...doc.settings, accent: "#123456" } }, []),
  ]);
  expect((await s.load()).document.settings.accent).toBe("#123456");
  const exported = await s.export(doc);
  expect(exported.document.connections[0]).not.toHaveProperty("credentialRef");
  expect(exported.assets[asset]).toBe(Buffer.from("image").toString("base64"));
});
it("backs up unsupported versions and rejects folder cycles and unknown active pages", async () => {
  const s = await store();
  await s.load();
  await writeFile(
    join(s.directory, "config.json"),
    JSON.stringify({ schemaVersion: 99 }),
  );
  expect((await s.load()).warning).toContain("backup saved");
  const doc = defaults();
  doc.profiles[0].pages[0].parentId = "home";
  expect(() => validateDocument(doc)).toThrow("Folder cycle");
  delete doc.profiles[0].pages[0].parentId;
  doc.activePageId = "missing";
  expect(() => validateDocument(doc)).toThrow("Active");
});
it("rejects image tampering and path traversal on import", async () => {
  const s = await store();
  await s.load();
  await expect(s.importAssets({ "../config.json": "a" })).rejects.toThrow(
    "Invalid asset",
  );
  await expect(
    s.importAssets({ ["a".repeat(64)]: "aW1hZ2U=" }),
  ).rejects.toThrow("checksum");
});
