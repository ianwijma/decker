import { bindingTargets } from "./binding-targets";
import type {
  ActionInstance,
  AppDocument,
  Graph,
  WorkflowDefinition,
  V3Document,
} from "./schema";
import { actionById } from "./catalog";
import { z } from "zod";

export type WorkflowAliases = AppDocument["workflowAliases"];

// Validated aliases are one hop to a UUID, including deleted-workflow tombstones.
// Unknown IDs pass through so callers can report missing records. No mutation.
export function resolveWorkflowId(
  id: string,
  aliases: WorkflowAliases = {},
): string {
  return Object.hasOwn(aliases, id) ? aliases[id] : id;
}
export function findWorkflow(
  workflows: WorkflowDefinition[],
  id: string,
  aliases: WorkflowAliases = {},
) {
  const resolved = resolveWorkflowId(id, aliases);
  return workflows.find((workflow) => workflow.id === resolved);
}

export function migrateWorkflowIdentities(
  document: Omit<V3Document, "schemaVersion" | "workflowAliases">,
): V3Document {
  const doc = structuredClone(document);
  const ids = [
    ...doc.workflows.map((w) => w.id),
    ...doc.connections.map((c) => c.id),
    ...doc.decks.map((d) => d.id),
    ...doc.profiles.flatMap((p) => [
      p.id,
      ...p.pages.flatMap((page) => [
        page.id,
        ...Object.values(page.keys).map((b) => b.id),
      ]),
    ]),
  ];
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate document ID before workflow migration");
  const reserved = new Set(ids),
    aliases: WorkflowAliases = Object.create(null);
  for (const workflow of doc.workflows) {
    if (z.uuid().safeParse(workflow.id).success) continue;
    let uuid: string;
    do {
      uuid = crypto.randomUUID();
    } while (reserved.has(uuid));
    reserved.add(uuid);
    aliases[workflow.id] = uuid;
    workflow.id = uuid;
  }
  const reference = (config: ActionInstance["config"], key: string) => {
    if (typeof config[key] === "string")
      config[key] = resolveWorkflowId(config[key], aliases);
  };
  const action = (a: ActionInstance) => {
    for (const field of actionById(a.type)?.fields ?? [])
      if (field.type === "workflow") reference(a.config, field.key);
  };
  const graph = (g: Graph) => {
    for (const n of g.nodes) {
      if (n.kind === "subflow") reference(n.config, "workflowId");
      if (n.kind === "action" && n.action) action(n.action);
      if (n.body) graph(n.body);
      n.branches?.forEach(graph);
    }
  };
  for (const w of doc.workflows) graph(w.graph);
  for (const p of doc.profiles)
    for (const page of p.pages)
      for (const b of Object.values(page.keys))
        for (const { target } of bindingTargets(b)) {
          if (target?.kind === "workflow")
            target.workflowId = resolveWorkflowId(target.workflowId, aliases);
          else if (target?.kind === "action") action(target.action);
          else if (target?.kind === "sequence") target.actions.forEach(action);
        }
  return { ...doc, schemaVersion: 3, workflowAliases: aliases };
}
