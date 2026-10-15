import type { KeyBinding, StateAppearance } from "./schema";
import type { ToggleState } from "./toggle-contract";

export type ToggleDisplay = {
  confirmed: "on" | "off" | "unknown";
  busy: boolean;
  disabled: boolean;
  summary: string;
};
const explanations = {
  "transition-failed": "Target failed; confirmed state retained.",
  cancelled: "Cancelled; confirmed state retained.",
  timeout: "Timed out; confirmed state retained.",
  "probe-invalid":
    "Probe returned invalid state. Refresh after fixing the probe.",
  "probe-failed": "State probe failed. Refresh after checking the source.",
  "probe-disagreed": "Observed state differs from the requested state.",
  storage: "Repair toggle storage and restart before recovery.",
  interrupted: "Interrupted effect. Verify the actual state before recovery.",
  unavailable: "Observation unavailable. Check the source and refresh.",
};
export function toggleDisplay(
  binding: KeyBinding,
  state?: ToggleState,
): ToggleDisplay | undefined {
  if (!binding.toggle) return undefined;
  const confirmed = state?.confirmed ?? "unknown",
    busy = Boolean(state?.transitioning || state?.reconciling);
  const summary = [
    confirmed === "unknown" ? "Unknown" : `Confirmed ${confirmed}`,
    state?.transitioning
      ? "Transitioning"
      : state?.reconciling
        ? "Reconciling"
        : state?.blocked
          ? "Blocked"
          : !state?.fresh
            ? "Stale"
            : "",
    state?.error ? explanations[state.error] : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    confirmed,
    busy,
    disabled:
      busy ||
      !state?.fresh ||
      Boolean(state?.blocked) ||
      confirmed === "unknown",
    summary,
  };
}
export function selectToggle(
  states: ToggleState[],
  binding: KeyBinding,
  deckId: string,
) {
  return states.find(
    (s) =>
      s.deckId === deckId &&
      s.bindingId === binding.id &&
      s.generation === binding.generation,
  );
}
/** Omitted fields inherit. A selected icon clears an inherited asset unless an asset is authored in the same override. */
export function stateAppearance(
  base: KeyBinding["appearance"],
  override?: StateAppearance,
): KeyBinding["appearance"] {
  const appearance = { ...base };
  if (!override) return appearance;
  for (const key of ["label", "icon", "background"] as const)
    if (override[key] !== undefined) appearance[key] = override[key];
  if (
    override.asset === null ||
    (override.icon !== undefined && override.asset === undefined)
  )
    delete appearance.asset;
  else if (override.asset !== undefined) appearance.asset = override.asset;
  return appearance;
}
