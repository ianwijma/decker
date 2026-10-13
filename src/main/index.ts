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
import { join, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { Persistence, validateDocument, validateImport } from "./persistence";
import { Credentials } from "./credentials";
import { defaults } from "../shared/defaults";
import {
  requestSchema,
  type AppDocument,
  type Json,
  type RunRecord,
  type Snapshot,
} from "../shared/schema";
import { Triggers } from "../device/triggers";
import { observedAppearance } from "../shared/feedback";
import { redact } from "../runtime/data";
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
const workers = new Map<
  string,
  { process: UtilityProcess; ready: boolean; failures: number }
>();
let publishTimer: ReturnType<typeof setTimeout> | undefined,
  persistTimer: ReturnType<typeof setTimeout> | undefined;
const snapshot = (): Snapshot => ({
  document,
  runs,
  devices,
  capabilities,
  observed,
  secureStorage: credentials.secure,
});
function publish() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    if (window && !window.isDestroyed())
      window.webContents.send("decker:snapshot", snapshot());
  }, 40);
}
function diagnostic(error: unknown) {
  observed = {
    ...observed,
    diagnostic: String(
      redact(
        error instanceof Error ? error.message : String(error),
        Object.values(credentials?.all() ?? {}),
      ),
    ),
  };
  publish();
}
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void store.save(document, runs).catch(diagnostic);
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
function page() {
  return document.profiles
    .find((p) => p.id === document.activeProfileId)!
    .pages.find((p) => p.id === document.activePageId)!;
}
const feedback = new Map<
  string,
  {
    runId: string;
    generation: number;
    state: string;
    label?: string;
    background?: string;
  }
>();
function configureDevice() {
  const keys = Object.fromEntries(
    Object.entries(page().keys).map(([index, binding]) => {
      const status = feedback.get(binding.id),
        appearance = observedAppearance(
          binding,
          observed,
          document.settings.accent,
        );
      if (status?.generation === binding.generation) {
        if (["running", "success", "failure"].includes(status.state))
          appearance.background =
            status.state === "failure"
              ? appearance.error
              : status.state === "running"
                ? document.settings.accent
                : appearance.success;
        if (status.label) appearance.label = status.label;
        if (status.background) appearance.background = status.background;
      }
      return [index, appearance];
    }),
  );
  post("device", {
    type: "configure",
    page: keys,
    brightness: document.settings.brightness,
    simulator: document.settings.simulator,
    assetDirectory: store.assetDirectory,
  });
}
function configure() {
  post("runner", {
    type: "configure",
    document,
    credentials: credentials.all(),
  });
  configureDevice();
  publish();
}
const triggers = new Triggers((binding, target) => {
  try {
    post("runner", { type: "trigger", binding, target });
  } catch (error) {
    diagnostic(error);
  }
});
function navigate(profileId: string, pageId: string) {
  const profile = document.profiles.find((p) => p.id === profileId);
  if (!profile?.pages.some((p) => p.id === pageId))
    throw new Error("Profile or page does not exist");
  document = { ...document, activeProfileId: profileId, activePageId: pageId };
  configure();
  persist();
}
async function mainAction(
  action: string,
  c: Record<string, Json>,
  context: { runId: string; bindingId?: string; generation?: number },
): Promise<Json> {
  switch (action) {
    case "desktop.open": {
      const target = String(c.target);
      if (/^https?:\/\//.test(target)) {
        const url = new URL(target);
        if (url.username || url.password)
          throw new Error("URL credentials are not supported");
        await shell.openExternal(url.href);
      } else {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target))
          throw new Error("Only HTTP(S) URLs and local paths are supported");
        const error = await shell.openPath(resolve(target));
        if (error) throw new Error(error);
      }
      return null;
    }
    case "desktop.copy":
      clipboard.writeText(String(c.text));
      return null;
    case "desktop.notify":
      new Notification({ title: String(c.title), body: String(c.body) }).show();
      return null;
    case "deck.page":
      navigate(document.activeProfileId, String(c.pageId));
      return null;
    case "deck.profile": {
      const p = document.profiles.find((p) => p.id === c.profileId);
      if (!p) throw new Error("Profile does not exist");
      navigate(p.id, p.pages[0].id);
      return null;
    }
    case "deck.back":
      if (page().parentId) navigate(document.activeProfileId, page().parentId!);
      return null;
    case "deck.brightness": {
      const value = z.number().int().min(0).max(100).parse(c.value);
      document.settings.brightness = value;
      configureDevice();
      publish();
      persist();
      return value;
    }
    case "deck.appearance": {
      const binding = Object.values(page().keys).find(
        (b) =>
          b.id === context.bindingId && b.generation === context.generation,
      );
      if (binding) {
        const background = z
          .string()
          .regex(/^#[a-fA-F0-9]{6}$/)
          .parse(c.background);
        feedback.set(binding.id, {
          runId: context.runId,
          generation: binding.generation,
          state: "custom",
          label: String(c.label).slice(0, 80),
          background,
        });
        configureDevice();
      }
      return null;
    }
    default:
      throw new Error(`Unknown main action: ${action}`);
  }
}
function startWorker(name: "runner" | "device", failures = 0) {
  const child = utilityProcess.fork(
    join(import.meta.dirname, `${name}.js`),
    [],
    { serviceName: `Decker ${name}`, stdio: "pipe" },
  );
  workers.set(name, { process: child, ready: false, failures });
  child.on("message", async (message) => {
    try {
      if (message.type === "ready") {
        const worker = workers.get(name);
        if (worker) worker.ready = true;
        configure();
        return;
      }
      if (name === "device") {
        if (message.type === "devices") {
          devices = message.devices;
          publish();
        } else if (message.type === "key") {
          if (message.down)
            triggers.down(message.id, message.key, page().keys[message.key]);
          else triggers.up(message.id, message.key);
        } else if (message.type === "disconnect")
          triggers.disconnect(message.id);
        else if (message.type === "diagnostic") diagnostic(message.error);
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
        if (record.bindingId) {
          const current = feedback.get(record.bindingId);
          if (
            !current ||
            current.runId === record.id ||
            record.status === "running"
          ) {
            feedback.set(record.bindingId, {
              ...current,
              runId: record.id,
              generation: record.generation!,
              state: record.status,
            });
            configureDevice();
            if (record.status !== "running")
              setTimeout(() => {
                const feedbackNow = feedback.get(record.bindingId!);
                if (
                  feedbackNow?.runId === record.id &&
                  !feedbackNow.label &&
                  !feedbackNow.background
                ) {
                  feedback.delete(record.bindingId!);
                  configureDevice();
                }
              }, 1500).unref();
          }
        }
        publish();
        persist();
      } else if (message.type === "capabilities") {
        capabilities = (message.capabilities as Snapshot["capabilities"]).map(
          (c) =>
            c.id === "obs"
              ? {
                  ...c,
                  available: document.connections.some((connection) =>
                    Boolean(
                      (
                        observed[`obs:${connection.id}`] as {
                          connected?: boolean;
                        }
                      )?.connected,
                    ),
                  ),
                  detail: document.connections.length
                    ? "OBS connection status is shown below."
                    : c.detail,
                }
              : c,
        );
        publish();
      } else if (message.type === "observed") {
        observed[message.id] = redact(
          message.value,
          Object.values(credentials.all()),
        );
        if (message.id.startsWith("obs:"))
          capabilities = capabilities.map((c) =>
            c.id === "obs"
              ? {
                  ...c,
                  available: Object.entries(observed).some(
                    ([key, value]) =>
                      key.startsWith("obs:") &&
                      Boolean((value as { connected?: boolean })?.connected),
                  ),
                  detail: "OBS connection status is shown below.",
                }
              : c,
          );
        configureDevice();
        publish();
      } else if (message.type === "error") diagnostic(message.error);
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
      diagnostic(error);
    }
  });
  child.stderr?.on("data", (chunk) => {
    diagnostic(String(chunk).slice(0, 2000));
  });
  child.on("exit", (code) => {
    workers.delete(name);
    if (quitting) return;
    if (name === "device") {
      triggers.disconnect();
      devices = [];
    } else {
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
    diagnostic(
      `${name} exited (${code}); ${failures < 3 ? "restarting" : "restart the application to retry"}`,
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
async function handle(raw: unknown) {
  const request = requestSchema.parse(raw);
  switch (request.type) {
    case "save": {
      const next = validateDocument(request.document);
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
      document = next;
      await store.save(document, runs);
      configure();
      return snapshot();
    }
    case "press":
      post("device", {
        type: "simulate",
        key: request.key,
        down: request.down,
      });
      return null;
    case "test":
      if (request.binding.press)
        post("runner", {
          type: "trigger",
          binding: request.binding,
          target: request.binding.press,
        });
      return null;
    case "run":
      post("runner", request);
      return null;
    case "cancel":
      post("runner", { type: "cancel", id: request.runId });
      return null;
    case "navigate":
      navigate(request.profileId, request.pageId);
      return snapshot();
    case "diagnose":
      post("runner", { type: "diagnose" });
      post("device", { type: "refresh" });
      return null;
    case "clearHistory":
      runs = runs.filter((r) => r.status === "running");
      persist();
      publish();
      return null;
    case "credential":
      await credentials.set(request.ref, request.value, request.persist);
      configure();
      return null;
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
      const next = validateImport(imported.document ?? imported);
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
      next.connections = next.connections.map(
        ({ credentialRef: _ref, ...c }) => c,
      );
      next.settings.launchAtLogin = document.settings.launchAtLogin;
      document = next;
      feedback.clear();
      await store.save(document, runs);
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
    if (loaded.warning) diagnostic(loaded.warning);
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
