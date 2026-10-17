import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import WebSocket from "ws";
import type { Json } from "../../src/shared/schema";
let app: ElectronApplication,
  page: Page,
  directory: string,
  server: Server,
  base: string;
let name = "Avatar one",
  fail = 0,
  requests = 0,
  slow: ServerResponse | undefined,
  image: Buffer;
async function launch() {
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
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-visible-refresh-"));
  name = "Avatar one";
  fail = 0;
  requests = 0;
  slow = undefined;
  image = await sharp({
    create: { width: 12, height: 12, channels: 4, background: "#2468ac" },
  })
    .png()
    .toBuffer();
  server = createServer((req, res) => {
    if (req.url === "/api") {
      requests++;
      if (fail) {
        res.writeHead(fail, { "Retry-After": "120" });
        res.end("private-response-secret");
      } else res.end(JSON.stringify({ name, avatar: base + "/avatar" }));
    } else if (req.url === "/slow") {
      requests++;
      slow = res;
      res.writeHead(200);
      res.write("{");
    } else {
      res.setHeader("Content-Type", "image/png");
      res.end(image);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
async function fixture(seconds = 60, web = false, url = "/api") {
  return page.evaluate(
    async ({ base, seconds, web, url }) => {
      const d = (await window.decker.snapshot()).document,
        w = d.workflows[0],
        b = d.profiles[0].pages[0].keys[2];
      const step = (
        id: string,
        type: string,
        config: Record<string, Json>,
      ) => ({
        id,
        name: id,
        kind: "action" as const,
        config: {},
        action: { type, version: 1 as const, config },
        timeoutMs: 30000,
        retries: 0,
        retrySafe: false,
      });
      const nodes = [
        step("http", "http.request", {
          url: base + url,
          method: "GET",
          body: "",
          credentialRef: "",
        }),
        step("parse", "data.parseJson", { input: { $ref: "outputs.http" } }),
        step("image", "image.fetch", {
          url: { $ref: "outputs.parse.value.avatar" },
        }),
        step("update", "deck.appearance", {
          label: { $ref: "outputs.parse.value.name" },
          asset: { $ref: "outputs.image.asset" },
        }),
      ];
      w.name = "Avatar refresh";
      w.graph = {
        entry: nodes[0].id,
        nodes,
        edges: nodes.slice(1).map((n, i) => ({
          id: String(i),
          source: nodes[i].id,
          target: n.id,
          port: "next",
        })),
      };
      const press = structuredClone(w);
      press.id = crypto.randomUUID();
      press.name = "Independent press";
      press.graph = {
        entry: "press",
        nodes: [
          {
            id: "press",
            name: "Press",
            kind: "set",
            config: { pressed: true },
            timeoutMs: 30000,
            retries: 0,
            retrySafe: false,
          },
        ],
        edges: [],
      };
      d.workflows.push(press);
      b.press = { kind: "workflow", workflowId: press.id };
      b.appearance.label = "Authored";
      b.refresh = {
        id: crypto.randomUUID(),
        workflowId: w.id,
        inputs: {},
        seconds,
        initial: true,
        enabled: true,
      }; // renderer save must strip attempted activation
      d.profiles[0].pages.push({ id: "away", name: "Away", keys: {} });
      if (web) {
        d.decks[0].kind = "web";
        d.settings.webEnabled = true;
        d.settings.webPort = 0;
      }
      const saved = (await window.decker.request({
        type: "save",
        document: d,
      })) as Awaited<ReturnType<typeof window.decker.snapshot>>;
      return {
        bindingId: b.id,
        workflowId: w.id,
        pressId: press.id,
        deckId: d.decks[0].id,
      };
    },
    { base, seconds, web, url },
  );
}
async function enable() {
  await page.getByRole("button", { name: /^Key 3:/ }).click();
  await page
    .getByRole("button", { name: "Enable refresh", exact: true })
    .click();
}
async function lastSuccess() {
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).refresh?.[0].lastSuccess,
      ),
    )
    .toBeTruthy();
}
/** Only the test main process owns this clock. Production IPC exposes no timer/run hook. */
async function installClock() {
  await app.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      refreshClock?: {
        offset: number;
        wall: () => number;
        mono: () => number;
        timers: (() => void)[];
      };
    };
    const state: NonNullable<typeof g.refreshClock> = {
      offset: 0,
      wall: Date.now.bind(Date),
      mono: performance.now.bind(performance),
      timers: [],
    };
    g.refreshClock = state;
    Date.now = () => state.wall() + state.offset;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => state.mono() + state.offset,
    });
    const native = setTimeout;
    globalThis.setTimeout = ((
      callback: () => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 1000) {
        state.timers.push(callback);
        return {
          unref() {
            return this;
          },
        };
      }
      return native(callback, delay, ...args);
    }) as typeof setTimeout;
  });
}
async function tick(seconds: number, renew?: () => Promise<void>) {
  for (let i = 0; i < seconds; i++) {
    if (i % 4 === 0) {
      if (renew) await renew();
      else
        await page.evaluate(async () => {
          const s = await window.decker.snapshot();
          const d = s.document.decks[0];
          await window.decker.request({
            type: "simulatorVisible",
            deckId: d.id,
            version: s.viewVersions![d.id],
            visible: true,
          });
        });
    }
    await app.evaluate(() => {
      const state = (globalThis as any).refreshClock;
      state.offset += 1000;
      const timers = state.timers.splice(0);
      for (const callback of timers) callback();
    });
  }
}
test("Dynamic workflow preset preserves press, saves inactive; refresh cadence, failures and last-good art remain independent", async () => {
  const ids = await fixture();
  expect(requests).toBe(0);
  await page.getByRole("button", { name: /^Key 3:/ }).click();
  await page
    .getByRole("button", { name: "Dynamic workflow button", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Refresh while visible", exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document.profiles[0]
      .pages[0].keys[2].press,
  ).toEqual({ kind: "workflow", workflowId: ids.pressId });
  await installClock();
  await enable();
  await lastSuccess();
  expect(requests).toBe(1);
  const key = page.getByRole("button", {
    name: "Key 3: Avatar one",
    exact: true,
  });
  const hash = await key.locator("img").getAttribute("src");
  expect(hash).toMatch(/^decker-asset:\/\/[a-f0-9]{64}$/);
  await page.evaluate(async (ids) => {
    await window.decker.request({
      type: "press",
      deckId: ids.deckId,
      key: 2,
      down: true,
    });
    await window.decker.request({
      type: "press",
      deckId: ids.deckId,
      key: 2,
      down: false,
    });
  }, ids);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).runs
            .filter((r) => r.context?.source.kind === "button")
            .at(-1)?.status,
      ),
    )
    .toBe("success");
  expect(requests).toBe(1);
  name = "Avatar two";
  image = await sharp({
    create: { width: 12, height: 12, channels: 4, background: "#bb7733" },
  })
    .png()
    .toBuffer();
  await tick(60);
  await expect(
    page.getByRole("button", { name: "Key 3: Avatar two", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(2);
  const good = await page
    .getByRole("button", { name: "Key 3: Avatar two", exact: true })
    .locator("img")
    .getAttribute("src");
  expect(good).not.toBe(hash);
  fail = 429;
  await tick(60);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).refresh?.[0].status,
      ),
    )
    .toBe("stale");
  expect(requests).toBe(3);
  await expect(
    page
      .getByRole("button", { name: "Key 3: Avatar two", exact: true })
      .locator("img"),
  ).toHaveAttribute("src", good!);
  expect(
    JSON.stringify(
      (await page.evaluate(() => window.decker.snapshot())).refresh,
    ),
  ).not.toMatch(/private-response-secret|127\.0\.0\.1/);
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await tick(120, async () => {});
  expect(requests).toBe(3);
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await tick(1);
  await expect.poll(() => requests).toBe(4);
  const saved = JSON.parse(
    await readFile(join(directory, "config.json"), "utf8"),
  );
  expect(saved.schemaVersion).toBe(7);
  expect(saved.profiles[0].pages[0].keys[2].refresh.enabled).toBe(true);
  await app.close();
  await launch();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.decker.snapshot()).refresh?.[0].status,
      ),
    )
    .toBe("error");
  expect(
    (await page.evaluate(() => window.decker.snapshot())).refresh?.[0]
      .lastSuccess,
  ).toBeUndefined();
  await expect(
    page
      .getByRole("button", { name: "Key 3: Avatar two", exact: true })
      .locator("img"),
  ).toHaveAttribute("src", good!);
});
test("five-minute choice, draft validation, inactive copies and current saved enable guard", async () => {
  const ids = await fixture(300);
  await page.getByRole("button", { name: /^Key 3:/ }).click();
  await page.getByRole("button", { name: "Edit refresh", exact: true }).click();
  await page
    .getByLabel("Refresh interval", { exact: true })
    .selectOption("300");
  await page
    .getByRole("spinbutton", { name: "Refresh seconds", exact: true })
    .fill("59");
  await expect(
    page.getByRole("button", { name: "Save refresh", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("spinbutton", { name: "Refresh seconds", exact: true })
    .fill("300");
  await page.getByRole("button", { name: "Save refresh", exact: true }).click();
  expect(requests).toBe(0);
  await installClock();
  await enable();
  await lastSuccess();
  await tick(299);
  expect(requests).toBe(1);
  await tick(1);
  await expect.poll(() => requests).toBe(2);
  await page
    .getByRole("button", { name: "Duplicate to empty key", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).document.profiles[0].pages[0].keys[3]
            ?.refresh?.enabled,
      ),
    )
    .toBe(false);
  const stale = (await page.evaluate(() => window.decker.snapshot())).document;
  await page.evaluate(async (ids) => {
    const s = await window.decker.snapshot(),
      r = s.document.profiles[0].pages[0].keys[2].refresh!;
    await window.decker.request({
      type: "refreshEnable",
      bindingId: ids.bindingId,
      expected: r,
      enabled: false,
    });
  }, ids);
  await page.evaluate(async (text) => {
    await window.decker.request({ type: "save", document: JSON.parse(text) });
  }, JSON.stringify(stale));
  expect(
    (await page.evaluate(() => window.decker.snapshot())).document.profiles[0]
      .pages[0].keys[2].refresh!.enabled,
  ).toBe(false);
  const reconstructed = await page.evaluate(async () => {
    const d = (await window.decker.snapshot()).document,
      b = structuredClone(d.profiles[0].pages[0].keys[2]);
    delete d.profiles[0].pages[0].keys[2];
    await window.decker.request({ type: "save", document: d });
    d.profiles[0].pages[0].keys[2] = b;
    const saved = (await window.decker.request({
      type: "save",
      document: d,
    })) as Awaited<ReturnType<typeof window.decker.snapshot>>;
    return {
      old: b.id,
      current: saved.document.profiles[0].pages[0].keys[2].id,
      enabled: saved.document.profiles[0].pages[0].keys[2].refresh!.enabled,
    };
  });
  expect(reconstructed.current).not.toBe(reconstructed.old);
  expect(reconstructed.enabled).toBe(false);
});
test("hidden/minimized simulator, route and navigation cancel hanging work and reject late display writes", async () => {
  const ids = await fixture(60, false, "/slow");
  await enable();
  await expect.poll(() => !!slow).toBe(true);
  await page.evaluate(async (deckId) => {
    await window.decker.request({ type: "press", deckId, key: 2, down: true });
    await window.decker.request({ type: "press", deckId, key: 2, down: false });
  }, ids.deckId);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).runs.findLast(
            (r) => r.context?.source.kind === "button",
          )?.status,
      ),
    )
    .toBe("success");
  expect(
    (await page.evaluate(() => window.decker.snapshot())).refresh?.[0].status,
  ).toBe("running");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].hide(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).runs.findLast(
            (r) => r.context?.source.kind === "refresh",
          )?.status,
      ),
    )
    .toBe("cancelled");
  slow?.end(JSON.stringify({ name: "Obsolete", avatar: base + "/avatar" }));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  await expect(
    page.getByRole("button", { name: "Key 3: Authored", exact: true }),
  ).toBeVisible();
  expect(
    JSON.stringify(
      (await page.evaluate(() => window.decker.snapshot())).observed
        .buttonDisplay,
    ),
  ).not.toContain("Obsolete");
  const epochs = await page.evaluate(async () => {
    const before = await window.decker.snapshot(),
      deck = before.document.decks[0],
      old = before.viewVersions![deck.id];
    await window.decker.request({
      type: "navigate",
      deckId: deck.id,
      profileId: deck.activeProfileId,
      pageId: "away",
    });
    await window.decker.request({
      type: "navigate",
      deckId: deck.id,
      profileId: deck.activeProfileId,
      pageId: "home",
    });
    const latest = await window.decker.snapshot(),
      version = latest.viewVersions![deck.id];
    await window.decker.request({
      type: "simulatorVisible",
      deckId: deck.id,
      version,
      visible: true,
    });
    await window.decker.request({
      type: "simulatorVisible",
      deckId: deck.id,
      version: old,
      visible: false,
    });
    return {
      old,
      version,
      next: (await window.decker.snapshot()).refresh?.[0].nextAt,
    };
  });
  expect(epochs.version).not.toBe(epochs.old);
  expect(epochs.next).toBeTruthy();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.minimize();
    // Xvfb has no window manager: simulate the OS state/event, validated by main.
    window.isMinimized = () => true;
    window.emit("minimize");
  });
  const s = await page.evaluate(() => window.decker.snapshot());
  await page.evaluate(
    async (s) => {
      await window.decker.request({
        type: "simulatorVisible",
        deckId: s.deckId,
        version: s.version,
        visible: true,
      });
    },
    {
      deckId: s.document.activeDeckId,
      version: s.viewVersions![s.document.activeDeckId],
    },
  );
  expect(
    (await page.evaluate(() => window.decker.snapshot())).refresh?.[0].nextAt,
  ).toBeUndefined();
});
test("paired foreground current-view clients deduplicate refresh; desktop web preview never owns visibility", async () => {
  const ids = await fixture(60, true);
  await installClock();
  await enable();
  expect(requests).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.decker.snapshot()).web.running),
    )
    .toBe(true);
  const pair = async () => {
    const invite = await page.evaluate(
      async (deckId) =>
        (await window.decker.request({ type: "invite", deckId })) as {
          urls: string[];
        },
      ids.deckId,
    );
    const link = invite.urls.find((u) => u.includes("127.0.0.1"))!,
      u = new URL(link),
      origin = u.origin,
      ticket = new URLSearchParams(u.hash.slice(1)).get("invite");
    const post = async (path: string, body: unknown) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Decker-Request": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const pending = (await (
      await post("/api/pair", { ticket, name: "Foreground test" })
    ).json()) as { id: string; pollToken: string };
    await page.evaluate(async (pairingId) => {
      await window.decker.request({
        type: "approvePairing",
        pairingId,
        approved: true,
      });
    }, pending.id);
    const cookie = (await post("/api/pair-status", pending)).headers
      .get("set-cookie")!
      .split(";")[0];
    const ws = new WebSocket(
      origin.replace("http:", "ws:") + `/socket?deck=${ids.deckId}`,
      { origin, headers: { Cookie: cookie } },
    );
    let version = "",
      sequence = 0;
    const ack = async () => {
      if (version && ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: "view",
            version,
            visible: true,
            sequence: ++sequence,
          }),
        );
    };
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.type === "view") {
        version = m.view.version;
        void ack();
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return { ws, ack };
  };
  const a = await pair(),
    b = await pair();
  try {
    await tick(1, b.ack);
    await lastSuccess();
    expect(requests).toBe(1);
    a.ws.close();
    await tick(60, b.ack);
    await expect.poll(() => requests).toBe(2);
    b.ws.close();
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.decker.snapshot()).refresh?.[0].nextAt,
        ),
      )
      .toBeUndefined();
    await tick(120, async () => {});
    expect(requests).toBe(2);
  } finally {
    a.ws.terminate();
    b.ws.terminate();
  }
});
