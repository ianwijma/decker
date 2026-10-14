import type { Json, KeyBinding } from "./schema";
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
  if (type === "media.control") {
    const state = observed.media as Record<string, Json> | undefined;
    const player = String(config.player || state?.defaultPlayer || "");
    if (state?.[player] === "Playing") appearance.background = accent;
  }
  return appearance;
}
