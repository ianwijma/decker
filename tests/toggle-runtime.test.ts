import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults, binding, node, uid } from "../src/shared/defaults";
import type {
  AppDocument,
  Target,
  WorkflowDefinition,
  Json,
  RunRecord,
} from "../src/shared/schema";
import { Engine, type Handler } from "../src/runtime/engine";
import { Toggles, probeState } from "../src/runtime/toggles";
import {
  ToggleStorage,
  type StoredToggle,
  type ToggleStorageRequest,
} from "../src/main/toggle-storage";
import { toggleKey } from "../src/shared/toggle-contract";
import { toggleStamp } from "../src/runtime/targets";
import { Triggers } from "../src/device/triggers";
import { handlers } from "../src/actions/handlers";
import { Coordinator } from "../src/runtime/coordinator";
import { ButtonActivity } from "../src/runtime/activity";
import { boundedResult } from "../src/runtime/results";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "decker-toggles-"));
  directories.push(dir);
  return dir;
}
const target = (text: string): Target => ({
  kind: "action",
  action: { type: "desktop.copy", version: 1, config: { text } },
});
function fixture() {
  const doc = defaults(),
    b = binding("desktop.copy");
  delete b.press;
  b.toggle = {
    on: target("on"),
    off: target("off"),
    source: { kind: "app", initial: "off" },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  return { doc, b, deckId: doc.decks[0].id };
}
function harness(
  doc: AppDocument,
  handler: Handler = async () => null,
  store?: (request: ToggleStorageRequest) => Promise<StoredToggle | null>,
) {
  const records: RunRecord[] = [],
    entries = new Map<string, StoredToggle>();
  const engine = new Engine(handler, (record) => {
    const i = records.findIndex((r) => r.id === record.id);
    if (i < 0) records.push(record);
    else records[i] = record;
  });
  const storage = vi.fn(
    store ??
      (async (request: ToggleStorageRequest) => {
        if (request.operation === "read")
          return entries.get(request.key) ?? null;
        const value: StoredToggle = {
          key: request.key,
          stamp: request.stamp,
          confirmed: request.confirmed,
          ...(request.operation === "prepare"
            ? { pending: request.token }
            : {}),
        };
        entries.set(request.key, value);
        return value;
      }),
  );
  const service = new Toggles(engine, storage, () => {});
  service.configure(doc);
  return {
    service,
    engine,
    records,
    storage,
    entries,
    state: () => service.snapshot()[0],
  };
}
function flow(
  ...nodes: WorkflowDefinition["graph"]["nodes"]
): WorkflowDefinition {
  return {
    ...defaults().workflows[0],
    id: uid(),
    graph: {
      entry: nodes[0].id,
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: uid(),
        source: nodes[i].id,
        target: n.id,
        port: "next",
      })),
    },
  };
}
function external() {
  const f = fixture();
  f.b.toggle!.source = {
    kind: "external",
    probe: target("probe"),
    timeoutMs: 1000,
  };
  return f;
}

it("serializes simultaneous desktop/web presses, ignores busy presses, and uses confirmed state", async () => {
  const { doc, b, deckId } = fixture();
  let release!: () => void;
  const calls: Json[] = [];
  const h = harness(doc, async (a) => {
    calls.push(a.config.text);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return null;
  });
  await h.service.settled();
  const triggers = new Triggers((binding, _target, deck, phase) => {
    if (phase === "press") void h.service.press(deck, binding);
  });
  triggers.down("desktop", 0, b, deckId);
  triggers.down("web:fixture", 0, b, deckId);
  triggers.up("desktop", 0);
  triggers.up("web:fixture", 0);
  await vi.waitFor(() => expect(calls).toEqual(["on"]));
  expect(h.state().confirmed).toBe("off");
  expect(h.state().transitioning).toBe(true);
  release();
  await vi.waitFor(() =>
    expect(h.state()).toMatchObject({ confirmed: "on", transitioning: false }),
  );
  const off = h.service.press(deckId, b);
  await vi.waitFor(() => expect(calls).toEqual(["on", "off"]));
  release();
  await off;
  expect(h.state().confirmed).toBe("off");
});

it.each(["action", "sequence", "workflow"] as const)(
  "executes %s on/off targets using real temporary command fixtures and survives restart",
  async (kind) => {
    const dir = await directory(),
      marker = join(dir, "fixture");
    const { doc, b, deckId } = fixture();
    const command = (state: string) => ({
      type: "command.run",
      version: 1 as const,
      config: {
        executable: "/bin/sh",
        args: ["-c", 'printf %s "$1" > "$2"', "fixture", state, marker],
        cwd: "",
      },
    });
    const make = (state: string): Target => {
      const a = command(state);
      if (kind === "action") return { kind, action: a };
      if (kind === "sequence")
        return {
          kind,
          actions: [
            a,
            {
              type: "data.extract",
              version: 1,
              config: { input: { on: true }, path: "on" },
            },
          ],
        };
      const n = { ...node("action", "Fixture command"), action: a },
        w = flow(n);
      doc.workflows.push(w);
      return { kind, workflowId: w.id };
    };
    b.toggle!.on = make("on");
    b.toggle!.off = make("off");
    const store = new ToggleStorage(dir);
    await store.load();
    const handler = handlers(
      () => doc,
      () => ({}),
      async () => null,
      {} as never,
    );
    const h = harness(doc, handler, (request) => store.request(request, doc));
    await h.service.settled();
    await h.service.press(deckId, b);
    expect(await readFile(marker, "utf8")).toBe("on");
    expect(h.state().confirmed).toBe("on");
    h.service.stop();
    const reopened = new ToggleStorage(dir);
    await reopened.load();
    const restart = harness(doc, handler, (request) =>
      reopened.request(request, doc),
    );
    await restart.service.settled();
    expect(restart.state().confirmed).toBe("on");
    await restart.service.press(deckId, b);
    expect(await readFile(marker, "utf8")).toBe("off");
    expect(restart.state().confirmed).toBe("off");
  },
);

it.each(["failure", "cancelled", "timeout"] as const)(
  "retains confirmed state and releases the slot after %s",
  async (mode) => {
    const { doc, b, deckId } = fixture();
    const wait = {
      ...node("delay", "Wait"),
      config: { ms: 30000 },
      timeoutMs: 60000,
    };
    const w = flow(wait);
    if (mode === "timeout") w.timeoutMs = 10;
    if (mode !== "failure") {
      doc.workflows.push(w);
      b.toggle!.on = { kind: "workflow", workflowId: w.id };
    }
    const h = harness(doc, async () => {
      throw new Error("sensitive message");
    });
    await h.service.settled();
    const pressing = h.service.press(deckId, b);
    if (mode === "cancelled") {
      await vi.waitFor(() => expect(h.engine.activeCount).toBe(1));
      h.engine.cancelWorkflow(w.id);
    }
    await pressing;
    expect(h.state()).toMatchObject({
      confirmed: "off",
      transitioning: false,
      error: mode === "failure" ? "transition-failed" : mode,
    });
    expect(JSON.stringify(h.service.snapshot())).not.toContain("sensitive");
    expect(h.engine.activeCount).toBe(0);
  },
);

it("cancels nested workflows, clears activity, and never takes cancellation error/retry edges", async () => {
  const { doc, b, deckId } = fixture();
  const waiting = {
    ...node("delay", "Wait"),
    config: { ms: 30000 },
    retries: 2,
  };
  const child = flow(waiting),
    call = {
      ...node("action", "Call"),
      action: {
        type: "workflow.run",
        version: 1 as const,
        config: { workflowId: child.id },
      },
    };
  const root = flow(call, {
    ...node("action", "Never"),
    action: { type: "desktop.copy", version: 1, config: { text: "never" } },
  });
  root.graph.edges[0].port = "error";
  doc.workflows.push(child, root);
  b.toggle!.on = { kind: "workflow", workflowId: root.id };
  const effects = vi.fn(async () => null),
    h = harness(doc, effects);
  await h.service.settled();
  const pressing = h.service.press(deckId, b);
  await vi.waitFor(() => expect(h.engine.activeCount).toBe(1));
  new Coordinator(h.engine).cancelWorkflow(child.id);
  await pressing;
  const activity = new ButtonActivity();
  for (const record of h.records) activity.update(record, doc);
  expect(activity.snapshot()).toEqual({});
  expect(h.records[0].status).toBe("cancelled");
  expect(effects).not.toHaveBeenCalled();
  expect(h.state().confirmed).toBe("off");
});

it("keeps decks independent and invalidates replaced/removed generations before stale completion", async () => {
  const { doc, b, deckId } = fixture();
  doc.decks.push({ ...doc.decks[0], id: "second" });
  let release!: () => void;
  const h = harness(doc, async (_a, context) => {
    if (context.deckId === deckId)
      await new Promise<void>((r) => {
        release = r;
      });
    return null;
  });
  await h.service.settled();
  const old = h.service.press(deckId, b);
  await vi.waitFor(() => expect(h.engine.activeCount).toBe(1));
  await h.service.press("second", b);
  expect(h.service.snapshot()[1].confirmed).toBe("on");
  b.generation++;
  h.service.configure(doc);
  await h.service.settled();
  release();
  await old;
  expect(h.state()).toMatchObject({
    generation: 1,
    confirmed: "off",
    transitioning: false,
  });
  delete doc.profiles[0].pages[0].keys[0];
  h.service.configure(doc);
  expect(h.service.snapshot()).toEqual([]);
});

it("journals before effects and blocks uncertain persistence after an externally successful command", async () => {
  const dir = await directory(),
    { doc, b, deckId } = fixture();
  const store = new ToggleStorage(dir);
  await store.load();
  const effects = vi.fn(async () => null);
  const h = harness(doc, effects, async (request) => {
    if (request.operation === "commit") throw new Error("disk full");
    return store.request(request, doc);
  });
  await h.service.settled();
  await h.service.press(deckId, b);
  expect(h.state()).toMatchObject({
    confirmed: "off",
    blocked: true,
    error: "storage",
  });
  await h.service.press(deckId, b);
  expect(effects).toHaveBeenCalledTimes(1);
  const restartStore = new ToggleStorage(dir);
  await restartStore.load();
  const restart = harness(doc, effects, (r) => restartStore.request(r, doc));
  await restart.service.settled();
  expect(restart.state()).toMatchObject({
    confirmed: "off",
    blocked: true,
    error: "interrupted",
  });
  await restart.service.press(deckId, b);
  expect(effects).toHaveBeenCalledTimes(1);
  await restart.service.recover(deckId, b.id, "on");
  expect(restart.state()).toMatchObject({ confirmed: "on", blocked: false });
});

it("does not run an effect when the durable prepare fails or a state file is corrupt", async () => {
  const { doc, b, deckId } = fixture(),
    effects = vi.fn(async () => null);
  const h = harness(doc, effects, async (r) => {
    if (r.operation === "read") return null;
    throw new Error("storage");
  });
  await h.service.settled();
  await h.service.press(deckId, b);
  expect(effects).not.toHaveBeenCalled();
  const dir = await directory();
  await writeFile(join(dir, "toggles.json"), "corrupt");
  const store = new ToggleStorage(dir);
  await store.load();
  await expect(
    store.request(
      { operation: "read", key: toggleKey(deckId, b), stamp: toggleStamp(b) },
      doc,
    ),
  ).rejects.toThrow("unavailable");
  expect(await readFile(join(dir, "toggles.json"), "utf8")).toBe("corrupt");
});

it("keeps external startup unknown until authorized activation, reconciles drift and treats observations as authoritative", async () => {
  const { doc, b, deckId } = external();
  let observed: Json = { on: false };
  const calls: Json[] = [];
  const h = harness(doc, async (a) => {
    calls.push(a.config.text);
    return a.config.text === "probe" ? observed : null;
  });
  await h.service.settled();
  expect(h.state()).toMatchObject({ confirmed: "unknown", fresh: false });
  expect(await h.service.press(deckId, b)).toBe(false);
  expect(calls).toEqual([]);
  h.service.configure(doc, true);
  await vi.waitFor(() => expect(h.state().fresh).toBe(true));
  expect(h.state().confirmed).toBe("off");
  expect(h.records).toHaveLength(0);
  await h.service.press(deckId, b);
  expect(h.state()).toMatchObject({
    confirmed: "off",
    error: "probe-disagreed",
    fresh: true,
  });
  observed = { on: true };
  await h.service.reconcile(deckId, b.id);
  expect(h.state().confirmed).toBe("on");
  const before = calls.length;
  h.service.configure(structuredClone(doc));
  await h.service.settled();
  expect(calls).toHaveLength(before);
});

it.each([
  null,
  "",
  "TRUE",
  {},
  { stdout: "", exitCode: 0 },
  { stdout: "false", exitCode: 1 },
  { on: "false" },
  { on: false, extra: true },
  { stdout: "on".repeat(40000), exitCode: 0 },
] as Json[])(
  "rejects invalid/empty/oversized probe result %j without erasing last confirmed",
  async (invalid) => {
    const { doc, b, deckId } = external();
    let output: Json = { on: true };
    const h = harness(doc, async () => output);
    h.service.configure(doc, true);
    await h.service.settled();
    // configure above can overlap initial load: explicitly activate after initialization.
    await h.service.reconcile(deckId, b.id);
    expect(h.state().confirmed).toBe("on");
    output = invalid;
    await h.service.reconcile(deckId, b.id);
    expect(h.state()).toMatchObject({
      confirmed: "on",
      fresh: false,
      error: "probe-invalid",
    });
    expect(await h.service.press(deckId, b)).toBe(false);
    expect(h.records).toEqual([]);
  },
);

it.each(["error", "timeout", "cancelled"])(
  "settles a %s probe and allows later reconciliation",
  async (mode) => {
    const { doc, b, deckId } = external();
    if (b.toggle!.source.kind === "external") b.toggle!.source.timeoutMs = 10;
    let fail = true;
    const h = harness(doc, async (_a, c) => {
      if (!fail) return { on: true };
      if (mode === "error") throw new Error("secret output");
      return new Promise((_resolve, reject) =>
        c.signal.addEventListener("abort", () => reject(c.signal.reason), {
          once: true,
        }),
      );
    });
    await h.service.settled();
    const probing = h.service.reconcile(deckId, b.id);
    if (mode === "cancelled") {
      await vi.waitFor(() => expect(h.engine.activeCount).toBe(1), {
        interval: 1,
      });
      h.engine.cancelWorkflow("direct");
    }
    await probing;
    expect(h.state()).toMatchObject({
      confirmed: "unknown",
      fresh: false,
      reconciling: false,
    });
    fail = false;
    await h.service.reconcile(deckId, b.id);
    expect(h.state()).toMatchObject({ confirmed: "on", fresh: true });
  },
);

it("cancels probes on generation change/shutdown and rejects late observations", async () => {
  const { doc, b, deckId } = external();
  let release!: (value: Json) => void;
  const h = harness(
    doc,
    async () =>
      new Promise<Json>((r) => {
        release = r;
      }),
  );
  await h.service.settled();
  const probing = h.service.reconcile(deckId, b.id);
  await vi.waitFor(() => expect(h.engine.activeCount).toBe(1));
  b.generation++;
  h.service.configure(doc);
  await h.service.settled();
  release({ on: true });
  await probing;
  expect(h.state()).toMatchObject({
    confirmed: "unknown",
    generation: 1,
    fresh: false,
  });
  const second = h.service.reconcile(deckId, b.id);
  await vi.waitFor(() => expect(h.engine.activeCount).toBe(1));
  h.service.stop();
  release({ on: true });
  await second;
  expect(h.service.snapshot()).toEqual([]);
  expect(h.engine.activeCount).toBe(0);
});

it("provides private typed results while preserving redacted done and nested workflow returns", async () => {
  const ret = {
      ...node("return", "Return"),
      config: { on: true, secret: "fixture-secret" },
    },
    child = flow(ret);
  child.outputs = ["on"];
  const root = flow({
    ...node("subflow", "Nested"),
    config: { workflowId: child.id, revision: 1 },
  });
  const records: RunRecord[] = [],
    engine = new Engine(
      async () => null,
      (r) => records.push(r),
      () => ["fixture-secret"],
    );
  const h = engine.start(root, [child, root]);
  expect(await h.result).toEqual({
    status: "success",
    output: { status: "available", value: ret.config },
  });
  expect(JSON.stringify(await h.done)).not.toContain("fixture-secret");
  const before = records.length,
    probe = engine.start(
      root,
      [child, root],
      {},
      undefined,
      {},
      { privateResult: true },
    );
  await probe.result;
  expect(records).toHaveLength(before);
  expect((await probe.done).nodes.every((n) => !n.input && !n.output)).toBe(
    true,
  );
  expect(boundedResult(undefined)).toEqual({ status: "unavailable" });
  expect(boundedResult("🙂".repeat(17000))).toEqual({ status: "oversized" });
  let deep: Json = true;
  for (let i = 0; i < 18; i++) deep = { value: deep };
  expect(boundedResult(deep)).toEqual({ status: "oversized" });
  expect(
    boundedResult(
      Object.defineProperty({}, "on", {
        get() {
          throw new Error("must not read");
        },
        enumerable: true,
      }),
    ),
  ).toEqual({ status: "invalid" });
});

it("counts private probes in the engine cap and releases all slots on shutdown", async () => {
  const delay = flow({ ...node("delay", "Delay"), config: { ms: 30000 } }),
    engine = new Engine(
      async () => null,
      () => {},
    );
  const handles = Array.from({ length: 64 }, () =>
    engine.start(delay, [delay], {}, undefined, {}, { privateResult: true }),
  );
  expect(() => engine.start(delay, [delay])).toThrow("Maximum active runs");
  handles.forEach((h) => h.cancel());
  await Promise.all(handles.map((h) => h.done));
  expect(engine.activeCount).toBe(0);
});

it("documents a strict on/off probe grammar", () => {
  for (const v of [
    true,
    "on",
    { on: true },
    { stdout: "true\n", exitCode: 0 },
  ] as Json[])
    expect(probeState(v)).toBe("on");
  for (const v of [
    false,
    "off",
    { on: false },
    { stdout: "off\n", exitCode: 0 },
  ] as Json[])
    expect(probeState(v)).toBe("off");
  expect(probeState(0)).toBeUndefined();
});

it("keeps an externally successful transition stale when its following probe fails, then recovers on reconciliation", async () => {
  const { doc, b, deckId } = external();
  let invalid = false;
  const effects: Json[] = [];
  const h = harness(doc, async (a): Promise<Json> => {
    if (a.config.text === "probe")
      return invalid ? { stdout: "", stderr: "", exitCode: 0 } : { on: false };
    effects.push(a.config.text);
    invalid = true;
    return null;
  });
  await h.service.settled();
  await h.service.reconcile(deckId, b.id);
  await h.service.press(deckId, b);
  expect(h.state()).toMatchObject({
    confirmed: "off",
    fresh: false,
    error: "probe-invalid",
    transitioning: false,
  });
  await h.service.press(deckId, b);
  expect(effects).toEqual(["on"]);
  invalid = false;
  await h.service.reconcile(deckId, b.id);
  expect(h.state()).toMatchObject({ confirmed: "off", fresh: true });
});

it("keeps reconciled state through workflow rename/layout saves and invalidates changed execution definitions", async () => {
  const { doc, b, deckId } = external(),
    ret = { ...node("return", "Observation"), config: { on: false } },
    probe = flow(ret);
  doc.workflows.push(probe);
  b.toggle!.source = {
    kind: "external",
    probe: { kind: "workflow", workflowId: probe.id },
    timeoutMs: 1000,
  };
  const h = harness(doc);
  await h.service.settled();
  await h.service.reconcile(deckId, b.id);
  expect(h.state()).toMatchObject({ confirmed: "off", fresh: true });
  const reads = h.storage.mock.calls.length;
  probe.name = "Renamed observer";
  probe.layout[ret.id] = { x: 300, y: 400 };
  h.service.configure(doc);
  await h.service.settled();
  expect(h.storage).toHaveBeenCalledTimes(reads);
  expect(h.state()).toMatchObject({ confirmed: "off", fresh: true });
  ret.config.on = true;
  probe.revision++;
  h.service.configure(doc);
  await h.service.settled();
  expect(h.state()).toMatchObject({ confirmed: "off", fresh: false });
  await h.service.reconcile(deckId, b.id);
  expect(h.state()).toMatchObject({ confirmed: "on", fresh: true });
});

it("refresh definition and activation edits neither reconcile nor cancel a pending toggle transition", async () => {
  const { doc, b, deckId } = fixture();
  let release!: () => void;
  const h = harness(doc, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return null;
  });
  await h.service.settled();
  const press = h.service.press(deckId, b);
  await vi.waitFor(() => expect(h.state().transitioning).toBe(true));
  const calls = h.storage.mock.calls.length;
  b.refresh = {
    id: uid(),
    workflowId: doc.workflows[0].id,
    inputs: {},
    seconds: 60,
    initial: true,
    enabled: false,
  };
  h.service.configure(doc);
  b.refresh.seconds = 300;
  b.refresh.enabled = true;
  h.service.configure(doc);
  expect(h.state()).toMatchObject({ confirmed: "off", transitioning: true });
  expect(h.storage.mock.calls).toHaveLength(calls);
  release();
  await press;
  expect(h.state()).toMatchObject({ confirmed: "on", transitioning: false });
  h.service.stop();
});
