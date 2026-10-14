import { targetWorkflow } from "./targets";
import { Toggles } from "./toggles";
import type { StoredToggle } from "../main/toggle-storage";
import { findWorkflow } from "../shared/workflow-identity";
import { z } from "zod";
import { Engine, type ActionContext, type RunHandle } from "./engine";
import { Coordinator } from "./coordinator";
import {
  documentSchema,
  bindingSchema,
  targetSchema,
  type AppDocument,
  type Json,
} from "../shared/schema";
import { defaults, uid } from "../shared/defaults";
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
    context.signal.throwIfAborted();
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
let observations: Record<string, Json> = {};
function observation(id: string, value: Json) {
  observations[id] = value;
  toggles.updateObservations(observations);
  send({ type: "observed", id, value });
}
const obs = new ObsConnections((id, value) => observation(`obs:${id}`, value));
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
        // The engine already resolved this using the cancelling run's alias snapshot.
        coordinator.cancelWorkflow(String(c.workflowId));
        return null;
      }
      return main(type, c, ctx);
    },
    obs,
  ),
  (record) => {
    if (record.status === "running") {
      if (!activeRuns.has(record.id)) send({ type: "run", record });
      activeRuns.add(record.id);
      queuedRecords.set(record.id, record);
    } else {
      activeRuns.delete(record.id);
      queuedRecords.delete(record.id);
      send({ type: "run", record });
    }
  },
  () => Object.values(credentials),
  () => document.workflowAliases,
);
const coordinator = new Coordinator(engine);
const storageReplies = new Map<
  string,
  {
    resolve: (value: StoredToggle | null) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const toggles = new Toggles(
  engine,
  (request) =>
    new Promise((resolve, reject) => {
      const id = uid(),
        timer = setTimeout(() => {
          storageReplies.delete(id);
          reject(new Error("Toggle storage timeout"));
        }, 10000);
      storageReplies.set(id, { resolve, reject, timer });
      send({ type: "toggleStorage", id, request });
    }),
  (states) => send({ type: "toggles", states }),
);
const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configure"),
    document: documentSchema,
    credentials: z.record(z.string(), z.string()),
    activateToggles: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("trigger"),
    binding: bindingSchema,
    target: targetSchema.optional(),
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
  z.object({
    type: z.literal("toggleStorageReply"),
    id: z.string(),
    value: z.unknown().optional(),
    error: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("reconcileToggle"),
    deckId: z.string(),
    bindingId: z.string(),
  }),
  z.object({
    type: z.literal("recoverToggle"),
    deckId: z.string(),
    bindingId: z.string(),
    confirmed: z.enum(["on", "off"]),
  }),
  z.object({ type: z.literal("activateToggles") }),
  z.object({ type: z.literal("diagnose") }),
  z.object({ type: z.literal("stop") }),
]);
let configurationEpoch = 0;
let diagnosing = false;
async function diagnose() {
  if (diagnosing) return;
  diagnosing = true;
  const captured = document;
  try {
    const capabilities = await probe();
    send({ type: "capabilities", capabilities });
    for (const connection of captured.connections)
      try {
        await obs.get(
          connection,
          connection.credentialRef
            ? credentials[connection.credentialRef]
            : undefined,
        );
      } catch (error) {
        if (captured === document)
          observation(`obs:${connection.id}`, { connected: false });
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
        const epoch = ++configurationEpoch;
        const changed =
          JSON.stringify(document.connections) !==
            JSON.stringify(message.document.connections) ||
          JSON.stringify(credentials) !== JSON.stringify(message.credentials);
        document = message.document;
        credentials = message.credentials;
        if (changed)
          for (const id of Object.keys(observations))
            if (id.startsWith("obs:")) delete observations[id];
        // Invalidate captured targets immediately, before bounded socket cleanup.
        toggles.configure(document, message.activateToggles);
        toggles.updateObservations(observations);
        if (changed) await obs.close();
        if (epoch !== configurationEpoch) break;
        void diagnose();
        break;
      }
      case "trigger": {
        if (engine.activeCount >= 64)
          throw new Error("Maximum active runs reached (64)");
        if (message.binding.toggle) {
          if (!message.phase || message.phase === "press")
            void toggles.press(message.deckId, message.binding);
          break;
        }
        if (!message.target) throw new Error("Target missing");
        const f = targetWorkflow(message.target, document);
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
        if (engine.activeCount >= 64)
          throw new Error("Maximum active runs reached (64)");
        const f = findWorkflow(
          document.workflows,
          message.workflowId,
          document.workflowAliases,
        );
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
        break;
      case "reply": {
        const reply = replies.get(message.id);
        replies.delete(message.id);
        if (message.error) reply?.reject(new Error(message.error));
        else reply?.resolve((message.value ?? null) as Json);
        break;
      }
      case "toggleStorageReply": {
        const pending = storageReplies.get(message.id);
        if (pending) {
          storageReplies.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error)
            pending.reject(new Error("Toggle storage unavailable"));
          else pending.resolve((message.value ?? null) as StoredToggle | null);
        }
        break;
      }
      case "reconcileToggle":
        void toggles.reconcile(message.deckId, message.bindingId);
        break;
      case "recoverToggle":
        void toggles.recover(
          message.deckId,
          message.bindingId,
          message.confirmed,
        );
        break;
      case "activateToggles":
        toggles.configure(document, true);
        break;
      case "diagnose":
        void diagnose();
        break;
      case "stop":
        toggles.stop();
        for (const pending of storageReplies.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Worker stopped"));
        }
        storageReplies.clear();
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
    const captured = document;
    const [microphone, speaker, media] = await Promise.all([
      observedAudio(),
      observedAudio(false),
      observedMedia().catch(() => ({ unavailable: true })),
    ]);
    if (captured !== document) return;
    observation("microphone", microphone);
    observation("speaker", speaker);
    observation("media", media);
  } finally {
    observing = false;
  }
}, 4000).unref();
send({ type: "ready" });

setInterval(() => void diagnose(), 15000).unref();
