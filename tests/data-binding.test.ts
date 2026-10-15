import { describe, expect, it } from "vitest";
import { defaults, node } from "../src/shared/defaults";
import { catalog, makeAction } from "../src/shared/catalog";
import { outputAvailability } from "../src/shared/data-availability";
import {
  acceptsType,
  bindingChoices,
  destinationType,
  nodeOutput,
  referenceBaseChoice,
} from "../src/shared/data-presentation";
import {
  lastNodePreview,
  matchesGraphPath,
  previewText,
  samplePaths,
  previewLocation,
} from "../src/shared/data-preview";
import { nodeAuditHints } from "../src/shared/node-audit";
import { escapeLiteral } from "../src/renderer/src/ExpressionEditor";
import { replaceConfigField } from "../src/renderer/src/ControlDataHelper";
import { resolve } from "../src/runtime/data";
import { validateWorkflow } from "../src/runtime/validate";
import type {
  FlowNode,
  Json,
  NodeExecutionRecord,
  RunRecord,
} from "../src/shared/schema";
function flow(nodes: FlowNode[]) {
  const f = defaults().workflows[0];
  f.graph = {
    entry: nodes[0].id,
    nodes,
    edges: nodes.slice(1).map((n, i) => ({
      id: String(i),
      source: nodes[i].id,
      target: n.id,
      port: "next",
    })),
  };
  f.inputs = ["a.b", ""];
  return f;
}
function http(id = "http.with.dots") {
  return { ...node("action", "Fetch"), id, action: makeAction("http.request") };
}
describe("scope and presentation contract", () => {
  it("shares validator dominators, typed fields and safe identity independent of names", () => {
    const a = http(),
      b = http("another"),
      c = node("set", "Consumer"),
      f = flow([a, b, c]);
    const available = outputAvailability(f.graph).get(c.id)!;
    expect([...available]).toEqual(expect.arrayContaining([a.id, b.id]));
    const choices = bindingChoices(f, [], c.id);
    expect(
      choices.find((x) => x.name === "Fetch (choice 1) / body"),
    ).toMatchObject({
      path: ["outputs", a.id, "body"],
      type: "text",
      conditional: false,
    });
    expect(
      choices.find((x) => x.group === "Inputs" && x.name === "a.b")?.path,
    ).toEqual(["inputs", "a.b"]);
    const paths = choices.map((x) => x.path);
    expect(
      referenceBaseChoice(choices, {
        $ref: ["outputs", a.id, "body", "example"],
      })?.path,
    ).toEqual(["outputs", a.id, "body"]);
    a.name = "Renamed";
    expect(bindingChoices(f, [], c.id).map((x) => x.path)).toEqual(paths);
    f.graph.nodes = f.graph.nodes.filter((x) => x.id !== a.id);
    expect(bindingChoices(f, [], c.id).some((x) => x.path[1] === a.id)).toBe(
      false,
    );
  });
  it("offers only reachable ancestors, marks conditional/error shapes and agrees with validation fallback", () => {
    const start = node("condition", "Choose"),
      a = http(),
      b = node("set", "Else"),
      join = node("set", "Join"),
      downstream = http("later"),
      unreachable = http("orphan");
    start.config = { left: true, right: true };
    const f = flow([start, a, b, join, downstream, unreachable]);
    f.graph.edges = [
      { id: "a", source: start.id, target: a.id, port: "true" },
      { id: "b", source: start.id, target: b.id, port: "false" },
      { id: "c", source: a.id, target: join.id, port: "next" },
      { id: "d", source: b.id, target: join.id, port: "next" },
      { id: "e", source: join.id, target: downstream.id, port: "next" },
    ];
    const choices = bindingChoices(f, [], join.id);
    expect(choices.find((x) => x.path[1] === a.id)?.conditional).toBe(true);
    expect(
      choices.some((x) =>
        [downstream.id, unreachable.id].includes(String(x.path[1])),
      ),
    ).toBe(false);
    expect(bindingChoices(f, [], b.id).some((x) => x.path[1] === a.id)).toBe(
      false,
    );
    join.config = { value: { $ref: ["outputs", a.id, "body"] } };
    expect(validateWorkflow(f, [f]).some((x) => x.includes("fallback"))).toBe(
      true,
    );
    join.config.value = { $ref: ["outputs", a.id, "body"], fallback: "" };
    expect(validateWorkflow(f, [f]).some((x) => x.includes("fallback"))).toBe(
      false,
    );
    const recovery = flow([a, join]);
    recovery.graph.edges.push({
      id: "error",
      source: a.id,
      target: join.id,
      port: "error",
    });
    expect(
      bindingChoices(recovery, [], join.id).find(
        (x) => x.path.length === 2 && x.path[1] === a.id,
      ),
    ).toMatchObject({ conditional: false, type: "JSON" });
    expect(
      bindingChoices(recovery, [], join.id).find((x) => x.path[2] === "body"),
    ).toMatchObject({ conditional: true });
  });
  it("inherits outer data in nested bodies/branches without leaking item or sibling data", () => {
    const a = http(),
      set = node("set", "Name values"),
      loop = node("foreach", "Loop"),
      inner = node("set", "Inner"),
      parallel = node("parallel", "Branches"),
      left = http("left"),
      right = node("set", "Right");
    set.config = { zero: 0, no: false, nil: null };
    loop.config = { items: [], maxIterations: 10 };
    loop.body = { entry: inner.id, nodes: [inner], edges: [] };
    parallel.branches = [left, right].map((n) => ({
      entry: n.id,
      nodes: [n],
      edges: [],
    }));
    const f = flow([a, set, loop, parallel]);
    const nested = bindingChoices(f, [{ nodeId: loop.id }], inner.id);
    expect(nested.find((x) => x.path[0] === "index")).toMatchObject({
      type: "number",
      conditional: false,
    });
    expect(
      nested.find((x) => x.path[0] === "vars" && x.path[1] === "zero"),
    ).toMatchObject({ type: "number", conditional: false });
    expect(nested.some((x) => x.path[1] === a.id)).toBe(true);
    const branch = bindingChoices(
      f,
      [{ nodeId: parallel.id, branch: 1 }],
      right.id,
    );
    expect(
      branch.some((x) => x.path[1] === left.id || x.path[0] === "item"),
    ).toBe(false);
    expect(
      bindingChoices(f, [], parallel.id).some((x) => x.path[0] === "item"),
    ).toBe(false);
  });
  it("checks every action field/output fit without inventing dynamic shapes", () => {
    const f = defaults().workflows[0];
    for (const def of catalog) {
      for (const field of def.fields)
        expect(destinationType(def.id, field)).toBeTruthy();
      const output = nodeOutput(
        { ...node("action", def.name), action: makeAction(def.id) },
        f,
      );
      if (def.id === "data.parseJson" || def.id === "data.extract")
        expect(output.fields).toEqual({ value: "JSON" });
      if (output.type === "object" || output.type === "HTTP result") {
        const sample = Object.fromEntries(
          Object.entries(output.fields).map(([key, type]) => [
            key,
            key === "operation" && def.id.startsWith("file.")
              ? def.id === "file.appendText"
                ? "append"
                : "overwrite"
              : type === "number"
                ? 0
                : type === "boolean"
                  ? false
                  : type === "text"
                    ? ""
                    : null,
          ]),
        );
        expect(def.outputSchema.safeParse(sample).success).toBe(true);
      }
    }
    expect(acceptsType("text", "object")).toBe(false);
    expect(acceptsType("text[]", "array")).toBe(true);
    expect(acceptsType("JSON", "null")).toBe(true);
    expect(Object.keys(nodeAuditHints)).toHaveLength(11);
  });
  it.each([0, false, null, ["native"], { "a.b": 0 }])(
    "preserves native literal/reference types %j",
    (value) => {
      const scope = { inputs: { value }, outputs: {}, vars: {} };
      expect(resolve(escapeLiteral(value), scope)).toEqual(value);
      expect(
        resolve({ $ref: ["inputs", "value"], fallback: "wrong" }, scope),
      ).toEqual(value);
    },
  );
  it("escapes reserved literals and edits only the selected control field", () => {
    const literal = { $ref: "literal", fallback: false };
    expect(escapeLiteral(literal)).toEqual({ $literal: literal });
    expect(
      resolve(escapeLiteral(literal), { inputs: {}, outputs: {}, vars: {} }),
    ).toEqual(literal);
    const config = {
      cases: ["a", "b"],
      value: "a",
      inputs: { "a.b": false },
      items: [null],
    };
    const ref: Json = { $ref: ["inputs", "a.b"] };
    expect(replaceConfigField(config, ["inputs", "a.b"], ref)).toEqual({
      ...config,
      inputs: { "a.b": ref },
    });
    expect(replaceConfigField(config, ["items", 0], ref).items).toEqual([ref]);
    expect(() =>
      replaceConfigField(config, ["inputs", "__proto__"], ref),
    ).toThrow("Unsafe");
    expect(() => replaceConfigField(config, ["missing", "field"], ref)).toThrow(
      "existing",
    );
    expect(config.inputs["a.b"]).toBe(false);
  });
  it("presents pinned subflow declarations and never guesses unknown dynamic fields", () => {
    const child = flow([node("return", "Return")]);
    child.id = "child";
    child.outputs = ["a.b", "result"];
    const call = node("subflow", "Child");
    call.config = {
      workflowId: "legacy-child",
      revision: child.revision,
      inputs: {},
    };
    const consumer = node("return", "Consumer"),
      parent = flow([call, consumer]);
    const choices = bindingChoices(parent, [], consumer.id, [child], {
      "legacy-child": "child",
    });
    expect(choices.find((x) => x.path[2] === "a.b")).toMatchObject({
      type: "JSON",
      conditional: false,
    });
    call.config.revision = child.revision + 1;
    expect(
      bindingChoices(parent, [], consumer.id, [child], {
        "legacy-child": "child",
      }).some((x) => x.path[0] === "outputs" && x.path.length > 2),
    ).toBe(false);
    expect(acceptsType("text or HTTP result", "number")).toBe(false);
    expect(acceptsType("text or HTTP result", "HTTP result")).toBe(true);
    expect(acceptsType("JSON path", "boolean")).toBe(false);
  });
});
describe("bounded sanitized historical preview", () => {
  const record = (path: string, attempt = 0): NodeExecutionRecord => ({
    id: path + attempt,
    nodeId: "same",
    name: "Node",
    path,
    attempt,
    startedAt: 1,
    status: "success",
    output: { value: 0 },
  });
  it("matches workflow, full nested graph paths, repeats and attempts; flags stale revision", () => {
    const f = flow([node("set", "Test")]);
    f.id = "flow";
    const run: RunRecord = {
      id: "r",
      workflowId: f.id,
      workflowName: f.name,
      revision: f.revision - 1,
      startedAt: 2,
      status: "success",
      nodes: [
        record("flow"),
        record("flow/loop/iteration:0"),
        record("flow/loop/iteration:1", 1),
        record("flow/other/iteration:0"),
        record("flow/loop/iteration:1/sibling/branch:0"),
      ],
    };
    const preview = lastNodePreview(
      [{ ...run, workflowId: "other", startedAt: 9 }, run],
      f,
      [{ nodeId: "loop" }],
      "same",
    );
    expect(preview.stale).toBe(true);
    const loop = node("repeat", "Rows");
    loop.id = "loop";
    f.graph.nodes.push(loop);
    expect(
      previewLocation(f, [{ nodeId: "loop" }], "flow/loop/iteration:1"),
    ).toBe("Rows / iteration 2");
    expect(preview.records.map((x) => x.attempt)).toEqual([0, 1]);
    expect(
      matchesGraphPath("flow/loop/iteration:00", "flow", [{ nodeId: "loop" }]),
    ).toBe(false);
    expect(
      matchesGraphPath("flow/loop/iteration:12/nest/branch:1", "flow", [
        { nodeId: "loop" },
        { nodeId: "nest", branch: 1 },
      ]),
    ).toBe(true);
    expect(
      lastNodePreview([{ ...run, status: "running" }], f, [], "same").run,
    ).toBeUndefined();
    expect(
      lastNodePreview(
        [{ ...run, workflowId: "legacy", nodes: [record("legacy")] }],
        f,
        [],
        "same",
        { legacy: "flow" },
      ).records,
    ).toHaveLength(1);
  });
  it("bounds width, depth, string size and expansion without invoking getters or leaking secrets", () => {
    const data: Record<string, unknown> = {
      token: "secret-value",
      html: "<img onerror='execute()'>",
      long: "x".repeat(20000),
      tree: Array.from({ length: 200 }, () =>
        Array.from({ length: 100 }, () => ({ nested: "y".repeat(5000) })),
      ),
    };
    Object.defineProperty(data, "getter", {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    const p = previewText(data);
    expect(p.text.length).toBeLessThanOrEqual(8000);
    expect(p.limited).toBe(true);
    expect(p.redacted).toBe(true);
    expect(p.text).not.toContain("secret-value");
    expect(p.text).toContain("<img"); // JSX renders this text, never HTML.
    expect(previewText(undefined).text).toContain("missing");
    expect(previewText({ truncated: true }).limited).toBe(true);
    expect(
      samplePaths({
        ...record("flow"),
        output: { value: { "a.b": [null, false, 0], token: "[redacted]" } },
      }),
    ).toContainEqual(["value", "a.b", 0]);
    expect(
      samplePaths({ ...record("flow"), output: { token: "secret" } }),
    ).toEqual([]);
  });
});
