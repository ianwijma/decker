import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, directory: string;
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
test("shows independent repair guidance, copies fixed text, retries and recovers", async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-diagnostics-"));
  app = await electron.launch({
    ...(process.env.DECKER_EXECUTABLE
      ? { executablePath: process.env.DECKER_EXECUTABLE }
      : {}),
    args: [...(process.env.DECKER_EXECUTABLE ? [] : ["."]), "--no-sandbox"],
    env: {
      ...process.env,
      DECKER_DATA_DIR: directory,
      PATH: directory,
      XDG_SESSION_TYPE: "x11",
      WAYLAND_DISPLAY: "",
    },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace health" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).health?.some((r) => r.id === "obs"),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Recheck", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).capabilities.find(
            (c) => c.id === "keyboard",
          )?.remedy,
      ),
    )
    .toBe("keyboard-tool");
  await page
    .getByRole("article", { name: "Keyboard input" })
    .getByRole("button", { name: "Copy repair text" })
    .click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    "sudo apt install xdotool",
  );
  expect(
    await page.evaluate(async () => {
      try {
        await window.decker.request({
          type: "diagnosticRemedy",
          healthId: "unknown; arbitrary text",
          action: "copy",
        });
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  // Mock desktop/hardware observations and IPC handlers. Never open real HID.
  const fixture = await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot();
    snapshot.health = undefined;
    snapshot.capabilities = [
      {
        id: "keyboard",
        available: false,
        detail: "xdotool is missing.",
        state: "unavailable",
        remedy: "keyboard-tool",
        distribution: "pop",
      },
    ];
    snapshot.devices = [
      {
        id: "xl:TEST-SERIAL",
        name: "Test XL",
        present: true,
        configured: true,
        connected: false,
        state: "permission-denied",
        updatedAt: 1,
        simulated: false,
        rows: 4,
        columns: 8,
        iconSize: 96,
        errorDetails: {
          stage: "open",
          message: "Permission denied password=never-show",
          code: "EACCES",
          errno: 13,
          at: 1,
        },
      },
    ];
    snapshot.document.connections = [
      { id: "test-obs", name: "Test OBS", url: "ws://localhost:4455" },
    ];
    snapshot.observed = {
      "obs:test-obs": {
        connected: false,
        error: "Connection refused token=hidden",
      },
    };
    return snapshot;
  });
  await app.evaluate(({ BrowserWindow, ipcMain }, serialized) => {
    const context = globalThis as unknown as {
      diagnosticRequests: unknown[];
      diagnosticSnapshot: import("../../src/shared/schema").Snapshot;
      emitDiagnostics: (fixture: string) => void;
    };
    context.diagnosticRequests = [];
    context.diagnosticSnapshot = JSON.parse(serialized);
    ipcMain.removeHandler("decker:snapshot");
    ipcMain.handle("decker:snapshot", () => context.diagnosticSnapshot);
    ipcMain.removeHandler("decker:request");
    ipcMain.handle("decker:request", (_event, request) => {
      context.diagnosticRequests.push(request);
      return null;
    });
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
      if (channel === "decker:snapshot")
        send(channel, context.diagnosticSnapshot);
      else send(channel, ...args);
    };
    context.emitDiagnostics = (fixture) => {
      context.diagnosticSnapshot = JSON.parse(fixture);
      send("decker:snapshot", context.diagnosticSnapshot);
    };
    context.emitDiagnostics(serialized);
  }, JSON.stringify(fixture));
  const hardware = page.getByRole("article", { name: "Test XL", exact: true });
  await expect(hardware).toContainText("Permission required");
  const keyboard = page.getByRole("article", {
    name: "Keyboard input",
    exact: true,
  });
  await expect(keyboard).toContainText("sudo apt install xdotool");
  await expect(
    page.getByRole("article", { name: "OBS · Test OBS" }),
  ).toContainText("Connection refused");
  await hardware.getByRole("button", { name: "Copy repair text" }).click();
  await hardware.getByRole("button", { name: "Retry", exact: true }).click();
  await keyboard.getByRole("button", { name: "Retry", exact: true }).click();
  await hardware.getByText("Feature details", { exact: true }).click();
  await expect(hardware).not.toContainText("never-show");
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { diagnosticRequests: unknown[] })
          .diagnosticRequests,
    ),
  ).toEqual([
    {
      type: "diagnosticRemedy",
      healthId: "device:xl:TEST-SERIAL",
      action: "copy",
    },
    { type: "retryDevice", hardwareId: "xl:TEST-SERIAL" },
    { type: "diagnose" },
  ]);
  fixture.devices[0] = {
    ...fixture.devices[0],
    state: "ready",
    connected: true,
    errorDetails: undefined,
  };
  await app.evaluate(
    (_electron, serialized) =>
      (
        globalThis as unknown as { emitDiagnostics: (fixture: string) => void }
      ).emitDiagnostics(serialized),
    JSON.stringify(fixture),
  );
  await expect(hardware).toContainText("Ready");
  await expect(
    hardware.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "OBS · Test OBS" }),
  ).toContainText("Connection refused");
});
