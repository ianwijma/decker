import type { Capability, DeviceStatus, Json, Snapshot } from "./schema";
import { deviceStatusLabel } from "./device-status";
import { redact } from "../runtime/data";

export type HealthState =
  "healthy" | "idle" | "unconfigured" | "degraded" | "unavailable";
export type RemedyId =
  | "keyboard-tool"
  | "audio-tools"
  | "audio-service"
  | "x11"
  | "desktop-bus"
  | "media-player"
  | "obs-config"
  | "obs-connect"
  | "device-permission"
  | "device-busy"
  | "device-connect"
  | "device-config"
  | "device-io"
  | "native-driver"
  | "recheck";
export type HealthRecord = {
  id: string;
  feature: string;
  state: HealthState;
  cause: string;
  remedy?: RemedyId;
  hardwareId?: string;
  distribution?: string;
  evidence?: Json;
};
export type Remedy = { text: string; copy?: string; url?: string };
const driverDocs =
  "https://github.com/Julusian/node-elgato-stream-deck/blob/master/packages/node/README.md";
const installCommands: Record<string, { keyboard: string; audio: string }> = {
  debian: {
    keyboard: "sudo apt install xdotool",
    audio: "sudo apt install wireplumber pulseaudio-utils",
  },
  ubuntu: {
    keyboard: "sudo apt install xdotool",
    audio: "sudo apt install wireplumber pulseaudio-utils",
  },
  pop: {
    keyboard: "sudo apt install xdotool",
    audio: "sudo apt install wireplumber pulseaudio-utils",
  },
  fedora: {
    keyboard: "sudo dnf install xdotool",
    audio: "sudo dnf install wireplumber pulseaudio-utils",
  },
  arch: {
    keyboard: "sudo pacman -S xdotool",
    audio: "sudo pacman -S wireplumber libpulse",
  },
};
// Only known USB models produce rule text. Neither paths, serials nor error text
// can become a command, URL or rule. Suggestions are copied, never executed.
const productIds: Record<string, string[]> = { xl: ["006c", "008f"] };
export function remedyFor(record: HealthRecord): Remedy | undefined {
  switch (record.remedy) {
    case "keyboard-tool":
    case "audio-tools": {
      const distribution = record.distribution ?? "";
      const copy = Object.hasOwn(installCommands, distribution)
        ? installCommands[distribution][
            record.remedy === "keyboard-tool" ? "keyboard" : "audio"
          ]
        : undefined;
      return {
        text: copy
          ? "Review this package command in your terminal, then Retry."
          : "Use your distribution’s package documentation to install xdotool (keyboard) or wpctl/pactl (audio), then Retry. No package command is available for this distribution.",
        copy,
        url: "https://github.com/ianwijma/decker#linux-integrations",
      };
    }
    case "audio-service":
      return {
        text: "The audio tools are installed. Start or repair your desktop’s PipeWire/WirePlumber or PulseAudio service, then Retry. Check your distribution’s audio service documentation.",
      };
    case "x11":
      return {
        text: "Sign into an X11 desktop session to use keyboard actions, then Retry. Wayland input injection is unsupported.",
      };
    case "desktop-bus":
      return {
        text: "Run Decker in your logged-in desktop session with its session D-Bus available, then Retry.",
      };
    case "media-player":
      return {
        text: "Start a media player that supports MPRIS in this desktop session, then Retry.",
      };
    case "obs-config":
      return {
        text: "Add an OBS connection in Settings → General and enable Tools → WebSocket Server Settings in OBS, then Retry.",
      };
    case "obs-connect":
      return {
        text: "Start OBS, enable its WebSocket server and check the configured address and credential reference, then Retry. A failed connection does not establish that OBS is missing.",
      };
    case "device-permission": {
      const model = record.hardwareId?.split(":")[0] ?? "";
      const allowed = Object.hasOwn(productIds, model)
        ? productIds[model]
        : undefined;
      const access = (
        record.evidence as { access?: { productId?: string } } | undefined
      )?.access;
      const products =
        access?.productId && allowed?.includes(access.productId)
          ? [access.productId]
          : allowed;
      return {
        text: "Discovery does not establish HID access. Inspect the desktop login session, device ownership, ACL and existing rule ordering. Preserve third-party rules. For a desktop session, place a model-scoped uaccess rule before the system seat ACL rule (for example /etc/udev/rules.d/50-decker-xl.rules), reload rules with sudo udevadm control --reload-rules, reconnect the deck and verify the desktop user’s ACL and read/write access. Do not run Decker as root or grant access to all HID devices. A dedicated group is a separate headless setup.",
        copy: products
          ?.map(
            (product) =>
              `SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", ATTRS{idProduct}=="${product}", TAG+="uaccess"`,
          )
          .join("\n"),
        url: driverDocs,
      };
    }
    case "device-busy":
      return {
        text: "Close other applications that may own this deck, then Retry.",
      };
    case "device-connect":
      return {
        text: "Reconnect the configured deck and check its USB cable, then Retry. Its saved serial identity is retained.",
      };
    case "device-config":
      return {
        text: "Assign this discovered device to a hardware deck in the deck settings, then Retry.",
      };
    case "device-io":
      return {
        text: "Check the USB connection and device-specific error below, then Retry. Successful driver writes still require physical display and input verification.",
        url: driverDocs,
      };
    case "native-driver":
      return {
        text: "Restart Decker after repairing or reinstalling its packaged native driver dependencies. Review the driver’s Linux setup documentation; Retry rechecks discovery.",
        url: driverDocs,
      };
    case "recheck":
      return {
        text: "Review the details below, correct the affected feature’s configuration or restart its service, then Retry.",
      };
  }
}
export function redactDiagnostics(
  value: unknown,
  secrets: string[] = [],
): Json {
  const scrub = (v: Json): Json => {
    if (typeof v === "string") {
      let text = v;
      for (const secret of secrets.filter(Boolean))
        text = text.split(secret).join("[redacted]");
      return text
        .replace(
          /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,
          "$1[redacted]@",
        )
        .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
        .replace(
          /((?:password|token|secret|api[_-]?key|authorization|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
          "$1[redacted]",
        );
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [String(scrub(k)), scrub(x)]),
      );
    return v;
  };
  return scrub(redact(value, secrets));
}
export type Fault = {
  feature: string;
  message: string;
  firstAt: number;
  lastAt: number;
  count: number;
};
export class DiagnosticFaults {
  private records = new Map<string, Fault>();
  set(
    id: string,
    feature: string,
    error: unknown,
    secrets: string[] = [],
    now = Date.now(),
  ) {
    const message = String(
      redactDiagnostics(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
    );
    const old = this.records.get(id);
    this.records.delete(id);
    this.records.set(id, {
      feature,
      message,
      firstAt: old?.message === message ? old.firstAt : now,
      lastAt: now,
      count: old?.message === message ? Math.min(999, old.count + 1) : 1,
    });
    while (this.records.size > 32)
      this.records.delete(this.records.keys().next().value!);
  }
  clear(id: string) {
    this.records.delete(id);
  }
  snapshot(): Record<string, Json> {
    return Object.fromEntries(
      [...this.records].map(([id, record]) => [id, { ...record }]),
    );
  }
}
function deviceHealth(device: DeviceStatus, evidence?: Json): HealthRecord {
  const state: HealthState = !device.configured
    ? "unconfigured"
    : device.state === "ready"
      ? "healthy"
      : ["discovered", "opening"].includes(device.state)
        ? "idle"
        : device.state === "io-error"
          ? "degraded"
          : "unavailable";
  const remedies: Partial<Record<DeviceStatus["state"], RemedyId>> = {
    "permission-denied": "device-permission",
    busy: "device-busy",
    disconnected: "device-connect",
    "open-error": "device-io",
    "io-error": "device-io",
  };
  const access = evidence as
    | {
        owner?: string;
        group?: string;
        mode?: string;
        readable?: boolean;
        writable?: boolean;
        rules?: { path: string }[];
      }
    | undefined;
  const detail = device.errorDetails?.message;
  const permission =
    device.state === "permission-denied"
      ? "The deck was discovered, but this process cannot open its HID interface."
      : "";
  const ownership = access?.mode
    ? `HID ownership: ${access.owner}:${access.group}, mode ${access.mode}; process read access: ${access.readable ? "yes" : "no"}, write access: ${access.writable ? "yes" : "no"}.`
    : "";
  const rules = access?.rules?.length
    ? `Detected model rules: ${access.rules.map((rule) => rule.path).join(", ")}.`
    : "";
  return {
    id: `device:${device.id}`,
    feature: device.name,
    state,
    cause: [deviceStatusLabel(device), detail, permission, ownership, rules]
      .filter(Boolean)
      .join(" · "),
    remedy: !device.configured ? "device-config" : remedies[device.state],
    hardwareId: device.simulated ? undefined : device.id,
    evidence: { status: redactDiagnostics(device), access: evidence ?? null },
  };
}
export function buildHealth(
  input: Pick<
    Snapshot,
    "document" | "devices" | "capabilities" | "observed" | "web"
  >,
): HealthRecord[] {
  const records: HealthRecord[] = input.capabilities
    .filter((c) => c.id !== "obs")
    .map((c: Capability) => ({
      id: `capability:${c.id}`,
      feature:
        c.id === "keyboard"
          ? "Keyboard input"
          : c.id === "audio"
            ? "Audio controls"
            : "Media controls",
      state: c.state ?? (c.available ? "healthy" : "unavailable"),
      cause: c.detail,
      remedy: c.remedy,
      distribution: c.distribution,
    }));
  if (!input.document.connections.length)
    records.push({
      id: "obs",
      feature: "OBS",
      state: "unconfigured",
      cause: "No OBS WebSocket connection configured.",
      remedy: "obs-config",
    });
  for (const connection of input.document.connections) {
    const value = input.observed[`obs:${connection.id}`] as
      { connected?: boolean; error?: string } | undefined;
    records.push({
      id: `obs:${connection.id}`,
      feature: `OBS · ${connection.name}`,
      state: value?.connected ? "healthy" : "unavailable",
      cause: value?.connected
        ? "WebSocket connected."
        : value?.error || "The configured OBS WebSocket is not connected.",
      remedy: value?.connected ? undefined : "obs-connect",
      evidence: value
        ? redactDiagnostics(
            value.connected
              ? Object.fromEntries(
                  Object.entries(value).filter(([key]) => key !== "error"),
                )
              : value,
          )
        : null,
    });
  }
  const access = input.observed.hardwareAccess as
    Record<string, Json> | undefined;
  records.push(
    ...input.devices
      .filter(
        (d) =>
          !(
            input.observed.hardwareNativeReady === false &&
            d.errorDetails?.stage === "discovery"
          ),
      )
      .map((d) => deviceHealth(d, access?.[d.id])),
  );
  if (input.observed.hardwareNativeReady === false)
    records.push({
      id: "hardware-native",
      feature: "Hardware driver",
      state: "unavailable",
      cause: String(
        input.observed.hardwareNativeError ||
          "Native device driver is unavailable; device readiness cannot be established.",
      ),
      remedy: "native-driver",
      evidence: {
        affectedDevices: input.devices
          .filter((d) => d.errorDetails?.stage === "discovery")
          .map((d) => d.name),
      },
    });
  if (input.web.error)
    records.push({
      id: "web",
      feature: "Web decks",
      state: "unavailable",
      cause: input.web.error,
      remedy: "recheck",
    });
  const faults = input.observed.diagnostics as
    Record<string, Fault> | undefined;
  for (const [id, fault] of Object.entries(faults ?? {}))
    records.push({
      id: `fault:${id}`,
      feature: fault.feature,
      state: "degraded",
      cause: fault.message,
      remedy: "recheck",
      evidence: { ...fault },
    });
  return records.map((record) => ({
    ...record,
    feature: String(redactDiagnostics(record.feature)),
    cause: String(redactDiagnostics(record.cause)),
  }));
}

export function obsCapability(
  input: Pick<Snapshot, "document" | "observed">,
): Capability {
  const connections = input.document.connections;
  const connected = connections.filter(
    (c) =>
      (input.observed[`obs:${c.id}`] as { connected?: boolean } | undefined)
        ?.connected,
  ).length;
  return {
    id: "obs",
    available: connected > 0,
    state: !connections.length
      ? "unconfigured"
      : connected === connections.length
        ? "healthy"
        : connected
          ? "degraded"
          : "unavailable",
    detail: !connections.length
      ? "No OBS WebSocket connection configured."
      : `${connected} of ${connections.length} OBS connections respond.`,
    remedy: !connections.length
      ? "obs-config"
      : connected === connections.length
        ? undefined
        : "obs-connect",
  };
}
