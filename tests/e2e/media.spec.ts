import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mediaActions, mediaPlaybackIcons } from "../../src/shared/media";
import { packKeySvg } from "../../src/shared/icons";
import type { Json, Snapshot } from "../../src/shared/schema";

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
  directory = await mkdtemp(join(tmpdir(), "decker-media-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

test("offers six Media tiles in both libraries, keeps legacy editing and persists selected players", async () => {
  let page = await launch();
  const media = page
    .locator(".catalog-group")
    .filter({ has: page.getByRole("heading", { name: "Media", exact: true }) });
  for (const { name } of mediaActions)
    await expect(
      media.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Media control", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Key 4", exact: true }).click();
  await media.getByRole("button", { name: "Play/Pause", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Operation", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", {
      name: "Player bus name (blank: first)",
      exact: true,
    })
    .fill("org.mpris.MediaPlayer2.fixture");
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    const old = structuredClone(doc.profiles[0].pages[0].keys[3]);
    old.id = crypto.randomUUID();
    old.appearance.label = "Legacy media";
    old.appearance.icon = "CUSTOM";
    old.press = {
      kind: "action",
      action: {
        type: "media.control",
        version: 1,
        config: {
          operation: "Previous",
          player: "org.mpris.MediaPlayer2.legacy",
        },
      },
    };
    doc.profiles[0].pages[0].keys[4] = old;
    await window.decker.request({ type: "save", document: doc });
  });
  await page
    .getByRole("button", { name: "Key 5: Legacy media", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveValue("media.control");
  await expect(
    page.getByRole("combobox", { name: "Operation", exact: true }),
  ).toHaveValue("Previous");
  await page
    .getByRole("textbox", {
      name: "Player bus name (blank: first)",
      exact: true,
    })
    .fill("org.mpris.MediaPlayer2.edited");
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  const doc = (await page.evaluate(() => window.decker.snapshot())).document;
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Media", exact: true }),
  ).toBeVisible();
  for (const { name } of mediaActions)
    await expect(
      page.getByRole("button", { name: `Add ${name} node`, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Media control node", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add Play/Pause node", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Player bus name (blank: first)",
      exact: true,
    }),
  ).toBeVisible();
  await app.close();
  page = await launch();
  const reloaded = (await page.evaluate(() => window.decker.snapshot()))
    .document;
  expect(reloaded.profiles).toEqual(doc.profiles);
  expect(reloaded.schemaVersion).toBe(4);
  expect(reloaded.workflowAliases).toEqual(doc.workflowAliases);
});

test("desktop keys follow external observations and clear unknown or disconnected state without changing authored artwork", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Key 4", exact: true }).click();
  await page.getByRole("button", { name: "Play/Pause", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  const snapshotJSON = await page.evaluate(async () =>
    JSON.stringify(await window.decker.snapshot()),
  );
  // Inject observation snapshots at the existing main→renderer boundary.
  // No desktop session, player, hardware or production-only test hook is used.
  type Fixture = { value: Record<string, Json> };
  await app.evaluate(({ BrowserWindow }, snapshotJSON) => {
    const fixture: Fixture = { value: {} };
    (globalThis as unknown as { mediaFixture: Fixture }).mediaFixture = fixture;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel: string, ...args: unknown[]) => {
      if (channel === "decker:snapshot") {
        const s = args[0] as Snapshot;
        args[0] = { ...s, observed: { ...s.observed, media: fixture.value } };
      }
      send(channel, ...args);
    };
    contents.send("decker:snapshot", JSON.parse(snapshotJSON));
  }, snapshotJSON);
  const key = page.getByRole("button", {
    name: "Key 4: Play/Pause",
    exact: true,
  });
  for (const [state, icon] of Object.entries(mediaPlaybackIcons)) {
    const media: Record<string, Json> =
      state === "unavailable"
        ? { unavailable: true }
        : {
            defaultPlayer: "fixture",
            fixture: state === "unknown" ? "Unknown" : state,
          };
    await app.evaluate(
      ({ BrowserWindow }, { mediaJSON, snapshotJSON }) => {
        (
          globalThis as unknown as { mediaFixture: Fixture }
        ).mediaFixture.value = JSON.parse(mediaJSON);
        BrowserWindow.getAllWindows()[0].webContents.send(
          "decker:snapshot",
          JSON.parse(snapshotJSON),
        );
      },
      { mediaJSON: JSON.stringify(media), snapshotJSON },
    );
    const expected = await page.evaluate((svg) => {
      const wrapper = document.createElement("span");
      wrapper.innerHTML = svg;
      return wrapper.innerHTML;
    }, packKeySvg(icon, "Play/Pause")!);
    await expect
      .poll(() => key.locator(".pack-key-visual").innerHTML())
      .toBe(expected);
    await expect(key).toHaveCSS(
      "background-color",
      state === "Playing" ? "rgb(88, 101, 242)" : "rgb(35, 36, 40)",
    );
  }
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document.profiles[0]
      .pages[0].keys[3].appearance.icon,
  ).toBe("pack:lucide:v1:music");
  await page
    .getByRole("textbox", { name: "Icon", exact: true })
    .fill("🎶 CUSTOM");
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await expect(key.locator(".key-symbol")).toHaveText("🎶 CUSTOM");
});
