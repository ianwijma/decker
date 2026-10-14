import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDesktopTarget } from "./desktop-open";
import { pickDesktopFile } from "./desktop-file-picker";
import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  deckPage,
  navigateDeck,
  cloneProfiles,
  keySlot,
  preserveNavigation,
} from "../shared/decks";
import { z } from "zod";
import { Persistence, validateDocument, validateImport } from "./persistence";
import { Credentials } from "./credentials";
import { mutateCredential } from "./credential-mutations";
import { commitBrightness } from "./brightness";
import { brightnessActions, preserveBrightness } from "../shared/brightness";
import {
  credentialOwners,
  rekeyCredentials,
} from "../shared/credential-owners";
import { defaults, uid } from "../shared/defaults";
import {
  requestSchema,
  type AppDocument,
  type Json,
  type RunRecord,
  type Snapshot,
  type Request,
  type WebStatus,
  type WebDeckView,
} from "../shared/schema";
import { Triggers } from "../device/triggers";
import { buttonAppearance } from "../shared/feedback";
import { ButtonActivity } from "../runtime/activity";
import { redact } from "../runtime/data";
import {
  buildHealth,
  obsCapability,
  DiagnosticFaults,
  redactDiagnostics,
  remedyFor,
} from "../shared/health";
const diagnosticFaults = new DiagnosticFaults();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "decker-asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  quitting = false,
  store: Persistence,
  credentials: Credentials;
let document: AppDocument = defaults(),
  runs: RunRecord[] = [],
  devices: Snapshot["devices"] = [],
  capabilities: Snapshot["capabilities"] = [],
  observed: Snapshot["observed"] = {};
let webStatus: WebStatus = {
  running: false,
  port: 0,
  urls: [],
  clients: [],
  pending: [],
};
let lastWebConfigure = "";
const webReplies = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const workers = new Map<
  string,
  { process: UtilityProcess; ready: boolean; failures: number }
>();
let publishTimer: ReturnType<typeof setTimeout> | undefined,
  persistTimer: ReturnType<typeof setTimeout> | undefined;
let credentialEpoch = uid();
const snapshot = (): Snapshot => {
  const secrets = Object.values(credentials?.all() ?? {});
  const safeObserved = Object.fromEntries(
    Object.entries({
      ...observed,
      buttonFeedback: feedback.snapshot(),
      diagnostics: diagnosticFaults.snapshot(),
    }).map(([key, value]) => [key, redactDiagnostics(value, secrets)]),
  );
  const safeDevices = devices.map(
    (device) => redactDiagnostics(device, secrets) as typeof device,
  );
  const currentCapabilities = [
    ...capabilities.filter((c) => c.id !== "obs"),
    obsCapability({ document, observed: safeObserved }),
  ];
  const health = buildHealth({
    document,
    devices: safeDevices,
    capabilities: currentCapabilities,
    observed: safeObserved,
    web: webStatus,
  }).map((record) => redactDiagnostics(record, secrets) as typeof record);
  return {
    document,
    runs,
    devices: [
      ...safeDevices,
      ...document.decks
        .filter((d) => d.kind === "simulator")
        .map((d) => ({
          id: d.id,
          name: d.name,
          connected: true,
          present: true,
          configured: true,
          state: "ready" as const,
          updatedAt: Date.now(),
          simulated: true,
          rows: d.rows,
          columns: d.columns,
          iconSize: 96,
        })),
    ],
    web: webStatus,
    capabilities: currentCapabilities,
    observed: safeObserved,
    health,
    secureStorage: credentials.secure,
    credentialState: {
      epoch: credentialEpoch,
      persistent: credentials.writable,
      owners: Object.fromEntries(
        credentialOwners(document).map((o) => [
          o.key,
          credentials.status(o.ref),
        ]),
      ),
    },
  };
};
function publish() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    configureWeb();
    if (window && !window.isDestroyed())
      window.webContents.send("decker:snapshot", snapshot());
  }, 40);
}
function diagnostic(error: unknown, id = "main", feature = "Application") {
  diagnosticFaults.set(
    id,
    feature,
    error,
    Object.values(credentials?.all() ?? {}),
  );
  publish();
}
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void enqueueMutation(() => store.save(document, runs))
      .then(() => {
        diagnosticFaults.clear("persistence");
        publish();
      })
      .catch((error) => diagnostic(error, "persistence", "Workspace storage"));
  }, 250);
}
function post(name: string, message: unknown) {
  const worker = workers.get(name);
  if (worker?.ready) worker.process.postMessage(message);
  else if (
    !["configure", "refresh", "stop"].includes(
      (message as { type: string }).type,
    )
  )
    throw new Error(`${name} is starting; try again in a moment`);
}
function page(deckId: string) {
  const result = deckPage(document, deckId);
  if (!result) throw new Error("Deck page unavailable");
  return result;
}
function deckAppearance(deckId: string) {
  const deck = document.decks.find((d) => d.id === deckId)!;
  const keys: Record<string, import("../shared/schema").WebKey> = {};
  const source = page(deckId);
  for (let i = 0; i < deck.rows * deck.columns; i++) {
    const binding = source.keys[keySlot(i, deck.columns)];
    if (!binding) continue;
    const appearance = buttonAppearance(
      binding,
      { ...observed, buttonFeedback: feedback.snapshot() },
      document.settings.accent,
      deckId,
    );
    keys[i] = {
      label: appearance.label,
      icon: appearance.icon,
      background: appearance.background,
      asset: appearance.asset,
    };
  }
  return keys;
}
function configureWeb() {
  if (!store) return;
  const views: WebDeckView[] = document.decks
    .filter((d) => d.kind === "web")
    .map((deck) => ({
      id: deck.id,
      name: deck.name,
      rows: deck.rows,
      columns: deck.columns,
      pageName: page(deck.id).name,
      accent: document.settings.accent,
      version: createHash("sha256")
        .update(
          JSON.stringify([
            deck.activeProfileId,
            deck.activePageId,
            deck.rows,
            deck.columns,
            Object.entries(page(deck.id).keys).map(([slot, key]) => [
              slot,
              key.id,
              key.generation,
            ]),
          ]),
        )
        .digest("hex"),
      keys: deckAppearance(deck.id),
    }));
  const message = {
    type: "configure",
    views,
    enabled: document.settings.webEnabled,
    port: document.settings.webPort,
    rendererDirectory: join(import.meta.dirname, "../renderer"),
    assetDirectory: store.assetDirectory,
    directory: store.directory,
  };
  const signature = JSON.stringify(message);
  if (signature !== lastWebConfigure && workers.get("web")?.ready) {
    lastWebConfigure = signature;
    post("web", message);
  }
}
function webRequest(type: string, payload: Record<string, unknown>) {
  return new Promise<unknown>((resolve, reject) => {
    const id = uid(),
      timer = setTimeout(() => {
        webReplies.delete(id);
        reject(new Error("Web deck service timed out"));
      }, 10000);
    webReplies.set(id, { resolve, reject, timer });
    try {
      post("web", { type, id, ...payload });
    } catch (error) {
      clearTimeout(timer);
      webReplies.delete(id);
      reject(error);
    }
  });
}
function input(deckId: string, source: string, key: number, down: boolean) {
  const deck = document.decks.find((d) => d.id === deckId);
  if (!deck || key < 0 || key >= deck.rows * deck.columns) return;
  if (down)
    triggers.down(
      source,
      key,
      page(deckId).keys[keySlot(key, deck.columns)],
      deckId,
    );
  else triggers.up(source, key);
}
const feedback = new ButtonActivity();
function configureDevice() {
  post("device", {
    type: "configure",
    frames: document.decks
      .filter((d) => d.kind === "hardware")
      .map((deck) => ({
        deckId: deck.id,
        hardwareId: deck.hardwareId,
        name: deck.name,
        rows: deck.rows,
        columns: deck.columns,
        brightness: deck.brightness,
        page: Object.fromEntries(
          Object.entries(deckAppearance(deck.id)).map(([key, appearance]) => [
            key,
            {
              ...appearance,
              running: document.settings.accent,
              success: "#23a559",
              error: "#f23f42",
            },
          ]),
        ),
      })),
    assetDirectory: store.assetDirectory,
  });
  configureWeb();
}
function configure() {
  feedback.reconcile(document);
  for (const key of Object.keys(observed))
    if (
      key.startsWith("obs:") &&
      !document.connections.some((c) => `obs:${c.id}` === key)
    )
      delete observed[key];
  post("runner", {
    type: "configure",
    document,
    credentials: credentials.all(),
  });
  configureDevice();
  publish();
}
const triggers = new Triggers((binding, target, deckId, phase) => {
  try {
    post("runner", { type: "trigger", binding, target, deckId, phase });
    diagnosticFaults.clear("trigger");
  } catch (error) {
    diagnostic(error, "trigger", "Key actions");
  }
});
function navigate(deckId: string, profileId: string, pageId: string) {
  navigateDeck(document, deckId, profileId, pageId);
  configure();
  persist();
}
async function mainAction(
  ...args: Parameters<typeof performMainAction>
): Promise<Json> {
  return [
    "deck.page",
    "deck.profile",
    "deck.back",
    ...brightnessActions,
  ].includes(args[0])
    ? enqueueMutation(async () => {
        // A run can cancel while a credential/document commit holds this queue.
        // Never apply its delayed navigation or brightness after it has settled.
        if (
          !runs.some(
            (run) => run.id === args[2].runId && run.status === "running",
          )
        )
          throw new Error("Run is no longer active");
        return performMainAction(...args);
      })
    : performMainAction(...args);
}
async function performMainAction(
  action: string,
  c: Record<string, Json>,
  context: {
    runId: string;
    bindingId?: string;
    generation?: number;
    deckId?: string;
  },
): Promise<Json> {
  const deck = document.decks.find(
    (d) => d.id === (context.deckId ?? document.activeDeckId),
  );
  if (action.startsWith("deck.") && !deck)
    throw new Error("No originating deck selected");
  switch (action) {
    case "desktop.open":
      return openDesktopTarget(action, c.target, shell);
    case "desktop.openUrl":
      return openDesktopTarget(action, c.url, shell);
    case "desktop.openFile":
      return openDesktopTarget(action, c.path, shell);
    case "desktop.copy":
      clipboard.writeText(String(c.text));
      return null;
    case "desktop.notify":
      new Notification({ title: String(c.title), body: String(c.body) }).show();
      return null;
    case "deck.page":
      navigate(deck!.id, deck!.activeProfileId, String(c.pageId));
      return null;
    case "deck.profile": {
      const p = document.profiles.find(
        (p) => p.id === c.profileId && deck!.profileIds.includes(p.id),
      );
      if (!p) throw new Error("Profile does not exist");
      navigate(deck!.id, p.id, p.pages[0].id);
      return null;
    }
    case "deck.back":
      if (page(deck!.id).parentId)
        navigate(deck!.id, deck!.activeProfileId, page(deck!.id).parentId!);
      return null;
    case "deck.brightness":
    case "deck.brightnessIncrease":
    case "deck.brightnessDecrease": {
      const committed = await commitBrightness(
        document,
        action,
        c,
        context.deckId,
        (next) => store.save(next, runs),
      );
      document = committed.document;
      configureDevice();
      publish();
      return committed.value;
    }
    case "deck.appearance": {
      const binding = Object.values(page(deck!.id).keys).find(
        (b) =>
          b.id === context.bindingId && b.generation === context.generation,
      );
      if (binding) {
        const background = z
          .string()
          .regex(/^#[a-fA-F0-9]{6}$/)
          .parse(c.background);
        feedback.override(
          deck!.id,
          binding,
          String(c.label).slice(0, 80),
          background,
        );
        configureDevice();
      }
      return null;
    }
    default:
      throw new Error(`Unknown main action: ${action}`);
  }
}
function startWorker(name: "runner" | "device" | "web", failures = 0) {
  const child = utilityProcess.fork(
    join(import.meta.dirname, `${name}.js`),
    [],
    { serviceName: `Decker ${name}`, stdio: "pipe" },
  );
  workers.set(name, { process: child, ready: false, failures });
  child.on("message", async (message) => {
    try {
      if (message.type === "ready") {
        diagnosticFaults.clear(`worker:${name}`);
        diagnosticFaults.clear(`stderr:${name}`);
        const worker = workers.get(name);
        if (worker) worker.ready = true;
        if (name === "web") lastWebConfigure = "";
        configure();
        return;
      }
      if (name === "web") {
        if (message.type === "status") {
          webStatus = message.status;
          publish();
        } else if (message.type === "input")
          input(message.deckId, message.source, message.key, message.down);
        else if (message.type === "disconnect")
          triggers.disconnect(message.source);
        else if (message.type === "reply") {
          const pending = webReplies.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            webReplies.delete(message.id);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.value);
          }
        } else if (message.type === "error") {
          webStatus = { ...webStatus, error: message.error };
          publish();
        }
        return;
      }
      if (name === "device") {
        if (message.type === "nativeReady") {
          observed.hardwareNativeReady = message.ready;
          if (message.ready) delete observed.hardwareNativeError;
          else
            observed.hardwareNativeError = redactDiagnostics(
              message.error ?? "Native driver unavailable",
              Object.values(credentials.all()),
            );
          publish();
        } else if (message.type === "hardwareAccess") {
          observed.hardwareAccess = redactDiagnostics(
            message.value,
            Object.values(credentials.all()),
          );
          publish();
        } else if (message.type === "devices") {
          devices = message.devices;
          for (const deck of document.decks.filter(
            (d) => d.kind === "hardware",
          )) {
            const found = devices.find((d) => d.id === deck.hardwareId);
            if (
              found?.present &&
              (deck.rows !== found.rows || deck.columns !== found.columns)
            ) {
              deck.rows = found.rows;
              deck.columns = found.columns;
              persist();
              configureDevice();
            }
          }
          publish();
        } else if (message.type === "key") {
          const deck = document.decks.find((d) => d.hardwareId === message.id);
          if (deck) input(deck.id, message.id, message.key, message.down);
        } else if (message.type === "disconnect")
          triggers.disconnect(message.id);
        else if (message.type === "diagnostic")
          diagnostic(message.error, `worker:${name}`, `${name} service`);
        return;
      }
      if (message.type === "run") {
        const record = message.record as RunRecord,
          index = runs.findIndex((r) => r.id === record.id);
        if (index >= 0) runs[index] = record;
        else runs.push(record);
        const active = runs.filter((r) => r.status === "running"),
          finished = runs
            .filter((r) => r.status !== "running")
            .slice(-document.settings.historyLimit);
        runs = [...finished, ...active].sort(
          (a, b) => a.startedAt - b.startedAt,
        );
        feedback.update(record, document);
        configureDevice();
        if (record.status === "success" || record.status === "failure")
          setTimeout(() => {
            feedback.expire();
            configureDevice();
            publish();
          }, 1500).unref();
        publish();
        persist();
      } else if (message.type === "capabilities") {
        capabilities = message.capabilities;
        diagnosticFaults.clear("worker:runner");
        diagnosticFaults.clear("stderr:runner");
        publish();
      } else if (message.type === "observed") {
        const value = message.value;
        if (message.id.startsWith("obs:")) {
          if (!document.connections.some((c) => `obs:${c.id}` === message.id))
            return;
          if (value?.connected) delete value.error;
        }
        observed[message.id] = redactDiagnostics(
          value,
          Object.values(credentials.all()),
        );
        configureDevice();
        publish();
      } else if (message.type === "error")
        diagnostic(message.error, `worker:${name}`, `${name} service`);
      else if (message.type === "mainAction") {
        try {
          const value = await mainAction(
            message.action,
            message.config,
            message.context,
          );
          post("runner", { type: "reply", id: message.id, value });
        } catch (error) {
          post("runner", {
            type: "reply",
            id: message.id,
            error: String(error),
          });
        }
      }
    } catch (error) {
      diagnostic(error, `worker:${name}`, `${name} service`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    diagnostic(
      String(chunk).slice(0, 2000),
      `stderr:${name}`,
      `${name} service output`,
    );
  });
  child.on("exit", (code) => {
    workers.delete(name);
    if (quitting) return;
    if (name === "device") {
      for (const device of devices) triggers.disconnect(device.id);
      observed.hardwareNativeReady = false;
      devices = devices.map((device) => ({
        ...device,
        connected: false,
        state: "io-error",
        updatedAt: Date.now(),
        error: "Device service exited; readiness is unknown",
        errorDetails: undefined,
      }));
    } else if (name === "runner") {
      feedback.interrupt();
      configureDevice();
      runs = runs.map((r) =>
        r.status === "running"
          ? {
              ...r,
              status: "interrupted",
              endedAt: Date.now(),
              error:
                "Runner exited unexpectedly; side effects were not replayed",
            }
          : r,
      );
      persist();
    }
    if (name === "web") {
      triggers.disconnect("web");
      lastWebConfigure = "";
      webStatus = {
        ...webStatus,
        running: false,
        pending: [],
        clients: webStatus.clients.map((c) => ({ ...c, online: false })),
      };
      for (const pending of webReplies.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Web service restarted"));
      }
      webReplies.clear();
    }
    diagnostic(
      `${name} exited (${code}); ${failures < 3 ? "restarting" : "restart the application to retry"}`,
      `worker:${name}`,
      `${name} service`,
    );
    if (failures < 3)
      setTimeout(() => startWorker(name, failures + 1), 500 * (failures + 1));
  });
}
async function startup(enabled: boolean) {
  const directory = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "autostart",
    ),
    path = join(directory, "decker.desktop");
  if (enabled) {
    await mkdir(directory, { recursive: true });
    const executable = process.env.APPIMAGE || process.execPath;
    await writeFile(
      path,
      `[Desktop Entry]\nType=Application\nName=Decker\nExec="${executable.replace(/["\\`$]/g, "\\$&")}" --hidden\nX-GNOME-Autostart-enabled=true\n`,
    );
  } else
    await unlink(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
}
let requests: Promise<unknown> = Promise.resolve();
function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = requests.catch(() => {}).then(operation);
  requests = result;
  return result;
}
function handle(raw: unknown) {
  const request = requestSchema.parse(raw);
  // Only document mutations share this queue. Cancellation and runner requests
  // remain responsive while storage or a native dialog is pending.
  return [
    "save",
    "credential",
    "import",
    "addDeck",
    "deleteDeck",
    "copyProfile",
    "navigate",
    "selectDeck",
  ].includes(request.type)
    ? enqueueMutation(() => handleRequest(request))
    : handleRequest(request);
}
async function handleRequest(request: Request) {
  switch (request.type) {
    case "save": {
      const next = request.document;
      preserveNavigation(document, next, request.navigationEdits);
      preserveBrightness(document, next, request.brightnessEdits);
      validateDocument(next);
      for (const f of next.workflows) {
        const old = document.workflows.find((w) => w.id === f.id);
        if (old) {
          const changed =
            JSON.stringify([
              old.graph,
              old.inputs,
              old.outputs,
              old.timeoutMs,
            ]) !== JSON.stringify([f.graph, f.inputs, f.outputs, f.timeoutMs]);
          f.revision = changed ? old.revision + 1 : old.revision;
        }
      }
      for (const profile of next.profiles)
        for (const p of profile.pages)
          for (const b of Object.values(p.keys)) {
            const old = document.profiles
              .flatMap((p) => p.pages)
              .flatMap((p) => Object.values(p.keys))
              .find((k) => k.id === b.id);
            if (old)
              b.generation =
                JSON.stringify({ ...old, generation: 0 }) ===
                JSON.stringify({ ...b, generation: 0 })
                  ? old.generation
                  : old.generation + 1;
          }
      if (next.settings.launchAtLogin !== document.settings.launchAtLogin)
        await startup(next.settings.launchAtLogin);
      for (const old of document.decks) {
        const changed = next.decks.find((d) => d.id === old.id);
        if (
          !changed ||
          changed.rows !== old.rows ||
          changed.columns !== old.columns
        )
          triggers.disconnectDeck(old.id);
      }
      await store.save(next, runs);
      document = next;
      credentialEpoch = uid();
      configure();
      return snapshot();
    }
    case "press": {
      const deck = document.decks.find((d) => d.id === request.deckId);
      if (deck?.kind !== "simulator")
        throw new Error("Simulated input requires a simulator deck");
      input(deck.id, deck.id, request.key, request.down);
      return null;
    }
    case "test": {
      const deck = document.decks.find((d) => d.id === request.deckId);
      if (!deck) throw new Error("Deck not found");
      if (request.binding.press)
        post("runner", {
          type: "trigger",
          binding: request.binding,
          target: request.binding.press,
          deckId: deck.id,
        });
      return null;
    }
    case "run":
      post("runner", {
        ...request,
        deckId: request.deckId ?? (document.activeDeckId || undefined),
      });
      return null;
    case "cancel":
      post("runner", { type: "cancel", id: request.runId });
      return null;
    case "navigate":
      navigate(request.deckId, request.profileId, request.pageId);
      return snapshot();
    case "selectDeck":
      if (!document.decks.some((d) => d.id === request.deckId))
        throw new Error("Deck not found");
      document.activeDeckId = request.deckId;
      persist();
      publish();
      return snapshot();
    case "addDeck": {
      if (document.decks.length >= 64 || document.profiles.length >= 200)
        throw new Error("Deck or profile limit reached");
      let rows = request.rows,
        columns = request.columns;
      if (request.kind === "hardware") {
        const found = devices.find((d) => d.id === request.hardwareId);
        if (!found?.present || found.id.startsWith("session:"))
          throw new Error(
            "Hardware needs a stable serial number and must be detected",
          );
        if (document.decks.some((d) => d.hardwareId === found.id))
          throw new Error("This Stream Deck is already configured");
        rows = found.rows;
        columns = found.columns;
      }
      const id = uid(),
        profileId = uid(),
        pageId = uid();
      credentialEpoch = uid();
      document.decks.push({
        id,
        name: request.name,
        kind: request.kind,
        icon: request.icon,
        rows,
        columns,
        brightness: 70,
        hardwareId:
          request.kind === "hardware" ? request.hardwareId : undefined,
        profileIds: [profileId],
        activeProfileId: profileId,
        activePageId: pageId,
      });
      document.profiles.push({
        id: profileId,
        name: "Default",
        pages: [{ id: pageId, name: "Home", keys: {} }],
      });
      document.activeDeckId = id;
      if (request.kind === "web") document.settings.webEnabled = true;
      await store.save(document, runs);
      configure();
      return snapshot();
    }
    case "deleteDeck": {
      const deck = document.decks.find((d) => d.id === request.deckId);
      if (!deck) throw new Error("Deck not found");
      triggers.disconnectDeck(deck.id);
      credentialEpoch = uid();
      document.decks = document.decks.filter((d) => d.id !== deck.id);
      document.profiles = document.profiles.filter(
        (p) => !deck.profileIds.includes(p.id),
      );
      if (document.activeDeckId === deck.id)
        document.activeDeckId = document.decks[0]?.id ?? "";
      await store.save(document, runs);
      configure();
      return snapshot();
    }
    case "copyProfile": {
      const deck = document.decks.find((d) => d.id === request.toDeckId),
        profile = document.profiles.find((p) => p.id === request.fromProfileId);
      if (!deck || !profile) throw new Error("Deck or profile not found");
      const copy = cloneProfiles([profile]).profiles[0];
      copy.name += " copy";
      credentialEpoch = uid();
      document.profiles.push(copy);
      deck.profileIds.push(copy.id);
      await store.save(document, runs);
      configure();
      return snapshot();
    }
    case "invite":
      return webRequest("invite", { deckId: request.deckId });
    case "approvePairing":
      return webRequest("approve", {
        pairingId: request.pairingId,
        approved: request.approved,
      });
    case "revokeClient":
      return webRequest("revoke", { clientId: request.clientId });
    case "copyWebLink":
    case "openWeb": {
      const url = new URL(request.url);
      if (
        !webStatus.urls.some((base) => url.origin === base) ||
        !url.pathname.startsWith("/deck/")
      )
        throw new Error("Only this computer’s web deck URLs can be opened");
      if (request.type === "copyWebLink") clipboard.writeText(request.url);
      else await shell.openExternal(request.url);
      return null;
    }
    case "retryDevice":
      if (
        !document.decks.some((deck) => deck.hardwareId === request.hardwareId)
      )
        throw new Error("Hardware deck is not configured");
      post("device", { type: "refresh", id: request.hardwareId });
      return null;
    case "diagnosticRemedy": {
      const record = snapshot().health?.find(
        (record) => record.id === request.healthId,
      );
      const remedy = record && remedyFor(record);
      if (!remedy)
        throw new Error(
          "This remedy is no longer available; recheck diagnostics",
        );
      if (request.action === "copy" && remedy.copy)
        clipboard.writeText(remedy.copy);
      else if (request.action === "open" && remedy.url)
        await shell.openExternal(remedy.url);
      else throw new Error("Remedy action is unavailable");
      return null;
    }
    case "diagnose":
      lastWebConfigure = "";
      configureWeb();
      post("runner", { type: "diagnose" });
      post("device", { type: "refresh" });
      return null;
    case "clearHistory":
      runs = runs.filter((r) => r.status === "running");
      persist();
      publish();
      return null;
    case "credential": {
      document = await mutateCredential(
        document,
        credentialEpoch,
        request,
        credentials,
        (next) => store.save(next, runs),
      );
      credentialEpoch = uid();
      configure();
      return snapshot();
    }
    case "pickFile":
      return pickDesktopFile((options) =>
        dialog.showOpenDialog(window!, options),
      );
    case "asset": {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      if (result.canceled) return null;
      const bytes = await readFile(result.filePaths[0]);
      if (bytes.length > 5_000_000) throw new Error("Image exceeds 5 MB");
      const normalized = await sharp(bytes, { limitInputPixels: 16000000 })
        .resize(256, 256, { fit: "cover" })
        .png()
        .toBuffer();
      return store.storeAsset(normalized);
    }
    case "export": {
      const result = await dialog.showSaveDialog({
        defaultPath: "decker-workspace.json",
        filters: [{ name: "Decker workspace", extensions: ["json"] }],
      });
      if (!result.canceled && result.filePath)
        await writeFile(
          result.filePath,
          JSON.stringify(await store.export(document), null, 2),
          { mode: 0o600 },
        );
      return null;
    }
    case "import": {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Decker workspace", extensions: ["json"] }],
      });
      if (result.canceled) return null;
      const bytes = await readFile(result.filePaths[0]);
      if (bytes.length > 20_000_000) throw new Error("Import exceeds 20 MB");
      const imported = JSON.parse(bytes.toString());
      const next = rekeyCredentials(
        validateImport(imported.document ?? imported),
        () => `managed:${uid()}`,
      );
      const review =
        JSON.stringify(
          next.profiles.map((p) => ({ name: p.name, pages: p.pages })),
          null,
          2,
        ) +
        "\n" +
        JSON.stringify(next.workflows, null, 2);
      const reviewPath = join(app.getPath("userData"), "import-review.json");
      await writeFile(reviewPath, review, { mode: 0o600 });
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "Review imported actions",
        message:
          "This workspace contains actions that can run commands and control your desktop.",
        detail:
          "Review every command and connection before activating it. The current workspace will be backed up.",
        buttons: ["Cancel", "Open review", "Import workspace"],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirmation.response === 1) {
        await shell.openPath(reviewPath);
        return null;
      }
      if (confirmation.response !== 2) return null;
      await writeFile(
        join(app.getPath("userData"), `before-import-${Date.now()}.json`),
        JSON.stringify(await store.export(document)),
        { mode: 0o600 },
      );
      await store.importAssets(imported.assets ?? {});
      triggers.disconnect();
      for (const r of runs.filter((r) => r.status === "running"))
        post("runner", { type: "cancel", id: r.id });

      next.settings.launchAtLogin = document.settings.launchAtLogin;
      post("web", { type: "resetPairings" });
      lastWebConfigure = "";
      next.settings.webEnabled = false;
      await store.save(next, runs);
      document = next;
      credentialEpoch = uid();
      feedback.clear();
      configure();
      return snapshot();
    }
  }
}
function createWindow() {
  window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    backgroundColor: "#313338",
    title: "Decker",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  window.on("close", (event) => {
    if (!quitting && document.settings.closeToTray && tray) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = undefined;
  });
  if (process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  window.on("ready-to-show", () => {
    if (!document.settings.startHidden && !process.argv.includes("--hidden"))
      window?.show();
  });
}
function show() {
  if (!window) createWindow();
  window?.show();
  window?.focus();
}
if (locked)
  void app.whenReady().then(async () => {
    if (process.env.DECKER_DATA_DIR)
      app.setPath("userData", process.env.DECKER_DATA_DIR);
    store = new Persistence(app.getPath("userData"));
    const loaded = await store.load();
    document = loaded.document;
    runs = loaded.runs;
    credentials = new Credentials(app.getPath("userData"));
    await credentials.load();
    if (loaded.warning)
      diagnostic(loaded.warning, "workspace-load", "Workspace recovery");
    protocol.handle("decker-asset", async (request) => {
      const hash = new URL(request.url).hostname;
      if (!/^[a-f0-9]{64}$/.test(hash))
        return new Response(null, { status: 404 });
      try {
        return new Response(await readFile(join(store.assetDirectory, hash)), {
          headers: { "Content-Type": "image/png" },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    ipcMain.handle("decker:snapshot", (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Untrusted sender");
      return snapshot();
    });
    ipcMain.handle("decker:request", (event, request) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Untrusted sender");
      return handle(request);
    });
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAALklEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRgEAABgYAAE6K4B8AAAAAElFTkSuQmCC",
    );
    // A generated monochrome grid remains readable in light and dark Linux panels.
    const traySvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#5865f2"/><g fill="white"><rect x="5" y="5" width="5" height="5" rx="1"/><rect x="14" y="5" width="5" height="5" rx="1"/><rect x="5" y="14" width="5" height="5" rx="1"/><rect x="14" y="14" width="5" height="5" rx="1"/></g></svg>',
    );
    const trayPng = await sharp(traySvg).png().toBuffer();
    tray = new Tray(nativeImage.createFromBuffer(trayPng) || icon);
    tray.setToolTip("Decker");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Decker", click: show },
        { type: "separator" },
        { label: "Quit Decker", click: () => app.quit() },
      ]),
    );
    tray.on("click", show);
    createWindow();
    startWorker("runner");
    startWorker("device");
    startWorker("web");
    powerMonitor.on("suspend", () => triggers.disconnect());
    powerMonitor.on("resume", () => {
      triggers.disconnect();
      post("device", { type: "refresh" });
    });
  });
app.on("second-instance", show);
app.on("activate", show);
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  triggers.disconnect();
  for (const name of workers.keys()) post(name, { type: "stop" });
  clearTimeout(persistTimer);
  setTimeout(() => {
    runs = runs.map((r) =>
      r.status === "running"
        ? {
            ...r,
            status: "interrupted",
            endedAt: Date.now(),
            error: "Application shutdown",
          }
        : r,
    );
    void store?.save(document, runs).finally(() => {
      for (const worker of workers.values()) worker.process.kill();
      tray?.destroy();
      app.quit();
    });
  }, 900);
});
