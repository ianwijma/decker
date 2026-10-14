import type {
  RunRecord,
  Snapshot,
  WorkflowDefinition,
} from "../../shared/schema";
import {
  resolveWorkflowId,
  type WorkflowAliases,
} from "../../shared/workflow-identity";

// IPC snapshots clone the whole document. Cache only the editor's inputs so
// device/observed updates do not rebuild the canvas; other consumers keep their snapshots.
function stableValue<T>(read: (snapshot?: Snapshot) => T) {
  let serialized: string | undefined, value: T;
  return (state: { snapshot?: Snapshot }) => {
    const next = read(state.snapshot),
      json = JSON.stringify(next);
    if (json !== serialized) {
      serialized = json;
      value = next;
    }
    return value;
  };
}
export const selectFlowWorkflows = stableValue<WorkflowDefinition[]>(
  (snapshot) => snapshot?.document.workflows ?? [],
);
export const selectWorkflowAliases = stableValue<WorkflowAliases>(
  (snapshot) => snapshot?.document.workflowAliases ?? {},
);
export const createLatestFlowRunSelector = (workflowId?: string) =>
  stableValue<RunRecord | undefined>((snapshot) =>
    snapshot?.runs
      .filter(
        (run) =>
          resolveWorkflowId(
            run.workflowId,
            snapshot.document.workflowAliases,
          ) === workflowId,
      )
      .at(-1),
  );
