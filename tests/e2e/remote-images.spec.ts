import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Json } from "../../src/shared/schema";
let app: ElectronApplication,
  page: Page,
  directory: string,
  server: Server,
  base: string;
let fail = false,
  slow: ServerResponse | undefined,
  image: Buffer;
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
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-image-e2e-"));
  fail = false;
  slow = undefined;
  image = await sharp({
    create: {
      width: 16,
      height: 12,
      channels: 4,
      background: { r: 20, g: 60, b: 180, alpha: 0.8 },
    },
  })
    .png()
    .toBuffer();
  server = createServer((req, res) => {
    if (req.url === "/api") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ avatar: base + "/avatar", name: "Local avatar" }),
      );
    } else if (req.url === "/slow") {
      slow = res;
      res.writeHead(200);
      res.write(image.subarray(0, 20));
    } else if (fail) {
      res.statusCode = 500;
      res.end("private-signed-error-body");
    } else {
      res.setHeader("Content-Type", "text/plain");
      res.end(image);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  return page.evaluate(async (base) => {
    const d = (await window.decker.snapshot()).document,
      workflow = d.workflows[0],
      key = d.profiles[0].pages[0].keys[2];
    const action = (
      id: string,
      type: string,
      config: Record<string, Json>,
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
      action("http", "http.request", {
        url: base + "/api",
        method: "GET",
        body: "",
        credentialRef: "",
      }),
      action("parse", "data.parseJson", { input: { $ref: "outputs.http" } }),
      action("extract", "data.extract", {
        input: { $ref: "outputs.parse.value" },
        path: "avatar",
      }),
      action("image", "image.fetch", {
        url: { $ref: "outputs.extract.value" },
      }),
      action("update", "deck.appearance", {
        asset: { $ref: "outputs.image.asset" },
        label: { $ref: "outputs.parse.value.name" },
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
      nodes.map((n, i) => [n.id, { x: i * 220, y: 80 }]),
    );
    key.appearance.label = "Authored avatar";
    key.press = { kind: "workflow", workflowId: workflow.id };
    await window.decker.request({ type: "save", document: d });
    return {
      deckId: d.decks[0].id,
      workflowId: workflow.id,
      bindingId: key.id,
    };
  }, base);
}
async function press(deckId: string) {
  await page.evaluate(async (deckId) => {
    await window.decker.request({ type: "press", deckId, key: 2, down: true });
    await window.decker.request({ type: "press", deckId, key: 2, down: false });
  }, deckId);
}
async function status(expected: string) {
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).runs.at(-1)?.status,
      ),
    )
    .toBe(expected);
}

test("saved HTTP → Parse → Extract → Fetch image → Update uses typed outputs and keeps last-good art on failure/restart", async () => {
  const ids = await fixture();
  await press(ids.deckId);
  await status("success");
  const key = page.getByRole("button", {
    name: "Key 3: Local avatar",
    exact: true,
  });
  await expect(key.locator("img")).toHaveAttribute(
    "src",
    /^decker-asset:\/\/[a-f0-9]{64}$/,
  );
  const src = (await key.locator("img").getAttribute("src"))!,
    hash = src.split("//")[1];
  await expect
    .poll(() =>
      key
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
    )
    .toBe(256);
  expect(
    (await sharp(await readFile(join(directory, "assets", hash))).metadata())
      .format,
  ).toBe("png");
  fail = true;
  await press(ids.deckId);
  await status("failure");
  await expect(key.locator("img")).toHaveAttribute("src", src);
  await expect(key.getByRole("status")).toHaveText("Image stale");
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(
    snapshot.document.profiles[0].pages[0].keys[2].appearance,
  ).not.toHaveProperty("asset");
  expect(snapshot.document.profiles[0].pages[0].keys[2].appearance.label).toBe(
    "Authored avatar",
  );
  expect(snapshot.runs.at(-1)?.error).not.toMatch(
    /private-signed-error-body|127\.0\.0\.1/,
  );
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.locator('.react-flow__node[data-id="image"]').click();
  await expect(
    page.getByLabel("Image URL value mode", { exact: true }),
  ).toBeVisible();
  await page.locator('.react-flow__node[data-id="update"]').click();
  await expect(page.getByText(/image \/ asset/).first()).toBeVisible();
  await app.close();
  await launch();
  await expect(
    page
      .getByRole("button", { name: "Key 3: Local avatar", exact: true })
      .locator("img"),
  ).toHaveAttribute("src", src);
  expect((await readdir(join(directory, "assets"))).includes(hash)).toBe(true);
});

test("manual no-origin fetch succeeds, display update fails honestly, and node timeout/worker death abort late asset publication", async () => {
  const ids = await fixture();
  await page.evaluate(async ({ workflowId, deckId }) => {
    await window.decker.request({
      type: "run",
      workflowId,
      inputs: {},
      deckId,
    });
  }, ids);
  await status("failure");
  let snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(
    snapshot.runs.at(-1)?.nodes.find((n) => n.nodeId === "image")?.status,
  ).toBe("success");
  expect(snapshot.runs.at(-1)?.error).toContain("triggering button");
  const edit = async (timeoutMs: number) =>
    page.evaluate(
      async ({ url, timeoutMs }) => {
        const d = (await window.decker.snapshot()).document,
          image = d.workflows[0].graph.nodes.find((n) => n.id === "image")!;
        image.action!.config.url = url;
        image.timeoutMs = timeoutMs;
        await window.decker.request({ type: "save", document: d });
      },
      { url: base + "/slow", timeoutMs },
    );
  await edit(200);
  await press(ids.deckId);
  await status("failure");
  await expect.poll(() => Boolean(slow?.destroyed)).toBe(true);
  slow = undefined;
  await edit(30000);
  await press(ids.deckId);
  await expect.poll(() => Boolean(slow)).toBe(true);
  await app.evaluate(({ app }) => {
    // The utility child is intentionally terminated via its OS PID, as the
    // coordinator has no physical hardware. No production test-only IPC exists.
    const runner = app.getAppMetrics().find((m) => m.name === "Decker runner");
    if (!runner) throw new Error("Runner process missing");
    process.kill(runner.pid, "SIGKILL");
  });
  await status("interrupted");
  await expect.poll(() => Boolean(slow?.destroyed)).toBe(true);
  snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(snapshot.observed.buttonDisplay ?? {}).toEqual({});
  await expect
    .poll(
      async () =>
        (await readdir(join(directory, "assets"))).filter((name) =>
          /^[a-f0-9]{64}$/.test(name),
        ).length,
    )
    .toBe(0);
});
