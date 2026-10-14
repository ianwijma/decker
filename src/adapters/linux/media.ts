import dbus from "dbus-next";
import type { Json } from "../../shared/schema";
import { mediaActions, selectedMediaPlayer } from "../../shared/media";

export type MediaBus = Pick<
  ReturnType<typeof dbus.sessionBus>,
  "on" | "getProxyObject" | "disconnect"
>;
const playerInterface = "org.mpris.MediaPlayer2.Player";
const playerPath = "/org/mpris/MediaPlayer2";

/** Injectable session transport: tests never connect to a desktop or player. */
export function createMediaAdapter(connect: () => MediaBus, timeoutMs = 2000) {
  async function busCall<T>(
    fn: (bus: MediaBus, check: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const bus = connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let expired = false;
    const check = () => {
      signal?.throwIfAborted();
      if (expired) throw new Error("Session D-Bus timed out");
    };
    try {
      return await new Promise<T>((resolve, reject) => {
        const fail = (error: unknown) => {
          expired = true;
          reject(error);
        };
        // Keep the error listener until disconnect so late bus errors cannot
        // become unhandled EventEmitter errors after timeout/cancellation.
        bus.on("error", fail);
        timer = setTimeout(
          () => fail(new Error("Session D-Bus timed out")),
          timeoutMs,
        );
        abort = () => fail(signal!.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        Promise.resolve()
          .then(() => {
            check();
            return fn(bus, check);
          })
          .then(resolve, reject);
      });
    } finally {
      expired = true;
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      bus.disconnect();
    }
  }
  const players = (signal?: AbortSignal): Promise<string[]> =>
    busCall(async (bus, check) => {
      const object = await bus.getProxyObject(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
      );
      check();
      const names = (await object
        .getInterface("org.freedesktop.DBus")
        .ListNames()) as string[];
      check();
      return names
        .filter((name) => name.startsWith("org.mpris.MediaPlayer2."))
        .sort();
    }, signal);
  const media = async (
    operation: string,
    player: string,
    signal: AbortSignal,
  ): Promise<Json> => {
    signal.throwIfAborted();
    if (!mediaActions.some((action) => action.operation === operation))
      throw new Error(`Unsupported media operation: ${operation}`);
    const names = await players(signal);
    const name = selectedMediaPlayer(player, names[0] ?? "");
    if (!name || !names.includes(name))
      throw new Error(
        `Media player disappeared or is unavailable${name ? `: ${name}` : ""}`,
      );
    return busCall(async (bus, check) => {
      const object = await bus.getProxyObject(name, playerPath);
      check();
      const iface = object.getInterface(playerInterface);
      if (typeof iface[operation] !== "function")
        throw new Error(`Unsupported media method: ${operation} (${name})`);
      // Keep the existing MPRIS dispatch contract: the player enforces its
      // capabilities. Do not invent a universal CanPlay/CanPause requirement.
      try {
        await iface[operation]();
      } catch (error) {
        check();
        throw new Error(
          `Media ${operation} failed (${name}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      check();
      const status = await object
        .getInterface("org.freedesktop.DBus.Properties")
        .Get(playerInterface, "PlaybackStatus");
      check();
      return { player: name, status: String(status.value) };
    }, signal);
  };
  const observedMedia = async (): Promise<Json> => {
    const names = await players();
    const result: Record<string, Json> = { defaultPlayer: names[0] ?? "" };
    await Promise.all(
      names.map(async (name) => {
        // Each status query has its own bound and cleanup. A hung player must
        // not discard observations of healthy players in the same poll.
        result[name] = await busCall(async (bus, check) => {
          const object = await bus.getProxyObject(name, playerPath);
          check();
          const status = await object
            .getInterface("org.freedesktop.DBus.Properties")
            .Get(playerInterface, "PlaybackStatus");
          check();
          return String(status.value);
        }).catch(() => "Unknown");
      }),
    );
    return result;
  };
  return { players, media, observedMedia };
}

export const { players, media, observedMedia } = createMediaAdapter(() =>
  dbus.sessionBus(),
);
