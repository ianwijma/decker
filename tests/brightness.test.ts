import { describe, it, expect, vi, afterEach } from "vitest";
import { defaults, node } from "../src/shared/defaults";
import { commitBrightness } from "../src/main/brightness";
import {
  brightnessValue,
  brightnessEdits,
  preserveBrightness,
} from "../src/shared/brightness";
import {
  actionById,
  catalogForPalette,
  makeAction,
} from "../src/shared/catalog";
import { Engine, type Handler } from "../src/runtime/engine";
import { validateWorkflow } from "../src/runtime/validate";
import { Persistence, validateImport } from "../src/main/persistence";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "../src/shared/schema";

const increase = "deck.brightnessIncrease",
  decrease = "deck.brightnessDecrease";
afterEach(() => vi.unstubAllGlobals());

describe("relative brightness contract", () => {
  it.each([
    [increase, 0, 10, 10],
    [increase, 95, 10, 100],
    [increase, 100, 10, 100],
    [decrease, 0, 10, 0],
    [decrease, 5, 10, 0],
    [decrease, 100, 10, 90],
    [increase, 0, 100, 100],
    [decrease, 100, 100, 0],
  ])("%s from %i by %i gives %i", (action, current, step, result) => {
    expect(brightnessValue(String(action), Number(current), { step })).toBe(
      result,
    );
  });
  it.each([0, -1, 101, 1.5, NaN, Infinity, "10", {}, null, true, undefined])(
    "rejects invalid step %j before persistence",
    async (step) => {
      const save = vi.fn(async () => {});
      for (const action of [increase, decrease]) {
        expect(actionById(action)!.schema.safeParse({ step }).success).toBe(
          false,
        );
        await expect(
          commitBrightness(defaults(), action, { step }, undefined, save),
        ).rejects.toThrow();
      }
      expect(save).not.toHaveBeenCalled();
    },
  );
  it("keeps absolute integer validation and numeric results", () => {
    expect(brightnessValue("deck.brightness", 70, { value: 0 })).toBe(0);
    expect(brightnessValue("deck.brightness", 0, { value: 100 })).toBe(100);
    for (const value of [-1, 101, 1.5, "50", NaN])
      expect(() => brightnessValue("deck.brightness", 70, { value })).toThrow();
    expect(makeAction(increase).config).toEqual({ step: 10 });
    expect(actionById(increase)!.outputSchema.safeParse(80).success).toBe(true);
  });
  it("commits repeated mixed actions on independent decks and preserves manual fallback", async () => {
    let doc = defaults();
    const first = doc.decks[0].id;
    doc.decks.push({ ...doc.decks[0], id: "second", brightness: 0 });
    doc.activeDeckId = "second";
    const saved: number[][] = [];
    for (const [action, step, target] of [
      [increase, 10, first],
      [increase, 10, first],
      [decrease, 5, first],
      [increase, 20, undefined],
      [decrease, 10, "second"],
    ] as const) {
      const result = await commitBrightness(
        doc,
        action,
        { step },
        target,
        async (next) => {
          saved.push(next.decks.map((d) => d.brightness));
        },
      );
      doc = result.document;
    }
    expect(saved).toEqual([
      [80, 0],
      [90, 0],
      [85, 0],
      [85, 20],
      [85, 10],
    ]);
    const save = vi.fn(async () => {});
    await expect(
      commitBrightness(doc, increase, { step: 10 }, "deleted", save),
    ).rejects.toThrow("No originating deck");
    expect(save).not.toHaveBeenCalled();
  });
  it("leaves live brightness unchanged on storage failure and waits for the commit", async () => {
    const doc = defaults();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const pending = commitBrightness(
      doc,
      increase,
      { step: 10 },
      undefined,
      () => held,
    );
    expect(doc.decks[0].brightness).toBe(70);
    release();
    expect((await pending).document.decks[0].brightness).toBe(80);
    await expect(
      commitBrightness(doc, increase, { step: 10 }, undefined, async () => {
        throw new Error("Disk full");
      }),
    ).rejects.toThrow("Disk full");
    expect(doc.decks[0].brightness).toBe(70);
  });
  it("protects stale whole-document saves but accepts an explicit slider edit", () => {
    const before = defaults(),
      stale = structuredClone(before),
      live = structuredClone(before);
    live.decks[0].brightness = 90;
    stale.settings.accent = "#123456";
    preserveBrightness(live, stale);
    expect(stale.decks[0].brightness).toBe(90);
    const slider = structuredClone(before);
    slider.decks[0].brightness = 25;
    const edits = brightnessEdits(before, slider);
    expect(edits).toEqual([before.decks[0].id]);
    preserveBrightness(live, slider, edits);
    expect(slider.decks[0].brightness).toBe(25);
  });
  it("resolves native numeric data before effects and forbids implicit retries", async () => {
    const action = {
      ...node("action", "Adjust"),
      id: "adjust",
      action: {
        ...makeAction(increase),
        config: { step: { $ref: "inputs.step" } },
      },
    };
    const flow = {
      ...defaults().workflows[0],
      inputs: ["step"],
      graph: { entry: action.id, nodes: [action], edges: [] },
    };
    expect(validateWorkflow(flow, [flow])).toEqual([]);
    const effect = vi.fn<Handler>(async () => 80);
    const engine = new Engine(effect, () => {});
    expect((await engine.start(flow, [flow], { step: 10 }).done).status).toBe(
      "success",
    );
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect.mock.calls[0][0].config.step).toBe(10);
    effect.mockClear();
    expect((await engine.start(flow, [flow], { step: "10" }).done).status).toBe(
      "failure",
    );
    expect(effect).not.toHaveBeenCalled();
    action.retries = 1;
    expect(actionById(increase)!.idempotent).toBe(false);
    expect(actionById(decrease)!.idempotent).toBe(false);
    expect(validateWorkflow(flow, [flow]).join()).toContain(
      "explicit confirmation",
    );
    expect(() => engine.start(flow, [flow], { step: 10 })).toThrow(
      "explicit confirmation",
    );
  });
});

describe("palette compatibility", () => {
  it("scopes new choices without hiding lookup or resurrecting global legacy actions", () => {
    for (const context of ["button", "workflow"] as const) {
      const ids = catalogForPalette(context).map((d) => d.id);
      expect(ids).toEqual(
        expect.arrayContaining([increase, decrease, "media.playPause"]),
      );
      expect(ids).not.toContain("desktop.open");
      expect(ids).not.toContain("media.control");
      for (const id of ["deck.brightness", "deck.appearance"])
        expect(ids.includes(id)).toBe(context === "workflow");
    }
    for (const id of [
      "desktop.open",
      "media.control",
      "deck.brightness",
      "deck.appearance",
    ])
      expect(actionById(id)).toBeDefined();
  });
  it("preserves advanced bindings through save, reload and import/export at schema v3", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decker-brightness-"));
    try {
      const doc = defaults(),
        key = doc.profiles[0].pages[0].keys[0];
      key.press = { kind: "action", action: makeAction("deck.brightness") };
      key.release = { kind: "action", action: makeAction("deck.appearance") };
      key.longPress = {
        kind: "sequence",
        actions: [
          makeAction(increase),
          makeAction(decrease),
          makeAction("deck.brightness"),
        ],
      };
      const store = new Persistence(directory);
      await store.save(doc, []);
      const loaded = (await store.load()).document;
      const exported = await store.export(loaded);
      expect(validateImport(exported.document).profiles).toEqual(doc.profiles);
      expect(loaded.schemaVersion).toBe(5);
      expect(loaded.workflowAliases).toEqual(doc.workflowAliases);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("renderer tracks slider intent per save while retaining credential guards", async () => {
  vi.resetModules();
  const request = vi.fn(async (r) => ({ ...snapshot, document: r.document }));
  const snapshot = { document: defaults() } as Snapshot;
  vi.stubGlobal("window", {
    decker: { request, snapshot: async () => snapshot },
  });
  const { useApp } = await import("../src/renderer/src/store");
  useApp.getState().receive(snapshot);
  useApp.getState().edit((d) => {
    d.decks[0].brightness = 40;
  });
  useApp.getState().edit((d) => {
    d.decks[0].name = "Editor";
  });
  await useApp.getState().request({ type: "diagnose" });
  expect(request.mock.calls[0][0].brightnessEdits).toEqual([
    snapshot.document.decks[0].id,
  ]);
  expect(request.mock.calls[1][0].brightnessEdits).toEqual([]);
});
