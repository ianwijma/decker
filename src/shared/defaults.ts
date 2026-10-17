import {
  documentSchema,
  type AppDocument,
  type FlowNode,
  type KeyBinding,
} from "./schema";
import { makeAction } from "./catalog";
export const uid = () => crypto.randomUUID();
export function node(kind: FlowNode["kind"], name: string): FlowNode {
  return {
    id: uid(),
    name,
    kind,
    config: {},
    timeoutMs: 30000,
    retries: 0,
    retrySafe: false,
  };
}
export function binding(type: string, label?: string): KeyBinding {
  return {
    id: uid(),
    generation: 0,
    appearance: {
      label: label ?? type,
      icon: "",
      background: "#232428",
      running: "#5865f2",
      success: "#23a559",
      error: "#f23f42",
    },
    press: { kind: "action", action: makeAction(type) },
    policy: "ignore",
    limit: 4,
    longPressMs: 600,
  };
}
export function defaults(): AppDocument {
  const trigger = node("trigger", "Software or deck press"),
    delay = node("delay", "Take a breath"),
    done = node("set", "Ready"),
    welcomeId = uid();
  delay.config = { ms: 400 };
  done.config = { status: "Ready to create" };
  return documentSchema.parse({
    schemaVersion: 6,
    schedules: [],
    workflowAliases: {},
    profiles: [
      {
        id: "default",
        name: "My workspace",
        pages: [
          {
            id: "home",
            name: "Home",
            keys: {
              0: binding("desktop.open", "Open browser"),
              1: binding("desktop.copy", "Copy greeting"),
              2: {
                ...binding("desktop.notify", "Welcome flow"),
                press: { kind: "workflow", workflowId: welcomeId },
              },
              7: binding("deck.back", "Back"),
            },
          },
        ],
      },
    ],
    workflows: [
      {
        id: welcomeId,
        name: "Welcome to Decker",
        revision: 1,
        graph: {
          entry: trigger.id,
          nodes: [trigger, delay, done],
          edges: [
            { id: uid(), source: trigger.id, target: delay.id, port: "next" },
            { id: uid(), source: delay.id, target: done.id, port: "next" },
          ],
        },
        layout: {
          [trigger.id]: { x: 60, y: 160 },
          [delay.id]: { x: 330, y: 160 },
          [done.id]: { x: 600, y: 160 },
        },
        inputs: [],
        outputs: [],
        timeoutMs: 300000,
      },
    ],
    connections: [],
    decks: [
      {
        id: "simulator-xl",
        name: "My XL",
        kind: "simulator",
        icon: "▦",
        rows: 4,
        columns: 8,
        brightness: 70,
        profileIds: ["default"],
        activeProfileId: "default",
        activePageId: "home",
      },
    ],
    activeDeckId: "simulator-xl",
    settings: {
      accent: "#5865f2",
      startHidden: false,
      launchAtLogin: false,
      closeToTray: true,
      webEnabled: false,
      webPort: 9018,
      historyLimit: 200,
    },
  });
}
