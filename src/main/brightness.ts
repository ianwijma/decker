import { brightnessValue } from "../shared/brightness";
import type { AppDocument } from "../shared/schema";

/** Call inside the document mutation queue, after checking invocation liveness. */
export async function commitBrightness(
  current: AppDocument,
  action: string,
  config: Record<string, unknown>,
  deckId: string | undefined,
  save: (next: AppDocument) => Promise<void>,
): Promise<{ document: AppDocument; value: number }> {
  const next = structuredClone(current);
  const deck = next.decks.find((d) => d.id === (deckId ?? next.activeDeckId));
  if (!deck) throw new Error("No originating deck selected");
  const value = brightnessValue(action, deck.brightness, config);
  deck.brightness = value;
  // Do not expose a persistent success or mutate live state on storage failure.
  await save(next);
  return { document: next, value };
}
