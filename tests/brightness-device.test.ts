import { EventEmitter } from "node:events";
import { it, expect, vi } from "vitest";
import type { StreamDeckDeviceInfo } from "@elgato-stream-deck/node";
import { DeviceSessions, type DeviceTransport } from "../src/device/session";
import { commitBrightness } from "../src/main/brightness";
import { defaults } from "../src/shared/defaults";

vi.mock("@elgato-stream-deck/node", () => {
  throw new Error("Brightness fixtures must never load the real HID driver");
});

it("transports committed relative brightness to a fake device without changing its peer", async () => {
  const controls = [
    {
      type: "button",
      feedbackType: "lcd",
      index: 0,
      row: 0,
      column: 0,
      pixelSize: { width: 96, height: 96 },
    },
  ];
  function fake() {
    return Object.assign(new EventEmitter(), {
      CONTROLS: controls,
      setBrightness: vi.fn(async (_value: number) => {}),
      fillKeyBuffer: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
  }
  const first = fake(),
    second = fake();
  let doc = defaults();
  doc.decks[0].kind = "hardware";
  doc.decks[0].hardwareId = "xl:ONE";
  doc.decks.push({
    ...doc.decks[0],
    id: "second",
    hardwareId: "xl:TWO",
    brightness: 0,
  });
  const sessions = new DeviceSessions(
    {
      discover: async () =>
        ["ONE", "TWO"].map(
          (serial) =>
            ({
              model: "xl",
              serialNumber: serial,
              path: serial,
              modelInfo: { name: "Fixture", controls },
            }) as unknown as StreamDeckDeviceInfo,
        ),
      open: async (path) =>
        (path === "ONE" ? first : second) as unknown as DeviceTransport,
      render: async () => Buffer.alloc(96 * 96 * 3),
    },
    () => {},
  );
  const configure = async () => {
    sessions.configure(
      doc.decks.map((d) => ({
        deckId: d.id,
        hardwareId: d.hardwareId!,
        brightness: d.brightness,
        page: {},
      })),
      "",
    );
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  try {
    await configure();
    doc = (
      await commitBrightness(
        doc,
        "deck.brightnessIncrease",
        { step: 10 },
        doc.decks[0].id,
        async () => {},
      )
    ).document;
    await configure();
    expect(first.setBrightness.mock.calls.map(([v]) => v)).toEqual([70, 80]);
    expect(second.setBrightness.mock.calls.map(([v]) => v)).toEqual([0]);
  } finally {
    await sessions.stop();
  }
});
