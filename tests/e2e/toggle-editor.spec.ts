import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
  type Locator,
} from "@playwright/test";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  chmod,
} from "node:fs/promises";
import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binding, defaults } from "../../src/shared/defaults";
import type { AppDocument, Target } from "../../src/shared/schema";
import { fakeObs } from "../fixtures/obs-server";
import { toggleStamp } from "../../src/runtime/targets";
import { toggleKey } from "../../src/shared/toggle-contract";
let app: ElectronApplication, page: Page, directory: string;
const command = (script: string, args: string[] = []): Target => ({
  kind: "action",
  action: {
    type: "command.run",
    version: 1,
    config: {
      executable: "/bin/sh",
      args: ["-c", script, "fixture", ...args],
      cwd: "",
    },
  },
});
async function launch(
  doc: AppDocument,
  environment: Record<string, string> = {},
) {
  await writeFile(join(directory, "config.json"), JSON.stringify(doc));
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, ...environment, DECKER_DATA_DIR: directory },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).capabilities.some(
          (c) => c.id === "keyboard",
        ),
      ),
    )
    .toBe(true);
}
async function saved() {
  return page.evaluate(
    async () =>
      (await window.decker.snapshot()).document.profiles[0].pages[0].keys[0],
  );
}
async function state() {
  return page.evaluate(
    async () => (await window.decker.snapshot()).toggles?.[0],
  );
}
async function configureCommand(
  group: Locator,
  script: string,
  args: string[] = [],
) {
  await group.getByLabel("Assignment", { exact: true }).selectOption("action");
  await group.getByLabel("Action", { exact: true }).selectOption("command.run");
  await group.getByLabel("Executable", { exact: true }).fill("/bin/sh");
  await group
    .getByLabel("Arguments (JSON array)", { exact: true })
    .fill(JSON.stringify(["-c", script, "fixture", ...args]));
}
type ImageGate = typeof globalThis & {
  finishAsset?: (result: { canceled: boolean; filePaths: string[] }) => void;
  assetResult?: unknown;
};
async function imageGate() {
  const path = join(directory, "image-fixture.png");
  await writeFile(
    path,
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer(),
  );
  await app.evaluate(({ dialog, ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<
          string,
          (event: unknown, request: unknown) => Promise<unknown>
        >;
      }
    )._invokeHandlers;
    const original = handlers.get("decker:request");
    if (!original) throw new Error("Request handler missing");
    ipcMain.removeHandler("decker:request");
    ipcMain.handle("decker:request", async (event, request: unknown) => {
      const result = await original(event, request);
      if ((request as { type?: string }).type === "asset")
        (globalThis as ImageGate).assetResult = result;
      return result;
    });
    dialog.showOpenDialog = (async () =>
      new Promise((resolve) => {
        (globalThis as ImageGate).assetResult = undefined;
        (globalThis as ImageGate).finishAsset = resolve;
      })) as typeof dialog.showOpenDialog;
  });
  return path;
}
async function finishAsset(path: string) {
  await expect
    .poll(() =>
      app.evaluate(() => typeof (globalThis as ImageGate).finishAsset),
    )
    .toBe("function");
  await app.evaluate((_, path) => {
    const state = globalThis as ImageGate;
    state.finishAsset!({ canceled: false, filePaths: [path] });
    state.finishAsset = undefined;
  }, path);
  await expect
    .poll(() => app.evaluate(() => (globalThis as ImageGate).assetResult))
    .toMatch(/^[a-f0-9]{64}$/);
  // Drain the real asset reply and render before checking that the stale owner stayed unchanged.
  await page.evaluate(async () => {
    await window.decker.snapshot();
    await new Promise(requestAnimationFrame);
  });
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
}
async function saveToggle() {
  await page
    .getByRole("button", { name: "Save toggle configuration", exact: true })
    .click();
  await expect(page.getByText("Unsaved draft.", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Execute saved toggle" }),
  ).toBeEnabled();
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-toggle-editor-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

test("converts explicit conflicts, authors commands and appearances without effects, preserves state and reloads", async () => {
  const doc = defaults(),
    b = doc.profiles[0].pages[0].keys[0],
    marker = join(directory, "effect");
  b.release = command("true");
  b.longPress = command("true");
  await launch(doc);
  await page.getByLabel("Button mode", { exact: true }).selectOption("toggle");
  await expect(
    page.getByRole("group", { name: "Resolve assignments" }),
  ).toContainText("release");
  expect((await saved()).toggle).toBeUndefined();
  await page.getByRole("button", { name: "Cancel toggle edits" }).click();
  expect(await saved()).toMatchObject({
    press: b.press,
    release: b.release,
    longPress: b.longPress,
  });
  await page.getByLabel("Button mode", { exact: true }).selectOption("toggle");
  await page.getByLabel("Resolve existing assignments").selectOption("replace");
  await configureCommand(
    page.getByRole("group", { name: "On target", exact: true }),
    'printf on > "$1"',
    [marker],
  );
  await configureCommand(
    page.getByRole("group", { name: "Off target", exact: true }),
    'printf off > "$1"',
    [marker],
  );
  await page.getByLabel("on label", { exact: true }).fill("Enabled");
  await page.getByLabel("off label", { exact: true }).fill("Disabled");
  await page.getByLabel("on background", { exact: true }).fill("#123456");
  await page.getByLabel("off background", { exact: true }).fill("#654321");
  const onAppearance = page.getByRole("group", {
    name: "on appearance",
    exact: true,
  });
  await onAppearance.getByRole("button", { name: /Lucide icon:/ }).click();
  await onAppearance
    .getByRole("combobox", { name: "Search Lucide icons" })
    .fill("power");
  await onAppearance
    .getByRole("option", { name: "Power", exact: true })
    .click();
  await expect(
    page.getByLabel("Authored on preview (does not execute)"),
  ).toContainText("Enabled");
  await expect(readFile(marker, "utf8")).rejects.toThrow();
  await page
    .getByRole("group", { name: "off appearance", exact: true })
    .getByRole("button", { name: "Clear icon", exact: true })
    .click();
  await saveToggle();
  await expect(
    page.locator(".deck-key").first().locator(".key-symbol"),
  ).toHaveText("");
  expect(await saved()).toMatchObject({
    toggle: {
      source: { kind: "app", initial: "off" },
      appearance: {
        on: { label: "Enabled", icon: "pack:lucide:v1:power" },
        off: { label: "Disabled" },
      },
    },
  });
  expect((await saved()).release).toBeUndefined();
  await expect(page.getByLabel("Live saved state")).toContainText("Disabled");
  await page.getByRole("button", { name: "Execute saved toggle" }).click();
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "on", fresh: true, transitioning: false });
  expect(await readFile(marker, "utf8")).toBe("on");
  const generation = (await saved()).generation;
  await page.getByLabel("on label", { exact: true }).fill("Active label");
  await expect(page.getByLabel("Live saved state")).toContainText("Enabled");
  await saveToggle();
  await expect.poll(saved).toMatchObject({ generation });
  expect((await state())?.confirmed).toBe("on");
  await page.getByLabel("Label", { exact: true }).fill("Base label");
  await expect
    .poll(saved)
    .toMatchObject({ generation, appearance: { label: "Base label" } });
  expect((await state())?.confirmed).toBe("on");
  await page
    .getByLabel("Button mode", { exact: true })
    .selectOption("ordinary");
  await page.getByLabel("Retain toggle target").selectOption("off");
  await page.getByRole("button", { name: "Cancel conversion" }).click();
  expect((await saved()).toggle).toBeDefined();
  await app.close();
  await launch(
    (await readFile(join(directory, "config.json"), "utf8").then(
      JSON.parse,
    )) as AppDocument,
  );
  await expect.poll(state).toMatchObject({ confirmed: "on", fresh: true });
  await page.getByRole("button", { name: "Execute saved toggle" }).click();
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "off", transitioning: false });
  expect(await readFile(marker, "utf8")).toBe("off");
  await page
    .getByLabel("Button mode", { exact: true })
    .selectOption("ordinary");
  await page.getByLabel("Retain toggle target").selectOption("off");
  await page.getByRole("button", { name: "Confirm ordinary mode" }).click();
  await expect.poll(saved).toMatchObject({
    press: {
      kind: "action",
      action: {
        type: "command.run",
        version: 1,
        config: {
          executable: "/bin/sh",
          args: JSON.stringify(["-c", 'printf off > "$1"', "fixture", marker]),
          cwd: "",
        },
      },
    },
  });
  expect((await saved()).toggle).toBeUndefined();
});

test("workflow and sequence drafts stay inactive; deliberate probe tests saved config and never expose output", async () => {
  const doc = defaults(),
    b = binding("desktop.copy", "Probe key"),
    counter = join(directory, "probes");
  delete b.press;
  b.toggle = {
    on: command("true"),
    off: command("true"),
    source: { kind: "app", initial: "off" },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  await launch(doc);
  const on = page.getByRole("group", { name: "On target", exact: true });
  await on.getByLabel("Assignment", { exact: true }).selectOption("workflow");
  await expect(on.getByRole("button", { name: /Workflow:/ })).toContainText(
    doc.workflows[0].name,
  );
  const off = page.getByRole("group", { name: "Off target", exact: true });
  await off.getByLabel("Assignment", { exact: true }).selectOption("sequence");
  await off.getByRole("button", { name: "Add step" }).click();
  await expect(off.locator(".sequence-item")).toHaveCount(2);
  await page
    .getByLabel("State source", { exact: true })
    .selectOption("external");
  const probe = page.getByRole("group", { name: "State probe", exact: true });
  await configureCommand(probe, 'printf x >> "$1"; printf off', [counter]);
  expect((await saved()).toggle!.source.kind).toBe("app");
  await expect(readFile(counter, "utf8")).rejects.toThrow();
  await page.getByRole("button", { name: "Save toggle configuration" }).click();
  await expect
    .poll(() => saved().then((b) => b.toggle?.source.kind))
    .toBe("external");
  await expect(
    page.getByRole("button", { name: "Execute saved toggle" }),
  ).toBeDisabled();
  await expect(readFile(counter, "utf8")).rejects.toThrow();
  await page
    .getByRole("button", { name: "Test / Refresh saved state" })
    .click();
  await expect.poll(state).toMatchObject({ confirmed: "off", fresh: true });
  expect(await readFile(counter, "utf8")).toBe("x");
  await configureCommand(
    page.getByRole("group", { name: "State probe", exact: true }),
    "printf private-invalid-probe-output",
  );
  await expect(
    page.getByRole("button", { name: "Test / Refresh saved state" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save toggle configuration" }).click();
  await expect(
    page.getByRole("button", { name: "Test / Refresh saved state" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Test / Refresh saved state" })
    .click();
  await expect.poll(state).toMatchObject({
    confirmed: "unknown",
    fresh: false,
    error: "probe-invalid",
  });
  expect(
    JSON.stringify(await page.evaluate(() => window.decker.snapshot())),
  ).not.toContain('"stdout":"private-invalid-probe-output"');
  await expect(page.locator(".toggle-status")).toContainText("invalid state");
});

test("blocked app-state recovery acknowledges user-verified truth without running either target", async () => {
  const doc = defaults(),
    b = binding("desktop.copy", "Interrupted"),
    marker = join(directory, "effect");
  delete b.press;
  b.toggle = {
    on: command('printf on > "$1"', [marker]),
    off: command('printf off > "$1"', [marker]),
    source: { kind: "app", initial: "off" },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  await writeFile(
    join(directory, "toggles.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          key: toggleKey(doc.decks[0].id, b),
          stamp: toggleStamp(b),
          confirmed: "off",
          pending: "interrupted-fixture",
        },
      ],
    }),
  );
  await launch(doc);
  await expect(page.locator(".toggle-status")).toContainText("Blocked");
  await expect(
    page.getByRole("button", { name: "Execute saved toggle" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "I verified state is on", exact: true })
    .click();
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "on", fresh: true, blocked: false });
  await expect(readFile(marker, "utf8")).rejects.toThrow();
});

test("saved on/off/probe HTTP owners use managed secrets; stale image completion cannot edit another key", async () => {
  const doc = defaults(),
    b = binding("desktop.copy", "Secrets");
  delete b.press;
  const http: Target = {
    kind: "action",
    action: {
      type: "http.request",
      version: 1,
      config: {
        url: "https://example.com",
        method: "GET",
        body: "",
        credentialRef: "",
      },
    },
  };
  b.toggle = {
    on: structuredClone(http),
    off: structuredClone(http),
    source: { kind: "external", probe: structuredClone(http), timeoutMs: 1000 },
  };
  doc.profiles[0].pages[0].keys = { 0: b, 1: binding("desktop.copy", "Other") };
  await launch(doc);
  for (const group of ["On target", "Off target", "State probe"]) {
    const owner = page.getByRole("group", { name: group, exact: true });
    await owner.getByLabel("Bearer token entry").fill(`synthetic-${group}`);
    await owner
      .getByRole("button", { name: "Save secret", exact: true })
      .click();
    await expect(
      owner
        .getByRole("group", { name: "Bearer token", exact: true })
        .getByRole("status")
        .first(),
    ).toContainText("Session-only");
  }
  const owners = await page.evaluate(
    async () => (await window.decker.snapshot()).credentialState?.owners,
  );
  expect(Object.keys(owners!).filter((k) => k.includes(b.id))).toHaveLength(3);
  const image = await imageGate();
  await page
    .getByRole("button", { name: "Choose on image…", exact: true })
    .click();
  await page.getByRole("button", { name: /^Key 2: Other/ }).click();
  await finishAsset(image);
  await expect(page.getByLabel("Button mode", { exact: true })).toHaveValue(
    "ordinary",
  );
  expect((await saved()).toggle!.appearance).toBeUndefined();
});

test("adapter observations update microphone and speaker toggles without presses and never infer success from a no-op", async () => {
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "wpctl"),
    `#!/bin/sh
base=$(dirname "$0")
case "$1" in
  status) exit 0 ;;
  get-volume) case "$2" in *SOURCE*) cat "$base/microphone" ;; *) cat "$base/speaker" ;; esac ;;
  set-mute) if [ -f "$base/accept" ]; then
    if [ "$3" = 1 ]; then printf 'Volume: 0.8 [MUTED]' > "$base/microphone"; else printf 'Volume: 0.8' > "$base/microphone"; fi
    fi; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  await chmod(join(bin, "wpctl"), 0o700);
  await writeFile(join(bin, "microphone"), "Volume: 0.8");
  await writeFile(join(bin, "speaker"), "Volume: 0.8 [MUTED]");
  const doc = defaults(),
    b = binding("desktop.copy", "Mic mute"),
    speaker = binding("desktop.copy", "Speaker mute");
  delete b.press;
  delete speaker.press;
  const mute = (value: string): Target => ({
    kind: "action",
    action: {
      type: "audio.control",
      version: 1,
      config: {
        operation: "mute",
        target: "@DEFAULT_AUDIO_SOURCE@",
        value,
        deviceKind: "input",
      },
    },
  });
  b.toggle = {
    on: mute("1"),
    off: mute("0"),
    source: {
      kind: "observed",
      observation: { kind: "audio", target: "microphone" },
      onWhen: true,
    },
    appearance: { on: { label: "Mic muted" }, off: { label: "Mic live" } },
  };
  speaker.toggle = {
    on: command("true"),
    off: command("true"),
    source: {
      kind: "observed",
      observation: { kind: "audio", target: "speaker" },
      onWhen: true,
    },
  };
  doc.profiles[0].pages[0].keys = { 0: b, 1: speaker };
  await launch(doc, { PATH: `${bin}:${process.env.PATH}` });
  await expect
    .poll(state, { timeout: 10000 })
    .toMatchObject({ confirmed: "off", fresh: true });
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await window.decker.snapshot()).toggles?.[1],
        ),
      { timeout: 10000 },
    )
    .toMatchObject({ confirmed: "on", fresh: true });
  await page.getByRole("button", { name: "Execute saved toggle" }).click();
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "off", fresh: true, error: "probe-disagreed" });
  await writeFile(join(bin, "microphone"), "Volume: 0.8 [MUTED]");
  await expect
    .poll(state, { timeout: 10000 })
    .toMatchObject({ confirmed: "on", fresh: true });
  await expect(
    page.getByRole("button", { name: /^Key 1: Mic muted/ }),
  ).toBeVisible();
  await writeFile(join(bin, "accept"), "");
  await page.getByRole("button", { name: "Execute saved toggle" }).click();
  // Confirm from a fresh provider read after the effect, before the next 4s poll.
  await expect
    .poll(state, { timeout: 1500 })
    .toMatchObject({ confirmed: "off", fresh: true, transitioning: false });
  await writeFile(join(bin, "microphone"), "Volume: 0.8 [MUTED]");
  await expect
    .poll(state, { timeout: 10000 })
    .toMatchObject({ confirmed: "on", fresh: true });
  await writeFile(join(bin, "microphone"), "invalid observation");
  await expect
    .poll(state, { timeout: 10000 })
    .toMatchObject({ confirmed: "on", fresh: false });
  await expect(
    page.getByRole("button", { name: "Execute saved toggle" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /^Key 1: Mic muted/ }).click();
  await expect(page.getByLabel("State source", { exact: true })).toHaveValue(
    "audio",
  );
  // All new controls remain reachable in a narrow inspector without a horizontal overflow.
  await page.locator(".inspector").evaluate((el) => {
    (el as HTMLElement).style.width = "260px";
  });
  expect(
    await page
      .locator(".toggle-editor")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});

test("cosmetic saves preserve a running transition while executable replacement cancels old completions", async () => {
  const doc = defaults(),
    b = binding("desktop.copy", "Running state"),
    marker = join(directory, "effect");
  delete b.press;
  b.toggle = {
    on: command('sleep 2; printf on > "$1"', [marker]),
    off: command('sleep 2; printf off > "$1"', [marker]),
    source: { kind: "app", initial: "off" },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  await launch(doc);
  await page.getByRole("button", { name: "Execute saved toggle" }).click();
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "off", transitioning: true });
  await page
    .getByLabel("on label", { exact: true })
    .fill("Edited while running");
  await page.getByRole("button", { name: "Save toggle configuration" }).click();
  await expect.poll(saved).toMatchObject({ generation: b.generation });
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "on", transitioning: false });
  expect(await readFile(marker, "utf8")).toBe("on");
  await page.getByRole("button", { name: "Execute saved toggle" }).click();
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "on", transitioning: true });
  await configureCommand(
    page.getByRole("group", { name: "Off target", exact: true }),
    "true",
  );
  await page.getByRole("button", { name: "Save toggle configuration" }).click();
  await expect.poll(saved).toMatchObject({ generation: b.generation + 1 });
  await expect
    .poll(state)
    .toMatchObject({ confirmed: "off", transitioning: false });
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).runs.at(-1)?.status,
      ),
    )
    .toBe("cancelled");
  expect(await readFile(marker, "utf8")).toBe("on");
});

test("named OBS observations reconcile events, retain missing choices and keep replacement sources inactive until refresh", async () => {
  const server = await fakeObs();
  try {
    const doc = defaults(),
      b = binding("desktop.copy", "OBS observed");
    delete b.press;
    doc.connections = [
      { id: "obs-fixture", name: "Studio fixture", url: server.url },
    ];
    b.toggle = {
      on: command("true"),
      off: command("true"),
      source: {
        kind: "observed",
        observation: {
          kind: "obs",
          connectionId: "obs-fixture",
          property: "scene",
          name: "Fixture scene",
        },
        onWhen: true,
      },
      appearance: {
        on: { label: "Scene active" },
        off: { label: "Other scene" },
      },
    };
    doc.profiles[0].pages[0].keys = { 0: b };
    await launch(doc);
    await expect.poll(state).toMatchObject({ confirmed: "on", fresh: true });
    await expect(
      page.getByRole("button", { name: "OBS connection: Studio fixture" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Observed OBS target: Fixture scene" })
      .click();
    await expect(
      page.getByRole("option", { name: "Fixture scene", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Search observed OBS targets" })
      .press("Escape");
    server.emit("CurrentProgramSceneChanged", { sceneName: "Other" });
    await expect.poll(state).toMatchObject({ confirmed: "off", fresh: true });
    await expect(
      page.getByRole("button", { name: /^Key 1: Other scene/ }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Observed OBS name", { exact: true }),
    ).toHaveValue("Fixture scene");
    await page
      .getByLabel("Observed OBS property", { exact: true })
      .selectOption("streaming");
    await page
      .getByLabel("On-state meaning", { exact: true })
      .selectOption("false");
    await page
      .getByRole("button", { name: "Save toggle configuration" })
      .click();
    await expect
      .poll(state)
      .toMatchObject({ confirmed: "unknown", fresh: false });
    server.emit("StreamStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.decker.snapshot()).observed["obs:obs-fixture"],
        ),
      )
      .toMatchObject({ streaming: true });
    expect(await state()).toMatchObject({ confirmed: "unknown", fresh: false });
    await page
      .getByRole("button", { name: "Test / Refresh saved state" })
      .click();
    await expect.poll(state).toMatchObject({ confirmed: "off", fresh: true });
    await server.close();
    await expect.poll(state).toMatchObject({ confirmed: "off", fresh: false });
    await expect(
      page.getByRole("button", { name: "Execute saved toggle" }),
    ).toBeDisabled();
    expect((await page.evaluate(() => window.decker.snapshot())).runs).toEqual(
      [],
    );
  } finally {
    await server.close().catch(() => {});
  }
});

test("OBS connection replacement invalidates a running target and reconciles only the new connection", async () => {
  const first = await fakeObs(),
    second = await fakeObs();
  try {
    const doc = defaults(),
      b = binding("desktop.copy", "Connection guard"),
      marker = join(directory, "obsolete-effect");
    delete b.press;
    doc.connections = [{ id: "studio", name: "Studio", url: first.url }];
    b.toggle = {
      on: command('sleep 2; printf obsolete > "$1"', [marker]),
      off: command("true"),
      source: {
        kind: "observed",
        observation: {
          kind: "obs",
          connectionId: "studio",
          property: "streaming",
          name: "",
        },
        onWhen: true,
      },
    };
    doc.profiles[0].pages[0].keys = { 0: b };
    await launch(doc);
    await expect.poll(state).toMatchObject({ confirmed: "off", fresh: true });
    await page.getByRole("button", { name: "Execute saved toggle" }).click();
    await expect.poll(state).toMatchObject({ transitioning: true });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.decker.snapshot()).runs.at(-1)?.status,
        ),
      )
      .toBe("running");
    await page.evaluate(async (url) => {
      const doc = (await window.decker.snapshot()).document;
      doc.connections[0].url = url;
      await window.decker.request({ type: "save", document: doc });
    }, second.url);
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.decker.snapshot()).runs.at(-1)?.status,
        ),
      )
      .toBe("cancelled");
    await expect
      .poll(state)
      .toMatchObject({ confirmed: "off", fresh: false, transitioning: false });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    await expect.poll(() => second.connections).toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.decker.snapshot()).observed["obs:studio"],
        ),
      )
      .toMatchObject({ connected: true, streaming: false });
    await page
      .getByRole("button", { name: "Test / Refresh saved state" })
      .click();
    await expect
      .poll(state)
      .toMatchObject({ confirmed: "off", fresh: true, blocked: false });
    first.emit("StreamStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    expect(
      (await page.evaluate(() => window.decker.snapshot())).observed[
        "obs:studio"
      ],
    ).toMatchObject({ streaming: false });
  } finally {
    await first.close();
    await second.close();
  }
});

test("replacement generations discard drafts and reject late image results for the same key", async () => {
  const doc = defaults(),
    b = binding("desktop.copy", "Owned key");
  delete b.press;
  b.toggle = {
    on: command("true"),
    off: command("true"),
    source: { kind: "app", initial: "off" },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  await launch(doc);
  const image = await imageGate();
  await page.getByLabel("on label", { exact: true }).fill("Stale draft");
  await page
    .getByRole("button", { name: "Choose on image…", exact: true })
    .click();
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    const t = doc.profiles[0].pages[0].keys[0].toggle!;
    if (t.on.kind !== "action") throw new Error();
    t.on.action.config.executable = "/bin/false";
    await window.decker.request({ type: "save", document: doc });
  });
  await expect(
    page.getByRole("button", { name: "Save toggle configuration" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "On target", exact: true })
      .getByLabel("Executable", { exact: true }),
  ).toHaveValue("/bin/false");
  await finishAsset(image);
  expect((await saved()).toggle!.appearance).toBeUndefined();
  await page
    .getByRole("button", { name: "Choose image…", exact: true })
    .click();
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    const t = doc.profiles[0].pages[0].keys[0].toggle!;
    if (t.off.kind !== "action") throw new Error();
    t.off.action.config.executable = "/bin/false";
    await window.decker.request({ type: "save", document: doc });
  });
  await expect(
    page
      .getByRole("group", { name: "Off target", exact: true })
      .getByLabel("Executable", { exact: true }),
  ).toHaveValue("/bin/false");
  await finishAsset(image);
  expect((await saved()).appearance.asset).toBeUndefined();
});
