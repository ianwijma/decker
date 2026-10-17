import {
  selectToggle,
  stateAppearance,
  toggleDisplay,
} from "./toggle-presentation";
import type { ToggleState } from "./toggle-contract";
import type { Json, KeyBinding } from "./schema";
import {
  mediaAction,
  mediaActions,
  mediaPlayback,
  mediaPlaybackIcons,
} from "./media";
/** Display the integration's observed state, never a guessed local toggle count. */
export function observedAppearance(
  binding: KeyBinding,
  observed: Record<string, Json>,
  accent: string,
): KeyBinding["appearance"] {
  const appearance = { ...binding.appearance },
    target = binding.press;
  if (target?.kind !== "action") return appearance;
  const { type, config } = target.action;
  if (type === "obs.control") {
    const state = observed[`obs:${config.connectionId}`] as
      Record<string, Json> | undefined;
    if (!state?.connected) return { ...appearance, icon: "⚠" };
    const active =
      config.operation === "scene"
        ? state.scene === config.name
        : config.operation === "source"
          ? state[`source:${config.name}:${config.sourceId}`]
          : config.operation === "mute"
            ? state[`mute:${config.name}`]
            : state[String(config.operation)];
    if (typeof active === "boolean") {
      appearance.background = active ? accent : appearance.background;
      if (config.operation === "mute")
        appearance.label = active ? "Muted" : "Live";
    }
  }
  if (
    type === "audio.control" &&
    config.operation === "mute" &&
    [
      "@DEFAULT_AUDIO_SOURCE@",
      "@DEFAULT_AUDIO_SINK@",
      "@DEFAULT_SOURCE@",
      "@DEFAULT_SINK@",
    ].includes(String(config.target))
  ) {
    const key = String(config.target).includes("SOURCE")
        ? "microphone"
        : "speaker",
      state = observed[key] as Record<string, Json> | undefined;
    const text = String(state?.stdout ?? "");
    if (text) {
      const muted = /\[MUTED\]|Mute:\s*yes/i.test(text);
      appearance.label = muted ? "Muted" : "Live";
      if (muted) appearance.background = accent;
    }
  }
  if (mediaAction(type, config)) {
    const state = observed.media as Record<string, Json> | undefined;
    const playback = mediaPlayback(config, state);
    if (playback === "Playing") appearance.background = accent;
    // The catalog's neutral default opts into observed icons. Authored text,
    // other pack icons and uploaded images retain precedence; labels stay authored.
    const dynamic = mediaActions.find(
      (action) => action.id === "media.playPause",
    )!;
    if (
      type === dynamic.id &&
      !appearance.asset &&
      appearance.icon === dynamic.icon
    )
      appearance.icon = mediaPlaybackIcons[playback];
  }
  return appearance;
}

/** Runtime identity: history without deck/generation provenance cannot color a key. */
export function activityKey(
  deckId: string,
  binding: Pick<KeyBinding, "id" | "generation">,
) {
  return JSON.stringify([deckId, binding.id, binding.generation]);
}
export function selectBindingRun(
  runs: import("./schema").RunRecord[],
  binding: KeyBinding,
  deckId: string,
) {
  const matching = runs.filter(
    (r) =>
      r.context?.source.kind !== "refresh" &&
      r.deckId === deckId &&
      r.bindingId === binding.id &&
      r.generation === binding.generation,
  );
  return matching.findLast((r) => r.status === "running") ?? matching.at(-1);
}

export type ButtonAppearance = KeyBinding["appearance"] & {
  stateLabel?: string;
  imageStatus?: "stale";
  refreshStatus?: string;
};
/** The same composition feeds desktop keys, web views and device frames. */
export function buttonAppearance(
  binding: KeyBinding,
  observed: Record<string, Json>,
  accent: string,
  deckId: string,
  toggles: ToggleState[] = [],
): ButtonAppearance {
  const toggle = selectToggle(toggles, binding, deckId);
  let appearance: ButtonAppearance = binding.toggle
    ? stateAppearance(
        binding.appearance,
        toggle && toggle.confirmed !== "unknown"
          ? binding.toggle.appearance?.[toggle.confirmed]
          : undefined,
      )
    : observedAppearance(binding, observed, accent);
  const display = toggleDisplay(binding, toggle);
  if (display)
    appearance.stateLabel = `${display.confirmed}${toggle?.transitioning ? " · transitioning" : toggle?.reconciling ? " · reconciling" : toggle?.blocked ? " · blocked" : !toggle?.fresh ? " · stale" : toggle?.error ? " · failed" : ""}`;
  const dynamic = observed.buttonDisplay as
    Record<string, import("./schema").StateAppearance> | undefined;
  appearance = {
    ...stateAppearance(appearance, dynamic?.[activityKey(deckId, binding)]),
    stateLabel: appearance.stateLabel,
    imageStatus:
      (
        dynamic?.[activityKey(deckId, binding)] as
          { imageStatus?: string } | undefined
      )?.imageStatus === "stale"
        ? "stale"
        : undefined,
  };
  const refresh = observed.buttonRefresh as Record<string, string> | undefined;
  appearance.refreshStatus = binding.refresh
    ? `Refresh ${refresh?.[activityKey(deckId, binding)] ?? (binding.refresh.enabled ? "waiting" : "idle")}`
    : undefined;
  const feedback = observed.buttonFeedback as
    Record<string, Record<string, Json>> | undefined;
  const state = feedback?.[activityKey(deckId, binding)];
  // PR21 seam: bounded dynamic/legacy display overrides precede temporary activity.
  if (typeof state?.label === "string") appearance.label = state.label;
  if (typeof state?.background === "string")
    appearance.background = state.background;
  if (state?.status === "running") appearance.background = accent;
  else if (state?.status === "success")
    appearance.background = appearance.success;
  else if (state?.status === "failure")
    appearance.background = appearance.error;
  return appearance;
}

/** Compatibility projection for label/background consumers of buttonFeedback.
 * Persistent fields are read from the display service, never owned by activity.
 */
export function legacyDisplayFeedback(
  activity: Record<string, Json>,
  display: Record<string, Json>,
): Record<string, Json> {
  const result = structuredClone(activity);
  for (const [key, value] of Object.entries(display)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fields: Record<string, Json> = {};
    for (const field of ["label", "background"] as const)
      if (typeof value[field] === "string") fields[field] = value[field];
    if (Object.keys(fields).length)
      result[key] = {
        ...(result[key] as Record<string, Json> | undefined),
        ...fields,
      };
  }
  return result;
}
