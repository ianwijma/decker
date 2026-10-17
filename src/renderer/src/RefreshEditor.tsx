import { useState, useEffect, useRef } from "react";
import type { KeyBinding, Snapshot } from "../../shared/schema";
import {
  refreshSchema,
  refreshError,
  type Refresh,
} from "../../shared/refresh";
import { uid } from "../../shared/defaults";
import { WorkflowDropdown } from "./WorkflowDropdown";
import { FieldLabel } from "./components";
import { useApp } from "./store";
import "./refresh.css";
export function RefreshEditor({
  binding,
  deckId,
  openRequested,
  onSave,
}: {
  binding: KeyBinding;
  deckId: string;
  openRequested: number;
  onSave: (fn: (b: KeyBinding) => void) => void;
}) {
  const { snapshot, saving, request, receive } = useApp();
  const [editing, setEditing] = useState(Boolean(openRequested));
  const [draft, setDraft] = useState<Refresh>(() =>
    binding.refresh
      ? structuredClone(binding.refresh)
      : {
          id: uid(),
          workflowId: "",
          inputs: {},
          seconds: 60,
          initial: true,
          enabled: false,
        },
  );
  const [inputs, setInputs] = useState(JSON.stringify(draft.inputs, null, 2));
  const section = useRef<HTMLElement>(null),
    epoch = useRef(0);
  const saved = binding.refresh;
  useEffect(() => {
    if (openRequested) {
      setEditing(true);
      section.current?.scrollIntoView({ block: "nearest" });
    }
  }, [openRequested]);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  let parsed: ReturnType<typeof refreshSchema.safeParse> | undefined;
  let error = "";
  try {
    parsed = refreshSchema.safeParse({ ...draft, inputs: JSON.parse(inputs) });
    error = !draft.workflowId
      ? "Choose a refresh workflow"
      : parsed.success
        ? (refreshError(parsed.data, snapshot!.document) ?? "")
        : parsed.error.issues[0].message;
  } catch {
    error = "Enter ordinary JSON inputs";
  }
  const state = snapshot!.refresh?.find(
    (s) =>
      s.origin.deckId === deckId &&
      s.origin.bindingId === binding.id &&
      s.origin.generation === binding.generation,
  );
  const open = () => {
    if (saved) {
      setDraft(structuredClone(saved));
      setInputs(JSON.stringify(saved.inputs, null, 2));
    }
    setEditing(true);
    epoch.current++;
  };
  const dirty =
    editing &&
    (!parsed?.success ||
      JSON.stringify({ ...parsed.data, enabled: false }) !==
        JSON.stringify({ ...saved, enabled: false }));
  const savedError = saved
    ? refreshError(saved, snapshot!.document)
    : undefined;
  return (
    <section
      ref={section}
      className="refresh-editor"
      aria-label="Refresh while visible"
    >
      <h3>Refresh while visible</h3>
      <p>
        Run a separate workflow to fetch or prepare button data. Refresh
        workflows can have effects; choose one you trust.
      </p>
      {saved && (
        <>
          <p role="status">
            {saved.enabled ? "Enabled" : "Disabled"} · Refresh{" "}
            {state?.status ?? (saved.enabled ? "waiting" : "idle")}
            <br />
            {state?.lastSuccess
              ? `Last successful refresh: ${new Date(state.lastSuccess).toLocaleString()}`
              : "Last successful refresh: unknown this session"}
            {state?.nextAt && (
              <>
                {" "}
                <br />
                Next attempt: {new Date(state.nextAt).toLocaleTimeString()}
              </>
            )}
          </p>
          {savedError && <p role="alert">{savedError}</p>}
          <button
            disabled={saving || (!saved.enabled && (!!savedError || dirty))}
            onClick={async () => {
              const token = ++epoch.current;
              const result = await request({
                type: "refreshEnable",
                bindingId: binding.id,
                expected: saved,
                enabled: !saved.enabled,
              });
              if (result && token === epoch.current)
                receive(result as Snapshot);
            }}
          >
            {saved.enabled ? "Disable refresh" : "Enable refresh"}
          </button>
          <button disabled={saving} onClick={open}>
            Edit refresh
          </button>
          <button
            disabled={saving}
            onClick={() =>
              onSave((b) => {
                delete b.refresh;
              })
            }
          >
            Remove refresh
          </button>
        </>
      )}
      {!saved && !editing && (
        <button onClick={open}>Add refresh workflow</button>
      )}
      {editing && (
        <div className="refresh-draft">
          <WorkflowDropdown
            label="Refresh workflow"
            workflows={snapshot!.document.workflows}
            value={draft.workflowId}
            onSelect={(workflowId) => setDraft({ ...draft, workflowId })}
          />
          <FieldLabel
            label="Refresh interval"
            hint="At least 60 seconds, at most one day."
          >
            <select
              aria-label="Refresh interval"
              value={
                [60, 300, 900, 3600, 86400].includes(draft.seconds)
                  ? draft.seconds
                  : "custom"
              }
              onChange={(e) => {
                if (e.target.value !== "custom")
                  setDraft({ ...draft, seconds: Number(e.target.value) });
              }}
            >
              <option value={60}>Every minute</option>
              <option value={300}>Every five minutes</option>
              <option value={900}>Every 15 minutes</option>
              <option value={3600}>Every hour</option>
              <option value={86400}>Every day</option>
              <option value="custom" disabled>
                Custom seconds
              </option>
            </select>
            <input
              aria-label="Refresh seconds"
              type="number"
              min={60}
              max={86400}
              value={draft.seconds}
              onChange={(e) =>
                setDraft({ ...draft, seconds: Number(e.target.value) })
              }
            />
          </FieldLabel>
          <label>
            <input
              type="checkbox"
              checked={draft.initial}
              onChange={(e) =>
                setDraft({ ...draft, initial: e.target.checked })
              }
            />
            Refresh when first visible
          </label>
          <FieldLabel
            label="Refresh inputs"
            hint={`Ordinary JSON. Required: ${snapshot!.document.workflows.find((w) => w.id === draft.workflowId)?.inputs.join(", ") || "none"}`}
          >
            <textarea
              aria-label="Refresh inputs"
              maxLength={16384}
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
            />
          </FieldLabel>
          {error && <p role="alert">{error}</p>}
          <p>
            Save, then enable. Copies and imports stay disabled. Hidden buttons
            stop refreshing; the last good display stays. Success times are
            known only for this session.
          </p>
          <button
            disabled={saving || !parsed?.success}
            onClick={() => {
              if (parsed?.success) {
                const value = { ...parsed.data, enabled: false };
                onSave((b) => {
                  b.refresh = value;
                });
                setEditing(false);
                epoch.current++;
              }
            }}
          >
            Save refresh
          </button>
          <button
            onClick={() => {
              setEditing(false);
              epoch.current++;
            }}
          >
            Cancel refresh edit
          </button>
        </div>
      )}
    </section>
  );
}
