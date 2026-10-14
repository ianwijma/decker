import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaAdapter, type MediaBus } from "../src/adapters/linux/media";
import { mediaActions } from "../src/shared/media";

const first = "org.mpris.MediaPlayer2.alpha";
const second = "org.mpris.MediaPlayer2.beta";
function fixture(timeout = 30) {
  const state = {
    names: [second, "org.unrelated", first],
    statuses: { [first]: "Paused", [second]: "Playing" } as Record<
      string,
      string
    >,
    failed: new Set<string>(),
    hung: new Set<string>(),
    missing: "",
    refused: "",
    enumeration: "ok",
    getProxy: undefined as undefined | (() => Promise<void>),
  };
  const calls: string[][] = [];
  const buses: (EventEmitter & { disconnect: ReturnType<typeof vi.fn> })[] = [];
  const connect = () => {
    const bus = Object.assign(new EventEmitter(), {
      disconnect: vi.fn(),
      getProxyObject: async (name: string) => {
        await state.getProxy?.();
        return {
          getInterface: (iface: string) => {
            if (iface === "org.freedesktop.DBus")
              return {
                ListNames: async () => {
                  if (state.enumeration === "hang")
                    return new Promise(() => {});
                  if (state.enumeration === "fail")
                    throw new Error("No session bus");
                  return state.names;
                },
              };
            if (iface === "org.freedesktop.DBus.Properties")
              return {
                Get: async () => {
                  if (state.failed.has(name)) throw new Error("Status denied");
                  if (state.hung.has(name)) return new Promise(() => {});
                  return { value: state.statuses[name] };
                },
              };
            return Object.fromEntries(
              mediaActions
                .filter((a) => a.operation !== state.missing)
                .map(({ operation }) => [
                  operation,
                  async () => {
                    calls.push([name, operation]);
                    if (operation === state.refused)
                      throw new Error(
                        "org.mpris.MediaPlayer2.Player.Error.NotSupported: capability unavailable",
                      );
                  },
                ]),
            );
          },
        };
      },
    });
    buses.push(bus);
    return bus as unknown as MediaBus;
  };
  return { ...createMediaAdapter(connect, timeout), state, calls, buses };
}
afterEach(() => vi.useRealTimers());
describe("fixture-backed MPRIS transport", () => {
  it.each(mediaActions)(
    "dispatches $operation to default and explicit players",
    async ({ operation }) => {
      const f = fixture();
      expect(await f.players()).toEqual([first, second]);
      expect(
        await f.media(operation, "", new AbortController().signal),
      ).toEqual({ player: first, status: "Paused" });
      expect(
        await f.media(operation, second, new AbortController().signal),
      ).toEqual({ player: second, status: "Playing" });
      expect(f.calls).toEqual([
        [first, operation],
        [second, operation],
      ]);
      expect(
        f.buses.every((bus) => bus.disconnect.mock.calls.length === 1),
      ).toBe(true);
    },
  );
  it("rejects absent and disappeared explicit players without fallback", async () => {
    const f = fixture();
    f.state.names = [first];
    await expect(
      f.media("Play", second, new AbortController().signal),
    ).rejects.toThrow("disappeared");
    f.state.names = [];
    await expect(
      f.media("Play", "", new AbortController().signal),
    ).rejects.toThrow("unavailable");
    expect(f.calls).toEqual([]);
  });
  it("reports invalid operations, missing methods and player capability refusals", async () => {
    const f = fixture();
    await expect(
      f.media("Execute", "", new AbortController().signal),
    ).rejects.toThrow("Unsupported media operation");
    expect(f.buses).toHaveLength(0);
    f.state.missing = "Stop";
    await expect(
      f.media("Stop", "", new AbortController().signal),
    ).rejects.toThrow("Unsupported media method: Stop");
    f.state.refused = "Next";
    await expect(
      f.media("Next", "", new AbortController().signal),
    ).rejects.toThrow(/Next failed.*capability unavailable/);
    expect(f.buses.every((bus) => bus.disconnect.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("isolates failed and hung queries, preserves sorted default and recovers on later polls", async () => {
    const f = fixture();
    for (const failures of [f.state.failed, f.state.hung]) {
      failures.add(first);
      expect(await f.observedMedia()).toEqual({
        defaultPlayer: first,
        [first]: "Unknown",
        [second]: "Playing",
      });
      failures.clear();
    }
    f.state.statuses[first] = "Playing";
    f.state.statuses[second] = "Stopped";
    expect(await f.observedMedia()).toEqual({
      defaultPlayer: first,
      [first]: "Playing",
      [second]: "Stopped",
    });
    f.state.names = [second];
    expect(await f.observedMedia()).toEqual({
      defaultPlayer: second,
      [second]: "Stopped",
    });
    expect(f.buses.every((bus) => bus.disconnect.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("bounds enumeration and method/status calls and propagates D-Bus errors", async () => {
    const f = fixture();
    f.state.enumeration = "hang";
    await expect(f.players()).rejects.toThrow("timed out");
    f.state.enumeration = "fail";
    await expect(f.observedMedia()).rejects.toThrow("No session bus");
    f.state.enumeration = "ok";
    f.state.hung.add(first);
    await expect(
      f.media("Play", "", new AbortController().signal),
    ).rejects.toThrow("timed out");
    const pending = f.players();
    f.buses.at(-1)!.emit("error", new Error("Disconnected"));
    await expect(pending).rejects.toThrow("Disconnected");
    expect(f.buses.every((bus) => bus.disconnect.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("aborts before connection and during enumeration/status, disconnecting promptly", async () => {
    const f = fixture(10000);
    const aborted = AbortSignal.abort(new Error("Cancelled"));
    await expect(f.media("Play", "", aborted)).rejects.toThrow("Cancelled");
    expect(f.buses).toHaveLength(0);
    f.state.enumeration = "hang";
    const controller = new AbortController();
    const pending = f.media("Play", "", controller.signal);
    controller.abort(new Error("Cancelled"));
    await expect(pending).rejects.toThrow("Cancelled");
    expect(f.calls).toEqual([]);
    f.state.enumeration = "ok";
    f.state.hung.add(first);
    const statusController = new AbortController();
    const status = f.media("Pause", "", statusController.signal);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    statusController.abort(new Error("Cancelled"));
    await expect(status).rejects.toThrow("Cancelled");
    expect(f.buses.every((bus) => bus.disconnect.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("does not dispatch a late proxy result after cancellation or timeout", async () => {
    for (const abort of [true, false]) {
      const f = fixture();
      let release!: () => void;
      f.state.getProxy = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const controller = new AbortController();
      const pending = f.media("Play", "", controller.signal);
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"), {
        interval: 1,
      });
      if (abort) controller.abort();
      await rejected;
      release();
      await Promise.resolve();
      expect(f.calls).toEqual([]);
      expect(f.buses[0].disconnect).toHaveBeenCalledTimes(1);
    }
  });
});
