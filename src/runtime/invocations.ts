import {
  findWorkflow,
  resolveWorkflowId,
  type WorkflowAliases,
} from "../shared/workflow-identity";
import type { Graph, WorkflowDefinition } from "../shared/schema";

/** Counts live calls, including overlapping calls to the same definition. */
export class Invocations {
  private counts = new Map<string, number>();
  constructor(private aliases: WorkflowAliases) {}
  enter(id: string): () => void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    return () => {
      const count = this.counts.get(id)! - 1;
      if (count) this.counts.set(id, count);
      else this.counts.delete(id);
    };
  }
  has(id: string) {
    return this.counts.has(resolveWorkflowId(id, this.aliases));
  }
}

/** Queue provenance is a pure scan of literal call targets, never an execution.
 * Data-dependent calls acquire their identity only when actually invoked.
 */
export function queuedWorkflows(
  workflow: WorkflowDefinition,
  all: WorkflowDefinition[],
  aliases: WorkflowAliases,
): (id: string) => boolean {
  const ids = new Set<string>();
  const visit = (f: WorkflowDefinition) => {
    // Definition IDs are already canonical; synthetic "direct" is not a legacy reference.
    const id = f.id;
    if (ids.has(id)) return;
    ids.add(id);
    const graph = (g: Graph) => {
      for (const n of g.nodes) {
        const ref =
          n.kind === "subflow"
            ? n.config.workflowId
            : n.kind === "action" && n.action?.type === "workflow.run"
              ? n.action.config.workflowId
              : undefined;
        if (typeof ref === "string") {
          const child = findWorkflow(all, ref, aliases);
          if (child) visit(child);
        }
        if (n.body) graph(n.body);
        n.branches?.forEach(graph);
      }
    };
    graph(f.graph);
  };
  visit(workflow);
  return (id) => ids.has(resolveWorkflowId(id, aliases));
}
