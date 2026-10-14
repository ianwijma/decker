import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamDeckDeviceInfo } from "@elgato-stream-deck/node";
import {
  DeviceSessions,
  hardwareIdentity,
  type DeviceEvent,
  type DeviceTransport,
  type Frame,
} from "../src/device/session";
import { binding } from "../src/shared/defaults";
import { deviceStatusLabel } from "../src/shared/device-status";
import { Triggers } from "../src/device/triggers";

vi.mock("@elgato-stream-deck/node", () => {
  throw new Error("Fake session tests must never load the real HID driver");
});

// Synthetic XL geometry/identity only. No runtime import of the HID driver.
const controls = Array.from({ length: 32 }, (_, index) => ({
  type: "button",
  feedbackType: "lcd",
  index,
  row: Math.floor(index / 8),
  column: index % 8,
  pixelSize: { width: 96, height: 96 },
}));
function discovery(serial = "TEST-SERIAL", path = "/dev/hidraw-test") {
  return {
    model: "xl",
    serialNumber: serial,
    path,
    modelInfo: { name: "Stream Deck XL", controls },
  } as unknown as StreamDeckDeviceInfo;
}
const appearance = (label: string) => ({
  ...binding("desktop.copy").appearance,
  label,
});
function frame(
  serial = "TEST-SERIAL",
  label = "Configured page",
  brightness = 100,
): Frame {
  return {
    deckId: `deck-${serial}`,
    hardwareId: `xl:${serial}`,
    brightness,
    page: { 0: appearance(label) },
  };
}
class FakeDeck extends EventEmitter {
  CONTROLS = controls;
  setBrightness = vi.fn(async (_value: number) => {});
  fillKeyBuffer = vi.fn(
    async (_key: number, _image: Buffer, _options: unknown) => {},
  );
  close = vi.fn(async () => {});
  transport() {
    return this as unknown as DeviceTransport;
  }
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  // One microtask per successful key write, plus open/render/finalizers.
  for (let i = 0; i < 300; i++) await Promise.resolve();
}
function setup() {
  const events: DeviceEvent[] = [];
  const decks: FakeDeck[] = [];
  const discover = vi.fn(async () => [discovery()]);
  const open = vi.fn(async (_path: string) => {
    const deck = new FakeDeck();
    decks.push(deck);
    return deck.transport();
  });
  const render = vi.fn(
    async (
      a: ReturnType<typeof appearance>,
      _size: number,
      _directory: string,
    ) => Buffer.from(a.label),
  );
  const send = vi.fn((event: DeviceEvent) => {
    events.push(event);
  });
  const sessions = new DeviceSessions({ discover, open, render }, send);
  const status = (id = "xl:TEST-SERIAL") => {
    const report = events.filter((e) => e.type === "devices").at(-1);
    return report?.type === "devices"
      ? report.devices.find((d) => d.id === id)!
      : undefined!;
  };
  return { sessions, discover, open, render, send, events, decks, status };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("truthful hardware sessions", () => {
  it("reproduces discovery success/open EACCES from captured host evidence", async () => {
    const h = setup();
    h.open.mockRejectedValue(
      Object.assign(new Error("Permission denied"), {
        code: "EACCES",
        errno: 13,
      }),
    );
    h.sessions.configure([frame()], "assets");
    await settle();
    expect(h.events).toContainEqual({ type: "nativeReady", ready: true });
    expect(h.status()).toMatchObject({
      present: true,
      configured: true,
      connected: false,
      state: "permission-denied",
      errorDetails: { stage: "open", code: "EACCES", errno: 13 },
    });
    expect(deviceStatusLabel(h.status())).toBe("Permission required");
    expect(h.status().lastSuccessfulWriteAt).toBeUndefined();
    expect(h.render).not.toHaveBeenCalled();
    expect(
      h.events
        .filter((e) => e.type === "devices")
        .flatMap((e) => (e.type === "devices" ? e.devices : []))
        .every((s) => !s.connected),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    await h.sessions.scan();
    expect(h.open).toHaveBeenCalledTimes(1);
    h.open.mockImplementation(async () => new FakeDeck().transport());
    h.sessions.refresh("xl:TEST-SERIAL");
    await settle();
    expect(h.status()).toMatchObject({ state: "ready", connected: true });
    expect(h.status().errorDetails).toBeUndefined();
    await h.sessions.stop();
  });

  it("reports generic HID open failure honestly; supplementary access checks can establish EACCES", async () => {
    const unknown = new Error("cannot open device with path /dev/hidraw-test");
    const h = setup();
    h.open.mockRejectedValue(unknown);
    h.sessions.configure([frame()], "");
    await settle();
    expect(h.status()).toMatchObject({
      state: "open-error",
      connected: false,
      errorDetails: { message: unknown.message },
    });
    const denied = new DeviceSessions(
      {
        discover: h.discover,
        open: h.open,
        render: h.render,
        permissionDenied: async () => true,
      },
      h.send,
    );
    denied.configure([frame()], "");
    await settle();
    expect(h.status()).toMatchObject({
      state: "permission-denied",
      errorDetails: { code: "EACCES" },
    });
    await h.sessions.stop();
    await denied.stop();
  });

  it("lists unconfigured presence without opening or writing; a missing saved deck is disconnected", async () => {
    const h = setup();
    await h.sessions.scan();
    expect(h.status()).toMatchObject({
      state: "discovered",
      present: true,
      configured: false,
      connected: false,
    });
    expect(h.open).not.toHaveBeenCalled();
    h.sessions.configure([frame("MISSING")], "");
    await settle();
    expect(h.status("xl:MISSING")).toMatchObject({
      state: "disconnected",
      present: false,
      configured: true,
    });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
    h.discover.mockResolvedValue([]);
    await h.sessions.scan();
    expect(h.status()).toBeUndefined();
    await h.sessions.stop();
  });

  it("waits for brightness and all initial images before declaring ready", async () => {
    const h = setup(),
      deck = new FakeDeck(),
      brightness = deferred(),
      last = deferred();
    deck.setBrightness.mockImplementation(() => brightness.promise);
    deck.fillKeyBuffer.mockImplementation(async (key) => {
      if (key === 31) await last.promise;
    });
    h.open.mockResolvedValue(deck.transport());
    h.sessions.configure([frame()], "");
    await settle();
    expect(h.status()).toMatchObject({ state: "opening", connected: false });
    expect(deck.fillKeyBuffer).not.toHaveBeenCalled();
    brightness.resolve();
    await settle();
    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(32);
    expect(h.status().state).toBe("opening");
    last.resolve();
    await settle();
    expect(h.status()).toMatchObject({
      state: "ready",
      connected: true,
      lastSuccessfulWriteAt: expect.any(Number),
    });
    expect(deck.setBrightness).toHaveBeenCalledWith(100);
    expect(deck.fillKeyBuffer).toHaveBeenCalledWith(
      0,
      Buffer.from("Configured page"),
      { format: "rgb" },
    );
    expect(deck.fillKeyBuffer).toHaveBeenCalledWith(31, Buffer.from(""), {
      format: "rgb",
    });
    await h.sessions.stop();
  });

  it("publishes initial image failure before closing, retries and resends the full frame", async () => {
    const h = setup(),
      broken = new FakeDeck(),
      close = deferred();
    broken.fillKeyBuffer.mockRejectedValueOnce(
      Object.assign(new Error("write failed"), { code: "EIO" }),
    );
    broken.close.mockImplementation(() => close.promise);
    h.open.mockResolvedValueOnce(broken.transport());
    h.sessions.configure([frame()], "");
    await settle();
    expect(h.status()).toMatchObject({
      state: "io-error",
      connected: false,
      errorDetails: { stage: "write", code: "EIO" },
    });
    expect(h.events).toContainEqual({
      type: "disconnect",
      id: "xl:TEST-SERIAL",
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(h.open).toHaveBeenCalledTimes(1);
    close.resolve();
    await settle();
    expect(h.status().state).toBe("ready");
    expect(h.decks[0].setBrightness).toHaveBeenCalledWith(100);
    expect(h.decks[0].fillKeyBuffer).toHaveBeenCalledTimes(32);
    await h.sessions.stop();
  });

  it("bounds busy/transient retry backoff and allows explicit retry after exhaustion", async () => {
    const h = setup();
    h.open.mockRejectedValue(
      Object.assign(new Error("Device busy"), { code: "EBUSY" }),
    );
    h.sessions.configure([frame()], "");
    await settle();
    expect(deviceStatusLabel(h.status())).toBe("Device busy");
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      const count = h.open.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.open).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.open).toHaveBeenCalledTimes(count + 1);
    }
    await vi.advanceTimersByTimeAsync(60000);
    await h.sessions.scan();
    expect(h.open).toHaveBeenCalledTimes(6);
    h.sessions.refresh();
    await settle();
    expect(h.open).toHaveBeenCalledTimes(7);
    await h.sessions.stop();
  });

  it("keeps native availability separate and recovers from discovery/native load failure", async () => {
    const h = setup();
    h.discover.mockRejectedValueOnce(new Error("native driver unavailable"));
    h.sessions.configure([frame()], "");
    await settle();
    expect(h.events).toContainEqual({
      type: "nativeReady",
      ready: false,
      error: "Error: native driver unavailable",
    });
    expect(h.status()).toMatchObject({
      connected: false,
      state: "io-error",
      errorDetails: { stage: "discovery" },
    });
    expect(h.open).not.toHaveBeenCalled();
    await h.sessions.scan();
    await settle();
    expect(h.status().state).toBe("ready");
    h.discover.mockRejectedValueOnce(new Error("enumeration failed"));
    await h.sessions.scan();
    await settle();
    expect(h.status().connected).toBe(false);
    await h.sessions.scan();
    await settle();
    expect(h.status().state).toBe("ready");
    await h.sessions.stop();
  });

  it("serializes/coalesces page and brightness updates using only successful write caches", async () => {
    const h = setup();
    h.sessions.configure([frame()], "assets");
    await settle();
    const deck = h.decks[0],
      first = deferred();
    deck.fillKeyBuffer.mockImplementationOnce(() => first.promise);
    h.sessions.configure([frame("TEST-SERIAL", "intermediate", 100)], "assets");
    await settle();
    for (let i = 0; i < 100; i++)
      h.sessions.configure([frame("TEST-SERIAL", `latest-${i}`, i)], "assets");
    await settle();
    expect(deck.setBrightness).toHaveBeenCalledTimes(1);
    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(33);
    first.resolve();
    await settle();
    expect(deck.setBrightness.mock.calls.map(([n]) => n)).toEqual([100, 99]);
    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(34);
    expect(deck.fillKeyBuffer.mock.calls.at(-1)).toEqual([
      0,
      Buffer.from("latest-99"),
      { format: "rgb" },
    ]);
    h.sessions.configure([frame("TEST-SERIAL", "latest-99", 99)], "assets");
    await settle();
    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(34);
    h.sessions.configure(
      [{ ...frame("TEST-SERIAL", "", 99), page: {} }],
      "assets",
    );
    await settle();
    expect(deck.fillKeyBuffer.mock.calls.at(-1)?.[1]).toEqual(Buffer.from(""));
    await h.sessions.stop();
  });

  it("preserves serial identity across changed paths and restores images, brightness and held input", async () => {
    const h = setup(),
      fire = vi.fn(),
      triggers = new Triggers(fire),
      b = binding("desktop.copy");
    b.longPress = b.press;
    b.release = b.press;
    h.send.mockImplementation((event) => {
      h.events.push(event);
      if (event.type === "disconnect") triggers.disconnect(event.id);
      if (event.type === "key") {
        if (event.down) triggers.down(event.id, event.key, b);
        else triggers.up(event.id, event.key);
      }
    });
    h.sessions.configure([frame()], "");
    await settle();
    const first = h.decks[0];
    first.emit("down", controls[0]);
    h.discover.mockResolvedValue([]);
    await h.sessions.scan();
    expect(h.status()).toMatchObject({
      state: "disconnected",
      present: false,
      connected: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    first.emit("up", controls[0]);
    expect(fire).not.toHaveBeenCalled();
    const changed = discovery("TEST-SERIAL", "/dev/hidraw-changed");
    expect(hardwareIdentity(changed)).toBe("xl:TEST-SERIAL");
    h.discover.mockResolvedValue([changed]);
    await h.sessions.scan();
    await settle();
    expect(h.open).toHaveBeenLastCalledWith(changed.path);
    expect(h.status().state).toBe("ready");
    expect(h.decks[1].fillKeyBuffer).toHaveBeenCalledTimes(32);
    expect(h.decks[1].setBrightness).toHaveBeenCalledWith(100);
    // Direct path replacement while still enumerated must also reopen immediately.
    h.discover.mockResolvedValue([
      discovery("TEST-SERIAL", "/dev/hidraw-third"),
    ]);
    await h.sessions.scan();
    await settle();
    expect(h.decks[1].close).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenLastCalledWith("/dev/hidraw-third");
    expect(h.decks[2].fillKeyBuffer).toHaveBeenCalledTimes(32);
    await h.sessions.stop();
  });

  it("recovers from a ready deck error and ignores input from its old connection", async () => {
    const h = setup();
    h.sessions.configure([frame()], "");
    await settle();
    const old = h.decks[0];
    old.emit("down", controls[0]);
    old.emit("error", new Error("USB read failed"));
    expect(h.status().state).toBe("io-error");
    old.emit("up", controls[0]);
    expect(h.events.filter((e) => e.type === "key")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(h.status().state).toBe("ready");
    expect(h.decks[1].fillKeyBuffer).toHaveBeenCalledTimes(32);
    await h.sessions.stop();
  });

  it("two decks have independent frames, brightness, writes, errors and retries", async () => {
    const h = setup(),
      blocked = new FakeDeck(),
      second = new FakeDeck(),
      wait = deferred();
    h.discover.mockResolvedValue([
      discovery("ONE", "/one"),
      discovery("TWO", "/two"),
    ]);
    blocked.fillKeyBuffer.mockImplementationOnce(() => wait.promise);
    h.open
      .mockResolvedValueOnce(blocked.transport())
      .mockResolvedValueOnce(second.transport());
    h.sessions.configure(
      [frame("ONE", "one", 20), frame("TWO", "two", 80)],
      "",
    );
    await settle();
    expect(h.status("xl:ONE").state).toBe("opening");
    expect(h.status("xl:TWO").state).toBe("ready");
    expect(second.setBrightness).toHaveBeenCalledWith(80);
    expect(second.fillKeyBuffer).toHaveBeenCalledWith(0, Buffer.from("two"), {
      format: "rgb",
    });
    wait.reject(Object.assign(new Error("one write failed"), { code: "EIO" }));
    await settle();
    expect(h.status("xl:ONE").state).toBe("io-error");
    expect(h.status("xl:TWO").state).toBe("ready");
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(h.status("xl:ONE").state).toBe("ready");
    expect(second.fillKeyBuffer).toHaveBeenCalledTimes(32);
    expect(second.close).not.toHaveBeenCalled();
    await h.sessions.stop();
  });

  it("unconfiguration cancels pending I/O, keys and retries; late opens are closed", async () => {
    const h = setup(),
      opened = deferred<DeviceTransport>(),
      deck = new FakeDeck();
    h.open.mockImplementationOnce(() => opened.promise);
    h.sessions.configure([frame()], "");
    await settle();
    h.sessions.configure([], "");
    opened.resolve(deck.transport());
    await settle();
    expect(deck.close).toHaveBeenCalledTimes(1);
    expect(deck.setBrightness).not.toHaveBeenCalled();
    expect(deck.fillKeyBuffer).not.toHaveBeenCalled();
    expect(h.status()).toMatchObject({
      state: "discovered",
      configured: false,
      connected: false,
    });
    await h.sessions.stop();
  });

  it("brightness failure is not ready, and pending updates are applied by the fresh connection", async () => {
    const h = setup(),
      broken = new FakeDeck();
    broken.setBrightness.mockRejectedValueOnce(
      new Error("brightness write failed"),
    );
    h.open.mockResolvedValueOnce(broken.transport());
    h.sessions.configure([frame()], "");
    await settle();
    expect(h.status()).toMatchObject({ state: "io-error", connected: false });
    expect(h.status().lastSuccessfulWriteAt).toBeUndefined();
    expect(broken.fillKeyBuffer).not.toHaveBeenCalled();
    h.sessions.configure([frame("TEST-SERIAL", "recovery page", 12)], "");
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(h.decks[0].setBrightness).toHaveBeenCalledWith(12);
    expect(h.decks[0].fillKeyBuffer).toHaveBeenCalledWith(
      0,
      Buffer.from("recovery page"),
      { format: "rgb" },
    );
    expect(h.status().state).toBe("ready");
    await h.sessions.stop();
  });

  it("preserves two simultaneous device-specific errors", async () => {
    const h = setup();
    h.discover.mockResolvedValue([
      discovery("ONE", "/one"),
      discovery("TWO", "/two"),
    ]);
    h.open
      .mockRejectedValueOnce(
        Object.assign(new Error("Permission denied for one"), {
          code: "EACCES",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("Device busy two"), { code: "EBUSY" }),
      );
    h.sessions.configure([frame("ONE"), frame("TWO")], "");
    await settle();
    expect(h.status("xl:ONE")).toMatchObject({
      state: "permission-denied",
      errorDetails: { code: "EACCES", message: "Permission denied for one" },
    });
    expect(h.status("xl:TWO")).toMatchObject({
      state: "busy",
      errorDetails: { code: "EBUSY", message: "Device busy two" },
    });
    await h.sessions.scan();
    expect(h.status("xl:ONE").state).toBe("permission-denied");
    expect(h.status("xl:TWO").state).toBe("busy");
    await h.sessions.stop();
  });

  it("cancels remaining frame writes and held input immediately when a deck is unconfigured", async () => {
    const h = setup(),
      pending = deferred();
    h.sessions.configure([frame()], "");
    await settle();
    const deck = h.decks[0];
    deck.fillKeyBuffer.mockImplementationOnce(() => pending.promise);
    h.sessions.configure([frame("TEST-SERIAL", "new page", 30)], "");
    await settle();
    h.sessions.configure([], "");
    deck.emit("down", controls[0]);
    pending.resolve();
    await settle();
    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(33);
    expect(deck.close).toHaveBeenCalledTimes(1);
    expect(h.events.filter((e) => e.type === "key")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.open).toHaveBeenCalledTimes(1);
    await h.sessions.stop();
  });
});
