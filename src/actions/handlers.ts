import { spawn } from "node:child_process";
import { actionById } from "../shared/catalog";
import type { AppDocument, Json } from "../shared/schema";
import type { Handler, ActionContext } from "../runtime/engine";
import { ResourceLocks } from "../runtime/coordinator";
import { audio, command, media } from "../adapters/linux/system";
import { ObsConnections } from "../integrations/obs";
import { mediaAction } from "../shared/media";
export function handlers(
  getDocument: () => AppDocument,
  secrets: () => Record<string, string>,
  main: (
    type: string,
    config: Record<string, Json>,
    context: ActionContext,
  ) => Promise<Json>,
  obs: ObsConnections,
): Handler {
  const locks = new ResourceLocks();
  return async (action, context) => {
    const def = actionById(action.type);
    if (!def || action.version !== def.version)
      throw new Error(`Unsupported action: ${action.type}`);
    const parsed = def.schema.safeParse(action.config);
    if (!parsed.success)
      throw new Error(
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", "),
      );
    const c = action.config,
      s = (key: string) => String(c[key] ?? ""),
      args = () => {
        const a = JSON.parse(s("args"));
        if (
          !Array.isArray(a) ||
          !a.every((x) => typeof x === "string") ||
          a.length > 256
        )
          throw new Error(
            "Arguments must be a JSON array of strings (maximum 256)",
          );
        return a as string[];
      };
    const perform = async (): Promise<Json> => {
      context.signal.throwIfAborted();
      const descriptor = mediaAction(action.type, c);
      if (descriptor)
        return media(descriptor.operation, s("player"), context.signal);
      switch (action.type) {
        case "app.launch":
          return new Promise((resolve, reject) => {
            const child = spawn(s("executable"), args(), {
              detached: true,
              stdio: "ignore",
            });
            child.on("error", reject);
            child.on("spawn", () => {
              child.unref();
              resolve({ pid: child.pid ?? 0 });
            });
          });
        case "command.run":
          return command(s("executable"), args(), context.signal, s("cwd"));
        case "command.shell":
          return command(
            "/bin/sh",
            ["-c", s("script")],
            context.signal,
            s("cwd"),
          );
        case "keyboard.shortcut":
        case "keyboard.type": {
          if (
            process.env.XDG_SESSION_TYPE === "wayland" ||
            process.env.WAYLAND_DISPLAY
          )
            throw new Error(
              "Keyboard injection requires X11; Wayland is not supported",
            );
          if (!process.env.DISPLAY) throw new Error("No X11 display available");
          return command(
            "xdotool",
            action.type === "keyboard.shortcut"
              ? ["key", "--clearmodifiers", s("keys")]
              : ["type", "--clearmodifiers", "--", s("text")],
            context.signal,
          );
        }
        case "audio.control":
          return audio(
            s("operation"),
            s("target"),
            s("value"),
            context.signal,
            s("deviceKind"),
          );
        case "http.request": {
          const url = new URL(s("url"));
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error("Use an HTTP(S) URL without embedded credentials");
          const secret = s("credentialRef")
            ? secrets()[s("credentialRef")]
            : undefined;
          if (s("credentialRef") && !secret)
            throw new Error("Credential unavailable; add it in Settings");
          const response = await fetch(url, {
            method: s("method"),
            body: ["GET", "HEAD"].includes(s("method"))
              ? undefined
              : s("body") || undefined,
            headers: secret ? { Authorization: `Bearer ${secret}` } : {},
            signal: context.signal,
            redirect: secret ? "error" : "follow",
          });
          const reader = response.body?.getReader();
          let bytes = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (reader) {
              const { done, value } = await reader.read();
              if (done) break;
              const remaining = 16384 - bytes;
              chunks.push(value.subarray(0, remaining));
              bytes += value.length;
              if (bytes >= 16384) break;
            }
          } finally {
            await reader?.cancel();
          }
          const body = Buffer.concat(chunks).toString("utf8");
          if (!response.ok)
            throw new Error(`HTTP ${response.status}: ${body.slice(0, 1000)}`);
          return { status: response.status, body, truncated: bytes > 16384 };
        }
        case "obs.control": {
          const connection = getDocument().connections.find(
            (x) => x.id === s("connectionId"),
          );
          if (!connection) throw new Error("OBS connection is not configured");
          return obs.execute(
            connection,
            connection.credentialRef
              ? secrets()[connection.credentialRef]
              : undefined,
            c,
            context.signal,
          );
        }
        default:
          return main(action.type, c, context);
      }
    };
    return def.resource
      ? locks.run(
          `${def.resource}:${def.resource === "obs" ? s("connectionId") : def.resource === "audio" ? s("target") : ""}`,
          context.signal,
          perform,
        )
      : perform();
  };
}
