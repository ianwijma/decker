import { launchSourceSchema, originBinding } from "../shared/trigger-context";
import { toggleBindings } from "../shared/toggle-contract";
import { targetWorkflow, toggleDefinitionStamp } from "./targets";
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
  context: ActionContext & { imageSecret?: string },
) =>
  new Promise<Json>((resolve, reject) => {
    context.signal.throwIfAborted();
    const id = uid();
    const lifecycle = (active: boolean) => {
      if (context.authority && context.actionId)
        send({
          type: "displayAction",
          authority: context.authority,
          runId: context.runId,
          actionId: context.actionId,
          active,
        });
    };
    lifecycle(true);
    const abort = () => {
      lifecycle(false);
      replies.delete(id);
      send({
        type: "cancelMainAction",
        id,
        runId: context.runId,
        actionId: context.actionId,
      });
      reject(new Error("Action cancelled"));
    };
    context.signal.addEventListener("abort", abort, { once: true });
    replies.set(id, {
      resolve: (v) => {
        lifecycle(false);
        context.signal.removeEventListener("abort", abort);
        resolve(v);
      },
      reject: (e) => {
        lifecycle(false);
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
        authority: context.authority,
        actionId: context.actionId,
        bindingId: context.bindingId,
        generation: context.generation,
        deckId: context.deckId,
        imageSecret: context.imageSecret,
      },
    });
  });
let observations: Record<string, Json> = {};
function observation(id: string, value: Json) {
  observations[id] = value;
  toggles.updateObservations({ [id]: value });
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
  (event) =>
    send({ ...event, type: "displayInvocation", operation: event.type }),
  (launch) =>
    !launch.source.origin ||
    Boolean(originBinding(document, launch.source.origin)),
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
let configurationEpoch = 0;
type ObservationRead = {
  epoch: number;
  pending: boolean;
  promise: Promise<Record<string, Json>>;
};
type ObservationCell = { pending: number; latest?: ObservationRead };
const observationReads = new Map<string, ObservationCell>();
/** New deliberate reads supersede old samples; live polls reuse pending work. */
function readProvider(
  key: string,
  fresh: boolean,
  read: () => Promise<Record<string, Json>>,
  accept: () => boolean,
) {
  const cell = observationReads.get(key) ?? { pending: 0 };
  if (
    !fresh &&
    cell.latest?.pending &&
    cell.latest.epoch === configurationEpoch
  )
    return cell.latest.promise;
  const entry: ObservationRead = {
    epoch: configurationEpoch,
    pending: true,
    promise: Promise.resolve({}),
  };
  cell.pending++;
  cell.latest = entry;
  observationReads.set(key, cell);
  entry.promise = Promise.resolve().then(async () => {
    try {
      const sample = await read();
      if (cell.latest !== entry) return await cell.latest!.promise;
      if (!accept()) throw new Error("Observation replaced");
      for (const [id, value] of Object.entries(sample)) observation(id, value);
      return sample;
    } catch (error) {
      if (cell.latest !== entry) return await cell.latest!.promise;
      throw error;
    } finally {
      entry.pending = false;
      cell.pending--;
      if (!cell.pending && observationReads.get(key) === cell)
        observationReads.delete(key);
    }
  });
  return entry.promise;
}
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
  async (source, owner) => {
    const valid = () =>
      toggleBindings(document).some(
        ({ deckId, binding }) =>
          deckId === owner.deckId &&
          binding.id === owner.bindingId &&
          binding.generation === owner.generation &&
          toggleDefinitionStamp(binding, document) === owner.definitionStamp,
      );
    const id =
      source.kind === "media"
        ? "media"
        : source.kind === "audio"
          ? source.target
          : `obs:${source.connectionId}`;
    const key = source.kind === "obs" ? JSON.stringify(source) : id;
    await readProvider(
      key,
      true,
      async (): Promise<Record<string, Json>> => {
        if (source.kind === "media")
          return {
            media: await observedMedia().catch(() => ({ unavailable: true })),
          };
        if (source.kind === "audio")
          return {
            [source.target]: await observedAudio(
              source.target === "microphone",
            ),
          };
        const connection = document.connections.find(
          (c) => c.id === source.connectionId,
        );
        if (!connection) throw new Error("Observation connection missing");
        return {
          [id]: await obs.readObservation(
            connection,
            connection.credentialRef
              ? credentials[connection.credentialRef]
              : undefined,
            source,
            valid,
          ),
        };
      },
      valid,
    );
    if (!valid()) throw new Error("Observation owner replaced");
    return { [id]: observations[id] };
  },
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
    launch: z
      .object({ source: launchSourceSchema, authority: z.string().optional() })
      .optional(),
    binding: bindingSchema,
    target: targetSchema.optional(),
    deckId: z.string(),
    phase: z.enum(["press", "release", "longPress"]).optional(),
  }),
  z.object({
    type: z.literal("run"),
    launch: z
      .object({ source: launchSourceSchema, authority: z.string().optional() })
      .optional(),
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
            if (id.startsWith("obs:")) {
              delete observations[id];
              toggles.updateObservations({ [id]: { connected: false } });
            }
        // Invalidate captured targets immediately, before bounded socket cleanup.
        toggles.configure(document, message.activateToggles);
        if (changed) await obs.close();
        if (epoch !== configurationEpoch) break;
        void diagnose();
        break;
      }
      case "trigger": {
        if (
          message.launch?.source.origin &&
          !originBinding(document, message.launch.source.origin)
        )
          throw new Error("Triggering button changed");
        if (engine.activeCount >= 64)
          throw new Error("Maximum active runs reached (64)");
        if (message.binding.toggle) {
          if (!message.phase || message.phase === "press")
            void toggles.press(message.deckId, message.binding, message.launch);
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
          message.launch,
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
          { deckId: message.deckId, launch: message.launch },
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
    await Promise.all([
      readProvider(
        "microphone",
        false,
        async () => ({ microphone: await observedAudio() }),
        () => captured === document,
      ),
      readProvider(
        "speaker",
        false,
        async () => ({ speaker: await observedAudio(false) }),
        () => captured === document,
      ),
      readProvider(
        "media",
        false,
        async () => ({
          media: await observedMedia().catch(() => ({ unavailable: true })),
        }),
        () => captured === document,
      ),
    ]).catch(() => {});
  } finally {
    observing = false;
  }
}, 4000).unref();
send({ type: "ready" });

setInterval(() => void diagnose(), 15000).unref();
