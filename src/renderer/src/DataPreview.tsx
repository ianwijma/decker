import { useState } from "react";
import {
  lastNodePreview,
  previewText,
  samplePaths,
  previewLocation,
} from "../../shared/data-preview";
import type { GraphPath } from "../../shared/data-presentation";
import type { WorkflowDefinition } from "../../shared/schema";
import { useApp } from "./store";
import { SearchableDropdown } from "./SearchableDropdown";
export function DataPreview({
  workflow,
  path,
  nodeId,
}: {
  workflow: WorkflowDefinition;
  path: GraphPath;
  nodeId: string;
}) {
  const runs = useApp((s) => s.snapshot?.runs ?? []),
    aliases = useApp((s) => s.snapshot?.document.workflowAliases ?? {});
  const { run, records, stale } = lastNodePreview(
    runs,
    workflow,
    path,
    nodeId,
    aliases,
  );
  const [recordId, setRecordId] = useState<string>();
  const record = records.find((r) => r.id === recordId) ?? records.at(-1);
  return (
    <details className="data-preview">
      <summary>Last-run preview (bounded and redacted)</summary>
      <p className="muted small">
        Sanitized historical samples; history may already be truncated. This
        preview does not run or fetch data.
      </p>
      {!run ? (
        <p>No completed run for this workflow.</p>
      ) : (
        <>
          <p>
            {new Date(run.startedAt).toLocaleString()} · Run {run.status} ·
            Revision {run.revision}
            {stale && " · Stale revision: edited since this run"}
          </p>
          {!record ? (
            <p>
              No node record for this graph path in the last run. It may not
              have executed or history was bounded.
            </p>
          ) : (
            <>
              <SearchableDropdown
                label="Preview execution"
                searchLabel="Search preview executions"
                hideIds
                value={record.id}
                onSelect={setRecordId}
                options={records.map((r, i) => ({
                  id: r.id,
                  name: `Execution ${i + 1} · ${r.status} · attempt ${r.attempt + 1}`,
                  description: previewLocation(
                    workflow,
                    path,
                    r.path,
                    run.workflowId,
                  ),
                }))}
              />
              <small>
                {previewLocation(workflow, path, record.path, run.workflowId)} ·
                Attempt {record.attempt + 1} · {record.status}
              </small>
              <details>
                <summary>Advanced execution path</summary>
                <small className="code">{record.path.slice(0, 4096)}</small>
              </details>
              {(["input", "output", "error"] as const).map((field) => {
                const result = previewText(record[field]);
                return (
                  <div key={field}>
                    <strong>{field}</strong>
                    <small>
                      {record[field] === undefined ? " · Missing data" : ""}
                      {result.redacted ? " · Redacted" : ""}
                      {result.limited ? " · Truncated / limited" : ""}
                    </small>
                    <pre>{result.text}</pre>
                  </div>
                );
              })}
              {samplePaths(record).length > 0 && (
                <details>
                  <summary>
                    Observed path examples (not schema guarantees)
                  </summary>
                  <p className="muted small">
                    Append these safe segments to this node's complete result.
                    Dynamic paths require a fallback; selecting a reference
                    never copies a sample value.
                  </p>
                  <pre>
                    {samplePaths(record)
                      .map((p) => JSON.stringify(p))
                      .join("\n")}
                  </pre>
                </details>
              )}
            </>
          )}
          <strong>Trigger context</strong>
          <pre>
            {run.context
              ? previewText(run.context).text
              : "Context unavailable in this historical run."}
          </pre>
          {run.context?.origin === null && (
            <p>No triggering button (unbound execution).</p>
          )}
        </>
      )}
    </details>
  );
}
