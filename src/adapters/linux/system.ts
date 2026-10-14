import { spawn } from "node:child_process";
import { execa } from "execa";
import { desktopProbe } from "./diagnostics";
import { players } from "./media";
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
  return desktopProbe(players);
}
export { players, media, observedMedia } from "./media";
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
