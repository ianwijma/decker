import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { execa } from "execa";
import type { Capability, Json } from "../../shared/schema";

export function distributionFrom(text: string): string {
  const values = Object.fromEntries(
    text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(
        /^(ID|ID_LIKE)=(?:"([^"]*)"|'([^']*)'|([^\s#]*))$/,
      );
      return match ? [[match[1], match[2] ?? match[3] ?? match[4]]] : [];
    }),
  );
  const supported = ["pop", "ubuntu", "debian", "fedora", "arch"];
  return (
    [values.ID, ...(values.ID_LIKE ?? "").split(/\s+/)].find((id) =>
      supported.includes(id),
    ) ?? "unknown"
  );
}
export type DesktopProbe = {
  session: "x11" | "wayland" | "unknown";
  distribution: string;
  installed(tool: "xdotool" | "wpctl" | "pactl"): Promise<boolean>;
  responds(tool: "xdotool" | "wpctl" | "pactl"): Promise<boolean>;
  players(): Promise<string[]>;
};
export async function probeDesktop(io: DesktopProbe): Promise<Capability[]> {
  const tools = ["xdotool", "wpctl", "pactl"] as const;
  const installed = await Promise.all(tools.map((t) => io.installed(t)));
  const responding = await Promise.all(
    tools.map((t, i) => (installed[i] ? io.responds(t) : false)),
  );
  let players: string[] = [],
    bus = true;
  try {
    players = await io.players();
  } catch {
    bus = false;
  }
  const capability = (
    id: string,
    available: boolean,
    state: NonNullable<Capability["state"]>,
    detail: string,
    remedy?: Capability["remedy"],
  ): Capability => ({
    id,
    available,
    state,
    detail,
    remedy,
    distribution: io.distribution,
  });
  return [
    io.session === "wayland"
      ? capability(
          "keyboard",
          false,
          "unavailable",
          "Wayland keyboard input injection is unsupported.",
          "x11",
        )
      : io.session !== "x11"
        ? capability(
            "keyboard",
            false,
            "unavailable",
            "No X11 desktop session detected.",
            "x11",
          )
        : !installed[0]
          ? capability(
              "keyboard",
              false,
              "unavailable",
              "xdotool is missing.",
              "keyboard-tool",
            )
          : !responding[0]
            ? capability(
                "keyboard",
                false,
                "unavailable",
                "xdotool is installed but the X11 display is not responding.",
                "x11",
              )
            : capability(
                "keyboard",
                true,
                "healthy",
                "X11 display and xdotool respond.",
              ),
    responding[1] || responding[2]
      ? capability(
          "audio",
          true,
          "healthy",
          responding[1]
            ? "PipeWire · wpctl responds."
            : "PulseAudio · pactl responds.",
        )
      : installed[1] || installed[2]
        ? capability(
            "audio",
            false,
            "unavailable",
            "Audio tools are installed but no audio service responds.",
            "audio-service",
          )
        : capability(
            "audio",
            false,
            "unavailable",
            "Neither wpctl nor pactl is installed.",
            "audio-tools",
          ),
    !bus
      ? capability(
          "media",
          false,
          "unavailable",
          "Desktop session D-Bus is unavailable.",
          "desktop-bus",
        )
      : players.length
        ? capability("media", true, "healthy", "MPRIS player available.")
        : capability(
            "media",
            false,
            "idle",
            "Session bus is available; no MPRIS player is running.",
            "media-player",
          ),
  ];
}
export async function installedTool(tool: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    const path = join(directory, tool);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return true;
    } catch {
      /* absent or inaccessible */
    }
  }
  return false;
}
export async function desktopProbe(
  players: () => Promise<string[]>,
): Promise<Capability[]> {
  return probeDesktop({
    session:
      process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland"
        ? "wayland"
        : process.env.XDG_SESSION_TYPE === "x11" || process.env.DISPLAY
          ? "x11"
          : "unknown",
    distribution: distributionFrom(
      await readFile("/etc/os-release", "utf8").catch(() => ""),
    ),
    installed: installedTool,
    responds: async (tool) => {
      try {
        await execa(
          tool,
          tool === "xdotool"
            ? ["getdisplaygeometry"]
            : tool === "wpctl"
              ? ["status"]
              : ["info"],
          { timeout: 2000, shell: false },
        );
        return true;
      } catch {
        return false;
      }
    },
    players,
  });
}
export type AccessProbe = {
  stat(path: string): Promise<{ uid: number; gid: number; mode: number }>;
  readable(path: string): Promise<boolean>;
  writable(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  rules(): Promise<{ path: string; text: string }[]>;
  properties(path: string): Promise<string>;
};
export async function probeDeviceAccess(
  path: string,
  model: string,
  io: AccessProbe,
): Promise<Json> {
  // Observation only: never opens HID, writes rules or changes permissions.
  if (!/^\/dev\/hidraw[\w-]+$/.test(path))
    return {
      path,
      detail: "Permission evidence unavailable for this transport.",
    };
  try {
    const [
      node,
      readable,
      writable,
      passwd,
      groups,
      processStatus,
      rules,
      properties,
    ] = await Promise.all([
      io.stat(path),
      io.readable(path),
      io.writable(path),
      io.read("/etc/passwd"),
      io.read("/etc/group"),
      io.read("/proc/self/status"),
      io.rules(),
      io.properties(path),
    ]);
    const owner =
      passwd
        .split("\n")
        .map((s) => s.split(":"))
        .find((p) => Number(p[2]) === node.uid)?.[0] ?? String(node.uid);
    const group =
      groups
        .split("\n")
        .map((s) => s.split(":"))
        .find((p) => Number(p[2]) === node.gid)?.[0] ?? String(node.gid);
    const gids = (processStatus.match(/^Groups:\s*(.*)$/m)?.[1] ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    const hid = await io.read(
      `/sys/class/hidraw/${path.split("/").pop()}/device/uevent`,
    );
    const usb = hid.match(
      /^HID_ID=[0-9a-f]+:0*([0-9a-f]{4}):0*([0-9a-f]{4})$/im,
    );
    const vendorId = usb?.[1].toLowerCase();
    const productId = usb?.[2].toLowerCase();
    const products = model === "xl" ? ["006c", "008f"] : [];
    const matching =
      model === "xl"
        ? rules
            .filter(
              (r) =>
                /ATTRS\{idVendor\}=="0fd9"/i.test(r.text) &&
                products.some((product) =>
                  r.text
                    .toLowerCase()
                    .includes(`ATTRS{idProduct}=="${product}"`.toLowerCase()),
                ),
            )
            .map((r) => ({
              path: r.path,
              hints: r.text
                .split("\n")
                .filter(
                  (line) =>
                    !line.trim().startsWith("#") &&
                    products.some((product) =>
                      line
                        .toLowerCase()
                        .includes(`idProduct}=="${product}"`.toLowerCase()),
                    ),
                )
                .slice(0, 8),
            }))
        : [];
    const tags = properties
      .split("\n")
      .filter((line) => /^(?:CURRENT_)?TAGS=/.test(line));
    return {
      path,
      owner,
      group,
      mode: (node.mode & 0o777).toString(8).padStart(4, "0"),
      readable,
      writable,
      supplementaryGroupMember: gids.includes(node.gid),
      rules: matching,
      tags,
      vendorId: vendorId ?? null,
      productId: productId ?? null,
      detail:
        "Access is for the Decker process. Seat ACL and desktop-user access must be verified in the actual login session; missing tags alone do not establish a seat failure.",
    };
  } catch {
    return {
      path,
      detail:
        "Permission/ownership evidence unavailable. Inspect device ACL and rules in the desktop session.",
    };
  }
}
export const accessProbe: AccessProbe = {
  stat,
  readable: async (path) => {
    try {
      await access(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  writable: async (path) => {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  read: (path) => readFile(path, "utf8").catch(() => ""),
  rules: async () => {
    const result: { path: string; text: string }[] = [];
    for (const directory of [
      "/usr/lib/udev/rules.d",
      "/run/udev/rules.d",
      "/etc/udev/rules.d",
    ]) {
      const files = await readdir(directory).catch(() => [] as string[]);
      for (const name of files
        .filter((f) => f.endsWith(".rules"))
        .sort()
        .slice(0, 256)) {
        const path = join(directory, name);
        result.push({
          path,
          text: (await readFile(path, "utf8").catch(() => "")).slice(0, 65536),
        });
      }
    }
    return result;
  },
  properties: async (path) => {
    try {
      return (
        await execa("udevadm", ["info", "--query=property", "--name", path], {
          timeout: 2000,
          shell: false,
        })
      ).stdout;
    } catch {
      return "";
    }
  },
};
