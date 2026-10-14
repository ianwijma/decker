import { spawn } from "node:child_process";
import { execa } from "execa";
import dbus from "dbus-next";
import type { Capability, Json } from "../../shared/schema";
export async function command(
  executable: string,
  args: string[],
  signal: AbortSignal,
  cwd?: string,
): Promise<Json> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: cwd || undefined,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* already exited */
        }
    };
    const abort = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
      killTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(0, 16384);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(0, 16384);
    });
    child.on("error", (error) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      kill("SIGKILL");
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0)
        reject(new Error(`Command exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
export async function probe(): Promise<Capability[]> {
  const check = async (cmd: string, args: string[]) => {
    try {
      await execa(cmd, args, { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  };
  const x11 =
    process.env.XDG_SESSION_TYPE === "x11" ||
    (!process.env.WAYLAND_DISPLAY && Boolean(process.env.DISPLAY));
  const [keyboard, wpctl, pactl] = await Promise.all([
    check("xdotool", ["version"]),
    check("wpctl", ["status"]),
    check("pactl", ["info"]),
  ]);
  let media = false;
  try {
    media = (await players()).length > 0;
  } catch {
    /* unavailable bus */
  }
  return [
    {
      id: "keyboard",
      available: x11 && keyboard,
      detail: x11
        ? keyboard
          ? "X11 · xdotool ready"
          : "Install xdotool to send keyboard input"
        : "Wayland input injection is not supported; use an X11 session",
    },
    {
      id: "audio",
      available: wpctl || pactl,
      detail: wpctl
        ? "PipeWire · wpctl ready"
        : pactl
          ? "PulseAudio · pactl ready"
          : "No responding wpctl/pactl service. Start PipeWire or PulseAudio.",
    },
    {
      id: "media",
      available: media,
      detail: media
        ? "MPRIS player available"
        : "No MPRIS player on the session bus. Start a supported media player.",
    },
    {
      id: "obs",
      available: false,
      detail: "Configure an OBS WebSocket connection in Settings.",
    },
  ];
}
async function busCall<T>(
  fn: (bus: ReturnType<typeof dbus.sessionBus>) => Promise<T>,
): Promise<T> {
  const bus = dbus.sessionBus();
  bus.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(bus),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Session D-Bus timed out")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    bus.disconnect();
  }
}
export async function players(): Promise<string[]> {
  return busCall(async (bus) => {
    const object = await bus.getProxyObject(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
    );
    const names = (await object
      .getInterface("org.freedesktop.DBus")
      .ListNames()) as string[];
    return names.filter((n) => n.startsWith("org.mpris.MediaPlayer2.")).sort();
  });
}
export async function media(
  operation: string,
  player: string,
  signal: AbortSignal,
): Promise<Json> {
  const names = await players(),
    name = player || names[0];
  if (!name || !names.includes(name))
    throw new Error("Media player disappeared or is unavailable");
  if (
    !["PlayPause", "Play", "Pause", "Next", "Previous", "Stop"].includes(
      operation,
    )
  )
    throw new Error("Unsupported media operation");
  signal.throwIfAborted();
  return busCall(async (bus) => {
    const object = await bus.getProxyObject(name, "/org/mpris/MediaPlayer2");
    signal.throwIfAborted();
    await object.getInterface("org.mpris.MediaPlayer2.Player")[operation]();
    const status = await object
      .getInterface("org.freedesktop.DBus.Properties")
      .Get("org.mpris.MediaPlayer2.Player", "PlaybackStatus");
    return { player: name, status: String(status.value) };
  });
}
export async function audio(
  operation: string,
  target: string,
  value: string,
  signal: AbortSignal,
  deviceKind = "output",
): Promise<Json> {
  let wpctl = true;
  try {
    await execa("wpctl", ["status"], { timeout: 1500, cancelSignal: signal });
  } catch {
    wpctl = false;
  }
  if (
    operation === "volume" &&
    (!Number.isFinite(Number(value)) ||
      Number(value) < 0 ||
      Number(value) > 1.5)
  )
    throw new Error("Volume must be between 0 and 1.5");
  if (operation === "mute" && !["0", "1", "toggle"].includes(value))
    throw new Error("Mute must be 0, 1 or toggle");
  if (wpctl) {
    if (!["mute", "volume", "default"].includes(operation))
      throw new Error("Unsupported audio operation");
    await command(
      "wpctl",
      operation === "default"
        ? ["set-default", target]
        : [operation === "mute" ? "set-mute" : "set-volume", target, value],
      signal,
    );
    return command(
      "wpctl",
      ["get-volume", operation === "default" ? "@DEFAULT_AUDIO_SINK@" : target],
      signal,
    );
  }
  const source = target.includes("SOURCE") || deviceKind === "input",
    pulseTarget = target
      .replace("@DEFAULT_AUDIO_SINK@", "@DEFAULT_SINK@")
      .replace("@DEFAULT_AUDIO_SOURCE@", "@DEFAULT_SOURCE@");
  const op =
    operation === "default"
      ? `set-default-${source ? "source" : "sink"}`
      : `set-${source ? "source" : "sink"}-${operation === "mute" ? "mute" : "volume"}`;
  await command(
    "pactl",
    operation === "default"
      ? [op, pulseTarget]
      : [
          op,
          pulseTarget,
          operation === "volume"
            ? `${Number(value) * 100}%`
            : value === "1"
              ? "1"
              : value === "0"
                ? "0"
                : "toggle",
        ],
    signal,
  );
  return command(
    "pactl",
    [`get-${source ? "source" : "sink"}-mute`, pulseTarget],
    signal,
  );
}
export async function observedAudio(source = true): Promise<Json> {
  try {
    return await command(
      "wpctl",
      [
        "get-volume",
        source ? "@DEFAULT_AUDIO_SOURCE@" : "@DEFAULT_AUDIO_SINK@",
      ],
      AbortSignal.timeout(1500),
    );
  } catch {
    try {
      return await command(
        "pactl",
        [
          source ? "get-source-mute" : "get-sink-mute",
          source ? "@DEFAULT_SOURCE@" : "@DEFAULT_SINK@",
        ],
        AbortSignal.timeout(1500),
      );
    } catch {
      return { unavailable: true };
    }
  }
}

export async function observedMedia(): Promise<Json> {
  const names = await players();
  return busCall(async (bus) => {
    const result: Record<string, Json> = { defaultPlayer: names[0] ?? "" };
    await Promise.allSettled(
      names.map(async (name) => {
        const object = await bus.getProxyObject(
          name,
          "/org/mpris/MediaPlayer2",
        );
        const status = await object
          .getInterface("org.freedesktop.DBus.Properties")
          .Get("org.mpris.MediaPlayer2.Player", "PlaybackStatus");
        result[name] = String(status.value);
      }),
    );
    return result;
  });
}
