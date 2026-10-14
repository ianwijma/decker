import type { Node } from "@xyflow/react";
import type {
  FlowNode,
  Graph,
  RunRecord,
  WorkflowDefinition,
} from "../../shared/schema";
import { actionById } from "../../shared/catalog";

export type FlowData = {
  name: string;
  kind: string;
  ports: string[];
  status?: string;
  icon: string;
};
export type FlowCanvasNode = Node<FlowData>;
const icons: Partial<Record<FlowNode["kind"], string>> = {
  trigger: "ϟ",
  delay: "◷",
  condition: "◇",
  switch: "⋔",
  set: "{}",
  parallel: "⑂",
  repeat: "↻",
  foreach: "↻",
  subflow: "⤷",
  return: "↵",
};
export function graphNodes(
  graph: Graph,
  layout: WorkflowDefinition["layout"],
  latest?: RunRecord,
): FlowCanvasNode[] {
  return graph.nodes.map((n, index) => ({
    id: n.id,
    type: "workflow",
    position: layout[n.id] ?? { x: 60 + index * 270, y: 120 },
    data: {
      name: n.name,
      kind: n.kind,
      icon: n.action
        ? (actionById(n.action.type)?.icon ?? "✦")
        : (icons[n.kind] ?? "✦"),
      status: latest?.nodes.filter((x) => x.nodeId === n.id).at(-1)?.status,
      ports:
        n.kind === "condition"
          ? ["true", "false", "error"]
          : n.kind === "switch"
            ? [
                ...(Array.isArray(n.config.cases)
                  ? n.config.cases.map(String)
                  : []),
                "default",
                "error",
              ]
            : n.kind === "return"
              ? []
              : ["next", "error"],
    },
  }));
}
export function samePosition(a: Node["position"], b: Node["position"]) {
  return a.x === b.x && a.y === b.y;
}

// Reconcile document edits without discarding React Flow's measured dimensions,
// multi-selection, or in-flight positions. Unchanged saved layout is not a drag reset.
export function reconcileNodes(
  previous: FlowCanvasNode[],
  source: FlowCanvasNode[],
  previousSource: FlowCanvasNode[],
  selected: string,
): FlowCanvasNode[] {
  const local = new Map(previous.map((n) => [n.id, n]));
  const saved = new Map(previousSource.map((n) => [n.id, n]));
  return source.map((n) => {
    const old = local.get(n.id),
      before = saved.get(n.id);
    if (!old) return { ...n, selected: n.id === selected };
    const position =
      old.dragging || (before && samePosition(before.position, n.position))
        ? old.position
        : n.position;
    const data =
      JSON.stringify(old.data) === JSON.stringify(n.data) ? old.data : n.data;
    return position === old.position && data === old.data
      ? old
      : { ...old, position, data };
  });
}

export function changedLayout(
  nodes: FlowCanvasNode[],
  layout: WorkflowDefinition["layout"],
) {
  return nodes.filter(
    (n) => !layout[n.id] || !samePosition(n.position, layout[n.id]),
  );
}
