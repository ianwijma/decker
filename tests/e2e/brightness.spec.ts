import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: ElectronApplication, directory: string, page: Page;
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  // OBS is synthesized by main before runner startup. Keyboard diagnostics
  // arrive only after the runner's ready/configure handshake, even without X11.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).capabilities.some(
          (capability) => capability.id === "keyboard",
        ),
      ),
    )
    .toBe(true);
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-brightness-e2e-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  return page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    const keys = doc.profiles[0].pages[0].keys;
    for (const [slot, type, step] of [
      [3, "deck.brightnessIncrease", 10],
      [4, "deck.brightnessDecrease", 5],
    ] as const) {
      keys[slot] = {
        ...structuredClone(keys[0]),
        id: crypto.randomUUID(),
        policy: "concurrent",
        limit: 16,
        appearance: { ...keys[0].appearance, label: type },
        press: {
          kind: "action",
          action: { type, version: 1, config: { step } },
        },
      };
    }
    doc.decks.push({
      ...doc.decks[0],
      id: "second",
      name: "Second",
      brightness: 0,
      profileIds: ["second-profile"],
      activeProfileId: "second-profile",
      activePageId: "second-page",
    });
    const secondProfile = structuredClone(doc.profiles[0]);
    secondProfile.id = "second-profile";
    secondProfile.pages[0].id = "second-page";
    for (const binding of Object.values(secondProfile.pages[0].keys))
      binding.id = crypto.randomUUID();
    doc.profiles.push(secondProfile);
    const action = {
      ...doc.workflows[0].graph.nodes[0],
      kind: "action" as const,
      name: "Brightness",
      action: {
        type: "deck.brightnessIncrease",
        version: 1 as const,
        config: { step: 10 },
      },
    };
    doc.workflows[0].graph = { entry: action.id, nodes: [action], edges: [] };
    doc.workflows[0].name = "Brightness";
    await window.decker.request({ type: "save", document: doc });
    return { deckId: doc.decks[0].id, workflowId: doc.workflows[0].id };
  });
}
async function brightness(deckId: string) {
  return page.evaluate(
    async (id) =>
      (await window.decker.snapshot()).document.decks.find((d) => d.id === id)!
        .brightness,
    deckId,
  );
}
async function press(deckId: string, key: number) {
  await page.evaluate(
    async ({ deckId, key }) => {
      await window.decker.request({ type: "press", deckId, key, down: true });
      await window.decker.request({ type: "press", deckId, key, down: false });
    },
    { deckId, key },
  );
}
async function settled() {
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).runs.filter(
            (r) => r.status === "running",
          ).length,
      ),
    )
    .toBe(0);
}

test("button/workflow palettes, search, drag assignment and advanced phase/sequence editing survive reload", async () => {
  for (const name of [
    "Increase brightness",
    "Decrease brightness",
    "Play/Pause",
  ])
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  for (const name of [
    "Set brightness",
    "Change key appearance",
    "Media control",
  ])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await page
    .getByRole("textbox", { name: "Search actions", exact: true })
    .fill("brightness");
  await expect(page.locator(".catalog-action")).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "Search actions", exact: true })
    .fill("");
  // Exercise the library's existing drag payload and the key drop handler.
  await page
    .getByRole("button", { name: "Increase brightness", exact: true })
    .evaluate((source) => {
      const transfer = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
      );
      document
        .querySelector('[aria-label="Key 4"]')!
        .dispatchEvent(
          new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
        );
    });
  await page
    .getByRole("button", { name: "Key 4: Increase brightness", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveValue("deck.brightnessIncrease");
  await expect(
    page.getByRole("spinbutton", { name: "Step", exact: true }),
  ).toHaveValue("10");
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document,
      key = doc.profiles[0].pages[0].keys[3];
    key.press = {
      kind: "action",
      action: { type: "deck.brightness", version: 1, config: { value: 35 } },
    };
    key.release = {
      kind: "action",
      action: {
        type: "deck.appearance",
        version: 1,
        config: { label: "Old", background: "#123456" },
      },
    };
    key.longPress = {
      kind: "sequence",
      actions: [key.press.action, key.release.action],
    };
    await window.decker.request({ type: "save", document: doc });
  });
  await expect(
    page.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveValue("deck.brightness");
  await expect(
    page
      .locator("option:checked")
      .filter({ hasText: "Set brightness (advanced)" }),
  ).toHaveCount(1);
  await page
    .getByRole("spinbutton", { name: "Brightness", exact: true })
    .fill("45");
  await page.getByRole("button", { name: "Release", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveValue("deck.appearance");
  await page.getByRole("button", { name: "Hold", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveCount(2);
  for (const selector of await page
    .getByRole("combobox", { name: "Action", exact: true })
    .all()) {
    expect(await selector.locator("option").allTextContents()).toEqual(
      expect.arrayContaining([
        "Deck / Increase brightness",
        "Deck / Decrease brightness",
      ]),
    );
    expect(
      (await selector.locator("option").allTextContents()).filter((s) =>
        s.includes("advanced"),
      ),
    ).toHaveLength(1);
  }
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  const saved = (await page.evaluate(() => window.decker.snapshot())).document;
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  for (const name of [
    "Set brightness",
    "Change key appearance",
    "Increase brightness",
    "Decrease brightness",
    "Play/Pause",
  ])
    await expect(
      page.getByRole("button", { name: `Add ${name} node`, exact: true }),
    ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Set brightness node", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveValue("deck.brightness");
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("deck.appearance");
  await app.close();
  await launch();
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document.profiles,
  ).toEqual(saved.profiles);
});

test("concurrent saved button presses stay on their origin, stale saves cannot rewind, and manual runs use selection", async () => {
  const { deckId, workflowId } = await fixture();
  const stale = (await page.evaluate(() => window.decker.snapshot())).document;
  // Both decks use the same saved bindings. Each targets its input origin.
  await page.evaluate(async (deckId) => {
    await window.decker.request({ type: "selectDeck", deckId: "second" });
    for (let i = 0; i < 3; i++) {
      await window.decker.request({
        type: "press",
        deckId,
        key: 3,
        down: true,
      });
      await window.decker.request({
        type: "press",
        deckId,
        key: 3,
        down: false,
      });
    }
  }, deckId);
  await expect.poll(() => brightness(deckId)).toBe(100);
  expect(await brightness("second")).toBe(0);
  await press(deckId, 4);
  await expect.poll(() => brightness(deckId)).toBe(95);
  await press("second", 3);
  await expect.poll(() => brightness("second")).toBe(10);
  await page.evaluate(
    (json) =>
      window.decker.request({ type: "save", document: JSON.parse(json) }),
    JSON.stringify(stale),
  );
  expect(await brightness(deckId)).toBe(95);
  expect(await brightness("second")).toBe(10);
  await page.evaluate(
    async ({ deckId, json }) => {
      const stale = JSON.parse(json);
      stale.decks[0].brightness = 25;
      await window.decker.request({
        type: "save",
        document: stale,
        brightnessEdits: [deckId],
      });
    },
    { deckId, json: JSON.stringify(stale) },
  );
  expect(await brightness(deckId)).toBe(25);
  await page.evaluate(
    (workflowId) =>
      window.decker.request({ type: "run", workflowId, inputs: {} }),
    workflowId,
  );
  await expect.poll(() => brightness("second")).toBe(20);
  await settled();
  expect(
    (await page.evaluate(() => window.decker.snapshot())).runs.every(
      (r) => r.status === "success",
    ),
  ).toBe(true);
  const disk = JSON.parse(
    await readFile(join(directory, "config.json"), "utf8"),
  );
  expect(disk.decks.map((d: { brightness: number }) => d.brightness)).toEqual([
    25, 20,
  ]);
});

test("cancelled brightness queued behind an import dialog never applies; deleted explicit origin fails", async () => {
  const { deckId, workflowId } = await fixture();
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (() =>
      new Promise((resolve) => {
        (
          globalThis as unknown as { releaseBrightnessDialog: () => void }
        ).releaseBrightnessDialog = () =>
          resolve({ canceled: true, filePaths: [] });
      })) as typeof dialog.showOpenDialog;
  });
  await page.evaluate(() => {
    void window.decker.request({ type: "import" });
  });
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(
          (globalThis as unknown as { releaseBrightnessDialog?: unknown })
            .releaseBrightnessDialog,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(
    ({ deckId, workflowId }) =>
      window.decker.request({ type: "run", deckId, workflowId, inputs: {} }),
    { deckId, workflowId },
  );
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).runs.some(
          (r) => r.status === "running" && r.nodes.length > 0,
        ),
      ),
    )
    .toBe(true);
  const runId = (await page.evaluate(() => window.decker.snapshot())).runs.at(
    -1,
  )!.id;
  await page.evaluate(
    (runId) => window.decker.request({ type: "cancel", runId }),
    runId,
  );
  await settled();
  await app.evaluate(() =>
    (
      globalThis as unknown as { releaseBrightnessDialog: () => void }
    ).releaseBrightnessDialog(),
  );
  await page.evaluate(async () =>
    window.decker.request({
      type: "save",
      document: (await window.decker.snapshot()).document,
    }),
  );
  expect(await brightness(deckId)).toBe(70);
  expect(
    (await page.evaluate(() => window.decker.snapshot())).runs.at(-1)!.status,
  ).toBe("cancelled");
  await page.evaluate(
    ({ workflowId }) =>
      window.decker.request({
        type: "run",
        deckId: "deleted",
        workflowId,
        inputs: {},
      }),
    { workflowId },
  );
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).runs.at(-1)!.status,
      ),
    )
    .toBe("failure");
  expect(
    (await page.evaluate(() => window.decker.snapshot())).runs.at(-1)!.error,
  ).toContain("No originating deck");
  expect(await brightness(deckId)).toBe(70);
});

test("storage failure reports a failed run without publishing or applying a relative step", async () => {
  const { deckId } = await fixture();
  // Make the existing persistence directory unavailable without mocking success.
  await rename(directory, `${directory}-held`);
  try {
    await press(deckId, 3);
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.decker.snapshot()).runs.at(-1)?.status,
        ),
      )
      .toBe("failure");
    expect(await brightness(deckId)).toBe(70);
    expect(
      (await page.evaluate(() => window.decker.snapshot())).runs.at(-1)!.error,
    ).toMatch(/ENOENT/);
  } finally {
    await rename(`${directory}-held`, directory);
  }
});

test("credential commit and brightness share one queue without losing a secret owner", async () => {
  const { deckId, workflowId } = await fixture();
  const epoch = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    doc.connections.push({
      id: "brightness-secret",
      name: "Fixture",
      url: "ws://127.0.0.1:65534",
    });
    const saved = await window.decker.request({ type: "save", document: doc });
    return (saved as import("../../src/shared/schema").Snapshot)
      .credentialState!.epoch;
  });
  await app.evaluate(async () => {
    const fs = process.getBuiltinModule(
      "node:fs/promises",
    ) as typeof import("node:fs/promises");
    const { syncBuiltinESMExports } = process.getBuiltinModule(
      "node:module",
    ) as typeof import("node:module");
    const write = fs.writeFile;
    fs.writeFile = (async (...args: Parameters<typeof write>) => {
      if (String(args[0]).endsWith("config.json.tmp")) {
        fs.writeFile = write;
        syncBuiltinESMExports();
        await new Promise<void>((resolve) => {
          (
            globalThis as unknown as { releaseCredentialCommit: () => void }
          ).releaseCredentialCommit = resolve;
        });
      }
      return write(...args);
    }) as typeof write;
    syncBuiltinESMExports();
  });
  await page.evaluate((epoch) => {
    void window.decker.request({
      type: "credential",
      epoch,
      owner: JSON.stringify(["connection", "brightness-secret"]),
      operation: "set",
      value: "synthetic-brightness-secret",
      persist: false,
    });
  }, epoch);
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(
          (globalThis as unknown as { releaseCredentialCommit?: unknown })
            .releaseCredentialCommit,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(
    ({ workflowId, deckId }) =>
      window.decker.request({ type: "run", workflowId, deckId, inputs: {} }),
    { workflowId, deckId },
  );
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).runs.some(
          (r) => r.status === "running" && r.nodes.length > 0,
        ),
      ),
    )
    .toBe(true);
  expect(await brightness(deckId)).toBe(70);
  await app.evaluate(() =>
    (
      globalThis as unknown as { releaseCredentialCommit: () => void }
    ).releaseCredentialCommit(),
  );
  await expect.poll(() => brightness(deckId)).toBe(80);
  await settled();
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(snapshot.document.connections[0].credentialRef).toMatch(/^managed:/);
  expect(
    snapshot.credentialState!.owners[
      JSON.stringify(["connection", "brightness-secret"])
    ],
  ).toBe("session-only");
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-brightness-secret");
});

test("paired web presses execute saved relative actions on the web origin while desktop selection differs", async () => {
  const { deckId } = await fixture();
  const webId = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    doc.settings.webPort = 0;
    await window.decker.request({ type: "save", document: doc });
    const created = (await window.decker.request({
      type: "addDeck",
      kind: "web",
      name: "Phone",
      icon: "▦",
      rows: 1,
      columns: 2,
    })) as import("../../src/shared/schema").Snapshot;
    const web = created.document.decks.find((d) => d.name === "Phone")!;
    const keys = created.document.profiles.find(
      (p) => p.id === web.activeProfileId,
    )!.pages[0].keys;
    const source = created.document.profiles[0].pages[0].keys;
    for (const [slot, sourceSlot, label] of [
      [0, 3, "Brighter"],
      [1, 4, "Dimmer"],
    ] as const)
      keys[slot] = {
        ...structuredClone(source[sourceSlot]),
        id: crypto.randomUUID(),
        appearance: { ...source[sourceSlot].appearance, label },
      };
    await window.decker.request({ type: "save", document: created.document });
    return web.id;
  });
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.decker.snapshot()).web.running),
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
  await app.evaluate(({ BrowserWindow }, link) => {
    const browser = new BrowserWindow({
      width: 390,
      height: 844,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void browser.loadURL(link);
  }, link);
  const phone = await next;
  await phone
    .getByRole("textbox", { name: "Browser name", exact: true })
    .fill("Brightness fixture");
  await phone
    .getByRole("button", { name: "Request pairing", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Approve browser", exact: true })
    .click();
  await expect(phone.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.evaluate(
    (deckId) => window.decker.request({ type: "selectDeck", deckId }),
    deckId,
  );
  await phone.getByRole("button", { name: "Brighter", exact: true }).click();
  await expect.poll(() => brightness(webId)).toBe(80);
  await phone.getByRole("button", { name: "Dimmer", exact: true }).click();
  await expect.poll(() => brightness(webId)).toBe(75);
  expect(await brightness(deckId)).toBe(70);
  await settled();
});
