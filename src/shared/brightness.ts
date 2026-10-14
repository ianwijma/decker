import { z } from "zod";
import type { AppDocument } from "./schema";

export const DEFAULT_BRIGHTNESS_STEP = 10;
export const brightnessValueSchema = z.number().int().min(0).max(100);
export const brightnessStepSchema = z.number().int().min(1).max(100);
export const brightnessActions = [
  "deck.brightness",
  "deck.brightnessIncrease",
  "deck.brightnessDecrease",
] as const;

export function brightnessValue(
  action: string,
  current: number,
  config: Record<string, unknown>,
): number {
  if (action === "deck.brightness")
    return brightnessValueSchema.parse(config.value);
  if (!brightnessActions.includes(action as (typeof brightnessActions)[number]))
    throw new Error(`Unknown brightness action: ${action}`);
  const step = brightnessStepSchema.parse(config.step);
  return Math.min(
    100,
    Math.max(
      0,
      current + (action === "deck.brightnessIncrease" ? step : -step),
    ),
  );
}

// Only an explicit slider edit may replace the live value in an editor save.
export function preserveBrightness(
  current: AppDocument,
  next: AppDocument,
  editedDecks: string[] = [],
) {
  for (const deck of next.decks) {
    const previous = current.decks.find((d) => d.id === deck.id);
    if (previous && !editedDecks.includes(deck.id))
      deck.brightness = previous.brightness;
  }
}

export function brightnessEdits(before: AppDocument, after: AppDocument) {
  return after.decks
    .filter((deck) => {
      const previous = before.decks.find((d) => d.id === deck.id);
      return previous && previous.brightness !== deck.brightness;
    })
    .map((deck) => deck.id);
}
