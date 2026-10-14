import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord, Snapshot } from "../../src/shared/schema";
type HiddenRunFixture = { runs: RunRecord[]; restore: () => void };
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
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
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
  const welcomeId = (await page.evaluate(() => window.decker.snapshot()))
    .document.workflows[0].id;
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
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await page.screenshot({ path: "test-results/deck.png", fullPage: true });
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  // Hidden Chromium renderers can throttle IPC promise delivery. Observe the
  // real main-to-renderer snapshots from main so this assertion proves the
  // runner finishes while the editor is hidden without relying on that editor.
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    const fixture: HiddenRunFixture = {
      runs: [],
      restore: () => {
        contents.send = send;
      },
    };
    (
      globalThis as unknown as { hiddenRunFixture: HiddenRunFixture }
    ).hiddenRunFixture = fixture;
    contents.send = (channel, ...args) => {
      if (channel === "decker:snapshot")
        fixture.runs = (args[0] as Snapshot).runs;
      send(channel, ...args);
    };
  });
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
    .poll(() =>
      app.evaluate(
        (_, id) =>
          (
            globalThis as unknown as { hiddenRunFixture: HiddenRunFixture }
          ).hiddenRunFixture.runs
            .filter((r) => r.workflowId === id)
            .at(-1)?.status,
        welcomeId,
      ),
    )
    .toBe("success");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  await app.evaluate(() =>
    (
      globalThis as unknown as { hiddenRunFixture: HiddenRunFixture }
    ).hiddenRunFixture.restore(),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await page
    .getByRole("button", { name: "Open run history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Decker", exact: true }),
  ).toBeVisible();
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
      (r) => r.workflowId === welcomeId && r.status === "success",
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

test("creates independent decks, changes icons, and preserves assignments when resized", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Add deck", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stream Deck", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Web deck", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Deck name", exact: true })
    .fill("Tablet");
  await page.getByRole("spinbutton", { name: "Rows", exact: true }).fill("2");
  await page
    .getByRole("spinbutton", { name: "Columns", exact: true })
    .fill("3");
  await page
    .getByRole("button", { name: "Create web deck", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Deck: Tablet", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Key \d/ })).toHaveCount(6);
  await page.getByRole("button", { name: "Key 6", exact: true }).click();
  await page.getByRole("button", { name: "Copy text", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Preserved");
  await page
    .getByRole("button", { name: "Deck settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Deck icon 🚀", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Rows", exact: true }).fill("1");
  await page
    .getByRole("spinbutton", { name: "Columns", exact: true })
    .fill("2");
  await expect(page.getByText(/1 assignments will be outside/)).toBeVisible();
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Key \d/ })).toHaveCount(2);
  await page
    .getByRole("button", { name: "Deck settings", exact: true })
    .click();
  await page.getByRole("spinbutton", { name: "Rows", exact: true }).fill("2");
  await page
    .getByRole("spinbutton", { name: "Columns", exact: true })
    .fill("3");
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Key 6: Preserved", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Key 1: Open browser", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Key \d/ })).toHaveCount(32);
  const doc = (await page.evaluate(() => window.decker.snapshot())).document;
  expect(doc.decks.find((d) => d.name === "Tablet")!.icon).toBe("🚀");
  expect(doc.decks[0].activePageId).toBe("home");
  await page.screenshot({
    path: "test-results/multi-deck.png",
    fullPage: true,
  });
});

test("pairs a phone-sized browser, executes on the host, isolates navigation, and revokes access", async () => {
  const page = await launch();
  await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot();
    snapshot.document.settings.webPort = 0;
    await window.decker.request({ type: "save", document: snapshot.document });
  });
  await page.getByRole("button", { name: "Add deck", exact: true }).click();
  await page.getByRole("button", { name: "Web deck", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Deck name", exact: true })
    .fill("Phone");
  await page.getByRole("spinbutton", { name: "Rows", exact: true }).fill("2");
  await page
    .getByRole("spinbutton", { name: "Columns", exact: true })
    .fill("3");
  await page
    .getByRole("button", { name: "Create web deck", exact: true })
    .click();
  await page.getByRole("button", { name: "Key 1", exact: true }).click();
  await page.getByRole("button", { name: "Copy text", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Browser copy");
  await page
    .getByRole("textbox", { name: "Text", exact: true })
    .fill("From my phone");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).web.running,
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Connect browser", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Network address", exact: true })
    .selectOption("0");
  const link = await page
    .getByRole("textbox", { name: "Pairing link", exact: true })
    .inputValue();
  const next = app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }, url) => {
    const browser = new BrowserWindow({
      width: 390,
      height: 844,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void browser.loadURL(url);
  }, link);
  const phone = await next;
  await phone
    .getByRole("textbox", { name: "Browser name", exact: true })
    .fill("Test phone");
  await phone
    .getByRole("button", { name: "Request pairing", exact: true })
    .click();
  await expect(
    phone.getByText("Approve on your computer", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Approve browser", exact: true })
    .click();
  await expect(phone.getByText("Connected", { exact: true })).toBeVisible();
  await expect(phone.getByRole("button")).toHaveCount(6);
  await phone
    .getByRole("button", { name: "Browser copy", exact: true })
    .click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("From my phone");
  await phone.screenshot({
    path: "test-results/web-phone.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot(),
      deck = snapshot.document.decks.find((d) => d.name === "Phone")!,
      profile = snapshot.document.profiles.find(
        (p) => p.id === deck.activeProfileId,
      )!;
    profile.pages[0].keys[0].release = {
      kind: "action",
      action: {
        type: "desktop.copy",
        version: 1,
        config: { text: "Original release" },
      },
    };
    profile.pages.push({ id: "phone-folder", name: "Phone folder", keys: {} });
    profile.pages[0].keys[1] = {
      ...profile.pages[0].keys[0],
      id: "folder-button",
      appearance: {
        ...profile.pages[0].keys[0].appearance,
        label: "Phone folder",
      },
      press: {
        kind: "action",
        action: {
          type: "deck.page",
          version: 1,
          config: { pageId: "phone-folder" },
        },
      },
    };
    await window.decker.request({ type: "save", document: snapshot.document });
  });
  await expect(
    phone.getByRole("button", { name: "Phone folder", exact: true }),
  ).toBeVisible();
  const box = await phone
    .getByRole("button", { name: "Browser copy", exact: true })
    .boundingBox();
  await phone.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await phone.mouse.down();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("From my phone");
  await page.evaluate(async () => {
    const s = await window.decker.snapshot(),
      deck = s.document.decks.find((d) => d.name === "Phone")!;
    await window.decker.request({
      type: "navigate",
      deckId: deck.id,
      profileId: deck.activeProfileId,
      pageId: "phone-folder",
    });
  });
  await expect(phone.getByText("Phone folder", { exact: true })).toBeVisible();
  await phone.mouse.up();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("Original release");
  await page.evaluate(async () => {
    const s = await window.decker.snapshot(),
      deck = s.document.decks.find((d) => d.name === "Phone")!,
      profile = s.document.profiles.find((p) => p.id === deck.activeProfileId)!;
    await window.decker.request({
      type: "navigate",
      deckId: deck.id,
      profileId: profile.id,
      pageId: profile.pages[0].id,
    });
  });
  await expect(
    phone.getByRole("button", { name: "Phone folder", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await phone
    .getByRole("button", { name: "Phone folder", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() => window.decker.snapshot())
        ).document.decks.find((d) => d.name === "Phone")!.activePageId,
    )
    .toBe("phone-folder");
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document.decks[0]
      .activePageId,
  ).toBe("home");
  await expect(phone.getByText("Phone folder", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Web decks", exact: true }).click();
  await expect(page.getByText("Test phone", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(
    phone.getByText("Pairing revoked · open a new pairing link", {
      exact: true,
    }),
  ).toBeVisible();
});
