import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defaults, node, uid } from "../src/shared/defaults";
import { makeAction } from "../src/shared/catalog";
import { migrateDocument } from "../src/shared/decks";
import {
  documentSchema,
  type Graph,
  type WorkflowDefinition,
} from "../src/shared/schema";
import {
  findWorkflow,
  resolveWorkflowId,
} from "../src/shared/workflow-identity";
import { Persistence, validateImport } from "../src/main/persistence";
import { Engine } from "../src/runtime/engine";
import { validateWorkflow } from "../src/runtime/validate";
import { createLatestFlowRunSelector } from "../src/renderer/src/flow-selectors";

function legacy() {
  const doc = defaults();
  doc.workflows[0].id = "welcome";
  doc.profiles[0].pages[0].keys[2].press = {
    kind: "workflow",
    workflowId: "welcome",
  };
  const { workflowAliases: _, ...old } = doc;
  return { ...old, schemaVersion: 2 };
}
function flow(name: string): WorkflowDefinition {
  const n = node("return", "Return");
  n.config = { text: "welcome" };
  return {
    ...defaults().workflows[0],
    id: uid(),
    name,
    revision: 7,
    graph: { entry: n.id, nodes: [n], edges: [] },
    layout: { [n.id]: { x: 99, y: 42 } },
  };
}
function graph(...nodes: Graph["nodes"]): Graph {
  return {
    entry: nodes[0].id,
    nodes,
    edges: nodes.slice(1).map((n, i) => ({
      id: uid(),
      source: nodes[i].id,
      target: n.id,
      port: "next",
    })),
  };
}
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function store() {
  const directory = await mkdtemp(
    join(tmpdir(), "decker-workflow-identities-"),
  );
  directories.push(directory);
  return new Persistence(directory);
}

it("fresh defaults generate UUIDs and bind the welcome flow using the same identity", () => {
  const doc = defaults(),
    other = defaults();
  expect(doc.schemaVersion).toBe(5);
  expect(z.uuid().safeParse(doc.workflows[0].id).success).toBe(true);
  expect(other.workflows[0].id).not.toBe(doc.workflows[0].id);
  expect(doc.profiles[0].pages[0].keys[2].press).toEqual({
    kind: "workflow",
    workflowId: doc.workflows[0].id,
  });
  expect(doc.workflowAliases).toEqual({});
});
it("uses one map for every typed nested reference while preserving user data and identity", () => {
  const old = legacy(),
    stable = flow("Existing UUID"),
    arbitrary = flow("Legacy"),
    parent = flow("Parent");
  arbitrary.id = "custom-old-id";
  const run = node("action", "Run"),
    cancel = node("action", "Cancel"),
    sub = node("subflow", "Child"),
    parallel = node("parallel", "Parallel"),
    repeat = node("repeat", "Repeat"),
    dynamic = node("action", "Dynamic"),
    text = node("action", "Text");
  run.action = {
    ...makeAction("workflow.run"),
    config: { workflowId: "welcome", other: "welcome" },
  };
  cancel.action = {
    ...makeAction("workflow.cancel"),
    config: { workflowId: "custom-old-id" },
  };
  sub.config = {
    workflowId: "welcome",
    revision: 1,
    inputs: { string: "welcome" },
  };
  dynamic.action = {
    ...makeAction("workflow.run"),
    config: { workflowId: { $ref: "inputs.which", fallback: "welcome" } },
  };
  text.action = {
    ...makeAction("command.shell"),
    config: { script: "welcome", cwd: "welcome" },
  };
  repeat.config = { maxIterations: 2, count: 1 };
  repeat.body = graph(sub, dynamic, text);
  parallel.branches = [graph(run, repeat), graph(cancel)];
  parent.graph = graph(parallel);
  old.workflows.push(stable, arbitrary, parent);
  const key = old.profiles[0].pages[0].keys[2];
  key.generation = 73;
  key.release = {
    kind: "sequence",
    actions: [run.action, cancel.action, text.action],
  };
  key.longPress = { kind: "action", action: dynamic.action };
  const migrated = migrateDocument(old),
    welcome = migrated.workflowAliases.welcome,
    custom = migrated.workflowAliases["custom-old-id"];
  const expected = structuredClone(old);
  expected.workflows[0].id = welcome;
  expected.workflows[2].id = custom;
  const expectedKey = expected.profiles[0].pages[0].keys[2];
  expectedKey.press = { kind: "workflow", workflowId: welcome };
  if (expectedKey.release?.kind !== "sequence") throw new Error();
  expectedKey.release.actions[0].config.workflowId = welcome;
  expectedKey.release.actions[1].config.workflowId = custom;
  const branches = expected.workflows[3].graph.nodes[0].branches!;
  branches[0].nodes[0].action!.config.workflowId = welcome;
  branches[0].nodes[1].body!.nodes[0].config.workflowId = welcome;
  branches[1].nodes[0].action!.config.workflowId = custom;
  expect(migrated).toEqual({
    ...expected,
    schemaVersion: 5,
    workflowAliases: { welcome, "custom-old-id": custom },
  });
  expect(migrateDocument(migrated)).toEqual(migrated);
  expect(
    findWorkflow(migrated.workflows, "welcome", migrated.workflowAliases)?.id,
  ).toBe(welcome);
  expect(resolveWorkflowId("toString", migrated.workflowAliases)).toBe(
    "toString",
  );
});
it("v1 imports retain deck migration semantics and then migrate workflow identities", () => {
  const old = legacy();
  const doc = validateImport({
    ...old,
    schemaVersion: 1,
    settings: { ...old.settings, simulator: true, brightness: 70 },
    devices: [{ id: "hardware", brightness: 30 }],
    activeProfileId: "default",
    activePageId: "home",
  });
  expect(doc.schemaVersion).toBe(5);
  expect(doc.decks).toHaveLength(2);
  expect(doc.decks[1].brightness).toBe(30);
  for (const p of doc.profiles)
    expect(p.pages[0].keys[2].press).toEqual({
      kind: "workflow",
      workflowId: doc.workflowAliases.welcome,
    });
});
it("rejects duplicate identities, alias collisions, chains, cycles and malformed targets", () => {
  const old = legacy();
  old.workflows.push(structuredClone(old.workflows[0]));
  expect(() => migrateDocument(old)).toThrow("Duplicate");
  const doc = defaults(),
    id = doc.workflows[0].id,
    other = uid();
  for (const aliases of [
    { [id]: other },
    { [other]: id },
    { first: other, [other]: id },
    { [other]: other },
    { old: "missing" },
    { default: id },
  ])
    expect(() =>
      documentSchema.parse({ ...doc, workflowAliases: aliases }),
    ).toThrow();
  // Keep a deleted UUID reserved so its legacy alias cannot be rebound.
  expect(
    documentSchema.parse({ ...doc, workflowAliases: { deleted: other } })
      .workflowAliases.deleted,
  ).toBe(other);
});
it("backs up before v2 migration, persists once, preserves finished history and reimports aliases", async () => {
  const s = await store(),
    old = legacy(),
    raw = JSON.stringify(old);
  const historic = {
    id: "old-run",
    workflowId: "welcome",
    workflowName: "Old name",
    revision: 1,
    startedAt: 100,
    endedAt: 200,
    status: "success",
    nodes: [],
  };
  await writeFile(join(s.directory, "config.json"), raw);
  await writeFile(
    join(s.directory, "history.json"),
    JSON.stringify([historic]),
  );
  const loaded = await s.load();
  expect(loaded.warning).toBeUndefined();
  expect(loaded.runs).toEqual([historic]);
  const backup = (await readdir(s.directory)).filter((n) =>
    n.startsWith("migration-backup-"),
  );
  expect(backup).toHaveLength(1);
  expect(await readFile(join(s.directory, backup[0]), "utf8")).toBe(raw);
  expect(
    JSON.parse(await readFile(join(s.directory, "config.json"), "utf8")),
  ).toEqual(loaded.document);
  expect((await s.load()).document).toEqual(loaded.document);
  expect(validateImport((await s.export(loaded.document)).document)).toEqual(
    loaded.document,
  );
  const selector = createLatestFlowRunSelector(loaded.document.workflows[0].id);
  expect(
    selector({
      snapshot: {
        ...loaded,
        capabilities: [],
        devices: [],
        observed: {},
        secureStorage: false,
        web: { running: false, port: 0, urls: [], clients: [], pending: [] },
      },
    }),
  ).toEqual(historic);
});
it.each(["future", "duplicate", "malformed", "bad-alias"])(
  "failed %s load leaves a recoverable original and prevents defaults overwriting it",
  async (kind) => {
    const s = await store(),
      old = legacy();
    let value: unknown = { schemaVersion: 99 };
    if (kind === "duplicate") {
      old.workflows.push(structuredClone(old.workflows[0]));
      value = old;
    }
    if (kind === "bad-alias")
      value = { ...defaults(), workflowAliases: { a: "b" } };
    const raw = kind === "malformed" ? "{invalid" : JSON.stringify(value);
    await writeFile(join(s.directory, "config.json"), raw);
    const loaded = await s.load();
    expect(loaded.warning).toContain("Workspace writes are blocked");
    await expect(s.save(loaded.document, [])).rejects.toThrow("blocked");
    expect(await readFile(join(s.directory, "config.json"), "utf8")).toBe(raw);
    const recoveries = (await readdir(s.directory)).filter((n) =>
      n.startsWith("recovery-"),
    );
    expect(recoveries).toHaveLength(1);
    expect(await readFile(join(s.directory, recoveries[0]), "utf8")).toBe(raw);
  },
);
it("dynamically computed Run, Cancel and pinned subflow references resolve aliases at execution", async () => {
  const old = legacy(),
    child = old.workflows[0];
  child.graph = graph(node("return", "Done"));
  child.graph.nodes[0].config = { result: "child result" };
  const parent = flow("Parent"),
    run = node("action", "Run"),
    cancel = node("action", "Cancel"),
    sub = node("subflow", "Subflow");
  run.action = {
    ...makeAction("workflow.run"),
    config: { workflowId: { $ref: "inputs.which" } },
  };
  cancel.action = {
    ...makeAction("workflow.cancel"),
    config: { workflowId: { $ref: "inputs.which", transform: "lowercase" } },
  };
  sub.config = {
    workflowId: { $ref: "inputs.which" },
    revision: 1,
    inputs: {},
  };
  parent.graph = graph(run, cancel, sub);
  old.workflows.push(parent);
  // Import validation must allow direct dynamic actions, too; no execution occurs.
  old.profiles[0].pages[0].keys[1].press = {
    kind: "sequence",
    actions: [run.action, cancel.action],
  };
  const doc = validateImport(old),
    handler = vi.fn(async () => null),
    engine = new Engine(
      handler,
      () => {},
      () => [],
      () => doc.workflowAliases,
    );
  expect(handler).not.toHaveBeenCalled();
  expect(
    validateWorkflow(doc.workflows[1], doc.workflows, doc.workflowAliases),
  ).toEqual([]);
  const result = await engine.start(doc.workflows[1], doc.workflows, {
    which: "welcome",
  }).done;
  expect(result.status).toBe("success");
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "workflow.cancel",
      config: { workflowId: doc.workflows[0].id },
    }),
    expect.anything(),
  );
  expect(result.nodes.filter((n) => n.name === "Done")).toHaveLength(2);
  doc.workflows[1].graph.nodes[2].config.revision = 2;
  expect(
    (
      await engine.start(doc.workflows[1], doc.workflows, { which: "welcome" })
        .done
    ).status,
  ).toBe("failure");
  delete doc.workflows[1].graph.nodes[2].config.revision;
  expect(
    (
      await engine.start(doc.workflows[1], doc.workflows, { which: "welcome" })
        .done
    ).error,
  ).toContain("Pin a subflow revision");
  expect(
    (
      await engine.start(doc.workflows[1], doc.workflows, { which: "deleted" })
        .done
    ).status,
  ).toBe("failure");
});
it("literal aliases participate in missing-reference and recursive-call validation", () => {
  const doc = migrateDocument(legacy()),
    run = node("action", "Recursive");
  run.action = {
    ...makeAction("workflow.run"),
    config: { workflowId: "welcome" },
  };
  doc.workflows[0].graph = graph(run);
  expect(
    validateWorkflow(
      doc.workflows[0],
      doc.workflows,
      doc.workflowAliases,
    ).join(),
  ).toContain("Recursive");
  run.action.type = "workflow.cancel";
  run.action.config.workflowId = "deleted";
  expect(
    validateWorkflow(
      doc.workflows[0],
      doc.workflows,
      doc.workflowAliases,
    ).join(),
  ).toContain("missing workflow");
});

it("prototype-like legacy IDs remain own alias data through migration and reimport", () => {
  const old = legacy();
  old.workflows[0].id = "__proto__";
  old.profiles[0].pages[0].keys[2].press = {
    kind: "workflow",
    workflowId: "__proto__",
  };
  const doc = migrateDocument(old);
  expect(Object.hasOwn(doc.workflowAliases, "__proto__")).toBe(true);
  expect(resolveWorkflowId("__proto__", doc.workflowAliases)).toBe(
    doc.workflows[0].id,
  );
  expect(validateImport(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  expect(() =>
    migrateDocument({ ...legacy(), workflowAliases: { old: uid() } }),
  ).toThrow("schema version 3");
});

it("a failed atomic migration write retains the backup and blocks subsequent writes", async () => {
  const s = await store(),
    raw = JSON.stringify(legacy());
  await writeFile(join(s.directory, "config.json"), raw);
  const atomic = vi
    .spyOn(
      s as unknown as { atomic(name: string, contents: string): Promise<void> },
      "atomic",
    )
    .mockRejectedValue(
      Object.assign(new Error("write failed"), { code: "ENOENT" }),
    );
  const loaded = await s.load();
  expect(loaded.warning).toContain("write failed");
  expect(atomic).toHaveBeenCalledOnce();
  await expect(s.save(loaded.document, [])).rejects.toThrow("blocked");
  expect(await readFile(join(s.directory, "config.json"), "utf8")).toBe(raw);
  const backup = (await readdir(s.directory)).find((name) =>
    name.startsWith("migration-backup-"),
  )!;
  expect(await readFile(join(s.directory, backup), "utf8")).toBe(raw);
});
