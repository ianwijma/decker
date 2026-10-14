import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication,
  page: Page,
  directory: string,
  server: Server | undefined;
type PickerFixture = typeof globalThis & {
  filePicker: {
    path: string;
    cancel: boolean;
    delayed: boolean;
    calls: string[];
    resolve?: (result: { canceled: boolean; filePath: string }) => void;
  };
};
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await app.evaluate(
    ({ dialog }, path) => {
      const fixture: PickerFixture["filePicker"] = {
        path,
        cancel: false,
        delayed: false,
        calls: [],
      };
      (globalThis as PickerFixture).filePicker = fixture;
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        fixture.calls.push((args.at(-1) as { title: string }).title);
        if (fixture.delayed)
          return new Promise((resolve) => {
            fixture.resolve = resolve;
          });
        return { canceled: fixture.cancel, filePath: fixture.path };
      }) as typeof dialog.showSaveDialog;
      dialog.showOpenDialog = (async () => {
        fixture.calls.push("open");
        return { canceled: fixture.cancel, filePaths: [fixture.path] };
      }) as typeof dialog.showOpenDialog;
    },
    join(directory, "new 你好.txt"),
  );
}
async function patchPicker(patch: Partial<PickerFixture["filePicker"]>) {
  await app.evaluate(
    (_electron, patch) =>
      Object.assign((globalThis as PickerFixture).filePicker, patch),
    patch,
  );
}
async function completePicker() {
  await app.evaluate(() => {
    const f = (globalThis as PickerFixture).filePicker;
    f.resolve!({ canceled: false, filePath: f.path });
    f.resolve = undefined;
  });
  await page.evaluate(async () => {
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  });
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-files-e2e-"));
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

test("discovers all file actions, uses open/save destinations, preserves cancellation and ignores edited/navigated chooser completions", async () => {
  await page.getByRole("button", { name: "Key 4", exact: true }).click();
  for (const name of ["Read text file", "Write text file", "Append text file"])
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Write text file", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  const path = page.getByRole("textbox", { name: "File path", exact: true });
  await expect(path).toHaveValue(join(directory, "new 你好.txt"));
  await expect(
    page.getByRole("textbox", { name: "Content", exact: true }),
  ).toHaveAttribute("rows", "3");
  await patchPicker({ cancel: true });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose File path", exact: true }),
  ).toBeEnabled();
  await expect(path).toHaveValue(join(directory, "new 你好.txt"));
  await patchPicker({ cancel: false, delayed: true });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await path.fill(join(directory, "manual.txt"));
  await completePicker();
  await expect(path).toHaveValue(join(directory, "manual.txt"));
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await page.getByRole("button", { name: "Key 5", exact: true }).click();
  await page
    .getByRole("button", { name: "Append text file", exact: true })
    .click();
  await completePicker();
  await expect(
    page.getByRole("textbox", { name: "File path", exact: true }),
  ).toHaveValue("");
  await patchPicker({ delayed: false });
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "File path", exact: true }),
  ).toHaveValue(join(directory, "new 你好.txt"));
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("file.readText");
  await page
    .getByRole("button", { name: "Choose File path", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "File path", exact: true }),
  ).toHaveValue(join(directory, "new 你好.txt"));
  expect(
    await app.evaluate(() => (globalThis as PickerFixture).filePicker.calls),
  ).toEqual([...Array(5).fill("Choose text file destination"), "open"]);
});

test("runs HTTP → Parse JSON → Extract → Write → Read → Append with typed templates and persisted schema-v3 configuration", async () => {
  server = createServer((_req, res) =>
    res.end(
      JSON.stringify({ message: "你好 🌏", count: 0, ok: false, directory }),
    ),
  );
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const destination = join(directory, "workflow 你好.txt");
  const id = await page.evaluate(
    async ({ url, destination }) => {
      const document = (await window.decker.snapshot()).document;
      const workflow = document.workflows[0];
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
        step("parse", "data.parseJson", {
          input: { $ref: ["outputs", "http"] },
        }),
        step("extract", "data.extract", {
          input: { $ref: ["outputs", "parse", "value"] },
          path: ["message"],
        }),
        step("write", "file.writeText", {
          path: {
            $template: [
              { $ref: ["outputs", "parse", "value", "directory"] },
              "/workflow 你好.txt",
            ],
          },
          content: { $ref: ["outputs", "extract", "value"] },
          createParents: false,
        }),
        step("read", "file.readText", { path: destination }),
        step("append", "file.appendText", {
          path: destination,
          content: {
            $template: [
              "\nRead ",
              { $ref: ["outputs", "read", "bytes"] },
              " bytes: ",
              { $ref: ["outputs", "read", "text"] },
              " / ",
              { $ref: ["outputs", "parse", "value", "count"] },
              " / ",
              { $ref: ["outputs", "parse", "value", "ok"] },
            ],
          },
          createParents: false,
        }),
      ];
      workflow.name = "Text file fixture";
      workflow.graph = {
        entry: "http",
        nodes,
        edges: nodes.slice(1).map((n, i) => ({
          id: `e${i}`,
          source: nodes[i].id,
          target: n.id,
          port: "next",
        })),
      };
      workflow.layout = Object.fromEntries(
        nodes.map((n, i) => [n.id, { x: 30 + i * 210, y: 100 }]),
      );
      await window.decker.request({ type: "save", document });
      return workflow.id;
    },
    { url, destination },
  );
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  for (const name of [
    "Read text file",
    "Write text file",
    "Append text file",
  ]) {
    await page.getByRole("textbox", { name: "Search nodes" }).fill(name);
    await expect(
      page.getByRole("button", { name: `Add ${name} node`, exact: true }),
    ).toBeVisible();
  }
  await page.locator('.react-flow__node[data-id="append"]').click();
  await expect(
    page.getByRole("combobox", { name: "Content value mode", exact: true }),
  ).toHaveValue("template");
  await page
    .getByRole("button", { name: /^Data for Content segment 2:/ })
    .click();
  await page
    .getByRole("combobox", {
      name: "Search data for Content segment 2",
      exact: true,
    })
    .fill("read / bytes");
  await expect(
    page.getByRole("option", { name: /read \/ bytes/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await app.close();
  await launch();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).runs
          .filter((r) => r.workflowId === id)
          .at(-1)?.status,
    )
    .toBe("success");
  const bytes = Buffer.byteLength("你好 🌏");
  expect(await readFile(destination, "utf8")).toBe(
    `你好 🌏\nRead ${bytes} bytes: 你好 🌏 / 0 / false`,
  );
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(snapshot.document.schemaVersion).toBe(3);
  const records = snapshot.runs
    .filter((r) => r.workflowId === id)
    .at(-1)!.nodes;
  expect(records.find((n) => n.nodeId === "read")?.output).toEqual({
    text: "你好 🌏",
    bytes,
    truncated: false,
  });
  expect(records.find((n) => n.nodeId === "append")?.output).toMatchObject({
    operation: "append",
    created: false,
  });
});

test("rejects destination-picker requests from a second renderer", async () => {
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
  expect(
    await other.evaluate(async () => {
      try {
        await window.decker.request({ type: "pickFile", picker: "saveFile" });
        return "";
      } catch (error) {
        return String(error);
      }
    }),
  ).toContain("Untrusted sender");
  expect(
    await app.evaluate(() => (globalThis as PickerFixture).filePicker.calls),
  ).toEqual([]);
});
