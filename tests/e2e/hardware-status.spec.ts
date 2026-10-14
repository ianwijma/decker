import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceStatus } from "../../src/shared/schema";

test("captured permission failure has truthful badges, device details and working Retry IPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decker-hardware-status-"));
  const executablePath = process.env.DECKER_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Deck: My XL", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Everything, a key away." }),
    ).toBeVisible();
    await page.evaluate(async () => {
      const snapshot = await window.decker.snapshot();
      const deck = snapshot.document.decks[0];
      deck.kind = "hardware";
      deck.hardwareId = "xl:TEST-SERIAL";
      deck.name = "Test XL";
      await window.decker.request({
        type: "save",
        document: snapshot.document,
      });
    });
    await expect(
      page.getByRole("button", { name: "Deck: Test XL", exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await window.decker.snapshot()).devices.some(
            (d) => d.id === "xl:TEST-SERIAL",
          ),
        ),
      )
      .toBe(true);
    const snapshot = await page.evaluate(() => window.decker.snapshot());
    // Inject captured/fake session evidence at the main-to-renderer boundary.
    // The synthetic configured serial is absent; no fake open can reach real HID.
    const denied: DeviceStatus = {
      id: "xl:TEST-SERIAL",
      name: "Stream Deck XL",
      simulated: false,
      present: true,
      configured: true,
      connected: false,
      state: "permission-denied",
      rows: 4,
      columns: 8,
      iconSize: 96,
      updatedAt: Date.now(),
      error: "Stream Deck XL: Permission denied",
      errorDetails: {
        stage: "open",
        code: "EACCES",
        errno: 13,
        message: "Permission denied",
        at: Date.now(),
      },
    };
    await app.evaluate(
      ({ BrowserWindow }, evidence) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const send = contents.send.bind(contents);
        const fixture = JSON.parse(evidence);
        // Keep the IPC fixture stable across the real worker's periodic empty
        // discovery reports until Retry is activated. Restoring before the
        // click can remove its button while Playwright is checking actionability.
        contents.send = (channel, ...args) => {
          if (channel === "decker:snapshot")
            send(channel, { ...args[0], devices: fixture.devices });
          else send(channel, ...args);
        };
        const context = globalThis as unknown as {
          restoreHardwareSnapshot: () => void;
        };
        context.restoreHardwareSnapshot = () => {
          contents.send = send;
        };
        send("decker:snapshot", fixture);
      },
      JSON.stringify({ ...snapshot, devices: [denied] }),
    );
    await expect(
      page.getByText("Permission required", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "Stream Deck XL: Permission denied",
    );
    const rail = page.getByRole("button", {
      name: "Deck: Test XL",
      exact: true,
    });
    await expect(rail).toHaveAttribute(
      "title",
      "Test XL · hardware · Permission required",
    );
    await expect(rail.locator(".deck-connection-dot")).not.toHaveClass(
      /connected/,
    );
    await expect(page.locator(".page-heading .status-dot")).toHaveCount(0);
    await page.screenshot({
      path: "test-results/hardware-permission.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Retry device", exact: true })
      .click();
    await app.evaluate(() => {
      (
        globalThis as unknown as { restoreHardwareSnapshot: () => void }
      ).restoreHardwareSnapshot();
    });
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const result = await page.evaluate(() => window.decker.snapshot());
    expect(result.devices.find((d) => d.id === denied.id)).toMatchObject({
      state: "disconnected",
      connected: false,
      configured: true,
    });
    expect(result.document.schemaVersion).toBe(4);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
