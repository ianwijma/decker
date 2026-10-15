import sharp from "sharp";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Json } from "../../src/shared/schema";
let app: ElectronApplication, page: Page, directory: string, server: Server;
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
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
async function fixture(url: string) {
  return page.evaluate(async (url) => {
    const document = (await window.decker.snapshot()).document,
      workflow = document.workflows[0],
      binding = document.profiles[0].pages[0].keys[2];
    const step = (id: string, type: string, config: Record<string, Json>) => ({
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
        path: "stats.count",
      }),
      step("update", "deck.appearance", {
        label: {
          $template: [
            "Count: ",
            { $ref: "outputs.extract.value" },
            " · ",
            { $ref: "context.source.kind" },
          ],
        },
        icon: "pack:lucide:v1:user",
        background: "#123456",
      }),
    ];
    workflow.graph = {
      entry: "http",
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: String(i),
        source: nodes[i].id,
        target: n.id,
        port: "next",
      })),
    };
    workflow.layout = Object.fromEntries(
      nodes.map((n, i) => [n.id, { x: 40 + i * 230, y: 120 }]),
    );
    binding.appearance.label = "Authored count";
    binding.press = { kind: "workflow", workflowId: workflow.id };
    document.profiles[0].pages.push({ id: "away", name: "Away", keys: {} });
    await window.decker.request({ type: "save", document });
    return {
      workflowId: workflow.id,
      deckId: document.decks[0].id,
      bindingId: binding.id,
    };
  }, url);
}
async function listen() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-trigger-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
test("HTTP/Parse/Extract updates the captured key across navigation and restart; UI exposes context without editing authored appearance", async () => {
  let pending: ServerResponse | undefined;
  server = createServer((_, res) => {
    pending = res;
  });
  const url = await listen();
  await launch();
  const ids = await fixture(url);
  await page.evaluate(async (deckId) => {
    await window.decker.request({ type: "press", deckId, key: 2, down: true });
    await window.decker.request({ type: "press", deckId, key: 2, down: false });
  }, ids.deckId);
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.evaluate(async (deckId) => {
    const document = (await window.decker.snapshot()).document;
    await window.decker.request({
      type: "navigate",
      deckId,
      profileId: document.profiles[0].id,
      pageId: "away",
    });
  }, ids.deckId);
  pending!.end('{"stats":{"count":0,"name":"Local fixture"}}');
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.decker.snapshot()).runs
            .filter((r) => r.workflowId === id)
            .at(-1)?.status,
        ids.workflowId,
      ),
    )
    .toBe("success");
  await page.evaluate(async (deckId) => {
    const document = (await window.decker.snapshot()).document;
    await window.decker.request({
      type: "navigate",
      deckId,
      profileId: document.profiles[0].id,
      pageId: "home",
    });
  }, ids.deckId);
  await expect(
    page.getByRole("button", { name: /Count: 0 · button/ }).first(),
  ).toBeVisible();
  const snap = await page.evaluate(() => window.decker.snapshot());
  expect(snap.document.profiles[0].pages[0].keys[2].appearance.label).toBe(
    "Authored count",
  );
  expect(snap.runs.at(-1)!.context!.origin).toMatchObject({
    pageId: "home",
    bindingId: ids.bindingId,
  });
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.locator('.react-flow__node[data-id="update"]').click();
  await expect(
    page.getByRole("checkbox", { name: "Update Icon", exact: true }),
  ).toBeChecked();
  await page.getByText("Label advanced JSON", { exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Label binding", exact: true }),
  ).toHaveValue(/context.source.kind/);
  await page
    .getByRole("combobox", { name: "Label value mode", exact: true })
    .selectOption("reference");
  await page.getByRole("button", { name: /^Data for Label:/ }).click();
  const contextPicker = page.getByRole("combobox", {
    name: "Search data for Label",
    exact: true,
  });
  await contextPicker.fill("source.kind");
  await expect(
    page.getByRole("option", { name: /Trigger context \/ source.kind/ }),
  ).toBeVisible();
  await contextPicker.press("Escape");
  await page
    .getByRole("combobox", { name: "Label value mode", exact: true })
    .selectOption("template");
  await page
    .getByText("Last-run preview (bounded and redacted)", { exact: true })
    .click();
  await expect(
    page.getByText("Trigger context", { exact: true }),
  ).toBeVisible();
  const cache = JSON.parse(
    await readFile(join(directory, "display-cache.json"), "utf8"),
  );
  expect(cache.entries[0].fields).toMatchObject({
    label: "Count: 0 · button",
    icon: "pack:lucide:v1:user",
  });
  expect(JSON.stringify(cache)).not.toMatch(/authority|outputs/);
  await app.close();
  await launch();
  await expect(
    page.getByRole("button", { name: /Count: 0 · button/ }).first(),
  ).toBeVisible();
});
test("manual/detached tests fail with no triggering button; an authoritative saved-key test may update it", async () => {
  server = createServer((_, res) => res.end('{"stats":{"count":12}}'));
  await launch();
  const ids = await fixture(await listen());
  await page.evaluate(
    async (workflowId) =>
      window.decker.request({
        type: "run",
        workflowId,
        inputs: { context: { origin: { bindingId: "forged" } } },
      }),
    ids.workflowId,
  );
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.decker.snapshot()).runs
            .filter((r) => r.workflowId === id)
            .at(-1)?.error,
        ids.workflowId,
      ),
    )
    .toContain("No valid triggering button");
  await page.evaluate(async (deckId) => {
    const b = structuredClone(
      (await window.decker.snapshot()).document.profiles[0].pages[0].keys[2],
    );
    b.appearance.label = "Unsaved draft";
    await window.decker.request({ type: "test", deckId, binding: b });
  }, ids.deckId);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).runs.at(-1)?.status,
      ),
    )
    .toBe("failure");
  let snap = await page.evaluate(() => window.decker.snapshot());
  expect(snap.runs.at(-1)!.context!.origin).toBeNull();
  expect(snap.runs.at(-1)!.bindingId).toBeUndefined();
  expect(Object.keys(snap.observed.buttonDisplay as object)).toHaveLength(0);
  await page.evaluate(async (deckId) => {
    const binding = (await window.decker.snapshot()).document.profiles[0]
      .pages[0].keys[2];
    await window.decker.request({ type: "test", deckId, binding });
  }, ids.deckId);
  await expect(
    page.getByRole("button", { name: /Count: 12 · test/ }).first(),
  ).toBeVisible();
  snap = await page.evaluate(() => window.decker.snapshot());
  expect(snap.document.profiles[0].pages[0].keys[2].appearance.label).toBe(
    "Authored count",
  );
});

test("local image control updates a saved key and supports partial fields without changing authored appearance", async () => {
  server = createServer((_, res) => res.end('{"stats":{"count":3}}'));
  await launch();
  const ids = await fixture(await listen()),
    imagePath = join(directory, "local.png");
  await sharp({
    create: { width: 24, height: 24, channels: 3, background: "#aabbcc" },
  })
    .png()
    .toFile(imagePath);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, imagePath);
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.locator('.react-flow__node[data-id="update"]').click();
  await page
    .getByRole("checkbox", { name: "Update Label", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Update Local image", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Choose local image", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).document.workflows[0].graph.nodes.at(
            -1,
          )!.action!.config.asset,
      ),
    )
    .toMatch(/^[a-f0-9]{64}$/);
  const snapshot = await page.evaluate(() => window.decker.snapshot()),
    hash = snapshot.document.workflows[0].graph.nodes.at(-1)!.action!.config
      .asset as string;
  expect(
    snapshot.document.workflows[0].graph.nodes.at(-1)!.action!.config,
  ).not.toHaveProperty("label");
  await page.evaluate(async (deckId) => {
    const binding = (await window.decker.snapshot()).document.profiles[0]
      .pages[0].keys[2];
    await window.decker.request({ type: "test", deckId, binding });
  }, ids.deckId);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).runs.at(-1)?.status,
      ),
    )
    .toBe("success");
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await expect(
    page
      .getByRole("button", { name: "Key 3: Authored count", exact: true })
      .locator("img"),
  ).toHaveAttribute("src", `decker-asset://${hash}`);
  const cache = JSON.parse(
    await readFile(join(directory, "display-cache.json"), "utf8"),
  );
  expect(cache.entries[0].fields.asset).toBe(hash);
  const authored = (await page.evaluate(() => window.decker.snapshot()))
    .document.profiles[0].pages[0].keys[2].appearance;
  expect(authored.label).toBe("Authored count");
  expect(authored.asset).toBeUndefined();
});
