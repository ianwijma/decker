import { expression } from "../../shared/data-contract";
import { ObsConnectionDropdown } from "./ObsConnectionDropdown";
import {
  destinationType,
  type DataChoice,
} from "../../shared/data-presentation";
import { ExpressionEditor } from "./ExpressionEditor";
import { WorkflowDropdown } from "./WorkflowDropdown";
import { NavigationTargetDropdown } from "./NavigationTargetDropdown";
import { useApp } from "./store";
import { selectFlowWorkflows, selectWorkflowAliases } from "./flow-selectors";
import { useEffect, useState, type ReactNode } from "react";
import { Plus, Search } from "lucide-react";
import {
  catalogForPalette,
  visibleInPalette,
  type PaletteContext,
  actionById,
  makeAction,
  type Field,
} from "../../shared/catalog";
import type {
  ActionInstance,
  Json,
  Target,
  WorkflowDefinition,
} from "../../shared/schema";
import { ActionSecret } from "./InlineSecret";
import { actionLocation, FilePickerButton } from "./file-picker";
import { MediaIcon } from "./MediaIcon";
export function FieldLabel({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function JsonEditor({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: unknown;
  onChange: (value: Json) => void;
  hint?: string;
}) {
  const serialized = JSON.stringify(value, null, 2),
    [text, setText] = useState(serialized),
    [error, setError] = useState("");
  useEffect(() => {
    setText(serialized);
    setError("");
  }, [serialized]);
  return (
    <FieldLabel label={label} hint={hint}>
      <textarea
        aria-label={label}
        className="code"
        rows={Math.min(12, Math.max(3, text.split("\n").length))}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          try {
            JSON.parse(event.target.value);
            setError("");
          } catch {
            setError("Enter valid JSON");
          }
        }}
        onBlur={() => {
          try {
            onChange(JSON.parse(text));
            setError("");
          } catch {
            setError("Enter valid JSON");
          }
        }}
      />
      {error && <small className="danger-text">{error}</small>}
    </FieldLabel>
  );
}
export function ActionFields({
  action,
  onChange,
  bindings = false,
  choices = [],
}: {
  action: ActionInstance;
  onChange: (action: ActionInstance) => void;
  bindings?: boolean;
  choices?: DataChoice[];
}) {
  const workflows = useApp(selectFlowWorkflows),
    aliases = useApp(selectWorkflowAliases);
  const scope = useApp((state) => {
    const doc = state.snapshot?.document;
    const deck = doc?.decks.find((d) => d.id === doc.activeDeckId);
    return JSON.stringify([
      state.tab,
      deck?.id,
      deck?.activeProfileId,
      deck?.activePageId,
      actionLocation(doc, action),
    ]);
  });
  const definition = actionById(action.type);
  if (!definition)
    return <p className="danger-text">Unknown action: {action.type}</p>;
  const change = (field: Field, value: Json) =>
    onChange({ ...action, config: { ...action.config, [field.key]: value } });
  return (
    <div className="fields">
      <p className="muted small">{definition.description}</p>
      {definition.fields.map((field) => {
        if (field.type === "secret")
          return <ActionSecret key={field.key} action={action} scope={scope} />;
        const value = Object.hasOwn(action.config, field.key)
          ? action.config[field.key]
          : (field.default ?? "");
        const literalEditor = (
          value: Json,
          setValue: (value: Json) => void,
        ) => (
          <>
            <FieldLabel label={field.label} hint={field.hint}>
              {field.type === "json" ||
              (value !== null && typeof value === "object") ||
              value === null ? (
                <JsonEditor
                  label={`${field.label} JSON`}
                  value={value}
                  onChange={(v) => setValue(v)}
                />
              ) : field.type === "connection" ? (
                <ObsConnectionDropdown
                  value={String(value)}
                  onSelect={(id) => setValue(id)}
                />
              ) : field.type === "workflow" ? (
                <WorkflowDropdown
                  workflows={workflows}
                  aliases={aliases}
                  value={String(value)}
                  onSelect={(id) => setValue(id)}
                />
              ) : field.type === "profile" || field.type === "page" ? (
                <NavigationTargetDropdown
                  kind={field.type}
                  value={String(value)}
                  onSelect={(id) => setValue(id)}
                />
              ) : field.type === "boolean" ? (
                <input
                  aria-label={field.label}
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => setValue(e.target.checked)}
                />
              ) : field.options ? (
                <select
                  aria-label={field.label}
                  value={String(value)}
                  onChange={(e) => setValue(e.target.value)}
                >
                  {field.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : field.key === "script" ||
                field.key === "text" ||
                field.key === "body" ? (
                <textarea
                  aria-label={field.label}
                  value={String(value)}
                  onChange={(e) => setValue(e.target.value)}
                  rows={3}
                />
              ) : (
                <input
                  aria-label={field.label}
                  type={field.type === "number" ? "number" : "text"}
                  value={String(value)}
                  onChange={(e) =>
                    setValue(
                      field.type === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                    )
                  }
                />
              )}
            </FieldLabel>
          </>
        );
        let bound = false;
        try {
          bound = Boolean(expression(value));
        } catch {
          bound = true;
        }
        return (
          <div key={field.key}>
            {bindings ? (
              <ExpressionEditor
                label={field.label}
                value={value}
                defaultValue={field.default ?? ""}
                destination={destinationType(action.type, field)}
                choices={choices}
                onChange={(v) => change(field, v)}
                renderLiteral={literalEditor}
              />
            ) : bound ? (
              <JsonEditor
                label={`${field.label} binding`}
                value={value}
                onChange={(v) => change(field, v)}
              />
            ) : (
              literalEditor(value, (v) => change(field, v))
            )}
            {field.type === "file" && field.picker === "openFile" && (
              <FilePickerButton
                scope={scope}
                action={action}
                fieldKey={field.key}
                label={field.label}
                onSelect={(path) => change(field, path)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
export function TargetEditor({
  target,
  onChange,
  workflows,
}: {
  target?: Target;
  onChange: (target?: Target) => void;
  workflows: WorkflowDefinition[];
}) {
  const aliases = useApp(selectWorkflowAliases);
  const kind = target?.kind ?? "none";
  return (
    <div className="target-editor">
      <FieldLabel label="Assignment">
        <select
          aria-label="Assignment"
          value={kind}
          onChange={(e) =>
            onChange(
              e.target.value === "none"
                ? undefined
                : e.target.value === "workflow"
                  ? { kind: "workflow", workflowId: workflows[0]?.id ?? "" }
                  : e.target.value === "sequence"
                    ? {
                        kind: "sequence",
                        actions: [makeAction("desktop.notify")],
                      }
                    : { kind: "action", action: makeAction("desktop.openUrl") },
            )
          }
        >
          <option value="none">Unassigned</option>
          <option value="action">Single action</option>
          <option value="sequence">Multi-action sequence</option>
          <option value="workflow">Workflow</option>
        </select>
      </FieldLabel>
      {target?.kind === "workflow" && (
        <FieldLabel label="Workflow">
          <WorkflowDropdown
            workflows={workflows}
            aliases={aliases}
            value={target.workflowId}
            onSelect={(id) => onChange({ ...target, workflowId: id })}
          />
        </FieldLabel>
      )}
      {target?.kind === "action" && (
        <>
          <ActionSelect
            context="button"
            value={target.action.type}
            onChange={(type) =>
              onChange({ kind: "action", action: makeAction(type) })
            }
          />
          <ActionFields
            action={target.action}
            onChange={(action) => onChange({ kind: "action", action })}
          />
        </>
      )}
      {target?.kind === "sequence" && (
        <>
          {target.actions.map((action, index) => (
            <div className="sequence-item" key={index}>
              <div className="row">
                <strong>Step {index + 1}</strong>
                <button
                  disabled={index === 0}
                  onClick={() => {
                    const actions = [...target.actions];
                    [actions[index - 1], actions[index]] = [
                      actions[index],
                      actions[index - 1],
                    ];
                    onChange({ ...target, actions });
                  }}
                >
                  ↑
                </button>
                <button
                  disabled={target.actions.length === 1}
                  onClick={() =>
                    onChange({
                      ...target,
                      actions: target.actions.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </button>
              </div>
              <ActionSelect
                context="button"
                value={action.type}
                onChange={(type) =>
                  onChange({
                    ...target,
                    actions: target.actions.map((a, i) =>
                      i === index ? makeAction(type) : a,
                    ),
                  })
                }
              />
              <ActionFields
                action={action}
                onChange={(next) =>
                  onChange({
                    ...target,
                    actions: target.actions.map((a, i) =>
                      i === index ? next : a,
                    ),
                  })
                }
              />
            </div>
          ))}
          <button
            onClick={() =>
              onChange({
                ...target,
                actions: [...target.actions, makeAction("desktop.notify")],
              })
            }
          >
            <Plus size={14} /> Add step
          </button>
        </>
      )}
    </div>
  );
}
export function ActionSelect({
  value,
  onChange,
  context,
}: {
  value: string;
  onChange: (type: string) => void;
  context: PaletteContext;
}) {
  const palette = catalogForPalette(context);
  const selected = actionById(value);
  return (
    <FieldLabel label="Action">
      <select
        aria-label="Action"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {selected && !visibleInPalette(selected, context) && (
          <option value={value}>
            {selected.group} / {selected.name} (
            {selected.paletteVisible === false ? "legacy" : "advanced"})
          </option>
        )}
        {palette.map((a) => (
          <option key={a.id} value={a.id}>
            {a.group} / {a.name}
          </option>
        ))}
      </select>
    </FieldLabel>
  );
}
export function Catalog({ onPick }: { onPick: (type: string) => void }) {
  const [search, setSearch] = useState("");
  const palette = catalogForPalette("button");
  return (
    <>
      <div className="section-heading">
        ACTION LIBRARY <span>{palette.length}</span>
      </div>
      <div className="search">
        <Search size={16} />
        <input
          aria-label="Search actions"
          placeholder="Search actions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {["Developer", "Desktop", "Media", "Streaming", "Deck"].map((group) => (
        <div key={group} className="catalog-group">
          <h3>{group}</h3>
          {palette
            .filter(
              (a) =>
                a.group === group &&
                `${a.name} ${a.description}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((a) => (
              <button
                className="catalog-action"
                aria-label={a.name}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData("decker/action", a.id)
                }
                onClick={() => onPick(a.id)}
                key={a.id}
                title={a.description}
              >
                <span className={`action-icon group-${group.toLowerCase()}`}>
                  {group === "Media" ? <MediaIcon icon={a.icon} /> : a.icon}
                </span>
                <span>{a.name}</span>
                <Plus size={13} />
              </button>
            ))}
        </div>
      ))}
    </>
  );
}
