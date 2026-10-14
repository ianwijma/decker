import { describe, expect, it } from "vitest";
import { applyNodeChanges } from "@xyflow/react";
import { defaults, node } from "../src/shared/defaults";
import { makeAction } from "../src/shared/catalog";
import type { FlowNode, Snapshot } from "../src/shared/schema";
import {
  changedLayout,
  graphNodes,
  reconcileNodes,
} from "../src/renderer/src/flow-canvas";
import {
  createLatestFlowRunSelector,
  selectFlowWorkflows,
} from "../src/renderer/src/flow-selectors";

describe("flow canvas reconciliation", () => {
  it("retains measurements, multi-selection and active positions across cloned definitions and run updates", () => {
    const flow = defaults().workflows[0],
      source = graphNodes(flow.graph, flow.layout);
    const measured = applyNodeChanges(
      [
        {
          id: source[0].id,
          type: "dimensions",
          dimensions: { width: 215, height: 72 },
        },
        { id: source[0].id, type: "select", selected: true },
        { id: source[1].id, type: "select", selected: true },
        {
          id: source[0].id,
          type: "position",
          position: { x: 120, y: 240 },
          dragging: true,
        },
      ],
      source,
    );
    const incoming = structuredClone(source);
    incoming[0].data.status = "running";
    const merged = reconcileNodes(measured, incoming, source, source[1].id);
    expect(merged[0]).toMatchObject({
      measured: { width: 215, height: 72 },
      position: { x: 120, y: 240 },
      dragging: true,
      selected: true,
      data: { status: "running" },
    });
    expect(merged[1]).toBe(measured[1]);
    expect(merged[1].selected).toBe(true);
    const stopped = applyNodeChanges(
      [{ id: source[0].id, type: "position", dragging: false }],
      merged,
    );
    expect(reconcileNodes(stopped, source, source, "")[0].position).toEqual({
      x: 120,
      y: 240,
    });
    const edited = structuredClone(source);
    edited[0].position = { x: 500, y: 600 };
    expect(reconcileNodes(stopped, edited, source, "")[0]).toMatchObject({
      position: { x: 500, y: 600 },
      measured: { width: 215, height: 72 },
      selected: true,
    });
    expect(reconcileNodes(measured, edited, source, "")[0].position).toEqual({
      x: 120,
      y: 240,
    });
  });

  it("adds and removes definitions without bringing deleted nodes back or persisting measurement/selection", () => {
    const flow = defaults().workflows[0],
      source = graphNodes(flow.graph, flow.layout);
    const changed = applyNodeChanges(
      [
        {
          id: source[0].id,
          type: "dimensions",
          dimensions: { width: 215, height: 72 },
        },
        { id: source[0].id, type: "select", selected: true },
      ],
      source,
    );
    expect(changedLayout(changed, flow.layout)).toEqual([]);
    const incoming = source.slice(1),
      extra = { ...source[0], id: "added" };
    const merged = reconcileNodes(
      changed,
      [...incoming, extra],
      source,
      "added",
    );
    expect(merged.map((n) => n.id)).toEqual([
      source[1].id,
      source[2].id,
      "added",
    ]);
    expect(merged.at(-1)?.selected).toBe(true);
    expect(
      changedLayout(
        [
          { ...source[1], position: { x: 9, y: 8 } },
          { ...source[2], position: { x: 7, y: 6 } },
        ],
        flow.layout,
      ),
    ).toHaveLength(2);
  });

  it.each<FlowNode["kind"]>([
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
  ])(
    "preserves %s ports and positions without modifying nested definitions",
    (kind) => {
      const n = node(kind, kind);
      if (kind === "switch") n.config = { cases: ["ready", 7] };
      if (kind === "action") n.action = makeAction("desktop.copy");
      if (["repeat", "foreach"].includes(kind))
        n.body = {
          entry: "inner",
          nodes: [{ ...node("set", "Inner"), id: "inner" }],
          edges: [],
        };
      if (kind === "parallel")
        n.branches = [
          {
            entry: "inner",
            nodes: [{ ...node("set", "Inner"), id: "inner" }],
            edges: [],
          },
        ];
      const graph = { entry: n.id, nodes: [n], edges: [] },
        before = structuredClone(graph);
      const result = graphNodes(graph, { [n.id]: { x: 12, y: 34 } })[0];
      expect(result.position).toEqual({ x: 12, y: 34 });
      expect(result.data.ports).toEqual(
        kind === "switch"
          ? ["ready", "7", "default", "error"]
          : kind === "condition"
            ? ["true", "false", "error"]
            : kind === "return"
              ? []
              : ["next", "error"],
      );
      expect(result.data.icon).toBeTruthy();
      expect(graph).toEqual(before);
    },
  );
});

it("canvas selectors ignore device/observed clones while delivering workflow and run edits", () => {
  const snapshot: Snapshot = {
    document: defaults(),
    devices: [],
    runs: [],
    capabilities: [],
    observed: {},
    secureStorage: false,
    web: { running: false, port: 9018, urls: [], clients: [], pending: [] },
  };
  const selectRun = createLatestFlowRunSelector(
    snapshot.document.workflows[0].id,
  );
  const workflows = selectFlowWorkflows({ snapshot }),
    runs = selectRun({ snapshot });
  const incoming = structuredClone(snapshot);
  incoming.observed = { synthetic: 1 };
  expect(selectFlowWorkflows({ snapshot: incoming })).toBe(workflows);
  expect(selectRun({ snapshot: incoming })).toBe(runs);
  incoming.document.workflows[0].name = "Edited workflow";
  expect(selectFlowWorkflows({ snapshot: incoming })[0].name).toBe(
    "Edited workflow",
  );
  incoming.runs.push({
    id: "run",
    workflowId: snapshot.document.workflows[0].id,
    workflowName: "Welcome",
    revision: 1,
    startedAt: 1,
    status: "running",
    nodes: [],
  });
  expect(selectRun({ snapshot: incoming })).not.toBe(runs);
  const latest = selectRun({ snapshot: incoming });
  incoming.runs.push({
    ...incoming.runs[0],
    id: "other-run",
    workflowId: "another-workflow",
  });
  expect(selectRun({ snapshot: incoming })).toBe(latest);
  expect(incoming.devices).toEqual(snapshot.devices);
});
