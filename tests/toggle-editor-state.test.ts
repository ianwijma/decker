import { EventEmitter } from "node:events";
import { ObsConnections } from "../src/integrations/obs";
import type { DisposableObsClient } from "../src/integrations/obs-client";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { binding, defaults } from "../src/shared/defaults";
import {
  bindingSchema,
  v4DocumentSchema,
  type Json,
  type ObservationSource,
  type Target,
} from "../src/shared/schema";
import { bindingExecutionIdentity } from "../src/shared/toggle-identity";
import {
  observedToggle,
  observedObsTargets,
} from "../src/shared/toggle-observation";
import {
  stateAppearance,
  toggleDisplay,
} from "../src/shared/toggle-presentation";
import { activityKey, buttonAppearance } from "../src/shared/feedback";
import type { ToggleState } from "../src/shared/toggle-contract";
import { toggleKey } from "../src/shared/toggle-contract";
import { toggleStamp, toggleDefinitionStamp } from "../src/runtime/targets";
import { Engine, type Handler } from "../src/runtime/engine";
import { Toggles } from "../src/runtime/toggles";
import { ToggleStorage } from "../src/main/toggle-storage";
import {
  Persistence,
  validateImport,
  validateDocument,
} from "../src/main/persistence";
import { migrateDocument } from "../src/shared/decks";
import { Images } from "../src/device/images";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "decker-pr19-"));
  dirs.push(dir);
  return dir;
}
const target = (text: string): Target => ({
  kind: "action",
  action: { type: "desktop.copy", version: 1, config: { text } },
});
function fixture() {
  const doc = defaults(),
    b = binding("desktop.copy", "Base");
  delete b.press;
  b.toggle = {
    on: target("on"),
    off: target("off"),
    source: { kind: "app", initial: "off" },
    appearance: {
      on: { label: "Enabled", background: "#102030" },
      off: { label: "Disabled", background: "#405060" },
    },
  };
  doc.profiles[0].pages[0].keys = { 0: b };
  const deckId = doc.decks[0].id;
  return { doc, b, deckId };
}
function state(
  deckId: string,
  b: ReturnType<typeof binding>,
  extra: Partial<ToggleState> = {},
): ToggleState {
  return {
    deckId,
    bindingId: b.id,
    generation: b.generation,
    confirmed: "off",
    fresh: true,
    blocked: false,
    transitioning: false,
    reconciling: false,
    ...extra,
  };
}

it("migrates actual v4 toggle documents and retains the durable v4 state through appearance edits", async () => {
  const { doc, b, deckId } = fixture();
  delete b.toggle!.appearance;
  const { schedules: _schedules, ...historical } = doc;
  const old = { ...historical, schemaVersion: 4 };
  expect(v4DocumentSchema.parse(old)).toEqual(old);
  const stamp = createHash("sha256")
    .update(JSON.stringify(b.toggle))
    .digest("hex");
  const dir = await directory();
  await writeFile(join(dir, "config.json"), JSON.stringify(old));
  await writeFile(
    join(dir, "toggles.json"),
    JSON.stringify({
      version: 1,
      entries: [{ key: toggleKey(deckId, b), stamp, confirmed: "on" }],
    }),
  );
  const migrated = (await new Persistence(dir).load()).document,
    saved = migrated.profiles[0].pages[0].keys[0];
  expect(migrated.schemaVersion).toBe(defaults().schemaVersion);
  expect(toggleStamp(saved)).toBe(stamp);
  saved.appearance.label = "Cosmetic";
  saved.toggle!.appearance = { on: { label: "Styled", asset: null } };
  expect(toggleStamp(saved)).toBe(stamp);
  const store = new ToggleStorage(dir);
  await store.load();
  const service = new Toggles(
    new Engine(
      async () => null,
      () => {},
    ),
    (r) => store.request(r, migrated),
    () => {},
  );
  service.configure(migrated);
  await service.settled();
  expect(service.snapshot()[0]).toMatchObject({ confirmed: "on", fresh: true });
  service.stop();
  expect(migrateDocument(old).profiles[0].pages[0].keys[0].toggle).toEqual(
    b.toggle,
  );
});

it("preserves confirmed state and a running transition across cosmetics, but invalidates real replacement", async () => {
  const { doc, b, deckId } = fixture(),
    dir = await directory(),
    store = new ToggleStorage(dir);
  await store.load();
  let finish = () => {};
  const handler: Handler = vi.fn(async (_a, ctx) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    ctx.signal.throwIfAborted();
    return null;
  });
  const engine = new Engine(handler, () => {}),
    service = new Toggles(
      engine,
      (r) => store.request(r, doc),
      () => {},
    );
  service.configure(doc);
  await service.settled();
  const originalIdentity = JSON.stringify(bindingExecutionIdentity(b)),
    stamp = toggleDefinitionStamp(b, doc);
  const first = service.press(deckId, b);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  b.appearance = {
    ...b.appearance,
    label: "Renamed",
    icon: "pack:lucide:v1:power",
    background: "#123456",
  };
  b.toggle!.appearance!.off = { label: "Still off", icon: "" };
  expect(JSON.stringify(bindingExecutionIdentity(b))).toBe(originalIdentity);
  expect(toggleDefinitionStamp(b, doc)).toBe(stamp);
  service.configure(doc);
  expect(service.snapshot()[0]).toMatchObject({
    confirmed: "off",
    transitioning: true,
  });
  finish();
  await first;
  expect(service.snapshot()[0]).toMatchObject({ confirmed: "on", fresh: true });
  b.toggle!.appearance!.on = { label: "Cosmetic on" };
  service.configure(doc);
  expect(service.snapshot()[0].confirmed).toBe("on");
  const second = service.press(deckId, b);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  b.toggle!.off = target("replacement");
  expect(toggleDefinitionStamp(b, doc)).not.toBe(stamp);
  b.generation++;
  service.configure(doc);
  await service.settled();
  finish();
  await second;
  expect(service.snapshot()[0]).toMatchObject({
    generation: b.generation,
    confirmed: "off",
    transitioning: false,
  });
  service.stop();
});

it.each([
  [
    { kind: "media", player: "fixture" },
    { media: { defaultPlayer: "other", fixture: "Playing", other: "Paused" } },
    true,
  ],
  [
    { kind: "media", player: "fixture" },
    { media: { defaultPlayer: "other", other: "Playing" } },
    undefined,
  ],
  [
    { kind: "media", player: "" },
    { media: { defaultPlayer: "a", a: "Unknown", b: "Playing" } },
    undefined,
  ],
  [
    { kind: "media", player: "" },
    { media: { defaultPlayer: "a", a: "Stopped" } },
    false,
  ],
  [
    { kind: "audio", target: "microphone" },
    { microphone: { stdout: "Volume: 0.5 [MUTED]", exitCode: 0 } },
    true,
  ],
  [
    { kind: "audio", target: "speaker" },
    { speaker: { stdout: "Mute: no", exitCode: 0 } },
    false,
  ],
  [
    { kind: "audio", target: "microphone" },
    { microphone: { stdout: "Mute: no", exitCode: 1 } },
    undefined,
  ],
  [
    { kind: "audio", target: "speaker" },
    { speaker: { stdout: "", exitCode: 0 } },
    undefined,
  ],
  [
    { kind: "obs", connectionId: "fixture", property: "recording", name: "" },
    { "obs:fixture": { connected: true, recording: true } },
    true,
  ],
  [
    { kind: "obs", connectionId: "fixture", property: "streaming", name: "" },
    { "obs:fixture": { connected: false, streaming: false } },
    undefined,
  ],
  [
    { kind: "obs", connectionId: "fixture", property: "mute", name: "Mic" },
    { "obs:fixture": { connected: true, "mute:Mic": false } },
    false,
  ],
  [
    {
      kind: "obs",
      connectionId: "fixture",
      property: "source",
      name: "Main",
      sourceId: 7,
    },
    { "obs:fixture": { connected: true, "source:Main:7": true } },
    true,
  ],
  [
    { kind: "obs", connectionId: "fixture", property: "scene", name: "Main" },
    { "obs:fixture": { connected: true, scene: "Other" } },
    false,
  ],
] as [ObservationSource, Record<string, Json>, boolean | undefined][])(
  "interprets %j without guessing missing truth",
  (source, observed, expected) => {
    expect(observedToggle(source, observed)).toBe(expected);
  },
);

it("uses saved observation activation and adapter drift; no-op success does not prove state", async () => {
  const { doc, b, deckId } = fixture(),
    dir = await directory(),
    store = new ToggleStorage(dir);
  await store.load();
  b.toggle!.source = {
    kind: "observed",
    observation: { kind: "media", player: "fixture" },
    onWhen: true,
  };
  const handler = vi.fn(async () => null),
    service = new Toggles(
      new Engine(handler, () => {}),
      (r) => store.request(r, doc),
      () => {},
    );
  service.configure(doc);
  await service.settled();
  service.updateObservations({ media: { fixture: "Paused" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(service.snapshot()[0]).toMatchObject({
    confirmed: "unknown",
    fresh: false,
  });
  expect(handler).not.toHaveBeenCalled();
  await service.reconcile(deckId, b.id);
  expect(service.snapshot()[0]).toMatchObject({
    confirmed: "off",
    fresh: true,
  });
  await service.press(deckId, b);
  expect(service.snapshot()[0]).toMatchObject({
    confirmed: "off",
    fresh: true,
    error: "probe-disagreed",
  });
  service.updateObservations({ media: { fixture: "Playing" } });
  await vi.waitFor(() =>
    expect(service.snapshot()[0]).toMatchObject({
      confirmed: "on",
      fresh: true,
    }),
  );
  service.updateObservations({
    media: { defaultPlayer: "other", other: "Paused" },
  });
  expect(service.snapshot()[0]).toMatchObject({
    confirmed: "on",
    fresh: false,
  });
  expect(await service.press(deckId, b)).toBe(false);
  b.toggle!.source = {
    kind: "observed",
    observation: { kind: "audio", target: "microphone" },
    onWhen: false,
  };
  b.generation++;
  service.configure(doc);
  await service.settled();
  service.updateObservations({
    media: { fixture: "Playing" },
    microphone: { stdout: "Mute: no", exitCode: 0 },
  });
  expect(service.snapshot()[0]).toMatchObject({
    confirmed: "unknown",
    fresh: false,
  });
  await service.reconcile(deckId, b.id);
  expect(service.snapshot()[0]).toMatchObject({ confirmed: "on", fresh: true });
  service.stop();
});

it("rejects delayed observation commits for a replaced generation", async () => {
  const { doc, b, deckId } = fixture();
  b.toggle!.source = {
    kind: "observed",
    observation: { kind: "audio", target: "speaker" },
    onWhen: true,
  };
  let release = () => {};
  const service = new Toggles(
    new Engine(
      async () => null,
      () => {},
    ),
    async (r) => {
      if (r.operation === "recover")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return null;
    },
    () => {},
  );
  service.configure(doc);
  await service.settled();
  service.updateObservations({ speaker: { stdout: "Mute: yes", exitCode: 0 } });
  const pending = service.reconcile(deckId, b.id);
  await vi.waitFor(() => expect(service.snapshot()[0].reconciling).toBe(true));
  b.generation++;
  b.toggle!.source = { kind: "app", initial: "off" };
  service.configure(doc);
  await service.settled();
  release();
  await pending;
  expect(service.snapshot()[0]).toMatchObject({
    generation: b.generation,
    confirmed: "off",
    fresh: true,
  });
  service.stop();
});

it("composes inherited and cleared artwork, legacy overrides, and temporary activity consistently across output frames", async () => {
  const { b, deckId } = fixture(),
    s = state(deckId, b, { confirmed: "on" });
  b.appearance.asset = "a".repeat(64);
  expect(stateAppearance(b.appearance, { label: "" })).toMatchObject({
    label: "",
    asset: b.appearance.asset,
  });
  expect(
    stateAppearance(b.appearance, { icon: "pack:lucide:v1:power" }).asset,
  ).toBeUndefined();
  expect(stateAppearance(b.appearance, { asset: null }).asset).toBeUndefined();
  expect(stateAppearance(b.appearance, { icon: "" }).icon).toBe("");
  const observed = {
    buttonFeedback: {
      [activityKey(deckId, b)]: {
        label: "Legacy",
        background: "#123456",
        status: "running",
      },
    },
  };
  const busy = buttonAppearance(b, observed, "#112233", deckId, [s]);
  expect(busy).toMatchObject({
    label: "Legacy",
    background: "#112233",
    stateLabel: "on",
  });
  const restored = buttonAppearance(b, {}, "#112233", deckId, [s]);
  expect(restored).toMatchObject({
    label: "Enabled",
    background: "#102030",
    asset: b.appearance.asset,
  });
  const asset = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#456789" },
  })
    .png()
    .toBuffer();
  const images = new Images(),
    a = await images.render(restored, 96, asset),
    c = await images.render(
      buttonAppearance(b, {}, "#112233", deckId, [s]),
      96,
      asset,
    );
  expect(a.equals(c)).toBe(true);
  expect(
    a.equals(
      await images.render({ ...restored, stateLabel: "off" }, 96, asset),
    ),
  ).toBe(false);
  expect(buttonAppearance(b, {}, "#112233", "other", [s]).label).toBe("Base");
  expect(
    buttonAppearance({ ...b, generation: 1 }, {}, "#112233", deckId, [s]).label,
  ).toBe("Base");
});

it.each([
  [{ confirmed: "on" }, "Confirmed on", false],
  [{ confirmed: "off" }, "Confirmed off", false],
  [{ confirmed: "unknown" }, "Unknown", true],
  [{ transitioning: true }, "Transitioning", true],
  [{ reconciling: true }, "Reconciling", true],
  [{ fresh: false }, "Stale", true],
  [{ blocked: true, error: "interrupted" }, "Blocked", true],
  [{ error: "transition-failed" }, "Target failed", false],
] as [Partial<ToggleState>, string, boolean][])(
  "presents distinct truthful state %j",
  (extra, text, disabled) => {
    const { b, deckId } = fixture();
    expect(toggleDisplay(b, state(deckId, b, extra))).toMatchObject({
      disabled,
      summary: expect.stringContaining(text),
    });
  },
);

it("exports on/off-only assets and validates observed connection references", async () => {
  const { doc, b } = fixture(),
    dir = await directory(),
    store = new Persistence(dir);
  await store.load();
  const bytes = await sharp({
      create: { width: 12, height: 12, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
    hash = await store.storeAsset(bytes);
  b.toggle!.appearance = { on: { asset: hash }, off: { asset: hash } };
  const exported = await store.export(doc);
  expect(Object.keys(exported.assets)).toEqual([hash]);
  const imported = validateImport(exported.document);
  expect(imported.profiles[0].pages[0].keys[0].id).not.toBe(b.id);
  expect(imported.profiles[0].pages[0].keys[0].toggle!.appearance).toEqual(
    b.toggle!.appearance,
  );
  b.toggle!.source = {
    kind: "observed",
    observation: {
      kind: "obs",
      connectionId: "missing",
      property: "recording",
      name: "",
    },
    onWhen: true,
  };
  expect(() => validateDocument(doc)).toThrow(
    "Missing observed OBS connection",
  );
  expect(() =>
    bindingSchema.parse({
      ...b,
      toggle: {
        ...b.toggle,
        appearance: { on: { asset: "https://example.com" } },
      },
    }),
  ).toThrow();
});

it("offers named OBS targets only for exposed observations, preserving names containing colons", () => {
  const observation: Extract<ObservationSource, { kind: "obs" }> = {
    kind: "obs",
    connectionId: "studio",
    property: "source",
    name: "",
  };
  const observed = {
    "obs:studio": {
      connected: true,
      scene: "Current",
      "source:Scene:with:colons:12": true,
      "mute:Mic:one": false,
      "source:unsupported:1": "unknown",
    },
  };
  expect(observedObsTargets(observation, observed)).toEqual([
    {
      id: JSON.stringify(["Scene:with:colons", 12]),
      name: "Scene:with:colons",
      sourceId: 12,
    },
  ]);
  expect(
    observedObsTargets({ ...observation, property: "mute" }, observed),
  ).toEqual([{ id: JSON.stringify(["Mic:one", null]), name: "Mic:one" }]);
  expect(
    observedObsTargets(observation, {
      "obs:studio": { ...observed["obs:studio"], connected: false },
    }),
  ).toEqual([]);
});

it("rejects queued writes from obsolete workflow definitions while retaining cosmetic and durable stamp compatibility", async () => {
  const { doc, b, deckId } = fixture(),
    dir = await directory(),
    store = new ToggleStorage(dir);
  await store.load();
  b.toggle!.on = { kind: "workflow", workflowId: doc.workflows[0].id };
  const request = {
    operation: "prepare" as const,
    key: toggleKey(deckId, b),
    stamp: toggleStamp(b),
    definitionStamp: toggleDefinitionStamp(b, doc),
    token: "old-transition",
    confirmed: "off" as const,
  };
  const initial = structuredClone(doc);
  // A main mutation can commit the graph before an old runner request reaches its queue.
  doc.workflows[0].revision++;
  doc.workflows[0].graph.nodes[0].config = { changed: "execution" };
  expect(b.generation).toBe(initial.profiles[0].pages[0].keys[0].generation);
  expect(toggleStamp(b)).toBe(request.stamp);
  await expect(store.request(request, doc)).rejects.toThrow(
    "Stale toggle definition",
  );
  expect(
    await store.request(
      {
        ...request,
        operation: "read",
        definitionStamp: toggleDefinitionStamp(b, doc),
      },
      doc,
    ),
  ).toBeNull();
  b.appearance.label = "Cosmetic";
  b.toggle!.appearance = { on: { label: "New artwork" } };
  const current = toggleDefinitionStamp(b, doc);
  await store.request({ ...request, definitionStamp: current }, doc);
  await expect(
    store.request(
      {
        ...request,
        operation: "commit",
        definitionStamp: current,
        confirmed: "on",
      },
      doc,
    ),
  ).resolves.toMatchObject({ confirmed: "on" });
  // The new guard is private request metadata, not part of durable v4/v5 stamps or records.
  const raw = JSON.parse(
    await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dir, "toggles.json"), "utf8"),
    ),
  );
  expect(raw.entries[0]).not.toHaveProperty("definitionStamp");
});

it("reconciles target completion from a fresh provider sample instead of the pre-command cache", async () => {
  const { doc, b, deckId } = fixture(),
    dir = await directory(),
    store = new ToggleStorage(dir);
  await store.load();
  b.toggle!.source = {
    kind: "observed",
    observation: { kind: "media", player: "fixture" },
    onWhen: true,
  };
  let playing = false;
  const reader = vi.fn(async () => ({
    media: { fixture: playing ? "Playing" : "Paused" },
  }));
  const service = new Toggles(
    new Engine(
      async () => {
        playing = true;
        return null;
      },
      () => {},
    ),
    (r) => store.request(r, doc),
    () => {},
    reader,
  );
  service.configure(doc);
  await service.settled();
  expect(reader).not.toHaveBeenCalled();
  service.updateObservations({ media: { fixture: "Paused" } });
  await service.reconcile(deckId, b.id);
  expect(service.snapshot()[0]).toMatchObject({
    confirmed: "off",
    fresh: true,
  });
  b.appearance.label = "Cosmetic";
  service.configure(doc);
  expect(reader).toHaveBeenCalledTimes(1);
  await service.press(deckId, b);
  expect(reader).toHaveBeenCalledTimes(2);
  expect(service.snapshot()[0]).toMatchObject({ confirmed: "on", fresh: true });
  // Unrelated provider events cannot replace the fresh sample with an old full snapshot.
  service.updateObservations({
    speaker: { stdout: "Volume: 0.5", exitCode: 0 },
  });
  expect(service.snapshot()[0]).toMatchObject({ confirmed: "on", fresh: true });
  service.stop();
});

it("does not let delayed initial OBS queries overwrite a newer read or event", async () => {
  let initial = () => {},
    older = () => {},
    streams = 0;
  const client = Object.assign(new EventEmitter(), {
    connect: async () => {},
    dispose: async () => {},
    call: vi.fn(async (type: string) => {
      if (type === "GetCurrentProgramScene")
        return { currentProgramSceneName: "Main" };
      if (type === "GetRecordStatus") return { outputActive: false };
      if (type === "GetStreamStatus") {
        if (++streams === 1)
          return new Promise((resolve) => {
            initial = () => resolve({ outputActive: false });
          });
        if (streams === 2) return { outputActive: true };
        if (streams === 3)
          return new Promise((resolve) => {
            older = () => resolve({ outputActive: true });
          });
        return { outputActive: false };
      }
      if (type === "GetInputList") return { inputs: [] };
      if (type === "GetSceneList") return { scenes: [] };
      throw new Error("Unexpected read");
    }),
  });
  const samples: Json[] = [],
    obs = new ObsConnections(
      (_id, value) => samples.push(value),
      () => client as unknown as DisposableObsClient,
    ),
    connection = { id: "studio", name: "Studio", url: "ws://localhost:4455" };
  await obs.get(connection);
  await vi.waitFor(() => expect(streams).toBe(1));
  expect(
    await obs.readObservation(
      connection,
      undefined,
      { kind: "obs", connectionId: "studio", property: "streaming", name: "" },
      () => true,
    ),
  ).toMatchObject({ streaming: true });
  initial();
  await vi.waitFor(() =>
    expect(samples.at(-1)).toMatchObject({ streaming: true, recording: false }),
  );
  const delayed = obs.readObservation(
    connection,
    undefined,
    { kind: "obs", connectionId: "studio", property: "streaming", name: "" },
    () => true,
  );
  await vi.waitFor(() => expect(streams).toBe(3));
  expect(
    await obs.readObservation(
      connection,
      undefined,
      { kind: "obs", connectionId: "studio", property: "streaming", name: "" },
      () => true,
    ),
  ).toMatchObject({ streaming: false });
  older();
  expect(await delayed).toMatchObject({ streaming: false });
  expect(client.call.mock.calls.every(([type]) => type.startsWith("Get"))).toBe(
    true,
  );
  await obs.close();
});
