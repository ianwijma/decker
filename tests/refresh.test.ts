import { readFile } from "node:fs/promises";
import { Images } from "../src/device/images";
import { describe, it, expect, vi, afterEach } from "vitest";
import { defaults, uid, binding, node } from "../src/shared/defaults";
import { documentSchema, type AppDocument } from "../src/shared/schema";
import { RefreshService } from "../src/main/refresh-service";
import { RefreshRunner } from "../src/main/refresh-runner";
import { RefreshRuns } from "../src/runtime/refresh-runs";
import {
  refreshSchema,
  preserveRefreshActivation,
  refreshError,
} from "../src/shared/refresh";
import { bindingExecutionIdentity } from "../src/shared/toggle-identity";
import { toggleDefinitionStamp } from "../src/runtime/targets";
import { captureOrigin } from "../src/shared/trigger-context";
import { refreshStamp, viewVersion } from "../src/runtime/refresh-definition";
import { migrateDocument, cloneProfiles } from "../src/shared/decks";
import {
  validateDocument,
  validateImport,
  Persistence,
} from "../src/main/persistence";
import { Engine } from "../src/runtime/engine";
import { DisplayState } from "../src/main/display-state";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buttonAppearance, selectBindingRun } from "../src/shared/feedback";
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
type Status = "success" | "failure" | "cancelled";
function fixture(count = 1, seconds = 60) {
  const document = defaults();
  document.profiles[0].pages[0].keys = {};
  for (let i = 0; i < count; i++) {
    const b = binding("desktop.copy");
    b.refresh = {
      id: uid(),
      workflowId: document.workflows[0].id,
      inputs: {},
      enabled: true,
      initial: true,
      seconds,
    };
    document.profiles[0].pages[0].keys[(i % 8) + Math.floor(i / 8) * 16] = b;
  }
  let wall = 1_800_000_000_000,
    mono = 0,
    serial = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  const attempts: {
    done: ReturnType<typeof deferred<Status>>;
    cancel: ReturnType<typeof vi.fn>;
    signal: AbortSignal;
  }[] = [];
  const launch = vi.fn(
    async (_origin, _definition, _stamp, _token, signal: AbortSignal) => {
      const done = deferred<Status>(),
        cancel = vi.fn(() => done.resolve("cancelled"));
      attempts.push({ done, cancel, signal });
      return { done: done.promise, cancel };
    },
  );
  const service = new RefreshService({
    now: () => wall,
    monotonic: () => mono,
    setTimer: (callback, delay) => {
      expect(delay).toBeLessThanOrEqual(1000);
      const id = ++serial;
      timers.set(id, { at: mono + delay, callback });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
    launch,
    changed: vi.fn(),
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const advance = async (ms: number, renew = true) => {
    const end = mono + ms;
    for (;;) {
      const t = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!t || t[1].at > end) break;
      wall += t[1].at - mono;
      mono = t[1].at;
      timers.delete(t[0]);
      if (renew && mono % 4000 === 0)
        service.lease(
          "one",
          document.decks[0].id,
          viewVersion(document, document.decks[0].id),
        );
      t[1].callback();
      await flush();
    }
    wall += end - mono;
    mono = end;
    await flush();
  };
  service.configure(document);
  const show = (source = "one", deckId = document.decks[0].id) =>
    service.lease(source, deckId, viewVersion(document, deckId));
  return {
    document,
    service,
    launch,
    attempts,
    timers,
    advance,
    flush,
    show,
    jump: async (ms: number) => {
      wall += ms;
      mono += ms;
      for (const [id, t] of [...timers]) {
        timers.delete(id);
        t.callback();
      }
      await flush();
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("schema v7 and separate identity", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "migrates v%i with no refresh and preserves v6 schedules",
    (version) => {
      const d = defaults();
      d.schedules = [
        {
          id: uid(),
          name: "Saved",
          workflowId: d.workflows[0].id,
          inputs: {},
          enabled: true,
          timing: { kind: "interval", seconds: 300 },
        },
      ];
      const value = {
        ...d,
        schemaVersion: version,
        ...(version === 1
          ? {
              activeProfileId: "default",
              activePageId: "home",
              devices: [],
              settings: { ...d.settings, brightness: 70, simulator: true },
            }
          : {}),
      };
      if (version < 3) delete (value as Partial<AppDocument>).workflowAliases;
      const migrated = migrateDocument(value);
      expect(migrated.schemaVersion).toBe(7);
      expect(
        migrated.profiles
          .flatMap((p) => p.pages.flatMap((page) => Object.values(page.keys)))
          .every((b) => !b.refresh),
      ).toBe(true);
      expect(migrated.schedules).toEqual(version === 6 ? d.schedules : []);
    },
  );
  it("bounds config/inputs and blocks future versions and duplicate/too many definitions", () => {
    const f = fixture(),
      r = f.document.profiles[0].pages[0].keys[0].refresh!;
    for (const seconds of [0, 59, 86401, Infinity, 60.5])
      expect(refreshSchema.safeParse({ ...r, seconds }).success).toBe(false);
    expect(
      refreshSchema.safeParse({ ...r, inputs: { huge: "x".repeat(16385) } })
        .success,
    ).toBe(false);
    expect(() => migrateDocument({ ...f.document, schemaVersion: 8 })).toThrow(
      "Unsupported",
    );
    expect(documentSchema.safeParse(fixture(65).document).success).toBe(false);
    const two = fixture(2).document;
    two.profiles[0].pages[0].keys[1].refresh!.id =
      two.profiles[0].pages[0].keys[0].refresh!.id;
    expect(documentSchema.safeParse(two).success).toBe(false);
  });
  it("disables new, changed, imported and copied refresh while preserving schedules/toggles and credentials", () => {
    const { document } = fixture();
    const b = document.profiles[0].pages[0].keys[0];
    const imported = validateImport(document);
    expect(imported.profiles[0].pages[0].keys[0].refresh!.enabled).toBe(false);
    expect(imported.profiles[0].pages[0].keys[0].refresh!.id).not.toBe(
      b.refresh!.id,
    );
    const copy = cloneProfiles(document.profiles).profiles[0].pages[0].keys[0];
    expect(copy.refresh!.enabled).toBe(false);
    expect(copy.refresh!.id).not.toBe(b.refresh!.id);
    const changed = structuredClone(document);
    changed.profiles[0].pages[0].keys[0].refresh!.seconds = 300;
    preserveRefreshActivation(document, changed);
    expect(changed.profiles[0].pages[0].keys[0].refresh!.enabled).toBe(false);
    const stale = structuredClone(document);
    b.refresh!.enabled = false;
    preserveRefreshActivation(document, stale);
    expect(stale.profiles[0].pages[0].keys[0].refresh!.enabled).toBe(false);
    const newDoc = fixture().document;
    preserveRefreshActivation(document, newDoc);
    expect(newDoc.profiles[0].pages[0].keys[0].refresh!.enabled).toBe(false);
  });
  it("validates workflow inputs at activation and permits inactive missing-workflow drafts", () => {
    const { document } = fixture(),
      r = document.profiles[0].pages[0].keys[0].refresh!;
    document.workflows[0].inputs = ["name"];
    expect(refreshError(r, document)).toContain("Required inputs");
    expect(() => validateDocument(document)).toThrow("Required inputs");
    r.enabled = false;
    expect(validateDocument(document)).toBeTruthy();
    r.inputs = { name: "Ada" };
    expect(refreshError(r, document)).toBeUndefined();
    r.workflowId = uid();
    expect(refreshError(r, document)).toContain("missing");
    expect(validateImport(document)).toBeTruthy();
  });
  it("keeps toggle execution/durable stamps independent of refresh and artwork; press replacement changes identity", () => {
    const { document } = fixture(),
      b = document.profiles[0].pages[0].keys[0];
    b.toggle = {
      on: b.press!,
      off: b.press!,
      source: { kind: "app", initial: "off" },
    };
    delete b.press;
    const ordinary = JSON.stringify(bindingExecutionIdentity(b)),
      toggle = toggleDefinitionStamp(b, document),
      origin = captureOrigin(document, document.activeDeckId, b)!;
    const stamp = refreshStamp(document, origin);
    b.refresh!.seconds = 300;
    b.appearance.label = "Cosmetic";
    expect(JSON.stringify(bindingExecutionIdentity(b))).toBe(ordinary);
    expect(toggleDefinitionStamp(b, document)).toBe(toggle);
    expect(refreshStamp(document, origin)).not.toBe(stamp);
    b.toggle.on = { kind: "workflow", workflowId: document.workflows[0].id };
    expect(JSON.stringify(bindingExecutionIdentity(b))).not.toBe(ordinary);
  });
  it("round trips v7 while exporting no status or leases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "refresh-schema-"));
    try {
      const { document } = fixture();
      const store = new Persistence(directory);
      await store.load();
      await store.save(document, []);
      expect((await store.load()).document).toEqual(document);
      const exported = await store.export(document);
      expect(exported.document).toEqual(document);
      expect(JSON.stringify(exported)).not.toMatch(
        /lastSuccess|nextAt|authority|leases/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
describe("owned visibility and bounded clock", () => {
  it("never runs from configure/render, inactive drafts or before current runner readiness", async () => {
    const f = fixture();
    await f.advance(120000, false);
    expect(f.launch).not.toHaveBeenCalled();
    f.show();
    await f.advance(1000);
    expect(f.launch).not.toHaveBeenCalled();
    f.service.ready(true);
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it.each([60, 300])(
    "initial once then %i-second cadence, without overlap or display-driven loops",
    async (seconds) => {
      const f = fixture(1, seconds);
      f.service.ready(true);
      f.show();
      await f.advance(1000);
      expect(f.launch).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 10; i++) {
        f.show();
        f.service.configure(f.document);
      }
      await f.advance(seconds * 1000);
      expect(f.launch).toHaveBeenCalledTimes(1);
      f.attempts[0].done.resolve("success");
      await f.flush();
      await f.advance(seconds * 1000);
      expect(f.launch).toHaveBeenCalledTimes(2);
      expect(f.service.snapshot()[0].lastSuccess).toBeTruthy();
    },
  );
  it("deduplicates clients; removing one retains the shared job and last lease cancels immediately", async () => {
    const f = fixture();
    f.service.ready(true);
    f.show();
    f.show("two");
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.service.drop("one");
    expect(f.attempts[0].signal.aborted).toBe(false);
    f.service.drop("two");
    expect(f.attempts[0].signal.aborted).toBe(true);
    expect(f.attempts[0].cancel).toHaveBeenCalledOnce();
  });
  it("expires silent surfaces and rejects stale/forged pages", async () => {
    const f = fixture();
    f.service.ready(true);
    f.service.lease("forged", f.document.activeDeckId, "wrong");
    await f.advance(1000, false);
    expect(f.launch).not.toHaveBeenCalled();
    f.show();
    await f.advance(1000, false);
    await f.advance(15000, false);
    expect(f.attempts[0].signal.aborted).toBe(true);
    expect(f.timers.size).toBe(0);
  });
  it("preserves failure backoff across hide/show/client churn and resets on success", async () => {
    const f = fixture();
    f.service.ready(true);
    f.show();
    await f.advance(1000);
    f.attempts[0].done.resolve("failure");
    await f.flush();
    expect(f.service.snapshot()[0].status).toBe("error");
    f.service.drop("one");
    f.show();
    f.show("two");
    await f.advance(59000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(2);
    f.attempts[1].done.resolve("failure");
    await f.flush();
    await f.advance(119000);
    expect(f.launch).toHaveBeenCalledTimes(2);
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(3);
    f.attempts[2].done.resolve("success");
    await f.flush();
    expect(f.service.snapshot()[0].lastSuccess).toBeTruthy();
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(4);
  });
  it("admits fairly within four refresh jobs while leaving root capacity for manual work", async () => {
    const f = fixture(10);
    f.service.ready(true);
    f.show();
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(4);
    f.attempts.slice().forEach((a) => a.done.resolve("success"));
    await f.flush();
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(8);
    f.attempts.slice(4).forEach((a) => a.done.resolve("success"));
    await f.flush();
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(10);
    expect(new Set(f.launch.mock.calls.map((c) => c[0].bindingId)).size).toBe(
      10,
    );
    expect(f.timers.size).toBe(1);
  });
  it.each(["disable", "edit", "delete", "navigate", "dependency"])(
    "invalidates %s while in flight; old completion cannot change replacement status",
    async (kind) => {
      const f = fixture();
      f.service.ready(true);
      f.show();
      await f.advance(1000);
      const b = f.document.profiles[0].pages[0].keys[0];
      if (kind === "disable") b.refresh!.enabled = false;
      if (kind === "edit") b.refresh!.seconds = 300;
      if (kind === "delete") delete f.document.profiles[0].pages[0].keys[0];
      if (kind === "navigate") f.document.decks[0].activePageId = "other";
      if (kind === "dependency")
        f.document.workflows[0].graph.nodes[0].config.changed = true;
      f.service.configure(f.document);
      expect(f.attempts[0].signal.aborted).toBe(true);
      f.attempts[0].done.resolve("success");
      await f.flush();
      expect(f.service.snapshot().every((s) => !s.lastSuccess)).toBe(true);
    },
  );
  it("cosmetic workflow layout and unchanged saves preserve a running job", async () => {
    const f = fixture();
    f.service.ready(true);
    f.show();
    await f.advance(1000);
    f.document.workflows[0].layout = {};
    f.document.workflows[0].name = "Rename";
    f.service.configure(f.document);
    f.service.ready(false);
    expect(f.attempts[0].signal.aborted).toBe(false);
    f.service.ready(true);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("skips clock/suspend gaps, pauses uncertain effects and never launches before readiness", async () => {
    const f = fixture();
    f.service.ready(true);
    f.show();
    await f.advance(1000);
    f.attempts[0].done.resolve("success");
    await f.flush();
    await f.jump(3600000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.service.pause(true);
    f.show();
    await f.advance(120000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.service.ready(true);
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(2);
    f.service.stop();
    expect(f.attempts[1].signal.aborted).toBe(true);
    expect(f.timers.size).toBe(0);
  });
  it("does not merge distinct decks sharing an authored binding", async () => {
    const f = fixture();
    f.document.decks.push({ ...f.document.decks[0], id: "second" });
    f.service.configure(f.document);
    f.service.ready(true);
    f.show();
    f.show("two", "second");
    await f.advance(1000);
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(new Set(f.launch.mock.calls.map((c) => c[0].deckId)).size).toBe(2);
    f.service.drop("two");
    expect(f.attempts[0].signal.aborted).toBe(false);
    expect(f.attempts[1].signal.aborted).toBe(true);
  });
});
describe("private runner/authority", () => {
  it("times out pending acceptance, invalidates immediately and cancels late acceptance", async () => {
    vi.useFakeTimers();
    const post = vi.fn(),
      invalidate = vi.fn();
    const f = fixture(),
      b = f.document.profiles[0].pages[0].keys[0],
      origin = captureOrigin(f.document, f.document.activeDeckId, b)!;
    const bridge = new RefreshRunner(
      post,
      (origin) => ({
        source: { kind: "refresh", invocationId: uid(), origin },
        authority: uid(),
      }),
      invalidate,
    );
    const token = uid();
    const pending = bridge.launch(
      origin,
      "a".repeat(64),
      token,
      new AbortController().signal,
      "epoch",
    );
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(invalidate).toHaveBeenCalled();
    bridge.message({ type: "refreshAccepted", token, accepted: true });
    expect(post).toHaveBeenLastCalledWith({ type: "refreshCancel", token });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels accepted work without depending on history and ignores obsolete settlement", async () => {
    const post = vi.fn(),
      invalidate = vi.fn(),
      f = fixture(),
      b = f.document.profiles[0].pages[0].keys[0],
      origin = captureOrigin(f.document, f.document.activeDeckId, b)!;
    const bridge = new RefreshRunner(
      post,
      (origin) => ({
        source: { kind: "refresh", invocationId: uid(), origin },
        authority: uid(),
      }),
      invalidate,
    );
    const token = uid(),
      controller = new AbortController(),
      pending = bridge.launch(
        origin,
        "a".repeat(64),
        token,
        controller.signal,
        "epoch",
      );
    bridge.message({ type: "refreshAccepted", token, accepted: true });
    const handle = await pending;
    controller.abort();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(await handle.done).toBe("cancelled");
    bridge.message({ type: "refreshSettled", token, status: "success" });
    bridge.stop();
  });
  it("validates exact saved refresh and immutable nested context without press/toggle policy activity", async () => {
    const f = fixture(),
      b = f.document.profiles[0].pages[0].keys[0],
      origin = captureOrigin(f.document, f.document.activeDeckId, b)!;
    const child = {
      ...f.document.workflows[0],
      id: uid(),
      name: "Child",
      graph: {
        entry: "child-trigger",
        nodes: [
          { ...node("trigger", "Start"), id: "child-trigger" },
          {
            ...node("return", "Context"),
            id: "return",
            config: { value: { $ref: "context" } },
          },
        ],
        edges: [
          {
            id: uid(),
            source: "child-trigger",
            target: "return",
            port: "next",
          },
        ],
      },
    };
    f.document.workflows.push(child);
    f.document.workflows[0].graph = {
      entry: "root-trigger",
      nodes: [
        { ...node("trigger", "Start"), id: "root-trigger" },
        {
          ...node("subflow", "Nested"),
          id: "sub",
          config: { workflowId: child.id, revision: 1, inputs: {} },
        },
      ],
      edges: [
        { id: uid(), source: "root-trigger", target: "sub", port: "next" },
      ],
    };
    const records: any[] = [];
    const engine = new Engine(
      async () => null,
      (r) => records.push(r),
    );
    const send = vi.fn(),
      runs = new RefreshRuns(engine, send),
      launch = {
        source: { kind: "refresh" as const, invocationId: uid(), origin },
        authority: uid(),
      },
      stamp = refreshStamp(f.document, origin);
    runs.start(f.document, origin, stamp, uid(), launch, false);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ accepted: false }),
    );
    expect(refreshError(b.refresh!, f.document)).toBeUndefined();
    runs.start(f.document, origin, stamp, uid(), launch, true);
    await vi.waitFor(() => expect(records.at(-1)?.status).toBe("success"));
    expect(records[0].context.source.kind).toBe("refresh");
    expect(records[0].context.origin).toEqual(origin);
    expect(
      records.at(-1).nodes.find((n: any) => n.name === "Context").output.value
        .origin,
    ).toEqual(origin);
    expect(selectBindingRun(records, b, origin.deckId)).toBeUndefined();
  });
  it("ends only refresh authority, keeps last-good display and never restores an older writer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refresh-display-"));
    try {
      const f = fixture(),
        b = f.document.profiles[0].pages[0].keys[0],
        origin = captureOrigin(f.document, f.document.activeDeckId, b)!;
      await mkdir(join(dir, "assets"));
      const display = new DisplayState(
        dir,
        join(dir, "assets"),
        () => f.document,
      );
      const press = display.accept("button", origin);
      display.begin(press.authority!, "press");
      display.action(press.authority!, "press", "p", true);
      const refresh = display.accept("refresh", origin);
      display.begin(refresh.authority!, "refresh");
      display.action(refresh.authority!, "refresh", "r", true);
      await display.commit(
        { label: "Last good" },
        { authority: refresh.authority, runId: "refresh", actionId: "r" },
      );
      display.end(refresh.authority!);
      await expect(
        display.commit(
          { label: "Old press" },
          { authority: press.authority, runId: "press", actionId: "p" },
        ),
      ).rejects.toThrow("superseded");
      expect(display.live(press.authority!, "press")).toBe(true);
      expect(
        buttonAppearance(
          b,
          {
            buttonDisplay: display.snapshot(),
            buttonRefresh: {
              [JSON.stringify([origin.deckId, b.id, b.generation])]: "stale",
            },
          },
          "#123456",
          origin.deckId,
        ),
      ).toMatchObject({ label: "Last good", refreshStatus: "Refresh stale" });
      const restored = new DisplayState(
        dir,
        join(dir, "assets"),
        () => f.document,
      );
      await restored.load();
      expect(JSON.stringify(restored.snapshot())).toContain("Last good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("imports the runnable local avatar fixture disabled and keeps refresh status separate in generated frames", async () => {
  const document = validateImport(
    JSON.parse(await readFile("docs/examples/visible-avatar.json", "utf8")),
  );
  const b = document.profiles[0].pages[0].keys[0];
  expect(b.refresh?.enabled).toBe(false);
  expect(refreshError(b.refresh!, document)).toBeUndefined();
  const images = new Images(),
    base = buttonAppearance(b, {}, "#123456", document.activeDeckId),
    stale = { ...base, refreshStatus: "Refresh stale" };
  const plain = await images.render(base, 96),
    frame = await images.render(stale, 96);
  expect(frame).not.toEqual(plain);
  expect(frame).toEqual(await images.render(stale, 96));
  expect(base.background).toBe(stale.background);
  expect(base.imageStatus).toBeUndefined();
});
it("clears a former simulator lease when surface kind changes", async () => {
  const f = fixture();
  f.service.ready(true);
  f.show();
  await f.advance(1000);
  f.document.decks[0].kind = "web";
  f.service.configure(f.document);
  expect(f.attempts[0].signal.aborted).toBe(true);
  expect(f.service.snapshot()[0].nextAt).toBeUndefined();
});

it("a stale simulator cleanup cannot remove a newer page epoch's lease", async () => {
  const f = fixture();
  f.service.ready(true);
  f.show();
  await f.advance(1000);
  f.service.drop("one", "obsolete-page");
  expect(f.attempts[0].signal.aborted).toBe(false);
  f.service.drop("one", viewVersion(f.document, f.document.activeDeckId));
  expect(f.attempts[0].signal.aborted).toBe(true);
});
