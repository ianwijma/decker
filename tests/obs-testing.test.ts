import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
vi.mock("electron", () => ({ safeStorage: {} }));
import { fakeObs } from "./fixtures/obs-server";
import { probeObs, ObsTests } from "../src/integrations/obs-test";
import { DisposableObsClient } from "../src/integrations/obs-client";
import { ObsConnections } from "../src/integrations/obs";
import { requestSchema } from "../src/shared/schema";
import { defaults } from "../src/shared/defaults";
import { Credentials } from "../src/main/credentials";
import { testObsRequest, saveObsDraft } from "../src/main/obs-connections";
import {
  obsSaveRequestSchema,
  obsTestRequestSchema,
} from "../src/shared/obs-contract";
import { rekeyCredentials } from "../src/shared/credential-owners";
const servers: Awaited<ReturnType<typeof fakeObs>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server(options?: Parameters<typeof fakeObs>[0]) {
  const s = await fakeObs(options);
  servers.push(s);
  return s;
}
const id = "60000000-0000-4000-8000-000000000001";
const owner = JSON.stringify(["connection", "obs-one"]);
function doc() {
  const d = defaults();
  d.connections = [
    { id: "obs-one", name: "Studio", url: "ws://127.0.0.1:4455" },
  ];
  return d;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function seam(connect = vi.fn(async () => ({ negotiatedRpcVersion: 1 }))) {
  const events = new EventEmitter();
  const call = vi.fn(
    async (type: string) =>
      ({
        GetVersion: {
          rpcVersion: 1,
          obsVersion: "30.0.0",
          obsWebSocketVersion: "5.0.8",
        },
        GetCurrentProgramScene: { currentProgramSceneName: "Current" },
        GetInputList: { inputs: [] },
        GetSceneList: { scenes: [] },
      })[type] ?? { outputActive: false },
  );
  return Object.assign(events, {
    connect,
    call,
    dispose: vi.fn(async () => {}),
  }) as unknown as DisposableObsClient;
}
describe("read-only OBS tests", () => {
  it("authenticates independent instances, sends only GetVersion with no subscriptions, and never returns echoed secrets", async () => {
    const first = await server({
      password: "synthetic-first",
      echo: "synthetic-first",
    });
    const second = await server({
      password: "synthetic-second",
      echo: "synthetic-second",
    });
    const tests = new ObsTests();
    const results = await Promise.all([
      tests.test(id, first.url, "synthetic-first"),
      tests.test("second", second.url, "synthetic-second"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["success", "success"]);
    expect(JSON.stringify(results)).not.toMatch(/synthetic|obsVersion/);
    for (const s of [first, second]) {
      expect(s.frames.map((f) => f.op)).toEqual([1, 6]);
      expect(s.frames[0].d).toMatchObject({
        rpcVersion: 1,
        eventSubscriptions: 0,
      });
      expect(s.frames[1].d.requestType).toBe("GetVersion");
      expect(JSON.stringify(s.frames)).not.toContain("synthetic");
      await vi.waitFor(() => expect(s.clients).toBe(0));
    }
  });
  it("handles no authentication, rejected/missing passwords, incompatible negotiation and refused endpoints honestly", async () => {
    const noAuth = await server(),
      auth = await server({ password: "synthetic", echo: "synthetic-wrong" }),
      incompatible = await server({ incompatible: true });
    expect(
      (await probeObs(id, noAuth.url, undefined, new AbortController().signal))
        .status,
    ).toBe("success");
    expect(
      (await probeObs(id, auth.url, undefined, new AbortController().signal))
        .status,
    ).toBe("missing-credential");
    const rejected = await probeObs(
      id,
      auth.url,
      "synthetic-wrong",
      new AbortController().signal,
    );
    expect(rejected.status).toBe("authentication");
    expect(JSON.stringify(rejected)).not.toContain("synthetic");
    expect(
      (
        await probeObs(
          id,
          incompatible.url,
          undefined,
          new AbortController().signal,
        )
      ).status,
    ).toBe("incompatible");
    const refused = await server();
    await refused.close();
    servers.splice(servers.indexOf(refused), 1);
    expect(
      (await probeObs(id, refused.url, undefined, new AbortController().signal))
        .status,
    ).toBe("unreachable");
  });
  it("bounds timeout/cancellation and closes actual stalled sockets", async () => {
    const stalled = await server({ stall: true });
    expect(
      (
        await probeObs(
          id,
          stalled.url,
          "synthetic",
          new AbortController().signal,
          undefined,
          30,
        )
      ).status,
    ).toBe("timeout");
    await vi.waitFor(() => expect(stalled.clients).toBe(0));
    const tests = new ObsTests(undefined, 1000),
      first = tests.test(id, stalled.url),
      second = tests.test("second", stalled.url);
    expect((await tests.test(id, stalled.url)).status).toBe("busy");
    expect((await tests.test("third", stalled.url)).status).toBe("busy");
    tests.cancel(id);
    tests.close();
    expect((await first).status).toBe("cancelled");
    expect((await second).status).toBe("cancelled");
    await vi.waitFor(() => expect(stalled.clients).toBe(0));
  });
  it("cleans up on generic and read-only RPC errors, with no low-level echo in results", async () => {
    const client = seam();
    vi.mocked(client.call).mockRejectedValueOnce(
      new Error("synthetic-echoed-password"),
    );
    const result = await probeObs(
      id,
      "wss://custom.local:4455",
      "synthetic-echoed-password",
      new AbortController().signal,
      () => client,
    );
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(client.call).toHaveBeenCalledWith("GetVersion");
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(
      (
        await probeObs(
          id,
          "ws://user:password@localhost:4455",
          undefined,
          new AbortController().signal,
          () => client,
        )
      ).status,
    ).toBe("invalid-input");
    expect(client.dispose).toHaveBeenCalledOnce();
  });
});
describe("owner-only credentials and draft commits", () => {
  it("rejects arbitrary refs, unbounded/credentialed URLs and ambiguous draft credential choices at the strict boundary", () => {
    const request = {
      type: "obsTest",
      id,
      target: { kind: "draft", url: "ws://host:4455" },
      credential: { kind: "supplied", password: "synthetic" },
    };
    expect(requestSchema.safeParse(request).success).toBe(true);
    for (const malformed of [
      { ...request, credentialRef: "other" },
      { ...request, credential: { kind: "stored" } },
      {
        ...request,
        credential: { ...request.credential, credentialRef: "other" },
      },
      { ...request, target: { ...request.target, url: "http://host" } },
      {
        ...request,
        target: { ...request.target, url: "ws://user:secret@host" },
      },
      { ...request, target: { ...request.target, url: "ws://host:65536" } },
      {
        ...request,
        credential: { kind: "supplied", password: "a".repeat(16001) },
      },
    ])
      expect(requestSchema.safeParse(malformed).success).toBe(false);
    expect(
      obsSaveRequestSchema.safeParse({
        type: "obsSave",
        epoch: "epoch",
        target: { kind: "new" },
        name: "OBS",
        url: "ws://host",
        credential: { kind: "keep" },
      }).success,
    ).toBe(false);
  });
  it("resolves only a current saved owner, supports session-only, and never silently selects a secret for a draft", async () => {
    const d = doc(),
      credentials = new Credentials("/unused", {
        isEncryptionAvailable: () => false,
      } as never);
    const ref = await credentials.create("synthetic-stored", false);
    d.connections[0].credentialRef = ref;
    const client = seam(),
      tests = new ObsTests(() => client),
      current = () => ({ document: d, epoch: "epoch" });
    const request = () =>
      obsTestRequestSchema.parse({
        type: "obsTest",
        id,
        target: {
          kind: "saved",
          owner,
          epoch: "epoch",
          url: "ws://changed-host:4455",
        },
        credential: { kind: "stored" },
      });
    expect(
      (await testObsRequest(request(), current, credentials, tests)).status,
    ).toBe("success");
    expect(client.connect).toHaveBeenCalledWith(
      "ws://changed-host:4455",
      "synthetic-stored",
      { rpcVersion: 1, eventSubscriptions: 0 },
    );
    expect(
      (
        await testObsRequest(
          {
            ...request(),
            target: {
              kind: "saved",
              owner,
              epoch: "old",
              url: d.connections[0].url,
            },
          },
          current,
          credentials,
          tests,
        )
      ).status,
    ).toBe("cancelled");
    expect(
      (
        await testObsRequest(
          {
            ...request(),
            target: {
              kind: "saved",
              owner: "foreign",
              epoch: "epoch",
              url: d.connections[0].url,
            },
          },
          current,
          credentials,
          tests,
        )
      ).status,
    ).toBe("invalid-input");
    delete d.connections[0].credentialRef;
    expect(
      (await testObsRequest(request(), current, credentials, tests)).status,
    ).toBe("missing-credential");
    expect(client.connect).toHaveBeenCalledOnce();
  });
  it("reports locked credentials and ignores superseded saved-owner test results", async () => {
    const credentials = new Credentials(
      "/unused",
      { isEncryptionAvailable: () => false } as never,
      {
        readFile: async () => JSON.stringify({ locked: "ciphertext" }),
      } as never,
    );
    await credentials.load();
    const d = doc();
    d.connections[0].credentialRef = "locked";
    let epoch = "epoch";
    const current = () => ({ document: d, epoch });
    const request = () =>
      obsTestRequestSchema.parse({
        type: "obsTest",
        id,
        target: { kind: "saved", owner, epoch, url: d.connections[0].url },
        credential: { kind: "stored" },
      });
    const ready = deferred<{ negotiatedRpcVersion: number }>(),
      client = seam(vi.fn(() => ready.promise)),
      tests = new ObsTests(() => client);
    expect(
      (await testObsRequest(request(), current, credentials, tests)).status,
    ).toBe("locked-credential");
    const transient = request();
    transient.credential = { kind: "supplied", password: "synthetic-new" };
    const pending = testObsRequest(transient, current, credentials, tests);
    epoch = "changed";
    ready.resolve({ negotiatedRpcVersion: 1 });
    expect((await pending).status).toBe("cancelled");
    expect(transient.credential.password).toBe("");
    expect(client.dispose).toHaveBeenCalledOnce();
  });
  it("stores before committing an owner, preserves shared old refs on all failures, and never exports plaintext", async () => {
    const d = doc(),
      credentials = new Credentials("/unused", {
        isEncryptionAvailable: () => false,
      } as never);
    const old = await credentials.create("synthetic-old", false);
    d.connections[0].credentialRef = old;
    d.connections.push({ ...d.connections[0], id: "copy" });
    const request = () =>
      obsSaveRequestSchema.parse({
        type: "obsSave",
        epoch: "epoch",
        target: { kind: "saved", owner },
        name: "New name",
        url: "ws://new-host:4455",
        credential: {
          kind: "replace",
          password: "synthetic-new",
          persist: false,
        },
      });
    let committed: ReturnType<typeof doc> | undefined;
    const next = await saveObsDraft(
      d,
      "epoch",
      request(),
      credentials,
      async (value) => {
        expect(credentials.status(value.connections[0].credentialRef)).toBe(
          "session-only",
        );
        committed = value;
      },
    );
    expect(next).toBe(committed);
    expect(next.connections[0].credentialRef).not.toBe(old);
    expect(next.connections[1].credentialRef).toBe(old);
    expect(d.connections[0].url).toBe("ws://127.0.0.1:4455");
    expect(JSON.stringify(next)).not.toContain("synthetic");
    expect(
      JSON.stringify(rekeyCredentials(next, () => "import:new")),
    ).not.toContain("synthetic");
    const failed = request();
    failed.credential = {
      kind: "replace",
      password: "synthetic-persistent",
      persist: true,
    };
    const save = vi.fn();
    await expect(
      saveObsDraft(d, "epoch", failed, credentials, save),
    ).rejects.toThrow("Secure storage");
    expect(save).not.toHaveBeenCalled();
    await expect(
      saveObsDraft(d, "epoch", request(), credentials, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("previous connection");
    expect(d.connections[0].credentialRef).toBe(old);
    expect(credentials.all()[old]).toBe("synthetic-old");
    await expect(
      saveObsDraft(d, "changed", request(), credentials, save),
    ).rejects.toThrow("out of date");
    const noAuth = request();
    noAuth.credential = { kind: "none" };
    const detached = await saveObsDraft(
      d,
      "epoch",
      noAuth,
      credentials,
      async () => {},
    );
    expect(detached.connections[0].credentialRef).toBeUndefined();
    expect(detached.connections[1].credentialRef).toBe(old);
  });
});
describe("runtime OBS generation and replacement races", () => {
  it("an old pending client cannot evict, recolor or supply state to the replacement after reconfigure", async () => {
    const ready = deferred<{ negotiatedRpcVersion: number }>(),
      old = seam(vi.fn(() => ready.promise)),
      replacement = seam();
    const observe = vi.fn(),
      clients = [old, replacement],
      obs = new ObsConnections(observe, () => clients.shift()!);
    const connection = doc().connections[0],
      stale = obs.get(connection, "old");
    const rejected = expect(stale).rejects.toThrow("configuration changed");
    await Promise.resolve();
    await obs.close();
    const active = await obs.get(
      { ...connection, url: "ws://new-host:4455" },
      "new",
    );
    const count = observe.mock.calls.length;
    old.emit(
      "ConnectionClosed",
      Object.assign(new Error("late"), { code: 1006 }),
    );
    old.emit("CurrentProgramSceneChanged", { sceneName: "Stale" } as never);
    ready.resolve({ negotiatedRpcVersion: 1 });
    await rejected;
    expect(
      await obs.get({ ...connection, url: "ws://new-host:4455" }, "new"),
    ).toBe(active);
    expect(observe.mock.calls.slice(count)).not.toContainEqual([
      connection.id,
      expect.objectContaining({ scene: "Stale" }),
    ]);
    expect(replacement.dispose).not.toHaveBeenCalled();
    await obs.close();
  });
  it("endpoint/password edits create distinct clients, old close callbacks cannot affect new clients, and close does not clear clients created during cleanup", async () => {
    const a = seam(),
      b = seam(),
      c = seam(),
      other = seam();
    const clients = [a, b, other, c],
      observe = vi.fn(),
      obs = new ObsConnections(observe, () => clients.shift()!);
    const connection = doc().connections[0];
    await obs.get(connection, "first");
    await obs.get(connection, "second");
    expect(a.dispose).toHaveBeenCalled();
    a.emit(
      "ConnectionClosed",
      Object.assign(new Error("late"), { code: 1006 }),
    );
    expect(await obs.get(connection, "second")).toBe(b);
    await obs.get({ ...connection, id: "independent" }, "other");
    const finish = deferred<void>();
    vi.mocked(b.dispose).mockImplementation(() => finish.promise);
    const closing = obs.close();
    await obs.get(connection, "third");
    finish.resolve();
    await closing;
    expect(await obs.get(connection, "third")).toBe(c);
    expect(c.dispose).not.toHaveBeenCalled();
    expect(other.dispose).toHaveBeenCalled();
    await obs.close();
  });
});
