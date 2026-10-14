import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { packKeySvg } from "../../src/shared/icons";

let app: ElectronApplication, directory: string;
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  return page;
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-icons-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
async function saved(page: Page) {
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
}
async function choose(page: Page, query: string, name: string) {
  await page.getByRole("button", { name: /^Lucide icon:/ }).click();
  const search = page.getByRole("combobox", { name: "Search Lucide icons" });
  await expect(search).toBeFocused();
  await search.fill(query);
  await page.getByRole("option", { name, exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Lucide icon: ${name}`, exact: true }),
  ).toBeFocused();
  await saved(page);
}
async function upload(page: Page) {
  const path = join(directory, "upload.png");
  await sharp({
    create: { width: 96, height: 96, channels: 3, background: "#f04020" },
  })
    .png()
    .toFile(path);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await page
    .getByRole("button", { name: "Choose image…", exact: true })
    .click();
  await saved(page);
  await expect(page.locator(".selected-key-preview img")).toBeVisible();
  return (await page.evaluate(() => window.decker.snapshot())).document
    .profiles[0].pages[0].keys[0].appearance.asset!;
}

test("searches and selects by keyboard; switches images, pack, custom text and clear; copies, exports/imports and reloads", async () => {
  let page = await launch();
  await page
    .getByRole("button", { name: "Key 1: Open browser", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Camera");
  await saved(page);
  const asset = await upload(page);
  await choose(page, "photo", "Camera");
  await expect(page.locator(".selected-key-preview img")).toHaveCount(0);
  await expect(
    page.locator(".selected-key-preview .pack-key-visual"),
  ).toBeVisible();
  const preview = await page
    .locator(".selected-key-preview .pack-key-visual")
    .innerHTML();
  expect(preview).toBe(
    await page
      .locator(".deck-key")
      .first()
      .locator(".pack-key-visual")
      .innerHTML(),
  );
  expect(preview).toContain('viewBox="0 0 100 100"');
  await expect(
    page.locator(".selected-key-preview .pack-key-visual text"),
  ).toHaveText("Camera");
  await page
    .getByRole("button", { name: "Lucide icon: Camera", exact: true })
    .click();
  const search = page.getByRole("combobox", { name: "Search Lucide icons" });
  await search.fill("zz-no-icons");
  await expect(
    page.getByText("No icons match your search.", { exact: true }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(
    page.getByRole("button", { name: "Lucide icon: Camera", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Lucide icon: Camera", exact: true })
    .click();
  await search.fill("microphone");
  await search.press("Home");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(
    page.getByRole("button", { name: "Lucide icon: Mic Off", exact: true }),
  ).toBeFocused();
  await choose(page, "photo", "Camera");
  await page.screenshot({
    path: "test-results/lucide-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Lucide icon: Camera", exact: true })
    .click();
  await search.fill("audio");
  await page.screenshot({
    path: "test-results/lucide-picker.png",
    fullPage: true,
  });
  await search.press("Escape");
  await page.getByRole("button", { name: "Copy key", exact: true }).click();
  await page.getByRole("button", { name: "Key 4", exact: true }).click();
  await page.getByRole("button", { name: "Paste key", exact: true }).click();
  await saved(page);
  await expect(
    page.getByRole("button", { name: "Lucide icon: Camera", exact: true }),
  ).toBeVisible();
  const exportPath = join(directory, "workspace.json");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await page.evaluate(() => window.decker.request({ type: "export" }));
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  expect(exported.document.profiles[0].pages[0].keys[3].appearance.icon).toBe(
    "pack:lucide:v1:camera",
  );
  await page.getByRole("button", { name: "Clear icon", exact: true }).click();
  await saved(page);
  await expect(
    page.getByRole("button", { name: "Lucide icon: None", exact: true }),
  ).toBeVisible();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
    dialog.showMessageBox = async () => ({
      response: 2,
      checkboxChecked: false,
    });
  }, exportPath);
  await page.evaluate(() => window.decker.request({ type: "import" }));
  await expect(
    page.getByRole("button", { name: "Lucide icon: Camera", exact: true }),
  ).toBeVisible();
  await saved(page);
  await app.close();
  page = await launch();
  await page
    .getByRole("button", { name: "Key 4: Camera", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lucide icon: Camera", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Icon", exact: true }).fill("🚀 TXT");
  await saved(page);
  await expect(page.locator(".selected-key-preview .key-symbol")).toHaveText(
    "🚀 TXT",
  );
  await page
    .getByRole("button", { name: "Key 1: Camera", exact: true })
    .click();
  await upload(page);
  await expect(
    page.locator(".selected-key-preview .pack-key-visual"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Remove image", exact: true }).click();
  await saved(page);
  await expect(
    page.locator(".selected-key-preview .pack-key-visual"),
  ).toBeVisible();
  await upload(page);
  await page.getByRole("textbox", { name: "Icon", exact: true }).fill("📷");
  await saved(page);
  await expect(page.locator(".selected-key-preview img")).toHaveCount(0);
  await expect(page.locator(".selected-key-preview .key-symbol")).toHaveText(
    "📷",
  );
  expect(await readFile(join(directory, "assets", asset))).toBeTruthy();
});

test("authenticated web initial render and same-page updates share geometry, preserve asset scoping and activity", async () => {
  const page = await launch();
  const asset = await upload(page);
  const deckId = await page.evaluate(async (asset) => {
    let s = await window.decker.snapshot();
    s.document.settings.webPort = 0;
    s.document.workflows[0].graph.nodes.find(
      (n) => n.kind === "delay",
    )!.config.ms = 8000;
    await window.decker.request({ type: "save", document: s.document });
    await window.decker.request({
      type: "addDeck",
      kind: "web",
      name: "Icon web",
      rows: 2,
      columns: 3,
      icon: "▦",
    });
    s = await window.decker.snapshot();
    const deck = s.document.decks.find((d) => d.name === "Icon web")!,
      profile = s.document.profiles.find((p) => p.id === deck.activeProfileId)!;
    const original = s.document.profiles[0].pages[0].keys[2];
    profile.pages[0].keys[0] = {
      ...structuredClone(original),
      id: crypto.randomUUID(),
      appearance: {
        ...original.appearance,
        icon: "pack:lucide:v1:camera",
        label: "Camera",
        background: "#123456",
        asset: undefined,
      },
    };
    profile.pages[0].keys[1] = {
      ...structuredClone(original),
      id: crypto.randomUUID(),
      appearance: {
        ...original.appearance,
        icon: "pack:lucide:v1:camera",
        label: "Image",
        asset,
      },
    };
    await window.decker.request({ type: "save", document: s.document });
    return deck.id;
  }, asset);
  await page
    .getByRole("button", { name: "Deck: Icon web", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).web.running,
    )
    .toBe(true);
  const invite = (await page.evaluate(
    (deckId) => window.decker.request({ type: "invite", deckId }),
    deckId,
  )) as { urls: string[] };
  const link = invite.urls.find((url) => url.includes("127.0.0.1"))!;
  const nextWindow = app.waitForEvent("window");
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
  const phone = await nextWindow;
  await phone
    .getByRole("button", { name: "Request pairing", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).web.pending
          .length,
    )
    .toBe(1);
  await page.evaluate(async () => {
    const pending = (await window.decker.snapshot()).web.pending[0];
    await window.decker.request({
      type: "approvePairing",
      pairingId: pending.id,
      approved: true,
    });
  });
  await expect(phone.getByText("Connected", { exact: true })).toBeVisible();
  const webKey = phone.locator('.key[data-key="0"]');
  await expect(webKey.locator(".pack-key-visual")).toBeVisible();
  expect(await webKey.locator(".pack-key-visual").innerHTML()).toBe(
    await page
      .locator(".deck-key")
      .first()
      .locator(".pack-key-visual")
      .innerHTML(),
  );
  await expect(webKey).toHaveCSS("background-color", "rgb(18, 52, 86)");
  await expect(phone.locator('.key[data-key="1"] img')).toBeVisible();
  expect(
    await phone.evaluate(
      async ({ asset, deckId }) => [
        (await fetch(`/key-assets/${asset}?deck=${encodeURIComponent(deckId)}`))
          .status,
        (await fetch(`/key-assets/${asset}?deck=simulator-xl`)).status,
        (
          await fetch(
            `/key-assets/${"f".repeat(64)}?deck=${encodeURIComponent(deckId)}`,
          )
        ).status,
      ],
      { asset, deckId },
    ),
  ).toEqual([200, 403, 403]);
  await phone.reload();
  await expect(webKey.locator(".pack-key-visual")).toBeVisible();
  await phone.screenshot({
    path: "test-results/lucide-web.png",
    fullPage: true,
  });
  await webKey.click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).runs.at(-1)
          ?.status,
    )
    .toBe("running");
  const runId = (await page.evaluate(() => window.decker.snapshot())).runs.at(
    -1,
  )!.id;
  await choose(page, "microphone mute", "Mic Off");
  await expect(webKey.locator(".pack-key-visual path").first()).toHaveAttribute(
    "d",
    "M18.89 13.23A7.12 7.12 0 0 0 19 12v-2",
  );
  // Existing generation checks decide whether old run feedback applies; the
  // icon editor must leave the actual run and its original binding untouched.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).runs.find(
          (r) => r.id === runId,
        )?.status,
      { timeout: 15000 },
    )
    .toBe("success");
  await page.getByRole("textbox", { name: "Icon", exact: true }).fill("🚀");
  await saved(page);
  await expect(webKey.locator(".symbol")).toHaveText("🚀");
  await page
    .getByRole("textbox", { name: "Icon", exact: true })
    .fill("pack:lucide:v99:missing");
  await saved(page);
  await expect(
    page.getByRole("button", {
      name: "Lucide icon: Unavailable icon",
      exact: true,
    }),
  ).toBeVisible();
  await expect(webKey.locator(".pack-key-visual circle")).toHaveAttribute(
    "r",
    "10",
  );
  await expect(webKey).not.toContainText("pack:");
  expect(packKeySvg("pack:lucide:v99:missing", "Camera")).toContain('r="10"');
});
