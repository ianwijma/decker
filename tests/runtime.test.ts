import { describe, it, expect, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { Engine, type Handler } from "../src/runtime/engine";
import { Coordinator, ResourceLocks } from "../src/runtime/coordinator";
import { validateWorkflow } from "../src/runtime/validate";
import { resolve, redact } from "../src/runtime/data";
import { binding, node, uid } from "../src/shared/defaults";
import { makeAction } from "../src/shared/catalog";
import type {
  FlowNode,
  Graph,
  Json,
  RunRecord,
  WorkflowDefinition,
} from "../src/shared/schema";
const step = (id: string, config: Record<string, Json> = {}): FlowNode => ({
  ...node("action", id),
  id,
  action: { type: "desktop.copy", version: 1, config: { text: id, ...config } },
});
const graph = (nodes: FlowNode[], edges?: Graph["edges"]): Graph => ({
  nodes,
  entry: nodes[0].id,
  edges:
    edges ??
    nodes.slice(1).map((n, i) => ({
      id: uid(),
      source: nodes[i].id,
      target: n.id,
      port: "next",
    })),
});
const flow = (g: Graph, id = "test"): WorkflowDefinition => ({
  id,
  name: id,
  revision: 1,
  graph: g,
  inputs: [],
  outputs: [],
  timeoutMs: 2000,
  layout: {},
});
function setup(handler: Handler = async (a) => a.config) {
  const records: RunRecord[] = [];
  return { engine: new Engine(handler, (r) => records.push(r)), records };
}
async function run(nodes: FlowNode[], handler?: Handler) {
  const f = flow(graph(nodes)),
    { engine } = setup(handler);
  return engine.start(f, [f]).done;
}
describe("execution contract", () => {
  it("executes a sequence once and resolves earlier outputs", async () => {
    const calls: string[] = [];
    const record = await run(
      [step("a"), step("b", { text: { $ref: "outputs.a.value" } })],
      async (a) => {
        calls.push(String(a.config.text));
        return { value: "result" };
      },
    );
    expect(record.status).toBe("success");
    expect(calls).toEqual(["a", "result"]);
  });
  it("chooses exactly one branch and requires fallback for conditional outputs", async () => {
    const condition = {
        ...node("condition", "Choose"),
        id: "if",
        config: { left: 2, operator: "greater", right: 1 },
      },
      a = step("yes"),
      b = step("no"),
      f = flow(
        graph(
          [condition, a, b],
          [
            { id: "yes", source: "if", target: "yes", port: "true" },
            { id: "no", source: "if", target: "no", port: "false" },
          ],
        ),
      );
    const calls: string[] = [];
    const { engine } = setup(async (a) => {
      calls.push(String(a.config.text));
      return null;
    });
    expect((await engine.start(f, [f]).done).status).toBe("success");
    expect(calls).toEqual(["yes"]);
    f.graph.nodes.push(step("after", { text: { $ref: "outputs.yes" } }));
    f.graph.edges.push(
      { id: "a", source: "yes", target: "after", port: "next" },
      { id: "b", source: "no", target: "after", port: "next" },
    );
    expect(validateWorkflow(f, [f]).join()).toContain(
      "not available on every path",
    );
  });
  it("joins nested parallel groups with branch-local variables and skipped branches", async () => {
    const set = (name: string) => ({ ...node("set", name), config: { name } }),
      inner = {
        ...node("parallel", "Inner"),
        branches: [graph([set("inner-a")]), graph([set("inner-b")])],
      },
      outer = {
        ...node("parallel", "Outer"),
        branches: [
          graph([set("branch-a"), inner]),
          graph([
            {
              ...node("condition", "skip"),
              config: { left: false, operator: "truthy" },
            },
          ]),
        ],
      },
      r = await run([
        outer,
        {
          ...node("return", "result"),
          config: {
            vars: { $ref: "vars" },
            output: { $ref: `outputs.${outer.id}` },
          },
        },
      ]);
    expect(r.status).toBe("success");
    const result = r.nodes.at(-1)!.output as Record<string, Json>;
    expect(result.vars).toEqual({});
    expect(result.output).toMatchObject({
      "0": { status: "success" },
      "1": { status: "success", value: false },
    });
  });
  it("fails fast and cancels sibling work before completing", async () => {
    let cancelled = false;
    const p = {
        ...node("parallel", "fork"),
        branches: [graph([step("fail")]), graph([step("wait")])],
      },
      r = await run([p], async (a, c) => {
        if (a.config.text === "fail") {
          await sleep(10);
          throw new Error("failure");
        }
        try {
          await sleep(1000, undefined, { signal: c.signal });
          return null;
        } catch {
          cancelled = true;
          throw new Error("aborted");
        }
      });
    expect(r.status).toBe("failure");
    expect(cancelled).toBe(true);
  });
  it("collects parallel errors when configured", async () => {
    const p = {
        ...node("parallel", "fork"),
        config: { mode: "collect" },
        branches: [graph([step("fail")]), graph([step("ok")])],
      },
      r = await run([p], async (a) => {
        if (a.config.text === "fail") throw new Error("broken");
        return "ok";
      });
    expect(r.status).toBe("success");
    expect(r.nodes.find((n) => n.nodeId === p.id)!.output).toMatchObject({
      "0": { status: "failure" },
      "1": { status: "success", value: "ok" },
    });
  });
  it("bounds repeat and isolates sequential and concurrent iteration data", async () => {
    const loop = {
      ...node("foreach", "items"),
      config: { items: ["a", "b", "c"], maxIterations: 3, concurrency: 2 },
      body: graph([
        {
          ...node("return", "item"),
          config: { item: { $ref: "item" }, index: { $ref: "index" } },
        },
      ]),
    };
    const r = await run([loop]);
    expect(r.status).toBe("success");
    expect(r.nodes.find((n) => n.nodeId === loop.id)!.output).toEqual([
      { item: "a", index: 0 },
      { item: "b", index: 1 },
      { item: "c", index: 2 },
    ]);
    loop.config.maxIterations = 2;
    expect((await run([loop])).status).toBe("failure");
  });
  it("snapshots parent and subflow revisions and propagates failure", async () => {
    const child = flow(graph([step("child")]), "child"),
      call = {
        ...node("subflow", "Call"),
        config: { workflowId: "child", revision: 1, inputs: {} },
      },
      pause = { ...node("delay", "pause"), config: { ms: 20 } },
      parent = flow(graph([pause, call])),
      { engine } = setup(async (a) => a.config.text);
    const handle = engine.start(parent, [parent, child]);
    child.graph.nodes[0].action!.config.text = "edited";
    expect(
      (await handle.done).nodes.find((n) => n.name === "child")!.output,
    ).toBe("child");
    expect(
      validateWorkflow(
        {
          ...child,
          graph: graph([
            { ...call, config: { workflowId: "test", revision: 1 } },
          ]),
        },
        [parent, child],
      ).join(),
    ).toContain("Recursive");
  });
  it("routes explicit node errors to recovery with structured data", async () => {
    const a = step("bad"),
      b = {
        ...node("return", "recover"),
        config: { error: { $ref: "error.message" } },
      },
      f = flow(
        graph(
          [a, b],
          [{ id: "err", source: a.id, target: b.id, port: "error" }],
        ),
      ),
      { engine } = setup(async () => {
        throw new Error("expected");
      });
    const r = await engine.start(f, [f]).done;
    expect(r.status).toBe("success");
    expect(r.nodes.at(-1)!.output).toEqual({ error: "expected" });
  });
  it("cancels a running delay and stops future side effects", async () => {
    const call = vi.fn(async () => null),
      delay = { ...node("delay", "Wait"), config: { ms: 1000 } },
      f = flow(graph([delay, step("never")])),
      { engine } = setup(call),
      h = engine.start(f, [f]);
    await sleep(10);
    h.cancel();
    expect((await h.done).status).toBe("cancelled");
    expect(call).not.toHaveBeenCalled();
  });
  it("enforces run and node deadlines", async () => {
    const delay = {
        ...node("delay", "Wait"),
        timeoutMs: 20,
        config: { ms: 500 },
      },
      f = flow(graph([delay])),
      { engine } = setup();
    expect((await engine.start(f, [f]).done).status).toBe("failure");
    f.timeoutMs = 10;
    expect((await engine.start(f, [f]).done).error).toContain("timeout");
  });
  it("retries are bounded and require opt-in for unsafe actions", async () => {
    const a = step("retry");
    a.action = makeAction("keyboard.shortcut");
    a.retries = 1;
    const f = flow(graph([a]));
    expect(validateWorkflow(f, [f]).join()).toContain("explicit confirmation");
    a.retrySafe = true;
    let calls = 0;
    const { engine } = setup(async () => {
      if (!calls++) throw new Error("once");
      return "ok";
    });
    expect((await engine.start(f, [f]).done).status).toBe("success");
    expect(calls).toBe(2);
  });
  it("rejects unstructured cycles and missing output paths", () => {
    const a = step("a"),
      b = step("b"),
      f = flow(graph([a, b]));
    f.graph.edges.push({
      id: "cycle",
      source: b.id,
      target: a.id,
      port: "next",
    });
    expect(validateWorkflow(f, [f]).join()).toContain("back-edges");
    expect(() =>
      resolve(
        { $ref: "outputs.absent" },
        { inputs: {}, outputs: {}, vars: {} },
      ),
    ).toThrow("Missing data");
    expect(
      resolve(
        { $ref: "outputs.absent", fallback: "safe" },
        { inputs: {}, outputs: {}, vars: {} },
      ),
    ).toBe("safe");
  });
  it("bounds logs and redacts credentials and values", () => {
    expect(
      redact(
        {
          Authorization: "abc",
          nested: { token: "secret" },
          output: "a SECRET b",
        },
        ["SECRET"],
      ),
    ).toEqual({
      Authorization: "[redacted]",
      nested: { token: "[redacted]" },
      output: "a [redacted] b",
    });
    expect(String(redact("x".repeat(10000))).length).toBe(4096);
  });
});
describe("coordination", () => {
  it.each(["ignore", "queue", "restart", "concurrent"] as const)(
    "applies %s policy with bounded work",
    async (policy) => {
      let active = 0,
        max = 0,
        calls = 0;
      const { engine } = setup(async (_a, c) => {
          calls++;
          active++;
          max = Math.max(max, active);
          try {
            await sleep(25, undefined, { signal: c.signal });
            return null;
          } finally {
            active--;
          }
        }),
        coordinator = new Coordinator(engine),
        b = { ...binding("desktop.copy"), policy, limit: 2 },
        f = flow(graph([step("work")]));
      for (let i = 0; i < 5; i++) coordinator.trigger(b, f, [f]);
      await sleep(160);
      expect(calls).toBe(policy === "ignore" ? 1 : policy === "queue" ? 3 : 2);
      expect(max).toBe(policy === "concurrent" ? 2 : 1);
    },
  );
  it("serializes a resource across workflows and releases after failure", async () => {
    const locks = new ResourceLocks(),
      order: string[] = [];
    await Promise.allSettled([
      locks.run("keyboard", AbortSignal.timeout(1000), async () => {
        order.push("a");
        await sleep(10);
        order.push("b");
        throw new Error("expected");
      }),
      locks.run("keyboard", AbortSignal.timeout(1000), async () => {
        order.push("c");
      }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});

it("bounds cleanup when an adapter ignores cancellation", async () => {
  const f = flow(graph([step("uncooperative")]));
  f.timeoutMs = 10;
  const { engine } = setup(async () => new Promise(() => {}));
  const started = Date.now();
  expect((await engine.start(f, [f]).done).status).toBe("failure");
  expect(Date.now() - started).toBeLessThan(1000);
});
it("rejects invalid referenced subflow graphs before running any side effect", () => {
  const child = flow(
    graph([step("child", { text: { $ref: "outputs.missing" } })]),
    "child",
  );
  const parent = flow(
    graph([
      {
        ...node("subflow", "call"),
        config: { workflowId: "child", revision: 1 },
      },
    ]),
  );
  const { engine } = setup();
  expect(() => engine.start(parent, [parent, child])).toThrow("not available");
});
