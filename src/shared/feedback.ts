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
      r.deckId === deckId &&
      r.bindingId === binding.id &&
      r.generation === binding.generation,
  );
  return matching.findLast((r) => r.status === "running") ?? matching.at(-1);
}

/** The same composition feeds desktop keys, web views and device frames. */
export function buttonAppearance(
  binding: KeyBinding,
  observed: Record<string, Json>,
  accent: string,
  deckId: string,
) {
  const appearance = observedAppearance(binding, observed, accent);
  const feedback = observed.buttonFeedback as
    Record<string, Record<string, Json>> | undefined;
  const state = feedback?.[activityKey(deckId, binding)];
  if (state?.status === "running") appearance.background = accent;
  else if (state?.status === "success")
    appearance.background = appearance.success;
  else if (state?.status === "failure")
    appearance.background = appearance.error;
  // Legacy deck.appearance overrides remain independent of transient run activity.
  if (typeof state?.label === "string") appearance.label = state.label;
  if (typeof state?.background === "string")
    appearance.background = state.background;
  return appearance;
}
