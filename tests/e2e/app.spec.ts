import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, directory: string;
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Everything, a key away." }),
  ).toBeVisible();
  return page;
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
test("edits a key, executes a flow with the editor hidden, and persists accent and assignments", async () => {
  let page = await launch();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByRole("button", { name: /^Key \d/ })).toHaveCount(32);
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).devices.some((d) => d.simulated),
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).observed.hardwareNativeReady,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Key 4", exact: true }).click();
  await page.getByRole("button", { name: "Copy text", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("My shortcut");
  await page
    .getByRole("textbox", { name: "Text", exact: true })
    .fill("End-to-end clipboard");
  await page.getByRole("button", { name: "Test action", exact: true }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("End-to-end clipboard");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Use accent #eb459e", exact: true })
    .click();
  await expect(page.locator("html")).toHaveCSS("--accent", "#eb459e");
  await page.screenshot({ path: "test-results/settings.png", fullPage: true });
  await page.getByRole("button", { name: "Deck", exact: true }).click();
  await page.screenshot({ path: "test-results/deck.png", fullPage: true });
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    )
    .toBe(false);
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).runs
            .filter((r) => r.workflowId === "welcome")
            .at(-1)?.status,
      ),
    )
    .toBe("success");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(page.getByText("Welcome to Decker").first()).toBeVisible();
  expect(errors).toEqual([]);
  await app.close();
  page = await launch();
  await expect(
    page.getByRole("button", { name: "Key 4: My shortcut", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("--accent", "#eb459e");
  const config = await page.evaluate(() => window.decker.snapshot());
  expect(config.document.profiles[0].pages[0].keys[3].press).toMatchObject({
    kind: "action",
    action: { config: { text: "End-to-end clipboard" } },
  });
  expect(
    config.runs.some(
      (r) => r.workflowId === "welcome" && r.status === "success",
    ),
  ).toBe(true);
});
test("creates and runs nested parallel and loop controls", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add Parallel / join node", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit branch 1 →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add Repeat node", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit loop body →", exact: true })
    .click();
  await page.getByRole("button", { name: "Parent flow", exact: true }).click();
  await page.getByRole("button", { name: "Parent flow", exact: true }).click();
  await expect(
    page.getByText("✓ Workflow is ready", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.decker.snapshot()).runs.at(-1)?.status,
      ),
    )
    .toBe("success");
  await page.screenshot({ path: "test-results/flows.png", fullPage: true });
});
test("renderer has no Node access and rejects malformed IPC", async () => {
  const page = await launch();
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { require: unknown }).require,
    ),
  ).toBe("undefined");
  const error = await page.evaluate(async () => {
    try {
      await window.decker.request({ type: "save", document: {} } as never);
      return "";
    } catch (error) {
      return String(error);
    }
  });
  expect(error).toContain("Error");
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      (
        BrowserWindow.getAllWindows()[0].webContents as unknown as {
          getLastWebPreferences(): Electron.WebPreferences;
        }
      ).getLastWebPreferences(),
    ),
  ).toMatchObject({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
});
