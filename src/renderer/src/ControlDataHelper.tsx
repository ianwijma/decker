import { useState } from "react";
import { ownPath, parsePath } from "../../shared/data-contract";
import type { DataChoice } from "../../shared/data-presentation";
import type { FlowNode, Json } from "../../shared/schema";
import { ExpressionEditor } from "./ExpressionEditor";
import { JsonEditor } from "./components";

export function replaceConfigField(
  config: Record<string, Json>,
  path: (string | number)[],
  value: Json,
): Record<string, Json> {
  parsePath(path);
  const copy = structuredClone(config);
  let parent: Record<string, Json> | Json[] = copy;
  for (const key of path.slice(0, -1)) {
    const d = Object.getOwnPropertyDescriptor(parent, key);
    if (!d || !("value" in d) || !d.value || typeof d.value !== "object")
      throw new Error(
        "Choose an existing object/array parent in Configuration JSON",
      );
    parent = d.value;
  }
  const last = path.at(-1)!;
  if (
    Array.isArray(parent) &&
    (!/^(0|[1-9]\d*)$/.test(String(last)) || Number(last) > parent.length)
  )
    throw new Error("Use an existing array index or its next index");
  Object.defineProperty(parent, last, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return copy;
}
export function ControlDataHelper({
  node,
  choices,
  onChange,
}: {
  node: FlowNode;
  choices: DataChoice[];
  onChange: (value: Record<string, Json>) => void;
}) {
  const [target, setTarget] = useState(
      JSON.stringify([Object.keys(node.config)[0] ?? "value"]),
    ),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false);
  let path: (string | number)[] = [],
    value: Json = null;
  try {
    const parsed = JSON.parse(target);
    if (!Array.isArray(parsed)) throw new Error();
    parsePath(parsed);
    path = parsed;
    value = ownPath(node.config, path) ?? null;
  } catch {
    /* Show validation on insertion. */
  }
  const destination =
    path.length === 1 &&
    ((node.kind === "delay" && path[0] === "ms") ||
      (node.kind === "repeat" && path[0] === "count"))
      ? "number"
      : path.length === 1 && node.kind === "foreach" && path[0] === "items"
        ? "array"
        : "JSON";
  return (
    <details
      className="data-binding"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Configuration data helper</summary>
      {open && (
        <>
          <p className="muted small">
            Choose the exact field to replace using JSON path segments, e.g.
            ["inputs","message"] for a subflow input. Configuration JSON stays
            available; switch cases and ports are unchanged.
          </p>
          <label className="field">
            <span>Selected configuration field (JSON path segments)</span>
            <input
              aria-label="Selected configuration field"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setError("");
              }}
            />
          </label>
          <ExpressionEditor
            key={target}
            label="Selected field"
            value={value}
            destination={destination}
            choices={choices}
            renderLiteral={(v, change) => (
              <JsonEditor
                label="Selected field literal JSON"
                value={v}
                onChange={change}
              />
            )}
            onChange={(v) => {
              try {
                if (!path.length)
                  throw new Error("Choose safe JSON path segments");
                onChange(replaceConfigField(node.config, path, v));
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
          {error && (
            <p role="alert" className="danger-text">
              {error}
            </p>
          )}
        </>
      )}
    </details>
  );
}
