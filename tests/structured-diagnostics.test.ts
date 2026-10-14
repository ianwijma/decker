import { describe, it, expect, vi } from "vitest";
import { defaults } from "../src/shared/defaults";
import {
  buildHealth,
  obsCapability,
  DiagnosticFaults,
  redactDiagnostics,
  remedyFor,
  type HealthRecord,
  type RemedyId,
} from "../src/shared/health";
import {
  distributionFrom,
  probeDesktop,
  probeDeviceAccess,
  type AccessProbe,
  type DesktopProbe,
} from "../src/adapters/linux/diagnostics";
import {
  requestSchema,
  type DeviceStatus,
  type Snapshot,
} from "../src/shared/schema";
const hardware: DeviceStatus = {
  id: "xl:TEST-SERIAL",
  name: "Test XL",
  connected: false,
  present: true,
  configured: true,
  state: "permission-denied",
  updatedAt: 1,
  simulated: false,
  rows: 4,
  columns: 8,
  iconSize: 96,
  errorDetails: {
    stage: "open",
    code: "EACCES",
    errno: 13,
    message: "Permission denied",
    at: 1,
  },
};
const fixture = (): Snapshot => ({
  document: defaults(),
  runs: [],
  devices: [structuredClone(hardware)],
  capabilities: [],
  observed: {},
  secureStorage: false,
  web: { running: false, port: 0, urls: [], clients: [], pending: [] },
});
const desktop = (patch: Partial<DesktopProbe> = {}): DesktopProbe => ({
  session: "x11",
  distribution: "pop",
  installed: async () => true,
  responds: async () => true,
  players: async () => ["org.mpris.MediaPlayer2.test"],
  ...patch,
});
describe("desktop capability causes", () => {
  it("distinguishes missing tools, stopped services, an empty bus and unavailable bus", async () => {
    const missing = await probeDesktop(
      desktop({ installed: async () => false, players: async () => [] }),
    );
    expect(missing.map((c) => [c.id, c.state, c.remedy])).toEqual([
      ["keyboard", "unavailable", "keyboard-tool"],
      ["audio", "unavailable", "audio-tools"],
      ["media", "idle", "media-player"],
    ]);
    const stopped = await probeDesktop(
      desktop({
        responds: async () => false,
        players: async () => {
          throw new Error("no bus");
        },
      }),
    );
    expect(stopped.map((c) => c.remedy)).toEqual([
      "x11",
      "audio-service",
      "desktop-bus",
    ]);
    expect(
      remedyFor({
        id: "audio",
        feature: "audio",
        state: "unavailable",
        cause: "stopped",
        remedy: stopped[1].remedy,
      })?.copy,
    ).toBeUndefined();
  });
  it("distinguishes unsupported Wayland and no desktop without blaming packages", async () => {
    expect(
      (await probeDesktop(desktop({ session: "wayland" })))[0],
    ).toMatchObject({ available: false, remedy: "x11" });
    expect(
      (await probeDesktop(desktop({ session: "unknown" })))[0].detail,
    ).toContain("No X11");
    expect(
      (await probeDesktop(desktop())).every((c) => c.state === "healthy"),
    ).toBe(true);
    expect(
      (
        await probeDesktop(
          desktop({ responds: async (tool) => tool === "pactl" }),
        )
      )[1],
    ).toMatchObject({ available: true, state: "healthy" });
  });
  it("parses known distribution families without executing os-release", () => {
    expect(distributionFrom('ID=pop\nID_LIKE="ubuntu debian"')).toBe("pop");
    expect(distributionFrom('ID=mint\nID_LIKE="ubuntu debian"')).toBe("ubuntu");
    expect(distributionFrom('ID="$(touch /tmp/never)"')).toBe("unknown");
    expect(distributionFrom("")).toBe("unknown");
    for (const distribution of ["pop", "debian", "ubuntu", "fedora", "arch"]) {
      const record: HealthRecord = {
        id: "keyboard",
        feature: "Keyboard",
        state: "unavailable",
        cause: "Missing",
        remedy: "keyboard-tool",
        distribution,
      };
      expect(remedyFor(record)?.copy).toMatch(/^sudo (apt|dnf|pacman)/);
      expect(
        remedyFor({ ...record, remedy: "audio-tools" })?.copy,
      ).toBeTruthy();
    }
    expect(
      remedyFor({
        id: "x",
        feature: "x",
        state: "unavailable",
        cause: "x",
        remedy: "keyboard-tool",
        distribution: "unknown",
      })?.copy,
    ).toBeUndefined();
  });
});
describe("health and safe remediation", () => {
  it("retains simultaneous device and integration failures, clearing only recovered records", () => {
    const input = fixture();
    input.document.connections = [
      { id: "obs-a", name: "Studio A", url: "ws://localhost:4455" },
      { id: "obs-b", name: "Studio B", url: "ws://localhost:4456" },
    ];
    input.observed = {
      "obs:obs-a": { connected: false, error: "connection refused" },
      "obs:obs-b": { connected: false, error: "authentication failed" },
    };
    expect(
      buildHealth(input)
        .filter((r) => r.state === "unavailable")
        .map((r) => r.id),
    ).toEqual(["obs:obs-a", "obs:obs-b", "device:xl:TEST-SERIAL"]);
    input.observed["obs:obs-a"] = { connected: true };
    input.devices[0] = {
      ...hardware,
      state: "ready",
      connected: true,
      errorDetails: undefined,
    };
    const recovered = buildHealth(input);
    expect(
      recovered.filter((r) => r.state === "unavailable").map((r) => r.id),
    ).toEqual(["obs:obs-b"]);
    expect(JSON.stringify(recovered)).not.toContain("connection refused");
    expect(JSON.stringify(recovered)).not.toContain("Permission denied");
    expect(obsCapability(input)).toMatchObject({
      available: true,
      state: "degraded",
    });
    input.document.connections = [];
    expect(
      buildHealth(input)
        .filter((r) => r.id.startsWith("obs"))
        .map((r) => r.state),
    ).toEqual(["unconfigured"]);
  });
  it("models device lifecycle evidence honestly without loading any HID driver", () => {
    const input = fixture();
    const cases = [
      ["disconnected", "unavailable", "device-connect"],
      ["busy", "unavailable", "device-busy"],
      ["open-error", "unavailable", "device-io"],
      ["io-error", "degraded", "device-io"],
      ["opening", "idle", undefined],
      ["ready", "healthy", undefined],
    ] as const;
    for (const [state, health, remedy] of cases) {
      input.devices[0] = {
        ...hardware,
        state,
        connected: state === "ready",
        errorDetails: undefined,
      };
      expect(
        buildHealth(input).find((r) => r.hardwareId === hardware.id),
      ).toMatchObject({ state: health, remedy });
    }
    input.devices[0] = { ...hardware, configured: false, state: "discovered" };
    expect(
      buildHealth(input).find((r) => r.hardwareId === hardware.id),
    ).toMatchObject({ state: "unconfigured", remedy: "device-config" });
    input.observed.hardwareNativeReady = false;
    expect(
      buildHealth(input).find((r) => r.id === "hardware-native")?.remedy,
    ).toBe("native-driver");
    input.devices[0] = {
      ...hardware,
      state: "io-error",
      errorDetails: { stage: "discovery", message: "native missing", at: 1 },
    };
    expect(
      buildHealth(input).filter((r) => r.id.startsWith("device:")).length,
    ).toBe(0);
    input.observed.hardwareNativeReady = true;
    input.devices[0] = { ...hardware, state: "ready", errorDetails: undefined };
    expect(buildHealth(input).some((r) => r.id === "hardware-native")).toBe(
      false,
    );
  });
  it("has guidance for every remedy category and never interpolates error/path/serial text", () => {
    const remedies: RemedyId[] = [
      "keyboard-tool",
      "audio-tools",
      "audio-service",
      "x11",
      "desktop-bus",
      "media-player",
      "obs-config",
      "obs-connect",
      "device-permission",
      "device-busy",
      "device-connect",
      "device-config",
      "device-io",
      "native-driver",
      "recheck",
    ];
    for (const remedy of remedies)
      expect(
        remedyFor({
          id: "test",
          feature: "test",
          state: "unavailable",
          cause: "$(touch /tmp/never)",
          remedy,
          distribution: "pop",
        })?.text,
      ).toBeTruthy();
    const record: HealthRecord = {
      id: "test",
      feature: "test",
      state: "unavailable",
      cause: "$(touch /tmp/never)",
      remedy: "device-permission",
      hardwareId: "xl:$(touch /tmp/never)",
      evidence: { access: { vendorId: "0fd9", productId: "006c" } },
    };
    expect(remedyFor(record)?.copy).toBe(
      'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", ATTRS{idProduct}=="006c", TAG+="uaccess"',
    );
    expect(
      remedyFor({ ...record, hardwareId: "unknown:TEST-SERIAL" })?.copy,
    ).toBeUndefined();
    expect(
      remedyFor({ ...record, hardwareId: "constructor:TEST-SERIAL" })?.copy,
    ).toBeUndefined();
    expect(remedyFor({ ...record, evidence: undefined })?.copy).toContain(
      'idProduct}=="008f"',
    );
    expect(
      requestSchema.safeParse({
        type: "diagnosticRemedy",
        healthId: "test",
        action: "execute",
        command: "arbitrary",
      }).success,
    ).toBe(false);
    expect(
      requestSchema.parse({
        type: "diagnosticRemedy",
        healthId: "test",
        action: "copy",
        command: "arbitrary",
      }),
    ).not.toHaveProperty("command");
  });
  it("bounds repeated faults and clears the appropriate source", () => {
    const faults = new DiagnosticFaults();
    for (let i = 0; i < 1100; i++)
      faults.set("runner", "Runtime", "failed", [], i);
    faults.set("storage", "Workspace storage", "disk full");
    expect(faults.snapshot().runner).toMatchObject({
      count: 999,
      firstAt: 0,
      lastAt: 1099,
    });
    faults.clear("runner");
    expect(Object.keys(faults.snapshot())).toEqual(["storage"]);
    for (let i = 0; i < 100; i++) faults.set(String(i), "test", "error");
    expect(Object.keys(faults.snapshot())).toHaveLength(32);
    faults.set("99", "test", "different");
    expect(faults.snapshot()["99"]).toMatchObject({ count: 1 });
  });
  it("redacts secrets in summaries and raw details, including credentials in URLs", () => {
    const value = {
      error:
        "failed sensitive ws://user:pass@host:4455/?token=abc Authorization: Bearer hidden password=other",
      password: "123",
      nested: { header: "Basic encoded", "sensitive key": "value" },
    };
    const output = JSON.stringify(redactDiagnostics(value, ["sensitive"]));
    for (const secret of [
      "sensitive",
      "user:pass",
      "abc",
      "hidden",
      "other",
      "123",
      "encoded",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("redacted");
    expect(
      String(redactDiagnostics("x".repeat(100000))).length,
    ).toBeLessThanOrEqual(4096);
  });
});
it("explains captured XL root:plugdev 0660 evidence and tolerates absent permission data", async () => {
  const io: AccessProbe = {
    stat: vi.fn(async () => ({ uid: 0, gid: 46, mode: 0o660 })),
    readable: async () => false,
    writable: async () => false,
    read: async (path) =>
      path.startsWith("/sys/")
        ? "HID_ID=0003:00000FD9:0000006C\n"
        : path === "/etc/passwd"
          ? "root:x:0:0:root:/root:/bin/bash"
          : path === "/etc/group"
            ? "plugdev:x:46:"
            : "Groups:\t1000 27\n",
    rules: async () => [
      {
        path: "/etc/udev/rules.d/50-elgato-stream-deck-headless.rules",
        text: 'KERNEL=="hidraw*", ATTRS{idVendor}=="0fd9", ATTRS{idProduct}=="006c", MODE:="660", GROUP="plugdev"',
      },
    ],
    properties: async () => "DEVNAME=/dev/hidraw-test\n",
  };
  const evidence = await probeDeviceAccess("/dev/hidraw-test", "xl", io);
  expect(evidence).toMatchObject({
    owner: "root",
    group: "plugdev",
    mode: "0660",
    readable: false,
    writable: false,
    supplementaryGroupMember: false,
    tags: [],
    rules: [{ path: "/etc/udev/rules.d/50-elgato-stream-deck-headless.rules" }],
  });
  const input = fixture();
  input.observed.hardwareAccess = { [hardware.id]: evidence };
  expect(
    buildHealth(input).find((r) => r.hardwareId === hardware.id)?.evidence,
  ).toMatchObject({ access: { group: "plugdev", writable: false } });
  expect(
    buildHealth(input).find((r) => r.hardwareId === hardware.id)?.cause,
  ).toContain("root:plugdev, mode 0660");
  expect(
    remedyFor(buildHealth(input).find((r) => r.hardwareId === hardware.id)!)
      ?.copy,
  ).toBe(
    'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", ATTRS{idProduct}=="006c", TAG+="uaccess"',
  );
  expect(
    await probeDeviceAccess("/dev/hidraw-changed", "xl", {
      ...io,
      stat: async () => {
        throw new Error("missing");
      },
    }),
  ).toMatchObject({ detail: expect.stringContaining("unavailable") });
  await probeDeviceAccess("$(touch /tmp/never)", "xl", io);
  expect(io.stat).toHaveBeenCalledTimes(1);
});
