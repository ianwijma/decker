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
  const draft = page.getByRole("group", {
    name: "New OBS connection",
    exact: true,
  });
  await expect(
    draft.getByRole("button", { name: "Save connection", exact: true }),
  ).toBeDisabled();
  await draft
    .getByLabel("OBS password entry", { exact: true })
    .fill("synthetic-inline-password");
  await draft
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  const password = page
    .locator(".connection")
    .first()
    .getByRole("group", { name: "OBS password", exact: true });
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
  // The direct fixture save returns before its published renderer snapshot.
  // Wait for that current epoch before exercising the protected owner control.
  await expect(page.locator(".connection")).toHaveCount(2);
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
  await page.getByLabel("Password choice").selectOption("none");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
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

test("cancels queued navigation while an import dialog holds the credential/document save queue", async () => {
  const page = await launch();
  const workflowId = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document,
      workflow = doc.workflows[0];
    doc.profiles[0].pages.push({
      id: "queued-target-page",
      name: "Queued target",
      keys: {},
    });
    const action = structuredClone(workflow.graph.nodes[0]);
    action.kind = "action";
    action.name = "Queued navigation";
    action.action = {
      type: "deck.page",
      version: 1,
      config: { pageId: "queued-target-page" },
    };
    workflow.name = "Queued navigation";
    workflow.graph = { entry: action.id, nodes: [action], edges: [] };
    await window.decker.request({ type: "save", document: doc });
    return workflow.id;
  });
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (() =>
      new Promise((resolve) => {
        (globalThis as unknown as { secretDialog: () => void }).secretDialog =
          () => resolve({ canceled: true, filePaths: [] });
      })) as typeof dialog.showOpenDialog;
  });
  await page.evaluate(() => {
    void window.decker.request({ type: "import" });
  });
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(
          (globalThis as unknown as { secretDialog?: unknown }).secretDialog,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(
    (workflowId) =>
      window.decker.request({ type: "run", workflowId, inputs: {} }),
    workflowId,
  );
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).runs.some(
          (r) =>
            r.workflowName === "Queued navigation" &&
            r.nodes.length &&
            r.status === "running",
        ),
      ),
    )
    .toBe(true);
  const runId = await page.evaluate(
    async () =>
      (await window.decker.snapshot()).runs.find(
        (r) => r.workflowName === "Queued navigation",
      )!.id,
  );
  await page.evaluate(
    (runId) => window.decker.request({ type: "cancel", runId }),
    runId,
  );
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.decker.snapshot()).runs.find(
            (r) => r.workflowName === "Queued navigation",
          )?.status,
      ),
    )
    .toBe("cancelled");
  await app.evaluate(() =>
    (globalThis as unknown as { secretDialog: () => void }).secretDialog(),
  );
  // Saving after the queued main action flushes the mutation queue. Navigation
  // preservation would retain a late page change, so this checks the actual host.
  const activePage = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    await window.decker.request({ type: "save", document: doc });
    return (await window.decker.snapshot()).document.decks[0].activePageId;
  });
  expect(activePage).toBe("home");
});
