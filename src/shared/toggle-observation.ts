import type { Json, ObservationSource } from "./schema";
import { mediaPlayback } from "./media";

/** One typed interpretation for runtime and UI. Unknown is never coerced to off. */
export function observedToggle(
  source: ObservationSource,
  observed: Record<string, Json>,
): boolean | undefined {
  if (source.kind === "media") {
    const status = mediaPlayback(
      { player: source.player },
      observed.media as Record<string, Json> | undefined,
    );
    return status === "Playing"
      ? true
      : status === "Paused" || status === "Stopped"
        ? false
        : undefined;
  }
  if (source.kind === "audio") {
    const state = observed[source.target] as Record<string, Json> | undefined;
    if (
      !state ||
      state.unavailable ||
      state.exitCode !== 0 ||
      typeof state.stdout !== "string"
    )
      return undefined;
    const text = state.stdout;
    if (/\[MUTED\]|Mute:\s*yes/i.test(text)) return true;
    if (/Mute:\s*no|Volume:\s*[0-9.]+/i.test(text)) return false;
    return undefined;
  }
  const state = observed[`obs:${source.connectionId}`] as
    Record<string, Json> | undefined;
  if (!state?.connected) return undefined;
  if (source.property === "scene")
    return typeof state.scene === "string"
      ? state.scene === source.name
      : undefined;
  const key =
    source.property === "mute"
      ? `mute:${source.name}`
      : source.property === "source"
        ? `source:${source.name}:${source.sourceId}`
        : source.property;
  return typeof state[key] === "boolean" ? state[key] : undefined;
}

/** Named choices only for truth the current adapter actually exposes. */
export function observedObsTargets(
  source: Extract<ObservationSource, { kind: "obs" }>,
  observed: Record<string, Json>,
): { id: string; name: string; sourceId?: number }[] {
  const state = observed[`obs:${source.connectionId}`] as
    Record<string, Json> | undefined;
  if (!state?.connected) return [];
  const choices = new Map<
    string,
    { id: string; name: string; sourceId?: number }
  >();
  const add = (name: string, sourceId?: number) => {
    if (!name || name.length > 200) return;
    const id = JSON.stringify([name, sourceId ?? null]);
    choices.set(id, {
      id,
      name,
      ...(sourceId === undefined ? {} : { sourceId }),
    });
  };
  if (source.property === "scene" && typeof state.scene === "string")
    add(state.scene);
  for (const [key, value] of Object.entries(state)) {
    if (
      source.property === "mute" &&
      key.startsWith("mute:") &&
      typeof value === "boolean"
    )
      add(key.slice(5));
    const match = /^source:(.+):(\d+)$/.exec(key);
    if (match && typeof value === "boolean") {
      if (source.property === "scene") add(match[1]);
      else if (source.property === "source") add(match[1], Number(match[2]));
    }
  }
  return [...choices.values()]
    .slice(0, 4096)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || (a.sourceId ?? 0) - (b.sourceId ?? 0),
    );
}
