import { describe, it, expect, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { Engine, type Handler, type RunHandle } from "../src/runtime/engine";
import { Coordinator, ResourceLocks } from "../src/runtime/coordinator";
import { binding, node, uid } from "../src/shared/defaults";
import type {
  FlowNode,
  Graph,
  Json,
  RunRecord,
  WorkflowDefinition,
} from "../src/shared/schema";

const graph = (...nodes: FlowNode[]): Graph => ({
  entry: nodes[0].id,
  nodes,
  edges: nodes.slice(1).map((n, i) => ({
    id: uid(),
    source: nodes[i].id,
    target: n.id,
    port: "next",
  })),
});
const flow = (id: string, ...nodes: FlowNode[]): WorkflowDefinition => ({
  id,
  name: id,
  revision: 1,
  graph: graph(...nodes),
  inputs: [],
  outputs: [],
  timeoutMs: 60000,
  layout: {},
});
const delay = (ms: Json = 30000) => ({
  ...node("delay", "Waiting"),
  config: { ms },
  timeoutMs: 60000,
});
const action = (type: string, config: Record<string, Json>): FlowNode => ({
  ...node("action", type),
  action: { type, version: 1, config },
});
const effect = () => action("desktop.copy", { text: "later effect" });
const call = (id: Json, pinned = false): FlowNode =>
  pinned
    ? {
        ...node("subflow", "Pinned child"),
        config: { workflowId: id, revision: 1 },
      }
    : action("workflow.run", { workflowId: id });
function harness(aliases: Record<string, string> = {}, custom?: Handler) {
  const records = new Map<string, RunRecord>(),
    effects = vi.fn();
  const engine = new Engine(
    async (a, c) => {
      if (a.type === "workflow.cancel") {
        coordinator.cancelWorkflow(String(a.config.workflowId));
        return null;
      }
      effects(a);
      return custom ? custom(a, c) : null;
    },
    (r) => records.set(r.id, r),
    () => [],
    () => aliases,
  );
  const coordinator = new Coordinator(engine);
  return { engine, coordinator, records, effects };
}
async function cancelled(handle: RunHandle) {
  expect((await handle.done).status).toBe("cancelled");
}

describe("live invocation cancellation", () => {
  it.each(["assignment", "action", "sequence", "nested", "pinned"])(
    "cancels %s roots and prevents later actions",
    async (kind) => {
      const child = flow(uid(), delay(), effect()),
        nested = flow(uid(), call(child.id)),
        root =
          kind === "assignment"
            ? child
            : flow(
                "direct",
                ...(kind === "sequence" ? [effect()] : []),
                call(
                  kind === "nested" ? nested.id : child.id,
                  kind === "pinned",
                ),
                effect(),
              ),
        { engine, coordinator, effects } = harness(),
        handle = engine.start(root, [root, child, nested]);
      await vi.waitFor(() =>
        expect(handle.containsWorkflow(child.id)).toBe(true),
      );
      const completedEffects = effects.mock.calls.length;
      coordinator.cancelWorkflow(child.id);
      await cancelled(handle);
      expect(effects).toHaveBeenCalledTimes(completedEffects);
      expect(handle.containsWorkflow(child.id)).toBe(false);
      expect(handle.containsWorkflow(root.id)).toBe(false);
    },
  );

  it("uses the invocation's alias and definition snapshot for dynamic legacy references", async () => {
    const child = flow(uid(), delay()),
      aliases = { legacy: child.id },
      root = flow(
        uid(),
        { ...node("set", "Select"), config: { child: "legacy" } },
        call({ $ref: "vars.child" }),
      ),
      { engine } = harness(aliases),
      handle = engine.start(root, [root, child]);
    aliases.legacy = uid();
    child.id = uid();
    expect(handle.containsWorkflow("legacy")).toBe(true);
    engine.cancelWorkflow("legacy");
    await cancelled(handle);
  });

  it("keeps duplicate parallel invocations active after the shorter call completes", async () => {
    const child = flow(uid(), delay({ $ref: "inputs.ms" })),
      invoke = (ms: number) => ({
        ...call(child.id, true),
        config: { workflowId: child.id, revision: 1, inputs: { ms } },
      }),
      root = flow(
        uid(),
        {
          ...node("parallel", "Fork"),
          branches: [graph(invoke(1)), graph(invoke(30000))],
        },
        effect(),
      ),
      { engine, effects, records } = harness(),
      h = engine.start(root, [root, child]);
    await vi.waitFor(() =>
      expect(
        records
          .get(h.record.id)!
          .nodes.some(
            (n) => n.name === "Pinned child" && n.status === "success",
          ),
      ).toBe(true),
    );
    expect(h.containsWorkflow(child.id)).toBe(true);
    engine.cancelWorkflow(child.id);
    await cancelled(h);
    expect(effects).not.toHaveBeenCalled();
  });

  it("does not cancel an owner for a completed historical child, but keeps its root live", async () => {
    const child = flow(uid(), {
        ...node("set", "Child done"),
        config: { done: true },
      }),
      root = flow(uid(), call(child.id), delay(), effect()),
      { engine, records, effects } = harness(),
      h = engine.start(root, [root, child]);
    await vi.waitFor(() =>
      expect(
        records.get(h.record.id)!.nodes.some((n) => n.name === "Waiting"),
      ).toBe(true),
    );
    expect(h.containsWorkflow(child.id)).toBe(false);
    engine.cancelWorkflow(child.id);
    expect(h.record.status).toBe("running");
    engine.cancelWorkflow(root.id);
    await cancelled(h);
    expect(effects).not.toHaveBeenCalled();
  });

  it("self-cancels synchronously in a standalone root and nested direct parent without deadlock", async () => {
    for (const nested of [false, true]) {
      const child = flow(uid(), effect());
      child.graph = graph(
        action("workflow.cancel", { workflowId: child.id }),
        effect(),
      );
      const root = nested ? flow("direct", call(child.id), effect()) : child,
        { engine, effects } = harness(),
        h = engine.start(root, [root, child]);
      await cancelled(h);
      expect(effects).not.toHaveBeenCalled();
    }
  });

  it("never retries or takes error edges after cancellation", async () => {
    const failing = { ...effect(), retries: 2, retrySafe: true },
      recovery = effect(),
      root = flow(uid(), failing, recovery);
    root.graph.edges[0].port = "error";
    const { engine, effects } = harness({}, async (_a, c) => {
        await sleep(30000, undefined, { signal: c.signal });
        return null;
      }),
      h = engine.start(root, [root]);
    engine.cancelWorkflow(root.id);
    await cancelled(h);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(h.record.nodes).toHaveLength(1);
  });
});

describe("queue and policy cancellation", () => {
  it.each(["ignore", "queue", "restart", "concurrent"] as const)(
    "cancels matching active and queued work under %s",
    async (policy) => {
      const { coordinator, records, effects } = harness(),
        b = { ...binding("desktop.copy"), policy, limit: 3 },
        child = flow(uid(), delay(), effect()),
        root = flow("direct", call(child.id), effect());
      for (let i = 0; i < 3; i++)
        coordinator.trigger(b, root, [root, child], "deck");
      coordinator.cancelWorkflow(child.id);
      await vi.waitFor(() =>
        expect(
          [...records.values()].every((r) => r.status === "cancelled"),
        ).toBe(true),
      );
      expect(records.size).toBe(policy === "concurrent" ? 3 : 1);
      expect(effects).not.toHaveBeenCalled();
    },
  );

  it("removes matching queued starts while preserving unrelated work on the same phase", async () => {
    const { coordinator, records, effects } = harness(),
      b = { ...binding("desktop.copy"), policy: "queue" as const, limit: 4 },
      first = flow(uid(), delay()),
      child = flow(uid(), effect()),
      queued = flow("direct", call(child.id)),
      other = flow(uid(), effect());
    coordinator.trigger(b, first, [first], "deck");
    coordinator.trigger(b, queued, [queued, child], "deck");
    coordinator.trigger(b, other, [other], "deck");
    coordinator.cancelWorkflow(child.id);
    expect(effects).not.toHaveBeenCalled();
    coordinator.cancelWorkflow(first.id);
    await vi.waitFor(() =>
      expect(
        [...records.values()].some(
          (r) => r.workflowId === other.id && r.status === "success",
        ),
      ).toBe(true),
    );
    expect(records.size).toBe(2);
    expect(effects).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued restart replacement while its predecessor cleans up", async () => {
    const { coordinator, records, effects } = harness({}, async () => {
        await sleep(30);
        return null;
      }),
      b = { ...binding("desktop.copy"), policy: "restart" as const },
      old = flow(uid(), effect()),
      replacement = flow(uid(), effect());
    coordinator.trigger(b, old, [old], "deck");
    coordinator.trigger(b, replacement, [replacement], "deck");
    coordinator.cancelWorkflow(replacement.id);
    await vi.waitFor(() =>
      expect([...records.values()].every((r) => r.status === "cancelled")).toBe(
        true,
      ),
    );
    expect(records.size).toBe(1);
    expect(effects).toHaveBeenCalledTimes(1);
  });

  it("keeps run-ID cancellation explicit, unmatched workflows inert and queues intact", async () => {
    const { engine, coordinator, records } = harness(),
      b = { ...binding("desktop.copy"), policy: "queue" as const },
      f = flow(uid(), delay());
    coordinator.trigger(b, f, [f], "deck");
    coordinator.trigger(b, f, [f], "deck");
    const first = [...records.values()][0];
    coordinator.cancelWorkflow(uid());
    coordinator.cancel(f.id); // workflow IDs are not run IDs
    expect(first.status).toBe("running");
    coordinator.cancel(first.id);
    await vi.waitFor(() => expect(records.size).toBe(2));
    expect([...records.values()][1].status).toBe("running");
    engine.cancelWorkflow(f.id);
    await vi.waitFor(() =>
      expect([...records.values()].every((r) => r.status === "cancelled")).toBe(
        true,
      ),
    );
  });

  it("isolates policies across decks and generations, and stop discards all queued starts", async () => {
    const { coordinator, records } = harness(),
      b = { ...binding("desktop.copy"), policy: "queue" as const },
      f = flow(uid(), delay());
    coordinator.trigger(b, f, [f], "one");
    coordinator.trigger(b, f, [f], "one");
    coordinator.trigger(b, f, [f], "two");
    coordinator.trigger({ ...b, generation: 1 }, f, [f], "one");
    expect(records.size).toBe(3);
    coordinator.stop();
    await vi.waitFor(() =>
      expect([...records.values()].every((r) => r.status === "cancelled")).toBe(
        true,
      ),
    );
    expect(records.size).toBe(3);
    coordinator.trigger(b, f, [f], "one");
    expect(records.size).toBe(4);
    coordinator.cancelWorkflow(f.id);
    await vi.waitFor(() =>
      expect([...records.values()].every((r) => r.status === "cancelled")).toBe(
        true,
      ),
    );
  });
});

it("aborts lock waits promptly without releasing or overtaking the current owner", async () => {
  const locks = new ResourceLocks(),
    controller = new AbortController(),
    calls: string[] = [];
  let release!: () => void;
  const owner = locks.run(
    "resource",
    new AbortController().signal,
    async () => {
      calls.push("owner");
      await new Promise<void>((r) => {
        release = r;
      });
    },
  );
  await vi.waitFor(() => expect(calls).toEqual(["owner"]));
  const waiting = locks.run("resource", controller.signal, async () => {
    calls.push("cancelled");
  });
  controller.abort(new Error("cancelled"));
  await expect(waiting).rejects.toThrow("cancelled");
  const last = locks.run("resource", new AbortController().signal, async () => {
    calls.push("last");
  });
  await sleep(5);
  expect(calls).toEqual(["owner"]);
  release();
  await Promise.all([owner, last]);
  expect(calls).toEqual(["owner", "last"]);
});

it("cancels every owning root across standalone and independent button executions", async () => {
  const { engine, coordinator, records } = harness(),
    child = flow(uid(), delay()),
    root = flow("direct", call(child.id)),
    b = binding("desktop.copy");
  const standalone = engine.start(root, [root, child]);
  coordinator.trigger(b, root, [root, child], "one");
  coordinator.trigger(b, root, [root, child], "two");
  coordinator.cancelWorkflow(child.id);
  await cancelled(standalone);
  await vi.waitFor(() =>
    expect([...records.values()].map((r) => r.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]),
  );
});

it("snapshots queued aliases and never confuses a synthetic parent with a legacy direct alias", async () => {
  const selected = flow(uid(), effect()),
    aliases = { legacy: selected.id, direct: selected.id },
    { engine, coordinator, records, effects } = harness(aliases),
    b = { ...binding("desktop.copy"), policy: "queue" as const },
    root = flow("direct", delay()),
    queued = flow("direct", call("legacy"));
  coordinator.trigger(b, root, [root, selected], "deck");
  coordinator.trigger(b, queued, [queued, selected], "deck");
  aliases.legacy = uid();
  coordinator.cancelWorkflow("legacy");
  expect([...records.values()][0].status).toBe("running");
  engine.cancelWorkflow(selected.id);
  expect([...records.values()][0].status).toBe("running");
  coordinator.cancel([...records.keys()][0]);
  await vi.waitFor(() =>
    expect([...records.values()][0].status).toBe("cancelled"),
  );
  expect(records.size).toBe(1);
  expect(effects).not.toHaveBeenCalled();
});
