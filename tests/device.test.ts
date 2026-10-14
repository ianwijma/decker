import { describe, it, expect, vi, afterEach } from "vitest";
import { Triggers } from "../src/device/triggers";
import { Images, WriteQueue } from "../src/device/images";
import { binding } from "../src/shared/defaults";
import { setTimeout as sleep } from "node:timers/promises";
afterEach(() => vi.useRealTimers());
describe("simulated deck", () => {
  it("captures bindings across profile changes and ignores duplicate downs", () => {
    const fire = vi.fn(),
      triggers = new Triggers(fire),
      b = binding("desktop.copy", "original");
    b.release = b.press;
    triggers.down("xl", 1, b);
    triggers.down("xl", 1, b);
    b.appearance.label = "changed";
    triggers.up("xl", 1);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire.mock.calls[1][0].appearance.label).toBe("original");
  });
  it("resolves short press on release and suppresses it after a long press", () => {
    vi.useFakeTimers();
    const fire = vi.fn(),
      triggers = new Triggers(fire),
      b = binding("desktop.copy");
    b.longPress = { kind: "workflow", workflowId: "hold" };
    triggers.down("xl", 0, b);
    vi.advanceTimersByTime(200);
    expect(fire).not.toHaveBeenCalled();
    triggers.up("xl", 0);
    expect(fire).toHaveBeenCalledWith(expect.anything(), b.press);
    fire.mockClear();
    triggers.down("xl", 0, b);
    vi.advanceTimersByTime(700);
    triggers.up("xl", 0);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(expect.anything(), b.longPress);
  });
  it("clears held buttons on disconnect and never replays release", () => {
    vi.useFakeTimers();
    const fire = vi.fn(),
      t = new Triggers(fire),
      b = binding("desktop.copy");
    b.longPress = b.press;
    b.release = b.press;
    t.down("xl", 0, b);
    t.disconnect("xl");
    vi.advanceTimersByTime(1000);
    t.up("xl", 0);
    expect(fire).not.toHaveBeenCalled();
  });
  it("coalesces pending images and serializes writes", async () => {
    const writes: number[] = [],
      queue = new WriteQueue(() => {});
    queue.set(0, async () => {
      await sleep(15);
      writes.push(0);
    });
    for (let i = 1; i <= 100; i++)
      queue.set(1, async () => {
        writes.push(i);
      });
    expect(queue.size).toBe(1);
    await sleep(40);
    expect(writes).toEqual([0, 100]);
  });
  it("escapes SVG labels and produces cached native RGB buffers", async () => {
    const images = new Images(),
      appearance = {
        ...binding("desktop.copy").appearance,
        label: '<script>&"',
        icon: ">",
      };
    const a = await images.render(appearance, 96),
      b = await images.render(appearance, 96);
    expect(a).toBe(b);
    expect(a.length).toBe(96 * 96 * 3);
  });
});

it("derives mute and scene feedback from observed state only", async () => {
  const { observedAppearance } = await import("../src/shared/feedback");
  const b = binding("obs.control");
  if (b.press?.kind !== "action") throw new Error();
  b.press.action.config.operation = "scene";
  b.press.action.config.name = "Live";
  expect(
    observedAppearance(
      b,
      { "obs:obs": { connected: true, scene: "Live" } },
      "#112233",
    ).background,
  ).toBe("#112233");
  expect(
    observedAppearance(
      b,
      { "obs:obs": { connected: true, scene: "Other" } },
      "#112233",
    ).background,
  ).toBe(b.appearance.background);
  const audio = binding("audio.control");
  if (audio.press?.kind !== "action") throw new Error();
  audio.press.action.config.target = "@DEFAULT_AUDIO_SOURCE@";
  expect(
    observedAppearance(
      audio,
      { microphone: { stdout: "Volume: 1.00 [MUTED]" } },
      "#112233",
    ).label,
  ).toBe("Muted");
  expect(
    observedAppearance(
      audio,
      { microphone: { stdout: "Volume: 1.00" } },
      "#112233",
    ).label,
  ).toBe("Live");
});
