import type { Json } from "./schema";

/** Persisted IDs and the single mapping used by catalog, dispatch and feedback. */
export const mediaActions = [
  {
    id: "media.play",
    name: "Play",
    operation: "Play",
    icon: "pack:lucide:v1:play",
  },
  {
    id: "media.pause",
    name: "Pause",
    operation: "Pause",
    icon: "pack:lucide:v1:pause",
  },
  {
    id: "media.playPause",
    name: "Play/Pause",
    operation: "PlayPause",
    icon: "pack:lucide:v1:music",
  },
  {
    id: "media.next",
    name: "Next",
    operation: "Next",
    icon: "pack:lucide:v1:skip-forward",
  },
  {
    id: "media.previous",
    name: "Previous",
    operation: "Previous",
    icon: "pack:lucide:v1:skip-back",
  },
  {
    id: "media.stop",
    name: "Stop",
    operation: "Stop",
    icon: "pack:lucide:v1:square",
  },
] as const;
export function mediaAction(type: string, config: Record<string, Json>) {
  return type === "media.control"
    ? { operation: String(config.operation ?? "") }
    : mediaActions.find((action) => action.id === type);
}

/** Blank selection always means the first sorted enumerated bus name. */
export const selectedMediaPlayer = (player: string, defaultPlayer: string) =>
  player || defaultPlayer;
export type MediaPlayback =
  "Playing" | "Paused" | "Stopped" | "unknown" | "unavailable";
export function mediaPlayback(
  config: Record<string, Json>,
  state: Record<string, Json> | undefined,
): MediaPlayback {
  const player = selectedMediaPlayer(
    String(config.player ?? ""),
    String(state?.defaultPlayer ?? ""),
  );
  if (!state || state.unavailable || !player || !(player in state))
    return "unavailable";
  const status = state[player];
  return status === "Playing" || status === "Paused" || status === "Stopped"
    ? status
    : "unknown";
}
export const mediaPlaybackIcons: Record<MediaPlayback, string> = {
  Playing: "pack:lucide:v1:pause",
  Paused: "pack:lucide:v1:play",
  Stopped: "pack:lucide:v1:square",
  unknown: "pack:lucide:v1:circle-help",
  unavailable: "pack:lucide:v1:triangle-alert",
};
