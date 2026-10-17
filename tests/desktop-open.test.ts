import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesktopTarget } from "../src/main/desktop-open";
import { pickDesktopFile } from "../src/main/desktop-file-picker";
import { actionById, makeAction, paletteCatalog } from "../src/shared/catalog";
import { documentSchema, requestSchema } from "../src/shared/schema";
import { defaults, binding, node, uid } from "../src/shared/defaults";
import { Persistence, validateImport } from "../src/main/persistence";
import { handlers } from "../src/actions/handlers";
import { Engine } from "../src/runtime/engine";
import { ObsConnections } from "../src/integrations/obs";
import { validateWorkflow } from "../src/runtime/validate";

const shell = () => ({
  openExternal: vi.fn(async () => {}),
  openPath: vi.fn(async () => ""),
});
describe("desktop open actions", () => {
  it("offers separate actions while retaining legacy lookup and edit metadata", () => {
    expect(paletteCatalog.map((d) => d.id)).toContain("desktop.openUrl");
    expect(paletteCatalog.map((d) => d.id)).toContain("desktop.openFile");
    expect(paletteCatalog.map((d) => d.id)).not.toContain("desktop.open");
    expect(actionById("desktop.open")!.fields[0].key).toBe("target");
    expect(actionById("desktop.openFile")!.fields[0]).toMatchObject({
      type: "file",
      picker: "openFile",
    });
  });
  it.each([
    "http://example.com",
    "https://example.com/你好?a=with%20spaces",
    "HTTPS://example.com",
  ])("opens supported URL %s", async (url) => {
    const s = shell();
    await openDesktopTarget("desktop.openUrl", url, s);
    expect(s.openExternal).toHaveBeenCalledWith(new URL(url).href);
    expect(s.openPath).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "not a URL",
    "https://",
    "https://name:secret@example.com",
    "http://user@example.com",
    "file:///tmp/file",
    "javascript:alert(1)",
    "ftp://example.com",
    "https://example.com\n",
    { $ref: "inputs.url" },
  ])("rejects invalid URLs before shell calls: %j", async (url) => {
    const s = shell();
    expect(
      actionById("desktop.openUrl")!.schema.safeParse({ url }).success,
    ).toBe(false);
    await expect(
      openDesktopTarget("desktop.openUrl", url, s),
    ).rejects.toThrow();
    expect(s.openExternal).not.toHaveBeenCalled();
    expect(s.openPath).not.toHaveBeenCalled();
  });
  it.each([
    ["/tmp/你好 file.txt", "/tmp/你好 file.txt"],
    [" relative file.txt ", "/app/ relative file.txt "],
    ["./file:notes.txt", "/app/file:notes.txt"],
  ])("preserves local path %s", async (path, absolute) => {
    const s = shell();
    await openDesktopTarget("desktop.openFile", path, s, "/app");
    expect(s.openPath).toHaveBeenCalledWith(absolute);
    expect(s.openExternal).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "  ",
    "https://example.com",
    " file:///tmp/file",
    "javascript:alert(1)",
    "bad\0path",
    { $ref: "inputs.path" },
  ])("rejects non-path values %j", async (path) => {
    const s = shell();
    expect(
      actionById("desktop.openFile")!.schema.safeParse({ path }).success,
    ).toBe(false);
    await expect(
      openDesktopTarget("desktop.openFile", path, s),
    ).rejects.toThrow();
    expect(s.openPath).not.toHaveBeenCalled();
  });
  it("surfaces shell errors and preserves the legacy URL/path dispatch", async () => {
    const s = shell();
    await openDesktopTarget("desktop.open", "https://example.com", s);
    await openDesktopTarget("desktop.open", "relative 你好.txt", s, "/app");
    expect(s.openPath).toHaveBeenCalledWith("/app/relative 你好.txt");
    s.openPath.mockResolvedValue("File does not exist");
    await expect(
      openDesktopTarget("desktop.openFile", "/missing", s),
    ).rejects.toThrow("File does not exist");
    await expect(
      openDesktopTarget("desktop.open", "file:///tmp/file", s),
    ).rejects.toThrow();
    s.openExternal.mockRejectedValue(new Error("No browser"));
    await expect(
      openDesktopTarget("desktop.openUrl", "https://example.com", s),
    ).rejects.toThrow("No browser");
  });
});

it("validates the narrow picker request and returns a path string or null", async () => {
  expect(
    requestSchema.safeParse({ type: "pickFile", picker: "openFile" }).success,
  ).toBe(true);
  for (const request of [
    { type: "pickFile" },
    { type: "pickFile", picker: "directory" },
    { type: "pickFile", picker: "openFile", path: "/tmp" },
  ])
    expect(requestSchema.safeParse(request).success).toBe(false);
  const dialog = vi.fn(async () => ({
    canceled: false,
    filePaths: ["/tmp/你好 file.txt"],
  }));
  expect(await pickDesktopFile(dialog)).toBe("/tmp/你好 file.txt");
  expect(dialog).toHaveBeenCalledWith({
    title: "Choose file",
    properties: ["openFile"],
  });
  dialog.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await pickDesktopFile(dialog)).toBeNull();
  for (const paths of [
    [],
    ["relative"],
    ["https://example.com"],
    ["/a", "/b"],
  ]) {
    dialog.mockResolvedValue({ canceled: false, filePaths: paths });
    await expect(pickDesktopFile(dialog)).rejects.toThrow();
  }
});

it("resolves bound URL/path data before handler validation and rejects unresolved objects", async () => {
  const doc = defaults(),
    s = shell();
  const handler = handlers(
    () => doc,
    () => ({}),
    async (type, config) =>
      openDesktopTarget(
        type as "desktop.openUrl" | "desktop.openFile",
        config.url ?? config.path,
        s,
        "/app",
      ),
    new ObsConnections(() => {}),
  );
  const nodes = ["desktop.openUrl", "desktop.openFile"].map((type, i) => ({
    ...node("action", type),
    id: `step${i}`,
    action: {
      ...makeAction(type),
      config: {
        [i ? "path" : "url"]: { $ref: i ? "inputs.path" : "inputs.url" },
      },
    },
  }));
  const workflow = {
    ...doc.workflows[0],
    id: uid(),
    graph: {
      entry: nodes[0].id,
      nodes,
      edges: [
        { id: "next", source: nodes[0].id, target: nodes[1].id, port: "next" },
      ],
    },
    inputs: ["url", "path"],
  };
  expect(validateWorkflow(workflow, [workflow])).toEqual([]);
  const engine = new Engine(handler, () => {});
  expect(
    (
      await engine.start(workflow, [workflow], {
        url: "https://example.com",
        path: "你好 file.txt",
      }).done
    ).status,
  ).toBe("success");
  expect(s.openPath).toHaveBeenCalledWith("/app/你好 file.txt");
  const bad = await engine.start(workflow, [workflow], {
    url: { unexpected: true },
    path: "/tmp",
  }).done;
  expect(bad.status).toBe("failure");
  expect(s.openExternal).toHaveBeenCalledTimes(1);
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it("round trips old and new assignments and bindings under schema v3", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decker-open-"));
  directories.push(directory);
  const store = new Persistence(directory);
  await store.load();
  const doc = defaults();
  for (const [index, type] of [
    "desktop.open",
    "desktop.openUrl",
    "desktop.openFile",
  ].entries())
    doc.profiles[0].pages[0].keys[index] = binding(type, type);
  doc.profiles[0].pages[0].keys[2].press = {
    kind: "sequence",
    actions: [
      {
        ...makeAction("desktop.openFile"),
        config: {
          path: { $ref: "inputs.path", fallback: "/tmp/你好 file.txt" },
        },
      },
      makeAction("desktop.openUrl"),
    ],
  };
  await store.save(doc, []);
  const imported = validateImport(
    (await store.export((await store.load()).document)).document,
  );
  expect(documentSchema.parse(imported)).toEqual(doc);
  expect(imported.schemaVersion).toBe(defaults().schemaVersion);
  expect(imported.workflowAliases).toEqual(doc.workflowAliases);
});
