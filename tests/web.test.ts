import { DisplayState } from "../src/main/display-state";
import { GeneratedAssets } from "../src/main/generated-assets";
import { normalizeImage } from "../src/main/remote-images";
import { defaults, uid } from "../src/shared/defaults";
import { captureOrigin } from "../src/shared/trigger-context";
import { buttonAppearance } from "../src/shared/feedback";
import { Images } from "../src/device/images";
import sharp from "sharp";
import { it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import {
  WebDeckServer,
  isLocalAddress,
  type StoredClient,
} from "../src/web/server";
import type { WebDeckView, WebStatus } from "../src/shared/schema";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
const view = (id = "tablet"): WebDeckView => ({
  id,
  name: id,
  rows: 2,
  columns: 3,
  pageName: "Home",
  version: "page-1",
  accent: "#5865f2",
  keys: {
    0: {
      label: "Copy",
      icon: "▣",
      background: "#232428",
      asset: "a".repeat(64),
    },
  },
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "decker-web-"));
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "web.html"),
    '<html><script src="/assets/web-test.js"></script></html>',
  );
  await writeFile(
    join(directory, "assets", "web-test.js"),
    'console.log("controller")',
  );
  await writeFile(join(directory, "a".repeat(64)), "image");
  const input = vi.fn(),
    disconnect = vi.fn(),
    visibility = vi.fn(),
    visibilityLost = vi.fn();
  let clock = Date.now();
  let status: WebStatus = {
      running: false,
      port: 0,
      urls: [],
      clients: [],
      pending: [],
    },
    stored: StoredClient[] = [];
  const server = new WebDeckServer({
    rendererDirectory: directory,
    assetDirectory: directory,
    loadClients: async () => stored,
    saveClients: async (clients) => {
      stored = structuredClone(clients);
    },
    input,
    disconnect,
    visibility,
    visibilityLost,
    now: () => clock,
    status: (s) => {
      status = s;
    },
  });
  server.configure([view(), view("other")]);
  await server.start(0);
  const base = `http://127.0.0.1:${status.port}`;
  cleanup.push(async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Origin: base,
        "X-Decker-Request": "1",
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const pair = async (deckId = "tablet") => {
    const link = server
        .invite(deckId)
        .urls.find((url) => url.includes("127.0.0.1"))!,
      ticket = new URLSearchParams(new URL(link).hash.slice(1)).get("invite");
    const pending = (await (
      await post("/api/pair", { ticket, name: "Phone" })
    ).json()) as { id: string; pollToken: string; code: string };
    server.approve(pending.id, true);
    const response = await post("/api/pair-status", pending);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      clientId: status.clients.at(-1)!.id,
      pending,
    };
  };
  return {
    directory,
    server,
    base,
    input,
    disconnect,
    post,
    pair,
    visibility,
    visibilityLost,
    advanceClock: (ms: number) => {
      clock += ms;
    },
    status: () => status,
    stored: () => stored,
  };
}
async function connect(base: string, cookie: string) {
  const messages: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(base.replace("http:", "ws:") + "/socket", {
    origin: base,
    headers: { Cookie: cookie },
  });
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await sleep(10);
  return { ws, messages };
}
it("requires desktop approval, uses one-use expiring invitations, and persists hashes only", async () => {
  const f = await fixture(),
    link = f.server.invite("tablet").urls[0],
    ticket = new URLSearchParams(new URL(link).hash.slice(1)).get("invite");
  const pending = await (
    await f.post("/api/pair", { ticket, name: "Phone" })
  ).json();
  expect(f.status().pending).toHaveLength(1);
  expect((await f.post("/api/pair", { ticket, name: "Reuse" })).status).toBe(
    403,
  );
  expect(await (await f.post("/api/pair-status", pending)).json()).toEqual({
    approved: null,
  });
  f.server.approve(pending.id, true);
  const response = await f.post("/api/pair-status", pending);
  expect(response.headers.get("set-cookie")).toContain(
    "HttpOnly; SameSite=Strict",
  );
  expect(f.stored()[0].tokenHash).toHaveLength(64);
  expect(JSON.stringify(f.status())).not.toContain("tokenHash");
  expect((await f.post("/api/pair-status", pending)).status).toBe(403);
  const expired = f.server.invite("tablet");
  vi.spyOn(Date, "now").mockReturnValue(expired.expiresAt + 1);
  const old = new URLSearchParams(new URL(expired.urls[0]).hash.slice(1)).get(
    "invite",
  );
  expect(
    (await f.post("/api/pair", { ticket: old, name: "Late" })).status,
  ).toBe(403);
});
it("limits paired clients to their own deck and sends only display state", async () => {
  const f = await fixture(),
    a = await f.pair(),
    b = await f.pair("other");
  expect(
    (
      await fetch(`${f.base}/api/session?deck=other`, {
        headers: { Cookie: a.cookie },
      })
    ).status,
  ).toBe(401);
  const { ws, messages } = await connect(f.base, a.cookie);
  expect(messages[0]).toMatchObject({
    type: "view",
    view: { id: "tablet", rows: 2, columns: 3 },
  });
  expect(JSON.stringify(messages)).not.toMatch(
    /command|credential|action|workflow/,
  );
  ws.send(
    JSON.stringify({
      type: "down",
      key: 0,
      version: "page-1",
      sequence: 1,
      deckId: "other",
    }),
  );
  ws.send(JSON.stringify({ type: "up", key: 0, sequence: 2 }));
  await sleep(20);
  expect(f.input.mock.calls.map((c) => c[0])).toMatchObject([
    { deckId: "tablet", down: true },
    { deckId: "tablet", down: false },
  ]);
  const other = await connect(f.base, b.cookie);
  expect(other.messages[0]).toMatchObject({ view: { id: "other" } });
  ws.close();
  other.ws.close();
});
it("rejects stale and out-of-bounds presses, duplicates, and arbitrary command messages", async () => {
  const f = await fixture(),
    paired = await f.pair(),
    { ws } = await connect(f.base, paired.cookie);
  for (const message of [
    { type: "down", key: 0, version: "old", sequence: 1 },
    { type: "down", key: 6, version: "page-1", sequence: 2 },
    { type: "command", executable: "evil", sequence: 3 },
    { type: "down", key: 0, version: "page-1", sequence: 4 },
    { type: "down", key: 0, version: "page-1", sequence: 4 },
  ])
    ws.send(JSON.stringify(message));
  await sleep(20);
  expect(f.input).toHaveBeenCalledTimes(1);
  f.server.configure([{ ...view(), version: "new" }, view("other")]);
  ws.send(JSON.stringify({ type: "up", key: 0, sequence: 5 }));
  await sleep(10);
  expect(f.input.mock.calls[1][0].down).toBe(false);
  ws.close();
});
it("clears held sources on reset, disconnect, revoke, stop, and deck deletion", async () => {
  const f = await fixture(),
    paired = await f.pair(),
    { ws } = await connect(f.base, paired.cookie);
  ws.send(
    JSON.stringify({ type: "down", key: 0, version: "page-1", sequence: 1 }),
  );
  ws.send(JSON.stringify({ type: "reset", sequence: 2 }));
  await sleep(10);
  expect(f.disconnect).toHaveBeenCalled();
  f.server.revoke(paired.clientId);
  await sleep(10);
  expect(f.status().clients).toHaveLength(0);
  expect(
    (
      await fetch(`${f.base}/api/session?deck=tablet`, {
        headers: { Cookie: paired.cookie },
      })
    ).status,
  ).toBe(401);
  const next = await f.pair(),
    connection = await connect(f.base, next.cookie);
  f.server.configure([view("other")]);
  await sleep(10);
  expect(connection.ws.readyState).not.toBe(WebSocket.OPEN);
  await f.server.stop();
  expect(f.status().running).toBe(false);
});
it("does not expose desktop file selection or filesystem requests to paired input", async () => {
  const f = await fixture(),
    paired = await f.pair(),
    { ws } = await connect(f.base, paired.cookie);
  for (const [index, request] of [
    { type: "pickFile", picker: "openFile" },
    { type: "pickFile", picker: "saveFile" },
    { type: "asset" },
    { type: "desktop.openFile", path: "/etc/passwd" },
    { type: "request", request: { type: "pickFile", picker: "openFile" } },
  ].entries()) {
    ws.send(JSON.stringify({ ...request, sequence: index + 1 }));
    expect(
      (await f.post("/api/request", request, { Cookie: paired.cookie })).status,
    ).toBe(404);
  }
  // An authorized key remains usable; only down/up reach the host callback.
  ws.send(
    JSON.stringify({ type: "down", key: 0, version: "page-1", sequence: 6 }),
  );
  ws.send(JSON.stringify({ type: "up", key: 0, sequence: 7 }));
  await vi.waitFor(() => expect(f.input).toHaveBeenCalledTimes(2));
  expect(f.input.mock.calls.map(([event]) => event.down)).toEqual([
    true,
    false,
  ]);
  expect(
    f.input.mock.calls.every(
      ([event]) =>
        Object.keys(event).sort().join() === "deckId,down,key,source",
    ),
  ).toBe(true);
  ws.close();
});
it("rejects foreign origins and hosts and serves only the browser bundle and authorized key assets", async () => {
  const f = await fixture();
  expect(
    (
      await f.post(
        "/api/pair",
        { ticket: "unknown", name: "Phone" },
        { Origin: "http://evil.test" },
      )
    ).status,
  ).toBe(403);
  expect(
    await new Promise<number>((resolve) =>
      httpGet(f.base, { headers: { Host: "evil.test" } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      }),
    ),
  ).toBe(403);
  expect((await fetch(`${f.base}/assets/web-test.js`)).status).toBe(200);
  expect((await fetch(`${f.base}/assets/desktop.js`)).status).toBe(404);
  expect((await fetch(`${f.base}/key-assets/${"a".repeat(64)}`)).status).toBe(
    403,
  );
  const paired = await f.pair();
  expect(
    (
      await fetch(`${f.base}/key-assets/${"a".repeat(64)}`, {
        headers: { Cookie: paired.cookie },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${f.base}/key-assets/${"b".repeat(64)}`, {
        headers: { Cookie: paired.cookie },
      })
    ).status,
  ).toBe(403);
  expect(isLocalAddress("8.8.8.8")).toBe(false);
  expect(isLocalAddress("::ffff:192.168.1.2")).toBe(true);
});

it("keeps multiple deck cookies separate and restores paired browsers after a service restart", async () => {
  const f = await fixture(),
    a = await f.pair(),
    b = await f.pair("other"),
    cookies = `${a.cookie}; ${b.cookie}`;
  for (const deck of ["tablet", "other"])
    expect(
      (
        await fetch(`${f.base}/api/session?deck=${deck}`, {
          headers: { Cookie: cookies },
        })
      ).status,
    ).toBe(200);
  const stored = structuredClone(f.stored());
  await f.server.stop();
  let status: WebStatus = {
    running: false,
    port: 0,
    urls: [],
    clients: [],
    pending: [],
  };
  const input = vi.fn();
  const restarted = new WebDeckServer({
    rendererDirectory: f.directory,
    assetDirectory: f.directory,
    loadClients: async () => stored,
    saveClients: async () => {},
    input,
    disconnect: () => {},
    status: (s) => {
      status = s;
    },
  });
  restarted.configure([view(), view("other")]);
  await restarted.start(0);
  cleanup.push(() => restarted.stop());
  const base = `http://127.0.0.1:${status.port}`;
  expect(
    (
      await fetch(`${base}/api/session?deck=tablet`, {
        headers: { Cookie: cookies },
      })
    ).status,
  ).toBe(200);
  const { ws, messages } = await connect(base, a.cookie);
  expect(messages[0]).toMatchObject({ view: { id: "tablet" } });
  expect(input).not.toHaveBeenCalled();
  ws.close();
});

it("authorizes resolved dynamic assets per deck and preserves desktop/web/frame composition parity", async () => {
  const f = await fixture(),
    document = defaults(),
    deck = document.decks[0],
    binding = document.profiles[0].pages[0].keys[0];
  deck.id = "tablet";
  const source = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const bytes = (await normalizeImage(source, new AbortController().signal))
    .normalized;
  const display = new DisplayState(f.directory, f.directory, () => document),
    launch = display.accept(
      "button",
      captureOrigin(document, deck.id, binding),
    ),
    runId = uid(),
    actionId = uid();
  display.begin(launch.authority!, runId);
  display.action(launch.authority!, runId, actionId, true);
  const generated = new GeneratedAssets(
    f.directory,
    f.directory,
    () => new Set(),
    () => display.assetReferences(),
  );
  await generated.load();
  const hash = await generated.ingest(
    bytes,
    runId,
    new AbortController().signal,
  );
  await display.commit(
    { label: "Fetched 0", icon: "pack:lucide:v1:user", asset: hash },
    { authority: launch.authority, runId, actionId },
  );
  generated.release(runId);
  await generated.collect();
  const ticket = display.beginImage({
    authority: launch.authority,
    runId,
    actionId,
  });
  display.imageResult(
    { authority: launch.authority, runId, actionId },
    ticket,
    true,
  );
  const desktop = buttonAppearance(
    binding,
    { buttonDisplay: display.snapshot() },
    document.settings.accent,
    deck.id,
  );
  f.server.configure([
    {
      ...view(),
      keys: {
        0: {
          label: desktop.label,
          background: desktop.background,
          icon: desktop.icon,
          asset: desktop.asset,
          imageStatus: desktop.imageStatus,
        },
      },
    },
    view("other"),
  ]);
  const paired = await f.pair(),
    other = await f.pair("other"),
    connection = await connect(f.base, paired.cookie);
  const payload = connection.messages[0] as { view: WebDeckView };
  expect(payload.view.keys[0]).toMatchObject({
    label: "Fetched 0",
    asset: hash,
    imageStatus: "stale",
  });
  expect(JSON.stringify(connection.messages)).not.toMatch(
    /authority|invocationId|buttonDisplay|outputs/,
  );
  expect(
    (
      await fetch(`${f.base}/key-assets/${hash}?deck=tablet`, {
        headers: { Cookie: paired.cookie },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${f.base}/key-assets/${hash}?deck=other`, {
        headers: { Cookie: other.cookie },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${f.base}/key-assets/${hash}?deck=tablet`, {
        headers: { Cookie: other.cookie },
      })
    ).status,
  ).toBe(403);
  const images = new Images();
  expect(
    await images.render(
      { ...binding.appearance, ...payload.view.keys[0] },
      72,
      bytes,
    ),
  ).toEqual(await images.render(desktop, 72, bytes));
  connection.ws.close();
});

it("owns foreground current-view acknowledgements per socket; pairing/pong/online alone never leases", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture(),
      paired = await f.pair(),
      other = await f.pair("other");
    const a = await connect(f.base, paired.cookie),
      b = await connect(f.base, paired.cookie),
      c = await connect(f.base, other.cookie);
    expect(f.visibility).not.toHaveBeenCalled();
    a.ws.send(JSON.stringify({ type: "heartbeat", sequence: 1 }));
    a.ws.send(
      JSON.stringify({
        type: "view",
        version: "old",
        visible: true,
        sequence: 2,
      }),
    );
    await sleep(20);
    expect(f.visibility).not.toHaveBeenCalled();
    a.ws.send(
      JSON.stringify({
        type: "view",
        version: "page-1",
        visible: true,
        sequence: 3,
      }),
    );
    b.ws.send(
      JSON.stringify({
        type: "view",
        version: "page-1",
        visible: true,
        sequence: 1,
      }),
    );
    c.ws.send(
      JSON.stringify({
        type: "view",
        version: "page-1",
        visible: true,
        sequence: 1,
        deckId: "tablet",
      }),
    );
    await sleep(20);
    expect(f.visibility).toHaveBeenCalledTimes(2);
    expect(f.visibility.mock.calls.map(([event]) => event.deckId)).toEqual([
      "tablet",
      "tablet",
    ]);
    const sourceA = f.visibility.mock.calls[0][0].source,
      sourceB = f.visibility.mock.calls[1][0].source;
    expect(sourceA).not.toBe(sourceB);
    a.ws.send(
      JSON.stringify({
        type: "view",
        version: "page-1",
        visible: false,
        sequence: 4,
      }),
    );
    await sleep(20);
    expect(f.disconnect).toHaveBeenCalledWith(sourceA);
    const count = f.visibility.mock.calls.length;
    b.ws.send(
      JSON.stringify({
        type: "view",
        version: "page-1",
        visible: true,
        sequence: 1,
      }),
    );
    await sleep(20);
    expect(f.visibility).toHaveBeenCalledTimes(count);
    f.server.configure([
      {
        ...view(),
        keys: {
          ...view().keys,
          0: { ...view().keys[0], label: "Display only" },
        },
      },
      view("other"),
    ]);
    await sleep(20);
    expect(f.disconnect.mock.calls.some(([source]) => source === sourceB)).toBe(
      false,
    );
    f.server.configure([{ ...view(), version: "page-2" }, view("other")]);
    expect(f.visibilityLost).toHaveBeenCalledWith(sourceB);
    b.ws.send(
      JSON.stringify({
        type: "view",
        version: "page-2",
        visible: true,
        sequence: 2,
      }),
    );
    await sleep(20);
    expect(f.visibility).toHaveBeenLastCalledWith({
      source: sourceB,
      deckId: "tablet",
      version: "page-2",
    });
    f.advanceClock(15001);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.disconnect).toHaveBeenCalledWith(sourceB);
    b.ws.send(
      JSON.stringify({
        type: "view",
        version: "page-2",
        visible: true,
        sequence: 3,
      }),
    );
    await sleep(20);
    f.server.revoke(paired.clientId);
    expect(f.disconnect).toHaveBeenCalledWith(sourceB);
    a.ws.terminate();
    b.ws.terminate();
    c.ws.terminate();
  } finally {
    vi.useRealTimers();
  }
});
