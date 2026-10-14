import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeObs } from "../fixtures/obs-server";
let app: ElectronApplication, directory: string;
let logs = "";
const servers: Awaited<ReturnType<typeof fakeObs>>[] = [];
async function server(options?: Parameters<typeof fakeObs>[0]) {
  const s = await fakeObs(options);
  servers.push(s);
  return s;
}
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  app.process().stdout?.on("data", (data) => {
    logs += String(data);
  });
  app.process().stderr?.on("data", (data) => {
    logs += String(data);
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await app.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => false;
  });
  await page.evaluate(async () => {
    const s = await window.decker.snapshot();
    await window.decker.request({ type: "save", document: s.document });
  });
  return page;
}
test.beforeEach(async () => {
  logs = "";
  directory = await mkdtemp(join(tmpdir(), "decker-obs-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await rm(directory, { recursive: true, force: true });
});
const snapshot = (page: Page) => page.evaluate(() => window.decker.snapshot());

test("tests an unsaved draft, saves an inline session password, retests/edits with explicit credentials and discards cancelled drafts", async () => {
  const first = await server({
    password: "synthetic-obs-password",
    echo: "synthetic-obs-password",
  });
  const second = await server({ password: "synthetic-other-password" });
  const page = await launch();
  await page.getByRole("button", { name: "Add OBS" }).click();
  const draft = page.getByRole("group", {
    name: "New OBS connection",
    exact: true,
  });
  await expect(draft).toContainText("Tools → obs-websocket Settings");
  await draft
    .getByLabel("Connection name", { exact: true })
    .fill("Main studio");
  await draft.getByLabel("WebSocket URL", { exact: true }).fill(first.url);
  await draft
    .getByLabel("OBS password entry", { exact: true })
    .fill("synthetic-obs-password");
  await draft
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(draft.getByRole("status")).toContainText(
    "Draft Main studio: Test passed",
  );
  expect((await snapshot(page)).document.connections).toHaveLength(0);
  expect(
    Object.keys((await snapshot(page)).observed).filter((k) =>
      k.startsWith("obs:"),
    ),
  ).toHaveLength(0);
  expect(first.frames.map((f) => f.op)).toEqual([1, 6]);
  expect(first.frames[0].d.eventSubscriptions).toBe(0);
  expect(first.frames[1].d.requestType).toBe("GetVersion");
  await draft
    .getByLabel("Connection name", { exact: true })
    .fill("Live studio");
  await expect(draft.getByRole("status")).toHaveCount(0);
  await draft
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(draft).toHaveCount(0);
  const saved = page.locator(".connection").first();
  await expect(saved.getByRole("status")).toContainText("Session-only");
  await expect(
    saved.getByLabel("OBS password entry", { exact: true }),
  ).toHaveValue("");
  await saved
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(saved.locator(".obs-test-result")).toContainText(
    "Live studio: Test passed",
  );
  await saved.getByRole("button", { name: "Edit connection" }).click();
  const editor = page.getByRole("group", {
    name: "Edit Live studio",
    exact: true,
  });
  await editor.getByLabel("WebSocket URL", { exact: true }).fill(second.url);
  await expect(editor.getByLabel("Password choice")).toHaveValue("supplied");
  await expect(
    editor.getByRole("button", { name: "Test connection", exact: true }),
  ).toBeDisabled();
  expect(second.connections).toBe(0);
  await editor.getByLabel("Password choice").selectOption("stored");
  await editor
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("Test authentication");
  expect((await snapshot(page)).document.connections[0].url).toBe(first.url);
  await editor.getByLabel("Password choice").selectOption("supplied");
  await editor
    .getByLabel("OBS password entry", { exact: true })
    .fill("synthetic-other-password");
  await editor
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("Test passed");
  await editor
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  expect((await snapshot(page)).document.connections[0].url).toBe(second.url);
  await expect(saved.locator(".obs-test-result")).toHaveCount(0);
  await saved
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(saved.locator(".obs-test-result")).toContainText("Test passed");
  const stalled = await server({ stall: true });
  await page.getByRole("button", { name: "Add OBS" }).click();
  await draft.getByLabel("WebSocket URL", { exact: true }).fill(stalled.url);
  await draft.getByLabel("Password choice").selectOption("none");
  await draft
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect.poll(() => stalled.connections).toBe(1);
  await draft.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toHaveCount(0);
  await expect.poll(() => stalled.clients).toBe(0);
  expect((await snapshot(page)).document.connections).toHaveLength(1);
  const serialized = JSON.stringify(await snapshot(page));
  expect(serialized).not.toContain("synthetic-");
  expect(logs).not.toContain("synthetic-");
  for (const file of (await readdir(directory)).filter((f) =>
    f.endsWith(".json"),
  ))
    expect(await readFile(join(directory, file), "utf8")).not.toContain(
      "synthetic-",
    );
  expect(
    [...first.frames, ...second.frames]
      .filter((f) => f.op === 6)
      .every((f) => String(f.d.requestType).startsWith("Get")),
  ).toBe(true);
});

test("named choices disambiguate duplicates in buttons and workflow fields, retain dynamic bindings and show deleted choices", async () => {
  const page = await launch();
  await page.evaluate(async () => {
    const d = (await window.decker.snapshot()).document;
    d.connections = [
      { id: "studio-a", name: "Studio", url: "ws://127.0.0.1:65534" },
      { id: "studio-b", name: "Studio", url: "ws://127.0.0.1:65533" },
    ];
    const action = {
      type: "obs.control",
      version: 1 as const,
      config: {
        connectionId: "",
        operation: "scene",
        name: "Scene",
        enabled: true,
        sourceId: 1,
      },
    };
    d.profiles[0].pages[0].keys[0].press = { kind: "action", action };
    const workflow = d.workflows[0];
    workflow.inputs = ["connection"];
    const node = structuredClone(workflow.graph.nodes[0]);
    node.id = "obs-choice";
    node.kind = "action";
    node.name = "OBS choice";
    node.action = structuredClone(action);
    workflow.graph = { entry: node.id, nodes: [node], edges: [] };
    await window.decker.request({ type: "save", document: d });
  });
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await page
    .getByRole("button", { name: "Key 1: Open browser", exact: true })
    .click();
  const choice = page.getByRole("button", { name: /^OBS connection:/ });
  await choice.click();
  await page.getByRole("option", { name: /Studio \(2\)/ }).click();
  await expect(choice).toHaveText("Studio (2)");
  await expect
    .poll(
      async () =>
        (await snapshot(page)).document.profiles[0].pages[0].keys[0].press,
    )
    .toMatchObject({ action: { config: { connectionId: "studio-b" } } });
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.locator('.react-flow__node[data-id="obs-choice"]').click();
  await choice.click();
  await page.getByRole("option", { name: /Studio \(1\)/ }).click();
  await expect(choice).toHaveText("Studio (1)");
  const mode = page.getByRole("combobox", {
    name: "OBS connection value mode",
    exact: true,
  });
  await mode.selectOption("reference");
  await page.getByRole("button", { name: /^Data for OBS connection:/ }).click();
  await page
    .getByRole("combobox", {
      name: "Search data for OBS connection",
      exact: true,
    })
    .fill("Inputs / connection");
  await page
    .getByRole("combobox", {
      name: "Search data for OBS connection",
      exact: true,
    })
    .press("Enter");
  await page
    .getByRole("button", {
      name: "Insert reference for OBS connection",
      exact: true,
    })
    .click();
  await expect(choice).toHaveCount(0);
  await mode.selectOption("literal");
  await expect(choice).toHaveText("Studio (1)");
  await page.evaluate(async () => {
    const d = (await window.decker.snapshot()).document;
    d.workflows[0].graph.nodes[0].action!.config.connectionId = {
      $ref: "inputs.connection",
      fallback: "studio-b",
    };
    await window.decker.request({ type: "save", document: d });
  });
  await page.getByText("OBS connection advanced JSON", { exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "OBS connection binding", exact: true }),
  ).toHaveValue(/inputs.connection/);
  await expect(choice).toHaveCount(0);
  await page.evaluate(async () => {
    const d = (await window.decker.snapshot()).document;
    d.workflows[0].graph.nodes[0].action!.config.connectionId = "studio-a";
    d.connections = d.connections.filter((c) => c.id !== "studio-a");
    await window.decker.request({ type: "save", document: d });
  });
  await expect(choice).toContainText("Connection unavailable");
  await choice.click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /Studio/ })
    .click();
  await expect(choice).toHaveText("Studio");
});

test("strict desktop tests reject arbitrary secret references and sanitize invalid input; teardown cancels probes", async () => {
  const stalled = await server({ stall: true }),
    page = await launch();
  const results = await page.evaluate(async (url) => {
    const invalid = await window.decker.request({
      type: "obsTest",
      id: crypto.randomUUID(),
      target: {
        kind: "draft",
        url: "ws://user:synthetic-password@localhost:4455",
      },
      credential: { kind: "none" },
    });
    const arbitrary = await window.decker.request({
      type: "obsTest",
      id: crypto.randomUUID(),
      target: { kind: "draft", url },
      credential: { kind: "stored", credentialRef: "managed:foreign" },
    } as never);
    return { invalid, arbitrary };
  }, stalled.url);
  expect(results.invalid).toMatchObject({ status: "invalid-input" });
  expect(results.arbitrary).toMatchObject({ status: "invalid-input" });
  expect(JSON.stringify(results)).not.toContain("synthetic");
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      (globalThis as unknown as { obsHelpUrl: string }).obsHelpUrl = url;
    };
  });
  await page.getByText("OBS setup help", { exact: true }).click();
  await page
    .getByRole("link", { name: "Official OBS remote control guide" })
    .click();
  await expect
    .poll(() =>
      app.evaluate(
        () => (globalThis as unknown as { obsHelpUrl?: string }).obsHelpUrl,
      ),
    )
    .toBe("https://obsproject.com/kb/remote-control-guide");
  const nextWindow = app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }) => {
    const primary = BrowserWindow.getAllWindows()[0];
    const other = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: decodeURIComponent(
          new URL("../preload/index.cjs", primary.webContents.getURL())
            .pathname,
        ),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void other.loadURL(primary.webContents.getURL());
  });
  const other = await nextWindow;
  await other.waitForFunction(() => Boolean(window.decker));
  const untrusted = await other.evaluate(async (url) => {
    try {
      await window.decker.request({
        type: "obsTest",
        id: crypto.randomUUID(),
        target: { kind: "draft", url },
        credential: { kind: "none" },
      });
      return "";
    } catch (error) {
      return String(error);
    }
  }, stalled.url);
  expect(untrusted).toContain("Untrusted sender");
  expect(stalled.connections).toBe(0);
  await page.evaluate((url) => {
    void window.decker.request({
      type: "obsTest",
      id: crypto.randomUUID(),
      target: { kind: "draft", url },
      credential: { kind: "none" },
    });
  }, stalled.url);
  await expect.poll(() => stalled.clients).toBe(1);
  await app.close();
  await expect.poll(() => stalled.clients).toBe(0);
});
