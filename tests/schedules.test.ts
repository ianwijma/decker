import { afterEach, describe, expect, it, vi } from "vitest";
import { defaults, node, uid } from "../src/shared/defaults";
import {
  documentSchema,
  requestSchema,
  type AppDocument,
} from "../src/shared/schema";
import {
  nextOccurrence,
  parseCron,
  previewSchedule,
  preserveScheduleActivation,
  scheduleError,
  scheduleSchema,
  type Schedule,
} from "../src/shared/schedules";
import { Scheduler, type ScheduledHandle } from "../src/main/scheduler";
import { ScheduledRunner } from "../src/main/scheduled-runner";
import { ScheduledRuns } from "../src/runtime/scheduled-runs";
import { Engine } from "../src/runtime/engine";
import { migrateDocument } from "../src/shared/decks";
import {
  Persistence,
  validateDocument,
  validateImport,
} from "../src/main/persistence";
import { ScheduleWatermarks } from "../src/main/schedule-watermarks";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingChoices } from "../src/shared/data-presentation";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const definition = (document: AppDocument, enabled = true): Schedule => ({
  id: uid(),
  name: "Morning",
  workflowId: document.workflows[0].id,
  enabled,
  inputs: {},
  timing: { kind: "interval", seconds: 60 },
});
function fixture(count = 1) {
  const document = defaults();
  document.schedules = Array.from({ length: count }, () =>
    definition(document),
  );
  let wall = Date.UTC(2026, 0, 1),
    mono = 0,
    serial = 0;
  const timers = new Map<number, { callback(): void; at: number }>();
  const completions: ReturnType<
    typeof deferred<"success" | "failure" | "cancelled">
  >[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const watermark = new Map<string, number>();
  const launch = vi.fn(async (): Promise<ScheduledHandle> => {
    const done = deferred<"success" | "failure" | "cancelled">();
    completions.push(done);
    const cancel = vi.fn(() => done.resolve("cancelled"));
    cancels.push(cancel);
    return { done: done.promise, cancel };
  });
  const claim = vi.fn(async (id: string, at: number) => {
    watermark.set(id, at);
  });
  const scheduler = new Scheduler({
    now: () => wall,
    monotonic: () => mono,
    setTimer: (callback, delay) => {
      expect(delay).toBeLessThanOrEqual(1000);
      const id = ++serial;
      timers.set(id, { callback, at: mono + delay });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
    claim,
    watermark: (id) => watermark.get(id) ?? 0,
    launch,
    changed: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const advance = async (ms: number, jump = false) => {
    if (jump) {
      wall += ms;
      mono += 1000;
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.callback();
    } else {
      const end = mono + ms;
      for (;;) {
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > end) break;
        const delta = due[1].at - mono;
        wall += delta;
        mono += delta;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      wall += end - mono;
      mono = end;
    }
    await flush();
  };
  scheduler.configure(document);
  return {
    document,
    scheduler,
    launch,
    claim,
    watermark,
    timers,
    completions,
    cancels,
    advance,
    flush,
    now: () => wall,
  };
}
afterEach(() => vi.useRealTimers());

describe("bounded schedule contract and occurrences", () => {
  it("accepts only bounded five numeric fields and IANA zones", () => {
    for (const value of [
      "",
      "@daily",
      "0 0 1 * * *",
      "0 0 * JAN MON",
      "H * * * *",
      "? * * * *",
      "60 * * * *",
      "* * * *",
      "*".repeat(121),
    ])
      expect(() => parseCron(value)).toThrow();
    for (const expression of ["*/15 9-17 * * 1-5", "0 0 1 * 1", "0 0 29 2 *"])
      expect(() => parseCron(expression)).not.toThrow();
    const d = defaults(),
      s = definition(d);
    for (const seconds of [0, 59, 60.5, Infinity, 31536001])
      expect(
        scheduleSchema.safeParse({
          ...s,
          timing: { kind: "interval", seconds },
        }).success,
      ).toBe(false);
    expect(
      scheduleSchema.safeParse({
        ...s,
        timing: { kind: "cron", expression: "0 0 * * *", timezone: "+11:00" },
      }).success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse({
        ...s,
        timing: {
          kind: "cron",
          expression: "0 0 * * *",
          timezone: "Wrong/Zone",
        },
      }).success,
    ).toBe(false);
    expect(() =>
      documentSchema.parse({ ...d, schedules: Array(201).fill(s) }),
    ).toThrow();
    expect(() => documentSchema.parse({ ...d, schedules: [s, s] })).toThrow();
    expect(() => previewSchedule(s, 0, 6)).toThrow();
    expect(() => previewSchedule(s, NaN)).toThrow();
    expect(
      requestSchema.safeParse({
        type: "schedulePreview",
        schedule: s,
        count: 0,
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        type: "scheduleEnable",
        id: s.id,
        expected: s,
        enabled: true,
        launch: {},
      }).success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse({ ...s, inputs: { x: "a".repeat(16385) } })
        .success,
    ).toBe(false);
    for (const value of [
      new Date(),
      /pattern/,
      new Map(),
      [undefined],
      Array(1),
    ])
      expect(
        scheduleSchema.safeParse({ ...s, inputs: { value } }).success,
      ).toBe(false);
    expect(
      scheduleSchema.safeParse({
        ...s,
        inputs: JSON.parse('{"constructor": 1}'),
      }).success,
    ).toBe(false);
  });
  it.each([
    [
      "America/New_York",
      "30 2 * * *",
      "2026-03-08T05:00:00Z",
      "2026-03-09T06:30:00Z",
    ],
    [
      "Australia/Lord_Howe",
      "15 2 * * *",
      "2026-10-03T14:00:00Z",
      "2026-10-04T15:15:00Z",
    ],
    [
      "Asia/Kolkata",
      "30 2 * * *",
      "2026-03-08T00:00:00Z",
      "2026-03-08T21:00:00Z",
    ],
    [
      "America/New_York",
      "30 1 * * *",
      "2026-11-01T04:00:00Z",
      "2026-11-01T05:30:00Z",
    ],
    [
      "America/New_York",
      "30 1 * * *",
      "2026-11-01T05:30:00Z",
      "2026-11-02T06:30:00Z",
    ],
    [
      "America/New_York",
      "30 1 * * *",
      "2026-11-01T06:10:00Z",
      "2026-11-02T06:30:00Z",
    ],
    [
      "Australia/Lord_Howe",
      "45 1 * * *",
      "2026-04-04T14:00:00Z",
      "2026-04-04T14:45:00Z",
    ],
    [
      "Australia/Lord_Howe",
      "45 1 * * *",
      "2026-04-04T15:00:00Z",
      "2026-04-05T15:15:00Z",
    ],
  ])(
    "%s %s skips gaps and second overlaps from %s",
    (timezone, expression, after, next) => {
      const timing = { kind: "cron" as const, timezone, expression };
      expect(
        new Date(nextOccurrence(timing, Date.parse(after))).toISOString(),
      ).toBe(new Date(next).toISOString());
    },
  );
  it("preserves valid later dates, leap days, numeric DOM/DOW OR and offset previews", () => {
    expect(
      nextOccurrence(
        { kind: "cron", timezone: "UTC", expression: "0 0 29 2 *" },
        Date.parse("2025-03-01Z"),
      ),
    ).toBe(Date.parse("2028-02-29Z"));
    const d = defaults(),
      s = definition(d);
    s.timing = {
      kind: "cron",
      timezone: "America/New_York",
      expression: "30 1 * * *",
    };
    const preview = previewSchedule(s, Date.parse("2026-11-01T04:00:00Z"));
    expect(preview[0].label).toContain("-04:00");
    expect(preview[1].label).toContain("-05:00");
    expect(preview[1].at - preview[0].at).toBe(25 * 3600000);
    expect(
      nextOccurrence(
        { kind: "cron", timezone: "UTC", expression: "0 0 1 * 1" },
        Date.parse("2026-10-01Z"),
      ),
    ).toBe(Date.parse("2026-10-05Z"));
  });
  it("blocks missing workflows/inputs and never resolves a schedule UUID as a legacy alias", () => {
    const d = defaults(),
      s = definition(d);
    d.workflows[0].inputs = ["count"];
    expect(scheduleError(s, d)).toContain("count");
    s.inputs = { count: 0 };
    expect(scheduleError(s, d)).toBeUndefined();
    s.inputs.extra = true;
    expect(scheduleError(s, d)).toContain("declared");
    s.workflowId = uid();
    d.workflowAliases[s.workflowId] = d.workflows[0].id;
    expect(scheduleError(s, d)).toContain("missing");
    s.workflowId = d.workflows[0].id;
    d.workflows[0].graph.entry = "missing";
    expect(scheduleError(s, d)).toContain("invalid");
    expect(() =>
      scheduleSchema.parse({ ...s, workflowId: "welcome" }),
    ).toThrow();
  });
});

describe("process clock, epochs and bounded launches", () => {
  it("never runs on startup/configure/preview; saves reuse a single timer and cadence", async () => {
    const f = fixture();
    await f.advance(120000);
    expect(f.launch).not.toHaveBeenCalled();
    f.scheduler.ready(true);
    await f.advance(30000);
    for (let i = 0; i < 10; i++) {
      f.scheduler.configure(structuredClone(f.document));
      f.scheduler.ready(false);
      f.scheduler.ready(true);
      expect(f.timers.size).toBe(1);
    }
    previewSchedule(f.document.schedules[0], f.now());
    await f.advance(30000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.completions[0].resolve("success");
    await f.flush();
    expect(f.scheduler.snapshot()[0]).toMatchObject({
      busy: false,
      lastStatus: "success",
    });
    f.scheduler.stop();
    expect(f.timers.size).toBe(0);
  });
  it("skips overlapping ticks, retains cadence and permits distinct schedules", async () => {
    const f = fixture(2);
    f.scheduler.ready(true);
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(2);
    await f.advance(120000);
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.scheduler.snapshot().map((s) => s.skipped)).toEqual([2, 2]);
    f.completions[0].resolve("failure");
    await f.flush();
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(3);
    expect(f.scheduler.snapshot()[1].busy).toBe(true);
    f.scheduler.stop();
  });
  it("bounds pending launches at the global 64-root limit", async () => {
    const f = fixture(200);
    f.scheduler.ready(true);
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(64);
    expect(f.scheduler.snapshot().filter((s) => s.skipped)).toHaveLength(136);
    f.scheduler.stop();
  });
  it("skips delayed ticks, clock jumps, suspend/resume and runner restarts without replay", async () => {
    const f = fixture();
    f.scheduler.ready(true);
    await f.advance(600000, true);
    expect(f.launch).not.toHaveBeenCalled();
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.scheduler.pause();
    expect(f.cancels[0]).toHaveBeenCalledOnce();
    await f.advance(600000);
    f.scheduler.ready(true);
    await f.advance(59999);
    expect(f.launch).toHaveBeenCalledTimes(1);
    await f.advance(1);
    expect(f.launch).toHaveBeenCalledTimes(2);
    await f.advance(-3600000, true);
    expect(f.launch).toHaveBeenCalledTimes(2);
    f.scheduler.stop();
    await f.advance(7200000);
    expect(f.launch).toHaveBeenCalledTimes(2);
  });
  it("cancels owned runs and rejects late acceptance/completion after edit, disable, deletion or stop", async () => {
    for (const action of ["edit", "disable", "delete", "stop"] as const) {
      const f = fixture(),
        pending = deferred<ScheduledHandle>(),
        cancel = vi.fn();
      f.launch.mockImplementationOnce(() => pending.promise);
      f.scheduler.ready(true);
      await f.advance(60000);
      if (action === "stop") f.scheduler.stop();
      else {
        if (action === "edit") f.document.schedules[0].name = "Changed";
        if (action === "disable") f.document.schedules[0].enabled = false;
        if (action === "delete") f.document.schedules = [];
        f.scheduler.configure(f.document);
      }
      pending.resolve({ done: Promise.resolve("success"), cancel });
      await f.flush();
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        f.scheduler
          .snapshot()
          .some((s) => s.busy || s.lastStatus === "success"),
      ).toBe(false);
      f.scheduler.stop();
    }
  });
  it("reanchors elapsed intervals after clock rollback without waiting for an old UTC mark", async () => {
    const f = fixture();
    f.scheduler.ready(true);
    await f.advance(60000);
    f.completions[0].resolve("success");
    await f.flush();
    await f.advance(-3600000, true);
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(2);
    f.scheduler.stop();
  });
  it("invalidates pending claims on a clock jump and skips storage-delayed ticks", async () => {
    const f = fixture(),
      claim = deferred<void>();
    f.claim.mockImplementationOnce(() => claim.promise);
    f.scheduler.ready(true);
    await f.advance(60000);
    await f.advance(3600000, true);
    claim.resolve();
    await f.flush();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.scheduler.snapshot()[0].busy).toBe(false);
    f.scheduler.stop();
    const g = fixture(),
      delayed = deferred<void>();
    g.claim.mockImplementationOnce(() => delayed.promise);
    g.scheduler.ready(true);
    await g.advance(60000);
    await g.advance(2000);
    delayed.resolve();
    await g.flush();
    expect(g.launch).not.toHaveBeenCalled();
    expect(g.scheduler.snapshot()[0]).toMatchObject({
      busy: false,
      skipped: 1,
    });
    g.scheduler.stop();
  });
  it("clears failures without retaining raw errors and never launches an obsolete storage callback", async () => {
    const f = fixture(),
      claim = deferred<void>();
    f.claim.mockImplementationOnce(() => claim.promise);
    f.scheduler.ready(true);
    await f.advance(60000);
    f.document.schedules = [];
    f.scheduler.configure(f.document);
    claim.resolve();
    await f.flush();
    expect(f.launch).not.toHaveBeenCalled();
    const g = fixture();
    g.launch.mockRejectedValueOnce(new Error("private raw credentials"));
    g.scheduler.ready(true);
    await g.advance(60000);
    expect(g.scheduler.snapshot()[0]).toMatchObject({
      busy: false,
      lastStatus: "failure",
    });
    expect(JSON.stringify(g.scheduler.snapshot())).not.toContain("private raw");
    await g.advance(60000);
    expect(g.launch).toHaveBeenCalledTimes(2);
    g.scheduler.stop();
  });
  it("waits for document acceptance and uses persisted marks across restarts/rollback", async () => {
    const f = fixture();
    f.scheduler.ready(true);
    await f.advance(59000);
    f.scheduler.ready(false);
    await f.advance(120000);
    expect(f.launch).not.toHaveBeenCalled();
    f.scheduler.ready(true);
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.scheduler.pause();
    f.watermark.set(f.document.schedules[0].id, f.now() + 3600000);
    f.scheduler.configure({
      ...f.document,
      schedules: f.document.schedules.map((s) => ({
        ...s,
        name: "Restarted",
        timing: { kind: "cron", expression: "* * * * *", timezone: "UTC" },
      })),
    });
    f.scheduler.ready(true);
    await f.advance(60000);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.scheduler.stop();
  });
});

describe("scheduled worker and transport", () => {
  it("settles owned cancellation independently from run history", async () => {
    const document = defaults(),
      schedule = definition(document),
      token = uid();
    document.schedules = [schedule];
    const delay = node("delay", "Pending effect");
    delay.config = { ms: 60000 };
    document.workflows[0].graph = {
      entry: delay.id,
      nodes: [delay],
      edges: [],
    };
    const engine = new Engine(
        async () => null,
        () => {},
      ),
      send = vi.fn();
    const worker = new ScheduledRuns(engine, send);
    worker.start(
      document,
      schedule.id,
      token,
      {
        source: {
          kind: "scheduled",
          invocationId: uid(),
          schedule: { id: schedule.id, name: schedule.name },
        },
      },
      true,
    );
    expect(send).toHaveBeenCalledWith({
      type: "scheduleAccepted",
      token,
      accepted: true,
    });
    const overlapping = uid();
    worker.start(
      document,
      schedule.id,
      overlapping,
      {
        source: {
          kind: "scheduled",
          invocationId: uid(),
          schedule: { id: schedule.id, name: schedule.name },
        },
      },
      true,
    );
    expect(send).toHaveBeenCalledWith({
      type: "scheduleAccepted",
      token: overlapping,
      accepted: false,
    });
    worker.cancel(token);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "scheduleSettled",
        token,
        status: "cancelled",
      }),
    );
    expect(engine.activeCount).toBe(0);
  });
  it("acknowledges independently from history, propagates nested unbound context and preserves aliases", async () => {
    const document = defaults(),
      child = structuredClone(document.workflows[0]);
    child.id = uid();
    child.inputs = [];
    child.outputs = [];
    const done = node("return", "Child result");
    done.kind = "action";
    done.action = {
      type: "desktop.copy",
      version: 1,
      config: {
        text: {
          $template: [
            { $ref: "context.source.schedule.name", fallback: "none" },
            { $ref: "context.source.kind" },
          ],
        },
      },
    };
    done.config = {};
    child.graph = { entry: done.id, nodes: [done], edges: [] };
    document.workflows.push(child);
    document.workflowAliases.legacy = child.id;
    const call = node("action", "Child");
    call.action = {
      type: "workflow.run",
      version: 1,
      config: { workflowId: "legacy" },
    };
    call.config = {
      workflowId: "legacy",
      revision: child.revision,
      inputs: {},
    };
    document.workflows[0].graph = { entry: call.id, nodes: [call], edges: [] };
    const schedule = definition(document);
    document.schedules = [schedule];
    const records: import("../src/shared/schema").RunRecord[] = [],
      messages: unknown[] = [];
    const contexts: import("../src/runtime/engine").ActionContext[] = [];
    const engine = new Engine(
      async (action, context) => {
        contexts.push(context);
        expect(action.config.text).toBe("Morningscheduled");
        return null;
      },
      (r) => records.push(structuredClone(r)),
      () => [],
      () => document.workflowAliases,
    );
    const service = new ScheduledRuns(engine, (m) => messages.push(m));
    const launch = {
      source: {
        kind: "scheduled" as const,
        invocationId: uid(),
        schedule: { id: schedule.id, name: schedule.name },
      },
    };
    service.start(document, schedule.id, uid(), launch, true);
    expect(messages[0]).toMatchObject({
      type: "scheduleAccepted",
      accepted: true,
    });
    await vi.waitFor(() =>
      expect(messages.at(-1)).toMatchObject({
        type: "scheduleSettled",
        status: "success",
      }),
    );
    expect(records.filter((r) => r.status === "success")).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].execution).toMatchObject({
      workflowId: child.id,
      rootWorkflowId: document.workflows[0].id,
      origin: null,
      source: { kind: "scheduled", schedule: launch.source.schedule },
    });
    expect(contexts[0].authority).toBeUndefined();
    expect(Object.isFrozen(contexts[0].execution?.source.schedule)).toBe(true);
    for (const record of records) {
      expect(record.context?.origin).toBeNull();
      expect(record.deckId).toBeUndefined();
      expect(record.context?.source).toEqual({
        kind: "scheduled",
        schedule: launch.source.schedule,
      });
    }
    expect(new Set(records.map((r) => r.context?.rootRunId)).size).toBe(1);
    expect(JSON.stringify(records)).not.toContain("authority");
    const choices = bindingChoices(document.workflows[0], [], call.id);
    expect(
      choices.find((c) => c.path.join(".") === "context.source.schedule.name"),
    ).toMatchObject({ conditional: true });
  });
  it("rejects display authority, stale documents, invalid/missing inputs and global capacity", () => {
    const document = defaults(),
      schedule = definition(document);
    document.schedules = [schedule];
    const engine = new Engine(
        async () => null,
        () => {},
      ),
      send = vi.fn(),
      worker = new ScheduledRuns(engine, send);
    const launch = {
      source: {
        kind: "scheduled" as const,
        invocationId: uid(),
        schedule: { id: schedule.id, name: schedule.name },
      },
    };
    worker.start(
      document,
      schedule.id,
      uid(),
      { ...launch, authority: "forged" },
      true,
    );
    worker.start(document, schedule.id, uid(), launch, false);
    document.workflows[0].inputs = ["needed"];
    worker.start(document, schedule.id, uid(), launch, true);
    for (const [message] of send.mock.calls)
      expect(message).toMatchObject({ accepted: false });
    document.workflows[0].inputs = [];
    vi.spyOn(engine, "activeCount", "get").mockReturnValue(64);
    worker.start(document, schedule.id, uid(), launch, true);
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ accepted: false });
  });
  it("bounds acceptance waits, cancels late acceptance and releases after rejection/worker replacement", async () => {
    vi.useFakeTimers();
    const post = vi.fn(),
      s = definition(defaults()),
      token = uid(),
      controller = new AbortController();
    const bridge = new ScheduledRunner(post, () => ({
      source: { kind: "scheduled", invocationId: uid() },
    }));
    const pending = bridge.launch(s, token, controller.signal, "config");
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    bridge.message({ type: "scheduleAccepted", token, accepted: true });
    expect(post).toHaveBeenLastCalledWith({ type: "scheduleCancel", token });
    const second = uid(),
      accepted = bridge.launch(
        s,
        second,
        new AbortController().signal,
        "config",
      );
    bridge.message({ type: "scheduleAccepted", token: second, accepted: true });
    const handle = await accepted;
    bridge.stop();
    expect(await handle.done).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("v6 persistence, activation and high-water marks", () => {
  it.each([1, 2, 3, 4, 5])(
    "migrates v%i without schedules or effects",
    (version) => {
      const d = defaults();
      const { workflowAliases: _, ...old } = d;
      const value =
        version === 1
          ? {
              ...old,
              schemaVersion: 1,
              activeProfileId: "default",
              activePageId: "home",
              devices: [],
              settings: { ...old.settings, brightness: 70, simulator: true },
            }
          : { ...(version === 2 ? old : d), schemaVersion: version };
      expect(migrateDocument(value)).toMatchObject({
        schemaVersion: 6,
        schedules: [],
      });
    },
  );
  it("requires deliberate enablement, prevents stale saves from re-enabling, and imports disabled fresh IDs", async () => {
    const d = defaults(),
      s = definition(d);
    d.schedules = [s];
    expect(validateImport(d).schedules[0]).toMatchObject({
      enabled: false,
      workflowId: s.workflowId,
    });
    expect(validateImport(d).schedules[0].id).not.toBe(s.id);
    const stale = structuredClone(d);
    d.schedules[0].enabled = false;
    preserveScheduleActivation(d, stale);
    expect(stale.schedules[0].enabled).toBe(false);
    stale.schedules.push({ ...s, id: uid(), enabled: true });
    preserveScheduleActivation(d, stale);
    expect(stale.schedules.every((s) => !s.enabled)).toBe(true);
    expect(() =>
      validateDocument({ ...d, schedules: [{ ...s, id: d.workflows[0].id }] }),
    ).toThrow("Duplicate");
    const directory = await mkdtemp(join(tmpdir(), "decker-schedules-"));
    try {
      const store = new Persistence(directory);
      await store.load();
      await store.save(stale, []);
      expect((await store.load()).document.schedules).toEqual(stale.schedules);
      const exported = await store.export(stale);
      expect(exported.document.schedules).toEqual(stale.schedules);
      expect(JSON.stringify(exported)).not.toContain("nextAt");
      const future = JSON.stringify({
        ...d,
        schemaVersion: 7,
        untouched: true,
      });
      await writeFile(join(directory, "config.json"), future);
      expect((await store.load()).warning).toContain(
        "Unsupported schema version 7",
      );
      await expect(store.save(d, [])).rejects.toThrow("blocked");
      expect(await readFile(join(directory, "config.json"), "utf8")).toBe(
        future,
      );
      expect(
        (await readdir(directory)).some((f) =>
          f.startsWith("migration-backup"),
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists monotonic bounded local occurrence marks and blocks corrupt storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decker-marks-")),
      id = uid();
    try {
      const marks = new ScheduleWatermarks(directory);
      await marks.load();
      await marks.claim(id, 10000, [id]);
      await marks.claim(id, 9000, [id]);
      const reloaded = new ScheduleWatermarks(directory);
      await reloaded.load();
      expect(reloaded.get(id)).toBe(10000);
      const next = uid();
      await reloaded.claim(next, 20000, [next]);
      expect(reloaded.get(id)).toBe(0);
      await writeFile(join(directory, "schedule-watermarks.json"), "corrupt");
      const broken = new ScheduleWatermarks(directory);
      await broken.load();
      await expect(broken.claim(id, 30000, [id])).rejects.toThrow("repair");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
