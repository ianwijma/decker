import { useRef, useState } from "react";
import { uid } from "../../shared/defaults";
import {
  scheduleSchema,
  scheduleError,
  type Schedule,
} from "../../shared/schedules";
import { useApp } from "./store";
import { FieldLabel } from "./components";
import type { Snapshot } from "../../shared/schema";
import "./workflow-schedules.css";
export function WorkflowSchedules({ workflowId }: { workflowId: string }) {
  const { snapshot, edit, request, receive, saving } = useApp();
  const previewEpoch = useRef(0);
  const [draft, setDraft] = useState<Schedule>();
  const [inputText, setInputText] = useState("{}");
  const [preview, setPreview] = useState<{ at: number; label: string }[]>([]);
  const document = snapshot!.document;
  const schedules = document.schedules.filter(
    (s) => s.workflowId === workflowId,
  );
  let parsed: ReturnType<typeof scheduleSchema.safeParse> | undefined;
  let error = "";
  if (draft) {
    try {
      parsed = scheduleSchema.safeParse({
        ...draft,
        inputs: JSON.parse(inputText),
      });
      error = parsed.success
        ? (scheduleError(parsed.data, document) ?? "")
        : parsed.error.issues[0].message;
    } catch {
      error = "Enter valid JSON inputs";
    }
  }
  const change = (value: Schedule) => {
    previewEpoch.current++;
    setDraft(value);
    setPreview([]);
  };
  const open = (value: Schedule) => {
    change(structuredClone(value));
    setInputText(JSON.stringify(value.inputs, null, 2));
  };
  const time = (at: number, schedule: Schedule) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone:
        schedule.timing.kind === "cron" ? schedule.timing.timezone : "UTC",
    }).format(at);
  return (
    <section className="workflow-schedules" aria-label="Workflow schedules">
      <h3>Schedules</h3>
      <p className="muted small">
        Schedules run while Decker is running. Closing to tray keeps schedules
        active; Quit stops them. Missed runs are skipped.
      </p>
      {schedules.map((schedule) => {
        const state = snapshot?.schedules?.find((s) => s.id === schedule.id);
        const invalid = scheduleError(schedule, document);
        return (
          <article
            key={schedule.id}
            className="schedule-card"
            aria-label={`Schedule ${schedule.name}`}
          >
            <strong>{schedule.name}</strong>
            <p className="small">
              {schedule.timing.kind === "interval"
                ? `Every ${schedule.timing.seconds} seconds (elapsed time)`
                : `${schedule.timing.expression} · ${schedule.timing.timezone}`}
            </p>
            <p className="small" role="status">
              {schedule.enabled ? "Enabled" : "Disabled"}
              {state?.busy ? " · Running" : ""}
              {state?.nextAt && schedule.enabled
                ? ` · Next: ${time(state.nextAt, schedule)}`
                : ""}
              {state?.lastStatus ? ` · Last: ${state.lastStatus}` : ""}
              {state?.lastAt ? ` at ${time(state.lastAt, schedule)}` : ""}
              {state?.skipped ? ` · Skipped: ${state.skipped}` : ""}
            </p>
            {(invalid || state?.error) && (
              <p className="danger-text small">{invalid || state?.error}</p>
            )}
            <div className="row">
              <button
                disabled={saving || (!!invalid && !schedule.enabled)}
                onClick={async () => {
                  const result = await request({
                    type: "scheduleEnable",
                    id: schedule.id,
                    enabled: !schedule.enabled,
                    expected: schedule,
                  });
                  if (result) receive(result as Snapshot);
                }}
              >
                {schedule.enabled ? "Disable schedule" : "Enable schedule"}
              </button>
              <button disabled={saving} onClick={() => open(schedule)}>
                Edit schedule
              </button>
              <button
                disabled={saving || document.schedules.length >= 200}
                onClick={() =>
                  edit((d) => {
                    d.schedules.push({
                      ...structuredClone(schedule),
                      id: uid(),
                      name: `${schedule.name.slice(0, 70)} copy`,
                      enabled: false,
                    });
                  })
                }
              >
                Duplicate schedule
              </button>
              <button
                disabled={saving}
                onClick={() =>
                  edit((d) => {
                    d.schedules = d.schedules.filter(
                      (s) => s.id !== schedule.id,
                    );
                  })
                }
              >
                Delete schedule
              </button>
            </div>
          </article>
        );
      })}
      {!draft ? (
        <button
          className="wide"
          disabled={saving || document.schedules.length >= 200}
          onClick={() =>
            open({
              id: uid(),
              name: "New schedule",
              workflowId,
              enabled: false,
              inputs: {},
              timing: { kind: "interval", seconds: 300 },
            })
          }
        >
          Add schedule
        </button>
      ) : (
        <div className="schedule-card" aria-label="Schedule editor">
          <FieldLabel label="Schedule name">
            <input
              value={draft.name}
              maxLength={80}
              onChange={(e) => change({ ...draft, name: e.target.value })}
            />
          </FieldLabel>
          <FieldLabel label="Schedule type">
            <select
              value={draft.timing.kind}
              onChange={(e) =>
                change({
                  ...draft,
                  timing:
                    e.target.value === "cron"
                      ? {
                          kind: "cron",
                          expression: "0 9 * * *",
                          timezone:
                            Intl.DateTimeFormat().resolvedOptions().timeZone ||
                            "UTC",
                        }
                      : { kind: "interval", seconds: 300 },
                })
              }
            >
              <option value="interval">Interval</option>
              <option value="cron">Cron</option>
            </select>
          </FieldLabel>
          {draft.timing.kind === "interval" ? (
            <FieldLabel
              label="Interval seconds"
              hint="60 seconds to 365 days. Anchored when enabled or restarted; suspend/resume starts a new cadence."
            >
              <input
                type="number"
                aria-label="Interval seconds"
                min={60}
                max={31536000}
                value={draft.timing.seconds}
                onChange={(e) =>
                  change({
                    ...draft,
                    timing: {
                      kind: "interval",
                      seconds: Number(e.target.value),
                    },
                  })
                }
              />
            </FieldLabel>
          ) : (
            <>
              <FieldLabel
                label="Cron expression"
                hint="Five numeric fields: minute hour day month weekday. Day and weekday use OR when both restricted."
              >
                <input
                  aria-label="Cron expression"
                  value={draft.timing.expression}
                  maxLength={120}
                  onChange={(e) => {
                    if (draft.timing.kind === "cron")
                      change({
                        ...draft,
                        timing: { ...draft.timing, expression: e.target.value },
                      });
                  }}
                />
              </FieldLabel>
              <FieldLabel
                label="Timezone"
                hint="IANA zone. DST gaps are skipped; a repeated local time runs once."
              >
                <input
                  aria-label="Timezone"
                  value={draft.timing.timezone}
                  maxLength={100}
                  onChange={(e) => {
                    if (draft.timing.kind === "cron")
                      change({
                        ...draft,
                        timing: { ...draft.timing, timezone: e.target.value },
                      });
                  }}
                />
              </FieldLabel>
            </>
          )}
          <FieldLabel
            label="Schedule inputs"
            hint={`Ordinary JSON; required names: ${document.workflows.find((w) => w.id === workflowId)?.inputs.join(", ") || "none"}. No selected deck or triggering button is supplied.`}
          >
            <textarea
              className="code"
              aria-label="Schedule inputs"
              maxLength={16384}
              value={inputText}
              onChange={(e) => {
                previewEpoch.current++;
                setInputText(e.target.value);
                setPreview([]);
              }}
            />
          </FieldLabel>
          {error && (
            <p className="danger-text" role="alert">
              {error}
            </p>
          )}
          <button
            disabled={!!error || !parsed?.success}
            onClick={async () => {
              if (!parsed?.success) return;
              const epoch = ++previewEpoch.current;
              const result = await request({
                type: "schedulePreview",
                schedule: parsed.data,
                count: 3,
              });
              if (result && epoch === previewEpoch.current)
                setPreview(result as typeof preview);
            }}
          >
            Preview next runs
          </button>
          {preview.length > 0 && (
            <ol aria-label="Next occurrences">
              {preview.map((p) => (
                <li key={p.at}>{p.label}</li>
              ))}
            </ol>
          )}
          <p className="muted small">
            Preview does not run anything. New and copied schedules are saved
            disabled; enable each schedule explicitly. Editing, disabling or
            deleting cancels its current run; completed effects remain.
          </p>
          <div className="row">
            <button
              disabled={saving || !!error || !parsed?.success}
              onClick={() => {
                if (!parsed?.success) return;
                const value = parsed.data;
                edit((d) => {
                  const index = d.schedules.findIndex((s) => s.id === value.id);
                  if (index < 0) d.schedules.push({ ...value, enabled: false });
                  else d.schedules[index] = value;
                });
                setDraft(undefined);
              }}
            >
              Save schedule
            </button>
            <button
              onClick={() => {
                previewEpoch.current++;
                setDraft(undefined);
              }}
            >
              Cancel schedule edit
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
