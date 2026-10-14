import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  boundedJson,
  expression,
  inspectExpressions,
} from "../../shared/data-contract";
import {
  acceptsType,
  referenceChoice,
  type DataChoice,
  type DataType,
} from "../../shared/data-presentation";
import type { Json } from "../../shared/schema";
import { DataPicker, TemplateEditor } from "./DataPicker";
import { JsonEditor } from "./components";
import "./data-binding.css";
type Mode = "literal" | "reference" | "template";
function modeOf(value: Json): Mode {
  try {
    const kind = expression(value)?.kind;
    return kind === "ref"
      ? "reference"
      : kind === "template"
        ? "template"
        : "literal";
  } catch {
    return "reference";
  }
}
export function escapeLiteral(value: Json): Json {
  boundedJson(value);
  try {
    if (inspectExpressions(value)) return { $literal: value };
  } catch {
    return { $literal: value };
  }
  return value;
}
export function ExpressionEditor({
  label,
  value,
  defaultValue = "",
  destination,
  choices,
  onChange,
  renderLiteral,
}: {
  label: string;
  value: Json;
  defaultValue?: Json;
  destination: DataType;
  choices: DataChoice[];
  onChange: (value: Json) => void;
  renderLiteral: (value: Json, change: (value: Json) => void) => ReactNode;
}) {
  const actual = modeOf(value),
    [mode, setMode] = useState<Mode>(actual),
    [error, setError] = useState(""),
    [advancedOpen, setAdvancedOpen] = useState(false);
  const drafts = useRef<Partial<Record<Mode, Json>>>({ [actual]: value });
  const serialized = JSON.stringify(value);
  useEffect(() => {
    drafts.current[modeOf(value)] = value;
    setMode(modeOf(value));
    setError("");
  }, [serialized]);
  const commit = (next: Json) => {
    drafts.current[modeOf(next)] = next;
    onChange(next);
  };
  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    const cached = drafts.current[next];
    if (cached !== undefined) commit(cached);
    else if (next === "template" && typeof value === "string")
      commit({ $template: [value] });
    // Other conversions need explicit input; retain the original value until then.
  };
  const shown =
    drafts.current[mode] ??
    (mode === "literal" ? escapeLiteral(defaultValue) : undefined);
  const literal =
    shown &&
    typeof shown === "object" &&
    !Array.isArray(shown) &&
    Object.hasOwn(shown, "$literal")
      ? shown.$literal
      : (shown ?? defaultValue);
  const selected = referenceChoice(choices, value);
  const ref =
    actual === "reference" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
      ? value
      : undefined;
  const incompatible =
    selected && !ref?.transform && !acceptsType(destination, selected.type);
  return (
    <section className="data-binding" aria-label={`${label} data binding`}>
      <label className="field">
        <span>{label} value mode</span>
        <select
          aria-label={`${label} value mode`}
          value={mode}
          onChange={(e) => switchMode(e.target.value as Mode)}
        >
          <option value="literal">Literal</option>
          <option value="reference">Whole value reference</option>
          {(destination === "text" ||
            destination === "text or HTTP result" ||
            destination === "JSON path" ||
            destination === "JSON" ||
            actual === "template") && (
            <option value="template">Mixed text template</option>
          )}
        </select>
      </label>
      {mode !== actual && (
        <p role="status" className="muted small">
          Original value retained until you enter or insert a value in this
          mode. Previous modes remain available during this edit.
        </p>
      )}
      {mode === "literal" && (
        <>
          {renderLiteral(literal, (next) => {
            try {
              commit(escapeLiteral(next));
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          })}
          {mode !== actual && (
            <button
              type="button"
              onClick={() => commit(escapeLiteral(literal))}
            >
              Apply literal value for {label}
            </button>
          )}
        </>
      )}
      {mode === "reference" && (
        <DataPicker
          key={JSON.stringify(shown)}
          label={label}
          choices={choices}
          destination={destination}
          value={shown}
          onChange={commit}
        />
      )}
      {mode === "template" && (
        <TemplateEditor
          label={label}
          choices={choices}
          value={
            shown &&
            typeof shown === "object" &&
            !Array.isArray(shown) &&
            Array.isArray(shown.$template)
              ? shown.$template
              : []
          }
          onChange={(segments) => commit({ $template: segments })}
        />
      )}
      {incompatible && (
        <p role="alert" className="danger-text">
          This field needs {destination}; {selected.type} requires a template or
          explicit transform.
        </p>
      )}
      {selected?.conditional && ref && !Object.hasOwn(ref, "fallback") && (
        <p role="alert" className="danger-text">
          Conditional data requires an explicit fallback.
        </p>
      )}
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      <details onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>{label} advanced JSON</summary>
        {advancedOpen && (
          <JsonEditor
            label={`${label} binding`}
            value={value}
            onChange={commit}
            hint="Advanced expressions, transforms and fallback. Literal objects with reserved keys use $literal."
          />
        )}
      </details>
    </section>
  );
}
