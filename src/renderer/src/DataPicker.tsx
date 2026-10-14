import { useState } from "react";
import {
  expression,
  inspectExpressions,
  parsePath,
  transforms,
} from "../../shared/data-contract";
import {
  acceptsType,
  choiceId,
  referenceBaseChoice,
  type DataChoice,
  type DataType,
} from "../../shared/data-presentation";
import type { Json } from "../../shared/schema";
import { SearchableDropdown } from "./SearchableDropdown";
import { JsonEditor } from "./components";

export function DataPicker({
  label,
  choices,
  destination,
  value,
  onChange,
}: {
  label: string;
  choices: DataChoice[];
  destination: DataType;
  value?: Json;
  onChange: (value: Json) => void;
}) {
  const existing =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const current =
    value === undefined ? undefined : referenceBaseChoice(choices, value);
  const [picked, setPicked] = useState<string>(),
    [suffix, setSuffix] = useState(() =>
      current && existing.$ref
        ? JSON.stringify(parsePath(existing.$ref).slice(current.path.length))
        : "[]",
    ),
    [fallback, setFallback] = useState(() =>
      Object.hasOwn(existing, "fallback")
        ? JSON.stringify(existing.fallback)
        : "",
    ),
    [transform, setTransform] = useState(() =>
      typeof existing.transform === "string" ? existing.transform : "",
    ),
    [error, setError] = useState("");
  const selected = choices.find((c) => choiceId(c) === picked) ?? current;
  const options = choices.map((c) => ({
    id: choiceId(c),
    name: `${c.group} / ${c.name}`,
    description: `${c.type} · ${c.conditional ? "Conditional — fallback required" : "Available"}${c.hint ? " · " + c.hint : ""}`,
  }));
  const insert = () => {
    if (!selected) return;
    try {
      const extra: unknown = JSON.parse(suffix);
      if (!Array.isArray(extra))
        throw new Error("Use a JSON array of path segments");
      if (extra.length) parsePath(extra);
      const ref: Record<string, Json> = {
        ...existing,
        $ref: [...selected.path, ...extra],
      };
      delete ref.$template;
      delete ref.$literal;
      if (transform) ref.transform = transform;
      else delete ref.transform;
      if (fallback.trim()) ref.fallback = JSON.parse(fallback);
      else delete ref.fallback;
      const resultType =
        ref.transform === "string" ||
        ref.transform === "lowercase" ||
        ref.transform === "uppercase"
          ? "text"
          : ref.transform === "number" || ref.transform === "length"
            ? "number"
            : extra.length
              ? "JSON"
              : selected.type;
      if (!acceptsType(destination, resultType))
        throw new Error(
          `This field needs ${destination}; ${resultType} requires an explicit transform or mixed text template.`,
        );
      if (
        (selected.conditional || extra.length > 0) &&
        !Object.hasOwn(ref, "fallback")
      )
        throw new Error(
          "Conditional or refined dynamic paths require an explicit fallback (JSON).",
        );
      inspectExpressions(ref);
      onChange(ref);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="data-picker">
      <SearchableDropdown
        label={`Data for ${label}`}
        searchLabel={`Search data for ${label}`}
        options={options}
        value={picked ?? (current && choiceId(current))}
        hideIds
        emptyLabel="Choose named data"
        missingLabel="Reference unavailable in this scope"
        onSelect={(id) => {
          setPicked(id);
          setError("");
        }}
      />
      {value !== undefined &&
        !current &&
        (() => {
          try {
            return expression(value)?.kind === "ref";
          } catch {
            return false;
          }
        })() && (
          <p className="muted small">
            Reference path is custom, removed, or unavailable in this scope.
            Review the JSON and fallback.
          </p>
        )}
      {selected && (
        <>
          <p className="muted small">
            {selected.type} ·{" "}
            {selected.conditional
              ? "Conditional: explicit fallback required."
              : "Available."}{" "}
            {selected.hint}
          </p>
          <label className="field">
            <span>Refine path segments (JSON array)</span>
            <input
              aria-label={`Path segments for ${label}`}
              value={suffix}
              onChange={(e) => setSuffix(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Missing data fallback (JSON)</span>
            <input
              aria-label={`Fallback for ${label}`}
              value={fallback}
              placeholder="Optional, e.g. null"
              onChange={(e) => setFallback(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Explicit transform</span>
            <select
              aria-label={`Transform for ${label}`}
              value={transform}
              onChange={(e) => setTransform(e.target.value)}
            >
              <option value="">Keep native type</option>
              {transforms.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={insert}>
            Insert reference for {label}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      {Object.hasOwn(existing, "$ref") && (
        <small className="muted">
          References keep native arrays, objects, null, false and zero. Fallback
          applies only to absence.
        </small>
      )}
    </div>
  );
}

export function TemplateEditor({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: Json[];
  choices: DataChoice[];
  onChange: (segments: Json[]) => void;
}) {
  const replace = (index: number, next: Json) =>
    onChange(value.map((v, i) => (i === index ? next : v)));
  return (
    <div className="data-template">
      <p className="muted small">
        Text and references concatenate in order. JSON values use compact JSON
        text; strings are literal.
      </p>
      {value.map((segment, index) => (
        <div className="data-segment" key={index}>
          <div className="row">
            <strong>Segment {index + 1}</strong>
            <button
              type="button"
              aria-label={`Remove ${label} segment ${index + 1}`}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
          {typeof segment === "string" ? (
            <textarea
              aria-label={`${label} text segment ${index + 1}`}
              rows={2}
              value={segment}
              onChange={(e) => replace(index, e.target.value)}
            />
          ) : (
            <>
              <DataPicker
                key={JSON.stringify(segment)}
                label={`${label} segment ${index + 1}`}
                choices={choices}
                destination="JSON"
                value={segment}
                onChange={(next) => replace(index, next)}
              />
              <details>
                <summary>Segment JSON</summary>
                <JsonEditor
                  label={`${label} segment ${index + 1} JSON`}
                  value={segment}
                  onChange={(next) => replace(index, next)}
                />
              </details>
            </>
          )}
        </div>
      ))}
      <div className="row">
        <button
          type="button"
          disabled={value.length >= 256}
          onClick={() => onChange([...value, ""])}
        >
          Add text to {label}
        </button>
        <button
          type="button"
          disabled={value.length >= 256}
          onClick={() => onChange([...value, { $literal: "" }])}
        >
          Add reference to {label}
        </button>
      </div>
    </div>
  );
}
