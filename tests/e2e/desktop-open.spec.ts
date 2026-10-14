import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, directory: string;
type MockHost = {
  calls: string[][];
  path: string;
  cancel: boolean;
  delay: boolean;
  resolve?: (value: { canceled: boolean; filePaths: string[] }) => void;
  pickerCalls: number;
  exported: string;
  options?: unknown;
  error: string;
};
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await app.evaluate(({ shell, dialog }, directory) => {
    const state: MockHost = {
      calls: [],
      path: "/tmp/你好 file.txt",
      cancel: false,
      delay: false,
      pickerCalls: 0,
      exported: `${directory}/workspace.json`,
      error: "",
    };
    (globalThis as unknown as { openHost: MockHost }).openHost = state;
    shell.openExternal = async (url) => {
      state.calls.push(["url", url]);
    };
    shell.openPath = async (path) => {
      state.calls.push(["file", path]);
      return state.error;
    };
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string };
      if (options.title !== "Choose file")
        return { canceled: false, filePaths: [state.exported] };
      state.pickerCalls++;
      state.options = options;
      if (state.delay)
        return new Promise((resolve) => {
          state.resolve = resolve;
        });
      return {
        canceled: state.cancel,
        filePaths: state.cancel ? [] : [state.path],
      };
    }) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: state.exported,
    })) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async () => ({
      response: 2,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
  }, directory);
  return page;
}
async function saved(page: Page) {
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
}
async function host(patch: Partial<MockHost>) {
  await app.evaluate(
    (_electron, patch) =>
      Object.assign(
        (globalThis as unknown as { openHost: MockHost }).openHost,
        patch,
      ),
    patch,
  );
}
async function calls() {
  return app.evaluate(
    () => (globalThis as unknown as { openHost: MockHost }).openHost.calls,
  );
}
async function complete() {
  await app.evaluate(() => {
    const state = (globalThis as unknown as { openHost: MockHost }).openHost;
    state.resolve!({ canceled: false, filePaths: [state.path] });
    state.resolve = undefined;
  });
  // Flush the IPC reply and a renderer frame before asserting no stale write.
  await (
    await app.firstWindow()
  ).evaluate(async () => {
    await window.decker.snapshot();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-open-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

test("distinct libraries, direct and sequence execution, legacy editing, export/import and reload", async () => {
  let page = await launch();
  await expect(
    page.getByRole("button", { name: "Open URL", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open file", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open URL or file", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Key 1: Open browser", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "URL or path", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveValue("desktop.open");
  await page.getByRole("button", { name: "Test action", exact: true }).click();
  await expect.poll(async () => (await calls()).length).toBe(1);
  await page.getByRole("button", { name: "Key 4", exact: true }).click();
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "File path", exact: true }),
  ).toHaveValue("/tmp/你好 file.txt");
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as { openHost: MockHost }).openHost.options,
      ),
    )
    .toEqual({ title: "Choose file", properties: ["openFile"] });
  await host({ cancel: true });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose File path", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "File path", exact: true }),
  ).toHaveValue("/tmp/你好 file.txt");
  await page.getByRole("button", { name: "Test action", exact: true }).click();
  await expect
    .poll(async () => (await calls()).at(-1))
    .toEqual(["file", "/tmp/你好 file.txt"]);
  await page
    .getByRole("combobox", { name: "Assignment", exact: true })
    .selectOption("sequence");
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("desktop.openUrl");
  await page
    .getByRole("textbox", { name: "URL", exact: true })
    .fill("https://example.com/你好");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  const step = page.locator(".sequence-item").nth(1);
  await step
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("desktop.openFile");
  await step
    .getByRole("textbox", { name: "File path", exact: true })
    .fill("relative 你好 file.txt");
  const before = (await calls()).length;
  await page.getByRole("button", { name: "Test action", exact: true }).click();
  await expect.poll(async () => (await calls()).length).toBe(before + 2);
  expect((await calls()).at(-1)![1]).toMatch(/\/relative 你好 file.txt$/);
  await saved(page);
  const document = (await page.evaluate(() => window.decker.snapshot()))
    .document;
  await page.evaluate(() => window.decker.request({ type: "export" }));
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    delete doc.profiles[0].pages[0].keys[3];
    await window.decker.request({ type: "save", document: doc });
  });
  await page.evaluate(() => window.decker.request({ type: "import" }));
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document,
  ).toEqual(document);
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add Open URL node", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Open file node", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Add Open URL or file node",
      exact: true,
    }),
  ).toHaveCount(0);
  await app.close();
  page = await launch();
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document,
  ).toEqual(document);
});

test("workflow bindings resolve normally, cancellation preserves objects, and stale results cannot edit another action", async () => {
  const page = await launch();
  const workflowId = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document,
      flow = doc.workflows[0];
    flow.name = "Bound desktop targets";
    flow.graph = {
      entry: "set",
      nodes: [
        {
          id: "set",
          name: "Data",
          kind: "set",
          config: {
            targets: {
              url: "https://example.com/bound",
              path: "/tmp/绑定 file.txt",
            },
          },
          timeoutMs: 30000,
          retries: 0,
          retrySafe: false,
        },
        ...["desktop.openUrl", "desktop.openFile"].map((type, i) => ({
          id: `open${i}`,
          name: i ? "Bound file" : "Bound URL",
          kind: "action" as const,
          config: {},
          action: {
            type,
            version: 1 as const,
            config: {
              [i ? "path" : "url"]: {
                $ref: `vars.targets.${i ? "path" : "url"}`,
              },
            },
          },
          timeoutMs: 30000,
          retries: 0,
          retrySafe: false,
        })),
      ],
      edges: [
        { id: "a", source: "set", target: "open0", port: "next" },
        { id: "b", source: "open0", target: "open1", port: "next" },
      ],
    };
    await window.decker.request({ type: "save", document: doc });
    return flow.id;
  });
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.locator('.react-flow__node[data-id="open1"]').click();
  await page.getByText("File path advanced JSON", { exact: true }).click();
  const bound = page.getByRole("textbox", {
    name: "File path binding",
    exact: true,
  });
  expect(await bound.inputValue()).toContain("vars.targets.path");
  await host({ cancel: true });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose File path", exact: true }),
  ).toBeEnabled();
  expect(await bound.inputValue()).toContain("vars.targets.path");
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).runs
          .filter((r) => r.workflowId === workflowId)
          .at(-1)?.status,
    )
    .toBe("success");
  expect(await calls()).toEqual([
    ["url", "https://example.com/bound"],
    ["file", "/tmp/绑定 file.txt"],
  ]);
  await host({ cancel: false });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "File path", exact: true }),
  ).toHaveValue("/tmp/你好 file.txt");
  await page
    .getByRole("combobox", { name: "File path value mode", exact: true })
    .selectOption("reference");
  await bound.fill(JSON.stringify({ $ref: "vars.targets.path" }));
  await bound.blur();
  await saved(page);
  await host({ delay: true });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(
          (globalThis as unknown as { openHost: MockHost }).openHost.resolve,
        ),
      ),
    )
    .toBe(true);
  await bound.fill(JSON.stringify({ $ref: "vars.targets.url" }));
  await bound.blur();
  await complete();
  expect(JSON.parse(await bound.inputValue())).toEqual({
    $ref: "vars.targets.url",
  });
  await bound.fill(JSON.stringify({ $ref: "vars.targets.path" }));
  await bound.blur();
  await saved(page);
  await host({ cancel: false, delay: true });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(
          (globalThis as unknown as { openHost: MockHost }).openHost.resolve,
        ),
      ),
    )
    .toBe(true);
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("desktop.openUrl");
  await complete();
  await expect(
    page.getByRole("textbox", { name: "URL", exact: true }),
  ).toHaveValue("https://example.com");
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await page.getByRole("button", { name: "Key 4", exact: true }).click();
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await page.getByRole("button", { name: "Key 5", exact: true }).click();
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await complete();
  await expect(
    page.getByRole("textbox", { name: "File path", exact: true }),
  ).toHaveValue("./file.txt");
  await saved(page);
  const doc = (await page.evaluate(() => window.decker.snapshot())).document;
  expect(doc.profiles[0].pages[0].keys[3].press).toMatchObject({
    action: { config: { path: "./file.txt" } },
  });
  expect(doc.profiles[0].pages[0].keys[4].press).toMatchObject({
    action: { config: { path: "./file.txt" } },
  });
});

test("malformed requests and a second renderer cannot reach the native selector", async () => {
  const page = await launch();
  const error = await page.evaluate(async () => {
    try {
      await window.decker.request({
        type: "pickFile",
        picker: "openFile",
        path: "/etc",
      } as never);
      return "";
    } catch (error) {
      return String(error);
    }
  });
  expect(error).toContain("Error");
  const next = app.waitForEvent("window");
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
  const other = await next;
  await other.waitForFunction(() => Boolean(window.decker));
  const untrusted = await other.evaluate(async () => {
    try {
      await window.decker.request({ type: "pickFile", picker: "openFile" });
      return "";
    } catch (error) {
      return String(error);
    }
  });
  expect(untrusted).toContain("Untrusted sender");
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { openHost: MockHost }).openHost.pickerCalls,
    ),
  ).toBe(0);
});
