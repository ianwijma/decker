import { buildHealth } from "../../shared/health";
import type { HealthRecord } from "../../shared/health";
import { deviceStatusLabel } from "../../shared/device-status";
import type { DeckConfig, Graph, Snapshot, Target } from "../../shared/schema";

// Device IDs already carry the driver's serial-derived identity. Never use an
// enumeration path as identity or promote a session ID to a persistent ID.
export function discoverDevices(snapshot: Snapshot) {
  const devices = new Map<string, Snapshot["devices"][number]>();
  for (const device of snapshot.devices) {
    const previous = devices.get(device.id);
    if (!previous || previous.updatedAt <= device.updatedAt)
      devices.set(device.id, device);
  }
  return [...devices.values()].filter(
    (device) =>
      !device.simulated &&
      device.present &&
      !device.configured &&
      !snapshot.document.decks.some((deck) => deck.hardwareId === device.id),
  );
}

export function deckReadiness(snapshot: Snapshot, deck: DeckConfig) {
  if (deck.kind === "simulator")
    return { label: "Simulator available", ready: true };
  if (deck.kind === "web") {
    const online = snapshot.web.clients.filter(
      (client) => client.deckId === deck.id && client.online,
    ).length;
    return {
      label: online
        ? `${online} browser${online === 1 ? "" : "s"} connected`
        : "No browser connected",
      ready: online > 0,
    };
  }
  const device = snapshot.devices.find((d) => d.id === deck.hardwareId);
  return { label: deviceStatusLabel(device), ready: device?.state === "ready" };
}

export function homeHealth(snapshot: Snapshot) {
  const records = snapshot.health ?? buildHealth(snapshot);
  const actions = new Set<string>();
  const targetActions = (target?: Target) => {
    if (target?.kind === "action") actions.add(target.action.type);
    if (target?.kind === "sequence")
      target.actions.forEach((action) => actions.add(action.type));
  };
  for (const profile of snapshot.document.profiles)
    for (const page of profile.pages)
      for (const key of Object.values(page.keys)) {
        targetActions(key.press);
        targetActions(key.release);
        targetActions(key.longPress);
      }
  const graphActions = (graph: Graph) => {
    for (const node of graph.nodes) {
      if (node.action) actions.add(node.action.type);
      if (node.body) graphActions(node.body);
      node.branches?.forEach(graphActions);
    }
  };
  snapshot.document.workflows.forEach((workflow) =>
    graphActions(workflow.graph),
  );
  const uses = (prefix: string) =>
    [...actions].some((type) => type.startsWith(prefix));
  const relevant = (record: HealthRecord) => {
    if (record.id.startsWith("capability:"))
      return uses(`${record.id.slice("capability:".length)}.`);
    if (record.id === "obs") return uses("obs.");
    if (record.id === "hardware-native")
      return snapshot.document.decks.some((deck) => deck.kind === "hardware");
    if (record.id === "web")
      return (
        snapshot.document.settings.webEnabled ||
        snapshot.document.decks.some((deck) => deck.kind === "web")
      );
    return true;
  };
  const warnings = records.filter(
    (record) =>
      relevant(record) &&
      (record.state === "degraded" ||
        record.state === "unavailable" ||
        (record.state === "unconfigured" && record.id === "obs")),
  );
  // Configured hardware can be absent from an older snapshot's device list.
  const missingDecks = snapshot.document.decks.filter(
    (deck) =>
      deck.kind === "hardware" &&
      !snapshot.devices.some((device) => device.id === deck.hardwareId),
  );
  return {
    records,
    warnings,
    warningCount: warnings.length + missingDecks.length,
  };
}
