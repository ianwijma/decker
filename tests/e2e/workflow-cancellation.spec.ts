import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, directory: string, page: Page;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-cancel-"));
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  // OBS capability exists before startup; keyboard diagnostics come from runner.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).capabilities.some(
          (c) => c.id === "keyboard",
        ),
      ),
    )
    .toBe(true);
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
async function fixture(kind: "workflow" | "action" | "sequence") {
  return page.evaluate(
    async ({ kind, marker }) => {
      const s = await window.decker.snapshot(),
        doc = s.document,
        workflow = doc.workflows[0],
        keys = doc.profiles[0].pages[0].keys,
        original = keys[2];
      const delay = {
          ...workflow.graph.nodes[1],
          id: "cancel-wait",
          name: "Long cancellation delay",
          config: { ms: 30000 },
          timeoutMs: 60000,
        },
        command = {
          ...delay,
          id: "never-command",
          name: "Command fixture",
          kind: "action" as const,
          config: {},
          action: {
            type: "command.run",
            version: 1 as const,
            config: {
              executable: "/bin/sh",
              args: JSON.stringify([
                "-c",
                'printf unexpected > "$1"',
                "fixture",
                marker,
              ]),
              cwd: "",
            },
          },
        },
        notification = {
          ...command,
          id: "never-notify",
          name: "Notification fixture",
          action: {
            type: "desktop.notify",
            version: 1 as const,
            config: {
              title: "Cancellation regression",
              body: "Must never run",
            },
          },
        };
      workflow.graph = {
        entry: delay.id,
        nodes: [delay, command, notification],
        edges: [
          { id: "later", source: delay.id, target: command.id, port: "next" },
          {
            id: "notify",
            source: command.id,
            target: notification.id,
            port: "next",
          },
        ],
      };
      const runAction = {
        type: "workflow.run",
        version: 1 as const,
        config: { workflowId: workflow.id },
      };
      original.appearance.label = "Run fixture";
      original.press =
        kind === "workflow"
          ? { kind, workflowId: workflow.id }
          : kind === "action"
            ? { kind, action: runAction }
            : {
                kind,
                actions: [
                  runAction,
                  {
                    type: "desktop.notify",
                    version: 1,
                    config: { title: "Sequence later", body: "Must never run" },
                  },
                ],
              };
      original.policy = "concurrent";
      original.limit = 4;
      keys[3] = {
        ...structuredClone(original),
        id: crypto.randomUUID(),
        appearance: { ...original.appearance, label: "Cancel fixture" },
        press: {
          kind: "action",
          action: {
            type: "workflow.cancel",
            version: 1,
            config: { workflowId: workflow.id },
          },
        },
      };
      await window.decker.request({ type: "save", document: doc });
      return {
        bindingId: original.id,
        deckId: doc.decks[0].id,
        background: original.appearance.background,
      };
    },
    { kind, marker: join(directory, "unexpected-effect") },
  );
}
for (const kind of ["workflow", "action", "sequence"] as const) {
  test(`Run button -> Cancel button aborts ${kind} delay and resets activity`, async () => {
    const { bindingId, background } = await fixture(kind);
    const run = page.getByRole("button", {
        name: "Key 3: Run fixture",
        exact: true,
      }),
      cancel = page.getByRole("button", {
        name: "Key 4: Cancel fixture",
        exact: true,
      });
    await run.dblclick();
    await expect(run).toHaveAttribute("aria-busy", "true");
    await cancel.dblclick();
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.decker.snapshot()).runs
              .filter((r) => r.bindingId === id)
              .at(-1)?.status,
          bindingId,
        ),
      )
      .toBe("cancelled");
    await expect(run).toHaveAttribute("aria-busy", "false");
    await expect(run).not.toHaveClass(/\brunning\b/);
    expect(
      await run.evaluate(
        (element) => (element as HTMLElement).style.backgroundColor,
      ),
    ).toBe("rgb(35, 36, 40)");
    const records = (
      await page.evaluate(() => window.decker.snapshot())
    ).runs.filter((r) => r.bindingId === bindingId);
    expect(records).toHaveLength(1);
    expect(
      records[0].nodes.some(
        (n) =>
          n.name === "Command fixture" || n.name === "Notification fixture",
      ),
    ).toBe(false);
    await expect(
      readFile(join(directory, "unexpected-effect")),
    ).rejects.toThrow(/ENOENT/);
    expect(background).toBe("#232428");
  });
}

test("a cancelled concurrent sibling keeps busy feedback; replacement rejects late completion", async () => {
  const { bindingId, deckId } = await fixture("workflow");
  const run = page.getByRole("button", {
    name: "Key 3: Run fixture",
    exact: true,
  });
  await run.dblclick();
  await run.dblclick();
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.decker.snapshot()).runs.filter(
            (r) => r.bindingId === id && r.status === "running",
          ).length,
        bindingId,
      ),
    )
    .toBe(2);
  const first = (await page.evaluate(() => window.decker.snapshot())).runs.find(
    (r) => r.bindingId === bindingId,
  )!;
  await page.evaluate(
    (runId) => window.decker.request({ type: "cancel", runId }),
    first.id,
  );
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.decker.snapshot()).runs.find((r) => r.id === id)
            ?.status,
        first.id,
      ),
    )
    .toBe("cancelled");
  await expect(run).toHaveAttribute("aria-busy", "true");
  await expect(run).toHaveClass(/\brunning\b/);
  const sibling = (
    await page.evaluate(() => window.decker.snapshot())
  ).runs.find((r) => r.bindingId === bindingId && r.status === "running")!;
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    doc.profiles[0].pages[0].keys[2].appearance.label = "Replacement";
    await window.decker.request({ type: "save", document: doc });
  });
  const replacement = page.getByRole("button", {
    name: "Key 3: Replacement",
    exact: true,
  });
  await expect(replacement).toHaveAttribute("aria-busy", "false");
  await page.evaluate(
    (runId) => window.decker.request({ type: "cancel", runId }),
    sibling.id,
  );
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.decker.snapshot()).runs.find((r) => r.id === id)
            ?.status,
        sibling.id,
      ),
    )
    .toBe("cancelled");
  await expect(replacement).toHaveAttribute("aria-busy", "false");
  expect(
    (await page.evaluate(() => window.decker.snapshot())).observed
      .buttonFeedback,
  ).toEqual({});
  expect(deckId).toBeTruthy();
});

test("runner interruption clears activity and a restarted runner accepts new runs without replay", async () => {
  const { bindingId } = await fixture("workflow");
  const run = page.getByRole("button", {
    name: "Key 3: Run fixture",
    exact: true,
  });
  await run.dblclick();
  await expect(run).toHaveAttribute("aria-busy", "true");
  const pid = await app.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((p) => p.name === "Decker runner")?.pid,
  );
  expect(pid).toBeTruthy();
  await app.evaluate((_electron, pid) => process.kill(pid!, "SIGKILL"), pid);
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.decker.snapshot()).runs.find((r) => r.bindingId === id)
            ?.status,
        bindingId,
      ),
    )
    .toBe("interrupted");
  await expect(run).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() =>
      app.evaluate(
        ({ app }, old) =>
          app
            .getAppMetrics()
            .some((p) => p.name === "Decker runner" && p.pid !== old),
        pid,
      ),
    )
    .toBe(true);
  // Ready follows process creation; wait for the service's diagnostic to clear.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.decker.snapshot()).health?.some(
          (h) => h.id === "worker:runner",
        ),
      ),
    )
    .toBe(false);
  await run.dblclick();
  await expect(run).toHaveAttribute("aria-busy", "true");
  await page
    .getByRole("button", { name: "Key 4: Cancel fixture", exact: true })
    .dblclick();
  await expect(run).toHaveAttribute("aria-busy", "false");
  const runs = (
    await page.evaluate(() => window.decker.snapshot())
  ).runs.filter((r) => r.bindingId === bindingId);
  expect(runs.map((r) => r.status)).toEqual(["interrupted", "cancelled"]);
  expect(
    runs.every((r) => r.nodes.every((n) => n.name !== "Command fixture")),
  ).toBe(true);
});

test("legacy appearance overrides survive cancellation on desktop", async () => {
  await fixture("sequence");
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    const key = doc.profiles[0].pages[0].keys[2];
    if (key.press?.kind !== "sequence")
      throw new Error("Missing fixture sequence");
    key.press.actions.unshift({
      type: "deck.appearance",
      version: 1,
      config: { label: "Legacy override", background: "#123456" },
    });
    await window.decker.request({ type: "save", document: doc });
  });
  await page
    .getByRole("button", { name: "Key 3: Run fixture", exact: true })
    .dblclick();
  const run = page.getByRole("button", {
    name: "Key 3: Legacy override",
    exact: true,
  });
  await expect(run).toHaveAttribute("aria-busy", "true");
  await page
    .getByRole("button", { name: "Key 4: Cancel fixture", exact: true })
    .dblclick();
  await expect(run).toHaveAttribute("aria-busy", "false");
  await expect(run).toHaveCSS("background-color", "rgb(18, 52, 86)");
  const feedback = (await page.evaluate(() => window.decker.snapshot()))
    .observed.buttonFeedback;
  expect(Object.values(feedback as object)).toContainEqual({
    label: "Legacy override",
    background: "#123456",
  });
});
