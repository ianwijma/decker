import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, directory: string;
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await app.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => false;
  });
  await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot();
    await window.decker.request({ type: "save", document: snapshot.document });
  });
  return page;
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-managed-e2e-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

test("inline connection and HTTP secrets survive editing without exposing values, share safely, and become missing after session restart", async () => {
  let page = await launch();
  await page.getByRole("button", { name: "Add OBS" }).click();
  const password = page.getByRole("group", {
    name: "OBS password",
    exact: true,
  });
  await expect(
    password.getByRole("button", { name: "Save secret", exact: true }),
  ).toBeDisabled();
  await password
    .getByLabel("OBS password entry", { exact: true })
    .fill("synthetic-inline-password");
  await password
    .getByRole("button", { name: "Save secret", exact: true })
    .click();
  await expect(
    password.getByLabel("OBS password entry", { exact: true }),
  ).toHaveValue("");
  await expect(password.getByRole("status")).toContainText("Session-only");
  const refs = await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot(),
      doc = snapshot.document,
      c = doc.connections[0];
    doc.connections.push({ ...c, id: "second-connection", name: "Second OBS" });
    const binding = doc.profiles[0].pages[0].keys[0];
    binding.press = {
      kind: "action",
      action: {
        type: "http.request",
        version: 1,
        config: {
          url: "http://127.0.0.1:65534",
          method: "GET",
          body: "",
          credentialRef: c.credentialRef!,
        },
      },
    };
    await window.decker.request({ type: "save", document: doc });
    return { original: c.credentialRef, connectionId: c.id };
  });
  expect(refs.original).toMatch(/^managed:/);
  const first = page.locator(".connection").first();
  await first
    .getByRole("button", { name: "Remove secret", exact: true })
    .click();
  await expect(first.getByRole("status")).toContainText("Missing");
  await expect(
    page.locator(".connection").nth(1).getByRole("status"),
  ).toContainText("Session-only");
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await page
    .getByRole("button", { name: "Key 1: Open browser", exact: true })
    .click();
  const bearer = page.getByRole("group", { name: "Bearer token", exact: true });
  await expect(bearer.getByRole("status")).toContainText("Session-only");
  await bearer
    .getByLabel("Bearer token entry", { exact: true })
    .fill("synthetic-inline-bearer");
  await bearer
    .getByRole("button", { name: "Replace secret", exact: true })
    .click();
  await expect(
    bearer.getByLabel("Bearer token entry", { exact: true }),
  ).toHaveValue("");
  const serialized = await page.evaluate(async () =>
    JSON.stringify(await window.decker.snapshot()),
  );
  expect(serialized).not.toContain("synthetic-inline");
  const state = JSON.parse(serialized);
  expect(state.document.connections[1].credentialRef).toBe(refs.original);
  expect(
    state.document.profiles[0].pages[0].keys[0].press.action.config
      .credentialRef,
  ).not.toBe(refs.original);
  for (const file of (await readdir(directory)).filter((f) =>
    f.endsWith(".json"),
  ))
    expect(await readFile(join(directory, file), "utf8")).not.toContain(
      "synthetic-inline",
    );
  await app.close();
  page = await launch();
  await expect(
    page.locator(".connection").nth(1).getByRole("status"),
  ).toContainText("Missing");
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await page
    .getByRole("button", { name: "Key 1: Open browser", exact: true })
    .click();
  await expect(
    page
      .getByRole("group", { name: "Bearer token", exact: true })
      .getByRole("status"),
  ).toContainText("Missing");
});

test("desktop IPC rejects stale/deleted owners, direct ref mutation and competing updates without attaching to another owner", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Add OBS" }).click();
  await expect(page.locator(".connection")).toHaveCount(1);
  const results = await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot(),
      c = snapshot.document.connections[0],
      owner = JSON.stringify(["connection", c.id]);
    const request = {
      type: "credential" as const,
      owner,
      epoch: snapshot.credentialState!.epoch,
      operation: "set" as const,
      value: "synthetic-race-token",
      persist: false,
    };
    const results = await Promise.allSettled([
      window.decker.request(request),
      window.decker.request(request),
    ]);
    const after = await window.decker.snapshot();
    const malformed = await window.decker
      .request({
        ...request,
        epoch: after.credentialState!.epoch,
        ref: "unrelated",
      } as typeof request)
      .then(
        () => false,
        () => true,
      );
    const deletedDoc = structuredClone(after.document);
    deletedDoc.connections = [];
    await window.decker.request({ type: "save", document: deletedDoc });
    const stale = await window.decker
      .request({ ...request, epoch: after.credentialState!.epoch })
      .then(
        () => false,
        () => true,
      );
    const current = await window.decker.snapshot();
    const deleted = await window.decker
      .request({ ...request, epoch: current.credentialState!.epoch })
      .then(
        () => false,
        () => true,
      );
    return {
      statuses: results.map((r) => r.status),
      malformed,
      stale,
      deleted,
      snapshot: JSON.stringify(current),
    };
  });
  expect(results.statuses).toEqual(["fulfilled", "rejected"]);
  expect(results.malformed).toBe(true);
  expect(results.stale).toBe(true);
  expect(results.deleted).toBe(true);
  expect(results.snapshot).not.toContain("synthetic-race-token");
});
