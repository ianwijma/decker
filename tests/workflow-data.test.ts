import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, readPath, type Scope } from "../src/runtime/data";
import {
  boundedJson,
  decodeArgs,
  inspectExpressions,
  parsePath,
} from "../src/shared/data-contract";
import { extractValue, parseJson } from "../src/shared/data-actions";
import { readHttpBody, HTTP_BODY_LIMIT } from "../src/actions/http-body";
import { handlers } from "../src/actions/handlers";
import { ObsConnections } from "../src/integrations/obs";
import { defaults, node } from "../src/shared/defaults";
import { actionById, makeAction } from "../src/shared/catalog";
import { Engine, type Handler } from "../src/runtime/engine";
import { validateWorkflow } from "../src/runtime/validate";
import { Persistence } from "../src/main/persistence";
import type { FlowNode, Json, WorkflowDefinition } from "../src/shared/schema";
const scope: Scope = {
  inputs: {
    nested: [{ "a.b": { "": 0, slash: "\\" } }],
    zero: 0,
    no: false,
    empty: "",
    nil: null,
    object: { a: 1 },
  },
  outputs: {},
  vars: {},
};
const context = () => ({
  signal: AbortSignal.timeout(2000),
  runId: "data",
  workflowId: "data",
});
function flow(nodes: FlowNode[]): WorkflowDefinition {
  return {
    ...defaults().workflows[0],
    name: "Data",
    graph: {
      entry: nodes[0].id,
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: `e${i}`,
        source: nodes[i].id,
        target: n.id,
        port: "next",
      })),
    },
  };
}
function action(
  id: string,
  type: string,
  config: Record<string, Json>,
): FlowNode {
  return {
    ...node("action", id),
    id,
    action: {
      ...makeAction(type),
      config: { ...makeAction(type).config, ...config },
    },
  };
}
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
async function serve(fn: RequestListener) {
  const server = createServer(fn);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function handler(main: Handler = async () => null) {
  return handlers(
    defaults,
    () => ({ test: "private-bearer" }),
    (type, config, c) => main({ type, version: 1, config }, c),
    new ObsConnections(() => {}),
  );
}
describe("bounded JSON expressions", () => {
  it.each([0, false, "", null, [1, false], { a: 1 }])(
    "keeps native value %j and uses fallback only for absence",
    (value) => {
      const s = { ...scope, vars: { value } };
      expect(resolve({ $ref: "vars.value", fallback: "wrong" }, s)).toEqual(
        value,
      );
      expect(
        resolve({ $ref: "vars.absent", fallback: { $ref: "vars.value" } }, s),
      ).toEqual(value);
    },
  );
  it("shares legacy dot paths and literal segment arrays including dots, empty and backslash keys", () => {
    expect(readPath(scope, "inputs.nested.0.a.b")).toBeUndefined();
    expect(resolve({ $ref: ["inputs", "nested", 0, "a.b", ""] }, scope)).toBe(
      0,
    );
    expect(readPath({ "a\\b": 1 }, ["a\\b"])).toBe(1);
    expect(readPath(scope, "inputs.zero")).toBe(0);
    expect(parsePath("a..b")).toEqual(["a", "", "b"]);
  });
  it("defines text conversion, literal strings and literal expression-shaped JSON", () => {
    expect(
      resolve(
        {
          $template: [
            "Subscribers: ",
            { $ref: "inputs.zero" },
            "/",
            { $ref: "inputs.no" },
            "/",
            { $ref: "inputs.nil" },
            "/",
            { $ref: "inputs.object" },
          ],
        },
        scope,
      ),
    ).toBe('Subscribers: 0/false/null/{"a":1}');
    expect(resolve("${inputs.zero} {{code}} $(touch nope)", scope)).toBe(
      "${inputs.zero} {{code}} $(touch nope)",
    );
    expect(
      resolve(
        { $literal: { $ref: "outputs.unavailable", $template: ["literal"] } },
        scope,
      ),
    ).toEqual({ $ref: "outputs.unavailable", $template: ["literal"] });
    expect(resolve({ $template: [] }, scope)).toBe("");
    for (const [transform, expected] of [
      ["string", "0"],
      ["number", 0],
      ["uppercase", "0"],
      ["lowercase", "0"],
      ["length", 0],
    ] as const)
      expect(resolve({ $ref: "inputs.zero", transform }, scope)).toBe(expected);
  });
  it.each([
    { $ref: 2 },
    { $ref: [] },
    { $template: "oops" },
    { $ref: "inputs.zero", extra: 1 },
    { $ref: "inputs.zero", transform: "eval" },
    { $ref: "inputs.zero", transform: ["string"] },
    { $ref: "inputs.zero", $template: [] },
    { $literal: 0, extra: 1 },
    { $template: Array(257).fill("") },
  ])(
    "rejects malformed expression %j identically in validation and execution",
    (value) => {
      expect(() => inspectExpressions(value as unknown as Json)).toThrow();
      expect(() => resolve(value as unknown as Json, scope)).toThrow();
    },
  );
  it.each(["__proto__", "prototype", "constructor"])(
    "rejects unsafe %s paths in either syntax, even in unused fallback",
    (key) => {
      for (const path of [`inputs.${key}`, ["inputs", key]]) {
        expect(() => resolve({ $ref: path, fallback: 0 }, scope)).toThrow(
          /unsafe/i,
        );
        expect(() => extractValue({ input: {}, path })).toThrow(/unsafe/i);
      }
      expect(() =>
        resolve(
          { $ref: "inputs.zero", fallback: { $ref: ["inputs", key] } },
          scope,
        ),
      ).toThrow(/unsafe/i);
      expect(() => parseJson(`{"${key}":1}`)).toThrow(/unsafe/i);
    },
  );
  it("does not access inherited values or invoke getters, and bounds depth, size and work", () => {
    const getter = vi.fn(() => 1),
      object = Object.defineProperty({}, "secret", {
        enumerable: true,
        get: getter,
      });
    expect(() => readPath(object, "secret")).toThrow(/getters/);
    expect(() => boundedJson(object)).toThrow(/getters/);
    expect(() => parseJson(object)).toThrow(/getters/);
    const pathGetter = Object.defineProperty([], "0", { get: getter });
    expect(() => parsePath(pathGetter)).toThrow(/getters/);
    expect(getter).not.toHaveBeenCalled();
    expect(
      readPath(Object.create({ inherited: 1 }), "inherited"),
    ).toBeUndefined();
    expect(() => boundedJson("x".repeat(1_000_001))).toThrow(/limit/);
    expect(() => boundedJson(Array(10001).fill(0))).toThrow(/limit/);
    expect(() => parsePath(Array(65).fill("a"))).toThrow();
    let deep: Json = 1;
    for (let i = 0; i < 34; i++) deep = { a: deep };
    expect(() => boundedJson(deep)).toThrow(/depth/);
    expect(() => parseJson("[".repeat(34) + "0" + "]".repeat(34))).toThrow(
      /depth/,
    );
    expect(() =>
      resolve(
        { $template: Array(100).fill({ $ref: "inputs.big" }) },
        { ...scope, inputs: { big: "x".repeat(20000) } },
      ),
    ).toThrow(/limit/);
  });
});
describe("data actions and schemas", () => {
  it("parses native JSON, extracts indexes and dotted keys, distinguishes missing and null", () => {
    const { value } = parseJson(
      '{"rows":[{"count.total":0,"nil":null,"empty":"","no":false}]}',
    );
    for (const [key, expected] of [
      ["count.total", 0],
      ["nil", null],
      ["empty", ""],
      ["no", false],
    ] as const)
      expect(
        extractValue({
          input: value,
          path: ["rows", 0, key],
          fallback: "wrong",
        }),
      ).toEqual({ value: expected });
    expect(
      extractValue({ input: value, path: "rows.0.missing", fallback: null }),
    ).toEqual({ value: null });
    expect(() => extractValue({ input: value, path: "missing" })).toThrow(
      /path is missing/,
    );
    expect(parseJson("null")).toEqual({ value: null });
    expect(() =>
      parseJson({ status: 200, body: "{}", truncated: true }),
    ).toThrow(/truncated HTTP/);
    expect(() => parseJson("secret invalid JSON")).toThrow(/^Invalid JSON:/);
  });
  it("validates literal structured fields and metadata without inventing dynamic object shapes", () => {
    expect(
      validateWorkflow(
        flow([action("cmd", "command.run", { args: [1] })]),
        [],
      ).join(),
    ).toContain("args");
    expect(
      validateWorkflow(
        flow([action("extract", "data.extract", { input: [0], path: [0] })]),
        [],
      ),
    ).toEqual([]);
    expect(
      actionById("http.request")!.outputSchema.safeParse({
        body: "{}",
        status: 200,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      actionById("data.parseJson")!.outputSchema.safeParse({
        value: [null, false],
      }).success,
    ).toBe(true);
    expect(
      actionById("command.run")!.outputSchema.safeParse({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }).success,
    ).toBe(true);
    expect(decodeArgs(["$(touch nope)", "a b"])).toEqual(
      decodeArgs('["$(touch nope)","a b"]'),
    );
  });
  it("walks references inside templates and fallbacks using parsed output segments", () => {
    const f = flow([
      action("notify", "desktop.notify", {
        body: { $template: ["value ", { $ref: ["outputs", "a.b", "value"] }] },
      }),
    ]);
    expect(validateWorkflow(f, [f]).join()).toContain(
      "output a.b is not available",
    );
    f.graph.nodes[0].action!.config.body = {
      $ref: "inputs.zero",
      fallback: { $ref: "outputs.missing" },
    };
    expect(validateWorkflow(f, [f]).join()).toContain("output missing");
    f.graph.nodes[0].action!.config.body = {
      $template: [{ $ref: ["outputs", "a.b"], fallback: "safe" }],
    };
    expect(validateWorkflow(f, [f])).toEqual([]);
  });
  it("preserves availability checks through branches, loop bodies and pinned subflows", async () => {
    const notify = action("notify", "desktop.notify", {
      body: {
        $template: [{ $ref: ["outputs", "conditional.output", "value"] }],
      },
    });
    const condition = {
      ...node("condition", "Choose"),
      id: "choice",
      config: { left: true, operator: "truthy" },
    };
    const conditional = {
      ...node("set", "conditional"),
      id: "conditional.output",
      config: { value: 0 },
    };
    const other = { ...node("set", "other"), id: "other", config: {} };
    const branch = flow([condition, conditional, other, notify]);
    branch.graph.edges = [
      { id: "yes", source: "choice", target: conditional.id, port: "true" },
      { id: "no", source: "choice", target: "other", port: "false" },
      { id: "join1", source: conditional.id, target: "notify", port: "next" },
      { id: "join2", source: "other", target: "notify", port: "next" },
    ];
    expect(validateWorkflow(branch, [branch]).join()).toContain(
      "not available on every path",
    );
    notify.action!.config.body = {
      $template: [{ $ref: ["outputs", conditional.id, "value"], fallback: 0 }],
    };
    expect(validateWorkflow(branch, [branch])).toEqual([]);
    const loop = {
      ...node("foreach", "loop"),
      id: "loop",
      config: { items: [0, false, null], maxIterations: 3, concurrency: 1 },
      body: {
        entry: "loop-notify",
        nodes: [
          action("loop-notify", "desktop.notify", {
            body: {
              $template: [
                "Item ",
                { $ref: "item" },
                "/",
                { $ref: ["outputs", conditional.id, "value"], fallback: 0 },
              ],
            },
          }),
        ],
        edges: [],
      },
    };
    const parent = flow([loop]);
    expect(validateWorkflow(parent, [parent])).toEqual([]);
    const effects = vi.fn<Handler>(async () => null);
    expect(
      (
        await new Engine(handler(effects), () => {}).start(parent, [parent])
          .done
      ).status,
    ).toBe("success");
    expect(effects.mock.calls.map((call) => call[0].config.body)).toEqual([
      "Item 0/0",
      "Item false/0",
      "Item null/0",
    ]);
    const child = flow([notify]);
    const call = {
      ...node("subflow", "Child"),
      config: { workflowId: child.id, revision: child.revision },
    };
    const pinned = flow([call]);
    expect(validateWorkflow(pinned, [pinned, child])).toEqual([]);
    call.config.revision++;
    expect(validateWorkflow(pinned, [pinned, child]).join()).toContain(
      "pin the current subflow revision",
    );
    notify.action!.config.body = {
      $ref: ["outputs", "missing"],
      fallback: { $template: [{ $ref: "outputs.another-missing" }] },
    };
    expect(validateWorkflow(pinned, [pinned, child]).join()).toContain(
      "output another-missing",
    );
  });
  it.each(["http.request", "desktop.notify", "command.run"])(
    "rejects referenced type mismatches before %s effects",
    async (type) => {
      const field =
        type === "http.request"
          ? "url"
          : type === "command.run"
            ? "args"
            : "body";
      const f = flow([
        action("bad", type, { [field]: { $ref: "inputs.value" } }),
      ]);
      const effect = vi.fn(async () => null);
      const result = await new Engine(effect, () => {}).start(f, [f], {
        value: 12,
      }).done;
      expect(result.status).toBe("failure");
      expect(effect).not.toHaveBeenCalled();
    },
  );
  it("passes native and legacy argv identically without shell evaluation", async () => {
    const argv = [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "$(echo should-stay-literal)",
      "a b",
      "",
    ];
    const execute = handler();
    const native = await execute(
      {
        ...makeAction("command.run"),
        config: { executable: process.execPath, args: argv, cwd: "" },
      },
      context(),
    );
    const legacy = await execute(
      {
        ...makeAction("command.run"),
        config: {
          executable: process.execPath,
          args: JSON.stringify(argv),
          cwd: "",
        },
      },
      context(),
    );
    expect(native).toEqual(legacy);
    expect(native).toMatchObject({
      stdout: JSON.stringify(argv.slice(2)),
      exitCode: 0,
    });
    for (const args of [[1], Array(257).fill(""), {}, "{}"])
      await expect(
        execute(
          {
            ...makeAction("app.launch"),
            config: { executable: process.execPath, args: args as Json },
          },
          context(),
        ),
      ).rejects.toThrow();
  });
});
describe("HTTP data pipeline", () => {
  it.each([16383, 16384, 16385, 50000])(
    "bounds %i-byte fixture responses and keeps credential authentication",
    async (size) => {
      let authorization: string | undefined;
      const url = await serve((req, res) => {
        authorization = req.headers.authorization;
        res.end("x".repeat(size));
      });
      const result = await handler()(
        {
          ...makeAction("http.request"),
          config: {
            ...makeAction("http.request").config,
            url,
            credentialRef: "test",
          },
        },
        context(),
      );
      expect(result).toEqual({
        status: 200,
        body: "x".repeat(Math.min(size, HTTP_BODY_LIMIT)),
        truncated: size > HTTP_BODY_LIMIT,
      });
      expect(authorization).toBe("Bearer private-bearer");
    },
  );
  it("detects an extra chunk after exactly 16384, preserves UTF-8 across chunks, and releases readers", async () => {
    const encoder = new TextEncoder();
    for (const extra of [false, true]) {
      const cancel = vi.fn();
      const chunks = [
        encoder.encode("x".repeat(16381)),
        encoder.encode("€").slice(0, 1),
        encoder.encode("€").slice(1),
        ...(extra ? [encoder.encode("!")] : []),
      ];
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          const chunk = chunks.shift();
          if (chunk) c.enqueue(chunk);
          else c.close();
        },
        cancel,
      });
      const result = await readHttpBody(new Response(stream), context().signal);
      expect(result).toEqual({
        body: "x".repeat(16381) + "€",
        truncated: extra,
      });
      expect(stream.locked).toBe(false);
      if (extra) expect(cancel).toHaveBeenCalled();
    }
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("x".repeat(16383) + "€"));
        c.close();
      },
    });
    const result = await readHttpBody(new Response(stream), context().signal);
    expect(result).toEqual({ body: "x".repeat(16383), truncated: true });
  });
  it("runs a saved/reloaded HTTP → Parse JSON → Extract → sentence notification with typed URL/body/condition", async () => {
    const notified = vi.fn(async () => null),
      received: string[] = [];
    const url = await serve((req, res) => {
      req.on("data", (c) => received.push(String(c)));
      req.on("end", () => res.end('{"stats":{"subscribers":0}}'));
    });
    const f = flow([
      {
        ...node("set", "Name values"),
        id: "named",
        config: { url, payload: { stats: true } },
      },
      action("http", "http.request", {
        url: { $ref: "vars.url" },
        method: "POST",
        body: { $ref: "vars.payload", transform: "string" },
      }),
      action("parse", "data.parseJson", { input: { $ref: "outputs.http" } }),
      action("extract", "data.extract", {
        input: { $ref: "outputs.parse.value" },
        path: ["stats", "subscribers"],
      }),
      {
        ...node("condition", "Check zero"),
        id: "check",
        config: {
          left: { $ref: "outputs.extract.value" },
          right: 0,
          operator: "equals",
        },
      },
      action("notify", "desktop.notify", {
        body: {
          $template: ["Subscribers: ", { $ref: "outputs.extract.value" }, "."],
        },
      }),
    ]);
    f.graph.edges.at(-1)!.port = "true";
    const dir = await mkdtemp(join(tmpdir(), "decker-data-"));
    try {
      const store = new Persistence(dir);
      const { document } = await store.load();
      document.workflows = [f];
      await store.save(document, []);
      const loaded = (await new Persistence(dir).load()).document;
      expect(loaded.schemaVersion).toBe(3);
      const result = await new Engine(handler(notified), () => {}).start(
        loaded.workflows[0],
        loaded.workflows,
      ).done;
      expect(result.status).toBe("success");
      expect(received.join("")).toBe('{"stats":true}');
      expect(notified).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "desktop.notify",
          config: { title: "Decker", body: "Subscribers: 0." },
        }),
        expect.anything(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("cancels streaming HTTP without retry, error recovery or late notification", async () => {
    let started!: () => void,
      requests = 0;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const url = await serve((_req, res) => {
      requests++;
      res.writeHead(200);
      res.write("{");
      started();
    });
    const http = action("http", "http.request", { url });
    http.retries = 2;
    http.retrySafe = true;
    const f = flow([http, action("late", "desktop.notify", {})]);
    f.graph.edges.push({
      id: "recovery",
      source: "http",
      target: "late",
      port: "error",
    });
    const notified = vi.fn(async () => null),
      engine = new Engine(handler(notified), () => {}),
      run = engine.start(f, [f]);
    await ready;
    run.cancel();
    expect((await run.done).status).toBe("cancelled");
    expect(requests).toBe(1);
    expect(notified).not.toHaveBeenCalled();
    expect(run.containsWorkflow(f.id)).toBe(false);
  });
  it("rejects missing secrets, secret-bearing redirects, and HTTP errors", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/" });
        res.end();
      } else {
        res.writeHead(503);
        res.end("unavailable");
      }
    });
    const a = makeAction("http.request");
    a.config.url = url;
    a.config.credentialRef = "missing";
    await expect(handler()(a, context())).rejects.toThrow(
      /Bearer token is missing or locked\. Open this HTTP action and enter or replace its token/,
    );
    a.config.credentialRef = "test";
    a.config.url = url + "/redirect";
    await expect(handler()(a, context())).rejects.toThrow();
    a.config.url = url;
    a.config.credentialRef = "";
    await expect(handler()(a, context())).rejects.toThrow(
      "HTTP 503: unavailable",
    );
  });
});

it("releases the HTTP reader after stream failure and after an already-cancelled read", async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("fixture stream failure"));
    },
  });
  await expect(
    readHttpBody(new Response(broken), context().signal),
  ).rejects.toThrow("fixture stream failure");
  expect(broken.locked).toBe(false);
  const cancel = vi.fn(),
    pending = new ReadableStream<Uint8Array>({ cancel });
  await expect(
    readHttpBody(
      new Response(pending),
      AbortSignal.abort(new Error("cancelled fixture")),
    ),
  ).rejects.toThrow("cancelled fixture");
  expect(pending.locked).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
});
