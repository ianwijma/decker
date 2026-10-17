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

let app: ElectronApplication, directory: string, page: Page;
const peers = ["General", "Web decks", "Diagnostics", "Run history"];
const headings = [
  "Your deck. Your way.",
  "Web decks",
  "Understand your workspace.",
  "A clear view of every run.",
];

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-settings-navigation-"));
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
});

test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

async function expectSelected(name: string) {
  const navigation = page.getByRole("navigation", {
    name: "Settings sections",
  });
  await expect(navigation.getByRole("button")).toHaveText(peers);
  await expect(navigation.locator('[aria-current="page"]')).toHaveText(name);
  await expect(navigation.locator(".active")).toHaveText(name);
  await expect(
    page.getByRole("heading", {
      name: headings[peers.indexOf(name)],
      exact: true,
    }),
  ).toBeVisible();
}

for (const width of [1440, 1000]) {
  test(`four peers support clicks and keyboard navigation at ${width}px`, async () => {
    await app.evaluate(({ BrowserWindow }, width) => {
      BrowserWindow.getAllWindows()[0].setSize(width, 900);
    }, width);
    const navigation = page.getByRole("navigation", {
      name: "Settings sections",
    });
    for (const name of peers) {
      await navigation.getByRole("button", { name, exact: true }).click();
      await expectSelected(name);
      expect(
        await page.evaluate(() =>
          Array.from(
            document.querySelectorAll(
              ".settings-workspace, .settings-screen, .runs-screen",
            ),
          ).every((element) => element.scrollWidth <= element.clientWidth),
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/settings-navigation-${width}-${name.replaceAll(" ", "-")}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await navigation
      .getByRole("button", { name: "General", exact: true })
      .focus();
    for (const [index, name] of peers.entries()) {
      if (index) await page.keyboard.press("Tab");
      const button = navigation.getByRole("button", { name, exact: true });
      await expect(button).toBeFocused();
      await page.keyboard.press(index % 2 ? "Space" : "Enter");
      await expectSelected(name);
    }
    await page.screenshot({
      path: `test-results/settings-navigation-${width}-keyboard-focus.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expectSelected("Diagnostics");
    await page.getByRole("button", { name: "Open run history" }).click();
    await expectSelected("Run history");
  });
}

test("General retains preferences and transfer entry points while decks stay in the rail", async () => {
  await expect(
    page.getByRole("heading", { name: "Devices", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Use accent #eb459e" }).click();
  await expect(page.getByLabel("Accent hex", { exact: true })).toHaveValue(
    "#eb459e",
  );
  await page.getByLabel("Custom accent colour").fill("#3498db");
  await expect(page.getByLabel("Accent hex", { exact: true })).toHaveValue(
    "#3498db",
  );
  for (const name of [
    "Close editor to tray",
    "Start with editor hidden",
    "Launch at login",
  ]) {
    await expect(
      page.getByRole("switch", { name: new RegExp(name) }),
    ).toBeVisible();
  }
  await page.getByLabel("Run history limit", { exact: true }).fill("123");
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).document.settings.historyLimit,
      ),
    )
    .toBe(123);
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add OBS" })).toBeEnabled();
  await page.getByRole("button", { name: "Add OBS" }).click();
  await expect(
    page.getByLabel("OBS password entry", { exact: true }),
  ).toHaveAttribute("type", "password");
  await expect(
    page.getByRole("button", { name: "Save connection", exact: true }),
  ).toBeDisabled();

  // Exercise both entry points without opening a native dialog or importing data.
  await app.evaluate(({ ipcMain }) => {
    const context = globalThis as unknown as { settingsTransfers: string[] };
    context.settingsTransfers = [];
    ipcMain.removeHandler("decker:request");
    ipcMain.handle("decker:request", (_event, request) => {
      context.settingsTransfers.push(request.type);
      return null;
    });
  });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("button", { name: "Export workspace" }).click();
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { settingsTransfers: string[] })
          .settingsTransfers,
    ),
  ).toEqual(["import", "export"]);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: /^Deck: / })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Deck settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Deck settings" }),
  ).toBeVisible();
  await expect(page.getByLabel("Deck name", { exact: true })).toBeEditable();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectSelected("General");
});

test("Web decks retains sharing and pairing approval controls", async () => {
  const fixture = await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot();
    snapshot.web.pending = [
      {
        id: "settings-test-pairing",
        deckId: snapshot.document.decks[0].id,
        name: "Test browser",
        code: "123456",
        expiresAt: Date.now() + 60000,
      },
    ];
    return snapshot;
  });
  // Inject browser evidence at IPC; never contact another browser or real device.
  await app.evaluate(({ BrowserWindow, ipcMain }, serialized) => {
    const context = globalThis as unknown as { settingsApprovals: unknown[] };
    context.settingsApprovals = [];
    const snapshot = JSON.parse(serialized);
    // Own both read and publication paths: a late startup/worker snapshot must
    // not replace synthetic pairing evidence while these controls are exercised.
    ipcMain.removeHandler("decker:snapshot");
    ipcMain.handle("decker:snapshot", () => snapshot);
    ipcMain.removeHandler("decker:request");
    ipcMain.handle("decker:request", (_event, request) => {
      context.settingsApprovals.push(request);
      return null;
    });
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
      if (channel === "decker:snapshot") send(channel, snapshot);
      else send(channel, ...args);
    };
    send("decker:snapshot", snapshot);
  }, JSON.stringify(fixture));
  expect(
    await page.evaluate(async () =>
      (await window.decker.snapshot()).web.pending.map((p) => p.code),
    ),
  ).toEqual(["123456"]);
  await page.getByRole("button", { name: "Web decks", exact: true }).click();
  await expectSelected("Web decks");
  await expect(
    page.getByRole("switch", { name: "Enable local web decks" }),
  ).toBeEnabled();
  await expect(page.getByLabel("Local port", { exact: true })).toBeEditable();
  await expect(
    page.getByRole("heading", { name: "Paired browsers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("123456", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page
    .getByRole("button", { name: "Approve browser", exact: true })
    .click();
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { settingsApprovals: unknown[] })
          .settingsApprovals,
    ),
  ).toEqual([
    {
      type: "approvePairing",
      pairingId: "settings-test-pairing",
      approved: false,
    },
    {
      type: "approvePairing",
      pairingId: "settings-test-pairing",
      approved: true,
    },
  ]);
});
