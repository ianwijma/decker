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
import type { DeviceStatus, Request, Snapshot } from "../../src/shared/schema";

let app: ElectronApplication, directory: string, page: Page;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-home-"));
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Your workspace at a glance." }),
  ).toBeVisible();
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

function device(id: string, patch: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    id,
    name: id,
    present: true,
    configured: false,
    connected: false,
    state: "discovered",
    simulated: false,
    rows: 4,
    columns: 8,
    iconSize: 96,
    updatedAt: 1,
    ...patch,
  };
}
async function baseFixture() {
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  snapshot.health = undefined;
  snapshot.capabilities = [];
  snapshot.observed = {};
  snapshot.devices = [];
  snapshot.web = {
    running: false,
    port: 9018,
    urls: [],
    clients: [],
    pending: [],
  };
  return snapshot;
}
type FixtureContext = {
  homeSend?: (channel: string, ...args: unknown[]) => void;
  homeSnapshot: Snapshot;
  homeRequests: Request[];
  emitHome: (json: string) => void;
};
// Stub requests and session evidence together. All synthetic hardware remains
// at the IPC boundary; none is passed to a physical driver.
async function installFixture(snapshot: Snapshot) {
  await app.evaluate(({ BrowserWindow, ipcMain }, json) => {
    const context = globalThis as unknown as FixtureContext;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = context.homeSend ?? contents.send.bind(contents);
    context.homeSend = send;
    contents.send = (channel, ...args) => {
      if (channel !== "decker:snapshot") send(channel, ...args);
    };
    context.homeRequests = [];
    context.emitHome = (json) => {
      context.homeSnapshot = JSON.parse(json);
      send("decker:snapshot", context.homeSnapshot);
    };
    context.emitHome(json);
    ipcMain.removeHandler("decker:snapshot");
    ipcMain.handle("decker:snapshot", () => context.homeSnapshot);
    ipcMain.removeHandler("decker:request");
    ipcMain.handle("decker:request", (_event, request: Request) => {
      context.homeRequests.push(request);
      const snapshot = context.homeSnapshot;
      if (request.type === "selectDeck")
        snapshot.document.activeDeckId = request.deckId;
      if (request.type === "retryDevice") {
        const device = snapshot.devices.find(
          (device) => device.id === request.hardwareId,
        )!;
        Object.assign(device, {
          state: "ready",
          connected: true,
          error: undefined,
          errorDetails: undefined,
        });
        snapshot.health = undefined;
      }
      if (request.type === "save") snapshot.document = request.document;
      if (request.type === "addDeck") {
        if (request.kind !== "hardware")
          throw new Error("Unexpected fixture request");
        const device = snapshot.devices.find(
          (device) =>
            device.id === request.hardwareId &&
            device.present &&
            !device.configured,
        );
        if (!device || device.id.startsWith("session:"))
          throw new Error("Unavailable device");
        device.configured = true;
        device.state = "opening";
        const id = `deck-${device.id}`,
          profileId = `profile-${device.id}`,
          pageId = `page-${device.id}`;
        snapshot.document.profiles.push({
          id: profileId,
          name: "Default",
          pages: [{ id: pageId, name: "Home", keys: {} }],
        });
        snapshot.document.decks.push({
          id,
          name: request.name,
          kind: "hardware",
          hardwareId: device.id,
          icon: request.icon,
          rows: device.rows,
          columns: device.columns,
          brightness: 70,
          profileIds: [profileId],
          activeProfileId: profileId,
          activePageId: pageId,
        });
        snapshot.document.activeDeckId = id;
      }
      send("decker:snapshot", snapshot);
      return snapshot;
    });
  }, JSON.stringify(snapshot));
}
async function emit(snapshot: Snapshot) {
  await app.evaluate(
    (_electron, json) =>
      (globalThis as unknown as FixtureContext).emitHome(json),
    JSON.stringify(snapshot),
  );
}
async function requests() {
  return app.evaluate(
    () => (globalThis as unknown as FixtureContext).homeRequests,
  );
}
const homeButton = () =>
  page.getByRole("button", { name: "Decker home", exact: true });

test("a delayed startup snapshot cannot overwrite a newer live overview", async () => {
  const stale = await baseFixture();
  await app.evaluate(({ ipcMain, BrowserWindow }, json) => {
    const context = globalThis as unknown as FixtureContext & {
      initialReplies: (() => void)[];
    };
    // Quiesce real publications before reloading, so only the deliberate newer
    // event and delayed stale reply participate in the startup ordering test.
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    context.homeSend = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
      if (channel !== "decker:snapshot") context.homeSend!(channel, ...args);
    };
    context.initialReplies = [];
    ipcMain.removeHandler("decker:snapshot");
    ipcMain.handle(
      "decker:snapshot",
      () =>
        new Promise((resolve) => {
          context.initialReplies.push(() => resolve(JSON.parse(json)));
        }),
    );
  }, JSON.stringify(stale));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as { initialReplies: (() => void)[] })
            .initialReplies.length,
      ),
    )
    .toBeGreaterThan(0);
  const latest = structuredClone(stale);
  latest.document.decks[0].name = "Latest workspace";
  await installFixture(latest);
  const deck = page.getByRole("article", {
    name: "Deck overview: Latest workspace",
  });
  await expect(deck).toBeVisible();
  await app.evaluate(() => {
    const context = globalThis as unknown as { initialReplies: (() => void)[] };
    context.initialReplies.splice(0).forEach((reply) => reply());
  });
  // This IPC round trip runs after the delayed replies have been delivered.
  await page.evaluate(() => window.decker.snapshot());
  await expect(deck).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Deck overview: My XL" }),
  ).toHaveCount(0);
});

test("generic Add deck from Home still creates simulator and web decks through real IPC", async () => {
  for (const [kind, name, create] of [
    ["Simulator", "Software test", "Create simulator"],
    ["Web deck", "Browser test", "Create web deck"],
  ]) {
    await homeButton().click();
    await page
      .getByRole("main")
      .getByRole("button", { name: "Add deck", exact: true })
      .click();
    const modal = page.getByRole("dialog", { name: "Add deck" });
    await modal.getByRole("button", { name: kind, exact: true }).click();
    await modal
      .getByRole("textbox", { name: "Deck name", exact: true })
      .fill(name);
    await modal.getByRole("button", { name: create, exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Deck: ${name}`, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(snapshot.document.decks.map((deck) => deck.kind)).toEqual([
    "simulator",
    "simulator",
    "web",
  ]);
  expect(snapshot.document.settings.webEnabled).toBe(true);
});

test("Home starts with honest simulator status, handles empty workspace, and navigates by keyboard", async () => {
  await expect(homeButton()).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".topbar strong")).toHaveText("Home");
  await expect(
    page.getByRole("article", { name: "Deck overview: My XL" }),
  ).toContainText("Simulator available");
  const fixture = await baseFixture();
  fixture.document.decks = [];
  fixture.document.profiles = [];
  fixture.document.workflows = [];
  fixture.document.activeDeckId = "";
  fixture.capabilities = [
    {
      id: "keyboard",
      available: false,
      state: "unavailable",
      detail: "xdotool missing",
      remedy: "keyboard-tool",
    },
    {
      id: "media",
      available: false,
      state: "unconfigured",
      detail: "No player",
      remedy: "media-player",
    },
  ];
  await installFixture(fixture);
  await expect(
    page.getByRole("heading", { name: "Create your first deck." }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "No configured feature faults reported",
  );
  await expect(
    page.getByRole("article", { name: "OBS", exact: true }),
  ).toContainText("Optional setup guidance");
  await expect(
    page.getByRole("article", { name: "Media controls", exact: true }),
  ).toContainText("Optional setup guidance");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add deck", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Add deck" });
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole("heading", { name: "No new Stream Deck found" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(
    page
      .getByRole("main")
      .getByRole("button", { name: "Add deck", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Flows", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(homeButton()).not.toHaveAttribute("aria-current", "page");
  await homeButton().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeVisible();
});

test("configured faults match rail, deck and Diagnostics, recover independently, and preserve deck navigation", async () => {
  const fixture = await baseFixture();
  const first = fixture.document.decks[0];
  first.kind = "hardware";
  first.hardwareId = "xl:DENIED";
  first.name = "Studio XL";
  const second = {
    ...first,
    id: "web-deck",
    kind: "web" as const,
    hardwareId: undefined,
    name: "Tablet",
    activePageId: "tablet-page",
  };
  const third = {
    ...first,
    id: "missing",
    hardwareId: "xl:MISSING",
    name: "Disconnected XL",
  };
  fixture.document.decks.push(second, third);
  fixture.document.profiles[0].pages.push({
    id: "tablet-page",
    name: "Tablet page",
    keys: {},
  });
  fixture.document.settings.webEnabled = true;
  fixture.web.running = true;
  fixture.document.connections = [
    { id: "studio", name: "Studio", url: "ws://localhost:4455" },
  ];
  fixture.devices = [
    device("xl:DENIED", {
      configured: true,
      state: "permission-denied",
      error: "Permission denied",
      errorDetails: {
        stage: "open",
        code: "EACCES",
        message: "Permission denied password=hidden",
        at: 1,
      },
    }),
    device("xl:MISSING", {
      configured: true,
      state: "disconnected",
      present: false,
    }),
  ];
  fixture.observed = {
    "obs:studio": {
      connected: false,
      error: "Connection refused token=hidden",
    },
    diagnostics: {
      audio: {
        feature: "Audio service",
        message: "Service unavailable",
        firstAt: 1,
        lastAt: 1,
        count: 1,
      },
    },
  };
  await installFixture(fixture);
  const denied = page.getByRole("article", {
    name: "Deck overview: Studio XL",
  });
  await expect(denied).toContainText("Permission required");
  await expect(denied).not.toContainText("hidden");
  await expect(page.getByRole("status")).toContainText(
    "4 features need attention",
  );
  await expect(
    page.getByRole("article", { name: "Deck overview: Disconnected XL" }),
  ).toContainText("Disconnected");
  const tablet = page.getByRole("article", { name: "Deck overview: Tablet" });
  await expect(tablet).toContainText("No browser connected");
  await expect(tablet).toContainText("Sharing server running");
  await expect(
    page.getByRole("button", { name: "Deck: Studio XL", exact: true }),
  ).toHaveAttribute("title", "Studio XL · hardware · Permission required");
  await denied.getByText("Repair guidance", { exact: true }).click();
  await denied.getByRole("button", { name: "Copy repair text" }).click();
  await denied.getByRole("button", { name: "Open documentation" }).click();
  await denied
    .getByRole("button", { name: "Diagnostics", exact: true })
    .click();
  const diagnostic = page.getByRole("article", {
    name: "xl:DENIED",
    exact: true,
  });
  await expect(diagnostic).toContainText("Permission required");
  await homeButton().click();
  await denied.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(denied).toContainText("Ready");
  await expect(denied).not.toContainText("Permission required");
  await expect(page.getByRole("status")).toContainText(
    "3 features need attention",
  );
  await expect(
    page.getByRole("article", { name: "OBS · Studio" }),
  ).toContainText("Connection refused");
  await page.getByRole("button", { name: "Recheck", exact: true }).click();
  expect(await requests()).toEqual(
    expect.arrayContaining([
      {
        type: "diagnosticRemedy",
        healthId: "device:xl:DENIED",
        action: "copy",
      },
      {
        type: "diagnosticRemedy",
        healthId: "device:xl:DENIED",
        action: "open",
      },
      { type: "retryDevice", hardwareId: "xl:DENIED" },
      { type: "diagnose" },
    ]),
  );
  for (const name of ["Tablet", "Disconnected XL", "Studio XL"]) {
    await page
      .getByRole("button", { name: `Open deck: ${name}`, exact: true })
      .click();
    await expect(page.locator(".topbar strong")).toHaveText("Deck workspace");
    await expect(
      page.getByRole("button", { name: `Deck: ${name}`, exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await homeButton().click();
  }
  const final = await page.evaluate(() => window.decker.snapshot());
  expect(
    final.document.decks.find((deck) => deck.id === "web-deck")!.activePageId,
  ).toBe("tablet-page");
  expect(final.document.decks[0].activePageId).toBe("home");
  final.web.clients = [
    {
      id: "phone",
      name: "Phone",
      deckId: "web-deck",
      online: true,
      createdAt: 1,
      lastSeen: 1,
    },
  ];
  final.web.pending = [
    {
      id: "pending",
      name: "New browser",
      deckId: "web-deck",
      code: "123456",
      expiresAt: Date.now() + 60000,
    },
  ];
  await emit(final);
  await expect(tablet).toContainText("1 browser connected");
  await page.getByRole("button", { name: "View pairing requests" }).click();
  await expect(
    page.getByRole("heading", { name: "Paired browsers" }),
  ).toBeVisible();
});

test("discovery deduplicates, follows live availability, requires confirmation, and respects reduced motion", async () => {
  const fixture = await baseFixture();
  fixture.devices = [
    device("xl:NEW-A"),
    device("xl:NEW-A", { updatedAt: 2 }),
    device("xl:NEW-B"),
    device("session:no-serial"),
  ];
  await installFixture(fixture);
  const prompts = page.locator(".discovery-prompt");
  await expect(prompts).toHaveCount(3);
  await expect(
    page.locator(".add-deck-button").locator("xpath=preceding-sibling::*[1]"),
  ).toHaveClass("discovery-prompt");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(prompts.first()).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(prompts.first()).toHaveCSS("animation-name", "discovery-pulse");
  const addA = page.getByRole("button", {
    name: "New Stream Deck detected — Add: xl:NEW-A (xl:NEW-A)",
    exact: true,
  });
  await addA.focus();
  await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Add deck" });
  await expect(modal.locator(".discovered-deck")).toHaveCount(1);
  await expect(modal.locator(".discovery-selected")).toContainText("xl:NEW-A");
  expect(
    (await requests()).filter((request) => request.type === "addDeck"),
  ).toEqual([]);
  fixture.devices = fixture.devices.filter(
    (device) => device.id !== "xl:NEW-A",
  );
  await emit(fixture);
  await expect(
    modal.getByRole("heading", {
      name: "Selected Stream Deck is no longer available",
    }),
  ).toBeVisible();
  await expect(
    modal.getByRole("button", { name: "Add Stream Deck" }),
  ).toHaveCount(0);
  await expect(prompts).toHaveCount(2);
  fixture.devices.push(
    device("xl:NEW-A", { updatedAt: 3, rows: 2, columns: 3 }),
  );
  await emit(fixture);
  await expect(modal).toContainText("2 × 3");
  await modal
    .getByRole("button", { name: "Add Stream Deck", exact: true })
    .click();
  await expect(modal).toHaveCount(0);
  await expect(prompts).toHaveCount(2);
  await expect(addA).toHaveCount(0);
  expect(
    (await requests()).filter((request) => request.type === "addDeck"),
  ).toEqual([
    {
      type: "addDeck",
      kind: "hardware",
      name: "xl:NEW-A",
      icon: "🎛",
      rows: 2,
      columns: 3,
      hardwareId: "xl:NEW-A",
    },
  ]);
  await page
    .getByRole("button", {
      name: "New Stream Deck detected — Add: session:no-serial (session:no-serial)",
      exact: true,
    })
    .click();
  await expect(
    modal.getByRole("button", { name: "Add Stream Deck" }),
  ).toBeDisabled();
  await expect(modal).toContainText("A serial number is required");
  await page.keyboard.press("Escape");
  await homeButton().click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "test-results/home-normal.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 700, height: 850 });
  await expect(page.getByRole("main")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/home-narrow.png",
    fullPage: true,
  });
});
