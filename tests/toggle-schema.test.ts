import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults, binding, uid, node } from "../src/shared/defaults";
import {
  documentSchema,
  v3DocumentSchema,
  bindingSchema,
  type AppDocument,
  type Target,
} from "../src/shared/schema";
import { migrateDocument, cloneProfiles } from "../src/shared/decks";
import {
  Persistence,
  validateDocument,
  validateImport,
} from "../src/main/persistence";
import {
  credentialOwners,
  rekeyCredentials,
} from "../src/shared/credential-owners";
import { toggleKey } from "../src/shared/toggle-contract";
import { ToggleStorage } from "../src/main/toggle-storage";
import { toggleStamp } from "../src/runtime/targets";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function directory() {
  const d = await mkdtemp(join(tmpdir(), "decker-toggle-schema-"));
  dirs.push(d);
  return d;
}
function fixture() {
  const doc = defaults(),
    b = binding("desktop.copy");
  delete b.press;
  const http = {
    type: "http.request",
    version: 1 as const,
    config: {
      url: "https://example.com",
      method: "GET",
      body: "",
      credentialRef: "managed:fixture",
    },
  };
  b.toggle = {
    on: { kind: "action", action: structuredClone(http) },
    off: { kind: "sequence", actions: [structuredClone(http)] },
    source: {
      kind: "external",
      probe: { kind: "action", action: structuredClone(http) },
      timeoutMs: 1000,
    },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  return { doc, b };
}
it.each([1, 2, 3])(
  "migrates version %i in order to v4 without synthesizing toggles or changing saved targets",
  async (version) => {
    const doc = defaults();
    const old = { ...doc, schemaVersion: version };
    let value: unknown = old;
    if (version < 3) {
      const { workflowAliases: _, ...legacy } = old;
      legacy.workflows[0].id = "welcome";
      legacy.profiles[0].pages[0].keys[2].press = {
        kind: "workflow",
        workflowId: "welcome",
      };
      value =
        version === 1
          ? {
              ...legacy,
              activeProfileId: "default",
              activePageId: "home",
              devices: [],
              settings: { ...legacy.settings, brightness: 70, simulator: true },
            }
          : legacy;
    }
    const migrated = migrateDocument(value);
    expect(migrated.schemaVersion).toBe(4);
    expect(
      migrated.profiles
        .flatMap((p) => p.pages.flatMap((page) => Object.values(page.keys)))
        .every((b) => !b.toggle),
    ).toBe(true);
    if (version === 3) expect(migrated).toEqual({ ...doc, schemaVersion: 4 });
    else
      expect(migrated.profiles[0].pages[0].keys[2].press).toEqual({
        kind: "workflow",
        workflowId: migrated.workflowAliases.welcome,
      });
    const dir = await directory();
    await writeFile(join(dir, "config.json"), JSON.stringify(value));
    const store = new Persistence(dir);
    expect((await store.load()).document).toMatchObject({ schemaVersion: 4 });
    expect(
      (await readdir(dir)).filter((f) => f.startsWith("migration-backup-")),
    ).toHaveLength(1);
    await store.load();
    expect(
      (await readdir(dir)).filter((f) => f.startsWith("migration-backup-")),
    ).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(dir, "config.json"), "utf8"))
        .schemaVersion,
    ).toBe(4);
  },
);
it("retains an explicit v3 decoder and preserves future documents instead of stripping unsupported data", async () => {
  const { doc } = fixture();
  expect(() => v3DocumentSchema.parse({ ...doc, schemaVersion: 3 })).toThrow();
  expect(() => documentSchema.parse({ ...doc, schemaVersion: 5 })).toThrow();
  const dir = await directory(),
    raw = JSON.stringify({
      ...doc,
      schemaVersion: 5,
      future: { secret: "untouched" },
    });
  await writeFile(join(dir, "config.json"), raw);
  const store = new Persistence(dir),
    loaded = await store.load();
  expect(loaded.warning).toContain("Unsupported schema version 5");
  await expect(store.save(defaults(), [])).rejects.toThrow(
    "writes are blocked",
  );
  expect(await readFile(join(dir, "config.json"), "utf8")).toBe(raw);
});
it("rejects conflicting toggle inputs without dropping any saved assignments", () => {
  const { b } = fixture();
  for (const phase of ["press", "release", "longPress"] as const) {
    const target: Target = { kind: "workflow", workflowId: uid() },
      conflict = { ...b, [phase]: target };
    expect(() => bindingSchema.parse(conflict)).toThrow(
      "Toggle mode owns input",
    );
    expect(conflict[phase]).toEqual(target);
  }
  expect(bindingSchema.parse(b).toggle).toEqual(b.toggle);
});
it("round trips v4 documents while export/import/copy allocate fresh toggle identities and carry no runtime state", async () => {
  const { doc, b } = fixture(),
    dir = await directory(),
    store = new Persistence(dir);
  await store.load();
  await store.save(doc, []);
  expect((await store.load()).document).toEqual(doc);
  const runtime = new ToggleStorage(dir);
  await runtime.load();
  await runtime.request(
    {
      operation: "recover",
      key: toggleKey(doc.decks[0].id, b),
      stamp: toggleStamp(b),
      confirmed: "on",
    },
    doc,
  );
  const bundle = await store.export(doc);
  expect(JSON.stringify(bundle)).not.toContain("confirmed");
  expect(JSON.stringify(bundle)).not.toContain("pending");
  const imported = validateImport(bundle.document),
    key = imported.profiles[0].pages[0].keys[0];
  expect(key.id).not.toBe(b.id);
  expect(key.generation).toBe(0);
  expect(
    validateImport(bundle.document).profiles[0].pages[0].keys[0].id,
  ).not.toBe(key.id);
  const copy = cloneProfiles(doc.profiles).profiles[0].pages[0].keys[0];
  expect(copy.id).not.toBe(b.id);
  expect(copy.toggle).toEqual(b.toggle);
  expect(
    await runtime.request(
      {
        operation: "read",
        key: toggleKey(imported.decks[0].id, key),
        stamp: toggleStamp(key),
      },
      imported,
    ),
  ).toBeNull();
});
it("walks every toggle target for credentials and rekeys without leaking local refs or stranding shared owners", () => {
  const { doc, b } = fixture();
  const owners = credentialOwners(doc);
  expect(owners).toHaveLength(3);
  expect(owners.map((o) => JSON.parse(o.key)[2])).toEqual([
    "toggle.on",
    "toggle.off",
    "toggle.probe",
  ]);
  let count = 0;
  const exported = rekeyCredentials(doc, () => `import:${++count}`);
  expect(count).toBe(1);
  expect(credentialOwners(exported).every((o) => o.ref === "import:1")).toBe(
    true,
  );
  expect(JSON.stringify(exported)).not.toContain("managed:fixture");
  const imported = rekeyCredentials(
    validateImport(exported),
    () => `managed:fresh-${++count}`,
  );
  expect(
    credentialOwners(imported).every((o) => o.ref === "managed:fresh-2"),
  ).toBe(true);
  expect(credentialOwners(imported)[0].key).not.toBe(owners[0].key);
  const copied = structuredClone(doc);
  copied.profiles = cloneProfiles(doc.profiles).profiles;
  expect(
    credentialOwners(copied).every((o) => o.ref === "managed:fixture"),
  ).toBe(true);
  expect(b.toggle?.source.kind).toBe("external");
});
it("preserves aliases and validates missing workflow references throughout on/off/probe and nested sequences", () => {
  const { doc, b } = fixture(),
    id = doc.workflows[0].id;
  doc.workflowAliases = { legacy: id };
  b.toggle!.on = { kind: "workflow", workflowId: "legacy" };
  b.toggle!.off = {
    kind: "sequence",
    actions: [
      { type: "workflow.run", version: 1, config: { workflowId: "legacy" } },
    ],
  };
  b.toggle!.source = {
    kind: "external",
    probe: { kind: "workflow", workflowId: "legacy" },
    timeoutMs: 1000,
  };
  expect(validateImport(doc).workflowAliases).toEqual({ legacy: id });
  for (const location of ["on", "off", "probe"] as const) {
    const bad = structuredClone(doc),
      toggle = bad.profiles[0].pages[0].keys[0].toggle!;
    if (location === "probe" && toggle.source.kind === "external")
      toggle.source.probe = { kind: "workflow", workflowId: "deleted" };
    else if (location !== "probe")
      toggle[location] = { kind: "workflow", workflowId: "deleted" };
    expect(() => validateImport(bad)).toThrow("Missing assigned workflow");
  }
  doc.workflows[0].name = "Renamed";
  expect(validateImport(doc).workflowAliases.legacy).toBe(id);
});
it("remaps page/profile navigation in both toggle targets during copy and visits nested workflow credential owners", () => {
  const { doc, b } = fixture();
  b.toggle!.on = {
    kind: "action",
    action: { type: "deck.page", version: 1, config: { pageId: "home" } },
  };
  b.toggle!.off = {
    kind: "sequence",
    actions: [
      { type: "deck.profile", version: 1, config: { profileId: "default" } },
    ],
  };
  const cloned = cloneProfiles(doc.profiles),
    profile = cloned.profiles[0],
    toggle = profile.pages[0].keys[0].toggle!;
  expect(toggle.on).toMatchObject({
    action: { config: { pageId: profile.pages[0].id } },
  });
  expect(toggle.off).toMatchObject({
    actions: [{ config: { profileId: profile.id } }],
  });
  const action = {
      type: "http.request",
      version: 1 as const,
      config: {
        credentialRef: "managed:nested",
        url: "https://example.com",
        method: "GET",
        body: "",
      },
    },
    nested = { ...node("action", "Secret"), action };
  doc.workflows[0].graph.nodes = [
    {
      ...node("parallel", "Branches"),
      branches: [{ entry: nested.id, nodes: [nested], edges: [] }],
    },
  ];
  doc.workflows[0].graph.entry = doc.workflows[0].graph.nodes[0].id;
  expect(credentialOwners(doc).some((o) => o.ref === "managed:nested")).toBe(
    true,
  );
});
it("rejects stale durable commits after replacement or generation changes", async () => {
  const { doc, b } = fixture(),
    dir = await directory(),
    store = new ToggleStorage(dir);
  await store.load();
  const request = {
    operation: "prepare" as const,
    key: toggleKey(doc.decks[0].id, b),
    stamp: toggleStamp(b),
    token: uid(),
    confirmed: "off" as const,
  };
  await store.request(request, doc);
  b.generation++;
  await expect(
    store.request({ ...request, operation: "commit", confirmed: "on" }, doc),
  ).rejects.toThrow("Stale toggle identity");
  expect(validateDocument(doc).schemaVersion).toBe(4);
});

it("imports native command argv and existing templates in every toggle target without changing their grammar", () => {
  const { doc, b } = fixture();
  const action = {
    type: "command.run",
    version: 1 as const,
    config: {
      executable: "/bin/echo",
      args: ["literal $()", "quoted value"],
      cwd: "",
    },
  };
  b.toggle!.on = { kind: "action", action };
  b.toggle!.off = {
    kind: "sequence",
    actions: [
      action,
      {
        type: "desktop.notify",
        version: 1,
        config: {
          title: "Fixture",
          body: {
            $template: [
              "state: ",
              { $ref: ["outputs", "missing"], fallback: false },
            ],
          },
        },
      },
    ],
  };
  b.toggle!.source = {
    kind: "external",
    probe: { kind: "action", action },
    timeoutMs: 1000,
  };
  const imported = validateImport(doc);
  expect(imported.profiles[0].pages[0].keys[0].toggle).toEqual(b.toggle);
});
