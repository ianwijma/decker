import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, page: Page, directory: string, server: Server;
type NotificationFixture = typeof globalThis & {
  dataNotifications: { title: string; body: string }[];
};
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  await app.evaluate(({ Notification }) => {
    (globalThis as NotificationFixture).dataNotifications = [];
    Notification.prototype.show = function () {
      (globalThis as NotificationFixture).dataNotifications.push({
        title: this.title,
        body: this.body,
      });
    };
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  // Main can publish its OBS capability before the runner handshake completes.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).capabilities.some(
          (c) => c.id === "keyboard",
        ),
      ),
    )
    .toBe(true);
}
async function notifications() {
  return app.evaluate(
    () => (globalThis as NotificationFixture).dataNotifications,
  );
}
async function fixture(url: string) {
  return page.evaluate(async (url) => {
    const doc = (await window.decker.snapshot()).document,
      workflow = doc.workflows[0];
    const step = (
      id: string,
      type: string,
      config: Record<string, import("../../src/shared/schema").Json>,
    ) => ({
      id,
      name: id,
      kind: "action" as const,
      config: {},
      action: { type, version: 1 as const, config },
      timeoutMs: 30000,
      retries: 0,
      retrySafe: false,
    });
    const nodes = [
      step("http", "http.request", {
        url,
        method: "GET",
        body: "",
        credentialRef: "",
      }),
      step("parse", "data.parseJson", { input: { $ref: "outputs.http" } }),
      step("extract", "data.extract", {
        input: { $ref: "outputs.parse.value" },
        path: "stats.subscribers",
      }),
      step("notify", "desktop.notify", {
        title: "Data fixture",
        body: {
          $template: ["Subscribers: ", { $ref: "outputs.extract.value" }],
        },
      }),
    ];
    workflow.name = "HTTP data and templates";
    workflow.graph = {
      entry: "http",
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: `edge${i}`,
        source: nodes[i].id,
        target: n.id,
        port: "next",
      })),
    };
    workflow.layout = Object.fromEntries(
      nodes.map((n, i) => [n.id, { x: 40 + i * 230, y: 120 }]),
    );
    await window.decker.request({ type: "save", document: doc });
    return workflow.id;
  }, url);
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-data-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await rm(directory, { recursive: true, force: true });
});
async function listen() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test("edits JSON path/template fields, saves and relaunches, and delivers the fetched value to a notification", async () => {
  server = createServer((_req, res) => res.end('{"stats":{"subscribers":0}}'));
  const url = await listen();
  await launch();
  const id = await fixture(url);
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.locator('.react-flow__node[data-id="extract"]').click();
  const path = page.getByRole("textbox", {
    name: "Data path JSON",
    exact: true,
  });
  await path.fill('["stats", "subscribers"]');
  await path.press("Tab");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).document
          .workflows[0].graph.nodes[2].action!.config.path,
    )
    .toEqual(["stats", "subscribers"]);
  await page.locator('.react-flow__node[data-id="notify"]').click();
  await page.getByText("Message advanced JSON", { exact: true }).click();
  const message = page.getByRole("textbox", {
    name: "Message binding",
    exact: true,
  });
  await message.fill(
    '{"$template":["Subscribers: ",{"$ref":"outputs.extract.value"},"."]}',
  );
  await message.press("Tab");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).document
          .workflows[0].graph.nodes[3].action!.config.body,
    )
    .toEqual({
      $template: ["Subscribers: ", { $ref: "outputs.extract.value" }, "."],
    });
  await app.close();
  await launch();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.locator('.react-flow__node[data-id="extract"]').click();
  await expect(
    page.getByRole("textbox", { name: "Data path JSON", exact: true }),
  ).toHaveValue(/subscribers/);
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).runs
          .filter((r) => r.workflowId === id)
          .at(-1)?.status,
    )
    .toBe("success");
  await expect
    .poll(notifications)
    .toEqual([{ title: "Data fixture", body: "Subscribers: 0." }]);
  await page.screenshot({
    path: test.info().outputPath("workflow-data.png"),
    fullPage: true,
  });
});
test("cancels HTTP and ignores a late fixture response without a notification", async () => {
  let pending: ServerResponse | undefined,
    requests = 0;
  server = createServer((_req, res) => {
    requests++;
    pending = res;
    res.writeHead(200);
    res.write('{"stats":');
  });
  const url = await listen();
  await launch();
  const id = await fixture(url);
  await page.evaluate(
    (workflowId) =>
      window.decker.request({ type: "run", workflowId, inputs: {} }),
    id,
  );
  await expect.poll(() => requests).toBe(1);
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  const runId = snapshot.runs.find(
    (r) => r.workflowId === id && r.status === "running",
  )!.id;
  await page.evaluate(
    (runId) => window.decker.request({ type: "cancel", runId }),
    runId,
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).runs.find(
          (r) => r.id === runId,
        )?.status,
    )
    .toBe("cancelled");
  pending!.end('{"subscribers":123}}');
  await expect.poll(notifications).toEqual([]);
  const record = (
    await page.evaluate(() => window.decker.snapshot())
  ).runs.find((r) => r.id === runId)!;
  expect(record.nodes.some((n) => n.nodeId === "notify")).toBe(false);
});
