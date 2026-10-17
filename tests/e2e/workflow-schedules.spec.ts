import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, page: Page, directory: string;
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Workflow schedules", exact: true }),
  ).toBeVisible();
}
async function awaitScheduled() {
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).schedules?.[0]?.nextAt,
      ),
    )
    .toBeTruthy();
}
/** Test-only main-process clock injection: no renderer clock/RPC or production hook.
 * Advance wall and monotonic clocks together to the actual next tick. */
async function tick(nextAt?: number) {
  const next =
    nextAt ??
    (await page.evaluate(() => window.decker.snapshot())).schedules![0].nextAt!;
  await app.evaluate((_electron, next) => {
    const clock = globalThis as typeof globalThis & {
      scheduleTestOffset?: number;
      scheduleTestNow?: () => number;
      scheduleTestMono?: () => number;
    };
    if (!clock.scheduleTestNow) {
      clock.scheduleTestNow = Date.now.bind(Date);
      clock.scheduleTestMono = performance.now.bind(performance);
      Date.now = () =>
        clock.scheduleTestNow!() + (clock.scheduleTestOffset ?? 0);
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: () =>
          clock.scheduleTestMono!() + (clock.scheduleTestOffset ?? 0),
      });
    }
    clock.scheduleTestOffset = next - clock.scheduleTestNow();
  }, next);
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-schedules-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
test("authors, previews, explicitly enables, runs unbound and edits/disables/deletes schedules", async () => {
  await launch();
  const region = page.getByRole("region", {
    name: "Workflow schedules",
    exact: true,
  });
  await expect(region).toContainText(
    "Closing to tray keeps schedules active; Quit stops them",
  );
  await region
    .getByRole("button", { name: "Add schedule", exact: true })
    .click();
  await region
    .getByRole("textbox", { name: "Schedule name", exact: true })
    .fill("Morning fixture");
  await region
    .getByRole("spinbutton", { name: "Interval seconds", exact: true })
    .fill("59");
  await expect(
    region.getByRole("button", { name: "Save schedule", exact: true }),
  ).toBeDisabled();
  await region
    .getByRole("spinbutton", { name: "Interval seconds", exact: true })
    .fill("60");
  await region
    .getByRole("textbox", { name: "Schedule inputs", exact: true })
    .fill("{");
  await expect(
    region.getByRole("button", { name: "Preview next runs", exact: true }),
  ).toBeDisabled();
  await region
    .getByRole("textbox", { name: "Schedule inputs", exact: true })
    .fill("{}");
  await region
    .getByRole("button", { name: "Preview next runs", exact: true })
    .click();
  await expect(
    region
      .getByRole("list", { name: "Next occurrences", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(3);
  expect(
    (await page.evaluate(() => window.decker.snapshot())).runs,
  ).toHaveLength(0);
  await region
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  const card = region.getByRole("article", {
    name: "Schedule Morning fixture",
    exact: true,
  });
  await expect(card).toContainText("Disabled");
  await card
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await expect(card).toContainText("Enabled");
  await awaitScheduled();
  const document = (await page.evaluate(() => window.decker.snapshot()))
    .document;
  expect(document.schedules[0].enabled).toBe(true);
  // Fixture graph uses a local no-effect return node; no hardware required.
  await page.evaluate(async () => {
    const d = (await window.decker.snapshot()).document;
    d.workflows[0].graph.nodes = [
      {
        id: "fixture",
        kind: "return",
        name: "Fixture return",
        config: { result: {} },
        timeoutMs: 5000,
        retries: 0,
        retrySafe: false,
      },
    ];
    d.workflows[0].graph.entry = "fixture";
    d.workflows[0].graph.edges = [];
    await window.decker.request({ type: "save", document: d });
  });
  await awaitScheduled();
  await tick();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).runs.at(-1)?.status,
      ),
    )
    .toBe("success");
  const record = (await page.evaluate(() => window.decker.snapshot())).runs.at(
    -1,
  )!;
  expect(record.context?.source).toMatchObject({
    kind: "scheduled",
    schedule: { name: "Morning fixture" },
  });
  expect(record.context?.origin).toBeNull();
  expect(record.deckId).toBeUndefined();
  expect(record.bindingId).toBeUndefined();
  await expect(card).toContainText("Last: success");
  await card
    .getByRole("button", { name: "Disable schedule", exact: true })
    .click();
  await expect(card).toContainText("Disabled");
  // A stale whole-document save cannot restore the previous activation.
  await page.evaluate(async (stale) => {
    const d = (await window.decker.snapshot()).document;
    d.schedules = JSON.parse(stale).schedules;
    await window.decker.request({ type: "save", document: d });
  }, JSON.stringify(document));
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document.schedules[0]
      .enabled,
  ).toBe(false);
  await card
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await region
    .getByRole("combobox", { name: "Schedule type", exact: true })
    .selectOption("cron");
  await region
    .getByRole("textbox", { name: "Timezone", exact: true })
    .fill("Wrong/Zone");
  await expect(
    region.getByRole("button", { name: "Save schedule", exact: true }),
  ).toBeDisabled();
  await region
    .getByRole("textbox", { name: "Timezone", exact: true })
    .fill("Australia/Lord_Howe");
  await region
    .getByRole("textbox", { name: "Cron expression", exact: true })
    .fill("45 1 * * *");
  await region
    .getByRole("button", { name: "Preview next runs", exact: true })
    .click();
  await expect(
    region.getByRole("list", { name: "Next occurrences", exact: true }),
  ).toContainText("Australia/Lord_Howe");
  await region
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(card).toContainText("Australia/Lord_Howe");
  await page.screenshot({
    path: "test-results/workflow-schedules.png",
    fullPage: true,
  });
  await card
    .getByRole("button", { name: "Duplicate schedule", exact: true })
    .click();
  const copy = region.getByRole("article", {
    name: "Schedule Morning fixture copy",
    exact: true,
  });
  await expect(copy).toContainText("Disabled");
  await copy
    .getByRole("button", { name: "Delete schedule", exact: true })
    .click();
  await expect(copy).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await expect(
    page.getByText("Scheduled · Morning fixture").first(),
  ).toBeVisible();
  const saved = JSON.parse(
    await readFile(join(directory, "config.json"), "utf8"),
  );
  expect(saved.schemaVersion).toBe(7);
  expect(saved.schedules[0].enabled).toBe(false);
});
test("resumes only enabled saved schedules after readiness, works with the window closed to tray and skips suspend time", async () => {
  await launch();
  await page.evaluate(async () => {
    const d = (await window.decker.snapshot()).document,
      f = d.workflows[0];
    f.graph = {
      entry: "fixture",
      nodes: [
        {
          id: "fixture",
          kind: "return",
          name: "No effects",
          config: { result: {} },
          timeoutMs: 5000,
          retries: 0,
          retrySafe: false,
        },
      ],
      edges: [],
    };
    d.schedules = [
      {
        id: crypto.randomUUID(),
        name: "Tray fixture",
        workflowId: f.id,
        enabled: true,
        inputs: {},
        timing: { kind: "interval", seconds: 60 },
      },
    ];
    await window.decker.request({ type: "save", document: d });
  });
  let snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(snapshot.document.schedules[0].enabled).toBe(false);
  await page.evaluate(async () => {
    const s = (await window.decker.snapshot()).document.schedules[0];
    await window.decker.request({
      type: "scheduleEnable",
      id: s.id,
      enabled: true,
      expected: s,
    });
  });
  await app.close();
  await launch();
  await awaitScheduled();
  snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(snapshot.runs).toHaveLength(0);
  expect(snapshot.document.schedules[0].enabled).toBe(true);
  const missedAt = snapshot.schedules![0].nextAt!;
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("suspend");
  });
  await tick(missedAt);
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("resume");
  });
  await awaitScheduled();
  expect(
    (await page.evaluate(() => window.decker.snapshot())).runs,
  ).toHaveLength(0);
  // Observe main publications independently from hidden-renderer throttling.
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents,
      send = wc.send.bind(wc);
    const g = globalThis as typeof globalThis & {
      scheduleTestRuns?: unknown[];
    };
    g.scheduleTestRuns = [];
    wc.send = (channel, ...args) => {
      if (channel === "decker:snapshot") g.scheduleTestRuns = args[0].runs;
      send(channel, ...args);
    };
  });
  await tick();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              scheduleTestRuns: { status: string }[];
            }
          ).scheduleTestRuns.at(-1)?.status,
      ),
    )
    .toBe("success");
});
