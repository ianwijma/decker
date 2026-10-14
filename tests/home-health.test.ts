import { describe, expect, it } from "vitest";
import { defaults, binding, node } from "../src/shared/defaults";
import { buildHealth } from "../src/shared/health";
import {
  deckReadiness,
  discoverDevices,
  homeHealth,
} from "../src/renderer/src/home-health";
import type { DeviceStatus, Snapshot } from "../src/shared/schema";

function snapshot(): Snapshot {
  return {
    document: defaults(),
    devices: [],
    runs: [],
    capabilities: [],
    observed: {},
    secureStorage: false,
    web: { running: false, port: 9018, urls: [], clients: [], pending: [] },
  };
}
function device(id: string, patch: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    id,
    name: "Stream Deck XL",
    present: true,
    configured: false,
    connected: false,
    state: "discovered",
    simulated: false,
    rows: 4,
    columns: 8,
    iconSize: 96,
    updatedAt: 1,
    ...patch,
  };
}
describe("Home health presentation", () => {
  it("keeps optional integrations informational in an empty workspace", () => {
    const s = snapshot();
    s.document.decks = [];
    s.document.profiles = [];
    s.document.workflows = [];
    s.capabilities = [
      {
        id: "keyboard",
        available: false,
        detail: "Missing tool",
        state: "unavailable",
        remedy: "keyboard-tool",
      },
      {
        id: "media",
        available: false,
        detail: "No player",
        state: "idle",
        remedy: "media-player",
      },
    ];
    expect(homeHealth(s).warningCount).toBe(0);
    expect(homeHealth(s).records).toEqual(buildHealth(s));
  });
  it("preserves authoritative records and reports independent configured faults", () => {
    const s = snapshot();
    s.health = [
      {
        id: "fault:render",
        feature: "Display",
        state: "degraded",
        cause: "Write failed",
        remedy: "recheck",
      },
      {
        id: "obs:studio",
        feature: "Studio",
        state: "unavailable",
        cause: "Connection refused",
        remedy: "obs-connect",
      },
    ];
    expect(homeHealth(s).records).toBe(s.health);
    expect(homeHealth(s).warningCount).toBe(2);
  });
  it("recognizes configured tools in release, sequences and nested workflow graphs", () => {
    const s = snapshot();
    const key = binding("desktop.copy");
    key.release = {
      kind: "sequence",
      actions: [{ type: "keyboard.type", version: 1, config: {} }],
    };
    s.document.profiles[0].pages[0].keys[0] = key;
    const repeat = node("repeat", "Nested");
    repeat.body = {
      entry: "audio",
      edges: [],
      nodes: [
        {
          ...node("action", "Audio"),
          id: "audio",
          action: { type: "audio.control", version: 1, config: {} },
        },
      ],
    };
    s.document.workflows[0].graph.nodes.push(repeat);
    s.capabilities = ["keyboard", "audio"].map((id) => ({
      id,
      available: false,
      detail: "Unavailable",
    }));
    expect(homeHealth(s).warningCount).toBe(2);
  });
  it("uses the device contract for readiness, disconnected and permission-denied recovery", () => {
    const s = snapshot(),
      deck = s.document.decks[0];
    deck.kind = "hardware";
    deck.hardwareId = "xl:SERIAL";
    expect(deckReadiness(s, deck)).toEqual({
      label: "Disconnected",
      ready: false,
    });
    expect(homeHealth(s).warningCount).toBe(1);
    s.devices = [
      device("xl:SERIAL", {
        configured: true,
        state: "permission-denied",
        errorDetails: {
          at: 1,
          stage: "open",
          code: "EACCES",
          message: "Permission denied",
        },
      }),
    ];
    expect(deckReadiness(s, deck)).toEqual({
      label: "Permission required",
      ready: false,
    });
    expect(homeHealth(s).warnings[0]).toMatchObject({
      remedy: "device-permission",
      cause: expect.stringContaining("Permission denied"),
    });
    s.devices[0] = device("xl:SERIAL", {
      configured: true,
      state: "ready",
      connected: true,
    });
    expect(deckReadiness(s, deck).ready).toBe(true);
    expect(homeHealth(s).warningCount).toBe(0);
    s.devices[0] = device("xl:SERIAL", {
      configured: true,
      state: "disconnected",
      present: false,
    });
    expect(homeHealth(s).warnings[0].remedy).toBe("device-connect");
  });
  it("keeps server availability, browser presence and simulator availability independent", () => {
    const s = snapshot(),
      deck = s.document.decks[0];
    expect(deckReadiness(s, deck).label).toBe("Simulator available");
    deck.kind = "web";
    s.web.running = true;
    expect(deckReadiness(s, deck)).toEqual({
      label: "No browser connected",
      ready: false,
    });
    s.web.clients = [
      {
        id: "client",
        name: "Phone",
        deckId: deck.id,
        online: true,
        createdAt: 1,
        lastSeen: 1,
      },
    ];
    expect(deckReadiness(s, deck)).toEqual({
      label: "1 browser connected",
      ready: true,
    });
  });
});
describe("Stream Deck discovery", () => {
  it("deduplicates stable serial identity across updated enumeration and handles multiple devices", () => {
    const s = snapshot();
    s.devices = [
      device("xl:A"),
      device("xl:A", { updatedAt: 2, name: "Re-enumerated XL" }),
      device("xl:B"),
    ];
    expect(discoverDevices(s).map((d) => [d.id, d.name])).toEqual([
      ["xl:A", "Re-enumerated XL"],
      ["xl:B", "Stream Deck XL"],
    ]);
    s.document.decks[0].hardwareId = "xl:A";
    expect(discoverDevices(s).map((d) => d.id)).toEqual(["xl:B"]);
    s.devices.push(
      device("xl:B", { updatedAt: 3, present: false, state: "disconnected" }),
    );
    expect(discoverDevices(s)).toEqual([]);
  });
  it("excludes simulators and configured hardware but leaves session identity explanatory", () => {
    const s = snapshot();
    s.devices = [
      device("sim", { simulated: true }),
      device("xl:A", { configured: true }),
      device("session:no-serial"),
    ];
    expect(discoverDevices(s).map((d) => d.id)).toEqual(["session:no-serial"]);
  });
});
