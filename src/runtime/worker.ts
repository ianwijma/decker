import { z } from "zod";
import { Engine, type ActionContext, type RunHandle } from "./engine";
import { Coordinator } from "./coordinator";
import {
  documentSchema,
  bindingSchema,
  targetSchema,
  type AppDocument,
  type Json,
  type Target,
  type WorkflowDefinition,
} from "../shared/schema";
import { defaults, node, uid } from "../shared/defaults";
import { handlers } from "../actions/handlers";
import { ObsConnections } from "../integrations/obs";
import { observedAudio, observedMedia, probe } from "../adapters/linux/system";
const port = process.parentPort!;
let document: AppDocument = defaults(),
  credentials: Record<string, string> = {};
const send = (message: unknown) => port.postMessage(message);
const replies = new Map<
  string,
  { resolve: (v: Json) => void; reject: (e: Error) => void }
>();
const main = async (
  type: string,
  config: Record<string, Json>,
  context: ActionContext,
) =>
  new Promise<Json>((resolve, reject) => {
    const id = uid();
    const abort = () => {
      replies.delete(id);
      reject(new Error("Action cancelled"));
    };
    context.signal.addEventListener("abort", abort, { once: true });
    replies.set(id, {
      resolve: (v) => {
        context.signal.removeEventListener("abort", abort);
        resolve(v);
      },
      reject: (e) => {
        context.signal.removeEventListener("abort", abort);
        reject(e);
      },
    });
    send({
      type: "mainAction",
      id,
      action: type,
      config,
      context: {
        runId: context.runId,
        bindingId: context.bindingId,
        generation: context.generation,
        deckId: context.deckId,
      },
    });
  });
const obs = new ObsConnections((id, value) =>
  send({ type: "observed", id: `obs:${id}`, value }),
);
const standalone = new Map<string, RunHandle>();
const activeRuns = new Set<string>();
const queuedRecords = new Map<string, import("../shared/schema").RunRecord>();
setInterval(() => {
  for (const record of queuedRecords.values()) send({ type: "run", record });
  queuedRecords.clear();
}, 40).unref();
const engine = new Engine(
  handlers(
    () => document,
    () => credentials,
    async (type, c, ctx) => {
      if (type === "workflow.cancel") {
        coordinator.cancel(String(c.workflowId));
        for (const h of standalone.values())
          if (h.record.workflowId === c.workflowId) h.cancel();
        return null;
      }
      return main(type, c, ctx);
    },
    obs,
  ),
  (record) => {
    if (record.status === "running") {
      activeRuns.add(record.id);
      queuedRecords.set(record.id, record);
    } else {
      activeRuns.delete(record.id);
      queuedRecords.delete(record.id);
      send({ type: "run", record });
    }
  },
  () => Object.values(credentials),
);
const coordinator = new Coordinator(engine);
function targetWorkflow(target: Target): WorkflowDefinition {
  if (target.kind === "workflow") {
    const f = document.workflows.find((w) => w.id === target.workflowId);
    if (!f) throw new Error("Workflow not found");
    return f;
  }
  const actions = target.kind === "sequence" ? target.actions : [target.action],
    nodes = actions.map((a) => ({ ...node("action", a.type), action: a }));
  return {
    id: "direct",
    name: target.kind === "sequence" ? "Multi-action" : actions[0].type,
    revision: 1,
    graph: {
      entry: nodes[0].id,
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: uid(),
        source: nodes[i].id,
        target: n.id,
        port: "next",
      })),
    },
    inputs: [],
    outputs: [],
    timeoutMs: 300000,
    layout: {},
  };
}
const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configure"),
    document: documentSchema,
    credentials: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("trigger"),
    binding: bindingSchema,
    target: targetSchema,
    deckId: z.string(),
    phase: z.enum(["press", "release", "longPress"]).optional(),
  }),
  z.object({
    type: z.literal("run"),
    workflowId: z.string(),
    inputs: z.record(z.string(), z.unknown()),
    deckId: z.string().optional(),
  }),
  z.object({ type: z.literal("cancel"), id: z.string() }),
  z.object({
    type: z.literal("reply"),
    id: z.string(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("diagnose") }),
  z.object({ type: z.literal("stop") }),
]);
let diagnosing = false;
async function diagnose() {
  if (diagnosing) return;
  diagnosing = true;
  try {
    const capabilities = await probe();
    send({ type: "capabilities", capabilities });
    for (const connection of document.connections)
      try {
        await obs.get(
          connection,
          connection.credentialRef
            ? credentials[connection.credentialRef]
            : undefined,
        );
      } catch (error) {
        send({
          type: "observed",
          id: `obs:${connection.id}`,
          value: { connected: false, error: String(error) },
        });
      }
  } finally {
    diagnosing = false;
  }
}
port.on("message", async (event) => {
  try {
    const message = schema.parse(event.data);
    switch (message.type) {
      case "configure": {
        const changed =
          JSON.stringify(document.connections) !==
            JSON.stringify(message.document.connections) ||
          JSON.stringify(credentials) !== JSON.stringify(message.credentials);
        document = message.document;
        credentials = message.credentials;
        if (changed) await obs.close();
        void diagnose();
        break;
      }
      case "trigger": {
        if (activeRuns.size >= 64)
          throw new Error("Maximum active runs reached (64)");
        const f = targetWorkflow(message.target);
        coordinator.trigger(
          message.binding,
          f,
          [...document.workflows, ...(f.id === "direct" ? [f] : [])],
          message.deckId,
          message.phase,
        );
        break;
      }
      case "run": {
        if (activeRuns.size >= 64)
          throw new Error("Maximum active runs reached (64)");
        const f = document.workflows.find((f) => f.id === message.workflowId);
        if (!f) throw new Error("Workflow not found");
        const h = engine.start(
          f,
          document.workflows,
          message.inputs as Record<string, Json>,
          message.deckId ? { deckId: message.deckId } : undefined,
        );
        standalone.set(h.record.id, h);
        void h.done.finally(() => standalone.delete(h.record.id));
        break;
      }
      case "cancel":
        coordinator.cancel(message.id);
        standalone.get(message.id)?.cancel();
        break;
      case "reply": {
        const reply = replies.get(message.id);
        replies.delete(message.id);
        if (message.error) reply?.reject(new Error(message.error));
        else reply?.resolve((message.value ?? null) as Json);
        break;
      }
      case "diagnose":
        void diagnose();
        break;
      case "stop":
        coordinator.stop();
        for (const h of standalone.values()) h.cancel();
        await obs.close();
        setTimeout(() => process.exit(0), 600);
        break;
    }
  } catch (error) {
    send({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
let observing = false;
setInterval(async () => {
  if (observing) return;
  observing = true;
  try {
    send({ type: "observed", id: "microphone", value: await observedAudio() });
    send({
      type: "observed",
      id: "speaker",
      value: await observedAudio(false),
    });
    send({
      type: "observed",
      id: "media",
      value: await observedMedia().catch(() => ({ unavailable: true })),
    });
  } finally {
    observing = false;
  }
}, 4000).unref();
send({ type: "ready" });

setInterval(() => void diagnose(), 15000).unref();
