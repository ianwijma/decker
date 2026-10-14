import { it, expect } from "vitest";
import { ButtonActivity } from "../src/runtime/activity";
import {
  activityKey,
  buttonAppearance,
  selectBindingRun,
} from "../src/shared/feedback";
import { defaults, uid } from "../src/shared/defaults";
import type { RunRecord } from "../src/shared/schema";

function fixture() {
  const document = defaults(),
    binding = document.profiles[0].pages[0].keys[0],
    deck = document.decks[0];
  const run = (status: RunRecord["status"] = "running"): RunRecord => ({
    id: uid(),
    workflowId: document.workflows[0].id,
    workflowName: "Test",
    revision: 1,
    bindingId: binding.id,
    generation: binding.generation,
    deckId: deck.id,
    startedAt: Date.now(),
    status,
    nodes: [],
  });
  let now = 0;
  const activity = new ButtonActivity(() => now);
  const appearance = () =>
    buttonAppearance(
      binding,
      { buttonFeedback: activity.snapshot() },
      document.settings.accent,
      deck.id,
    );
  return {
    document,
    binding,
    deck,
    run,
    activity,
    appearance,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("keeps concurrent sibling activity until all runs settle regardless of history order", () => {
  const { document, binding, deck, run, activity, appearance } = fixture(),
    first = run(),
    second = run();
  activity.update(first, document);
  activity.update(second, document);
  second.status = "cancelled";
  activity.update(second, document);
  expect(appearance().background).toBe(document.settings.accent);
  expect(selectBindingRun([first, second], binding, deck.id)).toBe(first);
  first.status = "cancelled";
  activity.update(first, document);
  expect(appearance()).toEqual(binding.appearance);
});
it("expires terminal colors and ignores old timers while a newer run is busy", () => {
  const { document, binding, run, activity, appearance, advance } = fixture(),
    first = run("success");
  activity.update(first, document);
  expect(appearance().background).toBe(binding.appearance.success);
  advance(1500);
  activity.expire();
  expect(appearance()).toEqual(binding.appearance);
  activity.update(run("failure"), document);
  expect(appearance().background).toBe(binding.appearance.error);
  advance(1000);
  const current = run();
  activity.update(current, document);
  advance(500);
  activity.expire();
  expect(appearance().background).toBe(document.settings.accent);
  current.status = "interrupted";
  activity.update(current, document);
  expect(appearance()).toEqual(binding.appearance);
});
it("invalidates deletion and replacement generations, including late completions and overrides", () => {
  const { document, binding, deck, run, activity, appearance } = fixture(),
    stale = run();
  activity.update(stale, document);
  activity.override(deck.id, binding, "Legacy", "#123456");
  binding.generation++;
  activity.reconcile(document);
  stale.status = "success";
  activity.update(stale, document);
  expect(activity.snapshot()).toEqual({});
  expect(appearance()).toEqual(binding.appearance);
  const deleted = run();
  activity.update(deleted, document);
  delete document.profiles[0].pages[0].keys[0];
  activity.reconcile(document);
  deleted.status = "failure";
  activity.update(deleted, document);
  expect(activity.snapshot()).toEqual({});
});
it("preserves authored/observed appearance and legacy overrides through cancellation and worker interruption", () => {
  const { document, binding, deck, run, activity, advance } = fixture();
  binding.press = {
    kind: "action",
    action: {
      type: "media.control",
      version: 1,
      config: { operation: "play-pause", player: "fixture" },
    },
  };
  const observed = () => ({
    media: { fixture: "Playing" },
    buttonFeedback: activity.snapshot(),
  });
  const record = run();
  activity.update(record, document);
  activity.override(deck.id, binding, "Legacy", "#123456");
  for (const status of ["cancelled", "success", "interrupted"] as const) {
    record.status = status;
    activity.update(record, document);
    advance(2000);
    activity.expire();
    const appearance = buttonAppearance(
      binding,
      observed(),
      document.settings.accent,
      deck.id,
    );
    expect(appearance).toMatchObject({
      label: "Legacy",
      background: "#123456",
      icon: binding.appearance.icon,
    });
  }
  activity.interrupt();
  expect(
    buttonAppearance(binding, observed(), document.settings.accent, deck.id),
  ).toMatchObject({ label: "Legacy", background: "#123456" });
  activity.clear();
  expect(
    buttonAppearance(binding, observed(), document.settings.accent, deck.id)
      .background,
  ).toBe(document.settings.accent);
});
it("isolates deck identity even when two decks share a binding, and emits common web/device appearance intent", () => {
  const { document, binding, deck, run, activity } = fixture();
  const other = { ...deck, id: uid() };
  document.decks.push(other);
  activity.update(run(), document);
  const observed = { buttonFeedback: activity.snapshot() };
  expect(Object.keys(observed.buttonFeedback)).toEqual([
    activityKey(deck.id, binding),
  ]);
  // Main sends these fields unchanged to WebKey and hardware frame inputs.
  const frame = buttonAppearance(
    binding,
    observed,
    document.settings.accent,
    deck.id,
  );
  expect(frame.background).toBe(document.settings.accent);
  expect(
    buttonAppearance(binding, observed, document.settings.accent, other.id),
  ).toEqual(binding.appearance);
  expect(selectBindingRun([run()], binding, other.id)).toBeUndefined();
});

it("renders shared web/device output fixtures with busy and restored background pixels", async () => {
  const { Images } = await import("../src/device/images");
  const { document, binding, run, activity, appearance } = fixture(),
    images = new Images(),
    record = run();
  activity.update(record, document);
  const busy = appearance();
  const webKey = {
    label: busy.label,
    icon: busy.icon,
    background: busy.background,
    asset: busy.asset,
  };
  expect(webKey.background).toBe(document.settings.accent);
  const busyFrame = await images.render(busy, 72);
  expect(busyFrame.subarray(0, 3).toString("hex")).toBe(
    document.settings.accent.slice(1),
  );
  record.status = "cancelled";
  activity.update(record, document);
  const restoredFrame = await images.render(appearance(), 72);
  expect(restoredFrame.subarray(0, 3).toString("hex")).toBe(
    binding.appearance.background.slice(1),
  );
  expect(restoredFrame.equals(busyFrame)).toBe(false);
});
