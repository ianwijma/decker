import { createHash } from "node:crypto";
import { toggleDefinitionStamp } from "./targets";
import { originBinding, type ButtonOrigin } from "../shared/trigger-context";
import type { AppDocument } from "../shared/schema";
export function refreshStamp(document: AppDocument, origin: ButtonOrigin) {
  const b = originBinding(document, origin);
  if (!b?.refresh) return "";
  const synthetic = {
    ...b,
    toggle: undefined,
    release: undefined,
    longPress: undefined,
    refresh: undefined,
    press: { kind: "workflow" as const, workflowId: b.refresh.workflowId },
  };
  return createHash("sha256")
    .update(
      JSON.stringify([b.refresh, toggleDefinitionStamp(synthetic, document)]),
    )
    .digest("hex");
}
/** Page identity changes only for executable map/navigation, never display/status updates. */
export function viewVersion(document: AppDocument, deckId: string) {
  const deck = document.decks.find((d) => d.id === deckId);
  const page = document.profiles
    .find((p) => p.id === deck?.activeProfileId)
    ?.pages.find((p) => p.id === deck?.activePageId);
  return createHash("sha256")
    .update(
      JSON.stringify([
        deck?.activeProfileId,
        deck?.activePageId,
        deck?.rows,
        deck?.columns,
        Object.entries(page?.keys ?? {}).map(([slot, b]) => [
          slot,
          b.id,
          b.generation,
        ]),
      ]),
    )
    .digest("hex");
}
