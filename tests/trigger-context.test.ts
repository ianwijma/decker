import { describe, expect, it, vi } from "vitest";
import {
  Engine,
  type ActionContext,
  type Handler,
} from "../src/runtime/engine";
import { Coordinator } from "../src/runtime/coordinator";
import { Triggers } from "../src/device/triggers";
import { Toggles } from "../src/runtime/toggles";
import { defaults, binding, node, uid } from "../src/shared/defaults";
import { makeAction, catalogForPalette } from "../src/shared/catalog";
import {
  captureOrigin,
  type TrustedLaunch,
} from "../src/shared/trigger-context";
import { bindingChoices } from "../src/shared/data-presentation";
import { validateWorkflow } from "../src/runtime/validate";
import type {
  FlowNode,
  Graph,
  Json,
  WorkflowDefinition,
} from "../src/shared/schema";
const graph = (nodes: FlowNode[]): Graph => ({
  entry: nodes[0].id,
  nodes,
  edges: nodes.slice(1).map((n, i) => ({
    id: String(i),
    source: nodes[i].id,
    target: n.id,
    port: "next",
  })),
});
const flow = (nodes: FlowNode[], id = uid()): WorkflowDefinition => ({
  ...defaults().workflows[0],
  id,
  graph: graph(nodes),
  inputs: [],
  outputs: [],
  timeoutMs: 5000,
});
const action = (
  type = "deck.appearance",
  config: Record<string, Json> = { label: { $ref: "context.source.kind" } },
): FlowNode => ({
  ...node("action", type),
  action: { type, version: 1, config },
});
const launch = (): TrustedLaunch => {
  const d = defaults();
  return {
    source: {
      kind: "button",
      invocationId: uid(),
      origin: captureOrigin(d, d.decks[0].id, d.profiles[0].pages[0].keys[0])!,
    },
    authority: uid(),
  };
};

describe("immutable trigger context", () => {
  it("separates spoofed inputs/vars/config from trusted metadata and freezes handler metadata", async () => {
    const start = node("set", "Spoof");
    start.config = { context: { origin: { bindingId: "forged" } } };
    const check = action("desktop.copy", {
      text: {
        $template: [
          { $ref: "context.origin.bindingId", fallback: "unbound" },
          "|",
          { $ref: "inputs.context" },
          "|",
          { $ref: "vars.context" },
        ],
      },
    });
    const f = flow([start, check]),
      source = launch(),
      calls: ActionContext[] = [];
    const engine = new Engine(
      async (a, c) => {
        calls.push(c);
        expect(a.config.text).toContain(source.source.origin!.bindingId);
        expect(() => {
          c.execution!.origin!.bindingId = "changed";
        }).toThrow();
        return null;
      },
      () => {},
    );
    const h = engine.start(f, [f], { context: "caller" }, { launch: source });
    expect((await h.done).status).toBe("success");
    expect(calls[0].execution).toMatchObject({
      rootRunId: h.record.id,
      invocationId: source.source.invocationId,
      origin: source.source.origin,
    });
    expect(JSON.stringify(h.record)).not.toContain(source.authority);
    const choices = bindingChoices(f, [], check.id);
    expect(
      choices.find((c) => c.path.join(".") === "context.origin.bindingId"),
    ).toMatchObject({ group: "Trigger context", conditional: true });
    check.action!.config.text = { $ref: "context.authority" };
    expect(validateWorkflow(f, [f])).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown trigger context"),
      ]),
    );
    check.action!.config.text = { $ref: "context.origin.bindingId" };
    expect(validateWorkflow(f, [f])).toEqual(
      expect.arrayContaining([expect.stringContaining("fallback")]),
    );
  });
  it("preserves origin through subflow, workflow.run, loops and parallel while assigning child identities", async () => {
    const record = action(),
      child = flow([record]),
      call = action("workflow.run", { workflowId: child.id }),
      sub = node("subflow", "Child");
    sub.config = { workflowId: child.id, revision: child.revision, inputs: {} };
    const loop = node("foreach", "Loop");
    loop.config = { items: ["a", "b"], maxIterations: 2, concurrency: 2 };
    loop.body = graph([sub]);
    const parallel = node("parallel", "Branches");
    parallel.branches = [graph([call]), graph([loop])];
    const root = flow([parallel]),
      source = launch(),
      contexts: ActionContext[] = [];
    const h = new Engine(
      async (_, c) => {
        contexts.push(c);
        return null;
      },
      () => {},
    ).start(root, [root, child], {}, { launch: source });
    expect((await h.done).status).toBe("success");
    expect(contexts).toHaveLength(3);
    expect(
      new Set(contexts.map((c) => c.execution!.workflowInvocationId)).size,
    ).toBe(3);
    for (const c of contexts)
      expect(c.execution).toMatchObject({
        origin: source.source.origin,
        rootRunId: h.record.id,
        invocationId: source.source.invocationId,
        rootWorkflowId: root.id,
        workflowId: child.id,
      });
  });
  it.each(["manual", "scheduled", "test"] as const)(
    "keeps %s launches unbound even with an active deck",
    async (kind) => {
      const f = flow([action()]),
        contexts: ActionContext[] = [];
      const h = new Engine(
        async (_, c) => {
          contexts.push(c);
          return null;
        },
        () => {},
      ).start(
        f,
        [f],
        { context: { origin: { bindingId: "forged" } } },
        { deckId: "active", launch: { source: { kind, invocationId: uid() } } },
      );
      expect((await h.done).status).toBe("success");
      expect(contexts[0].execution!.origin).toBeNull();
      expect(contexts[0].authority).toBeUndefined();
    },
  );
  it("private probes have no origin/authority and publish no context or results", async () => {
    const source = launch(),
      f = flow([action()]),
      emit = vi.fn(),
      effects: ActionContext[] = [];
    const h = new Engine(async (_, c) => {
      effects.push(c);
      return true;
    }, emit).start(f, [f], {}, { launch: source }, {}, { privateResult: true });
    await h.done;
    expect(emit).not.toHaveBeenCalled();
    expect(effects[0].execution).toMatchObject({
      source: { kind: "probe" },
      origin: null,
    });
    expect(effects[0].authority).toBeUndefined();
    expect(
      catalogForPalette("workflow").find((a) => a.id === "deck.appearance")!
        .name,
    ).toBe("Update triggering button");
    expect(
      catalogForPalette("button").some((a) => a.id === "deck.appearance"),
    ).toBe(false);
    expect(makeAction("deck.appearance").config).toEqual({ label: "Ready" });
  });
  it("toggle on/off targets retain origin while their automatic private probe cannot write", async () => {
    const d = defaults(),
      b = d.profiles[0].pages[0].keys[0];
    delete b.press;
    b.toggle = {
      on: { kind: "action", action: makeAction("deck.appearance") },
      off: { kind: "action", action: makeAction("deck.appearance") },
      source: { kind: "app", initial: "off" },
    };
    const effects: ActionContext[] = [],
      engine = new Engine(
        async (_, c) => {
          effects.push(c);
          return null;
        },
        () => {},
      ),
      toggles = new Toggles(
        engine,
        async () => null,
        () => {},
      );
    toggles.configure(d);
    await toggles.settled();
    const source = {
      ...launch(),
      source: {
        ...launch().source,
        origin: captureOrigin(d, d.decks[0].id, b),
      },
    };
    expect(await toggles.press(d.decks[0].id, b, source)).toBe(true);
    expect(effects[0].execution!.origin).toEqual(source.source.origin);
    expect(toggles.snapshot()[0].confirmed).toBe("on");
    toggles.stop();
  });
  it.each(["ignore", "queue", "restart", "concurrent"] as const)(
    "captures distinct %s invocation identities and lifecycle ordering",
    async (policy) => {
      const b = binding("deck.appearance");
      b.policy = policy;
      const f = flow([action()]),
        contexts: ActionContext[] = [],
        releases: Array<() => void> = [],
        events: string[] = [];
      const handler: Handler = async (_, c) => {
        contexts.push(c);
        events.push("action");
        await new Promise<void>((r) => {
          releases.push(r);
          c.signal.addEventListener("abort", () => r(), { once: true });
        });
        return null;
      };
      const engine = new Engine(
          handler,
          () => {},
          () => [],
          () => ({}),
          (e) => events.push(e.type),
        ),
        coordinator = new Coordinator(engine),
        a = launch(),
        second = launch();
      coordinator.trigger(b, f, [f], "deck", "press", a);
      coordinator.trigger(b, f, [f], "deck", "press", second);
      await vi.waitFor(() =>
        expect(contexts).toHaveLength(
          policy === "concurrent" || policy === "restart" ? 2 : 1,
        ),
      );
      for (const release of releases) release();
      if (policy === "queue") {
        await vi.waitFor(() => expect(contexts).toHaveLength(2));
        releases.at(-1)!();
      }
      await vi.waitFor(() => expect(engine.activeCount).toBe(0));
      expect(contexts[0].execution!.invocationId).toBe(a.source.invocationId);
      if (policy !== "ignore")
        expect(contexts[1].execution!.invocationId).toBe(
          second.source.invocationId,
        );
      expect(events[0]).toBe("begin");
      expect(events.at(-1)).toBe("end");
    },
  );
  it("drops a queued binding invalidated before launch and captures origin before delayed phases", async () => {
    const b = binding("deck.appearance"),
      f = flow([action()]);
    b.policy = "queue";
    let valid = true,
      release!: () => void;
    const handler = vi.fn(async () => {
      await new Promise<void>((r) => (release = r));
      return null;
    });
    const engine = new Engine(
        handler,
        () => {},
        () => [],
        () => ({}),
        () => {},
        () => valid,
      ),
      coordinator = new Coordinator(engine);
    coordinator.trigger(b, f, [f], "deck", "press", launch());
    coordinator.trigger(b, f, [f], "deck", "press", launch());
    valid = false;
    release();
    await vi.waitFor(() => expect(engine.activeCount).toBe(0));
    expect(handler).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      const source = launch().source.origin!,
        fire = vi.fn(),
        t = new Triggers(fire, () => structuredClone(source));
      b.longPress = b.press;
      b.release = b.press;
      t.down("device", 0, b, "deck");
      source.pageId = "navigated";
      vi.advanceTimersByTime(700);
      t.up("device", 0);
      expect(fire.mock.calls.map((c) => c[4].pageId)).toEqual(["home", "home"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
