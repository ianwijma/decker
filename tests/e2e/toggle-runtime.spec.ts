import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { defaults, binding, node, uid } from "../../src/shared/defaults";
import type { AppDocument, Target, WebDeckView } from "../../src/shared/schema";
let app: ElectronApplication, page: Page, directory: string;
function command(script: string, args: string[]): Target {
  return {
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
  };
}
function fixture(external = false) {
  const doc = defaults(),
    b = binding("desktop.copy", "Fixture toggle");
  delete b.press;
  const marker = join(directory, "fixture");
  b.toggle = {
    on: command('printf on > "$1"', [marker]),
    off: command('printf off > "$1"', [marker]),
    source: external
      ? {
          kind: "external",
          probe: command('cat "$1"', [marker]),
          timeoutMs: 1000,
        }
      : { kind: "app", initial: "off" },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  return { doc, b, marker, deckId: doc.decks[0].id };
}
async function launch(doc?: AppDocument) {
  if (doc) await writeFile(join(directory, "config.json"), JSON.stringify(doc));
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
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
async function state(deckId?: string) {
  return page.evaluate(
    async (deck) =>
      (await window.decker.snapshot()).toggles?.find(
        (s) => !deck || s.deckId === deck,
      ),
    deckId,
  );
}
async function press(deckId: string) {
  await page.evaluate(async (deck) => {
    await window.decker.request({
      type: "press",
      deckId: deck,
      key: 0,
      down: true,
    });
    await window.decker.request({
      type: "press",
      deckId: deck,
      key: 0,
      down: false,
    });
  }, deckId);
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-toggle-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

test("desktop and simulator inputs use durable confirmed state across stale saves and restart", async () => {
  const { doc, marker, deckId } = fixture();
  await launch(doc);
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "off", fresh: true });
  const stale = await page.evaluate(
    async () => (await window.decker.snapshot()).document,
  );
  await page
    .getByRole("button", { name: "Key 1: Fixture toggle", exact: true })
    .dblclick();
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "on", transitioning: false });
  expect(await readFile(marker, "utf8")).toBe("on");
  await page.evaluate(
    (raw) => window.decker.request({ type: "save", document: JSON.parse(raw) }),
    JSON.stringify(stale),
  );
  expect(await state()).toMatchObject({ confirmed: "on" });
  await app.close();
  await launch();
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "on", fresh: true });
  await press(deckId);
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "off", transitioning: false });
  expect(await readFile(marker, "utf8")).toBe("off");
  expect(
    (await page.evaluate(() => window.decker.snapshot())).runs.filter(
      (r) => r.bindingId === doc.profiles[0].pages[0].keys[0].id,
    ),
  ).toHaveLength(2);
});

test("external startup, drift, invalid observations and explicit activation preserve truth without probe history", async () => {
  const { doc, b, marker, deckId } = fixture(true);
  await writeFile(marker, "off");
  await launch(doc);
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "off", fresh: true });
  expect((await page.evaluate(() => window.decker.snapshot())).runs).toEqual(
    [],
  );
  await press(deckId);
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "on", fresh: true, transitioning: false });
  await writeFile(marker, "off");
  await page.evaluate(
    ({ deckId, bindingId }) =>
      window.decker.request({ type: "reconcileToggle", deckId, bindingId }),
    { deckId, bindingId: b.id },
  );
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "off", fresh: true });
  await writeFile(marker, "malformed-secret-fixture");
  await page.evaluate(
    ({ deckId, bindingId }) =>
      window.decker.request({ type: "reconcileToggle", deckId, bindingId }),
    { deckId, bindingId: b.id },
  );
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "off", fresh: false, error: "probe-invalid" });
  await press(deckId);
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  expect(snapshot.runs).toHaveLength(1);
  expect(JSON.stringify(snapshot)).not.toContain("malformed-secret-fixture");
  // A new external binding saved in an editor does not run its probe until activation.
  const probeMarker = join(directory, "probe-executed");
  await page.evaluate(async (marker) => {
    const document = (await window.decker.snapshot()).document,
      b = document.profiles[0].pages[0].keys[0];
    if (b.toggle?.source.kind !== "external") throw new Error();
    b.toggle.source.probe = {
      kind: "action",
      action: {
        type: "command.run",
        version: 1,
        config: {
          executable: "/bin/sh",
          args: ["-c", 'printf called > "$1"; printf on', "fixture", marker],
          cwd: "",
        },
      },
    };
    await window.decker.request({ type: "save", document });
  }, probeMarker);
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "unknown", fresh: false });
  await expect(readFile(probeMarker)).rejects.toThrow(/ENOENT/);
  await page.evaluate(() => window.decker.request({ type: "activateToggles" }));
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "on", fresh: true });
  expect(await readFile(probeMarker, "utf8")).toBe("called");
});

test("nested workflow cancellation and runner restart clear activity without replaying uncertain effects", async () => {
  const { doc, b, deckId } = fixture();
  const wait = { ...node("delay", "Long fixture"), config: { ms: 30000 } },
    child = {
      ...doc.workflows[0],
      id: uid(),
      graph: { entry: wait.id, nodes: [wait], edges: [] },
    };
  doc.workflows.push(child);
  b.toggle!.on = {
    kind: "sequence",
    actions: [
      { type: "workflow.run", version: 1, config: { workflowId: child.id } },
    ],
  };
  await launch(doc);
  await expect.poll(() => state()).toMatchObject({ fresh: true });
  await press(deckId);
  await expect.poll(() => state()).toMatchObject({ transitioning: true });
  await page.evaluate(async (workflowId) => {
    const document = (await window.decker.snapshot()).document;
    const cancel = {
      ...document.workflows[0],
      id: crypto.randomUUID(),
      name: "Cancel child",
      graph: {
        entry: "cancel",
        nodes: [
          {
            id: "cancel",
            name: "Cancel",
            kind: "action" as const,
            config: {},
            timeoutMs: 30000,
            retries: 0,
            retrySafe: false,
            action: {
              type: "workflow.cancel",
              version: 1 as const,
              config: { workflowId },
            },
          },
        ],
        edges: [],
      },
    };
    document.workflows.push(cancel);
    await window.decker.request({ type: "save", document });
    await window.decker.request({
      type: "run",
      workflowId: cancel.id,
      inputs: {},
    });
  }, child.id);
  await expect
    .poll(() => state())
    .toMatchObject({
      confirmed: "off",
      transitioning: false,
      error: "cancelled",
    });
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).observed.buttonFeedback,
      ),
    )
    .toEqual({});
  await press(deckId);
  await expect.poll(() => state()).toMatchObject({ transitioning: true });
  const pid = await app.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((p) => p.name === "Decker runner")?.pid,
  );
  expect(pid).toBeTruthy();
  await app.evaluate((_electron, pid) => process.kill(pid!, "SIGKILL"), pid);
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "off", blocked: true, transitioning: false });
  await expect
    .poll(() =>
      app.evaluate(
        ({ app }, old) =>
          app
            .getAppMetrics()
            .some((p) => p.name === "Decker runner" && p.pid !== old),
        pid,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => state())
    .toMatchObject({ error: "interrupted", blocked: true });
  const before = (await page.evaluate(() => window.decker.snapshot())).runs
    .length;
  await press(deckId);
  expect(
    (await page.evaluate(() => window.decker.snapshot())).runs,
  ).toHaveLength(before);
});

test("paired web input uses the same toggle runtime and stays independent from the desktop deck", async () => {
  const { doc, b, deckId } = fixture();
  const webBinding = structuredClone(b);
  webBinding.id = uid();
  const webMarker = join(directory, "web-fixture");
  webBinding.toggle!.on = command('printf on > "$1"', [webMarker]);
  webBinding.toggle!.off = command('printf off > "$1"', [webMarker]);
  doc.profiles.push({
    id: "web-profile",
    name: "Phone",
    pages: [{ id: "web-page", name: "Home", keys: { 0: webBinding } }],
  });
  doc.decks.push({
    ...doc.decks[0],
    id: "web-deck",
    name: "Phone",
    kind: "web",
    rows: 1,
    columns: 1,
    profileIds: ["web-profile"],
    activeProfileId: "web-profile",
    activePageId: "web-page",
  });
  doc.settings.webEnabled = true;
  doc.settings.webPort = 0;
  await launch(doc);
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.decker.snapshot()).web.running),
    )
    .toBe(true);
  const invitation = (await page.evaluate(() =>
    window.decker.request({ type: "invite", deckId: "web-deck" }),
  )) as { urls: string[] };
  const link = new URL(
      invitation.urls.find((url) => url.includes("127.0.0.1"))!,
    ),
    base = link.origin;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Origin: base,
        "X-Decker-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const pending = (await (
    await post("/api/pair", {
      ticket: new URLSearchParams(link.hash.slice(1)).get("invite"),
      name: "Toggle fixture",
    })
  ).json()) as { id: string; pollToken: string };
  await page.evaluate(
    (pairingId) =>
      window.decker.request({
        type: "approvePairing",
        pairingId,
        approved: true,
      }),
    pending.id,
  );
  const response = await post("/api/pair-status", pending),
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  const ws = new WebSocket(base.replace("http:", "ws:") + "/socket", {
    origin: base,
    headers: { Cookie: cookie },
  });
  let view: WebDeckView | undefined;
  const messages: unknown[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data));
    messages.push(message);
    if (message.type === "view") view = message.view;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await expect.poll(() => !!view).toBe(true);
    ws.send(
      JSON.stringify({
        type: "down",
        key: 0,
        version: view!.version,
        sequence: 1,
      }),
    );
    ws.send(JSON.stringify({ type: "up", key: 0, sequence: 2 }));
    await expect
      .poll(() => state("web-deck"))
      .toMatchObject({ confirmed: "on", transitioning: false });
    expect(await readFile(webMarker, "utf8")).toBe("on");
    expect(await state(deckId)).toMatchObject({ confirmed: "off" });
    expect(JSON.stringify(messages)).not.toContain('"confirmed":');
    expect(JSON.stringify(messages)).not.toContain("stdout");
  } finally {
    ws.close();
  }
});

test("detached drafts do not execute and re-adding a deleted toggle allocates a fresh runtime identity", async () => {
  const { doc, b, deckId, marker } = fixture();
  await launch(doc);
  await expect.poll(() => state()).toMatchObject({ fresh: true });
  const detached = structuredClone(b);
  detached.id = uid();
  await page.evaluate(
    (raw) =>
      window.decker.request({
        type: "test",
        deckId: "simulator-xl",
        binding: JSON.parse(raw),
      }),
    JSON.stringify(detached),
  );
  await expect(readFile(marker)).rejects.toThrow(/ENOENT/);
  const newId = await page.evaluate(async (raw) => {
    const old = JSON.parse(raw),
      document = (await window.decker.snapshot()).document;
    delete document.profiles[0].pages[0].keys[0];
    await window.decker.request({ type: "save", document });
    const next = (await window.decker.snapshot()).document;
    next.profiles[0].pages[0].keys[0] = old;
    const saved = (await window.decker.request({
      type: "save",
      document: next,
    })) as import("../../src/shared/schema").Snapshot;
    return saved.document.profiles[0].pages[0].keys[0].id;
  }, JSON.stringify(b));
  expect(newId).not.toBe(b.id);
  await expect
    .poll(() => state())
    .toMatchObject({ bindingId: newId, confirmed: "off", fresh: true });
  await press(deckId);
  await expect
    .poll(() => state())
    .toMatchObject({ confirmed: "on", transitioning: false });
  expect(await readFile(marker, "utf8")).toBe("on");
});
