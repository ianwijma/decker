import { useLayoutEffect, useRef, useState } from "react";
import {
  bindingSchema,
  type KeyBinding,
  type ObservationSource,
  type StateAppearance,
  type Target,
  type ToggleConfig,
} from "../../shared/schema";
import { makeAction } from "../../shared/catalog";
import { observedObsTargets } from "../../shared/toggle-observation";
import { buttonAppearance } from "../../shared/feedback";
import {
  selectToggle,
  stateAppearance,
  toggleDisplay,
} from "../../shared/toggle-presentation";
import { useApp } from "./store";
import { FieldLabel, TargetEditor } from "./components";
import { IconPicker } from "./IconPicker";
import { KeyIcon } from "./KeyIcon";
import { SearchableDropdown } from "./SearchableDropdown";
import { ObsConnectionDropdown } from "./ObsConnectionDropdown";
import "./toggle-editor.css";

type Draft = {
  on?: Target;
  off?: Target;
  source: ToggleConfig["source"];
  appearance?: ToggleConfig["appearance"];
};
const action = (): Target => ({
  kind: "action",
  action: makeAction("desktop.notify"),
});
const targetName = (target?: Target) =>
  !target
    ? "Unassigned"
    : target.kind === "workflow"
      ? `Workflow ${target.workflowId}`
      : target.kind === "sequence"
        ? `${target.actions.length} actions`
        : target.action.type;

export function ToggleEditor({
  binding,
  deckId,
  onSave,
}: {
  binding: KeyBinding;
  deckId: string;
  onSave: (fn: (binding: KeyBinding) => void) => void;
}) {
  const { snapshot, saving, request } = useApp();
  const [draft, setDraft] = useState<Draft>(),
    [conversion, setConversion] = useState(""),
    [ordinary, setOrdinary] = useState(false),
    [retention, setRetention] = useState(""),
    [message, setMessage] = useState("");
  const active = useRef(true),
    picker = useRef(0);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      picker.current++;
    };
  }, []);
  const state = selectToggle(snapshot!.toggles ?? [], binding, deckId),
    display = toggleDisplay(binding, state);
  const config = draft ?? binding.toggle;
  useLayoutEffect(() => {
    picker.current++;
  }, [JSON.stringify(config), binding.generation]);
  const conflicts = ["press", "release", "longPress"] as const;
  const hasConflicts = conflicts.some((phase) => binding[phase]);
  const change = (fn: (next: Draft) => void) => {
    const next = structuredClone(config!);
    fn(next);
    setDraft(next);
    picker.current++;
    setMessage("");
  };
  const source = config?.source;
  const observation =
    source?.kind === "observed" ? source.observation : undefined;
  const obsTargets =
    observation?.kind === "obs"
      ? observedObsTargets(observation, snapshot!.observed)
      : [];
  const save = () => {
    if (!draft) return;
    const next = {
      ...binding,
      toggle: draft,
      press: undefined,
      release: undefined,
      longPress: undefined,
    };
    const parsed = bindingSchema.safeParse(next);
    if (!parsed.success) {
      setMessage(
        "Complete both targets and a valid state source before saving.",
      );
      return;
    }
    if (!binding.toggle && hasConflicts && !conversion) {
      setMessage("Choose how to resolve existing assignments.");
      return;
    }
    onSave((k) => {
      k.toggle = parsed.data.toggle;
      delete k.press;
      delete k.release;
      delete k.longPress;
    });
    picker.current++;
    setDraft(undefined);
    setConversion("");
  };
  return (
    <section className="toggle-editor" aria-label="Button mode and toggle">
      <FieldLabel label="Button mode">
        <select
          aria-label="Button mode"
          value={draft || binding.toggle ? "toggle" : "ordinary"}
          onChange={(e) => {
            if (e.target.value === "toggle") {
              setDraft({
                on: action(),
                off: action(),
                source: { kind: "app", initial: "off" },
              });
              setConversion("");
            } else if (binding.toggle) {
              setOrdinary(true);
              setRetention("");
            } else setDraft(undefined);
          }}
        >
          <option value="ordinary">Ordinary button</option>
          <option value="toggle">Toggle on / off</option>
        </select>
      </FieldLabel>
      {ordinary && (
        <div role="group" aria-label="Return to ordinary button">
          <p>
            Select the target to retain as Press. On:{" "}
            {targetName(binding.toggle?.on)}. Off:{" "}
            {targetName(binding.toggle?.off)}.
          </p>
          <select
            aria-label="Retain toggle target"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
          >
            <option value="">Choose explicitly…</option>
            <option value="on">Keep On as Press</option>
            <option value="off">Keep Off as Press</option>
            <option value="none">Remove both targets</option>
          </select>
          <button
            disabled={!retention || saving}
            onClick={() => {
              onSave((k) => {
                k.press =
                  retention === "none"
                    ? undefined
                    : k.toggle![retention as "on" | "off"];
                delete k.toggle;
              });
              setOrdinary(false);
              setDraft(undefined);
            }}
          >
            Confirm ordinary mode
          </button>
          <button onClick={() => setOrdinary(false)}>Cancel conversion</button>
        </div>
      )}
      {!binding.toggle && draft && hasConflicts && (
        <div role="group" aria-label="Resolve assignments">
          <p>
            Toggle mode replaces these saved assignments only when you save:
          </p>
          <ul>
            {conflicts
              .filter((phase) => binding[phase])
              .map((phase) => (
                <li key={phase}>
                  {phase}: {targetName(binding[phase])}
                </li>
              ))}
          </ul>
          <select
            aria-label="Resolve existing assignments"
            value={conversion}
            onChange={(e) => {
              setConversion(e.target.value);
              if (e.target.value === "on" || e.target.value === "off")
                change((d) => {
                  d[e.target.value as "on" | "off"] = structuredClone(
                    binding.press!,
                  );
                });
            }}
          >
            <option value="">Choose explicitly…</option>
            {binding.press && (
              <>
                <option value="on">
                  Retain Press as On; replace other phases
                </option>
                <option value="off">
                  Retain Press as Off; replace other phases
                </option>
              </>
            )}
            <option value="replace">
              Replace all phases with configured targets
            </option>
          </select>
        </div>
      )}
      {display && (
        <>
          <p role="status" className="toggle-status">
            {display.summary}
          </p>
          <button
            disabled={display.disabled || saving || Boolean(draft)}
            onClick={() => void request({ type: "test", deckId, binding })}
          >
            Execute saved toggle
          </button>
          {binding.toggle!.source.kind !== "app" && (
            <button
              disabled={display.busy || saving || Boolean(draft)}
              onClick={() =>
                void request({
                  type: "reconcileToggle",
                  deckId,
                  bindingId: binding.id,
                  generation: binding.generation,
                  expectedToggle: binding.toggle,
                })
              }
            >
              Test / Refresh saved state
            </button>
          )}
          {binding.toggle!.source.kind === "app" && state?.blocked && (
            <div>
              <p>
                Verify the actual state, then acknowledge it without executing a
                target. Repair storage faults and restart first.
              </p>
              {(["on", "off"] as const).map((confirmed) => (
                <button
                  key={confirmed}
                  disabled={
                    display.busy ||
                    saving ||
                    Boolean(draft) ||
                    state.error === "storage"
                  }
                  onClick={() =>
                    void request({
                      type: "recoverToggle",
                      deckId,
                      bindingId: binding.id,
                      confirmed,
                      generation: binding.generation,
                    })
                  }
                >
                  I verified state is {confirmed}
                </button>
              ))}
            </div>
          )}
          <Preview
            label="Live saved state"
            appearance={buttonAppearance(
              binding,
              snapshot!.observed,
              snapshot!.document.settings.accent,
              deckId,
              snapshot!.toggles,
            )}
          />
        </>
      )}
      {config && (
        <>
          {(["on", "off"] as const).map((slot) => (
            <fieldset
              key={slot}
              aria-label={`${slot === "on" ? "On" : "Off"} target`}
            >
              <legend>{slot === "on" ? "On" : "Off"} target</legend>
              <TargetEditor
                target={config[slot]}
                workflows={snapshot!.document.workflows}
                onChange={(target) =>
                  change((d) => {
                    d[slot] = target;
                  })
                }
              />
            </fieldset>
          ))}
          <FieldLabel label="State source">
            <select
              aria-label="State source"
              value={
                source!.kind === "observed" ? observation!.kind : source!.kind
              }
              onChange={(e) =>
                change((d) => {
                  d.source =
                    e.target.value === "app"
                      ? { kind: "app", initial: "off" }
                      : e.target.value === "external"
                        ? {
                            kind: "external",
                            probe: action(),
                            timeoutMs: 10000,
                          }
                        : {
                            kind: "observed",
                            onWhen: true,
                            observation:
                              e.target.value === "media"
                                ? { kind: "media", player: "" }
                                : e.target.value === "audio"
                                  ? { kind: "audio", target: "microphone" }
                                  : {
                                      kind: "obs",
                                      connectionId:
                                        snapshot!.document.connections[0]?.id ??
                                        "",
                                      property: "recording",
                                      name: "",
                                    },
                          };
                })
              }
            >
              <option value="app">App-managed</option>
              <option value="external">Custom read-only probe</option>
              <option value="media">Observed media playback</option>
              <option value="audio">Observed audio mute</option>
              <option value="obs">Observed OBS state</option>
            </select>
          </FieldLabel>
          {source?.kind === "app" && (
            <FieldLabel label="Initial state">
              <select
                aria-label="Initial state"
                value={source.initial}
                onChange={(e) =>
                  change((d) => {
                    d.source = {
                      kind: "app",
                      initial: e.target.value as "on" | "off",
                    };
                  })
                }
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </FieldLabel>
          )}
          {source?.kind === "external" && (
            <fieldset aria-label="State probe">
              <legend>Read-only state probe</legend>
              <p>
                Commands and workflows should only read state; Decker cannot
                prove they are read-only. Accepted: boolean, exact on/off,
                workflow {"{on:boolean}"}, or command stdout on/off/true/false.
                Save first, then explicitly Test / Refresh.
              </p>
              <TargetEditor
                target={source.probe}
                workflows={snapshot!.document.workflows}
                onChange={(target) =>
                  change((d) => {
                    if (d.source.kind === "external") d.source.probe = target!;
                  })
                }
              />
              <FieldLabel label="Probe timeout (ms)">
                <input
                  aria-label="Probe timeout (ms)"
                  type="number"
                  min={10}
                  max={60000}
                  value={source.timeoutMs}
                  onChange={(e) =>
                    change((d) => {
                      if (d.source.kind === "external")
                        d.source.timeoutMs = Number(e.target.value);
                    })
                  }
                />
              </FieldLabel>
            </fieldset>
          )}
          {observation && (
            <>
              {observation.kind === "media" && (
                <SearchableDropdown
                  label="Observed player"
                  searchLabel="Search observed players"
                  value={observation.player}
                  options={[
                    { id: "", name: "Default player (lexical first)" },
                    ...Object.keys((snapshot!.observed.media ?? {}) as object)
                      .filter((k) => k.startsWith("org.mpris.MediaPlayer2."))
                      .map((id) => ({ id, name: id })),
                  ]}
                  onSelect={(player) =>
                    change((d) => {
                      if (d.source.kind === "observed")
                        d.source.observation = { kind: "media", player };
                    })
                  }
                />
              )}
              {observation.kind === "audio" && (
                <FieldLabel label="Observed audio target">
                  <select
                    aria-label="Observed audio target"
                    value={observation.target}
                    onChange={(e) =>
                      change((d) => {
                        if (d.source.kind === "observed")
                          d.source.observation = {
                            kind: "audio",
                            target: e.target.value as "microphone" | "speaker",
                          };
                      })
                    }
                  >
                    <option value="microphone">Default microphone</option>
                    <option value="speaker">Default speaker</option>
                  </select>
                </FieldLabel>
              )}
              {observation.kind === "obs" && (
                <>
                  <ObsConnectionDropdown
                    value={observation.connectionId}
                    onSelect={(connectionId) =>
                      change((d) => {
                        if (
                          d.source.kind === "observed" &&
                          d.source.observation.kind === "obs"
                        )
                          d.source.observation.connectionId = connectionId;
                      })
                    }
                  />
                  <FieldLabel label="Observed OBS property">
                    <select
                      aria-label="Observed OBS property"
                      value={observation.property}
                      onChange={(e) =>
                        change((d) => {
                          if (
                            d.source.kind === "observed" &&
                            d.source.observation.kind === "obs"
                          )
                            d.source.observation.property = e.target
                              .value as Extract<
                              ObservationSource,
                              { kind: "obs" }
                            >["property"];
                        })
                      }
                    >
                      {[
                        "recording",
                        "streaming",
                        "scene",
                        "mute",
                        "source",
                      ].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </FieldLabel>
                  {["scene", "mute", "source"].includes(
                    observation.property,
                  ) && (
                    <>
                      <SearchableDropdown
                        label="Observed OBS target"
                        searchLabel="Search observed OBS targets"
                        hideIds
                        value={JSON.stringify([
                          observation.name,
                          observation.property === "source"
                            ? (observation.sourceId ?? null)
                            : null,
                        ])}
                        options={obsTargets.map((target) => ({
                          id: target.id,
                          name:
                            target.sourceId === undefined
                              ? target.name
                              : `${target.name} / item ${target.sourceId}`,
                        }))}
                        missingLabel="Target unavailable — retained below"
                        onSelect={(id) => {
                          const target = obsTargets.find((t) => t.id === id);
                          if (target)
                            change((d) => {
                              if (
                                d.source.kind === "observed" &&
                                d.source.observation.kind === "obs"
                              ) {
                                d.source.observation.name = target.name;
                                d.source.observation.sourceId = target.sourceId;
                              }
                            });
                        }}
                      />
                      <FieldLabel label="Observed OBS name">
                        <input
                          aria-label="Observed OBS name"
                          maxLength={200}
                          value={observation.name}
                          onChange={(e) =>
                            change((d) => {
                              if (
                                d.source.kind === "observed" &&
                                d.source.observation.kind === "obs"
                              )
                                d.source.observation.name = e.target.value;
                            })
                          }
                        />
                      </FieldLabel>
                    </>
                  )}
                  {observation.property === "source" && (
                    <FieldLabel label="Observed scene item ID">
                      <input
                        aria-label="Observed scene item ID"
                        type="number"
                        min={0}
                        value={observation.sourceId ?? ""}
                        onChange={(e) =>
                          change((d) => {
                            if (
                              d.source.kind === "observed" &&
                              d.source.observation.kind === "obs"
                            )
                              d.source.observation.sourceId = Number(
                                e.target.value,
                              );
                          })
                        }
                      />
                    </FieldLabel>
                  )}
                </>
              )}
              <FieldLabel label="On-state meaning">
                <select
                  aria-label="On-state meaning"
                  value={String(source!.kind === "observed" && source!.onWhen)}
                  onChange={(e) =>
                    change((d) => {
                      if (d.source.kind === "observed")
                        d.source.onWhen = e.target.value === "true";
                    })
                  }
                >
                  <option value="true">
                    On when playing / muted / active / matching scene
                  </option>
                  <option value="false">
                    On when paused or stopped / unmuted / inactive / other scene
                  </option>
                </select>
              </FieldLabel>
              <p>
                Missing, disconnected or unknown observations disable execution.
                Targets do not optimistically change state.
              </p>
            </>
          )}
          {(["on", "off"] as const).map((slot) => {
            const override = config.appearance?.[slot] ?? {},
              preview = stateAppearance(binding.appearance, override);
            const appearanceChange = (
              fn: (appearance: StateAppearance) => void,
            ) =>
              change((d) => {
                d.appearance ??= {};
                d.appearance[slot] ??= {};
                fn(d.appearance[slot]!);
              });
            return (
              <fieldset key={slot} aria-label={`${slot} appearance`}>
                <legend>{slot} appearance</legend>
                <Preview
                  label={`Authored ${slot} preview (does not execute)`}
                  appearance={preview}
                />
                <FieldLabel label={`${slot} label`}>
                  <input
                    aria-label={`${slot} label`}
                    maxLength={80}
                    placeholder={`Inherit: ${binding.appearance.label}`}
                    value={override.label ?? ""}
                    onChange={(e) =>
                      appearanceChange((a) => {
                        a.label = e.target.value;
                      })
                    }
                  />
                </FieldLabel>
                <IconPicker
                  value={override.icon ?? binding.appearance.icon}
                  onSelect={(icon) =>
                    appearanceChange((a) => {
                      a.icon = icon;
                      a.asset = null;
                    })
                  }
                />
                <FieldLabel label={`${slot} background`}>
                  <input
                    aria-label={`${slot} background`}
                    type="color"
                    value={preview.background}
                    onChange={(e) =>
                      appearanceChange((a) => {
                        a.background = e.target.value;
                      })
                    }
                  />
                </FieldLabel>
                <button
                  onClick={async () => {
                    const token = ++picker.current,
                      asset = await request({ type: "asset" });
                    if (
                      active.current &&
                      picker.current === token &&
                      typeof asset === "string"
                    )
                      appearanceChange((a) => {
                        a.asset = asset;
                      });
                  }}
                >
                  Choose {slot} image…
                </button>
                <button
                  onClick={() =>
                    appearanceChange((a) => {
                      a.asset = null;
                    })
                  }
                >
                  Clear {slot} image
                </button>
                <button
                  onClick={() =>
                    change((d) => {
                      if (d.appearance) delete d.appearance[slot];
                    })
                  }
                >
                  Reset {slot} overrides
                </button>
              </fieldset>
            );
          })}
          {draft && (
            <div className="toggle-draft">
              <p>
                Unsaved draft. Targets and probes are inactive. Save a complete
                configuration before entering managed secrets.
              </p>
              <button disabled={saving} onClick={save}>
                Save toggle configuration
              </button>
              <button
                onClick={() => {
                  setDraft(undefined);
                  setConversion("");
                  picker.current++;
                }}
              >
                Cancel toggle edits
              </button>
            </div>
          )}
        </>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
function Preview({
  label,
  appearance,
}: {
  label: string;
  appearance: KeyBinding["appearance"];
}) {
  return (
    <div className="toggle-preview" aria-label={label}>
      <small>{label}</small>
      <div style={{ backgroundColor: appearance.background }}>
        {appearance.asset ? (
          <img alt="" src={`decker-asset://${appearance.asset}`} />
        ) : (
          <KeyIcon icon={appearance.icon} label={appearance.label} />
        )}
        <span>{appearance.label}</span>
      </div>
    </div>
  );
}
