import type { FlowNode } from "../../src/shared/schema";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication,
  page: Page,
  directory: string,
  server: Server | undefined;
type Fixture = typeof globalThis & {
  bindingNotifications: { title: string; body: string }[];
};
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  await app.evaluate(({ Notification }) => {
    (globalThis as Fixture).bindingNotifications = [];
    Notification.prototype.show = function () {
      (globalThis as Fixture).bindingNotifications.push({
        title: this.title,
        body: this.body,
      });
    };
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-binding-ui-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  await rm(directory, { recursive: true, force: true });
});
async function add(name: string, nodeName: string) {
  await page.getByRole("textbox", { name: "Search nodes" }).fill(name);
  await page
    .getByRole("button", { name: `Add ${name} node`, exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Node name", exact: true })
    .fill(nodeName);
}
async function pick(
  label: string,
  search: string,
  suffix?: string,
  fallback?: string,
) {
  const escapedLabel = label.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
  await page
    .getByRole("button", { name: new RegExp(`^Data for ${escapedLabel}:`) })
    .click();
  const box = page.getByRole("combobox", {
    name: `Search data for ${label}`,
    exact: true,
  });
  await expect(box).toBeFocused();
  await box.fill(search);
  await box.press("Enter");
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^Data for ${escapedLabel}:`),
    }),
  ).toBeFocused();
  if (suffix)
    await page
      .getByRole("textbox", { name: `Path segments for ${label}`, exact: true })
      .fill(suffix);
  if (fallback)
    await page
      .getByRole("textbox", { name: `Fallback for ${label}`, exact: true })
      .fill(fallback);
  await page
    .getByRole("button", { name: `Insert reference for ${label}`, exact: true })
    .click();
}
async function workflow(name: string) {
  return (
    await page.evaluate(() => window.decker.snapshot())
  ).document.workflows.find((w) => w.name === name)!;
}
test("builds HTTP → Parse → Extract → templated Notification entirely in the UI and preserves native zero/false/null across reload", async () => {
  let value: unknown = 0;
  server = createServer((_req, res) =>
    res.end(JSON.stringify({ stats: { subscribers: value } })),
  );
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Workflow name", exact: true })
    .fill("Metrics UI");
  await add("HTTP request", "Fetch metrics");
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(url);
  await add("Parse JSON", "Parse metrics");
  await page
    .getByRole("combobox", {
      name: "JSON text or HTTP result value mode",
      exact: true,
    })
    .selectOption("reference");
  await pick("JSON text or HTTP result", "Fetch metrics / Complete result");
  await add("Extract value", "Extract subscribers");
  await page
    .getByRole("combobox", { name: "Input value value mode", exact: true })
    .selectOption("reference");
  await pick("Input value", "Parse metrics / value");
  await page
    .getByRole("textbox", { name: "Data path JSON", exact: true })
    .fill('["stats","subscribers"]');
  await page
    .getByRole("textbox", { name: "Data path JSON", exact: true })
    .press("Tab");
  await add("Notification", "Report metrics");
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Metrics");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Subscribers: ");
  await page
    .getByRole("combobox", { name: "Message value mode", exact: true })
    .selectOption("template");
  await page
    .getByRole("button", { name: "Add reference to Message", exact: true })
    .click();
  await pick("Message segment 2", "Extract subscribers / value");
  await page
    .getByRole("button", { name: "Add text to Message", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Message text segment 3", exact: true })
    .fill(". ${literal} <b>text</b>");
  await expect
    .poll(
      async () =>
        (await workflow("Metrics UI")).graph.nodes.at(-1)?.action?.config.body,
    )
    .toEqual({
      $template: [
        "Subscribers: ",
        {
          $ref: [
            "outputs",
            (await workflow("Metrics UI")).graph.nodes[3].id,
            "value",
          ],
        },
        ". ${literal} <b>text</b>",
      ],
    });
  const saved = await workflow("Metrics UI");
  await app.close();
  await launch();
  await page.getByRole("button", { name: /^Workflow:/ }).click();
  await page.getByRole("option", { name: "Metrics UI", exact: true }).click();
  expect((await workflow("Metrics UI")).graph.nodes).toEqual(saved.graph.nodes);
  for (const native of [0, false, null]) {
    value = native;
    const before = (await page.evaluate(() => window.decker.snapshot())).runs
      .length;
    await page
      .getByRole("button", { name: "Run workflow", exact: true })
      .click();
    await expect
      .poll(async () => {
        const runs = (await page.evaluate(() => window.decker.snapshot())).runs;
        return runs.length > before ? runs.at(-1)?.status : undefined;
      })
      .toBe("success");
  }
  expect(
    await app.evaluate(() => (globalThis as Fixture).bindingNotifications),
  ).toEqual(
    [0, false, null].map((v) => ({
      title: "Metrics",
      body: "Subscribers: " + String(v) + ". ${literal} <b>text</b>",
    })),
  );
  await page
    .locator(`.react-flow__node[data-id="${saved.graph.nodes[4].id}"]`)
    .click();
  await page
    .getByText("Last-run preview (bounded and redacted)", { exact: true })
    .click();
  await expect(page.locator(".data-preview pre").first()).toContainText(
    "Subscribers: null.",
  );
  await expect(page.locator(".data-preview b")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("data-binding-ui.png"),
    fullPage: true,
  });
});

test("names duplicate producers, keeps references through rename, retains mode drafts and rejects missing conditional fallback", async () => {
  const ids = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document,
      w = doc.workflows[0];
    const n = (
      id: string,
      kind: "action" | "condition",
      name: string,
    ): FlowNode => ({
      id,
      kind,
      name,
      config: kind === "condition" ? { left: true, right: true } : {},
      timeoutMs: 30000,
      retries: 0,
      retrySafe: false,
    });
    w.graph = {
      entry: "first.with.dots",
      nodes: [
        {
          ...n("first.with.dots", "action", "Fetch"),
          action: {
            type: "http.request",
            version: 1,
            config: {
              url: "https://example.com",
              method: "GET",
              body: "",
              credentialRef: "",
            },
          },
        },
        {
          ...n("second", "action", "Fetch"),
          action: {
            type: "http.request",
            version: 1,
            config: {
              url: "https://example.com",
              method: "GET",
              body: "",
              credentialRef: "",
            },
          },
        },
        {
          ...n("notify", "action", "Notify"),
          action: {
            type: "desktop.notify",
            version: 1,
            config: { title: "Title", body: "Original" },
          },
        },
      ],
      edges: [
        { id: "1", source: "first.with.dots", target: "second", port: "next" },
        { id: "2", source: "second", target: "notify", port: "next" },
      ],
    };
    w.layout = {
      "first.with.dots": { x: 20, y: 50 },
      second: { x: 290, y: 50 },
      notify: { x: 560, y: 50 },
    };
    await window.decker.request({ type: "save", document: doc });
    return w.id;
  });
  await page.locator('.react-flow__node[data-id="notify"]').click();
  await page
    .getByRole("combobox", { name: "Message value mode", exact: true })
    .selectOption("reference");
  await pick("Message", "Fetch (choice 1) / status");
  await expect(
    page.getByRole("alert").filter({ hasText: "This field needs text" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Transform for Message", exact: true })
    .selectOption("string");
  await page
    .getByRole("button", { name: "Insert reference for Message", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).document
          .workflows[0].graph.nodes[2].action!.config.body,
    )
    .toEqual({
      $ref: ["outputs", "first.with.dots", "status"],
      transform: "string",
    });
  await page.getByRole("button", { name: /^Data for Message:/ }).click();
  await page
    .getByRole("combobox", { name: "Search data for Message", exact: true })
    .fill("Fetch");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(8);
  await page
    .getByRole("option", { name: /Node outputs \/ Fetch \(choice 1\) \/ body/ })
    .click();
  await page
    .getByRole("combobox", { name: "Transform for Message", exact: true })
    .selectOption("");
  await page
    .getByRole("button", { name: "Insert reference for Message", exact: true })
    .click();
  const read = async () =>
    (
      await page.evaluate(() => window.decker.snapshot())
    ).document.workflows.find((w) => w.id === ids)!.graph.nodes[2].action!
      .config.body;
  await expect.poll(read).toEqual({
    $ref: ["outputs", "first.with.dots", "body"],
  });
  await page
    .getByRole("combobox", { name: "Message value mode", exact: true })
    .selectOption("literal");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Original");
  await page
    .getByRole("combobox", { name: "Message value mode", exact: true })
    .selectOption("reference");
  await page.locator('.react-flow__node[data-id="first.with.dots"]').click();
  await page
    .getByRole("textbox", { name: "Node name", exact: true })
    .fill("Renamed fetch");
  await page.locator('.react-flow__node[data-id="notify"]').click();
  await expect(
    page.getByRole("button", { name: /^Data for Message:/ }),
  ).toContainText("Renamed fetch / body");
  await expect.poll(read).toEqual({
    $ref: ["outputs", "first.with.dots", "body"],
  });
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document,
      w = doc.workflows[0];
    w.graph.edges.push({
      id: "error",
      source: "first.with.dots",
      target: "notify",
      port: "error",
    });
    await window.decker.request({ type: "save", document: doc });
  });
  await pick("Message", "Renamed fetch / body");
  await expect(
    page.getByRole("alert").filter({ hasText: "explicit fallback" }).first(),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Fallback for Message", exact: true })
    .fill('""');
  await page
    .getByRole("button", { name: "Insert reference for Message", exact: true })
    .click();
  await expect
    .poll(read)
    .toEqual({ $ref: ["outputs", "first.with.dots", "body"], fallback: "" });
  await page.locator('.react-flow__node[data-id="first.with.dots"]').click();
  await page.getByRole("button", { name: "Delete node", exact: true }).click();
  await page.locator('.react-flow__node[data-id="notify"]').click();
  await expect(
    page.getByText(
      "Reference path is custom, removed, or unavailable in this scope. Review the JSON and fallback.",
    ),
  ).toBeVisible();
  await page.getByText("Message advanced JSON", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message binding", exact: true })
    .fill(
      '{"$template":["Escaped \\"text\\"",{"$ref":["inputs","zero"],"fallback":0}]}',
    );
  await page
    .getByRole("textbox", { name: "Message binding", exact: true })
    .press("Tab");
  await expect(
    page.getByRole("combobox", { name: "Message value mode", exact: true }),
  ).toHaveValue("template");
});

test("keeps URL/body/argv types, literal escapes, control fields and graph-specific preview samples", async () => {
  const id = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document,
      w = doc.workflows[0];
    const make = (
      id: string,
      kind: FlowNode["kind"],
      config: FlowNode["config"] = {},
    ): FlowNode => ({
      id,
      kind,
      name: id,
      config,
      timeoutMs: 30000,
      retries: 0,
      retrySafe: false,
    });
    const http = make("http", "action");
    http.action = {
      type: "http.request",
      version: 1,
      config: {
        url: "https://example.com",
        method: "GET",
        body: "",
        credentialRef: "",
      },
    };
    const command = make("command", "action");
    command.action = {
      type: "command.run",
      version: 1,
      config: { executable: "echo", args: ["old"], cwd: "" },
    };
    const condition = make("condition", "condition", {
      left: true,
      operator: "equals",
      right: false,
    });
    const sw = make("switch", "switch", { value: "a", cases: ["a", "b"] });
    const loop = make("loop", "foreach", {
      items: [],
      maxIterations: 10,
      concurrency: 1,
    });
    loop.body = {
      entry: "inner",
      nodes: [make("inner", "return", { result: false })],
      edges: [],
    };
    const call = make("call", "subflow", {
      workflowId: "child",
      revision: 1,
      inputs: { payload: null },
    });
    const ret = make("return", "return", { result: null });
    const nodes = [http, command, condition, sw, loop, call, ret];
    w.inputs = ["url", "body", "argv", "flag", "items", "payload"];
    w.graph = {
      entry: http.id,
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: String(i),
        source: nodes[i].id,
        target: n.id,
        port:
          nodes[i].kind === "condition"
            ? "true"
            : nodes[i].kind === "switch"
              ? "a"
              : "next",
      })),
    };
    w.layout = Object.fromEntries(
      nodes.map((n, i) => [
        n.id,
        { x: 20 + (i % 3) * 240, y: 40 + Math.floor(i / 3) * 140 },
      ]),
    );
    const child = structuredClone(w);
    child.id = crypto.randomUUID();
    call.config.workflowId = child.id;
    child.name = "Child";
    child.inputs = ["payload"];
    child.outputs = ["result"];
    child.revision = 1;
    child.graph = {
      entry: "child-return",
      nodes: [
        make("child-return", "return", {
          result: { $ref: ["inputs", "payload"] },
        }),
      ],
      edges: [],
    };
    doc.workflows.push(child);
    await window.decker.request({ type: "save", document: doc });
    return w.id;
  });
  await page.locator('.react-flow__node[data-id="http"]').click();
  await page
    .getByRole("combobox", { name: "URL value mode", exact: true })
    .selectOption("reference");
  await pick("URL", "Inputs / url");
  await page
    .getByRole("combobox", { name: "Body value mode", exact: true })
    .selectOption("reference");
  await pick("Body", "Inputs / body");
  await page.locator('.react-flow__node[data-id="command"]').click();
  await expect(
    page.getByRole("textbox", {
      name: "Arguments (JSON array) JSON",
      exact: true,
    }),
  ).toHaveValue('[\n  "old"\n]');
  await page
    .getByRole("combobox", {
      name: "Arguments (JSON array) value mode",
      exact: true,
    })
    .selectOption("reference");
  await pick("Arguments (JSON array)", "Inputs / argv");
  for (const [nodeId, target, input] of [
    ["condition", '["left"]', "flag"],
    ["switch", '["value"]', "flag"],
    ["loop", '["items"]', "items"],
    ["call", '["inputs","payload"]', "payload"],
    ["return", '["result"]', "payload"],
  ]) {
    await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
    await page.getByText("Configuration data helper", { exact: true }).click();
    await page
      .getByRole("textbox", {
        name: "Selected configuration field",
        exact: true,
      })
      .fill(target);
    await page
      .getByRole("combobox", { name: "Selected field value mode", exact: true })
      .selectOption("reference");
    await pick("Selected field", `Inputs / ${input}`);
    await expect(page.locator(".data-preview")).toHaveCount(1);
  }
  await page.locator('.react-flow__node[data-id="return"]').click();
  // Close/reopen the helper if needed, then explicitly restore literal mode.
  const helper = page.locator("details").filter({
    has: page.getByText("Configuration data helper", { exact: true }),
  });
  if ((await helper.getAttribute("open")) === null)
    await page.getByText("Configuration data helper", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Selected field value mode", exact: true })
    .selectOption("literal");
  await page
    .getByRole("textbox", { name: "Selected field literal JSON", exact: true })
    .fill('{"$ref":"literal.object"}');
  await page
    .getByRole("textbox", { name: "Selected field literal JSON", exact: true })
    .press("Tab");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).document.workflows
          .find((w) => w.id === id)!
          .graph.nodes.at(-1)?.config.result,
    )
    .toEqual({ $literal: { $ref: "literal.object" } });
  const saved = (
    await page.evaluate(() => window.decker.snapshot())
  ).document.workflows.find((w) => w.id === id)!;
  expect(saved.graph.nodes[0].action!.config).toMatchObject({
    url: { $ref: ["inputs", "url"] },
    body: { $ref: ["inputs", "body"] },
  });
  expect(saved.graph.nodes[1].action!.config.args).toEqual({
    $ref: ["inputs", "argv"],
  });
  expect(saved.graph.nodes[3].config.cases).toEqual(["a", "b"]);
  expect(saved.graph.nodes[4].config).toMatchObject({
    items: { $ref: ["inputs", "items"] },
    maxIterations: 10,
    concurrency: 1,
  });
  expect(saved.graph.nodes[5].config).toMatchObject({
    revision: 1,
    inputs: { payload: { $ref: ["inputs", "payload"] } },
  });
  // Persist a sanitized history fixture, so normal snapshot refreshes keep it.
  await app.close();
  const record = (path: string, attempt: number, output: string) => ({
    id: path + attempt,
    nodeId: "inner",
    name: "Inner",
    path,
    attempt,
    startedAt: 1,
    status: "success",
    output,
  });
  await writeFile(
    join(directory, "history.json"),
    JSON.stringify([
      {
        id: "preview",
        workflowId: id,
        workflowName: "Sample",
        revision: saved.revision - 1,
        startedAt: 2,
        status: "success",
        nodes: [
          record(id + "/loop/iteration:0", 0, "<b>safe sample</b>"),
          record(id + "/loop/iteration:1", 1, "[redacted]"),
          record(id + "/sibling/branch:0", 0, "wrong graph"),
        ],
      },
    ]),
  );
  await launch();
  await page.locator('.react-flow__node[data-id="loop"]').click();
  await page
    .getByRole("button", { name: "Edit loop body →", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="inner"]').click();
  await page
    .getByText("Last-run preview (bounded and redacted)", { exact: true })
    .click();
  await expect(page.locator(".data-preview")).toContainText("Stale revision");
  await expect(page.locator(".data-preview")).toContainText("[redacted]");
  await page.getByRole("button", { name: /^Preview execution:/ }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "Search preview executions", exact: true })
    .press("ArrowUp");
  await page
    .getByRole("combobox", { name: "Search preview executions", exact: true })
    .press("Enter");
  await expect(page.locator(".data-preview pre").nth(1)).toContainText(
    "<b>safe sample</b>",
  );
  await expect(page.locator(".data-preview b")).toHaveCount(0);
  await expect(page.locator(".data-preview")).not.toContainText("wrong graph");
});
