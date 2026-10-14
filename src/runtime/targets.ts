import { createHash } from "node:crypto";
import { findWorkflow } from "../shared/workflow-identity";
import { actionById } from "../shared/catalog";
import { bindingTargets } from "../shared/binding-targets";
import { node, uid } from "../shared/defaults";
import type {
  AppDocument,
  KeyBinding,
  Target,
  WorkflowDefinition,
  Graph,
  ActionInstance,
} from "../shared/schema";

export const toggleStamp = (binding: KeyBinding) =>
  createHash("sha256").update(JSON.stringify(binding.toggle)).digest("hex");

/** Relevant immutable definitions only: ordinary background saves never probe. */
export function toggleDefinitionStamp(
  binding: KeyBinding,
  document: AppDocument,
) {
  const dependencies = new Map<string, WorkflowDefinition>();
  const connections = new Map<string, AppDocument["connections"][number]>();
  const aliases: AppDocument["workflowAliases"] = Object.create(null);
  const reference = (id: unknown) => {
    if (typeof id !== "string") {
      // Dynamic workflow selection can choose any captured definition.
      Object.assign(aliases, document.workflowAliases);
      for (const workflow of document.workflows) reference(workflow.id);
      return;
    }
    if (Object.hasOwn(document.workflowAliases, id))
      aliases[id] = document.workflowAliases[id];
    const f = findWorkflow(document.workflows, id, document.workflowAliases);
    if (!f || dependencies.has(f.id)) return;
    dependencies.set(f.id, f);
    graph(f.graph);
  };
  const action = (a: ActionInstance) => {
    for (const field of actionById(a.type)?.fields ?? []) {
      if (field.type === "workflow") reference(a.config[field.key]);
      if (field.type === "connection") {
        const ref = a.config[field.key];
        for (const connection of document.connections)
          if (typeof ref !== "string" || connection.id === ref)
            connections.set(connection.id, connection);
      }
    }
  };
  const graph = (g: Graph) => {
    for (const n of g.nodes) {
      if (n.kind === "subflow") reference(n.config.workflowId);
      if (n.action) action(n.action);
      if (n.body) graph(n.body);
      n.branches?.forEach(graph);
    }
  };
  for (const { target } of bindingTargets(binding)) {
    if (target.kind === "workflow") reference(target.workflowId);
    else
      (target.kind === "action" ? [target.action] : target.actions).forEach(
        action,
      );
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding,
        [...dependencies.values()]
          .map(({ id, revision, graph, inputs, outputs, timeoutMs }) => ({
            id,
            revision,
            graph,
            inputs,
            outputs,
            timeoutMs,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
        [...connections.values()]
          .map(({ id, url, credentialRef }) => ({ id, url, credentialRef }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ]),
    )
    .digest("hex");
}

export type TargetDocument = Pick<AppDocument, "workflows" | "workflowAliases">;
export function targetWorkflow(
  target: Target,
  document: TargetDocument,
): WorkflowDefinition {
  if (target.kind === "workflow") {
    const f = findWorkflow(
      document.workflows,
      target.workflowId,
      document.workflowAliases,
    );
    if (!f) throw new Error("Workflow not found");
    return f;
  }
  const actions = target.kind === "sequence" ? target.actions : [target.action];
  const nodes = actions.map((a) => ({ ...node("action", a.type), action: a }));
  return {
    id: "direct",
    name: target.kind === "sequence" ? "Multi-action" : actions[0].type,
    revision: 1,
    graph: {
      entry: nodes[0].id,
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: uid(),
        source: nodes[i].id,
        target: n.id,
        port: "next",
      })),
    },
    inputs: [],
    outputs: [],
    timeoutMs: 300000,
    layout: {},
  };
}
