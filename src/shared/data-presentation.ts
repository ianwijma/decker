import { findWorkflow, type WorkflowAliases } from "./workflow-identity";
import { actionById, type Field } from "./catalog";
import { expression, parsePath } from "./data-contract";
import {
  outputAvailability,
  reachable,
  successfulOutput,
} from "./data-availability";
import type { FlowNode, Graph, Json, WorkflowDefinition } from "./schema";

export type DataType =
  | "JSON"
  | "text"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "text[]"
  | "text or HTTP result"
  | "HTTP result"
  | "JSON path";
export type GraphPath = Array<{ nodeId: string; branch?: number }>;
export type DataChoice = {
  path: (string | number)[];
  name: string;
  group: string;
  type: DataType;
  conditional: boolean;
  hint?: string;
};
export const choiceId = (choice: Pick<DataChoice, "path">) =>
  JSON.stringify(choice.path);
const outputFields: Record<string, Record<string, DataType>> = {
  "file.readText": { text: "text", bytes: "number", truncated: "boolean" },
  "file.writeText": {
    bytesWritten: "number",
    created: "boolean",
    operation: "text",
  },
  "file.appendText": {
    bytesWritten: "number",
    created: "boolean",
    operation: "text",
  },
  "http.request": { status: "number", body: "text", truncated: "boolean" },
  "data.parseJson": { value: "JSON" },
  "data.extract": { value: "JSON" },
  "command.run": { stdout: "text", stderr: "text", exitCode: "number" },
  "command.shell": { stdout: "text", stderr: "text", exitCode: "number" },
  "app.launch": { pid: "number" },
};
export function literalType(value: Json): DataType {
  try {
    if (expression(value)) return "JSON";
  } catch {
    return "JSON";
  }
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "object"
        ? "object"
        : typeof value === "string"
          ? "text"
          : typeof value === "number"
            ? "number"
            : "boolean";
}
export function destinationType(action: string, field: Field): DataType {
  if (action === "data.parseJson" && field.key === "input")
    return "text or HTTP result";
  if (action === "data.extract" && field.key === "path") return "JSON path";
  if (field.key === "args") return "text[]";
  if (field.type === "json") return "JSON";
  return field.type === "number"
    ? "number"
    : field.type === "boolean"
      ? "boolean"
      : "text";
}
export function acceptsType(destination: DataType, source: DataType): boolean {
  return (
    destination === "JSON" ||
    source === "JSON" ||
    destination === source ||
    (destination === "text[]" && (source === "array" || source === "text")) ||
    (destination === "text or HTTP result" &&
      (source === "text" || source === "HTTP result")) ||
    (destination === "JSON path" &&
      (source === "text" || source === "array")) ||
    (destination === "object" && source === "HTTP result")
  );
}
export function nodeOutput(
  node: FlowNode,
  workflow: WorkflowDefinition,
  all: WorkflowDefinition[] = [],
  aliases: WorkflowAliases = {},
) {
  if (node.kind === "subflow" && typeof node.config.workflowId === "string") {
    const child = findWorkflow(all, node.config.workflowId, aliases);
    if (child && child.revision === node.config.revision)
      return {
        type: "object" as const,
        fields: Object.fromEntries(
          child.outputs.map((key) => [key, "JSON" as DataType]),
        ),
      };
  }
  if (node.kind === "action") {
    const fields = outputFields[node.action?.type ?? ""];
    return {
      type:
        node.action?.type === "http.request"
          ? ("HTTP result" as const)
          : fields
            ? ("object" as const)
            : ("JSON" as const),
      fields: fields ?? {},
    };
  }
  const fields: Record<string, DataType> =
    node.kind === "trigger"
      ? Object.fromEntries(workflow.inputs.map((key) => [key, "JSON"]))
      : node.kind === "set" || node.kind === "return"
        ? Object.fromEntries(
            Object.entries(node.config).map(([key, value]) => [
              key,
              literalType(value),
            ]),
          )
        : {};
  return {
    type:
      node.kind === "condition"
        ? ("boolean" as const)
        : node.kind === "delay"
          ? ("number" as const)
          : node.kind === "repeat" || node.kind === "foreach"
            ? ("array" as const)
            : Object.keys(fields).length
              ? ("object" as const)
              : ("JSON" as const),
    fields,
  };
}
type Producer = {
  node: FlowNode;
  label: string;
  guaranteed: boolean;
  success: boolean;
};
/** Same presence rules as validation; only upstream, reachable nodes in this
 * graph or inherited outer graphs are discoverable. Branch-local data never leaks. */
export function bindingChoices(
  workflow: WorkflowDefinition,
  path: GraphPath,
  selected: string,
  all: WorkflowDefinition[] = [],
  aliases: WorkflowAliases = {},
): DataChoice[] {
  let graph = workflow.graph,
    inherited: Producer[] = [],
    loop = false,
    error = false;
  const producersAt = (g: Graph, id: string, outer: Producer[]): Producer[] => {
    const available =
      outputAvailability(
        g,
        new Set(outer.filter((p) => p.guaranteed).map((p) => p.node.id)),
      ).get(id) ?? new Set();
    const names = new Map<string, number>();
    for (const n of g.nodes) names.set(n.name, (names.get(n.name) ?? 0) + 1);
    const counts = new Map<string, number>();
    const local = g.nodes
      .map((n) => {
        const ordinal = (counts.get(n.name) ?? 0) + 1;
        counts.set(n.name, ordinal);
        return {
          node: n,
          label:
            n.name +
            ((names.get(n.name) ?? 0) > 1 ? ` (choice ${ordinal})` : ""),
          guaranteed: available.has(n.id),
          success: successfulOutput(g, n.id, id),
        };
      })
      .filter(
        (p) =>
          p.node.id !== id &&
          reachable(g, g.entry, p.node.id) &&
          reachable(g, p.node.id, id) &&
          reachable(g, g.entry, id),
      );
    // IDs are scope identities; a nearer producer shadows an inherited ID.
    return [
      ...outer.filter(
        (p) => !local.some((l) => l.node.id === p.node.id) && p.node.id !== id,
      ),
      ...local,
    ];
  };
  for (const step of path) {
    const parent = graph.nodes.find((n) => n.id === step.nodeId);
    if (!parent) return [];
    inherited = producersAt(graph, parent.id, inherited);
    error ||= graph.edges.some(
      (e) => e.port === "error" && reachable(graph, e.target, parent.id),
    );
    if (step.branch === undefined) {
      if (!parent.body) return [];
      loop ||= parent.kind === "repeat" || parent.kind === "foreach";
      graph = parent.body;
    } else {
      if (!parent.branches?.[step.branch]) return [];
      graph = parent.branches[step.branch];
    }
  }
  if (
    !graph.nodes.some((n) => n.id === selected) ||
    !reachable(graph, graph.entry, selected)
  )
    return [];
  const producers = producersAt(graph, selected, inherited);
  const choices: DataChoice[] = workflow.inputs.map((key) => ({
    path: ["inputs", key],
    name: key,
    group: "Inputs",
    type: "JSON",
    conditional: false,
    hint: "Declared input; resolved type is checked before execution.",
  }));
  for (const [key, type] of Object.entries({
    "source.kind": "text",
    "source.schedule.id": "text",
    "source.schedule.name": "text",
    origin: "JSON",
    "origin.deckId": "text",
    "origin.profileId": "text",
    "origin.pageId": "text",
    "origin.bindingId": "text",
    "origin.generation": "number",
    rootRunId: "text",
    invocationId: "text",
    rootWorkflowId: "text",
    workflowId: "text",
    workflowInvocationId: "text",
  } as Record<string, DataType>))
    choices.push({
      path: ["context", ...key.split(".")],
      name: key,
      group: "Trigger context",
      type,
      conditional:
        key.startsWith("origin.") || key.startsWith("source.schedule."),
      hint: key.startsWith("source.schedule.")
        ? "Available only for scheduled runs; add a fallback for other launch sources."
        : key.startsWith("origin")
          ? "Read-only saved origin; unavailable for manual, detached test, scheduled or private probe runs."
          : "Immutable runtime metadata, independent of caller inputs and variables.",
    });
  for (const p of producers) {
    const { type, fields } = nodeOutput(p.node, workflow, all, aliases);
    choices.push({
      path: ["outputs", p.node.id],
      name: `${p.label} / Complete result`,
      group: "Node outputs",
      type: p.success ? type : "JSON",
      conditional: !p.guaranteed,
      hint: p.success
        ? p.node.action?.type === "http.request"
          ? "Recommended for Parse JSON: retains truncation provenance."
          : "Complete native value."
        : "May contain recovered error data instead of successful output.",
    });
    for (const [key, fieldType] of Object.entries(fields))
      choices.push({
        path: ["outputs", p.node.id, key],
        name: `${p.label} / ${key}`,
        group: "Node outputs",
        type: fieldType,
        conditional: !p.guaranteed || !p.success,
        hint:
          fieldType === "JSON"
            ? "Dynamic JSON; refine safe path segments. Fields are not schema promises."
            : undefined,
      });
    if (p.node.kind === "set")
      for (const [key, value] of Object.entries(p.node.config))
        choices.push({
          path: ["vars", key],
          name: `${key} (from ${p.label})`,
          group: "Variables",
          type: literalType(value),
          conditional: !p.guaranteed || !p.success,
          hint: "Set/map variable; later assignments may change its type.",
        });
  }
  if (loop)
    choices.push(
      {
        path: ["item"],
        name: "Current item",
        group: "Loop",
        type: "JSON",
        conditional: false,
      },
      {
        path: ["index"],
        name: "Current index",
        group: "Loop",
        type: "number",
        conditional: false,
      },
    );
  error ||= graph.edges.some(
    (e) => e.port === "error" && reachable(graph, e.target, selected),
  );
  if (error)
    choices.push({
      path: ["error"],
      name: "Inherited error",
      group: "Recovery",
      type: "JSON",
      conditional: true,
      hint: "Error may be absent; supply a fallback.",
    });
  // Duplicate variable keys are uncertain, including conditional overwrites.
  for (const c of choices.filter((c) => c.group === "Variables")) {
    const siblings = choices.filter(
      (x) => x.group === "Variables" && choiceId(x) === choiceId(c),
    );
    if (siblings.length > 1) {
      c.type = "JSON";
      c.conditional = true;
    }
  }
  return choices.filter(
    (c, i) => choices.findIndex((x) => choiceId(x) === choiceId(c)) === i,
  );
}
export function referenceChoice(choices: DataChoice[], value: Json) {
  try {
    const e = expression(value);
    return e?.kind === "ref"
      ? choices.find(
          (c) =>
            JSON.stringify(parsePath(c.path)) ===
            JSON.stringify(parsePath(e.path)),
        )
      : undefined;
  } catch {
    return undefined;
  }
}
/** A refined dynamic path retains its named producer, without claiming a schema. */
export function referenceBaseChoice(choices: DataChoice[], value: Json) {
  try {
    const e = expression(value);
    if (e?.kind !== "ref") return;
    const parts = parsePath(e.path);
    return choices
      .filter((c) => {
        const prefix = parsePath(c.path);
        return (
          prefix.length <= parts.length &&
          prefix.every((p, i) => p === parts[i])
        );
      })
      .sort((a, b) => b.path.length - a.path.length)[0];
  } catch {
    return undefined;
  }
}
export function actionOutputDescription(id: string) {
  const fields = outputFields[id];
  return fields
    ? Object.entries(fields)
        .map(([key, type]) => `${key}: ${type}`)
        .join(", ")
    : `${actionById(id)?.name ?? id}: output shape unknown`;
}
