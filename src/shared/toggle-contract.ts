import type { KeyBinding, AppDocument } from "./schema";

export type ConfirmedState = "on" | "off";
export type ToggleError =
  | "transition-failed"
  | "cancelled"
  | "timeout"
  | "probe-invalid"
  | "probe-failed"
  | "probe-disagreed"
  | "storage"
  | "interrupted"
  | "unavailable";
/** Public, bounded state. Contains no command/probe output, error text or secrets. */
export type ToggleState = {
  deckId: string;
  bindingId: string;
  generation: number;
  confirmed: ConfirmedState | "unknown";
  transitioning: boolean;
  reconciling: boolean;
  fresh: boolean;
  blocked: boolean;
  error?: ToggleError;
};
export const toggleKey = (
  deckId: string,
  binding: Pick<KeyBinding, "id" | "generation">,
) => JSON.stringify([deckId, binding.id, binding.generation]);

export function toggleBindings(document: AppDocument) {
  return document.decks.flatMap((deck) =>
    document.profiles
      .filter((profile) => deck.profileIds.includes(profile.id))
      .flatMap((profile) =>
        profile.pages.flatMap((page) =>
          Object.values(page.keys)
            .filter((binding) => binding.toggle)
            .map((binding) => ({ deckId: deck.id, binding })),
        ),
      ),
  );
}
