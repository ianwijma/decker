import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { node } from "../../src/shared/defaults";
import { makeAction } from "../../src/shared/catalog";
import type {
  FlowNode,
  Snapshot,
  WorkflowDefinition,
} from "../../src/shared/schema";

let app: ElectronApplication, directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-canvas-"));
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

async function openFlow() {
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  return page;
}
async function inject(
  snapshot: Snapshot,
  iteration: number,
  runUpdates = false,
) {
  await app.evaluate(
    ({ BrowserWindow }, { json, iteration, runUpdates }) => {
      const snapshot = JSON.parse(json);
      const workflow = snapshot.document.workflows[0];
      BrowserWindow.getAllWindows()[0].webContents.send("decker:snapshot", {
        ...snapshot,
        devices: snapshot.devices.map((d: Record<string, unknown>) => ({
          ...d,
          connected: iteration % 2 === 0,
        })),
        observed: { ...snapshot.observed, canvasTest: iteration },
        ...(runUpdates
          ? {
              runs: [
                {
                  id: "canvas-run",
                  workflowId: workflow.id,
                  workflowName: workflow.name,
                  revision: workflow.revision,
                  startedAt: 1,
                  status: "running",
                  nodes: [
                    {
                      id: "execution",
                      nodeId: workflow.graph.nodes[0].id,
                      status: iteration % 2 === 0 ? "running" : "success",
                      startedAt: 1,
                    },
                  ],
                },
              ],
            }
          : {}),
      });
    },
    { json: JSON.stringify(snapshot), iteration, runUpdates },
  );
}
function definition(id: string, nodes: FlowNode[]): WorkflowDefinition {
  return {
    id,
    name: id,
    revision: 1,
    inputs: [],
    outputs: [],
    timeoutMs: 300000,
    graph: { entry: nodes[0].id, nodes, edges: [] },
    layout: Object.fromEntries(
      nodes.map((n, i) => [
        n.id,
        { x: 60 + (i % 3) * 270, y: 100 + Math.floor(i / 3) * 160 },
      ]),
    ),
  };
}
async function seed(page: Page, workflows: WorkflowDefinition[]) {
  await page.evaluate(async (json) => {
    const snapshot = await window.decker.snapshot();
    snapshot.document.workflows = JSON.parse(json);
    await window.decker.request({ type: "save", document: snapshot.document });
  }, JSON.stringify(workflows));
}
async function drag(
  page: Page,
  id: string,
  dx: number,
  dy: number,
  workflowId = "welcome",
) {
  const element = page.locator(`.react-flow__node[data-id="${id}"]`);
  const box = (await element.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 12 },
  );
  await page.mouse.up();
  const dropped = await element.evaluate(
    (node) => (node as HTMLElement).style.transform,
  );
  // The save indicator can still show the preceding render immediately after
  // pointer-up. Wait for this drop's layout before leaving a workflow or scope.
  await expect
    .poll(async () => {
      const position = (await layout(page, workflowId))[id];
      if (!position) return undefined;
      // Compare the exact CSS representation, which rounds fractional coordinates.
      return page.evaluate((position) => {
        const style = document.createElement("div").style;
        style.transform = `translate(${position.x}px, ${position.y}px)`;
        return style.transform;
      }, position);
    })
    .toBe(dropped);
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
}
async function layout(page: Page, workflowId = "welcome") {
  return page.evaluate(
    async (id) =>
      (await window.decker.snapshot()).document.workflows.find(
        (f) => f.id === id,
      )!.layout,
    workflowId,
  );
}

test("measured minimap nodes remain visible during incoming snapshots", async () => {
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  for (let i = 0; i < 10; i++) {
    await app.evaluate(
      ({ BrowserWindow }, { json, i }) => {
        const snapshot = JSON.parse(json);
        BrowserWindow.getAllWindows()[0].webContents.send("decker:snapshot", {
          ...snapshot,
          observed: { ...snapshot.observed, canvasTest: i },
        });
      },
      { json: JSON.stringify(snapshot), i },
    );
    await page.waitForTimeout(40);
  }
  await page.screenshot({
    path: test.info().outputPath("snapshot-minimap.png"),
  });
  const rectangles = await page
    .locator(".react-flow__minimap-node")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        width: Number(node.getAttribute("width")),
        height: Number(node.getAttribute("height")),
      })),
    );
  expect(rectangles).toHaveLength(3);
  for (const rectangle of rectangles) {
    expect(rectangle.width).toBeGreaterThan(0);
    expect(rectangle.height).toBeGreaterThan(0);
  }
});

test("dragging stays painted under device and run snapshots, saves on drop, and survives relaunch", async () => {
  let page = await openFlow();
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  const flow = snapshot.document.workflows[0],
    id = flow.graph.nodes[0].id;
  const before = await layout(page);
  const viewport = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.screenshot({ path: test.info().outputPath("drag-before.png") });
  await page.evaluate((id) => {
    const frames: Array<{
      x: number;
      y: number;
      visible: boolean;
      rectangles: number;
    }> = [];
    (window as unknown as { canvasFrames: typeof frames }).canvasFrames =
      frames;
    function sample() {
      const element = document.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${id}"]`,
      );
      const rect = element?.getBoundingClientRect(),
        style = element && getComputedStyle(element);
      frames.push({
        x: rect?.x ?? -1,
        y: rect?.y ?? -1,
        visible:
          !!rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          style?.visibility !== "hidden" &&
          style?.display !== "none" &&
          Number(style?.opacity) > 0,
        rectangles: document.querySelectorAll(".react-flow__minimap-node")
          .length,
      });
      if (frames.length < 600) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, id);
  const box = (await page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(start.x + i * 5, start.y + i * 4);
    await inject(snapshot, i, true);
    await page.waitForTimeout(35);
    expect(await layout(page)).toEqual(before);
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    if (i === 8)
      await page.screenshot({
        path: test.info().outputPath("drag-midpoint.png"),
      });
  }
  await page.mouse.up();
  await expect
    .poll(async () => (await layout(page))[id].x)
    .toBeGreaterThan(before[id].x + 40);
  const saved = await layout(page);
  await inject(await page.evaluate(() => window.decker.snapshot()), 100);
  const frames = await page.evaluate(
    () =>
      (
        window as unknown as {
          canvasFrames: Array<{
            x: number;
            y: number;
            visible: boolean;
            rectangles: number;
          }>;
        }
      ).canvasFrames,
  );
  const framesPath = test.info().outputPath("drag-frame-observations.json");
  await writeFile(framesPath, JSON.stringify(frames, null, 2));
  await test.info().attach("drag-frame-observations", {
    path: framesPath,
    contentType: "application/json",
  });
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(3);
  const rectangles = await page
    .locator(".react-flow__minimap-node")
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        x: Number(n.getAttribute("x")),
        y: Number(n.getAttribute("y")),
      })),
    );
  expect(rectangles).toEqual(flow.graph.nodes.map((n) => saved[n.id]));
  expect(
    await page.locator(".react-flow__viewport").getAttribute("style"),
  ).toBe(viewport);
  expect(frames.length).toBeGreaterThan(20);
  expect(frames.every((f) => f.visible && f.rectangles === 3)).toBe(true);
  for (let i = 1; i < frames.length; i++) {
    expect(frames[i].x).toBeGreaterThanOrEqual(frames[i - 1].x - 1);
    expect(frames[i].y).toBeGreaterThanOrEqual(frames[i - 1].y - 1);
  }
  await page.screenshot({ path: test.info().outputPath("drag-after.png") });
  await app.close();
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  page = await openFlow();
  expect(await layout(page)).toEqual(saved);
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(3);
});

test("multi-selection drags every node, persists keyboard moves, and deletes connected nodes", async () => {
  const page = await openFlow(),
    snapshot = await page.evaluate(() => window.decker.snapshot());
  const [first, second, third] = snapshot.document.workflows[0].graph.nodes;
  const before = await layout(page);
  await page.locator(`.react-flow__node[data-id="${first.id}"]`).click();
  await page
    .locator(`.react-flow__node[data-id="${second.id}"]`)
    .click({ modifiers: ["Control"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await inject(snapshot, 1);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await drag(page, first.id, 40, 55);
  await expect
    .poll(async () => (await layout(page))[second.id].y)
    .toBeGreaterThan(before[second.id].y + 20);
  const moved = await layout(page);
  expect(moved[first.id].x - before[first.id].x).toBeCloseTo(
    moved[second.id].x - before[second.id].x,
    5,
  );
  expect(moved[third.id]).toEqual(before[third.id]);
  await page.locator(`.react-flow__node[data-id="${first.id}"]`).focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await layout(page))[first.id].x)
    .toBe(moved[first.id].x + 5);
  await page.keyboard.press("Backspace");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  // The canvas updates optimistically; connected-edge and node deletions save
  // through the serialized queue. Check the complete saved state after both.
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() => window.decker.snapshot());
      const workflow = saved.document.workflows[0];
      return {
        nodes: workflow.graph.nodes.map((n) => n.id),
        edges: workflow.graph.edges,
        layout: Object.keys(workflow.layout),
      };
    })
    .toEqual({ nodes: [third.id], edges: [], layout: [third.id] });
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openFlow();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toHaveAttribute(
    "data-id",
    third.id,
  );
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(1);
  expect(Object.keys(await layout(page))).toEqual([third.id]);
});

test("workflow switches and nested scopes reset canvas state and keep saved positions", async () => {
  const page = await app.firstWindow();
  const shared = { ...node("set", "Shared ID"), id: "shared-node" };
  const repeat = node("repeat", "Repeat"),
    foreach = node("foreach", "For each"),
    parallel = node("parallel", "Parallel");
  const inner = node("set", "Inner result"),
    branch1 = node("set", "Branch one"),
    branch2 = node("set", "Branch two");
  repeat.body = { entry: inner.id, nodes: [inner], edges: [] };
  foreach.body = {
    entry: "foreach-body",
    nodes: [{ ...inner, id: "foreach-body" }],
    edges: [],
  };
  parallel.branches = [branch1, branch2].map((n) => ({
    entry: n.id,
    nodes: [n],
    edges: [],
  }));
  const a = definition("Scope A", [shared, repeat, foreach, parallel]),
    b = definition("Scope B", [{ ...shared }]);
  b.layout[shared.id] = { x: 500, y: 350 };
  await seed(page, [a, b]);
  await openFlow();
  await drag(page, shared.id, 45, 30, a.id);
  const savedA = await layout(page, a.id);
  await page.getByRole("button", { name: /Scope B$/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toHaveAttribute(
    "style",
    /translate\(500px, 350px\)/,
  );
  await drag(page, shared.id, 20, 30, b.id);
  const savedB = await layout(page, b.id);
  await page.getByRole("button", { name: /Scope A$/ }).click();
  expect(await layout(page, a.id)).toEqual(savedA);
  for (const [parent, button, child] of [
    [repeat.id, "Edit loop body →", inner.id],
    [foreach.id, "Edit loop body →", "foreach-body"],
    [parallel.id, "Edit branch 1 →", branch1.id],
    [parallel.id, "Edit branch 2 →", branch2.id],
  ]) {
    await page.locator(`.react-flow__node[data-id="${parent}"]`).click();
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await expect(page.locator(".react-flow__node")).toHaveAttribute(
      "data-id",
      child,
    );
    await drag(page, child, 30, 40, a.id);
    const childPosition = (await layout(page, a.id))[child];
    await page
      .getByRole("button", { name: "Parent flow", exact: true })
      .click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await page.locator(`.react-flow__node[data-id="${parent}"]`).click();
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveAttribute(
      "style",
      new RegExp(`translate\\(${childPosition.x}px, ${childPosition.y}px\\)`),
    );
    await page
      .getByRole("button", { name: "Parent flow", exact: true })
      .click();
  }
  expect(await layout(page, b.id)).toEqual(savedB);
  await page.screenshot({ path: test.info().outputPath("nested-scopes.png") });
});

test("all node kinds retain their ports and dynamic switch cases connect after JSON edits", async () => {
  const page = await app.firstWindow();
  const kinds: FlowNode["kind"][] = [
    "trigger",
    "delay",
    "condition",
    "switch",
    "set",
    "parallel",
    "repeat",
    "foreach",
    "subflow",
    "return",
    "action",
  ];
  const nodes = kinds.map((kind) => node(kind, kind));
  nodes[3].config = { value: "ready", cases: ["ready", "waiting"] };
  nodes[10].action = makeAction("desktop.copy");
  await seed(page, [definition("Ports", nodes)]);
  await openFlow();
  await expect(page.locator(".react-flow__node")).toHaveCount(11);
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(11);
  for (const n of nodes) {
    const element = page.locator(`.react-flow__node[data-id="${n.id}"]`);
    await expect(element.locator(".react-flow__handle.target")).toHaveCount(1);
    const expected =
      n.kind === "condition"
        ? ["true", "false", "error"]
        : n.kind === "switch"
          ? ["ready", "waiting", "default", "error"]
          : n.kind === "return"
            ? []
            : ["next", "error"];
    expect(
      await element
        .locator(".react-flow__handle.source")
        .evaluateAll((handles) =>
          handles.map((h) => h.getAttribute("data-handleid")),
        ),
    ).toEqual(expected);
  }
  const switchNode = page.locator(
    `.react-flow__node[data-id="${nodes[3].id}"]`,
  );
  await switchNode.click();
  await page
    .getByRole("textbox", { name: "Configuration", exact: true })
    .fill(
      JSON.stringify({ value: "third", cases: ["first", "second", "third"] }),
    );
  await page.getByRole("textbox", { name: "Node name", exact: true }).click();
  await expect(switchNode.locator(".react-flow__handle.source")).toHaveCount(5);
  for (const port of ["third", "default", "error"]) {
    await switchNode
      .locator(`[data-handleid="${port}"]`)
      .dragTo(
        page.locator(
          `.react-flow__node[data-id="${nodes[4].id}"] .react-flow__handle.target`,
        ),
      );
  }
  await expect
    .poll(async () =>
      (
        await page.evaluate(() => window.decker.snapshot())
      ).document.workflows[0].graph.edges.map((e) => e.port),
    )
    .toEqual(["third", "default", "error"]);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath("all-node-ports.png") });
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(1);
});

test("zoom, pane pan and minimap pan stay stable under incoming snapshots", async () => {
  const page = await openFlow();
  const viewport = page.locator(".react-flow__viewport"),
    initial = await viewport.getAttribute("style");
  await page.getByRole("button", { name: /zoom out/i }).click();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(initial);
  const canvas = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(canvas.x + 150, canvas.y + 70);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 210, canvas.y + 110, { steps: 10 });
  await page.mouse.up();
  const panned = await viewport.getAttribute("style");
  const snapshot = await page.evaluate(() => window.decker.snapshot());
  for (let i = 0; i < 8; i++) {
    await inject(snapshot, i);
    await page.waitForTimeout(30);
  }
  expect(await viewport.getAttribute("style")).toBe(panned);
  const minimap = (await page
    .locator(".react-flow__minimap-svg")
    .boundingBox())!;
  await page.mouse.move(minimap.x + 80, minimap.y + 60);
  await page.mouse.down();
  await page.mouse.move(minimap.x + 105, minimap.y + 80, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(panned);
  const beforeZoom = await viewport.getAttribute("style");
  await page.mouse.wheel(0, -160);
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforeZoom);
  await page.screenshot({ path: test.info().outputPath("zoom-and-pan.png") });
});
