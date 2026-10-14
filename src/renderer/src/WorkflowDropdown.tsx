import type { WorkflowDefinition } from "../../shared/schema";
import {
  resolveWorkflowId,
  type WorkflowAliases,
} from "../../shared/workflow-identity";
import { SearchableDropdown } from "./SearchableDropdown";

export function WorkflowDropdown({
  label = "Workflow",
  workflows,
  aliases = {},
  value,
  onSelect,
}: {
  label?: string;
  workflows: WorkflowDefinition[];
  aliases?: WorkflowAliases;
  value?: string;
  onSelect: (id: string) => void;
}) {
  const names = new Map<string, number>();
  for (const workflow of workflows)
    names.set(workflow.name, (names.get(workflow.name) ?? 0) + 1);
  return (
    <SearchableDropdown
      label={label}
      searchLabel={
        label === "Workflow"
          ? "Search workflows"
          : `Search ${label.toLowerCase()} workflows`
      }
      options={workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description:
          (names.get(workflow.name) ?? 0) > 1
            ? `Revision ${workflow.revision}`
            : undefined,
      }))}
      value={value ? resolveWorkflowId(value, aliases) : value}
      onSelect={onSelect}
      hideIds
      missingLabel="Workflow unavailable — choose a replacement"
      emptyLabel="Choose workflow"
    />
  );
}
